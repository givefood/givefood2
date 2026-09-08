import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/articles.ts -- gfdashArticles, GET /dashboard/articles/.
// Django's gfdash `articles()` at gfdash/views.py:234-241 (@cache_page(
// SECONDS_IN_HOUR) on 233), read alongside this file, together with
// gfdash/templates/dash/articles.html and the port's dash/articles.njk.
//
// WHY THIS FILE EXISTS. The whole page is ONE query and ONE table, and the
// page has no numbers on it that anybody eyeballs -- it is 200 rows of other
// people's headlines, which is exactly the content nobody can spot as wrong.
// Every way of breaking it renders a perfect-looking page with a 200:
//
//   * NO WHERE CLAUSE IS THE FEATURE. This is getRecentArticles(), the same
//     function behind /news/ and the RSS feed, and it differs from the
//     homepage's getFeaturedArticles() only by the absence of
//     `WHERE a.featured = 1`. A copy-paste that took the filter along turns
//     this dashboard into a 175-row homepage panel -- production's own split
//     is 175 featured of 17,248 (migration 0024's measurements) -- and
//     nothing errors, nothing looks empty, and the h1 still says "Articles".
//   * LIMIT (200) appears nowhere in the SQL text and nowhere on a page whose
//     fixture is smaller than it. It is also the ONLY difference between this
//     page's query and /news/'s, so a shared constant that drifted would be
//     invisible from both ends.
//   * THE FOOD BANK LINK IS THE PORT'S ONE DELIBERATE UPGRADE, and it is
//     upgraded to something that looks identical when wrong. Django's
//     template linked `article.foodbank_name_slug`
//     (givefood/models/articles.py:54-55) -- slugify() of the DENORMALISED
//     name copied onto the article by FoodbankArticle.save() (59-60) --
//     where this port links the REAL joined foodbank.slug. Both spellings
//     produce a plausible /needs/at/…/ URL; only one of them resolves.
//   * THE DATE FORMAT IS A PORT ARTEFACT. Django's template printed the bare
//     `{{ article.published_date }}` and let DATETIME_FORMAT do the work;
//     the .njk has to spell that format out as |date("N j, Y, P"). Django's
//     `N` is AP-style, so five months of the year are NOT three letters and a
//     stop ("March", "Sept.") -- a swap to the `M` token changes 5 rows in 12
//     and reads perfectly well.
//
// So the assertions below read VALUES out of the rendered table -- food bank
// names, both hrefs, truncated titles, formatted dates, in order -- never
// just a status code.
//
// REAL EVERYTHING, the same harness as routes/public/news.test.ts and
// routes/public/country.test.ts, whose shims this file reuses verbatim: the
// real production app (workers/site/src/index.ts's default export), so the
// route registration, serverTiming, cacheTag and pageCacheControl are the
// genuine articles; the real Nunjucks templates; and real in-memory SQLite
// built by schemaFor() from the real migrations. Mocked: only the two KV
// namespaces, which are Maps, because there is no local double.
//
// MUTATION-TESTED in a copy of the repo outside it -- see the note at the
// foot of this file for the list of breakages and which test caught each.

const ORIGIN = "https://www.givefood.org.uk";

// Tuesday 8 September 2026, mid-morning UTC. Nothing on this page is computed
// from the clock, but the fixture dates are written relative to it and
// freezing Date keeps a fixture that says "2026-09-10" from quietly becoming
// the past. Date only: elapsedMs() uses performance.now() and must stay real
// for the "Took Nms" test below.
const NOW = new Date("2026-09-08T09:30:00.000Z");

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text AND the values bound
// to it. Both halves are load-bearing -- the text is where a `featured = 1`
// would reappear, and the binding is the only place LIMIT is visible at all.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite -- the
// same shim routes/public/news.test.ts uses.
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
// form migrations/0022_normalise_timestamps.sql rewrote nine stragglers in
// THIS VERY COLUMN into. The last test in the ordering block is what happens
// when a row arrives in some other one.
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
// Food banks -- two whose slug is what Foodbank.save() would have stored, and
// one whose slug is deliberately NOTHING like its name, which is what makes
// "the template links the real joined slug, not a slugify of the name"
// provable at all:
//   1 salisbury-foodbank  "Salisbury Foodbank"
//   2 vineyard            "St. Mary's Foodbank & Pantry"   slug != slugify(name)
//   3 bath-foodbank       "Bath Foodbank"
//
// Articles, newest first, every one chosen for a reason:
//   id 5  NO food bank at all     2026-09-10 09:00  dropped by the INNER JOIN
//   id 6  dangling foodbank_id    2026-09-10 08:00  dropped by the INNER JOIN
//   id 3  featured = 0            2026-09-08 12:00  -- MUST BE FIRST here
//   id 1  utm querystring, an     2026-09-06 15:04  -- ref merge + acronym +
//         acronym, a trailing .                        trailing-stop strip
//   id 2  a DATE with no time     2026-09-04        -- P's midnight branch
//   id 4  a MARCH date            2026-03-03 08:00  -- N's spelled-out months
//
// The two dropped rows and the unfeatured row are all stamped NEWER than
// everything eligible, so any of those three rules failing shows up at the
// TOP of the table rather than somewhere in the middle where it might be
// missed.
function seed(): void {
  seedFoodbank(1, "salisbury-foodbank", "Salisbury Foodbank");
  seedFoodbank(2, "vineyard", "St. Mary's Foodbank & Pantry");
  seedFoodbank(3, "bath-foodbank", "Bath Foodbank");

  seedArticle({ id: 5, foodbankId: null, publishedDate: "2026-09-10 09:00:00.000000", title: "Orphan article", url: "https://news.invalid/orphan" });
  seedArticle({ id: 6, foodbankId: 999, publishedDate: "2026-09-10 08:00:00.000000", title: "Dangling article", url: "https://news.invalid/dangling" });
  seedArticle({ id: 3, foodbankId: 3, publishedDate: "2026-09-08 12:00:00.000000", title: "not featured", url: "https://news.invalid/three", featured: 0 });
  seedArticle({
    id: 1,
    foodbankId: 1,
    publishedDate: "2026-09-06 15:04:00.000000",
    title: "FOODBANK APPEALS FOR uht MILK.",
    url: "https://news.invalid/one?utm_source=tw",
  });
  seedArticle({ id: 2, foodbankId: 2, publishedDate: "2026-09-04", title: "volunteers needed", url: "https://news.invalid/two" });
  seedArticle({ id: 4, foodbankId: 3, publishedDate: "2026-03-03 08:00:00.000000", title: "spring appeal", url: "https://news.invalid/four" });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // schemaFor rather than hand-written DDL: getRecentArticles JOINs
  // `foodbank`, and article_url_uniq (migration 0010) is a real constraint
  // this fixture has to keep satisfying -- a seed that violated it would
  // otherwise pass here and be impossible in production.
  //
  // FOUR TABLES THIS PAGE NEVER READS are here too -- foodbankchange,
  // foodbankchange_full, foodbankhit, site_stats. One test below renders the
  // HOMEPAGE against the same fixture, because "this page gets no cache tag"
  // is only worth asserting beside a page that does. index() reads all four,
  // and without them it 500s instead of disagreeing.
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
// Reading the rendered page. dash/articles.njk emits one
// <table class="table is-narrow is-fullwidth"> whose every <tr> is three
// <td>s -- food bank link, article link, date -- so the assertions can talk
// in names, hrefs and dates rather than in HTML. It is the page's only
// <table>; the breadcrumb and the footer are <ul>s.
// ---------------------------------------------------------------------------

interface Row {
  foodbank: string;
  foodbankHref: string;
  title: string;
  href: string;
  date: string;
}

function rows(body: string): Row[] {
  const start = body.indexOf('<table class="table is-narrow is-fullwidth">');
  if (start === -1) throw new Error("no articles <table> in the rendered page");
  const table = body.slice(start, body.indexOf("</table>", start));
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((tr) => {
    const cells = [...(tr[1] as string).matchAll(/<td>([\s\S]*?)<\/td>/g)].map((td) => (td[1] as string).trim());
    const link = (cell: string | undefined) => /<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(cell ?? "");
    const fb = link(cells[0]);
    const article = link(cells[1]);
    return {
      foodbank: fb?.[2]?.trim() ?? "",
      foodbankHref: fb?.[1] ?? "",
      title: article?.[2]?.trim() ?? "",
      href: article?.[1] ?? "",
      date: cells[2] ?? "",
    };
  });
}

const titles = (body: string) => rows(body).map((r) => r.title);

describe("gfdashArticles -- the response envelope", () => {
  // A DELIBERATE-LOOKING DIVERGENCE THAT NOBODY DECIDED, pinned as current
  // behaviour. Django's articles() carried @cache_page(SECONDS_IN_HOUR);
  // middleware/pageCacheControl.ts's SHARED_TTL list names the home page,
  // /news/ and the country pages for the hour and has no entry for
  // /dashboard/*, so this page falls through to the DAY default. Combined
  // with the missing cache tag below, a newly crawled article can be 24 hours
  // late here where Django had it one hour late. Suspect, and reported --
  // but it is pageCacheControl's decision to make, not this module's, so the
  // assertion records what ships.
  it("serves cacheable HTML for a DAY at the edge where Django said an hour (suspect, pinned)", async () => {
    const res = await get("/dashboard/articles/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // NO CACHE-TAG, PINNED AS THE CURRENT BEHAVIOUR. middleware/cacheTag.ts
  // derives tags from the PATH and its AGGREGATE_PATHS list covers "/", the
  // sitemaps and the site-wide feeds but nothing under /dashboard/ -- even
  // though this page's content changes whenever ANY food bank gains an
  // article, which is the definition of an aggregate. So queues/cachePurge.ts
  // cannot purge it. Asserted against the homepage, whose featured-article
  // panel has exactly the same dependency and does get a tag, so this is a
  // real difference rather than an accident of the request.
  it("carries no cache tag, so a new article cannot purge it (suspect, pinned)", async () => {
    expect((await get("/dashboard/articles/")).headers.get("Cache-Tag")).toBeNull();
    // ...while the homepage, whose featured-article panel has exactly the
    // same dependency, does get one from the same middleware on the same
    // fixture. Without this second half, a null Cache-Tag would also be what
    // an unmounted cacheTag middleware produced.
    expect((await get("/")).headers.get("Cache-Tag")).toBe("fb-all");
  });

  // THE ONE CONSTANT AND THE MISSING WHERE CLAUSE, both otherwise invisible.
  // LIMIT = 200 never appears in the SQL text and never shows on a page whose
  // fixture is smaller than it, so it is asserted on the binding that
  // actually reached the engine -- and 200, not /news/'s 100, is the only
  // thing separating these two callers of getRecentArticles().
  //
  // The SQL text is asserted in full for the opposite reason: Django's
  // `FoodbankArticle.objects.all()` has no filter whatsoever, so the ABSENCE
  // of a WHERE clause is not observable in any shape -- only in the text and
  // in the rows.
  //
  // ONE SESSION. lib/session.ts opens a single withSession("first-unconstrained")
  // per request; there is only one query here, but a handler that opened a
  // session it then failed to reuse would still render.
  it("reads the list from one D1 session, unfiltered, with the limit the constant declares", async () => {
    await get("/dashboard/articles/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      [
        "SELECT a.id, a.foodbank_id, f.name AS foodbank_name, f.slug AS foodbank_slug, a.published_date, a.title, a.url, a.featured " +
          "FROM foodbankarticle a JOIN foodbank f ON f.id = a.foodbank_id ORDER BY a.published_date DESC LIMIT ?",
        [200],
      ],
    ]);
    // Spelled out separately from the equality above so a future rewrite of
    // the SELECT list cannot quietly reintroduce the homepage's filter while
    // someone updates the expected string to match.
    expect(prepared[0]?.sql).not.toContain("WHERE");
    expect(prepared[0]?.sql).not.toContain("featured = 1");
  });

  // GET only, matching gfdash/urls.py. Worth asserting rather than assuming:
  // the route is registered with app.get, and a stray app.all would hand a
  // POST to a handler whose response pageCacheControl then stamps public for
  // a day.
  it("does not answer a POST", async () => {
    expect((await get("/dashboard/articles/", { method: "POST" })).status).toBe(404);
  });

  // lib/appendSlash.ts, matching Django's APPEND_SLASH -- the slashless
  // spelling is the one people type and paste, and it must reach the page
  // rather than the 404 handler it is routed through.
  it("redirects the slashless spelling", async () => {
    const res = await get("/dashboard/articles");

    expect(res.status).toBe(301);
    // Absolute, because appendSlash redirects to the request URL with a slash
    // appended rather than to a bare path.
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/dashboard/articles/`);
  });

  // A D1 outage must produce the 500 page, NOT an Articles page with an empty
  // table -- and above all must not be cached: pageCacheControl only stamps
  // 200s, so the s-maxage=86400 above cannot attach itself to this. A DAY of
  // edge-cached emptiness is the failure this guards, and on an unattended
  // dashboard nobody would notice it.
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

    const res = await app.fetch(new Request(`${ORIGIN}/dashboard/articles/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain('<table class="table is-narrow is-fullwidth">');
  });

  // elapsedMs() reports WHOLE milliseconds, deliberately unlike Django's
  // three decimal places: on Workers performance.now() is coarsened, so the
  // fraction was always ".000". The value comes from serverTiming's
  // requestStartTime, which only exists because the REAL app is mounted here
  // -- a handler called directly would render "TookNaNms".
  it("stamps the debug comment with a whole-millisecond render time", async () => {
    expect(/⏱️ Took (\S+)/.exec(await getBody("/dashboard/articles/"))?.[1]).toMatch(/^\d+ms$/);
  });
});

describe("gfdashArticles -- the table", () => {
  // EVERY FIELD ON ONE ROW, and every one of them from a different rule:
  //   foodbank      the JOINED foodbank.name (Django read the denormalised
  //                 copy FoodbankArticle.save() stamped on at insert time --
  //                 nothing cascades a rename onto it, read from
  //                 givefood/models/foodbank.py, not run -- so this port
  //                 shows the CURRENT name where Django showed a stale one)
  //   foodbankHref  url('wfbn:foodbank', foodbank.slug)
  //   href          urlWithRefFoodbank() -- merges ref=givefood.org.uk into
  //                 the existing querystring and, unlike the donation-point
  //                 variant, KEEPS the utm_ params (Django's
  //                 PreparedRequest.prepare_url merge, articles.py:29-33)
  //   title         titleCapitalised(): capwords, then the acronym table
  //                 (UHT is in it), then the trailing full stop stripped
  //   date          |date("N j, Y, P") -- Django's DATETIME_FORMAT, which its
  //                 own template got for free from a bare {{ ... }}
  it("renders an article with its ref-tagged url, capitalised title and formatted date", async () => {
    expect(rows(await getBody("/dashboard/articles/"))[1]).toEqual({
      foodbank: "Salisbury Foodbank",
      foodbankHref: "/needs/at/salisbury-foodbank/",
      title: "Foodbank Appeals For UHT Milk",
      href: "https://news.invalid/one?utm_source=tw&amp;ref=givefood.org.uk",
      date: "Sept. 6, 2026, 3:04 p.m.",
    });
  });

  // THE WHOLE POINT OF THIS PAGE. articles() is index()'s article query
  // without `featured = 1`, so the unfeatured row -- seeded NEWEST of the
  // four eligible -- has to be at the top. A copy-paste from the homepage
  // that kept the filter passes every other test in this file.
  it("lists unfeatured articles too, newest first", async () => {
    expect(titles(await getBody("/dashboard/articles/"))).toEqual([
      "Not Featured",
      "Foodbank Appeals For UHT Milk",
      "Volunteers Needed",
      "Spring Appeal",
    ]);

    // The SAME FIXTURE through the homepage's getFeaturedArticles(): the
    // unfeatured row is absent there. That contrast is what makes its
    // presence at the top of this table an assertion rather than an accident
    // of the seed -- with only the dashboard read, a fixture where every row
    // happened to be featured would pass identically.
    const homepage = await getBody("/");
    expect(homepage).toContain("Foodbank Appeals For UHT Milk");
    expect(homepage).not.toContain("Not Featured");
  });

  // THE PORT'S ONE DELIBERATE UPGRADE OVER DJANGO, and the row that makes it
  // provable. Food bank 2 is stored with slug "vineyard" and a name that
  // slugifies to "st-marys-foodbank-pantry", so the two rules -- the joined
  // foodbank.slug this port uses, and the slugify(foodbank_name) Django's
  // template used -- produce visibly different URLs. Getting it wrong emits a
  // /needs/at/… link that 404s on every row whose food bank has been renamed
  // or given a custom slug.
  //
  // The name is also asserted ESCAPED: nunjucks autoescaping is the only
  // thing between a food bank name with an apostrophe or ampersand in it and
  // broken markup, and this table prints 200 of them.
  it("links the real foodbank.slug, never a slugify of the name", async () => {
    const row = rows(await getBody("/dashboard/articles/"))[2];

    expect(row?.foodbankHref).toBe("/needs/at/vineyard/");
    expect(row?.foodbankHref).not.toBe("/needs/at/st-marys-foodbank-pantry/");
    expect(row?.foodbank).toBe("St. Mary&#39;s Foodbank &amp; Pantry");
  });

  // DJANGO'S `N` TOKEN IS NOT A THREE-LETTER ABBREVIATION. django.utils.dates
  // .MONTHS_AP spells March, April, May, June and July out in full and writes
  // September as "Sept.", so five months in twelve differ from the `M` token
  // this format is one keystroke away from. Both spellings read perfectly
  // well on a page of dates, which is why the fixture carries a March row
  // alongside the September ones.
  it("formats months in Django's AP style, not as three-letter abbreviations", async () => {
    const dates = rows(await getBody("/dashboard/articles/")).map((r) => r.date);

    expect(dates[3]).toBe("March 3, 2026, 8 a.m.");
    expect(dates[0]).toBe("Sept. 8, 2026, noon");
  });

  // Django's `P` token has two special cases -- midnight and noon -- ported
  // verbatim in packages/templates/src/filters.ts. Both read oddly enough
  // that someone will eventually file them as bugs, so both are written down:
  //   * an article published exactly at noon renders "noon";
  //   * a published_date with NO time part parses as T00:00:00Z and renders
  //     "midnight" -- djangoDate() has an explicit branch for the timeless
  //     form, and this column is TEXT with no format constraint, so the value
  //     is one the codebase expects to meet.
  // Note the minutes are dropped on the hour ("8 a.m.", above) too -- that is
  // Django's `P`, not a truncation.
  it("renders the midnight and noon special cases rather than a 12-hour time", async () => {
    const dates = rows(await getBody("/dashboard/articles/")).map((r) => r.date);

    expect(dates[0]).toBe("Sept. 8, 2026, noon");
    expect(dates[2]).toBe("Sept. 4, 2026, midnight");
  });

  // |truncatewords(10), the one thing this template does that /news/'s does
  // not. RSS titles run long -- workers/jobs/src/queues/articles.ts stores
  // `item.title.slice(0, 250)` -- and without the truncation one headline
  // pushes the three-column layout apart for all 200 rows. Django's
  // Truncator appends " …" (space, then a single ellipsis CHARACTER, not
  // three dots), which is the detail a reimplementation gets wrong.
  it("truncates a long title at ten words with Django's space-plus-ellipsis", async () => {
    seedArticle({
      id: 20,
      foodbankId: 1,
      publishedDate: "2026-09-09 10:00:00.000000",
      title: "one two three four five six seven eight nine ten eleven twelve",
      url: "https://news.invalid/long",
    });

    const row = rows(await getBody("/dashboard/articles/"))[0];

    expect(row?.title).toBe("One Two Three Four Five Six Seven Eight Nine Ten …");
    // The capitalisation happens BEFORE the truncation, and the words past
    // the tenth are gone rather than merely hidden by CSS.
    expect(row?.title).not.toContain("Eleven");
  });

  // LIMIT = 200, applied by the query. 201 eligible rows here; the oldest
  // falls off. The limit is the only thing standing between this page and
  // production's 17,248 articles, so it is asserted on the rendered table as
  // well as on the binding above -- an off-by-one in either direction is
  // invisible on any smaller fixture.
  it("stops at two hundred articles, dropping the oldest", async () => {
    for (let i = 0; i < 197; i += 1) {
      seedArticle({
        id: 100 + i,
        foodbankId: 1,
        publishedDate: `2026-10-01 ${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000000`,
        title: `Filler ${i}`,
        url: `https://news.invalid/filler-${i}`,
      });
    }

    const rendered = titles(await getBody("/dashboard/articles/"));

    expect(rendered).toHaveLength(200);
    // "Spring Appeal" (2026-03-03) is the oldest of the 201 and the only one
    // that must be missing.
    expect(rendered).not.toContain("Spring Appeal");
    expect(rendered).toContain("Volunteers Needed");
    expect(rendered).toContain("Filler 0");
  });

  // THE INNER JOIN, PINNED AS-IS AND REPORTED. FoodbankArticle.foodbank is
  // `null=True` (givefood/models/articles.py:21) and Django's articles() does
  // a bare `.objects.all()` with no join at all, so a parentless article DID
  // reach dash/articles.html -- its template read the denormalised
  // foodbank_name and foodbank_name_slug, which for a null foodbank are an
  // empty cell and slugify(None) == "none". packages/db's ARTICLE_SELECT uses
  // a plain JOIN and silently drops the row instead.
  //
  // Read from the Django source, not run. packages/db/src/homepage.test.ts
  // already records the same divergence against getRecentArticles itself;
  // asserted again here because this page's own strapline claims "All the
  // recent articles we've found published by all the food banks we know of",
  // and both fixture rows are the NEWEST in the table -- so the page missing
  // them is missing the two most recent things it exists to show.
  it("silently drops an article with no food bank, and one whose food bank has gone (suspect, pinned)", async () => {
    const rendered = titles(await getBody("/dashboard/articles/"));

    expect(rendered).not.toContain("Orphan Article");
    expect(rendered).not.toContain("Dangling Article");
    expect(rendered).toHaveLength(4);
  });

  // NO DEDUPLICATION and no per-food-bank cap, unlike routes/public/country.ts's
  // recently-updated panel. Django's articles() is a plain slice of a queryset
  // with no Python loop after it, so one prolific food bank can take every
  // slot. Pinned because "the articles dashboard is all one food bank" is a
  // plausible-looking bug report, and the answer is that it is correct.
  it("repeats a food bank that published more than once", async () => {
    seedArticle({ id: 21, foodbankId: 3, publishedDate: "2026-09-08 13:00:00.000000", title: "Bath again", url: "https://news.invalid/again" });

    const rendered = rows(await getBody("/dashboard/articles/"));

    expect(rendered.map((r) => r.title)).toEqual([
      "Bath Again",
      "Not Featured",
      "Foodbank Appeals For UHT Milk",
      "Volunteers Needed",
      "Spring Appeal",
    ]);
    expect(rendered.filter((r) => r.foodbank === "Bath Foodbank")).toHaveLength(3);
  });

  // `published_date` is TEXT compared lexicographically and 'T' (0x54) sorts
  // after ' ' (0x20), so a row written by anything that stamps toISOString()
  // sorts ABOVE every Django-format row of the same date regardless of the
  // time in it -- 01:00Z here beats noon on the same day. Migration
  // 0022_normalise_timestamps.sql rewrote nine such rows in this very column,
  // which is the evidence they occur. Not a defect in this handler, which
  // only asks for ORDER BY published_date DESC; pinned so the next arrival of
  // one is recognised rather than investigated from scratch.
  it("orders by the raw text of published_date, so an ISO-8601 stamp outranks a same-day Django one", async () => {
    seedArticle({ id: 22, foodbankId: 1, publishedDate: "2026-09-08T01:00:00Z", title: "Iso stamped", url: "https://news.invalid/iso" });

    expect(titles(await getBody("/dashboard/articles/"))[0]).toBe("Iso Stamped");
  });

  // ARTICLE TITLES ARE THIRD-PARTY CONTENT. Every row in this table was
  // written by workers/jobs/src/queues/articles.ts from a food bank's own RSS
  // feed, so the only thing between a compromised or hostile feed and script
  // execution on givefood.org.uk is nunjucks autoescaping. titleCapitalised()
  // and truncatewords() both run first and neither escapes, so this asserts
  // the escape happened at RENDER time -- on the page that shows the most of
  // these titles at once.
  it("escapes a title containing markup rather than emitting it", async () => {
    seedArticle({
      id: 23,
      foodbankId: 1,
      publishedDate: "2026-09-09 11:00:00.000000",
      title: '<script>alert("xss")</script>',
      url: "https://news.invalid/xss",
    });

    const body = await getBody("/dashboard/articles/");

    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&lt;script&gt;");
  });

  // ONE BAD ROW TAKES THE WHOLE PAGE DOWN, PINNED AS-IS AND SUSPECT.
  // mapArticleRow -> urlWithRefFoodbank does `new URL(a.url)`, which THROWS
  // on anything that is not an absolute URL, and it runs inside the handler's
  // .map() -- so a single unparseable `url` column 500s /dashboard/articles/
  // entirely rather than dropping that one row. Reachable: queues/articles.ts
  // stores `item.link` from a food bank's feed verbatim with no validation,
  // and feeds do emit relative links. This page's 200-row window is four
  // times /news/'s, so it meets such a row first and stays broken longer.
  //
  // NOT A DIVERGENCE as far as reading goes: Django's url_with_ref()
  // (givefood/models/articles.py:29-33) hands the value to requests'
  // PreparedRequest.prepare_url, which raises MissingSchema on a schemeless
  // url, so articles() would have 500'd too. Read from the source only, not
  // verified by running Python in this session. Pinned rather than fixed
  // because a test may not touch source, and asserting the wish would leave
  // the suite permanently red.
  it("500s the entire page when one article's url is not absolute (suspect, pinned)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedArticle({ id: 24, foodbankId: 1, publishedDate: "2026-09-09 12:00:00.000000", title: "Relative link", url: "/news/story-1" });

    const res = await get("/dashboard/articles/");

    expect(res.status).toBe(500);
    // The four good rows go with it -- this is not a page with one article
    // missing.
    expect(await res.text()).not.toContain("Not Featured");
  });

  // An empty table must still render the page -- a fresh D1, or an extract
  // that has not run yet. The <table> is present and empty rather than the
  // handler throwing on an empty result set.
  it("renders an empty table, not an error, when there are no articles at all", async () => {
    db.prepare("DELETE FROM foodbankarticle").run();

    const body = await getBody("/dashboard/articles/");

    expect(rows(body)).toEqual([]);
    expect(body).toContain('<table class="table is-narrow is-fullwidth">');
    expect(body).toContain("<h1>Articles</h1>");
  });
});

describe("gfdashArticles -- the page around the table", () => {
  // The chrome dash/articles.njk adds, straight from
  // gfdash/templates/dash/articles.html: the title, the h1, the strapline and
  // the logo linking home.
  it("renders the Articles heading, title, strapline and home logo", async () => {
    const body = await getBody("/dashboard/articles/");

    expect(body).toContain("<title>Articles Dashboard - Give Food</title>");
    expect(body).toContain("<h1>Articles</h1>");
    // The apostrophe is a LITERAL in the template, so it survives unescaped
    // -- unlike the identical character inside a food bank NAME above, which
    // autoescaping turns into &#39;. Both spellings are asserted in this file
    // so neither can be "fixed" into the other.
    expect(body).toContain("<p>All the recent articles we've found published by all the food banks we know of</p>");
    expect(body).toContain('<a href="/" class="logo"><img src="/static/img/logo.svg" alt="Give Food"></a>');
  });

  // The three breadcrumb links, all built by url() from @givefood/urls'
  // ROUTES rather than written out. A mistyped route NAME is the failure
  // here: urlForLocale on an unknown name produces no href a reader would
  // notice, and this is the only navigation off a dashboard page.
  it("renders a Home / Dashboards / Articles breadcrumb", async () => {
    const body = await getBody("/dashboard/articles/");
    const nav = body.slice(body.indexOf('<nav class="breadcrumb'), body.indexOf("</nav>"));

    expect([...nav.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], (m[2] as string).trim()])).toEqual([
      ["/", "Home"],
      ["/dashboard/", "Dashboards"],
      ["/dashboard/articles/", "Articles"],
    ]);
  });

  // canonical comes from buildPageContext's `path`, which is c.req.path.
  // Django's articles() takes no input at all, so a querystring must not
  // reach the canonical URL -- otherwise every ?utm_source= link to this page
  // declares itself a separate document.
  it("declares a canonical url with no querystring", async () => {
    expect(await getBody("/dashboard/articles/?utm_source=newsletter")).toContain(
      '<link rel="canonical" href="https://www.givefood.org.uk/dashboard/articles/">',
    );
  });
});

describe("gfdashArticles -- not a translated page", () => {
  // gfdash sits in givefood/urls.py's "Untranslated apps" block, OUTSIDE
  // i18n_patterns, so index.ts registers the dashboards with no locale loop.
  // /cy/dashboard/articles/ is therefore a 404 in production and must stay
  // one -- a locale loop copy-pasted from the /needs/ block would silently
  // create three more URLs serving an English page, each one a duplicate for
  // search engines and a translation bug report waiting to happen.
  it("does not answer under a language prefix", async () => {
    for (const locale of ["cy", "ga", "gd", "en"]) {
      expect((await get(`/${locale}/dashboard/articles/`)).status).toBe(404);
    }
  });

  // pageContext() here passes NEITHER `locale` NOR `pageTranslatable` to
  // buildPageContext, so page_translatable is false and page.njk emits no
  // hreflang alternates -- the opposite of /news/, which advertises four.
  // page_translatable is the gate that matters: adding a `locale` alone was
  // mutation-tested below and changes nothing observable on this page (it
  // only fills a `languages` list that no template here reads), whereas
  // turning pageTranslatable on would advertise three language variants of a
  // page that 404s in all three.
  it("advertises no language alternates", async () => {
    const body = await getBody("/dashboard/articles/");

    expect(body).not.toContain("hreflang");
    expect(body).not.toContain("langswitcher");
    expect(body).toContain('<html lang="en" dir="ltr"');
  });
});

// MUTATION-TESTED 2026-09-08 in a copy of the whole repo under the
// scratchpad (never in place), one breakage at a time, re-precompiling
// packages/templates for the .njk ones -- src/generated/precompiled.js is
// what the tests actually execute, which is worth knowing before concluding a
// template edit made no difference. 19 mutants, 18 caught (failing tests in
// brackets):
//
//   LIMIT 200 -> 100                            caught (2)
//   getRecentArticles -> getFeaturedArticles     caught (9)
//   ORDER BY published_date DESC -> ASC          caught (10)
//   ARTICLE_SELECT's JOIN widened to LEFT JOIN   caught (11)
//   mapArticleRow dropped, raw rows passed       caught (15)
//   url_with_ref -> the raw article url          caught (1)
//   foodbank.slug -> foodbank.name|slugify       caught (1 -- the vineyard row)
//   foodbank.name -> foodbank.slug in the cell   caught (3)
//   |date("N j, Y, P") -> "M j, Y, P"            caught (3 -- the March row)
//   |truncatewords(10) -> (20)                   caught (1)
//   Django's " …" -> "..."                       caught (1)
//   render_time_ms dropped                       caught (1)
//   c.req.path -> c.req.url in pageContext       caught (1 -- canonical)
//   a second dbSession(c) per request            caught (1 -- session count)
//   locale AND pageTranslatable passed           caught (1 -- hreflang)
//   /cy/dashboard/articles/ also registered      caught (1)
//   pageCacheControl given a dashboard rule      caught (1 -- the s-maxage)
//   cacheTag given a /dashboard/ aggregate rule  caught (1 -- the Cache-Tag)
//
// THE ONE SURVIVOR, deliberately left alive: passing `locale: "en"` to
// buildPageContext WITHOUT pageTranslatable changes nothing in the rendered
// page. It only fills the `languages` list, which page.njk reads solely
// inside its `{% if page_translatable %}` block and which this page's
// template never touches otherwise. That is a no-op, not an escaped defect,
// and a test written to catch it would be pinning an implementation detail.
