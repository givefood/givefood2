import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// /dashboard/trusselltrust/old-data/ -- gfdash/views.py:220-230 `tt_old_data`,
// registered gfdash/urls.py:15 as `dash:tt_old_data`, rendered through
// packages/templates/templates/dash/tt_old_data.njk (a line-for-line port of
// gfdash/templates/dash/tt_old_data.html in the ancestor repo).
//
// WHAT THIS PAGE IS, because every assertion below turns on it: TWO tables of
// the SAME 100-row filter (open Trussell food banks), ordered in OPPOSITE
// directions. The left-hand table is `old` -- last_need ASCENDING, i.e. the
// food banks whose shopping list has gone longest without a change -- and the
// right-hand one is `recent`, last_need DESCENDING. That is the entire
// content of the page and the two differ by four characters of SQL, so a
// transposition renders a page that is complete, plausible, symmetrical and
// exactly backwards: the operator chasing stale data would work down a list
// of the food banks updated most recently.
//
// WHY THIS EXISTS AT ROUTE LEVEL when packages/db/src/dashboards.test.ts
// already runs getTrussellFoodbanksByLastNeed against a real engine: that
// function returns rows. Everything this page IS happens here and in the
// template -- which list reaches which column, the timesince rendering of
// last_need, and the null branch that turns a food bank with no recorded need
// into a bare " ago". None of it can fail loudly: a dashboard nobody watches
// serving a confident wrong ordering is precisely the failure class this tier
// was commissioned for.
//
// REAL EVERYTHING. The real `app` from ../../index (so the path, the method,
// the trailing-slash redirect and the cache headers are the SHIPPED
// registrations -- this repo has already had a suite pass for weeks against a
// router it built itself), the real packages/db query, the real dbSession,
// and the real Nunjucks render. Only D1 is doubled, by node:sqlite over the
// schema the real migrations produce (schemaFor), which is a truer D1 than
// any mock. Assertions read the rendered HTML rather than a captured context
// object, because env.ts sets throwOnUndefined:false: a context key renamed
// on either side of the boundary renders as empty string with a 200.
//
// PARITY WORK ACTUALLY RUN, not reasoned about. Every timesince string below
// was produced by calling django.utils.timesince.timesince() from the
// ancestor repo's own virtualenv (/Users/jasoncartwright/Sites/foodcharity/
// .venv -- Django 6.1 on python3.12) with the same two naive datetimes, and
// the null-rendering and autoescape expectations came from rendering the
// equivalent Django template snippets in that same interpreter. Where the
// port and Django genuinely differ it is marked DIVERGENCE and pinned as the
// port behaves.
//
// MUTATION-TESTED in a copy of the repo outside it (TESTING.md's
// no-scratch-files rule), 38 mutants across ttOldData.ts, index.ts's
// registration, lib/session.ts, lib/timesince.ts, packages/db's query,
// dash/tt_old_data.njk and middleware/pageCacheControl.ts. 36 died. The ones
// worth naming because they are plausible edits rather than contrived ones:
// the `recent`/`old` context keys transposed; the same transposition done one
// line earlier, at the two .map() calls; both queries given the same
// direction (each way round); LIMIT 100 -> 10 and -> 1000; the null guard on
// last_need deleted, and rewritten as `!== null` so an empty string reaches
// the parser; name and url swapped in toTemplateRow; last_need_timesince
// renamed; the page context no longer spread in; buildPageContext handed
// c.req.url; render_time_ms dropped; c.html -> c.text; a second dbSession()
// per query; the session mode changed to "first-primary"; the route
// registered as .post, additionally as .post, at a different path; the legacy
// /needs/tt-old-data/ redirect changed from 302 to 301; in packages/db, each
// of the two WHERE clauses dropped, `network =` loosened to LIKE, ORDER BY
// dropped and re-pointed at id and at modified, `url` replaced by a second
// copy of `name`, and the bound limit hardcoded; in the template, the Old
// Data loop switched to `recent`, the two <h2>s swapped, the literal " ago"
// removed and |safe applied to the name; in lib/timesince.ts, the two-unit
// depth cut to one and the U+00A0 turned back into a plain space; and in the
// middleware, the default shared TTL cut from a day to an hour.
//
// TWO SURVIVED, both recorded rather than papered over. (1) Dropping the
// `now` argument -- `timesince(row.last_need)` -- is undetectable here and
// arguably everywhere: the default is `new Date()`, which under this file's
// frozen clock is the same instant, and in production is microseconds later.
// (2) timesince()'s own `sinceSeconds <= 0` guard weakened to `< 0` survives
// this file but is killed by lib/timesince.test.ts, which owns that boundary
// and tests the equal-instant case directly.
//
// A TRAP WORTH RECORDING for whoever mutates a template next: templates reach
// the tests through packages/templates/src/generated/precompiled.js, a build
// artifact, so editing the .njk changes NOTHING until scripts/precompile.ts
// runs again. The four template mutants above were run with a precompile
// either side; without it they would all have "survived", which reads exactly
// like a strong suite and is the more dangerous of the two failure modes.

const ORIGIN = "https://www.givefood.org.uk";
const PATH = "/dashboard/trusselltrust/old-data/";

// Fixed, because this page's entire second column is an elapsed time. Without
// a frozen clock every timesince assertion would be a race against the
// calendar, and the ones that matter most (a boundary at exactly one week, a
// month count) would rot silently into passing for the wrong reason.
const NOW = new Date("2026-09-08T09:30:00.000Z");

// Django's avoid_wrapping() replaces the space inside "3 months" with U+00A0
// so the count never wraps away from its unit, and lib/timesince.ts's
// unitText() does the same. Always written as the escape and never as the raw
// character: on screen the two are indistinguishable, so a test comparing
// against the wrong one would assert nothing whatever.
const NB = " ";

type Bindable = null | number | bigint | string | Uint8Array;

interface Prepared {
  sql: string;
  params: Bindable[];
}

// Set by the one test that needs D1 to fail, cleared in beforeEach. A
// module-level flag rather than a parameter because the failure has to happen
// inside a session the ROUTE created, which the test cannot reach.
let failQueries = false;

// A D1DatabaseSession over real SQLite. Every statement is recorded so the
// tests can assert this page issues exactly two reads and never a write -- a
// GET able to run an UPDATE is invisible from the response body, and this
// repo has shipped one before.
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
      // Captured, not ignored: dbSession() asks for "first-unconstrained",
      // which is what lets a read-only dashboard be served from a replica.
      // Nothing on the page shows which mode it used.
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

interface Seed {
  id: number;
  name: string;
  lastNeed: string | null;
  network?: string | null;
  isClosed?: 0 | 1;
  url?: string;
}

// Every NOT NULL column of the real `foodbank` table filled with something
// plausible, because schemaFor() hands over the real DDL rather than a
// reduced fixture. Only last_need, network and is_closed are ever varied --
// the three things this page's query cares about -- so each test's seed reads
// as a statement about the one thing it is testing.
function seedFoodbank({ id, name, lastNeed, network = "Trussell", isClosed = 0, url }: Seed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, network,
       charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative,
       is_closed, no_locations, days_between_needs, last_need, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79', ?,
       0, ?, ?, ?, 0, ?, 0, 14, ?, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    id,
    String(id).padStart(32, "a"),
    name,
    `foodbank-${id}`,
    network,
    `info@fb${id}.invalid`,
    url ?? `https://fb${id}.invalid/`,
    `https://fb${id}.invalid/list/`,
    isClosed,
    lastNeed,
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
// The page carries exactly two <table>s and nothing else on it is tabular, so
// document order IS the identity of each list: the first is "Old Data"
// (`old`, ascending) and the second "Recent Changes" (`recent`, descending).
// Reading them positionally rather than by a class or an id is deliberate --
// it is the reading a human gets, and it is what makes a transposed pair of
// context keys detectable at all.

function tables(html: string): [string, string] {
  const found = [...html.matchAll(/<table[\s\S]*?<\/table>/g)];
  // If the template ever grows a third table this must be revisited rather
  // than silently indexing past it.
  expect(found).toHaveLength(2);
  // The headings are checked HERE, once, rather than in each test, because
  // reading the two lists positionally is only sound while the labels are in
  // the order this assumes. Swapping just the two <h2>s -- a one-line edit
  // that leaves both tables and every ordering intact -- would otherwise
  // relabel the whole page and survive every assertion in this file.
  // Positions come from the match indices, not indexOf: on an empty
  // database the two tables are byte-identical and indexOf would find the
  // first one twice.
  const marks = [
    html.indexOf("<h2>Old Data</h2>"),
    found[0]?.index as number,
    html.indexOf("<h2>Recent Changes</h2>"),
    found[1]?.index as number,
  ];
  expect(marks.every((mark) => mark >= 0)).toBe(true);
  expect([...marks].sort((a, b) => a - b)).toEqual(marks);
  return [found[0]?.[0] as string, found[1]?.[0] as string];
}

// One row as the page presents it: the link target, the link text, and the
// whole second cell verbatim -- including the leading space and the U+00A0,
// because both are load-bearing (see the null-last_need tests).
type Row = [href: string, name: string, lastNeedCell: string];

function rows(table: string): Row[] {
  return [...table.matchAll(/<td><a href="([^"]*)">([\s\S]*?)<\/a><\/td>\s*<td>([\s\S]*?)<\/td>/g)].map((m) => [
    m[1] as string,
    m[2] as string,
    m[3] as string,
  ]);
}

const oldTable = (html: string): Row[] => rows(tables(html)[0]);
const recentTable = (html: string): Row[] => rows(tables(html)[1]);
const names = (list: Row[]): string[] => list.map((row) => row[1]);

// ===========================================================================
// The two opposite orderings -- the whole point of the page
// ===========================================================================

describe("the two lists", () => {
  // The single most valuable assertion in this file, and the one that kills
  // the cheapest plausible mutant: swapping the `recent` and `old` keys in
  // the context object, or handing both calls the same direction. Django was
  // `.order_by("-last_need")[:100]` for recent and `.order_by("last_need")`
  // for old (views.py:222-223); the left-hand "Old Data" column must be the
  // ascending one. Three food banks with three distinct last_need values is
  // the smallest seed where "oldest first" and "newest first" are different
  // lists rather than the same list.
  it("puts the LONGEST-stale food bank at the top of Old Data and the freshest at the top of Recent Changes", async () => {
    seedFoodbank({ id: 1, name: "Middle", lastNeed: "2026-01-05 09:00:00.000000" });
    seedFoodbank({ id: 2, name: "Freshest", lastNeed: "2026-09-05 09:00:00.000000" });
    seedFoodbank({ id: 3, name: "Stalest", lastNeed: "2024-03-05 09:00:00.000000" });

    const html = await getBody();

    expect(names(oldTable(html))).toEqual(["Stalest", "Middle", "Freshest"]);
    expect(names(recentTable(html))).toEqual(["Freshest", "Middle", "Stalest"]);
  });

  // Insert order must not survive into either list. SQLite would otherwise
  // hand back rowid order, which for this seed is already neither ascending
  // nor descending by last_need -- so an ORDER BY dropped from the query
  // shows up here as the SAME order in both columns, which is the visual
  // signature the previous test cannot distinguish from a working page if
  // the rows happen to be inserted sorted.
  it("ignores insert order in both directions", async () => {
    seedFoodbank({ id: 1, name: "Second", lastNeed: "2025-06-05 09:00:00.000000" });
    seedFoodbank({ id: 2, name: "Third", lastNeed: "2026-06-05 09:00:00.000000" });
    seedFoodbank({ id: 3, name: "First", lastNeed: "2024-06-05 09:00:00.000000" });

    const html = await getBody();

    expect(names(oldTable(html))).toEqual(["First", "Second", "Third"]);
    expect(names(recentTable(html))).toEqual(["Third", "Second", "First"]);
  });

  // Both lists are LIMIT 100 (Django's `[:100]` twice, views.py:222-223), and
  // the two slices are taken from opposite ends of the SAME sort -- not one
  // slice reversed in JS. With 105 food banks that distinction becomes
  // visible for the first time: `recent` reversed would show the 100th to
  // 5th stalest as "Old Data" and hide the five stalest entirely, which is
  // the exact opposite of what an operator opens this page to find. Asserting
  // the ABSENCES as well as the presences, because a list of 100 plausible
  // names is not evidence of anything on its own.
  it("takes the extreme 100 from each end, and the five rows past each limit are absent", async () => {
    // 105 food banks, one per day through February 2024 and into May --
    // strictly increasing last_need, so "oldest 100" and "newest 100" are
    // unambiguous and overlap in all but five rows at each end.
    for (let i = 0; i < 105; i += 1) {
      const day = new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      seedFoodbank({ id: i + 1, name: `FB ${String(i).padStart(3, "0")}`, lastNeed: `${day} 09:00:00.000000` });
    }

    const html = await getBody();
    const oldNames = names(oldTable(html));
    const recentNames = names(recentTable(html));

    expect(oldNames).toHaveLength(100);
    expect(recentNames).toHaveLength(100);
    expect(oldNames[0]).toBe("FB 000");
    expect(oldNames[99]).toBe("FB 099");
    expect(recentNames[0]).toBe("FB 104");
    expect(recentNames[99]).toBe("FB 005");
    // The five newest never appear in Old Data, and the five oldest never in
    // Recent Changes.
    for (const late of ["FB 100", "FB 101", "FB 102", "FB 103", "FB 104"]) expect(oldNames).not.toContain(late);
    for (const early of ["FB 000", "FB 001", "FB 002", "FB 003", "FB 004"]) expect(recentNames).not.toContain(early);
  });

  // Fewer than 100 rows: both tables hold the same set, in exactly opposite
  // orders. This is the property that makes the page's two columns a single
  // fact viewed from both ends, and it kills a mutant that gives one list a
  // different filter or a different limit while leaving both looking sane.
  it("shows the same food banks in both columns, reversed, when there are fewer than 100", async () => {
    seedFoodbank({ id: 1, name: "Alpha", lastNeed: "2026-01-05 09:00:00.000000" });
    seedFoodbank({ id: 2, name: "Bravo", lastNeed: "2026-06-05 09:00:00.000000" });
    seedFoodbank({ id: 3, name: "Charlie", lastNeed: "2025-03-05 09:00:00.000000" });

    const html = await getBody();

    expect(oldTable(html)).toEqual([...recentTable(html)].reverse());
  });
});

// ===========================================================================
// The filter -- three ways a food bank can be excluded
// ===========================================================================

describe("which food banks appear", () => {
  // Every excluded row here is seeded with a last_need MORE EXTREME than the
  // one row that should survive -- one far older, one far newer -- so a
  // filter that stops working does not merely lengthen the lists, it puts a
  // wrong name at the TOP of both columns. A test that seeded only matching
  // rows would pass against a WHERE clause deleted entirely.
  it("excludes closed food banks, other networks and a null network from both lists", async () => {
    seedFoodbank({ id: 1, name: "Open Trussell", lastNeed: "2026-05-05 09:00:00.000000" });
    seedFoodbank({ id: 2, name: "Closed Trussell", lastNeed: "2019-01-01 09:00:00.000000", isClosed: 1 });
    seedFoodbank({ id: 3, name: "Closed And Fresh", lastNeed: "2026-09-07 09:00:00.000000", isClosed: 1 });
    seedFoodbank({ id: 4, name: "Independent", lastNeed: "2018-01-01 09:00:00.000000", network: "Independent" });
    seedFoodbank({ id: 5, name: "No Network", lastNeed: "2026-09-08 09:00:00.000000", network: null });

    const html = await getBody();

    expect(names(oldTable(html))).toEqual(["Open Trussell"]);
    expect(names(recentTable(html))).toEqual(["Open Trussell"]);
  });

  // The network match is exact and case-sensitive: the column holds
  // "Trussell", not the charity's former "Trussell Trust" name that this
  // page's own title and breadcrumb still use. Pinned because the two strings
  // are a rename apart and the page would empty itself silently -- an empty
  // dashboard reads as "nothing is stale", which is the reassuring failure.
  it("matches the network string exactly -- 'Trussell Trust' is not 'Trussell'", async () => {
    seedFoodbank({ id: 1, name: "Legacy Spelling", lastNeed: "2026-05-05 09:00:00.000000", network: "Trussell Trust" });
    seedFoodbank({ id: 2, name: "Lowercase", lastNeed: "2026-05-06 09:00:00.000000", network: "trussell" });

    const html = await getBody();

    expect(oldTable(html)).toEqual([]);
    expect(recentTable(html)).toEqual([]);
  });
});

// ===========================================================================
// last_need -> the "Last Need Found" cell
// ===========================================================================

describe("the elapsed-time column", () => {
  // The actual strings, against a frozen clock, produced by running
  // django.utils.timesince.timesince(d, now) in the ancestor repo's venv
  // (Django 6.1, python3.12) for each of these four timestamps against
  // 2026-09-08 09:30:00. The port matches all four, U+00A0 included. Both
  // the two-unit case ("2 years, 6 months", where Django joins adjacent units
  // with a plain ", ") and the one-unit cases are here because the join and
  // the depth-2 truncation are separate pieces of lib/timesince.ts.
  it("renders Django's own timesince output, non-breaking space and all", async () => {
    seedFoodbank({ id: 1, name: "Week", lastNeed: "2026-09-01 09:30:00.000000" });
    seedFoodbank({ id: 2, name: "Months", lastNeed: "2026-06-05 09:00:00.000000" });
    seedFoodbank({ id: 3, name: "YearsMonths", lastNeed: "2024-03-01 09:00:00.000000" });
    seedFoodbank({ id: 4, name: "DayHours", lastNeed: "2026-09-06 21:30:00.000000" });

    const cells = new Map(oldTable(await getBody()).map((row) => [row[1], row[2]]));

    expect(cells.get("Week")).toBe(`1${NB}week ago`);
    expect(cells.get("Months")).toBe(`3${NB}months ago`);
    expect(cells.get("YearsMonths")).toBe(`2${NB}years, 6${NB}months ago`);
    expect(cells.get("DayHours")).toBe(`1${NB}day, 12${NB}hours ago`);
  });

  // A NULL last_need renders as a bare " ago" -- the empty string the route's
  // toTemplateRow() substitutes, followed by the template's literal " ago".
  // THIS IS DELIBERATE PARITY, not an oversight: Django's `{{ x|timesince }}
  // ago` with x=None renders "[ ago]" verbatim, confirmed by rendering that
  // exact template in the ancestor repo's venv rather than by reading the
  // filter's source. The route's comment says as much, and this is the test
  // that stops a well-meaning "surely that should say Never" edit from
  // silently changing what an operator comparing the two sites sees.
  //
  // It is also the test that catches the null guard being removed: without
  // it, timesince(null) reaches parseUtc and throws on .split, which turns
  // this whole page into a 500 the moment one food bank has never had a need
  // recorded.
  it("renders a food bank with no recorded need as a bare ' ago'", async () => {
    seedFoodbank({ id: 1, name: "Never", lastNeed: null });

    const html = await getBody();

    expect(oldTable(html)).toEqual([["https://fb1.invalid/", "Never", " ago"]]);
    expect(recentTable(html)).toEqual([["https://fb1.invalid/", "Never", " ago"]]);
  });

  // An empty-string last_need takes the same falsy branch as NULL -- `row.
  // last_need ? ... : ""` tests truthiness, not null-ness -- so it also
  // renders " ago" rather than "56 years ago" (which is what parsing "" as a
  // date would give: Date.UTC(NaN...) is Invalid Date, and the arithmetic
  // downstream produces nonsense, not an exception). Reachable through an
  // importer or an admin edit, since the column is nullable TEXT with no
  // check constraint.
  it("treats an empty-string last_need the same as a null one", async () => {
    seedFoodbank({ id: 1, name: "Blank", lastNeed: "" });

    expect(oldTable(await getBody())[0]?.[2]).toBe(" ago");
  });

  // SUSPECT, PINNED AS THE PORT BEHAVES. SQLite sorts NULL as SMALLER than
  // every value; Postgres's defaults are ASC NULLS LAST / DESC NULLS FIRST,
  // so under Django a food bank that has NEVER had a need recorded headed the
  // "Recent Changes" column and here it heads "Old Data". (The Postgres half
  // of that claim is recorded in packages/db/src/dashboards.test.ts and is
  // NOT re-verified against a live Postgres here.) Neither placement errors
  // and both look reasonable, but the meanings are opposite -- and on THIS
  // page, whose entire subject is which food banks have stale data, the port
  // arguably lands the right way round while diverging.
  it("sorts a null last_need to the top of Old Data and the bottom of Recent Changes", async () => {
    seedFoodbank({ id: 1, name: "Never", lastNeed: null });
    seedFoodbank({ id: 2, name: "Stale", lastNeed: "2024-03-05 09:00:00.000000" });
    seedFoodbank({ id: 3, name: "Fresh", lastNeed: "2026-09-05 09:00:00.000000" });

    const html = await getBody();

    expect(names(oldTable(html))).toEqual(["Never", "Stale", "Fresh"]);
    expect(names(recentTable(html))).toEqual(["Fresh", "Stale", "Never"]);
  });

  // last_need is TEXT compared lexicographically, and this repo holds both
  // spellings: Django wrote "YYYY-MM-DD HH:MM:SS.ffffff" and app code has
  // written toISOString() ("...THH:MM:SS.sssZ"). Migration 0022 normalised
  // the three foodbank.last_need rows that had drifted, but nothing prevents
  // a new one. "T" (0x54) sorts AFTER " " (0x20), so an ISO row sorts after
  // every Django-format row of the SAME SECOND -- here the ISO 09:00 row
  // sorts after the naive 09:00 one, and both still sort correctly against a
  // different day. Pinned so the ordering consequence is written down rather
  // than discovered, and because lib/timesince.ts's parseUtc handles both
  // spellings: the rendered elapsed times below are identical, which is the
  // half that actually matters to a reader.
  it("orders an ISO-spelled timestamp after a Django-spelled one from the same second", async () => {
    seedFoodbank({ id: 1, name: "Naive", lastNeed: "2026-06-05 09:00:00.000000" });
    seedFoodbank({ id: 2, name: "Iso", lastNeed: "2026-06-05T09:00:00.000Z" });
    seedFoodbank({ id: 3, name: "Later Day", lastNeed: "2026-06-06 09:00:00.000000" });

    const html = await getBody();

    expect(names(oldTable(html))).toEqual(["Naive", "Iso", "Later Day"]);
    // Same instant, same rendered elapsed time, despite the different
    // spellings -- parseUtc strips the "T" and the "Z".
    const cells = new Map(oldTable(html).map((row) => [row[1], row[2]]));
    expect(cells.get("Iso")).toBe(cells.get("Naive"));
    expect(cells.get("Iso")).toBe(`3${NB}months ago`);
  });

  // A last_need in the FUTURE (a crawler writing a timestamp from a machine
  // with a skewed clock, or an admin typo) renders "0 minutes ago" rather
  // than a negative duration -- Django's own documented behaviour for
  // timesince(), and lib/timesince.ts reproduces it. It also lands at the top
  // of Recent Changes, which is where it belongs. Worth pinning at this level
  // because "0 minutes ago" at the head of a staleness dashboard is a
  // legible, wrong-looking-but-not-broken reading that an operator has to be
  // able to trust means what it says.
  it("renders a future last_need as '0 minutes ago' rather than a negative duration", async () => {
    seedFoodbank({ id: 1, name: "Skewed", lastNeed: "2027-01-01 09:00:00.000000" });
    seedFoodbank({ id: 2, name: "Normal", lastNeed: "2026-09-01 09:30:00.000000" });

    const html = await getBody();

    expect(recentTable(html)[0]).toEqual(["https://fb1.invalid/", "Skewed", `0${NB}minutes ago`]);
    expect(recentTable(html)[1]?.[2]).toBe(`1${NB}week ago`);
  });

  // Both columns are rendered from ONE `now`, captured once in the handler
  // before either query runs, so the same food bank cannot report two
  // different ages on one page. Under a frozen clock a per-row `new Date()`
  // would be indistinguishable, so this is not a strong mutant-killer on its
  // own -- what it does pin is that the two tables agree, which is the thing
  // a reader would notice and disbelieve.
  it("gives one food bank the same elapsed time in both columns", async () => {
    seedFoodbank({ id: 1, name: "Only", lastNeed: "2025-09-08 09:30:00.000000" });

    const html = await getBody();

    expect(oldTable(html)[0]?.[2]).toBe(`1${NB}year ago`);
    expect(recentTable(html)[0]).toEqual(oldTable(html)[0]);
  });
});

// ===========================================================================
// The link cell
// ===========================================================================

describe("the food bank link", () => {
  // `url` is the food bank's OWN website (Django's Foodbank.url), not a
  // givefood.org.uk page -- this dashboard exists so an operator can go and
  // look at the food bank's shopping list. A `name AS url` slip in the query
  // renders a page of links that all 404 while every row-count assertion in
  // this file still passes, which is why the href and the text are asserted
  // as a pair rather than separately.
  it("links each row to the food bank's own site, with the name as the text", async () => {
    seedFoodbank({ id: 7, name: "Salisbury", lastNeed: "2026-06-05 09:00:00.000000", url: "https://salisbury.example.org/" });

    expect(oldTable(await getBody())).toEqual([["https://salisbury.example.org/", "Salisbury", `3${NB}months ago`]]);
  });

  // Autoescaping, asserted on the literal output. A name or a URL containing
  // a quote would otherwise close the href attribute and let an admin-entered
  // string inject markup into a page other admins read.
  //
  // DIVERGENCE FROM DJANGO, cosmetic and pinned so nobody chases it: Nunjucks
  // escapes the apostrophe as &#39; where Django's own escape() emits &#x27;
  // (both were rendered, in the ancestor repo's venv and here, to check). The
  // character is the same; only the entity spelling differs, so a byte-level
  // diff of the two sites' HTML will show it.
  it("escapes the name and the URL rather than letting either close the attribute", async () => {
    seedFoodbank({
      id: 1,
      name: 'Al & <b>pha</b> "x" \'y\'',
      lastNeed: "2026-06-05 09:00:00.000000",
      url: 'https://e.invalid/?a=1&b="2"',
    });

    const html = await getBody();

    expect(html).toContain('<a href="https://e.invalid/?a=1&amp;b=&quot;2&quot;">Al &amp; &lt;b&gt;pha&lt;/b&gt; &quot;x&quot; &#39;y&#39;</a>');
    expect(html).not.toContain("<b>pha</b>");
  });

  // SUSPECT, PINNED BECAUSE DJANGO DID EXACTLY THE SAME. Autoescaping makes
  // the attribute safe to *parse*, but nothing filters the URL's SCHEME, so a
  // stored "javascript:" URL becomes a live link on a page that only staff
  // open. Verified that Django renders it identically ({{ u }} inside an
  // href, rendered in the ancestor repo's venv), so this is inherited rather
  // than introduced, and `url` is only writable through the admin. Recorded
  // here rather than fixed: a test is the right place for "this is not a
  // hardened link", and a reviewer skimming the escaping test above would
  // otherwise reasonably assume it was.
  it("does not filter the URL scheme -- a javascript: url renders as a live href", async () => {
    seedFoodbank({ id: 1, name: "Nasty", lastNeed: "2026-06-05 09:00:00.000000", url: "javascript:alert(1)" });

    expect(await getBody()).toContain('<a href="javascript:alert(1)">Nasty</a>');
  });
});

// ===========================================================================
// Empty renders
// ===========================================================================

describe("edge-case renders", () => {
  // An empty database is a 200 with two empty tables, not a 500 and not a
  // blank page. This is the state of every fresh D1 preview database, so it
  // is the first thing anyone sees after a migration -- an exception here
  // would be read as "the migration broke the dashboards". The headings and
  // the column titles are asserted too, so an empty dataset can never be
  // mistaken for an empty template.
  it("renders both empty tables when no Trussell food bank exists", async () => {
    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(oldTable(html)).toEqual([]);
    expect(recentTable(html)).toEqual([]);
    expect(html).toContain("<h1>Trussell Trust Old Data</h1>");
    expect(html).toContain("<h2>Old Data</h2>");
    expect(html).toContain("<h2>Recent Changes</h2>");
    // Both tables keep their header row, which is outside the loop.
    expect(html.match(/<th>Last Need Found<\/th>/g)).toHaveLength(2);
  });
});

// ===========================================================================
// Route wiring: the shipped registration, not a hand-built one
// ===========================================================================

describe("route", () => {
  it("answers GET at /dashboard/trusselltrust/old-data/ with HTML", async () => {
    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toContain("<title>Trussell Trust Old Data - Give Food</title>");
  });

  // Registered with app.get only, so every other method falls through to the
  // site 404. The database is read back rather than the status trusted: "no
  // write surface at this path" is the claim, and a 404 alone does not prove
  // the handler never ran.
  it("does not answer POST, and a POST touches the database not at all", async () => {
    seedFoodbank({ id: 1, name: "Alpha", lastNeed: "2026-06-05 09:00:00.000000" });

    const res = await get(PATH, { method: "POST" });

    expect(res.status).toBe(404);
    expect(sessionModes).toEqual([]);
    expect(prepared).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM foodbank").get() as { n: number }).n).toBe(1);
  });

  // gfdash sits OUTSIDE Django's i18n_patterns (gfdash/urls.py is included
  // unprefixed, and index.ts's locale loop deliberately skips the dashboards
  // for that reason), so there is no Welsh dashboard URL to be had. Pinned so
  // that adding one becomes a deliberate act rather than an accident of a
  // loop gaining one more path.
  it("has no locale-prefixed form", async () => {
    expect((await get(`/cy${PATH}`)).status).toBe(404);
    expect((await get(`/ga${PATH}`)).status).toBe(404);
  });

  // Django's APPEND_SLASH, reproduced by app.notFound() -> lib/appendSlash.ts.
  it("301s the slash-less URL to the canonical one", async () => {
    const res = await get("/dashboard/trusselltrust/old-data");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
  });

  // The pre-gfdash home of this page. It lives in index.ts:305 rather than in
  // ttOldData.ts, and is asserted here because it is the only thing that
  // makes an old bookmark or an external link land on this handler at all --
  // a redirect nobody tests is a redirect that quietly becomes a 404.
  it("302s the legacy /needs/tt-old-data/ URL here", async () => {
    const res = await get("/needs/tt-old-data/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(PATH);
  });

  // DIVERGENCE FROM DJANGO, pinned as the port behaves. Django decorated this
  // view @cache_page(SECONDS_IN_HOUR) (gfdash/views.py:219); the port has no
  // per-route header here, so middleware/pageCacheControl.ts's DEFAULT
  // applies -- a day at the edge. Twenty-four times Django's window on a page
  // whose whole subject is data going stale, and the edge entry carries no
  // Cache-Tag (cacheTag.ts tags food bank and aggregate paths, and a
  // dashboard is neither) so it cannot be purged short of a zone-wide purge.
  // Not this module's to fix, and recorded rather than wished away.
  it("is cached for a DAY at the edge, not Django's hour", async () => {
    const res = await get(PATH);

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });
});

// ===========================================================================
// Database discipline and failure
// ===========================================================================

describe("database use", () => {
  // TWO statements on ONE session. The single session is the point: both
  // lists are slices of the same filter, and a second withSession() could
  // serve them from two replicas at two different moments -- so a food bank
  // could appear in neither column, or in both with different ages, for no
  // reason a reader could ever diagnose. Also: both are SELECTs, both bind
  // the limit as a parameter, and neither is a write.
  it("reads twice on one first-unconstrained session, binds the limit, and writes nothing", async () => {
    seedFoodbank({ id: 1, name: "Alpha", lastNeed: "2026-06-05 09:00:00.000000" });

    await get(PATH);

    expect(sessionModes).toEqual(["first-unconstrained"]);
    expect(prepared).toHaveLength(2);
    for (const statement of prepared) {
      expect(statement.params).toEqual([100]);
      expect(statement.sql).toMatch(/^\s*SELECT\b/i);
      expect(statement.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|CREATE)\b/i);
    }
    // The two differ only in direction -- the DESC ("recent") slice is asked
    // for first. A single query reused for both lists, or a JS reverse of one
    // result set, would show up here as one prepare or as two identical ones.
    expect(prepared[0]?.sql).toContain("ORDER BY last_need DESC");
    expect(prepared[1]?.sql).toContain("ORDER BY last_need ASC");
  });

  // Two identical requests give identical pages and leave the database
  // untouched. This page has no cron behind it, but it IS reachable by any
  // crawler at any rate, and "reads are reads" is the property that makes the
  // day-long edge cache above safe to hand out.
  it("is unchanged by being requested twice", async () => {
    seedFoodbank({ id: 1, name: "Alpha", lastNeed: "2026-06-05 09:00:00.000000" });
    seedFoodbank({ id: 2, name: "Bravo", lastNeed: "2026-01-05 09:00:00.000000" });

    const first = await getBody();
    const second = await getBody();

    expect(oldTable(second)).toEqual(oldTable(first));
    expect(recentTable(second)).toEqual(recentTable(first));
    expect((db.prepare("SELECT COUNT(*) AS n FROM foodbank").get() as { n: number }).n).toBe(2);
  });

  // A D1 failure must surface as the site's 500 page, not as a 200 carrying
  // two empty tables. The distinction matters more here than on a content
  // page: "no Trussell food bank has stale data" is a legible, welcome,
  // plausible answer to this page's question, so a swallowed error would be
  // read as good news. It must also not be cached -- pageCacheControl skips
  // non-200s, so the broken page does not take the day-long TTL.
  it("500s on a database failure instead of rendering two empty tables", async () => {
    seedFoodbank({ id: 1, name: "Alpha", lastNeed: "2026-06-05 09:00:00.000000" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    failQueries = true;

    const res = await get(PATH);
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("500 - Internal Server Error");
    expect(html).not.toContain("<h1>Trussell Trust Old Data</h1>");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});

// ===========================================================================
// Page furniture that comes from the route, not the template
// ===========================================================================

describe("page context", () => {
  // buildPageContext is handed `c.req.path`, not the full URL, so the
  // canonical link is query-free. A "?utm_source=..." link shared into a
  // newsletter would otherwise announce itself to crawlers as a distinct
  // page -- the classic duplicate-content split, invisible on the page.
  it("gives the same canonical URL whatever the query string", async () => {
    const plain = await getBody(PATH);
    const withQuery = await getBody(`${PATH}?utm_source=newsletter&x=1`);

    expect(plain).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
    expect(withQuery).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
  });

  // render_time_ms is the route's own addition to the page context (Django's
  // RenderTime middleware, ported per-page -- see middleware/serverTiming.ts).
  // Unwire it and the debug comment reads "Took ms", because Nunjucks renders
  // a missing variable as empty string rather than complaining. Whole
  // milliseconds deliberately: the port dropped Django's three decimals
  // because on Workers they were always ".000".
  it("stamps the debug comment with a whole-millisecond render time", async () => {
    const html = await getBody();

    expect(html).toMatch(/⏱️ Took \d+ms/);
    expect(html).not.toMatch(/⏱️ Took \d+\.\d+ms/);
  });

  // The breadcrumb resolves through @givefood/urls' reverse-URL table, which
  // is how the page links back to /dashboard/. A wrong name there renders an
  // empty href -- a dead breadcrumb on a page nobody watches.
  it("links back to the dashboard index from the breadcrumb", async () => {
    const html = await getBody();

    expect(html).toContain('<a href="/dashboard/">Dashboards</a>');
    expect(html).toContain(`<a href="${PATH}" aria-current="page">Trussell Trust Old Data</a>`);
  });
});
