import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/public/news.ts -- publicNews, GET /news/ (and /cy//ga//gd/news/).
// Django's `news()` at givefood/views.py:582-590 (@cache_page(SECONDS_IN_HOUR)
// on 581), read alongside this file, together with
// givefood/templates/public/news.html and its public/frags/news.html include.
//
// WHY THIS FILE EXISTS. The whole page is one query and one list, and every
// way of getting it wrong renders a perfect-looking page with a 200:
//
//   * THE MISSING FILTER IS THE FEATURE. news() is the homepage's featured
//     -articles query MINUS `featured = 1` (getRecentArticles vs
//     getFeaturedArticles in packages/db/src/homepage.ts). A copy-paste that
//     kept the filter turns /news/ into a second, smaller homepage panel --
//     168 of 17,194 rows, the split those two files record for production --
//     and nothing errors, nothing looks broken, and the page still says
//     "News" at the top.
//   * ARTICLES_LIMIT (100) appears nowhere in the SQL text and nowhere on a
//     page whose fixture is smaller than it.
//   * the two links in each row come from DIFFERENT places -- the outbound
//     one from FoodbankArticle.url_with_ref(), the food bank one from the
//     JOINED foodbank.slug -- and both produce plausible URLs when wrong.
//   * public/news.njk's `{% set show_time = true %}` is the ONLY difference
//     between this page's rendering of public/frags/news.njk and the
//     homepage's. Django wrote `{% include ... with show_time=True %}`;
//     Nunjucks has no `with`, and the port relies on a top-level {% set %}
//     landing in the object {% include %} hands the partial. If that
//     assumption ever stops holding, every date on this page silently loses
//     its time and the page still renders.
//
// So the assertions below read VALUES out of the rendered body -- titles,
// hrefs, favicons, formatted dates, in order -- never just a status code.
//
// REAL EVERYTHING, the same harness as routes/public.test.ts and
// routes/public/country.test.ts: the real production app
// (workers/site/src/index.ts's default export), so the route registration,
// the four locale registrations, resolveLanguage, cacheTag and
// pageCacheControl are the genuine articles; the real Nunjucks templates and
// .po catalogues; and real in-memory SQLite built by schemaFor() from the
// real migrations. Mocked: only the two KV namespaces, which are Maps,
// because there is no local double.
//
// MUTATION-TESTED, in a copy of the repo outside it: 20 deliberate breakages
// -- ARTICLES_LIMIT, the `featured = 1` filter put back, the ORDER BY
// reversed, the JOIN widened to LEFT, pageTranslatable, the locale, the
// unprefixed path, the canonical path, render_time_ms, the linking rule, the
// url ref merge, titleCapitalised, pageCacheControl's NEWS rule, the P
// token's midnight/noon cases, a second D1 session, and five in the two
// templates (show_time false, the title piped through |safe, the date
// dropped, the h1 untranslated). All 20 were caught. The template ones only
// bite once packages/templates is re-precompiled -- src/generated/precompiled.js
// is what the tests actually execute -- which is worth knowing before
// concluding a .njk edit made no difference.

const ORIGIN = "https://www.givefood.org.uk";

// Tuesday 8 September 2026, mid-morning UTC. Nothing on this page is
// computed from the clock -- there is no hit window here -- but the fixture
// dates are written relative to it, and freezing Date keeps a fixture that
// says "2026-09-10" from quietly becoming the past. Date only: elapsedMs()
// uses performance.now() and must stay real for the "Took Nms" test.
const NOW = new Date("2026-09-08T09:30:00.000Z");

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text AND the values bound
// to it. Both halves are load-bearing here -- the text is where a
// `featured = 1` would reappear, and the binding is the only place
// ARTICLES_LIMIT is visible at all.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite -- the
// same shim routes/public.test.ts and routes/public/country.test.ts use.
function d1Session(db: DatabaseSync, prepared: Prepared[]): D1DatabaseSession {
  return {
    prepare: (sql: string) => {
      const entry: Prepared = { sql, params: [] };
      prepared.push(entry);
      const statement = (params: Bindable[]): unknown => ({
        bind: (...next: unknown[]) => {
          entry.params = next as Bindable[];
          return statement(next as Bindable[]);
        },
        first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
        run: async () => {
          db.prepare(sql).run(...params);
          return { success: true, meta: {} };
        },
      });
      return statement([]);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: Prepared[];
let sessions: number;
let kv: Map<string, string>;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        sessions += 1;
        return d1Session(db, prepared);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns this one query reads are parameterised; every other
// NOT NULL column is filled with whatever the real migration insists on, so a
// seeded row is one production would have accepted.
// ---------------------------------------------------------------------------

function seedFoodbank(id: number, slug: string, name: string): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, network,
       charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative,
       is_closed, no_locations, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79', 'Trussell Trust',
       0, ?, ?, ?, 0, 0, 0, 14, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(id, String(id).padStart(32, "a"), name, slug, `info@${slug}.invalid`, `https://${slug}.invalid/`, `https://${slug}.invalid/list/`);
}

// `published_date` is TEXT and ORDER BY compares it lexicographically, so
// every fixture timestamp is written in Django's own spelling --
// "2026-09-06 15:04:00.000000", a space and six digits of microseconds, the
// form migrations/0022_normalise_timestamps.sql rewrote the stragglers into.
// The last test in the ordering block is what happens when a row arrives in
// some other one.
function seedArticle(o: { id: number; foodbankId: number | null; publishedDate: string; title: string; url: string; featured?: 0 | 1 }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, ?)").run(
    o.id,
    o.foodbankId,
    o.publishedDate,
    o.title,
    o.url,
    o.featured ?? 1,
  );
}

// THE FIXTURE IS THE TEST, so each row turns exactly one rule on or off
// relative to its neighbour.
//
// Food banks -- two whose slug is what Foodbank.save() would have stored,
// and one whose slug is deliberately NOTHING like its name, which is what
// makes "the template links the real joined slug" provable at all:
//   1 salisbury-foodbank  "Salisbury Foodbank"
//   2 vineyard            "St. Mary's Foodbank & Pantry"  slug != slugify(name)
//   3 bath-foodbank       "Bath Foodbank"
//
// Articles, newest first, and every one of them chosen for a reason:
//   id 4  NO food bank at all      2026-09-10  dropped by the INNER JOIN
//   id 5  dangling foodbank_id     2026-09-10  dropped by the INNER JOIN
//   id 3  featured = 0             2026-09-08 noon      -- MUST BE FIRST here
//   id 1  utm querystring, an      2026-09-06 15:04     -- ref merge + acronym
//         acronym and a trailing .                         + trailing-stop
//   id 2  a DATE with no time      2026-09-04           -- P's midnight branch
//
// The two dropped rows and the unfeatured row are all stamped NEWER than
// everything eligible, so any of those three rules failing shows up at the
// TOP of the list rather than somewhere in the middle where it might be
// missed.
function seed(): void {
  seedFoodbank(1, "salisbury-foodbank", "Salisbury Foodbank");
  seedFoodbank(2, "vineyard", "St. Mary's Foodbank & Pantry");
  seedFoodbank(3, "bath-foodbank", "Bath Foodbank");

  seedArticle({ id: 4, foodbankId: null, publishedDate: "2026-09-10 09:00:00.000000", title: "Orphan article", url: "https://news.invalid/orphan" });
  seedArticle({ id: 5, foodbankId: 999, publishedDate: "2026-09-10 08:00:00.000000", title: "Dangling article", url: "https://news.invalid/dangling" });
  seedArticle({ id: 3, foodbankId: 3, publishedDate: "2026-09-08 12:00:00.000000", title: "not featured", url: "https://news.invalid/three", featured: 0 });
  seedArticle({
    id: 1,
    foodbankId: 1,
    publishedDate: "2026-09-06 15:04:00.000000",
    title: "FOODBANK APPEALS FOR uht MILK.",
    url: "https://news.invalid/one?utm_source=tw",
  });
  seedArticle({ id: 2, foodbankId: 2, publishedDate: "2026-09-04", title: "volunteers needed", url: "https://news.invalid/two" });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // schemaFor rather than hand-written DDL: getRecentArticles JOINs
  // `foodbank`, and article_url_uniq (migration 0010) is a real constraint
  // this fixture has to keep satisfying.
  //
  // FOUR TABLES THIS PAGE NEVER READS are here too -- foodbankchange,
  // foodbankchange_full, foodbankhit, site_stats. Two tests below render the
  // HOMEPAGE against the same fixture, because the only way to prove that
  // this page's two differences from it are real (no `featured = 1`, and
  // show_time) is to show the same articles rendering both ways. index()
  // reads all four, and without them it 500s instead of disagreeing.
  db.exec(schemaFor("foodbank", "foodbankarticle", "foodbankchange", "foodbankchange_full", "foodbankhit", "site_stats"));
  seed();
  prepared = [];
  sessions = 0;
  kv = new Map();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const getBody = async (path: string): Promise<string> => (await get(path)).text();

// ---------------------------------------------------------------------------
// Reading the rendered page. The list is one <ul class="foodbank-news"> and
// each article is one <li>, so the assertions can talk in titles, hrefs and
// dates rather than in HTML.
// ---------------------------------------------------------------------------

function ul(body: string, cls: string): string {
  const start = body.indexOf(`<ul class="${cls}">`);
  if (start === -1) throw new Error(`no <ul class="${cls}"> in the rendered page`);
  const end = body.indexOf("</ul>", start);
  return body.slice(start, end);
}

function anchors(html: string): { href: string; text: string }[] {
  return [...html.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1] as string, text: (m[2] as string).trim() }));
}

// public/frags/news.njk emits, per article, a favicon <img>, the outbound
// link, and a second link back to the food bank followed by the date. Same
// reader routes/public.test.ts uses on the homepage's copy of this partial,
// so the two pages' renderings are directly comparable -- which the
// show_time block below relies on.
function newsItems(body: string): { favicon: string; href: string; title: string; foodbankHref: string; foodbank: string; date: string }[] {
  return [...ul(body, "foodbank-news").matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => {
    const li = m[1] as string;
    const favicon = /<img src="([^"]*)"/.exec(li)?.[1] ?? "";
    const [outbound, backlink] = anchors(li);
    const date = /<\/a>\s*([^<]*)<\/div>/.exec(li)?.[1]?.trim() ?? "";
    return {
      favicon,
      href: outbound?.href ?? "",
      title: outbound?.text ?? "",
      foodbankHref: backlink?.href ?? "",
      foodbank: backlink?.text ?? "",
      date,
    };
  });
}

const titles = (body: string) => newsItems(body).map((a) => a.title);

describe("publicNews -- the response envelope", () => {
  // Django's news() carried @cache_page(SECONDS_IN_HOUR), and
  // middleware/pageCacheControl.ts has a NEWS rule that reproduces the shared
  // half of it. An hour rather than the fall-through day is the point: this
  // page is a feed of what has just been published.
  it("serves cacheable HTML for an hour at the edge, five minutes in the browser", async () => {
    const res = await get("/news/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=3600");
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // NO CACHE-TAG, PINNED AS THE CURRENT BEHAVIOUR. middleware/cacheTag.ts
  // derives tags from the PATH, and its AGGREGATE_PATHS list covers "/", the
  // sitemaps and the site-wide feeds but not "/news/" -- even though this
  // page's content changes whenever ANY food bank gains an article, which is
  // the definition of an aggregate. So queues/cachePurge.ts cannot purge it
  // and a new article can be up to an hour late here. Suspect rather than
  // wrong -- the tag set is cacheTag.ts's decision, not this module's -- and
  // recorded here because this is the page where the staleness would be seen.
  it("carries no cache tag, so a new article cannot purge it (suspect, pinned)", async () => {
    expect((await get("/news/")).headers.get("Cache-Tag")).toBeNull();
    // ...while the homepage, whose featured-news panel has exactly the same
    // dependency, does get one.
    expect((await get("/")).headers.get("Cache-Tag")).toBe("fb-all");
  });

  // THE ONE CONSTANT AND THE MISSING FILTER, both otherwise invisible.
  // ARTICLES_LIMIT (100) never appears in the SQL text and never shows on a
  // page whose fixture is smaller than it, so it is asserted on the binding
  // that actually reached the engine. The SQL text is asserted in full for
  // the opposite reason: `WHERE a.featured = 1` is what separates this page
  // from the homepage's panel, and its ABSENCE is not observable in any
  // shape, only in the text and in the rows.
  //
  // ONE SESSION. lib/session.ts opens a single withSession("first-unconstrained")
  // per request; there is only one query here, but a handler that opened a
  // session it then failed to reuse would still render.
  it("reads the list from one D1 session, unfiltered, with the limit the constant declares", async () => {
    await get("/news/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      [
        "SELECT a.id, a.foodbank_id, f.name AS foodbank_name, f.slug AS foodbank_slug, a.published_date, a.title, a.url, a.featured " +
          "FROM foodbankarticle a JOIN foodbank f ON f.id = a.foodbank_id ORDER BY a.published_date DESC LIMIT ?",
        [100],
      ],
    ]);
    expect(prepared[0]?.sql).not.toContain("featured = 1");
  });

  // GET only, matching Django's news(). Worth asserting rather than assuming:
  // the route is registered with app.get, and a stray app.all would hand a
  // POST to a handler whose response pageCacheControl then stamps public for
  // an hour.
  it("does not answer a POST", async () => {
    expect((await get("/news/", { method: "POST" })).status).toBe(404);
  });

  // lib/appendSlash.ts, matching Django's APPEND_SLASH -- /news is a 301, not
  // a 404, because that is the spelling people type and link.
  it("redirects the slashless spelling", async () => {
    const res = await get("/news");

    expect(res.status).toBe(301);
    // Absolute, because appendSlash redirects to the request URL with a
    // slash appended rather than to a bare path.
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/news/`);
  });

  // A D1 outage must produce the 500 page, NOT a News page with an empty
  // list -- and above all must not be cached: pageCacheControl only stamps
  // 200s, so the s-maxage=3600 above cannot attach itself to this. An hour of
  // edge-cached emptiness on the news page is the failure this guards.
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

    const res = await app.fetch(new Request(`${ORIGIN}/news/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain('<ul class="foodbank-news">');
  });

  // elapsedMs() reports WHOLE milliseconds, deliberately unlike Django's
  // three decimal places: on Workers performance.now() is coarsened, so the
  // fraction was always ".000" -- decoration that reads like precision. A
  // revert to toFixed(3) would show up here as "Took 0.000ms".
  it("stamps the debug comment with a whole-millisecond render time", async () => {
    expect(/⏱️ Took (\S+)/.exec(await getBody("/news/"))?.[1]).toMatch(/^\d+ms$/);
  });
});

describe("publicNews -- the article list", () => {
  // EVERY FIELD mapArticleRow() PRODUCES, ON ONE ROW:
  //   favicon      wfbn-generic:foodbank_favicon, from the JOINED slug
  //   href         urlWithRefFoodbank() -- merges ref=givefood.org.uk into the
  //                existing querystring and, unlike the donation-point
  //                variant, KEEPS the utm_ params (Django's
  //                PreparedRequest.prepare_url merge, articles.py:29-33)
  //   title        titleCapitalised(): capwords, then the acronym table (UHT
  //                is in it), then the trailing full stop stripped
  //   foodbank     the JOINED foodbank.name, HTML-escaped by nunjucks
  //   date         |date("j M P") -- see the show_time block below
  it("renders an article with its ref-tagged url, capitalised title and food bank favicon", async () => {
    expect(newsItems(await getBody("/news/"))[1]).toEqual({
      favicon: "/needs/at/salisbury-foodbank/favicon.png",
      href: "https://news.invalid/one?utm_source=tw&amp;ref=givefood.org.uk",
      title: "Foodbank Appeals For UHT Milk",
      foodbankHref: "/needs/at/salisbury-foodbank/",
      foodbank: "Salisbury Foodbank",
      date: "6 Sep 3:04 p.m.",
    });
  });

  // THE WHOLE POINT OF THIS PAGE. news() is index()'s article query without
  // `featured = 1`, so the unfeatured row -- seeded NEWEST of the three, and
  // absent from the homepage entirely -- has to be at the top. A copy-paste
  // that kept the filter passes every other test in this file.
  it("lists unfeatured articles too, newest first", async () => {
    expect(titles(await getBody("/news/"))).toEqual(["Not Featured", "Foodbank Appeals For UHT Milk", "Volunteers Needed"]);
    // The same fixture through the homepage's getFeaturedArticles: the
    // unfeatured row is gone, which is what makes its presence above a real
    // assertion rather than an accident of the seed.
    expect(titles(await getBody("/"))).toEqual(["Foodbank Appeals For UHT Milk", "Volunteers Needed"]);
  });

  // The food bank link and the favicon both come from the JOINED
  // foodbank.slug, not from a slugify() of the denormalised name the way the
  // homepage's "recently updated" panel links. Food bank 2 is stored with
  // slug "vineyard" and a name that slugifies to something else entirely, so
  // this is the row where the two rules are distinguishable -- and where
  // getting it wrong emits a URL that 404s.
  it("links the real foodbank.slug, never a slugify of the name", async () => {
    const row = newsItems(await getBody("/news/"))[2];

    expect(row?.foodbankHref).toBe("/needs/at/vineyard/");
    expect(row?.favicon).toBe("/needs/at/vineyard/favicon.png");
    expect(row?.foodbank).toBe("St. Mary&#39;s Foodbank &amp; Pantry");
  });

  // NO DEDUPLICATION, unlike routes/public/country.ts's recently-updated
  // panel, which keeps one row per food bank name. Django's news() is a plain
  // slice of a queryset with no Python loop after it, so a food bank that
  // published three times in a day takes three of the hundred slots. Pinned
  // because "the news page is all one food bank" is a plausible-looking bug
  // report, and the answer is that it is correct.
  it("repeats a food bank that published more than once", async () => {
    seedArticle({ id: 10, foodbankId: 3, publishedDate: "2026-09-08 13:00:00.000000", title: "Bath again", url: "https://news.invalid/again" });

    const rows = newsItems(await getBody("/news/"));

    expect(rows.map((a) => a.title)).toEqual(["Bath Again", "Not Featured", "Foodbank Appeals For UHT Milk", "Volunteers Needed"]);
    expect(rows.filter((a) => a.foodbank === "Bath Foodbank")).toHaveLength(2);
  });

  // ARTICLES_LIMIT = 100, applied by the query. 101 eligible rows here; the
  // oldest falls off. The limit is the only thing standing between this page
  // and production's 17,194 articles, so it is asserted on the rendered list
  // as well as on the binding above.
  it("stops at a hundred articles, dropping the oldest", async () => {
    for (let i = 0; i < 98; i += 1) {
      seedArticle({
        id: 100 + i,
        foodbankId: 1,
        publishedDate: `2026-10-01 ${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000000`,
        title: `Filler ${i}`,
        url: `https://news.invalid/filler-${i}`,
      });
    }

    const rows = titles(await getBody("/news/"));

    expect(rows).toHaveLength(100);
    // "Volunteers Needed" (2026-09-04) is the oldest of the 101 and the only
    // one that must be missing.
    expect(rows).not.toContain("Volunteers Needed");
    expect(rows).toContain("Not Featured");
    expect(rows).toContain("Filler 0");
  });

  // THE INNER JOIN, PINNED AS-IS AND ALREADY REPORTED. FoodbankArticle.foodbank
  // is `null=True` (givefood/models/articles.py:21), so Django's
  // select_related('foodbank') emits a LEFT OUTER JOIN and a parentless
  // article DOES reach news.html; packages/db's ARTICLE_SELECT uses a plain
  // JOIN and silently drops it. packages/db/src/homepage.test.ts already
  // records this against getRecentArticles itself ("drops parentless
  // articles too (suspect...)"); asserted again here because /news/ is where
  // the loss is user-visible -- both fixture rows are the NEWEST in the
  // table, so a page claiming to be "the last 100 articles" is missing the
  // two most recent.
  it("silently drops an article with no food bank, and one whose food bank has gone (suspect, pinned)", async () => {
    const rows = titles(await getBody("/news/"));

    expect(rows).not.toContain("Orphan Article");
    expect(rows).not.toContain("Dangling Article");
    expect(rows).toHaveLength(3);
  });

  // `published_date` is TEXT compared lexicographically and 'T' (0x54) sorts
  // after ' ' (0x20), so a row written by anything that stamps toISOString()
  // sorts ABOVE every Django-format row of the same date regardless of the
  // time in it -- 01:00Z here beats noon on the same day. Migration
  // 0022_normalise_timestamps.sql rewrote nine such rows in this very column,
  // which is the evidence they occur. Not a defect in this handler, which
  // only asks for ORDER BY published_date DESC; pinned so the next arrival
  // of one is recognised rather than investigated from scratch.
  it("orders by the raw text of published_date, so an ISO-8601 stamp outranks a same-day Django one", async () => {
    seedArticle({ id: 11, foodbankId: 1, publishedDate: "2026-09-08T01:00:00Z", title: "Iso stamped", url: "https://news.invalid/iso" });

    expect(titles(await getBody("/news/"))[0]).toBe("Iso Stamped");
  });

  // ARTICLE TITLES ARE THIRD-PARTY CONTENT. Every row in this table was
  // written by workers/jobs/src/queues/articles.ts from a food bank's own RSS
  // feed (`title: item.title.slice(0, 250)`), so the only thing standing
  // between a compromised or hostile feed and script execution on
  // givefood.org.uk is nunjucks autoescaping. titleCapitalised() runs first
  // and does not escape -- it capitalises -- so this asserts the escape
  // happened at render time, on the page that shows the most of these titles
  // at once.
  it("escapes a title containing markup rather than emitting it", async () => {
    seedArticle({
      id: 12,
      foodbankId: 1,
      publishedDate: "2026-09-09 10:00:00.000000",
      title: '<script>alert("xss")</script>',
      url: "https://news.invalid/xss",
    });

    const body = await getBody("/news/");

    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&lt;script&gt;");
  });

  // ONE BAD ROW TAKES THE WHOLE PAGE DOWN, PINNED AS-IS AND SUSPECT.
  // mapArticleRow -> urlWithRefFoodbank does `new URL(a.url)`, which THROWS
  // on a value that is not an absolute URL, and it runs inside the handler's
  // .map() -- so a single unparseable `url` column 500s /news/ entirely
  // rather than dropping that one row. Reachable: articles.ts stores
  // `item.link` from a food bank's feed verbatim with no validation, and
  // feeds do emit relative links.
  //
  // NOT A DIVERGENCE, as far as reading goes: Django's own url_with_ref()
  // (givefood/models/articles.py:29-33) hands the value to requests'
  // PreparedRequest.prepare_url, which raises MissingSchema on a schemeless
  // url, so news() would have 500'd too. Not verified by running Python in
  // this session -- read from the source only. Pinned rather than fixed
  // because a test may not touch source, and asserting the wish would leave
  // the suite red.
  it("500s the entire page when one article's url is not absolute (suspect, pinned)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedArticle({ id: 13, foodbankId: 1, publishedDate: "2026-09-09 11:00:00.000000", title: "Relative link", url: "/news/story-1" });

    const res = await get("/news/");

    expect(res.status).toBe(500);
    // The three good rows are lost with it -- this is not a page with one
    // article missing.
    expect(await res.text()).not.toContain("Not Featured");
  });

  // An empty table must still render the page -- a fresh D1, or an extract
  // that has not run yet. The <ul> is present and empty rather than the
  // handler throwing on an empty result set.
  it("renders an empty list, not an error, when there are no articles at all", async () => {
    db.prepare("DELETE FROM foodbankarticle").run();

    const body = await getBody("/news/");

    expect(newsItems(body)).toEqual([]);
    expect(body).toContain('<ul class="foodbank-news">');
    expect(body).toContain("<h1>News</h1>");
  });
});

describe("publicNews -- show_time, the one thing this page does differently", () => {
  // public/news.njk's `{% set show_time = true %}` immediately before its
  // {% include %}, standing in for Django's `{% include ... with
  // show_time=True %}` (Nunjucks has no `with`). The partial branches on it:
  // "j M P" here, "j M" everywhere else. THE SAME ARTICLE IS READ FROM BOTH
  // PAGES, because "6 Sep 3:04 p.m." on its own proves only that a date was
  // formatted -- it takes the homepage's "6 Sep" beside it to prove the flag
  // is what made the difference, and that a {% set %} at template top level
  // really does reach the included template's context.
  it("prints the time as well as the date, where the homepage prints only the date", async () => {
    const article = (body: string) => newsItems(body).find((a) => a.title === "Foodbank Appeals For UHT Milk");

    expect(article(await getBody("/news/"))?.date).toBe("6 Sep 3:04 p.m.");
    expect(article(await getBody("/"))?.date).toBe("6 Sep");
  });

  // Django's `P` token has two special cases -- midnight and noon -- ported
  // verbatim in packages/templates/src/filters.ts, and this is the only page
  // on the site that asks for P on this column. Both read oddly enough that
  // someone will eventually file them as bugs, so both are written down:
  //   * a published_date with NO time part parses as T00:00:00Z and renders
  //     "midnight" -- djangoDate() has an explicit branch for the timeless
  //     form, so the value is one the codebase expects to meet, though this
  //     particular column has not been checked against production for it;
  //   * an article published exactly on the hour of noon renders "noon".
  it("renders the midnight and noon special cases rather than a 12-hour time", async () => {
    const rows = newsItems(await getBody("/news/"));

    expect(rows[0]?.date).toBe("8 Sep noon");
    expect(rows[2]?.date).toBe("4 Sep midnight");
  });
});

describe("publicNews -- the page around the list", () => {
  // The three things public/news.njk adds around the include, all of them
  // straight from givefood/templates/public/news.html: the translated title,
  // the h1, and the logo linking home. The `news-page` column class is what
  // the stylesheet hangs the list layout off.
  it("renders the News heading, title and home logo", async () => {
    const body = await getBody("/news/");

    expect(body).toContain("<title>News - Give Food</title>");
    expect(body).toContain("<h1>News</h1>");
    expect(body).toContain('<a href="/" class="logo"><img src="/static/img/logo.svg" alt="Give Food"></a>');
    expect(body).toContain('<div class="column is-two-thirds news-page">');
  });

  // canonical comes from buildPageContext's `path`, which is c.req.path.
  // Django's news() takes no input at all, so a querystring must not reach
  // the canonical URL -- otherwise every ?utm_source= link to this page
  // declares itself a separate document.
  it("declares a canonical url with no querystring", async () => {
    expect(await getBody("/news/?utm_source=newsletter")).toContain('<link rel="canonical" href="https://www.givefood.org.uk/news/">');
  });
});

describe("publicNews -- languages", () => {
  // The handler reads c.get("lang") and passes it to render(), and passes
  // c.get("pathAfterPrefix") so the language switcher can offer "/news/"
  // rather than "/cy/news/" for English. Both are easy to drop and neither
  // changes the status code.
  //
  // THE TWO URL FAMILIES IN ONE ROW DIVERGE HERE, which is the reason this
  // test reads both: `wfbn:foodbank` is in @givefood/urls' I18N_SCOPED set
  // and takes the prefix, while `wfbn-generic:foodbank_favicon` is
  // deliberately absent from it -- those routes are registered BEFORE
  // i18n_patterns in givefood/urls.py, so a favicon must stay unprefixed. A
  // helper that prefixed everything would 404 every icon on this page.
  it("renders the Welsh news page, with prefixed food bank links and unprefixed favicons", async () => {
    const body = await getBody("/cy/news/");
    const row = newsItems(body)[1];

    expect(body).toContain('<html lang="cy" dir="ltr"');
    expect(body).toContain("<title>Newyddion - Give Food</title>");
    expect(body).toContain("<h1>Newyddion</h1>");
    expect(body).toContain('<link rel="canonical" href="https://www.givefood.org.uk/cy/news/">');
    expect(row?.foodbankHref).toBe("/cy/needs/at/salisbury-foodbank/");
    expect(row?.favicon).toBe("/needs/at/salisbury-foodbank/favicon.png");
  });

  // pageTranslatable: true. It gates BOTH the four hreflang alternates in
  // page.njk and the whole language switcher in includes/langswitcher.njk, so
  // passing false (or forgetting it) silently delists three languages from
  // search engines while the page still looks perfect. The alternate URLs are
  // built from pathAfterPrefix, so this also pins that the /news/ segment
  // survives the prefix swap.
  it("advertises all four language variants of the same page", async () => {
    const body = await getBody("/cy/news/");

    for (const [code, url] of [
      ["en", "/news/"],
      ["cy", "/cy/news/"],
      ["ga", "/ga/news/"],
      ["gd", "/gd/news/"],
    ]) {
      expect(body).toContain(`<link rel="alternate" hreflang="${code}" href="${ORIGIN}${url}">`);
    }
    expect(body).toContain('<div class="langswitcher');
  });

  // The other two catalogues, and the article list itself in each -- a page
  // that renders its chrome in Irish but loses its rows would still pass a
  // title-only assertion.
  it("serves the Irish and Scottish Gaelic news pages with the same articles", async () => {
    expect(await getBody("/ga/news/")).toContain("<h1>Nuacht</h1>");
    expect(await getBody("/gd/news/")).toContain("<h1>Naidheachdan</h1>");
    expect(titles(await getBody("/ga/news/"))).toEqual(["Not Featured", "Foodbank Appeals For UHT Milk", "Volunteers Needed"]);
  });

  // "en" is never a URL prefix (prefix_default_language=False in Django, and
  // resolveLanguage's PREFIXES set excludes it here), so /en/news/ is not a
  // second spelling of this page -- it is a 404, as it is in production.
  it("does not answer at /en/news/", async () => {
    expect((await get("/en/news/")).status).toBe(404);
  });
});
