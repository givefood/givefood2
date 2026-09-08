import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import type { AppEnv } from "../types";

// routes/apiDocs.ts -- the three HTML pages of the API: gfapi1's deprecated
// notice (GET /api/1/), and gfapi2's index (GET /api/2/, GET /api/) and docs
// (GET /api/2/docs/, GET /api/docs/). Ported from gfapi2/views.py's `index`
// and `docs`, and from givefood/views.py:608-613's `api` (which gfapi1/urls.py
// line 7 mounts at the gfapi1 root -- it is NOT reachable at /api/, despite
// the name; see the Cache-Control test below, where that matters).
//
// WHY THIS FILE EXISTS. Two of these three pages are static, which makes them
// look like nothing can go wrong on them. What can go wrong is the part that
// is not static:
//
//   * api2Docs' `eg_needs` is a LIVE query, and the only visible product of it
//     is the contents of one <select> a reader picks a sample need id out of.
//     Every plausible break there is silent: drop `published = 1` and the page
//     offers unpublished needs (an admin-only draft, published to the docs);
//     drop toDashedUuid and every option is a dashless id that
//     /api/2/need/<id>/ still accepts but which no Django response ever
//     printed; lose the ORDER BY and the "5 most recent" are five arbitrary
//     ones. All of them render a perfectly well-formed page with a 200.
//   * the four static lists ARE the page's documented contract -- they are
//     what a reader copies into their own client. gfapi2/views.py:33-60 is
//     the source of truth for three of them, and eg_parl_cons is a DELIBERATE
//     divergence (Django's `order_by("?")[:5]`, a random scan of ~650 rows,
//     replaced by five fixed names) that a future reader must be able to tell
//     apart from an accident.
//   * the two "static" pages have exactly one interesting property -- they do
//     NOT read the database -- and nothing about a page that renders correctly
//     would reveal a query creeping onto it.
//
// So the assertions here are the OPTION LISTS and the QUERIES, not the status
// code. Rows that must be excluded (unpublished needs, and published ones
// past the fifth) are seeded deliberately: a handler with no filter at all
// passes every test whose fixture only contains rows that should appear.
//
// REAL EVERYTHING -- the real app from ../index (so the real router, the real
// middleware chain, the real trailing-slash and dual-mount registrations), the
// real Nunjucks render(), and real SQLite seeded from the real migrations via
// schemaFor(). Same harness as routes/public/md.test.ts and
// routes/api2/foodbanks.test.ts. Nothing is mocked; there is nothing here that
// leaves the machine.
//
// MUTATION-TESTED (TESTING.md's convention) in a copy of the whole tree in a
// scratchpad outside the repo -- never by editing a file in src/ and putting it
// back. Twenty mutants, every one of them failed this file. Widened past
// apiDocs.ts itself, because a careless edit to any of these reaches these
// three pages just as surely as one to the handler: packages/db's needs.ts and
// uuid.ts, middleware/serverTiming.ts, cacheTag.ts and pageCacheControl.ts,
// index.ts's route table, and the two templates (re-running the precompile
// step, without which a .njk edit is inert and the "mutant" proves nothing --
// the first attempt at the GeoJSON one survived for exactly that reason).
// The kills worth naming, because each is a test's reason to exist: the limit
// raised from 5 to 100; toDashedUuid dropped, and separately its group
// boundaries shifted; `published = 1` dropped from the query; ORDER BY
// reversed; either doc page rendered through the other's template; the example
// food banks reordered; a search example's `type` changed; a constituency
// dropped from the fixed five; YAML dropped from api_formats; has_geojson
// dropped from all four call sites; the Dumps table restored to the landing
// page; either of the two /api/ aliases unregistered; canonical hardcoded
// instead of read from the request; the docs page added to cacheTag's
// aggregate purge set; "api" dropped from pageCacheControl's weekly list;
// render_time_ms dropped from the context, and separately given back its
// three always-zero decimals; and -- the one this file most wants to catch --
// the needs query wrapped in `.catch(() => [])`, which turns a D1 outage into
// a 200 that reads as "nothing is published".

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// Records the SQL prepared AND the values bound to it. The bind list is not
// decoration: `LIMIT ?` is the whole of "the five most recent", and a handler
// that asked for 100 and rendered five (or asked for five and rendered them in
// the wrong order) is indistinguishable from a correct one by body alone once
// the fixture is small.
function d1Session(db: DatabaseSync, prepared: string[], bound: Bindable[][]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => {
      bound.push(next as Bindable[]);
      return statement(sql, next as Bindable[]);
    },
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      prepared.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// getPublishedNeeds reads the VIEW, not the table -- and the view LEFT JOINs
// `foodbank`, so a fixture without that table comes up fine and then fails at
// SELECT time with "no such table". schemaFor() takes all three from the real
// migrations rather than hand-written DDL, which is the whole reason it exists
// (github #51: eight suites broke at once on a hand-built fixture that lacked
// a view a shared query had started reading).
const SCHEMA = schemaFor("foodbank", "foodbankchange", "foodbankchange_full");

let db: DatabaseSync;
let prepared: string[];
let bound: Bindable[][];

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared, bound) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// need_id is stored as 32 DASHLESS hex characters (PLAN.md §4.4) and re-emitted
// dashed. Real width matters: toDashedUuid slices at fixed offsets, so a
// 31-character fixture id would still render "a uuid" and prove nothing about
// the real one. The row number leads, so a failure names the row, and the
// dashless string is never a substring of its own dashed rendering -- which is
// what lets the "the dashless form appears nowhere" assertion mean something.
const needId = (n: number): string => `${String(n).padStart(2, "0")}dead4beefcafe`.padEnd(32, "f");
const dashed = (n: number): string => {
  const s = needId(n);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};

// `created` is TEXT in Django's `str(datetime)` shape -- "2026-09-05
// 19:28:08.853000" -- because SQLite compares TEXT lexicographically and
// everything that writes this column goes through @givefood/models' pyDatetime
// (see its header: a toISOString() value sorts ABOVE every same-day Django one,
// because 'T' > ' '). ORDER BY created DESC is only "most recent first" as long
// as the fixture uses the format production uses, so it does.
function seedNeed(id: number, published: 0 | 1, created: string): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, input_method, created, modified)
     VALUES (?, ?, NULL, 'Beans, Pasta, Tea', ?, 'user', ?, ?)`,
  ).run(id, needId(id), published, created, created);
}

// Ids ASCEND while `created` DESCENDS, so rowid order and the ordering the
// handler asks for are two different sequences: a dropped ORDER BY returns
// 1,2,3,4,5 and the assertions below expect 9,8,7,6,5. Row 10 is the NEWEST
// need in the table and is unpublished -- so a dropped `published = 1` shows
// up as an extra option at the TOP of the list, where it is impossible to miss,
// rather than as a silently reordered tail. Rows 1-4 are published and older
// than the fifth, and exist only to prove LIMIT 5 is doing something.
function seedNeeds(): void {
  seedNeed(10, 0, "2026-09-05 23:00:00.000000"); // newest of all, UNPUBLISHED
  seedNeed(9, 1, "2026-09-05 22:00:00.000000");
  seedNeed(8, 1, "2026-09-05 21:00:00.000000");
  seedNeed(7, 1, "2026-09-05 20:00:00.000000");
  seedNeed(6, 1, "2026-09-05 19:00:00.000000");
  seedNeed(5, 1, "2026-09-05 18:00:00.000000");
  seedNeed(4, 0, "2026-09-05 17:00:00.000000"); // UNPUBLISHED, mid-range
  seedNeed(3, 1, "2026-09-05 16:00:00.000000");
  seedNeed(2, 1, "2026-09-05 15:00:00.000000");
  seedNeed(1, 1, "2026-09-05 14:00:00.000000");
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepared = [];
  bound = [];
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// The <option> list of one named <select>, as "value|label" strings. Asserting
// the parsed pairs rather than a slab of markup keeps the claim on the DATA --
// which is what the handler supplies and what a reader copies out of the page
// -- while still pinning the order and the exact strings.
function options(html: string, selectAttr: string): string[] {
  const select = new RegExp(`<select[^>]*${selectAttr}[^>]*>([\\s\\S]*?)</select>`).exec(html);
  if (!select) throw new Error(`no <select> matching ${selectAttr} in the rendered page`);
  return [...select[1]!.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => `${m[1]}|${m[2]}`);
}

// ---------------------------------------------------------------------------
// api1Index -- GET /api/1/
// ---------------------------------------------------------------------------

describe("api1Index -- GET /api/1/", () => {
  // The page's whole job is to say "deprecated, use v2" and to stay out of
  // the index. Both are single lines in api1.njk that nothing else asserts.
  it("renders the deprecation notice and keeps the page out of search results", async () => {
    const res = await get("/api/1/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Give Food API</title>");
    expect(html).toContain(
      "This API has been deprecated. It'll continue to work, but it's recommended that you <a href=\"/api/\">use the v2 instead</a>.",
    );
    // givefood/views.py's `api` renders public/api.html, which carries this
    // meta -- the deprecated API's docs must not compete with /api/2/docs/
    // in search. It is one line, and losing it is invisible on the page.
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  // "static doc page, no DB reads" is apiDocs.ts's own claim about this
  // handler, and it is the only property of it that can regress without
  // showing. A `getPublishedNeeds`-shaped addition here would cost a D1 round
  // trip on a page that has nothing to show for it.
  it("issues no database query at all", async () => {
    await get("/api/1/");

    expect(prepared).toEqual([]);
  });

  // buildPageContext({ path: c.req.path }) -- canonical is the request's own
  // path, matching context_processors.py:19 (SITE_DOMAIN + translate_url(path)).
  it("declares itself canonical at its own URL", async () => {
    expect(await body("/api/1/")).toContain(`<link rel="canonical" href="${ORIGIN}/api/1/">`);
  });

  // PINNED, AND SUSPECT. Django decorates this view @cache_page(SECONDS_IN_WEEK)
  // (givefood/views.py:608, mounted at the gfapi1 root by gfapi1/urls.py:7), and
  // PLAN.md §7.7.1's own TTL table says WEEK for "api/1/ docs". What ships is a
  // day, because middleware/pageCacheControl.ts's WEEKLY_PAGES rule matches the
  // exact path "/api/" (plus its locale-prefixed forms) and nothing under it --
  // and "/api/" is a DIFFERENT page, gfapi2's index, whose TTL in both Django
  // and the same PLAN.md table is a day. The two are effectively swapped; see
  // api2Index's own Cache-Control test for the other half. Asserting the wish
  // would leave the suite permanently red and tell nobody; this asserts what
  // ships, and the divergence is reported instead.
  it("is cached for a day, not the week Django's @cache_page gave it", async () => {
    expect((await get("/api/1/")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });
});

// ---------------------------------------------------------------------------
// api2Index -- GET /api/2/ and its /api/ alias
// ---------------------------------------------------------------------------

describe("api2Index -- GET /api/2/", () => {
  it("renders the API landing page with its links to the docs and to v1", async () => {
    const res = await get("/api/2/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    // Trailing space inside the block tag, verbatim from the template and
    // from Django's own index.html before it.
    expect(html).toContain("<title>Give Food API </title>");
    // url('api2:docs') and the hardcoded /api/1/ link. The first is a reverse
    // through @givefood/urls; if that table moved, this button would point at
    // a 404 while the page still rendered.
    expect(html).toContain('<a href="/api/2/docs/" class="button is-light is-info">View documentation</a>');
    expect(html).toContain('<li><a href="/api/1/">Old API</a></li>');
  });

  // WP 5.6 / PLAN.md §8.8, maintainer decision 2026-09-02: gfdumps' daily
  // CSV/JSON/XML exports were dropped ENTIRELY rather than ported, so the
  // "Dumps" table Django's index.html rendered from `Dump.objects...` has no
  // data behind it here. A well-meaning restoration of the markup would render
  // an empty table on the live API landing page and advertise downloads that
  // 404 (/dumps is mounted as `gone()` in index.ts). Case-insensitive, because
  // the failure is the word appearing at all.
  it("does not mention dumps -- the table was dropped, not emptied", async () => {
    expect(await body("/api/2/")).not.toMatch(/dump/i);
  });

  it("issues no database query at all", async () => {
    await get("/api/2/");

    expect(prepared).toEqual([]);
  });

  // givefood/urls.py:94 and :96 include the SAME gfapi2 urlconf twice, so
  // index and docs are both live at the bare /api/ prefix in production, not
  // only the versioned one. index.ts:252 registers that alias explicitly
  // because a sub-app's own "/" route does not match a mount prefix WITH a
  // trailing slash in Hono -- the quirk index.ts records as having left these
  // two pages falling through to the catch-all until the line was added.
  it("is served identically at the bare /api/ alias, each canonical to itself", async () => {
    const versioned = await body("/api/2/");
    const alias = await body("/api/");

    expect(alias).toContain('<a href="/api/2/docs/" class="button is-light is-info">View documentation</a>');
    expect(versioned).toContain(`<link rel="canonical" href="${ORIGIN}/api/2/">`);
    // Django built canonical_path from request.path too (context_processors.py:17-19),
    // so the alias advertising ITSELF as canonical -- rather than pointing at
    // /api/2/ -- is ported behaviour, not an oversight of this port.
    expect(alias).toContain(`<link rel="canonical" href="${ORIGIN}/api/">`);
  });

  // PINNED, AND SUSPECT -- the other half of api1Index's Cache-Control note.
  // The same page, reached by its two mounts, is given two different shared
  // TTLs: /api/2/ gets Django's day (gfapi2/views.py:19's
  // @cache_page(SECONDS_IN_DAY), and PLAN.md §7.7.1's "api/2/ index" row),
  // while /api/ matches pageCacheControl's WEEKLY_PAGES rule and gets a week.
  // A change to this page stays stale seven times longer on one of its two
  // URLs than the other, and neither carries a Cache-Tag to purge.
  it("gets a day at /api/2/ but a week at /api/, for the same rendered page", async () => {
    expect((await get("/api/2/")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect((await get("/api/")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
  });
});

// ---------------------------------------------------------------------------
// api2Docs -- GET /api/2/docs/ and its /api/docs/ alias
// ---------------------------------------------------------------------------

describe("api2Docs -- GET /api/2/docs/", () => {
  beforeEach(seedNeeds);

  // THE ONE LIVE VALUE ON THE PAGE. Five options, newest first, dashed, with
  // the unpublished newest row (id 10) absent and the published tail (ids 1-3)
  // cut off by the LIMIT. Every one of those three rules is a separate way to
  // be wrong that still renders a 200.
  it("offers the five most recent PUBLISHED needs, newest first, as dashed uuids", async () => {
    const html = await body("/api/2/docs/");

    expect(options(html, 'id="id_argument"')).toEqual([
      `${dashed(9)}|${dashed(9)}`,
      `${dashed(8)}|${dashed(8)}`,
      `${dashed(7)}|${dashed(7)}`,
      `${dashed(6)}|${dashed(6)}`,
      `${dashed(5)}|${dashed(5)}`,
    ]);
  });

  // Named separately from the ordering test so a failure says WHICH rule broke.
  // An unpublished need is a draft an admin has not approved: putting one in
  // the public docs publishes it, and /api/2/need/<id>/ would then serve it to
  // anyone who selected it.
  it("never offers an unpublished need, not even the newest row in the table", async () => {
    const html = await body("/api/2/docs/");

    expect(html).not.toContain(dashed(10));
    expect(html).not.toContain(needId(10));
    expect(html).not.toContain(dashed(4));
  });

  // toDashedUuid, pinned at the page. Django's JSON encoder printed a UUID
  // field as its dashed str() form and gfapi1/2 re-emit need ids that way, so
  // a docs page offering the dashless storage form would be offering a value
  // no Django response ever produced -- and the option is meant to be copied.
  it("renders the dashed form and never the 32-char dashless one it stores", async () => {
    const html = await body("/api/2/docs/");

    expect(html).toContain(dashed(9));
    expect(html).not.toContain(needId(9));
  });

  // ONE query, and the one packages/db/src/needs.ts:37-43 actually publishes.
  // The limit is bound, not interpolated, and it is 5 -- gfapi2/views.py:52's
  // `[:5]`. A handler that fetched 100 and sliced in JS would render the same
  // five options while pulling 20x the rows off D1 for a doc page.
  it("reads the needs with exactly one bounded query, limited to five", async () => {
    await get("/api/2/docs/");

    expect(prepared).toEqual(["SELECT * FROM foodbankchange_full WHERE published = 1 ORDER BY created DESC LIMIT ?"]);
    expect(bound).toEqual([[5]]);
  });

  // The empty case is not hypothetical: it is what a fresh environment and any
  // database-restore window look like. The page must still render -- the other
  // eight methods documented on it have nothing to do with needs.
  it("renders with an empty need list rather than failing when nothing is published", async () => {
    db.prepare("DELETE FROM foodbankchange").run();

    const res = await get("/api/2/docs/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(options(html, 'id="id_argument"')).toEqual([]);
    // The rest of the page is untouched -- this is the assertion that says the
    // empty case degrades one <select>, not the document.
    expect(options(html, 'id="foodbank_argument"')).toHaveLength(4);
  });

  // gfapi2/views.py:36-39, verbatim. These four names are what a reader clicks
  // to try /api/2/foodbank/<slug>/, so the SLUGIFIED value is the load-bearing
  // half: "Black Country" must become "black-country" (the |slugify filter,
  // Django's own, applied in the template rather than in the view).
  it("offers the four documented example food banks, slugified for the URL", async () => {
    expect(options(await body("/api/2/docs/"), 'id="foodbank_argument"')).toEqual([
      "sid-valley|Sid Valley",
      "kingsbridge|Kingsbridge",
      "meon-valley|Meon Valley",
      "black-country|Black Country",
    ]);
  });

  // gfapi2/views.py:42-50, verbatim -- including "TR13 9JSE", which is not a
  // valid postcode (Helston is TR13 9JS) and is a typo in the Python source.
  // Pinned deliberately: this is a port, and "fixing" a sample value in the
  // docs is a change to published API documentation, not a typo repair.
  // The two `lat_lng` entries are the reason `type` exists -- they build a
  // different query parameter from the five addresses.
  it("offers the seven documented example searches, typo and all, with the right query parameter", async () => {
    expect(options(await body("/api/2/docs/"), 'name="search"')).toEqual([
      "?address=12 Millbank, Westminster, London SW1P 4QE|12 Millbank, Westminster, London SW1P 4QE",
      "?address=Mount Pleasant Rd, Porthleven, Helston TR13 9JSE|Mount Pleasant Rd, Porthleven, Helston TR13 9JSE",
      "?address=Gartocharn, Scotland|Gartocharn, Scotland",
      "?address=Bexhill-on-Sea|Bexhill-on-Sea",
      "?address=ZE2 9AU|ZE2 9AU",
      "?lat_lng=51.178889,-1.826111|51.178889,-1.826111",
      "?lat_lng=52.090833,0.131944|52.090833,0.131944",
    ]);
  });

  // THE DELIBERATE DIVERGENCE. gfapi2/views.py:57 was
  // `ParliamentaryConstituency.objects.all().order_by("?")[:5]` -- a random
  // full scan of ~650 rows on every cache miss, for five sample names.
  // apiDocs.ts replaces it with a fixed list and says so; PLAN.md §7.6 asks
  // for exactly that flag rather than a silent change. This test is what stops
  // someone "restoring parity" by reintroducing the random scan without
  // noticing it was a decision -- and it also pins that these five stay
  // constituencies that really exist, since each name is slugified straight
  // into a live /api/2/constituency/<slug>/ URL.
  it("offers five fixed constituencies rather than Django's random five of 650", async () => {
    expect(options(await body("/api/2/docs/"), 'id="constituency_argument"')).toEqual([
      "broadland-and-fakenham|Broadland and Fakenham",
      "great-yarmouth|Great Yarmouth",
      "north-norfolk|North Norfolk",
      "mid-norfolk|Mid Norfolk",
      "south-west-norfolk|South West Norfolk",
    ]);
  });

  // api_formats is one list, ["JSON","XML","YAML"], rendered through
  // api2/_macros.njk's api_formats() macro at nine call sites -- four of which
  // pass has_geojson=true. In Django those four were
  // `{% include ... with hasgeojson=True %}`; Nunjucks has no `with` on
  // include, so the port turned the partial into a macro with an explicit
  // parameter. The count is the assertion: pass `true` at a tenth site and the
  // docs offer GeoJSON for an endpoint that has no such format, and pass it at
  // three and a real format disappears from the docs for one endpoint. Nothing
  // about either failure is visible in a rendered page you are not diffing.
  it("documents JSON/XML/YAML at all nine methods and GeoJSON at exactly four", async () => {
    const html = await body("/api/2/docs/");

    expect(options(html, 'class="control api_format"')).toEqual(["json|JSON", "xml|XML", "yaml|YAML", "geojson|GeoJSON"]);
    expect(html.match(/<select class="control api_format" name="api_format">/g)).toHaveLength(9);
    expect(html.match(/<option value="geojson">GeoJSON<\/option>/g)).toHaveLength(4);
  });

  // The /api/ alias again (index.ts:253), this time on the page that queries.
  // Worth its own test because the alias is a SECOND registration of the same
  // handler: a change that touched only the /api/2/ line would leave the two
  // URLs serving different content, with nothing to say which was the real one.
  it("is served identically at /api/docs/, with its own canonical", async () => {
    const alias = await body("/api/docs/");

    expect(options(alias, 'id="id_argument"')[0]).toBe(`${dashed(9)}|${dashed(9)}`);
    expect(alias).toContain(`<link rel="canonical" href="${ORIGIN}/api/docs/">`);
  });

  // PINNED, WITH A CONSEQUENCE WORTH KNOWING. The page embeds live data and is
  // handed a day of shared cache, but middleware/cacheTag.ts assigns it no
  // Cache-Tag (its AGGREGATE_PATHS rule covers /api/[123]/needs, not the docs
  // page), so publishing a need cannot purge it -- the sample ids go stale for
  // up to a day. That matches Django, which cached the same page for a day
  // with no invalidation at all (@cache_page(SECONDS_IN_DAY), gfapi2/views.py:30),
  // so it is ported behaviour rather than a regression; it is pinned here so
  // that a future purge-list change has something to fail against.
  it("is cached for a day and carries no cache tag, so a new need cannot purge it", async () => {
    const res = await get("/api/2/docs/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  // These three pages sit OUTSIDE Django's i18n_patterns (givefood/urls.py:91,
  // "Untranslated apps"), and apiDocs.ts calls buildPageContext with no locale
  // -- which context.ts documents as producing plain English and no alternates.
  // The visible half of that is the absence of hreflang links; the routing half
  // is that no /cy/ form of the URL exists at all.
  it("is English-only: no hreflang alternates, and no language-prefixed URL", async () => {
    const html = await body("/api/2/docs/");

    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).not.toContain("hreflang");
    expect((await get("/cy/api/2/docs/")).status).toBe(404);
  });

  // A DIVERGENCE, PINNED. context_processors.py:46-48 appended QUERY_STRING to
  // flag_path, so Django's "Something wrong in this page?" link carried the
  // query the reader was actually looking at. apiDocs.ts's pageContext() passes
  // only `path` to buildPageContext, so the query is dropped here. Harmless on
  // this page (nothing on it reads a query parameter), and pinned so it is a
  // recorded difference rather than a surprise if these handlers ever grow one.
  it("drops the query string from the flag link, unlike Django", async () => {
    expect(await body("/api/2/docs/?format=json")).toContain(`href="/flag/#${ORIGIN}/api/2/docs/"`);
  });

  // The debug comment's "Took Nms" is elapsedMs(c), read off the timestamp
  // middleware/serverTiming.ts stored -- whole milliseconds, deliberately not
  // Django's three decimals, because performance.now() only advances at I/O
  // boundaries on Workers and the fraction was always exactly ".000".
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body("/api/2/docs/")).toMatch(/⏱️ Took \d+ms\n/);
  });

  // A DOWNSTREAM FAILURE. getPublishedNeeds is the only thing on this path that
  // can throw, and it throws for the ordinary reasons D1 does (a replica behind,
  // a query timeout). index.ts's app.onError catches it into the real 500 page;
  // what must NOT happen is a half-rendered docs page or a 200 with an empty
  // <select>, either of which would look like "no needs published" to a reader.
  it("serves the real 500 page when the needs query fails, not a partial page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      DB: {
        withSession: () => ({
          prepare: () => ({
            bind: () => ({
              all: async () => {
                throw new Error("D1_ERROR: network connection lost");
              },
            }),
          }),
        }),
      },
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`${ORIGIN}/api/2/docs/`), broken, execCtx);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("<h1>500 - Internal Server Error</h1>");
    expect(html).not.toContain("api_method_argument");
  });

  // THE TRAILING SLASH COSTS A FULL RENDER AND A D1 READ. lib/appendSlash.ts
  // answers Django's APPEND_SLASH by re-entering the app with a HEAD request
  // for the slashed URL and redirecting if it does not 404 -- so /api/2/docs
  // runs api2Docs in full, queries D1, renders the whole document and throws
  // the body away, all to produce a 301 with no content. Pinned rather than
  // fixed: it is how the probe is documented to work, and it is the kind of
  // cost that is invisible in every metric except D1 reads.
  it("301s a missing trailing slash, having really executed the handler to find out", async () => {
    const res = await get("/api/2/docs");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/api/2/docs/`);
    expect(prepared).toEqual(["SELECT * FROM foodbankchange_full WHERE published = 1 ORDER BY created DESC LIMIT ?"]);
  });
});
