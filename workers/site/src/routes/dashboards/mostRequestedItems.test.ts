import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import { serverTiming } from "../../middleware/serverTiming";
import type { AppEnv } from "../../types";
import { gfdashMostRequestedItems, gfdashTtMostRequestedItems } from "./mostRequestedItems";

// routes/dashboards/mostRequestedItems.ts -- the two public "Most Requested
// Items" pages, GET /dashboard/most-requested-items/ and
// GET /dashboard/trusselltrust/most-requested-items/. Ported from gfdash
// views.py:82-143 (`@cache_page(SECONDS_IN_DAY) def most_requested_items`),
// which both of Django's URLs (gfdash/urls.py, `most_requested_items` and
// `tt_most_requested_items`) point at -- one view, told apart by
// `trusselltrust = ("trusselltrust" in request.path)`.
//
// WHY THIS FILE EXISTS. packages/db/src/dashboards.test.ts already runs
// getLatestNeedTextsSince row by row through a real engine, so the SQL is
// covered. Everything ABOVE the SQL is not, and unlike most of this directory
// -- twenty handlers that are four lines and a render() -- there is real logic
// here to get wrong (mostExcessItems.ts is the one sibling that shares any of
// it, and only the day gate):
//
//   * A DAY GATE THAT DECIDES WHETHER TO ANSWER AT ALL. `days` comes off the
//     query string and is checked against a six-value allowlist; anything
//     else is a bare 403. The gate is also the only thing between an
//     anonymous caller and the size of the scan -- ?days=365 is a year of
//     food banks, and a gate that let arbitrary numbers through would let
//     anyone ask for all of them.
//   * A THRESHOLD BUILT BY STRING SURGERY. sinceIso() does
//     `toISOString().slice(0,19).replace("T"," ")`, because foodbank.last_need
//     is TEXT and is compared LEXICOGRAPHICALLY. Drop the .replace and the
//     'T' (0x54) sorts above every Django-shaped ' ' (0x20) value in the same
//     day, and the window silently stops meaning what it says -- this repo
//     already needed migration 0022 to undo exactly that, so the bound value
//     is asserted character for character below.
//   * A FILTER, A COUNTER AND A SORT the page's headline numbers come from.
//     Three keyword sentinels are excluded from the item list but still
//     counted as food banks; ties in the frequency sort are broken by which
//     food bank updated most recently. All of that renders as a perfectly
//     plausible table whichever way it goes wrong, which is why the
//     assertions here are on the rendered cells and the bound parameters
//     rather than on the status code.
//
// REAL EVERYTHING. The real app from ../../index (real router, real
// middleware chain, real appendSlash probe, real 500 page), the real Nunjucks
// render() through the real dash/most_requested_items.njk, the real
// getLatestNeedTextsSince, and real SQLite seeded from the real migrations via
// schemaFor(). Nothing is mocked; nothing on this path leaves the machine.
// Harness copied from the neighbouring routes/dashboards/beanPastaIndex.test.ts
// rather than reinvented.
//
// MUTATION-TESTED (TESTING.md's convention) in a copy of the whole tree in the
// scratchpad OUTSIDE the repo, never by editing a file in src/ and putting it
// back. 41 mutants applied and re-run; all 41 died. Widened past this module,
// because a careless edit to any of these reaches these two pages just as
// surely as one to the handler. The full list, because a count is only worth
// as much as the edits behind it:
//
//   the gate -- ALLOWED_DAYS.includes() negated, and neutered; the check moved
//     to AFTER the query so a rejected request still scans the table;
//     403 -> 404; the empty body given content; DEFAULT_DAYS 30 -> 7;
//     Number() -> parseInt(_, 10) (which accepts "30abc"); c.req.query ->
//     the LAST repeated value, i.e. Django's own semantics.
//   the threshold -- .replace("T", " ") dropped; .slice(0,19) widened to
//     .slice(0,23); MS_PER_DAY an hour short; `new Date()` hoisted to module
//     scope so every request in an isolate reuses the first one's clock.
//   the counting -- INVALID_TEXT emptied, and reduced to no_items()'s
//     two-item list; the membership test inverted, made a substring scan, and
//     made case-insensitive; numberFoodbanks moved inside the `if` so excluded
//     food banks stop being counted; split("\n") -> split(/\s+/), and ->
//     split with the empty pieces filtered out; the sort comparator reversed,
//     and given a localeCompare tie-break; itemsFreq.size -> items.length.
//   the render context -- items_sorted renamed; `days` replaced by
//     DEFAULT_DAYS; `trusselltrust` hardcoded false; buildPageContext given
//     c.req.url instead of c.req.path.
//   the flag -- false/true swapped between the two exported handlers;
//     `trusselltrust` re-derived from c.req.path (Django's own spelling)
//     instead of taken from the argument.
//   index.ts -- either registration deleted; the plain one registered as .all
//     so a POST is answered.
//   lib/session.ts -- the mode changed to "first-primary".
//   packages/db -- the network clause respelled `!= 'Independent'`; `>` ->
//     `>=`; ORDER BY reversed; the INNER JOIN made a LEFT JOIN.
//   the template -- the `selected` conditional dropped; the count cell
//     hardcoded; the Trussell prefix dropped from the title block. (A .njk
//     edit is inert until the precompile step is re-run, so the harness
//     re-runs it -- without that a template "mutant" proves nothing.)

const ORIGIN = "https://www.givefood.org.uk";

// Hardcoded rather than read from @givefood/urls, so the string here and the
// string in ROUTES/index.ts stay two independent copies -- a rename that
// updated only one of them is exactly what this guards. gfdash/urls.py spells
// both with hyphens; Django's reverse names have the underscores.
const PATH = "/dashboard/most-requested-items/";
const TT_PATH = "/dashboard/trusselltrust/most-requested-items/";

type Bindable = null | number | bigint | string | Uint8Array;

// Records the SQL prepared and the values bound to it. The whole point of
// sinceIso() is the shape of one bound string, and a rendered table looks
// identical whether the window was thirty days, thirty hours or wrong by a
// year -- the log is the only place that value is observable.
function d1Session(db: DatabaseSync, prepared: string[], bound: Bindable[][]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => {
      bound.push(next as Bindable[]);
      return statement(sql, next as Bindable[]);
    },
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    // Present, not omitted: a test that proves this GET writes nothing must
    // not be leaning on writes being impossible in the fixture.
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

// Both tables, because the query INNER JOINs them -- and taken from the real
// migrations via schemaFor() rather than hand-written DDL: 0019 does
// `ALTER TABLE foodbankchange DROP COLUMN foodbank_name` long after 0001
// created it, so a fixture typed out by hand tests the author's memory of the
// schema rather than the shipped one (github #51 -- eight suites broke at once
// on hand-built fixtures).
const SCHEMA = schemaFor("foodbank", "foodbankchange");

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
// Every last_need below is in DJANGO'S shape -- "YYYY-MM-DD HH:MM:SS.ffffff",
// what str(datetime) produces and what migration 0022 normalised the whole
// database to. Wrapping the normal shape makes the deliberately abnormal
// literals (the ISO-shaped one in "the window", the boundary pair) stand out
// as the anomalies they are.
const PY = (value: string) => value;

// One food bank plus, unless `need` is null, the foodbankchange row it points
// at. Written as a pair because this page's join is foodbank -> its OWN
// latest_need: a food bank with no need row, and a need row nothing points at,
// are both things the page has to cope with.
function seedFoodbank(o: { name: string; need: string | null; lastNeed: string | null; network?: string | null }): void {
  nextId += 1;
  const needId = o.need === null ? null : nextId;
  if (o.need !== null) {
    db.prepare(
      `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, input_method, created, modified)
       VALUES (?, ?, ?, ?, 1, 'scrape', '2026-01-01 00:00:00.000000', '2026-01-01 00:00:00.000000')`,
      // 32 dashless hex characters, the real width (PLAN.md §4.4) -- the
      // column carries a UNIQUE index, so a lazy constant would collide on the
      // second row and the fixture would be quietly one row smaller.
    ).run(nextId, `${String(nextId).padStart(2, "0")}dead4beefcafe`.padEnd(32, "f"), nextId, o.need);
  }
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, charity_just_foodbank,
       contact_email, url, shopping_list_url, address_is_administrative, is_closed, no_locations,
       days_between_needs, network, latest_need_id, last_need, created, modified)
     VALUES (?, ?, ?, ?, 'An address', 'SP1 1AA', 'England', '51.0,-1.0', 0,
       'a@b.invalid', 'https://example.invalid/', 'https://example.invalid/list/', 0, 0, 0, 14, ?, ?, ?,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(nextId, String(nextId).padStart(32, "a"), o.name, o.name.toLowerCase(), o.network ?? "Independent", needId, o.lastNeed);
}

// THE FIXTURE MOST OF THIS FILE READS, and half of it is rows that must NOT
// reach the page. Without those, every assertion here would pass against a
// handler that ignored the threshold, ignored the sentinel list and counted
// every food bank in the table -- the "a filter that does nothing passes every
// test that only seeds matching rows" trap.
//
// The counts are deliberately asymmetric and the ties deliberately
// anti-alphabetical: "Tinned tomatoes" and "Pasta" both end on 2, and "UHT
// milk" and "Nappies" both on 1, in each case with the alphabetically LATER
// item first. A comparator that fell back to the item text -- or a sort that
// was not stable -- reorders the table without changing a single number.
function seedTheDashboard(): void {
  // Inside the 30-day window, most recently updated first (which is the order
  // the query returns, and therefore the first-seen order of the items).
  seedFoodbank({ name: "Salisbury", need: "Tinned tomatoes\nPasta\nUHT milk", lastNeed: PY("2026-09-04 09:00:00.000000"), network: "Trussell" });
  seedFoodbank({ name: "Bristol", need: "Pasta\nNappies", lastNeed: PY("2026-09-03 09:00:00.000000") });
  // views.py's `invalid_text` -- excluded from the ITEMS but still counted as a
  // food bank, which is the asymmetry the headline sentence depends on.
  seedFoodbank({ name: "Cardiff", need: "Nothing", lastNeed: PY("2026-09-02 09:00:00.000000"), network: "Trussell" });
  seedFoodbank({ name: "Dundee", need: "Tinned tomatoes", lastNeed: PY("2026-09-01 09:00:00.000000"), network: "IFAN" });

  // THE THREE EXCLUSIONS, each for a different reason and each carrying an
  // item that appears nowhere else -- so a leak shows up as an extra ROW in
  // the table rather than as a count one too high, which is far harder to miss.
  // Older than 30 days (but inside 90, so the window is demonstrably a window
  // and not a permanent exclusion).
  seedFoodbank({ name: "Exeter", need: "Cat food", lastNeed: PY("2026-07-01 09:00:00.000000") });
  // NULL last_need: `NULL > '2026-08-06...'` is NULL, not false, and only
  // because this is a WHERE clause does the row disappear.
  seedFoodbank({ name: "Filey", need: "Ghost items", lastNeed: null });
  // The most recently updated food bank on the site, with NO need row: the
  // INNER JOIN drops it, so it is absent from `number_foodbanks` even though
  // it would head the ORDER BY. A LEFT JOIN here would put a food bank on the
  // page with no items and inflate the headline count by one.
  seedFoodbank({ name: "Gateshead", need: null, lastNeed: PY("2026-09-05 11:00:00.000000") });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepared = [];
  bound = [];
  sessionModes = [];
  nextId = 0;
  // Every threshold in this file is computed from this instant. Fake rather
  // than relative-to-now arithmetic, because the assertions are on the exact
  // bound string -- "2026-08-06 12:00:00" is a claim about sinceIso(), and a
  // test that recomputed it with the same expression could not fail.
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-05T12:00:00.000Z"));
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// The item table, as "item|count" pairs. Parsed rather than matched as a slab
// of markup so the claim stays on the DATA, while still pinning the order and
// the exact rendered strings. [\s\S] rather than [^<] in the cell, because one
// test deliberately seeds an item containing markup.
function tableRows(html: string): string[] {
  const table = /<table[\s\S]*?<\/table>/.exec(html);
  if (!table) throw new Error("no <table> in the rendered page");
  return [...table[0].matchAll(/<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g)].map((m) => `${m[1]}|${m[2]}`);
}

// The headline sentence, which carries `number_items`, `number_foodbanks` and
// `days` -- three separate template variables that no table cell shows, and
// the only place a reader sees how much of the country the page is describing.
function headline(html: string): string {
  const line = /Found [\s\S]*?days\./.exec(html);
  if (!line) throw new Error("no 'Found N items from M food bank organisations' line on the page");
  return line[0];
}

// The day-picker's options, each marked if it carries `selected`. The picker
// is the only navigation between the six windows, so a broken `selected` (or a
// missing option) strands the reader on whichever window they are already on.
function dayOptions(html: string): string[] {
  return [...html.matchAll(/<option value="\?days=(\d+)"( selected)?>/g)].map((m) => `${m[1]}${m[2] ?? ""}`);
}

// The two statements the page can issue, spelled out here rather than built
// from the same concatenation packages/db/src/dashboards.ts uses -- so this is
// a second, independent copy of the string, which is what makes asserting it
// worth anything.
const SQL =
  "SELECT fc.change_text AS change_text FROM foodbank f JOIN foodbankchange fc ON fc.id = f.latest_need_id WHERE f.last_need > ? ORDER BY f.last_need DESC";
const TT_SQL =
  "SELECT fc.change_text AS change_text FROM foodbank f JOIN foodbankchange fc ON fc.id = f.latest_need_id WHERE f.last_need > ? AND f.network = 'Trussell' ORDER BY f.last_need DESC";

// ---------------------------------------------------------------------------
// the two routes
// ---------------------------------------------------------------------------

describe("the two routes", () => {
  beforeEach(seedTheDashboard);

  // gfdash/urls.py's two paths, reached through the REAL router. A test that
  // mounted its own ad-hoc Hono route would pass with index.ts:548 deleted --
  // routes/admin/dupePostcodes.test.ts records the sibling case where a
  // shipped link 404ed because no route was registered, and dash/index.njk
  // links to both of these.
  it("answers GET /dashboard/most-requested-items/ with the plain page", async () => {
    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Most Requested Items - Give Food</title>");
    expect(html).toContain("<h1>Most Requested Items</h1>");
  });

  // The second URL is the same view in Django, told apart by its path. Here it
  // is a second exported handler, so "both URLs are registered and each gets
  // its own variant" is a claim about index.ts as much as about this module.
  it("answers GET /dashboard/trusselltrust/most-requested-items/ with the Trussell variant", async () => {
    const res = await get(TT_PATH);

    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("<title>Trussell Trust Most Requested Items - Give Food</title>");
    expect(html).toContain("<h1>Trussell Trust Most Requested Items</h1>");
    // The self-referencing breadcrumb, which is the port FIXING Django: the
    // original template hardcodes `{% url 'dash:tt_most_requested_items' %}`
    // in that <li> for BOTH pages (gfdash/templates/dash/
    // most_requested_items.html:19), so the plain page's own crumb links to
    // the Trussell page. The .njk added the `{% if trusselltrust %}`.
    expect(html).toContain(`<li class="is-active"><a href="${TT_PATH}" aria-current="page">Trussell Trust Most Requested Items</a></li>`);
  });

  it("gives the plain page a breadcrumb that points at itself, unlike Django's template", async () => {
    expect(await body(PATH)).toContain(`<li class="is-active"><a href="${PATH}" aria-current="page">Most Requested Items</a></li>`);
  });

  // GET ONLY. index.ts registers `app.get(...)` for both, so Hono answers a
  // POST with a 404.
  //
  // A DIVERGENCE FROM DJANGO, and a harmless one: Django's view is a plain
  // function with no method guard, so a POST there rendered the same page with
  // a 200. What is asserted is that the port's refusal is reached WITHOUT
  // running the query -- a POST flood cannot buy a scan of the foodbank table.
  it("refuses a POST on both URLs, and runs no query on the way to refusing", async () => {
    expect((await get(PATH, { method: "POST" })).status).toBe(404);
    expect((await get(TT_PATH, { method: "POST" })).status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block, entirely
  // outside i18n_patterns, and index.ts:545-567 registers the dashboards with
  // no locale loop. The visible half is the absence of hreflang alternates;
  // the routing half is that no /cy/ form of either URL exists at all.
  it("is English-only: no hreflang alternates, and no language-prefixed URL", async () => {
    const html = await body(PATH);

    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).not.toContain("hreflang");
    expect((await get(PATH)).headers.get("Content-Language")).toBe("en");
    expect((await get(`/cy${PATH}`)).status).toBe(404);
    expect((await get(`/cy${TT_PATH}`)).status).toBe(404);
  });

  // THE TRAILING SLASH COSTS A FULL RENDER AND A D1 READ. lib/appendSlash.ts
  // answers Django's APPEND_SLASH by re-entering the app with a HEAD request
  // for the slashed URL and redirecting if it does not 404 -- so the unslashed
  // URL really runs this handler, really scans the foodbank table, renders the
  // whole document and throws the body away, all to produce a 301 with no
  // content. Pinned rather than fixed: it is how the probe is documented to
  // work, and it is the kind of cost invisible in every metric except D1 rows
  // read.
  it("301s a missing trailing slash, having really executed the handler to find out", async () => {
    const res = await get("/dashboard/most-requested-items");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
    expect(prepared).toEqual([SQL]);

    prepared = [];
    const tt = await get("/dashboard/trusselltrust/most-requested-items");
    expect(tt.status).toBe(301);
    expect(tt.headers.get("Location")).toBe(`${ORIGIN}${TT_PATH}`);
  });

  // A HEAD is answered with the full handler run and an empty body -- which is
  // what the appendSlash probe above is built on, so it is behaviour the site
  // depends on rather than a curiosity.
  it("runs the whole handler for a HEAD and returns no body", async () => {
    const res = await get(PATH, { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(prepared).toEqual([SQL]);
  });
});

// ---------------------------------------------------------------------------
// the ?days gate
// ---------------------------------------------------------------------------

describe("the ?days gate", () => {
  beforeEach(seedTheDashboard);

  // views.py:86-90's `allowed_days` and `default_days`, and the whole of the
  // page's input surface. The bound value is asserted rather than the rendered
  // page because the threshold is the only thing `days` actually does to the
  // query -- a gate that accepted the value and then always used 30 days would
  // render an identical-looking page.
  it("accepts each of the six allowed windows and turns it into the right threshold", async () => {
    const thresholds: Record<string, string> = {
      "7": "2026-08-29 12:00:00",
      "30": "2026-08-06 12:00:00",
      "60": "2026-07-07 12:00:00",
      "90": "2026-06-07 12:00:00",
      "120": "2026-05-08 12:00:00",
      "365": "2025-09-05 12:00:00",
    };

    for (const [days, threshold] of Object.entries(thresholds)) {
      bound = [];
      const res = await get(`${PATH}?days=${days}`);
      expect(res.status, `?days=${days}`).toBe(200);
      expect(bound, `?days=${days}`).toEqual([[threshold]]);
    }
  });

  // views.py:88's `request.GET.get("days", default_days)` -- no parameter means
  // thirty days, and thirty days is what the page then says it is showing.
  it("defaults to 30 days when no parameter is given", async () => {
    const html = await body(PATH);

    expect(bound).toEqual([["2026-08-06 12:00:00"]]);
    expect(headline(html)).toContain("in the last 30 days.");
  });

  // views.py:89-90's `if days not in allowed_days: return HttpResponseForbidden()`.
  // An EMPTY BODY and text/plain, because the handler returns a bare
  // `new Response("", { status: 403 })` rather than going through the site's
  // 403 page -- matching Django's bare HttpResponseForbidden, which also
  // renders nothing.
  //
  // The values chosen are the ones an actual visitor produces: 31 is what
  // hand-editing the URL gets you, 0 and -1 are what a fuzzer sends, and
  // 100000 is the one that matters -- an unbounded window would scan every
  // food bank the site has ever recorded, for anyone who asks. "abc" and
  // "1e309" are the two Number() results that are not ordinary numbers at all:
  // NaN and Infinity. Both have to miss the allowlist, and `includes` uses
  // SameValueZero, so a NaN in ALLOWED_DAYS would MATCH one -- which is the
  // sort of thing that only stays untrue while someone keeps checking.
  it("403s an unallowed window with an empty body, without touching the database", async () => {
    for (const days of ["31", "0", "-1", "100000", "abc", "1e309"]) {
      prepared = [];
      const res = await get(`${PATH}?days=${days}`);
      expect(res.status, `?days=${days}`).toBe(403);
      expect(await res.text(), `?days=${days}`).toBe("");
      expect(res.headers.get("Content-Type"), `?days=${days}`).toBe("text/plain;charset=UTF-8");
      // THE ASSERTION THAT MATTERS. The gate is before dbSession(c), so a
      // refused request costs nothing. Move the check below the query -- an
      // easy tidy-up when someone "simplifies" the handler -- and the 403 is
      // still a 403 while every refused request scans the table.
      expect(prepared, `?days=${days}`).toEqual([]);
    }
  });

  // A 403 IS NOT CACHEABLE, so an attacker cannot pin one at the edge, and a
  // legitimate visitor who mistypes once is not served the refusal for a day.
  // middleware/pageCacheControl.ts only stamps 200s; this pins the consequence
  // for this page rather than trusting that it stays true.
  it("does not let a 403 into any cache", async () => {
    expect((await get(`${PATH}?days=31`)).headers.get("Cache-Control")).toBeNull();
  });

  // Both URLs share the gate, because both call the same private function.
  it("applies the same gate on the Trussell URL", async () => {
    const res = await get(`${TT_PATH}?days=31`);

    expect(res.status).toBe(403);
    expect(prepared).toEqual([]);
  });

  // THE PORT IS MORE PERMISSIVE THAN DJANGO, AND WHERE IT DIVERGES, DJANGO
  // 500ed. `Number(...)` accepts spellings `int(...)` rejects -- run under
  // CPython 3.13.0 on this machine, not assumed: int("30.0"), int("0x1E") and
  // int("3e1") all raise ValueError, which inside views.py:88 is an unhandled
  // exception. Here each is simply the 30-day page.
  //
  // Harmless -- the value still has to land on an allowlisted NUMBER before
  // anything happens -- and pinned because it is a real behavioural difference
  // someone comparing logs would otherwise trip over, and because it is
  // evidence the gate is a value check rather than a string check.
  it("accepts hex, exponent and decimal spellings of an allowed window that Django would have 500ed on", async () => {
    for (const spelling of ["30.0", "0x1E", "3e1"]) {
      bound = [];
      const res = await get(`${PATH}?days=${spelling}`);
      expect(res.status, `?days=${spelling}`).toBe(200);
      expect(bound, `?days=${spelling}`).toEqual([["2026-08-06 12:00:00"]]);
    }
  });

  // THE OTHER HALF, WHICH IS PARITY RATHER THAN DIVERGENCE, and is here so the
  // test above is not read as "the port accepts anything numeric-ish". A
  // leading plus and surrounding whitespace are accepted by BOTH: int("+30")
  // and int(" 30 ") are 30 (same CPython 3.13.0 run). A future "let me tighten
  // this up" regex would break the port away from Django in the one direction
  // this pair says it currently matches.
  it("accepts a signed or space-padded window, exactly as Django's int() did", async () => {
    for (const spelling of ["+30", "%2030%20"]) {
      bound = [];
      expect((await get(`${PATH}?days=${spelling}`)).status, `?days=${spelling}`).toBe(200);
      expect(bound, `?days=${spelling}`).toEqual([["2026-08-06 12:00:00"]]);
    }
  });

  // `?days=` and `?days` are the empty string, and Number("") is 0 -- not NaN,
  // which is the intuition this pins against. Django's int("") raises, so
  // Django 500ed here; the port 403s. Both refuse; only the port refuses
  // cheaply.
  it("403s an empty days parameter rather than falling back to the default", async () => {
    expect((await get(`${PATH}?days=`)).status).toBe(403);
    expect((await get(`${PATH}?days`)).status).toBe(403);
    expect(prepared).toEqual([]);
  });

  // A DIVERGENCE WORTH KNOWING ABOUT. Hono's c.req.query("days") returns the
  // FIRST occurrence; Django's request.GET.get("days") returns the LAST
  // (QueryDict.__getitem__ documents "the last value"). So the same URL shows
  // a 7-day window here and would have shown a 30-day one on the old site.
  // Nobody constructs that URL by hand, but a duplicated parameter is exactly
  // what a badly-built link or a redirect that appends rather than replaces
  // produces -- and the page would be quietly describing a different span of
  // time from the one the reader asked for.
  it("takes the first of a repeated days parameter, where Django took the last", async () => {
    await get(`${PATH}?days=7&days=30`);
    expect(bound).toEqual([["2026-08-29 12:00:00"]]);

    bound = [];
    await get(`${PATH}?days=30&days=7`);
    expect(bound).toEqual([["2026-08-06 12:00:00"]]);
  });

  // Everything else in the query string is inert -- there is exactly one
  // parameter, and the lookup is case-sensitive.
  it("ignores every other query parameter, including a differently-cased one", async () => {
    await get(`${PATH}?Days=7&trusselltrust=1&network=Trussell&limit=100000`);

    expect(bound).toEqual([["2026-08-06 12:00:00"]]);
    expect(prepared).toEqual([SQL]);
  });

  // The picker is `allowed_days` rendered as six <option>s with the current one
  // marked. Django's template does the same, and it is the only way to change
  // window without editing the URL -- lose the `selected` and a reader cannot
  // tell which window they are looking at; lose an option and they cannot get
  // back to it.
  it("renders the six windows as a picker with the current one selected", async () => {
    expect(dayOptions(await body(PATH))).toEqual(["7", "30 selected", "60", "90", "120", "365"]);
    expect(dayOptions(await body(`${PATH}?days=365`))).toEqual(["7", "30", "60", "90", "120", "365 selected"]);
  });
});

// ---------------------------------------------------------------------------
// the window
// ---------------------------------------------------------------------------

describe("the window", () => {
  // THE SHAPE OF THE BOUND STRING IS THE WHOLE SAFETY ARGUMENT. foodbank.last_need
  // is TEXT and the comparison is lexicographic, so the threshold has to look
  // like the stored values do. 'T' is 0x54 and ' ' is 0x20: leave the 'T' in
  // and every Django-shaped value in the same day sorts BELOW the threshold
  // regardless of the real instant, which is the defect migration 0022 exists
  // to undo. Asserted as an exact regex rather than an equality, so it fails
  // for the right reason.
  it("binds a Django-shaped, second-precision threshold with no 'T' and no fraction", async () => {
    seedTheDashboard();

    await get(PATH);

    expect(bound).toEqual([["2026-08-06 12:00:00"]]);
    expect(bound[0]![0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(bound[0]![0]).not.toContain("T");
  });

  // .slice(0, 19) throws the milliseconds away, so the threshold is always
  // rounded DOWN to the whole second and the window is up to 999ms WIDER than
  // Django's, which compared full-microsecond datetimes. Immaterial in
  // practice; pinned because it is the visible consequence of the slice, and a
  // slice(0, 23) "fix" would put a ".750" on the end of a value being compared
  // against ".000000" strings.
  it("truncates the clock's milliseconds rather than rounding them", async () => {
    seedTheDashboard();
    vi.setSystemTime(Date.parse("2026-09-05T12:00:00.750Z"));

    await get(`${PATH}?days=7`);

    expect(bound).toEqual([["2026-08-29 12:00:00"]]);
  });

  // The threshold is read from `new Date()` INSIDE the handler. Hoisting it to
  // module scope is the classic Workers mistake -- an isolate lives for hours,
  // so the window would freeze at whenever the isolate booted and the page
  // would slowly start describing a period that ended some time yesterday.
  it("recomputes the window on every request, not once per isolate", async () => {
    seedTheDashboard();

    await get(`${PATH}?days=7`);
    vi.setSystemTime(Date.parse("2026-09-06T12:00:00.000Z"));
    await get(`${PATH}?days=7`);

    expect(bound).toEqual([["2026-08-29 12:00:00"], ["2026-08-30 12:00:00"]]);
  });

  // THE EDGE OF THE WINDOW, AS THE PORT ACTUALLY DRAWS IT. The comparison is
  // `>` against a threshold with no fractional part, so a food bank whose
  // last_need falls in the SAME SECOND as the threshold is KEPT -- ".000000"
  // is the threshold plus characters, and therefore sorts above it. One
  // microsecond earlier and it is gone. Both sides are asserted, because an
  // exclusion test with nothing on the other side of the line passes for a
  // query that excludes everything.
  it("keeps a food bank that updated in the threshold's own second, and drops the microsecond before", async () => {
    seedFoodbank({ name: "Onthesecond", need: "Exactly on the line", lastNeed: PY("2026-08-29 12:00:00.000000") });
    seedFoodbank({ name: "Justbefore", need: "A microsecond too early", lastNeed: PY("2026-08-29 11:59:59.999999") });

    const html = await body(`${PATH}?days=7`);

    expect(tableRows(html)).toEqual(["Exactly on the line|1"]);
    expect(headline(html)).toBe("Found 1 items from 1 food bank organisations in the last 7 days.");
  });

  // MIGRATION 0022'S HAZARD, FROM THE PAGE'S SIDE. A last_need still stored in
  // JavaScript's ISO shape beats every same-day Django-shaped threshold on the
  // 'T', so such a food bank appears in a window it does not belong in -- here,
  // one that last updated eight hours BEFORE the 7-day threshold is on the
  // page anyway. 0022 rewrote the three rows that were in this shape and
  // pyNow() stops new ones being written; this is what fails if either
  // protection is undone, and the symptom on the live site is a food bank
  // silently appearing in (or vanishing from) a window with nothing logged.
  // SUSPECT BUT NOT THIS MODULE'S BUG -- the storage shape is the defect, and
  // the fix is upstream of here.
  it("is fooled by a last_need still stored in JavaScript's ISO shape", async () => {
    seedFoodbank({ name: "Isostamped", need: "Should not be in a 7-day window", lastNeed: "2026-08-29T04:00:00.000Z" });

    expect(tableRows(await body(`${PATH}?days=7`))).toEqual(["Should not be in a 7-day window|1"]);
  });

  // The window really is a window: Exeter is 66 days old, so it is absent at 30
  // days and present at 90. Without this, every "excluded" assertion in the
  // fixture is equally satisfied by a query that returns nothing at all.
  it("widens to admit an older food bank when a longer window is asked for", async () => {
    seedTheDashboard();

    expect(tableRows(await body(PATH))).not.toContain("Cat food|1");

    const wider = await body(`${PATH}?days=90`);
    expect(tableRows(wider)).toContain("Cat food|1");
    expect(headline(wider)).toBe("Found 5 items from 5 food bank organisations in the last 90 days.");
  });
});

// ---------------------------------------------------------------------------
// what the page counts
// ---------------------------------------------------------------------------

describe("what the page counts", () => {
  beforeEach(seedTheDashboard);

  // THE PAGE'S WHOLE PAYLOAD, in one assertion. Most-requested first; ties
  // broken by whichever food bank updated most recently (Salisbury's items
  // come before Bristol's), NOT alphabetically -- "Pasta" would head both
  // pairs under a text comparator, and "Tinned tomatoes"/"UHT milk" head them
  // under the real one.
  //
  // Django's `sorted(items_freq, reverse=True, key=lambda x: x[1])` behaves
  // identically: reverse=True does not reverse ties, it sorts descending and
  // leaves equal elements in their original order (run under CPython 3.13.0 on
  // this machine, not assumed). JS's Array.prototype.sort has been stable
  // since ES2019, and Map iterates in insertion order, so the port reproduces
  // Counter + sorted exactly.
  it("lists items most-requested first, breaking ties by the most recently updated food bank", async () => {
    expect(tableRows(await body(PATH))).toEqual(["Tinned tomatoes|2", "Pasta|2", "UHT milk|1", "Nappies|1"]);
  });

  // THE HEADLINE SENTENCE, and the one place the two counters are visible.
  // `number_items` is the number of DISTINCT items (itemsFreq.size, four here,
  // not the six item lines that went in); `number_foodbanks` is the number of
  // rows the query returned, INCLUDING Cardiff, whose "Nothing" contributed no
  // items at all. views.py:116-125 increments its counter outside the
  // `if not need_text in invalid_text` block, and the port copies that
  // faithfully -- which is why the two numbers here are 4 and 4 rather than 6
  // and 3.
  //
  // ("1 items" and "food bank organisations" are Django's own unpluralised
  // strings; the template is a straight port.)
  it("counts distinct items, and every food bank the query returned including the excluded ones", async () => {
    expect(headline(await body(PATH))).toBe("Found 4 items from 4 food bank organisations in the last 30 days.");
  });

  // views.py:107's `invalid_text = ["Nothing", "Unknown", "Facebook"]`, matched
  // as WHOLE STRINGS (`if not need_text in invalid_text`, a list membership
  // test, not a substring scan). All three, because the module's own comment
  // warns that this is deliberately NOT the two-item list no_items() uses --
  // dropping "Facebook" here would put "Facebook" on the dashboard as one of
  // the country's most requested items.
  it("excludes all three keyword sentinels from the items, while still counting their food banks", async () => {
    db.exec("DELETE FROM foodbank; DELETE FROM foodbankchange;");
    nextId = 0;
    seedFoodbank({ name: "Nothingfb", need: "Nothing", lastNeed: PY("2026-09-04 09:00:00.000000") });
    seedFoodbank({ name: "Unknownfb", need: "Unknown", lastNeed: PY("2026-09-03 09:00:00.000000") });
    seedFoodbank({ name: "Facebookfb", need: "Facebook", lastNeed: PY("2026-09-02 09:00:00.000000") });

    const html = await body(PATH);

    expect(tableRows(html)).toEqual([]);
    expect(headline(html)).toBe("Found 0 items from 3 food bank organisations in the last 30 days.");
  });

  // The membership test is EXACT and case-sensitive, which is what Django's
  // list `in` does too. A need that merely mentions one of the words is a real
  // need and is counted; a lowercase "nothing" is not the sentinel. Both are
  // asserted because "excludes the sentinels" is equally satisfied by a
  // substring scan, which would silently drop every food bank whose list
  // happens to say "Nothing tinned please".
  it("does not exclude a need that merely contains a sentinel, or one that differs in case", async () => {
    db.exec("DELETE FROM foodbank; DELETE FROM foodbankchange;");
    nextId = 0;
    seedFoodbank({ name: "Substring", need: "Nothing tinned please", lastNeed: PY("2026-09-04 09:00:00.000000") });
    seedFoodbank({ name: "Lowercase", need: "nothing", lastNeed: PY("2026-09-03 09:00:00.000000") });
    seedFoodbank({ name: "Multiline", need: "Rice\nNothing", lastNeed: PY("2026-09-02 09:00:00.000000") });

    const html = await body(PATH);

    // The third case is the sentinel as one LINE of a multi-line need: the
    // test is on the whole change_text, so "Nothing" survives as an item.
    expect(tableRows(html)).toEqual(["Nothing tinned please|1", "nothing|1", "Rice|1", "Nothing|1"]);
    expect(headline(html)).toBe("Found 4 items from 3 food bank organisations in the last 30 days.");
  });

  // An empty database is a 200 with an empty table and two zeroes, not a 404
  // and not a broken page. This is what a fresh environment, a database
  // restore window and a 7-day window over a quiet Christmas all look like.
  it("renders an empty table rather than 404ing when no food bank qualifies", async () => {
    db.exec("DELETE FROM foodbank; DELETE FROM foodbankchange;");

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(tableRows(html)).toEqual([]);
    expect(headline(html)).toBe("Found 0 items from 0 food bank organisations in the last 30 days.");
    // The rest of the page is untouched -- the empty case degrades the table,
    // not the document.
    expect(html).toContain("<h1>Most Requested Items</h1>");
    expect(dayOptions(html)).toHaveLength(6);
  });

  // ITEM TEXT IS FOOD BANK COPY, SCRAPED OFF THIRD-PARTY WEBSITES, and it goes
  // straight into the page. packages/templates/src/env.ts leaves autoescape on;
  // this is the assertion that says so for this template, because
  // `{{ item.item }}` in a `{% autoescape false %}` block, or a `| safe`
  // filter added by someone fixing a stray "&amp;amp;", turns a scraped
  // shopping list into stored XSS on a public page.
  it("escapes item text rather than trusting scraped copy", async () => {
    db.exec("DELETE FROM foodbank; DELETE FROM foodbankchange;");
    nextId = 0;
    seedFoodbank({ name: "Xss", need: `Tea <script>alert(1)</script> & "biscuits"`, lastNeed: PY("2026-09-04 09:00:00.000000") });

    const html = await body(PATH);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(tableRows(html)).toEqual([`Tea &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;biscuits&quot;|1`]);
  });
});

// ---------------------------------------------------------------------------
// splitting a need into items
// ---------------------------------------------------------------------------

describe("splitting a need into items", () => {
  // THE PORT USES split("\n"); DJANGO USED str.splitlines(). They are not the
  // same function, and the difference is visible on the page.
  //
  // Verified under CPython 3.13.0 on this machine (not assumed):
  //   "Beans\n".splitlines()      -> ["Beans"]        split("\n") -> ["Beans", ""]
  //   "".splitlines()             -> []               split("\n") -> [""]
  //   "Rice\r\nPasta".splitlines()-> ["Rice", "Pasta"] split("\n") -> ["Rice\r", "Pasta"]
  //
  // So a trailing newline, an empty need, or Windows line endings each produce
  // an item Django would not have produced -- and the empty-string item, being
  // the one thing every such need has in common, ACCUMULATES ACROSS FOOD BANKS
  // and sorts to the TOP of a page whose entire purpose is "what is most
  // requested". The first row of the dashboard becomes a blank cell with the
  // largest number on the page.
  //
  // PINNED, NOT FIXED, and reported as suspect rather than as a live outage:
  // every current writer runs the text through @givefood/models'
  // cleanFoodbankNeedText, which trims the string and drops empty lines (and
  // whose per-line .trim() also eats a stray \r), so today's rows should not be
  // shaped like this. That is a defence one layer away, not a guarantee here,
  // and it does not cover rows written before that cleaner existed. NOT
  // VERIFIED against production data.
  it("turns a trailing newline into a blank item, which Django's splitlines() would not have done", async () => {
    seedFoodbank({ name: "Trailing", need: "Beans\n", lastNeed: PY("2026-09-04 09:00:00.000000") });

    const html = await body(PATH);

    expect(tableRows(html)).toEqual(["Beans|1", "|1"]);
    expect(headline(html)).toBe("Found 2 items from 1 food bank organisations in the last 30 days.");
  });

  it("turns an empty need into a blank item that outranks every real one", async () => {
    seedFoodbank({ name: "Emptyone", need: "", lastNeed: PY("2026-09-04 09:00:00.000000") });
    seedFoodbank({ name: "Emptytwo", need: "", lastNeed: PY("2026-09-03 09:00:00.000000") });
    seedFoodbank({ name: "Real", need: "Beans", lastNeed: PY("2026-09-02 09:00:00.000000") });

    // The blank item is FIRST, with a count of 2 -- the top row of "most
    // requested items" is an empty cell. This is the shape of the defect.
    expect(tableRows(await body(PATH))).toEqual(["|2", "Beans|1"]);
  });

  it("leaves the carriage return attached on a Windows-line-ending need", async () => {
    seedFoodbank({ name: "Windows", need: "Rice\r\nPasta", lastNeed: PY("2026-09-04 09:00:00.000000") });

    // "Rice\r" and "Rice" are different items and would be counted separately
    // against a food bank that used Unix endings.
    expect(tableRows(await body(PATH))).toEqual(["Rice\r|1", "Pasta|1"]);
  });

  // The everyday case, asserted alongside the odd ones so the split is pinned
  // in both directions: a blank LINE in the middle of a need is its own item
  // in Django too (splitlines keeps interior empties), so this is parity, not
  // divergence.
  it("keeps an interior blank line as an item, matching splitlines()", async () => {
    seedFoodbank({ name: "Interior", need: "Beans\n\nPasta", lastNeed: PY("2026-09-04 09:00:00.000000") });

    expect(tableRows(await body(PATH))).toEqual(["Beans|1", "|1", "Pasta|1"]);
  });
});

// ---------------------------------------------------------------------------
// the Trussell Trust variant
// ---------------------------------------------------------------------------

describe("the Trussell Trust variant", () => {
  beforeEach(seedTheDashboard);

  // The network clause is string-concatenated into the SQL by
  // packages/db/src/dashboards.ts, so "the flag is wired to the clause" is a
  // claim worth checking in BOTH directions -- and the plain page having no
  // clause at all is the half that a `network != 'Independent'` spelling would
  // break silently.
  it("adds the network clause only on the Trussell URL", async () => {
    await get(PATH);
    expect(prepared).toEqual([SQL]);

    prepared = [];
    await get(TT_PATH);
    expect(prepared).toEqual([TT_SQL]);
  });

  // THE TWO PAGES MUST DISAGREE. Salisbury and Cardiff are Trussell; Bristol is
  // Independent and Dundee is IFAN, so the Trussell page loses
  // Bristol's "Nappies" and Dundee's second "Tinned tomatoes" -- which drops
  // Tinned tomatoes from 2 to 1 and takes Pasta's count with it. Asserting the
  // whole table rather than "fewer rows" is what kills a flag that is read but
  // not acted on.
  it("shows only Trussell food banks, with counts that differ from the plain page", async () => {
    const html = await body(TT_PATH);

    expect(tableRows(html)).toEqual(["Tinned tomatoes|1", "Pasta|1", "UHT milk|1"]);
    // Two food banks: Salisbury, and Cardiff whose "Nothing" is excluded from
    // the items but still counted.
    expect(headline(html)).toBe("Found 3 items from 2 food bank organisations in the last 30 days.");
  });

  // A food bank with NO network is not a Trussell food bank: `network = 'Trussell'`
  // is false for NULL -- and so is `network != 'Independent'`, which is why the
  // NULL row alone does NOT distinguish the two spellings. What distinguishes
  // them is Dundee: @givefood/models' FOODBANK_NETWORKS is
  // ["Trussell", "IFAN", "Independent"], so the negation silently admits every
  // IFAN food bank on the site, and the fixture carries one for that reason.
  it("excludes a food bank with no network from the Trussell page and keeps it on the plain one", async () => {
    seedFoodbank({ name: "Nonetwork", need: "Unrecorded network item", lastNeed: PY("2026-09-04 08:00:00.000000"), network: null });

    expect(tableRows(await body(TT_PATH))).not.toContain("Unrecorded network item|1");
    expect(tableRows(await body(PATH))).toContain("Unrecorded network item|1");
  });

  // THE MODULE'S OWN CLAIM, WHICH THE REAL ROUTER CANNOT TEST. Django derived
  // the flag from the URL (`trusselltrust = ("trusselltrust" in request.path)`);
  // this port passes it in as an argument specifically so the behaviour "never
  // depends on how it happens to have been reached". The only way to
  // demonstrate that is to reach the exported handlers from the WRONG paths --
  // so this one block mounts them on a bare Hono app with the real
  // serverTiming middleware in front (elapsedMs reads the timestamp it sets).
  //
  // This is NOT a stand-in for the real router: every other test in this file
  // goes through ../../index, precisely because a hand-built router is how a
  // suite ends up proving things about a copy of the app. It is a deliberately
  // wrong mount, used to prove one thing the correct mount cannot show.
  it("takes the flag from its argument, not from the path, unlike Django", async () => {
    const misrouted = new Hono<AppEnv>();
    misrouted.use("*", serverTiming);
    // The plain handler at a path containing the word Django keyed on.
    misrouted.get("/dashboard/trusselltrust/decoy/", gfdashMostRequestedItems);
    // The Trussell handler at a path with no such word in it.
    misrouted.get("/dashboard/decoy/", gfdashTtMostRequestedItems);

    const plainAtTtPath = await misrouted.fetch(new Request(`${ORIGIN}/dashboard/trusselltrust/decoy/`), env(), execCtx);
    expect(prepared).toEqual([SQL]);
    expect(await plainAtTtPath.text()).toContain("<h1>Most Requested Items</h1>");

    prepared = [];
    const ttAtPlainPath = await misrouted.fetch(new Request(`${ORIGIN}/dashboard/decoy/`), env(), execCtx);
    expect(prepared).toEqual([TT_SQL]);
    expect(await ttAtPlainPath.text()).toContain("<h1>Trussell Trust Most Requested Items</h1>");
  });
});

// ---------------------------------------------------------------------------
// what the request costs
// ---------------------------------------------------------------------------

describe("what the request costs", () => {
  beforeEach(seedTheDashboard);

  // ONE statement, a READ, over ONE session. The query joins the whole foodbank
  // table to foodbankchange with no LIMIT, and D1 meters rows read -- a second
  // call (the shape a careless "let me also show a total" edit takes) doubles
  // that with nothing on the page to show for it.
  it("issues exactly one statement, a read, over exactly one D1 session", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM foodbank").get() as { n: number }).n;

    await get(PATH);

    expect(prepared).toEqual([SQL]);
    expect(prepared[0]!).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
    expect((db.prepare("SELECT COUNT(*) AS n FROM foodbank").get() as { n: number }).n).toBe(before);
    // lib/session.ts's mode. "first-primary" would work and would silently
    // give up read-replica eligibility on a page with no consistency
    // requirement whatsoever.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // THE ONLY USER INPUT ON THE PAGE REACHES A BOUND PARAMETER, and it reaches
  // it as a value this handler constructed from a number it had already
  // checked against a six-item allowlist -- never as text off the query string.
  // The network clause beside it IS concatenated, which is safe only because
  // it is a literal chosen by a boolean; this pins that the visitor's own
  // string never gets near either.
  it("never lets the caller's own text into the statement", async () => {
    await get(`${PATH}?days=30' OR 1=1 --`);

    // Rejected before any query at all -- the allowlist is doing the work.
    expect(prepared).toEqual([]);

    await get(`${PATH}?days=30`);
    expect(bound).toEqual([["2026-08-06 12:00:00"]]);
  });

  // Two views in a row must be identical and must still be one statement each.
  // This is the assertion a "let me cache the answer in a table" change trips
  // over, and it is also what says the page is safe to reload -- which is what
  // an operator watching a shortage develop actually does.
  it("is idempotent across repeated views", async () => {
    const first = await body(PATH);
    prepared = [];
    const second = await body(PATH);

    expect(tableRows(second)).toEqual(tableRows(first));
    expect(headline(second)).toEqual(headline(first));
    expect(prepared).toEqual([SQL]);
  });
});

// ---------------------------------------------------------------------------
// caching and the shared page context
// ---------------------------------------------------------------------------

describe("caching and the shared page context", () => {
  beforeEach(seedTheDashboard);

  // Django's view carries @cache_page(SECONDS_IN_DAY) (gfdash/views.py:82), and
  // the port reproduces the shared half of that number -- but NOT from anything
  // in this route file: /dashboard/... matches no rule in
  // middleware/pageCacheControl.ts, so the day is its FALL-THROUGH DEFAULT.
  // That is what is worth pinning here, because a new rule added above the
  // default would change this page's TTL with nothing in this directory to say
  // it had. The 300-second browser max-age is pageCacheControl's own documented
  // divergence (a browser cache cannot be purged).
  it("gets Django's day of shared cache, via pageCacheControl's default", async () => {
    expect((await get(PATH)).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect((await get(TT_PATH)).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // No Cache-Tag, so publishing a need cannot purge this page: it goes stale
  // for up to a day. middleware/cacheTag.ts's AGGREGATE_PATHS covers the home
  // page, the sitemaps, the feeds and the API list endpoints, and no dashboard
  // is in it. That matches Django, which cached the same page for a day with no
  // invalidation at all, so it is ported behaviour rather than a regression --
  // pinned so a future purge-list change has something to fail against.
  it("carries no cache tag, so a newly published need cannot purge it", async () => {
    expect((await get(PATH)).headers.get("Cache-Tag")).toBeNull();
  });

  // EACH URL IS ITS OWN CACHE ENTRY, and each declares itself canonical at its
  // own address -- buildPageContext({ path: c.req.path }), matching
  // context_processors.py:19 (SITE_DOMAIN + the path). Two pages sharing a
  // canonical would hand the Trussell page's traffic to the plain one.
  it("declares each URL canonical at its own address", async () => {
    expect(await body(PATH)).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
    expect(await body(TT_PATH)).toContain(`<link rel="canonical" href="${ORIGIN}${TT_PATH}">`);
  });

  // A DIVERGENCE, PINNED, AND IT MATTERS MORE HERE THAN ON ITS NEIGHBOURS.
  // context_processors.py:46-48 appended QUERY_STRING to flag_path, so Django's
  // "Something wrong in this page?" link carried the query the reader was
  // actually looking at. pageContext() passes only `path`, so on THIS page --
  // the one dashboard whose content depends on a query parameter -- a reader
  // who flags a problem with the 365-day view reports it against the 30-day
  // URL.
  it("drops ?days from the flag link, so a report loses which window was being viewed", async () => {
    expect(await body(`${PATH}?days=365`)).toContain(`href="/flag/#${ORIGIN}${PATH}"`);
  });

  // The debug comment's "Took Nms" is elapsedMs(c), read off the timestamp
  // middleware/serverTiming.ts stored. The failure this catches is the string
  // "NaN": elapsedMs subtracts an unset context variable if the handler is ever
  // reached without serverTiming in front of it.
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body(PATH)).toMatch(/⏱️ Took \d+ms\n/);
  });

  // The breadcrumbs and logo hrefs come from @givefood/urls' reverse table
  // (`url('index')`, `url('dash:index')`), which is how Django's own template
  // built them. If that table moved, the page would still render with a 200 and
  // every link on it would point at a 404.
  it("builds its breadcrumbs from the reverse-URL table", async () => {
    const html = await body(PATH);

    expect(html).toContain('<li><a href="/">Home</a></li>');
    expect(html).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
  });
});

// ---------------------------------------------------------------------------
// when the query fails
// ---------------------------------------------------------------------------

describe("when the query fails", () => {
  // The handler has no try/catch, which is the right call and is worth pinning
  // as such. The defensive-looking alternative -- catching and rendering with
  // an empty item list -- would publish a page saying four food banks asked for
  // nothing at all in the last thirty days, when what actually happened is that
  // D1 was unavailable. An empty table on a data page is a claim, and a false
  // one is worse than an error page.
  it("serves the real 500 page instead of an empty table", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      DB: {
        withSession: () => ({
          prepare: () => ({
            bind: () => ({
              all: async () => {
                throw new Error("D1_ERROR: network connection lost");
              },
            }),
          }),
        }),
      },
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`${ORIGIN}${PATH}`), broken, execCtx);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("<h1>500 - Internal Server Error</h1>");
    // Not a partial page: the day picker and the item table must be absent, or
    // a reader gets a 500 that still looks like a working dashboard.
    expect(html).not.toContain("<table");
    expect(dayOptions(html)).toEqual([]);
  });
});
