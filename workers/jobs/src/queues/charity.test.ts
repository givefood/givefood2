import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import type { CharityCrawlFoodbankRow, Session } from "@givefood/db";
import type { Env } from "../../worker-configuration";
import { makeCharityQueueHandler, type CharityFetcher, type CharityMessage } from "./charity";
import { crawlOpenCharities } from "../charity/crawlOpenCharities";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning,
// as packages/db/src/schema.testkit.ts:35 and notify/needEmail.test.ts:6.
import { DatabaseSync } from "node:sqlite";

// queues/charity.ts -- the shared CrawlItem/CrawlSet bookkeeping behind all
// three charity queues (charity-ew / charity-scotland / charity-ni, one per
// regulator, wired up in queues/charityEw.ts, charityScotland.ts and
// charityNi.ts and dispatched from index.ts:36-47).
//
// WHY THIS FILE IS WORTH THE LENGTH. Nothing here is ever seen by a human in
// the normal case. The module is ~35 lines of pure bookkeeping around an
// injected fetcher, and every single decision it makes is about a failure
// nobody is watching:
//
//   * whether a message acks or retries, which is the only thing that decides
//     if a food bank's charity data gets another chance or silently does not;
//   * whether crawlset.remaining goes down exactly once per food bank, which
//     is the only signal that a nightly run finished at all -- the dashboards
//     read `finish IS NULL` / `remaining` and nothing else knows;
//   * whether the crawlitem row is left OPEN on a crash, which is the only
//     way a stall is ever detected (0008_needcheck.sql's own comment: "a row
//     with finish IS NULL is exactly how a stalled/crashed run is detected").
//
// Get any of those wrong and the site keeps rendering perfectly, the crawl
// keeps "succeeding", and the numbers on the crawl dashboard quietly stop
// meaning anything. That is the same shape as the incident this tier exists
// for -- a Browser Rendering credential that broke silently for a day -- so
// every test below reads a ROW back or counts an ack, never just awaits the
// handler.
//
// REAL THINGS, NOT MOCKS:
//   * node:sqlite carrying the WHOLE real migration set (MIGRATIONS_SQL, not
//     schemaFor(...)): this handler reaches foodbank, crawlitem and crawlset
//     through four shared packages/db functions, and the real crawler it is
//     wired to below reaches charityyear as well. The full schema is the only
//     fixture that cannot develop the github #51 gap where a shared query
//     starts reading one more object.
//   * the real getFoodbankForCharityCrawl / insertCrawlItem / finishCrawlItem
//     / decrementCrawlSetRemaining -- the upsert and the `finish IS NULL`
//     guard are the entire idempotency story, so a canned double would be
//     testing the double.
//   * the real crawlOpenCharities as the injected fetcher in the last block,
//     because "the queues stay split for retry isolation only" is only true
//     if the production combination actually works end to end.
//
// MOCKED, and only this: `fetch` (opencharities.uk is the one thing that
// leaves the machine) and the MessageBatch, which is a runtime object
// Cloudflare hands in and has no local equivalent.
//
// PARITY. givefood/utils/crawlers.py at /Users/jasoncartwright/Sites/foodcharity
// was read directly for every Django claim below -- foodbank_charity_crawl
// (:79-101) and _crawl_charity_ew (:104-169), whose CrawlItem open-then-close
// bracket (:112-118 and :166-167) is what this module reproduces. The one
// divergence, `url`, is asserted as the port does it and flagged in the
// comment, not wished away. No Python was executed for this file and nothing
// below claims otherwise; the citations are line references, read.
//
// MUTATION-TESTED, 2026-09-08, in a copy of the repo outside the working tree
// (TESTING.md's "no scratch files" rule). 76 mutants were applied one at a
// time and the suite re-run against each: 33 in queues/charity.ts itself, 21
// across the four packages/db functions it drives, and 22 in the real
// crawlOpenCharities the last block wires up. Four survived the suite as it
// first stood, and the three tests carrying a "MUTANT(S) THIS KILLS" comment
// below are the ones written to close them. All 76 are now caught. The
// survivors shared one root cause worth naming, because it will recur: every
// other test in this file runs under a FROZEN clock, and a frozen clock
// cannot tell a row that was correctly left alone from one that was
// rewritten with an identical value. Anything asserting "this write did NOT
// happen a second time" has to advance the clock first.

// ===========================================================================
// HARNESS
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
 * The one SQL pattern that should blow up on the next statement that matches
 * it, standing in for a D1 outage mid-message. Mutable between deliveries so a
 * TRANSIENT failure -- fails once, succeeds on the redelivery Cloudflare Queues
 * is guaranteed to send -- can be modelled, which is the only way to reach the
 * `closed === false` branch that this module's idempotency rests on.
 */
let failOn: RegExp | null = null;

/** Every bookmark mode `withSession` was asked for, in call order. */
let sessionModes: string[] = [];

/**
 * The D1 Sessions API surface packages/db uses, over the real engine. It
 * carries SQL to node:sqlite and does nothing else -- a session that answered
 * canned rows would be a second implementation of the queries under test, and
 * the upsert / RETURNING / `WHERE finish IS NULL` behaviour those queries lean
 * on is precisely what has to be real here.
 *
 * `first()` answers null and never undefined, matching D1; `run()` reports
 * `meta.changes`, which is the entire return value of finishCrawlItem.
 *
 * FIDELITY LIMIT, stated rather than hidden: real D1 rejects an `undefined`
 * bind value at .bind() time with D1_TYPE_ERROR, whereas node:sqlite rejects it
 * at execution time with a TypeError. Both throw out of the same call inside
 * processOne, which is all the malformed-body tests below depend on, but the
 * message text differs and nothing asserts on it.
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
  /** Index plus the options object the module passed, so the 60s backoff is measured rather than assumed. */
  retries: { index: number; options: unknown }[];
}

/**
 * A MessageBatch double. Cloudflare's real one is a runtime object with no
 * local equivalent, so this records ack/retry per message index -- which is the
 * ONLY externally observable output this module has for a failed message.
 * Bodies are `unknown` so the malformed-message tests can post things the type
 * says are impossible; a queue producer in another Worker is not typechecked
 * against this consumer.
 */
function batchOf(queue: string, bodies: unknown[]): { batch: MessageBatch<CharityMessage> } & AckLog {
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

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write: a SPACE separator, six fractional
// digits, never a "T" and never a "Z". crawlitem.start/finish and
// crawlset.finish are TEXT and SQLite compares TEXT bytewise, so an ISO value
// here sorts after every same-day Django one -- see pyDatetime.ts's header for
// the two production incidents that came of exactly that.
const DJANGO_NOW = "2026-09-05 19:28:08.853000";
const NOW = new Date("2026-09-05T19:28:08.853Z");

// A SECOND, LATER tick, used only by the redelivery tests. Everything else
// here runs under a frozen clock, and a frozen clock is blind to exactly the
// mutation class this module is most exposed to: a row that was REWRITTEN on
// a redelivery is byte-identical to one that was correctly left alone when
// both writes happen at the same instant. Cloudflare redelivers minutes
// later, so the tests that turn on "was this row preserved?" advance to here
// first. Same Django spelling as above -- space separator, six fractional
// digits, no "T" -- because these values are compared against ones pyNow()
// wrote and crawlitem.start/finish are TEXT.
const DJANGO_LATER = "2026-09-05 20:00:00.000000";
const LATER = new Date("2026-09-05T20:00:00.000Z");

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

/** The CrawlSet the cron opened (scheduled/index.ts:214-240): one per nightly run, shared by all three queues. */
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
  need_id: number | null;
}

function crawlItems(): CrawlItemRow[] {
  return db.prepare("SELECT * FROM crawlitem ORDER BY id").all() as unknown as CrawlItemRow[];
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

/**
 * A fetcher that records what it was handed and, optionally, throws. Every
 * argument is captured because the whole point of the `fetcher` indirection
 * (this module's own header comment) is the boundary it defines -- and because
 * the row it receives has to be the FRESHLY READ one, not the message body.
 */
interface FetcherCall {
  env: Env;
  session: Session;
  foodbank: CharityCrawlFoodbankRow;
  /** The crawlitem rows as they stood at the moment the fetcher ran -- proves the open-then-close bracket. */
  crawlItemsAtCallTime: CrawlItemRow[];
  crawlSetAtCallTime: CrawlSetRow | undefined;
}

let fetcherCalls: FetcherCall[];

function recordingFetcher(behaviour?: (call: FetcherCall) => void): CharityFetcher {
  return async (fetcherEnv, session, foodbank) => {
    const call: FetcherCall = {
      env: fetcherEnv,
      session,
      foodbank,
      crawlItemsAtCallTime: crawlItems(),
      crawlSetAtCallTime: db.prepare("SELECT id, expected, remaining, finish FROM crawlset WHERE id = ?").get(CRAWL_SET) as unknown as CrawlSetRow | undefined,
    };
    fetcherCalls.push(call);
    behaviour?.(call);
  };
}

beforeEach(() => {
  // Date only, not setTimeout: crawlOpenCharities arms a real
  // AbortSignal.timeout(20_000) and faking the clock underneath it buys
  // nothing here. Freezing Date is what makes the exact `start`/`finish`
  // assertions below possible.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(MIGRATIONS_SQL);

  failOn = null;
  sessionModes = [];
  fetcherCalls = [];
  errors = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String)));
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));

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
// THE HAPPY PATH -- the bookkeeping is the entire product of this module
// ===========================================================================
describe("a message that succeeds", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
  });

  // Django's _crawl_charity_ew opens a CrawlItem at crawlers.py:112-118 and
  // stamps finish at :166-167, with the fetching in between; the port keeps
  // that bracket exactly, and every value below is read back off the row
  // rather than inferred from the handler resolving.
  it("opens one crawlitem, closes it, and stamps Django-format timestamps", async () => {
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch, acks, retries } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    const items = crawlItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.foodbank_id).toBe(SALISBURY);
    expect(items[0]!.crawl_set_id).toBe(CRAWL_SET);
    // "charity", not "need" or "article": the crawl dashboards group on this
    // string, and a wrong one files the row under another job silently.
    expect(items[0]!.crawl_type).toBe("charity");
    expect(items[0]!.start).toBe(DJANGO_NOW);
    expect(items[0]!.finish).toBe(DJANGO_NOW);
    expect(items[0]!.start).not.toContain("T");
    expect(items[0]!.finish).not.toContain("T");
    // charity items never attach a FoodbankChange -- finishCrawlItem is
    // called with null here, unlike needcheckRender.ts which passes a need id.
    expect(items[0]!.need_id).toBeNull();
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  // A DELIBERATE DIVERGENCE, pinned rather than wished away. Django records the
  // regulator API URL it is about to call on the CrawlItem (crawlers.py:110 +
  // :116, and again at :180/:239 for Scotland and NI). The port passes
  // `url: null` because the URL is now built inside crawlOpenCharities and this
  // module no longer knows it. Anything reading crawlitem.url for a charity row
  // gets NULL where production Django had a link.
  it("records no url on the crawlitem, unlike Django", async () => {
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    expect(crawlItems()[0]!.url).toBeNull();
  });

  // The counter is the only thing that says a nightly run finished. Django has
  // no equivalent at all -- CrawlSet.remaining is this port's own invention
  // (PLAN.md §8.5.2) -- so nothing upstream would notice it being wrong.
  it("decrements crawlset.remaining exactly once", async () => {
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    expect(crawlSet().remaining).toBe(2);
    expect(crawlSet().expected).toBe(3);
    // Not the last message, so the set stays open.
    expect(crawlSet().finish).toBeNull();
  });

  // decrementCrawlSetRemaining stamps `finish` the moment remaining hits zero.
  // A charity CrawlSet is fanned out across THREE queues (scheduled/index.ts's
  // own comment), so whichever regulator's consumer happens to handle the last
  // food bank is the one that closes the set -- this asserts any of them can.
  it("closes the crawlset when it takes remaining to zero", async () => {
    seedCrawlSet(1, 99);
    const handle = makeCharityQueueHandler("charity-ni", recordingFetcher());
    const { batch } = batchOf("charity-ni", [message({ crawlSetId: 99 })]);

    await handle(batch, env);

    expect(crawlSet(99).remaining).toBe(0);
    expect(crawlSet(99).finish).toBe(DJANGO_NOW);
    // The set this message did NOT belong to must be untouched -- a decrement
    // that ignored its crawlSetId would pass every test that seeds only one.
    expect(crawlSet(CRAWL_SET).remaining).toBe(3);
    expect(crawlSet(CRAWL_SET).finish).toBeNull();
  });

  // Every packages/db call goes through the Sessions API because D1 has read
  // replication on and a bare prepare() can land on a stale replica (types.ts's
  // header). ONE session per MESSAGE, not per batch: read-your-writes only
  // holds inside a session, and this module's insert-then-update-then-read
  // sequence for a single food bank all has to be inside one.
  it("opens one first-unconstrained session per message", async () => {
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland" });
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch } = batchOf("charity-ew", [message(), message({ foodbankId: DUNDEE, slug: "dundee" })]);

    await handle(batch, env);

    expect(sessionModes).toEqual(["first-unconstrained", "first-unconstrained"]);
  });

  it("logs nothing on success -- a quiet queue is a working queue", async () => {
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
  });
});

// ===========================================================================
// WHAT THE FETCHER IS HANDED
// ===========================================================================
describe("the row handed to the fetcher", () => {
  // getFoodbankForCharityCrawl's own comment says the row is re-read fresh at
  // dequeue time because the cron's enqueue-time snapshot goes stale in the
  // drain window (crawlers.py:579-590's pattern). The message body carries a
  // DIFFERENT slug here so a handler that trusted `msg` rather than re-reading
  // is caught -- and so is one that re-read by slug instead of by id.
  it("comes from D1, not from the message body", async () => {
    seedFoodbank({ slug: "salisbury", name: "Salisbury Foodbank", country: "England", charity_number: "1122447", charity_id: "ORG-1122447" });
    seedCrawlSet(1);
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    // The slug the cron snapshotted, since renamed by an admin mid-run.
    const { batch } = batchOf("charity-ew", [message({ slug: "salisbury-and-district" })]);

    await handle(batch, env);

    expect(fetcherCalls).toHaveLength(1);
    expect(fetcherCalls[0]!.foodbank).toEqual({
      id: SALISBURY,
      slug: "salisbury",
      name: "Salisbury Foodbank",
      country: "England",
      charity_number: "1122447",
      // Scotland's old crawler built its second request from the EXISTING
      // value (charity.ts:39), so this column is read and deliberately never
      // written by the crawler -- it has to arrive here intact.
      charity_id: "ORG-1122447",
    });
  });

  // A WHERE clause that did nothing would pass any test that seeds one row.
  it("is the food bank the message names, not merely some food bank", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland", charity_number: "SC012345", charity_id: "OSCR-9" });
    seedCrawlSet(2);
    const handle = makeCharityQueueHandler("charity-scotland", recordingFetcher());
    const { batch } = batchOf("charity-scotland", [message({ foodbankId: DUNDEE, slug: "dundee" })]);

    await handle(batch, env);

    expect(fetcherCalls[0]!.foodbank.id).toBe(DUNDEE);
    expect(fetcherCalls[0]!.foodbank.name).toBe("Dundee Foodbank");
    expect(fetcherCalls[0]!.foodbank.country).toBe("Scotland");
    expect(fetcherCalls[0]!.foodbank.charity_number).toBe("SC012345");
    // Only Dundee's crawlitem exists; nothing was opened for Salisbury.
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([DUNDEE]);
  });

  // The crawlitem must already be OPEN when the fetcher runs and only be closed
  // afterwards. That ordering is the stall detector: a crash inside the fetcher
  // has to leave `finish IS NULL` behind (0008_needcheck.sql:32-34). A handler
  // that inserted and finished the row around the fetch, or finished first,
  // would look identical from the outside on the happy path.
  it("runs after the crawlitem is opened and before it is closed", async () => {
    seedFoodbank();
    seedCrawlSet(1);
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    const midFlight = fetcherCalls[0]!.crawlItemsAtCallTime;
    expect(midFlight).toHaveLength(1);
    expect(midFlight[0]!.finish).toBeNull();
    expect(midFlight[0]!.start).toBe(DJANGO_NOW);
    // ...and the counter is untouched until after the fetch, so a set can
    // never read as finished while a food bank is still being crawled.
    expect(fetcherCalls[0]!.crawlSetAtCallTime!.remaining).toBe(1);
  });

  // The `fetcher` indirection exists so swapping a regulator's implementation
  // is a one-line change in charityEw.ts rather than a rewrite here (this
  // module's header). That only holds if each handler calls ITS OWN fetcher.
  it("is the fetcher that handler was built with, not a shared one", async () => {
    seedFoodbank();
    seedCrawlSet(2);
    const ewCalls: string[] = [];
    const niCalls: string[] = [];
    const ew = makeCharityQueueHandler("charity-ew", async (_e, _s, fb) => void ewCalls.push(fb.slug));
    const ni = makeCharityQueueHandler("charity-ni", async (_e, _s, fb) => void niCalls.push(fb.slug));

    await ew(batchOf("charity-ew", [message()]).batch, env);

    expect(ewCalls).toEqual(["salisbury"]);
    expect(niCalls).toEqual([]);

    await ni(batchOf("charity-ni", [message()]).batch, env);

    expect(ewCalls).toEqual(["salisbury"]);
    expect(niCalls).toEqual(["salisbury"]);
  });

  // The fetcher writes (patchFoodbankCharity, replaceCharityYears) through the
  // SAME session this module read the row on -- not a fresh one it makes
  // itself. On a replicated D1 a second session could be pinned to a replica
  // that has not seen the crawlitem insert yet.
  it("shares the session the crawlitem was opened on", async () => {
    seedFoodbank();
    seedCrawlSet(1);
    let sessionSeenByFetcher: Session | null = null;
    const handle = makeCharityQueueHandler("charity-ew", async (_e, session) => {
      sessionSeenByFetcher = session;
    });

    await handle(batchOf("charity-ew", [message()]).batch, env);

    expect(sessionSeenByFetcher).not.toBeNull();
    // One session created for the whole message, and it is the one handed on.
    expect(sessionModes).toHaveLength(1);
  });

  it("is given the same env the handler was invoked with", async () => {
    seedFoodbank();
    seedCrawlSet(1);
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());

    await handle(batchOf("charity-ew", [message()]).batch, env);

    expect(fetcherCalls[0]!.env).toBe(env);
  });
});

// ===========================================================================
// THE FOOD BANK IS GONE
// ===========================================================================
describe("when the food bank no longer exists", () => {
  beforeEach(() => {
    seedCrawlSet(3);
  });

  // Deleted (or closed and purged) between the cron's enqueue and this
  // dequeue. The port throws rather than acking, which means three retries at
  // 60s and then the DLQ -- charityDlq.ts is what finally decrements the
  // counter so the set is not stuck open forever. Asserted as it behaves; see
  // the note in the redelivery block for the case where that safety net does
  // NOT fire.
  it("retries rather than acking, and opens no crawlitem", async () => {
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch, acks, retries } = batchOf("charity-ew", [message({ foodbankId: 999, slug: "vanished" })]);

    await handle(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    // No half-open row left behind for a food bank that does not exist: the
    // insert is downstream of the existence check.
    expect(crawlItems()).toEqual([]);
    expect(crawlSet().remaining).toBe(3);
    expect(fetcherCalls).toEqual([]);
  });

  // The message that failed has to be identifiable from the log line alone --
  // this is a queue, so the log IS the incident report. queueLabel distinguishes
  // charity-ew from charity-ni, which otherwise run identical code.
  it("logs the queue label, the id and the slug", async () => {
    const handle = makeCharityQueueHandler("charity-scotland", recordingFetcher());

    await handle(batchOf("charity-scotland", [message({ foodbankId: 999, slug: "vanished" })]).batch, env);

    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe("charity-scotland: message failed for foodbank 999 (vanished)");
    // The cause travels with it, or the retry is unexplainable.
    expect(errors[0]![1]).toContain("charity: foodbank 999 (vanished) no longer exists");
  });
});

// ===========================================================================
// DOWNSTREAM FAILURE
// ===========================================================================
describe("when something downstream fails", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
  });

  // The module's header promises the crawler "never throws for an external-API-
  // level failure -- only a genuine D1 write failure propagates here to retry".
  // This is that D1 write failure, raised from inside the fetcher.
  it("leaves the crawlitem OPEN and retries when the fetcher throws", async () => {
    const handle = makeCharityQueueHandler("charity-ew", async () => {
      throw new Error("D1_ERROR: Network connection lost");
    });
    const { batch, acks, retries } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    const items = crawlItems();
    expect(items).toHaveLength(1);
    // finish IS NULL is the only stall signal there is. If this ever comes back
    // stamped, a crashed charity crawl becomes indistinguishable from a clean
    // one on the crawl dashboard.
    expect(items[0]!.finish).toBeNull();
    expect(crawlSet().remaining).toBe(3);
    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
  });

  // The 60s is not decoration: it is the same backoff needcheckRender.ts uses,
  // and it exists so a provider outage is not hit again instantly at full
  // max_concurrency (10, per wrangler.jsonc's charity-* consumers). A bare
  // `message.retry()` would redeliver immediately and is the mutant this kills.
  it("backs the retry off by 60 seconds, not immediately", async () => {
    const handle = makeCharityQueueHandler("charity-ew", async () => {
      throw new Error("boom");
    });
    const { batch, retries } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    expect(retries[0]!.options).toEqual({ delaySeconds: 60 });
  });

  it("retries and opens no crawlitem when the crawlitem insert itself fails", async () => {
    failOn = /INSERT INTO crawlitem/;
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch, acks, retries } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    expect(crawlItems()).toEqual([]);
    expect(fetcherCalls).toEqual([]);
    expect(acks).toEqual([]);
    expect(retries).toHaveLength(1);
  });

  it("retries when closing the crawlitem fails, leaving it open for the redelivery", async () => {
    failOn = /UPDATE crawlitem SET finish/;
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch, acks, retries } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet().remaining).toBe(3);
    expect(acks).toEqual([]);
    expect(retries).toHaveLength(1);
  });
});

// ===========================================================================
// AT-LEAST-ONCE REDELIVERY -- Cloudflare Queues guarantees only this
// ===========================================================================
describe("when the same message is delivered twice", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
  });

  // The single most important property in this file. insertCrawlItem is an
  // upsert on crawlitem_crawlset_foodbank_uniq and finishCrawlItem guards on
  // `finish IS NULL`; together they mean a redelivery after a successful run
  // reopens the SAME row and skips the decrement. Without the upsert this
  // orphans a second row that never gets finished (indistinguishable from a
  // stall); without the guard, remaining goes down twice for one food bank and
  // the set closes early -- possibly before other food banks have been crawled.
  it("keeps one crawlitem row and decrements remaining exactly once", async () => {
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());

    await handle(batchOf("charity-ew", [message()]).batch, env);
    const { batch, acks } = batchOf("charity-ew", [message()]);
    await handle(batch, env);

    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(2);
    expect(acks).toEqual([0]);
  });

  // Pinning a real cost, not endorsing it: the fetcher runs AGAIN on a
  // redelivery, before finishCrawlItem gets a chance to report the item was
  // already closed. For crawlOpenCharities that is a second opencharities.uk
  // GET and a second patch of identical values -- harmless but paid for.
  it("runs the fetcher a second time even though the item is already closed", async () => {
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());

    await handle(batchOf("charity-ew", [message()]).batch, env);
    await handle(batchOf("charity-ew", [message()]).batch, env);

    expect(fetcherCalls).toHaveLength(2);
  });

  // Two deliveries of the same food bank landing in ONE batch -- which
  // max_batch_size 5 makes possible -- must behave the same as two batches.
  it("survives both copies arriving in the same batch", async () => {
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch, acks, retries } = batchOf("charity-ew", [message(), message()]);

    await handle(batch, env);

    expect(crawlItems()).toHaveLength(1);
    expect(crawlSet().remaining).toBe(2);
    expect(acks).toEqual([0, 1]);
    expect(retries).toEqual([]);
  });

  // MUTANTS THIS KILLS, both of which survived every other test in this file:
  // insertCrawlItem's `ON CONFLICT (crawl_set_id, foodbank_id) DO UPDATE SET
  // crawl_set_id = crawl_set_id` turned from a deliberate no-op into a real
  // assignment -- `SET start = excluded.start`, or an overwrite of crawl_type.
  // Under the frozen clock every other redelivery assertion above reads the
  // same whether the row was preserved or rewritten, so nothing noticed.
  //
  // It matters because crawlitem carries no duration column: how long a food
  // bank's crawl took is finish minus start, and that is what the crawl
  // dashboard plots. A `start` restamped by the redelivery makes every
  // redelivered item read as instantaneous -- the slowest crawls, which are
  // the ones that get redelivered, become the ones that look fastest.
  it("reopens the original row on a redelivery without rewriting it", async () => {
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());

    await handle(batchOf("charity-ew", [message()]).batch, env);
    const opened = crawlItems()[0]!;

    // Minutes later, as a real Cloudflare redelivery would arrive.
    vi.setSystemTime(LATER);
    const { batch, acks } = batchOf("charity-ew", [message()]);
    await handle(batch, env);

    const after = crawlItems();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(opened.id);
    // Every column is the FIRST delivery's, stamped at 19:28 and not 20:00.
    expect(after[0]!.start).toBe(DJANGO_NOW);
    expect(after[0]!.finish).toBe(DJANGO_NOW);
    expect(after[0]!.crawl_type).toBe("charity");
    expect(after[0]!.crawl_set_id).toBe(CRAWL_SET);
    expect(after[0]!.url).toBeNull();
    expect(after[0]!.need_id).toBeNull();
    expect(acks).toEqual([0]);
    expect(crawlSet().remaining).toBe(2);
  });

  // The recovery the "retries when closing the crawlitem fails" test above
  // sets up but never plays out: the redelivery that actually completes it.
  // The two timestamps have to come from DIFFERENT ticks -- `start` from the
  // attempt that opened the row, `finish` from the one that closed it -- which
  // is the only evidence that the upsert reopened the ORIGINAL row rather than
  // silently starting a fresh one. A plain INSERT in place of the upsert, or a
  // handler that inserted a second row when it found one open, both leave two
  // rows here, and the extra one never gets finished: that is indistinguishable
  // from a stalled crawl on the dashboard (0008_needcheck.sql:32-34).
  it("finishes the ORIGINAL row when a redelivery follows a failed close", async () => {
    failOn = /UPDATE crawlitem SET finish/;
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());

    await handle(batchOf("charity-ew", [message()]).batch, env);
    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]!.finish).toBeNull();

    failOn = null;
    vi.setSystemTime(LATER);
    const { batch, acks, retries } = batchOf("charity-ew", [message()]);
    await handle(batch, env);

    const rows = crawlItems();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.start).toBe(DJANGO_NOW);
    expect(rows[0]!.finish).toBe(DJANGO_LATER);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    // Closed for the first time on this delivery, so the decrement DOES run --
    // the mirror image of the suspect case below, where it never runs again.
    expect(crawlSet().remaining).toBe(2);
    expect(crawlSet().finish).toBeNull();
  });

  // The uniqueness is (crawl_set_id, foodbank_id), so the NEXT night's run for
  // the same food bank must open a second row, not reuse last night's.
  it("opens a separate crawlitem for the same food bank under a different crawlset", async () => {
    seedCrawlSet(1, 8);
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());

    await handle(batchOf("charity-ew", [message()]).batch, env);
    await handle(batchOf("charity-ew", [message({ crawlSetId: 8 })]).batch, env);

    const items = crawlItems();
    expect(items).toHaveLength(2);
    expect(items.map((row) => row.crawl_set_id)).toEqual([CRAWL_SET, 8]);
    expect(crawlSet(CRAWL_SET).remaining).toBe(2);
    expect(crawlSet(8).remaining).toBe(0);
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // finishCrawlItem and decrementCrawlSetRemaining are two separate writes with
  // no transaction around them. If the FIRST succeeds and the SECOND fails, the
  // message retries; on redelivery finishCrawlItem returns false (the row is
  // already closed), so `if (closed)` short-circuits and the decrement is
  // skipped -- permanently. crawlset.remaining stays one too high and `finish`
  // is never stamped, so that night's set reads as still running forever.
  //
  // The charity-*-dlq handler exists to decrement for a message that exhausts
  // its retries, but it never runs here: the redelivery ACKS. Nothing else in
  // the system decrements. The same shape is in needcheckRender.ts's finish().
  it("permanently loses the decrement if the crawlitem closes but the counter write fails", async () => {
    failOn = /UPDATE crawlset SET remaining/;
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());

    const first = batchOf("charity-ew", [message()]);
    await handle(first.batch, env);

    // First delivery: item closed, counter write blew up, message retried.
    //
    // THAT RETRY IS ASSERTED, not merely narrated. MUTANTS THIS KILLS: dropping
    // the `await` on decrementCrawlSetRemaining (`if (closed) void decrement...`)
    // and wrapping it in `.catch(() => null)`. Both leave the second half of
    // this test reading exactly the same -- remaining still 3, the redelivery
    // acks -- so both survived the whole file until these two lines existed.
    // Either one is strictly worse than the defect the test documents: the
    // counter write's failure never reaches the catch, so the message acks on
    // its FIRST delivery, the decrement is lost without even a retry, and the
    // charity-*-dlq safety net is bypassed as well.
    expect(first.acks).toEqual([]);
    expect(first.retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(3);

    // The outage clears before the redelivery arrives.
    failOn = null;
    const { batch, acks, retries } = batchOf("charity-ew", [message()]);
    await handle(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    // ...and the counter is still 3. This is the suspected bug, asserted as it
    // is so the suite stays green and the defect stays visible.
    expect(crawlSet().remaining).toBe(3);
    expect(crawlSet().finish).toBeNull();
  });
});

// ===========================================================================
// BATCH ISOLATION
// ===========================================================================
describe("a batch with a bad message in it", () => {
  // wrangler.jsonc gives every charity queue max_batch_size 5. One food bank
  // whose crawl fails must not cost the other four their crawl -- the try/catch
  // is per message for exactly this reason, and a handler that let the throw
  // escape the loop would silently redeliver four good messages every night.
  it("still processes the messages after it", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland" });
    seedCrawlSet(3);
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch, acks, retries } = batchOf("charity-ew", [
      message(),
      message({ foodbankId: 999, slug: "vanished" }),
      message({ foodbankId: DUNDEE, slug: "dundee" }),
    ]);

    await handle(batch, env);

    expect(acks).toEqual([0, 2]);
    expect(retries.map((r) => r.index)).toEqual([1]);
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([SALISBURY, DUNDEE]);
    // Two of three food banks accounted for; the third is the DLQ's problem.
    expect(crawlSet().remaining).toBe(1);
    expect(crawlSet().finish).toBeNull();
  });

  it("processes the batch in order, one message at a time", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland" });
    seedCrawlSet(2);
    const order: string[] = [];
    const handle = makeCharityQueueHandler("charity-ew", async (_e, _s, fb) => {
      order.push(`start ${fb.slug}`);
      await Promise.resolve();
      order.push(`end ${fb.slug}`);
    });

    await handle(batchOf("charity-ew", [message(), message({ foodbankId: DUNDEE, slug: "dundee" })]).batch, env);

    // Serial, not Promise.all: interleaving would put "start dundee" second.
    expect(order).toEqual(["start salisbury", "end salisbury", "start dundee", "end dundee"]);
  });

  it("does nothing at all for an empty batch", async () => {
    seedCrawlSet(3);
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());

    await handle(batchOf("charity-ew", []).batch, env);

    expect(sessionModes).toEqual([]);
    expect(crawlItems()).toEqual([]);
    expect(crawlSet().remaining).toBe(3);
  });
});

// ===========================================================================
// MALFORMED MESSAGES
// ===========================================================================
describe("a malformed message body", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
  });

  // A body with no foodbankId fails at the bind and is handled gracefully --
  // logged with `undefined` in place of the id, and retried. Retrying a message
  // that can never succeed is three wasted deliveries, but it does end at the
  // DLQ, which is where a human can see it.
  it("with no foodbankId is logged and retried, not silently dropped", async () => {
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch, acks, retries } = batchOf("charity-ew", [{ crawlSetId: CRAWL_SET }]);

    await handle(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(errors[0]![0]).toBe("charity-ew: message failed for foodbank undefined (undefined)");
    expect(crawlItems()).toEqual([]);
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // The catch block dereferences `message.body.foodbankId` to build its log
  // line. For a body of `null`/`undefined` that dereference throws INSIDE the
  // catch, so the error escapes `handle` entirely: the rest of the batch is
  // never looked at, and messages after the bad one are neither acked nor
  // retried. One unparseable message therefore poisons up to four healthy ones
  // (max_batch_size 5), every delivery, until the batch exhausts max_retries.
  it("that is null takes the whole rest of the batch down with it", async () => {
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland" });
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch, acks, retries } = batchOf("charity-ew", [message(), null, message({ foodbankId: DUNDEE, slug: "dundee" })]);

    await expect(handle(batch, env)).rejects.toThrow(TypeError);

    // The first message committed and acked before the crash...
    expect(acks).toEqual([0]);
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([SALISBURY]);
    // ...and the third was never even looked at. Not acked, not retried.
    expect(retries).toEqual([]);
    expect(crawlSet().remaining).toBe(2);
  });

  // A crawlSetId pointing at a set that does not exist is NOT an error:
  // decrementCrawlSetRemaining's UPDATE matches nothing and returns null. The
  // message acks and the crawlitem is closed with a dangling crawl_set_id.
  // Pinned because it is the shape a manual/one-off enqueue takes, and because
  // silence here is the correct behaviour rather than an oversight.
  it("naming a crawlset that does not exist still completes and acks", async () => {
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch, acks, retries } = batchOf("charity-ew", [message({ crawlSetId: 4242 })]);

    await handle(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(crawlItems()[0]!.crawl_set_id).toBe(4242);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(3);
  });

  // The `AND remaining > 0` guard in decrementCrawlSetRemaining. An extra
  // message against an already-drained set (a redelivery of the very last one,
  // say) must not push the counter negative or re-stamp `finish`.
  it("against an already-drained crawlset leaves remaining at zero", async () => {
    seedCrawlSet(0, 77);
    const handle = makeCharityQueueHandler("charity-ew", recordingFetcher());
    const { batch, acks } = batchOf("charity-ew", [message({ crawlSetId: 77 })]);

    await handle(batch, env);

    expect(acks).toEqual([0]);
    expect(crawlSet(77).remaining).toBe(0);
    // finish is stamped only on the transition to zero, which already happened
    // (or never will) -- this message must not restamp it.
    expect(crawlSet(77).finish).toBeNull();
  });
});

// ===========================================================================
// WIRED TO THE REAL CRAWLER
// ===========================================================================
//
// charityEw.ts / charityScotland.ts / charityNi.ts all do exactly
// `makeCharityQueueHandler(label, crawlOpenCharities)`. Everything above uses a
// stand-in fetcher to isolate the bookkeeping; this block runs the REAL one, so
// the claim being tested is the production combination -- including the
// contract this module's header depends on, that an external-API failure never
// reaches the catch here.
describe("with the real crawlOpenCharities as its fetcher", () => {
  interface FetchCall {
    url: string;
    headers: Record<string, string>;
  }
  let fetchCalls: FetchCall[];
  let reply: { status: number; body: string } | Error;

  beforeEach(() => {
    fetchCalls = [];
    reply = { status: 200, body: "{}" };
    vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
      fetchCalls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
      if (reply instanceof Error) throw reply;
      return new Response(reply.body, { status: reply.status });
    });
    seedCrawlSet(2);
  });

  function charityYears(foodbankId = SALISBURY): { date: string; income: number; expenditure: number; created: string }[] {
    return db.prepare("SELECT date, income, expenditure, created FROM charityyear WHERE foodbank_id = ? ORDER BY date DESC").all(foodbankId) as unknown as {
      date: string;
      income: number;
      expenditure: number;
      created: string;
    }[];
  }

  it("patches the charity columns and replaces the financial years in the same run", async () => {
    seedFoodbank({ charity_name: "STALE NAME" });
    reply = {
      status: 200,
      body: JSON.stringify({
        name: "Salisbury Foodbank",
        legal_form: "CIO - Association",
        date_registered: "2011-03-14",
        postcode: "SP2 9DY",
        website: "https://salisbury.example",
        activities: "Providing three days of emergency food",
        classifications: [
          { type: "What", description: "Food Banks" },
          // A non-"What" classification that must NOT reach charity_purpose --
          // a filter that did nothing would pass a fixture with only "What".
          { type: "Who", description: "People In Poverty" },
          { type: "What", description: "Relief Of Poverty" },
        ],
        financial_years: [
          { end: "2024-03-31", income: 412000, expenditure: 398000 },
          { end: "2023-03-31", income: 355000, expenditure: 340000 },
          // No end date: dropped, never written as a NULL-dated row.
          { end: null, income: 1, expenditure: 1 },
        ],
      }),
    };
    const handle = makeCharityQueueHandler("charity-ew", crawlOpenCharities);
    const { batch, acks } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ew/1122447.json"]);
    const row = foodbankRow();
    expect(row.charity_name).toBe("Salisbury Foodbank");
    expect(row.charity_type).toBe("CIO - Association");
    expect(row.charity_reg_date).toBe("2011-03-14");
    expect(row.charity_postcode).toBe("SP2 9DY");
    expect(row.charity_website).toBe("https://salisbury.example");
    expect(row.charity_purpose).toBe("Food Banks\nRelief Of Poverty\n");
    expect(row.charity_objectives).toBe("Providing three days of emergency food");
    expect(row.last_charity_check).toBe(DJANGO_NOW);
    // Deliberately NOT patched -- crawlOpenCharities.ts:194-200 keeps whatever
    // the last regulator crawl put there.
    expect(row.charity_id).toBe("ORG-1122447");

    expect(charityYears()).toEqual([
      { date: "2024-03-31", income: 412000, expenditure: 398000, created: DJANGO_NOW },
      { date: "2023-03-31", income: 355000, expenditure: 340000, created: DJANGO_NOW },
    ]);

    // ...and the bookkeeping still happened around it.
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(1);
    expect(acks).toEqual([0]);
  });

  // The fresh DB row is what builds the URL, so this is also the end-to-end
  // proof that country and charity_number arrive at the crawler intact -- NI's
  // "NIC" prefix strip (models/foodbank.py:339-347) only happens if `country`
  // made it through as "Northern Ireland".
  it("routes an NI food bank to the ni register with the NIC prefix stripped", async () => {
    seedFoodbank({ country: "Northern Ireland", charity_number: "NIC101234" });
    const handle = makeCharityQueueHandler("charity-ni", crawlOpenCharities);

    await handle(batchOf("charity-ni", [message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/101234.json"]);
    expect(fetchCalls[0]!.headers["User-Agent"]).toContain("GiveFoodBot");
  });

  // THE CONTRACT THIS MODULE'S HEADER RESTS ON. A 404 for a charity number that
  // has moved is not retryable, so crawlOpenCharities swallows it; this module
  // must then treat the message as DONE -- crawlitem closed, counter
  // decremented, message acked. If a non-200 ever started throwing, every one
  // of the ~2 daily 404s would burn three retries and land in the DLQ.
  it("acks and closes the crawlitem when the register 404s", async () => {
    seedFoodbank({ charity_name: "STALE NAME" });
    reply = { status: 404, body: "not found" };
    const handle = makeCharityQueueHandler("charity-ew", crawlOpenCharities);
    const { batch, acks, retries } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(1);
    // Nothing patched, nothing nulled -- Django's `if response.status_code ==
    // 200:` guard (crawlers.py:126) has the same effect.
    expect(foodbankRow().charity_name).toBe("STALE NAME");
    expect(foodbankRow().last_charity_check).toBeNull();
    expect(logs).toContain("charity: opencharities 404 for salisbury (ew/1122447)");
    expect(errors).toEqual([]);
  });

  // A rejected fetch (DNS, TLS, the 20s AbortSignal.timeout) is swallowed the
  // same way. It is logged as an error but the message still acks -- so a total
  // opencharities.uk outage costs a night's charity data and closes the crawl
  // set cleanly, rather than filling three DLQs.
  it("acks when the fetch itself rejects", async () => {
    seedFoodbank();
    reply = new TypeError("fetch failed");
    const handle = makeCharityQueueHandler("charity-ew", crawlOpenCharities);
    const { batch, acks, retries } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(1);
    expect(errors[0]![0]).toBe("charity: opencharities fetch failed for salisbury");
  });

  // Isle of Man has one food bank and no register at opencharities. It is
  // enqueued by nothing today (the cron only fans out England/Wales, Scotland
  // and Northern Ireland) but a manual enqueue must not wedge the queue.
  it("acks a country with no register at all, without fetching", async () => {
    seedFoodbank({ country: "Isle of Man" });
    const handle = makeCharityQueueHandler("charity-ew", crawlOpenCharities);
    const { batch, acks } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    expect(fetchCalls).toEqual([]);
    expect(acks).toEqual([0]);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(logs).toContain("charity: no register for country Isle of Man (salisbury)");
  });

  // replaceCharityYears deletes by foodbank_id before reinserting. A DELETE
  // that dropped its WHERE would empty every other food bank's history and
  // nothing would notice until someone looked at a charity page.
  it("replaces only this food bank's charity years", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", country: "Scotland" });
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2020-03-31', 1, 2, ?)").run(SALISBURY, DJANGO_NOW);
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2020-03-31', 3, 4, ?)").run(DUNDEE, DJANGO_NOW);
    reply = { status: 200, body: JSON.stringify({ name: "Salisbury Foodbank", financial_years: [{ end: "2024-03-31", income: 9, expenditure: 8 }] }) };
    const handle = makeCharityQueueHandler("charity-ew", crawlOpenCharities);

    await handle(batchOf("charity-ew", [message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2024-03-31", income: 9, expenditure: 8, created: DJANGO_NOW }]);
    expect(charityYears(DUNDEE)).toEqual([{ date: "2020-03-31", income: 3, expenditure: 4, created: DJANGO_NOW }]);
  });

  // A D1 failure INSIDE the real crawler is the one thing that is supposed to
  // reach this module's catch, per its header. The write it fails on is
  // patchFoodbankCharity, so the crawl is half-done: the crawlitem stays open
  // and the message comes back.
  it("retries when the crawler's own D1 write fails", async () => {
    seedFoodbank({ charity_name: "STALE NAME" });
    reply = { status: 200, body: JSON.stringify({ name: "Salisbury Foodbank" }) };
    failOn = /UPDATE foodbank SET/;
    const handle = makeCharityQueueHandler("charity-ew", crawlOpenCharities);
    const { batch, acks, retries } = batchOf("charity-ew", [message()]);

    await handle(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet().remaining).toBe(2);
    expect(foodbankRow().charity_name).toBe("STALE NAME");
    expect(errors[0]![0]).toBe("charity-ew: message failed for foodbank 22 (salisbury)");
  });
});
