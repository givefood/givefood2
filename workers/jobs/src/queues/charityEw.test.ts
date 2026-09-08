import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import type { Env } from "../../worker-configuration";
import type { CharityMessage } from "./charity";
import { handleCharityEwQueue } from "./charityEw";
import { handleCharityNiQueue } from "./charityNi";
import { handleCharityScotlandQueue } from "./charityScotland";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning,
// as packages/db/src/schema.testkit.ts:35 and queues/charity.test.ts:7.
import { DatabaseSync } from "node:sqlite";

// queues/charityEw.ts -- the consumer index.ts:36-37 dispatches the
// `charity-ew` queue to, and the only place in the codebase where England &
// Wales' nightly charity crawl is actually assembled.
//
// THE MODULE IS ONE LINE, WHICH IS EXACTLY WHY IT NEEDS ITS OWN FILE. It is
// `makeCharityQueueHandler("charity-ew", crawlOpenCharities)` and nothing
// else, so everything it can get wrong is a WIRING mistake, and every wiring
// mistake available to it is silent:
//
//   * the label. It is a bare string, duplicated across three near-identical
//     files (charityEw.ts / charityScotland.ts / charityNi.ts) that were
//     written by copy-paste and whose only textual differences are that string
//     and the export name. A charityEw.ts carrying "charity-ni" changes
//     nothing about what gets crawled -- the crawl succeeds, the counter
//     lands, the site renders -- and costs exactly one thing: the log line
//     somebody reads at 2am is pointing them at the wrong consumer. This repo
//     has already shipped that shape of bug twice in the deploy config alone
//     (commits 61a28c1 "Fix the jobs Worker's actual name" and 9b11b27 "Fix
//     the weekly cron's day-of-week").
//   * the fetcher. Since givefood/givefood2#1 all three queues share
//     charity/crawlOpenCharities.ts, so a charityEw.ts left pointing at a
//     deleted per-regulator crawler, or at nothing, is a TypeError inside the
//     handler -- which this module's factory turns into a retry, three of
//     them, and then a dead-letter queue nobody is watching. That is the
//     incident this whole tier exists for.
//   * the binding time. The handler is a module-scope `const`, built once when
//     the isolate loads and reused for every batch it ever sees, so it has to
//     hold no per-invocation state.
//
// WHAT THIS FILE IS *NOT*. queues/charity.test.ts already covers
// makeCharityQueueHandler itself in isolation -- the CrawlItem bracket, the
// ack/retry contract, the crawlset arithmetic -- against a stand-in fetcher,
// and this file does not repeat that. Everything below goes through the REAL
// exported `handleCharityEwQueue`, so what is under test is the composition:
// this label, this crawler, this queue, end to end from a queue message to the
// rows in D1.
//
// REAL THINGS, NOT MOCKS:
//   * node:sqlite carrying the WHOLE real migration set (MIGRATIONS_SQL): the
//     path under test writes foodbank, crawlitem, crawlset AND charityyear
//     through four shared packages/db functions, and a narrow hand-built
//     fixture is how eight suites broke at once when a shared query started
//     reading one more object (github #51).
//   * the real getFoodbankForCharityCrawl / insertCrawlItem / finishCrawlItem
//     / decrementCrawlSetRemaining / patchFoodbankCharity /
//     replaceCharityYears, and the real crawlOpenCharities on top of them.
//     Nothing between the message body and the row is doubled.
//
// MOCKED, and only this: `fetch` -- opencharities.uk is the one thing that
// leaves the machine -- and the MessageBatch, which is a runtime object
// Cloudflare hands in and has no local equivalent.
//
// DJANGO PARITY, read rather than remembered. givefood/utils/crawlers.py at
// /Users/jasoncartwright/Sites/foodcharity was opened directly while writing
// this file (2026-09-08): `foodbank_charity_crawl` (:79-101) branches on
// `foodbank.country` -- England/Wales (:94) -> _crawl_charity_ew, Scotland
// (:96) -> OSCR, Northern Ireland (:98) -> the NI CSV, anything else
// (:100-101) -> False -- with no notion of a queue anywhere, and
// gfoffline/management/commands/charityinfo.py is a single synchronous loop
// over every food bank of every country. So Django's register choice was
// always the ROW's country, never the job's; the "REGISTER COMES FROM THE ROW"
// block below is that parity, asserted rather than assumed.
//
// One parity claim below was checked by RUNNING CPython 3.13.0 on this machine
// rather than by reading the regex: see the NI comma test, which is a genuine
// divergence and is pinned as the port behaves.
//
// MUTATION TESTED, TWICE. Both passes ran in a copy of the repo built by
// `git archive HEAD` into a scratchpad OUTSIDE the working tree; no source file
// in the repo itself was edited at any point, and each mutant was reverted from
// git before the next.
//
// The first pass ran eleven breakages, all caught: in charityEw.ts the label
// changed to "charity-ni" (4 failures) and the fetcher replaced with a no-op
// (27). In its collaborators, to prove the composition is load-bearing rather
// than the stand-ins: `retry()` without the 60s backoff, Scotland remapped to
// the ew register, a non-200 made to throw instead of being swallowed, the
// "What" classification filter neutered, replaceCharityYears called
// unconditionally, the NIC strip removed, the website placeholder guard
// removed, charity_id added to the patch, and the `if (closed)` guard dropped
// from the decrement.
//
// The second (adversarial review) pass ran ~40 more across queues/charity.ts,
// charity/crawlOpenCharities.ts and packages/db's charity.ts and needcheck.ts:
// ack<->retry both ways, the batch loop truncated to one message and made to
// `break` on failure, the vanished-foodbank guard deleted, the session mode
// changed, insertCrawlItem's crawlSetId/foodbankId swapped, crawlType changed,
// finishCrawlItem and decrementCrawlSetRemaining each handed the wrong id,
// `finish IS NULL` and the ON CONFLICT upsert deleted, both WHERE clauses in
// patchFoodbankCharity/replaceCharityYears deleted, `country` dropped from the
// crawl SELECT, income/expenditure transposed, the years list sliced to its
// first element, Wales dropped from COUNTRY_CODE, purposeFor/objectivesFor's
// per-register sources swapped, single fields dropped from the patch, the
// sequential loop turned into Promise.all, and the User-Agent, AbortSignal,
// encodeURIComponent, trailing-newline and `if (!data) return` each removed.
// All were caught. FOUR SURVIVED and are the reason for the assertions marked
// "MUTANT KILLED" below: crawlitem.url, toLines' quoted-array detection,
// toLines' `.filter(Boolean)`, and websiteOrNull's trim on the returned value.
//
// NOT VERIFIED: nothing here has run against a real Cloudflare queue or
// against opencharities.uk. Redelivery claims are read off the documented
// at-least-once guarantee and wrangler.jsonc's charity-ew consumer settings
// (max_batch_size 5, max_retries 3, max_concurrency 10, dead_letter_queue
// charity-ew-dlq), not measured.

// ===========================================================================
// HARNESS -- copied from queues/charity.test.ts rather than reinvented, so the
// two files agree about what a D1 session and a MessageBatch look like.
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
 * standing in for a D1 outage mid-message. This is the ONLY input that can
 * reach the factory's catch through the real crawler -- every external failure
 * is swallowed upstream by design -- so it is the only way to test that a
 * genuine write failure still retries.
 */
let failOn: RegExp | null = null;

/** Every bookmark mode `withSession` was asked for, in call order. */
let sessionModes: string[] = [];

/**
 * The slice of the D1 Sessions API packages/db uses, carried over the real
 * engine. It forwards SQL untouched and interprets nothing, so SQLite decides
 * what comes back -- a session answering canned rows would be a second
 * implementation of the very upsert / `WHERE finish IS NULL` / batch semantics
 * this file depends on.
 *
 * `first()` answers null and never undefined, matching D1; `run()` reports
 * `meta.changes`, which is the whole return value of finishCrawlItem; `batch()`
 * runs the statements in order, which is how replaceCharityYears deletes and
 * reinserts.
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

interface AckLog {
  acks: number[];
  /** Index plus the options object the handler passed, so the 60s backoff is measured rather than assumed. */
  retries: { index: number; options: unknown }[];
}

/**
 * A MessageBatch double, recording ack/retry per message index -- the only
 * externally observable output a queue consumer has. Bodies are `unknown` so a
 * malformed message can be posted; the producer is a different Worker and is
 * not typechecked against this consumer.
 */
function batchOf(bodies: unknown[], queue = "charity-ew"): { batch: MessageBatch<CharityMessage> } & AckLog {
  const acks: number[] = [];
  const retries: { index: number; options: unknown }[] = [];
  const messages = bodies.map((body, index) => ({
    id: `msg-${index}`,
    timestamp: NOW,
    attempts: 1,
    body,
    ack: () => void acks.push(index),
    retry: (options?: unknown) => void retries.push({ index, options }),
  }));
  return { batch: { queue, messages } as unknown as MessageBatch<CharityMessage>, acks, retries };
}

let env: Env;
let errors: string[][];
let logs: string[];

// ---------------------------------------------------------------------------
// The one thing that leaves the machine.
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  /** crawlOpenCharities arms AbortSignal.timeout(20_000); captured so its presence is asserted, not assumed. */
  signal: unknown;
}

type Reply = { status: number; body: string } | Error;

let fetchCalls: FetchCall[];
/** Per-URL replies, so a multi-message batch can give each food bank its own answer. */
let replies: Map<string, Reply>;
let defaultReply: Reply;

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write: a SPACE separator, six fractional
// digits, never a "T" and never a "Z". crawlitem.start/finish, crawlset.finish,
// foodbank.last_charity_check and charityyear.created are all TEXT and SQLite
// compares TEXT bytewise, so an ISO value here sorts after every same-day
// Django one -- see pyDatetime.ts's header for the two production incidents
// that came of exactly that.
const DJANGO_NOW = "2026-09-05 19:28:08.853000";
const NOW = new Date("2026-09-05T19:28:08.853Z");

const SALISBURY = 22;
const DUNDEE = 23;
const CRAWL_SET = 7;

interface FoodbankSeed {
  id?: number;
  slug?: string;
  name?: string;
  country?: string;
  charity_number?: string | null;
  charity_id?: string | null;
  charity_name?: string | null;
}

function seedFoodbank(seed: FoodbankSeed = {}): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_number, charity_just_foodbank, charity_id, charity_name,
       contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs, created, modified
     ) VALUES (?, ?, ?, ?, '1 Bemerton Heath', 'SP2 9DY', ?, '51.0688,-1.7945', ?, 0, ?, ?, 'info@example.test', 'https://example.test/', 'https://example.test/need/', 0, 0, 0, 14, ?, ?)`,
  ).run(
    seed.id ?? SALISBURY,
    `uuid-${seed.slug ?? "salisbury"}`,
    seed.name ?? "Salisbury Foodbank",
    seed.slug ?? "salisbury",
    seed.country ?? "England",
    seed.charity_number === undefined ? "1122447" : seed.charity_number,
    seed.charity_id === undefined ? "ORG-1122447" : seed.charity_id,
    seed.charity_name === undefined ? "SALISBURY FOODBANK" : seed.charity_name,
    DJANGO_NOW,
    DJANGO_NOW,
  );
}

/** The CrawlSet the charityinfo cron opened (scheduled/index.ts:214-241): ONE per nightly run, shared by all three charity queues. */
function seedCrawlSet(remaining: number, id = CRAWL_SET): void {
  db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, expected, remaining) VALUES (?, 'charity', ?, ?, ?, ?)").run(id, `charity-${id}`, DJANGO_NOW, remaining, remaining);
}

function message(overrides: Partial<CharityMessage> = {}): CharityMessage {
  return { crawlSetId: CRAWL_SET, foodbankId: SALISBURY, slug: "salisbury", ...overrides };
}

interface CrawlItemRow {
  id: number;
  crawl_set_id: number | null;
  crawl_type: string;
  start: string;
  finish: string | null;
  foodbank_id: number;
  url: string | null;
}

function crawlItems(): CrawlItemRow[] {
  return db.prepare("SELECT id, crawl_set_id, crawl_type, start, finish, foodbank_id, url FROM crawlitem ORDER BY id").all() as unknown as CrawlItemRow[];
}

interface CrawlSetRow {
  id: number;
  expected: number | null;
  remaining: number | null;
  finish: string | null;
}

function crawlSet(id = CRAWL_SET): CrawlSetRow {
  return db.prepare("SELECT id, expected, remaining, finish FROM crawlset WHERE id = ?").get(id) as unknown as CrawlSetRow;
}

function foodbankRow(id = SALISBURY): Record<string, unknown> {
  return db.prepare("SELECT * FROM foodbank WHERE id = ?").get(id) as Record<string, unknown>;
}

function charityYears(foodbankId = SALISBURY): { date: string; income: number; expenditure: number; created: string }[] {
  return db.prepare("SELECT date, income, expenditure, created FROM charityyear WHERE foodbank_id = ? ORDER BY date DESC").all(foodbankId) as unknown as {
    date: string;
    income: number;
    expenditure: number;
    created: string;
  }[];
}

/** Queue a reply for one exact URL; anything else gets `defaultReply`. */
function replyTo(url: string, reply: Reply): void {
  replies.set(url, reply);
}

/** A full England & Wales payload in opencharities.uk's shape, as OpenCharity declares it. */
function ewPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "Salisbury Foodbank",
    legal_form: "CIO - Association",
    date_registered: "2011-03-14",
    postcode: "SP2 9DY",
    website: "https://salisbury.example",
    activities: "Providing three days of emergency food to people in crisis",
    classifications: [
      { type: "What", description: "Food Banks" },
      // A non-"What" classification. It must NOT reach charity_purpose -- a
      // filter that did nothing would pass any fixture carrying only "What".
      { type: "Who", description: "People In Poverty" },
      { type: "Where", description: "Wiltshire" },
      { type: "What", description: "Relief Of Poverty" },
    ],
    financial_years: [
      { end: "2024-03-31", income: 412000, expenditure: 398000 },
      { end: "2023-03-31", income: 355000, expenditure: 340000 },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  // Date only, not setTimeout: crawlOpenCharities arms a real
  // AbortSignal.timeout(20_000) and faking the clock underneath it buys
  // nothing. Freezing Date is what makes the exact `start`/`finish`/
  // `last_charity_check` assertions below possible at all.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(MIGRATIONS_SQL);

  failOn = null;
  sessionModes = [];
  errors = [];
  logs = [];
  fetchCalls = [];
  replies = new Map();
  defaultReply = { status: 200, body: "{}" };

  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String)));
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    fetchCalls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, signal: init.signal });
    const reply = replies.get(url) ?? defaultReply;
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, { status: reply.status });
  });

  env = {
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session();
      },
    },
  } as unknown as Env;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

// ===========================================================================
// THE EXPORT ITSELF
//
// index.ts:36-37 does `case "charity-ew": return handleCharityEwQueue(batch,
// env)`, with the batch cast to `any`, so nothing typechecks the shape of this
// export against the call site. These are the cheap assertions that would have
// caught it being the wrong kind of thing entirely.
// ===========================================================================
describe("handleCharityEwQueue", () => {
  it("is a two-argument async handler, not a factory awaiting its arguments", () => {
    expect(typeof handleCharityEwQueue).toBe("function");
    // (batch, env). A three-argument handler would mean the module had been
    // wired to something expecting `ctx`, which index.ts never passes.
    expect(handleCharityEwQueue.length).toBe(2);
  });

  it("resolves to undefined, because index.ts returns its promise straight to the runtime", async () => {
    seedFoodbank();
    seedCrawlSet(1);

    await expect(handleCharityEwQueue(batchOf([message()]).batch, env)).resolves.toBeUndefined();
  });

  // Three files, one factory, and the only difference between them is a string.
  // If charityEw.ts ever re-exported a sibling's handler -- the natural outcome
  // of copying charityNi.ts and editing only the export name -- these three
  // would be the same object and E&W's messages would be logged under NI's
  // name forever.
  it("is its own closure, distinct from the Scotland and NI consumers", () => {
    expect(handleCharityEwQueue).not.toBe(handleCharityScotlandQueue);
    expect(handleCharityEwQueue).not.toBe(handleCharityNiQueue);
  });

  // The handler is a module-scope const, built once when the isolate loads and
  // reused for every batch that isolate ever handles. It must therefore carry
  // no state between invocations -- here a batch that FAILED is followed by a
  // batch that must succeed on the same closure.
  it("carries no state between batches, having been built once at module load", async () => {
    seedFoodbank();
    seedCrawlSet(2);

    // Message one: the food bank does not exist, so it retries.
    const first = batchOf([message({ foodbankId: 999, slug: "vanished" })]);
    await handleCharityEwQueue(first.batch, env);
    expect(first.retries).toHaveLength(1);

    // Message two, same closure, is unaffected.
    const second = batchOf([message()]);
    await handleCharityEwQueue(second.batch, env);

    expect(second.acks).toEqual([0]);
    expect(second.retries).toEqual([]);
    expect(crawlSet().remaining).toBe(1);
  });
});

// ===========================================================================
// THE QUEUE LABEL
//
// The label appears in exactly one place -- the console.error the factory
// writes before retrying -- and that log line is the entire incident report for
// a queue nobody watches. Getting it wrong costs no data and is invisible in
// every other test, which is why it is asserted here as an exact string.
// ===========================================================================
describe("the queue label it was built with", () => {
  beforeEach(() => {
    seedCrawlSet(3);
  });

  it('logs failures as "charity-ew", with the food bank id and slug from the message', async () => {
    // The food bank was deleted between the cron's enqueue and this dequeue --
    // the one failure that needs no mocking at all.
    await handleCharityEwQueue(batchOf([message({ foodbankId: 999, slug: "vanished" })]).batch, env);

    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe("charity-ew: message failed for foodbank 999 (vanished)");
    // The cause travels with it, or the retry is unexplainable at 2am.
    expect(errors[0]![1]).toContain("charity: foodbank 999 (vanished) no longer exists");
  });

  // THE COPY-PASTE MUTANT, killed directly: charityEw.ts built with
  // "charity-ni" or "charity-scotland". All three handlers are given the SAME
  // impossible message, so the only thing that can differ in the output is the
  // string each module passed the factory.
  it("is unique among the three charity consumers for one identical failure", async () => {
    const gone = message({ foodbankId: 999, slug: "vanished" });

    await handleCharityEwQueue(batchOf([gone]).batch, env);
    await handleCharityScotlandQueue(batchOf([gone], "charity-scotland").batch, env);
    await handleCharityNiQueue(batchOf([gone], "charity-ni").batch, env);

    expect(errors.map((line) => line[0])).toEqual([
      "charity-ew: message failed for foodbank 999 (vanished)",
      "charity-scotland: message failed for foodbank 999 (vanished)",
      "charity-ni: message failed for foodbank 999 (vanished)",
    ]);
  });

  // The label describes the QUEUE, not the register that was crawled. A
  // Scottish food bank reaching this consumer (see the next block for how)
  // still logs as charity-ew, because charity-ew is where the message will be
  // redelivered and charity-ew-dlq is where it will eventually land.
  it("stays charity-ew even when the row being crawled is Scottish", async () => {
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland", charity_number: "SC012345" });
    failOn = /UPDATE foodbank SET/;

    await handleCharityEwQueue(batchOf([message({ foodbankId: DUNDEE, slug: "dundee" })]).batch, env);

    expect(errors[0]![0]).toBe("charity-ew: message failed for foodbank 23 (dundee)");
  });
});

// ===========================================================================
// WIRED TO THE REAL CRAWLER
//
// The second constructor argument. Every assertion below reads a ROW back:
// a handler wired to a no-op fetcher would still open and close its crawlitem,
// still decrement the counter and still ack -- and would leave every charity
// field on the site frozen at whatever the last working crawl wrote, which is
// precisely the silent failure this tier exists for.
// ===========================================================================
describe("the England & Wales crawl, end to end", () => {
  beforeEach(() => {
    seedCrawlSet(2);
  });

  it("fetches opencharities and writes every charity column and financial year", async () => {
    seedFoodbank({ charity_name: "STALE NAME" });
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: ewPayload() });

    const { batch, acks, retries } = batchOf([message()]);
    await handleCharityEwQueue(batch, env);

    // ONE GET, to the E&W register, for this food bank's number. The
    // per-country split buys retry isolation only; the endpoint is the same
    // opencharities.uk host for all three (crawlOpenCharities.ts:12-14).
    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ew/1122447.json"]);
    // opencharities is a small independent mirror; identifying the crawler is
    // the difference between being rate-limited politely and being blocked.
    expect(fetchCalls[0]!.headers["User-Agent"]).toBe("Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)");
    // Without the 20s AbortSignal.timeout a hung connection holds a consumer
    // slot (max_concurrency 10) until the invocation itself is killed.
    expect(fetchCalls[0]!.signal).toBeInstanceOf(AbortSignal);

    const row = foodbankRow();
    expect(row.charity_name).toBe("Salisbury Foodbank");
    expect(row.charity_type).toBe("CIO - Association");
    expect(row.charity_reg_date).toBe("2011-03-14");
    expect(row.charity_postcode).toBe("SP2 9DY");
    expect(row.charity_website).toBe("https://salisbury.example");
    // E&W purpose is the "What" classifications, one per line WITH a trailing
    // newline -- crawlers.py:137-138 built the string by `+= desc + "\n"` and
    // the port keeps that shape byte for byte. The "Who" and "Where" rows in
    // the fixture must not appear.
    expect(row.charity_purpose).toBe("Food Banks\nRelief Of Poverty\n");
    expect(row.charity_objectives).toBe("Providing three days of emergency food to people in crisis");
    // Django format, not toISOString: this column is TEXT and is compared
    // against Django-written values.
    expect(row.last_charity_check).toBe(DJANGO_NOW);

    expect(charityYears()).toEqual([
      { date: "2024-03-31", income: 412000, expenditure: 398000, created: DJANGO_NOW },
      { date: "2023-03-31", income: 355000, expenditure: 340000, created: DJANGO_NOW },
    ]);

    // ...and the bookkeeping bracket closed around all of it.
    const items = crawlItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.crawl_type).toBe("charity");
    expect(items[0]!.foodbank_id).toBe(SALISBURY);
    expect(items[0]!.start).toBe(DJANGO_NOW);
    expect(items[0]!.finish).toBe(DJANGO_NOW);
    // MUTANT KILLED: `url: msg.slug` in queues/charity.ts's insertCrawlItem
    // call. It survived every other assertion in this file, because nothing
    // read the column back. Django DID store a URL here -- each regulator
    // crawler passed the API endpoint it was about to call (crawlers.py:116,
    // :184, :243) -- and the port deliberately stores NULL, because
    // opencharities' URL is derivable from the row and there is only one of
    // it. It is not cosmetic: admin/crawl_set.njk:55 renders this column as an
    // `<a href>`, so a slug landing here becomes a broken link on the crawl
    // set page rather than the empty cell that means "nothing to link to".
    expect(items[0]!.url).toBeNull();
    expect(crawlSet().remaining).toBe(1);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  // Wales shares E&W's register (crawlers.py:93 `if country in ["England",
  // "Wales"]`), and the cron enqueues both into this queue
  // (scheduled/index.ts:230). A COUNTRY_CODE map that had only "England" would
  // pass every other test in this file.
  it("sends a Welsh food bank to the same ew register", async () => {
    seedFoodbank({ slug: "cardiff", name: "Cardiff Foodbank", country: "Wales", charity_number: "1105036" });

    await handleCharityEwQueue(batchOf([message({ slug: "cardiff" })]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ew/1105036.json"]);
  });

  // charity_id used to hold the Charity Commission's own organisation_number
  // (crawlers.py:129) and OSCR's id (crawlers.py:196); opencharities publishes neither, so
  // crawlOpenCharities.ts:194-200 deliberately leaves the column alone. If a
  // later edit ever "helpfully" wrote the charity number into it, the column
  // would silently change meaning for every food bank on the next nightly run.
  it("leaves charity_id exactly as the last regulator crawl left it", async () => {
    seedFoodbank({ charity_id: "ORG-1122447" });
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: ewPayload() });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(foodbankRow().charity_id).toBe("ORG-1122447");
  });

  // A register free-text field reading "n/a" would render as a link to
  // https://n/a on the food bank page. crawlOpenCharities.ts:96-108 treats the
  // known placeholders as absent; NULL is what the template checks for.
  it("stores a placeholder website as NULL rather than as a link", async () => {
    seedFoodbank();
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: ewPayload({ website: " N/A " }) });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(foodbankRow().charity_website).toBeNull();
    // ...and the rest of the patch still landed, so the placeholder guard is
    // not silently discarding the whole response.
    expect(foodbankRow().charity_name).toBe("Salisbury Foodbank");
  });

  // MUTANT KILLED: `return value` in place of `return trimmed` at the end of
  // websiteOrNull. The placeholder test above proves only that the value is
  // trimmed BEFORE the placeholder comparison -- it asserts NULL, so it can
  // say nothing about what a surviving value is stored as, and the mutant
  // passed the entire file. A register field padded with whitespace (the
  // registers are free text, and opencharities passes them through unaltered)
  // would then be written verbatim, and the food bank page renders
  // charity_website straight into an href.
  it("stores a padded website trimmed rather than verbatim", async () => {
    seedFoodbank();
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: ewPayload({ website: "  https://salisbury.example  " }) });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(foodbankRow().charity_website).toBe("https://salisbury.example");
  });

  // A financial year with no end date has nothing to key on; Django wrote
  // `year.get("financial_period_end_date").replace(...)` and would have thrown
  // on a null, so there is no stored precedent for a NULL-dated row. Dropped.
  it("drops a financial year that has no end date", async () => {
    seedFoodbank();
    replyTo("https://opencharities.uk/ew/1122447.json", {
      status: 200,
      body: ewPayload({ financial_years: [{ end: "2024-03-31", income: 1, expenditure: 2 }, { end: null, income: 3, expenditure: 4 }, { income: 5, expenditure: 6 }] }),
    });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2024-03-31", income: 1, expenditure: 2, created: DJANGO_NOW }]);
  });

  // A missing income/expenditure becomes 0, matching crawlers.py:158-159's
  // `year.get("income", 0)`. Storing NULL instead would break the charity
  // financials table, which sums these columns.
  it("defaults a missing income or expenditure to zero, as Django did", async () => {
    seedFoodbank();
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: ewPayload({ financial_years: [{ end: "2024-03-31" }] }) });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2024-03-31", income: 0, expenditure: 0, created: DJANGO_NOW }]);
  });

  // PLAN.md §8.7.1's whole point, and a DELIBERATE divergence from Django:
  // crawlers.py:147 deletes CharityYear rows BEFORE fetching the replacements,
  // so a register that answers 200 with no financial history empties the table.
  // Here the rows are only replaced when there are rows to replace them with,
  // so a thin response leaves last year's history on the page.
  it("keeps the existing financial years when the response carries none", async () => {
    seedFoodbank();
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2023-03-31', 355000, 340000, ?)").run(SALISBURY, DJANGO_NOW);
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: ewPayload({ financial_years: [] }) });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2023-03-31", income: 355000, expenditure: 340000, created: DJANGO_NOW }]);
    // The rest of the crawl still happened -- this is not an early return.
    expect(foodbankRow().charity_name).toBe("Salisbury Foodbank");
  });

  // replaceCharityYears deletes by foodbank_id before reinserting. A DELETE
  // that lost its WHERE would empty every other food bank's history, and
  // nothing would notice until somebody looked at a charity page months later.
  it("replaces only this food bank's years, not the whole table", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland", charity_number: "SC012345" });
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2020-03-31', 1, 2, ?)").run(SALISBURY, DJANGO_NOW);
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2020-03-31', 3, 4, ?)").run(DUNDEE, DJANGO_NOW);
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: ewPayload({ financial_years: [{ end: "2024-03-31", income: 9, expenditure: 8 }] }) });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2024-03-31", income: 9, expenditure: 8, created: DJANGO_NOW }]);
    expect(charityYears(DUNDEE)).toEqual([{ date: "2020-03-31", income: 3, expenditure: 4, created: DJANGO_NOW }]);
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // An empty 200 (`{}`) is what a mirror answers for a page it holds but has
  // no data for. Every field it does not carry is written as NULL, which is a
  // REAL data loss: an E&W charity whose response goes thin blanks its own name
  // on the site. Django could not do this -- crawlers.py:126-128 assigns only
  // inside `if response.status_code == 200:` AND `if data:`, and an empty dict
  // is falsy in Python, so a `{}` response left every field alone. The port
  // builds the patch object unconditionally from `data.name ?? null`.
  it("nulls the charity columns when a 200 carries no fields -- pinned, not endorsed", async () => {
    seedFoodbank({ charity_name: "SALISBURY FOODBANK" });
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: "{}" });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    const row = foodbankRow();
    expect(row.charity_name).toBeNull();
    expect(row.charity_type).toBeNull();
    // E&W purpose is the one exception: an empty classifications list yields
    // "" rather than NULL, because purposeFor returns a string either way.
    expect(row.charity_purpose).toBe("");
    expect(row.last_charity_check).toBe(DJANGO_NOW);
  });

  it("logs nothing at all on a clean run -- a quiet queue is a working queue", async () => {
    seedFoodbank();
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: ewPayload() });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
  });

  // Every packages/db call goes through the Sessions API because D1 has read
  // replication on and a bare prepare() can land on a stale replica. ONE
  // session per MESSAGE: read-your-writes only holds inside a session, and the
  // insert-then-patch-then-close sequence for one food bank must all be in one.
  it("opens one first-unconstrained session per message", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Wales", charity_number: "1105036" });

    await handleCharityEwQueue(batchOf([message(), message({ foodbankId: DUNDEE, slug: "dundee" })]).batch, env);

    expect(sessionModes).toEqual(["first-unconstrained", "first-unconstrained"]);
  });
});

// ===========================================================================
// THE REGISTER COMES FROM THE ROW, NOT FROM THE QUEUE
//
// Django had no queues: foodbank_charity_crawl (crawlers.py:79-101, read
// directly) branched on `foodbank.country` inside one synchronous loop. The
// port keeps that branch inside crawlOpenCharities and puts the country split
// in the PRODUCER (scheduled/index.ts:219-232, and routes/admin/
// foodbankForceCrawl.ts:111 for a manual crawl),
// so this consumer will faithfully crawl whatever register the row's country
// names -- which is what makes a mid-flight country correction, or a hand-
// enqueued message, do the right thing instead of hitting the wrong register.
// ===========================================================================
describe("a row whose country is not England or Wales", () => {
  beforeEach(() => {
    seedCrawlSet(2);
  });

  // The row is re-read at dequeue time precisely because the cron's snapshot
  // can go stale in the drain window; an admin fixing a wrongly-recorded
  // country is exactly that. It must follow the row.
  it("is crawled against Scotland's register, with OSCR's quoted arrays split into lines", async () => {
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland", charity_number: "SC012345" });
    replyTo("https://opencharities.uk/sc/SC012345.json", {
      status: 200,
      body: JSON.stringify({
        name: "Dundee Foodbank",
        // Scotland's purpose is OSCR's purposes array (crawlers.py:202-203),
        // arriving comma-joined and quoted. The SECOND purpose here carries an
        // INTERNAL COMMA, which is the whole reason toLines looks for the
        // quotes at all -- see the assertion below.
        purposes: "'The prevention or relief of poverty','The advancement of health, education and citizenship'",
        // ...and its objectives are the separate objectives field
        // (crawlers.py:204), which is free text and is stored verbatim.
        objectives: "To relieve poverty in Dundee, and to advance education",
      }),
    });

    await handleCharityEwQueue(batchOf([message({ foodbankId: DUNDEE, slug: "dundee" })]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/sc/SC012345.json"]);
    const row = foodbankRow(DUNDEE);
    // TWO lines, and the comma inside the second purpose SURVIVES.
    //
    // MUTANT KILLED: `const quoted = trimmed.startsWith("'") && false` in
    // toLines -- i.e. the quoted-array detection deleted, leaving every value
    // split on a bare comma. The fixture this test used to carry ('a','b' with
    // no internal punctuation) could not tell the two apart, because splitting
    // `'a','b'` on "," and on "','" both yield two items once the quotes are
    // stripped. The quoting is OSCR's, and it exists precisely BECAUSE its
    // purposes contain commas, so the mutant's real cost is a Scottish food
    // bank's purpose fragmenting mid-sentence across two lines on its page.
    //
    // NO trailing newline, where E&W's purpose has one and where Django's
    // Scottish loop appended one per item (`charity_purpose += item + "\n"`,
    // crawlers.py:202-203). toLines joins instead of appending, so a Scottish
    // charity_purpose read straight out of D1 is one byte shorter than the
    // Django-written value it replaces. Nothing renders it whitespace-
    // sensitively; pinned so the difference is a decision on the record.
    expect(row.charity_purpose).toBe("The prevention or relief of poverty\nThe advancement of health, education and citizenship");
    // The comma inside the objectives text is untouched: only `purposes` is
    // split, and a single fallback chain over both fields would be wrong.
    expect(row.charity_objectives).toBe("To relieve poverty in Dundee, and to advance education");
  });

  // Foodbank.open_charities_url() (models/foodbank.py:339-348) strips the "NIC"
  // prefix because the register's own numbers do not carry it. The strip lives
  // in the crawler, so it only happens if `country` survives the round trip
  // through D1 as "Northern Ireland".
  it("is crawled against NI's register with the NIC prefix stripped", async () => {
    seedFoodbank({ country: "Northern Ireland", charity_number: "NIC101234" });
    replyTo("https://opencharities.uk/ni/101234.json", {
      status: 200,
      body: JSON.stringify({
        name: "Newry Foodbank",
        // NI's purpose is the CSV's "What the charity does"
        // (crawlers.py:267-270), bare comma-separated -- and with a TRAILING
        // comma, the ordinary shape of a value lifted out of a CSV column.
        what_charity_does: "The prevention or relief of poverty,The advancement of citizenship,",
        // ...and its objectives are the "Charitable purposes" text
        // (crawlers.py:266) -- Django's own comment there reads "Objectives and
        // purposes are reversed in NI". Not split; the two fields mean opposite
        // things per register, which is why a single fallback chain would be
        // both shorter and wrong.
        purposes: "To relieve financial hardship in the Newry area",
      }),
    });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/101234.json"]);
    const row = foodbankRow();
    // TWO lines and no trailing blank one.
    //
    // MUTANT KILLED: toLines' `.filter(Boolean)` deleted. With the old fixture
    // (no trailing comma) the filter was dead code and the mutant survived the
    // whole file; with one, dropping it stores "...citizenship\n" and the food
    // bank's page grows an empty bullet under its purposes.
    expect(row.charity_purpose).toBe("The prevention or relief of poverty\nThe advancement of citizenship");
    expect(row.charity_objectives).toBe("To relieve financial hardship in the Newry area");
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // Django split NI's "What the charity does" on `re.sub(r",(?!\s)", "\n", ...)`
  // (crawlers.py:269): a comma NOT followed by whitespace. That negative
  // lookahead is deliberate -- it is what keeps the commas INSIDE a listed
  // purpose ("poverty, sickness or the effects of old age", the regulator's own
  // stock wording) from becoming line breaks. crawlOpenCharities' toLines
  // splits on EVERY bare comma, so that one purpose becomes two lines on the
  // food bank's page.
  //
  // VERIFIED BY RUNNING CPYTHON, not by reading the regex: python3 3.13.0 on
  // this machine turns the string below into TWO lines, where the port below
  // produces THREE. The port's own header claims the two formats differ only in
  // how the list is joined, which this contradicts.
  //
  // It has never bitten in production because crawlNi.ts recorded the NI CSV
  // endpoint 404ing, so Django has been storing nothing for NI at all -- this
  // port is the first code to write these rows. Asserted as the port does it.
  it("splits an NI purpose on a comma Django deliberately kept -- suspect, pinned", async () => {
    seedFoodbank({ country: "Northern Ireland", charity_number: "NIC101234" });
    replyTo("https://opencharities.uk/ni/101234.json", {
      status: 200,
      body: JSON.stringify({ name: "Newry Foodbank", what_charity_does: "The prevention or relief of poverty, sickness or the effects of old age,The advancement of education" }),
    });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(foodbankRow().charity_purpose).toBe("The prevention or relief of poverty\nsickness or the effects of old age\nThe advancement of education");
  });

  // Isle of Man has one food bank and no register anywhere --
  // crawlers.py:100-101's `else: return False`, reproduced. The cron never
  // enqueues it (it fans out three named country lists), but an admin
  // force-crawl or a hand-replayed message must not wedge the queue: no fetch,
  // no patch, and the message still acks and closes cleanly.
  it("acks without fetching when the country has no register at all", async () => {
    seedFoodbank({ country: "Isle of Man", charity_name: "PEEL FOODBANK" });

    const { batch, acks, retries } = batchOf([message()]);
    await handleCharityEwQueue(batch, env);

    expect(fetchCalls).toEqual([]);
    expect(foodbankRow().charity_name).toBe("PEEL FOODBANK");
    expect(foodbankRow().last_charity_check).toBeNull();
    expect(logs).toContain("charity: no register for country Isle of Man (salisbury)");
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    // The crawlitem is still opened AND closed, and the counter still moves --
    // otherwise one un-crawlable food bank would hold the whole nightly
    // CrawlSet open forever.
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(1);
  });
});

// ===========================================================================
// THE CHARITY NUMBER ON THE ROW
// ===========================================================================
describe("the charity number the URL is built from", () => {
  beforeEach(() => {
    seedCrawlSet(2);
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // Django's foodbank_charity_crawl opens with `if not foodbank.charity_number:
  // return False` (crawlers.py:89-90), BEFORE any HTTP call and before any
  // CrawlItem is created -- and Foodbank.open_charities_url() has the same
  // guard again (models/foodbank.py:340-341, `return None`), so Django would
  // not build this URL by either route. The port has no such guard: the number
  // is
  // interpolated as an empty string, so a food bank whose charity number was
  // cleared between the cron's enqueue and this dequeue produces a GET for
  // ".json" -- a request for nothing, to a small independent mirror, once per
  // affected food bank per night.
  //
  // The blast radius is small (the cron filters `charity_number IS NOT NULL AND
  // != ''` at enqueue time, so only a mid-run edit reaches here) and the 404
  // path below then patches nothing, so it costs a wasted request rather than
  // data. Asserted as it is.
  it("issues a request with an empty path segment when the number has been cleared", async () => {
    seedFoodbank({ charity_number: null });

    const { batch, acks } = batchOf([message()]);
    await handleCharityEwQueue(batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ew/.json"]);
    expect(acks).toEqual([0]);
    // ...and, unlike Django, a crawlitem row exists for the attempt.
    expect(crawlItems()).toHaveLength(1);
    expect(crawlSet().remaining).toBe(1);
  });

  // encodeURIComponent, not raw interpolation. Charity numbers are typed into
  // an admin form by hand, and a stray slash would otherwise reach a different
  // path on opencharities.uk entirely.
  it("percent-encodes a number that would otherwise change the path", async () => {
    seedFoodbank({ charity_number: "1122447/1" });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ew/1122447%2F1.json"]);
  });

  // The NI strip is `.replace("NIC", "")` -- a plain string replace, so it is
  // case-sensitive and unanchored. A lowercase "nic" prefix (an admin typo the
  // form does not reject) is passed through intact and 404s. Pinned as the
  // behaviour, since the fix is a source change and this file does not make
  // them.
  it("does not strip a lowercase nic prefix", async () => {
    seedFoodbank({ country: "Northern Ireland", charity_number: "nic101234" });

    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/nic101234.json"]);
  });
});

// ===========================================================================
// AN EXTERNAL FAILURE MUST NEVER RETRY
//
// This is the contract queues/charity.ts's header rests on and the reason the
// pairing in charityEw.ts is safe at all: crawlOpenCharities swallows every
// external-API failure, so the factory's catch is reserved for genuine D1
// failures. If a non-200 ever started throwing, every charity number that has
// moved or been removed would burn three retries at 60s and land in
// charity-ew-dlq -- and the crawler's own header records 2 of the 80 food banks
// it verified 404ing, so that is a nightly occurrence, not a hypothetical. A
// dead-letter queue filling up unnoticed is the exact incident this tier was
// written after.
// ===========================================================================
describe("when opencharities fails", () => {
  beforeEach(() => {
    seedFoodbank({ charity_name: "STALE NAME" });
    seedCrawlSet(2);
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2023-03-31', 1, 2, ?)").run(SALISBURY, DJANGO_NOW);
  });

  it("acks a 404 and leaves every existing value in place", async () => {
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 404, body: "not found" });

    const { batch, acks, retries } = batchOf([message()]);
    await handleCharityEwQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    // Nothing patched, nothing nulled -- Django's `if response.status_code ==
    // 200:` guard (crawlers.py:126) had the same effect. last_charity_check
    // staying NULL is how a food bank that has never crawled successfully stays
    // distinguishable from one that has.
    expect(foodbankRow().charity_name).toBe("STALE NAME");
    expect(foodbankRow().last_charity_check).toBeNull();
    expect(charityYears()).toHaveLength(1);
    expect(logs).toContain("charity: opencharities 404 for salisbury (ew/1122447)");
    expect(errors).toEqual([]);
    // The bookkeeping still completes, so one dead charity number cannot hold
    // the nightly CrawlSet open.
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(1);
  });

  // A 500 is transient where a 404 is not, so this one arguably SHOULD retry --
  // it does not, and the day's charity data for that food bank is simply
  // skipped. Pinned deliberately: `res.ok` draws no distinction, and changing
  // it would change the DLQ's meaning.
  it("acks a 500 exactly as it acks a 404 -- no retry for a transient outage", async () => {
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 500, body: "upstream error" });

    const { batch, acks, retries } = batchOf([message()]);
    await handleCharityEwQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(foodbankRow().charity_name).toBe("STALE NAME");
    expect(logs).toContain("charity: opencharities 500 for salisbury (ew/1122447)");
    expect(crawlSet().remaining).toBe(1);
  });

  // DNS, TLS, or the 20s AbortSignal.timeout firing. A total opencharities.uk
  // outage costs one night's charity data across all three queues and closes
  // the crawl set cleanly, rather than filling three dead-letter queues.
  it("acks when the fetch itself rejects, logging the crawler's own prefix", async () => {
    replyTo("https://opencharities.uk/ew/1122447.json", new TypeError("fetch failed"));

    const { batch, acks, retries } = batchOf([message()]);
    await handleCharityEwQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    // "charity:", not "charity-ew:" -- this is the crawler reporting a
    // swallowed failure, not the queue reporting a retry, and the two are told
    // apart by that prefix when reading logs.
    expect(errors[0]![0]).toBe("charity: opencharities fetch failed for salisbury");
    expect(errors.map((line) => line[0])).not.toContain("charity-ew: message failed for foodbank 22 (salisbury)");
    expect(foodbankRow().last_charity_check).toBeNull();
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
  });

  // A 200 carrying an HTML error page (a mirror's own 500 served with the
  // wrong status, or a captive portal) throws inside res.json(). It lands in
  // the SAME catch as a network failure and is therefore also swallowed --
  // worth pinning, because it is the one 200 that patches nothing.
  it("acks a 200 whose body is not JSON", async () => {
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: "<html>502 Bad Gateway</html>" });

    const { batch, acks, retries } = batchOf([message()]);
    await handleCharityEwQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(foodbankRow().charity_name).toBe("STALE NAME");
    expect(errors[0]![0]).toBe("charity: opencharities fetch failed for salisbury");
  });
});

// ===========================================================================
// A GENUINE D1 FAILURE MUST RETRY
//
// The other half of the same contract. These are the only inputs that reach
// the factory's catch through the real crawler.
// ===========================================================================
describe("when D1 fails mid-crawl", () => {
  beforeEach(() => {
    seedFoodbank({ charity_name: "STALE NAME" });
    seedCrawlSet(2);
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: ewPayload() });
  });

  it("retries with a 60s backoff and leaves the crawlitem open when the patch fails", async () => {
    failOn = /UPDATE foodbank SET/;

    const { batch, acks, retries } = batchOf([message()]);
    await handleCharityEwQueue(batch, env);

    expect(acks).toEqual([]);
    // The 60s is not decoration: charity-ew has max_concurrency 10, and a bare
    // retry() would redeliver instantly and hit a struggling D1 ten at a time.
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    // `finish IS NULL` is the ONLY stall signal there is (0008_needcheck.sql's
    // own comment). If this ever came back stamped, a crashed charity crawl
    // would be indistinguishable from a clean one on /admin/jobs/.
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet().remaining).toBe(2);
    expect(foodbankRow().charity_name).toBe("STALE NAME");
    expect(errors[0]![0]).toBe("charity-ew: message failed for foodbank 22 (salisbury)");
  });

  // The crawl is TWO writes and is not atomic. A failure between them leaves
  // the columns patched and the financial years stale, with the crawlitem open
  // and the message coming back -- so the redelivery is what repairs it. Pinned
  // because the half-written state is real and visible on the site until then.
  it("leaves the columns patched but the years stale when the year replace fails", async () => {
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2019-03-31', 1, 2, ?)").run(SALISBURY, DJANGO_NOW);
    failOn = /DELETE FROM charityyear/;

    const { batch, acks, retries } = batchOf([message()]);
    await handleCharityEwQueue(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toHaveLength(1);
    expect(foodbankRow().charity_name).toBe("Salisbury Foodbank");
    expect(charityYears()).toEqual([{ date: "2019-03-31", income: 1, expenditure: 2, created: DJANGO_NOW }]);
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet().remaining).toBe(2);
  });

  // The existence check is upstream of the insert, so a vanished food bank
  // leaves NO half-open crawlitem behind to be mistaken for a stall. It retries
  // three times and then reaches charity-ew-dlq, which is where charityDlq.ts
  // finally decrements the counter so the set can close.
  it("opens no crawlitem for a food bank that no longer exists", async () => {
    const { batch, acks, retries } = batchOf([message({ foodbankId: 999, slug: "vanished" })]);
    await handleCharityEwQueue(batch, env);

    expect(crawlItems()).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(crawlSet().remaining).toBe(2);
  });

  // A message body from a producer that has drifted -- or a hand-replayed one
  // pasted with a missing field. It must not take the batch down: the bind
  // throws, the message retries, and the ones after it still run.
  it("retries a malformed body rather than throwing out of the handler", async () => {
    const { batch, acks, retries } = batchOf([{ crawlSetId: CRAWL_SET, slug: "salisbury" }, message()]);

    await expect(handleCharityEwQueue(batch, env)).resolves.toBeUndefined();

    expect(retries.map((r) => r.index)).toEqual([0]);
    expect(acks).toEqual([1]);
    expect(crawlSet().remaining).toBe(1);
  });
});

// ===========================================================================
// THE BATCH
//
// wrangler.jsonc gives charity-ew max_batch_size 5. Every message in a batch is
// independent: a queue consumer that let one bad message abort the loop would
// silently drop up to four food banks per failure, and they would look crawled
// (no error, no DLQ entry) because nothing would ever have been enqueued twice.
// ===========================================================================
describe("a batch of several messages", () => {
  beforeEach(() => {
    seedCrawlSet(5);
  });

  it("processes every message even when one in the middle fails", async () => {
    seedFoodbank({ id: 1, slug: "bath", name: "Bath Foodbank", charity_number: "1122001" });
    seedFoodbank({ id: 3, slug: "corby", name: "Corby Foodbank", charity_number: "1122003" });
    replyTo("https://opencharities.uk/ew/1122001.json", { status: 200, body: JSON.stringify({ name: "Bath Foodbank" }) });
    replyTo("https://opencharities.uk/ew/1122003.json", { status: 200, body: JSON.stringify({ name: "Corby Foodbank" }) });

    const { batch, acks, retries } = batchOf([
      message({ foodbankId: 1, slug: "bath" }),
      message({ foodbankId: 2, slug: "deleted-yesterday" }),
      message({ foodbankId: 3, slug: "corby" }),
    ]);
    await handleCharityEwQueue(batch, env);

    expect(acks).toEqual([0, 2]);
    expect(retries.map((r) => r.index)).toEqual([1]);
    expect(foodbankRow(1).charity_name).toBe("Bath Foodbank");
    expect(foodbankRow(3).charity_name).toBe("Corby Foodbank");
    // Two food banks crawled, so the counter moved twice and not three times.
    expect(crawlSet().remaining).toBe(3);
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([1, 3]);
  });

  // Sequential, not Promise.all: the loop awaits each message, which is what
  // keeps a batch of 5 from opening 5 concurrent D1 sessions and 5 concurrent
  // GETs against one small mirror at max_concurrency 10.
  it("crawls the messages in the order they arrive, one at a time", async () => {
    for (const [id, slug] of [
      [1, "bath"],
      [2, "corby"],
      [3, "dover"],
    ] as const) {
      seedFoodbank({ id, slug, name: `${slug} Foodbank`, charity_number: `112200${id}` });
    }

    const { batch, acks } = batchOf([message({ foodbankId: 1, slug: "bath" }), message({ foodbankId: 2, slug: "corby" }), message({ foodbankId: 3, slug: "dover" })]);
    await handleCharityEwQueue(batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://opencharities.uk/ew/1122001.json",
      "https://opencharities.uk/ew/1122002.json",
      "https://opencharities.uk/ew/1122003.json",
    ]);
    expect(acks).toEqual([0, 1, 2]);
    // One session per message, each one unconstrained -- the mode matters as
    // much as the count, and a length check would pass on three sessions
    // opened against the primary.
    expect(sessionModes).toEqual(["first-unconstrained", "first-unconstrained", "first-unconstrained"]);
  });
});

// ===========================================================================
// AT-LEAST-ONCE REDELIVERY
//
// Cloudflare Queues guarantees at-least-once, so the same message body WILL
// arrive twice. Whether that is harmless is decided entirely by insertCrawlItem
// (an upsert on crawlitem_crawlset_foodbank_uniq) and finishCrawlItem's
// `finish IS NULL` guard -- and if it were not harmless, remaining would go
// down twice for one food bank and the CrawlSet would stamp `finish` while food
// banks were still being crawled.
// ===========================================================================
describe("when the same message is delivered twice", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(2);
    replyTo("https://opencharities.uk/ew/1122447.json", { status: 200, body: ewPayload() });
  });

  it("keeps one crawlitem, decrements once, and leaves one set of financial years", async () => {
    await handleCharityEwQueue(batchOf([message()]).batch, env);
    const second = batchOf([message()]);
    await handleCharityEwQueue(second.batch, env);

    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(1);
    expect(second.acks).toEqual([0]);
    expect(second.retries).toEqual([]);
    // replaceCharityYears deletes before reinserting, so a redelivery must not
    // double the rows -- the charity financials table sums this column. The
    // VALUES, not the count: a length check passes just as happily on two rows
    // whose income has been overwritten with the wrong year's.
    expect(charityYears()).toEqual([
      { date: "2024-03-31", income: 412000, expenditure: 398000, created: DJANGO_NOW },
      { date: "2023-03-31", income: 355000, expenditure: 340000, created: DJANGO_NOW },
    ]);
  });

  // Pinning a real cost, not endorsing it: the crawler runs AGAIN on a
  // redelivery, before finishCrawlItem gets the chance to report the item was
  // already closed. That is a second GET to opencharities.uk and a second
  // identical patch -- harmless, but paid for, and it is why the crawler's
  // ~831 daily requests are a floor rather than a total.
  it("re-fetches opencharities on the redelivery", async () => {
    await handleCharityEwQueue(batchOf([message()]).batch, env);
    await handleCharityEwQueue(batchOf([message()]).batch, env);

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ew/1122447.json", "https://opencharities.uk/ew/1122447.json"]);
  });

  // Both copies inside ONE batch, which max_batch_size 5 makes possible, must
  // behave the same as two batches.
  it("survives both copies arriving in the same batch", async () => {
    const { batch, acks, retries } = batchOf([message(), message()]);

    await handleCharityEwQueue(batch, env);

    expect(crawlItems()).toHaveLength(1);
    expect(crawlSet().remaining).toBe(1);
    expect(acks).toEqual([0, 1]);
    expect(retries).toEqual([]);
  });

  // The uniqueness is (crawl_set_id, foodbank_id), so TONIGHT's run for the
  // same food bank must open its own row rather than reopening last night's --
  // otherwise the crawl history collapses to one row per food bank forever.
  it("opens a fresh crawlitem under the next night's crawlset", async () => {
    seedCrawlSet(1, 8);

    await handleCharityEwQueue(batchOf([message()]).batch, env);
    await handleCharityEwQueue(batchOf([message({ crawlSetId: 8 })]).batch, env);

    expect(crawlItems().map((row) => row.crawl_set_id)).toEqual([CRAWL_SET, 8]);
    expect(crawlSet(CRAWL_SET).remaining).toBe(1);
    // The second set was the last message it expected, so it closed.
    expect(crawlSet(8).remaining).toBe(0);
    expect(crawlSet(8).finish).toBe(DJANGO_NOW);
  });

  // A charity CrawlSet is fanned out across all THREE queues carrying the same
  // crawlSetId (scheduled/index.ts:207-213's own comment), so whichever consumer happens to
  // handle the last food bank is the one that stamps `finish`. This asserts
  // charity-ew can be that one -- if it could not, a night whose final message
  // happened to be English would leave the set open forever.
  it("closes the shared crawlset when it handles the last food bank of the night", async () => {
    seedCrawlSet(1, 9);

    await handleCharityEwQueue(batchOf([message({ crawlSetId: 9 })]).batch, env);

    expect(crawlSet(9).remaining).toBe(0);
    expect(crawlSet(9).finish).toBe(DJANGO_NOW);
    // The set this message did NOT belong to is untouched -- a decrement that
    // ignored crawlSetId would pass every test that seeds only one set.
    expect(crawlSet(CRAWL_SET).remaining).toBe(2);
    expect(crawlSet(CRAWL_SET).finish).toBeNull();
  });
});
