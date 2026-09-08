import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/pricePerKg.ts -- GET /dashboard/price-per/kg/, the public
// "Price Per Kg" chart. Ported from gfdash/views.py:449-464
// (`@cache_page(SECONDS_IN_HOUR) def price_per_kg`), registered at
// gfdash/urls.py:25 as `path("price-per/kg/", price_per_kg, name="price_per_kg")`.
//
// WHY THIS FILE EXISTS. The handler is nine lines with two ternaries and no
// error path, so nothing in it can throw -- and every way it can be wrong
// renders a plausible-looking page with a 200:
//
//   * IT IS A COPY OF ITS NEIGHBOUR. pricePerCalorie.ts is the same nine lines
//     with the same MONTH_NAMES array against getPricePerCalorieByMonth /
//     getOrderCalorieTotals, and the two files differ only in the two queries,
//     one context key and the template name. Pointed at the calorie query this
//     page still renders a chart, a table and a headline sentence -- over
//     `orderline` instead of `orders`, with prices two orders of magnitude out
//     and NOBODY able to tell from the shape of the page. The exact-SQL
//     assertions plus the rendered numbers are what catch it.
//   * THE HEADLINE SENTENCE IS ASSEMBLED HERE, not in the template. Django's
//     template did the month-name lookup itself
//     (`{{ months.0.month|date:"F" }}`, over a TruncMonth date object); this
//     port's rows carry a plain 1-12 integer, so MONTH_NAMES and the
//     `month - 1` index live in this file and exist nowhere else. An
//     off-by-one there prints "since January 2024" for a December start, or
//     prints nothing at all, on a sentence that is the page's whole claim
//     about how long Give Food has been buying food.
//   * `months[0]` IS ONLY THE EARLIEST MONTH BECAUSE OF AN ORDER BY IN
//     packages/db. SQLite answers `GROUP BY year, month` through a temp b-tree
//     keyed on the group columns, so rows come back in year/month order whether
//     or not the query asks -- a fixture inserted oldest-first cannot see the
//     clause at all. The one below inserts in a deliberately scrambled order
//     and straddles a year boundary, which is the case an `ORDER BY month`
//     that forgot the year gets wrong.
//   * THE TWO HALVES OF THE PAGE COME FROM DIFFERENT LOOPS over the same list:
//     a <table> of "year-month" / "Np" cells, and a pair of JavaScript arrays
//     (`dates` and `values`) built by a second `{% for %}`. They can disagree
//     -- and in one real case below they do, because a null price emits
//     `values.push();`, which pushes nothing and slides every later bar onto
//     the wrong month.
//
// REAL EVERYTHING, the harness the sibling dashboard suites use: the real
// production app (workers/site/src/index.ts's default export), so the route
// registration, appendSlash, pageCacheControl and cacheTag are the shipped
// articles rather than a hand-built router; the real Nunjucks templates through
// the real render(); the real getPricePerKgByMonth/getOrderWeightTotals; and
// real in-memory SQLite built by schemaFor() from the real migrations, so
// `orders`' columns are the shipped ones (the table is named `orders`, not
// Django's `order` -- migration 0005_orders_and_charity.sql:11 renamed it away
// from the SQL reserved word) rather than this author's memory of them. Mocked:
// the two KV namespaces, because there is no local double and nothing on this
// path touches them.
//
// MUTATION-TESTED in a copy of the whole tree in the scratchpad OUTSIDE the
// repo -- see the list at the foot of this file.

const ORIGIN = "https://www.givefood.org.uk";
// Hardcoded rather than imported from @givefood/urls, so the string here and
// the string in index.ts:562 are two independent copies: a rename that updated
// only one of them is what this is guarding. Django spells the URL with a slash
// between "price-per" and "kg" and its reverse name with underscores, which is
// why both spellings appear in this file.
const PATH = "/dashboard/price-per/kg/";
// gfdash/urls.py:29's RedirectView for the older spelling of the URL above,
// ported at index.ts:567. It exists only to reach that URL, so it is asserted
// here rather than in a file of its own.
const LEGACY_PATH = "/dashboard/price-per-kg/";

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite. Records
// the SQL prepared and anything bound to it: this page's whole cost story is
// "two parameterless reads per view", and a rendered chart looks identical
// whether it took two statements or six.
function d1Session(db: DatabaseSync, prepared: string[], bound: Bindable[][]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => {
      bound.push(next as Bindable[]);
      return statement(sql, next as Bindable[]);
    },
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    // Present rather than omitted: the test that says this GET writes nothing
    // must not be leaning on writes being impossible in the fixture.
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

// The one table both statements name. From the real migrations via schemaFor()
// rather than hand-written DDL -- github #51 is the record of eight suites
// breaking at once on hand-built fixtures when a shared query started reading
// an object they did not have.
const SCHEMA = schemaFor("orders");

// The exact statements the two queries prepare, in the order the handler runs
// them (packages/db/src/dashboards.ts:387 then :351). Written out in full
// because the copy-of-its-neighbour failure described at the top of this file
// swaps `orders` for `orderline` and `weight` for `calories` and still renders
// a 200 -- and because the `/ 1000000.0` in the second one, with the decimal
// point, is the difference between a tonnage and a whole number of tonnes.
const SQL_MONTHS =
  "SELECT CAST(strftime('%Y', delivery_datetime) AS INTEGER) AS year, " +
  "CAST(strftime('%m', delivery_datetime) AS INTEGER) AS month, " +
  "(SUM(cost) * 1000) / SUM(weight) AS price " +
  "FROM orders GROUP BY year, month ORDER BY year, month";
const SQL_TOTALS =
  "SELECT SUM(no_items) AS items, SUM(weight) / 1000000.0 AS weight_tonnes, COUNT(DISTINCT foodbank_id) AS number_foodbanks FROM orders";

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
      // D1 read replica, and ONE entry per request is how the tests below know
      // the handler opened one session and ran both queries inside it rather
      // than opening a second.
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
// Seeds
// ---------------------------------------------------------------------------

// Every column `orders` declares NOT NULL is supplied, so a seeded row is one
// production would have accepted. `created`/`modified`/`delivery_datetime` are
// in DJANGO'S shape ("YYYY-MM-DD HH:MM:SS.ffffff", what str(datetime) produces
// and what the pg-to-D1 extract wrote) rather than toISOString()'s -- these are
// TEXT columns compared and formatted lexically, and delivery_datetime is the
// one strftime() reads, so a fixture in the wrong shape would silently test a
// different parser path from production.
function seedOrder(row: Record<string, Bindable> = {}): void {
  const n = (nextId += 1);
  const full: Record<string, Bindable> = {
    id: n,
    order_id: `GF-${n}`,
    items_text: "Baked Beans x 10",
    country: "England",
    created: "2024-01-01 12:00:00.000000",
    modified: "2024-01-01 12:00:00.000000",
    delivery_date: "2024-01-10",
    delivery_hour: 9,
    delivery_datetime: "2024-01-10 09:00:00.000000",
    weight: 1_000_000,
    calories: 1_000_000,
    cost: 1_000_000,
    no_lines: 1,
    no_items: 10,
    foodbank_id: 1,
    ...row,
  };
  const columns = Object.keys(full);
  db.prepare(`INSERT INTO orders (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((c) => full[c] as Bindable),
  );
}

// THE FIXTURE IS THE TEST. Five orders, chosen so that every arithmetic and
// ordering rule on the page produces a DIFFERENT number under the obvious wrong
// implementation rather than the same one:
//
//   INSERTED SCRAMBLED, oldest fourth. `months[0]` drives the "purchasing food
//   since ..." sentence, and insertion order is what a lost ORDER BY falls back
//   to often enough to matter.
//
//   DECEMBER 2023 IS THE EARLIEST, and December is the LAST entry of
//   MONTH_NAMES. An off-by-one index (`[month]` rather than `[month - 1]`)
//   reads past the end and renders an empty month name; month 1 is covered
//   separately below for the other end of the array.
//
//   IT STRADDLES A YEAR BOUNDARY, 2023-12 to 2024-12. `ORDER BY month` without
//   the year -- the natural way to mis-transcribe Django's `.order_by('month')`
//   over a TruncMonth date -- puts January 2024 first and dates the charity's
//   food buying a year late.
//
//   DECEMBER APPEARS IN BOTH YEARS. `GROUP BY month` alone folds them into one
//   point of 1500p/kg and shortens the series to three, which is a chart that
//   still draws.
//
//   JANUARY 2024 HAS TWO ORDERS WITH DIFFERENT PRICES PER KILO -- a cheap
//   333p/kg pallet and a dear 1000p/kg delivery. The ratio of sums is 400p/kg;
//   the mean of the two prices is 666p/kg. Weighting is the whole point of the
//   figure, and `AVG((cost * 1000) / weight)` is the natural wrong way to write
//   it, so the two must not agree.
//
//   MARCH 2024 DIVIDES UNEVENLY, 3000000*1000/7000000 = 428.57p, so the
//   truncation Django's Postgres integer division also did is visible.
//
//   ONE ORDER HAS NO FOOD BANK. Its items and weight count toward the headline
//   totals; it must NOT count toward "delivered to N different food banks",
//   because COUNT(DISTINCT foodbank_id) skips NULLs. Without it the fixture has
//   COUNT(*) = COUNT(foodbank_id) = COUNT(DISTINCT foodbank_id) for nothing,
//   and both the DISTINCT and the NULL-skipping are unmeasured.
function seed(): void {
  // 2024-01, dear: 1000p/kg on its own.
  seedOrder({ delivery_datetime: "2024-01-08 09:00:00.000000", cost: 1_000_000, weight: 1_000_000, no_items: 20, foodbank_id: 1 });
  // 2024-01, cheap and heavy: 333p/kg on its own, and nine times the weight.
  seedOrder({ delivery_datetime: "2024-01-20 09:00:00.000000", cost: 3_000_000, weight: 9_000_000, no_items: 30, foodbank_id: 2 });
  // 2024-12, the second December.
  seedOrder({ delivery_datetime: "2024-12-05 09:00:00.000000", cost: 2_000_000, weight: 1_000_000, no_items: 50, foodbank_id: 3 });
  // 2023-12, the earliest month and the one the headline sentence names.
  seedOrder({ delivery_datetime: "2023-12-05 09:00:00.000000", cost: 1_000_000, weight: 1_000_000, no_items: 10, foodbank_id: 1 });
  // 2024-03, unevenly divided, and attached to no food bank at all.
  seedOrder({ delivery_datetime: "2024-03-11 09:00:00.000000", cost: 3_000_000, weight: 7_000_000, no_items: 40, foodbank_id: null });
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

// ---------------------------------------------------------------------------
// Reading the rendered page
// ---------------------------------------------------------------------------

// The <table> under the chart, as "year-month|price" pairs in document order.
// Parsed rather than matched as a slab of markup, so the claims stay on the
// DATA while still pinning the order and the exact strings. The header row is
// <th>, so it cannot match.
function tableRows(html: string): string[] {
  const table = /<table[\s\S]*?<\/table>/.exec(html);
  if (!table) throw new Error("no <table> in the rendered page");
  return [...table[0].matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/g)].map((m) => `${m[1]}|${m[2]}`);
}

// Every `dates.push(...)` / `values.push(...)` statement the template emitted,
// as raw source text in document order.
//
// RAW TEXT, NOT PARSED VALUES, and both arrays in ONE list rather than two.
// The template builds the chart with two interleaved pushes per month and
// echarts pairs them BY INDEX (`dates.map((date, index) => [date, values[index]])`),
// so the pairing is the meaning: a `values.push()` that pushes nothing -- which
// is exactly what a null price produces, see the test below -- leaves every
// later bar on the wrong month, and no assertion that reads the two arrays
// separately can see it. Reading the source text is also the only way to see
// `new Date(, -1, 1)`, which is a syntax error rather than a value.
function chartPushes(html: string): string[] {
  const block = /var values = \[\];([\s\S]*?)var option = \{/.exec(html);
  if (!block) throw new Error("no chart data block in the rendered page");
  return [...(block[1] as string).matchAll(/\w+\.push\([^;]*\);/g)].map((m) => m[0]);
}

// The one-sentence headline above the chart, which is where first_month_name,
// first_month_year, items, weight_tonnes and number_foodbanks all surface --
// five of this handler's eight context keys, none of them visible anywhere else
// on the page.
function intro(html: string): string {
  const match = /<p>(Give Food has been purchasing[\s\S]*?)<\/p>/.exec(html);
  if (!match) throw new Error("no headline paragraph in the rendered page");
  return match[1] as string;
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

describe("the route", () => {
  // gfdash/urls.py's path, reached through the REAL router. A suite that
  // mounted its own ad-hoc Hono route would pass with index.ts:562 deleted --
  // routes/admin/dupePostcodes.test.ts records the sibling case where a link
  // shipped in a template 404ed because no route was registered.
  //
  // The title and <h1> are asserted because twenty dashboards share this
  // handler's shape and the template name is a string literal: pointed at
  // dash/price_per_calorie.njk the page still renders, because that template
  // reads `months`, `items` and `number_foodbanks` under the same names.
  it("answers GET /dashboard/price-per/kg/ with the price-per-kg page", async () => {
    seed();

    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Price Per Kg - Give Food</title>");
    expect(html).toContain("<h1>Price Per Kg</h1>");
    expect(html).toContain('<div id="chart" style="height:500px"></div>');
    // The y-axis label is the cheapest available proof that THIS template
    // rendered and not the calorie sibling, whose axis says "Price per calorie
    // (pence)".
    expect(html).toContain("name: 'Price per Kg (pence)'");
  });

  // BOTH SCRIPTS, OR NO CHART. `gfChartColors` from chart-colors.js is
  // referenced by the inline config as `color: gfChartColors`; drop that tag
  // and echarts throws a ReferenceError in the browser, leaving an empty div
  // on a page that is perfect as far as the server is concerned. Nothing
  // server-side can notice, which is why it is asserted here.
  it("loads echarts and the shared colour palette the inline config references", async () => {
    seed();
    const html = await body(PATH);

    expect(html).toMatch(/<script src="\/static\/js\/echarts\.js\?v=[^"]*"><\/script>/);
    expect(html).toMatch(/<script src="\/static\/js\/chart-colors\.js\?v=[^"]*"><\/script>/);
    expect(html).toContain("color: gfChartColors");
  });

  // GET ONLY. index.ts:562 registers app.get() and nothing else.
  //
  // A DIVERGENCE FROM DJANGO, and a harmless one: Django's view is a plain
  // function with no method guard, so a POST there rendered the same page with
  // a 200. What matters is that the port's refusal is reached WITHOUT running
  // either query -- so a POST flood cannot buy repeated full-table aggregates
  // of `orders`. This repo has already shipped a GET route able to run an
  // UPDATE, which is why the method registration is asserted rather than
  // assumed.
  it("refuses a POST, and runs no query on the way to refusing it", async () => {
    seed();

    const res = await get(PATH, { method: "POST" });

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
    expect(sessionModes).toEqual([]);
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block, entirely
  // outside i18n_patterns, and index.ts:542-567 registers the dashboards with
  // no locale loop. The visible half is the absence of hreflang alternates
  // (pageContext() calls buildPageContext with no `locale`, which is what
  // leaves `languages` empty); the routing half is that no /cy/ form of this
  // URL exists at all. A route registered inside the LOCALES loop by mistake
  // would 200 on the Welsh URL.
  it("is English-only: no hreflang alternates, and no language-prefixed URL", async () => {
    seed();

    const res = await get(PATH);
    const html = await res.text();

    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).not.toContain("hreflang");
    expect(res.headers.get("Content-Language")).toBe("en");
    expect((await get(`/cy${PATH}`)).status).toBe(404);
  });

  // Even asking in Welsh. resolveLanguage reads Accept-Language for the routes
  // that are translated; this one is not, so the header must not change the
  // response -- a page whose numbers are the same in every language but whose
  // <html lang> was not would be a quiet accessibility defect.
  it("ignores Accept-Language entirely", async () => {
    seed();

    const res = await get(PATH, { headers: { "Accept-Language": "cy" } });

    expect(res.headers.get("Content-Language")).toBe("en");
    expect(await res.text()).toContain('<html lang="en" dir="ltr"');
  });

  // Django's APPEND_SLASH, via lib/appendSlash.ts, which answers it by
  // re-entering the app with a HEAD request for the slashed URL and redirecting
  // if that does not 404. So /dashboard/price-per/kg runs this handler in full
  // -- BOTH statements, the whole document rendered and thrown away -- to
  // produce a 301 with no body. Pinned rather than filed: it is how the probe
  // is documented to work, and it is the kind of cost that shows up in no
  // metric except D1 rows read.
  it("301s a missing trailing slash, having really executed the handler to find out", async () => {
    seed();

    const res = await get("/dashboard/price-per/kg");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
    expect(prepared).toEqual([SQL_MONTHS, SQL_TOTALS]);
  });

  // gfdash/urls.py:29's `RedirectView.as_view(url='/dashboard/price-per/kg/',
  // permanent=True)` for the old spelling, ported at index.ts:567. It is the
  // only reason PATH is written with a slash rather than a hyphen anywhere in
  // this file, and it exists purely to reach this page -- so a rename of the
  // route above that missed it would leave a permanent redirect, cached by
  // every browser that ever followed it, pointing at a 404.
  //
  // 301 and RELATIVE, both as shipped: c.redirect() with a path emits the path
  // verbatim, where appendSlash's redirect above is absolute. Both are legal
  // (RFC 7231 allows a relative Location) and the difference is pinned rather
  // than tidied.
  it("301s the pre-rename /dashboard/price-per-kg/ here, without touching the database", async () => {
    seed();

    const res = await get(LEGACY_PATH);

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(PATH);
    expect(prepared).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// what the page shows
// ---------------------------------------------------------------------------

describe("what the page shows", () => {
  beforeEach(seed);

  // THE TABLE, in full. Four months, oldest first, each with its integer price
  // in pence and a literal "p" the template appends.
  //
  // The month number is NOT zero-padded -- "2024-1", not "2024-01" -- because
  // packages/db CASTs strftime('%m') to an integer and nunjucks prints it as
  // one. Django printed `{{ month.month.month }}`, a Python int off a datetime,
  // which is also unpadded, so this matches the original; it is asserted
  // because dropping the CAST would give "2024-01" here and break the
  // `{{ month.month - 1 }}` arithmetic in the chart at the same time.
  it("prints one table row per month, oldest first, with the truncated price in pence", async () => {
    expect(tableRows(await body(PATH))).toEqual(["2023-12|1000p", "2024-1|400p", "2024-3|428p", "2024-12|2000p"]);
  });

  // THE CHART IS THE ARTIFACT; the table under it is the footnote. Asserted as
  // the exact statements the template emitted, in order, because four separate
  // things are being pinned at once and only the raw text shows all four: the
  // PAIRING (echarts zips `dates` and `values` by index), the ORDER (same as
  // the table), the MONTH CONVERSION (`{{ month.month - 1 }}` -- JavaScript's
  // Date takes a zero-based month, so December must be 11 and January 0; drop
  // the `- 1` and every bar moves one month later, which on a
  // price-over-time chart is invisible), and the values themselves.
  it("emits paired dates and values for the echarts series, with JavaScript's zero-based months", async () => {
    expect(chartPushes(await body(PATH))).toEqual([
      "dates.push(new Date(2023, 11, 1));",
      "values.push(1000);",
      "dates.push(new Date(2024, 0, 1));",
      "values.push(400);",
      "dates.push(new Date(2024, 2, 1));",
      "values.push(428);",
      "dates.push(new Date(2024, 11, 1));",
      "values.push(2000);",
    ]);
  });

  // THE HEADLINE SENTENCE, in full -- five context keys in one string, and the
  // only place on the page any of them appears. Django's template built the
  // same sentence from `{{ months.0.month|date:"F" }} {{ months.0.year.year }}`,
  // `{{ items|intcomma }}`, `{{ weight|floatformat:2|intcomma }}` and
  // `{{ number_foodbanks }}`; this port moved the month-name lookup and the
  // two-decimal formatting into pricePerKg.ts, so the sentence is the contract
  // between the two files.
  it("dates the charity's food buying from the earliest month and totals the whole table", async () => {
    expect(intro(await body(PATH))).toBe(
      "Give Food has been purchasing food for food banks since December 2023, this is the price we've paid for " +
        "one kilogram of the food requested by them over time. Our data covers 150 items bought weighing 19.00 " +
        "tonnes and delivered to 3 different food banks around the UK.",
    );
  });

  // Named separately from the sentence above so a failure says WHICH rule
  // broke. The fixture is inserted with December 2023 FOURTH and January 2024
  // first, so "the earliest month" and "the first row inserted" are different
  // answers -- and a year-blind ORDER BY gives the second one.
  it("names the earliest month even though it was inserted fourth", async () => {
    const html = await body(PATH);

    expect(intro(html)).toContain("since December 2023,");
    expect(tableRows(html)[0]).toBe("2023-12|1000p");
  });

  // ALL TWELVE, one render each. MONTH_NAMES is twelve string literals typed
  // out by hand in pricePerKg.ts, indexed `[month - 1]`, and nothing else in
  // the codebase reads them. Only ONE of them is ever on the page at a time --
  // whichever month happens to be the earliest, which for the live site is a
  // value that was fixed years ago and will not change again -- so a typo
  // ("Feburary") or a shortened form ("Sep") in any of the other eleven ships
  // and waits. Measured as a real gap rather than assumed: with the fixture's
  // December and the sentence test above in place, mutating MONTH_NAMES[2] to
  // "Mar" and MONTH_NAMES[8] to "Sept" each survived every other test in this
  // file.
  //
  // Twelve renders also walk both ends of the index at once: month 12 dies on
  // an `[month]` off-by-one that reads past the end, month 1 on a `[month - 2]`
  // that reads past the front.
  it("spells all twelve month names out in full", async () => {
    const expected = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    for (let month = 1; month <= 12; month += 1) {
      db.prepare("DELETE FROM orders").run();
      seedOrder({ delivery_datetime: `2025-${String(month).padStart(2, "0")}-15 09:00:00.000000` });

      expect(intro(await body(PATH))).toContain(`since ${expected[month - 1]} 2025,`);
    }
  });

  // Django folded these two into one point only if you wrote `.values('month')`
  // without the year; the port's GROUP BY names both columns. Two Decembers a
  // year apart is the case that tells the difference: folded, they average to
  // 1500p/kg and the series loses a point.
  it("keeps the same month in two different years apart", async () => {
    const rows = tableRows(await body(PATH));

    expect(rows).toContain("2023-12|1000p");
    expect(rows).toContain("2024-12|2000p");
    expect(rows).not.toContain("2023-12|1500p");
    expect(rows).toHaveLength(4);
  });

  // WEIGHTED, NOT AVERAGED. January 2024's two orders are 1000p/kg and 333p/kg;
  // the ratio of the sums is 400p/kg and the mean of the prices is 666p/kg.
  // Django's `Sum('cost')*1000/Sum('weight')` weighted by kilo, which is the
  // point of the figure -- one enormous cheap pallet has to move the month more
  // than one small expensive delivery.
  it("sums cost and weight across the month before dividing", async () => {
    expect(tableRows(await body(PATH))).toContain("2024-1|400p");
  });

  // INTEGER DIVISION, and this one is faithful: Postgres divided two integer
  // sums here too (views.py:452's `Sum('cost')*1000/Sum('weight')`). March
  // 2024 is 3000000*1000/7000000 = 428.57p and both engines chart 428, not 429.
  it("truncates the price rather than rounding it", async () => {
    expect(tableRows(await body(PATH))).toContain("2024-3|428p");
  });

  // THE ORDER WITH NO FOOD BANK. Its 40 items and 7 tonnes are in the headline
  // totals (both SUMs are unfiltered) while it adds nothing to "delivered to N
  // different food banks", because COUNT(DISTINCT foodbank_id) skips NULLs.
  //
  // SUSPECT, PINNED AS-IS. Django's `Order.objects.values('foodbank')
  // .distinct().count()` treated NULL as a group of its own and counted it, so
  // this figure is one lower here than it was on the live site for as long as
  // any order has no food bank attached. Both numbers are defensible; they are
  // not the same number, and the sentence says "delivered to N food banks".
  // Recorded at the packages/db level too (dashboards.test.ts:1620); asserted
  // again here because this is where a reader actually sees it.
  it("counts an order with no food bank in the totals but not in the food bank tally", async () => {
    const line = intro(await body(PATH));

    // 150 items and 19 tonnes include the orphan order's 40 and 7.
    expect(line).toContain("covers 150 items bought weighing 19.00 tonnes");
    // Three food banks, from five orders across foodbank_ids 1, 1, 2, 3, NULL.
    expect(line).toContain("delivered to 3 different food banks");
  });

  // TWO NUMBERS, TWO FORMATTINGS, ON PURPOSE, matching Django exactly:
  // `{{ items|intcomma }}` gets thousands separators and
  // `{{ number_foodbanks }}` does not. A careless "make these consistent" edit
  // in either direction changes what the page claims -- and 1,234 food banks is
  // not hypothetical, the site lists over 3,000 locations. 1,234 orders seeded
  // rather than a smaller number because intcomma only does anything above 999.
  //
  // The tonnage is separators AND two decimals at once, which is the whole
  // reason pricePerKg.ts does the toFixed(2) itself and lets the template's
  // `|intcomma` run over the resulting string: intcomma's regex only ever
  // touches the digits before a decimal point, so "1234.57" comes out
  // "1,234.57" exactly as Django's `|floatformat:2|intcomma` pair did (verified
  // by running Django 6.1 -- the version pyproject.toml pins -- from
  // foodcharity/.venv: floatformat(1234.56789, 2) is "1234.57" and
  // intcomma("1234.57") is "1,234.57").
  it("puts thousands separators in the item count and the tonnage but never in the food bank count", async () => {
    db.prepare("DELETE FROM orders").run();
    for (let i = 0; i < 1234; i += 1) {
      seedOrder({ delivery_datetime: "2024-05-01 09:00:00.000000", no_items: 1000, weight: 1_000_456, foodbank_id: i + 1 });
    }

    const line = intro(await body(PATH));

    expect(line).toContain("covers 1,234,000 items bought weighing 1,234.56 tonnes");
    expect(line).toContain("delivered to 1234 different food banks");
  });

  // AN EMPTY DATABASE IS A 200, not a 404 and not a 500. This is not
  // hypothetical: migration 0005's header calls `orders` a one-time read-only
  // snapshot, so any environment loaded without it -- a fresh preview, a
  // restore window -- renders exactly this page. `?? 0` in getOrderWeightTotals
  // is what turns three NULL aggregates into zeros; without it the tonnage
  // would be `null / 1000000.0`, i.e. NaN, and `NaN.toFixed(2)` is the string
  // "NaN" in the middle of the sentence.
  //
  // The two empty strings for the month name and year leave a DOUBLE SPACE and
  // a dangling comma -- "since  , this is the price". Ugly, pinned as-is, and
  // identical to what Django rendered for the same empty queryset (`{{ months.0.month }}`
  // on an empty list is "" there too), so it is ported behaviour rather than a
  // regression.
  it("renders an empty page rather than failing when there are no orders at all", async () => {
    db.prepare("DELETE FROM orders").run();

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(intro(html)).toBe(
      "Give Food has been purchasing food for food banks since  , this is the price we've paid for one kilogram " +
        "of the food requested by them over time. Our data covers 0 items bought weighing 0.00 tonnes and " +
        "delivered to 0 different food banks around the UK.",
    );
    expect(tableRows(html)).toEqual([]);
    expect(chartPushes(html)).toEqual([]);
    // The empty case degrades the chart, not the document: the table's header
    // row survives, which is what distinguishes "no data" from "the table did
    // not render".
    expect(html).toContain("<th>Price per Kg</th>");
    expect(html).toContain("<h1>Price Per Kg</h1>");
  });
});

// ---------------------------------------------------------------------------
// the shapes the data can take that the page does not handle
// ---------------------------------------------------------------------------

describe("degenerate rows", () => {
  // SUSPECT, PINNED AS-IS -- and the most consequential thing in this file.
  //
  // A month whose orders weigh nothing divides by zero. SQLite returns NULL
  // (Postgres raised, so Django 500'd here instead -- not re-verified against a
  // live Postgres, but it is what packages/db's own suite records at
  // dashboards.test.ts:1740). Nunjucks renders NULL as the empty string, which
  // gives two different failures on one page:
  //
  //   * the table cell reads a bare "p", which at least LOOKS wrong; but
  //   * the script emits `values.push();` -- a legal call that pushes NOTHING.
  //
  // `dates` therefore gets one more element than `values`, and echarts pairs
  // them by index (`dates.map((date, index) => [date, values[index]])`). So
  // EVERY LATER MONTH IS PLOTTED AGAINST THE WRONG DATE and the last bar's
  // value is `undefined`. The chart still draws, still looks like a
  // price-over-time series, and is silently shifted -- which is strictly worse
  // than the 500 Django gave, and is why this is reported rather than merely
  // noted.
  //
  // Reachable whenever an order is recorded with weight 0, which the column
  // permits (`weight INTEGER NOT NULL`, no CHECK). Pinned, not fixed: these
  // tests record what the code does.
  it("emits an empty values.push() for a zero-weight month, sliding every later bar off its date", async () => {
    seedOrder({ delivery_datetime: "2024-03-01 09:00:00.000000", cost: 1_000_000, weight: 0 });
    seedOrder({ delivery_datetime: "2024-04-01 09:00:00.000000", cost: 1_000_000, weight: 1_000_000 });

    const html = await body(PATH);

    expect(tableRows(html)).toEqual(["2024-3|p", "2024-4|1000p"]);
    expect(chartPushes(html)).toEqual([
      "dates.push(new Date(2024, 2, 1));",
      // Not "values.push(null);" and not a skipped month -- an empty call.
      "values.push();",
      "dates.push(new Date(2024, 3, 1));",
      "values.push(1000);",
    ]);
  });

  // SUSPECT, PINNED AS-IS. `delivery_datetime` is TEXT with no CHECK
  // constraint, so a row whose value strftime() cannot parse comes back with
  // year and month NULL. The table degrades quietly to "-", but the inline
  // script gets `new Date(, -1, 1)` -- which is a SYNTAX ERROR, so the browser
  // discards the ENTIRE <script> block: no chart, no trend line, and no message
  // anywhere. A blank space where a graph should be, with a 200 and a perfect
  // table underneath it.
  //
  // The `-1` is `null - 1` evaluated by nunjucks; the empty year is
  // suppressValue turning null into "". Not currently reachable from the
  // pg-to-D1 loader, whose source column is a Django DateTimeField, which is
  // why this is pinned rather than treated as a live defect -- but the day
  // anything else writes to `orders` it becomes one page-wide failure per bad
  // row, and this assertion is here to fail loudly then.
  it("emits an unparsable new Date() for a malformed delivery_datetime, killing the whole script block", async () => {
    seedOrder({ delivery_datetime: "not a datetime", cost: 1_000_000, weight: 1_000_000 });

    const html = await body(PATH);

    expect(tableRows(html)).toEqual(["-|1000p"]);
    expect(chartPushes(html)).toEqual(["dates.push(new Date(, -1, 1));", "values.push(1000);"]);
    // And the headline sentence loses its month AND its year, because
    // MONTH_NAMES[null - 1] is MONTH_NAMES[-1], i.e. undefined.
    expect(intro(html)).toContain("since  ,");
  });

  // SUSPECT, A ROUNDING DIVERGENCE, PINNED AS-IS. pricePerKg.ts:48 formats the
  // tonnage with `toFixed(2)`; Django used `|floatformat:2`, which is
  // `Decimal(repr(value)).quantize(..., ROUND_HALF_UP)`. They disagree on an
  // exact tie whose binary double sits just below it: 1005000 grams is 1.005
  // tonnes, and Django prints "1.01" where this port prints "1.00".
  //
  // BOTH SIDES MEASURED, not reasoned about: Django 6.1 out of
  // foodcharity/.venv (the version pyproject.toml pins) gives
  // floatformat(1.005, 2) == "1.01"; node gives (1005000/1000000).toFixed(2)
  // == "1.00". Worth a hundredth of a tonne on one sentence, so it is recorded
  // rather than fixed -- and note packages/templates already ships a
  // `floatformat` filter that is itself just toFixed(), so routing this through
  // the template would not change the answer.
  it("rounds a half-tonne tie down where Django's floatformat rounded it up", async () => {
    seedOrder({ delivery_datetime: "2024-03-01 09:00:00.000000", weight: 1_005_000 });

    expect(intro(await body(PATH))).toContain("weighing 1.00 tonnes");
  });

  // The empty-string month name and year are the ONLY strings this handler puts
  // on the page that it did not read out of a fixed array -- everything else on
  // it is an integer from an aggregate. So there is no escaping surface here at
  // all, which is worth an assertion rather than an assumption: it is the
  // reason this file has no counterpart to itemGroups.test.ts's `</script>`
  // breakout test, and a future edit that starts printing, say, a country or a
  // food bank name into the inline script would have to notice.
  it("puts nothing user-controlled into the page: every rendered value is a number", async () => {
    seed();
    const pushes = chartPushes(await body(PATH));

    for (const push of pushes) expect(push).toMatch(/^(?:dates\.push\(new Date\(\d+, \d+, 1\)\);|values\.push\(-?\d+\);)$/);
    for (const row of tableRows(await body(PATH))) expect(row).toMatch(/^\d+-\d+\|-?\d+p$/);
  });
});

// ---------------------------------------------------------------------------
// what the request costs
// ---------------------------------------------------------------------------

describe("what the request costs", () => {
  beforeEach(seed);

  // TWO statements, both READS, over ONE session, with nothing bound. Both
  // aggregate the whole of `orders` and D1 meters rows read, so a third call --
  // the shape a careless "let me also show the latest delivery" edit takes --
  // adds a full table scan with nothing visible to show for it. The ORDER is
  // asserted as well: months first, totals second, which is what makes
  // `months[0]` available for the headline sentence without a second query.
  it("issues exactly two statements, both reads, over exactly one D1 session", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;

    await get(PATH);

    expect(prepared).toEqual([SQL_MONTHS, SQL_TOTALS]);
    for (const sql of prepared) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
    // No bound parameters at all: both statements are fixed strings, so there
    // is nothing on this page any part of the request could reach.
    expect(bound).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n).toBe(before);
    // ONE session for both queries, so they see one consistent snapshot -- two
    // sessions could straddle a replica lag boundary and put a table and a
    // headline total from different moments on the same page.
    //
    // "first-unconstrained" is lib/session.ts's mode. "first-primary" would
    // work identically here and would silently give up read-replica
    // eligibility on a page with no consistency requirement whatsoever.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // Two views in a row are byte-identical in the parts that carry data, and
  // each is still two statements. This is the assertion a "let me cache the
  // answer in a table" change trips over, and it is also what says the page is
  // safe to reload -- which is what someone watching these numbers actually
  // does.
  it("is idempotent across repeated views", async () => {
    const first = await body(PATH);
    prepared = [];
    const second = await body(PATH);

    expect(tableRows(second)).toEqual(tableRows(first));
    expect(chartPushes(second)).toEqual(chartPushes(first));
    expect(intro(second)).toEqual(intro(first));
    expect(prepared).toEqual([SQL_MONTHS, SQL_TOTALS]);
  });

  // NOTHING IN THE URL REACHES EITHER QUERY. The handler takes no parameters,
  // so a query string is inert -- asserted because "let me make this page
  // filterable by year" is the obliging edit that would put a request value
  // into a statement, and the sibling getDeliveryMonthCounts already
  // interpolates its metric (from an allowlist) rather than binding it.
  it("ignores a query string entirely", async () => {
    const html = await body(`${PATH}?year=2024&month=1&limit=100000`);

    expect(tableRows(html)).toEqual(["2023-12|1000p", "2024-1|400p", "2024-3|428p", "2024-12|2000p"]);
    expect(prepared).toEqual([SQL_MONTHS, SQL_TOTALS]);
    expect(bound).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// caching
// ---------------------------------------------------------------------------

describe("caching", () => {
  beforeEach(seed);

  // A DIVERGENCE, PINNED. Django's view carries @cache_page(SECONDS_IN_HOUR)
  // (gfdash/views.py:449), and this page gets a DAY of shared cache -- not from
  // anything in this route file, but because /dashboard/... matches no rule in
  // middleware/pageCacheControl.ts and the day is its FALL-THROUGH DEFAULT.
  // That default was chosen for the food bank pages that are nearly all of this
  // site's HTML; it happens to match the @cache_page on the item-group and
  // heatmap dashboards and NOT the one on this one.
  //
  // Twenty-four hours rather than one on a page whose underlying table is a
  // static snapshot is a small thing, but it is 24x Django's staleness window
  // with nothing in this directory saying so, and the same fall-through covers
  // price_per_calorie, price_per_item_category, deliveries and every other
  // hourly gfdash view. Reported rather than fixed. The 300-second browser
  // max-age is pageCacheControl's own documented divergence (a browser cache
  // cannot be purged).
  it("gets a day of shared cache from pageCacheControl's default, where Django said an hour", async () => {
    expect((await get(PATH)).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // No Cache-Tag, so a newly loaded orders snapshot cannot purge this page: it
  // goes stale for up to a day. middleware/cacheTag.ts's aggregate purge set
  // covers the home page, the sitemaps, the feeds and the API list endpoints,
  // and no dashboard is in it. That matches Django, which cached the same page
  // with no invalidation at all -- ported behaviour rather than a regression,
  // pinned so a future purge-list change has something to fail against.
  it("carries no cache tag, so a reloaded orders snapshot cannot purge it", async () => {
    expect((await get(PATH)).headers.get("Cache-Tag")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the shared page context
// ---------------------------------------------------------------------------

describe("the shared page context", () => {
  beforeEach(seed);

  // buildPageContext({ path: c.req.path }) -- canonical is the request's own
  // path, matching givefood/context_processors.py:19 (SITE_DOMAIN + the path).
  it("declares itself canonical at its own URL", async () => {
    expect(await body(PATH)).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
  });

  // The debug comment's "Took Nms" is elapsedMs(c), read off the timestamp
  // middleware/serverTiming.ts stored -- whole milliseconds, deliberately not
  // Django's three decimals (performance.now() only advances at I/O boundaries
  // on Workers, so the fraction was always exactly ".000"). The failure this
  // catches is the string "NaN": elapsedMs subtracts an unset context variable
  // if this handler is ever reached without serverTiming in front of it, and an
  // HTML comment is not a place anyone looks.
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body(PATH)).toMatch(/⏱️ Took \d+ms\n/);
  });

  // A DIVERGENCE, PINNED. givefood/context_processors.py:46-48 appended
  // QUERY_STRING to flag_path, so Django's "Something wrong in this page?" link
  // carried the query the reader was actually looking at. pageContext() here
  // passes only `path`, so the query is dropped -- harmless (this page reads no
  // parameters) and recorded so it stays a known difference. Every gfdash
  // handler in this directory is written the same way.
  it("drops the query string from the flag link, unlike Django", async () => {
    const html = await body(`${PATH}?utm_source=newsletter`);

    expect(html).toContain(`href="/flag/#${ORIGIN}${PATH}"`);
    expect(html).not.toContain("utm_source");
  });

  // The breadcrumb and logo hrefs come from @givefood/urls' reverse table
  // (`url('index')`, `url('dash:index')`, `url('dash:price_per_kg')`), which is
  // how Django's own template built them. If that table moved, this page would
  // still render with a 200 and every link on it would point at a 404 -- and
  // the self-referencing third crumb is the one that would say so, because it
  // is also the URL the legacy redirect above targets.
  it("builds its breadcrumbs from the reverse-URL table", async () => {
    const html = await body(PATH);

    expect(html).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
    expect(html).toContain(`<li class="is-active"><a href="${PATH}" aria-current="page">Price Per Kg</a></li>`);
  });
});

// ---------------------------------------------------------------------------
// when the query fails
// ---------------------------------------------------------------------------

describe("when a query fails", () => {
  // The handler has no try/catch, which is the right call and is worth pinning
  // as such. The defensive-looking alternative -- catching and rendering with
  // `months: []` -- publishes a page stating that Give Food has bought 0 items
  // weighing 0.00 tonnes for 0 food banks, when what actually happened is that
  // D1 was unavailable. An empty chart on a data page is a claim, and a false
  // one is worse than an error page.
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
    // Not a partial page: the chart's own div must not be on it, or a reader
    // gets a 500 that still draws an empty graph.
    expect(html).not.toContain('<div id="chart"');
  });

  // THE SECOND QUERY FAILING ALONE, which the test above cannot reach because
  // the first one throws first. getOrderWeightTotals runs after the months are
  // already in hand, so a handler that caught nothing but happened to render
  // early would produce a chart with no headline sentence -- a page that looks
  // finished and states nothing. It must 500 instead.
  it("serves the 500 page when only the totals query fails, not a chart with no headline", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      DB: {
        withSession: () => ({
          prepare: (sql: string) => ({
            all: async () => ({ results: db.prepare(sql).all(), success: true, meta: {} }),
            first: async () => {
              throw new Error("D1_ERROR: network connection lost");
            },
          }),
        }),
      },
    } as unknown as AppEnv["Bindings"];
    seed();

    const res = await app.fetch(new Request(`${ORIGIN}${PATH}`), broken, execCtx);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("<h1>500 - Internal Server Error</h1>");
    expect(html).not.toContain("Give Food has been purchasing food");
  });
});

// ===========================================================================
// MUTATION TESTING, run in a copy of this repo under the scratchpad -- never
// against a source file in the working tree. Each mutant was applied alone, the
// templates re-precompiled where a .njk was touched (a template edit is inert
// until scripts/precompile.ts runs, so without that step a "template mutant"
// proves nothing), this file re-run, the mutant reverted, and the suite re-run
// to prove the tree was clean again before the next one. The count is how many
// of the 33 tests above went red.
//
// In pricePerKg.ts itself:
//   getPricePerKgByMonth -> getPricePerCalorieByMonth            24 failed
//   getOrderWeightTotals -> getOrderCalorieTotals                24 failed
//     (the two halves of the copy-of-its-neighbour failure this file is
//      largely about)
//   MONTH_NAMES[month - 1] -> MONTH_NAMES[month]                  3 failed
//   MONTH_NAMES[2] "March" -> "Mar"                               1 failed
//   MONTH_NAMES[8] "September" -> "Sept"                          1 failed
//   months[0] -> months[months.length - 1]                        2 failed
//   toFixed(2) -> toFixed(1)                                      5 failed
//   toFixed(2) dropped entirely                                   5 failed
//   context key `months` -> `rows`                                9 failed
//   template -> "dash/price_per_calorie.njk"                      7 failed
//   items: totals.items -> totals.numberFoodbanks                 3 failed
//   number_foodbanks dropped from the context                     4 failed
//   the two `firstMonth ? ... : ""` guards dropped                1 failed
//   render_time_ms dropped from pageContext()                     1 failed
//   c.html() -> c.text()                                          2 failed
//   a second dbSession(c) for the totals query                    1 failed
//   pageTranslatable: true + locale: "en" added                   1 failed
//
// In index.ts:
//   the app.get() registration deleted                           26 failed
//   registered with app.all()                                     1 failed
//   the legacy redirect pointed back at itself                    1 failed
//
// In the shared queries (packages/db/src/dashboards.ts), to prove the fixture's
// scrambled insertion order, its two Decembers and its food-bank-less order are
// doing work rather than sitting there:
//   ORDER BY year, month -> ORDER BY month                        8 failed
//   GROUP BY year, month -> GROUP BY month                        9 failed
//   ORDER BY year DESC, month DESC                                9 failed
//   (SUM(cost) * 1000) / SUM(weight) -> AVG((cost*1000)/weight)   8 failed
//   * 1000 -> * 100                                              12 failed
//   both strftime CASTs dropped                                   8 failed
//   / 1000000.0 -> / 1000000 (integer division)                   5 failed
//   COUNT(DISTINCT foodbank_id) -> COUNT(foodbank_id)             6 failed
//   COUNT(DISTINCT foodbank_id) -> COUNT(*)                       6 failed
//   SUM(no_items) -> SUM(no_lines)                                7 failed
//   SUM(no_items) -> SUM(weight)                                  7 failed
//
// In dash/price_per_kg.njk:
//   `{{ month.month - 1 }}` -> `{{ month.month }}`                3 failed
//   `{{ items|intcomma }}` -> `{{ items }}`                       1 failed
//   `{{ number_foodbanks }}` -> `{{ number_foodbanks|intcomma }}` 1 failed
//   the chart-colors.js <script> deleted                          1 failed
//   the table cell prints month.year instead of month.price       8 failed
//   the table cell's year and month swapped                       7 failed
//   the dates.push/values.push pair emitted in the other order    3 failed
//   chart height 500px -> 600px                                   1 failed
//
// TWO SURVIVORS out of 41 mutants, recorded rather than papered over:
//
//   `locale: "en"` added to buildPageContext() ALONE changes no byte of the
//   page, because both the hreflang block and includes/langswitcher.njk are
//   gated on `page_translatable`, which stays false. An equivalent mutant, not
//   a gap -- the version above that also flips pageTranslatable dies.
//
//   `render_time_ms: elapsedMs(c)` -> `0` survives, because the debug-comment
//   test matches /Took \d+ms/ and "Took 0ms" is a \d+. Deliberate: the only
//   assertion that would kill it is one on a specific elapsed time, which is
//   the flakiest thing a suite can contain. Dropping the key entirely -- which
//   is the edit that actually happens, and which renders "Took ms" -- does die.
