import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/wfbn/rss.ts -- BOTH of its exports:
//
//   wfbnRss          GET /needs/rss.xml            (the site-wide feed)
//   wfbnFoodbankRss  GET /needs/at/<slug>/rss.xml  (one food bank's feed)
//
// plus their three locale-prefixed twins each. Ported from gfwfbn/views.py's
// `rss` (the one view that serves both, read in full alongside this file
// together with gfwfbn/templates/wfbn/rss.xml and the debugcomment include
// both versions share).
//
// WHY THIS FILE EXISTS. A feed is the one page on this site nobody looks at.
// It is fetched by aggregators, by IFTTT-style automations and by the couple
// of food banks that mirror their own feed back onto their website, and every
// way it can be wrong is a clean, well-formed 200 that a human never opens:
//
//   * THE MERGE IS TWO QUERIES, NOT ONE. Ten needs and ten articles are
//     fetched independently and then sorted together in JS. So the feed is
//     NOT "the twenty most recent things" -- eleven needs in a day pushes the
//     eleventh out even if it is newer than every article present. That is
//     Django's behaviour too, and a "tidy-up" to one merged LIMIT 20 would
//     change what subscribers receive without changing anything visible;
//   * THE SORT KEY IS A PARSED DATE, not the lexicographic TEXT ordering the
//     rest of this codebase relies on. `new Date(x).getTime()` on a value it
//     cannot parse is NaN, and a comparator that returns NaN leaves the whole
//     array in an unspecified order -- one bad row reorders the feed, not
//     just itself;
//   * THE THREE SENTINELS ARE EXCLUDED IN SQL, not in the handler. A need
//     saying "Unknown" is the newest row on a busy food bank most days, so a
//     lost exclusion puts "0 items requested at X" at the top of the feed;
//   * BOTH QUERIES INNER-JOIN `foodbank`, while Django's ForeignKey is
//     null=True on both models. An orphan row is silently dropped here;
//   * the item count in the title is `no_items()` on the RAW English text
//     while the description is the TRANSLATED text, so the two disagree by
//     design in cy/ga/gd -- collapse them and English never changes;
//   * every value is interpolated into XML. One unescaped `&` in an article
//     title makes the document unparseable for every subscriber at once.
//
// So every assertion below reads a value out of the rendered feed, out of the
// statements that reached the engine, or off a response header -- never a
// bare status code on its own.
//
// REAL EVERYTHING, the harness routes/wfbn/foodbank.test.ts and
// routes/wfbn/locations.test.ts already use: the real production app
// (src/index.ts's default export), so resolveLanguage, cacheTag,
// pageCacheControl and the four locale registrations are the genuine articles
// rather than a hand-built router; the real Nunjucks templates and the real
// .po catalogues; the real packages/db queries over real in-memory SQLite
// whose DDL comes from schemaFor(), i.e. from the migrations. Nothing this
// route touches leaves the machine, so nothing is mocked at all.
//
// PARITY CLAIMS. Where a comment says "Django does X", X was READ out of
// /Users/jasoncartwright/Sites/foodcharity (gfwfbn/views.py's `rss`,
// givefood/models/needs.py's `no_items`/`get_text`, givefood/models/
// articles.py, givefood/const/general.py's SITE_DOMAIN and
// gfwfbn/templates/wfbn/rss.xml). NO PYTHON WAS EXECUTED for this file --
// where a claim would need a running Django to settle it, the comment says
// "not verified" rather than inventing a citation.
//
// MUTATION-TESTED in an rsync'd copy of the tree OUTSIDE the repo (TESTING.md's
// "several suites were mutation-tested"). The mutants and what happened to
// each are listed at the bottom of this file, next to the tests that killed
// them.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text and the values bound
// to it. Both halves matter here -- the LIMIT and the food bank id are the
// only things distinguishing the four queries this route can issue, and the
// translation lookup's whole contract is "one statement binding every need
// id", which no rendered feed can show.
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

function env(overrides: Partial<Record<string, unknown>> = {}): AppEnv["Bindings"] {
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
    ...overrides,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns this feed reads are parameterised; every other NOT
// NULL column is filled with something the real migration accepts, so a seeded
// row is one production would have taken.
//
// Timestamps are written in DJANGO'S OWN SPELLING throughout ("2026-09-05
// 19:00:00.000000" -- a space and six digits of microseconds), because that is
// what the ETL copied out of Postgres, what migration 0022 normalised every
// JavaScript-written value INTO, and what both ORDER BY clauses here compare
// lexicographically. Writing toISOString() values instead would sort every
// same-day row wrongly against them, which is the exact bug 0022 exists to
// have fixed.
// ---------------------------------------------------------------------------

function seedFoodbank(s: { id: number; slug: string; name: string; altName?: string | null }): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, ?, '12 High Street', 'SP2 8LZ', 'England', '51.0688,-1.7945',
       0, ?, ?, ?, 0, 0, 0, 14, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.altName ?? null,
    s.slug,
    `info@${s.slug}.invalid`,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
  );
}

// `need_id` is the 32-char DASHLESS uuid D1 stores (PLAN.md §4.4). The
// padded-with-"b" spelling makes the dashed form the feed emits readable at a
// glance: id 101 becomes bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb101.
function seedNeed(o: { id: number; foodbankId: number | null; changeText: string; created: string; published?: 0 | 1 }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text,
       published, input_method, created, modified)
     VALUES (?, ?, ?, ?, NULL, ?, 'scrape', ?, ?)`,
  ).run(o.id, String(o.id).padStart(32, "b"), o.foodbankId, o.changeText, o.published ?? 1, o.created, o.created);
}

// `featured` is 0 on every seeded article ON PURPOSE. The site-wide feed must
// use getRecentArticles (unfiltered), not getFeaturedArticles (`featured = 1`)
// -- they share a SELECT and differ only in a WHERE clause, so a call site
// that picked the wrong one would return an empty news half here and be
// invisible on the 168-row featured subset the homepage shows.
function seedArticle(o: { id: number; foodbankId: number | null; title: string; url: string; publishedDate: string }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, 0)").run(
    o.id,
    o.foodbankId,
    o.publishedDate,
    o.title,
    o.url,
  );
}

function seedTranslation(o: { id: number; needId: number; language: string; changeText?: string | null }): void {
  db.prepare(
    "INSERT INTO foodbankchangetranslation (id, need_id, foodbank_id, language, change_text, excess_change_text) VALUES (?, ?, NULL, ?, ?, NULL)",
  ).run(o.id, o.needId, o.language, o.changeText ?? null);
}

// THE FIXTURE IS THE TEST. The four food banks each turn one branch on or off,
// and the three sentinels plus the unpublished need are deliberately the FOUR
// NEWEST rows in the table -- so any of those four filters failing puts the
// offending item at the TOP of the feed, where a single "first item is..."
// assertion catches it.
//
//   1  salisbury       a plain food bank, with a need whose text contains a
//                      blank line, plus an article whose title contains "&"
//   2  caerdydd        alt_name set -- full_name()'s Welsh branch
//   3  salvation-army  a DONT_APPEND_FOOD_BANK name (no "Foodbank" suffix in
//                      any locale)
//   4  quiet-town      no needs and no articles at all -- the empty feed
function seed(): void {
  seedFoodbank({ id: 1, slug: "salisbury", name: "Salisbury" });
  seedFoodbank({ id: 2, slug: "caerdydd", name: "Caerdydd", altName: "Pantri Bwyd Bae Caerdydd" });
  seedFoodbank({ id: 3, slug: "salvation-army", name: "Salvation Army" });
  seedFoodbank({ id: 4, slug: "quiet-town", name: "Quiet Town" });

  // The four rows that MUST NOT appear, newest first.
  seedNeed({ id: 103, foodbankId: 1, changeText: "Unknown", created: "2026-09-05 22:00:00.000000" });
  seedNeed({ id: 104, foodbankId: 1, changeText: "Facebook", created: "2026-09-05 21:30:00.000000" });
  seedNeed({ id: 105, foodbankId: 1, changeText: "Nothing", created: "2026-09-05 21:00:00.000000" });
  seedNeed({ id: 106, foodbankId: 1, changeText: "Draft beans", created: "2026-09-05 20:30:00.000000", published: 0 });

  // The rows that must.
  seedNeed({ id: 101, foodbankId: 1, changeText: "Tinned soup\n\nLong life milk\nNappies", created: "2026-09-05 19:00:00.000000" });
  seedNeed({ id: 102, foodbankId: 2, changeText: "Ffa pob\nPasta", created: "2026-09-05 17:00:00.000000" });
  seedNeed({ id: 107, foodbankId: 3, changeText: "Rice\nTea", created: "2026-09-05 15:00:00.000000" });

  seedArticle({ id: 201, foodbankId: 1, title: "Volunteers & vans", url: "https://news.invalid/vans", publishedDate: "2026-09-05 18:00:00.000000" });
  seedArticle({ id: 202, foodbankId: 2, title: "Appeal launched", url: "https://news.invalid/appeal", publishedDate: "2026-09-05 16:00:00.000000" });
  seedArticle({ id: 203, foodbankId: 3, title: "Army marches on", url: "https://news.invalid/army", publishedDate: "2026-09-05 14:00:00.000000" });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // schemaFor(), not hand-written DDL. `foodbankchange_full` is here because
  // getFoodbankBySlug reads through that VIEW (github #51 -- eight suites
  // 500'd at once when it started doing so) even though this route only wants
  // the food bank row; `slugredirect` because middleware/slugRedirect.ts owns
  // every /needs/at/ URL and its regex is one edit away from matching these.
  //
  // AND `foodbanklocation`, WHICH THIS ROUTE NEVER READS -- the second verse
  // of that same #51 scar, from github #52 item 3. The two 404 tests below ask
  // for /needs/at/<slug>/rss.xml WITHOUT a trailing slash, so index.ts's
  // app.notFound() runs lib/appendSlash.ts, which HEAD-probes
  // /needs/at/<slug>/rss.xml/ -- and that DOES match a route:
  // /needs/at/:slug/:locslug/, with locslug "rss.xml". Since #52 that handler's
  // first batch counts service areas in `foodbanklocation`, so without the
  // table the probe 500s; appendSlash redirects on anything that is not a 404
  // or a 501, and the two tests saw a 301. Nothing about the feed changed. The
  // fixture had simply stopped describing every table the URL space reaches.
  db.exec(
    schemaFor(
      "foodbank",
      "foodbankchange",
      "foodbankchange_full",
      "foodbankarticle",
      "foodbankchangetranslation",
      "foodbanklocation",
      "slugredirect",
    ),
  );
  seed();
  prepared = [];
  sessions = 0;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit, bindings = env()): Promise<Response> =>
  app.fetch(new Request(`${ORIGIN}${path}`, init), bindings, execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// One <item> per entry, whitespace collapsed. The template indents with tabs
// and blank lines around its {% if %}, none of which a feed reader sees, so
// collapsing is the difference between asserting content and asserting the
// template's indentation.
const items = (xml: string): string[] => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]!.replace(/\s+/g, " ").trim());

// The <title> of each item, in feed order -- the one value that identifies an
// item to a subscriber, and the thing an ordering bug reorders.
const titles = (xml: string): string[] => [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map((m) => m[1]!.trim());

// One element out of the <channel> header (not out of an <item>: the regex is
// anchored on the substring before the first <item>).
function channel(xml: string, tag: string): string {
  const header = xml.slice(0, xml.indexOf("<item>") === -1 ? xml.length : xml.indexOf("<item>"));
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(header);
  if (!match) throw new Error(`no <${tag}> in the channel header`);
  return match[1]!.trim();
}

describe("wfbnRss / wfbnFoodbankRss -- the response envelope", () => {
  // THE CONTENT TYPE IS THE WHOLE POINT OF THIS ROUTE. Django passed
  // `content_type='application/rss+xml'` explicitly, and a feed served as
  // text/html is one every aggregator rejects while every browser renders
  // happily -- so this is a failure that looks fine to the only person who
  // ever opens it in a browser. Note there is NO charset parameter, unlike
  // the HTML pages' "text/html; charset=UTF-8": the XML declaration in the
  // body carries the encoding instead.
  it("serves both feeds as application/rss+xml with no charset parameter", async () => {
    const site = await get("/needs/rss.xml");
    const foodbank = await get("/needs/at/salisbury/rss.xml");

    expect(site.status).toBe(200);
    expect(site.headers.get("Content-Type")).toBe("application/rss+xml");
    expect(foodbank.status).toBe(200);
    expect(foodbank.headers.get("Content-Type")).toBe("application/rss+xml");
  });

  // THE XML DECLARATION MUST BE THE FIRST BYTES OF THE BODY. rss.njk emits it
  // and only then includes debugcomment.njk, so the ~40-line ASCII-art comment
  // sits between the declaration and <rss> -- legal XML, and deliberate. Swap
  // those two template lines and every parser in the world rejects the
  // document with "XML declaration allowed only at the start", which no
  // status code, header or content check would notice.
  it("puts the XML declaration first and the debug comment after it", async () => {
    const xml = await body("/needs/rss.xml");

    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(true);
    expect(xml.indexOf("<!--")).toBeGreaterThan(0);
    expect(xml.indexOf("<!--")).toBeLessThan(xml.indexOf("<rss "));
    expect(xml.trimEnd().endsWith("</rss>")).toBe(true);
  });

  // Django's `rss` view carries @cache_page(SECONDS_IN_DAY)
  // (gfwfbn/views.py:131, the decorator directly above `def rss` on :132),
  // and pageCacheControl.ts's
  // fall-through rule is also a day -- so the shared-cache number here MATCHES
  // Django exactly. The browser number does not, deliberately: BROWSER_MAX_AGE
  // is 300 because a browser cache cannot be purged.
  //
  // This only happens because "application/rss+xml" is in that middleware's
  // CACHEABLE_TYPES. A feed served under any other type would silently lose
  // its whole cache policy, which is the second reason the type assertion
  // above matters.
  it("stamps Django's day-long shared TTL, and five minutes in the browser", async () => {
    expect((await get("/needs/rss.xml")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect((await get("/needs/at/salisbury/rss.xml")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // THE TAGS ARE WHY THE DAY ABOVE IS SAFE, and the two feeds get DIFFERENT
  // ones. queues/cachePurge.ts purges `fb-<slug>` when one food bank's need is
  // published and `fb-all` when anything changes; the site-wide feed depends
  // on every food bank, so it must carry the aggregate tag or a day-old copy
  // of it sits at the edge with no way to revoke it. Cloudflare strips
  // Cache-Tag before a client sees it, so its absence is invisible from
  // outside.
  it("tags the site-wide feed fb-all and a food bank's feed with its own slug, in every locale", async () => {
    expect((await get("/needs/rss.xml")).headers.get("Cache-Tag")).toBe("fb-all");
    expect((await get("/cy/needs/rss.xml")).headers.get("Cache-Tag")).toBe("fb-all");
    expect((await get("/needs/at/salisbury/rss.xml")).headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect((await get("/gd/needs/at/salisbury/rss.xml")).headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // ONE D1 SESSION PER REQUEST. lib/session.ts opens a single
  // withSession("first-unconstrained") so both halves of the merge see one
  // snapshot of a replicated database -- otherwise a need published between
  // the two queries could appear in the feed alongside an article list that
  // predates it. A handler opening one session per query renders identically.
  it("reads the whole site-wide feed from one session, in two statements", async () => {
    await get("/needs/rss.xml");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      [
        "SELECT fc.id, fc.need_id, fc.change_text, fc.created, f.slug AS foodbank_slug, f.name AS foodbank_name, f.alt_name AS foodbank_alt_name " +
          "FROM foodbankchange fc JOIN foodbank f ON f.id = fc.foodbank_id " +
          "WHERE fc.published = 1 AND fc.change_text NOT IN ('Unknown', 'Facebook', 'Nothing') ORDER BY fc.created DESC LIMIT ?",
        [10],
      ],
      [
        "SELECT a.id, a.foodbank_id, f.name AS foodbank_name, f.slug AS foodbank_slug, a.published_date, a.title, a.url, a.featured " +
          "FROM foodbankarticle a JOIN foodbank f ON f.id = a.foodbank_id ORDER BY a.published_date DESC LIMIT ?",
        [10],
      ],
    ]);
  });

  // THE FOOD BANK FEED SCOPES BOTH HALVES BY ID, not by slug and not in JS.
  // The id is bound into both WHERE clauses; a filter that quietly stopped
  // filtering would show every food bank's needs on every food bank's feed,
  // which reads perfectly well until a subscriber notices they are getting
  // 1,070 food banks' shopping lists.
  it("scopes both halves of a food bank's feed with its numeric id, after resolving the slug", async () => {
    await get("/needs/at/salisbury/rss.xml");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => p.params)).toEqual([
      ["salisbury"], // getFoodbankBySlug's batch, statement 1
      ["salisbury"], // ... and statement 2, the latest-need subquery it does not use here
      [1, 10], // needs, scoped to foodbank_id 1
      [1, 10], // articles, same
    ]);
    expect(prepared[2]!.sql).toContain("AND fc.foodbank_id = ? ORDER BY fc.created DESC LIMIT ?");
    expect(prepared[3]!.sql).toContain("WHERE a.foodbank_id = ? ORDER BY a.published_date DESC LIMIT ?");
  });

  // An unknown slug is Django's get_object_or_404. It must reach the real 404
  // page, must NOT run the two feed queries (the handler returns before the
  // Promise.all), and above all must not be stamped cacheable: a mistyped feed
  // URL in someone's aggregator would otherwise poison the edge with a
  // day-long negative entry that the fixed URL cannot displace.
  it("404s an unknown slug as HTML, uncached, untagged, without querying for items", async () => {
    const res = await get("/needs/at/nowhere/rss.xml");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
    expect(await res.text()).not.toContain("<rss");
    expect(prepared.map((p) => p.sql).filter((sql) => sql.includes("foodbankarticle"))).toEqual([]);
  });

  // GET ONLY, matching Django. index.ts registers both with app.get; a stray
  // app.all would hand a POST to a handler whose 200 pageCacheControl then
  // stamps public for a day -- and the handler reads nothing from a body, so
  // it would happily render and be cached.
  it("does not answer a POST to either feed", async () => {
    expect((await get("/needs/rss.xml", { method: "POST" })).status).toBe(404);
    expect((await get("/needs/at/salisbury/rss.xml", { method: "POST" })).status).toBe(404);
  });

  // A GET THAT WRITES IS THE FAILURE THIS ASSERTS AGAINST -- a route in this
  // repo has been caught with one before. A response stamped
  // `public, s-maxage=86400` cannot afford a side effect: the edge serves it
  // once and swallows every subsequent request.
  it("issues nothing but SELECTs, on both feeds and in every locale", async () => {
    await get("/needs/rss.xml");
    await get("/needs/at/salisbury/rss.xml");
    await get("/cy/needs/rss.xml");
    await get("/gd/needs/at/salisbury/rss.xml");

    expect(prepared).not.toHaveLength(0);
    for (const { sql } of prepared) expect(sql).toMatch(/^SELECT /);
  });

  // The slug comparison is SQLite's default case-sensitive `=` on TEXT, same
  // as Django's exact lookup. A `COLLATE NOCASE` on the column would create a
  // second, uncanonical feed URL for every food bank -- and feeds are
  // subscribed to, so a duplicate lives in someone's reader forever.
  it("does not answer a differently-cased slug", async () => {
    expect((await get("/needs/at/SALISBURY/rss.xml")).status).toBe(404);
  });

  // A D1 outage must produce the 500 page, not an EMPTY BUT WELL-FORMED FEED.
  // An aggregator handed a valid feed with zero items concludes the food bank
  // has nothing to say; handed a 500 it retries. The uncached part matters
  // just as much: a cached empty feed would be served for a day after the
  // database came back.
  it("500s, uncached, when the database is unavailable -- rather than serving an empty feed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = env({
      DB: {
        withSession: () => {
          throw new Error("D1_ERROR: network");
        },
      },
    });

    const res = await get("/needs/rss.xml", undefined, broken);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("<rss");
  });

  // elapsedMs() reports WHOLE milliseconds, deliberately unlike Django's three
  // decimal places. Asserted only as a FORMAT -- 0 is a legitimate value on
  // this clock -- because a revert to toFixed(3) shows up here as "Took
  // 0.000ms" and dropping render_time_ms leaves "Took ms", and both are inside
  // an XML comment where nothing else would ever notice.
  it("stamps the feed's debug comment with a whole-millisecond render time", async () => {
    expect(/⏱️ Took (\S+)/.exec(await body("/needs/rss.xml"))?.[1]).toMatch(/^\d+ms$/);
  });
});

describe("wfbnRss -- what the site-wide feed contains, and what it must not", () => {
  // THE WHOLE FEED, IN ORDER, IN ONE ASSERTION. Needs and articles interleave
  // strictly by date: need 19:00, article 18:00, need 17:00, article 16:00,
  // need 15:00, article 14:00. Any of the four excluded rows leaking in would
  // land at the TOP of this list, because all four are newer than everything
  // here.
  it("merges needs and articles into one date-ordered list", async () => {
    expect(titles(await body("/needs/rss.xml"))).toEqual([
      "4 items requested at Salisbury Foodbank",
      "Volunteers &amp; vans",
      "2 items requested at Caerdydd Foodbank",
      "Appeal launched",
      "2 items requested at Salvation Army",
      "Army marches on",
    ]);
  });

  // THE THREE SENTINELS, excluded by getRecentPublishedNeedsForRss's own
  // `NOT IN` -- which is why rss.ts, unlike foodbank.ts and locationDetail.ts,
  // needs no "is this a real need" gate of its own. Each of the three is
  // seeded NEWER than every real row, so a lost exclusion is the first item
  // in the feed rather than a subtle one buried in the middle.
  //
  // The visible symptom would be specific and silly: no_items() returns 0 for
  // "Unknown" and "Nothing", so the feed would announce "0 items requested at
  // Salisbury Foodbank" -- and 1 for "Facebook", which is not a sentinel
  // no_items() knows about (needs.py:93-97 checks only two of the three).
  it("excludes the Unknown/Facebook/Nothing sentinels even though they are the newest rows", async () => {
    const xml = await body("/needs/rss.xml");

    expect(xml).not.toContain("0 items requested at");
    expect(xml).not.toContain("1 items requested at");
    expect(xml).not.toContain("<description>Unknown</description>");
    expect(xml).not.toContain("<description>Facebook</description>");
    expect(xml).not.toContain("<description>Nothing</description>");
    expect(items(xml)).toHaveLength(6);
  });

  // `published = 1`. An unpublished need is a draft an admin has not released
  // -- often a scrape awaiting review -- and the feed is a PUSH channel: once
  // it is in a subscriber's reader it cannot be withdrawn. Seeded as the
  // newest real-looking row for the same reason as the sentinels.
  it("excludes an unpublished need", async () => {
    expect(await body("/needs/rss.xml")).not.toContain("Draft beans");
  });

  // The article half is UNFILTERED by `featured` -- getRecentArticles, not
  // getFeaturedArticles. Every article seeded here has featured = 0, so if
  // this route ever picked up the featured-only query the news half of the
  // feed would silently empty out while the needs half kept working.
  it("includes unfeatured articles", async () => {
    const xml = await body("/needs/rss.xml");
    expect(xml).toContain("Appeal launched");
    expect(xml).toContain("Army marches on");
  });

  // SUSPECT, PINNED AS THE PORT'S ACTUAL BEHAVIOUR. Both queries INNER JOIN
  // `foodbank`, while Django's ForeignKey is null=True on FoodbankChange
  // (models/needs.py:57) and on FoodbankArticle (models/articles.py:21). So an
  // orphan row is dropped here.
  //
  // The two halves diverge from Django differently, which is why both are
  // asserted:
  //   * an orphan NEED -- Django's view does `need.foodbank.full_name()`, so
  //     Django would raise AttributeError on None and 500 the whole feed. The
  //     port dropping the row is the safer behaviour of the two (not verified
  //     against a running Django; read out of gfwfbn/views.py);
  //   * an orphan ARTICLE -- Django's news half is a plain
  //     `FoodbankArticle.objects.all()` and its template uses only title, url
  //     and published_date, so Django INCLUDES it. The port silently drops it,
  //     and this is a real loss of content with no symptom at all.
  it("SUSPECT: silently drops needs and articles whose food bank FK is NULL, where Django keeps the article", async () => {
    seedNeed({ id: 108, foodbankId: null, changeText: "Orphan soup", created: "2026-09-05 23:00:00.000000" });
    seedArticle({ id: 204, foodbankId: null, title: "Orphan article", url: "https://news.invalid/orphan", publishedDate: "2026-09-05 23:30:00.000000" });

    const xml = await body("/needs/rss.xml");

    expect(xml).not.toContain("Orphan soup");
    expect(xml).not.toContain("Orphan article");
    expect(items(xml)).toHaveLength(6);
  });

  // TWO LIMITS OF TEN, NOT ONE LIMIT OF TWENTY -- and this is the test that
  // tells them apart. Twelve needs, all newer than all twelve articles: the
  // feed carries the 10 newest needs and the 10 newest ARTICLES, so needs 11
  // and 12 are missing while ten articles that are older than both of them are
  // present. "The twenty most recent items" would instead be twelve needs and
  // eight articles.
  //
  // This is Django's shape exactly (two independent `[:10]` slices merged in
  // Python), so it is parity rather than a defect -- pinned because collapsing
  // it into one merged query is an obvious-looking simplification that would
  // change what every subscriber receives.
  it("takes ten needs AND ten articles, not the twenty most recent things", async () => {
    db.prepare("DELETE FROM foodbankchange").run();
    db.prepare("DELETE FROM foodbankarticle").run();
    for (let i = 1; i <= 12; i += 1) {
      const hh = String(i + 8).padStart(2, "0"); // needs run 09:00 .. 20:00 on the 6th
      seedNeed({ id: 300 + i, foodbankId: 1, changeText: `Need ${i}`, created: `2026-09-06 ${hh}:00:00.000000` });
      seedArticle({ id: 400 + i, foodbankId: 1, title: `Article ${i}`, url: `https://news.invalid/${i}`, publishedDate: `2026-09-05 ${hh}:00:00.000000` });
    }

    const xml = await body("/needs/rss.xml");
    const newest = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3];

    expect(items(xml)).toHaveLength(20);
    // Every need item's description, in feed order, then every article title:
    // the ten newest of each, and the merged list is needs-then-articles
    // because all twelve needs are newer than all twelve articles.
    // `.slice(1)` skips the CHANNEL's own <description>, which is the first
    // one in the document.
    expect([...xml.matchAll(/<description>([^<]*)<\/description>/g)].map((m) => m[1]).slice(1)).toEqual(newest.map((n) => `Need ${n}`));
    expect(titles(xml).slice(10)).toEqual(newest.map((n) => `Article ${n}`));
    // Needs 1 and 2 are gone despite being NEWER than every article present --
    // the observable difference between two limits of ten and one of twenty.
    expect(xml).not.toContain("Need 2<");
    expect(xml).not.toContain("Need 1<");
    expect(xml).not.toContain("Article 2<");
  });

  // A tie is decided by INSERTION ORDER, not by the sort: every need is pushed
  // into `items` before any article, and Array.prototype.sort has been
  // required to be stable since ES2019. Worth pinning because a food bank's
  // article and its need genuinely do land on the same second when the
  // articles crawler and the needs scrape run in the same tick, and "the need
  // first" is the useful order -- the need is the thing a donor acts on.
  it("puts a need before an article when their timestamps are identical", async () => {
    seedArticle({ id: 205, foodbankId: 1, title: "Same second", url: "https://news.invalid/tie", publishedDate: "2026-09-05 19:00:00.000000" });

    expect(titles(await body("/needs/rss.xml")).slice(0, 2)).toEqual(["4 items requested at Salisbury Foodbank", "Same second"]);
  });

  // SUSPECT: A SINGLE UNPARSEABLE TIMESTAMP BREAKS THE SORT FOR THE WHOLE
  // FEED. The comparator is `new Date(b.date).getTime() - new Date(a.date)
  // .getTime()`; an unparseable value gives NaN, every comparison involving it
  // returns NaN, and the ECMAScript sort contract says the result is
  // implementation-defined when the comparator is inconsistent -- so the
  // damage is not confined to the bad item's own position.
  //
  // This is reachable: workers/jobs' article crawler stores
  // `pyDatetime(item.publishedDate)`, and pyDatetime() of an Invalid Date
  // formats NaN fields rather than throwing.
  //
  // Only the DETERMINISTIC consequences are asserted -- the item survives, and
  // its <pubDate> renders empty because djangoDate() returns "" for a value it
  // cannot parse rather than emitting "NaN NaN NaN". The resulting permutation
  // is deliberately NOT pinned: it depends on V8's sort internals, so an
  // assertion on it would be a test of V8 rather than of this route.
  it("SUSPECT: keeps an item whose timestamp cannot be parsed, with an empty pubDate and no ordering guarantee", async () => {
    db.prepare("UPDATE foodbankarticle SET published_date = 'not a date' WHERE id = 202").run();

    const xml = await body("/needs/rss.xml");

    expect(items(xml)).toHaveLength(6);
    expect(xml).toContain("<title>Appeal launched</title>");
    expect(xml).toMatch(/<title>Appeal launched<\/title>[\s\S]*?<pubDate><\/pubDate>/);
  });

  // The empty feed. A food bank with nothing to report still gets a valid
  // document with a complete channel header -- an aggregator handed a
  // truncated or item-less-but-malformed feed unsubscribes.
  it("renders a valid, item-less feed for a food bank with no needs and no articles", async () => {
    const xml = await body("/needs/at/quiet-town/rss.xml");

    expect(items(xml)).toEqual([]);
    expect(channel(xml, "title")).toBe("Quiet Town Foodbank");
    expect(xml.trimEnd().endsWith("</rss>")).toBe(true);
  });
});

describe("wfbnFoodbankRss -- one food bank's feed, and the rows it must leave out", () => {
  // BOTH HALVES SCOPED. Salisbury's feed carries Salisbury's need and
  // Salisbury's article and nothing else -- the negatives are the test, since
  // a scope filter that stopped filtering passes any assertion that only
  // checks what SHOULD be there.
  it("carries only this food bank's need and article", async () => {
    const xml = await body("/needs/at/salisbury/rss.xml");

    expect(titles(xml)).toEqual(["4 items requested at Salisbury Foodbank", "Volunteers &amp; vans"]);
    expect(xml).not.toContain("Caerdydd");
    expect(xml).not.toContain("Appeal launched");
    expect(xml).not.toContain("Salvation Army");
    expect(xml).not.toContain("Army marches on");
  });

  // The sentinel and published filters are in the same query and therefore
  // apply to a food bank's own feed too -- asserted separately because
  // Salisbury owns all four excluded rows, so this feed is where they would
  // show up first.
  it("applies the same sentinel and published filters as the site-wide feed", async () => {
    const xml = await body("/needs/at/salisbury/rss.xml");

    expect(items(xml)).toHaveLength(2);
    expect(xml).not.toContain("Draft beans");
    expect(xml).not.toContain("0 items");
    expect(xml).not.toContain("1 items");
  });
});

describe("the item: title, link, guid, pubDate, description", () => {
  // ONE ITEM, EVERY FIELD, EXACTLY. The five values a subscriber actually
  // consumes, in the one place they can be read together:
  //
  //   title        no_items() + a translated "items requested at" + full_name()
  //   link/guid    SITE_DOMAIN + the food bank page + "#need-<DASHED uuid>"
  //   pubDate      RFC 2822, from a Django-format TEXT timestamp
  //   description  the blank-line-stripped shopping list, newlines intact
  //
  // The guid is `isPermaLink="true"` and equal to the link, so it is the
  // IDENTITY of the item in every reader on earth: change how that URL is
  // built and every past item in every subscriber's reader reappears as new.
  it("renders every field of a need item", async () => {
    expect(items(await body("/needs/rss.xml"))[0]).toBe(
      "<title>4 items requested at Salisbury Foodbank</title> " +
        "<link>https://www.givefood.org.uk/needs/at/salisbury/#need-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb101</link> " +
        '<guid isPermaLink="true">https://www.givefood.org.uk/needs/at/salisbury/#need-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb101</guid> ' +
        "<pubDate>Sat, 05 Sep 2026 19:00:00 +0000</pubDate> " +
        "<description>Tinned soup Long life milk Nappies</description>",
    );
  });

  // THE FRAGMENT IS THE DASHED UUID, not the dashless form D1 stores. Django's
  // need_id is a UUIDField, so `"#need-%s" % need.need_id` interpolates
  // str(UUID) -- the dashed spelling -- and the food bank page's anchor is
  // generated from the same model field. toDashedUuid() is what keeps the feed
  // link pointing at an anchor that exists: drop it and every "read more" in
  // every reader lands at the top of the page instead of on the need.
  it("builds the #need- fragment from the dashed uuid", async () => {
    const xml = await body("/needs/rss.xml");

    expect(xml).toContain("#need-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb101");
    expect(xml).not.toContain("#need-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb101");
  });

  // AN ARTICLE ITEM HAS NO <description> AT ALL. The template gates it on
  // `{% if item.description %}` and the article branch never sets one, exactly
  // as Django's does. An empty <description></description> is not the same
  // thing to a reader: several render an empty summary block for it.
  it("omits <description> entirely for an article", async () => {
    expect(items(await body("/needs/rss.xml"))[1]).toBe(
      "<title>Volunteers &amp; vans</title> " +
        "<link>https://news.invalid/vans</link> " +
        '<guid isPermaLink="true">https://news.invalid/vans</guid> ' +
        "<pubDate>Sat, 05 Sep 2026 18:00:00 +0000</pubDate>",
    );
  });

  // pubDate is RFC 2822 ("D, d M Y H:i:s O"), which is what RSS 2.0 requires
  // and what Django's `|date:"D, d M Y H:i:s O"` produced from the same TEXT
  // column. The offset is always +0000 because the stored value is naive UTC
  // (Django ran USE_TZ=False with TZ pinned to UTC, and vitest.config.mts pins
  // TZ=UTC for the same reason): an accidental local-time render would show up
  // as a +0100 here every British summer.
  it("formats pubDate as RFC 2822 in UTC", async () => {
    const xml = await body("/needs/rss.xml");

    expect(xml).toContain("<pubDate>Sat, 05 Sep 2026 19:00:00 +0000</pubDate>");
    expect(xml).toContain("<pubDate>Sat, 05 Sep 2026 14:00:00 +0000</pubDate>");
    expect(xml).not.toMatch(/<pubDate>[^<]*\+0100<\/pubDate>/);
  });

  // lastBuildDate is the SAME format, from `now()` rather than a column.
  // Asserted as a shape because the value is the wall clock: a reader that
  // cannot parse it treats the whole channel as never updated.
  it("stamps lastBuildDate in the same RFC 2822 format", async () => {
    expect(channel(await body("/needs/rss.xml"), "lastBuildDate")).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
  });

  // SUSPECT, AND FAITHFUL TO DJANGO. no_items() is
  // `len(change_text.split('\n'))` (needs.py:93-97) -- it counts BLANK lines,
  // while get_change_text() strips them before display. So a scrape of a list
  // with a gap in it produces a title that says four items above a description
  // listing three. The port reproduces both halves exactly, in
  // @givefood/models' noItems() and resolveNeedText().
  //
  // Pinned rather than fixed: "obviously the count should match the list" is a
  // one-line change that would silently alter the title of every item in every
  // subscriber's reader, and it is Django's number that the site's own
  // statistics have always been built on.
  it("SUSPECT: counts blank lines in the title's item count but strips them from the description", async () => {
    const xml = await body("/needs/rss.xml");

    // "Tinned soup\n\nLong life milk\nNappies" -- four \n-separated pieces...
    expect(xml).toContain("<title>4 items requested at Salisbury Foodbank</title>");
    // ...and three lines shown.
    expect(xml).toContain("<description>Tinned soup\nLong life milk\nNappies</description>");
    expect(xml).not.toContain("\n\nLong life milk");
  });

  // SUSPECT, ALSO FAITHFUL TO DJANGO. change_text is NOT NULL but may be the
  // empty string. no_items("") is 1 (`"".split("\n")` is a one-element list in
  // both languages), so the title claims one item, while resolveNeedText()
  // returns "" and the template's `{% if item.description %}` then drops the
  // description entirely -- an item that says "1 items requested at X" and
  // lists nothing.
  it("SUSPECT: an empty need announces one item and carries no description", async () => {
    db.prepare("DELETE FROM foodbankchange WHERE id != 101").run();
    db.prepare("UPDATE foodbankchange SET change_text = '' WHERE id = 101").run();

    const only = items(await body("/needs/at/salisbury/rss.xml"))[0]!;
    expect(only).toContain("<title>1 items requested at Salisbury Foodbank</title>");
    expect(only).not.toContain("<description>");
  });

  // EVERY VALUE IS XML-ESCAPED, BY NUNJUCKS AUTOESCAPE. This is the failure
  // mode with the widest blast radius on this route: one raw `&` in one
  // article title and the whole document is not well-formed, so every
  // subscriber loses every item, not just that one. Article titles are
  // arbitrary text scraped off a food bank's own website, so the input is not
  // under this project's control.
  //
  // The apostrophe becomes the NUMERIC reference &#39; rather than &apos;,
  // because that is what nunjucks emits -- both are valid XML, and the
  // numeric one is what a byte-comparison against production would see.
  it("escapes &, <, >, \" and ' in titles, links and descriptions", async () => {
    db.prepare("DELETE FROM foodbankarticle").run();
    seedArticle({
      id: 206,
      foodbankId: 1,
      title: `Beans & "peas" <b>now</b> at Tim's`,
      url: "https://news.invalid/q?a=1&b=2",
      publishedDate: "2026-09-05 18:00:00.000000",
    });
    db.prepare("UPDATE foodbankchange SET change_text = 'Beans & rice' WHERE id = 101").run();

    const xml = await body("/needs/at/salisbury/rss.xml");

    expect(xml).toContain("<title>Beans &amp; &quot;peas&quot; &lt;b&gt;now&lt;/b&gt; at Tim&#39;s</title>");
    expect(xml).toContain("<link>https://news.invalid/q?a=1&amp;b=2</link>");
    expect(xml).toContain("<description>Beans &amp; rice</description>");
    // The proof that nothing slipped through: no bare ampersand anywhere in
    // the document that is not the start of an entity reference.
    expect(xml.replace(/&(?:amp|lt|gt|quot|#\d+);/g, "")).not.toContain("&");
  });
});

describe("the channel header, and the domain every URL is built from", () => {
  // THE SITE-WIDE CHANNEL. `<title>Give Food</title>` is a hardcoded literal
  // in the template (not translated, in any locale), and the description's
  // ampersand arrives escaped from autoescape.
  //
  // <link> IS THE BARE DOMAIN WITH NO TRAILING SLASH, because the template is
  // `{{ SITE_DOMAIN }}{% if foodbank %}...{% endif %}` and SITE_DOMAIN carries
  // no trailing slash (givefood/const/general.py:149 spells it the same way).
  // Django emits exactly this. Pinned rather than "fixed" to
  // "https://www.givefood.org.uk/": it is the channel's identity URL, and
  // changing it changes what a reader thinks the feed's home page is.
  it("renders the site-wide channel header, link included, exactly as Django spells it", async () => {
    const xml = await body("/needs/rss.xml");

    expect(channel(xml, "title")).toBe("Give Food");
    expect(channel(xml, "description")).toBe("News &amp; donation requests from UK food banks");
    expect(channel(xml, "link")).toBe("https://www.givefood.org.uk");
    expect(xml).toContain('<atom:link href="https://www.givefood.org.uk/needs/rss.xml" rel="self" type="application/rss+xml" />');
  });

  // A FOOD BANK'S CHANNEL names the food bank three times: the title, the
  // description and the <link> to its page. All three use full_name(), so a
  // regression in the locale-aware naming shows up in the feed's own identity
  // and not just in its items.
  it("renders a food bank's channel header from its full name and its page URL", async () => {
    const xml = await body("/needs/at/salisbury/rss.xml");

    expect(channel(xml, "title")).toBe("Salisbury Foodbank");
    expect(channel(xml, "description")).toBe("News &amp; donation requests from Salisbury Foodbank");
    expect(channel(xml, "link")).toBe("https://www.givefood.org.uk/needs/at/salisbury/");
    expect(xml).toContain('<atom:link href="https://www.givefood.org.uk/needs/at/salisbury/rss.xml" rel="self" type="application/rss+xml" />');
  });

  // atom:link rel="self" IS LOCALE-AWARE and points at the URL that was
  // actually requested. A self-link that pointed at the English feed from the
  // Welsh one tells every aggregator the two are the same document, so one of
  // them stops being fetched.
  it("points the self-link at the locale-prefixed URL that was requested", async () => {
    expect(await body("/cy/needs/rss.xml")).toContain('href="https://www.givefood.org.uk/cy/needs/rss.xml"');
    expect(await body("/ga/needs/at/salisbury/rss.xml")).toContain('href="https://www.givefood.org.uk/ga/needs/at/salisbury/rss.xml"');
    expect(await body("/gd/needs/at/salisbury/rss.xml")).toContain('href="https://www.givefood.org.uk/gd/needs/at/salisbury/rss.xml"');
  });

  // The channel <link> and every item link are locale-prefixed too, so a Welsh
  // subscriber's reader takes them to the Welsh page.
  it("prefixes the channel link and the item links with the locale", async () => {
    const xml = await body("/cy/needs/at/salisbury/rss.xml");

    expect(channel(xml, "link")).toBe("https://www.givefood.org.uk/cy/needs/at/salisbury/");
    expect(xml).toContain("<link>https://www.givefood.org.uk/cy/needs/at/salisbury/#need-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb101</link>");
  });

  // THE CHANNEL'S OWN full_name IS LOCALE-AWARE TOO, and it is computed by a
  // SEPARATE call from the items' -- `fullNameLocaleAware(foodbank.name, ...)`
  // at the bottom of the handler, not the one inside the needs loop. So the
  // two can diverge: mutation-testing showed that pinning the item titles in
  // cy/gd (the locale section below) leaves a hardcoded "en" in the CHANNEL's
  // call completely undetected, which would name a Welsh subscriber's feed
  // "Caerdydd Foodbank" while every item inside it said "Pantri Bwyd Bae
  // Caerdydd". That mutant is what this test exists to kill.
  //
  // It also covers the feed of a food bank with NO items at all, where the
  // channel header is the only thing a subscriber ever sees.
  it("names the channel with the locale-aware full name, in the title, the description and an empty feed", async () => {
    const cy = await body("/cy/needs/at/caerdydd/rss.xml");
    expect(channel(cy, "title")).toBe("Pantri Bwyd Bae Caerdydd");
    expect(channel(cy, "description")).toBe("News &amp; donation requests from Pantri Bwyd Bae Caerdydd");

    const gd = await body("/gd/needs/at/caerdydd/rss.xml");
    expect(channel(gd, "title")).toBe("Banca-bìdh Caerdydd");
    expect(channel(gd, "description")).toBe("News &amp; donation requests from Banca-bìdh Caerdydd");

    // ga ignores alt_name and appends the English word, exactly as en does.
    expect(channel(await body("/ga/needs/at/caerdydd/rss.xml"), "title")).toBe("Caerdydd Foodbank");

    // ...and the same on a feed with nothing in it.
    expect(channel(await body("/cy/needs/at/quiet-town/rss.xml"), "title")).toBe("Banc Bwyd Quiet Town");
  });

  // EVERY ABSOLUTE URL COMES FROM THE `SITE_DOMAIN` BINDING, not from
  // context.ts's hardcoded SITE_DOMAIN constant -- which is what makes a
  // preview or staging deployment emit its own URLs instead of production's.
  // The channel <link>, the atom self-link and the item links are all built
  // from it; nothing here should still say www.givefood.org.uk.
  it("builds the channel link, the self-link and the item links from the SITE_DOMAIN binding", async () => {
    const staging = env({ SITE_DOMAIN: "https://staging.givefood.invalid" });
    const xml = await (await get("/needs/at/salisbury/rss.xml", undefined, staging)).text();

    expect(channel(xml, "link")).toBe("https://staging.givefood.invalid/needs/at/salisbury/");
    expect(xml).toContain('href="https://staging.givefood.invalid/needs/at/salisbury/rss.xml"');
    expect(xml).toContain("<link>https://staging.givefood.invalid/needs/at/salisbury/#need-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb101</link>");
    expect(xml).not.toContain("www.givefood.org.uk");
  });
});

describe("locales: what translates, what does not, and the lookup that pays for it", () => {
  // THE ITEM TITLE IS THE ONLY TRANSLATED STRING IN THE WHOLE FEED, and
  // full_name() changes with it. Everything else in the channel header stays
  // English (see the next test), so this is the assertion that proves the
  // catalogue is loaded and applied at all -- without it every locale test
  // here would pass on an entirely English document.
  it("translates 'items requested at' and the food bank's name in cy, ga and gd", async () => {
    // packages/templates/src/generated/locales/*.json, from the .po catalogues.
    expect(await body("/cy/needs/rss.xml")).toContain("<title>4 eitemau y gofynnwyd amdanynt yn Banc Bwyd Salisbury</title>");
    expect(await body("/ga/needs/rss.xml")).toContain("<title>4 míreanna a iarradh ag Salisbury Foodbank</title>");
    expect(await body("/gd/needs/rss.xml")).toContain("<title>4 nithean a chaidh iarraidh aig Banca-bìdh Salisbury</title>");
  });

  // full_name()'s three rules, all visible in item titles on one feed:
  // cy-with-alt_name returns alt_name VERBATIM (no prefix, no suffix); cy/gd
  // otherwise prefix the translated word; ga and en append "Foodbank"; and a
  // DONT_APPEND_FOOD_BANK name is left alone in every locale -- "Banc Bwyd
  // Salvation Army" is not a thing that exists.
  it("applies full_name()'s alt_name, prefix and DONT_APPEND branches per locale", async () => {
    const cy = await body("/cy/needs/rss.xml");
    expect(cy).toContain("2 eitemau y gofynnwyd amdanynt yn Pantri Bwyd Bae Caerdydd");
    // What the cy prefix branch would produce if alt_name were ignored -- its
    // absence is what says alt_name actually won.
    expect(cy).not.toContain("Banc Bwyd Caerdydd");
    expect(cy).toContain("2 eitemau y gofynnwyd amdanynt yn Salvation Army");
    expect(cy).not.toContain("Banc Bwyd Salvation Army");

    // ga ignores alt_name entirely and takes the English suffix branch.
    expect(await body("/ga/needs/rss.xml")).toContain("2 míreanna a iarradh ag Caerdydd Foodbank");
    // gd prefixes, and still ignores alt_name -- the pair most easily
    // conflated with cy, since both prefix a word.
    expect(await body("/gd/needs/rss.xml")).toContain("2 nithean a chaidh iarraidh aig Banca-bìdh Caerdydd");
  });

  // SUSPECT: THE CHANNEL DESCRIPTION NEVER TRANSLATES. Neither
  // "News & donation requests from " nor "UK food banks" has a msgstr in any
  // of the three catalogues, so translate() falls back to the msgid and a
  // Welsh subscriber's reader shows an English channel description above
  // Welsh item titles.
  //
  // This is a CATALOGUE gap rather than a code defect, and the same gap exists
  // in Django's own catalogues: locale/{cy,ga,gd}/LC_MESSAGES/django.po each
  // carry "items requested at" (cy:605, ga:609, gd:610) and NONE of the three
  // carries either of these two msgids (grepped, zero matches each). So the
  // port is faithful. Recorded here because the natural "fix" is to add it to
  // the .po -- which is a translation job, not a code change, and this test
  // will go red the day someone does it.
  //
  // Note also that the port's msgid carries a RAW ampersand where Django's
  // template writes `{% trans "News &amp; donation requests from " %}` -- a
  // different msgid, which is part of why neither catalogue matches. What
  // Django's autoescape then does with that pre-escaped string is not settled
  // here: no Python was run.
  it("SUSPECT: leaves the channel title and description in English in every locale", async () => {
    for (const locale of ["cy", "ga", "gd"]) {
      const xml = await body(`/${locale}/needs/rss.xml`);
      expect(channel(xml, "title")).toBe("Give Food");
      expect(channel(xml, "description")).toBe("News &amp; donation requests from UK food banks");
    }
  });

  // ENGLISH NEVER QUERIES FoodbankChangeTranslation. Django's get_text() takes
  // the `current_language == "en"` branch (needs.py:216-225) and reads the
  // column directly. The site-wide feed is the busiest single feed URL on the
  // site, so a lookup here would be a wasted round trip on the large majority
  // of all requests -- and an absent query is invisible in a rendered feed,
  // which is why this asserts on the statements instead.
  it("issues no translation lookup on the English feed", async () => {
    await get("/needs/rss.xml");

    expect(prepared.map((p) => p.sql).filter((sql) => sql.includes("foodbankchangetranslation"))).toEqual([]);
  });

  // ONE STATEMENT FOR ALL THREE NEEDS, not one per need. getNeedTranslations
  // ByIds exists precisely so a list page does not N+1: with a full feed that
  // is 10 round trips saved, and a regression to per-row lookups would render
  // an identical feed while multiplying this route's D1 cost by ten.
  it("looks every need's translation up in a single batched statement on a translated feed", async () => {
    await get("/cy/needs/rss.xml");

    expect(prepared.filter((p) => p.sql.includes("foodbankchangetranslation"))).toEqual([
      {
        sql: "SELECT need_id, change_text, excess_change_text FROM foodbankchangetranslation WHERE language = ? AND need_id IN (?, ?, ?)",
        params: ["cy", 101, 102, 107],
      },
    ]);
  });

  // AND NO STATEMENT AT ALL WHEN THERE ARE NO NEEDS -- an `IN ()` with no
  // placeholders is not a query D1 should ever be sent. TWO guards deliver
  // this, and the mutation run confirmed either one alone is enough: the
  // handler's `needs.length > 0` and getNeedTranslationsByIds's own
  // `if (needIds.length === 0) return new Map()`. So this test pins the
  // OBSERVABLE contract rather than which of the two provides it -- deleting
  // the handler's gate does not fail it, and that is recorded in the mutation
  // log at the bottom of this file rather than papered over.
  it("issues no translation lookup on a translated feed with no needs", async () => {
    await get("/cy/needs/at/quiet-town/rss.xml");

    expect(prepared.map((p) => p.sql).filter((sql) => sql.includes("foodbankchangetranslation"))).toEqual([]);
  });

  // THE DESCRIPTION IS THE TRANSLATED TEXT, and the blank-line strip applies
  // to it exactly as it does to English.
  it("shows the Welsh shopping list in the description when a translation exists", async () => {
    seedTranslation({ id: 1, needId: 101, language: "cy", changeText: "Cawl tun\n\nLlaeth hir oes\nCewynnau" });

    const xml = await body("/cy/needs/rss.xml");

    expect(xml).toContain("<description>Cawl tun\nLlaeth hir oes\nCewynnau</description>");
    expect(xml).not.toContain("Tinned soup");
    expect(xml).not.toContain("\n\nLlaeth");
  });

  // THE TITLE'S COUNT STAYS ON THE RAW ENGLISH TEXT even when the description
  // is translated -- rss.ts says so in its own comment, because
  // FoodbankChange.no_items() (needs.py:93) is not locale-aware either. The
  // Welsh translation here has THREE \n-separated pieces against the English
  // four, so a count that had quietly moved onto the translated text would
  // read "3" and nothing else on the page would change.
  it("counts the items in the RAW English text even when the description is Welsh", async () => {
    seedTranslation({ id: 1, needId: 101, language: "cy", changeText: "Cawl tun\nLlaeth hir oes\nCewynnau" });

    const xml = await body("/cy/needs/rss.xml");

    expect(xml).toContain("<title>4 eitemau y gofynnwyd amdanynt yn Banc Bwyd Salisbury</title>");
    expect(xml).not.toContain("<title>3 eitemau");
    expect(xml).toContain("<description>Cawl tun\nLlaeth hir oes\nCewynnau</description>");
  });

  // The translation is keyed on (language, need_id), so a cy row must not
  // reach the Irish feed -- which falls back to the RAW ENGLISH column, never
  // to the other translation.
  it("falls back to English for a locale with no translation row", async () => {
    seedTranslation({ id: 1, needId: 101, language: "cy", changeText: "Cawl tun" });

    const ga = await body("/ga/needs/rss.xml");
    expect(ga).toContain("<description>Tinned soup\nLong life milk\nNappies</description>");
    expect(ga).not.toContain("Cawl tun");
  });

  // A NULL change_text ON A REAL ROW IS NOT A TRANSLATION. Django's get_text()
  // falls back on FALSINESS (`if not translated_text or not the_text:`), not
  // on row existence -- so a row that only ever carried an excess list must
  // still show the English need list. resolveNeedText() reproduces that with
  // its own truthiness check, and a `!== undefined` written in its place would
  // put an empty description on the page.
  it("falls back to English when the translation row exists but its column is NULL", async () => {
    seedTranslation({ id: 1, needId: 101, language: "cy", changeText: null });

    expect(await body("/cy/needs/rss.xml")).toContain("<description>Tinned soup\nLong life milk\nNappies</description>");
  });

  // Only the need whose row matches gets translated: one Welsh row must not
  // silently become every item's description.
  it("applies a translation only to the need it belongs to", async () => {
    seedTranslation({ id: 1, needId: 102, language: "cy", changeText: "Ffa pob wedi'u cyfieithu" });

    const xml = await body("/cy/needs/rss.xml");

    expect(xml).toContain("<description>Ffa pob wedi&#39;u cyfieithu</description>");
    expect(xml).toContain("<description>Tinned soup\nLong life milk\nNappies</description>");
    expect(xml).toContain("<description>Rice\nTea</description>");
  });

  // Content-Language comes from resolveLanguage and is the header an
  // aggregator reads to decide which of the four feeds it is holding.
  it("stamps Content-Language from the URL prefix", async () => {
    expect((await get("/needs/rss.xml")).headers.get("Content-Language")).toBe("en");
    expect((await get("/cy/needs/at/salisbury/rss.xml")).headers.get("Content-Language")).toBe("cy");
  });
});

// ---------------------------------------------------------------------------
// MUTATION LOG. 33 mutants, 31 killed. Every one was ACTUALLY APPLIED AND RUN,
// in an rsync'd copy of the whole tree OUTSIDE this repository -- no source
// file in the repo was edited and restored (TESTING.md's rule, after a
// reviewer once caught csrf.ts momentarily on disk with its signature check
// deleted). Each mutant was written into the copy, this suite re-run against
// it, and the copy's file restored before the next one.
//
//   routes/wfbn/rss.ts
//     ITEMS_LIMIT 10 -> 20 ......................................... killed
//     `foodbank?.id` -> undefined (site-wide rows on a scoped feed) . killed
//     getRecentArticles used for the scoped feed too ............... killed
//     sort comparator reversed (oldest first) ..................... killed
//     sort dropped entirely ....................................... killed
//     `toDashedUuid(need.need_id)` -> `need.need_id` ............... killed
//     `need.need_id` -> `need.id` in the fragment ................. killed
//     noItems() moved onto the TRANSLATED text .................... killed
//     resolveNeedText's translated argument replaced with null .... killed
//     translation lookup issued in English too .................... killed
//     `needs.length > 0` gate removed ........................... SURVIVED
//     selfUrl's two branches swapped .............................. killed
//     selfUrl built with a hardcoded "en" ......................... killed
//     item links built with a hardcoded "en" ...................... killed
//     `c.env.SITE_DOMAIN` -> context.ts's hardcoded constant ...... killed
//     `foodbank` passed to the template without full_name ......... killed
//     the CHANNEL's fullNameLocaleAware given a hardcoded "en" .... killed
//     the ITEM's fullNameLocaleAware given a hardcoded "en" ....... killed
//     `c.get("lang")` -> a hardcoded "en" ......................... killed
//     `translate(catalogue, "items requested at")` -> another msgid  killed
//     `c.notFound()` -> fall through and render an empty feed ..... killed
//     Content-Type -> "text/xml" .................................. killed
//     render_time_ms dropped from the context ..................... killed
//     pageTranslatable true -> false ............................ SURVIVED
//     a second dbSession(c) opened for the needs query ............ killed
//   packages/db (the queries this route is made of)
//     getRecentPublishedNeedsForRss losing `published = 1` ........ killed
//     ... losing the sentinel `NOT IN` entirely ................... killed
//     ... excluding only 'Nothing' of the three ................... killed
//     ... ordered `created ASC` ................................... killed
//     getRecentArticles gaining `WHERE a.featured = 1` ............ killed
//     ... ordered `published_date ASC` ............................ killed
//     getArticlesByFoodbankId ordered `published_date ASC` ........ killed
//     getNeedTranslationsByIds dropping its `language = ?` ........ killed
//
// BOTH SURVIVORS ARE EQUIVALENT THROUGH THIS ROUTE, and both are recorded
// rather than papered over with an assertion that would only be testing
// something else:
//
//   * the `needs.length > 0` gate is DOUBLY guarded --
//     getNeedTranslationsByIds already returns an empty Map without issuing a
//     statement when the id list is empty, so removing the handler's gate
//     changes nothing observable. Noted on that test above;
//   * `pageTranslatable` is never read by wfbn/rss.njk or by the
//     debugcomment.njk it includes (grepped: no `page_translatable` in
//     either), so this route's value for it cannot reach the response at all.
//     It is dead context here, not an untested behaviour.
//
// An earlier version of this file also let "the channel's fullNameLocaleAware
// given a hardcoded en" survive: the item titles were pinned in cy/gd but the
// channel header only in English, so a Welsh feed could have been titled
// "Caerdydd Foodbank" while every item inside it said "Pantri Bwyd Bae
// Caerdydd". The test that now kills it says so where it sits.
// ---------------------------------------------------------------------------
