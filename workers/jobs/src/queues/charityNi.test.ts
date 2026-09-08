import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import type { Env } from "../../worker-configuration";
import { handleCharityNiQueue } from "./charityNi";
import type { CharityMessage } from "./charity";
import jobsWorker from "../index";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning,
// as packages/db/src/schema.testkit.ts:35 and queues/charity.test.ts:12.
import { DatabaseSync } from "node:sqlite";

// queues/charityNi.ts -- the consumer for the `charity-ni` queue. The whole
// module is one line:
//
//     export const handleCharityNiQueue =
//       makeCharityQueueHandler("charity-ni", crawlOpenCharities);
//
// WHY A ONE-LINE MODULE IS WORTH A FILE THIS SIZE. Nothing here is code so
// much as WIRING, and wiring is the class of mistake that no other test in the
// repo can catch:
//
//   * queues/charity.test.ts proves the bookkeeping factory works, but it
//     builds its own handlers with its own labels. It would pass unchanged if
//     this file said "charity-ew".
//   * charity/crawlOpenCharities.ts does have a colocated suite of its own
//     (crawlOpenCharities.test.ts, added alongside this one), but it calls the
//     crawler DIRECTLY -- it imports `crawlOpenCharities` and hands it a row,
//     never a MessageBatch. Nothing there proves the crawler is the function
//     this queue's handler was built with, and the NORTHERN IRELAND field
//     mapping -- which is not the same mapping as England's, deliberately
//     (crawlOpenCharities.ts:129-144) -- is exercised THROUGH THE CONSUMER
//     here or nowhere.
//   * index.ts:44-45 routes `batch.queue === "charity-ni"` to this export.
//     Nothing else asserts that the name in the switch, the name in
//     wrangler.jsonc's consumer block and the label in the log line are the
//     same three strings -- and because the three regulator handlers are
//     behaviourally identical apart from that label, the switch landing on
//     charityEw's handler is invisible to every assertion about what gets
//     crawled. See "routes charity-ni to THIS handler..." below.
//
// And this is the queue where being wrong is least likely to be noticed.
// Northern Ireland has a handful of food banks against England and Wales'
// hundreds; a charity-ni consumer that quietly did nothing would show up as
// nothing at all on the site -- the charity panel would simply keep rendering
// whatever it rendered yesterday.
//
// THE NI HISTORY THIS REPLACES, read out of Django rather than assumed.
// givefood/utils/crawlers.py at /Users/jasoncartwright/Sites/foodcharity
// (read directly while writing this file) has `_crawl_charity_ni` fetch
// charitycommissionni.org.uk's CSV export inside the usual
// `if response.status_code == 200:` guard, and crawlOpenCharities.ts's header
// records that that endpoint 404s for a real food bank's number -- so NI
// charity data has been silently stale in production Django too. Everything
// this consumer writes for NI is therefore new data on a page nobody has seen
// change in a long time, which is exactly the situation where a wrong value is
// mistaken for a right one.
//
// REAL THINGS, NOT MOCKS. node:sqlite carrying the WHOLE migration set
// (MIGRATIONS_SQL, matching charity.test.ts): this path reaches foodbank,
// crawlitem, crawlset AND charityyear through six shared packages/db
// functions, and a narrow fixture is how a suite develops the github #51 gap
// where a shared query starts reading one more object. The real
// getFoodbankForCharityCrawl / insertCrawlItem / finishCrawlItem /
// decrementCrawlSetRemaining / patchFoodbankCharity / replaceCharityYears run
// throughout, and so does the real crawlOpenCharities -- the whole point of
// this file is the composition, so substituting either half would test the
// substitute. index.ts's real default export is used for the routing block.
//
// MOCKED, and only this: `fetch` (opencharities.uk is the one thing that
// leaves the machine) and the MessageBatch, which is a Cloudflare runtime
// object with no local equivalent. Plus a by-SQL failure hook, because a D1
// outage cannot otherwise be delivered.
//
// PARITY CLAIMS ARE RUN, NOT REASONED. Where a comment below says CPython does
// X, it was executed on this machine (python3 --version -> Python 3.13.0,
// 2026-09-08). NOT VERIFIED, and not claimed anywhere below: anything about
// live opencharities.uk responses -- no request was made to it from here, and
// the fixture bodies are shaped from crawlOpenCharities.ts's own OpenCharity
// interface, not from a recorded response.

// ===========================================================================
// HARNESS -- lifted from queues/charity.test.ts on purpose. Two suites over
// the same two tables that disagree about what a session is would be two
// fixtures to keep true.
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
 * standing in for a D1 outage mid-message. A D1 write failure is the ONLY
 * thing that is supposed to reach the queue handler's catch -- the crawler
 * swallows every external failure itself -- so it is the only way to reach the
 * retry path at all.
 */
let failOn: RegExp | null = null;

/** Every bookmark mode `withSession` was asked for, in call order. */
let sessionModes: string[] = [];

/**
 * The D1 Sessions API surface packages/db uses, over the real engine. It
 * carries SQL to node:sqlite and interprets nothing: canned rows would be a
 * second implementation of the upsert, the `WHERE finish IS NULL` guard and
 * the `remaining > 0` decrement, which are the three pieces of behaviour this
 * consumer's correctness actually rests on.
 *
 * `first()` answers null rather than undefined, matching D1, and `run()`
 * reports `meta.changes`, which is the whole return value of finishCrawlItem.
 *
 * ONE THING IT DOES NOT MODEL: `batch()` here runs its statements in order and
 * stops at the first throw, where real D1 applies a batch atomically. So no
 * test below may assert that replaceCharityYears' DELETE was rolled back when
 * one of its INSERTs failed -- this harness would report the DELETE as having
 * stuck, and that would be an artefact of the double, not of the code.
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
 * A MessageBatch double. Bodies are `unknown` so the malformed-message tests
 * can post things the type says are impossible -- the producer is a different
 * Worker (workers/site's force-crawl route) plus a cron, neither of which is
 * typechecked against this consumer.
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

/** What the crawler asked opencharities.uk for, which is half of what this file is about. */
interface FetchCall {
  url: string;
  headers: Record<string, string>;
  /** AbortSignal.timeout(20_000) is armed by the crawler; without it a hung connection holds a consumer slot. */
  hasSignal: boolean;
}
let fetchCalls: FetchCall[];
let reply: { status: number; body: string } | Error;

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write: a SPACE separator, six fractional
// digits, never a "T" and never a "Z". crawlitem.start/finish, crawlset.finish
// and foodbank.last_charity_check are all TEXT and SQLite compares TEXT
// bytewise, so an ISO value here sorts after every same-day Django one.
const DJANGO_NOW = "2026-09-05 19:28:08.853000";
const NOW = new Date("2026-09-05T19:28:08.853Z");

const BELFAST = 44;
/** A second Northern Irish food bank, for the batch and multi-message cases. */
const LISBURN = 45;
/** An England row that must be untouched by every NI crawl below. */
const SALISBURY = 22;
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
     ) VALUES (?, ?, ?, ?, '10 Sandy Row', 'BT12 5EY', ?, '54.5896,-5.9370', ?, 0, ?, ?, 'info@example.test', 'https://example.test/', 'https://example.test/need/', 0, 0, 0, 14, ?, ?)`,
  ).run(
    seed.id ?? BELFAST,
    `uuid-${seed.slug ?? "belfast"}`,
    seed.name ?? "Belfast South Foodbank",
    seed.slug ?? "belfast",
    seed.country ?? "Northern Ireland",
    seed.charity_number === undefined ? "NIC101234" : seed.charity_number,
    // NI's Django crawler never wrote charity_id (crawlers.py's
    // _crawl_charity_ni sets four fields and none of them is that one), so a
    // real NI row's value is whatever it was seeded with at import. A
    // recognisable string here proves the port still leaves it alone.
    seed.charity_id === undefined ? "NI-LEGACY-9" : seed.charity_id,
    seed.charity_name === undefined ? "BELFAST SOUTH FOODBANK" : seed.charity_name,
    DJANGO_NOW,
    DJANGO_NOW,
  );
}

/** Put yesterday's crawl result on a row, so "this run blanked it" is distinguishable from "it was always empty". */
function setCharityColumns(id: number, values: Record<string, string | null>): void {
  const columns = Object.keys(values);
  db.prepare(`UPDATE foodbank SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...columns.map((c) => values[c] ?? null), id);
}

/** The CrawlSet the charityinfo cron opened (scheduled/index.ts:214-240): ONE per nightly run, shared by all three regulator queues. */
function seedCrawlSet(remaining: number, id = CRAWL_SET): void {
  db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, expected, remaining) VALUES (?, 'charity', ?, ?, ?, ?)").run(id, `charity-${id}`, DJANGO_NOW, remaining, remaining);
}

function message(overrides: Partial<CharityMessage> = {}): CharityMessage {
  return { crawlSetId: CRAWL_SET, foodbankId: BELFAST, slug: "belfast", ...overrides };
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

function foodbankRow(id = BELFAST): Record<string, unknown> {
  return db.prepare("SELECT * FROM foodbank WHERE id = ?").get(id) as Record<string, unknown>;
}

function charityYears(foodbankId = BELFAST): { date: string; income: number; expenditure: number; created: string }[] {
  return db.prepare("SELECT date, income, expenditure, created FROM charityyear WHERE foodbank_id = ? ORDER BY date DESC").all(foodbankId) as unknown as {
    date: string;
    income: number;
    expenditure: number;
    created: string;
  }[];
}

/** Reply with one opencharities-shaped body. Keys omitted here are keys the register did not publish. */
function respondWith(body: Record<string, unknown>): void {
  reply = { status: 200, body: JSON.stringify(body) };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

beforeEach(() => {
  // Date only, not setTimeout: the crawler arms a real
  // AbortSignal.timeout(20_000) and faking the clock underneath it buys
  // nothing. Freezing Date is what makes the exact `start`/`finish`/
  // `last_charity_check` assertions below possible.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(MIGRATIONS_SQL);

  failOn = null;
  sessionModes = [];
  errors = [];
  logs = [];
  fetchCalls = [];
  reply = { status: 200, body: "{}" };

  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String)));
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    fetchCalls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, hasSignal: Boolean(init.signal) });
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
// WHICH QUEUE THIS IS -- the label and the routing, which nothing else pins
// ===========================================================================
describe("the identity of the charity-ni consumer", () => {
  beforeEach(() => {
    seedCrawlSet(3);
  });

  // THE COPY-PASTE MUTANT. charityEw.ts, charityScotland.ts and charityNi.ts
  // are byte-identical apart from one string and the export name, and the
  // label is only ever observed in this log line. Build this one with
  // "charity-ew" and everything still works -- the crawl runs, the counter
  // lands on zero, the site renders -- while the only artefact a human reads
  // when Northern Ireland's crawl starts failing at 5:30am points at the wrong
  // regulator. Asserted as an exact string for that reason.
  it("logs its own queue label on a failure, not another regulator's", async () => {
    await handleCharityNiQueue(batchOf("charity-ni", [message({ foodbankId: 999, slug: "vanished" })]).batch, env);

    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe("charity-ni: message failed for foodbank 999 (vanished)");
    // The cause travels with it, or the retry is unexplainable from the log.
    expect(errors[0]![1]).toContain("charity: foodbank 999 (vanished) no longer exists");
  });

  // index.ts:44-45. The switch is on the queue NAME as Cloudflare delivers it,
  // and the name is set in wrangler.jsonc:189 -- three strings that have to
  // agree and are written in three files. A miss lands on `default:` and the
  // whole batch is dropped unacked, which is a silent nightly no-op.
  it("is what the real Worker dispatches a charity-ni batch to", async () => {
    seedFoodbank();
    respondWith({ name: "Belfast South Foodbank" });
    const probe = batchOf("charity-ni", [message()]);

    await jobsWorker.queue(probe.batch, env, ctx);

    // Reached this consumer specifically: a crawlitem was opened AND the
    // opencharities GET went out. The DLQ consumer for the same regulator does
    // neither, so both halves are needed to tell them apart.
    expect(crawlItems()).toHaveLength(1);
    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/101234.json"]);
    expect(foodbankRow().charity_name).toBe("Belfast South Foodbank");
    expect(probe.acks).toEqual([0]);
  });

  // MUTANT THE TEST ABOVE CANNOT SEE, and it survived this file's first
  // mutation run: index.ts:45 changed to `return handleCharityEwQueue(...)`
  // for the charity-ni case. All three regulator handlers are
  // `makeCharityQueueHandler(<label>, crawlOpenCharities)` and differ ONLY in
  // that label, so England's handler crawls Northern Irish food banks exactly
  // as this one does -- same GET, same patch, same crawlitem, same ack. Every
  // assertion above still passes.
  //
  // The label is observable in one place only: the console.error a failed
  // message writes. So the routing has to be probed with a message that
  // FAILS. Get this wrong and the nightly 5:30am NI failures are logged under
  // "charity-ew", which is where someone would then go looking for them.
  it("routes charity-ni to THIS handler, not to England's identical twin", async () => {
    const probe = batchOf("charity-ni", [message({ foodbankId: 999, slug: "vanished" })]);

    await jobsWorker.queue(probe.batch, env, ctx);

    expect(errors.map((line) => line[0])).toEqual(["charity-ni: message failed for foodbank 999 (vanished)"]);
    // ...and it is the crawl consumer's retry policy, not the DLQ's ack, that
    // the switch reached.
    expect(probe.retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(probe.acks).toEqual([]);
  });

  // The negative that makes the above mean something. charity-ni-dlq is one
  // hyphenated suffix away and routes to handleCharityNiDlq, which decrements
  // the counter and records nothing else. If this consumer were ever wired to
  // the DLQ name, exhausted messages would be re-crawled forever.
  it("is NOT what a charity-ni-dlq batch is dispatched to", async () => {
    seedFoodbank();
    const probe = batchOf("charity-ni-dlq", [message()]);

    await jobsWorker.queue(probe.batch, env, ctx);

    expect(fetchCalls).toEqual([]);
    expect(crawlItems()).toEqual([]);
    expect(errors.map((line) => line[0])).toEqual(["charity-ni-dlq: foodbank 44 (belfast) exhausted retries"]);
    // The DLQ still frees the counter, which is the whole reason it exists.
    expect(crawlSet().remaining).toBe(2);
  });

  // A name that is in neither case reaches `default:`. Seeded with the
  // realistic near-miss -- charity-ni renamed in wrangler.jsonc without
  // touching index.ts -- rather than nonsense.
  it("does not answer a queue name that is merely similar", async () => {
    seedFoodbank();
    const probe = batchOf("charity-northern-ireland", [message()]);

    await jobsWorker.queue(probe.batch, env, ctx);

    expect(fetchCalls).toEqual([]);
    expect(crawlItems()).toEqual([]);
    expect(probe.acks).toEqual([]);
    expect(errors.map((line) => line[0])).toEqual(['givefood2-jobs: unhandled queue "charity-northern-ireland"']);
  });

  // The other half of the wiring: the fetcher. A handler built with a no-op
  // fetcher would satisfy every bookkeeping assertion in this file -- crawlitem
  // opened and closed, counter decremented, message acked -- and fetch nothing
  // and write nothing. The outbound request IS the proof the real
  // crawlOpenCharities is attached.
  it("is wired to the real crawler, which really reaches out to opencharities", async () => {
    seedFoodbank();
    respondWith({ name: "Belfast South Foodbank" });
    // AbortSignal.timeout's deadline is not readable off the signal it returns,
    // so the only way to pin the NUMBER is to watch the call. Without this,
    // `AbortSignal.timeout(2_000)` -- or 200_000 -- is invisible: `hasSignal`
    // stays true either way. That was a live survivor of this file's mutation
    // run before this line existed.
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(timeout).toHaveBeenCalledWith(20_000);

    expect(fetchCalls).toHaveLength(1);
    // Byte-identical to Django's own BOT_USER_AGENT
    // (givefood/const/general.py:210, read directly). The bot page it points
    // at is how a food bank's webmaster identifies this traffic, and
    // opencharities is a small site that could reasonably block an anonymous
    // client.
    expect(fetchCalls[0]!.headers["User-Agent"]).toBe("Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)");
    // The 20s abort is armed. opencharities is one small independent site
    // (crawlOpenCharities.ts:21-27); a connection it never closes would
    // otherwise hold one of the ten concurrent consumers until the Worker's
    // own limit killed the invocation.
    expect(fetchCalls[0]!.hasSignal).toBe(true);
  });
});

// ===========================================================================
// THE NORTHERN IRELAND FIELD MAPPING
// ===========================================================================
//
// This is the part that is genuinely NI-specific. crawlOpenCharities.ts:129-144
// keeps a per-register mapping on purpose -- "A single fallback chain would be
// shorter and wrong: Scotland and NI both populate `purposes`, but it means the
// categorised list in one and the objects text in the other" -- and Django says
// the same thing in one blunt line at crawlers.py:265, "Objectives and purposes
// are reversed in NI". Getting it backwards puts a list of categories where the
// food bank page prints its objectives and vice versa: both columns are
// free text, both render, and nothing anywhere would throw.
describe("what an NI register response writes", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(2);
  });

  it("patches every column the register published, and stamps last_charity_check", async () => {
    setCharityColumns(BELFAST, { charity_name: "STALE NAME", charity_postcode: null, charity_type: null });
    respondWith({
      name: "Belfast South Foodbank",
      legal_form: "Other",
      date_registered: "2013-11-05",
      postcode: "BT12 5EY",
      website: "https://belfastsouth.example",
      // NI's two free-text fields, crossed over exactly as the register
      // publishes them.
      what_charity_does: "Food Banks,Relief Of Poverty",
      purposes: "The prevention or relief of poverty,The advancement of citizenship",
    });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    const row = foodbankRow();
    expect(row.charity_name).toBe("Belfast South Foodbank");
    expect(row.charity_type).toBe("Other");
    expect(row.charity_reg_date).toBe("2013-11-05");
    // Django's NI crawler wrote neither of these two -- crawlers.py's
    // _crawl_charity_ni sets charity_name, charity_reg_date, charity_website,
    // charity_objectives and charity_purpose and nothing else -- so postcode
    // and type are new data for NI, which is the gain crawlOpenCharities.ts's
    // header claims (19/20 NI food banks had an empty postcode).
    expect(row.charity_postcode).toBe("BT12 5EY");
    expect(row.charity_website).toBe("https://belfastsouth.example");
    expect(row.last_charity_check).toBe(DJANGO_NOW);
  });

  // THE CROSSOVER, asserted in both directions so a swap cannot survive. NI's
  // "what the charity does" is the PURPOSE column and its "purposes" is the
  // OBJECTIVES column; a mapping that read the field names at face value would
  // look more sensible and be wrong in exactly the way Django warns about.
  it("puts what_charity_does in charity_purpose and purposes in charity_objectives", async () => {
    respondWith({
      what_charity_does: "Food Banks,Relief Of Poverty",
      purposes: "The prevention or relief of poverty,The advancement of citizenship",
    });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    const row = foodbankRow();
    expect(row.charity_purpose).toBe("Food Banks\nRelief Of Poverty");
    expect(row.charity_objectives).toBe("The prevention or relief of poverty,The advancement of citizenship");
    expect(row.charity_purpose).not.toContain("prevention or relief");
    expect(row.charity_objectives).not.toContain("Food Banks");
  });

  // charity_objectives is passed through RAW, commas and all, while
  // charity_purpose is split. That asymmetry is not an oversight: Django does
  // the same, `charity_objectives = data.get("Charitable purposes")` with no
  // substitution (crawlers.py:266) against a re.sub on the other field
  // (:267-270). A "tidy-up" that ran both through toLines() would silently
  // reformat every NI food bank's objectives.
  it("leaves charity_objectives unsplit even though it is full of commas", async () => {
    respondWith({ purposes: "a,b,c" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(foodbankRow().charity_objectives).toBe("a,b,c");
    expect(String(foodbankRow().charity_objectives)).not.toContain("\n");
  });

  // A DIVERGENCE FROM DJANGO, pinned as the port does it and reported, not
  // fixed. Django splits on a comma NOT followed by whitespace
  // (`re.sub(r",(?!\s)", "\n", objectives)`), so "poverty, The advancement"
  // stays on ONE line; toLines() splits on every comma and trims, so it becomes
  // two. RUN, not reasoned: CPython 3.13.0 on this machine returns
  // 'The prevention or relief of poverty, The advancement of education\nThe
  // advancement of health' for that input, where the port returns three lines.
  //
  // It only bites when the register's text has ", " inside an item, which is
  // also the only case where Django's negative lookahead was doing anything.
  it("splits charity_purpose on a comma-space too, where Django kept one line", async () => {
    respondWith({ what_charity_does: "The prevention or relief of poverty, The advancement of education,The advancement of health" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(foodbankRow().charity_purpose).toBe("The prevention or relief of poverty\nThe advancement of education\nThe advancement of health");
  });

  // The two agree wherever the register writes bare commas, which
  // crawlOpenCharities.ts:110-114 says is NI's normal shape ("Northern Ireland
  // as bare `a,b,c`"). This is the case that covers essentially all real rows.
  it("matches Django's output exactly for the bare-comma shape NI actually sends", async () => {
    respondWith({ what_charity_does: "Food Banks,Relief Of Poverty,Advancement Of Health" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    // CPython 3.13.0, same input through re.sub(r",(?!\s)", "\n", ...):
    // 'Food Banks\nRelief Of Poverty\nAdvancement Of Health'.
    expect(foodbankRow().charity_purpose).toBe("Food Banks\nRelief Of Poverty\nAdvancement Of Health");
  });

  // toLines() drops empties rather than emitting blank lines: a register value
  // with a trailing comma is common in exported CSV-derived text and would
  // otherwise put a stray newline at the end of the rendered list.
  it("drops empty items and surrounding whitespace from charity_purpose", async () => {
    respondWith({ what_charity_does: " Food Banks , , Relief Of Poverty ," });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(foodbankRow().charity_purpose).toBe("Food Banks\nRelief Of Poverty");
  });

  // The EW branch appends a trailing newline per item (crawlOpenCharities.ts:151-152
  // "Django appended a trailing newline per item"). NI's does not, and the
  // difference is real stored data -- an NI value that suddenly grew one would
  // be a diff on every NI food bank.
  it("does not add EW's trailing newline to an NI purpose", async () => {
    respondWith({ what_charity_does: "Food Banks" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(foodbankRow().charity_purpose).toBe("Food Banks");
  });

  // The register-specific mapping again, from the other side: an EW-shaped
  // payload delivered for an NI food bank must ignore `classifications` and
  // `activities` entirely. A fallback chain (`what_charity_does ??
  // classifications ?? ...`) would pass every test above and quietly start
  // filing English categories against Northern Irish charities.
  it("ignores the England/Wales fields even when the response carries them", async () => {
    respondWith({
      what_charity_does: "Food Banks",
      purposes: "The prevention or relief of poverty",
      classifications: [
        { type: "What", description: "General Charitable Purposes" },
        { type: "Who", description: "People In Poverty" },
      ],
      activities: "Providing three days of emergency food",
    });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(foodbankRow().charity_purpose).toBe("Food Banks");
    expect(foodbankRow().charity_objectives).toBe("The prevention or relief of poverty");
  });

  // THE FALLBACK-CHAIN MUTANT, which survived this file's first mutation run.
  // `purposeFor` rewritten as `toLines(data.what_charity_does ?? data.purposes
  // ?? <classifications>)` passes every other test here, because every other
  // fixture publishes what_charity_does and the chain never reaches its second
  // link. This is the fixture that reaches it: an NI charity that has filed its
  // charitable purposes but not "what the charity does", which the register
  // permits and which crawlOpenCharities.ts:129-144 says must NOT be papered
  // over ("Scotland and NI both populate `purposes`, but it means the
  // categorised list in one and the objects text in the other").
  //
  // Under the chain, charity_purpose would come out holding the same objects
  // text as charity_objectives -- comma-split into a bogus list -- and the food
  // bank page would print it twice, once as a list of categories it is not.
  it("leaves charity_purpose empty when the register published no what_charity_does", async () => {
    setCharityColumns(BELFAST, { charity_purpose: "Food Banks" });
    respondWith({
      purposes: "The prevention or relief of poverty,The advancement of citizenship",
      // The EW fields are here too, so a chain that falls through to
      // `classifications` is caught by the same fixture.
      classifications: [{ type: "What", description: "General Charitable Purposes" }],
      activities: "Providing three days of emergency food",
    });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(foodbankRow().charity_purpose).toBeNull();
    expect(foodbankRow().charity_objectives).toBe("The prevention or relief of poverty,The advancement of citizenship");
  });

  // charity_id is DELIBERATELY not in the patch (crawlOpenCharities.ts:194-200):
  // it held two regulators' own internal identifiers and opencharities
  // publishes neither, so writing the charity number into it would silently
  // change what the column means.
  it("leaves charity_id exactly as it found it", async () => {
    respondWith({ name: "Belfast South Foodbank" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(foodbankRow().charity_id).toBe("NI-LEGACY-9");
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // patchFoodbankCharity's own comment (packages/db/src/charity.ts:64-72) says
  // "a field a regulator's API didn't return this run ... is left exactly as it
  // already was in D1, never nulled. `patch` therefore only ever contains the
  // columns this particular crawl actually has fresh values for". That contract
  // is not kept by this caller: crawlOpenCharities builds the patch object with
  // all seven keys unconditionally and `?? null`, so a 200 response that omits
  // a field BLANKS the stored value.
  //
  // NI is where this matters most -- it is the sparsest of the three registers,
  // and crawlOpenCharities.ts's "NOT ONE FIELD THAT HAS A VALUE TODAY COMES
  // BACK EMPTY" was measured against 20 NI charities that happened to publish
  // everything. One NI charity dropping its website from the register empties
  // charity_website here, where Django's failure mode was to leave it (its NI
  // endpoint 404s, so it never patched at all).
  it("blanks columns the register omitted from an otherwise good response", async () => {
    setCharityColumns(BELFAST, {
      charity_website: "https://belfastsouth.example",
      charity_purpose: "Food Banks",
      charity_objectives: "The prevention or relief of poverty",
      charity_postcode: "BT12 5EY",
      charity_type: "Other",
      charity_reg_date: "2013-11-05",
    });
    // A minimal 200: the charity is on the register, but only its name is
    // published this time.
    respondWith({ name: "Belfast South Foodbank" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    const row = foodbankRow();
    expect(row.charity_name).toBe("Belfast South Foodbank");
    expect(row.charity_website).toBeNull();
    expect(row.charity_purpose).toBeNull();
    expect(row.charity_objectives).toBeNull();
    expect(row.charity_postcode).toBeNull();
    expect(row.charity_type).toBeNull();
    expect(row.charity_reg_date).toBeNull();
    // ...and last_charity_check still says the crawl succeeded, so nothing
    // downstream can tell this apart from a genuinely empty register entry.
    expect(row.last_charity_check).toBe(DJANGO_NOW);
  });
});

// ===========================================================================
// THE WEBSITE PLACEHOLDERS -- an NI-only defect by origin
// ===========================================================================
//
// crawlOpenCharities.ts:96-102 exists because of this queue: "The NI register
// lets a charity file the literal string 'n/a' as its website, and
// opencharities passes it through faithfully. Django never saw it, because
// crawlNi.ts's endpoint has been 404ing. Writing it into charity_website would
// render a link to https://n/a on the food bank page." So the list below is
// only ever exercised in production by NI rows.
describe("placeholder websites the NI register accepts", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(1);
  });

  for (const placeholder of ["n/a", "N/A", "  n/a  ", "na", "none", "None", "-", "tbc", "TBC", "no website", "No Website"]) {
    it(`treats ${JSON.stringify(placeholder)} as no website at all`, async () => {
      respondWith({ website: placeholder });

      await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

      expect(foodbankRow().charity_website).toBeNull();
    });
  }

  // The placeholder set is matched WHOLE, after trimming and lowercasing.
  // A substring match would eat every one of these, and "Nantwich" or a real
  // domain containing "na" is not a placeholder.
  for (const real of ["https://na.example.org", "http://nowebsite.example", "www.tbc-foodbank.org.uk", "https://none.example/na"]) {
    it(`keeps ${JSON.stringify(real)}, which merely contains a placeholder`, async () => {
      respondWith({ website: real });

      await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

      expect(foodbankRow().charity_website).toBe(real);
    });
  }

  // Whitespace is trimmed off a real value too, not just off placeholders --
  // a stored " https://x " would break the href on the food bank page.
  it("trims a real website before storing it", async () => {
    respondWith({ website: "  https://belfastsouth.example  " });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(foodbankRow().charity_website).toBe("https://belfastsouth.example");
  });

  it("stores null for an empty string, not an empty string", async () => {
    setCharityColumns(BELFAST, { charity_website: "https://old.example" });
    respondWith({ website: "   " });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(foodbankRow().charity_website).toBeNull();
  });
});

// ===========================================================================
// THE URL -- where the NIC prefix goes
// ===========================================================================
describe("the opencharities URL an NI food bank produces", () => {
  beforeEach(() => {
    seedCrawlSet(1);
  });

  // Foodbank.open_charities_url() (givefood/models/foodbank.py:339-347) and
  // Django's own `reg_id = foodbank.charity_number.replace("NIC","")`
  // (crawlers.py:234) both strip the prefix, because the register's numbers
  // have none. Leaving it on is a 404 for every NI food bank at once -- which
  // is indistinguishable, in the logs, from the regulator being down.
  it("strips the NIC prefix D1 stores", async () => {
    seedFoodbank({ charity_number: "NIC101234" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/101234.json"]);
  });

  it("leaves a bare number alone", async () => {
    seedFoodbank({ charity_number: "101234" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/101234.json"]);
  });

  // SUSPECT (cosmetic, no known real number hits it) -- pinned, reported, not
  // fixed. Python's str.replace has no count argument and replaces EVERY
  // occurrence; JavaScript's String.prototype.replace with a string pattern
  // replaces only the FIRST. Run on this machine rather than recalled:
  // CPython 3.13.0 gives '100001' for 'NICNIC100001'.replace('NIC',''), and
  // node gives 'NIC100001'. Real NI numbers are "NIC" + six digits, so nothing
  // in production takes this branch today.
  it("removes only the first NIC, where Django removed them all", async () => {
    seedFoodbank({ charity_number: "NICNIC100001" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/NIC100001.json"]);
  });

  // Also inherited from Django, which uses the same unanchored replace: the
  // strip is not prefix-only, so "NIC" anywhere in the number disappears.
  // Asserted so that a future "tidy" to a ^NIC anchor is a visible change of
  // behaviour rather than a silent one.
  it("removes NIC from the middle of a number too", async () => {
    seedFoodbank({ charity_number: "101NIC234" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/101234.json"]);
  });

  // Lowercase is NOT stripped -- and neither did Django strip it. An
  // admin-typed "nic101234" therefore asks for a path that cannot exist and
  // gets the ordinary 404 handling.
  it("does not strip a lowercase nic", async () => {
    seedFoodbank({ charity_number: "nic101234" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/nic101234.json"]);
  });

  // The cron filters empty charity numbers out (getFoodbanksByCountryForCharityCrawl:
  // `charity_number IS NOT NULL AND charity_number != ''`), but /admin/'s
  // force-crawl route does not, so this body IS reachable. It asks for a
  // nonsense path and takes the 404 route rather than throwing.
  it("still builds a URL for an empty charity number, and survives the 404", async () => {
    seedFoodbank({ charity_number: "" });
    reply = { status: 404, body: "not found" };
    const { batch, acks } = batchOf("charity-ni", [message()]);

    await handleCharityNiQueue(batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/.json"]);
    expect(acks).toEqual([0]);
    expect(logs).toContain("charity: opencharities 404 for belfast (ni/)");
  });

  // A number with a space or a slash in it must not escape the path segment.
  // encodeURIComponent is what stops "NIC 101234/2" from addressing a
  // different resource entirely.
  it("percent-encodes a charity number that is not URL-safe", async () => {
    seedFoodbank({ charity_number: "NIC101234/2" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/101234%2F2.json"]);
  });

  // THE REGISTER IS CHOSEN BY THE ROW, NOT BY THE QUEUE. This consumer is fed
  // only Northern Irish food banks by the cron (scheduled/index.ts:223), but
  // nothing enforces that, and the module's header says the split "now buys
  // only retry isolation". A Scottish row force-crawled onto this queue must
  // still be looked up in the Scottish register -- and must use SCOTLAND's
  // field mapping, which is `purposes` for charity_purpose rather than NI's
  // `what_charity_does`. Hardcoding "ni" here would look like a simplification
  // and would corrupt exactly this case.
  it("uses the food bank's own country, so a Scottish row on this queue goes to /sc/", async () => {
    seedFoodbank({ country: "Scotland", charity_number: "SC012345" });
    // The middle purpose carries a COMMA INSIDE its quotes, which OSCR's own
    // wording does ("the advancement of education, arts and culture"). That is
    // the only input that distinguishes toLines' quote-aware split from a plain
    // `split(",")`: with `const quoted = false` this response yields four lines
    // instead of three, and that mutant survived until this fixture said so.
    respondWith({
      purposes: "'the prevention or relief of poverty','the advancement of education, arts and culture','the advancement of health'",
      objectives: "To relieve poverty in Dundee",
    });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/sc/SC012345.json"]);
    // Scotland's mapping: purposes -> purpose (quote-stripped and split),
    // objectives -> objectives. Under NI's mapping charity_purpose would have
    // been null and charity_objectives would hold the quoted array.
    expect(foodbankRow().charity_purpose).toBe("the prevention or relief of poverty\nthe advancement of education, arts and culture\nthe advancement of health");
    expect(foodbankRow().charity_objectives).toBe("To relieve poverty in Dundee");
  });

  // Isle of Man has one food bank, matches no branch in COUNTRY_CODE (nor in
  // Django's, crawlers.py:94-101) and has no register at opencharities. It is
  // enqueued by nothing today, but a manual enqueue must not wedge the queue.
  it("fetches nothing and acks for a country with no register", async () => {
    seedFoodbank({ country: "Isle of Man", charity_name: "STALE NAME" });
    const { batch, acks, retries } = batchOf("charity-ni", [message()]);

    await handleCharityNiQueue(batch, env);

    expect(fetchCalls).toEqual([]);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(logs).toContain("charity: no register for country Isle of Man (belfast)");
    // Nothing was checked, so nothing may claim to have been: a
    // last_charity_check stamped here would make an unregisterable food bank
    // indistinguishable, on /admin/, from one that was crawled cleanly this
    // morning. (The mutation that stamps it anyway is otherwise invisible --
    // every other assertion in this test still passes.)
    expect(foodbankRow().last_charity_check).toBeNull();
    expect(foodbankRow().charity_name).toBe("STALE NAME");
    // The crawl item is still closed and the counter still moves: an
    // unregisterable food bank must not hold a crawl set open.
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(0);
  });
});

// ===========================================================================
// FINANCIAL YEARS -- brand new data for Northern Ireland
// ===========================================================================
//
// crawlOpenCharities.ts:59-62: "_crawl_charity_ni never touched CharityYear,
// because the regulator's export carries no financial rows." Confirmed in
// Django: _crawl_charity_ni (crawlers.py:229-278) imports only CrawlItem and
// writes four Foodbank fields -- no CharityYear anywhere, unlike
// _crawl_charity_ew. Every row this block writes is a row NI food banks have
// never had.
describe("the charity years an NI response brings", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(1);
  });

  it("writes one row per published year, newest first when read back", async () => {
    respondWith({
      financial_years: [
        { end: "2024-03-31", income: 412000, expenditure: 398000 },
        { end: "2023-03-31", income: 355000, expenditure: 340000 },
      ],
    });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(charityYears()).toEqual([
      { date: "2024-03-31", income: 412000, expenditure: 398000, created: DJANGO_NOW },
      { date: "2023-03-31", income: 355000, expenditure: 340000, created: DJANGO_NOW },
    ]);
  });

  // A year with no end date has nothing to sort or label it by, so it is
  // dropped rather than written with a NULL date -- charityyear.date is what
  // the charity panel groups on.
  it("drops a year with no end date instead of writing a null-dated row", async () => {
    respondWith({
      financial_years: [
        { end: "2024-03-31", income: 1, expenditure: 2 },
        { end: null, income: 3, expenditure: 4 },
        { end: "", income: 5, expenditure: 6 },
      ],
    });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2024-03-31", income: 1, expenditure: 2, created: DJANGO_NOW }]);
  });

  // Missing income/expenditure become 0, not NULL: the column is summed and
  // rendered as currency.
  it("defaults a missing income or expenditure to zero", async () => {
    respondWith({ financial_years: [{ end: "2024-03-31" }] });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2024-03-31", income: 0, expenditure: 0, created: DJANGO_NOW }]);
  });

  // PLAN.md §8.7.1's fix, from the direction that matters: when the register
  // publishes NO years, replaceCharityYears is never called, so last run's
  // history survives. Django deleted first (crawlers.py:147/207) and would
  // have left the food bank with nothing.
  it("keeps the existing history when the response carries no years at all", async () => {
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2023-03-31', 355000, 340000, ?)").run(BELFAST, DJANGO_NOW);
    respondWith({ name: "Belfast South Foodbank" });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2023-03-31", income: 355000, expenditure: 340000, created: DJANGO_NOW }]);
  });

  // ...and the same when every year in the response was unusable, since the
  // filter runs before the length check.
  it("keeps the existing history when every published year lacks an end date", async () => {
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2023-03-31', 355000, 340000, ?)").run(BELFAST, DJANGO_NOW);
    respondWith({ financial_years: [{ end: null, income: 1, expenditure: 1 }] });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2023-03-31", income: 355000, expenditure: 340000, created: DJANGO_NOW }]);
  });

  // The replace is a DELETE keyed on foodbank_id followed by inserts. A DELETE
  // that lost its WHERE would empty every other food bank's history, and
  // nothing would notice until someone opened a charity page months later.
  it("replaces only this food bank's years", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", country: "England", charity_number: "1122447", charity_name: "SALISBURY FOODBANK" });
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2020-03-31', 1, 2, ?)").run(BELFAST, DJANGO_NOW);
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2020-03-31', 3, 4, ?)").run(SALISBURY, DJANGO_NOW);
    respondWith({ financial_years: [{ end: "2024-03-31", income: 9, expenditure: 8 }] });

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2024-03-31", income: 9, expenditure: 8, created: DJANGO_NOW }]);
    expect(charityYears(SALISBURY)).toEqual([{ date: "2020-03-31", income: 3, expenditure: 4, created: DJANGO_NOW }]);
    // ...and nothing was patched on the England row either.
    expect(foodbankRow(SALISBURY).charity_name).toBe("SALISBURY FOODBANK");
    expect(foodbankRow(SALISBURY).last_charity_check).toBeNull();
  });
});

// ===========================================================================
// WHEN THE REGISTER DOES NOT ANSWER -- NI's historical normal state
// ===========================================================================
describe("when opencharities does not return a charity", () => {
  beforeEach(() => {
    seedFoodbank({ charity_name: "STALE NAME" });
    setCharityColumns(BELFAST, { charity_website: "https://belfastsouth.example", charity_purpose: "Food Banks" });
    seedCrawlSet(2);
  });

  // THE CONTRACT queues/charity.ts's header RESTS ON: "The crawler never throws
  // for an external-API-level failure ... only a genuine D1 write failure
  // propagates here to retry." A 404 is a charity number that has moved or been
  // removed, which no amount of retrying fixes; if it ever started throwing,
  // each one would burn three deliveries and land in charity-ni-dlq.
  it("acks a 404, patches nothing, and still closes the crawl item", async () => {
    reply = { status: 404, body: "not found" };
    const { batch, acks, retries } = batchOf("charity-ni", [message()]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    // Nothing patched, nothing nulled -- the same effect as Django's
    // `if response.status_code == 200:` guard at crawlers.py:245.
    expect(foodbankRow().charity_name).toBe("STALE NAME");
    expect(foodbankRow().charity_website).toBe("https://belfastsouth.example");
    expect(foodbankRow().charity_purpose).toBe("Food Banks");
    // ...including last_charity_check, so a food bank whose number has moved is
    // still visibly un-checked rather than looking freshly verified.
    expect(foodbankRow().last_charity_check).toBeNull();
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(1);
    // console.log, not console.error: a 404 is expected traffic here.
    expect(logs).toContain("charity: opencharities 404 for belfast (ni/101234)");
    expect(errors).toEqual([]);
  });

  // Every non-200 takes the same path. 500 and 429 are the ones a small
  // independent mirror actually produces under load, and the interesting thing
  // is that they are NOT retried either -- a night's data is lost rather than
  // the queue backing off. Pinned because it is a real, deliberate cost, not
  // because it is obviously right.
  for (const status of [301, 429, 500, 503]) {
    it(`acks a ${status} without retrying`, async () => {
      reply = { status, body: "" };
      const { batch, acks, retries } = batchOf("charity-ni", [message()]);

      await handleCharityNiQueue(batch, env);

      expect(acks).toEqual([0]);
      expect(retries).toEqual([]);
      expect(foodbankRow().charity_name).toBe("STALE NAME");
      expect(logs).toContain(`charity: opencharities ${status} for belfast (ni/101234)`);
    });
  }

  // A rejected fetch -- DNS, TLS, or the 20s AbortSignal.timeout firing -- is
  // swallowed the same way. A total opencharities outage therefore costs one
  // night's charity data and closes the crawl set cleanly, instead of filling
  // three dead-letter queues nobody is watching.
  it("acks when the fetch itself rejects", async () => {
    reply = new TypeError("fetch failed");
    const { batch, acks, retries } = batchOf("charity-ni", [message()]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(1);
    expect(foodbankRow().last_charity_check).toBeNull();
    // console.error this time -- a rejected fetch is not expected traffic.
    expect(errors[0]![0]).toBe("charity: opencharities fetch failed for belfast");
  });

  // A 200 whose body is not JSON. res.json() rejects INSIDE the same try, so
  // it is caught by the same handler as a network failure: acked, logged as a
  // fetch failure, nothing patched. Worth pinning because opencharities
  // serving an HTML error page with a 200 is a realistic mirror failure and
  // the log line it produces ("fetch failed") reads misleadingly.
  it("acks a 200 that is not JSON, logging it as a fetch failure", async () => {
    reply = { status: 200, body: "<html>upstream error</html>" };
    const { batch, acks, retries } = batchOf("charity-ni", [message()]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(foodbankRow().charity_name).toBe("STALE NAME");
    expect(foodbankRow().last_charity_check).toBeNull();
    expect(errors[0]![0]).toBe("charity: opencharities fetch failed for belfast");
  });

  // A 200 carrying JSON `null` is falsy, so `if (!data) return` treats it as no
  // answer at all -- no patch, no log line of any kind, and an ack. Silent, but
  // harmless; pinned so the silence is a decision on record.
  it("acks a 200 whose body is literally null, silently", async () => {
    reply = { status: 200, body: "null" };
    const { batch, acks } = batchOf("charity-ni", [message()]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(foodbankRow().last_charity_check).toBeNull();
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
  });

  // An empty JSON object is NOT falsy, so it patches -- with nulls everywhere
  // and a fresh last_charity_check. Same shape as the omitted-fields case
  // above and pinned for the same reason: it is how "the register knows
  // nothing about this charity but answered 200" is recorded.
  it("treats an empty JSON object as a real answer and blanks the row", async () => {
    reply = { status: 200, body: "{}" };

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(foodbankRow().charity_name).toBeNull();
    expect(foodbankRow().charity_website).toBeNull();
    expect(foodbankRow().last_charity_check).toBe(DJANGO_NOW);
  });
});

// ===========================================================================
// THE BOOKKEEPING THIS CONSUMER OWES THE CRAWL DASHBOARD
// ===========================================================================
//
// Not a re-test of queues/charity.ts, which has its own suite: these run the
// composed export, because the numbers on /admin/jobs/ are produced by the
// composition and by nothing else. A charity CrawlSet is fanned out across all
// three regulator queues with one shared id, so this consumer can be the one
// that closes a set out.
describe("the crawl item and the crawl set", () => {
  beforeEach(() => {
    seedFoodbank();
    respondWith({ name: "Belfast South Foodbank" });
  });

  it("opens one crawlitem, closes it, and stamps Django-format timestamps", async () => {
    seedCrawlSet(3);
    const { batch, acks, retries } = batchOf("charity-ni", [message()]);

    await handleCharityNiQueue(batch, env);

    const items = crawlItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.foodbank_id).toBe(BELFAST);
    expect(items[0]!.crawl_set_id).toBe(CRAWL_SET);
    // "charity", not "need" or "article": the crawl dashboards group on this
    // string and a wrong one files the row under another job silently.
    expect(items[0]!.crawl_type).toBe("charity");
    expect(items[0]!.start).toBe(DJANGO_NOW);
    expect(items[0]!.finish).toBe(DJANGO_NOW);
    expect(items[0]!.start).not.toContain("T");
    expect(items[0]!.need_id).toBeNull();
    // A DELIBERATE DIVERGENCE. Django put the regulator URL on the CrawlItem
    // (crawlers.py:235-241 for NI); the port passes null because the URL is
    // now built inside the crawler. Anything reading crawlitem.url for a
    // charity row gets NULL where production Django had a link.
    expect(items[0]!.url).toBeNull();
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  it("decrements the shared crawlset exactly once and leaves it open", async () => {
    seedCrawlSet(3);

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(crawlSet().remaining).toBe(2);
    expect(crawlSet().expected).toBe(3);
    expect(crawlSet().finish).toBeNull();
  });

  // NI is the smallest of the three fan-outs, so it very often finishes last
  // -- meaning this consumer is frequently the one that stamps `finish` on a
  // set whose other members were crawled by charity-ew.
  it("closes the crawlset when it is the one that takes remaining to zero", async () => {
    seedCrawlSet(1, 99);
    seedCrawlSet(3);

    await handleCharityNiQueue(batchOf("charity-ni", [message({ crawlSetId: 99 })]).batch, env);

    expect(crawlSet(99).remaining).toBe(0);
    expect(crawlSet(99).finish).toBe(DJANGO_NOW);
    // The set this message did NOT belong to is untouched -- a decrement that
    // ignored its crawlSetId would pass any test that seeds only one set.
    expect(crawlSet(CRAWL_SET).remaining).toBe(3);
    expect(crawlSet(CRAWL_SET).finish).toBeNull();
  });

  // One session per MESSAGE, not per batch: read-your-writes only holds inside
  // a D1 session, and the insert-then-patch-then-close sequence for one food
  // bank has to be inside one of them or a replica can answer stale.
  it("opens one first-unconstrained session per message", async () => {
    seedCrawlSet(3);
    seedFoodbank({ id: LISBURN, slug: "lisburn", name: "Lisburn Foodbank", country: "Northern Ireland", charity_number: "NIC100002" });

    await handleCharityNiQueue(batchOf("charity-ni", [message(), message({ foodbankId: LISBURN, slug: "lisburn" })]).batch, env);

    expect(sessionModes).toEqual(["first-unconstrained", "first-unconstrained"]);
  });

  it("logs nothing on success -- a quiet queue is a working queue", async () => {
    seedCrawlSet(3);

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);

    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
  });

  // The row handed to the crawler is re-read from D1 at dequeue time, not
  // taken from the message body -- the cron's snapshot can be hours stale by
  // the time a queue drains. The body here carries a slug that no longer
  // matches, and the URL proves which one was used.
  it("crawls the row D1 has now, not the snapshot in the message", async () => {
    seedCrawlSet(1);
    db.prepare("UPDATE foodbank SET slug = 'belfast-south', charity_number = 'NIC109999' WHERE id = ?").run(BELFAST);

    await handleCharityNiQueue(batchOf("charity-ni", [message({ slug: "belfast" })]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/109999.json"]);
  });
});

// ===========================================================================
// FAILURE AND REDELIVERY
// ===========================================================================
describe("when a message cannot be completed", () => {
  beforeEach(() => {
    seedCrawlSet(3);
    respondWith({ name: "Belfast South Foodbank" });
  });

  // Deleted (or closed and purged) between the cron's enqueue and this
  // dequeue. Retried rather than acked, which means three attempts at 60s and
  // then charity-ni-dlq -- the DLQ consumer is what finally decrements the
  // counter so the set is not stuck open forever.
  it("retries and opens no crawlitem when the food bank has gone", async () => {
    const { batch, acks, retries } = batchOf("charity-ni", [message({ foodbankId: 999, slug: "vanished" })]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(crawlItems()).toEqual([]);
    expect(crawlSet().remaining).toBe(3);
    expect(fetchCalls).toEqual([]);
  });

  // THE SAME CASE FROM BELOW, and the mutant the one above cannot see: it uses
  // foodbankId 999, which is higher than every seeded row, so
  // getFoodbankForCharityCrawl's `WHERE id = ?1` loosened to `WHERE id >= ?1`
  // still matches nothing and still throws. It survived this file's first
  // mutation run for exactly that reason.
  //
  // Here the vanished id is LOWER than a real row, which is what a deleted food
  // bank actually looks like -- ids are handed out in creation order, so almost
  // every deleted one has neighbours above it. A lookup that is not an exact
  // match then crawls the NEXT food bank along and files the result against it:
  // Lisburn's charity data overwritten from Belfast's charity number, acked,
  // with nothing in the logs.
  it("does not fall through to the next food bank when the message's own has gone", async () => {
    seedFoodbank({ id: LISBURN, slug: "lisburn", name: "Lisburn Foodbank", country: "Northern Ireland", charity_number: "NIC100002", charity_name: "LISBURN FOODBANK" });
    const { batch, acks, retries } = batchOf("charity-ni", [message({ foodbankId: BELFAST, slug: "belfast" })]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(errors[0]![1]).toContain("charity: foodbank 44 (belfast) no longer exists");
    // The neighbour was neither fetched for nor written to.
    expect(fetchCalls).toEqual([]);
    expect(crawlItems()).toEqual([]);
    expect(foodbankRow(LISBURN).charity_name).toBe("LISBURN FOODBANK");
    expect(foodbankRow(LISBURN).last_charity_check).toBeNull();
  });

  // The D1 write failure the header says is the only thing that reaches the
  // catch. The crawl is half done -- fetched, not stored -- so the item must
  // stay OPEN: `finish IS NULL` is the only stall signal there is
  // (0008_needcheck.sql's own comment), and a row stamped here would make a
  // crashed NI crawl indistinguishable from a clean one.
  it("leaves the crawlitem open and retries when the charity patch fails", async () => {
    seedFoodbank({ charity_name: "STALE NAME" });
    failOn = /UPDATE foodbank SET/;
    const { batch, acks, retries } = batchOf("charity-ni", [message()]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet().remaining).toBe(3);
    expect(foodbankRow().charity_name).toBe("STALE NAME");
    expect(errors[0]![0]).toBe("charity-ni: message failed for foodbank 44 (belfast)");
  });

  // The charityyear batch is the second D1 write, after the patch has already
  // committed. Retrying re-runs both, which is safe because the patch is
  // idempotent and the years are replaced wholesale.
  it("retries when writing the charity years fails, after the patch has landed", async () => {
    seedFoodbank();
    respondWith({ name: "Belfast South Foodbank", financial_years: [{ end: "2024-03-31", income: 1, expenditure: 2 }] });
    failOn = /INSERT INTO charityyear/;
    const { batch, acks, retries } = batchOf("charity-ni", [message()]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([]);
    // The options, not just the count: the backoff has to survive on THIS path
    // too, and a bare `message.retry()` here would hammer a D1 that is already
    // failing at max_concurrency 10.
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(foodbankRow().charity_name).toBe("Belfast South Foodbank");
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet().remaining).toBe(3);
  });

  // The 60s is not decoration: it is the same backoff needcheckRender.ts uses,
  // so a provider outage is not hit again instantly at max_concurrency 10
  // (wrangler.jsonc:189-190). A bare `message.retry()` redelivers immediately
  // and is the mutant this kills.
  it("backs the retry off by 60 seconds", async () => {
    const { batch, retries } = batchOf("charity-ni", [message({ foodbankId: 999, slug: "vanished" })]);

    await handleCharityNiQueue(batch, env);

    expect(retries[0]!.options).toEqual({ delaySeconds: 60 });
  });

  // Cloudflare Queues is at-least-once, so the same tick genuinely arrives
  // twice. The upsert on crawlitem_crawlset_foodbank_uniq plus finishCrawlItem's
  // `finish IS NULL` guard are the whole idempotency story: without the upsert
  // the second delivery orphans a row that never gets finished (which looks
  // exactly like a stall), and without the guard `remaining` drops twice for
  // one food bank and the set can close before other food banks are crawled.
  it("is idempotent across a redelivery", async () => {
    seedFoodbank();

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);
    const second = batchOf("charity-ni", [message()]);
    await handleCharityNiQueue(second.batch, env);

    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(2);
    expect(second.acks).toEqual([0]);
    // The cost that idempotency does NOT cover, pinned rather than endorsed:
    // the crawler runs again first, so the redelivery is a second
    // opencharities GET and a second identical patch.
    expect(fetchCalls).toHaveLength(2);
  });

  // The same duplicate, delivered inside ONE batch rather than across two --
  // which is what Cloudflare's at-least-once actually looks like when a
  // consumer invocation times out after committing: the retry can arrive
  // alongside a fresh copy. Both messages run the whole of processOne against
  // their own session, so the guards have to hold within a single invocation
  // too, not just between invocations.
  it("is idempotent for a duplicate inside one batch", async () => {
    seedFoodbank();
    const { batch, acks, retries } = batchOf("charity-ni", [message(), message()]);

    await handleCharityNiQueue(batch, env);

    // Both acked -- neither is treated as an error...
    expect(acks).toEqual([0, 1]);
    expect(retries).toEqual([]);
    // ...one crawlitem, because of crawlitem_crawlset_foodbank_uniq...
    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    // ...and ONE decrement, because finishCrawlItem's `finish IS NULL` guard
    // answered false the second time. Two would let a charity crawl set close
    // while other food banks in it were still unfetched, which stamps `finish`
    // on a set that is not finished.
    expect(crawlSet().remaining).toBe(2);
  });

  // Uniqueness is (crawl_set_id, foodbank_id), so tomorrow night's run for the
  // same food bank opens a SECOND row rather than reusing tonight's.
  it("opens a fresh crawlitem for the next night's crawl set", async () => {
    seedFoodbank();
    seedCrawlSet(1, 8);

    await handleCharityNiQueue(batchOf("charity-ni", [message()]).batch, env);
    await handleCharityNiQueue(batchOf("charity-ni", [message({ crawlSetId: 8 })]).batch, env);

    expect(crawlItems().map((row) => row.crawl_set_id)).toEqual([CRAWL_SET, 8]);
    expect(crawlSet(CRAWL_SET).remaining).toBe(2);
    expect(crawlSet(8).remaining).toBe(0);
    expect(crawlSet(8).finish).toBe(DJANGO_NOW);
  });

  // wrangler.jsonc:189 gives charity-ni max_batch_size 5. One food bank whose
  // crawl fails must not cost the other four theirs -- the try/catch is per
  // message for exactly this reason, and a throw escaping the loop would
  // silently redeliver four healthy messages every night.
  it("isolates a bad message from the rest of its batch", async () => {
    seedFoodbank();
    seedFoodbank({ id: LISBURN, slug: "lisburn", name: "Lisburn Foodbank", country: "Northern Ireland", charity_number: "NIC100002" });
    const { batch, acks, retries } = batchOf("charity-ni", [message(), message({ foodbankId: 999, slug: "vanished" }), message({ foodbankId: LISBURN, slug: "lisburn" })]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([0, 2]);
    expect(retries.map((r) => r.index)).toEqual([1]);
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([BELFAST, LISBURN]);
    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ni/101234.json", "https://opencharities.uk/ni/100002.json"]);
    // Two of three accounted for; the third is the DLQ's problem.
    expect(crawlSet().remaining).toBe(1);
    expect(crawlSet().finish).toBeNull();
  });

  it("does nothing at all for an empty batch", async () => {
    await handleCharityNiQueue(batchOf("charity-ni", []).batch, env);

    expect(sessionModes).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(crawlItems()).toEqual([]);
    expect(crawlSet().remaining).toBe(3);
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here. Inherited from
  // queues/charity.ts, but reachable through this export and therefore real
  // for this queue.
  //
  // The catch block dereferences `message.body.foodbankId` to build its log
  // line. For a body of `null` that dereference throws INSIDE the catch, so the
  // error escapes the handler entirely: the rest of the batch is never looked
  // at, and messages after the bad one are neither acked nor retried. One
  // unparseable message therefore poisons up to four healthy ones, every
  // delivery, until the batch exhausts max_retries.
  it("takes the rest of the batch down with it when a body is null", async () => {
    seedFoodbank();
    seedFoodbank({ id: LISBURN, slug: "lisburn", name: "Lisburn Foodbank", country: "Northern Ireland", charity_number: "NIC100002" });
    const { batch, acks, retries } = batchOf("charity-ni", [message(), null, message({ foodbankId: LISBURN, slug: "lisburn" })]);

    await expect(handleCharityNiQueue(batch, env)).rejects.toThrow(TypeError);

    // The first message committed and acked before the crash...
    expect(acks).toEqual([0]);
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([BELFAST]);
    // ...and the third was never even looked at.
    expect(retries).toEqual([]);
    expect(crawlSet().remaining).toBe(2);
  });

  // A body missing foodbankId fails at the bind instead, which the catch
  // handles: logged with `undefined` in place of the id, and retried. Retrying
  // a message that can never succeed is three wasted deliveries, but it does
  // end at the DLQ where a human can see it.
  it("logs and retries a body with no foodbankId", async () => {
    const { batch, acks, retries } = batchOf("charity-ni", [{ crawlSetId: CRAWL_SET }]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(errors[0]![0]).toBe("charity-ni: message failed for foodbank undefined (undefined)");
    expect(crawlItems()).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  // A crawlSetId pointing at no set is not an error: the decrement's UPDATE
  // matches nothing and returns null. The message acks with a dangling
  // crawl_set_id on the item. This is the shape a manual one-off enqueue takes.
  it("completes and acks for a crawlset that does not exist", async () => {
    seedFoodbank();
    const { batch, acks, retries } = batchOf("charity-ni", [message({ crawlSetId: 4242 })]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(crawlItems()[0]!.crawl_set_id).toBe(4242);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(foodbankRow().charity_name).toBe("Belfast South Foodbank");
    expect(crawlSet().remaining).toBe(3);
  });

  // The `AND remaining > 0` guard. An extra message against an already-drained
  // set -- a redelivery of the very last one, say -- must not push the counter
  // negative or re-stamp `finish`.
  it("leaves an already-drained crawlset at zero", async () => {
    seedFoodbank();
    seedCrawlSet(0, 77);
    const { batch, acks } = batchOf("charity-ni", [message({ crawlSetId: 77 })]);

    await handleCharityNiQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(crawlSet(77).remaining).toBe(0);
    expect(crawlSet(77).finish).toBeNull();
  });
});
