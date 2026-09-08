import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// /dashboard/items-requested-weekly/ -- gfdash/views.py:26-43
// `weekly_itemcount`, registered gfdash/urls.py:9 as
// `dash:weekly_itemcount`.
//
// WHAT THE PAGE IS. One bar per "year-week" bucket, whose height is the
// total number of ITEMS (not needs) that published food bank needs asked for
// in that week, plus the same numbers as a newest-first table. Both halves
// come out of a single Map built in a dozen lines of handler: bucket the row's
// `created` with weekKey(), add noItems(change_text) to whatever is already
// there.
//
// WHY A ROUTE-LEVEL SUITE, when lib/isoWeek.test.ts already sweeps every day
// of 2015-2035 through weekKey() and packages/db/src/dashboards.test.ts runs
// the SELECT against a real engine. Neither of them can see the thing this
// page is: the ACCUMULATION. Which rows reach the loop, what each one
// contributes, which bucket it lands in, what order the buckets come out in,
// and whether the table is the reverse of the chart -- none of that exists
// until the three pieces are joined here, and every way of getting it wrong
// renders a complete, plausible, 200-OK page with a wrong number on it. This
// is a public dashboard with no watcher, no log line and a day-long edge
// cache: a wrong bar lives here for as long as nobody happens to recompute it
// by hand.
//
// REAL EVERYTHING. The real `app` from ../../index -- so the route path, the
// method, the trailing-slash redirect and the cache headers under test are
// the shipped registrations rather than a hand-built router, which is the
// mistake this repo has already made once -- the real packages/db query, the
// real dbSession, and the real Nunjucks render of dash/weekly_itemcount.njk
// over in-memory SQLite whose `foodbankchange` DDL comes from the real
// migrations via schemaFor(). Nothing here leaves the machine, so nothing is
// mocked but the two KV namespaces, which are inert stubs.
//
// Assertions read the RENDERED HTML rather than a captured context object,
// because packages/templates sets throwOnUndefined:false: a context key
// renamed on either side of the boundary renders as empty string with a 200,
// and a "the context had the right key" test would not notice.
//
// MUTATION-TESTED in an rsync'd copy of the repo outside it (TESTING.md's
// no-scratch-files rule): 42 mutants, 41 dead. They spanned this handler
// (items counted as needs; the accumulation turned into a last-write-wins
// assignment; the null-key guard deleted; `.slice().reverse()` -> `.reverse()`;
// the two context keys transposed; the desc key handed the un-reversed array;
// a zero-item guard around the Map write; the buckets sorted; the page context
// given c.req.url; render_time_ms dropped; the by-year template rendered
// instead; c.html -> c.text; the query awaited twice; a `.catch(() => [])`
// around the read), lib/session.ts ("first-primary"), lib/isoWeek.ts (a padded
// week number, an ISO year in place of Django's calendar year, the ticket-#7
// "blind + Z", the NaN guard removed, a Sunday-start week number),
// @givefood/models (no_items' sentinels dropped, case-folded, widened to
// "Facebook", and its split filtered of blank lines), packages/db (published,
// the 2020 cutoff, ORDER BY dropped and reversed, SELECT *), index.ts (the
// path pointed at the sibling handler, an extra .post registration, the route
// added to the locale loop), dash/weekly_itemcount.njk (each loop pointed at
// the other list, the comma guard removed and inverted, the series printing
// the week key, the table printing the count twice) and the middleware (the
// 301 turned 302, the page TTL cut to an hour).
//
// THE ONE SURVIVOR is recorded in place, at the 2020-cutoff test: `>` vs `>=`
// on a bare date literal is not observable by anything.
//
// A TRAP WORTH REPEATING from the neighbouring foodbanksFound suite, since
// this file's seven template mutants would otherwise have "survived": templates
// reach the tests through packages/templates/src/generated/precompiled.js, a
// build artifact, so editing a .njk changes nothing until scripts/precompile.ts
// runs again. Each template mutant above was run with a precompile either side.
//
// THE ORACLE FOR THE PARITY CLAIMS IS DJANGO'S OWN LOOP, RUN. The fixture in
// "the accumulation" below was put through views.py:29-37 transcribed into
// CPython 3.13.0 on this machine (`datetime.strptime` +
// `isocalendar()[1]` + an OrderedDict), which printed
// [('2024-1', 4), ('2024-52', 2), ('2025-1', 1)] -- the exact list the chart
// is asserted to draw, including the December-into-January merge. Where a
// comment below says Django does X, that is what was run; where it is
// reasoning from the source, it says so.

const ORIGIN = "https://www.givefood.org.uk";
const PATH = "/dashboard/items-requested-weekly/";

// Pinned only so the debug comment's "Generated at {{ now() }}" is
// deterministic. NOTHING ELSE ON THIS PAGE READS THE CLOCK, and that is worth
// having stated: its sibling weeklyItemcountYear.ts builds a 2020..current
// year list from `new Date()`, so the two pages age differently and only one
// of them has output that is a function of the calendar.
const NOW = new Date("2026-09-08T09:30:00.000Z");

type Bindable = null | number | bigint | string | Uint8Array;

interface Prepared {
  sql: string;
  params: Bindable[];
}

// Set by the one test that needs D1 to fail, cleared in beforeEach. A
// module-level flag rather than a parameter because the failure has to happen
// inside a session the ROUTE created, which the test never holds.
let failQueries = false;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite --
// the same shim the neighbouring dashboard suites use. Every statement is
// recorded, because two of the claims below are about SQL that was NOT run:
// that this GET issues one read and no write at all, and that a 404 never
// reaches the database.
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
      // The mode is captured rather than ignored: dbSession() asks for
      // "first-unconstrained", which is what lets this read be served by a
      // read replica. A page of weekly totals has no reason to pin the
      // primary and no way of showing that it did.
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

// Every NOT NULL column of the real `foodbankchange` table, because
// schemaFor() hands us the real DDL and not a reduced fixture. Only the three
// things this page can possibly react to -- change_text, created, published
// -- are ever varied, so each test's seed is a statement about the one thing
// it is testing.
//
// `created` takes the Django spelling "YYYY-MM-DD HH:MM:SS.ffffff", which is
// what the pg-to-D1 import wrote and what production overwhelmingly holds.
// It is TEXT and compared lexicographically both by the query's 2020 cutoff
// and by its ORDER BY, so the format is not cosmetic here -- see the
// ISO-mixture test.
let seeded = 0;
function seedNeed(changeText: string, created: string, published: 0 | 1 = 1): number {
  seeded += 1;
  const id = seeded;
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, name, change_text, published,
       input_method, created, modified)
     VALUES (?, ?, 1, ?, ?, ?, 'typed', ?, ?)`,
  ).run(id, String(id).padStart(32, "a"), `Need ${id}`, changeText, published, created, created);
  return id;
}

// Seeds rows in an order chosen by the caller while giving them ASCENDING
// ids, so that "the query ordered these" and "SQLite handed them back in
// rowid order" are never the same thing by accident.
function seedInInsertOrder(needs: [changeText: string, created: string][]): void {
  for (const [changeText, created] of needs) seedNeed(changeText, created);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(schemaFor("foodbankchange"));
  prepared = [];
  sessionModes = [];
  seeded = 0;
  failQueries = false;
  // Date only: performance.now() must stay real, or elapsedMs() would report
  // a frozen 0 and the render-time assertion would be testing the fake timer.
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
// Readers over the rendered page
//
// The page says everything twice: an ECharts option literal inside a <script>
// built from `week_needs_items`, and an HTML table built from
// `week_needs_items_desc`. They are separate context keys fed by separate
// template loops, so a page can be half right, and only reading BOTH out of
// ONE response can tell.

// The <td> pairs of the table, in document order -- which is the DESCENDING
// (newest bucket first) list.
function tableRows(html: string): [string, number][] {
  const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
  return [...table.matchAll(/<td>([^<]*)<\/td>\s*<td>(-?\d+)<\/td>/g)].map((m) => [m[1] ?? "", Number(m[2])]);
}

// The array literal following the Nth `data: [` in the page: index 0 is the
// xAxis category list (week keys), index 1 is the bar series (item counts).
// Both come from `week_needs_items`, the ASCENDING list. Returned as source
// text so the comma logic is visible to the callers below.
function dataLiteral(html: string, occurrence: 0 | 1): string {
  let at = -1;
  for (let i = 0; i <= occurrence; i += 1) at = html.indexOf("data: [", at + 1);
  return html.slice(at, html.indexOf("]", at));
}

const chartWeeks = (html: string): string[] => [...dataLiteral(html, 0).matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");

const chartCounts = (html: string): number[] =>
  dataLiteral(html, 1)
    .replace("data: [", "")
    .split(",")
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map(Number);

// ===========================================================================
// The accumulation -- views.py:33-37, the whole content of the page
// ===========================================================================

describe("the weekly accumulation", () => {
  // THE FIXTURE IS THE TEST, and it was run through Django's own loop in
  // CPython 3.13.0 on this machine (see the file header) rather than
  // reasoned about:
  //
  //   Beans            2024-01-01  -> "2024-1"   1 item
  //   Pasta\nRice      2024-12-29  -> "2024-52"  2 items
  //   Soup\nTea\nCoffee 2024-12-30 -> "2024-1"   3 items  (December! see below)
  //   Nothing          2024-12-31  -> "2024-1"   0 items  (the sentinel)
  //   Milk             2025-01-01  -> "2025-1"   1 item
  //
  // giving [('2024-1', 4), ('2024-52', 2), ('2025-1', 1)] in Django and here.
  // Five rows chosen so that a single assertion separates the mutants that
  // matter: a handler counting NEEDS instead of items reads 3, 1, 1; one that
  // ignored the "Nothing" sentinel reads 5, 2, 1; one that sorted the buckets
  // puts 2024-1 after 2024-52; one that keyed on the ISO year rather than
  // Django's calendar year moves December's three items out of the January
  // bar (1, 2, 4 instead of 4, 2, 1).
  it("sums no_items() per week bucket, in the order the weeks first appear", async () => {
    seedInInsertOrder([
      ["Beans", "2024-01-01 09:00:00.000000"],
      ["Pasta\nRice", "2024-12-29 09:00:00.000000"],
      ["Soup\nTea\nCoffee", "2024-12-30 09:00:00.000000"],
      ["Nothing", "2024-12-31 09:00:00.000000"],
      ["Milk", "2025-01-01 09:00:00.000000"],
    ]);

    const html = await getBody();

    expect(chartWeeks(html)).toEqual(["2024-1", "2024-52", "2025-1"]);
    expect(chartCounts(html)).toEqual([4, 2, 1]);
  });

  // The same numbers read out of the table instead of the chart, in the
  // opposite order, FROM THE SAME RESPONSE. `week_needs_items_desc` is
  // `weekNeedsItems.slice().reverse()`, and dropping the `.slice()` is the
  // classic version of this bug: `.reverse()` mutates in place, both context
  // keys then point at the same reversed array, the table looks perfect and
  // the chart's x-axis silently runs backwards in time. Only asserting both
  // halves of one render kills that.
  //
  // Django's template said `{% for week in week_needs.items reversed %}`
  // (dash/weekly_itemcount.html); the port precomputes the reversal in the
  // handler because Nunjucks has no `reversed` loop modifier.
  it("prints the table newest week first while the chart stays oldest first", async () => {
    seedInInsertOrder([
      ["Beans", "2024-01-01 09:00:00.000000"],
      ["Pasta\nRice", "2024-12-29 09:00:00.000000"],
      ["Soup\nTea\nCoffee", "2024-12-30 09:00:00.000000"],
      ["Nothing", "2024-12-31 09:00:00.000000"],
      ["Milk", "2025-01-01 09:00:00.000000"],
    ]);

    const html = await getBody();

    expect(tableRows(html)).toEqual([
      ["2025-1", 1],
      ["2024-52", 2],
      ["2024-1", 4],
    ]);
    expect(chartWeeks(html)).toEqual(["2024-1", "2024-52", "2025-1"]);
  });

  // A week in which every published need said "Nothing" or "Unknown" is a
  // REAL BUCKET WITH A ZERO, not an absent one: the Map entry is written
  // before the count is known to be zero, exactly as Django's
  // `week_needs[key] = week_needs.get(key, 0) + need.no_items()` is. That
  // distinction is the difference between "food banks reported no needs that
  // week" (a zero bar) and "we have no data for that week" (no bar), and a
  // `if (items) weekNeeds.set(...)` guard -- which looks like a tidy-up --
  // silently converts every one of the first into the second.
  it("keeps a zero bar for a week whose needs were all 'Nothing' or 'Unknown'", async () => {
    seedInInsertOrder([
      ["Nothing", "2026-08-31 09:00:00.000000"],
      ["Unknown", "2026-09-01 09:00:00.000000"],
      ["Beans", "2026-09-07 09:00:00.000000"],
    ]);

    const html = await getBody();

    expect(chartWeeks(html)).toEqual(["2026-36", "2026-37"]);
    expect(chartCounts(html)).toEqual([0, 1]);
    expect(tableRows(html)).toEqual([
      ["2026-37", 1],
      ["2026-36", 0],
    ]);
  });

  // noItems() is `len(change_text.split("\n"))` with two sentinels special-
  // cased, and every one of these cases is a line-splitting decision someone
  // could plausibly "improve":
  //
  //   ""                 -> 1, because "".split("\n") is [""] in BOTH Python
  //                         and JS (verified in CPython 3.13.0 here). A
  //                         `filter(Boolean)` or a trim-then-split would make
  //                         this 0 and quietly lower every bar containing an
  //                         empty need.
  //   "A\n\nB\n"         -> 4: blank lines and the trailing newline COUNT.
  //                         nonEmptyLines() exists in @givefood/models for
  //                         the callers that want them stripped; no_items()
  //                         is deliberately not one of them.
  //   "nothing"/"unknown"-> 1: the sentinel comparison is case-SENSITIVE.
  //   "Facebook"         -> 1: the third sentinel of the schema's contract is
  //                         deliberately NOT excluded by no_items(), unlike
  //                         has_needs()'s three-way check. Asserted so a
  //                         later "surely these should be symmetric" edit
  //                         has to be a deliberate one.
  //
  // Each seeded in its own ISO week so a wrong count cannot hide inside a
  // shared bar.
  it("counts lines the way FoodbankChange.no_items() does, sentinels included", async () => {
    seedInInsertOrder([
      ["", "2026-01-05 09:00:00.000000"],
      ["A\n\nB\n", "2026-01-12 09:00:00.000000"],
      ["nothing", "2026-01-19 09:00:00.000000"],
      ["unknown", "2026-01-26 09:00:00.000000"],
      ["Facebook", "2026-02-02 09:00:00.000000"],
    ]);

    const html = await getBody();

    expect(chartWeeks(html)).toEqual(["2026-2", "2026-3", "2026-4", "2026-5", "2026-6"]);
    expect(chartCounts(html)).toEqual([1, 4, 1, 1, 1]);
  });

  // A need whose text is one item per line with Windows line endings still
  // counts its lines: `split("\n")` leaves the "\r" attached to the previous
  // piece rather than producing an extra one, in JS and in Python alike. Real
  // needcheck rows carry CRLF whenever the scraped page did, so this is the
  // shape of a large minority of production text, not a curiosity.
  it("counts CRLF-separated items once each, not twice", async () => {
    seedNeed("Beans\r\nPasta\r\nRice", "2026-03-02 09:00:00.000000");

    expect(chartCounts(await getBody())).toEqual([3]);
  });

  // The bucket order is INSERTION order (a JS Map, standing in for Django's
  // OrderedDict) and never a sort. These two rows are eight days apart and
  // produce "2024-52" then "2024-1" -- a chart whose second bar has a LOWER
  // week number than its first, which is correct and looks like a bug, and
  // which any sort() "fix" would silently reorder. Lexical order would put
  // "2024-1" first; numeric order would too. Only the arrival order gives
  // this answer.
  it("orders the buckets by first appearance, not by sorting the keys", async () => {
    seedInInsertOrder([
      ["Pasta", "2024-12-29 09:00:00.000000"],
      ["Beans", "2024-12-30 09:00:00.000000"],
    ]);

    const html = await getBody();

    expect(chartWeeks(html)).toEqual(["2024-52", "2024-1"]);
    // Stated as a difference rather than only as a literal, so the test fails
    // if a sort is ever introduced under either comparison.
    expect([...chartWeeks(html)].sort()).toEqual(["2024-1", "2024-52"]);
  });

  // "First appearance" means first by `created`, which is the query's ORDER
  // BY and not the rowid. Seeded in scrambled insert order with ascending ids
  // so that a dropped or reversed ORDER BY -- in packages/db, or a future
  // "the rows come back sorted anyway" simplification -- shows up as buckets
  // in the wrong sequence rather than as nothing at all.
  it("does not depend on the order the rows were inserted", async () => {
    seedInInsertOrder([
      ["Beans", "2026-06-10 09:00:00.000000"],
      ["Pasta", "2026-02-10 09:00:00.000000"],
      ["Rice", "2026-08-10 09:00:00.000000"],
      ["Tea", "2026-04-10 09:00:00.000000"],
    ]);

    expect(chartWeeks(await getBody())).toEqual(["2026-7", "2026-15", "2026-24", "2026-33"]);
  });

  // Two needs written in the same instant (a bulk import, or two scrapes
  // finishing together) both count -- the accumulation is `+=` over rows, not
  // a lookup keyed on the timestamp, so there is no de-duplication to lose.
  // Worth pinning because the sibling foodbanks-found dashboard DOES lose
  // rows on duplicate timestamps in Django, and someone reading both ports
  // might expect the same shape here.
  it("counts two needs sharing a created timestamp separately", async () => {
    seedNeed("Beans", "2026-05-04 09:00:00.000000");
    seedNeed("Pasta\nRice", "2026-05-04 09:00:00.000000");

    expect(chartCounts(await getBody())).toEqual([3]);
  });
});

// ===========================================================================
// The calendar-year / ISO-week quirk -- views.py:34-36, reproduced verbatim
// ===========================================================================

describe("the year/week key quirk", () => {
  // Django keys on `"%s-%s" % (need.created.year, need.created.isocalendar()[1])`
  // -- the PLAIN CALENDAR year glued to the ISO week number, which are not
  // from the same calendar near 1 January. lib/isoWeek.ts reproduces that on
  // purpose; here is what it does to the published chart.
  //
  // 2024-01-01 is ISO 2024-W01 and 2024-12-30 is ISO 2025-W01 (both verified
  // in CPython 3.13.0 here), and Django's key for both is "2024-1". So a need
  // from the last Monday of December is added to the bar for the first week of
  // JANUARY -- eleven months earlier -- and, because the bucket was created in
  // January, that bar keeps its position at the far LEFT of the chart.
  //
  // Pinned, emphatically not endorsed: this is the live behaviour of the
  // Django site and the port must not "fix" it into a self-consistent ISO
  // year+week, which would move real numbers between bars on a public page.
  it("adds a late-December need to the previous January's bar, where Django put it", async () => {
    seedInInsertOrder([
      ["Beans", "2024-01-01 09:00:00.000000"],
      ["Pasta", "2024-06-03 09:00:00.000000"],
      ["Soup\nTea\nCoffee", "2024-12-30 09:00:00.000000"],
    ]);

    const html = await getBody();

    expect(chartWeeks(html)).toEqual(["2024-1", "2024-23"]);
    // 1 + 3, in the bucket that opened in January.
    expect(chartCounts(html)).toEqual([4, 1]);
  });

  // The other face of the same quirk: ISO 2020-W53 runs Mon 2020-12-28 to
  // Sun 2021-01-03, and Django splits it at the calendar year -- "2020-53"
  // for the December half, "2021-53" for the January half. The chart
  // therefore shows a 53rd week of 2021 as its FIRST 2021 bar, before
  // "2021-1" ever appears. (CPython 3.13.0 here: 2020-12-31 -> 2020-53,
  // 2021-01-01 -> 2021-53, 2021-01-04 -> 2021-1.)
  it("splits one ISO week across the new year into '2020-53' and '2021-53'", async () => {
    seedInInsertOrder([
      ["Beans", "2020-12-31 23:59:59.999999"],
      ["Pasta\nRice", "2021-01-01 00:00:00.000000"],
      ["Milk", "2021-01-04 00:00:00.000000"],
    ]);

    const html = await getBody();

    expect(chartWeeks(html)).toEqual(["2020-53", "2021-53", "2021-1"]);
    expect(chartCounts(html)).toEqual([1, 2, 1]);
  });

  // The week number is NOT zero-padded, because Python's "%s" of an int is
  // not. It is a chart label and a table cell here, so padding would merely
  // look tidier -- but the same key shape is looked up character-for-character
  // by the sibling by-year grid (weeklyItemcountYear.ts's `${year}-${week}`),
  // where a padded key would make all 53 rows read zero. Pinned here too so
  // the two pages cannot drift apart.
  it("labels single-digit weeks unpadded, as Python's %s does", async () => {
    seedNeed("Beans", "2026-01-05 09:00:00.000000");

    expect(chartWeeks(await getBody())).toEqual(["2026-2"]);
    expect(tableRows(await getBody())).toEqual([["2026-2", 1]]);
  });
});

// ===========================================================================
// Rows that must not be counted
// ===========================================================================

describe("what the chart leaves out", () => {
  // `published=True` in views.py:31. needcheck writes UNPUBLISHED needs
  // continuously -- every scrape that finds a change lands one for review --
  // so a lost filter would not add a little noise, it would roughly double
  // the chart and keep on looking entirely plausible.
  //
  // The excluded need is seeded in a week of its OWN, so its absence is
  // visible as a missing bucket rather than only as a smaller number: a
  // filter that does nothing passes any test whose excluded row shares a
  // bucket with an included one.
  it("counts published needs only", async () => {
    seedNeed("Beans", "2026-04-06 09:00:00.000000", 1);
    seedNeed("Draft\nItems\nHere", "2026-04-13 09:00:00.000000", 0);

    const html = await getBody();

    expect(chartWeeks(html)).toEqual(["2026-15"]);
    expect(chartCounts(html)).toEqual([1]);
    expect(tableRows(html)).toEqual([["2026-15", 1]]);
  });

  // `created__gt=date(2020,1,1)` in views.py:30-31. The dashboard starts at
  // 2020 by editorial decision; pre-2020 rows exist (the directory predates
  // it) and must not appear.
  //
  // The midnight row is a KNOWN, RECORDED DIVERGENCE, pinned here at the page
  // where it would be seen: Django compared against a datetime and excluded
  // exactly-midnight 2020-01-01, while the port compares the TEXT column
  // against the bare string '2020-01-01', and "2020-01-01 00:00:00.000000"
  // sorts after it, so the row is INCLUDED. One instant's worth of
  // difference, six years in the past, already pinned at the SQL tier
  // (packages/db/src/dashboards.test.ts) and repeated here so nobody
  // "corrects" the chart's first bar without knowing why it is there.
  //
  // A MUTANT THIS DOES NOT KILL, said out loud rather than left for the next
  // reader to discover: `created > '2020-01-01'` rewritten as `>=` changes
  // nothing observable, here or anywhere. The literal is a bare date and
  // every stored `created` carries a time, so no value can ever be byte-equal
  // to it. Confirmed by mutating it and re-running: 37 passed.
  it("starts at 2020, and includes the exactly-midnight row Django excluded", async () => {
    seedInInsertOrder([
      ["Pre\nHistory", "2019-12-31 23:59:59.999999"],
      ["Midnight", "2020-01-01 00:00:00.000000"],
      ["Beans", "2020-01-02 09:00:00.000000"],
    ]);

    const html = await getBody();

    // 2019-12-31 is ISO 2020-W01, so a lost cutoff would show up as "2019-1"
    // -- a bucket sitting at the far left, before the chart is meant to
    // begin, carrying two items.
    expect(chartWeeks(html)).toEqual(["2020-1"]);
    expect(chartCounts(html)).toEqual([2]);
  });

  // TICKET #7, the reason weekKey() returns null at all: a "NaN-NaN" bucket
  // rendered onto this exact chart. An unreadable `created` costs its own row
  // and nothing else -- no bucket, no label, no 500.
  //
  // All four unreadable shapes are the ones production can actually hold:
  // empty text, free text, a doubled "Z" suffix (the pre-fix "blind + Z" bug
  // that produced ticket #7), and a value with an offset, which neither
  // writer emits. Each carries three lines, so a regression that bucketed
  // them shows up as an extra bar of 12 as well as a "NaN" in the page.
  it("skips an unreadable created instead of drawing a NaN bucket (ticket #7)", async () => {
    seedInInsertOrder([
      ["Beans", "2026-07-06 09:00:00.000000"],
      ["Bad\nRow\nHere", ""],
      ["Bad\nRow\nHere", "not a timestamp"],
      ["Bad\nRow\nHere", "2026-07-07 09:00:00.000000ZZ"],
      ["Bad\nRow\nHere", "2026-07-08 09:00:00.000000+00:00"],
    ]);

    const html = await getBody();

    expect(chartWeeks(html)).toEqual(["2026-28"]);
    expect(chartCounts(html)).toEqual([1]);
    expect(tableRows(html)).toEqual([["2026-28", 1]]);
    // The literal shape of the defect, asserted on the whole page rather than
    // on the arrays: "NaN" must not appear anywhere, including in the table.
    expect(html).not.toContain("NaN");
  });

  // The other half of the timestamp story: a row written by the PORT rather
  // than by the Django import carries an ISO "T"/"Z" spelling, and it must
  // land in the same bucket as its Django-shaped neighbour rather than being
  // skipped or bucketed apart. Migration 0022 normalised the rows that
  // existed; this is what stops a future ISO writer from silently halving a
  // week.
  //
  // Note the ORDER these two arrive in: "T" (0x54) sorts after " " (0x20), so
  // the 09:00 ISO row sorts AFTER the 23:00 Django row within the same day.
  // Harmless for a weekly bucket, and pinned so that it is known to be
  // harmless rather than unexamined.
  it("buckets an ISO-8601 created with its Django-format neighbours", async () => {
    seedInInsertOrder([
      ["Beans", "2026-07-06 23:00:00.000000"],
      ["Pasta\nRice", "2026-07-06T09:00:00.000Z"],
    ]);

    const html = await getBody();

    expect(chartWeeks(html)).toEqual(["2026-28"]);
    expect(chartCounts(html)).toEqual([3]);
  });

  // This page publishes COUNTS, never the needs themselves -- the only string
  // that reaches the HTML is a week key built from two numbers. Pinned as a
  // floor: `change_text` is attacker-influenced in the weakest sense (a food
  // bank's own web page, scraped by needcheck), it is rendered raw on other
  // pages behind an admin review, and a future "show the items in a tooltip"
  // edit would put unreviewed scraped text inside a <script> block on a
  // cached public page. The test that would have to be changed first is this
  // one.
  it("never puts need text on the page, only counts", async () => {
    seedNeed("</script><script>alert(1)</script>\nBeans", "2026-07-06 09:00:00.000000");

    const html = await getBody();

    expect(chartCounts(html)).toEqual([2]);
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("Beans");
  });
});

// ===========================================================================
// Edge-case renders
// ===========================================================================

describe("edge-case renders", () => {
  // An empty table is the state of every fresh D1 preview database, so it is
  // the first thing anyone sees after a migration -- and an exception here
  // reads as "the migration broke the dashboards". `{% for %}` over an empty
  // list emits nothing, so ECharts is handed `data: []` twice, which is valid
  // JS and an empty chart.
  it("renders an empty chart rather than failing when there are no needs", async () => {
    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(chartWeeks(html)).toEqual([]);
    expect(chartCounts(html)).toEqual([]);
    expect(tableRows(html)).toEqual([]);
    // Still the real page: an empty dataset must not be mistaken for an empty
    // template, which is what a swallowed render error would look like.
    expect(html).toContain("<h1>Items requested by UK food banks per week</h1>");
    expect(html).toContain("<th>Number of items requested</th>");
  });

  // One bucket exercises the template's `{% if not loop.last %}` comma logic
  // at its only interesting boundary. A stray trailing comma inside the
  // series array is a JS syntax error in a <script> block: HTTP 200, a page
  // that looks completely normal, and a chart that never appears. Asserted on
  // the literal text, because a forgiving expectation would not see it.
  it("emits single-element arrays with no trailing comma", async () => {
    seedNeed("Beans\nPasta", "2026-09-07 09:00:00.000000");

    const html = await getBody();

    expect(dataLiteral(html, 0).replace(/\s+/g, "")).toBe("data:['2026-37'");
    expect(dataLiteral(html, 1).replace(/\s+/g, "")).toBe("data:[2");
  });

  // Every bar is separated by exactly one comma, in both arrays, with none
  // trailing. The multi-element counterpart of the test above, and the one
  // that catches a `{% if not loop.first %}` inversion -- which produces a
  // leading comma, an ECharts array whose first element is `undefined`, and a
  // chart drawn one bar to the right.
  it("comma-separates a multi-bar chart with no leading or trailing comma", async () => {
    seedInInsertOrder([
      ["Beans", "2026-01-05 09:00:00.000000"],
      ["Pasta\nRice", "2026-01-12 09:00:00.000000"],
      ["Tea", "2026-01-19 09:00:00.000000"],
    ]);

    const html = await getBody();

    expect(dataLiteral(html, 0).replace(/\s+/g, "")).toBe("data:['2026-2','2026-3','2026-4'");
    expect(dataLiteral(html, 1).replace(/\s+/g, "")).toBe("data:[1,2,1");
  });
});

// ===========================================================================
// Route wiring -- the shipped registration, not a hand-built one
// ===========================================================================

describe("route", () => {
  it("answers GET at /dashboard/items-requested-weekly/ with HTML", async () => {
    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toContain("<title>Items requested by UK food banks per week - Give Food</title>");
  });

  // The sibling by-year grid hangs off the SAME prefix ("by-year/"), and the
  // two pages share a heading, a breadcrumb, a table and both context keys --
  // `week_needs_items_desc` is literally the same variable in both templates.
  // So a handler or template registered at the wrong one of these two paths
  // does not 404, it serves a page that reads almost identically. The
  // separator is the by-year chart's per-year `legend:` block, which is the
  // one thing only that page has.
  it("is a different page from the by-year grid at the same prefix", async () => {
    seedNeed("Beans", "2026-09-07 09:00:00.000000");

    const weekly = await getBody();
    const byYear = await getBody(`${PATH}by-year/`);

    expect(weekly).toContain("<h1>Items requested by UK food banks per week</h1>");
    expect(byYear).toContain("<h1>Items requested by UK food banks per week per year</h1>");
    expect(weekly).not.toContain("legend:");
    expect(byYear).toContain("legend:");
  });

  // Registered with app.get only, so every other method falls through to the
  // site 404. Asserted by reading the database back rather than by trusting
  // the status: "a GET route able to run an UPDATE" is the failure this tier
  // exists to rule out, and the mirror of it -- a write reaching a read-only
  // dashboard -- is invisible in a 404.
  it.each(["POST", "PUT", "PATCH", "DELETE"])("does not answer %s, and touches the database not at all", async (method) => {
    seedNeed("Beans", "2026-09-07 09:00:00.000000");

    const res = await get(PATH, { method });

    expect(res.status).toBe(404);
    expect(sessionModes).toEqual([]);
    expect(prepared).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get() as { n: number }).n).toBe(1);
  });

  // gfdash sits OUTSIDE Django's i18n_patterns (givefood/urls.py's
  // "Untranslated apps" block; index.ts's locale loop skips the dashboards
  // for that reason), so there is no Welsh dashboard URL to be had. Pinned so
  // that adding one becomes a deliberate act: a /cy/ URL that quietly starts
  // answering in English is an hreflang problem, not a feature.
  it.each(["cy", "ga", "gd"])("has no /%s/ locale-prefixed form", async (locale) => {
    expect((await get(`/${locale}${PATH}`)).status).toBe(404);
  });

  // Django's APPEND_SLASH, reproduced by app.notFound() -> lib/appendSlash.ts
  // as a 301. Every internal link uses the slashed form; this is for the
  // hand-typed one, and the 301-not-302 is what keeps the page's ranking.
  it("301s the slash-less URL to the canonical one", async () => {
    const res = await get(PATH.slice(0, -1));

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
  });

  // Django decorated the view @cache_page(SECONDS_IN_DAY) (views.py:25); the
  // port's middleware/pageCacheControl.ts supplies the header half, with the
  // day on s-maxage (where the edge can be purged) and five minutes for
  // browsers (where it cannot). This page falls through to that default
  // rather than matching a named path rule, so the assertion is both "the
  // dashboard is cacheable" and "it inherited Django's day".
  it("is cacheable for a day at the edge and five minutes in the browser", async () => {
    const res = await get(PATH);

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Content-Language")).toBe("en");
    // No Cache-Tag: middleware/cacheTag.ts tags food bank and aggregate
    // paths, and a dashboard is neither, so this page is only purged
    // zone-wide. A tag appearing here would mean those rules had started
    // matching /dashboard/ by accident.
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  // HEAD reaches the handler (Hono answers it from the GET route) so the
  // query really runs, and the body is stripped -- but there is NO
  // Cache-Control, because pageCacheControl returns early for any method
  // other than GET. SUSPECT and not this module's to fix: a shared cache
  // revalidating with HEAD sees an uncacheable response for a page whose GET
  // may be held for a day. Pinned so the asymmetry is recorded rather than
  // rediscovered.
  it("answers HEAD with an empty body (and, suspiciously, no Cache-Control)", async () => {
    seedNeed("Beans", "2026-09-07 09:00:00.000000");

    const res = await get(PATH, { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(prepared).toHaveLength(1);
  });
});

// ===========================================================================
// Database discipline and failure
// ===========================================================================

describe("database use", () => {
  // ONE statement, no bound parameters, no writes, on a replica-friendly
  // session. The SQL text itself belongs to packages/db and is asserted
  // there; what this owns is the SHAPE of the access. A per-week or per-need
  // query would render this page perfectly while turning one D1 read into
  // hundreds on a page any crawler may hit at any rate.
  it("reads once, on a first-unconstrained session, and writes nothing", async () => {
    seedInInsertOrder([
      ["Beans", "2026-01-05 09:00:00.000000"],
      ["Pasta", "2026-02-05 09:00:00.000000"],
      ["Rice", "2026-03-05 09:00:00.000000"],
    ]);

    await get(PATH);

    expect(sessionModes).toEqual(["first-unconstrained"]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.params).toEqual([]);
    expect(prepared[0]?.sql).toMatch(/^\s*SELECT\b/i);
    expect(prepared[0]?.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|CREATE|ALTER)\b/i);
    // ...and NARROW. `foodbankchange` is one of the largest tables the site
    // has and this query has no LIMIT, so a `SELECT *` would drag seventeen
    // columns of every published need ever written across the D1 wire to
    // compute two numbers -- and would render an identical page while doing
    // it, which is why nothing but an assertion about the statement can see
    // it. The projection itself is packages/db's to own; this is the page
    // saying it still wants only the two columns it reads.
    expect(prepared[0]?.sql).not.toMatch(/SELECT\s+\*/i);
    expect(prepared[0]?.sql).toContain("change_text");
    expect(prepared[0]?.sql).toContain("created");
  });

  // Two identical requests give identical pages and leave the database
  // untouched. A dashboard is not a cron, but it is delivered at least once
  // per cache miss per colo and there is no ordering guarantee between those:
  // "reads are reads" is the property that makes the day-long edge cache
  // above safe to hand out, and the one that would break first if this page
  // ever grew a "record that someone looked" write.
  it("is unchanged by being requested twice", async () => {
    seedInInsertOrder([
      ["Beans", "2026-01-05 09:00:00.000000"],
      ["Pasta\nRice", "2026-01-12 09:00:00.000000"],
    ]);

    const first = await getBody();
    const rowsAfterFirst = (db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get() as { n: number }).n;
    const second = await getBody();

    expect(chartWeeks(second)).toEqual(chartWeeks(first));
    expect(chartCounts(second)).toEqual(chartCounts(first));
    expect(tableRows(second)).toEqual(tableRows(first));
    expect(rowsAfterFirst).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get() as { n: number }).n).toBe(2);
  });

  // A D1 failure must surface as the site's 500 page, not as a 200 carrying
  // an empty chart. The distinction matters more here than on a content page:
  // "no items were requested in any week" is a legible, plausible answer to
  // this page's question, so a swallowed error would look like DATA. It must
  // also not be cached -- pageCacheControl skips non-200s, so a broken render
  // does not take the day-long TTL the healthy one gets.
  it("500s on a database failure instead of rendering an empty chart", async () => {
    seedNeed("Beans", "2026-09-07 09:00:00.000000");
    vi.spyOn(console, "error").mockImplementation(() => {});
    failQueries = true;

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("500 - Internal Server Error");
    expect(html).not.toContain("<h1>Items requested by UK food banks per week</h1>");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});

// ===========================================================================
// Page furniture that comes from the route, not the template
// ===========================================================================

describe("page context", () => {
  // buildPageContext is handed `c.req.path`, not the full URL, so the
  // canonical link is query-free. THE MUTANT THIS KILLS is `path: c.req.url`,
  // a one-word edit that renders a perfectly normal-looking page carrying
  // `<link rel="canonical" href="https://www.givefood.org.uk https://www.
  // givefood.org.uk/dashboard/...?utm_source=x">` -- a doubled origin, and a
  // separate canonical for every tracking parameter anyone appends.
  it("gives the same canonical URL whatever the query string", async () => {
    const plain = await getBody(PATH);
    const withQuery = await getBody(`${PATH}?utm_source=newsletter&x=1`);

    expect(plain).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
    expect(withQuery).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
  });

  // render_time_ms is the route's own addition to the page context (Django's
  // RenderTime middleware, ported per-page rather than as a body rewrite).
  // Unwire it and the debug comment reads "Took ms", because Nunjucks renders
  // a missing variable as empty string rather than complaining -- so the
  // regex requires a digit. Whole milliseconds, deliberately: the port
  // dropped Django's three decimal places because on Workers they were always
  // ".000" (see middleware/serverTiming.ts), and the Server-Timing header
  // keeps the fraction. The pair only means anything asserted together.
  it("stamps a whole-millisecond render time into the debug comment, keeping the header's decimals", async () => {
    const res = await get(PATH);
    const html = await res.text();

    expect(html).toMatch(/⏱️ Took \d+ms/);
    expect(html).not.toMatch(/⏱️ Took \d+\.\d+ms/);
    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=\d+\.\d{3}$/);
  });

  // The breadcrumb resolves through @givefood/urls' reverse-URL table. A
  // broken name renders an empty href -- a dead breadcrumb on a page nobody
  // watches.
  //
  // A DELIBERATE DIVERGENCE, pinned so it is not "corrected" back: Django's
  // dash/weekly_itemcount.html points its own you-are-here crumb at
  // `{% url 'dash:tt_most_requested_items' %}`, i.e. at a different
  // dashboard entirely -- a copy-paste in the original. The port links the
  // crumb at this page (`url('dash:weekly_itemcount')`), which is what
  // aria-current="page" claims it is.
  it("links the breadcrumb back to the dashboard index and at itself", async () => {
    const html = await getBody();

    expect(html).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
    expect(html).toContain(`<li class="is-active"><a href="${PATH}" aria-current="page">`);
    expect(html).not.toContain("/dashboard/trusselltrust/most-requested-items/");
  });
});
