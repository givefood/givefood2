import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/pricePerCalorie.ts -- GET /dashboard/price-per/calorie/,
// the public "Price Per Calorie" chart. Ported from gfdash/views.py:531-558
// (`@cache_page(SECONDS_IN_HOUR) def price_per_calorie`), registered at
// index.ts:564 and linked from dash/index.njk:78.
//
// WHY THIS FILE EXISTS, given packages/db/src/dashboards.test.ts already runs
// both queries through a real engine. The handler is eight lines with two
// ternaries in it, so nothing here can throw -- and that is exactly the
// problem. Every way this page can be wrong is a 200 with a plausible chart
// and a plausible sentence under the heading:
//
//   * TWO QUERIES OVER TWO DIFFERENT TABLES, whose results are printed
//     side by side. `months` comes from `orderline` and the three headline
//     figures come from `orders` (dashboards.ts:364 and :411). They are
//     shaped alike, they are both about deliveries, and swapping either for
//     the other renders perfectly.
//   * MONTH_NAMES, a hand-copied 12-element array indexed by `month - 1`.
//     An off-by-one prints "Give Food has been purchasing food for food
//     banks since February 2021" on a page whose first bar is January, and
//     there is no other reader of that array anywhere in the stack. This
//     module holds its OWN copy of the table -- pricePerKg.ts has a second
//     one -- so the two can drift apart with nothing to say so.
//   * the rows not reaching the template, or reaching it under a name the
//     template does not read. `months` drives BOTH the <table>
//     (dash/price_per_calorie.njk:39-44) and the `dates`/`values` arrays the
//     echarts option is built from (:60-63); rename it and nunjucks renders
//     an empty chart in silence, because packages/templates/src/env.ts sets
//     throwOnUndefined: false on purpose.
//   * `first_month_name`/`first_month_year` are computed HERE where Django
//     computed them in the template (`{{ months.0.month|date:"F" }}`), so
//     the port owns a behaviour Django got for free.
//   * the reachability of the URL itself. This is one `app.get` line in
//     index.ts:564 -- routes/admin/dupePostcodes.test.ts records the sibling
//     case where a shipped link 404ed because no route was registered.
//
// So the assertions below are on the RENDERED VALUES -- the table cells, the
// two JavaScript arrays, and the prose sentence -- and on the statement log,
// not on the status code.
//
// REAL EVERYTHING. The real app from ../../index (so the real router, the real
// middleware chain, the real trailing-slash probe and the real 500 page), the
// real Nunjucks render() through the real templates, the real
// getPricePerCalorieByMonth/getOrderCalorieTotals, and real SQLite seeded from
// the real migrations via schemaFor(). Nothing is mocked; nothing on this path
// leaves the machine. Same harness as routes/dashboards/beanPastaIndex.test.ts
// and deliveries.test.ts, which this file is modelled on.
//
// MUTATION-TESTED (TESTING.md's convention) in a copy of the whole tree in the
// scratchpad OUTSIDE the repo, never by editing a file in src/ and putting it
// back. 39 mutants applied and re-run; 38 died. Widened past pricePerCalorie.ts
// itself, because a careless edit to any of these reaches this page just as
// surely as one to the handler. The kills worth naming, because each is a
// test's reason to exist:
//
//   index.ts -- the registration deleted; the path retyped as
//     /dashboard/price-per/calories/; registered as .all so a POST is answered.
//   the handler -- MONTH_NAMES rotated forward by one; the lookup changed to
//     [month]; "September" mis-spelled "Sept"; November and December
//     transposed; months[0] changed to the last row; `months` renamed;
//     `totals.items` and `totals.calories` transposed; number_foodbanks
//     hardcoded; the template swapped for dash/price_per_kg.njk; the page
//     context no longer spread in; render_time_ms dropped; canonical built
//     from c.req.url; c.text() instead of c.html(); the months query issued
//     twice; the months call wrapped in `.catch(() => [])`; and an UPDATE
//     bolted on alongside the reads (this repo's own scar -- a GET route left
//     able to run one, with its "does not answer GET at all" test passing
//     throughout).
//   packages/db -- `calories > 0` dropped; `delivery_date IS NOT NULL`
//     dropped; the *2000 multiplier halved; SUM(line_cost)/SUM(calories)
//     rewritten as AVG(line_cost*2000/calories); GROUP BY narrowed to month
//     alone; ORDER BY reversed; both CASTs removed; COUNT(DISTINCT
//     foodbank_id) widened to COUNT(*); SUM(no_items) changed to
//     SUM(no_lines); SUM(calories) changed to SUM(weight); the `?? 0`
//     fallbacks removed.
//   lib/session.ts -- the mode changed to "first-primary".
//   the template -- the chart's `- 1` dropped; the values loop deleted; the
//     table loop deleted; a price cell hardcoded; `|intcomma` removed from
//     items and added to the food bank count; first_month_year pointed at a
//     variable nothing sets. (A .njk edit is inert until the precompile step
//     is re-run, so the harness re-runs it -- without that a template
//     "mutant" proves nothing.)
//
// THE ONE SURVIVOR, recorded because a mutation run that reports only kills is
// not evidence. Rewriting `firstMonth ? MONTH_NAMES[firstMonth.month - 1] : ""`
// as `MONTH_NAMES[firstMonth?.month - 1]` survives, and always will: with no
// months, `undefined - 1` is NaN, MONTH_NAMES[NaN] is undefined, and nunjucks
// prints undefined and "" identically (throwOnUndefined is off). It is an
// EQUIVALENT mutant as far as this page is concerned, and no test that goes
// through the route can kill it. The ternary is still worth keeping -- it is
// what stops the next field anyone reaches for from being a TypeError -- but
// this file cannot claim to be defending it.
//
// TWO FALSE SURVIVORS were corrected during the run, both worth recording
// because they are what makes a mutation report readable rather than
// decorative:
//   * "SUM(no_items) -> SUM(no_lines)" first "survived" because the search
//     string `"SELECT SUM(no_items) AS items,` is a PREFIX of
//     getOrderWeightTotals' query 12 lines higher up, so the edit landed on
//     the price-per-KG page's statement, which this page never runs. Anchored
//     on the whole calorie statement, it dies.
//   * `.catch(() => [])` on the months call first "survived" because the only
//     failure test used a binding where EVERYTHING threw -- so the second
//     query threw too and the page 500'd anyway. It dies against
//     halfBrokenEnv("months"), which is why that helper exists.

const ORIGIN = "https://www.givefood.org.uk";
// Hardcoded rather than read from @givefood/urls, so that the string in this
// file and the string in ROUTES/index.ts are two independent copies -- a
// rename that updated only one of them is exactly what this is guarding.
// gfdash/urls.py spells the URL with a slash between "price-per" and
// "calorie"; Django's reverse name has underscores throughout.
const PATH = "/dashboard/price-per/calorie/";

type Bindable = null | number | bigint | string | Uint8Array;

// Records the SQL prepared and the values bound to it. This page's cost
// argument is "two statements, no parameters, per view", and the log is the
// only place that claim is observable -- a rendered chart looks the same
// whether it took two queries or six.
function d1Session(db: DatabaseSync, prepared: string[], bound: Bindable[][]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => {
      bound.push(next as Bindable[]);
      return statement(sql, next as Bindable[]);
    },
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    // Present, not omitted: a test that proves this GET writes nothing must
    // not be relying on writes being impossible in the fixture.
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

// Both tables the page reads, and nothing else. Taken from the real migrations
// via schemaFor() rather than hand-written DDL -- 0005_orders_and_charity.sql
// declares nine NOT NULL columns on `orders` that this page never looks at,
// and a fixture typed out by hand tests the author's memory of that list
// rather than the shipped schema (github #51 -- eight suites broke at once on
// hand-built fixtures).
const SCHEMA = schemaFor("orders", "orderline");

let db: DatabaseSync;
let prepared: string[];
let bound: Bindable[][];
let sessionModes: string[];
let nextOrderId: number;
let nextLineId: number;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      // Recorded rather than ignored: lib/session.ts asks for
      // "first-unconstrained", which is what makes these reads eligible for a
      // D1 read replica. One entry per request is also how the tests below
      // know the handler opened exactly one session for its two queries.
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session(db, prepared, bound);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// seeds
// ---------------------------------------------------------------------------

// An `orders` row with every NOT NULL column 0005 declares, so a seeded row is
// one production would have accepted.
//
// `no_lines` is deliberately NOT no_items, and not a constant either. The
// headline sentence prints SUM(no_items); a copy-paste to SUM(no_lines) is a
// one-word edit that renders a perfectly believable smaller number, and it
// would survive any fixture where the two columns agree. Same reasoning for
// `calories`, which defaults to 0 here and is set explicitly by every seed
// that means it: the orders table's `calories` and the orderline table's
// `calories` are different columns feeding different halves of this page.
function seedOrder(row: Partial<Record<string, Bindable>> = {}): void {
  const n = (nextOrderId += 1);
  const full: Record<string, Bindable> = {
    id: n,
    order_id: `GF-${n}`,
    items_text: "Baked beans x1",
    country: "England",
    created: "2024-01-01 00:00:00.000000",
    modified: "2024-01-01 00:00:00.000000",
    delivery_date: "2024-01-10",
    delivery_hour: 12,
    delivery_datetime: "2024-01-10 12:00:00.000000",
    weight: 1000,
    calories: 0,
    cost: 1000,
    no_lines: 7 + n,
    no_items: 0,
    foodbank_id: null,
    ...row,
  };
  const columns = Object.keys(full);
  db.prepare(`INSERT INTO orders (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((c) => full[c] as Bindable),
  );
}

// An `orderline` row. delivery_date is TEXT holding Django's DateField
// spelling "YYYY-MM-DD"; strftime() is what turns it into the year/month pair,
// and the format it is handed decides whether that pair comes out at all (see
// "the months the SQL cannot name" below).
function seedLine(row: Partial<Record<string, Bindable>> = {}): void {
  const n = (nextLineId += 1);
  const full: Record<string, Bindable> = {
    id: n,
    name: "Baked beans 400g",
    quantity: 1,
    item_cost: 100,
    line_cost: 100,
    weight: 400,
    calories: 1000,
    order_id: 1,
    delivery_date: "2024-01-10",
    category: null,
    group_name: null,
    ...row,
  };
  const columns = Object.keys(full);
  db.prepare(`INSERT INTO orderline (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((c) => full[c] as Bindable),
  );
}

// THE FIXTURE MOST OF THIS FILE READS, and half of it is rows that must NOT
// appear. Without those, every assertion here would pass against a handler
// whose query had lost its WHERE clause entirely -- the "a filter that does
// nothing passes every test that only seeds matching rows" trap.
//
// Three months, with prices chosen so that no two are equal and none is a
// round multiple of another:
//
//   2024-01   (100+200) * 2000 / (1000+1000) = 300
//   2024-02   500 * 2000 / 4000              = 250
//   2024-11   900 * 2000 / 700               = 2571 (truncated from 2571.42)
//
// November rather than March for the third, because "2024-11" and month 11 are
// the two-digit cases: a `%-m` strftime, a template that prints the raw
// zero-padded string, or a MONTH_NAMES lookup that ran off the end of the
// array all show up in the eleventh month and in no earlier one.
function seedTheChart(): void {
  seedLine({ delivery_date: "2024-01-05", line_cost: 100, calories: 1000 });
  seedLine({ delivery_date: "2024-01-25", line_cost: 200, calories: 1000 });
  seedLine({ delivery_date: "2024-02-05", line_cost: 500, calories: 4000 });
  seedLine({ delivery_date: "2024-11-05", line_cost: 900, calories: 700 });

  // THE EXCLUSIONS, all in months that appear NOWHERE in the expected output,
  // so a leak shows up as an extra row and an extra bar rather than as a
  // number that is merely wrong -- much harder to miss.
  //
  // `calories > 0` (Django's `calories__gt=0`) is doing two jobs: keeping
  // non-food lines out of a food price index, and keeping the denominator away
  // from zero. Both of these carry a large line_cost, so a leak would not be
  // subtle -- but it would still be a 200.
  seedLine({ delivery_date: "2024-05-05", line_cost: 5000, calories: 0 });
  seedLine({ delivery_date: "2024-06-05", line_cost: 5000, calories: null });
  // `delivery_date IS NOT NULL` is the port's own addition (Django's
  // TruncMonth(NULL) produced a None month that views.py never dereferenced
  // here). Without it this row's NULL year/month pair sorts to the FRONT of
  // the series -- see "the months the SQL cannot name".
  seedLine({ delivery_date: null, line_cost: 5000, calories: 1000 });

  // The three headline figures come from `orders`, a DIFFERENT TABLE from the
  // one above. Two orders for one food bank, one for another, and one orphan
  // with no food bank at all: 12,345 + 20 + 1,000 + 5 items, 900,000 + 1,000 +
  // 2,000 + 100 calories, and two distinct food banks.
  seedOrder({ foodbank_id: 1, no_items: 12_345, calories: 900_000 });
  seedOrder({ foodbank_id: 1, no_items: 20, calories: 1000 });
  seedOrder({ foodbank_id: 2, no_items: 1000, calories: 2000 });
  seedOrder({ foodbank_id: null, no_items: 5, calories: 100 });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepared = [];
  bound = [];
  sessionModes = [];
  nextOrderId = 0;
  nextLineId = 0;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, method = "GET"): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, { method }), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// ---------------------------------------------------------------------------
// reading the page
// ---------------------------------------------------------------------------

// The <table> under the chart, as "year-month|price" pairs. Parsed rather than
// matched as a slab of markup so the claim stays on the DATA, while still
// pinning the order and the exact strings (the trailing "p" for pence
// included -- it is part of the cell, and a template that lost it would be
// publishing pounds-looking numbers).
function tableRows(html: string): string[] {
  const table = /<table[\s\S]*?<\/table>/.exec(html);
  if (!table) throw new Error("no <table> in the rendered page");
  return [...table[0].matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/g)].map((m) => `${m[1]}|${m[2]}`);
}

// The `dates.push(new Date(Y, M, 1))` arguments, as the RAW source text the
// browser will parse. THE TABLE IS NOT A PROXY FOR THIS: the table and the
// chart are two separate `{% for %}` loops over the same variable
// (price_per_calorie.njk:39-44 and :60-63), so one can be right while the
// other is empty -- and the chart is the half nobody reads numbers off.
//
// Raw text rather than parsed numbers because the month is arithmetic done in
// the TEMPLATE (`{{ month.month - 1 }}`, JavaScript's 0-based Date months),
// and "-1" versus "0" is the difference between December of the previous year
// and January of this one.
function chartDates(html: string): string[] {
  return [...html.matchAll(/dates\.push\(new Date\(([^)]*)\)\);/g)].map((m) => m[1]!);
}

function chartValues(html: string): string[] {
  return [...html.matchAll(/values\.push\(([^)]*)\);/g)].map((m) => m[1]!);
}

// The one sentence of prose on the page, which is where five of the handler's
// eight lines end up. Extracted whole rather than probed with `toContain`, so
// that a missing variable shows as a visible gap in the sentence instead of
// passing a substring check on the half either side of it.
//
// WHITESPACE IS NOT NORMALISED HERE, unlike the chart helpers in the sibling
// suites. The paragraph is a single line in price_per_calorie.njk:30, so there
// is nothing to tidy -- and the DOUBLE SPACE that appears when
// first_month_name and first_month_year are both empty is the only visible
// trace of the two ternaries failing over. Collapsing runs of whitespace here
// would erase precisely the evidence these tests are looking for.
function intro(html: string): string {
  const match = /<p>(Give Food has been purchasing[\s\S]*?)<\/p>/.exec(html);
  if (!match) throw new Error("no intro paragraph in the rendered page");
  return match[1]!.trim();
}

// ===========================================================================
// the route
// ===========================================================================

describe("the route", () => {
  // index.ts:564's path, reached through the REAL router. A test that mounted
  // its own ad-hoc Hono route would pass with that line deleted, which is the
  // failure the sibling suite records as having shipped.
  it("answers GET /dashboard/price-per/calorie/ with the Price Per Calorie page", async () => {
    seedTheChart();

    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    // The template's own title and heading -- proof that
    // dash/price_per_calorie.njk rendered and not dash/price_per_kg.njk, which
    // is the same eight-line handler shape over the same two-query pattern and
    // would render without complaint from anything here.
    expect(html).toContain("<title>Price Per Calorie - Give Food</title>");
    expect(html).toContain("<h1>Price Per Calorie</h1>");
    expect(html).toContain('<div id="chart" style="height:500px"></div>');
    // The kg page's column heading, which this page must NOT have.
    expect(html).not.toContain("Price per kg");
  });

  // GET ONLY. index.ts:564 registers `app.get(...)` and nothing else, so Hono
  // answers anything else with a 404.
  //
  // A DIVERGENCE FROM DJANGO, and a harmless one: Django's view is a plain
  // function with no method guard, so a POST there rendered the same page with
  // a 200. Neither writes anything; what is asserted is that the port's answer
  // is a refusal reached WITHOUT running either query, so a POST flood cannot
  // buy two full scans of the two largest tables this site has.
  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses a %s, and runs no query on the way to refusing it", async (method) => {
    seedTheChart();

    const res = await get(PATH, method);

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // HEAD does reach the handler (Hono answers HEAD from the GET route), so
  // both queries run and the headers are the real ones -- with the body
  // stripped. Pinned because it is the shape a monitor uses, and because it
  // means a HEAD costs exactly what a GET costs.
  it("answers HEAD with the GET headers, an empty body, and both queries run", async () => {
    seedTheChart();

    const res = await get(PATH, "HEAD");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toBe("");
    expect(prepared).toHaveLength(2);
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block, entirely
  // outside i18n_patterns -- index.ts:542-544 says so, and registers the
  // dashboards with no locale loop. The visible half is the absence of
  // hreflang alternates (buildPageContext is called with no `locale`, so
  // `languages` is empty and page.njk emits nothing); the routing half is that
  // no /cy/ form of this URL exists at all.
  it("is English-only: no hreflang alternates, and no language-prefixed URL", async () => {
    seedTheChart();

    const res = await get(PATH);
    const html = await res.text();

    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).not.toContain("hreflang");
    expect(res.headers.get("Content-Language")).toBe("en");
    expect((await get(`/cy${PATH}`)).status).toBe(404);
    expect((await get(`/gd${PATH}`)).status).toBe(404);
  });

  // THE TRAILING SLASH COSTS A FULL RENDER AND TWO D1 READS. lib/appendSlash.ts
  // answers Django's APPEND_SLASH by re-entering the app with a HEAD request
  // for the slashed URL and redirecting if it does not 404 -- so
  // /dashboard/price-per/calorie runs this handler in full, scans `orderline`
  // AND `orders`, renders the whole document and throws the body away, all to
  // produce a 301 with no content. Pinned rather than fixed: it is how the
  // probe is documented to work, and it is the kind of cost that is invisible
  // in every metric except D1 rows read.
  it("301s a missing trailing slash, having really executed the handler to find out", async () => {
    seedTheChart();

    const res = await get("/dashboard/price-per/calorie");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
    expect(prepared).toHaveLength(2);
  });

  // The neighbouring dashboard, whose old URL gfdash/urls.py redirects. Not
  // this page's business except that /dashboard/price-per-kg/ and
  // /dashboard/price-per/kg/ and /dashboard/price-per/calorie/ are three
  // similar strings in one file, and a fat-fingered edit to any of them is a
  // 404 on a page linked from dash/index.njk.
  it("does not answer the kg page's URLs", async () => {
    expect((await get("/dashboard/price-per/calories/")).status).toBe(404);
    expect((await get("/dashboard/price-per-calorie/")).status).toBe(404);
  });
});

// ===========================================================================
// the chart and the table
// ===========================================================================

describe("the chart and the table", () => {
  beforeEach(seedTheChart);

  // THE PAGE'S PAYLOAD, in the half a reader can copy numbers out of. One row
  // per month, oldest first, price in pence for 2000 calories with the "p"
  // suffix the template appends.
  //
  // `2024-11`, not `2024-1`: the month is printed from the CAST INTEGER, so
  // eleven prints as "11" and January prints as "1" -- NOT "01". That is a
  // real difference from Django, whose `{{ month.month.month }}` over a
  // TruncMonth date object printed the same unpadded integer, so the port
  // matches; noted because "2024-1" looks like a bug and is not one.
  it("prints one table row per month, oldest first, priced in pence", async () => {
    expect(tableRows(await body(PATH))).toEqual(["2024-1|300p", "2024-2|250p", "2024-11|2571p"]);
  });

  // THE CHART, which is the artifact -- the table under it is the footnote.
  // Two independent `{% for %}` loops build these arrays, so they are asserted
  // separately from the table and from each other: a template edit that broke
  // only the series leaves a correctly-dated x-axis with no bars on it, and a
  // 200.
  //
  // THE MONTH IS ZERO-BASED HERE AND ONE-BASED IN THE TABLE, because
  // `new Date(2024, 0, 1)` is January. `{{ month.month - 1 }}` in the template
  // is the only place that conversion happens; drop it and every bar on this
  // chart moves one month to the right, and the December bar moves into the
  // next year.
  it("drives the echarts date and value arrays from the same months, in the same order", async () => {
    const html = await body(PATH);

    expect(chartDates(html)).toEqual(["2024, 0, 1", "2024, 1, 1", "2024, 10, 1"]);
    expect(chartValues(html)).toEqual(["300", "250", "2571"]);
  });

  // INTEGER DIVISION, PINNED, and faithful: Postgres divided two integer sums
  // at views.py:545 too (`Sum('line_cost') * 2000 / Sum('calories')`).
  // 900 * 2000 / 700 is 2571.43p and both engines chart 2571. The `/ 2000.0`
  // that would "fix" this is the most tempting edit in dashboards.ts, and it
  // would step every point of this published chart away from the number Django
  // published.
  it("truncates the price rather than rounding it", async () => {
    expect(tableRows(await body(PATH))[2]).toBe("2024-11|2571p");
  });

  // THE MONTH'S LINES ARE SUMMED BEFORE DIVIDING, which is the whole point of
  // the figure -- one big cheap line has to move the month more than one small
  // dear one. January's two lines are 100p/1000cal and 200p/1000cal; the ratio
  // of sums is 300, and the mean of the two per-line prices is also 300 here,
  // so the fixture is extended rather than trusted: a third, wildly cheaper
  // line makes the two disagree.
  it("sums the whole month's cost and calories before dividing, rather than averaging line prices", async () => {
    seedLine({ delivery_date: "2024-01-30", line_cost: 100, calories: 8000 });

    // (100+200+100) * 2000 / (1000+1000+8000) = 80. The mean of the three
    // per-line prices (200, 400, 25) is 208.
    expect(tableRows(await body(PATH))[0]).toBe("2024-1|80p");
  });

  // Named separately from the tests above so a failure says WHICH rule broke.
  // 2024-05, 2024-06 and the NULL-dated line hold nothing but the three
  // excluded rows, so their absence from the page is the whole assertion.
  it("never shows a month whose only lines are calorie-free or undated", async () => {
    const html = await body(PATH);

    expect(html).not.toContain("2024-5");
    expect(html).not.toContain("2024-6");
    expect(chartDates(html)).toEqual(["2024, 0, 1", "2024, 1, 1", "2024, 10, 1"]);
    // The excluded lines each cost 5000p; if any had leaked, its month's price
    // would be an order of magnitude above every real one on the chart.
    expect(chartValues(html)).not.toContain("14285");
  });

  // GROUP BY YEAR **AND** MONTH. Grouping by month alone folds January 2024
  // and January 2025 into one point and halves the length of the series -- a
  // chart that still draws, with a shorter x-axis nobody counts, and a
  // blended price nobody can reproduce.
  it("keeps the same month of two different years apart", async () => {
    seedLine({ delivery_date: "2025-01-15", line_cost: 900, calories: 1000 });

    const html = await body(PATH);

    expect(chartDates(html)).toEqual(["2024, 0, 1", "2024, 1, 1", "2024, 10, 1", "2025, 0, 1"]);
    expect(tableRows(html)).toEqual(["2024-1|300p", "2024-2|250p", "2024-11|2571p", "2025-1|1800p"]);
  });

  // THE X-AXIS ORDER IS THE QUERY'S ORDER -- price_per_calorie.njk has no sort
  // in it. Seeded deliberately out of insertion order and across a year
  // boundary, because the ORDER BY is over the CAST INTEGERs: ordering by the
  // raw strftime strings instead would still look right until a two-digit
  // month met a one-digit one.
  it("orders the series chronologically regardless of insertion order", async () => {
    db.prepare("DELETE FROM orderline").run();
    seedLine({ delivery_date: "2024-10-01", line_cost: 100, calories: 1000 });
    seedLine({ delivery_date: "2023-12-31", line_cost: 200, calories: 1000 });
    seedLine({ delivery_date: "2024-02-05", line_cost: 300, calories: 1000 });
    seedLine({ delivery_date: "2025-01-01", line_cost: 400, calories: 1000 });

    expect(tableRows(await body(PATH))).toEqual(["2023-12|400p", "2024-2|600p", "2024-10|200p", "2025-1|800p"]);
  });

  // An empty database is a 200 with an empty table and two empty arrays, not a
  // 404 and not a broken script. This is what a fresh environment looks like,
  // and `orders`/`orderline` are a one-time read-only snapshot
  // (0005_orders_and_charity.sql's header), so an environment loaded without
  // them renders THIS rather than 500ing. echarts draws an empty frame quite
  // happily; what it must not get is a syntax error, which is what a
  // half-emitted loop would produce.
  it("renders an empty chart rather than 404ing when there are no order lines", async () => {
    db.prepare("DELETE FROM orderline").run();

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(tableRows(html)).toEqual([]);
    expect(chartDates(html)).toEqual([]);
    expect(chartValues(html)).toEqual([]);
    // The rest of the page is untouched -- the empty case degrades the chart,
    // not the document.
    expect(html).toContain("<h1>Price Per Calorie</h1>");
  });
});

// ===========================================================================
// the intro sentence -- MONTH_NAMES and the three headline figures
// ===========================================================================

describe("the intro sentence", () => {
  // THE WHOLE SENTENCE, asserted as one string. Five of the handler's eight
  // lines feed this paragraph and every one of them can fail silently:
  // nunjucks prints undefined as the empty string on purpose
  // (packages/templates/src/env.ts sets throwOnUndefined: false), so a dropped
  // variable is a gap in a sentence rather than an error.
  //
  // 12,345 + 20 + 1,000 + 5 = 13,370 items and 900,000 + 1,000 + 2,000 + 100 =
  // 903,100 calories, both through the template's `|intcomma`; two food banks,
  // NOT comma'd, matching Django's `{{ number_foodbanks }}`.
  //
  // The apostrophe in "we've" stays a LITERAL apostrophe, not `&#39;`: it is
  // template text rather than a variable, and packages/templates'
  // autoescapeExtension only escapes what comes out of `{{ }}`. Asserted as
  // part of the whole string because an autoescape change that started
  // escaping literals would be visible on every page of the site and is
  // exactly the kind of thing a byte-for-byte sentence catches.
  it("names the first month, and prints the three totals from the orders table", async () => {
    seedTheChart();

    expect(intro(await body(PATH))).toBe(
      "Give Food has been purchasing food for food banks since January 2024, this is the price we've paid " +
        "per calorie of the food requested by them over time. Our data covers 13,370 items bought providing " +
        "903,100 calories and delivered to 2 different food banks around the UK.",
    );
  });

  // MONTH_NAMES, ALL TWELVE, one render each. This array is a hand-copied
  // table with exactly one reader, indexed `month - 1`, and every plausible
  // way it goes wrong -- off by one in either direction, two entries
  // transposed, "Sept" for "September" -- produces a page that is correct in
  // every other respect. Nothing else in the stack reads it, so nothing else
  // can notice.
  //
  // The month is the FIRST row of the series, which is the only row this
  // lookup ever sees: `months[0]`, and the query's ORDER BY makes that the
  // oldest.
  it.each([
    [1, "January"],
    [2, "February"],
    [3, "March"],
    [4, "April"],
    [5, "May"],
    [6, "June"],
    [7, "July"],
    [8, "August"],
    [9, "September"],
    [10, "October"],
    [11, "November"],
    [12, "December"],
  ])("renders month %i of the first row as %s", async (month, name) => {
    seedLine({ delivery_date: `2021-${String(month).padStart(2, "0")}-15` });
    // A LATER month too, so "the first row" is a real choice rather than the
    // only row -- a lookup that read months[months.length - 1] would pass
    // twelve single-row tests in a row.
    seedLine({ delivery_date: "2022-12-25" });

    expect(await body(PATH)).toContain(`since ${name} 2021, this is the price`);
  });

  // NO MONTHS AT ALL. Both ternaries fall to `""`, and the sentence renders
  // with a two-space hole where the date should be: "since  , this is". That
  // is what the code does, and it is better than the alternative -- the raw
  // `undefined` the ternaries exist to prevent would print identically here
  // but would make `months[0].year` a TypeError the day someone reached for a
  // second field. Pinned so the ternaries cannot be "simplified" away
  // unnoticed.
  it("leaves a blank where the first month would be when there is nothing to chart", async () => {
    seedOrder({ foodbank_id: 1, no_items: 5, calories: 50 });

    expect(intro(await body(PATH))).toContain("food banks since  , this is the price");
  });

  // THE TWO TABLES ARE INDEPENDENT, and this is the test that says so. The
  // chart comes from `orderline`; the three figures come from `orders`. Order
  // lines with no matching order row is not a hypothetical -- these tables are
  // a one-time snapshot loaded by tools/pg-to-d1 with no foreign keys
  // (PLAN.md §4.5) -- and the page shows a full chart above a sentence
  // claiming zero items, zero calories and zero food banks.
  //
  // The zeros rather than the word "null" are getOrderCalorieTotals' `?? 0`
  // fallbacks: SUM over no rows is NULL in SQLite, and `{{ null|intcomma }}`
  // would print "null" into the middle of an English sentence.
  it("prints zeros, not nulls, when there are order lines but no orders", async () => {
    seedLine({ delivery_date: "2024-03-01", line_cost: 100, calories: 1000 });

    const html = await body(PATH);

    expect(intro(html)).toContain("since March 2024, this is the price");
    expect(intro(html)).toContain("covers 0 items bought providing 0 calories and delivered to 0 different food banks");
    expect(tableRows(html)).toEqual(["2024-3|200p"]);
  });

  // SUSPECT, PINNED AS-IS. COUNT(DISTINCT foodbank_id) skips NULLs; Django's
  // `Order.objects.values('foodbank').distinct().count()` (views.py:550)
  // treated NULL as a group of its own and counted it, so an order with no
  // food bank attached moved this figure by one there and moves it by nothing
  // here. Both numbers are defensible; they are not the same number, and the
  // page says "delivered to N food banks". Already recorded at the db layer
  // (packages/db/src/dashboards.test.ts); asserted again HERE because this is
  // the sentence a reader actually sees.
  it("does not count orphan orders towards the food bank tally, unlike Django", async () => {
    seedOrder({ foodbank_id: 42, no_items: 1, calories: 1 });
    seedOrder({ foodbank_id: null, no_items: 1, calories: 1 });
    seedOrder({ foodbank_id: null, no_items: 1, calories: 1 });

    // Their items and calories DO count -- only the food bank tally skips
    // them, which is why this is a divergence rather than a filter.
    expect(intro(await body(PATH))).toContain("covers 3 items bought providing 3 calories and delivered to 1 different food banks");
  });

  // `|intcomma` is applied to the two big numbers and NOT to the food bank
  // count, exactly as Django's template did (price_per_calorie.html:31). A
  // stray `|intcomma` on the third would print "1,234 different food banks",
  // which is not wrong so much as inconsistent with every other dashboard --
  // and its absence is invisible until the site has passed a thousand of
  // anything.
  it("comma-groups the items and calories but not the food bank count", async () => {
    for (let i = 1; i <= 1234; i += 1) seedOrder({ foodbank_id: i, no_items: 1000, calories: 1000 });

    // 1234 orders x 1000 = 1,234,000 of each, over 1234 distinct food banks.
    expect(intro(await body(PATH))).toContain(
      "covers 1,234,000 items bought providing 1,234,000 calories and delivered to 1234 different food banks",
    );
  });
});

// ===========================================================================
// the months the SQL cannot name
// ===========================================================================

describe("the months the SQL cannot name", () => {
  // SUSPECT, PINNED AS-IS, AND THE WORST FAILURE MODE THIS PAGE HAS.
  //
  // Postgres held `delivery_date` as a real date, so TruncMonth could never
  // fail to produce one. D1 holds it as TEXT, and strftime() returns NULL for
  // anything it cannot parse; `delivery_date IS NOT NULL` catches the NULL
  // column but not a non-NULL string that is not a date. CAST(NULL AS INTEGER)
  // is NULL, NULL sorts FIRST in SQLite's ascending order, so such a row
  // arrives as months[0] and takes the intro sentence's date with it.
  //
  // The chart is worse than wrong: the template emits
  // `dates.push(new Date(, -1, 1));` -- an empty first argument, because
  // nunjucks prints NULL as "" while `{{ month.month - 1 }}` evaluates
  // `null - 1` to -1. That is a JavaScript SYNTAX ERROR, so the whole
  // <script> block fails to parse and NO chart is drawn at all, on an HTTP
  // 200 with no log line anywhere.
  //
  // Contrived -- migration 0022 normalised the stored timestamps, and this
  // snapshot came from a Postgres date column -- but the tables are loaded by
  // an external script with no schema constraint on the text, and nothing
  // between that script and this page would notice. Reported in suspectedBugs
  // rather than fixed: pinning what the code does is the point.
  it("emits a syntactically broken chart script for an unparseable delivery_date", async () => {
    seedLine({ delivery_date: "2024-07-05", line_cost: 100, calories: 1000 });
    seedLine({ delivery_date: "not a date at all", line_cost: 300, calories: 1000 });

    const html = await body(PATH);

    expect(chartDates(html)).toEqual([", -1, 1", "2024, 6, 1"]);
    expect(chartValues(html)).toEqual(["600", "200"]);
    // ...and the sentence loses its date, because MONTH_NAMES[null - 1] is
    // MONTH_NAMES[-1], which is undefined, which nunjucks prints as "".
    expect(intro(html)).toContain("food banks since  , this is the price");
    // The table shows the row with both cells empty but the price intact --
    // the one place on the page the corrupt group is legible at all.
    expect(tableRows(html)).toEqual(["-|600p", "2024-7|200p"]);
  });

  // THE OTHER SHAPE, and the reassuring one: a full ISO-8601 timestamp --
  // what `toISOString()` writes, and what any TypeScript-era writer would
  // naturally produce into a column Django wrote as a bare "YYYY-MM-DD" --
  // IS parsed by strftime, so such a row groups into its real month and merges
  // with its Django-shaped neighbours rather than forming a second bar or
  // falling into the NULL bucket above.
  it("still groups a legacy toISOString() delivery_date into its real month", async () => {
    seedLine({ delivery_date: "2024-08-05", line_cost: 100, calories: 1000 });
    seedLine({ delivery_date: "2024-08-06T09:30:00.000Z", line_cost: 300, calories: 1000 });

    const html = await body(PATH);

    expect(chartDates(html)).toEqual(["2024, 7, 1"]);
    expect(tableRows(html)).toEqual(["2024-8|400p"]);
    expect(intro(html)).toContain("since August 2024, this is the price");
  });
});

// ===========================================================================
// what the request costs
// ===========================================================================

describe("what the request costs", () => {
  beforeEach(seedTheChart);

  // TWO statements, both READS, over ONE session, in this order. Both are
  // unindexed aggregates over the two largest tables on the site and D1 meters
  // rows read, so a third query -- the shape a careless "let me also show the
  // average" edit takes -- is a real cost with nothing on the page to show for
  // it. The exact SQL is pinned because these two strings are what actually
  // reach the engine, and because a `SELECT *` the handler then aggregates in
  // JavaScript would render identically while pulling both whole tables across
  // the D1 wire.
  it("issues exactly two statements, both reads, over exactly one D1 session", async () => {
    const before = {
      orders: (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n,
      lines: (db.prepare("SELECT COUNT(*) AS n FROM orderline").get() as { n: number }).n,
    };

    await get(PATH);

    expect(prepared).toEqual([
      "SELECT CAST(strftime('%Y', delivery_date) AS INTEGER) AS year, " +
        "CAST(strftime('%m', delivery_date) AS INTEGER) AS month, " +
        "(SUM(line_cost) * 2000) / SUM(calories) AS price " +
        "FROM orderline WHERE calories > 0 AND delivery_date IS NOT NULL " +
        "GROUP BY year, month ORDER BY year, month",
      "SELECT SUM(no_items) AS items, SUM(calories) AS calories, COUNT(DISTINCT foodbank_id) AS number_foodbanks FROM orders",
    ]);
    for (const sql of prepared) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
    // No bound parameters at all: both statements are fixed strings, so there
    // is nothing on this page a query string could reach.
    expect(bound).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n).toBe(before.orders);
    expect((db.prepare("SELECT COUNT(*) AS n FROM orderline").get() as { n: number }).n).toBe(before.lines);
    // lib/session.ts's mode, and ONE session for both queries -- which is what
    // makes them a consistent pair rather than two reads that could land
    // either side of a write. "first-primary" would work and would silently
    // give up read-replica eligibility on a page with no consistency
    // requirement whatsoever.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // Two views in a row must be identical and must still be two statements
  // each. This is the assertion a "let me cache the answer in a table" change
  // trips over, and it is also what says the page is safe to reload -- which
  // is what an operator watching a price index actually does.
  it("is idempotent across repeated views", async () => {
    const first = await body(PATH);
    prepared = [];
    const second = await body(PATH);

    expect(tableRows(second)).toEqual(tableRows(first));
    expect(chartValues(second)).toEqual(chartValues(first));
    expect(intro(second)).toBe(intro(first));
    expect(prepared).toHaveLength(2);
  });

  // NOTHING IN THE URL REACHES EITHER QUERY. The handler takes no parameters
  // at all, so a query string is inert -- asserted because "let me make this
  // page filterable" is the obliging edit that would put user input into a
  // statement, and because the sibling getDeliveryMonthCounts already builds
  // its SQL by interpolation (from an allowlist, which is the only reason that
  // is safe).
  it("ignores a query string entirely", async () => {
    const html = await body(`${PATH}?year=2024&calories=0&limit=100000`);

    expect(tableRows(html)).toEqual(["2024-1|300p", "2024-2|250p", "2024-11|2571p"]);
    expect(prepared).toHaveLength(2);
    expect(bound).toEqual([]);
  });

  // The generated SQL must not reach the page. Django's price_per_kg sibling
  // put its assembled statement into template_vars and never printed it;
  // nothing here does, and this is a PUBLIC page, so the day someone adds a
  // debug variable "for parity" and a template edit prints it, the site
  // publishes its own schema.
  it("does not leak its SQL or its table names into the public page", async () => {
    const html = await body(PATH);

    expect(html).not.toContain("strftime");
    expect(html).not.toContain("FROM orderline");
    expect(html).not.toContain("SELECT ");
  });
});

// ===========================================================================
// caching
// ===========================================================================

describe("caching", () => {
  beforeEach(seedTheChart);

  // A DIVERGENCE FROM DJANGO, PINNED. gfdash/views.py:531 decorates this view
  // `@cache_page(SECONDS_IN_HOUR)`; the port gives it a DAY, because
  // /dashboard/... matches no rule in middleware/pageCacheControl.ts and falls
  // through to that file's SECONDS_IN_DAY default. Harmless in itself -- the
  // underlying `orders`/`orderline` snapshot is loaded by hand and changes
  // roughly never (0005_orders_and_charity.sql's header) -- but it is a
  // 24x difference nothing else records, and the day the Orders admin screens
  // land in Phase 6 and this data starts moving, an hour and a day stop being
  // interchangeable. The 300-second browser max-age is pageCacheControl's own
  // documented divergence (a browser cache cannot be purged).
  it("gets a day of shared cache where Django gave it an hour", async () => {
    expect((await get(PATH)).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // No Cache-Tag, so nothing can purge this page: it goes stale for up to a
  // day. middleware/cacheTag.ts's AGGREGATE_PATHS covers the home page, the
  // sitemaps, the feeds and the API list endpoints, and no dashboard is in it.
  // That matches Django, which cached the page with no invalidation at all, so
  // it is ported behaviour rather than a regression -- pinned so a future
  // purge-list change has something to fail against.
  it("carries no cache tag, so nothing can purge it early", async () => {
    expect((await get(PATH)).headers.get("Cache-Tag")).toBeNull();
  });
});

// ===========================================================================
// the shared page context
// ===========================================================================

describe("the shared page context", () => {
  beforeEach(seedTheChart);

  // buildPageContext({ path: c.req.path }) -- what this module supplies is
  // c.req.PATH, and this is the test that says so. THE MUTANT IT KILLS is
  // `path: c.req.url`, a one-word edit that produces a page which looks
  // completely normal and emits a canonical with a doubled origin and a
  // separate URL for every tracking parameter anyone ever appends.
  it("declares itself canonical at its own path, with the query string dropped", async () => {
    expect(await body(PATH)).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
    expect(await body(`${PATH}?utm_source=newsletter`)).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
  });

  // The debug comment's "Took Nms" is elapsedMs(c), read off the timestamp
  // middleware/serverTiming.ts stored. WHOLE MILLISECONDS, deliberately not
  // Django's three decimals (performance.now() only advances at I/O boundaries
  // on Workers, so the fraction was always exactly ".000"). The failure this
  // catches is the string "NaN": elapsedMs subtracts an unset context variable
  // if the handler is ever reached without serverTiming in front of it.
  it("reports a whole-millisecond render time in the debug comment", async () => {
    const html = await body(PATH);

    expect(html).toMatch(/⏱️ Took \d+ms\n/);
    expect(html).not.toMatch(/⏱️ Took [\d.]*\.\d+ms/);
  });

  // The Server-Timing header keeps its decimals -- the same divergence, the
  // other way round, and the pair only makes sense asserted together.
  it("keeps the fractional render duration in the Server-Timing header", async () => {
    expect((await get(PATH)).headers.get("Server-Timing")).toMatch(/^render;dur=\d+\.\d{3}$/);
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

  // The breadcrumb and logo hrefs come from @givefood/urls' reverse table
  // (`url('index')`, `url('dash:index')`, `url('dash:price_per_calorie')`),
  // which is how Django's own template built them. If that table moved, the
  // page would still render with a 200 and every link on it would point at a
  // 404 -- and the self-referencing third crumb is the one that would say so.
  it("builds its breadcrumbs from the reverse-URL table", async () => {
    const html = await body(PATH);

    expect(html).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
    expect(html).toContain(`<li class="is-active"><a href="${PATH}" aria-current="page">Price Per Calorie</a></li>`);
  });
});

// ===========================================================================
// when a query fails
// ===========================================================================

describe("when a query fails", () => {
  // A session that serves one of the two queries for real from the fixture and
  // fails the other. `all()` is the months query over `orderline` and
  // `first()` is the totals query over `orders`, so failing exactly one of
  // them is the difference between "D1 was down" and "D1 answered, halfway".
  //
  // BOTH HALVES HAVE TO FAIL THE SAME WAY, and a shim that breaks everything
  // cannot show that. A `.catch(() => [])` added to the months call -- the
  // single most plausible "let me make this page robust" edit -- still 500s
  // under a fully-broken binding, because the SECOND query then throws too.
  // It only becomes visible when the second query works. (Measured: with a
  // fully-broken binding that mutant survived the run.)
  function halfBrokenEnv(fail: "months" | "totals"): AppEnv["Bindings"] {
    const real = d1Session(db, prepared, bound);
    const boom = async () => {
      throw new Error("D1_ERROR: Network connection lost");
    };
    return {
      ...env(),
      DB: {
        withSession: (mode: string) => {
          sessionModes.push(mode);
          return {
            prepare: (sql: string) => {
              const statement = real.prepare(sql) as { all: () => unknown; first: () => unknown };
              return {
                ...statement,
                all: fail === "months" ? boom : () => statement.all(),
                first: fail === "totals" ? boom : () => statement.first(),
              };
            },
          };
        },
      },
    } as unknown as AppEnv["Bindings"];
  }

  // The handler has no try/catch, which is the right call and is worth pinning
  // as such. The defensive-looking alternative -- catching and rendering with
  // `months: []` -- would publish a page saying Give Food has bought nothing,
  // ever, when what actually happened is that D1 was unavailable. An empty
  // chart on a data page is a claim, and a false one is worse than an error
  // page, because nobody investigates a claim.
  it("serves the real 500 page when the months query fails, not an empty chart", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedTheChart();

    const res = await app.fetch(new Request(`${ORIGIN}${PATH}`), halfBrokenEnv("months"), execCtx);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("<h1>500 - Internal Server Error</h1>");
    // Not a partial page, and specifically not an EMPTY chart: neither the
    // chart's container nor the intro sentence's zeros may appear.
    expect(html).not.toContain('<div id="chart"');
    expect(html).not.toContain("Give Food has been purchasing food");
  });

  // THE SECOND QUERY IS THE OTHER INTERESTING ONE, because it is awaited AFTER
  // the first has already succeeded. Nothing in the handler is transactional
  // and nothing streams, so a totals failure has to lose the whole page rather
  // than publish a real chart above a sentence with three holes in it.
  it("serves the real 500 page when only the totals query fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedTheChart();

    const res = await app.fetch(new Request(`${ORIGIN}${PATH}`), halfBrokenEnv("totals"), execCtx);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("<h1>500 - Internal Server Error</h1>");
    expect(html).not.toContain("Give Food has been purchasing food");
    // The first query really did run, so this is the after-a-success path and
    // not a shortcut through the same failure as the test above.
    expect(prepared).toHaveLength(2);
  });

  // Total failure -- the whole binding unreachable, which is what a D1 outage
  // actually looks like from a Worker. Kept alongside the two half-failures
  // because it is the only one of the three that a real incident produces, and
  // because it proves the 500 page itself does not need the database.
  it("serves the real 500 page when the whole binding is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dead = {
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

    const res = await app.fetch(new Request(`${ORIGIN}${PATH}`), dead, execCtx);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("<h1>500 - Internal Server Error</h1>");
    expect(html).not.toContain('<div id="chart"');
  });
});
