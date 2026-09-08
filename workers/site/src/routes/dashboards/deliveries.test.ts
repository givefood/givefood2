import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index";
import { serverTiming } from "../../middleware/serverTiming";
import type { AppEnv } from "../../types";
import { gfdashDeliveries } from "./deliveries";

// routes/dashboards/deliveries.ts -- /dashboard/deliveries/{count|items|
// weight|calories}/, Django's gfdash `deliveries` at gfdash/views.py:394-421,
// routed by gfdash/urls.py:22's
// `re_path(r'^deliveries/(count|items|weight|calories)/$', ...)`.
//
// WHY THIS FILE EXISTS. This handler is 19 lines and three of them carry the
// whole weight of the module:
//
//   1. `isDeliveryMetric(metric)` is a SECURITY BOUNDARY, not a tidy-up.
//      getDeliveryMonthCounts (packages/db/src/dashboards.ts:281) builds its
//      statement by TEMPLATE-INTERPOLATING the metric's aggregate into the SQL
//      text -- `AS the_month, ${metricSql} AS count` -- and its own comment
//      says out loud that it trusts the route to have validated first. Django
//      got that validation free from a URL regex that could not match anything
//      else; here it is a hand-written `includes()` call that a refactor could
//      weaken to `metric in METRIC_TEXT` without a single test going red, at
//      which point `/dashboard/deliveries/toString/` reaches the SQL builder.
//      So the tests below assert the 404 AND that ZERO statements reached the
//      engine -- a 404 alone is equally true of a guard that queries first.
//
//   2. METRIC_TEXT is four literal strings copied verbatim from views.py's
//      if/elif chain. A copy-paste in that table gives every chart a correct
//      HTTP 200 with the wrong axis label, which nothing else in the stack
//      notices.
//
//   3. `months` goes straight into a JavaScript array literal inside a
//      <script> block. The page renders identically whether the numbers are
//      right, wrong, or in the wrong order, so "returns 200" says nothing at
//      all -- the tests read the two literal arrays echarts is handed.
//
// REAL EVERYTHING, following routes/public/sitemaps.test.ts: the real
// production app (workers/site/src/index.ts's default export), so the real
// router, the real middleware chain and the real Nunjucks render, over real
// in-memory SQLite whose `orders` DDL comes from the real migrations via
// schemaFor(). Nothing about this route leaves the machine, so nothing here
// is mocked except the two KV namespaces, which are inert stubs.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite -- the
// same shim routes/public/sitemaps.test.ts uses. `prepared` records the SQL
// that actually reached the engine, which is the entire point here: the
// allowlist tests below are assertions about statements NOT prepared, and
// there is no other way to see that from outside.
function d1Session(db: DatabaseSync, prepared: string[]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
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

let db: DatabaseSync;
let prepared: string[];

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

// Every NOT NULL column 0005_orders_and_charity.sql declares, so a seeded row
// is one production would have accepted. Only the four the four metrics read
// -- delivery_datetime, no_items, weight, calories -- are parameterised.
//
// `delivery_datetime` is TEXT, and takes the Django spelling
// "YYYY-MM-DD HH:MM:SS.ffffff" that Django's own writer produces. That
// matters: strftime() is what turns it into the month key, and the format it
// is handed decides whether the key comes out at all (see the NULL-month test).
function seedOrder(o: { id: number; deliveryDatetime: string; noItems?: number; weight?: number; calories?: number }): void {
  db.prepare(
    `INSERT INTO orders (id, order_id, items_text, country, created, modified, delivery_date, delivery_hour,
       delivery_datetime, weight, calories, cost, no_lines, no_items)
     VALUES (?, ?, 'Baked beans x1', 'England', '2024-01-01 00:00:00.000000', '2024-01-01 00:00:00.000000',
       ?, 12, ?, ?, ?, 1000, 1, ?)`,
  ).run(o.id, `GF-${o.id}`, o.deliveryDatetime.slice(0, 10), o.deliveryDatetime, o.weight ?? 0, o.calories ?? 0, o.noItems ?? 0);
}

// THE FIXTURE IS THE TEST for the four metric tests. Two months, and every
// metric deliberately produces a DIFFERENT pair of numbers from the same three
// rows, so a chart drawn from the wrong aggregate cannot coincidentally match:
//
//   month    count   items   weight (g -> kg)      calories
//   2024-01      2      30   1500+2400 = 3900 -> 3   12,000
//   2024-02      1       5              800 -> 0      1,000
//
// The 3900 g -> 3 kg truncation is the deliberate integer division inherited
// from the Postgres `sum(weight)/1000` at views.py:406, pinned at the db layer
// too (packages/db/src/dashboards.test.ts) and pinned again HERE because this
// is where a reader sees it: the chart genuinely publishes 3 kg for 3.9 kg.
function seedTwoMonths(): void {
  seedOrder({ id: 1, deliveryDatetime: "2024-01-10 09:00:00.000000", noItems: 10, weight: 1500, calories: 5000 });
  seedOrder({ id: 2, deliveryDatetime: "2024-01-20 09:00:00.000000", noItems: 20, weight: 2400, calories: 7000 });
  seedOrder({ id: 3, deliveryDatetime: "2024-02-10 09:00:00.000000", noItems: 5, weight: 800, calories: 1000 });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(schemaFor("orders"));
  prepared = [];
});

afterEach(() => {
  db.close();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, method = "GET"): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, { method }), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// ---------------------------------------------------------------------------
// Reading the chart
// ---------------------------------------------------------------------------

// The template emits one line per `{% for %}` iteration with the tag's own
// whitespace left in, so the literal bytes of these two arrays are unreadable
// in an expectation and would break on any reindent of deliveries.njk.
// Collapsing runs of whitespace loses nothing that matters -- whitespace
// inside a JS array literal is not syntax -- while the QUOTING, the COMMAS,
// the VALUES and their ORDER, which are all of the content, survive intact.
const squash = (html: string): string => html.replace(/\s+/g, " ");

function capture(re: RegExp, haystack: string, what: string): string {
  const match = re.exec(haystack);
  // Thrown rather than expect()ed so a template change that moves the chart
  // fails by name instead of as an inscrutable `undefined` mismatch.
  if (match === null) throw new Error(`could not find the chart's ${what} in the rendered page`);
  return match[1]!.trim();
}

// The two array literals echarts is actually handed, as source text. Anchored
// on the surrounding option keys rather than on "the first data: [" so the
// x-axis and the series cannot be silently swapped by a future edit.
function chartMonths(html: string): string {
  return capture(/xAxis: \{ type: 'category', data: \[(.*?)\], axisLabel/, squash(html), "xAxis data");
}

function chartValues(html: string): string {
  return capture(/type: 'bar', data: \[(.*?)\] \}/, squash(html), "series data");
}

// ===========================================================================
// The metric allowlist -- Django's URL regex, re-implemented as code
// ===========================================================================

describe("gfdashDeliveries -- the metric allowlist", () => {
  // The four values gfdash/urls.py:22's regex alternation permits, each
  // reaching the handler and rendering. If the allowlist and the regex ever
  // disagree, a URL that worked on Django 404s here (or, worse, the reverse).
  it.each(["count", "items", "weight", "calories"])("serves /dashboard/deliveries/%s/", async (metric) => {
    seedTwoMonths();

    const res = await get(`/dashboard/deliveries/${metric}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
  });

  // THE SECURITY TEST, and the reason this file leads with it. Django's regex
  // could not route a fifth value at all; here the router happily matches
  // `:metric` and the handler is the only thing standing between an arbitrary
  // path segment and a SQL string built by interpolation. A 404 on its own
  // does NOT prove the guard ran first -- a guard that queried and then threw
  // would also 404 -- so this asserts the engine saw no statement whatsoever.
  it.each(["bogus", "COUNT", "Count", "count ", "cost", "co", "counts"])("404s /dashboard/deliveries/%s/ without preparing any SQL", async (metric) => {
    seedTwoMonths();

    const res = await get(`/dashboard/deliveries/${encodeURIComponent(metric)}/`);

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // The uppercase cases above are worth naming separately: Django's regex is
  // case-SENSITIVE, so /deliveries/COUNT/ was a 404 there, and `includes()` on
  // a string array is case-sensitive too. A "helpful" toLowerCase() in
  // isDeliveryMetric would start serving URLs Django never served, and would
  // do it silently.
  it("does not case-fold the metric, matching the case-sensitive Django regex", async () => {
    expect((await get("/dashboard/deliveries/Weight/")).status).toBe(404);
    expect((await get("/dashboard/deliveries/CALORIES/")).status).toBe(404);
    expect((await get("/dashboard/deliveries/weight/")).status).toBe(200);
  });

  // THE MUTANT THIS KILLS: `isDeliveryMetric` rewritten as `value in
  // METRIC_TEXT` or `METRIC_TEXT[value] !== undefined`, both of which look
  // like obvious simplifications and both of which are TRUE for every key on
  // Object.prototype. "toString" would then pass the guard, and
  // DELIVERY_METRIC_SQL["toString"] would resolve to the inherited FUNCTION,
  // which template-interpolates into the statement as its source text. The
  // `includes()` spelling in the source is not an accident, and only this test
  // says so.
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "404s the inherited Object.prototype key %s without preparing any SQL",
    async (metric) => {
      seedTwoMonths();

      const res = await get(`/dashboard/deliveries/${encodeURIComponent(metric)}/`);

      expect(res.status).toBe(404);
      expect(prepared).toEqual([]);
    },
  );

  // A metric carrying SQL, for the same reason -- and specifically a payload
  // that WOULD be syntactically valid if it were interpolated, so a regression
  // shows up as a 200 with a mangled chart rather than as a 500 anyone would
  // investigate.
  it("404s a metric carrying SQL, and prepares nothing", async () => {
    seedTwoMonths();

    const res = await get(`/dashboard/deliveries/${encodeURIComponent("COUNT(*) FROM orders WHERE 1=0 --")}/`);

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // Hono decodes the path parameter before the handler sees it, and Django
  // likewise resolved URLs against the decoded path -- so a percent-encoded
  // spelling of a legal metric is the same URL, not a bypass and not a 404.
  // Pinned because it is the one place where "the allowlist compares decoded
  // text" is observable, and because a future guard written against
  // c.req.url instead of the param would get this wrong in both directions.
  it("matches a percent-encoded spelling of a legal metric", async () => {
    seedTwoMonths();

    const res = await get("/dashboard/deliveries/%63ount/");

    expect(res.status).toBe(200);
    expect(chartValues(await res.text())).toBe("2, 1");
  });

  // An empty segment. `c.req.param("metric") ?? ""` exists for exactly this
  // shape; the empty string is not in the allowlist, so it 404s -- and Hono
  // does not match the route at all, so the handler is not even reached.
  it("404s an empty metric segment", async () => {
    expect((await get("/dashboard/deliveries//")).status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // WHERE THE GUARD LIVES. Everything above would also pass if the allowlist
  // had been deleted and index.ts had grown four literal routes instead --
  // a real possibility, since that is closer to what the Django regex does.
  // Mounting the exported handler on a bare app under a DIFFERENT path proves
  // the 404 comes from the handler's own c.notFound(), which is what makes
  // getDeliveryMonthCounts safe no matter how it is ever re-mounted.
  it("rejects the metric in the handler itself, not in index.ts's routing", async () => {
    seedTwoMonths();
    const bare = new Hono<AppEnv>();
    bare.use("*", serverTiming); // gfdashDeliveries reads the start time this records
    bare.get("/anywhere/:metric/", gfdashDeliveries);

    const bad = await bare.fetch(new Request(`${ORIGIN}/anywhere/bogus/`), env(), execCtx);
    const preparedAfterBad = [...prepared]; // snapshotted BEFORE the good request adds its own
    const good = await bare.fetch(new Request(`${ORIGIN}/anywhere/count/`), env(), execCtx);

    expect(bad.status).toBe(404);
    expect(preparedAfterBad).toEqual([]);
    expect(good.status).toBe(200);
    expect(chartValues(await good.text())).toBe("2, 1");
  });
});

// ===========================================================================
// The four metrics -- views.py:394-421's if/elif chain, value for value
// ===========================================================================

describe("gfdashDeliveries -- the four metrics", () => {
  beforeEach(seedTwoMonths);

  // count -> "count(*)" (views.py:398). Two January deliveries, one February.
  it("charts COUNT(*) per month for metric=count", async () => {
    const html = await body("/dashboard/deliveries/count/");

    expect(chartMonths(html)).toBe("'2024-01', '2024-02'");
    expect(chartValues(html)).toBe("2, 1");
  });

  // items -> "sum(no_items)" (views.py:401). 10 + 20, then 5.
  it("charts SUM(no_items) per month for metric=items", async () => {
    const html = await body("/dashboard/deliveries/items/");

    expect(chartMonths(html)).toBe("'2024-01', '2024-02'");
    expect(chartValues(html)).toBe("30, 5");
  });

  // weight -> "sum(weight)/1000" (views.py:404). INTEGER DIVISION, PINNED:
  // 1500 + 2400 = 3900 g is published as 3 kg, and 800 g as 0 kg, exactly as
  // the Postgres original did. The `/ 1000.0` that would "fix" this is the
  // single most tempting edit in packages/db/src/dashboards.ts, and it would
  // step every point of this published chart away from the number Django
  // published. Asserted here, at the rendered page, so the consequence is
  // visible and not just a unit-test number.
  it("charts whole-kilogram SUM(weight)/1000 per month for metric=weight, truncating 3.9 kg to 3", async () => {
    const html = await body("/dashboard/deliveries/weight/");

    expect(chartMonths(html)).toBe("'2024-01', '2024-02'");
    expect(chartValues(html)).toBe("3, 0");
  });

  // calories -> "sum(calories)" (views.py:407). 5000 + 7000, then 1000.
  it("charts SUM(calories) per month for metric=calories", async () => {
    const html = await body("/dashboard/deliveries/calories/");

    expect(chartMonths(html)).toBe("'2024-01', '2024-02'");
    expect(chartValues(html)).toBe("12000, 1000");
  });

  // The whole point of the if/elif chain is that the four branches differ. A
  // copy-paste in DELIVERY_METRIC_SQL -- three entries all reading COUNT(*),
  // say -- produces four 200s, four correctly-labelled axes and four
  // identical charts, and the individual tests above would still pass if the
  // fixture happened to make two aggregates agree. This one cannot.
  it("gives each metric a distinct series", async () => {
    const series = await Promise.all(
      ["count", "items", "weight", "calories"].map(async (m) => chartValues(await body(`/dashboard/deliveries/${m}/`))),
    );

    expect(series).toEqual(["2, 1", "30, 5", "3, 0", "12000, 1000"]);
    expect(new Set(series).size).toBe(4);
  });
});

// ===========================================================================
// METRIC_TEXT -- views.py's metric_text strings, and where each one lands
// ===========================================================================

describe("gfdashDeliveries -- metric_text", () => {
  beforeEach(seedTwoMonths);

  // The four strings verbatim from views.py:397/400/403/406, in the two
  // places the template uses them: `|lower` in the human-facing headings, and
  // UNLOWERED in the echarts axis and series names. Both spellings of each
  // string are asserted because the template applies the filter in three
  // places and not in two, and a stray `|lower` on the axis name is exactly
  // the sort of edit that no status code notices.
  //
  // The lowered spellings are what Nunjucks' `lower` filter actually produced
  // here, read off the rendered page. All four strings are plain ASCII, where
  // Django's `lower` should agree -- but that half is reasoning from the two
  // implementations, NOT VERIFIED by running Django.
  it.each([
    ["count", "Number of deliveries", "number of deliveries"],
    ["items", "Items", "items"],
    ["weight", "Weight kg", "weight kg"],
    ["calories", "Calories", "calories"],
  ])("renders metric=%s as %j in the axis and %j in the headings", async (metric, text, lowered) => {
    const html = await body(`/dashboard/deliveries/${metric}/`);

    expect(html).toContain(`<title>Deliveries (by ${lowered}) - Give Food</title>`);
    expect(html).toContain(`<h1>Deliveries (by ${lowered})</h1>`);
    expect(squash(html)).toContain(`yAxis: { type: 'value', name: '${text}' }`);
    expect(squash(html)).toContain(`series: [ { name: '${text}', type: 'bar'`);
  });

  // {% url 'dash:deliveries' metric %} at deliveries.html:19 -- the breadcrumb
  // links to the page it is on, so the reversed URL has to carry the metric
  // back out. A reverser that dropped the argument would give all four pages a
  // breadcrumb pointing at /dashboard/deliveries//, which renders fine and
  // 404s when clicked.
  it.each(["count", "items", "weight", "calories"])("reverses the breadcrumb's own url for metric=%s", async (metric) => {
    const html = await body(`/dashboard/deliveries/${metric}/`);

    expect(html).toContain(`<li class="is-active"><a href="/dashboard/deliveries/${metric}/" aria-current="page">`);
    expect(html).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
  });

  // Django put the assembled SQL string into template_vars as "sql"
  // (views.py:412) and dash/deliveries.html never printed it; the port drops
  // the variable entirely. Pinned as a floor, not as parity trivia: this is a
  // PUBLIC, uncached-by-login page, and the day someone restores the variable
  // "for parity" and a template edit prints it, the site publishes its own
  // schema. Nothing else in the stack would flag that.
  it("does not leak the generated SQL into the public page", async () => {
    const html = await body("/dashboard/deliveries/count/");

    expect(html).not.toContain("strftime");
    expect(html).not.toContain("SELECT");
    expect(html).not.toContain("FROM orders");
  });
});

// ===========================================================================
// The month series -- ordering, emptiness, and the things Postgres could not
// produce
// ===========================================================================

describe("gfdashDeliveries -- the month series", () => {
  // The x-axis order is the QUERY's order, not the template's -- deliveries.njk
  // has no sort in it. Seeded deliberately out of order and across a year
  // boundary, because "YYYY-MM" text sorts chronologically only while the month
  // stays zero-padded: a strftime key of '%Y-%-m' would put "2024-10" before
  // "2024-2" and draw a chart whose bars are in the wrong places with no error
  // anywhere.
  it("orders the x-axis chronologically across a year boundary, in insertion-independent order", async () => {
    seedOrder({ id: 1, deliveryDatetime: "2024-10-01 09:00:00.000000" });
    seedOrder({ id: 2, deliveryDatetime: "2023-12-31 23:00:00.000000" });
    seedOrder({ id: 3, deliveryDatetime: "2024-02-05 09:00:00.000000" });
    seedOrder({ id: 4, deliveryDatetime: "2025-01-01 00:00:00.000000" });

    expect(chartMonths(await body("/dashboard/deliveries/count/"))).toBe("'2023-12', '2024-02', '2024-10', '2025-01'");
  });

  // No orders at all -- a brand-new database, or the first request after a
  // truncate. `{% for %}` over an empty list emits nothing, so echarts is
  // handed `data: []` twice, which is valid JS and an empty chart. The failure
  // this guards against is a template rewrite that emits a trailing comma or a
  // bare `data: [,]` for the empty case: a JS syntax error inside a <script>
  // block still returns HTTP 200 and a page that looks fine until you notice
  // the chart never appears.
  it("renders an empty chart, not a broken one, when there are no orders", async () => {
    const res = await get("/dashboard/deliveries/count/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(chartMonths(html)).toBe("");
    expect(chartValues(html)).toBe("");
    expect(html).toContain("<h1>Deliveries (by number of deliveries)</h1>");
  });

  // SUSPECT, PINNED AS-IS -- see the suite header. Django's
  // `to_char(delivery_datetime, 'YYYY-MM')` ran over a Postgres timestamp
  // column, so every row HAD a month. In D1 the column is TEXT and strftime()
  // returns NULL for anything it cannot parse, so unparseable rows collapse
  // into a single NULL group which SQLite's ORDER BY puts FIRST, and Nunjucks
  // renders as ''. The chart therefore gains a leading nameless bar carrying
  // the sum of every corrupt row -- a 200, no log line, and a number a reader
  // would take at face value.
  //
  // This asserts what the code DOES. It is not an endorsement: reported in
  // suspectedBugs.
  it("collapses unparseable delivery_datetime values into one leading nameless bar", async () => {
    seedOrder({ id: 1, deliveryDatetime: "2024-01-10 09:00:00.000000", noItems: 10 });
    seedOrder({ id: 2, deliveryDatetime: "not a date at all", noItems: 7 });
    seedOrder({ id: 3, deliveryDatetime: "", noItems: 1 });

    const html = await body("/dashboard/deliveries/items/");

    expect(chartMonths(html)).toBe("'', '2024-01'");
    expect(chartValues(html)).toBe("8, 10");
  });

  // The other half of that: an ISO-8601 "T"/"Z" timestamp -- what
  // `toISOString()` writes, and what any TypeScript-era writer would naturally
  // produce -- IS parsed by strftime and lands in the right month, so a table
  // holding both spellings charts correctly rather than splitting. Pinned
  // because it is the reason the previous test's NULL bucket is a data problem
  // and not a format-migration problem.
  it("reads an ISO-8601 delivery_datetime into the same month as the Django spelling", async () => {
    seedOrder({ id: 1, deliveryDatetime: "2024-03-01 09:00:00.000000", noItems: 4 });
    seedOrder({ id: 2, deliveryDatetime: "2024-03-15T10:30:00.000Z", noItems: 6 });

    expect(chartMonths(await body("/dashboard/deliveries/items/"))).toBe("'2024-03'");
    expect(chartValues(await body("/dashboard/deliveries/items/"))).toBe("10");
  });

  // One statement per request, and it is the projected aggregate rather than a
  // `SELECT *` the handler then counts in JavaScript. `orders` is the largest
  // table this site has; the difference between these two is the whole table's
  // rows crossing the D1 wire on every dashboard hit.
  it("issues exactly one aggregate query per render", async () => {
    seedTwoMonths();

    await get("/dashboard/deliveries/weight/");

    expect(prepared).toEqual([
      "SELECT strftime('%Y-%m', delivery_datetime) AS the_month, SUM(weight) / 1000 AS count FROM orders GROUP BY the_month ORDER BY the_month",
    ]);
  });
});

// ===========================================================================
// Routing, methods and locale
// ===========================================================================

describe("gfdashDeliveries -- routing", () => {
  beforeEach(seedTwoMonths);

  // gfdash is registered OUTSIDE i18n_patterns in Django (givefood/urls.py's
  // "Untranslated apps" block), and index.ts:542-544's comment says the port
  // deliberately does not run this family through its locale loop. So the
  // three non-English prefixes are 404s, not translated dashboards -- if a
  // future refactor folds these routes into the loop, /cy/ starts answering
  // and the canonical link tags multiply.
  it.each(["cy", "ga", "gd"])("404s the /%s/ locale prefix -- gfdash is outside i18n_patterns", async (locale) => {
    expect((await get(`/${locale}/dashboard/deliveries/count/`)).status).toBe(404);
  });

  // Django's re_path ends in `/$`; the slashless spelling was an APPEND_SLASH
  // redirect, not a second route. Pinned with the exact target because a
  // redirect that dropped the metric, or that 302'd instead of 301'ing, would
  // still "work" in a browser and quietly cost the page its ranking.
  it("redirects the slashless url permanently to the trailing-slash one", async () => {
    const res = await get("/dashboard/deliveries/count");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/dashboard/deliveries/count/`);
  });

  // Registered with app.get, so a POST is not a 405 with an Allow header but a
  // plain 404 -- Django's URLconf behaved the same way, since a view reached
  // by POST here would simply have rendered. Pinned as the current contract:
  // this is a read-only dashboard and nothing about it should ever accept a
  // write, so a day when POST starts returning 200 is a day to look closely.
  it.each(["POST", "PUT", "DELETE", "PATCH"])("404s a %s and touches the database not at all", async (method) => {
    const res = await get("/dashboard/deliveries/count/", method);

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // HEAD does reach the handler (Hono answers HEAD from the GET route), so the
  // query runs and the headers are the real ones -- with the body stripped.
  it("answers HEAD with the GET headers and an empty body", async () => {
    const res = await get("/dashboard/deliveries/count/", "HEAD");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toBe("");
  });
});

// ===========================================================================
// pageContext() -- the module's other, quieter half
// ===========================================================================

describe("gfdashDeliveries -- page context", () => {
  beforeEach(seedTwoMonths);

  // buildPageContext({ path: c.req.path }) -- what this module supplies is
  // c.req.PATH, and this is the test that says so. THE MUTANT IT KILLS is
  // `path: c.req.url`, which is a one-word edit, produces a page that looks
  // completely normal, and emits
  // `<link rel="canonical" href="https://www.givefood.org.uk https://www.
  // givefood.org.uk/dashboard/...?utm_source=newsletter">` -- a doubled
  // origin and a separate canonical for every tracking parameter anyone ever
  // appends. (Excluding the querystring is buildPageContext's own doing, not
  // this module's; asserted here because c.req.path is where it starts.)
  it("gives each metric its own canonical, built from the path and not the full url", async () => {
    const withQs = await body("/dashboard/deliveries/calories/?utm_source=newsletter");

    expect(withQs).toContain(`<link rel="canonical" href="${ORIGIN}/dashboard/deliveries/calories/">`);
    expect(await body("/dashboard/deliveries/count/")).toContain(`<link rel="canonical" href="${ORIGIN}/dashboard/deliveries/count/">`);
  });

  // render_time_ms: elapsedMs(c), which reads the start time serverTiming
  // recorded. WHOLE MILLISECONDS, and a DELIBERATE divergence from Django's
  // three decimal places -- serverTiming.ts explains why (Workers coarsens
  // timers, so the fraction was always exactly ".000", which reads like
  // precision and is not). If pageContext ever stopped merging this in, the
  // comment would render "Took ms" and nobody would ever see it; the regex
  // below requires a digit, and rejects a decimal point.
  it("stamps a whole-millisecond render time into the debug comment", async () => {
    const html = await body("/dashboard/deliveries/count/");

    expect(html).toMatch(/⏱️ Took \d+ms\n/);
    expect(html).not.toMatch(/⏱️ Took [\d.]*\.\d+ms/);
  });

  // The Server-Timing header keeps its decimals -- the same divergence, the
  // other way round, and the pair only makes sense asserted together.
  it("keeps the fractional render duration in the Server-Timing header", async () => {
    const res = await get("/dashboard/deliveries/count/");

    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=\d+\.\d{3}$/);
  });

  // The dashboards fall through pageCacheControl's default family to
  // s-maxage=86400, matching @cache_page(SECONDS_IN_DAY) at views.py:393,
  // with the browser deliberately held to five minutes. The middleware owns
  // this rule and tests it in full; asserted here only so that a route-level
  // header added later cannot silently shadow it.
  it("is cacheable for a day at the edge and five minutes in the browser", async () => {
    const res = await get("/dashboard/deliveries/count/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Content-Language")).toBe("en");
  });
});
