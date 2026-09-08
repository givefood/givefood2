import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import type { AppEnv } from "../types";

// routes/public.ts -- publicIndex, the homepage. Django's `index()` at
// givefood/views.py:77-209 (read alongside this file; the LOGOS list, the
// three panel queries and the map config below are all verbatim from it).
//
// WHY THIS FILE EXISTS. This is the most-requested page on the site and
// almost everything on it is DATA rather than structure: four panels, four
// queries, four ways to be quietly wrong. Nothing here fails loudly --
//
//   * a broken "recently updated" filter shows unpublished or sentinel
//     ('Unknown'/'Facebook'/'Nothing') changes as if they were real needs,
//     with a 200 and a page that looks exactly right;
//   * a "most viewed" window off by a day silently reranks the panel;
//   * the two panels link food banks by DIFFERENT rules on purpose --
//     recently_updated by slugify(name), most_viewed by the real
//     foodbank.slug -- and swapping either produces a plausible-looking URL
//     that 404s;
//   * with no site_stats row the four statistics render the literal string
//     "undefined" (see the test that pins it).
//
// So the tests below assert VALUES pulled out of the rendered body -- the
// hrefs and the names, the ranked order, the formatted numbers -- not that
// the page came back 200.
//
// REAL EVERYTHING, the same harness as routes/public/sitemaps.test.ts and
// routes/public/md.test.ts: the real production app (workers/site/src/index.ts's
// default export) so the route registrations, the language middleware and
// pageCacheControl are the genuine articles, real Nunjucks templates, and real
// in-memory SQLite built by schemaFor() from the real migrations -- which
// matters here because `recently_updated` reads through the
// `foodbankchange_full` VIEW, and the view's LEFT JOIN is the only reason a
// change row pointing at a deleted food bank is droppable at all. Mocked: the
// two KV namespaces (Maps), because there is no local double.
//
// MUTATION-TESTED, in a copy of the repo outside it: 22 deliberate breakages
// of routes/public.ts (each limit, the seven-day window, the two date bounds
// swapped, slugify() dropped, the locale ignored, pageTranslatable false,
// enable_write false, a D1 session per query, every map_config field, a logo's
// file extension) and 8 of the shared queries in packages/db/src/homepage.ts
// (each WHERE clause and each ORDER BY). All 30 were caught. That is the
// evidence these assertions are load-bearing rather than decorative.

const ORIGIN = "https://www.givefood.org.uk";

// Wednesday 8 September 2026, mid-morning UTC. The homepage's "most viewed
// this week" window is computed from `new Date()`, so without a frozen clock
// every hit-window assertion below would be untestable. Date only -- nothing
// on this path waits on a timer, and elapsedMs() uses performance.now(),
// which must stay real for the "Took Nms" test.
const NOW = new Date("2026-09-08T09:30:00.000Z");

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text AND the values bound
// to it. The bindings are the load-bearing half here -- RECENTLY_UPDATED_LIMIT,
// MOST_VIEWED_LIMIT, ARTICLES_LIMIT and MOST_VIEWED_DAYS are module constants
// in routes/public.ts that never appear in the SQL text and are invisible in
// the rendered page until a fixture happens to overflow one of them.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite -- the
// same shim routes/public/sitemaps.test.ts uses, extended to record bindings.
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
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns these four queries read are parameterised; the rest
// are whatever the real migration insists on, so a seeded row is one
// production would have accepted.
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

// `created` is TEXT and is compared lexicographically, so every fixture
// timestamp is written in Django's own spelling -- "2026-09-05 19:28:08.853000",
// a space and six digits of microseconds. The last test in the
// recently-updated block below is what happens when a row arrives in some
// other one.
function seedChange(o: { id: number; foodbankId: number | null; created: string; text?: string; published?: 0 | 1 }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 'scrape', ?, ?)`,
  ).run(o.id, `need-${o.id}`, o.foodbankId, o.text ?? "Beans\nPasta", o.published ?? 1, o.created, o.created);
}

function seedHit(foodbankId: number, day: string, hits: number): void {
  db.prepare("INSERT INTO foodbankhit (foodbank_id, day, hits) VALUES (?, ?, ?)").run(foodbankId, day, hits);
}

function seedArticle(o: { id: number; foodbankId: number; publishedDate: string; title: string; url: string; featured?: 0 | 1 }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, ?)").run(
    o.id,
    o.foodbankId,
    o.publishedDate,
    o.title,
    o.url,
    o.featured ?? 1,
  );
}

function seedStats(foodbanks: number, donationpoints: number, items: number, meals: number): void {
  db.prepare("INSERT INTO site_stats (id, foodbanks, donationpoints, items, meals, computed_at) VALUES (1, ?, ?, ?, ?, '2026-09-08 04:00:00.000000')").run(
    foodbanks,
    donationpoints,
    items,
    meals,
  );
}

// THE FIXTURE IS THE TEST, so each row exists to turn exactly one rule on or
// off relative to its neighbour.
//
// Food banks -- three whose slug is what Django's Foodbank.save() would have
// stored, and one whose slug is deliberately NOTHING like its name, which is
// what makes the two panels' different linking rules distinguishable at all:
//   1 salisbury-foodbank  "Salisbury Foodbank"            slug == slugify(name)
//   2 vineyard            "St. Mary's Foodbank & Pantry"  slug != slugify(name)
//   3 bath-foodbank       "Bath Foodbank"
//   4 truro-foodbank      "Truro Foodbank"
//
// Changes -- three eligible ones, then one instance of every exclusion, each
// stamped NEWER than all three so a lost filter shows up at the TOP of the
// panel rather than somewhere in the middle where it might be missed.
//
// Hits -- today is 2026-09-08, so the window is 2026-09-01..2026-09-08:
//   bath      100 today + 50 yesterday = 150   (summing across days)
//   salisbury 120 on 2026-09-01, exactly seven days back -- INCLUDED
//   truro     10 today + 999 TOMORROW          (the future row must not count;
//                                               if it did, truro would rank first)
//   vineyard  999 on 2026-08-31, eight days back -- EXCLUDED entirely
//
// Articles -- two featured, plus a non-featured one dated later than both.
function seed(): void {
  seedFoodbank(1, "salisbury-foodbank", "Salisbury Foodbank");
  seedFoodbank(2, "vineyard", "St. Mary's Foodbank & Pantry");
  seedFoodbank(3, "bath-foodbank", "Bath Foodbank");
  seedFoodbank(4, "truro-foodbank", "Truro Foodbank");

  seedChange({ id: 1, foodbankId: 2, created: "2026-09-07 08:00:00.000000" });
  seedChange({ id: 2, foodbankId: 1, created: "2026-09-06 23:59:59.999999" });
  seedChange({ id: 3, foodbankId: 3, created: "2026-09-05 19:28:08.853000" });
  seedChange({ id: 4, foodbankId: 4, created: "2026-09-08 09:00:00.000000", published: 0 });
  seedChange({ id: 5, foodbankId: 4, created: "2026-09-08 08:00:00.000000", text: "Unknown" });
  seedChange({ id: 6, foodbankId: 4, created: "2026-09-08 07:00:00.000000", text: "Facebook" });
  seedChange({ id: 7, foodbankId: 4, created: "2026-09-08 06:00:00.000000", text: "Nothing" });
  seedChange({ id: 8, foodbankId: null, created: "2026-09-08 05:00:00.000000" });
  seedChange({ id: 9, foodbankId: 999, created: "2026-09-08 04:00:00.000000" });

  seedHit(3, "2026-09-08", 100);
  seedHit(3, "2026-09-07", 50);
  seedHit(1, "2026-09-01", 120);
  seedHit(4, "2026-09-08", 10);
  seedHit(4, "2026-09-09", 999);
  seedHit(2, "2026-08-31", 999);

  seedArticle({ id: 1, foodbankId: 1, publishedDate: "2026-09-06", title: "FOODBANK APPEALS FOR uht MILK.", url: "https://news.invalid/one?utm_source=tw" });
  seedArticle({ id: 2, foodbankId: 2, publishedDate: "2026-09-04", title: "volunteers needed", url: "https://news.invalid/two" });
  seedArticle({ id: 3, foodbankId: 3, publishedDate: "2026-09-08", title: "not featured", url: "https://news.invalid/three", featured: 0 });

  seedStats(2854, 4110, 1234567, 89000);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(schemaFor("foodbank", "foodbankchange", "foodbankchange_full", "foodbankhit", "foodbankarticle", "site_stats"));
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
// Reading the rendered page. Each panel is a <ul> with a stable class, and
// every row in it is one <a>, so the assertions below can talk in hrefs and
// names rather than in HTML.
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

const panel = (body: string, cls: string) => anchors(ul(body, cls));

// public/frags/news.njk emits, per article, a favicon <img>, the outbound
// link, and a second link back to the food bank followed by the date.
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

// The five <p> values under <div class="columns stats">. The fifth is the
// client-filled "last updated" fragment, which has no text of its own.
function statValues(body: string): string[] {
  const start = body.indexOf('<div class="columns stats">');
  const block = body.slice(start, body.indexOf("</div>\n\n</div>", start));
  return [...block.matchAll(/<p[^>]*>([^<]*)<\/p>/g)].map((m) => (m[1] as string).trim());
}

describe("publicIndex -- GET /", () => {
  // The response envelope. The Cache-Control value is the whole reason
  // middleware/pageCacheControl.ts has a HOME rule: Django's index() carried
  // @cache_page(SECONDS_IN_HOUR) and the "recently updated"/"most viewed"
  // panels are why an hour rather than a day. cache-tag fb-all is what
  // queues/cachePurge.ts purges when any food bank changes -- without it this
  // page keeps showing a food bank's old name for an hour after a rename.
  it("serves cacheable HTML tagged for the whole-estate purge", async () => {
    const res = await get("/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=3600");
    expect(res.headers.get("Cache-Tag")).toBe("fb-all");
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // THE FOUR CONSTANTS, WHICH ARE OTHERWISE INVISIBLE. RECENTLY_UPDATED_LIMIT,
  // MOST_VIEWED_LIMIT, ARTICLES_LIMIT and MOST_VIEWED_DAYS never appear in the
  // SQL text and never show on a page whose fixture is smaller than the limit,
  // so they are asserted on the bindings that actually reached the engine.
  //
  // ONE SESSION FOR ALL FOUR. lib/session.ts opens a single
  // withSession("first-unconstrained") per request precisely so the four
  // parallel reads see one consistent snapshot of a replicated database; a
  // handler that opened one per query would still render, and would still pass
  // every other test in this file.
  it("reads the four panels from one D1 session, with the limits and the seven-day window the constants declare", async () => {
    await get("/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => p.params)).toEqual([[8], ["2026-09-01", "2026-09-08", 8], [5], []]);
    expect(prepared.map((p) => p.sql)).toEqual([
      "SELECT foodbank_name FROM foodbankchange_full WHERE published = 1 AND change_text NOT IN ('Unknown', 'Facebook', 'Nothing') AND foodbank_name IS NOT NULL ORDER BY created DESC LIMIT ?",
      "SELECT f.name, f.slug FROM (SELECT foodbank_id, SUM(hits) AS total_hits FROM foodbankhit WHERE day >= ? AND day <= ? GROUP BY foodbank_id ORDER BY total_hits DESC LIMIT ?) t JOIN foodbank f ON f.id = t.foodbank_id ORDER BY t.total_hits DESC",
      "SELECT a.id, a.foodbank_id, f.name AS foodbank_name, f.slug AS foodbank_slug, a.published_date, a.title, a.url, a.featured FROM foodbankarticle a JOIN foodbank f ON f.id = a.foodbank_id WHERE a.featured = 1 ORDER BY a.published_date DESC LIMIT ?",
      "SELECT foodbanks, donationpoints, items, meals, computed_at FROM site_stats WHERE id = 1",
    ]);
  });

  // The window is date arithmetic (setUTCDate(x - 7)), not string arithmetic,
  // and the difference only shows at a month boundary -- across the end of
  // February in a leap year, most of all. A handler that sliced the ISO string
  // and subtracted 7 from the day field produces "2026-03--4" here and matches
  // no row at all, which on a live homepage is an empty "most viewed" panel
  // and nothing else.
  it("walks the seven-day window back across a month boundary", async () => {
    vi.setSystemTime(new Date("2024-03-02T00:05:00.000Z"));

    await get("/");

    expect(prepared[1]?.params).toEqual(["2024-02-24", "2024-03-02", 8]);
  });
});

describe("publicIndex -- the recently updated panel", () => {
  // Order and content in one assertion. Django's index() takes the eight most
  // recent FoodbankChange rows by -created; `created` here is TEXT, so this is
  // also the test that says the fixture's Django-format timestamps sort the
  // way the site needs them to.
  it("lists changed food banks newest first", async () => {
    expect(panel(await getBody("/"), "recently-updated").map((a) => a.text)).toEqual([
      "St. Mary&#39;s Foodbank &amp; Pantry",
      "Salisbury Foodbank",
      "Bath Foodbank",
    ]);
  });

  // THE FOUR EXCLUSIONS, each seeded newer than every eligible row, so any one
  // of them failing puts "Truro Foodbank" at the TOP of the panel:
  //   published = 0                 -- an unpublished change is a draft, and
  //                                    showing it publishes a food bank's need
  //                                    list before anyone has approved it
  //   change_text 'Unknown'/'Facebook'/'Nothing' -- sentinels, not needs (the
  //                                    column comment in 0001_core.sql calls
  //                                    them contract)
  //   foodbank_id NULL / dangling   -- foodbankchange_full LEFT JOINs, so both
  //                                    arrive with a NULL foodbank_name
  //
  // That last one is not cosmetic: the handler feeds foodbank_name straight to
  // slugify(), which does value.toLowerCase(), so a NULL name throws and the
  // WHOLE HOMEPAGE 500s. Verified by deleting "AND foodbank_name IS NOT NULL"
  // from getRecentlyUpdated in a scratch copy of the repo -- GET / came back
  // 500, not a page with one blank row in it.
  it("shows neither unpublished changes, sentinel change_texts, nor changes whose food bank has gone", async () => {
    const rows = panel(await getBody("/"), "recently-updated");

    expect(rows.map((a) => a.text)).toEqual(["St. Mary&#39;s Foodbank &amp; Pantry", "Salisbury Foodbank", "Bath Foodbank"]);
  });

  // THE LIMIT. Nine eligible changes, eight slots: the oldest falls off.
  it("stops at eight, dropping the oldest", async () => {
    for (let i = 0; i < 6; i += 1) {
      seedFoodbank(20 + i, `extra-${i}`, `Extra ${i} Foodbank`);
      seedChange({ id: 20 + i, foodbankId: 20 + i, created: `2026-09-0${i + 1} 01:00:00.000000` });
    }

    const rows = panel(await getBody("/"), "recently-updated");

    expect(rows).toHaveLength(8);
    // 2026-09-01 01:00 is the oldest of the nine.
    expect(rows.map((a) => a.text)).not.toContain("Extra 0 Foodbank");
    expect(rows.map((a) => a.text)).toContain("Extra 1 Foodbank");
  });

  // NO DEDUPLICATION, deliberately. givefood's country() view over-fetches 50
  // rows and dedupes by name in Python; index() does not, so a food bank that
  // was updated three times this morning occupies three of the eight slots.
  // packages/db/src/homepage.test.ts pins the same thing at the query level;
  // this is the visible half. A "tidy" that adds DISTINCT or GROUP BY changes
  // what the homepage shows.
  it("repeats a food bank that changed more than once", async () => {
    seedChange({ id: 30, foodbankId: 1, created: "2026-09-07 09:00:00.000000" });
    seedChange({ id: 31, foodbankId: 1, created: "2026-09-07 08:30:00.000000" });

    expect(panel(await getBody("/"), "recently-updated").map((a) => a.text)).toEqual([
      "Salisbury Foodbank",
      "Salisbury Foodbank",
      "St. Mary&#39;s Foodbank &amp; Pantry",
      "Salisbury Foodbank",
      "Bath Foodbank",
    ]);
  });

  // THE LINKING RULE, AND IT IS NOT THE OBVIOUS ONE. Django's template calls
  // FoodbankChange.foodbank_name_slug() -- slugify() of the denormalised name
  // -- and the query is .only('foodbank_name') with no join to reach the real
  // slug. This port reproduces that: food bank id 2 is stored with slug
  // "vineyard" and the panel still links /needs/at/st-mary-s-foodbank-pantry/.
  // Joining to foodbank.slug here would be an improvement and a divergence.
  it("links by slugify(name), never by the food bank's real slug", async () => {
    const rows = panel(await getBody("/"), "recently-updated");

    expect(rows.map((a) => a.href)).toEqual(["/needs/at/st-mary-s-foodbank-pantry/", "/needs/at/salisbury-foodbank/", "/needs/at/bath-foodbank/"]);
    // "vineyard" is the real slug of the food bank at the top of the panel,
    // and it is the one URL this panel must never emit.
    expect(rows.map((a) => a.href)).not.toContain("/needs/at/vineyard/");
  });

  // SUSPECT, PINNED AS-IS. @givefood/models' slugify() replaces every run of
  // non-[a-z0-9] with a hyphen, where Django's django.utils.text.slugify()
  // first DELETES apostrophes, full stops and ampersands and only then
  // hyphenates whitespace -- and transliterates accented letters rather than
  // dropping them. Run on this machine against the reference checkout
  // (Django 5.2.6):
  //     "St. Mary's Foodbank & Pantry" -> 'st-marys-foodbank-pantry'
  //     'Ynys Môn Foodbank'            -> 'ynys-mon-foodbank'
  // This port yields "st-mary-s-foodbank-pantry" and "ynys-m-n-foodbank", so
  // for any food bank whose name carries punctuation or an accent the homepage
  // link does not match the real slug and 404s. models/index.ts documents the
  // simplification (PLAN.md R7) as acceptable "to reconstruct a URL fragment";
  // this test records what it actually costs on the highest-traffic page.
  // Asserting Django's answer instead would leave the suite red and fix
  // nothing.
  it("hyphenates punctuation and accents where Django would have deleted or transliterated them (suspect, pinned)", async () => {
    seedFoodbank(40, "ynys-mon", "Ynys Môn Foodbank");
    seedChange({ id: 40, foodbankId: 40, created: "2026-09-07 23:00:00.000000" });

    const hrefs = panel(await getBody("/"), "recently-updated").map((a) => a.href);

    expect(hrefs[0]).toBe("/needs/at/ynys-m-n-foodbank/");
    expect(hrefs).toContain("/needs/at/st-mary-s-foodbank-pantry/");
  });

  // `created` is TEXT compared lexicographically, and 'T' (0x54) sorts after
  // ' ' (0x20). A row written by anything that stamps toISOString() therefore
  // sorts ABOVE every Django-format row of the same date regardless of the
  // time in it -- 10:00Z here beats 08:00 on the same day. Not a defect in
  // this handler, which only asks for ORDER BY created DESC; pinned because
  // the homepage is where such a row would first be seen, and "the newest
  // change is not at the top" is otherwise a very confusing bug report.
  it("orders by the raw text of `created`, so an ISO-8601 timestamp outranks a same-day Django one", async () => {
    seedChange({ id: 50, foodbankId: 4, created: "2026-09-07T10:00:00.000Z" });

    expect(panel(await getBody("/"), "recently-updated")[0]?.text).toBe("Truro Foodbank");
  });
});

describe("publicIndex -- the most viewed panel", () => {
  // Ranking, summing and BOTH window edges in one assertion:
  //   bath 150 (100 today + 50 yesterday) > salisbury 120 (exactly seven days
  //   back, the inclusive edge) > truro 10 (whose 999 hits TOMORROW must not
  //   count, or it would rank first), and vineyard's 999 hits eight days back
  //   are outside the window entirely.
  it("ranks by hits summed over the trailing seven days, inclusive of the seventh and exclusive of the future", async () => {
    const rows = panel(await getBody("/"), "most-viewed");

    expect(rows.map((a) => a.text)).toEqual(["Bath Foodbank", "Salisbury Foodbank", "Truro Foodbank"]);
    expect(rows.map((a) => a.text)).not.toContain("St. Mary&#39;s Foodbank &amp; Pantry");
  });

  // The other half of the linking rule tested above: this panel DOES join to
  // foodbank, so it links the real slug. Food bank id 2 is absent from the
  // panel in the base fixture (its hits are outside the window), so it gets a
  // hit inside it here -- the point being "vineyard", not "st-mary-s-...".
  it("links the real foodbank.slug, not a slugify of the name", async () => {
    seedHit(2, "2026-09-08", 5);

    expect(panel(await getBody("/"), "most-viewed").at(-1)).toEqual({ href: "/needs/at/vineyard/", text: "St. Mary&#39;s Foodbank &amp; Pantry" });
  });

  // ISSUE #43's DOCUMENTED CAVEAT, at the page level. getMostViewed ranks and
  // LIMITs the hit rows first and joins `foodbank` afterwards, to avoid ~6,000
  // rows_read per render; the price is that a hit row whose food bank no longer
  // exists still consumes one of the eight slots and then vanishes at the join.
  //
  // Eight real food banks with hits plus one orphan ranked top: the subquery
  // returns eight groups, the join drops the orphan, and the panel shows SEVEN
  // -- the food bank with the fewest hits having been pushed out by a food bank
  // that does not exist. Pinned rather than fixed: do NOT move the join back
  // inside the subquery, which is the 6,000 rows packages/db/src/homepage.ts
  // explains at length.
  it("lets an orphaned hit row consume a slot, so the panel comes up short", async () => {
    for (let i = 0; i < 5; i += 1) {
      seedFoodbank(60 + i, `viewed-${i}`, `Viewed ${i} Foodbank`);
      seedHit(60 + i, "2026-09-08", 200 + i);
    }
    seedHit(999, "2026-09-08", 10_000);

    const rows = panel(await getBody("/"), "most-viewed");

    expect(rows.map((a) => a.text)).toEqual([
      "Viewed 4 Foodbank",
      "Viewed 3 Foodbank",
      "Viewed 2 Foodbank",
      "Viewed 1 Foodbank",
      "Viewed 0 Foodbank",
      "Bath Foodbank",
      "Salisbury Foodbank",
    ]);
    // Truro's 10 hits would have been eighth had the orphan not taken a slot.
    expect(rows.map((a) => a.text)).not.toContain("Truro Foodbank");
  });

  it("stops at eight, dropping the least viewed", async () => {
    for (let i = 0; i < 6; i += 1) {
      seedFoodbank(60 + i, `viewed-${i}`, `Viewed ${i} Foodbank`);
      seedHit(60 + i, "2026-09-08", 200 + i);
    }

    const rows = panel(await getBody("/"), "most-viewed");

    expect(rows).toHaveLength(8);
    // Truro's 10 hits are the smallest of the nine totals.
    expect(rows.map((a) => a.text)).not.toContain("Truro Foodbank");
    expect(rows.map((a) => a.text)).toContain("Viewed 0 Foodbank");
  });
});

describe("publicIndex -- the news panel", () => {
  // Every field mapArticleRow() produces, on one row:
  //   favicon      wfbn-generic:foodbank_favicon, from the JOINED slug
  //   href         urlWithRefFoodbank() -- appends ref=givefood.org.uk and,
  //                unlike the donation-point variant, KEEPS utm_ params
  //   title        titleCapitalised(): capwords, then the acronym table
  //                (UHT is in it), then the trailing full stop stripped
  //   date         |date("j M"), the template's own format
  it("renders each featured article with its ref-tagged url, capitalised title and food bank favicon", async () => {
    expect(newsItems(await getBody("/"))[0]).toEqual({
      favicon: "/needs/at/salisbury-foodbank/favicon.png",
      href: "https://news.invalid/one?utm_source=tw&amp;ref=givefood.org.uk",
      title: "Foodbank Appeals For UHT Milk",
      foodbankHref: "/needs/at/salisbury-foodbank/",
      foodbank: "Salisbury Foodbank",
      date: "6 Sep",
    });
  });

  // featured = 1 only, newest first. The non-featured row is dated two days
  // AFTER both featured ones, so losing the filter puts it first rather than
  // last -- givefood's /news/ page is the one that lists everything
  // (getRecentArticles), and the homepage showing 17,000 articles' worth of
  // ordering instead of 168 is not visibly different until you know the data.
  it("shows only featured articles, newest first", async () => {
    expect(newsItems(await getBody("/")).map((a) => a.title)).toEqual(["Foodbank Appeals For UHT Milk", "Volunteers Needed"]);
  });

  it("stops at five", async () => {
    for (let i = 0; i < 4; i += 1) {
      seedArticle({ id: 70 + i, foodbankId: 1, publishedDate: `2026-09-0${i + 1}`, title: `Story ${i}`, url: `https://news.invalid/x${i}` });
    }

    const titles = newsItems(await getBody("/")).map((a) => a.title);

    expect(titles).toHaveLength(5);
    // 2026-09-01 is the oldest of the six.
    expect(titles).not.toContain("Story 0");
    expect(titles).toContain("Story 3");
  });
});

describe("publicIndex -- statistics, logos and the map", () => {
  // get_site_stats() is a single precomputed row (0003_homepage_data.sql), and
  // the template's |intcomma is Django's humanize filter. The four numbers are
  // the only place on the site these figures appear.
  it("prints the four site statistics with thousands separators", async () => {
    expect(statValues(await getBody("/"))).toEqual(["2,854", "4,110", "1,234,567", "89,000", ""]);
  });

  // SUSPECT, PINNED AS-IS. getSiteStats() returns null when site_stats is
  // empty -- a table that is ETL-loaded by tools/pg-to-d1/extract_core.py, so
  // "empty" is reachable after a failed or partial extract, not just in a test.
  // The handler passes that null straight to the template, Nunjucks resolves
  // `stats.foodbanks` to undefined, and intcomma() does String(undefined): the
  // live homepage then reads "undefined" under all four headings, with a 200
  // and a warm cache for the next hour. Django rendered "" here, because a
  // missing template variable is string_if_invalid ('') and intcomma('') is ''.
  it("prints the literal string \"undefined\" for every statistic when site_stats is empty (suspect, pinned)", async () => {
    db.prepare("DELETE FROM site_stats").run();

    expect(statValues(await getBody("/"))).toEqual(["undefined", "undefined", "undefined", "undefined", ""]);
  });

  // The LOGOS list, verbatim from givefood/views.py:82-160 -- twelve
  // partners, in this order, each with the file EXTENSION it actually has in
  // static/img/hplogos/. The two PNGs among ten SVGs are the reason the
  // extension is data rather than a hardcoded ".svg": get one wrong and the
  // image silently fails to load for every visitor.
  it("renders all twelve partner logos in order, with the right file extension for each", async () => {
    const body = await getBody("/");
    const logos = [...body.matchAll(/<img src="\/static\/img\/hplogos\/([^"]+)" class="[^"]*" alt="([^"]*)"/g)].map((m) => [m[1], m[2]]);

    expect(logos).toEqual([
      ["nhs.svg", "NHS"],
      ["bbc.svg", "BBC"],
      ["scottishgov.svg", "Scottish Government Riaghaltas na h-Alba"],
      ["cdrc.png", "Consumer Data Research Centre"],
      ["reach.svg", "Reach plc"],
      ["ageuk.svg", "Age UK"],
      ["channel4.svg", "Channel 4"],
      ["welshgov.svg", "Welsh Government"],
      ["fcdo.svg", "Foreign, Commonwealth &amp; Development Office"],
      ["mars.svg", "Mars"],
      ["ca.svg", "Citizens Advice"],
      ["nctj.png", "National Council for the Training of Journalists"],
    ]);
    expect(body).toContain('<a href="https://www.gov.uk/government/organisations/foreign-commonwealth-development-office">');
  });

  // map_config is JSON.stringify'd in the handler and dropped into a <script>
  // by includes/mapconfig.njk, so the exact string is what the map JS parses.
  // location_marker false and zoom 5 centred on 55.4/-4 is the whole-UK view;
  // Django built the same dict in index().
  it("hands the map the whole-UK view and the geojson url for the current language", async () => {
    expect(await getBody("/")).toContain(
      'window.gfMapConfig = {"geojson":"/needs/geo.json","lat":55.4,"lng":-4,"zoom":5,"location_marker":false};',
    );
  });

  // ENABLE_WRITE is a hardcoded constant in givefood/const/general.py, not an
  // env flag, so the "Write to your MP" entry is always present. The template
  // gates on it; if the handler stopped passing it the link would vanish with
  // no other symptom.
  it("offers the Write to your MP link", async () => {
    expect(await getBody("/")).toContain('<li><a href="/write/">Write to your MP</a></li>');
  });

  // `address` is passed as the empty string, unconditionally. Django's index()
  // takes no input at all -- the search box posts to wfbn:index, which is a
  // different view -- so a handler that "helpfully" echoed ?address= here would
  // both diverge and make the page per-visitor while pageCacheControl is still
  // stamping it public for an hour.
  it("leaves the address box empty even when the url carries an address", async () => {
    const body = await getBody("/?address=Sheffield&lat_lng=51,-1");

    expect(body).toContain('<input id="address_field" type="text" name="address" class="input" placeholder="e.g. EX4 6PX or Sheffield" value="" required>');
    expect(body).not.toContain("Sheffield&");
  });

  // elapsedMs() reports WHOLE milliseconds, deliberately unlike Django's
  // three decimal places: on Workers performance.now() is coarsened, so the
  // fraction was always ".000" -- decoration that reads like precision. A
  // revert to toFixed(3) would show up here as "Took 0.000ms".
  it("stamps the debug comment with a whole-millisecond render time", async () => {
    const took = /⏱️ Took (\S+)/.exec(await getBody("/"))?.[1];

    expect(took).toMatch(/^\d+ms$/);
  });
});

describe("publicIndex -- languages", () => {
  // The handler reads c.get("lang") and passes it to render(), so the page
  // comes back in Welsh; it also passes c.get("pathAfterPrefix"), which is
  // what makes the language switcher offer "/" rather than "/cy/" for English.
  // Both are easy to drop and neither changes the status code.
  it("renders the Welsh homepage, with prefixed links and the Welsh geojson", async () => {
    const body = await getBody("/cy/");

    expect(body).toContain('<html lang="cy" dir="ltr"');
    expect(body).toContain("<h2>Diweddarwyd yn ddiweddar</h2>");
    expect(body).toContain("<h2>Edrychwyd arno fwyaf yr wythnos hon</h2>");
    expect(body).toContain('window.gfMapConfig = {"geojson":"/cy/needs/geo.json","lat":55.4,"lng":-4,"zoom":5,"location_marker":false};');
    expect(body).toContain('<link rel="canonical" href="https://www.givefood.org.uk/cy/">');
    expect(panel(body, "recently-updated")[1]?.href).toBe("/cy/needs/at/salisbury-foodbank/");
  });

  // pageTranslatable: true. It gates BOTH the four hreflang alternates in
  // page.njk and the whole language switcher in includes/langswitcher.njk, so
  // passing false (or forgetting it) silently delists three languages from
  // search engines while the page still looks perfect.
  it("advertises all four language variants of itself", async () => {
    const body = await getBody("/cy/");

    for (const [code, url] of [
      ["en", "/"],
      ["cy", "/cy/"],
      ["ga", "/ga/"],
      ["gd", "/gd/"],
    ]) {
      expect(body).toContain(`<link rel="alternate" hreflang="${code}" href="${ORIGIN}${url}">`);
    }
    expect(body).toContain('<div class="langswitcher is-pulled is-pulled-right">');
  });

  // The favicon URL is gfwfbn's `wfbn-generic` namespace, registered OUTSIDE
  // i18n_patterns in givefood/urls.py, so it never takes a language prefix
  // even on a Welsh page -- while the food bank link right beside it does.
  // The two urls sit in the same <li> of the same template, which is exactly
  // where an over-eager "prefix everything" change would go unnoticed.
  it("keeps the article favicon unprefixed on a prefixed page", async () => {
    const item = newsItems(await getBody("/cy/"))[0];

    expect(item?.favicon).toBe("/needs/at/salisbury-foodbank/favicon.png");
    expect(item?.foodbankHref).toBe("/cy/needs/at/salisbury-foodbank/");
  });

  it("serves the Irish and Scottish Gaelic homepages too", async () => {
    expect((await get("/ga/")).status).toBe(200);
    expect((await get("/gd/")).status).toBe(200);
  });

  // "en" is never a URL prefix (prefix_default_language=False in Django, and
  // resolveLanguage's PREFIXES set excludes it here), so /en/ is not a second
  // spelling of the homepage -- it is a 404, as it is in production.
  it("does not answer at /en/", async () => {
    expect((await get("/en/")).status).toBe(404);
  });
});

describe("publicIndex -- what it does not do", () => {
  // GET only, matching Django's index(). Worth asserting rather than assuming:
  // the route is registered with app.get, and a stray app.all here would hand a
  // POST to a handler that renders a cacheable page.
  it("does not answer a POST", async () => {
    expect((await get("/", { method: "POST" })).status).toBe(404);
  });

  // An empty database must still render -- a fresh D1, or an extract that has
  // not run yet. The three panels come up empty and nothing throws.
  it("renders with every panel empty when the database has no rows", async () => {
    for (const table of ["foodbankchange", "foodbankhit", "foodbankarticle", "foodbank"]) db.prepare(`DELETE FROM ${table}`).run();

    const body = await getBody("/");

    expect(panel(body, "recently-updated")).toEqual([]);
    expect(panel(body, "most-viewed")).toEqual([]);
    expect(newsItems(body)).toEqual([]);
    expect(statValues(body)).toEqual(["2,854", "4,110", "1,234,567", "89,000", ""]);
  });

  // A D1 outage must produce the 500 page, NOT a homepage with four empty
  // panels -- and above all must not be cached: pageCacheControl only stamps
  // 200s, so the s-maxage=3600 above cannot attach itself to this. An hour of
  // edge-cached emptiness on the site's front door is the failure this guards.
  it("500s, uncached, when the database is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...env(), DB: { withSession: () => { throw new Error("D1_ERROR: network"); } } } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`${ORIGIN}/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain('<ul class="recently-updated">');
  });
});
