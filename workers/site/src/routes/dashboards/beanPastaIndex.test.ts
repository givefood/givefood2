import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/beanPastaIndex.ts -- GET /dashboard/bean-pasta-index/, the
// public "Beans & Pasta Index" chart. Ported from gfdash/views.py:382-391
// (`@cache_page(SECONDS_IN_DAY) def bean_pasta_index`), registered at
// gfdash/urls.py:21 as `path("bean-pasta-index/", ...)`.
//
// WHY THIS FILE EXISTS, given packages/db/src/dashboards.test.ts already runs
// the SQL row by row through a real engine. The handler is four lines with no
// branches, so nothing here can throw -- and that is precisely the problem.
// This is a PUBLIC page whose entire content is a bar chart, and every way it
// can be wrong renders a perfectly plausible chart with a 200:
//
//   * the rows not reaching the template, or reaching it under a name the
//     template does not read. `months` drives BOTH the <table> and the two
//     echarts arrays (dash/bean_pasta_index.njk:37-42, 72-74 and 89-91); rename
//     it and nunjucks renders an empty chart in silence, because
//     packages/templates/src/env.ts sets throwOnUndefined: false on purpose.
//   * a second query, or a write, creeping onto a page that is meant to be
//     one read. gfdash is entirely uncached in this port apart from the
//     Cache-Control header pageCacheControl.ts fills in, so every miss costs
//     whatever this handler does.
//   * the TTL. Django decorated the view @cache_page(SECONDS_IN_DAY); nothing
//     in this handler says so, and the day comes from pageCacheControl.ts's
//     fall-through default. A rule added above that default for /dashboard/
//     would change this page's caching with nothing in this directory to say
//     it had.
//   * the reachability of the URL itself. This is one `app.get` line in
//     index.ts:558, and dash/index.njk plus page.njk's footer both link into
//     the dashboards -- routes/admin/dupePostcodes.test.ts records the sibling
//     case where a shipped link 404ed because no route was registered.
//
// So the assertions below are on the RENDERED VALUES -- the table cells and
// the two JavaScript arrays the chart is actually built from -- and on the
// statement log, not on the status code.
//
// REAL EVERYTHING. The real app from ../../index (so the real router, the real
// middleware chain, the real trailing-slash probe and the real 500 page), the
// real Nunjucks render() through the real templates, the real
// getBeanPastaMonthCounts, and real SQLite seeded from the real migrations via
// schemaFor(). Nothing is mocked; nothing on this path leaves the machine.
// Same harness as routes/apiDocs.test.ts, which this file is modelled on.
//
// MUTATION-TESTED (TESTING.md's convention) in a copy of the whole tree in the
// scratchpad OUTSIDE the repo, never by editing a file in src/ and putting it
// back. 31 mutants applied and re-run; all 31 died. Widened past
// beanPastaIndex.ts itself, because a careless edit to any of these reaches
// this page just as surely as one to the handler. The kills worth naming,
// because each is a test's reason to exist:
//
//   index.ts -- the registration deleted; the path retyped with an underscore;
//     registered as .all so a POST is answered.
//   the handler -- `months` renamed to `monthCounts`; the rows discarded and
//     `months: []` passed; the template swapped for a sibling dashboard's; the
//     page context no longer spread in; render_time_ms dropped;
//     getBeanPastaMonthCounts called twice; the call wrapped in
//     `.catch(() => [])`; canonical built from c.req.url instead of
//     c.req.path; c.text() instead of c.html(); and an UPDATE bolted on
//     alongside the read (this repo's own scar -- a GET route left able to
//     run one, with its "does not answer GET at all" test passing throughout).
//   lib/session.ts -- the mode changed to "first-primary".
//   packages/db -- `published = 1` dropped; the WHERE parentheses removed (AND
//     binds tighter than OR); either LIKE branch dropped; ORDER BY reversed;
//     strftime('%Y-%m') widened to '%Y'; LIKE swapped for case-sensitive GLOB;
//     COUNT(*) swapped for COUNT(DISTINCT foodbank_id).
//   the template -- either chart loop deleted; either table cell hardcoded;
//     the `{% if not loop.last %}` separator inverted; the x-axis loop pointed
//     at a variable nothing sets. (A .njk edit is inert until the precompile
//     step is re-run, so the harness re-runs it -- without that a template
//     "mutant" proves nothing.)
//   middleware -- pageCacheControl's fall-through TTL raised to a week;
//     /dashboard/ added to cacheTag's aggregate purge set; elapsedMs given
//     back Django's three decimals.
//
// ONE FALSE SURVIVOR, recorded because it is the kind of thing that makes a
// mutation run read stronger than it is: the COUNT(DISTINCT) mutant "survived"
// on its first pass, because the search string
// "COUNT(*) AS count FROM foodbankchange" is a PREFIX of
// getNeedItemGroupCounts' "... FROM foodbankchangeline" nine functions higher
// up, so the edit landed on a query this page never runs. Anchored on the
// trailing quote instead, it dies on seven tests.

const ORIGIN = "https://www.givefood.org.uk";
// Hardcoded rather than read from @givefood/urls, so that the string in this
// file and the string in ROUTES/index.ts are two independent copies -- a
// rename that updated only one of them is exactly what this is guarding.
// gfdash/urls.py spells it with hyphens; Django's own reverse name (used by
// the breadcrumb below) has the underscores.
const PATH = "/dashboard/bean-pasta-index/";

type Bindable = null | number | bigint | string | Uint8Array;

// Records the SQL prepared and the values bound to it. This page's whole cost
// argument is "one statement, no parameters, once per view", and the log is
// the only place that claim is observable -- a rendered chart looks the same
// whether it took one query or four.
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

// Only the one table the statement names -- getBeanPastaMonthCounts reads
// `foodbankchange` itself, not the foodbankchange_full VIEW its excess-page
// sibling uses. Taken from the real migrations via schemaFor() rather than
// hand-written DDL: migration 0019 does `ALTER TABLE foodbankchange DROP
// COLUMN foodbank_name` long after 0001 created it, and a fixture typed out by
// hand tests the author's memory of that rather than the shipped schema
// (github #51 -- eight suites broke at once on hand-built fixtures).
const SCHEMA = schemaFor("foodbankchange");

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
// Every timestamp below is in DJANGO'S shape -- "YYYY-MM-DD HH:MM:SS.ffffff",
// what str(datetime) produces and what migration 0022 normalised the whole
// database to. Wrapping the normal shape makes the two literals deliberately
// left in other shapes (the ISO one and the malformed one, both in the
// "months the SQL cannot name" block) stand out as the anomalies they are.
const PY = (value: string) => value;

function seedChange(row: Record<string, Bindable> = {}): void {
  const n = (nextId += 1);
  const full: Record<string, Bindable> = {
    id: n,
    // 32 dashless hex characters, the real width (PLAN.md §4.4) -- the column
    // carries a UNIQUE index, so a lazy constant would collide on the second
    // row and the fixture would be one row smaller than it reads.
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

// THE FIXTURE THE MAJORITY OF THIS FILE READS, and half of it is rows that
// must NOT appear. Without those, every assertion here passes against a
// handler that ignored getBeanPastaMonthCounts and counted every need in the
// table -- the "a filter that does nothing passes every test that only seeds
// matching rows" trap.
//
// The two UNPUBLISHED rows are one per keyword, which is not padding. The
// predicate is `published = 1 AND (beans OR pasta)`, and SQL binds AND tighter
// than OR: lose the parentheses and it becomes
// `(published = 1 AND beans) OR pasta`, under which every unpublished PASTA
// need counts and every unpublished BEANS need does not. With only a beans row
// on the unpublished side that mutant lives. needcheck writes unpublished
// needs continuously, so it would roughly double the current month and leave
// history alone -- a chart that bends upward at its right-hand edge and reads
// as news.
function seedTheIndex(): void {
  seedChange({ change_text: "Beans", created: PY("2024-01-05 09:00:00.000000") });
  seedChange({ change_text: "Pasta", created: PY("2024-02-05 09:00:00.000000") });
  // Both words in one need. Counted ONCE -- written as a UNION ALL, or as two
  // queries summed, this index would double-count every need asking for both,
  // which is most of them.
  seedChange({ change_text: "Beans\nPasta\nMore beans", created: PY("2024-02-06 09:00:00.000000") });
  // Django ran Postgres's case-INSENSITIVE `~*`; the port relies on SQLite
  // folding ASCII case in LIKE (packages/db/src/dashboards.ts:249-252). If
  // that ever stopped being true the index would quietly lose every need that
  // spells the word with a capital -- and shouting item names is how food
  // banks write these lists.
  seedChange({ change_text: "BEANS", created: PY("2024-03-05 09:00:00.000000") });
  // Neither word. A real need, and the commonest kind of row in the table.
  seedChange({ change_text: "Nappies and toothpaste", created: PY("2024-03-06 09:00:00.000000") });
  // The two exclusions above, in a month that appears NOWHERE in the expected
  // output -- so a leak shows up as an extra bar rather than as a count one
  // too high, which is much harder to miss.
  seedChange({ change_text: "Beans", published: 0, created: PY("2024-04-05 09:00:00.000000") });
  seedChange({ change_text: "Pasta please", published: 0, created: PY("2024-04-06 09:00:00.000000") });
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
const get = async (path: string): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// The <table> the page prints under the chart, as "month|count" pairs. Parsed
// rather than matched as a slab of markup so the claim stays on the DATA,
// while still pinning the order and the exact strings.
function tableRows(html: string): string[] {
  const table = /<table[\s\S]*?<\/table>/.exec(html);
  if (!table) throw new Error("no <table> in the rendered page");
  return [...table[0].matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/g)].map((m) => `${m[1]}|${m[2]}`);
}

// The echarts x-axis categories, read out of the <script> the browser actually
// runs. THE TABLE IS NOT A PROXY FOR THIS: they are two separate `{% for %}`
// loops over the same variable (dash/bean_pasta_index.njk:36-43 and 68-74), so
// one can be right while the other is empty, and the chart is the half nobody
// reads the numbers off.
function chartLabels(html: string): string[] {
  const block = /xAxis: \{[\s\S]*?data: \[([\s\S]*?)\]/.exec(html);
  if (!block) throw new Error("no xAxis data array in the rendered chart");
  return [...block[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

// The bar heights, as the RAW JavaScript tokens rather than parsed numbers --
// so a count rendered as a quoted string ('3' rather than 3), which echarts
// would still plot but which is a different thing in the source, is visible
// here instead of being normalised away by the test.
function chartValues(html: string): string[] {
  const block = /type: 'bar',\s*data: \[([\s\S]*?)\]/.exec(html);
  if (!block) throw new Error("no series data array in the rendered chart");
  return block[1]!
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

describe("the route", () => {
  // gfdash/urls.py:21's path, reached through the REAL router. A test that
  // mounted its own ad-hoc Hono route would pass with index.ts:558 deleted,
  // which is the failure the sibling suite records as having shipped.
  it("answers GET /dashboard/bean-pasta-index/ with the Beans & Pasta Index page", async () => {
    seedTheIndex();

    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    // The template's own title, ampersand entity and all -- proof that
    // dash/bean_pasta_index.njk rendered and not one of the twenty sibling
    // dashboards, every one of which is the same four-line handler shape.
    expect(html).toContain("<title>Beans &amp; Pasta Index - Give Food</title>");
    expect(html).toContain("<h1>Beans &amp; Pasta Index</h1>");
    expect(html).toContain('<div id="chart" style="height:500px"></div>');
  });

  // GET ONLY. index.ts:558 registers `app.get(...)` and nothing else, so Hono
  // answers a POST with a 404.
  //
  // A DIVERGENCE FROM DJANGO, and a harmless one: Django's view is a plain
  // function with no method guard, so a POST there rendered the same page with
  // a 200. Neither writes anything; what is asserted is that the port's answer
  // is a refusal reached WITHOUT running the query, so a POST flood cannot buy
  // a full scan of foodbankchange.
  it("refuses a POST, and runs no query on the way to refusing it", async () => {
    seedTheIndex();

    const res = await app.fetch(new Request(`${ORIGIN}${PATH}`, { method: "POST" }), env(), execCtx);

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block, entirely
  // outside i18n_patterns -- beanPastaIndex.ts:8-11 says so, and index.ts:542-562
  // registers the dashboards with no locale loop. The visible half is the
  // absence of hreflang alternates (buildPageContext is called with no
  // `locale`, so `languages` is empty and page.njk emits nothing); the routing
  // half is that no /cy/ form of this URL exists at all.
  it("is English-only: no hreflang alternates, and no language-prefixed URL", async () => {
    seedTheIndex();

    const html = await body(PATH);

    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).not.toContain("hreflang");
    expect((await get(PATH)).headers.get("Content-Language")).toBe("en");
    expect((await get("/cy/dashboard/bean-pasta-index/")).status).toBe(404);
  });

  // THE TRAILING SLASH COSTS A FULL RENDER AND A D1 READ. lib/appendSlash.ts
  // answers Django's APPEND_SLASH by re-entering the app with a HEAD request
  // for the slashed URL and redirecting if it does not 404 -- so
  // /dashboard/bean-pasta-index runs this handler in full, scans
  // foodbankchange, renders the whole document and throws the body away, all
  // to produce a 301 with no content. Pinned rather than fixed: it is how the
  // probe is documented to work, and it is the kind of cost that is invisible
  // in every metric except D1 rows read.
  it("301s a missing trailing slash, having really executed the handler to find out", async () => {
    seedTheIndex();

    const res = await get("/dashboard/bean-pasta-index");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
    expect(prepared).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// what the page shows
// ---------------------------------------------------------------------------

describe("what the page shows", () => {
  beforeEach(seedTheIndex);

  // THE PAGE'S WHOLE PAYLOAD. One row per month, oldest first, with the count
  // -- and no 2024-04 row, which is where both unpublished needs live.
  //
  // The counts are asymmetric on purpose (1, 2, 1 rather than 1, 1, 1): a
  // handler that rendered one row per NEED rather than the grouped rows, or a
  // GROUP BY that collapsed to a single bucket, produces a differently-shaped
  // list rather than the same list with a wrong number in it.
  it("prints one table row per month, oldest first, with the need count", async () => {
    expect(tableRows(await body(PATH))).toEqual(["2024-01|1", "2024-02|2", "2024-03|1"]);
  });

  // THE CHART, which is the artifact -- the table under it is the footnote.
  // Two independent `{% for %}` loops over `months` build these two arrays, so
  // they are asserted separately from the table and from each other: a
  // template edit that broke only the series leaves a correctly-labelled
  // x-axis with no bars on it, and a 200.
  it("drives the echarts x-axis and the bar series from the same months, in the same order", async () => {
    const html = await body(PATH);

    expect(chartLabels(html)).toEqual(["2024-01", "2024-02", "2024-03"]);
    expect(chartValues(html)).toEqual(["1", "2", "1"]);
  });

  // Named separately from the two tests above so a failure says WHICH rule
  // broke. 2024-04 holds nothing but the two unpublished needs, so its absence
  // from the page is the whole assertion -- see seedTheIndex()'s comment for
  // why there is one unpublished row per keyword rather than one in total.
  it("never shows a month whose only needs are unpublished", async () => {
    const html = await body(PATH);

    expect(html).not.toContain("2024-04");
    expect(chartLabels(html)).not.toContain("2024-04");
  });

  // An empty database is a 200 with an empty table and two empty arrays, not a
  // 404 and not a broken script. This is what a fresh environment and any
  // database-restore window look like, and echarts renders an empty chart
  // frame quite happily -- what it must not get is a syntax error, which is
  // what a half-emitted loop would produce.
  it("renders an empty chart rather than 404ing when nothing matches", async () => {
    db.prepare("DELETE FROM foodbankchange").run();

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(tableRows(html)).toEqual([]);
    expect(chartLabels(html)).toEqual([]);
    expect(chartValues(html)).toEqual([]);
    // The rest of the page is untouched -- the empty case degrades the chart,
    // not the document.
    expect(html).toContain("<h1>Beans &amp; Pasta Index</h1>");
  });

  // A SINGLE MONTH, because the template separates array elements with
  // `{% if not loop.last %},{% endif %}` and the one-element case is the one
  // where that condition never fires. Cheap, and it is the shape a brand new
  // deployment's first month has.
  it("emits a one-element chart array without a stray separator", async () => {
    db.prepare("DELETE FROM foodbankchange").run();
    seedChange({ change_text: "Pasta", created: PY("2025-07-07 09:00:00.000000") });

    const html = await body(PATH);

    expect(chartLabels(html)).toEqual(["2025-07"]);
    expect(chartValues(html)).toEqual(["1"]);
    expect(tableRows(html)).toEqual(["2025-07|1"]);
  });
});

// ---------------------------------------------------------------------------
// months the SQL cannot name
// ---------------------------------------------------------------------------

describe("months the SQL cannot name", () => {
  // NOT A DJANGO PARITY POINT -- A CONSEQUENCE OF THE PORT'S STORAGE. Postgres
  // held `created` as a real timestamp, so `to_char(created, 'YYYY-MM')` could
  // never fail to produce a month. D1 holds it as TEXT, and strftime returns
  // NULL for anything it cannot parse; NULL sorts FIRST in SQLite's ascending
  // order, so the row arrives at the head of `months` and nunjucks (with
  // throwOnUndefined off, deliberately) prints it as an empty string.
  //
  // The result is a nameless leading bar on a public chart, with a real count
  // under it: '' as the first x-axis category, and an empty first cell in the
  // table. SUSPECT, and reported rather than fixed -- pinning what the code
  // does is the point, and the seed itself is contrived (migration 0022
  // normalised every stored timestamp to the Django shape, so a row like this
  // should not exist today). It is here because it is the page's one silent
  // corruption mode, and because a future writer that skips @givefood/models'
  // pyDatetime would reintroduce it with nothing to say so.
  it("renders an unparseable created date as a nameless leading bar", async () => {
    seedChange({ change_text: "Beans", created: PY("2024-05-05 09:00:00.000000") });
    seedChange({ change_text: "Beans", created: "not a date at all" });

    const html = await body(PATH);

    expect(chartLabels(html)).toEqual(["", "2024-05"]);
    expect(chartValues(html)).toEqual(["1", "1"]);
    expect(tableRows(html)).toEqual(["|1", "2024-05|1"]);
  });

  // THE OTHER SHAPE, and the one that really was in this database: rows
  // written by the port before migration 0022 carried toISOString() values
  // ("2024-06-07T09:00:00.000Z"). SQLite's strftime accepts the 'T' and the
  // 'Z', so those rows group into the correct month and merge with their
  // Django-shaped neighbours rather than forming a second bar. Asserted
  // because the failure would be invisible in every other test here -- the
  // fixtures are uniformly Django-shaped -- and because the equivalent
  // ordering hazard (a 'T' sorting above a ' ' in an ORDER BY over the same
  // column) has already cost this repo a defect.
  it("still groups a legacy toISOString() timestamp into its real month", async () => {
    seedChange({ change_text: "Beans", created: PY("2024-06-06 09:00:00.000000") });
    seedChange({ change_text: "Pasta", created: "2024-06-07T09:00:00.000Z" });

    const html = await body(PATH);

    expect(chartLabels(html)).toEqual(["2024-06"]);
    expect(chartValues(html)).toEqual(["2"]);
  });
});

// ---------------------------------------------------------------------------
// what the request costs
// ---------------------------------------------------------------------------

describe("what the request costs", () => {
  beforeEach(seedTheIndex);

  // ONE statement, a READ, over ONE session. The query is an unindexed scan of
  // foodbankchange with two leading-wildcard LIKEs -- no index can serve
  // `LIKE '%beans%'` -- so on the live table this is a full scan, and D1 meters
  // rows read. A second call to getBeanPastaMonthCounts (the shape a careless
  // "let me also compute a total" edit takes) doubles that with nothing visible
  // on the page to show for it.
  it("issues exactly one statement, a read, over exactly one D1 session", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get() as { n: number }).n;

    await get(PATH);

    expect(prepared).toEqual([
      "SELECT strftime('%Y-%m', created) AS the_month, COUNT(*) AS count FROM foodbankchange " +
        "WHERE published = 1 AND (change_text LIKE '%beans%' OR change_text LIKE '%pasta%') " +
        "GROUP BY the_month ORDER BY the_month",
    ]);
    expect(prepared[0]!).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
    // No bound parameters at all: the whole statement is a fixed string, so
    // there is nothing on this page a query string could reach.
    expect(bound).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get() as { n: number }).n).toBe(before);
    // lib/session.ts's mode. "first-primary" would work and would silently
    // give up read-replica eligibility on a page that has no consistency
    // requirement whatsoever.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // Two views in a row must be identical and must still be one statement each.
  // This is the assertion a "let me cache the answer in a table" change trips
  // over, and it is also what says the page is safe to reload -- which is what
  // an operator watching the index move actually does.
  it("is idempotent across repeated views", async () => {
    const first = await body(PATH);
    prepared = [];
    const second = await body(PATH);

    expect(tableRows(second)).toEqual(tableRows(first));
    expect(chartValues(second)).toEqual(chartValues(first));
    expect(prepared).toHaveLength(1);
  });

  // NOTHING IN THE URL REACHES THE QUERY. The handler takes no parameters at
  // all, so a query string is inert -- asserted because "let me make this page
  // filterable" is the obliging edit that would put user input into a
  // statement built by string concatenation (which is how the sibling
  // getDeliveryMonthCounts interpolates its metric, from an allowlist).
  it("ignores a query string entirely", async () => {
    const html = await body(`${PATH}?published=0&month=2024-04&limit=100000`);

    expect(tableRows(html)).toEqual(["2024-01|1", "2024-02|2", "2024-03|1"]);
    expect(prepared).toHaveLength(1);
    expect(bound).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// caching
// ---------------------------------------------------------------------------

describe("caching", () => {
  beforeEach(seedTheIndex);

  // Django's view carries @cache_page(SECONDS_IN_DAY) (gfdash/views.py:382),
  // and the port reproduces the shared half of that number -- but NOT from
  // anything in this route file: /dashboard/... matches no rule in
  // middleware/pageCacheControl.ts, so the day is its FALL-THROUGH DEFAULT.
  // That is the fact worth pinning here, because it means a new rule added
  // above the default changes this page's TTL with nothing in this directory
  // to say it had. The 300-second browser max-age is pageCacheControl's own
  // documented divergence (a browser cache cannot be purged).
  it("gets Django's day of shared cache, via pageCacheControl's default", async () => {
    expect((await get(PATH)).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // No Cache-Tag, so publishing a need cannot purge this page: the index goes
  // stale for up to a day. middleware/cacheTag.ts's AGGREGATE_PATHS covers the
  // home page, the sitemaps, the feeds and the API list endpoints, and no
  // dashboard is in it. That matches Django, which cached the same page for a
  // day with no invalidation at all, so it is ported behaviour rather than a
  // regression -- pinned so a future purge-list change has something to fail
  // against.
  it("carries no cache tag, so a newly published need cannot purge it", async () => {
    expect((await get(PATH)).headers.get("Cache-Tag")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the shared page context
// ---------------------------------------------------------------------------

describe("the shared page context", () => {
  beforeEach(seedTheIndex);

  // buildPageContext({ path: c.req.path }) -- canonical is the request's own
  // path, matching context_processors.py:19 (SITE_DOMAIN + the path).
  it("declares itself canonical at its own URL", async () => {
    expect(await body(PATH)).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
  });

  // The debug comment's "Took Nms" is elapsedMs(c), read off the timestamp
  // middleware/serverTiming.ts stored. Whole milliseconds, deliberately not
  // Django's three decimals (performance.now() only advances at I/O boundaries
  // on Workers, so the fraction was always exactly ".000"). The failure this
  // catches is the string "NaN": elapsedMs subtracts an unset context variable
  // if the handler is ever reached without serverTiming in front of it.
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

  // The breadcrumb and logo hrefs come from @givefood/urls' reverse table
  // (`url('index')`, `url('dash:index')`, `url('dash:bean_pasta_index')`),
  // which is how Django's own template built them. If that table moved, the
  // page would still render with a 200 and every link on it would point at a
  // 404 -- and the self-referencing third crumb is the one that would say so.
  it("builds its breadcrumbs from the reverse-URL table", async () => {
    const html = await body(PATH);

    expect(html).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
    expect(html).toContain(`<li class="is-active"><a href="${PATH}" aria-current="page">Beans &amp; Pasta Index</a></li>`);
  });
});

// ---------------------------------------------------------------------------
// when the query fails
// ---------------------------------------------------------------------------

describe("when the query fails", () => {
  // The handler has no try/catch, which is the right call and is worth pinning
  // as such. The defensive-looking alternative -- catching and rendering with
  // `months: []` -- would publish a chart saying nobody has asked for beans or
  // pasta in the whole history of the site, when what actually happened is
  // that D1 was unavailable. An empty chart on a data page is a claim, and a
  // false one is worse than an error page.
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
    // Not a partial page: the chart's own script must not be on it, or a
    // reader gets a 500 that still draws an empty graph.
    expect(html).not.toContain('<div id="chart"');
  });
});
