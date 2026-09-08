import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/itemGroups.ts -- GET /dashboard/item-groups/, the public
// "Requested items by item group" pie chart. Ported from gfdash/views.py:209-217
// (`@cache_page(SECONDS_IN_DAY) def item_groups`), registered at
// gfdash/urls.py:14 as `path("item-groups/", item_groups, name="item_groups")`.
//
// WHY THIS FILE EXISTS. The handler is five lines with no branches, so nothing
// in it can throw -- and that is exactly why it needs testing at this level.
// The page is a pie chart plus a table, and every way it can be wrong renders
// a perfectly plausible one with a 200:
//
//   * IT IS A COPY OF ITS NEIGHBOUR. itemCategories.ts is the same five lines
//     against getNeedItemCategoryCounts, and the two files differ only in the
//     query, the context key and the template name. Left calling the category
//     query, this page renders a table of four EMPTY name cells (the rows come
//     back keyed `category`, dash/item_groups.njk reads `group_name`, and
//     packages/templates/src/env.ts sets throwOnUndefined: false on purpose) --
//     with correct-looking counts beside them and a 200. That is the single
//     most likely defect here, and the exact-SQL assertion plus the rendered
//     cell values are what catch it.
//   * `chart_data_json` IS BUILT IN THIS FILE, not in the template -- the one
//     real divergence from Django, whose template hand-builds the JS array
//     literal instead (see the escaping block near the foot of this file). So
//     the mapping `{ value: row.count, name: row.group_name }` exists nowhere
//     but here: swap the two and echarts gets a slice list with numeric names
//     and undefined sizes, drawing nothing, while the table underneath stays
//     perfect. Asserted as the exact JSON the page carries.
//   * THE TWO HALVES OF THE PAGE COME FROM DIFFERENT PLACES. The table walks
//     `groups` in nunjucks; the chart reads a string this handler serialised.
//     They can disagree -- in content, in order, and in formatting (the table
//     is intcomma'd, the chart must not be) -- and only one of them is what a
//     reader takes a number off.
//   * ORDER IS THE ENTIRE MEANING OF A PIE CHART, and `ORDER BY count DESC`
//     lives in packages/db. SQLite answers a GROUP BY through a temp b-tree
//     keyed on the group column, so rows come back in group-NAME order whether
//     or not the query asks for one -- a fixture whose biggest group is also
//     alphabetically first cannot see the clause at all. The fixture below is
//     built so the two orders disagree in both directions.
//
// REAL EVERYTHING, the harness the sibling dashboard suites use: the real
// production app (workers/site/src/index.ts's default export), so the route
// registration, resolveLanguage, appendSlash, cacheTag and pageCacheControl are
// the shipped articles rather than a hand-built router; the real Nunjucks
// templates through the real render(); the real getNeedItemGroupCounts; and
// real in-memory SQLite built by schemaFor() from the real migrations, so
// foodbankchangeline's columns are the shipped ones (`group_name`, not
// Postgres's reserved `group` -- migration 0003_homepage_data.sql:32) rather
// than this author's memory of them. Mocked: the two KV namespaces, because
// there is no local double and nothing on this path touches them.
//
// MUTATION-TESTED in a copy of the whole tree in the scratchpad OUTSIDE the
// repo -- see the list at the foot of this file.

const ORIGIN = "https://www.givefood.org.uk";
// Hardcoded rather than imported from @givefood/urls, so the string here and
// the string in index.ts:551 are two independent copies: a rename that updated
// only one of them is what this is guarding. Django spells the URL with a
// hyphen and its reverse name (which the breadcrumb below uses) with an
// underscore, which is why both spellings appear in this file.
const PATH = "/dashboard/item-groups/";

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite. Records
// the SQL prepared and anything bound to it: this page's whole cost story is
// "one parameterless read per view", and a rendered chart looks identical
// whether it took one statement or five.
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

// The one table the statement names. From the real migrations via schemaFor()
// rather than hand-written DDL -- github #51 is the record of eight suites
// breaking at once on hand-built fixtures when a shared query started reading
// an object they did not have.
const SCHEMA = schemaFor("foodbankchangeline");

// The exact statement getNeedItemGroupCounts prepares
// (packages/db/src/dashboards.ts:121). Written out in full because the
// copy-of-its-neighbour failure described at the top of this file differs from
// the correct query by one word -- `foodbankchangeline`'s `group_name` column
// versus `category` -- and both render a 200.
const SQL = "SELECT group_name, COUNT(*) AS count FROM foodbankchangeline WHERE type = 'need' GROUP BY group_name ORDER BY count DESC";

let db: DatabaseSync;
let prepared: string[];
let bound: Bindable[][];
let sessionModes: string[];
let nextId: number;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      // Recorded rather than ignored: lib/session.ts asks for
      // "first-unconstrained", which is what makes this read eligible for a D1
      // read replica, and one entry per request is how the tests below know
      // the handler opened exactly one session.
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

// Every column foodbankchangeline declares NOT NULL is supplied, so a seeded
// row is one production would have accepted. `created` is in DJANGO'S shape
// ("YYYY-MM-DD HH:MM:SS.ffffff", what str(datetime) produces and what migration
// 0022 normalised the whole table to) even though this query never reads it --
// a fixture that is wrong in an unread column is a trap for the next person to
// add a test here.
function seedLine(row: Record<string, Bindable> = {}): void {
  const n = (nextId += 1);
  const full: Record<string, Bindable> = {
    id: n,
    need_id: 1,
    foodbank_id: 1,
    item: `Item ${n}`,
    type: "need",
    category: "Baked Beans",
    group_name: "Meal Food",
    created: "2024-01-01 12:00:00.000000",
    ...row,
  };
  const columns = Object.keys(full);
  db.prepare(`INSERT INTO foodbankchangeline (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((c) => full[c] as Bindable),
  );
}

function seedLines(count: number, row: Record<string, Bindable>): void {
  for (let i = 0; i < count; i += 1) seedLine(row);
}

// THE FIXTURE IS THE TEST.
//
// REAL GROUP NAMES, not invented ones: `group` is not free text, it is derived
// on save from a fixed lookup (givefood/models/needs.py:374,
// `self.group = ITEM_CATEGORY_GROUPS[self.category]`), whose eight values are
// listed in givefood/const/item_types.py:3-54 -- Meal Food, Snack Food, Drink,
// Cooking, Cleaning, Toiletries, Baby Supplies, Other. Using them keeps the
// escaping tests further down honest about what is and is not reachable.
//
// THE COUNTS ARE 5/3/2/1 AND DELIBERATELY NOT ALPHABETICAL. By count they read
// Meal Food, Toiletries, Drink, Baby Supplies; alphabetically ascending they
// read Baby Supplies, Drink, Meal Food, Toiletries and descending the reverse
// of that. All three orders differ, and so does count-ascending -- so a lost or
// inverted ORDER BY, or SQLite's own group-name ordering showing through, is
// visible on the page rather than hidden behind a fixture that happens to agree.
//
// CLEANING IS FOUR EXCESS LINES AND NOTHING ELSE. Without it every assertion
// below passes against a query with no `type = 'need'` filter at all -- "a
// filter that does nothing passes every test that only seeds matching rows".
// Four, not one, so a leak would put Cleaning SECOND on the chart rather than
// last, which is the difference between an obvious failure and a plausible one.
function seed(): void {
  seedLines(5, { group_name: "Meal Food", category: "Baked Beans" });
  seedLines(3, { group_name: "Toiletries", category: "Toilet Roll" });
  seedLines(2, { group_name: "Drink", category: "Tea" });
  seedLines(1, { group_name: "Baby Supplies", category: "Nappies" });
  seedLines(4, { group_name: "Cleaning", category: "Laundry", type: "excess" });
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

// The <table> under the chart, as "group|count" pairs in document order. Parsed
// rather than matched as a slab of markup, so the claims stay on the DATA while
// still pinning the order and the exact strings. The header row is <th>, so it
// cannot match.
function tableRows(html: string): string[] {
  const table = /<table[\s\S]*?<\/table>/.exec(html);
  if (!table) throw new Error("no <table> in the rendered page");
  return [...table[0].matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/g)].map((m) => `${m[1]}|${m[2]}`);
}

// The chart's `data:` array EXACTLY as it appears in the page -- the raw text,
// not a parsed object. dash/item_groups.njk emits `data: {{ chart_data_json|safe }},`
// on a line of its own, and `|safe` means whatever this handler serialised is
// what the browser parses as JavaScript. Reading it raw is the only way the
// escaping tests below can see the difference between a quote the page escaped
// and one it did not -- JSON.parse would normalise exactly the thing under test.
//
// The one character trimmed is the template's OWN trailing comma, which
// separates `data:` from the `emphasis:` key after it. It is fixed template
// punctuation rather than anything the handler produced, and a serialised array
// can never itself end in a comma (JSON.stringify closes with `]`), so removing
// it cannot hide a defect and keeps every expectation below readable as the
// JSON it is.
function chartDataLine(html: string): string {
  const match = /^\s*data: (.*)$/m.exec(html);
  if (!match) throw new Error("no chart data array in the rendered page");
  const line = (match[1] as string).trim();
  return line.endsWith(",") ? line.slice(0, -1) : line;
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

describe("the route", () => {
  // gfdash/urls.py:14's path, reached through the REAL router. A suite that
  // mounted its own ad-hoc Hono route would pass with index.ts:551 deleted --
  // routes/admin/dupePostcodes.test.ts records the sibling case where a link
  // shipped in a template 404ed because no route was registered.
  //
  // The title and <h1> are asserted because twenty dashboards share this
  // handler's shape, and the template name is a string literal: pointed at a
  // sibling .njk the page still renders, with `groups` simply unread.
  it("answers GET /dashboard/item-groups/ with the item-group page", async () => {
    seed();

    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Requested items by item group - Give Food</title>");
    expect(html).toContain("<h1>Requested items by item group</h1>");
    // 600px, where the neighbouring dashboards use 500 -- the cheapest
    // available proof that THIS template rendered and not item_categories.njk.
    expect(html).toContain('<div id="chart" style="height:600px"></div>');
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

  // GET ONLY. index.ts:551 registers app.get() and nothing else.
  //
  // A DIVERGENCE FROM DJANGO, and a harmless one: Django's view is a plain
  // function with no method guard, so a POST there rendered the same page with
  // a 200. What matters is that the port's refusal is reached WITHOUT running
  // the query -- so a POST flood cannot buy repeated scans of
  // foodbankchangeline (332,440 rows in production, PLAN.md 5521). This repo
  // has already shipped a GET route able to run an UPDATE, which is why the
  // method registration is asserted rather than assumed.
  it("refuses a POST, and runs no query on the way to refusing it", async () => {
    seed();

    const res = await get(PATH, { method: "POST" });

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
    expect(sessionModes).toEqual([]);
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block (it is
  // included at urls.py:98, outside i18n_patterns), and index.ts:542-567
  // registers the dashboards with
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
  // re-entering the app with a HEAD request for the slashed URL and
  // redirecting if that does not 404. So /dashboard/item-groups runs this
  // handler in full -- one statement, the whole document rendered and thrown
  // away -- to produce a 301 with no body. Pinned rather than filed: it is how
  // the probe is documented to work, and it is the kind of cost that shows up
  // in no metric except D1 rows read.
  it("301s a missing trailing slash, having really executed the handler to find out", async () => {
    seed();

    const res = await get("/dashboard/item-groups");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
    expect(prepared).toEqual([SQL]);
  });
});

// ---------------------------------------------------------------------------
// what the page shows
// ---------------------------------------------------------------------------

describe("what the page shows", () => {
  beforeEach(seed);

  // THE TABLE, in full. Four groups, biggest first, with the excess-only
  // Cleaning group absent -- the counts are 5/3/2/1 precisely so that a
  // differently-ordered or differently-filtered answer is a different LIST
  // rather than the same list with one number out.
  //
  // The names are the assertion as much as the numbers: they arrive keyed
  // `group_name` (Django's queryset says `.values("group")`; migration 0003
  // renamed the column to dodge quoting a reserved word), and
  // dash/item_groups.njk reads `group.group_name`. A query aliased back to
  // `group` -- or the neighbouring category query called by mistake -- renders
  // this table with four empty name cells and these exact counts.
  it("prints one table row per group, most-requested first, with the item count", async () => {
    expect(tableRows(await body(PATH))).toEqual(["Meal Food|5", "Toiletries|3", "Drink|2", "Baby Supplies|1"]);
  });

  // THE CHART IS THE ARTIFACT; the table under it is the footnote. Asserted as
  // the exact JSON text on the page rather than as a parsed structure, because
  // three separate things are being pinned at once and only the raw line shows
  // all three: the ORDER (same as the table), the MAPPING
  // (`{ value: count, name: group_name }` -- swap them and echarts draws
  // nothing while the table stays perfect), and the KEY NAMES echarts requires.
  it("serialises the same groups, in the same order, as the echarts pie slices", async () => {
    expect(chartDataLine(await body(PATH))).toBe(
      '[{"value":5,"name":"Meal Food"},{"value":3,"name":"Toiletries"},{"value":2,"name":"Drink"},{"value":1,"name":"Baby Supplies"}]',
    );
  });

  // Named separately from the two tests above so a failure says WHICH rule
  // broke. Cleaning exists only as excess lines, and this dashboard is about
  // what food banks ASK for; the excess list is a different page
  // (/dashboard/most-excess-items/). Both halves of the page are checked,
  // because the filter is applied once in SQL and a leak would reach them
  // together -- but a template edit could reach only one.
  it("never counts an excess line, in the table or in the chart", async () => {
    const html = await body(PATH);

    expect(html).not.toContain("Cleaning");
    expect(tableRows(html).some((row) => row.startsWith("Cleaning"))).toBe(false);
    expect(chartDataLine(html)).not.toContain("Cleaning");
  });

  // THE TABLE AND THE CHART FORMAT THE SAME NUMBER DIFFERENTLY, on purpose:
  // `{{ group.count|intcomma }}` in the cell, the raw integer in the JSON. A
  // careless "make these consistent" edit is a real defect in either direction
  // -- `{"value":1,234}` is not JavaScript at all, and a syntax error in an
  // inline <script> is invisible server-side and leaves an empty chart div on
  // an otherwise perfect page; while a raw 332440 in the table is the kind of
  // number this site prints for its biggest group (foodbankchangeline holds
  // 332,440 rows in production, PLAN.md 5521). 1,234 rows seeded rather than
  // some smaller number because intcomma does nothing at all below 1000.
  it("puts thousands separators in the table cell and never in the chart data", async () => {
    db.prepare("DELETE FROM foodbankchangeline").run();
    seedLines(1234, { group_name: "Meal Food" });

    const html = await body(PATH);

    expect(tableRows(html)).toEqual(["Meal Food|1,234"]);
    expect(chartDataLine(html)).toBe('[{"value":1234,"name":"Meal Food"}]');
  });

  // A SINGLE GROUP, which is the case Django's template got wrong-shaped:
  // there the array is hand-built with `{% if not forloop.last %},{% endif %}`
  // between elements, so the one-element case is the branch that never fires.
  // JSON.stringify has no such branch, and that is the point of the port's
  // divergence -- pinned so the page cannot quietly go back to building the
  // literal in the template.
  it("emits a one-element chart array with no stray separator", async () => {
    db.prepare("DELETE FROM foodbankchangeline").run();
    seedLine({ group_name: "Other", category: "Pet Food" });

    const html = await body(PATH);

    expect(chartDataLine(html)).toBe('[{"value":1,"name":"Other"}]');
    expect(tableRows(html)).toEqual(["Other|1"]);
  });

  // AN EMPTY DATABASE IS A 200 WITH AN EMPTY CHART, not a 404 and not a broken
  // script. This is what a fresh environment and any restore window look like.
  // `[]` is valid JavaScript and echarts renders an empty frame quite happily;
  // what it must not get is a syntax error, which is what a half-emitted loop
  // would have produced -- and note this is the case where the Django original
  // emits `data: [\n\n]`, whitespace and all.
  it("renders an empty chart rather than failing when nothing has been requested", async () => {
    db.prepare("DELETE FROM foodbankchangeline").run();

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(tableRows(html)).toEqual([]);
    expect(chartDataLine(html)).toBe("[]");
    // The empty case degrades the chart, not the document: the header row of
    // the table survives, which is what distinguishes "no data" from "the
    // table did not render".
    expect(html).toContain("<th>Group</th>");
    expect(html).toContain("<h1>Requested items by item group</h1>");
  });

  // GROUPING IS CASE-SENSITIVE, because SQLite's default collation is BINARY
  // and Postgres's text equality was too -- so the port and the original agree
  // that "Drink" and "drink" are two groups. Not a hypothetical: the values are
  // written by ITEM_CATEGORY_GROUPS lookups, and a single mis-cased entry added
  // to that table would split a slice in two on this chart rather than raising
  // anywhere. Asserted so that "helpfully" adding COLLATE NOCASE to the GROUP
  // BY -- which would merge the slices and change the totals -- has to be a
  // decision rather than a tidy-up.
  it("treats two spellings of a group name as two groups", async () => {
    db.prepare("DELETE FROM foodbankchangeline").run();
    seedLines(2, { group_name: "Drink" });
    seedLine({ group_name: "drink" });

    expect(tableRows(await body(PATH))).toEqual(["Drink|2", "drink|1"]);
  });
});

// ---------------------------------------------------------------------------
// escaping -- the port's one real divergence from the Django template
// ---------------------------------------------------------------------------
//
// Django's dash/item_groups.html builds the array in the template:
//   {value: {{ group.count }}, name: "{{ group.group|safe }}"}
// `|safe` only skips HTML escaping; it does nothing about JS-string escaping,
// so a group name containing a double quote ends the string and breaks the
// whole config. itemGroups.ts:21-23 serialises with JSON.stringify instead,
// which the module's comment says "escapes correctly for both". It escapes the
// quote. It does not escape `</script>` -- see the second test.

describe("escaping the group name into the inline script", () => {
  // THE HALF THE PORT REALLY DOES FIX, and the contrast between the two
  // renderings of one value in one page. The same name goes through nunjucks'
  // autoescape in the table cell (`&amp;`, `&quot;`) and through
  // JSON.stringify in the script (a literal `&`, a backslash-escaped quote) --
  // correct in both places, and different in both places. Escaping the JSON
  // for HTML too would put `&quot;` inside a JavaScript string literal, which
  // is a syntax error rather than a display bug.
  it("escapes a quote for JavaScript in the chart and for HTML in the table", async () => {
    seedLine({ group_name: 'Cleaning & "Household"' });

    const html = await body(PATH);

    expect(tableRows(html)).toEqual(["Cleaning &amp; &quot;Household&quot;|1"]);
    expect(chartDataLine(html)).toBe('[{"value":1,"name":"Cleaning & \\"Household\\""}]');
  });

  // SUSPECT, PINNED AS-IS. JSON.stringify does not escape `/`, and `|safe`
  // means nothing escapes the `<` either -- so a group name containing the
  // literal text `</script>` is emitted verbatim inside the inline <script>,
  // and an HTML parser ends the script element THERE. The rest of the echarts
  // config lands in the document as text and anything after it is live markup:
  // that is the classic script-block breakout, and it is exactly the failure
  // itemGroups.ts:12-16 claims JSON.stringify prevents. The comment overclaims;
  // the code is still strictly safer than Django's, which breaks on the quote
  // as well.
  //
  // NOT reachable from today's data, which is why it is pinned rather than
  // treated as a live vulnerability: `group` is not user input at all --
  // givefood/models/needs.py:374 sets it from ITEM_CATEGORY_GROUPS[category],
  // a hardcoded dict of eight plain-ASCII values
  // (givefood/const/item_types.py:3-54). It becomes reachable the day a group
  // name is editable, so the assertion is here to fail loudly then, and it is
  // reported rather than fixed because these tests pin what the code does.
  it("does NOT escape a literal </script> in a group name -- the script block ends early", async () => {
    seedLine({ group_name: "Other</script><b>x" });

    const html = await body(PATH);

    // Escaped correctly in the table, where nunjucks' autoescape is in charge.
    expect(tableRows(html)).toEqual(["Other&lt;/script&gt;&lt;b&gt;x|1"]);
    // And NOT escaped in the script, where it is the terminator.
    expect(chartDataLine(html)).toBe('[{"value":1,"name":"Other</script><b>x"}]');
  });

  // The degenerate value the closed set cannot currently produce but the column
  // permits (group_name is NOT NULL, so "" is the emptiest a row can be): an
  // unnamed slice on the pie and an empty first cell in the table, both with a
  // real count beside them. Pinned because the alternative behaviours -- an
  // error, or the row being dropped -- would both be worse discoveries in
  // production than a nameless slice, and because it documents that nothing
  // downstream of the query filters the rows at all.
  it("renders an empty group name as an unnamed slice rather than dropping the row", async () => {
    seedLines(2, { group_name: "" });
    seedLine({ group_name: "Drink" });

    const html = await body(PATH);

    expect(tableRows(html)).toEqual(["|2", "Drink|1"]);
    expect(chartDataLine(html)).toBe('[{"value":2,"name":""},{"value":1,"name":"Drink"}]');
  });
});

// ---------------------------------------------------------------------------
// what the request costs
// ---------------------------------------------------------------------------

describe("what the request costs", () => {
  beforeEach(seed);

  // ONE statement, a READ, over ONE session, with nothing bound. The query
  // aggregates the whole of foodbankchangeline and D1 meters rows read, so a
  // second call to getNeedItemGroupCounts -- the shape a careless "let me also
  // show a total" edit takes -- doubles the cost of the page with nothing
  // visible to show for it.
  it("issues exactly one statement, a read, over exactly one D1 session", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM foodbankchangeline").get() as { n: number }).n;

    await get(PATH);

    expect(prepared).toEqual([SQL]);
    expect(prepared[0]!).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
    // No bound parameters at all: the statement is a fixed string, so there is
    // nothing on this page any part of the request could reach.
    expect(bound).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM foodbankchangeline").get() as { n: number }).n).toBe(before);
    // lib/session.ts's mode. "first-primary" would work identically here and
    // would silently give up read-replica eligibility on a page with no
    // consistency requirement whatsoever.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // Two views in a row are byte-identical in the parts that carry data, and
  // each is still one statement. This is the assertion a "let me cache the
  // answer in a table" change trips over, and it is also what says the page is
  // safe to reload -- which is what someone watching these numbers actually
  // does.
  it("is idempotent across repeated views", async () => {
    const first = await body(PATH);
    prepared = [];
    const second = await body(PATH);

    expect(tableRows(second)).toEqual(tableRows(first));
    expect(chartDataLine(second)).toEqual(chartDataLine(first));
    expect(prepared).toEqual([SQL]);
  });

  // NOTHING IN THE URL REACHES THE QUERY. The handler takes no parameters, so
  // a query string is inert -- asserted because "let me make this page
  // filterable" is the obliging edit that would put a request value into a
  // statement, and the sibling getDeliveryMonthCounts already interpolates its
  // metric (from an allowlist) rather than binding it.
  it("ignores a query string entirely", async () => {
    const html = await body(`${PATH}?type=excess&group=Cleaning&limit=100000`);

    expect(tableRows(html)).toEqual(["Meal Food|5", "Toiletries|3", "Drink|2", "Baby Supplies|1"]);
    expect(prepared).toEqual([SQL]);
    expect(bound).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// caching
// ---------------------------------------------------------------------------

describe("caching", () => {
  beforeEach(seed);

  // Django's view carries @cache_page(SECONDS_IN_DAY) (gfdash/views.py:209),
  // and the port reproduces the shared half of that number -- but NOT from
  // anything in this route file: /dashboard/... matches no rule in
  // middleware/pageCacheControl.ts, so the day is its FALL-THROUGH DEFAULT.
  // That is what is worth pinning here, because a new rule added above that
  // default changes this page's TTL with nothing in this directory to say it
  // had. The 300-second browser max-age is pageCacheControl's own documented
  // divergence from Django (a browser cache cannot be purged).
  it("gets Django's day of shared cache, via pageCacheControl's default", async () => {
    expect((await get(PATH)).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // No Cache-Tag, so a newly published need cannot purge this page: it goes
  // stale for up to a day. middleware/cacheTag.ts's aggregate purge set covers
  // the home page, the sitemaps, the feeds and the API list endpoints, and no
  // dashboard is in it. That matches Django, which cached the same page for a
  // day with no invalidation at all -- ported behaviour rather than a
  // regression, pinned so a future purge-list change has something to fail
  // against.
  it("carries no cache tag, so a newly published need cannot purge it", async () => {
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
  // if this handler is ever reached without serverTiming in front of it, and
  // an HTML comment is not a place anyone looks.
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
  // (`url('index')`, `url('dash:index')`, `url('dash:item_groups')`), which is
  // how Django's own template built them. If that table moved, this page would
  // still render with a 200 and every link on it would point at a 404 -- and
  // the self-referencing third crumb is the one that would say so.
  it("builds its breadcrumbs from the reverse-URL table", async () => {
    const html = await body(PATH);

    expect(html).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
    expect(html).toContain(`<li class="is-active"><a href="${PATH}" aria-current="page">Requested items by item group</a></li>`);
  });
});

// ---------------------------------------------------------------------------
// when the query fails
// ---------------------------------------------------------------------------

describe("when the query fails", () => {
  // The handler has no try/catch, which is the right call and is worth pinning
  // as such. The defensive-looking alternative -- catching and rendering with
  // `groups: []` -- publishes a pie chart claiming no food bank has ever asked
  // for anything, when what actually happened is that D1 was unavailable. An
  // empty chart on a data page is a claim, and a false one is worse than an
  // error page.
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
});

// ===========================================================================
// MUTATION TESTING (TESTING.md's convention), run in a copy of the whole tree
// in the scratchpad OUTSIDE the repo -- never by editing a file in src/ and
// putting it back. Each mutant was applied alone, the templates re-precompiled
// where a .njk was touched (nunjucks is loaded precompiled here -- Workers bans
// new Function() -- so a template edit is INERT until scripts/precompile.ts is
// re-run, and without that step a "template mutant" proves nothing), and this
// file re-run. The count is how many of the 26 tests above went red.
//
// Widened past itemGroups.ts itself, because a careless edit to any of these
// reaches this page just as surely as one to the handler.
//
// In itemGroups.ts:
//   getNeedItemGroupCounts -> getNeedItemCategoryCounts (the
//     copy-of-its-neighbour failure this file is mostly about)   19 failed
//   context key `groups` -> `rows`                                8 failed
//   `{ value: row.count, name: row.group_name }` swapped          6 failed
//   `name: row.group_name` -> `name: row.category`                6 failed
//   `value: row.count` -> `value: 1`                              3 failed
//   chart_data_json dropped from the context                      7 failed
//   template -> "dash/item_categories.njk"                       11 failed
//   render_time_ms dropped from pageContext()                     1 failed
//   a second dbSession(c) per request                             4 failed
//   c.html() -> c.text()                                          2 failed
//   pageTranslatable: true + locale: "en" added                   1 failed
//
// In index.ts and lib/session.ts:
//   the app.get() registration deleted                           20 failed
//   registered with app.all() instead                             1 failed
//   withSession("first-unconstrained") -> "first-primary"         1 failed
//
// In the shared query (packages/db/src/dashboards.ts), to prove the excluded
// and deliberately-ordered fixture rows are doing work rather than sitting
// there:
//   `WHERE type = 'need'` dropped                                 7 failed
//   `type = 'need'` -> `type = 'excess'`                         13 failed
//   ORDER BY count DESC -> ASC                                    8 failed
//   ORDER BY dropped entirely                                     6 failed
//   GROUP BY group_name -> ... COLLATE NOCASE                     5 failed
//   `SELECT group_name` -> ``SELECT group_name AS `group` ``     12 failed
//     (the Django column name put back, which is the exact shape of a
//      well-meaning "match the original queryset" edit)
//
// In dash/item_groups.njk:
//   `{{ group.count|intcomma }}` -> `{{ group.count }}`           1 failed
//   `{{ chart_data_json|safe }}` -> `{{ chart_data_json }}`       6 failed
//   `<td>{{ group.group_name }}</td>` hardcoded                   8 failed
//   `data: {{ chart_data_json|safe }},` -> `data: [],`            6 failed
//   the chart-colors.js <script> deleted                          1 failed
//
// 26 mutants, 25 dead. ONE SURVIVOR, recorded rather than papered over: adding
// `locale: "en"` to buildPageContext() ALONE changes no byte of the page,
// because both the hreflang block and includes/langswitcher.njk are gated on
// `page_translatable`, which stays false. It is an equivalent mutant rather
// than a gap -- the version above that also flips pageTranslatable dies.
