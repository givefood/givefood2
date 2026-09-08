import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/itemCategories.ts -- GET /dashboard/item-categories/, the
// public "Requested items by category" pie chart. Ported from
// gfdash/views.py:199-206 (`@cache_page(SECONDS_IN_DAY) def item_categories`),
// registered at gfdash/urls.py:13 as `path("item-categories/", ...)`.
//
// WHY THIS FILE EXISTS, given packages/db/src/dashboards.test.ts already runs
// getNeedItemCategoryCounts' SQL through a real engine three ways. The handler
// is five lines with no branches, so nothing in it can throw -- and that is
// exactly the problem. This is a PUBLIC page whose whole content is a pie
// chart and the table under it, and every way it can be wrong still renders a
// perfectly plausible chart with a 200:
//
//   * the rows not reaching the template, or reaching it under a name the
//     template does not read. dash/item_categories.njk:39 loops `categories`
//     and reads `.category`/`.count` off each row; rename any of the three and
//     nunjucks prints an empty table in silence, because
//     packages/templates/src/env.ts sets throwOnUndefined: false on purpose.
//   * the TWO HALVES OF THE PAGE DISAGREEING. Unlike its sibling dashboards
//     the table and the chart here are built from DIFFERENT things -- the
//     table from `categories` in the template, the chart from
//     `chart_data_json`, a string the HANDLER builds with JSON.stringify. They
//     can each be right while the other is empty or stale, so both are
//     asserted, separately.
//   * the chart_data_json escaping. The handler's own comment (lines 14-19)
//     is a claim about injection, and this file is where that claim is
//     checked rather than believed. It holds for `"`. It does NOT hold for
//     `</script>` -- see the "category names the allowlist would never
//     produce" block, and suspectedBugs.
//   * a second query, or a write, creeping onto a page that is meant to be one
//     read. gfdash is entirely uncached in this port beyond the Cache-Control
//     header pageCacheControl.ts fills in, so every edge miss costs whatever
//     this handler does -- and this handler's statement is a full scan.
//   * the reachability of the URL itself. This is one `app.get` line
//     (index.ts:550), and dash/index.njk:34, page.njk's footer and
//     routes/public/textFiles.ts:95 (llms.txt) all link into it.
//
// So the assertions below are on RENDERED VALUES -- the table cells and the
// exact JSON the chart is built from -- and on the statement log, never on the
// status code alone.
//
// REAL EVERYTHING. The real app from ../../index (so the real router, the real
// middleware chain, the real trailing-slash probe and the real 500 page), the
// real Nunjucks render() through the real templates, the real
// getNeedItemCategoryCounts, and real SQLite seeded from the real migrations
// via schemaFor(). Nothing is mocked; nothing on this path leaves the machine.
// Same harness as its sibling routes/dashboards/beanPastaIndex.test.ts, which
// this file is modelled on.
//
// MUTATION-TESTED (TESTING.md's convention) in a copy of the whole tree in the
// scratchpad OUTSIDE the repo, never by editing a file in src/ and putting it
// back. 29 mutants applied and re-run; 28 died, and the one survivor is a
// deliberate equivalence control (see the note at the foot of this file).
// Widened past itemCategories.ts itself, because a careless edit to any of
// these reaches this page just as surely as one to the handler:
//
//   index.ts -- the registration deleted; the path retyped with an
//     underscore; registered as .all so a POST is answered; pointed at
//     gfdashItemGroups, the sibling handler one line below it.
//   the handler -- `categories` renamed; the rows discarded and
//     `categories: []` passed; `chart_data_json` renamed; the chart array
//     emptied; the chart rows reversed relative to the table; value and name
//     swapped; the count stringified; the template swapped for
//     dash/item_groups.njk; the page context no longer spread in;
//     render_time_ms dropped; canonical built from c.req.url instead of
//     c.req.path; getNeedItemCategoryCounts called twice; the call wrapped in
//     `.catch(() => [])`; c.text() instead of c.html(); and an UPDATE bolted
//     on alongside the read (this repo's own scar -- a GET route left able to
//     run one, with its "does not answer GET at all" test passing throughout).
//   packages/db -- `type = 'need'` dropped; the same predicate loosened to
//     `type != 'excess'`; ORDER BY deleted; ORDER BY reversed to ASC;
//     COUNT(*) swapped for COUNT(DISTINCT need_id); the GROUP BY moved to
//     group_name (which is what this page's sibling dashboard does).
//   lib/session.ts -- the mode changed to "first-primary".
//   middleware -- elapsedMs given back Django's three decimals;
//     pageCacheControl's fall-through TTL raised to a week.

const ORIGIN = "https://www.givefood.org.uk";
// Hardcoded rather than imported from @givefood/urls, so the string here and
// the string in ROUTES/index.ts are two independent copies -- a rename that
// updated only one of them is precisely what this guards. gfdash/urls.py
// spells the path with a hyphen; Django's reverse name (which the breadcrumb
// below goes through) has the underscore.
const PATH = "/dashboard/item-categories/";

type Bindable = null | number | bigint | string | Uint8Array;

// Records the SQL prepared. This page's whole cost argument is "one statement,
// no parameters, once per view", and the log is the only place that claim is
// observable -- a rendered pie looks identical whether it took one query or
// four.
function d1Session(db: DatabaseSync, prepared: string[], bound: Bindable[][]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => {
      bound.push(next as Bindable[]);
      return statement(sql, next as Bindable[]);
    },
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    // Present, not omitted: a test that proves this GET writes nothing must
    // not be leaning on writes being impossible in the fixture. This repo's
    // own scar is a GET route left able to run an UPDATE with a test named
    // "does not answer GET at all" passing throughout.
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

// Only the one table the statement names. Taken from the real migrations via
// schemaFor() rather than hand-written DDL: `group_name` is a RENAME of
// Postgres's `group` (0003_homepage_data.sql:32) and the partial index
// fcl_cat_need_idx that serves this very query is `WHERE type = 'need'`, so a
// fixture typed out by hand tests the author's memory rather than the shipped
// schema (github #51 -- eight suites broke at once on hand-built fixtures).
const SCHEMA = schemaFor("foodbankchangeline");

let db: DatabaseSync;
let prepared: string[];
let bound: Bindable[][];
let sessionModes: string[];
let nextId: number;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      // Recorded rather than ignored: lib/session.ts asks for
      // "first-unconstrained", which is what makes this read eligible for a
      // D1 read replica. One entry per request is also how the tests below
      // know the handler opened exactly one session.
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session(db, prepared, bound);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// A NO-OP THAT EARNS ITS KEEP, borrowed from packages/db/src/dashboards.test.ts.
// Every timestamp here is in DJANGO'S shape -- "YYYY-MM-DD HH:MM:SS.ffffff",
// what str(datetime) produces and what migration 0022 normalised the database
// to. This page never reads `created` (the query groups on category alone), so
// the wrapper is documentation rather than a constraint -- but a timestamp
// literal in the port's toISOString() shape sitting unremarked in a fixture is
// how the lexical-ordering defects in this repo started.
const PY = (value: string) => value;

// `category` and `group_name` below are drawn from packages/db/src/needLines.ts's
// ITEM_CATEGORY_GROUPS, the 50-key allowlist upsertNeedLine() validates against
// (it throws on an unknown category), so these fixtures are rows the live
// writer could actually produce. That matters for the escaping block at the
// bottom, whose rows deliberately are NOT.
function seedLine(row: Record<string, Bindable> = {}): void {
  const n = (nextId += 1);
  const full: Record<string, Bindable> = {
    id: n,
    need_id: 1,
    foodbank_id: 1,
    item: `Item ${n}`,
    type: "need",
    category: "Soup",
    group_name: "Meal Food",
    created: PY("2024-01-01 12:00:00.000000"),
    ...row,
  };
  const columns = Object.keys(full);
  db.prepare(`INSERT INTO foodbankchangeline (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((c) => full[c] as Bindable),
  );
}

// THE FIXTURE MOST OF THIS FILE READS, and a third of it is rows that must NOT
// appear. Without those, every assertion here passes against a handler that
// ignored the `type = 'need'` filter entirely -- the "a filter that does
// nothing passes every test that only seeds matching rows" trap.
//
// THE COUNTS ARE 3/2/1, ALL DISTINCT, ON PURPOSE. SQLite answers a GROUP BY
// through a temp b-tree keyed on the grouping column, so with tied counts the
// rows come back in CATEGORY order whether or not the query asks for one --
// a fixture with ties would pass with `ORDER BY count DESC` deleted. It would
// also pass with it reversed, if the tie order happened to agree. Distinct
// counts make both mutants fail.
//
// THE THREE "Tinned Tomatoes" LINES SPAN TWO DIFFERENT need_ids, because the
// query is COUNT(*) of LINES, not of needs -- Django's
// `.values("category").annotate(count=Count("category"))` counts rows too. A
// COUNT(DISTINCT need_id) mutant would give 2 here and read as an entirely
// plausible chart.
function seedTheCategories(): void {
  seedLine({ category: "Tinned Tomatoes", group_name: "Meal Food", need_id: 1 });
  seedLine({ category: "Tinned Tomatoes", group_name: "Meal Food", need_id: 1 });
  seedLine({ category: "Tinned Tomatoes", group_name: "Meal Food", need_id: 2 });
  seedLine({ category: "Toiletries", group_name: "Toiletries", need_id: 1 });
  seedLine({ category: "Toiletries", group_name: "Toiletries", need_id: 3 });
  seedLine({ category: "Nappies", group_name: "Baby Supplies", need_id: 2 });
  // THE EXCLUSIONS, and they are a category that appears NOWHERE else -- so a
  // dropped `type = 'need'` shows up as an EXTRA SLICE rather than as one
  // count being two too high, which is far harder to miss. Their count (2)
  // would also land them in the middle of the ordering, so the leak reorders
  // the chart as well as adding to it.
  //
  // Excess lines are not rare: routes/admin/needs.ts writes one per item of
  // every "excess" list a food bank publishes, through the same
  // foodbankchangeline table. On the live database they are a large minority
  // of the rows, and this dashboard is one of only two readers of the partial
  // index (fcl_cat_need_idx) that exists to skip them.
  seedLine({ category: "Cereal", group_name: "Meal Food", type: "excess" });
  seedLine({ category: "Cereal", group_name: "Meal Food", type: "excess" });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepared = [];
  bound = [];
  sessionModes = [];
  nextId = 0;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// The <table> under the chart, as "category|count" pairs. Parsed rather than
// matched as a slab of markup so the claim stays on the DATA, while still
// pinning the order and the exact rendered strings (including the intcomma
// separator and the HTML escaping).
function tableRows(html: string): string[] {
  const table = /<table[\s\S]*?<\/table>/.exec(html);
  if (!table) throw new Error("no <table> in the rendered page");
  return [...table[0].matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/g)].map((m) => `${m[1]}|${m[2]}`);
}

// The pie series' data array, AS THE RAW SOURCE TEXT the browser parses --
// deliberately not JSON.parse'd. This page's one interesting escaping question
// is what characters survive into the document, and parsing the array back
// would normalise away exactly the thing being asked about. It also catches a
// count arriving as a quoted string ('3' rather than 3), which echarts would
// still plot but which is a different thing in the source.
function chartDataSource(html: string): string {
  const block = /type: 'pie',\s*radius: '70%',\s*data: (.*)\n/.exec(html);
  if (!block) throw new Error("no pie series data in the rendered chart");
  return block[1]!;
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

describe("the route", () => {
  // gfdash/urls.py:13's path, reached through the REAL router. A test that
  // mounted its own ad-hoc Hono route would pass with index.ts:550 deleted,
  // which is the failure a sibling suite records as having actually shipped.
  //
  // The 600px chart height is not decoration: every one of the twenty gfdash
  // handlers is this same five-line shape, and dash/bean_pasta_index.njk's
  // chart div is 500px. Asserting the height alongside the title is what
  // separates "rendered the categories template" from "rendered A dashboard".
  // Killed the mutant that swapped the template name for "dash/item_groups.njk".
  it("answers GET /dashboard/item-categories/ with the Requested items by category page", async () => {
    seedTheCategories();

    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Requested items by category - Give Food</title>");
    expect(html).toContain("<h1>Requested items by category</h1>");
    expect(html).toContain('<div id="chart" style="height:600px"></div>');
    expect(html).toContain("<th>Number of items</th>");
  });

  // GET ONLY. index.ts:550 registers `app.get(...)` and nothing else, so Hono
  // answers a POST with a 404.
  //
  // A DIVERGENCE FROM DJANGO, and a harmless one: Django's view is a plain
  // function with no method guard, so a POST there rendered the same page with
  // a 200. Neither writes anything; what is asserted is that the port's
  // refusal is reached WITHOUT running the query, so a POST flood cannot buy
  // repeated full scans of foodbankchangeline.
  it("refuses a POST, and runs no query on the way to refusing it", async () => {
    seedTheCategories();

    const res = await get(PATH, { method: "POST" });

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block, entirely
  // outside i18n_patterns -- index.ts:542-544 says so, and registers the
  // dashboards with no locale loop. The visible half is the absence of
  // hreflang alternates (buildPageContext is called with no `locale`, so
  // `languages` is empty and page.njk emits nothing); the routing half is that
  // no /cy/ form of this URL exists at all.
  it("is English-only: no hreflang alternates, and no language-prefixed URL", async () => {
    seedTheCategories();

    const res = await get(PATH);
    const html = await res.text();

    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).not.toContain("hreflang");
    expect(res.headers.get("Content-Language")).toBe("en");
    expect((await get("/cy/dashboard/item-categories/")).status).toBe(404);
  });

  // THE TRAILING SLASH COSTS A FULL RENDER AND A D1 READ. lib/appendSlash.ts
  // answers Django's APPEND_SLASH by re-entering the app with a HEAD request
  // for the slashed URL and redirecting if it does not 404 -- so
  // /dashboard/item-categories runs this handler in full, scans
  // foodbankchangeline, renders the whole document and throws the body away,
  // all to produce a 301 with no content. Pinned rather than treated as a bug:
  // it is how the probe is documented to work, and it is the kind of cost that
  // is invisible in every metric except D1 rows read.
  it("301s a missing trailing slash, having really executed the handler to find out", async () => {
    seedTheCategories();

    const res = await get("/dashboard/item-categories");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
    expect(prepared).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// what the page shows
// ---------------------------------------------------------------------------

describe("what the page shows", () => {
  beforeEach(seedTheCategories);

  // THE TABLE, which is the half a reader can copy numbers out of. One row per
  // category, most-requested first, and no "Cereal" row -- Cereal exists only
  // as excess lines. Killed the mutants that renamed the handler's `categories`
  // key, that passed `categories: []`, and that dropped `type = 'need'` from
  // the query (which adds a "Cereal|2" row in second place).
  it("prints one table row per category, most requested first", async () => {
    expect(tableRows(await body(PATH))).toEqual(["Tinned Tomatoes|3", "Toiletries|2", "Nappies|1"]);
  });

  // THE CHART, which is the artifact -- the table under it is the footnote.
  // Asserted as the EXACT source text, because this array is not built by the
  // template from `categories` the way every sibling dashboard's is: the
  // handler builds it with JSON.stringify and the template drops it in through
  // `|safe`. So the table being right is NO evidence the chart is, and vice
  // versa; they are two independent renderings of the same rows and each has
  // its own way of going wrong.
  //
  // Note the key ORDER inside each object -- {value, name}, matching the
  // handler's object literal and Django's own hand-built
  // `{value: ..., name: "..."}`. echarts does not care, and asserting it
  // anyway is what makes this a test of the exact string rather than of a
  // shape.
  it("feeds echarts the same rows in the same order, as JSON built by the handler", async () => {
    expect(chartDataSource(await body(PATH))).toBe(
      '[{"value":3,"name":"Tinned Tomatoes"},{"value":2,"name":"Toiletries"},{"value":1,"name":"Nappies"}],',
    );
  });

  // Named separately from the two tests above so a failure says WHICH rule
  // broke rather than just "the page is wrong". "Cereal" is the excess-only
  // category; its absence from BOTH halves of the page is the whole assertion.
  it("never shows a category that exists only on excess lines", async () => {
    const html = await body(PATH);

    expect(html).not.toContain("Cereal");
    expect(chartDataSource(html)).not.toContain("Cereal");
  });

  // COUNT(*) OF LINES, NOT OF NEEDS. Two of the three Tinned Tomatoes lines
  // share need_id 1 (see seedTheCategories' comment): a COUNT(DISTINCT
  // need_id) would report 2 and reorder nothing, which is the shape of wrong
  // that no reader could ever detect from the page.
  it("counts every line, including two lines of the same category on one need", async () => {
    const rows = tableRows(await body(PATH));

    expect(rows[0]).toBe("Tinned Tomatoes|3");
  });

  // An empty database is a 200 with an empty table and an empty array, not a
  // 404 and not a broken script. This is what a fresh environment and any
  // database-restore window look like, and echarts renders an empty pie quite
  // happily -- what it must not get is `data: ,` or `data: undefined`, which
  // is what a dropped chart_data_json key produces (throwOnUndefined is off).
  // Killed the mutant that renamed chart_data_json to chartDataJson.
  it("renders an empty chart rather than 404ing when nothing matches", async () => {
    db.prepare("DELETE FROM foodbankchangeline").run();

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(tableRows(html)).toEqual([]);
    expect(chartDataSource(html)).toBe("[],");
    // The rest of the page is untouched -- the empty case degrades the chart,
    // not the document.
    expect(html).toContain("<h1>Requested items by category</h1>");
  });

  // THE TABLE AND THE CHART FORMAT THE SAME NUMBER DIFFERENTLY, and they must.
  // The template runs `{{ category.count|intcomma }}`, matching Django's
  // `{% load humanize %}` cell; the handler's JSON.stringify does not, and must
  // not -- `{"value":"1,234"}` is a STRING to echarts, which plots it as NaN
  // and renders a pie with one invisible slice and a 200.
  //
  // 1,234 lines rather than a token 1,000, so a thousands separator inserted
  // in the wrong place (Django's intcomma is a repeated regex substitution,
  // ported verbatim in packages/templates/src/filters.ts) is visible.
  it("comma-groups the table's count but not the chart's, which must stay a number", async () => {
    db.prepare("DELETE FROM foodbankchangeline").run();
    db.prepare(
      "INSERT INTO foodbankchangeline (need_id, foodbank_id, item, type, category, group_name, created) " +
        "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1234) " +
        "SELECT 1, 1, 'Soup ' || n, 'need', 'Soup', 'Meal Food', '2024-01-01 12:00:00.000000' FROM seq",
    ).run();

    const html = await body(PATH);

    expect(tableRows(html)).toEqual(["Soup|1,234"]);
    expect(chartDataSource(html)).toBe('[{"value":1234,"name":"Soup"}],');
  });

  // A SINGLE CATEGORY, because JSON.stringify of a one-element array is the
  // case where the comma separator never appears -- the equivalent of the
  // `{% if not forloop.last %},{% endif %}` that Django's template used and
  // that this port deliberately does not (see itemCategories.ts:14-19). Cheap,
  // and it is the shape a brand new deployment's first day has.
  it("emits a one-element chart array without a stray separator", async () => {
    db.prepare("DELETE FROM foodbankchangeline").run();
    seedLine({ category: "Pasta", group_name: "Meal Food" });

    const html = await body(PATH);

    expect(chartDataSource(html)).toBe('[{"value":1,"name":"Pasta"}],');
    expect(tableRows(html)).toEqual(["Pasta|1"]);
  });
});

// ---------------------------------------------------------------------------
// category names the allowlist would never produce
// ---------------------------------------------------------------------------
//
// THE HANDLER'S HEADER COMMENT IS A SECURITY CLAIM, and this block is where it
// is checked rather than believed. itemCategories.ts:14-19 says the Django
// template's `name: "{{ x|safe }}"` "would break or inject into the page" for a
// category containing a `"` or `</script>`, and that "JSON.stringify escapes
// correctly for both".
//
// Half of that is true. The rows below are not rows the live writer can
// produce today -- packages/db/src/needLines.ts's upsertNeedLine() looks the
// category up in ITEM_CATEGORY_GROUPS and throws on a miss, so the column's 50
// possible values are all plain ASCII words -- which is why these are pinned
// as CURRENT BEHAVIOUR and reported, not fixed. They are worth pinning anyway,
// because the allowlist is app-level and not a DB constraint (§4.5), the
// comment claiming the escaping is safe is right here in the file, and a
// future import or backfill that writes the column directly would land on
// exactly this.

describe("category names the allowlist would never produce", () => {
  // A DOUBLE QUOTE, which is the half of the comment's claim that HOLDS.
  // Django's template emitted `name: "Tinned "Goods""` -- a syntax error that
  // takes the whole inline script with it, and with it the chart on every
  // dashboard page sharing the pattern. JSON.stringify emits `\"`, which is
  // correct inside the JS string literal. The table cell is a separate
  // mechanism entirely: nunjucks autoescaping turns it into `&quot;`.
  it("escapes a double quote for the chart, and HTML-escapes it for the table", async () => {
    seedLine({ category: 'Tinned "Goods"' });

    const html = await body(PATH);

    expect(chartDataSource(html)).toBe('[{"value":1,"name":"Tinned \\"Goods\\""}],');
    expect(tableRows(html)).toEqual(["Tinned &quot;Goods&quot;|1"]);
  });

  // AND THE HALF THAT DOES NOT. SUSPECT -- reported in suspectedBugs, pinned
  // rather than fixed, because these tests record what the code does.
  //
  // JSON.stringify does not escape `/`, so a category containing the literal
  // text `</script>` reaches the document unchanged INSIDE the inline
  // `<script>` element. An HTML parser ends the script at that sequence
  // regardless of the JavaScript around it -- so the chart breaks and the rest
  // of the category name is parsed as MARKUP, which is the injection the
  // comment says JSON.stringify prevents. The conventional fix is to escape
  // the `<` (JSON.stringify(...).replace(/</g, "\\u003c")), which stays valid
  // JSON and cannot close the element.
  //
  // Not reachable from the live writer today (see this block's header), so
  // this is a documentation-versus-behaviour defect rather than a live XSS --
  // but the comment is what the next person will trust.
  //
  // The table half is fine: nunjucks escapes the whole thing to entities.
  it("does NOT escape a closing script tag, contradicting the handler's own comment", async () => {
    seedLine({ category: "Beans</script><img src=x>" });

    const html = await body(PATH);

    // The literal sequence, unescaped, in the source the browser parses.
    expect(chartDataSource(html)).toBe('[{"value":1,"name":"Beans</script><img src=x>"}],');
    expect(html).toContain('data: [{"value":1,"name":"Beans</script>');
    // And the table, by contrast, is safe -- which is what makes the chart's
    // behaviour easy to miss on a visual inspection of the page.
    expect(tableRows(html)).toEqual(["Beans&lt;/script&gt;&lt;img src=x&gt;|1"]);
  });

  // AN EMPTY CATEGORY. The column is NOT NULL, so a NULL is impossible, but ''
  // is not -- and it produces a nameless pie slice with a real count under it,
  // plus an empty first table cell. Pinned because it is the page's one silent
  // corruption mode that a reader would read straight past, and because the
  // handler does no filtering of any kind (no `if (!row.category) continue`)
  // and neither did Django.
  it("renders an empty category as a nameless slice rather than dropping it", async () => {
    // Two Pasta lines against one empty-named line, rather than one each: with
    // a tie SQLite's group-by order would decide the sequence and '' sorts
    // before 'Pasta', so the assertion would be about the engine's tie-break
    // rather than about the empty name surviving the round trip, which is what
    // this test is for.
    seedLine({ category: "Pasta", group_name: "Meal Food" });
    seedLine({ category: "Pasta", group_name: "Meal Food" });
    seedLine({ category: "" });

    const html = await body(PATH);

    expect(chartDataSource(html)).toBe('[{"value":2,"name":"Pasta"},{"value":1,"name":""}],');
    expect(tableRows(html)).toEqual(["Pasta|2", "|1"]);
    // The empty cell as it actually reaches the document -- an unlabelled row
    // under a labelled one, which reads as a rendering glitch rather than as
    // data and is exactly why it is worth having pinned.
    expect(html).toContain("<td></td>");
  });
});

// ---------------------------------------------------------------------------
// what the request costs
// ---------------------------------------------------------------------------

describe("what the request costs", () => {
  beforeEach(seedTheCategories);

  // ONE statement, a READ, over ONE session, with NO bound parameters.
  //
  // The exact SQL is asserted because it is the contract between this page and
  // the partial index built for it: fcl_cat_need_idx is
  // `(category, need_id) WHERE type = 'need'` (0003_homepage_data.sql:38), and
  // it can only serve a query whose WHERE clause is literally `type = 'need'`.
  // Rewrite the predicate as a bound parameter, or as `type != 'excess'`, and
  // the page still renders identically while D1 reads every row in
  // foodbankchangeline -- the single largest table in this schema, and D1
  // meters rows read.
  it("issues exactly one statement, a read, over exactly one D1 session", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM foodbankchangeline").get() as { n: number }).n;

    await get(PATH);

    expect(prepared).toEqual(["SELECT category, COUNT(*) AS count FROM foodbankchangeline WHERE type = 'need' GROUP BY category ORDER BY count DESC"]);
    expect(prepared[0]!).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
    // No bound parameters at all: the whole statement is a fixed string, so
    // there is nothing on this page a query string could reach.
    expect(bound).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM foodbankchangeline").get() as { n: number }).n).toBe(before);
    // lib/session.ts's mode. "first-primary" would work and would silently
    // give up read-replica eligibility on a page with no consistency
    // requirement whatsoever. Killed the mutant that changed it.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // Two views in a row must be identical and must still be one statement each.
  // This is the assertion a "let me memoise the answer in a module-level
  // variable" change trips over -- which on Workers would pin one isolate's
  // chart until it was evicted, and is a real temptation on a page whose one
  // query is a full scan.
  it("is idempotent across repeated views", async () => {
    const first = await body(PATH);
    prepared = [];
    const second = await body(PATH);

    expect(tableRows(second)).toEqual(tableRows(first));
    expect(chartDataSource(second)).toBe(chartDataSource(first));
    expect(prepared).toHaveLength(1);
  });

  // NOTHING IN THE URL REACHES THE QUERY. The handler takes no parameters at
  // all, so a query string is inert -- asserted because "let me make this page
  // filterable" is the obliging edit that would put user input into a
  // statement this module builds as a bare string.
  it("ignores a query string entirely", async () => {
    const html = await body(`${PATH}?type=excess&category=Cereal&limit=100000`);

    expect(tableRows(html)).toEqual(["Tinned Tomatoes|3", "Toiletries|2", "Nappies|1"]);
    expect(prepared).toHaveLength(1);
    expect(bound).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// caching
// ---------------------------------------------------------------------------

describe("caching", () => {
  beforeEach(seedTheCategories);

  // Django's view carries @cache_page(SECONDS_IN_DAY) (gfdash/views.py:198),
  // and the port reproduces the shared half of that number -- but NOT from
  // anything in this route file: /dashboard/... matches no rule in
  // middleware/pageCacheControl.ts's SHARED_TTL list, so the day is its
  // FALL-THROUGH DEFAULT. That is the fact worth pinning here, because it
  // means a rule added above the default changes this page's TTL with nothing
  // in this directory to say it had. The 300-second browser max-age is
  // pageCacheControl's own documented divergence (a browser cache cannot be
  // purged).
  it("gets Django's day of shared cache, via pageCacheControl's default", async () => {
    expect((await get(PATH)).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // No Cache-Tag, so categorising a need in the admin cannot purge this page:
  // the chart is up to a day stale. middleware/cacheTag.ts's AGGREGATE_PATHS
  // covers the home page, the sitemaps, the feeds and the API list endpoints,
  // and no dashboard is in it. That matches Django, which cached the same page
  // for a day with no invalidation at all, so it is ported behaviour rather
  // than a regression -- pinned so a future purge-list change has something to
  // fail against.
  it("carries no cache tag, so a newly categorised line cannot purge it", async () => {
    expect((await get(PATH)).headers.get("Cache-Tag")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the shared page context
// ---------------------------------------------------------------------------

describe("the shared page context", () => {
  beforeEach(seedTheCategories);

  // buildPageContext({ path: c.req.path }) -- canonical is the request's own
  // path, matching context_processors.py:19 (SITE_DOMAIN + the path). Killed
  // the mutant that dropped the page-context spread from the render call,
  // which leaves a document with no canonical, no version query strings and no
  // debug comment, and still a 200.
  it("declares itself canonical at its own URL", async () => {
    expect(await body(PATH)).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
  });

  // The debug comment's "Took Nms" is elapsedMs(c), read off the timestamp
  // middleware/serverTiming.ts stored. Whole milliseconds, deliberately not
  // Django's three decimals (performance.now() only advances at I/O boundaries
  // on Workers, so the fraction was always exactly ".000"). The failure this
  // catches is the string "NaN": elapsedMs subtracts an unset context variable
  // if this handler is ever reached without serverTiming in front of it.
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body(PATH)).toMatch(/⏱️ Took \d+ms\n/);
  });

  // A DIVERGENCE, PINNED. context_processors.py:46-48 appended QUERY_STRING to
  // flag_path, so Django's "Something wrong in this page?" link carried the
  // query the reader was actually looking at. This handler's pageContext()
  // passes only `path`, so the query is dropped -- harmless here (nothing on
  // the page reads one), and recorded so it is a known difference rather than
  // a surprise if these dashboards ever grow a parameter.
  it("drops the query string from the flag link, unlike Django", async () => {
    expect(await body(`${PATH}?format=json`)).toContain(`href="/flag/#${ORIGIN}${PATH}"`);
  });

  // The breadcrumb hrefs come from @givefood/urls' reverse table
  // (`url('index')`, `url('dash:index')`, `url('dash:item_categories')`),
  // which is how Django's own template built them. If that table moved, the
  // page would still render with a 200 and every link on it would point at a
  // 404 -- and the self-referencing third crumb is the one that would say so,
  // because it must equal the URL the reader is already on.
  it("builds its breadcrumbs from the reverse-URL table", async () => {
    const html = await body(PATH);

    expect(html).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
    expect(html).toContain(`<li class="is-active"><a href="${PATH}" aria-current="page">Requested items by category</a></li>`);
  });
});

// ---------------------------------------------------------------------------
// when the query fails
// ---------------------------------------------------------------------------

describe("when the query fails", () => {
  // The handler has no try/catch, which is the right call and is worth pinning
  // as such. The defensive-looking alternative -- catching and rendering with
  // `categories: []` -- would publish a pie chart claiming nobody has ever
  // requested anything, when what actually happened is that D1 was
  // unavailable. An empty chart on a data page is a claim, and a false one is
  // worse than an error page.
  it("serves the real 500 page instead of an empty chart", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      DB: {
        withSession: () => ({
          prepare: () => ({
            all: async () => {
              throw new Error("D1_ERROR: network connection lost");
            },
          }),
        }),
      },
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`${ORIGIN}${PATH}`), broken, execCtx);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("<h1>500 - Internal Server Error</h1>");
    // Not a partial page: the chart's own container must not be on it, or a
    // reader gets a 500 that still draws an empty graph.
    expect(html).not.toContain('<div id="chart"');
  });
});

// ---------------------------------------------------------------------------
// WHAT SURVIVED THE MUTATION RUN, recorded because a report that lists only
// kills is not evidence of anything.
//
// One survivor out of 29, and it is the CONTROL: rewriting the handler's
// `categories.map((row) => ({ value: row.count, name: row.category }))` as a
// destructuring `categories.map(({ count, category }) => ({ value: count,
// name: category }))`. Behaviourally identical, so it must survive -- it was
// put in the run so that a suite which killed literally everything would be
// visibly suspicious (a test asserting on the module's SOURCE, or a harness
// that reported failure for the wrong reason, kills equivalent mutants too).
//
// Two kills worth naming, because each is a specific test's reason to exist:
//
//   `chart_data_json` renamed to `chartDataJson` -- kills SEVEN tests here and
//   NONE of the table tests, which is the whole argument for asserting the
//   chart's source text separately. Nunjucks with throwOnUndefined off (set
//   deliberately in packages/templates/src/env.ts) renders the page with a 200
//   and a correct-looking table above a chart built from nothing.
//
//   `render_time_ms` dropped from pageContext() -- kills exactly one test,
//   "reports a whole-millisecond render time in the debug comment", and only
//   because that test's regex asserts `\d+`. A looser /Took .*ms/ would have
//   let it through; the digit class is the assertion.
// ---------------------------------------------------------------------------
