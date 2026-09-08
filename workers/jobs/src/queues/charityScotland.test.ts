import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import type { Env } from "../../worker-configuration";
import type { CharityMessage } from "./charity";
import { handleCharityScotlandQueue } from "./charityScotland";
import { handleCharityEwQueue } from "./charityEw";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning,
// as packages/db/src/schema.testkit.ts:35 and queues/charity.test.ts:12.
import { DatabaseSync } from "node:sqlite";

// queues/charityScotland.ts -- the consumer bound to the `charity-scotland`
// queue (wrangler.jsonc:183-186, dispatched at index.ts:40-41). The whole
// module is one line:
//
//   export const handleCharityScotlandQueue =
//     makeCharityQueueHandler("charity-scotland", crawlOpenCharities);
//
// WHY A ONE-LINE MODULE IS WORTH A TEST FILE. charityEw.ts, charityScotland.ts
// and charityNi.ts are byte-identical apart from two tokens each -- the queue
// label and the exported name. That is exactly the shape that survives a
// copy-paste with one token left behind, and NOTHING would catch it: the label
// only ever appears in a console.error on a failed message, in a Worker that
// runs at 05:30 with nobody watching. A Scottish crawl failure filed under
// "charity-ew" sends whoever reads the logs to the wrong regulator. So the
// first block below runs this handler and E&W's side by side and reads the log
// lines back.
//
// The other half of the value is the SCOTTISH DATA PATH. queues/charity.test.ts
// covers the makeCharityQueueHandler factory (with a stand-in fetcher, and an
// end-to-end block that uses England and Northern Ireland); nothing anywhere
// exercises what a Scottish food bank's row actually looks like after this
// handler has run. Scotland is the register whose values arrive in a shape
// nothing else uses -- OSCR's arrays comma-joined and quote-wrapped, which
// crawlOpenCharities.ts:120-127 unpicks with toLines() -- and it is the one
// where the port deliberately stops writing a column Django wrote
// (charity_id, crawlers.py:196). Both are asserted here against real rows.
//
// REAL THINGS, NOT MOCKS:
//   * node:sqlite carrying the WHOLE real migration set (MIGRATIONS_SQL rather
//     than schemaFor(...)): this path writes foodbank, crawlitem, crawlset and
//     charityyear through five shared packages/db functions, and a narrow
//     hand-built fixture is how a suite develops a gap the day one of those
//     queries starts reading one more object.
//   * the real production handler -- the exported const itself, not a
//     rebuilt makeCharityQueueHandler("charity-scotland", ...). Rebuilding it
//     here would test this file's copy of the wiring, which is the only thing
//     the module contains.
//   * the real crawlOpenCharities behind it, and the real
//     getFoodbankForCharityCrawl / insertCrawlItem / patchFoodbankCharity /
//     replaceCharityYears / finishCrawlItem / decrementCrawlSetRemaining.
//
// MOCKED, and only this: `fetch` (opencharities.uk is the single thing that
// leaves the machine) and the MessageBatch, which is a runtime object
// Cloudflare hands in and has no local equivalent.
//
// PARITY. givefood/utils/crawlers.py at /Users/jasoncartwright/Sites/foodcharity
// was read directly for every Django claim below -- `foodbank_charity_crawl`
// (:79-101) and `_crawl_charity_scotland` (:172-227). No Python was executed
// for this file and nothing below claims otherwise; the citations are line
// references, read. The JSON fixtures are shaped from the field names in
// crawlOpenCharities.ts's own OpenCharity interface and its header notes on
// what Scotland sends; they are NOT captured from a live opencharities.uk
// response, which this machine cannot reach from a test.
//
// MUTATION-TESTED. The repo was cloned to a scratch directory OUTSIDE it,
// source files broken there, and this file re-run against each break. No
// source file was ever edited in place in the working tree.
//
// The file arrived carrying its author's own pass -- 29 breakages, 28 dead,
// one recorded survivor (Northern Ireland's `.replace("NIC", "")` applied to
// every register). Those runs cannot be re-verified from here and that
// survivor is now dead, so the numbers that follow are the ADVERSARIAL
// REVIEW pass, which was run: 82 breakages across charityScotland.ts,
// queues/charity.ts, charity/crawlOpenCharities.ts, packages/db/src/
// charity.ts and packages/db/src/needcheck.ts. 73 died against the file as
// it stood. Of the 9 survivors one is an equivalent mutant -- `JSON.parse(
// await res.text())` in place of `res.json()`, same throw from the same
// try -- and the other 8 were real holes, now closed. Each is named again
// at the assertion that kills it, so a later edit that guts one is visible.
//
// THE 8 HOLES:
//   1-4. purposeFor/objectivesFor's entire ew branch -- deleted, its
//        `type === "What"` filter widened, its trailing newline dropped,
//        and `objectives` read where `activities` belongs -- all survived,
//        because the single test that routes an English row through this
//        handler asserted only the fetched URL while its comment claimed it
//        proved the branch had run. It now reads the columns back.
//     5. `toLines(data.purposes ?? data.what_charity_does)`, the one-chain
//        collapse crawlOpenCharities.ts:142-144 warns against in prose. It
//        diverges only when `purposes` is ABSENT, which no fixture had.
//     6. NI's `.replace("NIC", "")` applied to every register: nothing here
//        used a number containing that substring.
//   7-8. `encodeURIComponent` dropped from the request path, and with it
//        the `?? ""` that keeps a NULL charity number out of the URL.
//
// The genuinely uncovered edit, stated rather than left to be discovered:
// changing AbortSignal.timeout(20_000) to any other non-zero number. See
// the fetch test for why it is not reachable from this file.

// ===========================================================================
// HARNESS -- lifted from queues/charity.test.ts so the two files fail the same
// way, rather than each inventing its own D1 double.
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
 * standing in for a D1 outage mid-message. Mutable between deliveries so a
 * TRANSIENT failure can be modelled -- fails once, succeeds on the redelivery
 * Cloudflare Queues is guaranteed to send.
 */
let failOn: RegExp | null = null;

/** Every bookmark mode `withSession` was asked for, in call order. */
let sessionModes: string[] = [];

/**
 * The D1 Sessions API surface packages/db uses, over the real engine. It
 * carries SQL to node:sqlite and does nothing else: a session that answered
 * canned rows would be a second implementation of the queries under test, and
 * the upsert / `WHERE finish IS NULL` / `AND remaining > 0` behaviour those
 * queries lean on is precisely what has to be real here.
 *
 * FIDELITY LIMIT, stated rather than hidden: real D1 rejects an `undefined`
 * bind value at .bind() time with D1_TYPE_ERROR, whereas node:sqlite rejects it
 * at execution time with a TypeError. Both throw out of the same call, which is
 * all the malformed-message tests depend on, but the message text differs and
 * nothing asserts on it.
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
 * A MessageBatch double. `queue` is a parameter rather than a constant because
 * one test below delivers a batch stamped with the WRONG queue name, to prove
 * the log label comes from this module's wiring and not from the batch.
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
// digits, never a "T" and never a "Z". crawlitem.start/finish, crawlset.finish,
// charityyear.created and foodbank.last_charity_check are all TEXT and SQLite
// compares TEXT bytewise, so an ISO value here sorts after every same-day
// Django one -- see pyDatetime.ts's header for the two production incidents
// that came of exactly that.
const DJANGO_NOW = "2026-09-05 19:28:08.853000";
const NOW = new Date("2026-09-05T19:28:08.853Z");

const DUNDEE = 23;
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
  charity_type?: string | null;
  charity_reg_date?: string | null;
  charity_postcode?: string | null;
  charity_website?: string | null;
  charity_purpose?: string | null;
  charity_objectives?: string | null;
}

/**
 * A Scottish food bank by default. Every charity_* column is seeded with a
 * recognisable prior value so that a test can tell "left alone" from
 * "overwritten with the same thing" from "nulled" -- which is the distinction
 * the whole `if response.status_code == 200:` design rests on.
 */
function seedFoodbank(seed: FoodbankSeed = {}): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_number, charity_just_foodbank, charity_id, charity_name, charity_type,
       charity_reg_date, charity_postcode, charity_website, charity_purpose, charity_objectives,
       contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs, created, modified
     ) VALUES (?, ?, ?, ?, '1 Old Glamis Road', 'DD3 8HP', ?, '56.4907,-2.9605', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'info@example.test', 'https://example.test/', 'https://example.test/need/', 0, 0, 0, 14, ?, ?)`,
  ).run(
    seed.id ?? DUNDEE,
    `uuid-${seed.slug ?? "dundee"}`,
    seed.name ?? "Dundee Foodbank",
    seed.slug ?? "dundee",
    seed.country ?? "Scotland",
    seed.charity_number === undefined ? "SC012345" : seed.charity_number,
    seed.charity_id === undefined ? "OSCR-9" : seed.charity_id,
    seed.charity_name === undefined ? "STALE NAME" : seed.charity_name,
    seed.charity_type === undefined ? "STALE TYPE" : seed.charity_type,
    seed.charity_reg_date === undefined ? "1999-01-01" : seed.charity_reg_date,
    seed.charity_postcode === undefined ? "STALE PC" : seed.charity_postcode,
    seed.charity_website === undefined ? "https://stale.example" : seed.charity_website,
    seed.charity_purpose === undefined ? "STALE PURPOSE" : seed.charity_purpose,
    seed.charity_objectives === undefined ? "STALE OBJECTIVES" : seed.charity_objectives,
    DJANGO_NOW,
    DJANGO_NOW,
  );
}

/** The CrawlSet the 05:30 cron opened (scheduled/index.ts:214-240): ONE per nightly run, shared by all three regulator queues. */
function seedCrawlSet(remaining: number, id = CRAWL_SET): void {
  db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, expected, remaining) VALUES (?, 'charity', ?, ?, ?, ?)").run(id, `charity-${id}`, DJANGO_NOW, remaining, remaining);
}

function message(overrides: Partial<CharityMessage> = {}): CharityMessage {
  return { crawlSetId: CRAWL_SET, foodbankId: DUNDEE, slug: "dundee", ...overrides };
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

function foodbankRow(id = DUNDEE): Record<string, unknown> {
  return db.prepare("SELECT * FROM foodbank WHERE id = ?").get(id) as Record<string, unknown>;
}

function charityYears(foodbankId = DUNDEE): { date: string; income: number; expenditure: number; created: string }[] {
  return db.prepare("SELECT date, income, expenditure, created FROM charityyear WHERE foodbank_id = ? ORDER BY date DESC").all(foodbankId) as unknown as {
    date: string;
    income: number;
    expenditure: number;
    created: string;
  }[];
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  signal: unknown;
}

let fetchCalls: FetchCall[];
/** What the stubbed opencharities.uk answers with, per test. An Error is thrown from fetch itself (DNS/TLS/abort). */
let reply: { status: number; body: string } | Error;

/** The `'a','b','c'` shape crawlOpenCharities.ts:110-118 documents OSCR's arrays arriving in. */
function oscrArray(...items: string[]): string {
  return items.map((item) => `'${item}'`).join(",");
}

beforeEach(() => {
  // Date only, not setTimeout: crawlOpenCharities arms a real
  // AbortSignal.timeout(20_000) and faking the clock underneath it buys
  // nothing. Freezing Date is what makes the exact start/finish/created
  // assertions below possible at all.
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
    fetchCalls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, signal: init.signal });
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
// THE WIRING -- which is the entire content of this module
// ===========================================================================
describe("what this handler is wired to", () => {
  beforeEach(() => {
    seedCrawlSet(3);
  });

  // THE COPY-PASTE MUTANT. charityEw.ts and charityScotland.ts differ by two
  // tokens; leaving "charity-ew" behind in this file compiles, deploys, drains
  // the queue correctly and mislabels every incident report it ever writes.
  // The label is not otherwise observable, so this is the only place it can be
  // caught.
  it("logs failures under charity-scotland, not charity-ew", async () => {
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message({ foodbankId: 999, slug: "vanished" })]).batch, env);

    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe("charity-scotland: message failed for foodbank 999 (vanished)");
    // ...and E&W's handler, run against the identical message, says its own
    // name. Asserting only the string above would still pass if BOTH handlers
    // had been built with "charity-scotland".
    errors = [];
    await handleCharityEwQueue(batchOf("charity-ew", [message({ foodbankId: 999, slug: "vanished" })]).batch, env);
    expect(errors[0]![0]).toBe("charity-ew: message failed for foodbank 999 (vanished)");
  });

  // The label is baked in at module load, not read off the batch. A "tidy-up"
  // that replaced it with `batch.queue` would look right in production and
  // then report a message replayed onto another queue under the wrong name --
  // which is precisely when someone is reading the log.
  it("uses its own label even when the batch says otherwise", async () => {
    await handleCharityScotlandQueue(batchOf("some-other-queue", [message({ foodbankId: 999, slug: "vanished" })]).batch, env);

    expect(errors[0]![0]).toBe("charity-scotland: message failed for foodbank 999 (vanished)");
  });

  // "The per-country split now buys only retry isolation" (this module's own
  // header). makeCharityQueueHandler returns a fresh closure per call, so the
  // three consumers really are three functions over three queues rather than
  // one shared object -- if they were the same reference, wrangler's separate
  // max_concurrency 10 / charity-scotland-dlq settings would be describing
  // something that does not exist.
  it("is its own handler instance, not the one E&W uses", () => {
    expect(handleCharityScotlandQueue).not.toBe(handleCharityEwQueue);
    expect(typeof handleCharityScotlandQueue).toBe("function");
  });

  // The fetcher is the real crawlOpenCharities, so the URL is the tell. The
  // old crawler this replaced called oscrapi.azurewebsites.net TWICE per food
  // bank with an x-functions-key header (crawlers.py:178 and :207, both under
  // the headers built at :188-191); a build that
  // still pointed there would need SCOT_CHARITY_KEY, which wrangler.jsonc no
  // longer carries -- so it would fail silently in production and pass any
  // test that only checked a row was written.
  it("fetches opencharities.uk's sc register, once, with the bot User-Agent", async () => {
    seedFoodbank();

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/sc/SC012345.json"]);
    expect(fetchCalls[0]!.headers["User-Agent"]).toBe("Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)");
    // The 20s abort is what stops a hung register holding a message for the
    // full queue timeout; without it one unresponsive host stalls a consumer
    // slot out of ten. Only the signal's PRESENCE is checkable here: nothing
    // on an AbortSignal exposes its deadline, and `toFake: ["Date"]` leaves
    // setTimeout real on purpose, so a 20_000 -> 200_000 edit would survive
    // this file. That one belongs to charity/crawlOpenCharities.test.ts.
    expect(fetchCalls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  // THE NUMBER GOES INTO THE PATH VERBATIM. Two mutants hide in one short
  // expression (crawlOpenCharities.ts:173-177):
  //
  //   * dropping encodeURIComponent. A charity number typed with a slash --
  //     admin free text, and the column is a plain TEXT with no format check
  //     -- would otherwise walk out of the register's path segment and GET a
  //     different resource entirely, whose JSON is then patched in as this
  //     food bank's charity details.
  //   * applying Northern Ireland's `.replace("NIC", "")` to every register
  //     rather than to `cc === "ni"`. NOTE, because it is the one honest
  //     artificiality in this file: a real OSCR number is "SC" plus six
  //     digits and could not contain "NIC", so the number below is SYNTHETIC
  //     and exists only to make the branch observable from this handler.
  //     Nothing here claims it was seen in production.
  it("puts the row's charity number in the path verbatim and percent-encoded", async () => {
    seedFoodbank({ charity_number: "SC 012345/2" });
    seedFoodbank({ id: 24, slug: "perth", name: "Perth Foodbank", charity_number: "SCNIC099999" });

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message(), message({ foodbankId: 24, slug: "perth" })]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://opencharities.uk/sc/SC%20012345%2F2.json",
      // ...and no "NIC" removed: that strip is Northern Ireland's alone.
      "https://opencharities.uk/sc/SCNIC099999.json",
    ]);
  });

  // Every packages/db call goes through the Sessions API because D1 has read
  // replication on and a bare prepare() can land on a stale replica. ONE
  // session per MESSAGE: read-your-writes only holds inside a session, and the
  // read-insert-patch-update sequence for a single food bank all has to be in
  // one of them.
  it("opens one first-unconstrained session per message", async () => {
    seedFoodbank();
    seedFoodbank({ id: 24, slug: "perth", name: "Perth Foodbank", charity_number: "SC099999" });

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message(), message({ foodbankId: 24, slug: "perth" })]).batch, env);

    expect(sessionModes).toEqual(["first-unconstrained", "first-unconstrained"]);
  });
});

// ===========================================================================
// A SCOTTISH FOOD BANK, END TO END
// ===========================================================================
describe("a Scottish food bank the register knows about", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
    reply = {
      status: 200,
      body: JSON.stringify({
        name: "Dundee Foodbank",
        legal_form: "SCIO (Scottish Charitable Incorporated Organisation)",
        date_registered: "2012-06-18",
        postcode: "DD3 8HP",
        website: "https://dundee.foodbank.example",
        // OSCR's purposes array, comma-joined and quote-wrapped, exactly as
        // crawlOpenCharities.ts:110-118 describes it arriving.
        purposes: oscrArray("The prevention or relief of poverty", "The advancement of citizenship or community development"),
        objectives: "To relieve poverty in Dundee by providing emergency food parcels.",
        // Present on the response and DELIBERATELY unused for Scotland --
        // `what_charity_does` is Northern Ireland's purposes field. A single
        // fallback chain instead of the two per-register maps
        // (crawlOpenCharities.ts:129-155) would pick this up and put NI's text
        // in a Scottish food bank's charity_purpose.
        what_charity_does: oscrArray("NI PURPOSES THAT MUST NOT BE USED"),
        // Likewise EW-only: activities feeds charity_objectives for England
        // and Wales alone.
        activities: "EW ACTIVITIES THAT MUST NOT BE USED",
        classifications: [{ type: "What", description: "EW CLASSIFICATION THAT MUST NOT BE USED" }],
        financial_years: [
          { end: "2025-03-31", income: 511000, expenditure: 489000 },
          { end: "2024-03-31", income: 402000, expenditure: 377000 },
        ],
      }),
    };
  });

  it("writes every charity column the port claims Scotland gains", async () => {
    const { batch, acks, retries } = batchOf("charity-scotland", [message()]);

    await handleCharityScotlandQueue(batch, env);

    const row = foodbankRow();
    expect(row.charity_name).toBe("Dundee Foodbank");
    // crawlOpenCharities.ts:39-42 says reg_date and type were EMPTY in D1 for
    // 19 of 20 sampled Scottish food banks and are populated by this crawler.
    // Django's _crawl_charity_scotland never set charity_type at all --
    // crawlers.py:196-204 is the whole assignment block and it writes six
    // columns, charity_type not among them -- so this column is new.
    expect(row.charity_type).toBe("SCIO (Scottish Charitable Incorporated Organisation)");
    expect(row.charity_reg_date).toBe("2012-06-18");
    expect(row.charity_postcode).toBe("DD3 8HP");
    expect(row.charity_website).toBe("https://dundee.foodbank.example");
    expect(row.charity_objectives).toBe("To relieve poverty in Dundee by providing emergency food parcels.");
    expect(row.last_charity_check).toBe(DJANGO_NOW);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  // THE SCOTLAND-ONLY TRANSFORM. Django built this string itself
  // (crawlers.py:201-203: `charity_purpose = ""` then `for item in
  // data["purposes"]: charity_purpose += item + "\n"`), so a
  // newline-separated list is the stored shape every
  // template downstream expects. toLines() reproduces it from the quoted,
  // comma-joined form -- and the fixture's two purposes come back as two lines
  // rather than one run-on string.
  it("unpicks OSCR's quoted comma-joined purposes into newline-separated lines", async () => {
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(foodbankRow().charity_purpose).toBe("The prevention or relief of poverty\nThe advancement of citizenship or community development");
  });

  // A DIVERGENCE FROM DJANGO, pinned rather than wished away. Django's loop
  // appends "\n" after EVERY item including the last, so production Scottish
  // rows end with a newline; toLines() joins instead of appending, so they no
  // longer do. (E&W keeps the trailing newline -- crawlOpenCharities.ts:152
  // has an explicit `\n` -- so the two registers now disagree with each other
  // as well.) Nothing renders the difference, but a byte-comparison against
  // the Django export will show it on every Scottish row.
  it("drops the trailing newline Django left on charity_purpose", async () => {
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(foodbankRow().charity_purpose).not.toMatch(/\n$/);
  });

  // Django set `foodbank.charity_id = data["id"]` for Scotland
  // (crawlers.py:196) and used it to build the second OSCR request at :207.
  // There is no second request now and opencharities publishes no such id, so
  // the port deliberately leaves the column alone (crawlOpenCharities.ts:194-
  // 200). It must survive the crawl intact: overwriting it with the charity
  // number would silently change what the column means.
  it("leaves charity_id exactly as it found it", async () => {
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(foodbankRow().charity_id).toBe("OSCR-9");
  });

  // NEW FOR SCOTLAND IN A DIFFERENT SENSE: Django DID write CharityYear rows
  // for Scotland, but from a SECOND keyed request to
  // oscrapi.azurewebsites.net/api/annualreturns (crawlers.py:207-219) that
  // needed charity_id to have been refreshed first. Here they ride along on
  // the one response.
  it("replaces the financial years from the same single response", async () => {
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(charityYears()).toEqual([
      { date: "2025-03-31", income: 511000, expenditure: 489000, created: DJANGO_NOW },
      { date: "2024-03-31", income: 402000, expenditure: 377000, created: DJANGO_NOW },
    ]);
  });

  // Django opens a CrawlItem at crawlers.py:180-186 and stamps finish at
  // :224-225 with the fetching in between; the port keeps that bracket. The
  // values are read off the row rather than inferred from the handler
  // resolving, because a stalled charity crawl is detected by `finish IS NULL`
  // and by nothing else (0008_needcheck.sql's own comment).
  it("brackets the crawl with one crawlitem and decrements the shared crawlset once", async () => {
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    const items = crawlItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.foodbank_id).toBe(DUNDEE);
    expect(items[0]!.crawl_set_id).toBe(CRAWL_SET);
    expect(items[0]!.crawl_type).toBe("charity");
    expect(items[0]!.start).toBe(DJANGO_NOW);
    expect(items[0]!.finish).toBe(DJANGO_NOW);
    expect(items[0]!.start).not.toContain("T");
    // A DELIBERATE DIVERGENCE: Django recorded the regulator URL it was about
    // to call on the CrawlItem (crawlers.py:178 + :184). The URL is now built
    // inside crawlOpenCharities and queues/charity.ts passes null, so anything
    // reading crawlitem.url for a Scottish charity row gets NULL.
    expect(items[0]!.url).toBeNull();
    expect(items[0]!.need_id).toBeNull();
    // One CrawlSet is shared by all three regulator queues, so this decrement
    // has to land on the set the message names.
    expect(crawlSet().remaining).toBe(2);
    expect(crawlSet().finish).toBeNull();
  });

  it("says nothing on a clean run -- a quiet queue is a working queue", async () => {
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
  });

  // A WHERE clause that did nothing, or a DELETE that lost its foodbank_id,
  // would pass every test that seeds a single row. The English food bank here
  // must come out of this untouched -- it belongs to another queue entirely.
  it("touches only the food bank the message names", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", country: "England", charity_number: "1122447" });
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2020-03-31', 3, 4, ?)").run(SALISBURY, DJANGO_NOW);

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    const untouched = foodbankRow(SALISBURY);
    expect(untouched.charity_name).toBe("STALE NAME");
    expect(untouched.charity_purpose).toBe("STALE PURPOSE");
    expect(untouched.last_charity_check).toBeNull();
    expect(charityYears(SALISBURY)).toEqual([{ date: "2020-03-31", income: 3, expenditure: 4, created: DJANGO_NOW }]);
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([DUNDEE]);
  });

  // The row the crawler works from is re-read from D1 at dequeue time, not
  // taken from the message (getFoodbankForCharityCrawl's own comment; the
  // cron's enqueue-time snapshot goes stale in the drain window). The slug in
  // the message body is deliberately a stale one here, and the URL is built
  // from the DB row's charity_number -- so a handler that trusted the body,
  // or re-read by slug rather than id, is caught.
  it("crawls the row D1 has now, not the snapshot the cron enqueued", async () => {
    db.prepare("UPDATE foodbank SET charity_number = 'SC077777' WHERE id = ?").run(DUNDEE);

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message({ slug: "dundee-and-angus" })]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/sc/SC077777.json"]);
  });
});

// ===========================================================================
// THE SHAPES OSCR ACTUALLY SENDS THROUGH toLines()
// ===========================================================================
describe("charity_purpose for the shapes opencharities returns", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(1);
  });

  // `what_charity_does` rides along on EVERY response here and must never
  // reach a Scottish column. It is what makes the "no purposes at all" case
  // below load-bearing: without it, collapsing the two per-register maps into
  // one fallback chain (`toLines(data.purposes ?? data.what_charity_does)`)
  // is invisible, because it only diverges when `purposes` is absent.
  async function purposeFrom(purposes: unknown): Promise<unknown> {
    reply = { status: 200, body: JSON.stringify({ name: "Dundee Foodbank", purposes, what_charity_does: oscrArray("NI PURPOSES THAT MUST NOT BE USED") }) };
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);
    return foodbankRow().charity_purpose;
  }

  it("keeps a comma inside a quoted item when there is more than one item", async () => {
    // OSCR's statutory purposes really do contain commas -- "the advancement
    // of the arts, heritage, culture or science" is one of them -- so the
    // split-on-quote-comma rather than split-on-comma matters.
    expect(await purposeFrom(oscrArray("The advancement of the arts, heritage, culture or science", "The relief of poverty"))).toBe(
      "The advancement of the arts, heritage, culture or science\nThe relief of poverty",
    );
  });

  it("handles a single quoted purpose with no comma in it", async () => {
    expect(await purposeFrom(oscrArray("The prevention or relief of poverty"))).toBe("The prevention or relief of poverty");
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // toLines() decides the value is a quoted list only if it contains the
  // literal `','` separator (crawlOpenCharities.ts:124). A charity with
  // exactly ONE purpose has no separator, so the string falls through to the
  // bare-comma split -- and OSCR's own statutory purpose texts contain commas.
  // A Scottish food bank registered for the single purpose below therefore
  // gets its charity_purpose shredded into four lines mid-sentence, on the
  // food bank's public page. Multi-purpose charities are unaffected, which is
  // why the sample of 20 in the module header would not have shown it.
  it("SHREDS a single purpose that contains commas, mid-sentence", async () => {
    expect(await purposeFrom(oscrArray("The advancement of the arts, heritage, culture or science"))).toBe("The advancement of the arts\nheritage\nculture or science");
  });

  // Not quoted at all -- the bare `a,b,c` form the header attributes to
  // Northern Ireland. Splitting it the same way is harmless and is what the
  // code does, so it is pinned rather than left to chance.
  it("splits an unquoted comma list too", async () => {
    expect(await purposeFrom("The prevention or relief of poverty,The advancement of education")).toBe("The prevention or relief of poverty\nThe advancement of education");
  });

  // An absent `purposes` NULLS the column rather than leaving the previous
  // value: toLines(undefined) returns null and patchFoodbankCharity writes
  // every key the patch object carries. Django's Scotland branch would have
  // raised KeyError on `data["purposes"]` and written nothing at all, so this
  // is the port's own behaviour, not a port of one.
  //
  // It stays NULL rather than falling back to the `what_charity_does` the
  // fixture also carries -- see purposeFrom's comment. That fallback is the
  // exact mutant crawlOpenCharities.ts:142-144 warns about in prose ("a
  // single fallback chain would be shorter and wrong"), and this is the
  // assertion that makes the warning enforceable.
  it("nulls the column when the register sends no purposes at all", async () => {
    expect(await purposeFrom(undefined)).toBeNull();
  });

  // Empty string in, empty string out -- NOT null. `",,,"` splits into four
  // empty parts, all filtered out, and joins to "". Pinned because "" and NULL
  // read differently in the templates and in any downstream export.
  it("writes an empty string, not null, for a list of nothing but separators", async () => {
    expect(await purposeFrom(",,,")).toBe("");
  });
});

// ===========================================================================
// WHEN THE REGISTER DOES NOT ANSWER USEFULLY
// ===========================================================================
describe("when opencharities.uk fails", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(2);
  });

  /** Nothing in the charity_* columns moved and no check was stamped. */
  function expectUntouched(): void {
    const row = foodbankRow();
    expect(row.charity_name).toBe("STALE NAME");
    expect(row.charity_type).toBe("STALE TYPE");
    expect(row.charity_website).toBe("https://stale.example");
    expect(row.charity_purpose).toBe("STALE PURPOSE");
    expect(row.charity_objectives).toBe("STALE OBJECTIVES");
    expect(row.last_charity_check).toBeNull();
  }

  // THE CONTRACT queues/charity.ts's header rests on: the crawler "never
  // throws for an external-API-level failure". A charity number that has moved
  // is not a retryable condition -- if a 404 ever started throwing, every one
  // of the ~2 daily misses would burn three retries at 60s and land in
  // charity-scotland-dlq, which exists for stuck COUNTERS, not for this.
  it("acks and closes the crawlitem on a 404, patching nothing", async () => {
    reply = { status: 404, body: "not found" };
    const { batch, acks, retries } = batchOf("charity-scotland", [message()]);

    await handleCharityScotlandQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(1);
    expectUntouched();
    // Same effect as Django's `if response.status_code == 200:` guard
    // (crawlers.py:193). The log line carries the register and number so the
    // miss can be looked up by hand.
    expect(logs).toEqual(["charity: opencharities 404 for dundee (sc/SC012345)"]);
    expect(errors).toEqual([]);
  });

  // A 500 is treated identically -- no retry, no second attempt tonight. That
  // is a deliberate trade (a whole night's Scottish charity data lost to a
  // transient blip) and it is pinned so nobody assumes a 5xx is retried.
  it("acks on a 500 as well, so a transient blip costs the night's data", async () => {
    reply = { status: 500, body: "server error" };
    const { batch, acks, retries } = batchOf("charity-scotland", [message()]);

    await handleCharityScotlandQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expectUntouched();
    expect(logs).toEqual(["charity: opencharities 500 for dundee (sc/SC012345)"]);
  });

  // DNS, TLS, or the 20s AbortSignal.timeout firing. Logged as an error --
  // this one IS worth a human's attention, unlike a 404 -- but still acked, so
  // a total opencharities.uk outage closes the crawl set cleanly rather than
  // filling three dead-letter queues with 831 messages.
  it("acks when the fetch itself rejects, but logs it as an error", async () => {
    reply = new TypeError("fetch failed");
    const { batch, acks, retries } = batchOf("charity-scotland", [message()]);

    await handleCharityScotlandQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expectUntouched();
    expect(errors[0]![0]).toBe("charity: opencharities fetch failed for dundee");
  });

  // A 200 carrying an HTML error page -- the classic interposed-proxy failure,
  // and the exact shape of the incident this tier exists for. res.json()
  // rejects inside the same try, so it is swallowed like any other fetch
  // failure and nothing is written. Good behaviour; pinned so a refactor that
  // moved the json() parse outside the try cannot start nulling columns.
  it("acks and patches nothing when a 200 body is not JSON", async () => {
    reply = { status: 200, body: "<html><body>502 Bad Gateway</body></html>" };
    const { batch, acks } = batchOf("charity-scotland", [message()]);

    await handleCharityScotlandQueue(batch, env);

    expect(acks).toEqual([0]);
    expectUntouched();
    expect(errors[0]![0]).toBe("charity: opencharities fetch failed for dundee");
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // `if (!data) return` (crawlOpenCharities.ts:192) is a JavaScript truthiness
  // check, and `{}` is truthy in JavaScript. Django's guard is `if data:`
  // (crawlers.py:195) and `{}` is FALSY in Python, so where Django left every
  // column alone, the port writes NULL into all seven of them and stamps
  // last_charity_check as though the crawl succeeded.
  //
  // A 200 with an empty or unrecognised JSON envelope -- an error body, a
  // register entry that has been emptied, a shape change at opencharities --
  // therefore silently wipes a food bank's charity details, on a cron, with
  // an ack and no log line. Across a bad deploy at the mirror that is every
  // Scottish food bank at once, and the only visible symptom is a blank
  // section on a public page.
  it("NULLS every charity column for a 200 that is an empty JSON object", async () => {
    reply = { status: 200, body: "{}" };
    const { batch, acks } = batchOf("charity-scotland", [message()]);

    await handleCharityScotlandQueue(batch, env);

    const row = foodbankRow();
    expect(row.charity_name).toBeNull();
    expect(row.charity_type).toBeNull();
    expect(row.charity_reg_date).toBeNull();
    expect(row.charity_postcode).toBeNull();
    expect(row.charity_website).toBeNull();
    expect(row.charity_purpose).toBeNull();
    expect(row.charity_objectives).toBeNull();
    // ...and it looks like a successful crawl from every angle a dashboard has.
    expect(row.last_charity_check).toBe(DJANGO_NOW);
    expect(acks).toEqual([0]);
    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
    // charity_id is the one column that survives, because it is never patched.
    expect(row.charity_id).toBe("OSCR-9");
  });

  // The counterpart, and the reason the one above is a bug rather than a
  // policy: a JSON `null` body IS falsy, so it takes the early return and the
  // columns survive. Two adjacent responses, opposite outcomes.
  //
  // The ack/finish assertions are what make this test stand on its own. With
  // only expectUntouched(), deleting the `if (!data) return` guard altogether
  // still passed here -- `data.name` throws, nothing is written, and the
  // columns look "left alone" while the message is actually retrying towards
  // the DLQ with a half-open crawlitem behind it. Untouched columns and a
  // clean crawl are different outcomes and both have to be asserted.
  it("leaves everything alone for a 200 whose body is JSON null", async () => {
    reply = { status: 200, body: "null" };
    const { batch, acks, retries } = batchOf("charity-scotland", [message()]);

    await handleCharityScotlandQueue(batch, env);

    expectUntouched();
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(1);
    expect(errors).toEqual([]);
  });

  // PLAN.md §8.7.1's fix, and the one place the port is clearly safer than
  // Django. crawlers.py:206 deletes every CharityYear row BEFORE issuing the
  // annual-returns request, so a failed second fetch left the food bank with
  // no financial history at all until the next good run. Here the rows are in
  // hand first and `if (years.length)` skips the replace entirely.
  it("keeps the existing financial years when the response carries none", async () => {
    db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, '2023-03-31', 300, 290, ?)").run(DUNDEE, DJANGO_NOW);
    reply = { status: 200, body: JSON.stringify({ name: "Dundee Foodbank", financial_years: [] }) };

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2023-03-31", income: 300, expenditure: 290, created: DJANGO_NOW }]);
    // The rest of the patch still applied, so this is a skip of the replace
    // and not an early return from the whole crawler.
    expect(foodbankRow().charity_name).toBe("Dundee Foodbank");
  });

  // A year with no end date is dropped rather than written with a NULL date,
  // and a missing income/expenditure becomes 0 -- matching Django's
  // `year.get("GrossIncome", 0)` default at crawlers.py:216-217. A NULL-dated
  // row would sort unpredictably on the charity page.
  it("drops financial years with no end date and zero-fills missing amounts", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        name: "Dundee Foodbank",
        financial_years: [{ end: "2025-03-31" }, { end: null, income: 1, expenditure: 1 }, { end: "", income: 2, expenditure: 2 }],
      }),
    };

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2025-03-31", income: 0, expenditure: 0, created: DJANGO_NOW }]);
  });

  // The NI register's literal "n/a" website, which would render a link to
  // https://n/a. Scotland has no reason to send it, but the filter is applied
  // to every register and this handler is one of the three -- so it is asserted
  // where it runs, not only where it was motivated.
  it("treats a placeholder website as absent", async () => {
    reply = { status: 200, body: JSON.stringify({ name: "Dundee Foodbank", website: "  N/A  " }) };

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(foodbankRow().charity_website).toBeNull();
  });
});

// ===========================================================================
// COUNTRY ROUTING -- the queue does not decide the register, the ROW does
// ===========================================================================
describe("when the row's country is not Scotland", () => {
  beforeEach(() => {
    seedCrawlSet(2);
  });

  // Worth pinning because it is counter-intuitive and it is a SAFETY property:
  // the register comes from foodbank.country (crawlOpenCharities.ts:164), not
  // from which queue the message arrived on. A food bank moved between
  // countries by an admin between the 05:30 fan-out and the drain is still
  // crawled against the right register rather than looked up in the wrong one.
  it("still uses the register the row's country names, not the queue's", async () => {
    seedFoodbank({ country: "England", charity_number: "1122447" });
    // The URL alone does NOT prove the EW branch ran -- purposeFor/
    // objectivesFor branch on the same `cc` a second time, and four separate
    // mutants in them survived this test while it asserted only the URL and
    // the crawlitem's finish. So the response below carries BOTH registers'
    // fields at once, each labelled with which register reads it, and the
    // assertions read the columns back.
    reply = {
      status: 200,
      body: JSON.stringify({
        name: "Salisbury Foodbank",
        // Scotland's two fields. Neither may appear in an English row.
        purposes: oscrArray("SCOTTISH PURPOSES THAT MUST NOT BE USED"),
        objectives: "SCOTTISH OBJECTIVES THAT MUST NOT BE USED",
        // England's two.
        activities: "Providing three days of emergency food.",
        classifications: [
          { type: "What", description: "General charitable purposes" },
          { type: "Who", description: "WHO CLASSIFICATION THAT MUST NOT BE USED" },
          { type: "What", description: "The prevention or relief of poverty" },
          { type: "How", description: "HOW CLASSIFICATION THAT MUST NOT BE USED" },
        ],
      }),
    };

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/ew/1122447.json"]);
    const row = foodbankRow();
    // MUTANTS THIS KILLS, all of which survived the URL-only version:
    //   * purposeFor's ew branch deleted, so an English row falls through to
    //     toLines(data.purposes) and gets OSCR's list.
    //   * `.filter((c) => c.type === "What")` widened, which drags the Who/How
    //     rows onto the public page as if they were charitable purposes.
    //   * the trailing "\n" dropped -- Django appended one per item
    //     (crawlers.py:136-138) and E&W rows in production carry it, so losing
    //     it is a silent byte-level divergence on every English food bank.
    expect(row.charity_purpose).toBe("General charitable purposes\nThe prevention or relief of poverty\n");
    //   * objectivesFor's ew branch reading `objectives` instead of
    //     `activities`, which is a real confusion risk: the two field names
    //     mean the opposite things in the two registers.
    expect(row.charity_objectives).toBe("Providing three days of emergency food.");
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
  });

  // The EW branch's empty case is "" where Scotland's toLines() gives null,
  // and this handler is one of the two places a row can reach it. Pinned
  // because "" and NULL read differently downstream, and because returning
  // null here would look like a tidy-up rather than a change.
  it("writes an empty charity_purpose, not null, for an English row with no What classification", async () => {
    seedFoodbank({ country: "England", charity_number: "1122447" });
    reply = { status: 200, body: JSON.stringify({ name: "Salisbury Foodbank", classifications: [{ type: "Who", description: "Other charities" }] }) };

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(foodbankRow().charity_purpose).toBe("");
  });

  // Isle of Man has one food bank and no register anywhere. The 05:30 cron
  // only fans out England/Wales, Scotland and Northern Ireland, so this can
  // only arrive by hand -- and it must not wedge a consumer slot.
  it("acks a country with no register at all, without fetching", async () => {
    seedFoodbank({ country: "Isle of Man" });
    const { batch, acks, retries } = batchOf("charity-scotland", [message()]);

    await handleCharityScotlandQueue(batch, env);

    expect(fetchCalls).toEqual([]);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    // The bookkeeping still completes -- the food bank is accounted for even
    // though nothing was crawled, which is what keeps the set closable.
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(1);
    expect(logs).toEqual(["charity: no register for country Isle of Man (dundee)"]);
    expect(foodbankRow().last_charity_check).toBeNull();
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // The cron only enqueues food banks with a non-empty charity_number
  // (getFoodbanksByCountryForCharityCrawl's WHERE clause), and Django bailed
  // on `if not foodbank.charity_number: return False` before doing anything at
  // all (crawlers.py:88-89). The port has no such guard at dequeue time: a
  // charity number cleared by an admin during the drain window produces a real
  // HTTP GET for `https://opencharities.uk/sc/.json` -- the register's index
  // page, not a charity -- and whatever that returns is patched in.
  //
  // Both spellings of "cleared" are here on purpose. The column is nullable
  // (0001_core.sql:20 `charity_number TEXT`), so an admin emptying the field
  // leaves "" while a script that unsets it leaves NULL. Only the second
  // exercises the `number ?? ""` coalescing -- without it the NULL is
  // stringified into the path and the crawler GETs /sc/null.json, a URL that
  // could one day resolve to something patchable.
  it("still fetches a bare /sc/.json when the charity number has been cleared", async () => {
    seedFoodbank({ charity_number: "" });
    seedFoodbank({ id: 24, slug: "perth", name: "Perth Foodbank", charity_number: null });
    const { batch, acks } = batchOf("charity-scotland", [message(), message({ foodbankId: 24, slug: "perth" })]);

    await handleCharityScotlandQueue(batch, env);

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/sc/.json", "https://opencharities.uk/sc/.json"]);
    expect(acks).toEqual([0, 1]);
  });
});

// ===========================================================================
// A MESSAGE THAT CANNOT BE PROCESSED
// ===========================================================================
describe("a message that cannot be processed", () => {
  beforeEach(() => {
    seedCrawlSet(3);
  });

  // Deleted, or closed and purged, between the 05:30 enqueue and this dequeue.
  // The port throws rather than acking, which means three retries at 60s and
  // then charity-scotland-dlq -- whose handler (built at charityDlq.ts:10-23,
  // decrementing at :16, exported for this queue at :26) is the only thing
  // that finally decrements the counter so the set is not stuck open.
  // No half-open crawlitem is left behind, because the insert is downstream of
  // the existence check.
  it("retries a food bank that no longer exists, opening no crawlitem", async () => {
    const { batch, acks, retries } = batchOf("charity-scotland", [message({ foodbankId: 999, slug: "vanished" })]);

    await handleCharityScotlandQueue(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(crawlItems()).toEqual([]);
    expect(crawlSet().remaining).toBe(3);
    expect(fetchCalls).toEqual([]);
    expect(errors[0]![1]).toContain("charity: foodbank 999 (vanished) no longer exists");
  });

  // The 60s is not decoration: charity-scotland runs at max_concurrency 10
  // (wrangler.jsonc:185), so a bare `message.retry()` would hit a struggling
  // opencharities.uk again immediately, ten at a time. That is the mutant.
  it("backs the retry off by 60 seconds rather than redelivering at once", async () => {
    const { batch, retries } = batchOf("charity-scotland", [message({ foodbankId: 999, slug: "vanished" })]);

    await handleCharityScotlandQueue(batch, env);

    expect(retries[0]!.options).toEqual({ delaySeconds: 60 });
  });

  // A body with no foodbankId fails at the bind and is handled: logged with
  // `undefined` in place of the id, and retried. Three wasted deliveries for a
  // message that can never succeed, but it ends at the DLQ where a human can
  // see it -- which beats a silent drop.
  it("logs and retries a body with no foodbankId", async () => {
    const { batch, acks, retries } = batchOf("charity-scotland", [{ crawlSetId: CRAWL_SET }]);

    await handleCharityScotlandQueue(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(errors[0]![0]).toBe("charity-scotland: message failed for foodbank undefined (undefined)");
    expect(crawlItems()).toEqual([]);
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // The catch block dereferences `message.body.foodbankId` to build its log
  // line (queues/charity.ts:33). For a body of null that dereference throws
  // INSIDE the catch, so the error escapes the handler entirely: the rest of
  // the batch is never looked at, and the messages after the bad one are
  // neither acked nor retried. With max_batch_size 5 one unparseable message
  // costs up to four healthy food banks their crawl, every delivery, until the
  // whole batch exhausts max_retries into charity-scotland-dlq -- where the
  // DLQ handler dereferences the same body and throws again.
  it("lets a null body take the rest of the batch down with it", async () => {
    seedFoodbank();
    seedFoodbank({ id: 24, slug: "perth", name: "Perth Foodbank", charity_number: "SC099999" });
    const { batch, acks, retries } = batchOf("charity-scotland", [message(), null, message({ foodbankId: 24, slug: "perth" })]);

    await expect(handleCharityScotlandQueue(batch, env)).rejects.toThrow(TypeError);

    // The first message committed and acked before the crash...
    expect(acks).toEqual([0]);
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([DUNDEE]);
    // ...and Perth was never even looked at. Not acked, not retried, not
    // fetched.
    expect(retries).toEqual([]);
    expect(fetchCalls).toHaveLength(1);
    expect(crawlSet().remaining).toBe(2);
  });

  // A D1 write failure inside the crawler IS meant to reach the handler's
  // catch (queues/charity.ts:14-16). The crawl is then half done: the
  // crawlitem must stay open so the run reads as stalled, and the message must
  // come back.
  it("retries and leaves the crawlitem open when the crawler's D1 write fails", async () => {
    seedFoodbank();
    reply = { status: 200, body: JSON.stringify({ name: "Dundee Foodbank" }) };
    failOn = /UPDATE foodbank SET/;
    const { batch, acks, retries } = batchOf("charity-scotland", [message()]);

    await handleCharityScotlandQueue(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet().remaining).toBe(3);
    expect(foodbankRow().charity_name).toBe("STALE NAME");
    expect(errors[0]![0]).toBe("charity-scotland: message failed for foodbank 23 (dundee)");
  });

  // One bad food bank in a batch of five must not cost the other four their
  // crawl. The try/catch is per message for exactly this reason, and a handler
  // that let the throw escape the loop would silently redeliver good messages
  // every night.
  it("keeps processing the batch after a message fails", async () => {
    seedFoodbank();
    seedFoodbank({ id: 24, slug: "perth", name: "Perth Foodbank", charity_number: "SC099999" });
    const { batch, acks, retries } = batchOf("charity-scotland", [message(), message({ foodbankId: 999, slug: "vanished" }), message({ foodbankId: 24, slug: "perth" })]);

    await handleCharityScotlandQueue(batch, env);

    expect(acks).toEqual([0, 2]);
    expect(retries.map((r) => r.index)).toEqual([1]);
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([DUNDEE, 24]);
    expect(fetchCalls.map((call) => call.url)).toEqual(["https://opencharities.uk/sc/SC012345.json", "https://opencharities.uk/sc/SC099999.json"]);
    // Two of three accounted for; the third is the DLQ's problem.
    expect(crawlSet().remaining).toBe(1);
    expect(crawlSet().finish).toBeNull();
  });

  it("does nothing at all for an empty batch", async () => {
    await handleCharityScotlandQueue(batchOf("charity-scotland", []).batch, env);

    expect(sessionModes).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(crawlItems()).toEqual([]);
    expect(crawlSet().remaining).toBe(3);
  });
});

// ===========================================================================
// AT-LEAST-ONCE REDELIVERY -- Cloudflare Queues guarantees only this
// ===========================================================================
describe("when the same message is delivered twice", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
    reply = { status: 200, body: JSON.stringify({ name: "Dundee Foodbank", purposes: oscrArray("The prevention or relief of poverty"), financial_years: [{ end: "2025-03-31", income: 5, expenditure: 4 }] }) };
  });

  // The single most important property for an at-least-once queue.
  // insertCrawlItem upserts on (crawl_set_id, foodbank_id) and finishCrawlItem
  // guards on `finish IS NULL`; together they mean a redelivery reopens the
  // SAME row and skips the decrement. Without the upsert a second row is
  // orphaned and never finished, which is indistinguishable from a stall;
  // without the guard, remaining goes down twice for one food bank and the set
  // closes early -- possibly while other food banks are still being crawled.
  it("keeps one crawlitem and decrements remaining exactly once", async () => {
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);
    const { batch, acks, retries } = batchOf("charity-scotland", [message()]);
    await handleCharityScotlandQueue(batch, env);

    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(2);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  // The financial history is delete-and-reinsert, so a redelivery must leave
  // exactly one row per year rather than duplicating the lot. This is the
  // check that would have caught the phantom-duplicate hazard PLAN.md §8.7.1
  // describes -- CharityYear has no `modified` column to deduplicate on after
  // the fact.
  it("does not duplicate the charity years", async () => {
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(charityYears()).toEqual([{ date: "2025-03-31", income: 5, expenditure: 4, created: DJANGO_NOW }]);
    expect(foodbankRow().charity_purpose).toBe("The prevention or relief of poverty");
  });

  // A REAL COST, pinned rather than endorsed: the crawler runs AGAIN on a
  // redelivery, before finishCrawlItem gets a chance to report the item was
  // already closed. That is a second opencharities.uk GET and a second
  // identical patch -- harmless, but paid for, and it is why a redelivery
  // storm is visible at the mirror rather than at D1.
  it("re-fetches the register even though the item is already closed", async () => {
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(fetchCalls).toHaveLength(2);
  });

  // Two copies in ONE batch, which max_batch_size 5 makes possible, must
  // behave the same as two batches.
  it("survives both copies arriving in the same batch", async () => {
    const { batch, acks, retries } = batchOf("charity-scotland", [message(), message()]);

    await handleCharityScotlandQueue(batch, env);

    expect(crawlItems()).toHaveLength(1);
    expect(crawlSet().remaining).toBe(2);
    expect(acks).toEqual([0, 1]);
    expect(retries).toEqual([]);
  });

  // The uniqueness is (crawl_set_id, foodbank_id), so TOMORROW night's run for
  // the same food bank has to open a second row rather than reuse tonight's.
  it("opens a fresh crawlitem for the next night's crawlset", async () => {
    seedCrawlSet(1, 8);

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);
    await handleCharityScotlandQueue(batchOf("charity-scotland", [message({ crawlSetId: 8 })]).batch, env);

    expect(crawlItems().map((row) => row.crawl_set_id)).toEqual([CRAWL_SET, 8]);
    expect(crawlSet(CRAWL_SET).remaining).toBe(2);
    expect(crawlSet(8).remaining).toBe(0);
    // The second set was the last message it was waiting for, so it closes --
    // and any of the three regulator queues can be the one that closes the
    // shared set.
    expect(crawlSet(8).finish).toBe(DJANGO_NOW);
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // finishCrawlItem and decrementCrawlSetRemaining are two separate writes
  // with no transaction around them. If the first succeeds and the second
  // fails, the message retries; on redelivery finishCrawlItem returns false
  // (the row is already closed), `if (closed)` short-circuits, and the
  // decrement is skipped PERMANENTLY. crawlset.remaining stays one too high
  // and `finish` is never stamped, so that night's set reads as still running
  // forever on the crawl dashboard.
  //
  // charity-scotland-dlq would decrement for a message that exhausted its
  // retries, but it never runs here: the redelivery ACKS. Nothing else in the
  // system decrements.
  it("permanently loses the decrement if the item closes but the counter write fails", async () => {
    failOn = /UPDATE crawlset SET remaining/;

    await handleCharityScotlandQueue(batchOf("charity-scotland", [message()]).batch, env);

    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(3);

    // The outage clears before the redelivery arrives.
    failOn = null;
    const { batch, acks, retries } = batchOf("charity-scotland", [message()]);
    await handleCharityScotlandQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    // ...and the counter is still 3, forever.
    expect(crawlSet().remaining).toBe(3);
    expect(crawlSet().finish).toBeNull();
  });

  // A redelivery of the very last message must not push remaining negative or
  // re-stamp finish -- that is the `AND remaining > 0` guard in
  // decrementCrawlSetRemaining.
  it("cannot drive an already-drained crawlset below zero", async () => {
    seedCrawlSet(0, 77);
    const { batch, acks } = batchOf("charity-scotland", [message({ crawlSetId: 77 })]);

    await handleCharityScotlandQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(crawlSet(77).remaining).toBe(0);
    expect(crawlSet(77).finish).toBeNull();
  });
});
