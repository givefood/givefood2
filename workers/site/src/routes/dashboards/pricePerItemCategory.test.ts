import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/pricePerItemCategory.ts -- GET
// /dashboard/price-per/item-category/, the public "Price Per Item Category"
// stacked-area chart. Ported from gfdash/views.py:472-528
// (`@cache_page(SECONDS_IN_HOUR) def price_per_item_category`), registered at
// index.ts:565 and reversed by @givefood/urls as
// `dash:price_per_item_category`.
//
// WHY THIS FILE EXISTS, given packages/db/src/dashboards.test.ts already runs
// both of this page's queries through a real engine. The queries are the half
// this handler does NOT do. What it does do is the RESHAPE -- views.py:500-517's
// Python loop, ported by hand -- and every way that loop can be wrong still
// produces a 200 with a perfectly convincing chart on it:
//
//   * THE ALIGNMENT. The x-axis (`months_json`) and every series
//     (`categories_data`) are separate JSON documents that echarts zips
//     together POSITIONALLY -- xAxis.data[i] labels series.data[i]. If a
//     category's array is built against a different month list, or the
//     0-filling for a month it has no rows in is dropped, the series SHORTENS
//     and every point on it silently slides left onto the wrong month. Nothing
//     in the page complains; the line just tells a different story. That is the
//     single failure this file exists for, which is why the fixture below gives
//     three categories three DIFFERENT month spans.
//   * THE TWO LISTS DISAGREEING. `category_names` (the checkboxes) comes from
//     stage 1, ordered by line count descending. The keys of `categories_data`
//     come from stage 2, ordered by month then category. They are built from
//     different queries in different orders, and either can be right while the
//     other is empty, stale or short -- so both are asserted, separately, and
//     the fixture deliberately puts them in OPPOSITE orders.
//   * THE TWO COPIES OF 100. This module keeps its own MIN_ITEMS_FOR_CATEGORY
//     (pricePerItemCategory.ts:16) purely for the intro sentence, while the
//     threshold that actually filters lives in packages/db/src/dashboards.ts:432.
//     Its own comment says "keep in sync"; nothing enforces that, and drift is
//     invisible -- the page would read "more than 250 items" while showing
//     categories with 100. Pinned below by asserting the sentence and the BOUND
//     PARAMETER in the same test.
//   * A THIRD QUERY, or a write, on a page that is meant to be two reads of the
//     largest cost table in the schema.
//
// So the assertions are on RENDERED VALUES -- the exact JSON the browser
// parses, the exact checkbox tags -- and on the statement log, never on the
// status code alone.
//
// REAL EVERYTHING. The real app from ../../index (so the real router, the real
// middleware chain, the real APPEND_SLASH probe and the real 500 page), the
// real Nunjucks render(), the real getOrderLineCategoryTotals /
// getOrderLineCategoryMonthPrices, and real SQLite seeded from the real
// migrations via schemaFor("orderline"). Nothing is mocked; nothing on this
// path leaves the machine. Harness copied from the sibling
// routes/dashboards/itemCategories.test.ts rather than reinvented.
//
// MUTATION-TESTED (TESTING.md's convention) against a copy of the whole tree
// in the scratchpad OUTSIDE the repo -- never by editing a file in src/ and
// putting it back. The mutants applied and the tests that killed each are named
// on the tests themselves; two SURVIVED and are recorded at the foot of the
// file rather than quietly dropped.

const ORIGIN = "https://www.givefood.org.uk";
// Hardcoded rather than imported from @givefood/urls, so the string here and
// the string in index.ts:565 are two independent copies -- a rename that
// updated only one of them is exactly what this guards. Note the URL is
// `price-per/item-category/`, two segments, unlike the sibling
// `/dashboard/item-categories/`: gfdash/urls.py groups the three price-per
// dashboards under a shared prefix and this port copies it.
const PATH = "/dashboard/price-per/item-category/";

type Bindable = null | number | bigint | string | Uint8Array;

// Records the SQL prepared and the values bound to it. This page's cost
// argument is "exactly two statements, both reads, one session", and the log is
// the only place that claim is observable -- a rendered chart looks identical
// whether it took two queries or twenty.
function d1Session(db: DatabaseSync, prepared: string[], bound: Bindable[][]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => {
      bound.push(next as Bindable[]);
      return statement(sql, next as Bindable[]);
    },
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    // Present, not omitted: a test that proves this GET writes nothing must not
    // be leaning on writes being impossible in the fixture. This repo's own scar
    // is a GET route left able to run an UPDATE with a test named "does not
    // answer GET at all" passing throughout.
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

// Only the one table both statements name. Taken from the real migrations via
// schemaFor() rather than hand-written DDL: `group_name` is a rename of
// Postgres's reserved `group` (0005_orders_and_charity.sql:44) and the partial
// index this page's stage 1 sits on -- orderline_category_idx, `WHERE category
// IS NOT NULL` -- only exists in the migration. A fixture typed out by hand
// tests the author's memory rather than the shipped schema (github #51: eight
// suites broke at once on hand-built fixtures).
const SCHEMA = schemaFor("orderline");

let db: DatabaseSync;
let prepared: string[];
let bound: Bindable[][];
let sessionModes: string[];
let nextId: number;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      // Recorded rather than ignored: lib/session.ts asks for
      // "first-unconstrained", which is what makes these reads eligible for a
      // D1 read replica. One entry per request is also how the tests below know
      // the handler opened exactly one session for its two queries.
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

// `delivery_date` is a DATE, not a timestamp -- OrderLine.save() copies it off
// the parent order (givefood/models/orders.py:249) and Django's DateField
// serialises as "YYYY-MM-DD" with no time part. So unlike most fixtures in this
// repo these literals need no Django-shaped microseconds; what matters is that
// strftime('%Y-%m', ...) can parse them, which it can only do for an ISO date.
//
// item_cost and line_cost are PENCE and INTEGER NOT NULL. That is load-bearing
// for this page: stage 2 divides an INTEGER sum by an INTEGER count, which
// SQLite answers with INTEGER DIVISION (verified: SUM over 100/101/101 divided
// by COUNT(*) returns integer 100, not 100.67).
function seedLines(count: number, row: Record<string, Bindable> = {}): void {
  for (let i = 0; i < count; i += 1) {
    const n = (nextId += 1);
    const full: Record<string, Bindable> = {
      id: n,
      name: `Item ${n}`,
      quantity: 1,
      item_cost: 100,
      line_cost: 100,
      order_id: 1,
      delivery_date: "2024-01-10",
      category: "Tinned Goods",
      group_name: "Meal Food",
      ...row,
    };
    const columns = Object.keys(full);
    db.prepare(`INSERT INTO orderline (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
      ...columns.map((c) => full[c] as Bindable),
    );
  }
}

// THE FIXTURE MOST OF THIS FILE READS. Three qualifying categories, and 299
// rows that must NOT reach the page -- without those, every assertion here
// passes against a handler whose filters do nothing, which is the
// "only-matching-rows" trap this repo has been bitten by before.
//
// THE THREE MONTH SPANS ARE ALL DIFFERENT, ON PURPOSE, and that is the point of
// the whole fixture:
//
//   Dry Goods   2024-01 only          -> [400, 0, 0]   trailing zeros
//   Toiletries  2024-01 and 2024-02    -> [500, 700, 0] a zero on one end
//   Tinned Goods 2024-02 and 2024-03   -> [0, 200, 300] leading zeros
//
// Every category is missing at least one month, and the missing months land at
// the start for one and the end for another. A reshape that dropped the
// 0-filling, or that built each array against only its OWN months, produces
// three arrays of lengths 1, 2 and 2 against a three-label axis -- echarts
// renders that without complaint and every point on Tinned Goods moves two
// months earlier.
//
// THE LINE COUNTS ARE 150/120/100, ALL DISTINCT: with ties, SQLite's GROUP BY
// temp b-tree hands rows back in CATEGORY order whether or not the query asks
// for one, so a fixture with tied counts passes with `ORDER BY total_count
// DESC` deleted.
//
// AND THE TWO ORDERS ARE EXACT REVERSES OF EACH OTHER. Checkbox order (stage 1,
// count descending) is Tinned Goods, Toiletries, Dry Goods. `categories_data`
// key order (stage 2, first month a category appears in) is Dry Goods,
// Toiletries, Tinned Goods. Building either list from the other query is
// therefore visible rather than coincidentally identical.
//
// THE QUANTITIES ARE NOT ALL 1, which is the fixture's other deliberate
// asymmetry. Stage 2 divides by COUNT(*) -- LINES, matching Django's
// `Count('id')` (views.py:497) -- and a line ordering five tins is still one
// line. With every row carrying quantity 1, `COUNT(*)` and `SUM(quantity)` are
// the same number everywhere and a SUM(quantity) denominator survives every
// value assertion on the page (measured: with a uniform fixture that mutant
// died only on the SQL-text assertion). Tinned Goods' first month orders five
// at a time, so the mutant reports 40p rather than 200p there.
function seedTheCategories(): void {
  // 150 lines -- the largest, so the first checkbox; but its first month is the
  // SECOND month, so the last key in categories_data.
  seedLines(100, { category: "Tinned Goods", delivery_date: "2024-02-10", item_cost: 200, quantity: 5 });
  seedLines(50, { category: "Tinned Goods", delivery_date: "2024-03-10", item_cost: 300 });
  // 120 lines, spanning the first two months -- the only category present in
  // more than one of the fixture's month columns on both sides of a gap.
  seedLines(20, { category: "Toiletries", delivery_date: "2024-01-11", item_cost: 500 });
  seedLines(100, { category: "Toiletries", delivery_date: "2024-02-11", item_cost: 700 });
  // Exactly 100 lines: the boundary of packages/db's `HAVING total_count >= ?`.
  seedLines(100, { category: "Dry Goods", delivery_date: "2024-01-12", item_cost: 400 });

  // THE EXCLUSIONS.
  //
  // 99 lines is one short of the threshold, and they are dated inside the same
  // month range with a cost (999) that appears nowhere else, so a leak shows up
  // as an extra checkbox AND an extra series AND the number 999 in the JSON.
  seedLines(99, { category: "Household", delivery_date: "2024-01-13", item_cost: 999 });
  // 200 uncategorised lines in a month NO qualifying category has. This is the
  // more interesting exclusion of the two: packages/db's stage 1 adds `category
  // IS NOT NULL` where Django had no such filter (views.py:478), and stage 2's
  // `IN (...)` list can never match a NULL anyway -- so a leak here would add a
  // FOURTH LABEL, 2024-04, to the shared x-axis and push every series out of
  // alignment with it. Uncategorised lines are not hypothetical: the ported
  // line-parse job writes category "" or leaves it unset whenever the fallback
  // chain finds nothing (workers/jobs/src/adminJobs/orderLines.ts:162).
  seedLines(200, { category: null, delivery_date: "2024-04-10", item_cost: 111 });
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

// The checkbox column, as the raw `<input>` tags. Kept as source text rather
// than parsed into names: the `checked` attribute and the HTML escaping of
// `value` are both part of what is being asserted, and both would be normalised
// away by anything that understood the markup.
function checkboxTags(html: string): string[] {
  const block = /<div id="category-checkboxes">([\s\S]*?)<\/div>/.exec(html);
  if (!block) throw new Error("no #category-checkboxes block in the rendered page");
  return [...block[1]!.matchAll(/<input [^>]*>/g)].map((m) => m[0]);
}

// The two JSON documents the inline script parses, AS THE RAW SOURCE TEXT --
// deliberately not JSON.parse'd. Parsing them back would normalise away the one
// thing the escaping block at the foot of this file asks about, and would also
// hide a number arriving as a quoted string ("200" rather than 200), which
// echarts plots as NaN and renders as an invisible line with a 200 response.
function categoriesDataSource(html: string): string {
  const line = /var categoriesData = (.*);\n/.exec(html);
  if (!line) throw new Error("no categoriesData assignment in the rendered chart");
  return line[1]!;
}

function monthsSource(html: string): string {
  const line = /var allMonths = (.*);\n/.exec(html);
  if (!line) throw new Error("no allMonths assignment in the rendered chart");
  return line[1]!;
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

describe("the route", () => {
  // gfdash/urls.py's path, reached through the REAL router. A test that mounted
  // its own ad-hoc Hono route would pass with index.ts:565 deleted, which is a
  // failure a sibling suite records as having actually shipped.
  //
  // The 500px chart height is not decoration: all twenty gfdash handlers are
  // the same five-line shape and dash/item_categories.njk's chart div is 600px,
  // so asserting the height alongside the title is what separates "rendered the
  // price-per-item-category template" from "rendered A dashboard". Killed the
  // mutant that swapped the template name for "dash/price_per_calorie.njk".
  it("answers GET /dashboard/price-per/item-category/ with the Price Per Item Category page", async () => {
    seedTheCategories();

    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Price Per Item Category - Give Food</title>");
    expect(html).toContain("<h1>Price Per Item Category</h1>");
    expect(html).toContain('<div id="chart" style="height:500px"></div>');
    expect(html).toContain('<h2 class="is-size-5">Categories</h2>');
  });

  // GET ONLY. index.ts:565 registers `app.get(...)` and nothing else, so Hono
  // answers a POST with a 404.
  //
  // A DIVERGENCE FROM DJANGO, and a harmless one: Django's view is a plain
  // function with no method guard, so a POST there rendered the same page with
  // a 200. Neither writes anything; what is asserted is that the port's refusal
  // is reached WITHOUT running either query, so a POST flood cannot buy
  // repeated full aggregations of orderline.
  it("refuses a POST, and runs no query on the way to refusing it", async () => {
    seedTheCategories();

    const res = await get(PATH, { method: "POST" });

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block, entirely
  // outside i18n_patterns -- index.ts:542-544 says so and registers the
  // dashboards with no locale loop. The visible half is the absence of hreflang
  // alternates (buildPageContext is called with no `locale`, so `languages` is
  // empty and page.njk emits nothing); the routing half is that no /cy/ form of
  // this URL exists at all.
  it("is English-only: no hreflang alternates, and no language-prefixed URL", async () => {
    seedTheCategories();

    const res = await get(PATH);
    const html = await res.text();

    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).not.toContain("hreflang");
    expect(res.headers.get("Content-Language")).toBe("en");
    expect((await get(`/cy${PATH}`)).status).toBe(404);
  });

  // THE TRAILING SLASH COSTS A FULL RENDER AND BOTH D1 READS. lib/appendSlash.ts
  // answers Django's APPEND_SLASH by re-entering the app with a HEAD request for
  // the slashed URL and redirecting if it does not 404 -- so
  // /dashboard/price-per/item-category runs this handler in full, aggregates
  // orderline TWICE, renders the whole document and throws the body away, all to
  // produce a 301 with no content. Pinned rather than treated as a bug: it is
  // how the probe is documented to work, and it is the kind of cost that is
  // invisible in every metric except D1 rows read.
  it("301s a missing trailing slash, having really executed both queries to find out", async () => {
    seedTheCategories();

    const res = await get("/dashboard/price-per/item-category");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
    expect(prepared).toHaveLength(2);
  });

  // The neighbouring `/dashboard/price-per-kg/` is a 301 to the two-segment
  // form (index.ts:567, Django's RedirectView). There is NO equivalent legacy
  // alias for this page, so the hyphenated spelling someone would guess by
  // analogy is a plain 404 -- asserted so that "add the missing redirect" stays
  // a deliberate decision rather than something a reader assumes already
  // happened.
  it("has no legacy /dashboard/price-per-item-category/ alias", async () => {
    seedTheCategories();

    expect((await get("/dashboard/price-per-item-category/")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// the checkbox column -- stage 1's category_names
// ---------------------------------------------------------------------------

describe("the checkbox column", () => {
  beforeEach(seedTheCategories);

  // ONE CHECKBOX PER QUALIFYING CATEGORY, MOST LINES FIRST, and no others. The
  // exact tags rather than the names: `checked` is absent on all three here
  // (see the Baked Beans tests below) and the surrounding whitespace is the
  // template's, so this is the string a browser actually parses.
  //
  // Killed the mutants that renamed the handler's `category_names` key (which
  // leaves an empty column and a 200, because packages/templates/src/env.ts
  // sets throwOnUndefined: false on purpose), that passed stage 2's category
  // list instead, and that dropped `ORDER BY total_count DESC`.
  it("prints one checkbox per qualifying category, most-ordered first", async () => {
    expect(checkboxTags(await body(PATH))).toEqual([
      '<input type="checkbox" value="Tinned Goods" >',
      '<input type="checkbox" value="Toiletries" >',
      '<input type="checkbox" value="Dry Goods" >',
    ]);
  });

  // THE TWO EXCLUSIONS, named separately from the test above so a failure says
  // WHICH rule broke. "Household" has 99 lines -- one short of the `>=`
  // threshold -- and the 200 uncategorised lines have no category at all. A
  // reader cannot tell a missing category from a category that genuinely has no
  // data, which is why the absence is asserted rather than assumed.
  it("shows neither the 99-line category nor the uncategorised lines", async () => {
    const html = await body(PATH);

    expect(html).not.toContain("Household");
    expect(checkboxTags(html)).toHaveLength(3);
    // The 200 uncategorised lines would come through as an empty-valued box.
    expect(html).not.toContain('value="" ');
  });

  // BAKED BEANS IS THE PAGE'S DEFAULT SERIES, hardcoded in the template
  // (`{% if cat == "Baked Beans" %}checked{% endif %}`, njk:38, copied verbatim
  // from the Django template's line 39). It is the only category with a
  // pre-selected state, and it is matched by EXACT STRING -- so this is the one
  // place a category rename in the upstream ITEM_CATEGORIES list would silently
  // empty the page's default view.
  it("pre-checks Baked Beans and nothing else", async () => {
    seedLines(200, { category: "Baked Beans", delivery_date: "2024-02-14", item_cost: 88 });

    const tags = checkboxTags(await body(PATH));

    expect(tags[0]).toBe('<input type="checkbox" value="Baked Beans" checked>');
    expect(tags.filter((tag) => tag.includes("checked"))).toHaveLength(1);
  });

  // AND WHAT HAPPENS WHEN IT DOES NOT QUALIFY, which is the state the main
  // fixture is in and, on a fresh or partially-loaded database, the state
  // production is in. Nothing is checked, so updateChart() builds an empty
  // series list and the reader is shown a fully-loaded page with a blank chart
  // -- correct behaviour, ported exactly, and the kind of empty page that gets
  // reported as "the dashboard is broken". Pinned so nobody has to work that
  // out twice.
  it("checks nothing at all when Baked Beans has too few lines to qualify", async () => {
    const html = await body(PATH);

    expect(checkboxTags(html).some((tag) => tag.includes("checked"))).toBe(false);
    // The data is all still there -- it is only the default SELECTION that is
    // empty, so a click on any box draws a line.
    expect(categoriesDataSource(html)).not.toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// the reshape -- views.py:500-517, ported by hand
// ---------------------------------------------------------------------------

describe("the reshape", () => {
  beforeEach(seedTheCategories);

  // THE WHOLE POINT OF THE MODULE, in one assertion: three categories, three
  // month columns, every array the same length as the axis, zeros where a
  // category has no rows for that month.
  //
  // Asserted as the EXACT source text because this is a hand-written loop
  // producing JSON that the template drops in through `|safe`, not something
  // the template derives from a row list -- so no other assertion on the page
  // constrains it. The key order (Dry Goods, Toiletries, Tinned Goods) is
  // stage 2's row order, which is the reverse of the checkbox order above.
  //
  // Killed the mutants that: dropped the `?? 0` fill (arrays become
  // `[400]`/`[500,700]`/`[200,300]` -- shorter than the axis, every point
  // sliding left); built each category's array from its OWN months instead of
  // allMonthsSorted; and renamed the `categories_data` context key.
  it("builds one 0-filled array per category, aligned to the shared month axis", async () => {
    const html = await body(PATH);

    expect(monthsSource(html)).toBe('["2024-01","2024-02","2024-03"]');
    expect(categoriesDataSource(html)).toBe('{"Dry Goods":[400,0,0],"Toiletries":[500,700,0],"Tinned Goods":[0,200,300]}');
  });

  // THE AXIS AND THE SERIES MUST BE THE SAME LENGTH, stated as its own
  // arithmetic rather than as a consequence of the string above. echarts zips
  // xAxis.data against series.data by INDEX, so this is the invariant that
  // makes a point's label mean anything -- and it is the one that a future
  // "only emit the months this category has, to save bytes" optimisation would
  // break while leaving a chart that still renders.
  it("gives every series exactly as many points as there are month labels", async () => {
    const html = await body(PATH);
    const months = JSON.parse(monthsSource(html)) as string[];
    const series = JSON.parse(categoriesDataSource(html)) as Record<string, number[]>;

    expect(months).toHaveLength(3);
    for (const [category, points] of Object.entries(series)) {
      expect(`${category}:${points.length}`).toBe(`${category}:${months.length}`);
    }
  });

  // THE MONTH AXIS IS A UNION, not any single category's span. Dry Goods knows
  // only 2024-01 and Tinned Goods only 2024-02/03; neither category alone could
  // produce this axis. A reshape that seeded `allMonths` from the first row's
  // category, or that used the LAST category seen, gives a two-label axis here.
  //
  // The absence of 2024-04 is the other half: 200 uncategorised lines sit in
  // that month, and their exclusion is what proves stage 2's `IN (...)` list is
  // doing something. A leak there is far worse than an extra series -- it moves
  // the axis under every series at once.
  it("takes the month axis from every qualifying category and from no other line", async () => {
    const html = await body(PATH);

    expect(monthsSource(html)).toContain("2024-01");
    expect(monthsSource(html)).toContain("2024-03");
    expect(monthsSource(html)).not.toContain("2024-04");
    // 999 is the 99-line category's cost and 111 the uncategorised lines' --
    // neither may appear as a data point anywhere.
    expect(categoriesDataSource(html)).not.toContain("999");
    expect(categoriesDataSource(html)).not.toContain("111");
  });

  // MONTHS SORT CHRONOLOGICALLY ACROSS A YEAR BOUNDARY. "YYYY-MM" is the one
  // date shape where a lexical sort and a chronological one agree, which is
  // precisely why strftime('%Y-%m', ...) is used rather than anything friendlier
  // -- '%b %Y' would put April before January on this axis and the chart would
  // still draw. December-then-January is the case that catches it.
  it("orders the month axis chronologically across a year boundary", async () => {
    db.prepare("DELETE FROM orderline").run();
    seedLines(60, { category: "Dry Goods", delivery_date: "2024-12-10", item_cost: 300 });
    seedLines(60, { category: "Dry Goods", delivery_date: "2025-01-10", item_cost: 400 });
    seedLines(60, { category: "Dry Goods", delivery_date: "2025-09-10", item_cost: 500 });
    seedLines(60, { category: "Dry Goods", delivery_date: "2025-10-10", item_cost: 600 });

    const html = await body(PATH);

    // 09 before 10 within a year is the second half of the same claim: a
    // zero-padded month is what makes the string sort work at all.
    expect(monthsSource(html)).toBe('["2024-12","2025-01","2025-09","2025-10"]');
    expect(categoriesDataSource(html)).toBe('{"Dry Goods":[300,400,500,600]}');
  });

  // A CATEGORY THAT QUALIFIES BUT HAS NOTHING TO PLOT. Stage 1 counts every
  // line; stage 2 requires a delivery date. The asymmetry is real and
  // deliberate (packages/db/src/dashboards.test.ts:1875-1883 pins it at the
  // query level) and here is what it looks like on the page: a checkbox the
  // reader can tick that draws nothing, because the template's
  // `var data = categoriesData[cat]; if (!data) return;` (njk:86-87) skips it.
  //
  // Worth pinning because the alternative -- a series of `undefined` -- would
  // have echarts throw inside setOption and blank the whole chart, taking the
  // other three categories with it.
  it("gives an undated category a checkbox but no series, which the template skips", async () => {
    seedLines(300, { category: "Cereal", delivery_date: null, item_cost: 250 });

    const html = await body(PATH);

    // Largest by line count, so first in the column.
    expect(checkboxTags(html)[0]).toBe('<input type="checkbox" value="Cereal" >');
    // ...and absent from the series object entirely.
    expect(categoriesDataSource(html)).toBe('{"Dry Goods":[400,0,0],"Toiletries":[500,700,0],"Tinned Goods":[0,200,300]}');
    expect(monthsSource(html)).toBe('["2024-01","2024-02","2024-03"]');
  });

  // A GENUINE ZERO AND A MISSING MONTH ARE THE SAME NUMBER, and there is no way
  // to tell them apart on the chart. `?? 0` fills a gap with 0 and a month
  // whose average truncates to 0 is also 0 -- so the stacked area for a
  // free-item month and for a month the category was not stocked in are
  // identical. This is DJANGO'S BEHAVIOUR TOO (`.get(m, 0)`, views.py:517), so
  // it is ported parity rather than a regression, and it is pinned because
  // "null instead of 0 so echarts breaks the line" is the obvious improvement
  // and would be a deliberate divergence, not a bug fix.
  it("cannot distinguish a real zero price from a month with no rows", async () => {
    db.prepare("DELETE FROM orderline").run();
    seedLines(100, { category: "Dry Goods", delivery_date: "2024-01-10", item_cost: 0 });
    seedLines(100, { category: "Dry Goods", delivery_date: "2024-03-10", item_cost: 400 });
    seedLines(100, { category: "Toiletries", delivery_date: "2024-02-10", item_cost: 700 });

    // Dry Goods' 2024-01 is a REAL measured 0; its 2024-02 is a fill. Both
    // print as 0.
    expect(categoriesDataSource(await body(PATH))).toBe('{"Dry Goods":[0,0,400],"Toiletries":[0,700,0]}');
  });

  // THE PRICES ARE INTEGERS, and must reach the page as JSON numbers rather
  // than strings. SUM(item_cost) / COUNT(*) over two INTEGER columns is INTEGER
  // DIVISION in SQLite -- 30101/101 is 298, not 298.03 -- matching Django's
  // `Sum('item_cost') / Count('id')` over two IntegerFields (Postgres also
  // truncates; NOT verified against a running Postgres here, only read from
  // views.py:497).
  //
  // The failure this prevents is a future `ROUND(..., 2)` or a cast: echarts
  // plots 298 and "298" very differently, and the second is a NaN point in an
  // otherwise perfect-looking chart.
  it("emits whole-pence prices as JSON numbers, truncated not rounded", async () => {
    db.prepare("DELETE FROM orderline").run();
    seedLines(100, { category: "Dry Goods", delivery_date: "2024-01-10", item_cost: 300 });
    // One cheaper line drags the mean to 298.02, which truncates to 298.
    seedLines(1, { category: "Dry Goods", delivery_date: "2024-01-11", item_cost: 101 });

    const source = categoriesDataSource(await body(PATH));

    expect(source).toBe('{"Dry Goods":[298]}');
    expect((JSON.parse(source) as Record<string, number[]>)["Dry Goods"]![0]).toBe(298);
  });

  // AN EMPTY DATABASE IS A 200 WITH AN EMPTY OBJECT AND AN EMPTY ARRAY, not a
  // 404 and not a broken script. What the inline script must not receive is
  // `var categoriesData = ;` -- which is what a dropped context key produces,
  // silently, because throwOnUndefined is off -- and that would take the whole
  // <script> element with it, including nothing else on the page but also
  // producing a console error nobody sees.
  //
  // ONE STATEMENT, NOT TWO: with no qualifying categories,
  // getOrderLineCategoryMonthPrices returns early rather than building `IN ()`,
  // which is a syntax error in SQLite and would 500 this page rather than draw
  // an empty chart. That early return is only reachable through this path, so
  // this is where the page-level consequence is asserted.
  it("renders an empty chart, in one statement, when no category qualifies", async () => {
    db.prepare("DELETE FROM orderline").run();
    seedLines(50, { category: "Dry Goods" });

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(categoriesDataSource(html)).toBe("{}");
    expect(monthsSource(html)).toBe("[]");
    expect(checkboxTags(html)).toEqual([]);
    expect(prepared).toHaveLength(1);
    // The rest of the document is untouched -- the empty case degrades the
    // chart, not the page.
    expect(html).toContain("<h1>Price Per Item Category</h1>");
  });
});

// ---------------------------------------------------------------------------
// the two copies of 100
// ---------------------------------------------------------------------------

describe("the threshold the page claims and the threshold it uses", () => {
  // THE ONE TEST THAT SPANS BOTH. pricePerItemCategory.ts:16 keeps a local
  // MIN_ITEMS_FOR_CATEGORY = 100 used ONLY for the sentence, and
  // packages/db/src/dashboards.ts:432 keeps the one that actually filters. The
  // route file's own comment asks the next person to keep them in sync and
  // nothing enforces it: change one and the page reads "more than 250 items"
  // over a chart of categories with 100, or vice versa, with no error anywhere.
  //
  // So the sentence and the BOUND PARAMETER are asserted together, in one test,
  // deliberately -- separated into two they would each keep passing while the
  // pair drifted apart. Killed the mutant that changed the route's constant to
  // 250 and left the db's at 100.
  it("prints the same threshold it binds into the HAVING clause", async () => {
    seedTheCategories();

    const html = await body(PATH);

    expect(html).toContain("Categories with more than 100 items are shown.");
    expect(bound[0]).toEqual([100]);
  });

  // "MORE THAN 100" IS NOT WHAT THE QUERY DOES -- the comparison is `>=`
  // (packages/db/src/dashboards.ts:440, matching Django's `total_count__gte`,
  // views.py:483), so a category with exactly 100 lines is shown by a page that
  // says it will not be. SUSPECT, reported in suspectedBugs, and PINNED AS-IS
  // per TESTING.md rather than corrected: the wording is inherited verbatim
  // from the Django template (dash/price_per_item_category.html:30), so the
  // port is faithful and the defect is upstream.
  //
  // "Dry Goods" in the shared fixture has exactly 100 lines, which is what
  // makes this observable at all.
  it("shows a category with exactly 100 items despite saying 'more than 100'", async () => {
    seedTheCategories();

    const html = await body(PATH);

    expect((db.prepare("SELECT COUNT(*) AS n FROM orderline WHERE category = 'Dry Goods'").get() as { n: number }).n).toBe(100);
    expect(html).toContain("Categories with more than 100 items are shown.");
    expect(checkboxTags(html)).toContain('<input type="checkbox" value="Dry Goods" >');
  });
});

// ---------------------------------------------------------------------------
// what the request costs
// ---------------------------------------------------------------------------

describe("what the request costs", () => {
  beforeEach(seedTheCategories);

  // TWO statements, both READS, over ONE session.
  //
  // The exact SQL is asserted because stage 1 is the contract between this page
  // and the partial index built for it: orderline_category_idx is
  // `ON orderline(category) WHERE category IS NOT NULL`
  // (0005_orders_and_charity.sql:48), and a partial index can only serve a query
  // whose WHERE clause matches its own predicate. Rewrite it as `category != ''`
  // and the page renders identically while D1 scans every row of orderline --
  // and D1 meters rows read.
  //
  // Stage 2's text matters for a different reason: `IN (?, ?, ?)` is built by
  // string interpolation from the category count, and it is the only
  // variable-length parameter list in packages/db. At 101 qualifying categories
  // D1 rejects the statement outright (its cap is 100 bindings) and this page
  // goes down; the count is asserted here so the relationship between "one
  // placeholder per checkbox" and that cap is visible from the route.
  it("issues exactly two statements, both reads, over exactly one D1 session", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM orderline").get() as { n: number }).n;

    await get(PATH);

    expect(prepared).toEqual([
      "SELECT category, COUNT(*) AS total_count FROM orderline WHERE category IS NOT NULL GROUP BY category HAVING total_count >= ? ORDER BY total_count DESC",
      "SELECT strftime('%Y-%m', delivery_date) AS the_month, category, SUM(item_cost) / COUNT(*) AS price_per_item " +
        "FROM orderline WHERE category IN (?, ?, ?) AND delivery_date IS NOT NULL " +
        "GROUP BY the_month, category ORDER BY the_month, category",
    ]);
    for (const sql of prepared) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
    expect((db.prepare("SELECT COUNT(*) AS n FROM orderline").get() as { n: number }).n).toBe(before);
    // ONE session for both queries -- lib/session.ts's whole purpose is that
    // the two stages see the same snapshot, so stage 2 cannot be handed a
    // category name that stage 1 saw and stage 2's replica has not.
    // "first-primary" would also work and would silently give up read-replica
    // eligibility on a page with no consistency requirement beyond that.
    // Killed the mutant that changed it.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // STAGE 2 IS BOUND FROM STAGE 1'S ANSWER, in order, one placeholder per name.
  // This is the join between the two queries and it exists only in TypeScript
  // -- there is no SQL relating them -- so nothing else on the page or in
  // packages/db can catch it going wrong. A mutant that bound the checkbox
  // labels, or that passed the whole row objects, produces `[object Object]`
  // parameters, no matching rows, an empty chart and a 200.
  it("binds stage 1's category names into stage 2, in the same order", async () => {
    await get(PATH);

    expect(bound).toEqual([[100], ["Tinned Goods", "Toiletries", "Dry Goods"]]);
    expect(prepared[1]!.match(/\?/g)).toHaveLength(3);
  });

  // Two views in a row must be identical and must still be two statements each.
  // This is the assertion a "let me memoise the reshape in a module-level
  // variable" change trips over -- which on Workers would pin one isolate's
  // chart until it was evicted, and is a real temptation on a page whose two
  // queries are both full aggregations of the largest table in the schema.
  it("is idempotent across repeated views", async () => {
    const first = await body(PATH);
    prepared = [];
    bound = [];
    const second = await body(PATH);

    expect(categoriesDataSource(second)).toBe(categoriesDataSource(first));
    expect(monthsSource(second)).toBe(monthsSource(first));
    expect(checkboxTags(second)).toEqual(checkboxTags(first));
    expect(prepared).toHaveLength(2);
  });

  // NOTHING IN THE URL REACHES EITHER QUERY. The handler takes no parameters at
  // all -- the category SELECTION is a client-side URL FRAGMENT (njk:64-77's
  // updateHash/loadFromHash), which never leaves the browser. Asserted because
  // "let me make the selection shareable server-side" is the obliging edit that
  // would put user input next to a statement whose IN list is built by string
  // interpolation.
  it("ignores a query string entirely", async () => {
    const html = await body(`${PATH}?category=Household&min_items=1&months=2024-04`);

    expect(checkboxTags(html)).toHaveLength(3);
    expect(monthsSource(html)).toBe('["2024-01","2024-02","2024-03"]');
    expect(bound).toEqual([[100], ["Tinned Goods", "Toiletries", "Dry Goods"]]);
  });
});

// ---------------------------------------------------------------------------
// caching
// ---------------------------------------------------------------------------

describe("caching", () => {
  beforeEach(seedTheCategories);

  // A DIVERGENCE, PINNED. Django's view carries @cache_page(SECONDS_IN_HOUR)
  // (gfdash/views.py:472) -- an HOUR, unlike most of gfdash, because order data
  // arrives daily and the page is cheap to be wrong about. The port gives it a
  // DAY: /dashboard/... matches no rule in middleware/pageCacheControl.ts's
  // SHARED_TTL list, so it takes the FALL-THROUGH DEFAULT of SECONDS_IN_DAY,
  // and no dashboard is in middleware/cacheTag.ts's AGGREGATE_PATHS so nothing
  // can purge it either.
  //
  // Reported in suspectedBugs and pinned as-is per TESTING.md. It also means a
  // rule ADDED above the default silently changes this page's TTL with nothing
  // in this directory to say it had.
  it("is cached for a day, not Django's hour, via pageCacheControl's default", async () => {
    const res = await get(PATH);

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the shared page context
// ---------------------------------------------------------------------------

describe("the shared page context", () => {
  beforeEach(seedTheCategories);

  // buildPageContext({ path: c.req.path }) -- canonical is the request's own
  // path, matching context_processors.py's SITE_DOMAIN + path. Killed the
  // mutant that dropped the page-context spread from the render call, which
  // leaves a document with no canonical, no ?v= version query strings on the
  // two <script> tags this page needs, and still a 200.
  it("declares itself canonical at its own URL and versions its chart scripts", async () => {
    const html = await body(PATH);

    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
    // echarts.js and chart-colors.js are loaded by this template alone among
    // the page's includes; without the context spread they lose their cache
    // buster and a deploy that changes the palette never reaches a browser.
    expect(html).toMatch(/<script src="\/static\/js\/echarts\.js\?v=[^"]+"><\/script>/);
    expect(html).toMatch(/<script src="\/static\/js\/chart-colors\.js\?v=[^"]+"><\/script>/);
  });

  // The debug comment's "Took Nms" is elapsedMs(c), read off the timestamp
  // middleware/serverTiming.ts stored. The `\d+` is deliberate and not
  // decoration: a looser /Took .*ms/ passes against "Took ms", which is what
  // dropping render_time_ms from pageContext() produces, and against "Took
  // NaNms", which is what reaching this handler without serverTiming in front
  // of it produces.
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body(PATH)).toMatch(/⏱️ Took \d+ms\n/);
  });

  // The breadcrumb hrefs come from @givefood/urls' reverse table
  // (`url('index')`, `url('dash:index')`, `url('dash:price_per_item_category')`),
  // which is how Django's own template built them. If that table moved, the
  // page would still render with a 200 and every link on it would point at a
  // 404 -- and the self-referencing third crumb is the one that would say so,
  // because it must equal the URL the reader is already on. Note the reverse
  // name uses underscores while the URL uses hyphens, which is exactly the
  // near-miss this catches.
  it("builds its breadcrumbs from the reverse-URL table", async () => {
    const html = await body(PATH);

    expect(html).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
    expect(html).toContain(`<li class="is-active"><a href="${PATH}" aria-current="page">Price Per Item Category</a></li>`);
  });

  // A DIVERGENCE, PINNED. context_processors.py appended QUERY_STRING to
  // flag_path, so Django's "Something wrong in this page?" link carried the
  // query the reader was actually looking at. This handler's pageContext()
  // passes only `path`, so the query is dropped -- harmless here (nothing on
  // the page reads one) and recorded so it stays a known difference.
  it("drops the query string from the flag link, unlike Django", async () => {
    expect(await body(`${PATH}?format=json`)).toContain(`href="/flag/#${ORIGIN}${PATH}"`);
  });
});

// ---------------------------------------------------------------------------
// category names the allowlist would never produce
// ---------------------------------------------------------------------------
//
// orderline.category is CONSTRAINED IN THE APPLICATION, NOT IN THE DATABASE
// (PLAN.md §4.5, and the column is a plain nullable TEXT). Django's model
// declares `choices=ITEM_CATEGORIES_CHOICES` (givefood/models/orders.py:243)
// and the port's line-parse job copies a category from a previous line, a need
// line, or a Gemini answer checked against that same list
// (workers/jobs/src/adminJobs/orderLines.ts:160-162) -- so today every value in
// the column is a plain ASCII phrase.
//
// The rows below are therefore NOT rows the live writer can produce, which is
// why they are pinned as CURRENT BEHAVIOUR and reported rather than fixed. They
// are worth pinning anyway: the constraint is app-level, this page pushes the
// column straight into an inline <script> through `|safe`, and a backfill or an
// import that wrote the column directly would land on exactly this.

describe("category names the allowlist would never produce", () => {
  // THE ESCAPING THAT HOLDS. Django emitted this object with json.dumps and the
  // port with JSON.stringify; both escape a `"` inside a key to `\"`, which is
  // correct inside the JS object literal. The checkbox is a separate mechanism
  // entirely -- nunjucks autoescaping turns it into `&quot;` -- and both halves
  // are asserted because they can fail independently.
  it("escapes a double quote in the JSON and HTML-escapes it in the checkbox", async () => {
    seedLines(100, { category: 'Tinned "Goods"', delivery_date: "2024-01-10", item_cost: 150 });

    const html = await body(PATH);

    expect(categoriesDataSource(html)).toBe('{"Tinned \\"Goods\\"":[150]}');
    expect(checkboxTags(html)).toEqual(['<input type="checkbox" value="Tinned &quot;Goods&quot;" >']);
  });

  // AND THE ESCAPING THAT DOES NOT. SUSPECT -- reported in suspectedBugs,
  // pinned rather than fixed.
  //
  // JSON.stringify does not escape `<` or `/`, so a category containing the
  // literal text `</script>` reaches the document unchanged INSIDE the inline
  // <script> element. An HTML parser ends the script at that sequence
  // regardless of the JavaScript around it, so the chart dies and the rest of
  // the category name is parsed as MARKUP. json.dumps has the identical hole,
  // so this is inherited from Django rather than introduced here; the
  // conventional fix is `.replace(/</g, "\\u003c")`, which stays valid JSON and
  // cannot close the element.
  //
  // Not reachable from the live writer today (see this block's header), so it
  // is a latent defect rather than a live XSS -- but the sibling
  // routes/dashboards/itemCategories.ts carries a comment claiming
  // JSON.stringify handles exactly this case, and that comment is what the next
  // person will trust.
  //
  // The checkbox half is safe: nunjucks escapes the whole thing to entities.
  it("does NOT escape a closing script tag inside the chart's JSON", async () => {
    seedLines(100, { category: "Beans</script><img src=x>", delivery_date: "2024-01-10", item_cost: 42 });

    const html = await body(PATH);

    expect(categoriesDataSource(html)).toBe('{"Beans</script><img src=x>":[42]}');
    expect(html).toContain('var categoriesData = {"Beans</script>');
    expect(checkboxTags(html)).toEqual(['<input type="checkbox" value="Beans&lt;/script&gt;&lt;img src=x&gt;" >']);
  });

  // AN EMPTY CATEGORY, WHICH IS THE ONE CASE HERE THAT IS ACTUALLY REACHABLE.
  // Django's CharField has no null, so an uncategorised line is `""`, not NULL;
  // the ported job writes `?? ""` for the same reason
  // (adminJobs/orderLines.ts:162). `category IS NOT NULL` does not exclude an
  // empty string, so 100 uncategorised-in-the-Django-sense lines produce a real
  // qualifying category with no name: an unlabelled checkbox, and a series
  // whose legend entry is blank.
  //
  // Pinned because it is the page's one silent corruption mode that a reader
  // would read straight past, and because neither the handler nor Django does
  // any filtering of it.
  it("treats an empty-string category as a real, unlabelled category", async () => {
    seedLines(150, { category: "", delivery_date: "2024-01-10", item_cost: 60 });
    seedLines(100, { category: "Dry Goods", delivery_date: "2024-01-10", item_cost: 400 });

    const html = await body(PATH);

    expect(checkboxTags(html)).toEqual(['<input type="checkbox" value="" >', '<input type="checkbox" value="Dry Goods" >']);
    expect(categoriesDataSource(html)).toBe('{"":[60],"Dry Goods":[400]}');
  });

  // A HARMLESS DIVERGENCE, PINNED BECAUSE IT IS SURPRISING. The port builds
  // `categories_aligned` by iterating `Object.keys(categoriesData)`, and
  // JavaScript enumerates INTEGER-LIKE string keys first, in ascending numeric
  // order, whatever order they were inserted in. Python's dict preserves
  // insertion order for every key, so views.py:516's loop does not reorder
  // anything.
  //
  // Verified rather than assumed, both sides, on this machine:
  //   node   -> {"2024":2,"Beans":1,"Soup":3}
  //   python -> {"Beans": 1, "2024": 2, "Soup": 3}   (CPython 3.13.0)
  //
  // Here "2024" is inserted SECOND (its first month is later) and comes out
  // FIRST. It changes nothing a reader sees -- the template looks each category
  // up by name (njk:86) and never iterates the object -- so this is
  // documentation, not a defect. It is also the one place a category name that
  // happens to be a year would behave differently from every other name, which
  // is worth having written down.
  it("reorders an integer-like category name to the front, where Python would not", async () => {
    seedLines(100, { category: "Beans", delivery_date: "2024-01-10", item_cost: 70 });
    seedLines(100, { category: "2024", delivery_date: "2024-02-10", item_cost: 80 });

    // Stage 2 hands the rows over Beans-first, so a faithful port of the Python
    // loop would emit Beans first too.
    expect(categoriesDataSource(await body(PATH))).toBe('{"2024":[0,80],"Beans":[70,0]}');
  });
});

// ---------------------------------------------------------------------------
// when a query fails
// ---------------------------------------------------------------------------

describe("when a query fails", () => {
  // The handler has no try/catch, which is the right call and is worth pinning
  // as such. The defensive-looking alternative -- catching and rendering with
  // an empty `categories_data` -- would publish a price chart claiming there is
  // no price history at all, when what actually happened is that D1 was
  // unavailable. An empty chart on a data page is a claim, and a false one is
  // worse than an error page.
  it("serves the real 500 page instead of an empty chart", async () => {
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
    // Not a partial page: neither the chart container nor the inline script may
    // be on it, or a reader gets a 500 that still draws a graph.
    expect(html).not.toContain('<div id="chart"');
    expect(html).not.toContain("var categoriesData");
  });

  // THE SECOND QUERY FAILING ON ITS OWN, which is a different code path: stage 1
  // has already succeeded, so the handler is holding a perfectly good
  // `category_names` list and could very plausibly be "improved" into rendering
  // the checkbox column with an empty chart beside it. It must not -- a page
  // listing twelve categories with a blank graph reads as "we have no price
  // data", not as "the database is down".
  it("500s when only the month-price query fails, rather than rendering half a page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedTheCategories();
    let calls = 0;
    const flaky = {
      ...env(),
      DB: {
        withSession: (mode: string) => {
          const real = d1Session(db, prepared, bound);
          return {
            prepare: (sql: string) => {
              calls += 1;
              if (calls === 1) return real.prepare(sql);
              throw new Error("D1_ERROR: too many SQL variables");
            },
          };
        },
      },
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`${ORIGIN}${PATH}`), flaky, execCtx);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).not.toContain("Tinned Goods");
  });
});

// ---------------------------------------------------------------------------
// THE MUTATION RUN, in full -- kills AND survivors, because a report that lists
// only kills is not evidence of anything. Every mutant below was applied to a
// COPY OF THE WHOLE TREE in the scratchpad, outside the repo; nothing in src/
// was edited and restored. 24 mutants, 22 killed, 2 survivors, both of them
// equivalent mutants that no fixture can reach.
//
// A note on the method, because it nearly produced a false report: the first
// pass showed every packages/db mutant as killed and a later pass showed the
// same mutants surviving. Neither was the truth -- vitest was serving a stale
// transform of the cross-package module. The runs below clear every .vite cache
// in the copy and touch the test file before each mutant, and the setup was
// checked with a canary (a bare `throw` appended to packages/db/src/dashboards.ts)
// to confirm an edit there really reaches the run.
//
// SURVIVED -- 2, both provably unobservable:
//
//   * Deleting `[...allMonths].sort()` and using the Set's own insertion order.
//     Stage 2's SQL already carries `ORDER BY the_month, category`, so rows
//     arrive month-ascending and the Set is in sorted order before .sort()
//     touches it. No fixture of any size can see the difference, and a "sorts
//     the months" test that passed either way would be worse than saying so.
//     It stops being unobservable the day that ORDER BY changes -- which is why
//     packages/db/src/dashboards.test.ts pins the clause as SQL text.
//   * Making `categoriesData[cat][month] = price` keep the FIRST value instead
//     of the last. Stage 2 groups by (the_month, category), so there is never
//     more than one row per pair and the assignment never overwrites anything.
//
// KILLED -- 22, with the test each one dies on first:
//
//   the reshape, which is what this file is mainly for
//   * skip missing months instead of 0-filling ......... builds one 0-filled array
//   * drop the `?? 0` alone (arrays get JSON nulls) .... builds one 0-filled array
//   * build each array from its OWN months ............. gives every series ... points
//   * record a month only the first time its category
//     appears (allMonths.add moved into the guard) ..... takes the month axis from every
//   * reverse the Object.keys() iteration .............. builds one 0-filled array
//
//   the context the template reads
//   * rename `categories_data` ......................... builds one 0-filled array
//   * rename `months_json` ............................. takes the month axis from every
//   * rename `category_names` .......................... prints one checkbox per
//   * `category_names` fed from stage 2 instead of 1 ... prints one checkbox per
//   * drop the `...pageContext(c)` spread .............. declares itself canonical
//   * drop `render_time_ms` ............................ reports a whole-millisecond
//   * route's own MIN_ITEMS_FOR_CATEGORY -> 250 ........ prints the same threshold
//   * render "dash/price_per_calorie.njk" instead ...... answers GET ... with the page
//
//   the router and the session (index.ts, lib/session.ts)
//   * delete the app.get registration .................. answers GET ... with the page
//   * register the path without its trailing slash ..... answers GET ... with the page
//   * withSession("first-primary") ..................... issues exactly two statements
//
//   the two queries (packages/db/src/dashboards.ts)
//   * stage 1 `>=` becomes `>` ......................... prints one checkbox per
//   * stage 1 drops `category IS NOT NULL` ............. prints one checkbox per
//   * stage 1 drops `ORDER BY total_count DESC` ........ prints one checkbox per
//   * stage 2 drops `delivery_date IS NOT NULL` ........ gives an undated category
//   * stage 2 divides by SUM(quantity) not COUNT(*) .... builds one 0-filled array
//   * stage 2 month label `%m` instead of `%Y-%m` ...... builds one 0-filled array
//
// The last two are the reason the shared fixture is shaped the way it is: the
// SUM(quantity) mutant died only on the SQL-text assertion until Tinned Goods'
// first month was given quantity 5, and the `%m` mutant needs the year-boundary
// case to be more than a relabelling.
// ---------------------------------------------------------------------------
