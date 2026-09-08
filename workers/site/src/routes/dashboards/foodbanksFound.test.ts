import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// /dashboard/foodbanks-found/ -- gfdash/views.py:347-362 `foodbanks_found`,
// registered gfdash/urls.py:20 as `dash:foodbanks_found`.
//
// WHAT THIS PAGE IS, because every assertion below turns on it: a CUMULATIVE
// discovery curve. Each row is "how many food bank organisations did Give
// Food know about at the end of this month", not "how many were added in it".
// A month with no new food banks does not appear at all. That distinction is
// the entire content of the page and it is one character of code wide
// (`index + 1` versus a `+= 1`), so most of this file exists to hold it
// still.
//
// WHY A ROUTE-LEVEL SUITE AT ALL, when packages/db/src/dashboards.test.ts
// already puts `getFoodbankCreatedDates` through a real engine: that function
// returns a flat list of timestamp strings. Everything this page is -- the
// month bucketing, the cumulative count, the ascending chart, the descending
// table -- happens HERE, in fifteen lines with no error path, and none of it
// can fail loudly. A month key computed from the wrong slice, a count that
// counts the wrong thing, a `_desc` that is not reversed: every one of them
// renders a complete, plausible, wrong page with a 200 and no console noise.
// A dashboard nobody is watching is exactly where a wrong number lives
// longest, which is the failure class this tier was commissioned for.
//
// REAL EVERYTHING. The real `app` from ../../index (so the route path, the
// method, the trailing-slash redirect and the cache headers under test are
// the shipped registrations, not a hand-built copy -- this repo has already
// had a suite pass for weeks against a router it built itself), the real
// packages/db query, the real dbSession, and the real Nunjucks render of
// dash/foodbanks_found.njk. Nothing is stubbed: the only outbound thing this
// page touches is D1, and node:sqlite seeded from the real migrations
// (schemaFor) is a truer D1 than any mock. Assertions read the rendered HTML
// -- the table rows and the two ECharts arrays -- because "the context object
// had the right key" is not evidence the page did: env.ts sets
// throwOnUndefined:false, so a variable renamed on either side of the
// boundary renders as empty string with a 200.
//
// MUTATION-TESTED in an rsync'd copy of the repo outside it (TESTING.md's
// no-scratch-files rule), 41 mutants over three rounds, spanning
// foodbanksFound.ts, index.ts's registration, packages/db's query,
// dash/foodbanks_found.njk and the middleware this page's headers come from.
// All 41 died. The ones worth naming because they are plausible edits rather
// than contrived ones: slice(0,7) -> slice(0,4), slice(0,10) and slice(-7);
// `index + 1` -> `index`; the cumulative `set(month, index + 1)` rewritten as
// a per-month tally, and again with a "don't overwrite" guard;
// `.slice().reverse()` -> `.reverse()` (which silently reverses the chart too,
// since both context keys would then be the same array); `_desc` handed the
// un-reversed array; the two context keys transposed; the page context no
// longer spread in; buildPageContext given c.req.url instead of c.req.path;
// render_time_ms dropped; the session mode changed to "first-primary"; the
// template swapped for a sibling dashboard; c.html -> c.text; the query
// awaited twice; the route registered as .post, additionally as .post, at a
// hyphen-free path, or deleted; in packages/db, `ORDER BY created` reversed,
// dropped, replaced by ORDER BY id, narrowed with `WHERE is_closed = 0`, and
// the column swapped for `modified`; in the template, `|safe` on the month
// label, either ECharts array switched to the descending list, the table loop
// switched to the ascending one, and the `{% if not loop.last %}` comma guard
// removed; and in the middleware, APPEND_SLASH's 301 turned into a 302, the
// default page TTL cut from a day to an hour, and /dashboard/ added to
// cacheTag's aggregate paths.
//
// A TRAP WORTH RECORDING for whoever mutates a template next: the first three
// .njk mutants "survived", and had not in fact been applied. Templates reach
// the tests through packages/templates/src/generated/precompiled.js, a build
// artifact, so editing the .njk changes nothing until scripts/precompile.ts
// runs again. Re-run with a precompile either side, all six template mutants
// died. A green suite against an unapplied mutant reads exactly like a strong
// suite, which is the more dangerous of the two failure modes.

const ORIGIN = "https://www.givefood.org.uk";
const PATH = "/dashboard/foodbanks-found/";

// Fixed so the debug comment's "Generated at" and any date filter are
// deterministic; nothing on this page depends on the current time, and that
// is itself worth having pinned -- a "months since launch" axis built from
// Date.now() would make the page's output a function of the calendar.
const NOW = new Date("2026-09-08T09:30:00.000Z");

type Bindable = null | number | bigint | string | Uint8Array;

interface Prepared {
  sql: string;
  params: Bindable[];
}

// Set by the one test that needs D1 to fail, cleared in beforeEach. A
// module-level flag rather than a per-call parameter because the failure has
// to happen inside a session the ROUTE created, which the test cannot reach.
let failQueries = false;

// A D1DatabaseSession over real SQLite. Records every statement so the tests
// below can assert the page runs one query rather than one per month, and
// that it never runs a write -- a GET that can UPDATE is the specific bug
// this repo's testing brief names, and it is invisible from the response.
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
        all: async () => {
          if (failQueries) throw new Error("D1_ERROR: Network connection lost");
          return { results: db.prepare(sql).all(...params), success: true, meta: {} };
        },
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
let sessionModes: string[];

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      // The mode is captured, not ignored: dbSession() asks for
      // "first-unconstrained", which is what lets this read be served by a
      // read replica. A page of month totals has no reason to pin the primary
      // and no way to show that it did.
      withSession: (mode: string) => {
        sessionModes.push(mode);
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

// Every NOT NULL column of the real `foodbank` table filled with something
// plausible, because schemaFor() hands us the real DDL rather than a reduced
// fixture: only `created` and `is_closed` are ever varied, which keeps each
// test's seed a statement about the one thing it is testing.
function seedFoodbank(id: number, created: string, isClosed: 0 | 1 = 0): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, network,
       charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative,
       is_closed, no_locations, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79', 'Trussell',
       0, ?, ?, ?, 0, ?, 0, 14, ?, '2020-01-01 00:00:00.000000')`,
  ).run(
    id,
    String(id).padStart(32, "a"),
    `Foodbank ${id}`,
    `foodbank-${id}`,
    `info@fb${id}.invalid`,
    `https://fb${id}.invalid/`,
    `https://fb${id}.invalid/list/`,
    isClosed,
    created,
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(schemaFor("foodbank"));
  prepared = [];
  sessionModes = [];
  failQueries = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const getBody = async (path = PATH): Promise<string> => (await get(path)).text();

// ---------------------------------------------------------------------------
// Readers over the rendered page.
//
// Deliberately parsing the HTML rather than inspecting a captured context
// object: the two halves of this page (an ECharts option literal inside a
// <script>, and an HTML table) read the same two variables through different
// template loops, and only the rendered output shows that both arrived. The
// chart readers also pin something no context assertion can -- that the
// values land inside the JS array literal as JS, i.e. that the comma logic
// (`{% if not loop.last %}`) produces parseable code.

// The <td> pairs of the summary table, in document order -- which is the
// DESCENDING (newest-first) list, from `created_months_items_desc`.
function tableRows(html: string): [string, number][] {
  const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
  return [...table.matchAll(/<td>([^<]*)<\/td>\s*<td>(\d+)<\/td>/g)].map((m) => [m[1] ?? "", Number(m[2])]);
}

// The array literal that follows the Nth `data: [` in the page: index 0 is
// the xAxis category list (month labels), index 1 is the bar series (counts).
// Both are built from `created_months_items`, the ASCENDING list.
function dataLiteral(html: string, occurrence: 0 | 1): string {
  let at = -1;
  for (let i = 0; i <= occurrence; i += 1) at = html.indexOf("data: [", at + 1);
  return html.slice(at, html.indexOf("]", at));
}

const chartMonths = (html: string): string[] => [...dataLiteral(html, 0).matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");

const chartCounts = (html: string): number[] =>
  dataLiteral(html, 1)
    .replace("data: [", "")
    .split(",")
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map(Number);

// ===========================================================================
// The cumulative curve -- the whole point of the page
// ===========================================================================

describe("the discovery curve", () => {
  // The single most valuable assertion in this file. Two food banks found in
  // May 2020, one in June 2021, one in July 2023: the counts are 2, 3, 4 --
  // running totals, NOT 2, 1, 1. Django built this with
  // `created_dates.index(date) + 1`, a position in the whole sorted list, and
  // a port that "tidied" it into a per-month tally would draw a chart that is
  // wrong in the most convincing possible way: same months, same shape of
  // bars, every number a plausible small integer, and the line no longer says
  // what the page's own axis label says it says.
  it("counts food banks known SO FAR, not food banks found that month", async () => {
    seedFoodbank(1, "2020-05-05 09:00:00.000000");
    seedFoodbank(2, "2020-05-31 23:59:59.999999");
    seedFoodbank(3, "2021-06-06 09:00:00.000000");
    seedFoodbank(4, "2023-07-07 09:00:00.000000");

    const html = await getBody();

    expect(chartMonths(html)).toEqual(["2020-05", "2021-06", "2023-07"]);
    expect(chartCounts(html)).toEqual([2, 3, 4]);
  });

  // The same numbers again, read out of the table rather than the chart, and
  // in the opposite order. `created_months_items_desc` is a separate context
  // key fed by `.slice().reverse()`, so the table can be wrong while the
  // chart is right -- and a table that reads oldest-first looks like a table
  // whose newest month has stopped updating, which is a support ticket, not a
  // visible break. Django's template said `{% for month in
  // created_months.items reversed %}`; this is that.
  it("prints the table newest month first, with the same totals", async () => {
    seedFoodbank(1, "2020-05-05 09:00:00.000000");
    seedFoodbank(2, "2020-05-31 23:59:59.999999");
    seedFoodbank(3, "2021-06-06 09:00:00.000000");
    seedFoodbank(4, "2023-07-07 09:00:00.000000");

    const html = await getBody();

    expect(tableRows(html)).toEqual([
      ["2023-07", 4],
      ["2021-06", 3],
      ["2020-05", 2],
    ]);
    // ...and the chart is still ascending in the same render. `.reverse()`
    // without the `.slice()` mutates the array both keys point at, so the
    // chart's x-axis silently runs backwards in time while the table looks
    // perfect. Only asserting both from ONE response kills that mutant.
    expect(chartMonths(html)).toEqual(["2020-05", "2021-06", "2023-07"]);
  });

  // A month key is written once per food bank found in it, and the LAST write
  // wins -- both in Django's dict and in the port's Map, and for the same
  // reason (re-assigning an existing key keeps its original position but
  // replaces the value). So a month that saw three food banks shows the total
  // as of the third, not the first. Seeded with three in one month precisely
  // because a Map built with a `if (!has) set()` guard -- a natural-looking
  // "don't overwrite" edit -- passes every other test in this file.
  it("takes each month's total from the LAST food bank found in it", async () => {
    seedFoodbank(1, "2022-03-01 09:00:00.000000");
    seedFoodbank(2, "2022-03-02 09:00:00.000000");
    seedFoodbank(3, "2022-03-03 09:00:00.000000");

    expect(chartCounts(await getBody())).toEqual([3]);
  });

  // Months in which nothing was found are ABSENT, not zero-filled: Django
  // built a dict keyed by the months that actually occur, and the chart's
  // x-axis is a category axis over exactly those keys. Nine months separate
  // these two food banks and the chart has two bars. Zero-filling would not
  // merely add points -- on a cumulative series a zero is a claim that the
  // directory emptied itself that month.
  it("omits months in which no food bank was found", async () => {
    seedFoodbank(1, "2021-01-15 09:00:00.000000");
    seedFoodbank(2, "2021-10-15 09:00:00.000000");

    const html = await getBody();

    expect(chartMonths(html)).toEqual(["2021-01", "2021-10"]);
    expect(chartCounts(html)).toEqual([1, 2]);
  });

  // The month key is the first SEVEN characters of the stored string.
  // slice(0,4) buckets by year and slice(0,10) by day; both produce a page
  // that renders, both keep the counts monotonic, and neither is visible
  // without counting the bars. Two food banks in different months of the same
  // year is the smallest seed that separates all three.
  it("buckets by year-month, not by year and not by day", async () => {
    seedFoodbank(1, "2024-02-10 09:00:00.000000");
    seedFoodbank(2, "2024-11-20 09:00:00.000000");

    expect(chartMonths(await getBody())).toEqual(["2024-02", "2024-11"]);
  });

  // The count is a 1-BASED position. Django wrote `.index(date) + 1`; drop
  // the + 1 and the earliest month reads 0 -- "we knew about no food banks
  // after finding our first one" -- which is the kind of wrong that people
  // read past because the rest of the curve still looks right.
  it("starts at 1, not 0", async () => {
    seedFoodbank(1, "2018-06-01 09:00:00.000000");

    expect(chartCounts(await getBody())).toEqual([1]);
  });

  // CLOSED FOOD BANKS COUNT. Django's `get_all_foodbanks()` is
  // `Foodbank.objects.all()` (givefood/utils/cache.py:37-43), not
  // `get_all_open_foodbanks()`: a food bank that has since shut was still
  // discovered on its created date. Excluding it would rewrite HISTORY --
  // every past month's total would drop the day a food bank closes today, so
  // a cumulative curve that is supposed to only ever rise would sink. Seeded
  // as the ONLY food bank in its month so an exclusion cannot hide behind a
  // sibling: with a `WHERE is_closed = 0` anywhere in the chain this page
  // shows one bar, not two.
  it("counts food banks that have since closed", async () => {
    seedFoodbank(1, "2020-05-05 09:00:00.000000", 0);
    seedFoodbank(2, "2021-06-06 09:00:00.000000", 1);

    const html = await getBody();

    expect(chartMonths(html)).toEqual(["2020-05", "2021-06"]);
    expect(chartCounts(html)).toEqual([1, 2]);
  });

  // The rows arrive from SQL already sorted ascending, and the whole
  // cumulative reading depends on it: `index + 1` is only "how many so far"
  // if the list is in discovery order. Seeded in deliberately scrambled
  // insert order (SQLite would otherwise hand back rowid order, which here
  // would be 2021, 2019, 2023) so a dropped or reversed ORDER BY shows up as
  // months out of sequence AND as a curve that goes down.
  it("does not depend on insert order", async () => {
    seedFoodbank(1, "2021-06-06 09:00:00.000000");
    seedFoodbank(2, "2019-04-04 09:00:00.000000");
    seedFoodbank(3, "2023-07-07 09:00:00.000000");

    const html = await getBody();

    expect(chartMonths(html)).toEqual(["2019-04", "2021-06", "2023-07"]);
    expect(chartCounts(html)).toEqual([1, 2, 3]);
  });
});

// ===========================================================================
// Timestamps as TEXT -- where the port and Django can drift
// ===========================================================================

describe("timestamp handling", () => {
  // A KNOWN, VERIFIED DIVERGENCE FROM DJANGO, pinned as the port behaves
  // rather than as anyone would wish.
  //
  // Django: `created_months[d.strftime("%Y-%m")] = created_dates.index(d) + 1`
  // -- and `list.index()` returns the FIRST position of an equal value, so
  // two food banks sharing a created timestamp both score the earlier index
  // and the month's total comes out one short. The port uses the loop
  // position, which gives the honest running total.
  //
  // Verified by running the Django loop under this machine's CPython 3.13.0
  // over these four timestamps: Django yields {'2020-05': 1, '2021-06': 2},
  // the port yields 1 and 4. The port is arguably RIGHT and Django wrong --
  // which is exactly why this is a test and not a fix: someone comparing the
  // two dashboards during the cutover needs the difference written down.
  //
  // Unreachable in practice on live data (`created` is auto_now_add with
  // microsecond precision, givefood/models/base.py:15) but reachable in a
  // bulk import, which is how a directory acquires several food banks in the
  // same instant.
  it("counts duplicate created timestamps separately (Django's list.index() does not)", async () => {
    seedFoodbank(1, "2020-05-05 09:00:00.000000");
    seedFoodbank(2, "2021-06-06 09:00:00.000000");
    seedFoodbank(3, "2021-06-06 09:00:00.000000");
    seedFoodbank(4, "2021-06-06 09:00:00.000000");

    expect(chartCounts(await getBody())).toEqual([1, 4]);
  });

  // `created` is TEXT compared lexicographically, and this port writes rows
  // with toISOString() in places while Django wrote
  // "YYYY-MM-DD HH:MM:SS.ffffff" -- so a table can hold both spellings, and
  // "T" sorts after " ". That reorders two rows WITHIN a day (here the
  // 23:00 Django-format row sorts ahead of the 09:00 ISO one), which is
  // harmless for this page and worth proving harmless: the first ten
  // characters still sort correctly, so every row of a month stays
  // contiguous, the month keys stay ascending, and the total at the end of
  // each month is unchanged. The failure this rules out is a bucketing that
  // parses the string instead of slicing it -- new Date("2024-03-01
  // 23:00:00.000000") is Invalid Date in strict engines, and an
  // ISO-vs-Django mix is where that would first bite.
  it("is unbothered by ISO-8601 rows mixed in with Django-format ones", async () => {
    seedFoodbank(1, "2024-02-20 09:00:00.000000");
    seedFoodbank(2, "2024-03-01T09:00:00.000Z");
    seedFoodbank(3, "2024-03-01 23:00:00.000000");

    const html = await getBody();

    expect(chartMonths(html)).toEqual(["2024-02", "2024-03"]);
    expect(chartCounts(html)).toEqual([1, 3]);
  });

  // Django ran with TIME_ZONE = "UTC" and USE_TZ = False (givefood/
  // settings.py:210,213), so `created` was a naive UTC datetime and
  // strftime("%Y-%m") read the stored value's own month. The port slices the
  // stored string, which is the same answer -- including for the two
  // timestamps most likely to expose a timezone shift, the last microsecond
  // of a month and the first of the next. They must land in different
  // buckets; convert either to local time in a BST-shaped zone and January's
  // last row falls into December.
  it("puts a month-boundary timestamp in the month the string says", async () => {
    seedFoodbank(1, "2022-01-31 23:59:59.999999");
    seedFoodbank(2, "2022-02-01 00:00:00.000000");

    expect(chartMonths(await getBody())).toEqual(["2022-01", "2022-02"]);
  });

  // Degenerate stored values do not 500 the page: a blank `created` (the
  // column is NOT NULL, so blank is as empty as it gets) yields a blank month
  // label that sorts first and still occupies a position in the running
  // count, shifting every later month up by one. Pinned as current behaviour
  // and NOT endorsed -- it is a silent data-quality hole, not a feature --
  // but a dashboard that throws on one bad row tells an operator nothing at
  // all, whereas a blank label in the table is visible.
  it("renders a blank month label rather than failing on an empty created", async () => {
    seedFoodbank(1, "");
    seedFoodbank(2, "2020-05-05 09:00:00.000000");

    const html = await getBody();

    expect(chartMonths(html)).toEqual(["", "2020-05"]);
    expect(chartCounts(html)).toEqual([1, 2]);
  });
});

// ===========================================================================
// Empty and single-row renders
// ===========================================================================

describe("edge-case renders", () => {
  // An empty directory is a 200 with an empty chart, not a 500 and not a
  // blank page. This is the state every fresh D1 preview database is in, so
  // it is the first thing anyone sees after a migration -- and an exception
  // here would be read as "the migration broke the dashboards".
  it("renders an empty page when no food banks exist", async () => {
    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(chartMonths(html)).toEqual([]);
    expect(chartCounts(html)).toEqual([]);
    expect(tableRows(html)).toEqual([]);
    // Still the real page, with its heading and column titles -- an empty
    // dataset must not be mistaken for an empty template.
    expect(html).toContain("<h1>Food Banks Found</h1>");
    expect(html).toContain("<th>Food Bank Organisations</th>");
  });

  // One row exercises the template's `{% if not loop.last %}` comma logic at
  // its only interesting boundary. A trailing comma in the category array is
  // survivable in a modern browser; one in the wrong place is not, and either
  // way the page renders and the chart does not, which no status code shows.
  // Asserted on the literal text so a stray comma cannot hide behind a
  // forgiving parser.
  it("emits single-element arrays with no trailing comma", async () => {
    seedFoodbank(1, "2019-12-31 23:59:59.999999");

    const html = await getBody();

    expect(chartMonths(html)).toEqual(["2019-12"]);
    expect(chartCounts(html)).toEqual([1]);
    expect(dataLiteral(html, 0).replace(/\s+/g, "")).toBe("data:['2019-12'");
    expect(dataLiteral(html, 1).replace(/\s+/g, "")).toBe("data:[1");
  });

  // Month labels reach the page through Nunjucks' autoescaping, INSIDE a
  // <script> block where HTML escaping is not what a JS string wants. Pinned
  // because the escaping is what stops a seven-character apostrophe-bearing
  // `created` from closing the string literal: it comes out as &#39;, which
  // breaks that one chart and cannot execute. `created` is only writable by
  // an admin or an importer, so this is a defence-in-depth pin rather than a
  // live exposure -- and a future "use |safe here, the entities look ugly"
  // edit is exactly what it exists to stop.
  it("escapes month labels rather than letting them close the JS string", async () => {
    seedFoodbank(1, "'+ale<b>rt(1)//");

    const html = await getBody();

    expect(dataLiteral(html, 0)).toContain("&#39;+ale&lt;b");
    expect(dataLiteral(html, 0)).not.toContain("'+ale<b");
    expect(tableRows(html)).toEqual([["&#39;+ale&lt;b", 1]]);
  });
});

// ===========================================================================
// Route wiring: the shipped registration, not a hand-built one
// ===========================================================================

describe("route", () => {
  it("answers GET at /dashboard/foodbanks-found/ with HTML", async () => {
    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toContain("<title>Food Banks Found - Give Food</title>");
  });

  // Registered with app.get only, so every other method falls through to the
  // site 404. Django's view had no method decorator either, but Django's URL
  // resolver hands GET-only pages a 405-free 200 for POST, so this is the
  // port's own contract: no write surface exists at this path, and the test
  // reads the DB back to say so rather than trusting the status.
  it("does not answer POST, and a POST touches the database not at all", async () => {
    seedFoodbank(1, "2020-05-05 09:00:00.000000");

    const res = await get(PATH, { method: "POST" });

    expect(res.status).toBe(404);
    expect(sessionModes).toEqual([]);
    expect(prepared).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM foodbank").get() as { n: number }).n).toBe(1);
  });

  // gfdash sits OUTSIDE Django's i18n_patterns (gfdash/urls.py is included
  // unprefixed, and index.ts's locale loop deliberately skips the dashboards
  // for that reason), so there is no Welsh dashboard URL to be had. Pinned so
  // that adding one becomes a deliberate act: a /cy/ URL that quietly starts
  // answering in English is a hreflang problem, not a feature.
  it("has no locale-prefixed form", async () => {
    expect((await get("/cy/dashboard/foodbanks-found/")).status).toBe(404);
    expect((await get("/ga/dashboard/foodbanks-found/")).status).toBe(404);
  });

  // Django's APPEND_SLASH, reproduced by app.notFound() -> lib/appendSlash.ts
  // as a 301 to the slashed URL. Every internal link and the breadcrumb use
  // the slashed form; this is for the hand-typed and the mis-copied one.
  it("301s the slash-less URL to the canonical one", async () => {
    const res = await get("/dashboard/foodbanks-found");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
  });

  // Django decorated this view @cache_page(SECONDS_IN_DAY); the port's
  // middleware/pageCacheControl.ts supplies the header half, with the day on
  // s-maxage (where the edge can be purged) and five minutes for browsers
  // (where it cannot). This page falls through to that default rather than
  // matching any of the middleware's named path rules, so the assertion is
  // both "the dashboard is cacheable" and "it inherited Django's day".
  it("is cacheable for a day at the edge and five minutes in the browser", async () => {
    const res = await get(PATH);

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    // No Cache-Tag: middleware/cacheTag.ts tags food bank and aggregate
    // paths, and a dashboard is neither, so this page is purged only by a
    // zone-wide purge. Pinned because a tag appearing here would mean the
    // tag rules had started matching /dashboard/ by accident.
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  // HEAD runs the handler (Hono answers it from the GET route) and returns an
  // empty body -- but NO Cache-Control, because pageCacheControl returns
  // early for any method other than GET. SUSPECT, and not this module's to
  // fix: a shared cache that revalidates with HEAD sees an uncacheable
  // response for a page the GET says may be held for a day. Pinned as-is so
  // the asymmetry is recorded rather than discovered.
  it("answers HEAD with an empty body (and, suspiciously, no Cache-Control)", async () => {
    seedFoodbank(1, "2020-05-05 09:00:00.000000");

    const res = await get(PATH, { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Cache-Control")).toBeNull();
    // The query still runs, which is what makes the 301 probe in
    // lib/appendSlash.ts (a HEAD under the covers) a real check.
    expect(prepared).toHaveLength(1);
  });
});

// ===========================================================================
// Database discipline and failure
// ===========================================================================

describe("database use", () => {
  // ONE statement, no parameters, no writes, on a replica-friendly session.
  // The exact SQL belongs to packages/db and is asserted there; what this
  // owns is the shape of the access -- a per-month or per-food-bank query
  // would still render this page correctly while turning one D1 read into
  // hundreds on a dashboard that is otherwise free to serve.
  it("reads once, on a first-unconstrained session, and writes nothing", async () => {
    seedFoodbank(1, "2020-05-05 09:00:00.000000");
    seedFoodbank(2, "2021-06-06 09:00:00.000000");
    seedFoodbank(3, "2023-07-07 09:00:00.000000");

    await get(PATH);

    expect(sessionModes).toEqual(["first-unconstrained"]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.params).toEqual([]);
    expect(prepared[0]?.sql).toMatch(/^\s*SELECT\b/i);
    expect(prepared[0]?.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|CREATE)\b/i);
  });

  // Two identical requests produce identical pages and leave the database
  // untouched. This page has no cron or queue behind it, but it IS reachable
  // by any crawler at any rate, and "reads are reads" is the property that
  // makes the day-long edge cache above safe to hand out.
  it("is unchanged by being requested twice", async () => {
    seedFoodbank(1, "2020-05-05 09:00:00.000000");
    seedFoodbank(2, "2020-05-06 09:00:00.000000");

    const first = await getBody();
    const rowsAfterFirst = (db.prepare("SELECT COUNT(*) AS n FROM foodbank").get() as { n: number }).n;
    const second = await getBody();

    expect(chartCounts(second)).toEqual(chartCounts(first));
    expect(tableRows(second)).toEqual(tableRows(first));
    expect(rowsAfterFirst).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM foodbank").get() as { n: number }).n).toBe(2);
  });

  // A D1 failure must surface as the site's 500 page, not as a 200 carrying
  // an empty chart. The distinction matters more here than on a content page:
  // "no food banks were found in any month" is a legible, plausible answer to
  // this page's question, so a swallowed error would look like data. It also
  // must not be cached -- pageCacheControl skips non-200s, so the broken page
  // does not take the day-long TTL the healthy one gets.
  it("500s on a database failure instead of rendering an empty chart", async () => {
    seedFoodbank(1, "2020-05-05 09:00:00.000000");
    vi.spyOn(console, "error").mockImplementation(() => {});
    failQueries = true;

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("500 - Internal Server Error");
    expect(html).not.toContain("<h1>Food Banks Found</h1>");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});

// ===========================================================================
// Page furniture that comes from the route, not the template
// ===========================================================================

describe("page context", () => {
  // buildPageContext is handed `c.req.path`, not the full URL, so the
  // canonical link is query-free. A `?utm_source=...` link shared onto social
  // media would otherwise announce itself to crawlers as a distinct page --
  // the classic duplicate-content split, invisible on the page itself.
  it("gives the same canonical URL whatever the query string", async () => {
    const plain = await getBody(PATH);
    const withQuery = await getBody(`${PATH}?utm_source=newsletter&x=1`);

    expect(plain).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
    expect(withQuery).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
  });

  // render_time_ms is the route's own addition to the page context (Django's
  // RenderTime middleware, ported per-page rather than as a body rewrite --
  // see middleware/serverTiming.ts). Unwire it and the debug comment reads
  // "Took ms", because Nunjucks renders a missing variable as empty string
  // rather than complaining. Whole milliseconds, deliberately: the port
  // dropped Django's three decimal places because on Workers they were always
  // ".000".
  it("stamps the debug comment with a whole-millisecond render time", async () => {
    const html = await getBody();

    expect(html).toMatch(/⏱️ Took \d+ms/);
    expect(html).not.toMatch(/⏱️ Took \d+\.\d+ms/);
  });

  // The breadcrumb resolves through @givefood/urls' reverse-URL table, which
  // is how the page links back to /dashboard/. A broken name there renders an
  // empty href -- a dead breadcrumb on a page nobody watches.
  it("links back to the dashboard index from the breadcrumb", async () => {
    const html = await getBody();

    expect(html).toContain('<a href="/dashboard/">Dashboards</a>');
    expect(html).toContain(`<a href="${PATH}" aria-current="page">Food Banks Found</a>`);
  });
});
