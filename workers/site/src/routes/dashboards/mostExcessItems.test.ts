import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/mostExcessItems.ts -- gfdash's `most_excess_items`
// (gfdash/views.py:146-195 in the Django repo, read alongside this file),
// served at /dashboard/most-excess-items/.
//
// WHY THIS FILE EXISTS. The handler is a ?days= gate, one query and a Counter,
// and every way it can be wrong renders a perfectly ordinary page of food
// items with plausible numbers beside them. Nothing on the page says which
// window it covers except a sentence the handler itself writes, so a wrong
// threshold is self-consistent and invisible:
//
//   * `sinceIso()` is computed HERE, from `new Date()`, and is the query's
//     ONLY bound parameter. It never appears in the SQL text, so
//     packages/db/src/dashboards.test.ts -- which passes its own literal
//     threshold -- cannot see a change to the arithmetic, the truncation, or
//     the "YYYY-MM-DD HH:MM:SS" shape that makes a TEXT column comparable at
//     all. Every ?days= test below asserts the value that actually reached
//     the engine.
//   * the two counters the page leads with are computed from DIFFERENT things
//     -- `number_foodbanks` counts rows that contributed, `number_items`
//     counts DISTINCT items -- and swapping either for the obvious neighbour
//     (`rows.length`, `items.length`) changes the headline sentence and
//     nothing else.
//   * this dashboard deliberately has NO invalid-text exclusion list and no
//     /trusselltrust/ variant, unlike its near-identical sibling
//     mostRequestedItems.ts. Those are the two things a copy-paste between
//     them would bring across, and both would look like tidying up.
//
// REAL EVERYTHING, the harness the other dashboard suites use: the real
// production app (workers/site/src/index.ts's default export), so route
// registration, appendSlash, resolveLanguage, cacheTag and pageCacheControl
// are the shipped articles rather than a hand-built router; the real Nunjucks
// templates through the real render(), so the escaping and the <select> are
// the ones production emits; and real in-memory SQLite built by schemaFor()
// from the real migrations, so foodbank.last_need and
// foodbankchange.excess_change_text are nullable here exactly as they are in
// production. Mocked: the two KV namespaces, because there is no local double
// and nothing on this path touches them.
//
// PARITY CLAIMS BELOW WERE RUN, NOT REASONED. Every "Python does X" comment
// in this file was checked against the CPython 3 and Django 5.2.6 on this
// machine (`python3 -c ...`), because the ?days= parsing divergences are all
// of the form "both return a number, but not the same one".
//
// MUTATION-TESTED in a copy of the repo outside it -- see the note at the
// foot of this file.

const ORIGIN = "https://www.givefood.org.uk";
const PATH = "/dashboard/most-excess-items/";

// Tuesday 8 September 2026, 09:30 UTC. Chosen so the default 30-day window
// opens at 2026-08-09 09:30:00 -- a date whose day-of-month is smaller than
// today's, so an off-by-one month in the arithmetic could not coincidentally
// land on a plausible-looking value.
const NOW = new Date("2026-09-08T09:30:00.000Z");

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text AND the values bound to
// it. The binding is the load-bearing half -- the threshold is computed in the
// handler and appears nowhere in the SQL text or on the rendered page.
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
// Seeds. Only the columns this page reads are parameterised; every other
// column is whatever the real migration insists on, so a seeded row is one
// production would have accepted.
// ---------------------------------------------------------------------------

// The join is foodbank -> foodbankchange on latest_need_id, and the window is
// on foodbank.last_need, so the pairing has to be seeded explicitly rather
// than derived from the need's own `created`. last_need is stored in Django's
// shape -- "YYYY-MM-DD HH:MM:SS.ffffff", space-separated, six fractional
// digits -- because that is what the threshold string is compared against
// lexicographically (see migration 0022).
function seedFoodbank(id: number, lastNeed: string | null, latestNeedId: number | null): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, network,
       charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative,
       is_closed, no_locations, days_between_needs, latest_need_id, last_need, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79', ?,
       0, ?, ?, ?, 0, 0, 0, 14, ?, ?, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    id,
    String(id).padStart(32, "a"),
    `Foodbank ${id}`,
    `fb-${id}`,
    // Alternating networks, so a network filter copied over from
    // getLatestNeedTextsSince would drop rows here rather than being invisible.
    id % 2 === 0 ? "Independent" : "Trussell",
    `info@fb-${id}.invalid`,
    `https://fb-${id}.invalid/`,
    `https://fb-${id}.invalid/list/`,
    latestNeedId,
    lastNeed,
  );
}

// change_text is NOT NULL and is deliberately given a value this dashboard
// must never show: reading the wrong column is the single most likely way for
// this handler to be wrong, and "Beans" appearing in the table would otherwise
// look like data.
function seedNeed(id: number, excess: string | null): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text, published, input_method, created, modified)
     VALUES (?, ?, ?, 'NEED TEXT, NOT EXCESS', ?, 1, 'scrape', '2026-09-01 00:00:00.000000', '2026-09-01 00:00:00.000000')`,
  ).run(id, `need-${id}`, id, excess);
}

// One food bank with one need, positioned in the window by `lastNeed`. Ids are
// allocated together so a fixture reads as a list of (when, what) pairs.
let nextId = 0;
function seedPair(lastNeed: string, excess: string | null): number {
  nextId += 1;
  seedNeed(nextId, excess);
  seedFoodbank(nextId, lastNeed, nextId);
  return nextId;
}

// Descending last_need, one day apart, so the order rows arrive in is fixed
// and the Counter's first-seen order is a property of the fixture rather than
// of SQLite's scan order.
const DAY_BEFORE = (n: number) => `2026-09-0${8 - n} 10:00:00.000000`;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(schemaFor("foodbank", "foodbankchange"));
  prepared = [];
  sessions = 0;
  nextId = 0;
  // Date only: elapsedMs() reads performance.now(), which must stay real for
  // the debug comment's "Took Nms" to be a number at all.
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

// The only bound parameter of the only statement -- the threshold.
const boundThreshold = (): Bindable | undefined => prepared[0]?.params[0];

// ---------------------------------------------------------------------------
// Reading the rendered page. Everything below talks in item text and counts,
// never in HTML.
// ---------------------------------------------------------------------------

// [item, count] per row, with the cell text left EXACTLY as rendered -- not
// trimmed, not entity-decoded. Both of those would hide the two divergences
// this file exists to pin: an item that is the empty string, and an item with
// a carriage return still attached.
function itemRows(body: string): [string, string][] {
  const start = body.indexOf('<table class="table is-striped is-narrow is-fullwidth">');
  if (start === -1) throw new Error("no dashboard table in the rendered page");
  const table = body.slice(start, body.indexOf("</table>", start));
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => {
    const cells = [...(row[1] as string).matchAll(/<td>([\s\S]*?)<\/td>/g)].map((cell) => cell[1] as string);
    return [cells[0] as string, cells[1] as string];
  });
}

// The headline sentence, which carries all three of number_items,
// number_foodbanks and days.
function summary(body: string): string {
  const start = body.indexOf('<p class="is-pulled-left">');
  if (start === -1) throw new Error("no summary paragraph in the rendered page");
  return body.slice(start + '<p class="is-pulled-left">'.length, body.indexOf("</p>", start));
}

// Which of the six <option>s carries `selected` -- the page's own statement of
// which window it thinks it is showing.
function selectedDays(body: string): string | null {
  return body.match(/<option value="\?days=(\d+)" selected>/)?.[1] ?? null;
}

describe("gfdashMostExcessItems -- GET /dashboard/most-excess-items/", () => {
  // -------------------------------------------------------------------------
  // The ?days= gate and the threshold it produces. This is everything the
  // handler computes before it reads anything.
  // -------------------------------------------------------------------------

  // ONE SESSION, ONE STATEMENT, ONE BINDING. The threshold appears nowhere in
  // the SQL text and nowhere on the page except the "last 30 days" sentence,
  // so this is the only place the default window is visible as a value. The
  // session count is not decoration either: lib/session.ts opens exactly one
  // withSession("first-unconstrained") per request so a page's reads see one
  // consistent snapshot of a replicated database, and a handler that opened
  // its own would still render this page perfectly.
  it("defaults to a 30-day window, as the single bound parameter of a single statement", async () => {
    seedPair(DAY_BEFORE(1), "Rice");

    const body = await getBody(PATH);

    expect(sessions).toBe(1);
    expect(prepared).toHaveLength(1);
    expect(boundThreshold()).toBe("2026-08-09 09:30:00");
    expect(summary(body)).toContain("in the last 30 days");
    expect(selectedDays(body)).toBe("30");
    // Matched only far enough to prove the route reaches
    // getLatestExcessTextsSince rather than its near-identical sibling
    // getLatestNeedTextsSince, whose SELECT list is the other column.
    expect(prepared[0]?.sql).toContain("SELECT fc.excess_change_text");
  });

  // ALL SIX ALLOWED WINDOWS, each asserted as the threshold that reached the
  // engine. Django's `timezone.now() - timedelta(days=days)` uses fixed
  // 86,400-second days, and so does MS_PER_DAY here -- 365 days before
  // 2026-09-08 is 2025-09-08 because no leap day falls between them, which is
  // the arithmetic being pinned rather than a calendar subtraction.
  it.each([
    [7, "2026-09-01 09:30:00"],
    [30, "2026-08-09 09:30:00"],
    [60, "2026-07-10 09:30:00"],
    [90, "2026-06-10 09:30:00"],
    [120, "2026-05-11 09:30:00"],
    [365, "2025-09-08 09:30:00"],
  ])("accepts ?days=%i and asks for everything since %s", async (days, threshold) => {
    seedPair(DAY_BEFORE(1), "Rice");

    const body = await getBody(`${PATH}?days=${days}`);

    expect(boundThreshold()).toBe(threshold);
    expect(summary(body)).toContain(`in the last ${days} days`);
    expect(selectedDays(body)).toBe(String(days));
  });

  // THE THRESHOLD IS DJANGO-SHAPED TEXT, not an ISO string, and that is the
  // whole reason the comparison works. foodbank.last_need is TEXT compared
  // lexicographically, and "T" (0x54) sorts above every digit while " " (0x20)
  // sorts below them -- so an ISO threshold with its "T" intact would exclude
  // every same-day food bank and include none, silently, for exactly one day
  // per window. Migration 0022 exists because three stored rows had that shape.
  //
  // The fractional seconds being DROPPED is deliberate and matches the
  // sibling: a bare "YYYY-MM-DD HH:MM:SS" sorts correctly against a stored
  // ".ffffff" value, and truncating rather than rounding widens the window by
  // under a second. Both halves are pinned, including from a system time whose
  // milliseconds would round the second upward.
  it("binds a space-separated, whole-second timestamp with no fractional part", async () => {
    vi.setSystemTime(new Date("2026-09-08T09:30:00.999Z"));
    seedPair(DAY_BEFORE(1), "Rice");

    await get(PATH);

    expect(boundThreshold()).toBe("2026-08-09 09:30:00");
    expect(boundThreshold()).not.toContain("T");
    expect(boundThreshold()).not.toContain("Z");
    expect(boundThreshold()).not.toContain(".");
  });

  // THE CLOCK IS READ PER REQUEST. A threshold captured once at module load
  // would serve a window that silently freezes -- correct on the deploy day,
  // then a day staler with every day the isolate lives. Nothing on the page
  // would change.
  it("recomputes the window on every request rather than capturing it once", async () => {
    seedPair(DAY_BEFORE(1), "Rice");

    await get(PATH);
    expect(boundThreshold()).toBe("2026-08-09 09:30:00");

    prepared = [];
    vi.setSystemTime(new Date("2026-09-09T09:30:00.000Z"));
    await get(PATH);
    expect(boundThreshold()).toBe("2026-08-10 09:30:00");
  });

  // A DAY COUNT OFF THE LIST IS A BARE 403 -- Django's HttpResponseForbidden,
  // with an empty body. The query count is what makes this mean "the gate ran
  // BEFORE the read" rather than "the response was discarded": ?days=100000
  // against the real table is a full scan of foodbank, and the gate is what
  // stops an arbitrary URL asking for one.
  it.each(["1", "31", "0", "-30", "100000"])("refuses ?days=%s with an empty 403 and reads nothing", async (days) => {
    seedPair(DAY_BEFORE(1), "Rice");

    const res = await get(`${PATH}?days=${days}`);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    expect(prepared).toHaveLength(0);
    expect(sessions).toBe(0);
  });

  // A DIVERGENCE IN THE SAFE DIRECTION, PINNED SO IT STAYS ONE. Django's
  // `int(request.GET.get("days", 30))` raises ValueError on any of these,
  // which is an unhandled 500 (verified: python3 -c 'int("abc")' ->
  // ValueError, CPython 3 on this machine). `Number()` returns NaN instead,
  // NaN is not in ALLOWED_DAYS, and the request gets the same 403 a
  // disallowed number gets. `?days=` with no value is the one that actually
  // happens -- the <select> on this page emits "?days=N", but a hand-edited
  // or truncated URL produces the empty form.
  it.each(["abc", "", "Infinity", "NaN", "%D9%A3%D9%A0"])("turns the unparseable ?days=%s into a 403 rather than the 500 Django raises", async (days) => {
    seedPair(DAY_BEFORE(1), "Rice");

    const res = await get(`${PATH}?days=${days}`);

    expect(res.status).toBe(403);
    expect(prepared).toHaveLength(0);
  });

  // THE OTHER HALF OF THAT DIVERGENCE, AND IT IS NOT SAFE. `Number()` accepts
  // spellings `int()` rejects, so URLs Django answered with a 500 now render a
  // real 30-day page: "0x1E" is 30 in JavaScript and a ValueError in Python,
  // and so are "3e1" and "30.0" (all three verified against CPython 3 here).
  // Harmless in itself -- the window is one of the six allowed either way --
  // but it means this route's accepted input set is wider than the Django
  // original's, and the canonical number is what reaches the page.
  it.each(["0x1E", "3e1", "30.0", "%2030%20"])("accepts the JavaScript-only number ?days=%s as 30", async (days) => {
    seedPair(DAY_BEFORE(1), "Rice");

    const body = await getBody(`${PATH}?days=${days}`);

    expect(boundThreshold()).toBe("2026-08-09 09:30:00");
    // The template is handed the PARSED number, not the raw parameter, so the
    // page says "30 days" and the <select> agrees -- no unescaped "0x1E" is
    // reflected anywhere.
    expect(summary(body)).toContain("in the last 30 days");
    expect(selectedDays(body)).toBe("30");
    expect(body).not.toContain("0x1E");
  });

  // REPEATED PARAMETERS RESOLVE THE OPPOSITE WAY ROUND FROM DJANGO. Hono's
  // c.req.query() returns the FIRST value; Django's QueryDict.get() returns
  // the LAST (verified on this machine: Django 5.2.6, QueryDict("days=7&
  // days=365").get("days") == "365"). So the same URL gives a 7-day window
  // here and a 365-day one in the original -- a fifty-fold difference in what
  // the page reports, with no error either side. Only reachable by a
  // hand-built or doubled-up link, which is why it is pinned rather than
  // fixed: the behaviour is worth knowing about, and changing it is a
  // decision, not a tidy-up.
  it("takes the FIRST ?days= when it is repeated, where Django takes the last", async () => {
    seedPair(DAY_BEFORE(1), "Rice");

    const body = await getBody(`${PATH}?days=7&days=365`);

    expect(boundThreshold()).toBe("2026-09-01 09:30:00");
    expect(summary(body)).toContain("in the last 7 days");
  });

  // -------------------------------------------------------------------------
  // Counting. group_list() is a Counter over the flattened lines, and the two
  // headline numbers come from two different places.
  // -------------------------------------------------------------------------

  // THE WHOLE FIXTURE IN ONE ASSERTION. Read as a table:
  //
  //   fb1  "Rice\nPasta\nBeans"   three items, and the first-seen order
  //   fb2  "Pasta\nRice"          the cross-food-bank totals
  //   fb3  "Pasta\nBeans"         Pasta reaches 3; Rice and Beans tie on 2
  //   fb4  NULL                   contributes nothing AND is not counted
  //   fb5  ""                     the same, via the empty string
  //   fb6  outside the window     never read at all
  //
  // Sorting is `b.count - a.count` over an insertion-ordered Map, and
  // Array.prototype.sort has been stable since ES2019 -- so equal counts keep
  // FIRST-SEEN order, matching Python's `sorted(reverse=True, key=...)`. Rice
  // and Beans both finish on 2, and Rice is seen first (fb1's opening line),
  // so Rice must stay ahead of it. A sort that reversed the comparison, or one
  // that fell back to comparing the item text, reorders exactly those two rows
  // while leaving Pasta on top.
  it("counts items across food banks, most frequent first, ties in first-seen order", async () => {
    seedPair(DAY_BEFORE(1), "Rice\nPasta\nBeans");
    seedPair(DAY_BEFORE(2), "Pasta\nRice");
    seedPair(DAY_BEFORE(3), "Pasta\nBeans");
    seedPair(DAY_BEFORE(4), null);
    seedPair(DAY_BEFORE(5), "");
    seedPair("2026-07-01 10:00:00.000000", "Nappies\nNappies\nNappies\nNappies");

    const body = await getBody(PATH);

    expect(itemRows(body)).toEqual([
      ["Pasta", "3"],
      ["Rice", "2"],
      ["Beans", "2"],
    ]);
    // number_items is the DISTINCT count (itemsFreq.size) and number_foodbanks
    // counts only the food banks that CONTRIBUTED -- three of the five inside
    // the window. `items.length` would say 7 here and `rows.length` would say
    // 5, and both are the obvious wrong thing to reach for.
    expect(summary(body)).toBe("Found 3 excess items from 3 food bank organisations in the last 30 days.");
  });

  // THE TRUTHINESS GATE IS WHERE THIS DASHBOARD DIFFERS FROM ITS SIBLING.
  // Django's `if excess_text:` guards BOTH the item extend and the
  // `number_foodbanks += 1`, so a food bank with no excess text is not in the
  // denominator at all -- whereas most_requested_items increments its counter
  // for every row it sees. Moving this `+= 1` outside the `if` (which is what
  // the sibling looks like, and what a copy-paste between them produces)
  // leaves the table identical and inflates the headline: here it would read
  // 4 food banks instead of 1.
  it("excludes a food bank with no excess text from the food bank count, not just from the items", async () => {
    seedPair(DAY_BEFORE(1), "Rice");
    seedPair(DAY_BEFORE(2), null);
    seedPair(DAY_BEFORE(3), "");
    seedPair(DAY_BEFORE(4), null);

    expect(summary(await getBody(PATH))).toBe("Found 1 excess items from 1 food bank organisations in the last 30 days.");
  });

  // WHITESPACE IS TRUTHY IN BOTH LANGUAGES, so a food bank whose excess text
  // is a couple of spaces counts as a contributing food bank and puts a blank
  // row in the table. Faithful to Django (`if excess_text:` is falsy only for
  // "" and None) and pinned because a `.trim()` added to the guard would look
  // like an obvious improvement while quietly changing the denominator.
  it("treats whitespace-only excess text as real, producing a blank row", async () => {
    seedPair(DAY_BEFORE(1), "Rice");
    seedPair(DAY_BEFORE(2), "  ");

    const body = await getBody(PATH);

    expect(itemRows(body)).toEqual([
      ["Rice", "1"],
      ["  ", "1"],
    ]);
    expect(summary(body)).toContain("from 2 food bank organisations");
  });

  // NO INVALID-TEXT LIST HERE. mostRequestedItems.ts drops the three keyword
  // sentinels "Nothing", "Unknown" and "Facebook" before counting, because
  // views.py:83-143 does; most_excess_items (views.py:146-195) has no such
  // list, so the same words are ordinary items on this page. A shared helper
  // introduced across the two dashboards would silently delete these rows, and
  // "Nothing" is a plausible thing for a food bank to actually write in an
  // excess field.
  it("counts the words its sibling dashboard excludes -- Nothing, Unknown and Facebook", async () => {
    seedPair(DAY_BEFORE(1), "Nothing");
    seedPair(DAY_BEFORE(2), "Unknown");
    seedPair(DAY_BEFORE(3), "Facebook");

    const body = await getBody(PATH);

    expect(itemRows(body)).toEqual([
      ["Nothing", "1"],
      ["Unknown", "1"],
      ["Facebook", "1"],
    ]);
    expect(summary(body)).toContain("Found 3 excess items from 3 food bank organisations");
  });

  // A REPEAT WITHIN ONE FOOD BANK'S OWN TEXT COUNTS TWICE. Django extends a
  // flat list and Counts it, with no per-food-bank de-duplication, so a scrape
  // that picked up the same line twice inflates that item -- exactly as it
  // does in the original. Pinned because de-duplicating per row (a Set inside
  // the loop) is a tempting "fix" that changes the ranking on the real data.
  it("counts a line repeated within one food bank's text once per occurrence", async () => {
    seedPair(DAY_BEFORE(1), "Rice\nRice\nRice");
    seedPair(DAY_BEFORE(2), "Pasta");

    const body = await getBody(PATH);

    expect(itemRows(body)).toEqual([
      ["Rice", "3"],
      ["Pasta", "1"],
    ]);
    // Three occurrences, ONE distinct item, ONE contributing food bank.
    expect(summary(body)).toContain("Found 2 excess items from 2 food bank organisations");
  });

  // THE COLUMN. change_text is seeded with a sentinel on every row precisely
  // so that reading the wrong one of the two near-identical text columns is
  // loud rather than plausible -- getLatestNeedTextsSince and
  // getLatestExcessTextsSince differ only in their SELECT list.
  it("reads excess_change_text and never the need text beside it", async () => {
    seedPair(DAY_BEFORE(1), "Rice");

    const body = await getBody(PATH);

    expect(itemRows(body)).toEqual([["Rice", "1"]]);
    expect(body).not.toContain("NEED TEXT, NOT EXCESS");
  });

  // NO NETWORK FILTER. most_excess_items has no /trusselltrust/ variant, and
  // the fixture alternates Trussell and Independent so that a `f.network =
  // 'Trussell'` clause copied over from the sibling query would halve this
  // page rather than being invisible.
  it("includes every network, Trussell and independent alike", async () => {
    seedPair(DAY_BEFORE(1), "Rice"); // fb1 -- Trussell
    seedPair(DAY_BEFORE(2), "Pasta"); // fb2 -- Independent

    expect(itemRows(await getBody(PATH))).toEqual([
      ["Rice", "1"],
      ["Pasta", "1"],
    ]);
  });

  // A FOOD BANK INSIDE THE WINDOW WITH NO latest_need ROW. The query is an
  // INNER JOIN, so it never arrives; Django's `select_related("latest_need")`
  // on a nullable FK is a LEFT OUTER JOIN, and views.py:171 would then have
  // read `.excess_change_text` off None and raised AttributeError. Not
  // crashing is the improvement; what is pinned here is that it also does not
  // land in the denominator, because the truthiness gate would drop a NULL
  // excess text even if the join were widened. That makes this page's
  // behaviour DIFFERENT from its sibling's under the same data -- most
  // requested items counts every row it is handed -- which is why it is worth
  // a test of its own rather than being left to the shared query's suite.
  it("ignores a food bank whose latest_need_id is NULL or dangling, in both counts", async () => {
    seedPair(DAY_BEFORE(1), "Rice");
    seedNeed(90, "Orphaned excess text");
    seedFoodbank(91, DAY_BEFORE(2), null); // last_need set, no latest_need row
    seedFoodbank(92, DAY_BEFORE(3), 999_999); // last_need set, latest_need_id points nowhere

    const res = await get(PATH);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(itemRows(body)).toEqual([["Rice", "1"]]);
    expect(summary(body)).toBe("Found 1 excess items from 1 food bank organisations in the last 30 days.");
    // The orphaned need is reachable by id but nothing points at it, so it
    // must not appear either -- the join direction is food bank to need, not
    // the other way round.
    expect(body).not.toContain("Orphaned excess text");
  });

  // -------------------------------------------------------------------------
  // Two line-splitting divergences from Python, both pinned as-is and both
  // reported rather than fixed.
  // -------------------------------------------------------------------------

  // SUSPECT, PINNED AS-IS. Django splits with `str.splitlines()`; this port
  // uses `split("\n")`, which leaves the carriage return of a CRLF pair
  // attached to the end of every line but the last. Verified against CPython 3
  // on this machine: "Rice\r\nPasta".splitlines() == ["Rice", "Pasta"], where
  // "Rice\r\nPasta".split("\n") == ["Rice\r", "Pasta"].
  //
  // The consequence is invisible on the page -- a stray CR renders as nothing
  // -- so "Rice" and "Rice\r" appear as two identical-looking rows whose
  // counts have been split between them, and a genuinely popular item can be
  // pushed down the table by a food bank whose textarea submitted CRLF. This
  // is not hypothetical for this schema: foodbank.address is CRLF-separated in
  // 1,066 of 1,071 production rows (migration 0001's own comment), and the
  // same web forms feed excess_change_text.
  it("leaves a carriage return attached, splitting one item into two rows", async () => {
    seedPair(DAY_BEFORE(1), "Rice\r\nPasta");
    seedPair(DAY_BEFORE(2), "Rice\nPasta");

    const body = await getBody(PATH);

    // Three rows, not two, and the two "Rice" rows are indistinguishable to a
    // reader -- which is why the assertion is on the raw cell text. Pasta,
    // being last on both lines, has no CR on it and correctly totals 2, so the
    // page shows one item ahead of another that is really just as popular.
    expect(itemRows(body)).toEqual([
      ["Pasta", "2"],
      ["Rice\r", "1"],
      ["Rice", "1"],
    ]);
    expect(summary(body)).toContain("Found 3 excess items");
  });

  // SUSPECT, PINNED AS-IS, and the same root cause. Python's splitlines()
  // discards a single trailing terminator ("Beans\n".splitlines() == ["Beans"]
  // -- verified against CPython 3 here); split("\n") yields a trailing empty
  // string, which becomes an ITEM. It is counted in number_items, it gets its
  // own <td></td> row in the table, and because the empty string recurs across
  // every food bank whose text ends in a newline it accumulates a high count
  // and sorts near the TOP of the page. An empty first row of a "most excess
  // items" table is the visible symptom; nothing logs it.
  it("counts the empty string after a trailing newline as an item of its own", async () => {
    seedPair(DAY_BEFORE(1), "Rice\n");
    seedPair(DAY_BEFORE(2), "Pasta\n");
    seedPair(DAY_BEFORE(3), "Beans\n");

    const body = await getBody(PATH);

    expect(itemRows(body)).toEqual([
      ["", "3"],
      ["Rice", "1"],
      ["Pasta", "1"],
      ["Beans", "1"],
    ]);
    // Four distinct "items" from three food banks that between them named
    // three real things.
    expect(summary(body)).toBe("Found 4 excess items from 3 food bank organisations in the last 30 days.");
  });

  // The OTHER separators Python's splitlines() recognises and split("\n") does
  // not -- a lone \r, \v, \f, \x1c-\x1e, U+2028 and U+2029 -- stay inside the
  // item
  // text here, so an old-Mac-style "\r"-separated excess field arrives as ONE
  // long item rather than several. Same family as the two above; pinned in one
  // test because the fix, if there ever is one, is a single shared helper.
  it("does not split on a lone carriage return at all", async () => {
    seedPair(DAY_BEFORE(1), "Rice\rPasta\rBeans");

    expect(itemRows(await getBody(PATH))).toEqual([["Rice\rPasta\rBeans", "1"]]);
  });

  // -------------------------------------------------------------------------
  // Rendering, and the page around the data.
  // -------------------------------------------------------------------------

  // ITEM TEXT IS FOOD BANK-SUPPLIED and reaches the page through nunjucks'
  // autoescape. This is scraped and volunteer-typed text, so the angle
  // brackets are the realistic case rather than a contrived one, and the
  // template writes it with a bare {{ }} -- one `| safe` added there would be
  // stored XSS on a public page.
  it("escapes item text rather than trusting it", async () => {
    seedPair(DAY_BEFORE(1), 'Tinned <b>"tomatoes"</b> & rice');

    const body = await getBody(PATH);

    expect(itemRows(body)).toEqual([["Tinned &lt;b&gt;&quot;tomatoes&quot;&lt;/b&gt; &amp; rice", "1"]]);
    expect(body).not.toContain("<b>");
  });

  // AN EMPTY WINDOW IS A 200 WITH ZEROES, not a 500 and not an empty page.
  // Both counters have to survive the empty case independently: `number_items`
  // comes from a Map's size and `number_foodbanks` from a counter that was
  // never incremented, and the `<select>` still has to render so a visitor can
  // widen the window from a page that showed them nothing.
  it("renders zeroes and an empty table when nothing falls inside the window", async () => {
    seedPair("2026-01-01 10:00:00.000000", "Rice"); // long outside the 30-day window

    const res = await get(PATH);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(itemRows(body)).toEqual([]);
    expect(summary(body)).toBe("Found 0 excess items from 0 food bank organisations in the last 30 days.");
    expect(body).toContain('<option value="?days=365">365 days</option>');
  });

  // The six windows the page offers must be the six the gate accepts -- they
  // are the same ALLOWED_DAYS array, and this is what notices if the template
  // is ever handed a hard-coded list instead. Every one of these links is a
  // URL a visitor can click; a value in the <select> that the gate refuses is
  // a 403 from the page's own dropdown.
  it("offers exactly the six windows it accepts, as ?days= links", async () => {
    seedPair(DAY_BEFORE(1), "Rice");
    const body = await getBody(PATH);

    expect([...body.matchAll(/<option value="\?days=(\d+)"/g)].map((m) => m[1])).toEqual(["7", "30", "60", "90", "120", "365"]);
  });

  // A DELIBERATE DIVERGENCE, PINNED SO IT STAYS DELIBERATE. Django's
  // most_excess_items carries @cache_page(SECONDS_IN_DAY);
  // middleware/pageCacheControl.ts gives everything outside its named families
  // a day at the edge and five minutes in the browser, which matches here.
  // The page is given no Cache-Tag (middleware/cacheTag.ts has no rule for
  // /dashboard/), so queues/cachePurge.ts cannot shorten that when a need is
  // re-scraped: this page is stale-until-TTL by design.
  it("serves cacheable, untagged HTML in English", async () => {
    seedPair(DAY_BEFORE(1), "Rice");
    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // THE 403 MUST NOT BE CACHED. pageCacheControl only stamps a 200, so the
  // refusal carries no Cache-Control at all -- which matters because the
  // shared cache keys on the full URL including ?days=, and a cached 403 for a
  // URL somebody once mistyped is harmless while a cached 200 under a refused
  // window would not be. Django's @cache_page behaves the same way (its
  // UpdateCacheMiddleware stores only 200s).
  it("does not attach a caching header to the 403", async () => {
    const res = await get(`${PATH}?days=5`);

    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  // buildPageContext + elapsedMs, the two halves of pageContext(). The debug
  // comment in includes/debugcomment.njk is the only consumer of
  // render_time_ms, and with the key missing it renders "Took ms" -- a page
  // that still looks perfect. `Took \d+` also pins the whole-millisecond
  // rounding elapsedMs() does deliberately.
  it("puts the canonical URL, the flag link and a numeric render time on the page", async () => {
    seedPair(DAY_BEFORE(1), "Rice");
    const body = await getBody(PATH);

    expect(body).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
    expect(body).toContain(`<a href="/flag/#${ORIGIN}${PATH}"`);
    expect(body).toMatch(/⏱️ Took \d+ms/);
    expect(body).toContain("<title>Most Excess Items - Give Food</title>");
    // The breadcrumb is how a visitor gets back to the dashboard index, and
    // url('dash:most_excess_items') resolving to the wrong entry would produce
    // a page that links to a sibling dashboard as though it were itself.
    expect(body).toContain(`<li class="is-active"><a href="${PATH}" aria-current="page">Most Excess Items</a></li>`);
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block, outside
  // i18n_patterns -- so there is no /cy/dashboard/... URL, and the page
  // advertises no hreflang alternates (buildPageContext is called without a
  // locale, which is what leaves `languages` empty). A route registered under
  // the LOCALES loop by mistake would 200 here.
  it("has no language-prefixed form and offers no translations", async () => {
    seedPair(DAY_BEFORE(1), "Rice");

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
    seedPair(DAY_BEFORE(1), "Rice");

    const res = await get(PATH, { method: "POST" });

    expect(res.status).toBe(404);
    expect(prepared).toHaveLength(0);
    expect(sessions).toBe(0);
  });

  // Django's APPEND_SLASH, via lib/appendSlash.ts. Worth pinning because
  // gfdash/urls.py registers this path WITH the slash and every inbound link
  // uses it, so the unslashed form only ever arrives hand-typed -- and the
  // redirect preserves the querystring, without which a visitor who typed the
  // URL with a ?days= would be silently returned to the default window.
  it("301s the unslashed URL onto the canonical one, keeping ?days=", async () => {
    seedPair(DAY_BEFORE(1), "Rice");

    const bare = await get("/dashboard/most-excess-items");
    expect(bare.status).toBe(301);
    expect(bare.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);

    const withQuery = await get("/dashboard/most-excess-items?days=365");
    expect(withQuery.status).toBe(301);
    expect(withQuery.headers.get("Location")).toBe(`${ORIGIN}${PATH}?days=365`);
  });

  // The querystring is dropped from `flag_path` because pageContext() passes
  // only `c.req.path` to buildPageContext (no `querystring`), unlike the
  // routes that do -- so a visitor reporting a problem with the 365-day view
  // reports it against the default view's URL. Pinned rather than filed: every
  // other gfdash handler is written the same way, and the ?days= is still
  // honoured by the page itself, which is the half that matters.
  it("honours ?days= while leaving it out of the flag link", async () => {
    seedPair(DAY_BEFORE(1), "Rice");

    const body = await getBody(`${PATH}?days=365`);

    expect(summary(body)).toContain("in the last 365 days");
    expect(body).toContain(`<a href="/flag/#${ORIGIN}${PATH}"`);
    expect(body).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
  });
});

// ===========================================================================
// MUTATION TESTING, run in a copy of this repo under the scratchpad -- never
// against a source file in the working tree. Each mutant was applied alone and
// this file re-run; the count is how many of the 45 test cases above went red.
//
// In mostExcessItems.ts itself:
//   `days * MS_PER_DAY` -> `(days + 1) * MS_PER_DAY`        14 failed
//   MS_PER_DAY 86_400_000 -> 86_400                         26 failed
//   `now.getTime() - ...` -> `now.getTime() + ...`          26 failed
//   `.slice(0, 19)` -> `.slice(0, 23)`                      14 failed
//   `.replace("T", " ")` dropped                            14 failed
//   `new Date()` -> a module-level constant                  1 failed (the
//                                                            per-request clock
//                                                            test, which exists
//                                                            for exactly this)
//   DEFAULT_DAYS 30 -> 7                                     8 failed
//   ALLOWED_DAYS loses 365                                   4 failed
//   the `!ALLOWED_DAYS.includes(days)` gate removed         11 failed
//   `Number(daysParam)` -> `parseInt(daysParam, 10)`         2 failed
//   `c.req.query("days")` -> `queries("days")?.at(-1)`       1 failed (Django's
//                                                            own spelling, and
//                                                            only the repeated-
//                                                            parameter test
//                                                            sees it)
//   403 -> 404                                              11 failed
//   the 403 body "" -> "Forbidden"                           5 failed
//   `if (row.excess_change_text)` dropped                    2 failed
//   that guard given a `.trim()`                             1 failed
//   `numberFoodbanks += 1` moved outside that guard          2 failed
//   `.split("\n")` -> `.split(/\r?\n/)`                      1 failed (the CR
//                                                            divergence test,
//                                                            which is the only
//                                                            thing standing
//                                                            between that
//                                                            "fix" and a
//                                                            silent change to
//                                                            the rankings)
//   `.split("\n")` -> `.split("\n").filter(Boolean)`          1 failed
//   items deduplicated per food bank (a Set in the loop)     1 failed
//   `b.count - a.count` -> `a.count - b.count`               4 failed
//   ties broken alphabetically as well as by count           6 failed
//   the sort dropped entirely                                3 failed
//   `number_items: itemsFreq.size` -> `items.length`         4 failed
//   `number_foodbanks: numberFoodbanks` -> `rows.length`     2 failed
//   context key `items_sorted` -> `items`                   11 failed
//   context `days` -> `days: DEFAULT_DAYS`                   7 failed
//   `allowed_days` hard-coded to [7, 30, 60]                 5 failed
//   `render_time_ms` dropped from pageContext()              1 failed
//   template -> "dash/most_requested_items.njk"              9 failed
//   a second `dbSession(c)` per request                      1 failed
//   buildPageContext given c.req.url instead of c.req.path   3 failed
//
// In index.ts:
//   this route's app.get() -> app.all()                      1 failed
//
// In the shared query (packages/db/src/dashboards.ts), to prove the excluded
// fixture rows above are doing work rather than sitting there:
//   `fc.excess_change_text` -> `fc.change_text`             13 failed
//   `AND f.network = 'Trussell'` added                       7 failed
//   ORDER BY f.last_need DESC -> ASC                         6 failed
//   `WHERE f.last_need > ?` -> `>=`                          0 failed  <-- below
//   `JOIN foodbankchange` -> `LEFT JOIN`                     0 failed  <-- below
//
// In dash/most_excess_items.njk. THE .njk IS NOT WHAT RENDERS: env.ts loads
// src/generated/precompiled.js, so each of these was applied AND
// scripts/precompile.ts re-run before the suite. Editing the template alone
// changes nothing, and a template mutant that "survives" without that step has
// not been tested at all -- which is how the first pass of this table read
// until the precompile was added.
//   `{% if allowed_day == days %} selected{% endif %}` gone 11 failed
//   `{{ item.count }}` -> a literal 1                        4 failed
//   number_items and number_foodbanks swapped                2 failed
//   `{{ item.item }}` -> `{{ item.item | safe }}`            1 failed
//
// TWO SURVIVORS, recorded rather than papered over:
//
//   `>` -> `>=` on the window boundary changes nothing here, because a fixture
//   would have to store a last_need byte-equal to a clock-derived threshold to
//   tell them apart. That case belongs to packages/db/src/dashboards.test.ts,
//   which passes a literal threshold and seeds exactly on it ("excludes a
//   last_need exactly equal to the threshold"); reproducing it here would mean
//   freezing the clock to a value the fixture also hard-codes, which tests the
//   fixture rather than the port.
//
//   `JOIN` -> `LEFT JOIN` is an EQUIVALENT MUTANT for this page specifically,
//   and that is worth understanding rather than filing as a gap: the phantom
//   row a LEFT JOIN produces for a food bank with no latest_need carries a
//   NULL excess_change_text, which `if (row.excess_change_text)` drops -- so
//   neither the table nor either counter moves. The same mutant in the sibling
//   query is NOT equivalent (most_requested_items counts every row it is
//   handed, so its "N food banks" figure would inflate), and it is killed by
//   packages/db/src/dashboards.test.ts's own copy of the case. The test above
//   named "ignores a food bank whose latest_need_id is NULL or dangling" pins
//   the behaviour for this page from both directions even though it cannot
//   distinguish the two joins.
