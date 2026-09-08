import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import { getFoodbankForCharityCrawl, type CharityCrawlFoodbankRow, type Session } from "@givefood/db";
import type { Env } from "../../worker-configuration";
import { crawlOpenCharities } from "./crawlOpenCharities";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning,
// as packages/db/src/schema.testkit.ts:35 and queues/charity.test.ts:12.
import { DatabaseSync } from "node:sqlite";

// crawlOpenCharities -- the ONE crawler behind all three charity queues
// (charity-ew / charity-scotland / charity-ni; charityEw.ts, charityScotland.ts
// and charityNi.ts each do `makeCharityQueueHandler(label, crawlOpenCharities)`
// and nothing else). It is the only writer of the eight charity_* columns on
// foodbank and of every row in charityyear.
//
// WHY THIS FILE IS WORTH THE LENGTH. This runs unattended once a night across
// 831 food banks and nobody reads its output. Every failure mode it has is
// silent by construction:
//
//   * a WRONG FIELD is invisible -- the food bank page still renders, it just
//     shows another register's text in the wrong box. The three registers
//     publish different things under similar names (`purposes` means the
//     categorised list in Scotland and the objects text in Northern Ireland),
//     which is exactly the mistake a single fallback chain would make and the
//     module's own header warns about;
//   * a BLANKED field is invisible -- a 200 carrying a shape this code did not
//     expect patches NULL over data that was correct yesterday, and the page
//     simply stops showing a website or a registration date;
//   * a WRONG URL is invisible -- opencharities answers 404 for a number that
//     never existed exactly as it does for one that has moved, and the module
//     deliberately swallows both.
//
// So every test below reads the ROW BACK out of SQLite, or asserts the exact
// URL/log line. Nothing here asserts that a promise resolved.
//
// REAL THINGS, NOT MOCKS:
//   * node:sqlite carrying the WHOLE real migration set (MIGRATIONS_SQL), so
//     the columns being patched are the columns the database actually has --
//     a hand-written fixture would test this file's memory of the schema;
//   * the real patchFoodbankCharity / replaceCharityYears, reached through the
//     module itself, and the real getFoodbankForCharityCrawl to BUILD the input
//     row rather than hand-rolling a `CharityCrawlFoodbankRow` literal, so a
//     column rename in packages/db surfaces here instead of quietly passing.
//
// MOCKED, and only this: `fetch`. opencharities.uk is the one thing that leaves
// the machine.
//
// PARITY. The Django this replaces is
// /Users/jasoncartwright/Sites/foodcharity/givefood/utils/crawlers.py --
// `foodbank_charity_crawl` (:79-101), `_crawl_charity_ew` (:104-169),
// `_crawl_charity_scotland` (:172-227) and `_crawl_charity_ni` (:230-278), plus
// `Foodbank.open_charities_url` (givefood/models/foodbank.py:339-348). All read
// directly for every claim below. The ONE claim that needed an interpreter --
// NI's `re.sub(r",(?!\s)", "\n", ...)` at crawlers.py:269 -- was run on the
// CPython on this machine (3.13.0): `re.sub(r',(?!\s)', '\n', 'a, b,c')` is
// `'a, b\nc'`, which is NOT what toLines() produces. See the NI block.
//
// The module's header cites a verification of 80 real food banks against the
// live regulator APIs. Nothing here re-runs that -- these are fixtures, not
// production data -- and no test below claims otherwise.

// ===========================================================================
// HARNESS -- lifted from queues/charity.test.ts, which drives this same module
// through the queue consumer; same session double, same reasoning.
// ===========================================================================

type Bindable = null | number | bigint | string | Uint8Array;

interface SqliteStatement {
  all(...params: Bindable[]): Record<string, unknown>[];
  get(...params: Bindable[]): Record<string, unknown> | undefined;
  run(...params: Bindable[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

let db: SqliteDatabase;

/**
 * The one SQL pattern that should blow up on the next statement matching it,
 * standing in for a D1 outage mid-crawl. The module makes TWO independent
 * writes with no transaction around them, so which of the two fails decides
 * what the food bank is left holding -- that is only observable with a way to
 * break one and not the other.
 */
let failOn: RegExp | null = null;

/**
 * The D1 Sessions API surface packages/db uses, carried to the real engine. A
 * session answering canned rows would be a second implementation of the very
 * UPDATE and batch under test.
 */
function d1Session(): unknown {
  function statement(sql: string, params: Bindable[]): unknown {
    const guard = (): void => {
      if (failOn?.test(sql)) throw new Error("D1_ERROR: Network connection lost");
    };
    return {
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T>() => {
        guard();
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      all: async <T>() => {
        guard();
        return { results: db.prepare(sql).all(...params) as T[] };
      },
      run: async () => {
        guard();
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
      const out: unknown[] = [];
      for (const each of statements) out.push(await each.all());
      return out;
    },
    getBookmark: () => null,
  };
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | null | undefined;
  /**
   * The WHOLE init, so the request's shape is assertable and not just its URL.
   * opencharities.uk serves a static JSON document; a `method` or a `body`
   * appearing here is a route it does not have, and the module's own non-200
   * branch would then log a 405 for every food bank in the country while
   * looking exactly like a missing charity number.
   */
  init: RequestInit;
}

/** A modelled reply. An Error means the fetch itself rejected -- DNS, TLS, or the abort firing. */
type Reply = { status: number; body: string } | Error;

let fetchCalls: FetchCall[];
let reply: Reply;
let session: Session;
let env: Env;
let logs: string[];
let errors: string[][];

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write: a SPACE separator, six fractional
// digits, never a "T" and never a "Z". last_charity_check and charityyear.created
// are TEXT and SQLite compares TEXT bytewise, so an ISO value here sorts after
// every same-day Django one -- see pyDatetime.ts's header for the two production
// incidents that came of exactly that.
const DJANGO_NOW = "2026-09-05 19:28:08.853000";
const NOW = new Date("2026-09-05T19:28:08.853Z");

const SALISBURY = 22;
const DUNDEE = 23;

interface FoodbankSeed {
  id?: number;
  slug?: string;
  name?: string;
  country?: string;
  charity_number?: string | null;
  charity_id?: string | null;
  charity_name?: string | null;
  charity_type?: string | null;
  charity_reg_date?: string | null;
  charity_postcode?: string | null;
  charity_website?: string | null;
  charity_purpose?: string | null;
  charity_objectives?: string | null;
}

/**
 * A food bank with EVERY charity column already populated. The defaults matter:
 * a crawl that blanks a column is only visible if the column had something in
 * it to begin with, and "the register stopped publishing X" is the single most
 * common way this job does damage.
 */
function seedFoodbank(seed: FoodbankSeed = {}): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_number, charity_just_foodbank, charity_id, charity_name, charity_type,
       charity_reg_date, charity_postcode, charity_website, charity_purpose, charity_objectives,
       contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs, created, modified
     ) VALUES (?, ?, ?, ?, '1 Bemerton Heath', 'SP2 9DY', ?, '51.0688,-1.7945', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'info@example.test', 'https://example.test/', 'https://example.test/need/', 0, 0, 0, 14, ?, ?)`,
  ).run(
    seed.id ?? SALISBURY,
    `uuid-${seed.slug ?? "salisbury"}`,
    seed.name ?? "Salisbury Foodbank",
    seed.slug ?? "salisbury",
    seed.country ?? "England",
    seed.charity_number === undefined ? "1122447" : seed.charity_number,
    seed.charity_id === undefined ? "ORG-1122447" : seed.charity_id,
    seed.charity_name === undefined ? "OLD NAME" : seed.charity_name,
    seed.charity_type === undefined ? "OLD TYPE" : seed.charity_type,
    seed.charity_reg_date === undefined ? "1999-01-01" : seed.charity_reg_date,
    seed.charity_postcode === undefined ? "OLD 1PC" : seed.charity_postcode,
    seed.charity_website === undefined ? "https://old.example" : seed.charity_website,
    seed.charity_purpose === undefined ? "OLD PURPOSE" : seed.charity_purpose,
    seed.charity_objectives === undefined ? "OLD OBJECTIVES" : seed.charity_objectives,
    DJANGO_NOW,
    DJANGO_NOW,
  );
}

function foodbankRow(id = SALISBURY): Record<string, unknown> {
  return db.prepare("SELECT * FROM foodbank WHERE id = ?").get(id) as Record<string, unknown>;
}

interface YearRow {
  date: string;
  income: number;
  expenditure: number;
  created: string;
}

/** Ordered by id, i.e. insertion order, so the ORDER the module writes them in is observable. */
function charityYears(foodbankId = SALISBURY): YearRow[] {
  return db.prepare("SELECT date, income, expenditure, created FROM charityyear WHERE foodbank_id = ? ORDER BY id").all(foodbankId) as unknown as YearRow[];
}

function seedCharityYear(foodbankId: number, date: string, income = 1, expenditure = 2): void {
  db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, ?, ?, ?, ?)").run(foodbankId, date, income, expenditure, "2020-01-01 00:00:00.000000");
}

/** Set the reply to a 200 carrying this JSON body -- the shape opencharities returns. */
function ok(body: unknown): void {
  reply = { status: 200, body: JSON.stringify(body) };
}

/**
 * The production call, with the input row READ BACK OUT OF D1 rather than
 * hand-built: queues/charity.ts hands this function whatever
 * getFoodbankForCharityCrawl returned, so building the literal here would let a
 * column rename pass unnoticed on both sides.
 */
async function crawl(foodbankId = SALISBURY): Promise<void> {
  const row = await getFoodbankForCharityCrawl(session, foodbankId);
  if (!row) throw new Error(`test fixture: no foodbank ${foodbankId}`);
  await crawlOpenCharities(env, session, row);
}

beforeEach(() => {
  // Date only, not setTimeout: the module arms a real AbortSignal.timeout(20_000)
  // and faking the clock underneath it buys nothing. Freezing Date is what makes
  // the exact last_charity_check / charityyear.created assertions possible.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(MIGRATIONS_SQL);

  failOn = null;
  fetchCalls = [];
  reply = { status: 200, body: "null" };
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String)));

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    fetchCalls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, signal: init.signal, init });
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, { status: reply.status });
  });

  session = d1Session() as Session;
  // The crawler takes `env` but touches no binding on it -- it writes through
  // the session it is handed, which is the queue consumer's read-your-writes
  // one. An empty object is therefore the honest fixture, and it is also the
  // assertion: if this file ever starts reaching for env.DB, every test here
  // fails at once rather than the crawl silently landing on a stale replica.
  env = {} as Env;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

// ===========================================================================
// WHICH REGISTER, AND WHICH URL
// ===========================================================================
describe("choosing a register", () => {
  // COUNTRY_CODE is crawlers.py:94-101's country branch. Getting one of these
  // wrong asks opencharities for a number that exists in ANOTHER register --
  // which mostly 404s, but "SC012345" under /ew/ is a plausible-looking request
  // that would simply return someone else's charity if it ever resolved.
  it.each([
    ["England", "https://opencharities.uk/ew/1122447.json"],
    ["Wales", "https://opencharities.uk/ew/1122447.json"],
    ["Scotland", "https://opencharities.uk/sc/1122447.json"],
    ["Northern Ireland", "https://opencharities.uk/ni/1122447.json"],
  ])("sends %s to %s", async (country, url) => {
    seedFoodbank({ country });

    await crawl();

    expect(fetchCalls.map((call) => call.url)).toEqual([url]);
  });

  // models/foodbank.py:339-348's open_charities_url() strips "NIC" for Northern
  // Ireland (the strip itself is :346) because the register's own numbers carry
  // no prefix. Both spellings are in production data, so both have to reach the
  // same URL.
  it("strips the NIC prefix for Northern Ireland", async () => {
    seedFoodbank({ country: "Northern Ireland", charity_number: "NIC101234" });

    await crawl();

    expect(fetchCalls[0]!.url).toBe("https://opencharities.uk/ni/101234.json");
  });

  it("leaves an unprefixed Northern Irish number alone", async () => {
    seedFoodbank({ country: "Northern Ireland", charity_number: "101234" });

    await crawl();

    expect(fetchCalls[0]!.url).toBe("https://opencharities.uk/ni/101234.json");
  });

  // A DIVERGENCE FROM DJANGO, pinned as the port behaves. JavaScript's
  // `String.replace(string, ...)` replaces the FIRST occurrence only and is not
  // anchored to the start; Python's `str.replace` with no count strips EVERY
  // occurrence, so crawlers.py:236 turns "NICNIC123" into "123" where this turns
  // it into "NIC123" -- run on this machine's CPython 3.13.0, not reasoned about.
  // Harmless today: NI charity numbers carry at most one NIC prefix, so no real
  // row reaches the difference. Reported, not fixed here.
  it("strips only the first NIC, wherever it appears", async () => {
    seedFoodbank({ country: "Northern Ireland", charity_number: "NICNIC123" });

    await crawl();

    expect(fetchCalls[0]!.url).toBe("https://opencharities.uk/ni/NIC123.json");
  });

  // Case-sensitive, exactly as Django's `.replace("NIC","")` is -- CPython 3.13.0
  // on this machine leaves 'nic101234' untouched too.
  it("does not strip a lowercase nic prefix", async () => {
    seedFoodbank({ country: "Northern Ireland", charity_number: "nic101234" });

    await crawl();

    expect(fetchCalls[0]!.url).toBe("https://opencharities.uk/ni/nic101234.json");
  });

  // The E&W and Scottish branches must NOT strip. "NIC" cannot begin an E&W
  // number, but a crawler that stripped unconditionally would be invisible
  // until it did.
  it("does not strip NIC for the other registers", async () => {
    seedFoodbank({ country: "Scotland", charity_number: "NIC999" });

    await crawl();

    expect(fetchCalls[0]!.url).toBe("https://opencharities.uk/sc/NIC999.json");
  });

  // encodeURIComponent, not raw interpolation. charity_number is admin-entered
  // free text: a stray slash would otherwise walk out of the register's path
  // segment and hit a completely different endpoint on opencharities.uk.
  it("percent-encodes a charity number that would escape the path segment", async () => {
    seedFoodbank({ charity_number: "../ni/999" });

    await crawl();

    expect(fetchCalls[0]!.url).toBe("https://opencharities.uk/ew/..%2Fni%2F999.json");
  });

  it("percent-encodes a space in a charity number", async () => {
    seedFoodbank({ charity_number: "112 2447" });

    await crawl();

    expect(fetchCalls[0]!.url).toBe("https://opencharities.uk/ew/112%202447.json");
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // charity_number is NULLABLE in D1 (0001_core.sql:20) even though
  // CharityCrawlFoodbankRow types it `string`, so this row is reachable. Django
  // guards at crawlers.py:89-90 (`if not foodbank.charity_number: return False`);
  // this module has no such guard and builds ".../ew/.json", one useless request
  // per night per such food bank. The nightly cron filters them out
  // (getFoodbanksByCountryForCharityCrawl requires a non-empty number), so today
  // only a manual enqueue -- or an admin clearing the number inside the drain
  // window -- reaches it.
  it("fetches a numberless URL for a food bank with no charity number, unlike Django", async () => {
    seedFoodbank({ charity_number: null });

    await crawl();

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ew/.json"]);
  });

  // The Isle of Man's single food bank matches no branch in Django either
  // (crawlers.py:100-101 returns False) and opencharities has no Manx register.
  // The important half is the second assertion: nothing is patched, so an
  // unroutable country never blanks the columns an admin typed in by hand.
  it("makes no request and writes nothing for a country with no register", async () => {
    seedFoodbank({ country: "Isle of Man" });

    await crawl();

    expect(fetchCalls).toEqual([]);
    expect(logs).toEqual(["charity: no register for country Isle of Man (salisbury)"]);
    const row = foodbankRow();
    expect(row.charity_name).toBe("OLD NAME");
    expect(row.charity_website).toBe("https://old.example");
    // Not even the timestamp: an unroutable food bank never looks freshly checked.
    expect(row.last_charity_check).toBeNull();
  });

  // Case-sensitive lookup, same as Django's `country in ["England", "Wales"]`.
  // The admin form is a free-text field, so a "england" or "ENGLAND" row would
  // silently never be crawled again -- pinned so that is a known cost.
  it("does not match a country in the wrong case", async () => {
    seedFoodbank({ country: "england" });

    await crawl();

    expect(fetchCalls).toEqual([]);
    expect(logs).toEqual(["charity: no register for country england (salisbury)"]);
  });

  it("does not match a country with surrounding whitespace", async () => {
    seedFoodbank({ country: " Scotland" });

    await crawl();

    expect(fetchCalls).toEqual([]);
    expect(logs).toEqual(["charity: no register for country  Scotland (salisbury)"]);
  });

  it("treats an empty country as no register", async () => {
    seedFoodbank({ country: "" });

    await crawl();

    expect(fetchCalls).toEqual([]);
    expect(logs).toEqual(["charity: no register for country  (salisbury)"]);
  });

  // `foodbank.country ?? ""` is defensive only: foodbank.country is NOT NULL in
  // D1 (0001_core.sql:15), so this row cannot come out of getFoodbankForCharityCrawl.
  // Pinned anyway because the log line is what a human would search for, and
  // "country null" reads very differently from "country undefined".
  it("survives a null country, which the schema makes unreachable", async () => {
    seedFoodbank();
    const row = { ...(await getFoodbankForCharityCrawl(session, SALISBURY))!, country: null } as unknown as CharityCrawlFoodbankRow;

    await crawlOpenCharities(env, session, row);

    expect(fetchCalls).toEqual([]);
    expect(logs).toEqual(["charity: no register for country null (salisbury)"]);
  });
});

// ===========================================================================
// THE REQUEST ITSELF
// ===========================================================================
describe("the request", () => {
  beforeEach(() => {
    seedFoodbank();
  });

  // opencharities.uk is one small independent site now carrying every country's
  // charity data (the module's own "IT IS A MIRROR, NOT THE REGISTER" note), so
  // identifying the bot honestly is what keeps 831 nightly requests welcome. The
  // contact URL is the part that matters -- an operator who wants this stopped
  // needs somewhere to go that is not a block rule.
  it("identifies itself with the contactable bot user agent", async () => {
    await crawl();

    expect(fetchCalls[0]!.headers).toEqual({
      "User-Agent": "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)",
    });
  });

  // No API key of any kind, which is the whole point of the switch: EW_CHARITY_KEY
  // and SCOT_CHARITY_KEY were dropped from wrangler.jsonc's secrets.required. A
  // header reappearing here would mean a secret is being read that deployment no
  // longer provides.
  it("sends no authentication header", async () => {
    await crawl();

    expect(Object.keys(fetchCalls[0]!.headers)).toEqual(["User-Agent"]);
  });

  // Asserted through AbortSignal.timeout's argument rather than by waiting one
  // out: the signal is armed by node's internal timer, not a fakeable global.
  // Without the bound, a server that accepts the connection and never answers
  // holds a queue consumer open until the Worker's own limit kills it -- and 831
  // messages behind it wait at max_concurrency 10.
  it("bounds the fetch at 20 seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await crawl();

    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(fetchCalls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(fetchCalls[0]!.signal!.aborted).toBe(false);
  });

  // One GET per food bank, replacing 3 (E&W), 2 (Scotland) or 1 (NI) against
  // three different hosts -- the module header's ~2,354 requests down to 831.
  // A second fetch appearing here is that saving quietly going away.
  //
  // Asserted as the URL LIST rather than a length, because a length says
  // nothing about WHICH request was made: a mutant that fetched the overview
  // endpoint instead would keep the count at one.
  it("makes exactly one request per crawl", async () => {
    ok({ name: "Salisbury Foodbank", financial_years: [{ end: "2024-03-31", income: 1, expenditure: 2 }] });

    await crawl();

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ew/1122447.json"]);
  });

  // KILLS the mutant that puts a `method` or a `body` on the init. Nothing else
  // in this file looks at the request beyond its URL and headers, so a POST --
  // or a fetch that quietly grew a JSON body -- would 405 for all 831 food banks
  // a night and be indistinguishable, in the logs, from 831 missing charities.
  it("asks for the document with a plain GET and no body", async () => {
    await crawl();

    const { init } = fetchCalls[0]!;
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
    // ...and nothing else has been bolted on either: exactly the UA and the timeout.
    expect(Object.keys(init).sort()).toEqual(["headers", "signal"]);
  });
});

// ===========================================================================
// WHEN THE REGISTER DOES NOT ANSWER
//
// The contract queues/charity.ts depends on, in its own words: this function
// never throws for an external failure. If any of these started throwing, the
// ~2 daily 404s (the module header's own count, 2 of 80 sampled) would each burn
// three retries and land in a dead-letter queue nobody is watching.
// ===========================================================================
describe("when the register does not answer with a usable body", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCharityYear(SALISBURY, "2020-03-31");
  });

  /** Nothing at all was written: not a column, not the timestamp, not a year row. */
  function expectUntouched(): void {
    const row = foodbankRow();
    expect(row.charity_name).toBe("OLD NAME");
    expect(row.charity_type).toBe("OLD TYPE");
    expect(row.charity_reg_date).toBe("1999-01-01");
    expect(row.charity_postcode).toBe("OLD 1PC");
    expect(row.charity_website).toBe("https://old.example");
    expect(row.charity_purpose).toBe("OLD PURPOSE");
    expect(row.charity_objectives).toBe("OLD OBJECTIVES");
    expect(row.last_charity_check).toBeNull();
    // The year row's CONTENT, not a count. `toHaveLength(1)` passed a mutant
    // that emptied the history and wrote a placeholder back in its place, which
    // is exactly the shape a delete-then-reinsert bug takes.
    expect(charityYears()).toEqual([{ date: "2020-03-31", income: 1, expenditure: 2, created: "2020-01-01 00:00:00.000000" }]);
  }

  // Django's `if response.status_code == 200:` guard (crawlers.py:126, :193,
  // :252) has exactly this effect: a moved or removed charity number leaves
  // yesterday's data in place rather than blanking it.
  it.each([404, 403, 429, 500, 502, 503])("patches nothing on a %i", async (status) => {
    reply = { status, body: "not found" };

    await crawl();

    expectUntouched();
    // The status branch, not the exception branch: console.log, and nothing on
    // console.error. Without this, a guard loosened from `res.ok` to something
    // like `status < 500` still passes -- the body fails to parse, the throw is
    // caught, and the columns survive by accident rather than by the guard.
    expect(logs).toEqual([`charity: opencharities ${status} for salisbury (ew/1122447)`]);
    expect(errors).toEqual([]);
  });

  // The log line IS the incident report for an unattended job. It has to carry
  // the slug (to find the food bank) and the register plus number (to reproduce
  // the request by hand), and the number is the POST-strip one actually asked for.
  it("logs the status, the slug and the register path it asked for", async () => {
    seedFoodbank({ id: DUNDEE, slug: "ni-town", name: "NI Town Foodbank", country: "Northern Ireland", charity_number: "NIC101234" });
    reply = { status: 404, body: "" };

    await crawl(DUNDEE);

    expect(logs).toEqual(["charity: opencharities 404 for ni-town (ni/101234)"]);
    expect(errors).toEqual([]);
  });

  // KILLS the mutant that retries the same URL when the answer is not ok. The
  // failure path is the ONE place nothing else in this file counts requests, and
  // these failures are not transient -- they are charity numbers that have moved
  // or been removed (2 of the module header's 80 sampled). A retry therefore
  // doubles the nightly load on a one-person mirror and never once succeeds.
  it.each([404, 500])("does not retry a %i: one request, and one only", async (status) => {
    reply = { status, body: "" };

    await crawl();

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ew/1122447.json"]);
  });

  // Same guarantee for the branch where fetch itself rejects: an opencharities
  // outage costs one attempt per food bank, not two.
  it("does not retry after the fetch itself rejects", async () => {
    reply = new TypeError("fetch failed");

    await crawl();

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ew/1122447.json"]);
  });

  // A rejected fetch -- DNS, TLS, or the 20s abort firing -- is the shape a total
  // opencharities.uk outage takes. It costs a night's charity data for every food
  // bank and must cost nothing else.
  it("patches nothing and does not throw when the fetch rejects", async () => {
    reply = new TypeError("fetch failed");

    await expect(crawl()).resolves.toBeUndefined();

    expectUntouched();
    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe("charity: opencharities fetch failed for salisbury");
    // The cause travels with it, or a night of missing data is unexplainable.
    expect(errors[0]![1]).toContain("fetch failed");
  });

  // A 200 whose body is not JSON -- an HTML error page or a Cloudflare
  // interstitial from opencharities' own edge. res.json() rejects INSIDE the same
  // try, so it lands in the fetch-failed branch rather than escaping. Distinguish
  // this from the 404 branch by the log: it is console.error, not console.log.
  it("patches nothing when a 200 body is not JSON", async () => {
    reply = { status: 200, body: "<html>Bad gateway</html>" };

    await expect(crawl()).resolves.toBeUndefined();

    expectUntouched();
    expect(logs).toEqual([]);
    expect(errors[0]![0]).toBe("charity: opencharities fetch failed for salisbury");
  });

  // JSON `null` is falsy, so `if (!data) return` catches it -- the port's
  // equivalent of Django's `if data:` guard (crawlers.py:128).
  it("patches nothing when the body is JSON null", async () => {
    reply = { status: 200, body: "null" };

    await crawl();

    expectUntouched();
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // Django's guard is `if data:`, and in Python an EMPTY DICT IS FALSY, so a 200
  // carrying `{}` made Django write nothing. In JavaScript `{}` is truthy, so
  // this port sails past `if (!data) return` and patches every column with the
  // `?? null` fallback -- six columns NULLed and charity_purpose set to the
  // empty string, over data that was correct. The same is true of `[]`.
  //
  // Nothing observed produces an empty object today; this is what a change at
  // the mirror (an empty stub for a de-registered charity, say) would cost, and
  // it would be silent -- last_charity_check would even be stamped fresh.
  it("BLANKS every charity column when the body is an empty object, unlike Django", async () => {
    reply = { status: 200, body: "{}" };

    await crawl();

    const row = foodbankRow();
    expect(row.charity_name).toBeNull();
    expect(row.charity_type).toBeNull();
    expect(row.charity_reg_date).toBeNull();
    expect(row.charity_postcode).toBeNull();
    expect(row.charity_website).toBeNull();
    expect(row.charity_objectives).toBeNull();
    // "" rather than NULL: purposeFor's E&W branch returns an empty string when
    // no "What" classification survives the filter.
    expect(row.charity_purpose).toBe("");
    expect(row.last_charity_check).toBe(DJANGO_NOW);
    // The years survive only because `years.length` is 0 and the replace is
    // skipped -- see the financial-years block.
    expect(charityYears()).toHaveLength(1);
  });

  it("BLANKS every charity column when the body is an empty array, unlike Django", async () => {
    reply = { status: 200, body: "[]" };

    await crawl();

    expect(foodbankRow().charity_name).toBeNull();
    expect(foodbankRow().last_charity_check).toBe(DJANGO_NOW);
  });

  // The other side of the same coin, and the one that is actually normal: a
  // register that has stopped publishing a website blanks charity_website. That
  // IS the intent -- the crawler mirrors the register -- so it is pinned as
  // correct rather than flagged, and it is why the empty-object case above is
  // indistinguishable from a real answer.
  it("blanks a single field the register no longer publishes", async () => {
    ok({ name: "Salisbury Foodbank", legal_form: "CIO", date_registered: "2011-03-14", postcode: "SP2 9DY", activities: "Emergency food" });

    await crawl();

    expect(foodbankRow().charity_name).toBe("Salisbury Foodbank");
    expect(foodbankRow().charity_website).toBeNull();
  });
});

// ===========================================================================
// ENGLAND & WALES FIELD MAPPING
// ===========================================================================
describe("England and Wales", () => {
  beforeEach(() => {
    seedFoodbank({ country: "England" });
  });

  // The full mapping, one register at a time, because "which field holds what
  // differs by register" is this module's central claim and a mis-mapping renders
  // perfectly well.
  it("writes every column from the fields the E&W register publishes", async () => {
    ok({
      name: "Salisbury Foodbank",
      legal_form: "CIO - Association",
      date_registered: "2011-03-14",
      postcode: "SP2 9DY",
      website: "https://salisburyfoodbank.example",
      activities: "Providing three days of emergency food to people in crisis",
      classifications: [{ type: "What", description: "Food Banks" }],
    });

    await crawl();

    const row = foodbankRow();
    expect(row.charity_name).toBe("Salisbury Foodbank");
    expect(row.charity_type).toBe("CIO - Association");
    expect(row.charity_reg_date).toBe("2011-03-14");
    expect(row.charity_postcode).toBe("SP2 9DY");
    expect(row.charity_website).toBe("https://salisburyfoodbank.example");
    expect(row.charity_purpose).toBe("Food Banks\n");
    expect(row.charity_objectives).toBe("Providing three days of emergency food to people in crisis");
    expect(row.last_charity_check).toBe(DJANGO_NOW);
  });

  // crawlers.py:136-138 filters `who_what_where` on classification_type == "What"
  // and appends "\n" per item. The "Who" and "Where" entries are beneficiary and
  // geography lists -- putting them in charity_purpose would print "People In
  // Poverty" and "Throughout England And Wales" as things the charity does.
  //
  // A filter that did nothing passes any fixture containing only "What", so the
  // decoys here are load-bearing.
  it("takes only the What classifications, in register order, each on its own line", async () => {
    ok({
      classifications: [
        { type: "Who", description: "People In Poverty" },
        { type: "What", description: "Food Banks" },
        { type: "Where", description: "Throughout England And Wales" },
        { type: "What", description: "Relief Of Poverty" },
        { type: "How", description: "Provides Services" },
      ],
    });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("Food Banks\nRelief Of Poverty\n");
  });

  // The TRAILING newline is Django's shape, not an accident: crawlers.py:138 is
  // `+= item + "\n"`, so the stored value has always ended in one. Templates that
  // split on "\n" would gain a blank final item if it disappeared, and every
  // stored E&W value would differ from every re-crawled one.
  it("keeps Django's trailing newline even for a single purpose", async () => {
    ok({ classifications: [{ type: "What", description: "Food Banks" }] });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("Food Banks\n");
  });

  // An empty string, NOT null and NOT the previous value. Django does the same
  // (crawlers.py:135 assigns "" before the loop), so a charity whose "What"
  // classifications are withdrawn ends with a blank purpose in both systems.
  it("writes an empty string when no What classification survives", async () => {
    ok({ name: "Salisbury Foodbank", classifications: [{ type: "Who", description: "People In Poverty" }] });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("");
  });

  it("writes an empty string when classifications is missing entirely", async () => {
    ok({ name: "Salisbury Foodbank" });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("");
  });

  // A classification with no description at all would otherwise contribute a
  // bare "\n" and leave a blank line mid-list on the food bank page.
  it("drops a What classification with an empty or missing description", async () => {
    ok({
      classifications: [
        { type: "What", description: "Food Banks" },
        { type: "What", description: "" },
        { type: "What" },
        { type: "What", description: "Relief Of Poverty" },
      ],
    });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("Food Banks\nRelief Of Poverty\n");
  });

  // E&W objectives come from `activities` (crawlers.py:145's charityoverview
  // endpoint). `objectives` and `purposes` are the OTHER registers' fields and
  // must be ignored here even when opencharities happens to send them -- this is
  // the "a single fallback chain would be shorter and wrong" case, made concrete.
  it("takes objectives from activities and ignores the Scottish and NI fields", async () => {
    ok({
      activities: "THE ENGLISH ACTIVITIES",
      objectives: "THE SCOTTISH OBJECTIVES",
      purposes: "THE SCOTTISH PURPOSES",
      what_charity_does: "THE NI TEXT",
      classifications: [{ type: "What", description: "Food Banks" }],
    });

    await crawl();

    expect(foodbankRow().charity_objectives).toBe("THE ENGLISH ACTIVITIES");
    expect(foodbankRow().charity_purpose).toBe("Food Banks\n");
  });

  // Multi-paragraph activities text arrives verbatim -- no toLines() on this
  // path, so commas and newlines inside the prose are left exactly as published.
  it("stores multi-line activities text verbatim", async () => {
    ok({ activities: "Line one, with a comma.\n\nLine two." });

    await crawl();

    expect(foodbankRow().charity_objectives).toBe("Line one, with a comma.\n\nLine two.");
  });

  // A DIVERGENCE, pinned rather than wished away. Django stripped the API's time
  // suffix (`data["date_of_registration"].replace("T00:00:00", "")`,
  // crawlers.py:132); this port writes date_registered verbatim. opencharities
  // publishes a clean date today, so nothing is wrong -- but if it ever carried a
  // time, it would reach charity_reg_date whole and render as one.
  it("stores date_registered verbatim, with no T00:00:00 stripping", async () => {
    ok({ date_registered: "2011-03-14T00:00:00" });

    await crawl();

    expect(foodbankRow().charity_reg_date).toBe("2011-03-14T00:00:00");
  });
});

// ===========================================================================
// SCOTLAND FIELD MAPPING
// ===========================================================================
describe("Scotland", () => {
  beforeEach(() => {
    seedFoodbank({ country: "Scotland", charity_number: "SC012345", charity_id: "OSCR-9" });
  });

  // The module header's claim for Scotland: reg_date and type were EMPTY in D1
  // for 19 of 20 sampled food banks and are populated here, because OSCR's own
  // API never gave crawlers.py a legal form (crawlers.py:196-204 sets no
  // charity_type at all).
  it("writes the type and registration date Django never had", async () => {
    ok({
      name: "Dundee Foodbank",
      legal_form: "SCIO",
      date_registered: "2013-06-01",
      postcode: "DD1 1AA",
      website: "https://dundee.example",
      purposes: "'The prevention or relief of poverty','The advancement of citizenship'",
      objectives: "To provide emergency food",
    });

    await crawl();

    const row = foodbankRow();
    expect(row.charity_type).toBe("SCIO");
    expect(row.charity_reg_date).toBe("2013-06-01");
    expect(row.charity_name).toBe("Dundee Foodbank");
    expect(row.charity_postcode).toBe("DD1 1AA");
    expect(row.charity_website).toBe("https://dundee.example");
  });

  // OSCR's purposes arrive as its own array, comma-joined and single-quoted.
  // Django stored them newline-separated (crawlers.py:201-203's `+= item + "\n"`),
  // so splitting on "','" reproduces the stored shape -- otherwise every Scottish
  // charity_purpose becomes one long quoted line on the food bank page.
  it("splits OSCR's quoted purposes array onto separate lines", async () => {
    ok({ purposes: "'The prevention or relief of poverty','The advancement of education','The relief of those in need'" });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("The prevention or relief of poverty\nThe advancement of education\nThe relief of those in need");
  });

  // THE REASON the quoted form is detected separately. OSCR purposes routinely
  // contain commas ("Relief of those in need by reason of age, ill-health,
  // disability..."). Splitting on a bare comma would shatter one purpose into
  // four fragments -- which is what the `quoted` branch exists to prevent.
  it("keeps a comma that is inside a quoted purpose", async () => {
    ok({ purposes: "'Relief of those in need by reason of age, ill-health or disability','The advancement of health'" });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("Relief of those in need by reason of age, ill-health or disability\nThe advancement of health");
  });

  // A DELIBERATE LOSS, recorded in the module's own comment: OSCR labels each
  // purpose with a letter and opencharities has already dropped it, so the code
  // is gone before this port ever sees the value. Nothing renders it.
  it("keeps whatever prefix arrives, having no code of its own to restore", async () => {
    ok({ purposes: "'A - the prevention or relief of poverty'" });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("A - the prevention or relief of poverty");
  });

  // One purpose has no "','" in it, so it takes the unquoted branch and is
  // saved only by the leading/trailing quote strip.
  it("unwraps a single quoted purpose", async () => {
    ok({ purposes: "'The prevention or relief of poverty'" });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("The prevention or relief of poverty");
  });

  // Scotland's objectives are free prose from OSCR (crawlers.py:204) and are NOT
  // put through toLines -- so commas in the objects clause survive. A shared
  // helper applied to both would silently reformat every Scottish charity's
  // objectives into a list.
  it("stores objectives verbatim, commas and all", async () => {
    ok({ objectives: "To relieve poverty, hardship and distress, in Dundee and the surrounding area" });

    await crawl();

    expect(foodbankRow().charity_objectives).toBe("To relieve poverty, hardship and distress, in Dundee and the surrounding area");
  });

  // The register crossing again, from the Scottish side: `what_charity_does` is
  // NI's field and `activities` is E&W's. Both must be ignored.
  it("ignores the NI and E&W text fields", async () => {
    ok({ purposes: "'Scottish purpose'", objectives: "Scottish objectives", what_charity_does: "NI TEXT", activities: "EW TEXT" });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("Scottish purpose");
    expect(foodbankRow().charity_objectives).toBe("Scottish objectives");
  });
});

// ===========================================================================
// NORTHERN IRELAND FIELD MAPPING
//
// The register this port actually fixes: crawlNi.ts recorded the regulator's CSV
// endpoint 404ing for a real NI food bank, and Django's own status guard means
// production has been getting nothing from it either. Everything below is data
// that has been stale in both systems.
// ===========================================================================
describe("Northern Ireland", () => {
  beforeEach(() => {
    seedFoodbank({ country: "Northern Ireland", charity_number: "NIC101234" });
  });

  // The FIELDS ARE CROSSED for NI, and Django crossed them too -- crawlers.py:266
  // takes objectives from "Charitable purposes" and :270 takes purpose from "What
  // the charity does", with the comment "Objectives and purposes are reversed in
  // NI". opencharities publishes those two as `purposes` and `what_charity_does`.
  // A reader who assumed `purposes` -> charity_purpose would swap the two boxes
  // on every NI food bank page and nothing would look broken.
  it("crosses purposes into objectives and what_charity_does into purpose", async () => {
    ok({
      name: "Belfast Foodbank",
      postcode: "BT1 1AA",
      purposes: "The prevention or relief of poverty",
      what_charity_does: "Food banks,Emergency support",
    });

    await crawl();

    const row = foodbankRow();
    expect(row.charity_objectives).toBe("The prevention or relief of poverty");
    expect(row.charity_purpose).toBe("Food banks\nEmergency support");
    // The header's other NI claim: postcode was empty in D1 for 19 of 20 and is
    // populated here.
    expect(row.charity_postcode).toBe("BT1 1AA");
  });

  // objectivesFor returns `purposes` RAW for NI -- no toLines -- so a comma-joined
  // objects clause stays on one line, exactly as Django's `data.get("Charitable
  // purposes")` did.
  it("stores the objectives text unsplit, however many commas it has", async () => {
    ok({ purposes: "The prevention of poverty,The advancement of health,The relief of those in need" });

    await crawl();

    expect(foodbankRow().charity_objectives).toBe("The prevention of poverty,The advancement of health,The relief of those in need");
  });

  // A DIVERGENCE FROM DJANGO, verified with CPython on this machine (3.13.0),
  // not reasoned about. Django split NI's "What the charity does" on a comma NOT
  // followed by whitespace: `re.sub(r",(?!\s)", "\n", "a, b,c")` returns
  // 'a, b\nc' -- a comma-then-space stays inside its line. toLines() splits on
  // EVERY comma and trims, so the same input becomes 'a\nb\nc'.
  //
  // The port therefore produces MORE lines than Django did for any NI charity
  // whose text has ", " in it. Pinned as the port behaves; not fixed here. The
  // practical impact is small -- Django has been getting nothing from the NI
  // endpoint at all, so there is no stored value to differ from.
  it("splits on a comma followed by a space, where Django kept the line whole", async () => {
    ok({ what_charity_does: "Food banks, and other charitable activity,Emergency support" });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("Food banks\nand other charitable activity\nEmergency support");
  });

  it("ignores the E&W and Scottish text fields", async () => {
    ok({ purposes: "NI objectives", what_charity_does: "NI purpose", activities: "EW TEXT", objectives: "SCOTTISH TEXT", classifications: [{ type: "What", description: "EW CLASSIFICATION" }] });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("NI purpose");
    expect(foodbankRow().charity_objectives).toBe("NI objectives");
  });
});

// ===========================================================================
// toLines EDGE CASES -- reached through Scotland/NI, since it is not exported
// ===========================================================================
describe("the comma-separated list parser", () => {
  beforeEach(() => {
    seedFoodbank({ country: "Scotland" });
  });

  // Whitespace-only comes back NULL, so the column is blanked rather than filled
  // with spaces -- a template testing `{% if charity_purpose %}` would otherwise
  // render an empty heading.
  it("nulls a whitespace-only value", async () => {
    ok({ purposes: "   \n  " });

    await crawl();

    expect(foodbankRow().charity_purpose).toBeNull();
  });

  it("nulls a missing value", async () => {
    ok({ name: "Dundee Foodbank" });

    await crawl();

    expect(foodbankRow().charity_purpose).toBeNull();
  });

  it("nulls an empty string", async () => {
    ok({ purposes: "" });

    await crawl();

    expect(foodbankRow().charity_purpose).toBeNull();
  });

  // A lone comma survives the `if (!trimmed)` guard, splits into two empty
  // pieces, both are filtered out, and join("") gives "" -- an EMPTY STRING where
  // every other degenerate input gives NULL. Harmless (both render as nothing)
  // but pinned because the inconsistency is real and would surprise a query
  // written as `WHERE charity_purpose IS NOT NULL`.
  it("returns an empty string, not null, for a value of just commas", async () => {
    ok({ purposes: ",," });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("");
  });

  it("drops empty items rather than emitting blank lines", async () => {
    ok({ purposes: "Poverty,,Education," });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("Poverty\nEducation");
  });

  it("trims whitespace around every item", async () => {
    ok({ purposes: "  Poverty ,  Education  " });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("Poverty\nEducation");
  });

  // The quoted branch is only taken when the value BOTH starts with a quote and
  // contains "','", so a value that merely mentions an apostrophe takes the bare
  // comma path -- and a mid-item apostrophe is left alone by the strip, which
  // only removes one leading and one trailing quote.
  it("leaves an apostrophe inside an item alone", async () => {
    ok({ purposes: "Children's welfare,Older people's care" });

    await crawl();

    expect(foodbankRow().charity_purpose).toBe("Children's welfare\nOlder people's care");
  });
});

// ===========================================================================
// THE WEBSITE PLACEHOLDER FILTER
// ===========================================================================
describe("the website field", () => {
  beforeEach(() => {
    seedFoodbank();
  });

  // The NI register lets a charity file the literal string "n/a" as its website
  // and opencharities passes it through. Stored, it renders a link to
  // https://n/a on the food bank page -- a visibly broken link on a public page,
  // which is the one failure in this file a member of the public would see.
  it.each(["n/a", "N/A", "na", "NA", "none", "None", "-", "tbc", "TBC", "no website", "No Website", "  n/a  "])(
    "treats %s as no website at all",
    async (value) => {
      ok({ website: value });

      await crawl();

      expect(foodbankRow().charity_website).toBeNull();
    },
  );

  it("keeps a real website, trimmed", async () => {
    ok({ website: "  https://salisburyfoodbank.example/  " });

    await crawl();

    expect(foodbankRow().charity_website).toBe("https://salisburyfoodbank.example/");
  });

  // Only the exact placeholders are filtered; anything that merely CONTAINS one
  // is a real address. A `.includes` here would drop every domain with "na" in it.
  it.each(["https://nationalfoodbank.example", "na.example.com", "https://example.com/n/a"])("keeps %s", async (value) => {
    ok({ website: value });

    await crawl();

    expect(foodbankRow().charity_website).toBe(value);
  });

  // Pinned as-is, not endorsed: a schemeless address is stored verbatim, so
  // whatever renders it has to add the scheme or produce a relative link. That is
  // the register's own data and Django stored it the same way (crawlers.py:134,
  // :200, :264 all assign the raw value).
  it("stores a schemeless address exactly as the register published it", async () => {
    ok({ website: "www.salisburyfoodbank.example" });

    await crawl();

    expect(foodbankRow().charity_website).toBe("www.salisburyfoodbank.example");
  });

  it("nulls an all-whitespace website", async () => {
    ok({ website: "   " });

    await crawl();

    expect(foodbankRow().charity_website).toBeNull();
  });
});

// ===========================================================================
// CHARITY_ID
// ===========================================================================
describe("charity_id", () => {
  // DELIBERATELY NOT PATCHED (the module's own 194-200 comment). It used to hold
  // E&W's organisation_number and OSCR's internal id -- two different registers'
  // identifiers whose only job was building the second OSCR request, which no
  // longer exists. Writing the charity number into it would silently change what
  // the column means for every consumer of it.
  it("is left exactly as the last regulator crawl left it", async () => {
    seedFoodbank({ charity_id: "ORG-1122447" });
    ok({ name: "Salisbury Foodbank", id: "SHOULD-NOT-BE-WRITTEN", organisation_number: "SHOULD-NOT-BE-WRITTEN" });

    await crawl();

    expect(foodbankRow().charity_id).toBe("ORG-1122447");
  });

  it("stays null when it was already null", async () => {
    seedFoodbank({ charity_id: null });
    ok({ name: "Salisbury Foodbank" });

    await crawl();

    expect(foodbankRow().charity_id).toBeNull();
  });
});

// ===========================================================================
// FINANCIAL YEARS
// ===========================================================================
describe("financial years", () => {
  beforeEach(() => {
    seedFoodbank();
  });

  // `financial_years` is uniform across all three registers, which is what stops
  // CharityYear handling from being per-country -- and NI gains a financial
  // history it never had, because _crawl_charity_ni never touched CharityYear at
  // all (the CSV carried no financial rows).
  it("writes one row per year, in the order the register sent them", async () => {
    ok({
      financial_years: [
        { end: "2024-03-31", income: 412000, expenditure: 398000 },
        { end: "2023-03-31", income: 355000, expenditure: 340000 },
      ],
    });

    await crawl();

    expect(charityYears()).toEqual([
      { date: "2024-03-31", income: 412000, expenditure: 398000, created: DJANGO_NOW },
      { date: "2023-03-31", income: 355000, expenditure: 340000, created: DJANGO_NOW },
    ]);
  });

  // `created` is written by replaceCharityYears with pyNow(), so it must carry
  // Django's space separator. charityyear.created is TEXT: an ISO value here
  // sorts after every same-day Django one, which is the pyDatetime.ts incident.
  it("stamps created in Django's format, not ISO", async () => {
    ok({ financial_years: [{ end: "2024-03-31", income: 1, expenditure: 2 }] });

    await crawl();

    expect(charityYears()[0]!.created).toBe(DJANGO_NOW);
    expect(charityYears()[0]!.created).not.toContain("T");
  });

  // A year with no end date has nothing to key on -- Django wrote
  // `year.get("financial_period_end_date").replace(...)` (crawlers.py:157) and
  // would have crashed on a missing one. Dropping it keeps a NULL-dated row out
  // of a table both of whose indexes are on `date`
  // (0005_orders_and_charity.sql:56-57: (foodbank_id, date DESC) and (date)).
  it.each([[null], [undefined], [""]])("drops a year whose end date is %s", async (end) => {
    ok({
      financial_years: [
        { end: "2024-03-31", income: 1, expenditure: 2 },
        { end, income: 99, expenditure: 99 },
      ],
    });

    await crawl();

    expect(charityYears()).toEqual([{ date: "2024-03-31", income: 1, expenditure: 2, created: DJANGO_NOW }]);
  });

  // Django's `year.get("income", 0)` (crawlers.py:158-159) defaulted the same
  // way. A NULL income would render as blank rather than "£0" and would break any
  // SUM over the column.
  it.each([[null], [undefined]])("defaults a %s income and expenditure to zero", async (value) => {
    ok({ financial_years: [{ end: "2024-03-31", income: value, expenditure: value }] });

    await crawl();

    expect(charityYears()).toEqual([{ date: "2024-03-31", income: 0, expenditure: 0, created: DJANGO_NOW }]);
  });

  it("keeps a genuine zero and a genuine negative", async () => {
    ok({
      financial_years: [
        { end: "2024-03-31", income: 0, expenditure: 0 },
        { end: "2023-03-31", income: 5, expenditure: -5 },
      ],
    });

    await crawl();

    expect(charityYears()).toEqual([
      { date: "2024-03-31", income: 0, expenditure: 0, created: DJANGO_NOW },
      { date: "2023-03-31", income: 5, expenditure: -5, created: DJANGO_NOW },
    ]);
  });

  // The whole point of replaceCharityYears: DELETE then re-INSERT in ONE batch,
  // so a re-crawl never doubles a food bank's history. Cloudflare crons and
  // queues are both at-least-once, so this runs twice more often than anyone
  // thinks.
  it("replaces rather than appends when the same crawl runs twice", async () => {
    seedCharityYear(SALISBURY, "2019-03-31", 100, 200);
    ok({ financial_years: [{ end: "2024-03-31", income: 1, expenditure: 2 }] });

    await crawl();
    await crawl();

    expect(charityYears()).toEqual([{ date: "2024-03-31", income: 1, expenditure: 2, created: DJANGO_NOW }]);
  });

  // The DELETE is by foodbank_id. One that lost its WHERE clause would empty
  // every other food bank's history and nothing would notice until someone
  // looked at a charity page -- 830 of them, from one nightly run.
  it("replaces only this food bank's years", async () => {
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland" });
    seedCharityYear(DUNDEE, "2019-03-31", 100, 200);
    ok({ financial_years: [{ end: "2024-03-31", income: 1, expenditure: 2 }] });

    await crawl();

    expect(charityYears()).toEqual([{ date: "2024-03-31", income: 1, expenditure: 2, created: DJANGO_NOW }]);
    expect(charityYears(DUNDEE)).toEqual([{ date: "2019-03-31", income: 100, expenditure: 200, created: "2020-01-01 00:00:00.000000" }]);
  });

  // A DELIBERATE DIVERGENCE from Django, and the safer one. crawlers.py:147 and
  // :206 DELETE the CharityYear rows before fetching the replacements, so a failed
  // fetch leaves a food bank with no financial history at all. Here the rows are
  // in hand first and the replace is skipped entirely when there are none, so an
  // empty `financial_years` PRESERVES what is already stored (PLAN.md §8.7.1).
  //
  // The cost, pinned so it is a known one: a charity that genuinely deregisters
  // its financial history keeps showing the old years forever.
  it.each([[[]], [undefined], [null]])("keeps the existing years when financial_years is %s", async (years) => {
    seedCharityYear(SALISBURY, "2019-03-31", 100, 200);
    ok({ name: "Salisbury Foodbank", financial_years: years });

    await crawl();

    expect(charityYears()).toEqual([{ date: "2019-03-31", income: 100, expenditure: 200, created: "2020-01-01 00:00:00.000000" }]);
    // ...and the rest of the crawl still happened.
    expect(foodbankRow().charity_name).toBe("Salisbury Foodbank");
  });

  it("keeps the existing years when every year sent lacks an end date", async () => {
    seedCharityYear(SALISBURY, "2019-03-31", 100, 200);
    ok({ financial_years: [{ end: null, income: 1, expenditure: 2 }] });

    await crawl();

    // The whole row, including `created`: the stored year must be the ORIGINAL
    // one, not a re-inserted copy carrying tonight's timestamp.
    expect(charityYears()).toEqual([{ date: "2019-03-31", income: 100, expenditure: 200, created: "2020-01-01 00:00:00.000000" }]);
  });

  // A 404 must not empty the table either -- this is the same guarantee one level
  // up, and the reason `if (!data) return` sits before the years are touched.
  it("keeps the existing years when the register 404s", async () => {
    seedCharityYear(SALISBURY, "2019-03-31", 100, 200);
    reply = { status: 404, body: "" };

    await crawl();

    expect(charityYears()).toEqual([{ date: "2019-03-31", income: 100, expenditure: 200, created: "2020-01-01 00:00:00.000000" }]);
  });
});

// ===========================================================================
// ORDER OF WRITES, AND WHAT SURVIVES A D1 FAILURE
//
// The two writes have no transaction around them. Which one fails decides what
// the food bank is left holding, and the queue consumer's retry only helps if the
// exception actually escapes.
// ===========================================================================
describe("when D1 fails mid-crawl", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCharityYear(SALISBURY, "2019-03-31", 100, 200);
    ok({ name: "Salisbury Foodbank", financial_years: [{ end: "2024-03-31", income: 1, expenditure: 2 }] });
  });

  // A genuine D1 write failure is the ONE thing that must propagate: it is what
  // makes queues/charity.ts retry the message and leave the crawlitem open, which
  // is the only stall signal the crawl dashboard has.
  it("propagates a failed column patch instead of swallowing it", async () => {
    failOn = /UPDATE foodbank SET/;

    await expect(crawl()).rejects.toThrow("D1_ERROR: Network connection lost");

    expect(foodbankRow().charity_name).toBe("OLD NAME");
  });

  // ORDER MATTERS: the patch is awaited before the years are replaced, so a
  // failed patch leaves the years alone. Were it the other way round, a retry
  // would have already destroyed the old history before the columns were written.
  it("leaves the existing years intact when the patch fails", async () => {
    failOn = /UPDATE foodbank SET/;

    await expect(crawl()).rejects.toThrow();

    expect(charityYears()).toEqual([{ date: "2019-03-31", income: 100, expenditure: 200, created: "2020-01-01 00:00:00.000000" }]);
  });

  // The other half, pinned as a KNOWN partial write: the columns are already
  // committed when the years batch fails, so the food bank is left with fresh
  // charity details, a fresh last_charity_check, and last year's financials. The
  // queue's retry re-runs the whole crawl and converges, which is why this is
  // acceptable rather than a bug -- but the intermediate state is real and a
  // dashboard reading last_charity_check would call it a clean run.
  it("has already committed the columns when the years batch fails", async () => {
    failOn = /DELETE FROM charityyear/;

    await expect(crawl()).rejects.toThrow("D1_ERROR: Network connection lost");

    expect(foodbankRow().charity_name).toBe("Salisbury Foodbank");
    expect(foodbankRow().last_charity_check).toBe(DJANGO_NOW);
    expect(charityYears()).toEqual([{ date: "2019-03-31", income: 100, expenditure: 200, created: "2020-01-01 00:00:00.000000" }]);
  });
});

// ===========================================================================
// THE WHOLE THING, TWICE
// ===========================================================================
describe("a full crawl", () => {
  // Cloudflare Queues are at-least-once and the nightly cron can be delivered
  // twice, so this function runs again more often than anyone plans for. Nothing
  // it writes may accumulate.
  it("is idempotent: the second run leaves exactly the same rows", async () => {
    seedFoodbank({ country: "Scotland", charity_number: "SC012345" });
    ok({
      name: "Dundee Foodbank",
      legal_form: "SCIO",
      date_registered: "2013-06-01",
      postcode: "DD1 1AA",
      website: "https://dundee.example",
      purposes: "'Poverty','Education'",
      objectives: "To relieve poverty",
      financial_years: [
        { end: "2024-03-31", income: 412000, expenditure: 398000 },
        { end: "2023-03-31", income: 355000, expenditure: 340000 },
      ],
    });

    await crawl();
    const afterFirst = foodbankRow();
    const yearsAfterFirst = charityYears();

    await crawl();

    expect(foodbankRow()).toEqual(afterFirst);
    expect(charityYears()).toEqual(yearsAfterFirst);
    expect(charityYears()).toHaveLength(2);
    // Two runs, two requests: there is no caching or short-circuit here, which is
    // what the queue consumer's own "runs the fetcher a second time" test costs.
    expect(fetchCalls).toHaveLength(2);
  });

  // Only the food bank named by the row. Every column of the other one has to be
  // untouched -- a patch missing its WHERE would rewrite the whole table from one
  // charity's data, and the crawl of the other 830 would look perfectly normal.
  it("touches only the food bank it was given", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland" });
    const dundeeBefore = foodbankRow(DUNDEE);
    ok({ name: "Salisbury Foodbank", financial_years: [{ end: "2024-03-31", income: 1, expenditure: 2 }] });

    await crawl();

    expect(foodbankRow().charity_name).toBe("Salisbury Foodbank");
    expect(foodbankRow(DUNDEE)).toEqual(dundeeBefore);
    expect(charityYears(DUNDEE)).toEqual([]);
  });

  // KILLS TWO MUTANTS that nothing else here could see: a literal id in place of
  // `foodbank.id` in either write --
  // `patchFoodbankCharity(session, 22, ...)` or `replaceCharityYears(session, 22, ...)`,
  // the classic wrong-bind-parameter slip. Every other test in this file crawls
  // SALISBURY, whose id IS 22, so both mutants wrote the correct row by
  // coincidence and the suite stayed green. Here the row crawled is DUNDEE and
  // SALISBURY is the one that must not move -- in production that mutant would
  // rewrite one food bank's charity details 831 times a night from 831 different
  // registers' data, and the page for every other food bank would look normal.
  it("writes to the food bank it was handed, not to a fixed id", async () => {
    seedFoodbank();
    seedCharityYear(SALISBURY, "2018-03-31", 7, 8);
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland", charity_number: "SC012345" });
    const salisburyBefore = foodbankRow(SALISBURY);
    ok({
      name: "Dundee Foodbank Charity",
      legal_form: "SCIO",
      date_registered: "2013-06-01",
      postcode: "DD1 1AA",
      website: "https://dundee.example",
      purposes: "'Poverty','Education'",
      objectives: "To relieve poverty",
      financial_years: [{ end: "2024-03-31", income: 9, expenditure: 10 }],
    });

    await crawl(DUNDEE);

    const dundee = foodbankRow(DUNDEE);
    expect(dundee.charity_name).toBe("Dundee Foodbank Charity");
    expect(dundee.charity_type).toBe("SCIO");
    expect(dundee.charity_reg_date).toBe("2013-06-01");
    expect(dundee.charity_postcode).toBe("DD1 1AA");
    expect(dundee.charity_website).toBe("https://dundee.example");
    expect(dundee.charity_purpose).toBe("Poverty\nEducation");
    expect(dundee.charity_objectives).toBe("To relieve poverty");
    expect(dundee.last_charity_check).toBe(DJANGO_NOW);
    expect(charityYears(DUNDEE)).toEqual([{ date: "2024-03-31", income: 9, expenditure: 10, created: DJANGO_NOW }]);
    // Salisbury -- every column, its timestamp, and its own financial history.
    expect(foodbankRow(SALISBURY)).toEqual(salisburyBefore);
    expect(charityYears(SALISBURY)).toEqual([{ date: "2018-03-31", income: 7, expenditure: 8, created: "2020-01-01 00:00:00.000000" }]);
  });

  // The non-charity columns are not this job's business. A patch built from
  // Object.keys of the response rather than the fixed column list could reach
  // `name` or `postcode` -- the food bank's OWN name and postcode, which are
  // editorial and not the registered charity's.
  it("never writes the food bank's own name, postcode or address", async () => {
    seedFoodbank();
    ok({ name: "The Trussell Trust", postcode: "BH21 1AA", website: "https://x.example" });

    await crawl();

    const row = foodbankRow();
    expect(row.name).toBe("Salisbury Foodbank");
    expect(row.postcode).toBe("SP2 9DY");
    expect(row.address).toBe("1 Bemerton Heath");
    // ...while the CHARITY equivalents did change.
    expect(row.charity_name).toBe("The Trussell Trust");
    expect(row.charity_postcode).toBe("BH21 1AA");
  });

  // A successful crawl says nothing. These jobs run 831 times a night; anything
  // logged on the happy path buries the two lines that matter.
  it("logs nothing when it works", async () => {
    seedFoodbank();
    ok({ name: "Salisbury Foodbank", financial_years: [{ end: "2024-03-31", income: 1, expenditure: 2 }] });

    await crawl();

    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("resolves undefined -- the queue consumer reads no return value", async () => {
    seedFoodbank();
    ok({ name: "Salisbury Foodbank" });

    await expect(crawl()).resolves.toBeUndefined();
  });
});
