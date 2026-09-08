import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/weeklyItemcountYear.ts -- GET
// /dashboard/items-requested-weekly/by-year/, the public "Items requested by
// UK food banks per week per year" chart. Ported from gfdash/views.py:46-80
// (`@cache_page(SECONDS_IN_DAY) def weekly_itemcount_year`), registered at
// gfdash/urls.py:10 and at workers/site/src/index.ts:547.
//
// WHY THIS FILE EXISTS. The handler holds the only arithmetic on the page, and
// every way it can be wrong renders a 200 with a plausible chart:
//
//   * THE WEEK KEY IS BUILT HERE, not in SQL. packages/db hands over raw
//     (change_text, created) pairs precisely because SQLite's strftime('%W')
//     is not ISO 8601 (dashboards.ts:6-11), so the bucketing, the sentinel
//     handling in no_items() and the year-boundary quirk all live in this
//     module. packages/db/src/dashboards.test.ts cannot see any of it -- it
//     asserts the rows, not the buckets.
//   * THE YEAR AXIS IS COMPUTED FROM THE CLOCK. `years` runs 2020..this UTC
//     year and appears nowhere in the query; get it wrong and the page loses
//     (or invents) a whole series with nothing else on the page changing.
//   * THE CHART IS THE ARTIFACT, THE TABLE IS THE FOOTNOTE, and they are fed
//     from two DIFFERENT structures -- `week_year_needs` (53 x N grid, week
//     order) and `week_needs_items_desc` (insertion order, reversed). One can
//     be right while the other is silently empty; nunjucks is configured with
//     throwOnUndefined: false (packages/templates/src/env.ts), so a renamed
//     context key renders as nothing at all rather than failing.
//   * THE SIBLING PAGE SHARES THE TABLE VARIABLE. dash/weekly_itemcount.njk
//     and dash/weekly_itemcount_year.njk both loop `week_needs_items_desc`,
//     so a template swapped for its sibling produces an IDENTICAL table and
//     merely loses the chart's legend and its per-year series. Nothing below
//     relies on the table to tell those two templates apart.
//
// REAL EVERYTHING, the harness routes/dashboards/beanPastaIndex.test.ts and
// charityIncomeExpenditure.test.ts use: the real production app (the default
// export of workers/site/src/index.ts, so the real router, appendSlash probe,
// pageCacheControl and cacheTag), the real Nunjucks templates through the real
// render(), the real getPublishedNeedsForWeeklyCount, and real in-memory
// SQLite built by schemaFor() from the real migrations. Mocked: only the two
// KV namespaces, because there is no local double and nothing on this path
// touches them.
//
// THE ISO WEEK NUMBERS BELOW WERE CROSS-CHECKED AGAINST CPYTHON. Every
// "YYYY-week" string this file expects was printed by
// `datetime.fromisoformat(s)` -> `"%s-%s" % (d.year, d.isocalendar()[1])` on
// CPython 3.13.0 on this machine, and all thirteen matched lib/isoWeek.ts.
// That is what makes the year-boundary assertions below parity claims rather
// than a restatement of the TypeScript.
//
// MUTATION-TESTED in a copy of the repo under the scratchpad, never by editing
// a file in src/ and putting it back -- see the note at the foot of this file.

const ORIGIN = "https://www.givefood.org.uk";
// Hardcoded rather than read from @givefood/urls, so the string here and the
// one in index.ts are two independent copies: a rename that touched only one
// of them is exactly what this is guarding. Django spells the path with
// hyphens (gfdash/urls.py:10) and the reverse name with underscores.
const PATH = "/dashboard/items-requested-weekly/by-year/";

// Tuesday 8 September 2026, mid-morning UTC. Fixed so `years` is a known
// 2020..2026 -- the handler's `new Date().getUTCFullYear()` is the only clock
// read on the page, and a floating "current year" would make every legend
// assertion below rot on 1 January. Date only: elapsedMs() reads
// performance.now(), which must stay real for the debug comment's "Took Nms"
// to be a number at all.
const NOW = new Date("2026-09-08T09:30:00.000Z");

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine. This page's whole cost argument is
// "one unparameterised SELECT, once per view, no writes", and the log is the
// only place that is observable -- a rendered chart looks the same whether it
// took one query or four.
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
        // Present, not omitted: a test proving this GET writes nothing must
        // not be leaning on writes being impossible in the fixture.
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

// Only the one table the statement names -- getPublishedNeedsForWeeklyCount
// reads `foodbankchange` itself, not the foodbankchange_full VIEW its
// excess-page sibling uses. From the real migrations via schemaFor() rather
// than hand-written DDL: migration 0019 does `ALTER TABLE foodbankchange DROP
// COLUMN foodbank_name` long after 0001 created it, and a fixture typed out by
// hand tests the author's memory of that rather than the shipped schema.
const SCHEMA = schemaFor("foodbankchange");

let db: DatabaseSync;
let prepared: Prepared[];
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
        return d1Session(db, prepared);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// A NO-OP THAT EARNS ITS KEEP, borrowed from packages/db/src/dashboards.test.ts.
// Every timestamp below is in DJANGO'S shape -- "YYYY-MM-DD HH:MM:SS.ffffff",
// what str(datetime) produces and what migration 0022 normalised the whole
// database to. Wrapping the normal shape makes the two literals deliberately
// left in other shapes (the ISO one and the unreadable one, both in the
// "timestamps the page cannot read" block) stand out as the anomalies they are.
const PY = (value: string) => value;

function seedChange(row: Record<string, Bindable> = {}): void {
  const n = (nextId += 1);
  const full: Record<string, Bindable> = {
    id: n,
    // 32 dashless hex characters, the real width -- the column carries a
    // UNIQUE index, so a lazy constant would collide on the second row and the
    // fixture would silently be one row smaller than it reads.
    need_id: `${String(n).padStart(2, "0")}dead4beefcafe`.padEnd(32, "f"),
    foodbank_id: null,
    change_text: "Beans",
    published: 1,
    input_method: "scrape",
    created: PY("2024-01-01 12:00:00.000000"),
    modified: PY("2024-01-01 12:00:00.000000"),
    ...row,
  };
  const columns = Object.keys(full);
  db.prepare(`INSERT INTO foodbankchange (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((c) => full[c] as Bindable),
  );
}

// THE FIXTURE IS THE TEST. Every row exists to turn exactly one rule on or off
// relative to its neighbour, and the two excluded rows are five items each in
// weeks that appear NOWHERE in the expected output -- so a leak shows up as an
// extra row and an extra bar rather than as a count one too high, which is much
// harder to miss. The week key each row lands in was confirmed in CPython (see
// the header); the comment on each line is that key.
//
// The `no_items()` counts are deliberately asymmetric (1, 3, 1, 2, 1, 2+1, 0):
// a handler that counted NEEDS instead of ITEMS, or that summed the whole table
// into one bucket, produces a differently-shaped page rather than the same page
// with one number out.
function seedTheYears(): void {
  seedChange({ change_text: "Beans", created: PY("2020-01-02 09:00:00.000000") }); // 2020-1, 1 item
  seedChange({ change_text: "Beans\nPasta\nRice", created: PY("2020-01-06 09:00:00.000000") }); // 2020-2, 3 items

  // THE YEAR BOUNDARY, both sides of it. 28 December 2020 and 1 January 2021
  // are the SAME ISO week (2020-W53), but Django keys on the plain calendar
  // year, so they land in two different buckets a whole year apart --
  // "2020-53" and "2021-53" -- and ISO 2021 has no week 53 at all. Reproduced
  // verbatim, quirk included (lib/isoWeek.ts:1-9); a "fix" to a self-consistent
  // ISO year+week pair would move needs between the chart's series.
  seedChange({ change_text: "Soup", created: PY("2020-12-28 09:00:00.000000") }); // 2020-53, 1 item
  seedChange({ change_text: "Soup\nTea", created: PY("2021-01-01 09:00:00.000000") }); // 2021-53, 2 items
  seedChange({ change_text: "Milk", created: PY("2021-01-04 00:00:00.000000") }); // 2021-1, 1 item

  // THE OTHER HALF OF THE SAME QUIRK, and the one that silently merges data:
  // 30 December 2024 is ISO week 1 (of 2025) but calendar year 2024, so it is
  // keyed "2024-1" and ADDS ITSELF to the needs from the previous January.
  // Two needs a year apart in one bucket, in both Django and the port.
  seedChange({ change_text: "Beans\nPasta", created: PY("2024-01-01 12:00:00.000000") }); // 2024-1, 2 items
  seedChange({ change_text: "Rice", created: PY("2024-12-30 09:00:00.000000") }); // 2024-1, 1 item

  // THE SENTINEL. no_items() returns 0 for "Unknown"/"Nothing"
  // (givefood/models/needs.py:93-97), but the bucket is still CREATED, because
  // Django writes `week_needs[key] = week_needs.get(key, 0) + 0`. So this week
  // appears in the table with a zero beside it -- absence and zero are
  // different states on this page, and only a row like this tells them apart.
  seedChange({ change_text: "Unknown", created: PY("2025-06-30 09:00:00.000000") }); // 2025-27, 0 items

  // EXCLUDED, one row per rule, five items each so a leak is unmistakable.
  // needcheck writes unpublished needs continuously, so counting them would
  // inflate every week on the chart rather than adding one visible bar.
  seedChange({ change_text: "A\nB\nC\nD\nE", published: 0, created: PY("2023-05-01 09:00:00.000000") }); // would be 2023-18
  // Before the 2020 floor Django's `created__gt=date(2020,1,1)` imposes. Note
  // its week key would be "2019-1" -- the same year-boundary carry as above,
  // so a lost floor shows up as a 2019 row the chart has no series for.
  seedChange({ change_text: "A\nB\nC\nD\nE", created: PY("2019-12-31 09:00:00.000000") }); // would be 2019-1
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepared = [];
  sessionModes = [];
  nextId = 0;
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
const body = async (path: string): Promise<string> => (await get(path)).text();

// ---------------------------------------------------------------------------
// Reading the rendered page. The table and the three families of echarts array
// ARE the page; everything below talks in their values rather than in markup.
// ---------------------------------------------------------------------------

// The <table> under the chart, as "year-week|count" pairs in document order.
// Parsed rather than matched as a slab of HTML so the claim stays on the data,
// while still pinning the exact strings and the order.
function tableRows(html: string): string[] {
  const table = /<table[\s\S]*?<\/table>/.exec(html);
  if (!table) throw new Error("no <table> in the rendered page");
  return [...table[0].matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/g)].map((m) => `${m[1]}|${m[2]}`);
}

// The legend's year list. Anchored on `legend: {` because the series below
// carry the same year strings in their `name:` fields, and a bare year search
// would find those instead -- passing while asserting nothing about the legend.
function legendYears(html: string): string[] {
  const block = /legend: \{\s*data: \[([\s\S]*?)\]/.exec(html);
  if (!block) throw new Error("no legend data array in the rendered chart");
  return [...block[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

// The x-axis categories -- the week numbers 1..53.
function axisWeeks(html: string): string[] {
  const block = /xAxis: \{[\s\S]*?data: \[([\s\S]*?)\]/.exec(html);
  if (!block) throw new Error("no xAxis data array in the rendered chart");
  return [...block[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

// Every bar series, keyed by the year in its `name:`, as the RAW JavaScript
// tokens between the commas rather than parsed numbers. Deliberately NOT
// filtered of empties: the template emits one comma per week and fills each
// slot from an inner `{% if year_data.year == year %}` loop, so a slot that
// matched nothing is an empty element -- a hole that shifts every later bar one
// week to the left. Parsing or trimming empties away would hide exactly that.
function seriesByYear(html: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of html.matchAll(/name: '(\d+)',\s*type: 'bar',\s*data: \[([\s\S]*?)\]/g)) {
    out[m[1]!] = m[2]!.split(",").map((value) => value.trim());
  }
  return out;
}

// A 53-slot expected series: zeros everywhere except the named weeks. Written
// this way so the assertion states the WHOLE row -- the empty weeks are the
// majority of the page and a series that had quietly gained a bar somewhere
// else would still pass a spot check of the three weeks that matter.
function weeks(...cells: [number, string][]): string[] {
  const row = Array.from({ length: 53 }, () => "0");
  for (const [week, value] of cells) row[week - 1] = value;
  return row;
}

const YEARS_TO_2026 = ["2020", "2021", "2022", "2023", "2024", "2025", "2026"];

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

describe("the route", () => {
  // gfdash/urls.py:10's path, reached through the REAL router. A test that
  // mounted its own ad-hoc Hono route would pass with index.ts:547 deleted --
  // the sibling suite records a shipped link that 404ed for exactly that.
  //
  // The title and the legend are asserted together on purpose: the title is
  // one word ("per year") away from dash/weekly_itemcount.njk's, and the
  // legend is the thing the sibling template does not have at all.
  it("answers GET with the per-year page, not its one-line-shorter sibling", async () => {
    seedTheYears();

    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Items requested by UK food banks per week per year - Give Food</title>");
    expect(html).toContain("<h1>Items requested by UK food banks per week per year</h1>");
    expect(html).toContain('<div id="chart" style="height:500px"></div>');
    expect(legendYears(html)).toEqual(YEARS_TO_2026);
  });

  // ONE SESSION, ONE STATEMENT, NO PARAMETERS, NO WRITES. The whole page is a
  // full scan of published foodbankchange with no LIMIT, so a second call --
  // or a handler that opened its own session per query -- doubles the D1 rows
  // billed for a page nobody is watching. "first-unconstrained" is what makes
  // the read eligible for a replica (lib/session.ts); asking for
  // "first-primary" would still render this page perfectly.
  it("reads once, through one replica-eligible session, and writes nothing", async () => {
    seedTheYears();

    await get(PATH);

    expect(sessionModes).toEqual(["first-unconstrained"]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.sql).toMatch(/^SELECT /);
    expect(prepared[0]!.params).toEqual([]);
    // Matched only far enough to prove the route reaches
    // getPublishedNeedsForWeeklyCount rather than some other query; the row
    // level behaviour of the statement belongs to
    // packages/db/src/dashboards.test.ts, and pinning its full text here would
    // fail this suite for a rewrite that changed nothing this page can see.
    expect(prepared[0]!.sql).toContain("FROM foodbankchange");
    expect(prepared[0]!.sql).toContain("published = 1");
    // The count is unchanged afterwards -- this repo has already shipped a GET
    // route able to run an UPDATE, with its "does not answer GET" test passing
    // throughout, and the fake session above deliberately implements run().
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get()).toEqual({ n: 10 });
  });

  // NO STATE SURVIVES THE REQUEST. `week_needs` is built inside the handler; a
  // Map hoisted to module scope (the classic Workers global-state mistake --
  // an isolate serves thousands of requests) would double every count on the
  // second view and keep climbing, which looks like traffic rather than a bug.
  it("counts the same needs the same way on a second request", async () => {
    seedTheYears();

    const first = await body(PATH);
    const second = await body(PATH);

    expect(tableRows(second)).toEqual(tableRows(first));
    expect(seriesByYear(second)["2024"]).toEqual(seriesByYear(first)["2024"]);
  });

  // GET ONLY. index.ts:547 registers app.get() and nothing else, so Hono
  // answers a POST with a 404 -- a DIVERGENCE from Django, whose view is a
  // plain function with no method guard and would have rendered the page with
  // a 200. Harmless either way (neither writes), and what is asserted is that
  // the refusal happens BEFORE the query, so a POST flood cannot buy a full
  // scan of foodbankchange.
  it("refuses a POST, and runs no query on the way to refusing it", async () => {
    seedTheYears();

    const res = await get(PATH, { method: "POST" });

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
    expect(sessionModes).toEqual([]);
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block, outside
  // i18n_patterns, and index.ts:542-567 registers the dashboards with no
  // locale loop. The visible half is the absence of hreflang alternates
  // (buildPageContext is called with no `locale`, leaving `languages` empty);
  // the routing half is that no /cy/ form of this URL exists at all. A route
  // added to the LOCALES loop by mistake would 200 on the Welsh URL.
  it("is English-only: no hreflang alternates, and no language-prefixed URL", async () => {
    seedTheYears();

    const html = await body(PATH);

    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).not.toContain("hreflang");
    expect((await get(PATH)).headers.get("Content-Language")).toBe("en");
    expect((await get(`/cy${PATH}`)).status).toBe(404);
  });

  // Django's APPEND_SLASH, via lib/appendSlash.ts -- and it is not free. The
  // probe re-enters the app with a HEAD for the slashed URL, so the unslashed
  // form runs this handler in full, scans foodbankchange and renders the whole
  // document before throwing the body away to produce a 301. Pinned rather
  // than filed: it is how the probe is documented to work, and the cost is
  // invisible in every metric except D1 rows read.
  it("301s a missing trailing slash, having really executed the handler to find out", async () => {
    seedTheYears();

    const res = await get("/dashboard/items-requested-weekly/by-year");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
    expect(prepared).toHaveLength(1);
  });

  // A DELIBERATE DIVERGENCE, PINNED SO IT STAYS DELIBERATE. Django decorated
  // this view @cache_page(SECONDS_IN_DAY); nothing in the handler says so, and
  // the day here comes from middleware/pageCacheControl.ts's fall-through
  // default. There is also no Cache-Tag (middleware/cacheTag.ts has no rule for
  // /dashboard/), so queues/cachePurge.ts cannot shorten that when needs are
  // re-crawled: this page is stale-until-TTL by design. Either half changing
  // quietly changes how long the site shows last week's chart.
  it("serves day-cacheable, untagged HTML", async () => {
    seedTheYears();

    const res = await get(PATH);

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  // buildPageContext + elapsedMs, the two halves of pageContext(). The debug
  // comment in includes/debugcomment.njk is the only consumer of
  // render_time_ms, and with the key missing it renders "Took ms" -- a page
  // that still looks perfect. `Took \d+ms` also pins the whole-millisecond
  // rounding elapsedMs() does deliberately.
  //
  // THE STATUS CHECK IS NOT PADDING. The 404 page is built from the same
  // page.njk and carries a canonical link, a flag link and a debug comment for
  // whatever path was asked for -- so without it this test passed with the
  // route deleted from index.ts entirely (found by mutation, not by reasoning).
  it("puts the canonical URL, the flag link and a numeric render time on the page", async () => {
    seedTheYears();

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
    expect(html).toContain(`<a href="/flag/#${ORIGIN}${PATH}"`);
    expect(html).toMatch(/⏱️ Took \d+ms/);
  });

  // THE BREADCRUMB IS A DELIBERATE FIX, not a faithful port, and it is pinned
  // here so a future "restore parity" pass does not undo it. Django's
  // gfdash/templates/dash/weekly_itemcount_year.html:19 points its own
  // aria-current="page" crumb at `{% url 'dash:tt_most_requested_items' %}` --
  // a copy-paste from the Trussell page that sends the reader to a different
  // dashboard. The port resolves dash:weekly_itemcount_year instead, i.e. this
  // page.
  it("points its current breadcrumb at itself, unlike the Django template", async () => {
    seedTheYears();

    const html = await body(PATH);

    expect(html).toContain(`<a href="${PATH}" aria-current="page">Items requested by UK food banks per week per year</a>`);
    expect(html).not.toContain("/dashboard/trusselltrust/most-requested-items/");
  });

  // The querystring is dropped from `flag_path` because pageContext() passes
  // only `c.req.path` to buildPageContext, unlike the routes that also pass
  // `querystring`. Pinned rather than filed: this page takes no parameters, so
  // the only thing a query can do is arrive from a tracking link, and the flag
  // link should point at the page rather than at the link that reached it.
  it("ignores the querystring entirely, including in the flag link", async () => {
    seedTheYears();

    const res = await get(`${PATH}?utm_source=newsletter`);
    const html = await res.text();

    // 200 asserted for the same reason as the test above: the 404 page would
    // satisfy both of the assertions that follow.
    expect(res.status).toBe(200);
    expect(html).toContain(`<a href="/flag/#${ORIGIN}${PATH}"`);
    expect(html).not.toContain("utm_source");
  });
});

// ---------------------------------------------------------------------------
// the week buckets -- the <table>
// ---------------------------------------------------------------------------

describe("the week buckets", () => {
  beforeEach(seedTheYears);

  // THE WHOLE PAYLOAD OF THE TABLE, IN ONE ASSERTION, because the ORDER is as
  // load-bearing as the numbers and neither is obvious.
  //
  // Django renders `week_needs.items reversed` over an OrderedDict, so the
  // order is INSERTION order reversed -- the order the weeks were first seen
  // walking needs by created ascending -- and NOT a sort. The port matches by
  // reversing a Map, which preserves insertion order the same way. The visible
  // consequence is the "2021-1" row sitting ABOVE "2021-53": week 53 of 2021
  // is the first days of January and was seen first, so reversal puts it last.
  // Sorting the list -- an entirely reasonable-looking "tidy-up" -- would move
  // that row and quietly change what the table means.
  //
  // Every count here is items, not needs: 2020-2 is one need with three lines.
  it("prints one row per week seen, newest-first by first appearance, counting ITEMS", async () => {
    expect(tableRows(await body(PATH))).toEqual([
      "2025-27|0",
      "2024-1|3",
      "2021-1|1",
      "2021-53|2",
      "2020-53|1",
      "2020-2|3",
      "2020-1|1",
    ]);
  });

  // Named separately from the row assertion above so a failure says WHICH rule
  // broke. Both excluded rows carry five items in weeks that appear nowhere in
  // the expected output, so a leak is an extra ROW rather than a count one too
  // high -- much harder to miss.
  it("never shows a week whose only needs are unpublished or pre-2020", async () => {
    const html = await body(PATH);

    expect(html).not.toContain("2023-18");
    expect(html).not.toContain("2019-1");
    expect(tableRows(html).some((row) => row.endsWith("|5"))).toBe(false);
  });

  // THE SENTINEL, on its own. "Unknown" and "Nothing" are the contract values
  // needcheck writes when a food bank publishes no list
  // (givefood/models/needs.py:93-97), and they must count as zero items rather
  // than as one line of text. The bucket still exists, so the week is present
  // with a 0 -- which is how the table says "we looked and there was nothing"
  // rather than "we did not look".
  it("counts a sentinel need as zero items while still creating its week", async () => {
    db.prepare("DELETE FROM foodbankchange").run();
    seedChange({ change_text: "Unknown", created: PY("2025-06-30 09:00:00.000000") });
    seedChange({ change_text: "Nothing", created: PY("2025-07-01 09:00:00.000000") });
    seedChange({ change_text: "Beans", created: PY("2025-07-02 09:00:00.000000") });

    // All three land in 2025-27 (30 June to 6 July 2025 is one ISO week), so
    // the whole week is one item: a sentinel counted as a line would make it 3.
    expect(tableRows(await body(PATH))).toEqual(["2025-27|1"]);
  });

  // THE TWO HALVES OF THE YEAR-BOUNDARY QUIRK, asserted as VALUES because both
  // are lossy and both are faithful. Django keys on `need.created.year` (plain
  // calendar year) and `need.created.isocalendar()[1]` (ISO week), which are
  // from two different calendars near 1 January:
  //
  //   * 28 Dec 2020 and 1 Jan 2021 are ONE ISO week split across two buckets
  //     ("2020-53" and "2021-53"), so a single week of need appears twice.
  //   * 1 Jan 2024 and 30 Dec 2024 are a YEAR apart, merged into one bucket
  //     ("2024-1" = 2 items + 1 item = 3), so the first week of every year
  //     silently absorbs the last few days of December.
  //
  // Both were confirmed against CPython 3.13.0 on this machine (header note).
  // Reproduced verbatim rather than "fixed" into a consistent ISO year+week
  // pair, because fixing it would move needs between the chart's series and
  // make the port disagree with the live site.
  it("splits one ISO week across two years, and merges two Januaries into one bucket", async () => {
    const rows = tableRows(await body(PATH));

    // The split. ISO 2021 has only 52 weeks, so "2021-53" is a calendar-year
    // artefact rather than a real week -- it holds the needs from 1 January.
    expect(rows).toContain("2020-53|1");
    expect(rows).toContain("2021-53|2");
    // The merge. 2 items from January plus 1 from the following 30 December.
    expect(rows).toContain("2024-1|3");
  });
});

// ---------------------------------------------------------------------------
// the year grid -- the echarts config
// ---------------------------------------------------------------------------

describe("the year grid", () => {
  beforeEach(seedTheYears);

  // 53 CATEGORIES, ALWAYS, whatever the data says -- `weeks = range(1,54)` at
  // gfdash/views.py:56, MAX_WEEK here. A grid built from the weeks that
  // happened to have needs would look identical on a busy year and lose the
  // quiet weeks entirely; an off-by-one at 53 would drop the year-boundary
  // bucket that the table above proves exists.
  it("draws a 53-week x axis, numbered 1..53, regardless of the data", async () => {
    const labels = axisWeeks(await body(PATH));

    expect(labels).toHaveLength(53);
    expect(labels[0]).toBe("1");
    expect(labels[52]).toBe("53");
    expect(labels).toEqual(Array.from({ length: 53 }, (_, i) => String(i + 1)));
  });

  // ONE SERIES PER LEGEND ENTRY, and no more. The legend and the series are
  // two separate `{% for year in years %}` loops over the same list; if they
  // ever disagreed the chart would carry a legend item that toggles nothing,
  // or an unnamed extra colour. Cheap to assert, and it holds the two loops
  // together.
  it("emits exactly one bar series per legend year", async () => {
    const html = await body(PATH);

    expect(Object.keys(seriesByYear(html)).sort()).toEqual([...YEARS_TO_2026].sort());
    expect(legendYears(html)).toEqual(YEARS_TO_2026);
  });

  // THE ACTUAL BARS, stated as whole 53-slot rows rather than spot checks. The
  // zeros are the majority of this page and they are not padding: `week_needs
  // .get(key, 0)` is what turns a sparse dict into a dense grid, and a series
  // that had gained a bar in some other week would still pass an assertion
  // that only looked at the weeks with data.
  //
  // 2020 carries three separate weeks (1, 2 and 53); 2021's week 53 is the
  // January bucket described above; 2024's week 1 is the merged one.
  it("places each year's items in the right week, and zero everywhere else", async () => {
    const series = seriesByYear(await body(PATH));

    expect(series["2020"]).toEqual(weeks([1, "1"], [2, "3"], [53, "1"]));
    expect(series["2021"]).toEqual(weeks([1, "1"], [53, "2"]));
    expect(series["2024"]).toEqual(weeks([1, "3"]));
  });

  // A YEAR WITH NO NEEDS AT ALL IS STILL A FULL ROW OF ZEROS -- 2022 and 2023
  // here, since the only 2023 need is unpublished. This is what makes the
  // chart's bars line up: echarts pairs series data with x-axis categories by
  // POSITION, so a year that emitted only its non-zero weeks would draw them
  // against the wrong week numbers rather than drawing less.
  it("gives an empty year a full row of zeros rather than a short array", async () => {
    const series = seriesByYear(await body(PATH));

    expect(series["2022"]).toEqual(weeks());
    expect(series["2023"]).toEqual(weeks());
    expect(series["2022"]).toHaveLength(53);
  });

  // NO HOLES. The template fills each slot from an inner loop over ALL years
  // guarded by `{% if year_data.year == year %}`, and emits the separating
  // comma OUTSIDE that inner loop -- so a slot that matched no year would
  // render as an empty array element and shift every later bar one week left.
  // The seriesByYear() reader deliberately keeps empty elements so this can be
  // asserted; every token must be a bare integer, unquoted (echarts would plot
  // a quoted '3' too, but it is a different thing in the source).
  //
  // The series are ENUMERATED from YEARS_TO_2026 rather than walked from
  // whatever seriesByYear() happened to find: iterating the found series meant
  // that on a page with no series at all -- the route deleted from index.ts,
  // say -- the loop body never ran and the test passed on an empty object.
  // Found by mutation, not by reasoning.
  it("fills every one of the 53 slots with a bare unquoted integer", async () => {
    const series = seriesByYear(await body(PATH));

    expect(Object.keys(series)).toHaveLength(YEARS_TO_2026.length);
    for (const year of YEARS_TO_2026) {
      const data = series[year];
      expect(`${year}:${data?.length}`).toBe(`${year}:53`);
      expect(data?.every((value) => /^\d+$/.test(value))).toBe(true);
    }
  });

  // A WEEK KEY OUTSIDE 2020..THIS YEAR EXISTS IN THE TABLE AND NOWHERE IN THE
  // CHART. `years` stops at the current year, so a mistyped future need -- the
  // realistic source is an admin-entered date -- gets a table row and no bar,
  // and the two halves of the page disagree with each other. Faithful to
  // Django (`years = range(start_year, current_year+1)` at views.py:55), and
  // pinned here because it is the page's one silent divergence between its own
  // two renderings.
  it("shows a need dated beyond this year in the table but in no series", async () => {
    seedChange({ change_text: "Beans\nPasta", created: PY("2099-03-02 09:00:00.000000") });

    const html = await body(PATH);

    expect(tableRows(html)).toContain("2099-10|2");
    expect(legendYears(html)).not.toContain("2099");
    expect(seriesByYear(html)["2099"]).toBeUndefined();
    // And it did not leak into the current year's week 10 either.
    expect(seriesByYear(html)["2026"]).toEqual(weeks());
  });
});

// ---------------------------------------------------------------------------
// the year axis, which comes from the clock
// ---------------------------------------------------------------------------

describe("the year axis", () => {
  // THE ONLY CLOCK READ ON THE PAGE, at the instant it moves. `years` runs
  // START_YEAR..new Date().getUTCFullYear(), so the whole chart gains a series
  // at UTC midnight on 1 January with nothing else about the page changing --
  // a handler that had cached the year, or read it from a different clock,
  // would go a full year unnoticed.
  //
  // NOT a test of getUTCFullYear() vs getFullYear(): vitest.config.mts pins
  // TZ=UTC for the whole suite, so the two agree here by construction. This
  // pins the RANGE, not the UTC-ness.
  //
  // Django's `date.today()` at views.py:54 was UTC too, so there is no
  // divergence hiding behind that: givefood/settings.py sets TIME_ZONE = "UTC"
  // (with USE_TZ = False), and django/conf/__init__.py's Settings.__init__
  // puts TIME_ZONE into os.environ["TZ"] and calls time.tzset(), which makes
  // the whole process -- date.today() included -- run in it. Checked in the
  // Django installed on this machine, which is 5.2.6.
  it("gains its newest series exactly at UTC new year", async () => {
    vi.setSystemTime(new Date("2025-12-31T23:59:59.999Z"));
    const before = await body(PATH);
    expect(legendYears(before)).toEqual(["2020", "2021", "2022", "2023", "2024", "2025"]);

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const after = await body(PATH);
    expect(legendYears(after)).toEqual(YEARS_TO_2026);
    // The new year arrives as a complete, empty row -- not as a missing one.
    expect(seriesByYear(after)["2026"]).toEqual(weeks());
  });

  // THE FLOOR IS A CONSTANT, NOT DATA. START_YEAR is 2020 (`start_date =
  // date(2020,1,1)` at views.py:52), so the legend begins at 2020 even when
  // the database holds nothing from that year -- which is the state a fresh
  // environment or a filtered dataset is in. Deriving the floor from the
  // earliest need instead would silently drop the empty leading years, and the
  // chart would look right.
  it("always starts at 2020, even with no 2020 data in the database", async () => {
    seedChange({ change_text: "Beans", created: PY("2025-06-30 09:00:00.000000") });

    const html = await body(PATH);

    expect(legendYears(html)).toEqual(YEARS_TO_2026);
    expect(seriesByYear(html)["2020"]).toEqual(weeks());
    expect(seriesByYear(html)["2025"]).toEqual(weeks([27, "1"]));
  });

  // AN EMPTY DATABASE IS A FULL CHART OF ZEROS, not an empty one -- and that
  // is what distinguishes this page from its sibling, whose chart really does
  // collapse to nothing. A fresh environment, or any database-restore window,
  // looks like this: 200, an empty table, and 7 x 53 zeros. What echarts must
  // not receive is a syntax error, which is what a half-emitted loop produces
  // and which is invisible server-side.
  it("renders the whole zeroed grid rather than 404ing when there are no needs at all", async () => {
    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(tableRows(html)).toEqual([]);
    expect(axisWeeks(html)).toHaveLength(53);
    expect(legendYears(html)).toEqual(YEARS_TO_2026);
    for (const year of YEARS_TO_2026) expect(seriesByYear(html)[year]).toEqual(weeks());
    // The rest of the document is untouched -- the empty case flattens the
    // chart, it does not degrade the page.
    expect(html).toContain("<h1>Items requested by UK food banks per week per year</h1>");
  });
});

// ---------------------------------------------------------------------------
// timestamps the page cannot read
// ---------------------------------------------------------------------------

describe("timestamps the page cannot read", () => {
  // TICKET #7. This page is one of weekKey()'s three callers -- the other two
  // are the sibling weeklyItemcount.ts and routes/admin/stats.ts. weekKey() returns
  // null for an unparseable date and the handler skips the row instead of
  // bucketing it, because the key is a CHART AXIS LABEL and a table cell: the
  // ticket was a screenshot of a "NaN-NaN" bucket sitting at the end of this
  // very chart. One unreadable row costs that row, not the credibility of the
  // page.
  //
  // The seed is contrived -- migration 0022 normalised every stored timestamp,
  // and `created` is NOT NULL -- but the SQL floor is a LEXICOGRAPHIC string
  // comparison ("not a date at all" > "2020-01-01" because 'n' > '2'), so
  // garbage passes the filter and arrives here rather than being caught by the
  // query.
  it("drops a need whose created date cannot be read, rather than printing NaN-NaN", async () => {
    seedChange({ change_text: "Beans\nPasta", created: PY("2025-06-30 09:00:00.000000") });
    seedChange({ change_text: "Rice\nTea\nSoup", created: "not a date at all" });

    const html = await body(PATH);

    expect(html).not.toContain("NaN");
    // The readable row is untouched -- and the unreadable one's three items
    // were not silently folded into it either.
    expect(tableRows(html)).toEqual(["2025-27|2"]);
  });

  // THE TRAILING-Z STRIP IN parseD1Timestamp(), which is the FOURTH site of
  // one bug (lib/isoWeek.ts:31-45). Appending "Z" to a value that already ends
  // in one gives "...ZZ", which `new Date()` resolves to an Invalid Date
  // SILENTLY -- and weekKey() then had nothing to return but null, so the need
  // would vanish from the chart with no error anywhere.
  //
  // Rows in this shape are what the PORT ITSELF wrote before ticket #9
  // normalised them, so this is a real historical shape rather than a
  // hypothetical: both spellings of the same instant must land in 2024-10.
  it("reads an ISO-shaped created date, Z and all, into the same week as the Django-shaped one", async () => {
    seedChange({ change_text: "Beans", created: "2024-03-05T09:00:00.000Z" });
    seedChange({ change_text: "Pasta", created: PY("2024-03-06 09:00:00.000000") });

    const html = await body(PATH);

    expect(tableRows(html)).toEqual(["2024-10|2"]);
    expect(seriesByYear(html)["2024"]).toEqual(weeks([10, "2"]));
  });
});


// ===========================================================================
// MUTATION TESTING, run in a COPY of the whole tree under the scratchpad,
// outside the repo -- never by editing a file in src/ and putting it back.
// Each mutant was applied alone and this file re-run; where a .njk changed,
// `scripts/precompile.ts` was re-run first, because a template edit is inert
// until it is (a "template mutant" without that step proves nothing). The
// number is how many of the 25 tests above went red.
//
// In weeklyItemcountYear.ts itself:
//   START_YEAR 2020 -> 2021                                   7 failed
//   MAX_WEEK 53 -> 52                                         9 failed
//   `year <= currentYear` -> `year < currentYear`             7 failed
//   `new Date().getUTCFullYear()` -> a hardcoded 2026          1 failed (the
//                                                              UTC-new-year
//                                                              test, which
//                                                              exists for it)
//   the grid's `?? 0` -> `?? null` (sparse, not dense)         8 failed
//   `if (key === null)` -> `if (key === undefined)`, so an
//     unreadable date is bucketed under a null key             1 failed
//   `+ noItems(row.change_text)` -> `+ 1` (needs, not items)   6 failed
//   `week_needs_items_desc` passed un-reversed                 1 failed
//   context key `week_year_needs` -> `weekYearNeeds`           9 failed
//   context key `years` -> `all_years`                        10 failed
//   context key `week_needs_items_desc` -> `week_needs_items`  6 failed
//   `render_time_ms` dropped from pageContext()                1 failed
//   template -> the sibling "dash/weekly_itemcount.njk"       12 failed
//   a second dbSession(c) per request                          1 failed
//   an UPDATE run beside the read                              2 failed
//   a DELETE run beside the read                               2 failed
//
// In lib/isoWeek.ts, because a careless edit there reaches this page just as
// surely as one to the handler:
//   weekKey keyed on the ISO year instead of the calendar
//     year -- the "self-consistent" fix its own comment warns
//     against                                                  3 failed
//   isoWeekNumber's `- dayNum + 3` -> `+ 4` (the wrong day of
//     the week decides the year)                               3 failed
//   parseD1Timestamp's `.replace(/Z$/, "")` deleted            1 failed
//   weekKey returning "NaN-NaN" rather than null (ticket #7)   1 failed
//
// In index.ts and the shared query (packages/db/src/dashboards.ts), to prove
// the excluded fixture rows are doing work rather than sitting there:
//   the app.get registration deleted                          24 failed
//   registered with app.all instead of app.get                 1 failed
//   `published = 1` dropped                                    4 failed
//   the `created > '2020-01-01'` floor dropped                  2 failed
//   ORDER BY created removed                                   1 failed -- the
//     table's insertion order, which the chart cannot see; that is why the row
//     order is asserted as a list rather than as a sorted set.
//
// In dash/weekly_itemcount_year.njk:
//   the legend loop deleted                                    5 failed
//   the series' `{% if year_data.year == year %}` gate
//     inverted to `!=`                                         8 failed
//   the `{% if not loop.last %}` comma moved INSIDE the inner
//     year loop (53 slots become 371)                          8 failed
//   the table loop pointed at `week_needs_items`               6 failed
//
// In the middleware this page inherits its headers from:
//   pageCacheControl's fall-through shared TTL day -> week     1 failed
//   /dashboard/ added to cacheTag's aggregate purge set        1 failed
//
// ONE SURVIVOR, recorded rather than papered over: dropping the `.slice()`
// from `weekNeedsItems.slice().reverse()`, so the array is reversed IN PLACE,
// kills nothing. It is an equivalent mutant here -- `weekNeedsItems` is built
// fresh by Array.from on every request and is never read again after that line
// -- and it would stop being equivalent the moment the un-reversed list were
// also passed to the template, which is exactly how the sibling handler
// weeklyItemcount.ts uses it. Left in the source as the safer spelling.
//
// THREE TESTS WERE STRENGTHENED BY THIS RUN, which is the point of doing it:
// "puts the canonical URL...", "ignores the querystring..." and "fills every
// one of the 53 slots..." all SURVIVED the deletion of the route from
// index.ts. The first two because the 404 page is built from the same
// page.njk and carries a canonical link, a flag link and a debug comment of
// its own; the third because it iterated the series it found, and on a page
// with no series the loop body never ran. Each now pins the status or the
// expected count first. Only "refuses a POST" still survives that mutant, and
// legitimately: a 404 is a 404 either way.
