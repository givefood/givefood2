import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/charityIncomeExpenditure.ts -- gfdash's
// `charity_income_expenditure` (gfdash/views.py:437-446 in the Django repo,
// read alongside this file), served at /dashboard/charity-income-expenditure/.
//
// WHY THIS FILE EXISTS. The handler is six lines, and every one of the ways it
// can be wrong produces a 200 and a chart:
//
//   * `five_years_ago` is computed HERE, not in SQL -- `new Date().getUTCFullYear() - 5`
//     is the only bound parameter the query ever gets. Off by one and the page
//     silently gains or loses a whole year's bar; the SQL text is unchanged, so
//     packages/db/src/dashboards.test.ts (which passes its own literal 2021)
//     cannot see it. That arithmetic is asserted here on the value that
//     actually reached the engine, at three different system times.
//   * the page mixes two orderings of the SAME list on purpose: the table is
//     newest-year-first (the query's ORDER BY year DESC) and the echarts
//     series are `years | reverse`, oldest-first. Swap either and the chart
//     still draws -- with the bars in the wrong order against a correct axis,
//     or a correct chart under a table that reads backwards.
//   * the query's two exclusions (charity_just_foodbank, and the five-year
//     floor) are the difference between "food bank charity income" and "any
//     charity that happens to run a food bank", and a parent church or trust's
//     accounts dwarf a food bank's -- so a lost filter does not look like a
//     bug, it looks like a bigger chart.
//
// REAL EVERYTHING, the harness routes/public.test.ts uses: the real production
// app (workers/site/src/index.ts's default export), so the route registration,
// resolveLanguage, cacheTag and pageCacheControl are the shipped articles and
// not a hand-built router; the real Nunjucks templates through the real
// render(), so `(so far)`, the `| reverse` and the intcomma-formatted cells
// are the ones production emits; and real in-memory SQLite built by
// schemaFor() from the real migrations, so `charityyear`'s nullable
// income/expenditure/date are nullable here too. Mocked: the two KV
// namespaces, because there is no local double, and nothing on this path
// touches them.
//
// MUTATION-TESTED in a copy of the repo outside it (see the note at the foot
// of this file for the list) -- that is the evidence these assertions are
// load-bearing rather than decorative.

const ORIGIN = "https://www.givefood.org.uk";
const PATH = "/dashboard/charity-income-expenditure/";

// Tuesday 8 September 2026, mid-morning UTC -- so the five-year floor is 2021
// and every fixture year below is positioned relative to that. Date only:
// elapsedMs() reads performance.now(), which must stay real for the debug
// comment's "Took Nms" to be a number at all.
const NOW = new Date("2026-09-08T09:30:00.000Z");

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text AND the values bound to
// it. The binding is the load-bearing half here -- `sinceYear` is computed in
// the handler and appears nowhere in the SQL text, so it is invisible on the
// page unless a fixture happens to straddle the boundary.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite.
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

function env(): AppEnv["Bindings"] {
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
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns this query reads are parameterised; the rest are
// whatever the real migration insists on, so a seeded row is one production
// would have accepted.
// ---------------------------------------------------------------------------

function seedFoodbank(id: number, slug: string, justFoodbank: 0 | 1): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, network,
       charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative,
       is_closed, no_locations, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79', 'Trussell Trust',
       ?, ?, ?, ?, 0, 0, 0, 14, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    id,
    String(id).padStart(32, "a"),
    `Foodbank ${id}`,
    slug,
    justFoodbank,
    `info@${slug}.invalid`,
    `https://${slug}.invalid/`,
    `https://${slug}.invalid/list/`,
  );
}

// charityyear.date is a Django DateField -- "YYYY-MM-DD", no time part -- and
// income/expenditure are nullable INTEGERs (migration 0005). Both facts are
// exercised below rather than assumed away by the fixture.
function seedCharityYear(o: { id: number; foodbankId: number | null; date: string | null; income?: number | null; expenditure?: number | null }): void {
  db.prepare("INSERT INTO charityyear (id, foodbank_id, created, date, income, expenditure) VALUES (?, ?, '2026-01-01 00:00:00.000000', ?, ?, ?)").run(
    o.id,
    o.foodbankId,
    o.date,
    o.income ?? null,
    o.expenditure ?? null,
  );
}

// THE FIXTURE IS THE TEST: every row here exists to turn exactly one rule on
// or off relative to its neighbour, and each excluded row is stamped with an
// income large enough that including it would be unmistakable in the totals.
//
//   1 alpha   charity_just_foodbank = 1  -- the real subject
//   2 bravo   charity_just_foodbank = 1  -- proves years sum ACROSS food banks
//   3 church  charity_just_foodbank = 0  -- the parent charity that must not count
function seed(): void {
  seedFoodbank(1, "alpha", 1);
  seedFoodbank(2, "bravo", 1);
  seedFoodbank(3, "church", 0);

  // Included. 2024 is two rows with two different year-ends, which is what
  // makes "GROUP BY the extracted year" distinguishable from "GROUP BY date".
  seedCharityYear({ id: 1, foodbankId: 1, date: "2024-03-31", income: 1_234_567, expenditure: 900_000 });
  seedCharityYear({ id: 2, foodbankId: 2, date: "2024-12-31", income: 2_000, expenditure: 1_500 });
  seedCharityYear({ id: 3, foodbankId: 1, date: "2025-03-31", income: 40_000, expenditure: 30_000 });
  // 2021 is the floor itself (2026 - 5), inclusive -- Django's
  // `date__year__gte=five_years_ago`.
  seedCharityYear({ id: 4, foodbankId: 1, date: "2021-01-01", income: 7, expenditure: 3 });

  // Excluded, one row per rule.
  seedCharityYear({ id: 5, foodbankId: 1, date: "2020-12-31", income: 8_000_000, expenditure: 8_000_000 }); // one day under the floor
  seedCharityYear({ id: 6, foodbankId: 3, date: "2024-03-31", income: 9_000_000, expenditure: 9_000_000 }); // the parent charity
  seedCharityYear({ id: 7, foodbankId: 999, date: "2024-03-31", income: 9_000_000, expenditure: 9_000_000 }); // orphan FK -- D1 declares none
  seedCharityYear({ id: 8, foodbankId: null, date: "2024-03-31", income: 9_000_000, expenditure: 9_000_000 }); // no food bank at all
  seedCharityYear({ id: 9, foodbankId: 1, date: null, income: 9_000_000, expenditure: 9_000_000 }); // no date
  seedCharityYear({ id: 10, foodbankId: 1, date: "31/03/2024", income: 9_000_000, expenditure: 9_000_000 }); // unparseable date
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(schemaFor("foodbank", "charityyear"));
  prepared = [];
  sessions = 0;
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
// Reading the rendered page. The table and the three echarts arrays are the
// whole page; everything below talks in their VALUES rather than in HTML.
// ---------------------------------------------------------------------------

// Every <tr> after the header row, as [year cell, income cell, expenditure
// cell] with whitespace collapsed -- the year cell keeps its "(so far)" span,
// because which row carries it is one of the things being asserted.
function tableRows(body: string): string[][] {
  const start = body.indexOf('<table class="table is-striped is-narrow is-fullwidth">');
  if (start === -1) throw new Error("no dashboard table in the rendered page");
  const table = body.slice(start, body.indexOf("</table>", start));
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((row) => [...(row[1] as string).matchAll(/<td>([\s\S]*?)<\/td>/g)].map((cell) => (cell[1] as string).replace(/\s+/g, " ").trim()))
    .filter((cells) => cells.length > 0);
}

// One `data: [ ... ]` literal out of the inline echarts config, split on
// commas exactly as written. NOT JSON.parse'd and not trimmed of empties: an
// element the template rendered as nothing is the interesting case (see the
// NULL test below), and parsing would hide it.
function chartArray(body: string, after: RegExp): string[] {
  const anchor = body.search(after);
  if (anchor === -1) throw new Error(`no ${after} in the rendered page`);
  const open = body.indexOf("data: [", anchor) + "data: [".length;
  const inner = body.slice(open, body.indexOf("]", open));
  if (inner.trim() === "") return [];
  return inner.split(",").map((value) => value.trim());
}

// The two series anchors match `name` AND `type` together, because the legend
// higher up the same config has its own `data: ['Income', 'Expenditure']` and
// a bare "Income" would find that instead -- which would pass, silently
// asserting the legend twice and the series never.
const axisYears = (body: string) => chartArray(body, /xAxis:/);
const incomeSeries = (body: string) => chartArray(body, /name: 'Income',\s*type: 'bar'/);
const expenditureSeries = (body: string) => chartArray(body, /name: 'Expenditure',\s*type: 'bar'/);

describe("gfdashCharityIncomeExpenditure -- GET /dashboard/charity-income-expenditure/", () => {
  // ---------------------------------------------------------------------
  // The five-year floor. This is the only thing the handler itself computes.
  // ---------------------------------------------------------------------

  // ONE STATEMENT, ONE SESSION, ONE BINDING. `sinceYear` never appears in the
  // SQL text, so this is the only place a change to `- 5` is visible without
  // a fixture that happens to straddle the boundary. The session count is not
  // decoration either: lib/session.ts opens exactly one
  // withSession("first-unconstrained") per request so a page's reads see one
  // consistent snapshot of a replicated database, and a handler that opened
  // its own would still render this page perfectly.
  it("asks for the years since (this UTC year - 5), as the single bound parameter of a single statement", async () => {
    seed();

    await get(PATH);

    expect(sessions).toBe(1);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.params).toEqual([2021]);
    // The SQL is packages/db's, and packages/db/src/dashboards.test.ts owns
    // its row-level behaviour; matched here only far enough to prove the
    // route reaches getCharityYearAggregates rather than some other query.
    // Deliberately not the whole statement: pinning its exact text here would
    // fail this suite for a rewrite of that query that changed nothing this
    // page can see (an INNER JOIN to a LEFT JOIN, say, which the exclusions
    // below make equivalent).
    expect(prepared[0]?.sql).toContain("FROM charityyear cy");
  });

  // THE YEAR BOUNDARY, both sides of it. `new Date().getUTCFullYear()` moves
  // at the instant UTC midnight on 1 January passes, and nothing else about
  // the page changes then -- so a handler that had cached the year, or read
  // it from a different clock, would go a whole year unnoticed.
  //
  // NOT a test of getUTCFullYear() vs getFullYear(): vitest.config.mts pins
  // TZ=UTC for the whole suite (deliberately -- the Workers runtime is UTC),
  // so the two agree here by construction and this pins the arithmetic, not
  // the UTC-ness. The module's own comment is the record of why it is UTC.
  it("moves the floor forward at UTC new year, not before it", async () => {
    vi.setSystemTime(new Date("2025-12-31T23:59:59.999Z"));
    await get(PATH);
    expect(prepared[0]?.params).toEqual([2020]);

    prepared = [];
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await get(PATH);
    expect(prepared[0]?.params).toEqual([2021]);
  });

  // ---------------------------------------------------------------------
  // The table. Values, not shape.
  // ---------------------------------------------------------------------

  // The whole fixture in one assertion, because the excluded rows are the
  // point: six of the ten charity years seeded must not appear, each stamped
  // with 9,000,000 (or 8,000,000, under the floor) so that any of them
  // leaking would land in a cell here rather than merely nudging a total.
  //
  // 2024 is 1,234,567 + 2,000 across two food banks with two different
  // year-end dates: grouped by the raw date instead of the extracted year,
  // this table would sprout a row per charity year-end.
  it("renders one row per year, newest first, summed across food banks and formatted with intcomma", async () => {
    seed();

    expect(tableRows(await getBody(PATH))).toEqual([
      ['2025 <span class="is-size-7">(so far)</span>', "£40,000", "£30,000"],
      ["2024", "£1,236,567", "£901,500"],
      ["2021", "£7", "£3"],
    ]);
  });

  // "(so far)" IS UNCONDITIONAL ON THE FIRST ROW, and that is faithful to
  // Django rather than a port bug: the original template computes
  // `{% now "Y" as current_year %}` at the top and then never reads it,
  // labelling `forloop.first` instead. So the newest year present is called
  // "(so far)" even when it is a closed year and the real current year has no
  // data at all -- which is exactly the state this fixture is in (2026 is
  // missing, and 2025 wears the label).
  it("labels the newest row (so far) even when that year is over", async () => {
    seedFoodbank(1, "alpha", 1);
    seedCharityYear({ id: 1, foodbankId: 1, date: "2022-03-31", income: 10, expenditure: 5 });

    expect(tableRows(await getBody(PATH))).toEqual([['2022 <span class="is-size-7">(so far)</span>', "£10", "£5"]]);
  });

  // ---------------------------------------------------------------------
  // The chart. Same rows, opposite order.
  // ---------------------------------------------------------------------

  // THE TABLE AND THE CHART DISAGREE ON PURPOSE. `years` arrives newest-first
  // and the three echarts arrays each re-walk it through `| reverse`, so the
  // x axis reads left-to-right in time. Dropping the filter leaves a chart
  // that still renders, with the years running backwards -- and the year
  // labels reversed alongside the values, so the bars stay attached to the
  // right labels and only the direction of time is wrong. Nothing about that
  // looks broken; it is why all three arrays are asserted, in order, against
  // the table's own order above.
  it("feeds the echarts series oldest-first, the reverse of the table", async () => {
    seed();
    const body = await getBody(PATH);

    expect(axisYears(body)).toEqual(["'2021'", "'2024'", "'2025'"]);
    expect(incomeSeries(body)).toEqual(["7", "1236567", "40000"]);
    expect(expenditureSeries(body)).toEqual(["3", "901500", "30000"]);
  });

  // The chart prints the raw integers while the table prints them through
  // intcomma. Both come from the same `years`, so a filter applied one level
  // too high would put "1,236,567" into a JavaScript array literal and break
  // the whole config -- silently, since a syntax error in an inline <script>
  // is invisible server-side and leaves an empty chart div on the page.
  it("keeps the series unformatted -- no thousands separators inside the JS literal", async () => {
    seed();
    const body = await getBody(PATH);

    expect(incomeSeries(body).some((value) => value.includes(","))).toBe(false);
    expect(body).toContain("£1,236,567");
  });

  // ---------------------------------------------------------------------
  // Empty and NULL.
  // ---------------------------------------------------------------------

  // A brand-new database, or a five-year window with nothing in it, must not
  // 500 -- and getCharityYearAggregates returns [] rather than null for it, so
  // the template's `{% for %}` simply produces nothing. The header row of the
  // table survives, which is what tells the difference between "no data" and
  // "the table did not render".
  it("renders an empty table and empty series rather than failing when no year qualifies", async () => {
    seedFoodbank(1, "alpha", 1);
    seedCharityYear({ id: 1, foodbankId: 1, date: "2019-03-31", income: 5_000_000, expenditure: 5_000_000 });

    const res = await get(PATH);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(tableRows(body)).toEqual([]);
    expect(body).toContain("<th>Year</th>");
    expect(axisYears(body)).toEqual([]);
    expect(incomeSeries(body)).toEqual([]);
  });

  // SUM() SKIPS NULLS, so a year with one populated row and one empty one
  // reports the populated figure rather than nothing -- the ordinary case
  // while a charity's accounts are half-entered, and worth pinning because
  // COALESCE'ing the column instead would look identical here and differ in
  // the all-NULL case below.
  it("sums past a NULL income within a year", async () => {
    seedFoodbank(1, "alpha", 1);
    seedFoodbank(2, "bravo", 1);
    seedCharityYear({ id: 1, foodbankId: 1, date: "2024-03-31", income: 100, expenditure: 90 });
    seedCharityYear({ id: 2, foodbankId: 2, date: "2024-03-31", income: null, expenditure: null });

    expect(tableRows(await getBody(PATH))).toEqual([['2024 <span class="is-size-7">(so far)</span>', "£100", "£90"]]);
  });

  // SUSPECT, PINNED AS-IS. When EVERY row in a year has a NULL income the sum
  // is NULL, and the two renderings disagree about what that means: intcomma
  // stringifies it, so the table cell reads the literal "£null", while the
  // chart's bare `{{ year.income }}` renders nothing at all and leaves a hole
  // in the JavaScript array -- here a trailing comma, so the Income series
  // comes out one element SHORTER than the x axis and the year silently loses
  // its bar. Django's own intcomma would have raised instead
  // (django.contrib.humanize returns the input unchanged for a non-number, so
  // it renders "None"), so this is a divergence in spelling, not in kind: both
  // put a placeholder word where a number belongs. Reported, not fixed --
  // asserting the wish would leave the suite red and tell nobody anything.
  it("renders a wholly-NULL year as '£null' in the table and as a hole in the chart", async () => {
    seedFoodbank(1, "alpha", 1);
    seedCharityYear({ id: 1, foodbankId: 1, date: "2024-03-31", income: 500, expenditure: 400 });
    seedCharityYear({ id: 2, foodbankId: 1, date: "2025-03-31", income: null, expenditure: null });

    const body = await getBody(PATH);

    expect(tableRows(body)).toEqual([['2025 <span class="is-size-7">(so far)</span>', "£null", "£null"], ["2024", "£500", "£400"]]);
    expect(axisYears(body)).toEqual(["'2024'", "'2025'"]);
    // Two axis labels, one datum plus an empty slot: `[500, ]` is a
    // one-element array in JavaScript, not a two-element one with a gap.
    expect(incomeSeries(body)).toEqual(["500", ""]);
    expect(expenditureSeries(body)).toEqual(["400", ""]);
  });

  // A year AHEAD of today still charts, because the query has an inclusive
  // floor and no ceiling -- exactly as Django's `date__year__gte` does. A
  // mistyped year-end in the admin therefore adds a bar to the right of the
  // real data and takes the "(so far)" label off the current year, and this
  // is the ported behaviour rather than an oversight.
  it("does not exclude a year in the future", async () => {
    seedFoodbank(1, "alpha", 1);
    seedCharityYear({ id: 1, foodbankId: 1, date: "2025-03-31", income: 100, expenditure: 90 });
    seedCharityYear({ id: 2, foodbankId: 1, date: "2099-03-31", income: 1, expenditure: 1 });

    expect(tableRows(await getBody(PATH)).map((cells) => cells[0])).toEqual(['2099 <span class="is-size-7">(so far)</span>', "2025"]);
  });

  // ---------------------------------------------------------------------
  // The response envelope, and the page around the data.
  // ---------------------------------------------------------------------

  // A DELIBERATE DIVERGENCE, PINNED SO IT STAYS DELIBERATE. Django's
  // charity_income_expenditure carries @cache_page(SECONDS_IN_HOUR);
  // middleware/pageCacheControl.ts lists only the home page, /news/ and the
  // country pages as hourly and everything else falls through to a day, so
  // this page is shared-cached for 24h rather than 1h. It is also given no
  // Cache-Tag (middleware/cacheTag.ts has no rule for /dashboard/), so
  // queues/cachePurge.ts cannot shorten that when a charity's accounts are
  // re-crawled: this page is stale-until-TTL by design. Both halves are
  // asserted because either changing quietly would change how long the site
  // shows last year's figures.
  it("serves cacheable, untagged HTML in English", async () => {
    seed();
    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // buildPageContext + elapsedMs, the two halves of pageContext(). The debug
  // comment in includes/debugcomment.njk is the only consumer of
  // render_time_ms, and with the key missing it renders "Took ms" -- a page
  // that still looks perfect. `Took \d+` also pins the whole-millisecond
  // rounding elapsedMs() does deliberately (see its comment: three digits of
  // guaranteed ".000" read like precision that Workers' coarsened timers
  // cannot supply).
  it("puts the canonical URL, the flag link and a numeric render time on the page", async () => {
    seed();
    const body = await getBody(PATH);

    expect(body).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
    expect(body).toContain(`<a href="/flag/#${ORIGIN}${PATH}"`);
    expect(body).toMatch(/⏱️ Took \d+ms/);
    // The bare "&" is literal template text, not a variable, so neither
    // nunjucks' autoescape nor Django's touches it -- the two render the same
    // technically-invalid HTML here, and pinning it keeps a well-meaning
    // "fix" to one of them from silently diverging from the other.
    expect(body).toContain("<title>Food bank charity income & expenditure - Give Food</title>");
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block, outside
  // i18n_patterns -- so there is no /cy/dashboard/... URL, and the page
  // advertises no hreflang alternates (buildPageContext is called without a
  // locale, which is what leaves `languages` empty). A route registered
  // under the LOCALES loop by mistake would 200 here.
  it("has no language-prefixed form and offers no translations", async () => {
    seed();

    const welsh = await get(`/cy${PATH}`);
    expect(welsh.status).toBe(404);
    // Nothing was read for it either -- the 404 is the router's, not a
    // rendered-then-discarded page.
    expect(prepared).toHaveLength(0);

    expect(await getBody(PATH)).not.toContain('rel="alternate" hreflang');
  });

  // GET ONLY. The handler is read-only, so a POST reaching it would be
  // harmless today -- but the route is registered with app.get() and this
  // asserts the router actually enforces that, which is the check that stops
  // an app.all() creeping in later (this repo has already shipped a GET route
  // able to run an UPDATE). The query count is what makes the assertion mean
  // "the handler did not run" rather than "the response was a 404".
  it("does not answer POST at all", async () => {
    seed();

    const res = await get(PATH, { method: "POST" });

    expect(res.status).toBe(404);
    expect(prepared).toHaveLength(0);
    expect(sessions).toBe(0);
  });

  // Django's APPEND_SLASH, via lib/appendSlash.ts. Worth pinning here because
  // gfdash/urls.py registers this path WITH the slash and every inbound link
  // uses it, so the unslashed form only ever arrives hand-typed -- and the
  // 301 costs a full render of the page (the redirect probes by re-fetching
  // the slashed URL with HEAD, which runs the handler and the query) rather
  // than being a pure path rewrite.
  it("301s the unslashed URL onto the canonical one", async () => {
    seed();

    const res = await get("/dashboard/charity-income-expenditure");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
  });

  // The querystring is dropped from `flag_path` because pageContext() passes
  // only `c.req.path` to buildPageContext (no `querystring`), unlike the
  // routes that do. Pinned rather than filed: this page takes no query
  // parameters, so the only thing a query can do is arrive from a tracking
  // link, and the flag link points at the page rather than at the link that
  // reached it. Every other gfdash handler is written the same way.
  it("ignores the querystring entirely, including in the flag link", async () => {
    seed();

    const body = await getBody(`${PATH}?utm_source=newsletter`);

    expect(body).toContain(`<a href="/flag/#${ORIGIN}${PATH}"`);
    expect(body).not.toContain("utm_source");
    expect(prepared[0]?.params).toEqual([2021]);
  });
});

// ===========================================================================
// MUTATION TESTING, run in a copy of this repo under the scratchpad -- never
// against a source file in the working tree. Each mutant was applied alone and
// this file re-run; the count is how many of the 16 tests above went red.
//
// In charityIncomeExpenditure.ts itself:
//   `- 5` -> `- 4`                                          5 failed
//   `- 5` -> `- 6`                                           5 failed
//   `new Date().getUTCFullYear()` -> `2026`                  1 failed (the
//                                                            UTC-new-year test,
//                                                            which exists for
//                                                            exactly this)
//   a second `dbSession(c)` per request                      1 failed
//   `years` -> `years.slice().reverse()`                     4 failed
//   context key `years` -> `rows`                            7 failed
//   `render_time_ms` dropped from pageContext()              1 failed
//   template -> "dash/index.njk"                             9 failed
//   pageTranslatable + locale added to buildPageContext      1 failed
//
// In the shared query (packages/db/src/dashboards.ts), to prove the excluded
// fixture rows above are doing work rather than sitting there:
//   `charity_just_foodbank = 1` dropped                      3 failed
//   `>=` -> `>` on the five-year floor                       2 failed
//   ORDER BY year DESC -> ASC                                4 failed
//   income and expenditure swapped in the SELECT list        5 failed
//
// ONE SURVIVOR, recorded rather than papered over: adding `locale: "en"` to
// buildPageContext() alone changes no byte of the page, because both the
// hreflang block and includes/langswitcher.njk are gated on
// `page_translatable`, which stays false. It is an equivalent mutant, not a
// gap -- the version that also flips pageTranslatable is the one above, and
// it dies.
