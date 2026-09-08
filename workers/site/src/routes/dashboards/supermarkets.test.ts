import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/supermarkets.ts -- GET /dashboard/donationpoints/supermarkets/,
// the public "Supermarket Donation Points" pie chart. The one exported symbol is
// `gfdashSupermarkets`. Ported from gfdash/views.py:424-434
// (`@cache_page(SECONDS_IN_DAY) def supermarkets`), registered at gfdash/urls.py:23
// as `path("donationpoints/supermarkets/", supermarkets, name="supermarkets")`.
//
// WHY THIS FILE EXISTS. The handler has no branches, so it cannot throw and a
// status-code test proves nothing. Everything that can go wrong here renders a
// perfectly plausible chart with a 200:
//
//   * TWO INDEPENDENT NUMBERS ON ONE PAGE. Unlike every other pie-chart
//     dashboard in this directory, this one issues TWO statements: the per-company
//     counts that become the chart and the table, and a SEPARATE total that
//     becomes the <tfoot> "Total Supermarket Donation Points". Nothing makes them
//     agree except the two WHERE clauses being written the same way. Replace the
//     second query with `supermarkets.length` -- the obliging "why are we asking
//     the database twice" edit -- and the fixture below reports 4 instead of 11,
//     which is a plausible number in the right place. Drop the total's
//     `company IS NOT NULL` and it reports 15, counting every church hall in the
//     country as a supermarket. Both are asserted as exact values.
//   * `chart_data_json` IS BUILT IN THIS FILE, not in the template -- the port's
//     one real divergence from Django, whose template hand-builds the JS array
//     literal instead (see the escaping block near the foot of this file). So the
//     mapping `{ value: row.count, name: row.company }` exists nowhere but
//     supermarkets.ts:24: swap the two and echarts gets slices with numeric names
//     and undefined sizes, drawing nothing, while the table underneath stays
//     perfect. Asserted as the exact JSON text the page carries.
//   * THE COMPANY LOGO IS DERIVED DATA. dash/supermarkets.njk builds each row's
//     <img src> as `/static/img/co/{{ supermarket.company|slugify }}.png`, so the
//     company string is doing double duty as a filename. A query aliased to
//     something other than `company` renders a table of empty names AND a page of
//     `/static/img/co/.png` requests -- with correct counts beside them, and a 200
//     (packages/templates/src/env.ts sets throwOnUndefined: false on purpose).
//     The srcs are asserted, and they are checked against real company names.
//   * ORDER IS THE ENTIRE MEANING OF A PIE CHART, and `ORDER BY count DESC` lives
//     in packages/db. SQLite answers a GROUP BY through a temp b-tree keyed on the
//     group column, so rows arrive in company-NAME order whether or not the query
//     asks for one -- a fixture whose biggest company is also alphabetically first
//     cannot see the clause at all. The fixture below is built so count order,
//     name order and its reverse all disagree.
//
// REAL COMPANY NAMES, not invented ones. `company` is not free text: it is a
// CharField with `choices=DONATION_POINT_COMPANIES_CHOICES`
// (givefood/models/foodbank.py:1021), a closed list of 25 supermarket names in
// givefood/const/general.py:73-99. Using real ones keeps the slugify and escaping
// tests honest about what is and is not reachable -- "Marks & Spencer" and
// "Sainsbury's" below are members of that list, not contrived punctuation.
//
// REAL EVERYTHING ELSE, the harness the sibling dashboard suites use: the real
// production app (workers/site/src/index.ts's default export), so the route
// registration, appendSlash, cacheTag and pageCacheControl are the shipped
// articles rather than a hand-built router; the real Nunjucks templates through
// the real render(); the real getSupermarketDonationPointCounts and
// getSupermarketDonationPointTotal; and real in-memory SQLite built by schemaFor()
// from the real migrations, so foodbankdonationpoint's columns are the shipped
// ones (migration 0019 drops three of the ones 0001 created) rather than this
// author's memory of them. Mocked: the two KV namespaces, because there is no
// local double and nothing on this path touches them.
//
// MUTATION-TESTED in a copy of the whole tree in the scratchpad OUTSIDE the repo
// -- see the list at the foot of this file.

const ORIGIN = "https://www.givefood.org.uk";
// Hardcoded rather than imported from @givefood/urls, so the string here and the
// string in index.ts:560 are two independent copies: a rename that updated only
// one of them is what this is guarding. Note the `donationpoints/` segment --
// this dashboard is NOT at /dashboard/supermarkets/, which packages/urls'
// routes.test.ts:95 already flags as the easy thing to get wrong, and which the
// route tests below check really 404s.
const PATH = "/dashboard/donationpoints/supermarkets/";

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite. Records
// the SQL prepared and anything bound to it: this page's cost story is "two
// parameterless reads over one session per view", and a rendered chart looks
// identical whether it took two statements or six.
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
// breaking at once on hand-built fixtures when a shared query started reading an
// object they did not have. It also brings the real UNIQUE index on
// (foodbank_id, name), which is why the seed below numbers every row.
const SCHEMA = schemaFor("foodbankdonationpoint");

// The two statements the handler prepares, exactly (packages/db/src/dashboards.ts
// :301-313). Written out in full because the failure this file is mostly about --
// the two queries drifting apart -- is one word of difference between them, and
// both render a 200.
const COUNTS_SQL =
  "SELECT company, COUNT(*) AS count FROM foodbankdonationpoint WHERE company IS NOT NULL GROUP BY company ORDER BY count DESC";
const TOTAL_SQL = "SELECT COUNT(*) AS total FROM foodbankdonationpoint WHERE company IS NOT NULL";

let db: DatabaseSync;
let prepared: string[];
let bound: Bindable[][];
let sessionModes: string[];
let nextId: number;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      // Recorded rather than ignored: lib/session.ts asks for
      // "first-unconstrained", which is what makes these reads eligible for a D1
      // read replica, and one entry per request is how the tests below know BOTH
      // queries shared a single session -- which is the only reason the chart and
      // the <tfoot> total are guaranteed to describe the same snapshot.
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

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

// Every column foodbankdonationpoint declares NOT NULL is supplied, so a seeded
// row is one production would have accepted. `company` defaults to NULL because
// that is what the overwhelming majority of real donation points are -- church
// halls, libraries and community centres -- and a seed helper whose default is a
// supermarket would make the exclusion tests below accidents rather than
// assertions. `modified` is in DJANGO'S shape ("YYYY-MM-DD HH:MM:SS.ffffff", what
// str(datetime) produces and what the ETL writes) even though neither query reads
// it: a fixture that is wrong in an unread column is a trap for the next person to
// add a test here. Note that foodbankdonationpoint is NOT one of the tables
// migration 0022 rewrote, so this column's format is the ETL's convention rather
// than something a migration enforces.
function seedPoint(row: Record<string, Bindable> = {}): void {
  const n = (nextId += 1);
  const full: Record<string, Bindable> = {
    id: n,
    uuid: `dp${n}uuid`,
    foodbank_id: 1,
    name: `Donation Point ${n}`,
    slug: `donation-point-${n}`,
    address: "2 Low Street",
    postcode: "SP2 2BB",
    lat_lng: "51.0688,-1.7945",
    is_closed: 0,
    in_store_only: 0,
    company: null,
    modified: "2020-01-01 00:00:00.000000",
    ...row,
  };
  const columns = Object.keys(full);
  db.prepare(`INSERT INTO foodbankdonationpoint (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((c) => full[c] as Bindable),
  );
}

function seedPoints(count: number, row: Record<string, Bindable>): void {
  for (let i = 0; i < count; i += 1) seedPoint(row);
}

// THE FIXTURE IS THE TEST.
//
// THE COUNTS ARE 5/3/2/1 AND DELIBERATELY NOT ALPHABETICAL. By count they read
// Tesco, Co-op, Asda, Waitrose; alphabetically ascending they read Asda, Co-op,
// Tesco, Waitrose and descending the reverse of that; by count ascending they read
// Waitrose, Asda, Co-op, Tesco. All four orders differ, so a lost or inverted
// ORDER BY -- or SQLite's own group-by ordering showing through -- moves a slice
// on the page rather than hiding behind a fixture that happens to agree.
//
// NO TIES, on purpose. SQLite's sorter is not documented as stable and does not
// behave stably here (measured: three companies on one count came back in neither
// insertion nor name order), so a fixture with ties would pin an implementation
// detail of the engine rather than anything about this page.
//
// FOUR COMPANY-LESS POINTS AND NOTHING ELSE. Without them every assertion below
// passes against queries with no `company IS NOT NULL` filter at all -- "a filter
// that does nothing passes every test that only seeds matching rows". Four rather
// than one so a leak puts the unlabelled slice SECOND on the chart and pushes the
// total from 11 to 15, which is the difference between an obvious failure and a
// plausible one.
function seed(): void {
  seedPoints(5, { company: "Tesco" });
  seedPoints(3, { company: "Co-op" });
  seedPoints(2, { company: "Asda" });
  seedPoints(1, { company: "Waitrose" });
  seedPoints(4, { company: null });
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

interface BodyRow {
  logo: string;
  alt: string;
  company: string;
  count: string;
}

// The <tbody> rows in document order, split into the four things each one
// carries. Parsed rather than matched as a slab of markup, so the claims stay on
// the DATA while still pinning the order and the exact strings -- and split into
// `logo`/`alt`/`company` because those are three separate renderings of one value
// (slugified into a filename, autoescaped into an attribute, autoescaped into
// text) and only one of them changes for some defects.
//
// <tbody> specifically, not the whole <table>: the <tfoot> total row is also two
// <td>s and would otherwise be read as a company called "Total Supermarket
// Donation Points".
//
// The company text is trimmed of the single space the template itself puts
// between the logo and the name (`...png"> {{ supermarket.company }}`); that space
// is fixed template punctuation, not anything the handler produced.
function bodyRows(html: string): BodyRow[] {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(html);
  if (!tbody) throw new Error("no <tbody> in the rendered page");
  const row = /<tr>\s*<td><img src="([^"]*)" alt="([^"]*)"[^>]*>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/g;
  return [...(tbody[1] as string).matchAll(row)].map((m) => ({
    logo: m[1] as string,
    alt: m[2] as string,
    company: (m[3] as string).trim(),
    count: m[4] as string,
  }));
}

// The <tfoot> total cell, as the exact text on the page. Its own reader rather
// than part of bodyRows() because it comes from the OTHER query, and a test that
// mixed the two could not say which half broke.
function footTotal(html: string): string {
  const foot = /<tfoot>[\s\S]*?<td>Total Supermarket Donation Points<\/td>\s*<td>([^<]*)<\/td>/.exec(html);
  if (!foot) throw new Error("no <tfoot> total row in the rendered page");
  return (foot[1] as string).trim();
}

// The chart's `data:` array EXACTLY as it appears in the page -- the raw text,
// not a parsed object. dash/supermarkets.njk emits `data: {{ chart_data_json|safe }},`
// on a line of its own, and `|safe` means whatever this handler serialised is what
// the browser parses as JavaScript. Reading it raw is the only way the escaping
// tests below can see the difference between a quote the page escaped and one it
// did not -- JSON.parse would normalise exactly the thing under test.
//
// The one character trimmed is the template's OWN trailing comma, which separates
// `data:` from the `emphasis:` key after it. It is fixed template punctuation, and
// a serialised array can never itself end in a comma (JSON.stringify closes with
// `]`), so removing it cannot hide a defect and keeps every expectation below
// readable as the JSON it is.
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
  // gfdash/urls.py:23's path, reached through the REAL router. A suite that
  // mounted its own ad-hoc Hono route would pass with index.ts:560 deleted --
  // routes/admin/dupePostcodes.test.ts records the sibling case where a link
  // shipped in a template 404ed because no route was registered.
  //
  // The title and <h1> are asserted because the 22 /dashboard/ routes in
  // index.ts share this handler's shape and the template name is a string
  // literal: pointed at a sibling .njk the page still renders, with
  // `supermarkets` simply unread.
  it("answers GET /dashboard/donationpoints/supermarkets/ with the supermarket page", async () => {
    seed();

    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Supermarket Donation Points - Give Food</title>");
    expect(html).toContain("<h1>Supermarket Donation Points</h1>");
    expect(html).toContain('<div id="chart" style="height:600px"></div>');
    // The echarts series label, which is this template's alone -- the surest
    // cheap proof that dash/supermarkets.njk rendered and not a sibling whose
    // chart is also 600px tall.
    expect(html).toContain("name: 'Number of Donation Points'");
  });

  // THE URL HAS A `donationpoints/` SEGMENT. Django nests it (gfdash/urls.py:23)
  // while every neighbouring dashboard sits directly under /dashboard/, so
  // "/dashboard/supermarkets/" is the URL a person -- or a template author -- will
  // reach for. It must 404 rather than quietly resolving, or the real URL could be
  // moved with nothing to notice.
  it("does not answer at /dashboard/supermarkets/, the URL this page is not at", async () => {
    seed();

    expect((await get("/dashboard/supermarkets/")).status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // BOTH SCRIPTS, OR NO CHART. `gfChartColors` from chart-colors.js is referenced
  // by the inline config as `color: gfChartColors`; drop that tag and echarts
  // throws a ReferenceError in the browser, leaving an empty div on a page that is
  // perfect as far as the server is concerned. Nothing server-side can notice,
  // which is why it is asserted here.
  it("loads echarts and the shared colour palette the inline config references", async () => {
    seed();
    const html = await body(PATH);

    expect(html).toMatch(/<script src="\/static\/js\/echarts\.js\?v=[^"]*"><\/script>/);
    expect(html).toMatch(/<script src="\/static\/js\/chart-colors\.js\?v=[^"]*"><\/script>/);
    expect(html).toContain("color: gfChartColors");
  });

  // GET ONLY. index.ts:560 registers app.get() and nothing else.
  //
  // A DIVERGENCE FROM DJANGO, and a harmless one: Django's view is a plain
  // function with no method guard, so a POST there rendered the same page with a
  // 200. What matters is that the port's refusal is reached WITHOUT running either
  // query -- so a POST flood cannot buy repeated full scans of
  // foodbankdonationpoint. This repo has already shipped a GET route able to run
  // an UPDATE, which is why the method registration is asserted rather than
  // assumed.
  it("refuses a POST, and runs no query on the way to refusing it", async () => {
    seed();

    const res = await get(PATH, { method: "POST" });

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
    expect(sessionModes).toEqual([]);
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block, entirely outside
  // i18n_patterns, and index.ts:542-567 registers the dashboards with no locale
  // loop. The visible half is the absence of hreflang alternates (pageContext()
  // calls buildPageContext with no `locale`, which is what leaves `languages`
  // empty); the routing half is that no /cy/ form of this URL exists at all. A
  // route registered inside the LOCALES loop by mistake would 200 on the Welsh URL.
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

  // Django's APPEND_SLASH, via lib/appendSlash.ts, which answers it by re-entering
  // the app with a HEAD request for the slashed URL and redirecting if that does
  // not 404. So the unslashed URL runs this handler in full -- BOTH statements,
  // the whole document rendered and thrown away -- to produce a 301 with no body.
  // Pinned rather than filed: it is how the probe is documented to work, and it is
  // the kind of cost that shows up in no metric except D1 rows read.
  it("301s a missing trailing slash, having really executed the handler to find out", async () => {
    seed();

    const res = await get("/dashboard/donationpoints/supermarkets");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
    expect(prepared).toEqual([COUNTS_SQL, TOTAL_SQL]);
  });
});

// ---------------------------------------------------------------------------
// what the page shows
// ---------------------------------------------------------------------------

describe("what the page shows", () => {
  beforeEach(seed);

  // THE TABLE, in full. Four companies, biggest first, with the four company-less
  // donation points absent -- the counts are 5/3/2/1 precisely so that a
  // differently-ordered or differently-filtered answer is a different LIST rather
  // than the same list with one number out.
  //
  // The logo src is asserted alongside the name because it is the same string put
  // through packages/templates' slugify(), and a table of correct names with
  // `/static/img/co/.png` in every row is a defect the counts cannot show. The
  // four slugs here were checked against the real files in
  // workers/site/dist/static/static/img/co/ -- aldi.png, co-op.png, tesco.png and
  // the rest are really named this way, so the filter's output is being compared
  // with reality rather than with itself.
  it("prints one table row per company, most donation points first, with a logo and a count", async () => {
    expect(bodyRows(await body(PATH))).toEqual([
      { logo: "/static/img/co/tesco.png", alt: "Tesco", company: "Tesco", count: "5" },
      { logo: "/static/img/co/co-op.png", alt: "Co-op", company: "Co-op", count: "3" },
      { logo: "/static/img/co/asda.png", alt: "Asda", company: "Asda", count: "2" },
      { logo: "/static/img/co/waitrose.png", alt: "Waitrose", company: "Waitrose", count: "1" },
    ]);
  });

  // THE CHART IS THE ARTIFACT; the table under it is the footnote. Asserted as the
  // exact JSON text on the page rather than as a parsed structure, because three
  // separate things are being pinned at once and only the raw line shows all
  // three: the ORDER (same as the table), the MAPPING
  // (`{ value: count, name: company }` -- swap them and echarts draws nothing
  // while the table stays perfect), and the KEY NAMES echarts requires.
  it("serialises the same companies, in the same order, as the echarts pie slices", async () => {
    expect(chartDataLine(await body(PATH))).toBe(
      '[{"value":5,"name":"Tesco"},{"value":3,"name":"Co-op"},{"value":2,"name":"Asda"},{"value":1,"name":"Waitrose"}]',
    );
  });

  // THE SECOND QUERY, and the whole reason this page differs from its neighbours.
  // 11, not 4 (the number of companies, which is what `supermarkets.length` would
  // give) and not 15 (every donation point, which is what dropping the total's own
  // `company IS NOT NULL` would give). All three are integers in the right place
  // on a page that still looks right, so the exact value is the only assertion
  // worth making.
  it("prints the total number of supermarket donation points, not the number of supermarkets", async () => {
    const html = await body(PATH);

    expect(footTotal(html)).toBe("11");
    expect(bodyRows(html)).toHaveLength(4);
  });

  // The two halves of the page agree only because both statements carry the same
  // WHERE and run inside one D1 session (lib/session.ts's "first-unconstrained",
  // asserted below) -- so they see one snapshot rather than two. Stated as its own
  // test because "the footer does not match the chart" is the complaint a reader
  // would actually make, and because it is what fails if either WHERE clause is
  // edited without the other.
  it("footer total equals the sum of the chart slices", async () => {
    const html = await body(PATH);
    const sliceSum = (JSON.parse(chartDataLine(html)) as { value: number }[]).reduce((a, s) => a + s.value, 0);

    expect(String(sliceSum)).toBe(footTotal(html));
  });

  // Named separately from the tests above so a failure says WHICH rule broke. The
  // four company-less points are the church halls and community centres that make
  // up most of this table in production; they outnumber several real supermarkets.
  // All three places they could leak into are checked, because the filter is
  // applied twice in SQL and a leak would reach the chart and the table together
  // -- but the total is a different statement and could leak on its own.
  it("never counts a donation point with no company, in the table, the chart or the total", async () => {
    const html = await body(PATH);

    // A NULL company slugifies to nothing, so the giveaway in the table is a row
    // whose logo has no filename at all.
    expect(html).not.toContain("/static/img/co/.png");
    expect(bodyRows(html).map((r) => r.company)).toEqual(["Tesco", "Co-op", "Asda", "Waitrose"]);
    expect(chartDataLine(html)).not.toContain("null");
    expect(footTotal(html)).toBe("11");
  });

  // NO THOUSANDS SEPARATORS ANYWHERE ON THIS PAGE, which is parity and not an
  // oversight: gfdash/templates/dash/supermarkets.html:42,49 prints
  // `{{ supermarket.count }}` and `{{ supermarket_total }}` raw, with no
  // `|intcomma`, and dash/supermarkets.njk copies it exactly. The neighbouring
  // dash/item_groups.njk DOES intcomma its counts, so "make these dashboards
  // consistent" is a live edit -- and in the chart it would be a real defect,
  // because a comma inside a JavaScript number literal parses as a second array
  // element. 1,234 rows seeded rather than a smaller number because intcomma only
  // does anything above 999.
  it("prints raw integers in the table, the footer and the chart, matching Django", async () => {
    db.prepare("DELETE FROM foodbankdonationpoint").run();
    seedPoints(1234, { company: "Tesco" });

    const html = await body(PATH);

    expect(bodyRows(html)).toEqual([{ logo: "/static/img/co/tesco.png", alt: "Tesco", company: "Tesco", count: "1234" }]);
    expect(footTotal(html)).toBe("1234");
    expect(chartDataLine(html)).toBe('[{"value":1234,"name":"Tesco"}]');
  });

  // A SINGLE COMPANY, which is the case Django's template got wrong-shaped: there
  // the array is hand-built with `{% if not forloop.last %},{% endif %}` between
  // elements, so the one-element case is the branch that never fires.
  // JSON.stringify has no such branch, and that is the point of the port's
  // divergence -- pinned so the page cannot quietly go back to building the
  // literal in the template.
  it("emits a one-element chart array with no stray separator", async () => {
    db.prepare("DELETE FROM foodbankdonationpoint").run();
    seedPoint({ company: "Lidl" });

    const html = await body(PATH);

    expect(chartDataLine(html)).toBe('[{"value":1,"name":"Lidl"}]');
    expect(bodyRows(html)).toHaveLength(1);
    expect(footTotal(html)).toBe("1");
  });

  // AN EMPTY DATABASE IS A 200 WITH AN EMPTY CHART AND A ZERO, not a 404 and not a
  // broken script. This is what a fresh environment and any restore window look
  // like. `[]` is valid JavaScript and echarts renders an empty frame quite
  // happily; what it must not get is a syntax error, which is what a half-emitted
  // loop would have produced -- and note this is the case where the Django
  // original emits `data: [\n\n]`, whitespace and all.
  //
  // The "0" is the assertion that matters most here: getSupermarketDonationPointTotal
  // ends `?? 0`, and without it the tfoot cell would render EMPTY rather than
  // wrong, because throwOnUndefined is off. An empty cell under "Total Supermarket
  // Donation Points" reads as a rendering glitch; "0" reads as an answer.
  it("renders an empty chart and a zero total rather than failing on an empty database", async () => {
    db.prepare("DELETE FROM foodbankdonationpoint").run();

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(bodyRows(html)).toEqual([]);
    expect(chartDataLine(html)).toBe("[]");
    expect(footTotal(html)).toBe("0");
    // The empty case degrades the chart, not the document: the header row of the
    // table survives, which is what distinguishes "no data" from "the table did
    // not render".
    expect(html).toContain("<th>Supermarket</th>");
    expect(html).toContain("<th>Number of Donation Points</th>");
    expect(html).toContain("<h1>Supermarket Donation Points</h1>");
  });

  // CLOSED DONATION POINTS ARE COUNTED. Django applied no is_closed filter here
  // (gfdash/views.py:427 filters on `company__isnull` and nothing else), so this is
  // parity rather than an oversight -- the chart is "how many supermarket donation
  // points have we ever recorded", not "how many are open today". Worth pinning
  // because foodbankdonationpoint HAS an is_closed column with a partial index
  // built on it (migration 0001_core.sql:107), so "surely this should exclude
  // closed ones" is a plausible and quiet change to both the chart and the total.
  it("counts closed donation points, as Django did", async () => {
    db.prepare("DELETE FROM foodbankdonationpoint").run();
    seedPoints(2, { company: "Iceland", is_closed: 1 });
    seedPoint({ company: "Nisa" });

    const html = await body(PATH);

    expect(bodyRows(html).map((r) => `${r.company}|${r.count}`)).toEqual(["Iceland|2", "Nisa|1"]);
    expect(footTotal(html)).toBe("3");
  });

  // GROUPING IS CASE-SENSITIVE, because SQLite's default collation is BINARY and
  // Postgres's text equality was too -- so the port and the original agree that
  // "Spar" and "SPAR" are two companies. Not a hypothetical: `company` is a choices
  // field, and a single mis-cased entry added to DONATION_POINT_COMPANIES
  // (givefood/const/general.py:73) would split a slice in two on this chart rather
  // than raising anywhere. Asserted so that "helpfully" adding COLLATE NOCASE to
  // the GROUP BY -- which would merge the slices, change the logo filename and
  // leave the total alone -- has to be a decision rather than a tidy-up.
  it("treats two spellings of a company name as two companies", async () => {
    db.prepare("DELETE FROM foodbankdonationpoint").run();
    seedPoints(2, { company: "Spar" });
    seedPoint({ company: "SPAR" });

    const html = await body(PATH);

    expect(bodyRows(html).map((r) => `${r.company}|${r.count}`)).toEqual(["Spar|2", "SPAR|1"]);
    // Both slugify to the same file, so the two rows share one logo -- which is
    // exactly why the split is invisible to a reader skimming the pictures.
    expect(bodyRows(html).map((r) => r.logo)).toEqual(["/static/img/co/spar.png", "/static/img/co/spar.png"]);
    expect(footTotal(html)).toBe("3");
  });
});

// ---------------------------------------------------------------------------
// the company logo filename
// ---------------------------------------------------------------------------
//
// `/static/img/co/{{ supermarket.company|slugify }}.png` -- the company string
// used as a filename. This is the only page in the port that renders a company
// logo this way, and it is derived at RENDER time rather than read from the
// `company_slug` column the model already maintains
// (givefood/models/foodbank.py:1274-1275 sets it on save). Django's template does
// exactly the same thing, so the duplication is parity, not a port defect -- but
// it does mean the filter has to agree with Django's for every name in the closed
// list, or a logo silently 404s and the row shows a broken image.
//
// CHECKED AGAINST DJANGO, NOT REASONED ABOUT. `django.utils.text.slugify` was run
// under the Django installed at /Users/jasoncartwright/Sites/foodcharity (5.2.6,
// printed by django.get_version()) over all 25 names in
// givefood/const/general.py:73-99 plus the empty string, and packages/templates'
// slugify() was run over the same list. Every one of the 26 outputs matched. The
// four cases below are the ones where they COULD have differed.

describe("the company logo filename", () => {
  // AN AMPERSAND, A POSSESSIVE, AN INTERNAL HYPHEN AND A SPACE -- the four real
  // names in the choices list that slugify does anything to. Each maps onto a file
  // that really exists in workers/site/dist/static/static/img/co/, which is the
  // half of this assertion that a test comparing slugify() with itself could not
  // make: marks-spencer.png (not "marks-and-spencer" or "marks--spencer"),
  // sainsburys.png (not "sainsbury-s"), co-op.png (the hyphen survives) and
  // one-stop.png (the space becomes one).
  //
  // The counts are 4/3/2/1 rather than equal so the row order is determined; see
  // the note about ties on the main fixture.
  it("turns each real company name into the logo file that actually exists", async () => {
    seedPoints(4, { company: "Marks & Spencer" });
    seedPoints(3, { company: "Sainsbury's" });
    seedPoints(2, { company: "Co-op" });
    seedPoints(1, { company: "One Stop" });

    expect(bodyRows(await body(PATH)).map((r) => r.logo)).toEqual([
      "/static/img/co/marks-spencer.png",
      "/static/img/co/sainsburys.png",
      "/static/img/co/co-op.png",
      "/static/img/co/one-stop.png",
    ]);
  });

  // AN EMPTY-STRING COMPANY IS NOT NULL, so both statements count it -- parity
  // with Django, whose `company__isnull=False` drew the line in exactly the same
  // place, and already pinned at the query level in packages/db/src/dashboards.test.ts.
  // What that suite cannot see is what it does to the PAGE: a nameless slice on
  // the pie, an empty first cell in the table, and a request for
  // "/static/img/co/.png" that is a guaranteed 404. Pinned because the
  // alternatives -- an error, or the row being dropped -- would both be worse
  // discoveries in production than a nameless slice, and because it documents that
  // nothing downstream of the query filters the rows at all.
  it("renders an empty-string company as a nameless slice and a logo with no filename", async () => {
    seedPoints(2, { company: "" });
    seedPoint({ company: "Aldi" });

    const html = await body(PATH);

    expect(bodyRows(html)).toEqual([
      { logo: "/static/img/co/.png", alt: "", company: "", count: "2" },
      { logo: "/static/img/co/aldi.png", alt: "Aldi", company: "Aldi", count: "1" },
    ]);
    expect(chartDataLine(html)).toBe('[{"value":2,"name":""},{"value":1,"name":"Aldi"}]');
    expect(footTotal(html)).toBe("3");
  });
});

// ---------------------------------------------------------------------------
// escaping -- the port's one real divergence from the Django template
// ---------------------------------------------------------------------------
//
// Django's dash/supermarkets.html:76 builds the array in the template:
//   {value: {{ supermarket.count }}, name: "{{ supermarket.company|safe }}"}
// `|safe` only skips HTML escaping; it does nothing about JS-string escaping, so a
// company name containing a double quote ends the string and breaks the whole
// config. supermarkets.ts:21-24 serialises with JSON.stringify instead, which the
// module's comment says "avoids the unescaped-JS-string-literal issue". It escapes
// the quote. It does not escape `</script>` -- see the second test.

describe("escaping the company name into the inline script", () => {
  // ONE VALUE, THREE RENDERINGS, ALL DIFFERENT AND ALL CORRECT. "Marks & Spencer"
  // is a real member of the choices list, so this is not a contrived input: the
  // ampersand goes through nunjucks' autoescape in the alt attribute and the table
  // cell (`&amp;`), through slugify in the filename (dropped entirely), and
  // through JSON.stringify in the script (a literal `&`). Escaping the JSON for
  // HTML as well -- the obvious-looking "we escape everything else, why not this"
  // change -- would put `&amp;` inside a JavaScript string literal, which displays
  // as garbage in the tooltip, and `&quot;` there would be a syntax error.
  it("escapes an ampersand for HTML in the table and leaves it alone in the chart", async () => {
    seedPoint({ company: "Marks & Spencer" });

    const html = await body(PATH);

    expect(bodyRows(html)).toEqual([
      { logo: "/static/img/co/marks-spencer.png", alt: "Marks &amp; Spencer", company: "Marks &amp; Spencer", count: "1" },
    ]);
    expect(chartDataLine(html)).toBe('[{"value":1,"name":"Marks & Spencer"}]');
  });

  // THE APOSTROPHE, which nunjucks escapes to `&#39;` in both the attribute and the
  // text but JSON.stringify leaves alone -- correct in all three places, because
  // the JSON string is delimited by double quotes. Django's `|safe` would have left
  // it raw in the attribute too; that is harmless there (the attribute is
  // double-quoted) but it is the reason the two systems' HTML differs byte for byte
  // on this row, and "Sainsbury's" is the second-largest supermarket in the list.
  it("escapes an apostrophe for HTML and not for JSON", async () => {
    seedPoint({ company: "Sainsbury's" });

    const html = await body(PATH);

    expect(bodyRows(html)).toEqual([
      { logo: "/static/img/co/sainsburys.png", alt: "Sainsbury&#39;s", company: "Sainsbury&#39;s", count: "1" },
    ]);
    expect(chartDataLine(html)).toBe('[{"value":1,"name":"Sainsbury\'s"}]');
  });

  // THE HALF THE PORT REALLY DOES FIX. A double quote in a company name ends the
  // string in Django's hand-built literal and takes the rest of the echarts config
  // with it; JSON.stringify emits `\"` and the chart survives. Not reachable from
  // the choices list, and pinned anyway because this is the specific claim
  // supermarkets.ts:21-23 makes about itself.
  it("escapes a double quote for JavaScript, which Django's template did not", async () => {
    seedPoint({ company: 'Tesco "Express"' });

    expect(chartDataLine(await body(PATH))).toBe('[{"value":1,"name":"Tesco \\"Express\\""}]');
  });

  // SUSPECT, PINNED AS-IS. JSON.stringify does not escape `/`, and `|safe` means
  // nothing escapes the `<` either -- so a company name containing the literal text
  // `</script>` is emitted verbatim inside the inline <script>, and an HTML parser
  // ends the script element THERE. The rest of the echarts config lands in the
  // document as text and anything after it is live markup: that is the classic
  // script-block breakout, and it is exactly the failure supermarkets.ts:21-23
  // claims JSON.stringify prevents. The comment overclaims; the code is still
  // strictly safer than Django's, which breaks on the quote as well.
  //
  // NOT reachable from today's data, which is why it is pinned rather than treated
  // as a live vulnerability: `company` is a CharField with
  // `choices=DONATION_POINT_COMPANIES_CHOICES` (givefood/models/foodbank.py:1021),
  // a hardcoded list of 25 plain-ASCII supermarket names, and the admin renders it
  // as a select. It becomes reachable the day the field is opened up, so the
  // assertion is here to fail loudly then, and it is reported rather than fixed
  // because these tests pin what the code does.
  it("does NOT escape a literal </script> in a company name -- the script block ends early", async () => {
    seedPoint({ company: "Tesco</script><b>x" });

    const html = await body(PATH);

    // Escaped correctly in the table, where nunjucks' autoescape is in charge.
    expect(bodyRows(html)[0]?.company).toBe("Tesco&lt;/script&gt;&lt;b&gt;x");
    // And NOT escaped in the script, where it is the terminator.
    expect(chartDataLine(html)).toBe('[{"value":1,"name":"Tesco</script><b>x"}]');
  });
});

// ---------------------------------------------------------------------------
// what the request costs
// ---------------------------------------------------------------------------

describe("what the request costs", () => {
  beforeEach(seed);

  // TWO statements, both READS, over ONE session, with nothing bound.
  //
  // The order is the order Promise.all kicks them off in, which is the order they
  // appear in supermarkets.ts:17-20 -- each async function runs synchronously as
  // far as its own `session.prepare(...)` before yielding. Pinned as an exact
  // array because that also says each statement ran EXACTLY once: both queries
  // scan the whole of foodbankdonationpoint and D1 meters rows read, so a
  // duplicate -- the shape a careless "let me also show a percentage" edit takes
  // -- doubles the cost of the page with nothing visible to show for it.
  it("issues exactly two statements, both reads, over exactly one D1 session", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM foodbankdonationpoint").get() as { n: number }).n;

    await get(PATH);

    expect(prepared).toEqual([COUNTS_SQL, TOTAL_SQL]);
    for (const sql of prepared) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
    // No bound parameters at all: both statements are fixed strings, so there is
    // nothing on this page any part of the request could reach.
    expect(bound).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM foodbankdonationpoint").get() as { n: number }).n).toBe(before);
    // ONE entry, not two: dbSession(c) is called once and the same session is
    // handed to both queries, which is what makes the chart and the footer total
    // describe the same snapshot. A second dbSession() call would be invisible on
    // the page and would put the two numbers on two connections.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // Two views in a row are byte-identical in the parts that carry data, and each
  // is still two statements. This is the assertion a "let me cache the answer in a
  // table" change trips over, and it is also what says the page is safe to reload
  // -- which is what someone watching these numbers actually does.
  it("is idempotent across repeated views", async () => {
    const first = await body(PATH);
    prepared = [];
    const second = await body(PATH);

    expect(bodyRows(second)).toEqual(bodyRows(first));
    expect(chartDataLine(second)).toEqual(chartDataLine(first));
    expect(footTotal(second)).toEqual(footTotal(first));
    expect(prepared).toEqual([COUNTS_SQL, TOTAL_SQL]);
  });

  // NOTHING IN THE URL REACHES EITHER QUERY. The handler takes no parameters, so a
  // query string is inert -- asserted because "let me make this page filterable" is
  // the obliging edit that would put a request value into a statement, and the
  // sibling getDeliveryMonthCounts already interpolates its metric (from an
  // allowlist) rather than binding it.
  it("ignores a query string entirely", async () => {
    const html = await body(`${PATH}?company=Tesco&limit=100000`);

    expect(bodyRows(html).map((r) => r.company)).toEqual(["Tesco", "Co-op", "Asda", "Waitrose"]);
    expect(footTotal(html)).toBe("11");
    expect(prepared).toEqual([COUNTS_SQL, TOTAL_SQL]);
    expect(bound).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// caching
// ---------------------------------------------------------------------------

describe("caching", () => {
  beforeEach(seed);

  // Django's view carries @cache_page(SECONDS_IN_DAY) (gfdash/views.py:424), and
  // the port reproduces the shared half of that number -- but NOT from anything in
  // this route file: /dashboard/... matches no rule in
  // middleware/pageCacheControl.ts, so the day is its FALL-THROUGH DEFAULT. That is
  // what is worth pinning here, because a new rule added above that default changes
  // this page's TTL with nothing in this directory to say it had. The 300-second
  // browser max-age is pageCacheControl's own documented divergence from Django (a
  // browser cache cannot be purged).
  it("gets Django's day of shared cache, via pageCacheControl's default", async () => {
    expect((await get(PATH)).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // No Cache-Tag, so a newly added donation point cannot purge this page: it goes
  // stale for up to a day. middleware/cacheTag.ts's aggregate purge set covers the
  // home page, the sitemaps, the feeds and the API list endpoints, and no dashboard
  // is in it. That matches Django, which cached the same page for a day with no
  // invalidation at all -- ported behaviour rather than a regression, pinned so a
  // future purge-list change has something to fail against.
  it("carries no cache tag, so a newly added donation point cannot purge it", async () => {
    expect((await get(PATH)).headers.get("Cache-Tag")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the shared page context
// ---------------------------------------------------------------------------

describe("the shared page context", () => {
  beforeEach(seed);

  // buildPageContext({ path: c.req.path }) -- canonical is the request's own path,
  // matching givefood/context_processors.py:19 (SITE_DOMAIN + the path).
  it("declares itself canonical at its own URL", async () => {
    expect(await body(PATH)).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
  });

  // The debug comment's "Took Nms" is elapsedMs(c), read off the timestamp
  // middleware/serverTiming.ts stored -- whole milliseconds, deliberately not
  // Django's three decimals (performance.now() only advances at I/O boundaries on
  // Workers, so the fraction was always exactly ".000"). The failure this catches
  // is the string "NaN": elapsedMs subtracts an unset context variable if this
  // handler is ever reached without serverTiming in front of it, and an HTML
  // comment is not a place anyone looks.
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body(PATH)).toMatch(/⏱️ Took \d+ms\n/);
  });

  // A DIVERGENCE, PINNED. givefood/context_processors.py:46-48 appended
  // QUERY_STRING to flag_path, so Django's "Something wrong in this page?" link
  // carried the query the reader was actually looking at. pageContext() here passes
  // only `path`, so the query is dropped -- harmless (this page reads no
  // parameters) and recorded so it stays a known difference. Every gfdash handler
  // in this directory is written the same way.
  it("drops the query string from the flag link, unlike Django", async () => {
    const html = await body(`${PATH}?utm_source=newsletter`);

    expect(html).toContain(`href="/flag/#${ORIGIN}${PATH}"`);
    expect(html).not.toContain("utm_source");
  });

  // The breadcrumb and logo hrefs come from @givefood/urls' reverse table
  // (`url('index')`, `url('dash:index')`, `url('dash:supermarkets')`), which is how
  // Django's own template built them. If that table moved, this page would still
  // render with a 200 and every link on it would point at a 404 -- and the
  // self-referencing third crumb, the one that has to spell out the nested
  // donationpoints/ path, is the one that would say so.
  it("builds its breadcrumbs from the reverse-URL table", async () => {
    const html = await body(PATH);

    expect(html).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
    expect(html).toContain(`<li class="is-active"><a href="${PATH}" aria-current="page">Supermarket Donation Points</a></li>`);
  });
});

// ---------------------------------------------------------------------------
// when a query fails
// ---------------------------------------------------------------------------

describe("when a query fails", () => {
  // The handler has no try/catch, which is the right call and is worth pinning as
  // such. The defensive-looking alternative -- catching and rendering with
  // `supermarkets: []` -- publishes a pie chart claiming no supermarket in the
  // country hosts a donation point, when what actually happened is that D1 was
  // unavailable. An empty chart on a data page is a claim, and a false one is worse
  // than an error page.
  it("serves the real 500 page instead of an empty chart", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      DB: {
        withSession: () => ({
          prepare: () => ({
            all: async () => {
              throw new Error("D1_ERROR: network connection lost");
            },
            first: async () => {
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
    // Not a partial page: the chart's own div must not be on it, or a reader gets
    // a 500 that still draws an empty graph.
    expect(html).not.toContain('<div id="chart"');
  });

  // HALF A PAGE IS NOT AN OPTION EITHER, and this is the failure only a two-query
  // page can have. The counts succeed and only the total fails -- one statement
  // timing out while the other returns is an ordinary D1 event -- and because they
  // are joined by Promise.all the whole handler rejects rather than rendering a
  // complete chart above an empty "Total Supermarket Donation Points" cell. That
  // empty cell is what `await` on each query in turn inside a try/catch, or a `?? 0`
  // moved up into this route, would produce: a page that looks finished and
  // understates the number.
  it("500s when only the total fails, rather than rendering a chart with a blank total", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    seed();
    const halfBroken = {
      ...env(),
      DB: {
        withSession: () => {
          const real = d1Session(db, prepared, bound);
          return {
            prepare: (sql: string) => {
              const stmt = real.prepare(sql);
              if (sql !== TOTAL_SQL) return stmt;
              return { ...stmt, first: async () => { throw new Error("D1_ERROR: statement timed out"); } };
            },
          };
        },
      },
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`${ORIGIN}${PATH}`), halfBroken, execCtx);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("<h1>500 - Internal Server Error</h1>");
    expect(html).not.toContain("Total Supermarket Donation Points");
    // The counts query really did run and really did succeed -- otherwise this
    // test would be passing for the same reason the one above it does.
    expect(prepared).toEqual([COUNTS_SQL, TOTAL_SQL]);
  });
});

// ===========================================================================
// MUTATION TESTING, run in a private copy of this repo under the scratchpad --
// never against a source file in the working tree, and in a copy of its OWN
// rather than a shared one (a first attempt used a scratch tree another agent
// was mutating at the same time and produced two flatly wrong readings, one of
// which claimed a killed mutant had survived). Each mutant was applied alone,
// the templates re-precompiled where a .njk was touched (a template edit is
// inert until scripts/precompile.ts runs, so without that step a "template
// mutant" proves nothing), and this file re-run. The count is how many of the 34
// tests above went red.
//
// In supermarkets.ts itself:
//   template -> "dash/item_groups.njk"                          18 failed
//   context key `supermarkets` -> `rows`                         13 failed
//   chart_data_json dropped from the context                    10 failed
//   supermarket_total dropped from the context                  10 failed
//   `{ value: row.count, name: row.company }` swapped            9 failed
//   supermarket_total -> supermarkets.length                     8 failed
//   c.html() -> c.text()                                         2 failed
//   render_time_ms dropped from pageContext()                    1 failed
//   a second dbSession(c) for the total                          1 failed
//   pageTranslatable: true + locale: "en" added                  1 failed
//   Promise.all unrolled into two awaits, the total .catch(0)'d  1 failed
//
// In index.ts:
//   registered at /dashboard/supermarkets/ instead              28 failed
//   the app.get() registration deleted                          27 failed
//   registered with app.all()                                    1 failed
//
// In the shared queries (packages/db/src/dashboards.ts), to prove the excluded
// fixture rows are doing work rather than sitting there:
//   counts: SELECT company_slug AS company                      25 failed
//   counts: `WHERE company IS NOT NULL` dropped                 15 failed
//   counts: COUNT(*) -> COUNT(DISTINCT foodbank_id)             14 failed
//   counts: ORDER BY count DESC -> ASC                          12 failed
//   total:  COUNT(*) -> COUNT(DISTINCT company)                 12 failed
//   counts: ORDER BY dropped entirely                           10 failed
//   total:  `WHERE company IS NOT NULL` dropped                  8 failed
//   counts: GROUP BY company COLLATE NOCASE                      6 failed
//   counts: `AND is_closed = 0` added                            6 failed
//
// In dash/supermarkets.njk:
//   `{{ chart_data_json|safe }}` -> `{{ chart_data_json }}`      9 failed
//   the <tfoot> cell reads `{{ supermarkets|length }}`           8 failed
//   `{{ supermarket.company|slugify }}` loses |slugify           7 failed
//   `alt="{{ supermarket.company }}"` -> `alt=""`                5 failed
//   `{{ supermarket.count }}` gains |intcomma                    1 failed
//   `{{ supermarket_total }}` gains |intcomma                    1 failed
//   the chart-colors.js <script> deleted                         1 failed
//
// ONE SURVIVOR, recorded rather than papered over:
//   getSupermarketDonationPointTotal's `?? 0` -> `?? -1`         0 failed
// It is unreachable, not untested. `SELECT COUNT(*) AS total` always returns
// exactly one row holding a number, so `.first()` never resolves to null and the
// fallback never runs -- packages/db/src/dashboards.test.ts had already measured
// the same thing and says so in its own comment. Reaching it from here would mean
// replacing the statement's result with a fake, which would be a test of the shim
// rather than of the page.
