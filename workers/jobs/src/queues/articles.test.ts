import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import { handleArticlesQueue, type ArticlesMessage } from "./articles";
import type { Env } from "../../worker-configuration";
// No @ts-ignore on this import, unlike schema.testkit.ts:35 and
// adminJobs/foodbankCheck.test.ts:11 -- checked rather than copied. This
// Worker's tsconfig lists only @cloudflare/workers-types, but `types` gates the
// automatic inclusion of GLOBAL type packages, not the resolution of an
// explicit import: "node:sqlite" still resolves through the hoisted @types/node,
// and `tsc --noEmit` in workers/jobs is clean without a suppression. Suppressing
// it anyway would silently turn DatabaseSync into `any`.
import { DatabaseSync } from "node:sqlite";

// queues/articles.ts -- the ARTICLES_Q consumer, ported from
// givefood/utils/crawlers.py:25-67 (foodbank_article_crawl). Read directly at
// /Users/jasoncartwright/Sites/foodcharity for every parity claim below; where
// the port diverges the test asserts the PORT and the comment says which way
// Django went.
//
// WHY THIS FILE IS WORTH THE LENGTH. Nothing watches this consumer. It runs
// every two hours from 08:20 to 22:20 over ~470 third-party feeds
// (wrangler.jsonc's "20 8-22/2 * * *"), it renders nothing, and its only
// visible output is rows appearing on /needs/at/<slug>/news/ -- so "no new
// articles" and "the crawl has been broken for a week" look identical from
// outside. The module comment is explicit that a feed-level failure is
// SUPPOSED to be silent ("nothing happens today, try again tomorrow"), which
// makes the boundary between that silence and a real infrastructure failure
// the whole contract of the file: one side acks and closes the CrawlItem, the
// other side throws so the message retries and eventually reaches articles-dlq.
// Every test below sits on one side or the other of that line.
//
// REAL THINGS, NOT MOCKS:
//   * node:sqlite carrying the WHOLE real migration set. MIGRATIONS_SQL rather
//     than schemaFor(...) because this consumer reaches foodbank,
//     foodbankarticle, crawlitem and crawlset through six shared packages/db
//     functions, and the full schema is the only fixture that cannot develop
//     the github #51 gap where a shared query quietly starts reading one more
//     object. Nothing is hand-written: a fixture typed out here would test the
//     author's memory of the columns rather than the columns D1 has.
//   * the real getFoodbankForArticleCrawl / insertCrawlItem /
//     insertArticleIfNew / updateFoodbankLastCrawl / finishCrawlItem /
//     decrementCrawlSetRemaining, running their real SQL.
//   * the real parseFeed over the real fast-xml-parser, fed real feed XML.
//
// MOCKED, and only this: `fetch` (the food banks' own web servers -- the one
// thing here that leaves the machine) and PURGE_Q.send (a Cloudflare queue).
//
// MUTATION-TESTED, per TESTING.md's convention: the repo was copied to a
// scratchpad OUTSIDE it, articles.ts was broken there 44 ways, and this file
// re-run against each one. Killed, among others: dropping the ack, the retry's
// delaySeconds, retry -> ack, retry -> batch.retryAll, parsing a non-ok body,
// dropping the abort signal, a shortened user agent, dropping or widening the
// 250-character title slice, toISOString() for published_date or last_crawl,
// transposing crawlSetId/foodbankId in the crawl item, attaching articles to
// the crawl set's id, crawl_type "need", never/always setting foundNew,
// purging unconditionally, purging msg.slug instead of the row's slug,
// dropping the aggregate tag, an un-awaited purge send, dropping the
// finishCrawlItem guard before the decrement, dropping last_crawl / finish /
// the decrement entirely, returning instead of throwing for a missing food
// bank, resolving links against the wrong base URL, Promise.all over the batch,
// opening the crawl item after the fetch, transposing the last_crawl and purge
// lines, decrementing with the crawl item's id, swapping title and url,
// `res.status < 500` for `res.ok`, acking before processing, processing only
// the batch's first message, and moving the article insert out of the fetch's
// try block (which is the suspected bug below -- the test that pins it is
// SUPPOSED to fail against a fixed module, and says so).
//
// THREE SURVIVED, all from the second (adversarial) half of that sweep.
// `foundNew = inserted` (last-item-wins) and
// `withSession("first-primary")` were real gaps and the two tests naming those
// mutants were written to close them. The third -- shortening
// AbortSignal.timeout(20_000) to 200ms -- was recorded as unobservable from a
// node test. That was wrong, and the review pass below says why.
//
// RE-REVIEWED ADVERSARIALLY by a second author: 65 mutants over two waves, same
// method (a clonefile copy of the repo in the scratchpad, never an edit in the
// working tree). TWO SURVIVED, both now closed, both named in the comment on
// the test that closes them:
//   * timeout-200ms. AbortSignal.timeout is a writable, spy-able static, so its
//     ARGUMENT is observable even though the deadline it produces is not --
//     see "passes a live abort signal set to 20 seconds".
//   * session-per-batch: hoisting env.DB.withSession out of processOne and
//     sharing one session across the whole batch. "opens one unconstrained D1
//     session per message" ran a ONE-message batch, so it proved "at least one
//     session", not "one per message". It now runs two messages.
// Newly killed by the second wave and worth naming because they are the shapes
// a tidy-up produces: closing the crawl item before stamping last_crawl, acking
// in a `finally` alongside the retry, iterating the batch in reverse, swapping
// the two purge tags, `foundNew &&= inserted`, and pinning the crawl item's
// crawl_set_id to a constant.
//
// Also rewritten in that pass: "does nothing at all for an empty batch"
// asserted only that its own fixture had no messages -- true before the handler
// is ever called, and equally true of an empty function body. It now asserts
// the absence of every side effect the handler could have had.
//
// Also added: the two exclusion cases nothing here seeded -- an article URL
// already stored under ANOTHER food bank (article_url_uniq is on (url) alone,
// matching Django's own global dedup) and a crawl item belonging to a PREVIOUS
// crawl set. A filter that does nothing passes every test that only seeds rows
// which match.
//
// A NOTE ON WHAT THE ASSERTIONS READ. Every "it worked" test reads the ROWS
// back out of SQLite -- the article, the crawl item's finish, the food bank's
// last_crawl, the crawl set's countdown -- and every "it did not work" test
// asserts those same rows are absent or unchanged. A resolved promise is not
// evidence: this handler swallows most of what can go wrong on purpose, so
// "handleArticlesQueue resolved" is true of a working crawl and of a crawl
// that fetched nothing, parsed nothing and stored nothing.

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
 * Fail the next D1 statement whose SQL this returns an Error for. It is a
 * function rather than a regex so a test can fail the SECOND insert of a run
 * (see "articles stored before a D1 failure still trigger a purge"), which is
 * where the interesting half of this module's error handling lives.
 */
let failIf: ((sql: string, params: Bindable[]) => Error | null) | null;

/**
 * The D1 Sessions API surface packages/db uses, over the real engine. It
 * carries SQL to node:sqlite and does nothing else -- a session answering
 * canned rows would be a second implementation of the queries under test, and
 * three of the claims this file makes (INSERT OR IGNORE reporting changes = 0,
 * the crawlitem upsert returning the EXISTING id, `AND finish IS NULL` matching
 * no row on a redelivery) are claims about what the engine does, not about what
 * the TypeScript says.
 *
 * `first()` answers null, never undefined: articles.ts:50 tests `!foodbank`.
 * `meta.changes` is the engine's own sqlite3_changes(), because
 * insertArticleIfNew turns it into foundNew -> a cache purge.
 */
function d1Session(): unknown {
  function statement(sql: string, params: Bindable[]): unknown {
    const guard = (): void => {
      const err = failIf?.(sql, params);
      if (err) throw err;
    };
    return {
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T>() => {
        guard();
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      all: async <T>() => {
        guard();
        return { results: db.prepare(sql).all(...params) as T[], success: true, meta: {} };
      },
      run: async () => {
        guard();
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null };
}

// ---------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------

/** A modelled reply. An Error means the fetch itself rejected (DNS, TLS, abort). */
type Reply = { status: number; body: string } | Error;

let feedReplies: Map<string, Reply[]>;
let fetchCalls: Array<{ url: unknown; headers: Record<string, string>; signal: unknown }>;
/** Ordered trace of the observable side effects, for the batch-ordering tests. */
let events: string[];
let logs: string[];
/** Runs inside the fetch stub, for observing the database mid-flight. */
let onFetch: (() => void) | null;

function stubFetch(): void {
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit): Promise<Response> => {
    fetchCalls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal });
    events.push(`fetch ${String(url)}`);
    onFetch?.();
    // A REAL asynchronous boundary, not just a resolved promise. handleArticlesQueue
    // awaits each message in turn, and the only way to tell that apart from a
    // Promise.all over the batch is to make the work actually yield -- see
    // "processes a batch one message at a time".
    await new Promise((resolve) => setTimeout(resolve, 0));
    // What node's own fetch does with a non-URL, measured rather than guessed:
    // `fetch(null)` rejects with TypeError "Failed to parse URL from null"
    // (run under this repo's node before this stub was written). It matters
    // because the food bank row's rss_url is nullable and articles.ts:65 hands
    // it straight to fetch -- see "a feed URL cleared between enqueue and
    // dequeue".
    if (typeof url !== "string" || !/^https?:/.test(url)) throw new TypeError(`Failed to parse URL from ${String(url)}`);
    const queue = feedReplies.get(url);
    // An unmodelled URL is a test bug, never a silent default: a fetch this
    // handler grows later must fail loudly here rather than be absorbed by the
    // handler's own catch-everything block.
    if (!queue || queue.length === 0) throw new Error(`unmodelled fetch: ${url}`);
    const reply = queue.length === 1 ? queue[0]! : queue.shift()!;
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, { status: reply.status });
  });
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

let purgeSend: ReturnType<typeof vi.fn>;
/** Runs inside PURGE_Q.send, for observing the database at the instant of the purge. */
let onPurge: (() => void) | null;
/** The constraint string each processOne asked D1 for -- see the session-mode test. */
let sessionModes: unknown[];

function buildEnv(): Env {
  return {
    DB: {
      withSession: (mode: unknown) => {
        sessionModes.push(mode);
        return d1Session();
      },
    },
    PURGE_Q: { send: purgeSend },
  } as unknown as Env;
}

interface FakeMessage {
  id: string;
  body: unknown;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

interface FakeBatch {
  batch: MessageBatch<ArticlesMessage>;
  messages: FakeMessage[];
  ackAll: ReturnType<typeof vi.fn>;
  retryAll: ReturnType<typeof vi.fn>;
}

/**
 * A MessageBatch whose per-message ack/retry are observable. `ackAll`/`retryAll`
 * are present and asserted never to be called: this handler must settle each
 * message on its own, because a batch of five (wrangler.jsonc's
 * max_batch_size: 5) can easily contain one dead food bank and four live ones.
 */
function batchOf(...bodies: unknown[]): FakeBatch {
  const messages: FakeMessage[] = bodies.map((body, index) => {
    const slug = (body as ArticlesMessage | null)?.slug ?? "?";
    return {
      id: `msg-${index + 1}`,
      body,
      ack: vi.fn(() => void events.push(`ack ${slug}`)),
      retry: vi.fn(() => void events.push(`retry ${slug}`)),
    };
  });
  const ackAll = vi.fn();
  const retryAll = vi.fn();
  return {
    batch: { queue: "articles", messages, ackAll, retryAll } as unknown as MessageBatch<ArticlesMessage>,
    messages,
    ackAll,
    retryAll,
  };
}

// ===========================================================================
// FIXTURES
// ===========================================================================

// The clock is frozen so that last_crawl, crawlitem.start/finish and
// crawlset.finish can be asserted as EXACT strings rather than matched against
// a shape. Only Date is faked -- the fetch stub's setTimeout and
// AbortSignal.timeout's own timer stay real, so nothing here depends on
// pretending time passes.
const NOW = new Date("2026-09-06T20:22:41.037Z");
/** Django's str(datetime): a space, six fractional digits, no "T", no "Z". */
const DJANGO_NOW = "2026-09-06 20:22:41.037000";

// Deliberately unequal ids. crawlSetId and foodbankId are two numbers side by
// side in the message body and in insertCrawlItem's parameter object, so a
// fixture where they coincide cannot see a transposition -- the same trap
// routes/admin/foodbankForceCrawl.test.ts documents for the producer side.
const CRAWL_SET = 7;
const SALISBURY = 22;
const DUNDEE = 41;

const SALISBURY_FEED = "https://salisbury.example/feed/";
const DUNDEE_FEED = "https://dundee.example/news/feed/";

// givefood/const/general.py:210 verbatim -- read at
// /Users/jasoncartwright/Sites/foodcharity and compared byte for byte.
// crawlers.py:39 sets it on feedparser itself (`feedparser.USER_AGENT = ...`),
// which is why the port sends it by hand.
const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

/** RFC 822, the shape WordPress -- most food banks' CMS -- emits. */
const PUB = "Sun, 06 Sep 2026 07:30:00 +0000";

const rss = (items: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>News</title>${items}</channel></rss>`;

const item = (title: string, link: string, pubDate: string = PUB): string =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${pubDate}</pubDate></item>`;

interface FoodbankSeed {
  id: number;
  slug: string;
  name?: string;
  rssUrl?: string | null;
  lastCrawl?: string | null;
  isClosed?: 0 | 1;
}

/**
 * Fills every NOT NULL column the real foodbank table declares (17 of them
 * under the full migration set), so a seeded row is one production would
 * actually accept.
 */
function seedFoodbank({ id, slug, name, rssUrl = null, lastCrawl = null, isClosed = 0 }: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url, rss_url,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       last_crawl, created, modified
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, 0, 14, ?, ?, ?)`,
  ).run(
    id,
    `uuid-${slug}`,
    name ?? slug,
    slug,
    "1 High Street",
    "SP1 1AA",
    "England",
    "51.0688,-1.7945",
    `info@${slug}.example`,
    `https://${slug}.example/`,
    `https://${slug}.example/shopping-list/`,
    rssUrl,
    isClosed,
    lastCrawl,
    "2020-01-01 00:00:00.000000",
    "2026-08-01 09:15:22.412000",
  );
}

/** An article row as the ETL wrote it -- one of the 17,196 already in the table. */
function seedArticle(row: { id: number; foodbankId: number; publishedDate: string; title: string; url: string }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, 0)").run(
    row.id,
    row.foodbankId,
    row.publishedDate,
    row.title,
    row.url,
  );
}

function seedCrawlSet(id: number, remaining: number | null): void {
  db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, expected, remaining) VALUES (?, 'article', ?, ?, ?, ?)").run(
    id,
    `articles-2026-09-06-20`,
    DJANGO_NOW,
    remaining,
    remaining,
  );
}

function articles(): Record<string, unknown>[] {
  return db.prepare("SELECT id, foodbank_id, published_date, title, url, featured FROM foodbankarticle ORDER BY id").all();
}

function crawlItems(): Record<string, unknown>[] {
  return db.prepare("SELECT id, crawl_set_id, crawl_type, start, finish, foodbank_id, url, need_id FROM crawlitem ORDER BY id").all();
}

function crawlSet(id: number = CRAWL_SET): Record<string, unknown> | undefined {
  return db.prepare("SELECT id, expected, remaining, finish FROM crawlset WHERE id = ?").get(id);
}

function lastCrawlOf(id: number): unknown {
  return (db.prepare("SELECT last_crawl FROM foodbank WHERE id = ?").get(id) as { last_crawl: unknown } | undefined)?.last_crawl;
}

/** The ordinary message the cron sends (scheduled/index.ts:198). */
const MESSAGE: ArticlesMessage = { crawlSetId: CRAWL_SET, foodbankId: SALISBURY, slug: "salisbury" };

/** Run one ordinary message and hand back the fake batch for ack/retry assertions. */
async function run(...bodies: unknown[]): Promise<FakeBatch> {
  const fake = batchOf(...(bodies.length > 0 ? bodies : [MESSAGE]));
  await handleArticlesQueue(fake.batch, buildEnv());
  return fake;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(MIGRATIONS_SQL);
  failIf = null;

  seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury", rssUrl: SALISBURY_FEED, lastCrawl: "2026-09-06 18:21:04.552000" });
  // The neighbour that must NOT be touched by a Salisbury message. Every
  // "wrote the right row" assertion is only worth something next to a row the
  // same statement could have written by mistake -- an UPDATE that lost its
  // WHERE stamps all 1,071 food banks and reports nothing.
  seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee", rssUrl: DUNDEE_FEED, lastCrawl: "2026-09-06 18:21:09.118000" });
  seedCrawlSet(CRAWL_SET, 2);

  feedReplies = new Map();
  fetchCalls = [];
  events = [];
  logs = [];
  onFetch = null;
  onPurge = null;
  sessionModes = [];
  purgeSend = vi.fn(async (body: { tags: string[] }) => {
    events.push(`purge ${body.tags.join(",")}`);
    onPurge?.();
  });
  stubFetch();
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => String(a)).join(" ")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.close();
});

// ===========================================================================
// THE WHOLE WRITE SET FOR ONE SUCCESSFUL CRAWL
// ===========================================================================

describe("a successful crawl", () => {
  beforeEach(() => {
    feedReplies.set(SALISBURY_FEED, [
      {
        status: 200,
        body: rss(
          `${item("Harvest collections this Sunday", "https://salisbury.example/2026/09/06/harvest/")}
           ${item("New opening hours", "https://salisbury.example/2026/09/05/hours/", "Sat, 05 Sep 2026 11:00:00 +0000")}`,
        ),
      },
    ]);
  });

  // The whole point of the consumer, asserted as ROWS rather than as "it
  // resolved". crawlers.py:25-67 does five things -- open a CrawlItem, store
  // the new articles, stamp last_crawl, decache if anything was new, close the
  // CrawlItem -- and every one of them is invisible from outside except by
  // reading the table it wrote.
  it("stores the new articles, stamps last_crawl, purges the cache and closes the crawl item", async () => {
    const fake = await run();

    expect(articles()).toEqual([
      {
        id: 1,
        foodbank_id: SALISBURY,
        published_date: "2026-09-06 07:30:00.000000",
        title: "Harvest collections this Sunday",
        url: "https://salisbury.example/2026/09/06/harvest/",
        featured: 0,
      },
      {
        id: 2,
        foodbank_id: SALISBURY,
        published_date: "2026-09-05 11:00:00.000000",
        title: "New opening hours",
        url: "https://salisbury.example/2026/09/05/hours/",
        featured: 0,
      },
    ]);

    // ONE crawl item, opened against the crawl set from the message body and
    // the food bank from the message body, stamped with the feed URL read back
    // out of the row. need_id is null and stays null: articles.ts:92 passes
    // null, and that column exists for needcheck's FoodbankChange.
    expect(crawlItems()).toEqual([
      {
        id: 1,
        crawl_set_id: CRAWL_SET,
        crawl_type: "article",
        start: DJANGO_NOW,
        finish: DJANGO_NOW,
        foodbank_id: SALISBURY,
        url: SALISBURY_FEED,
        need_id: null,
      },
    ]);

    expect(lastCrawlOf(SALISBURY)).toBe(DJANGO_NOW);
    // crawlers.py:60's do_decache=True, expressed as tags rather than as
    // Django's enumerated URL list (PLAN.md §3.6).
    expect(purgeSend).toHaveBeenCalledTimes(1);
    expect(purgeSend).toHaveBeenCalledWith({ tags: ["fb-salisbury", "fb-all"] });
    // The countdown moved exactly once. `expected` is untouched -- it is the
    // cron's number and this consumer must never write it.
    expect(crawlSet()).toEqual({ id: CRAWL_SET, expected: 2, remaining: 1, finish: null });
    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(fake.messages[0]!.retry).not.toHaveBeenCalled();
  });

  // The neighbour, unchanged. An UPDATE that lost its WHERE, or an insert bound
  // to the wrong id, is silent: the crawl still "works", it just writes into
  // another food bank's row.
  it("leaves every other food bank's row alone", async () => {
    await run();

    expect(lastCrawlOf(DUNDEE)).toBe("2026-09-06 18:21:09.118000");
    expect(articles().every((row) => row.foodbank_id === SALISBURY)).toBe(true);
    expect(fetchCalls.map((call) => call.url)).toEqual([SALISBURY_FEED]);
  });

  // crawlSetId and foodbankId are adjacent numbers in one object literal, and
  // the crawl item takes both. With CRAWL_SET = 7 and SALISBURY = 22 a
  // transposition puts the articles on food bank 7 and the crawl item in crawl
  // set 22 -- neither of which exists, and neither of which errors: D1 has no
  // foreign keys (PLAN.md §4.5), so the rows would simply be orphaned and the
  // food bank's news page would stay empty for ever.
  it("keeps the crawl set's id and the food bank's id in the fields they belong in", async () => {
    await run();

    expect(crawlItems()[0]).toMatchObject({ crawl_set_id: CRAWL_SET, foodbank_id: SALISBURY });
    expect(articles().map((row) => row.foodbank_id)).toEqual([SALISBURY, SALISBURY]);
  });

  // Django's crawl_item.save() happens BEFORE feedparser.parse (crawlers.py:35
  // vs :40) and the port keeps that order, which is the only reason a hung feed
  // is visible at all: /admin/crawlsets/ shows an item with finish IS NULL. If
  // the item were opened after the fetch, a feed that hangs for the full 20s
  // timeout -- or a Worker that died mid-crawl -- would leave no trace whatever.
  it("opens the crawl item before the fetch, so a hung feed shows as an unfinished item", async () => {
    let openAtFetch: Record<string, unknown>[] = [];
    onFetch = () => void (openAtFetch = crawlItems());

    await run();

    expect(openAtFetch).toHaveLength(1);
    expect(openAtFetch[0]).toMatchObject({ foodbank_id: SALISBURY, url: SALISBURY_FEED, finish: null });
  });

  // ONE SESSION PER MESSAGE, OPENED UNCONSTRAINED. D1 read replication is why
  // every packages/db function takes a Session rather than the database
  // (workers/jobs/wrangler.jsonc's D1 note): "first-unconstrained" lets the
  // first read be served by a replica, and the session's bookmark then keeps
  // the writes that follow consistent with it. MUTANT session-mode-primary
  // ("first-primary") is silent -- every assertion in this file still passes,
  // and in production it just quietly routes every article crawl's reads to the
  // primary. The mode is a deliberate choice, so it is pinned rather than left
  // to whoever edits this line next.
  //
  // TWO MESSAGES, TWO SESSIONS. MUTANT session-per-batch (hoisting the
  // withSession call into handleArticlesQueue and passing one session down the
  // loop) survived while this test ran a single-message batch -- the assertion
  // said "per message" and only ever proved "at least one". A shared session
  // accumulates one bookmark chain across unrelated food banks, so a slow write
  // for the first food bank in a batch can hold up every read after it.
  it("opens one unconstrained D1 session per message, not one per batch", async () => {
    feedReplies.set(DUNDEE_FEED, [{ status: 200, body: rss(item("Dundee one", "https://dundee.example/1/")) }]);

    await run(MESSAGE, { crawlSetId: CRAWL_SET, foodbankId: DUNDEE, slug: "dundee" });

    expect(sessionModes).toEqual(["first-unconstrained", "first-unconstrained"]);
  });

  // Ordering, read from inside the queue send. last_crawl has to be stamped
  // before the purge, or a request racing the purge re-caches a page rendered
  // from the pre-crawl state; and the crawl item must still be open, because
  // the purge is the last thing that can fail and a failure has to leave the
  // item re-openable (see the purge-failure test below).
  it("stamps last_crawl before purging, and closes the crawl item after", async () => {
    let stateAtPurge: { lastCrawl: unknown; itemFinish: unknown } | null = null;
    onPurge = () => void (stateAtPurge = { lastCrawl: lastCrawlOf(SALISBURY), itemFinish: crawlItems()[0]!.finish });

    await run();

    expect(stateAtPurge).toEqual({ lastCrawl: DJANGO_NOW, itemFinish: null });
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
  });
});

// ===========================================================================
// THE FETCH
// ===========================================================================

describe("the fetch", () => {
  beforeEach(() => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);
  });

  // crawlers.py:39 sets feedparser.USER_AGENT to this exact string, so food
  // banks' own logs, WAF rules and robots exceptions are all keyed to it. A
  // Worker fetching with the default UA is not an error anywhere -- it is a
  // 403 from whichever hosts allow-list the bot, i.e. a handful of feeds
  // silently going empty.
  it("identifies itself with the same bot user agent Django set on feedparser", async () => {
    await run();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.headers).toEqual({ "User-Agent": BOT_USER_AGENT });
  });

  // The 20s AbortSignal is the one thing here Django never had: feedparser's
  // own fetch is unbounded and the module comment records a measured 148s hang.
  //
  // MUTANT timeout-200ms (AbortSignal.timeout(20_000) -> (200)) SURVIVED this
  // file's first sweep, on the reasoning that a stubbed fetch cannot see the
  // deadline -- an AbortSignal exposes `aborted`, not the time it will fire.
  // It can be seen one level up: AbortSignal.timeout is a writable, spy-able
  // static, so the ARGUMENT is observable even though its effect is not. The
  // spy calls through, so the signal handed to fetch is still a real, live one.
  //
  // Both directions of that mutant are silent in production and neither has a
  // failing test anywhere else: shortened, every feed on slow hosting starts
  // aborting into the "nothing today" path and simply goes quiet; lengthened,
  // the 148s hang is back and one food bank's dead server holds a queue slot
  // for the whole invocation.
  it("passes a live abort signal set to 20 seconds, the timeout Django never had", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await run();

    expect(timeout.mock.calls).toEqual([[20_000]]);
    const signal = fetchCalls[0]!.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  // The re-fetch-at-dequeue-time pattern (crawlers.py:579-590, and
  // getFoodbankForArticleCrawl's own comment) exists for exactly this: the
  // message body carries no URL, so an admin who fixes a feed URL between the
  // cron's enqueue and the consumer's dequeue gets the corrected URL crawled.
  // A consumer that cached the enqueue-time snapshot would keep crawling the
  // broken one until the next cron.
  it("crawls the feed URL read back at dequeue time, not one carried in the message", async () => {
    db.prepare("UPDATE foodbank SET rss_url = ? WHERE id = ?").run("https://salisbury.example/corrected-feed/", SALISBURY);
    feedReplies.set("https://salisbury.example/corrected-feed/", [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);

    await run();

    expect(fetchCalls.map((call) => call.url)).toEqual(["https://salisbury.example/corrected-feed/"]);
    // ...and the crawl item records the URL that was actually crawled, which is
    // what /admin/crawlsets/ shows when someone asks why a feed found nothing.
    expect(crawlItems()[0]!.url).toBe("https://salisbury.example/corrected-feed/");
  });

  // One request per message, however many items come back. wrangler.jsonc caps
  // this queue at max_concurrency 15 precisely because the far end is a food
  // bank's own (often tiny) hosting; a retry loop or a per-item fetch added here
  // would multiply that by the feed length against sites that can least afford
  // it.
  it("makes exactly one request per message", async () => {
    feedReplies.set(SALISBURY_FEED, [
      { status: 200, body: rss(Array.from({ length: 20 }, (_, n) => item(`Story ${n}`, `https://salisbury.example/${n}/`)).join("")) },
    ]);

    await run();

    expect(fetchCalls).toHaveLength(1);
    expect(articles()).toHaveLength(20);
  });
});

// ===========================================================================
// WHAT GETS STORED
// ===========================================================================

describe("what gets stored", () => {
  // crawlers.py:50's `item.title[0:250]`. FoodbankArticle.title is a
  // CharField(max_length=250) in Django and a plain TEXT column in D1, so
  // SQLite would happily store the whole thing -- the slice is the only thing
  // keeping the two databases' contents comparable, and dropping it would be
  // invisible until someone diffed a title against production.
  it("truncates a long title at 250 characters, as Django's slice did", async () => {
    const long = `${"Volunteers needed for the ".repeat(20)}end`; // 523 chars
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item(long, "https://salisbury.example/1/")) }]);

    await run();

    expect(String(articles()[0]!.title)).toHaveLength(250);
    expect(articles()[0]!.title).toBe(long.slice(0, 250));
  });

  // A SHORT TITLE IS NOT PADDED OR TRIMMED -- the slice must not be a
  // substring(0, 250) mutant that also normalises. The overwhelming majority of
  // real titles are far under the limit, so this is the path that actually runs.
  it("stores a short title unchanged", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("Harvest &amp; Advent appeal", "https://salisbury.example/1/")) }]);

    await run();

    expect(articles()[0]!.title).toBe("Harvest & Advent appeal");
  });

  // A DIVERGENCE FROM DJANGO, pinned rather than fixed, and MEASURED rather
  // than reasoned about. Python's `title[0:250]` counts CODE POINTS; JavaScript's
  // `slice(0, 250)` counts UTF-16 CODE UNITS, so an emoji before the boundary
  // costs two. Both halves were run on this machine:
  //
  //   python3 -c "s='a'*248+'\U0001F600'+'tail'; print(len(s[0:250]), repr(s[0:250][-2:]))"
  //     -> 250 '😀t'
  //   node -e "...s.slice(0,250)..."  -> length 250, 249 code points, ends '😀'
  //
  // So this port stores one character fewer than Django for such a title. It is
  // cosmetic here (a headline losing its last letter at exactly 250) and it
  // matters only if someone diffs the two databases and expects equality.
  //
  // The nastier case, also measured and NOT asserted below because the result
  // is an artefact of the storage engine rather than of this module: when the
  // boundary lands BETWEEN a surrogate pair, JS keeps a lone high surrogate,
  // and node:sqlite stores it as U+FFFD. Whether D1 does the same is NOT
  // VERIFIED -- there is no workerd in this suite to ask.
  it("counts UTF-16 units where Django counted characters, so an emoji costs two", async () => {
    const title = `${"a".repeat(248)}\u{1F600}tail`;
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item(title, "https://salisbury.example/1/")) }]);

    await run();

    const stored = String(articles()[0]!.title);
    expect(stored).toHaveLength(250); // UTF-16 units, the same number Django counts characters
    expect([...stored]).toHaveLength(249); // ...but one character fewer than Django would store
    expect(stored.endsWith("\u{1F600}")).toBe(true); // Django's slice ends "😀t"
  });

  // TICKET #9. published_date is TEXT and every reader orders on it
  // lexicographically, so the port must write Django's spelling. An RFC 822
  // pubDate with an offset also has to land in UTC: feedparser normalises
  // published_parsed to UTC and Django's mktime() then read it back under a
  // TZ=UTC process, so a BST feed's 08:30 is stored as 07:30 in both.
  it("writes the published date in Django's spelling, converted to UTC", async () => {
    feedReplies.set(SALISBURY_FEED, [
      { status: 200, body: rss(item("Summer appeal", "https://salisbury.example/1/", "Sun, 06 Sep 2026 08:30:00 +0100")) },
    ]);

    await run();

    expect(articles()[0]!.published_date).toBe("2026-09-06 07:30:00.000000");
  });

  // The regression itself, executed rather than described: an earlier version
  // of this crawler wrote toISOString(), and " " (0x20) sorts before "T"
  // (0x54), so an ISO-spelled morning row jumps ahead of a Django-spelled
  // evening row from the same day. 0022_normalise_timestamps.sql had to go back
  // and repair nine of them. This test seeds ETL rows either side of the new one
  // and reads the page's own ORDER BY back.
  it("sorts correctly against the ETL's rows under the ORDER BY the news page uses", async () => {
    seedArticle({ id: 900, foodbankId: SALISBURY, publishedDate: "2026-09-06 06:00:00.000000", title: "Earlier", url: "https://salisbury.example/e/" });
    seedArticle({ id: 901, foodbankId: SALISBURY, publishedDate: "2026-09-06 22:00:00.000000", title: "Evening", url: "https://salisbury.example/v/" });
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("Morning", "https://salisbury.example/m/")) }]);

    await run();

    const order = db
      .prepare("SELECT title FROM foodbankarticle WHERE foodbank_id = ? ORDER BY published_date DESC")
      .all(SALISBURY)
      .map((row) => row.title);
    expect(order).toEqual(["Evening", "Morning", "Earlier"]);
  });

  // THE GLOSSOPDALE INCIDENT, from the consumer's side. feedParser resolves an
  // item link against the feed URL, and the feed URL it is given is the one
  // read out of the row -- articles.ts:67 passes foodbank.rss_url, not the
  // message. Before that resolution existed, /needs/at/glossopdale/news/
  // returned a hard 500 (url_with_ref calls new URL() on the stored value) and
  // every article was stored twice, once by each crawler.
  it("stores a relative feed link resolved against the feed URL it fetched", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("New fire door needed", "/news/new-fire-door-needed/")) }]);

    await run();

    expect(articles()[0]!.url).toBe("https://salisbury.example/news/new-fire-door-needed/");
    // The stored value is one `new URL()` can parse, which is what the news
    // page and the API both do to it.
    expect(() => new URL(String(articles()[0]!.url))).not.toThrow();
  });

  // parseFeed drops items with no title, no usable date or no link
  // (crawlers.py:43's `if item.title != ""`, plus the structural requirement
  // that published_date is NOT NULL). The consumer relies on that -- it
  // dereferences item.publishedDate with a `!` -- so a feed carrying all four
  // shapes must still store only the good one, and must not throw on the rest.
  it("stores only the items parseFeed considers usable, and does not throw on the others", async () => {
    feedReplies.set(SALISBURY_FEED, [
      {
        status: 200,
        body: rss(
          `${item("Good one", "https://salisbury.example/good/")}
           <item><title></title><link>https://salisbury.example/untitled/</link><pubDate>${PUB}</pubDate></item>
           <item><title>Undated</title><link>https://salisbury.example/undated/</link></item>
           <item><title>Unparseable date</title><link>https://salisbury.example/bad-date/</link><pubDate>next Tuesday</pubDate></item>
           <item><title>No link at all</title><pubDate>${PUB}</pubDate></item>`,
        ),
      },
    ]);

    const fake = await run();

    expect(articles().map((row) => row.url)).toEqual(["https://salisbury.example/good/"]);
    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });

  // The common path, not an edge: every crawl re-reads a feed whose items are
  // nearly all stored already. `INSERT OR IGNORE` against article_url_uniq is
  // what makes that a no-op, and what makes a Cloudflare Queues redelivery
  // harmless. The seeded row is an ETL row -- the population the crawler's own
  // rows have to coexist with.
  it("does not duplicate an article it already has, or rewrite its title", async () => {
    seedArticle({
      id: 900,
      foodbankId: SALISBURY,
      publishedDate: "2026-09-06 07:30:00.000000",
      title: "Harvest collections this Sunday",
      url: "https://salisbury.example/harvest/",
    });
    feedReplies.set(SALISBURY_FEED, [
      { status: 200, body: rss(item("Harvest collections this Sunday | Salisbury Foodbank", "https://salisbury.example/harvest/")) },
    ]);

    await run();

    expect(articles()).toEqual([
      {
        id: 900,
        foodbank_id: SALISBURY,
        published_date: "2026-09-06 07:30:00.000000",
        title: "Harvest collections this Sunday", // NOT the feed's new spelling
        url: "https://salisbury.example/harvest/",
        featured: 0,
      },
    ]);
  });

  // THE UNIQUENESS IS GLOBAL, NOT PER FOOD BANK, and that is Django's
  // behaviour too: crawlers.py:44 dedups with
  // `FoodbankArticle.objects.filter(url=item.link).first()` -- no foodbank in
  // the filter -- and the port's index is `CREATE UNIQUE INDEX article_url_uniq
  // ON foodbankarticle(url)` (0010_article_url_unique.sql), likewise on (url)
  // alone. Both read at /Users/jasoncartwright/Sites/foodcharity and in this
  // repo's migrations.
  //
  // The consequence, which nothing else in this file pins: if two food banks'
  // feeds ever carry the same item URL, whichever is crawled SECOND stores
  // nothing and purges nothing. How often that happens in production is NOT
  // VERIFIED here -- no production query was run -- but it is what both
  // implementations do, so a change to either index has to be a deliberate
  // decision rather than an accident. The row seeded below is one that MUST be
  // excluded: it belongs to Dundee, and a dedup accidentally scoped per food
  // bank (or an insert that overwrote the row's foodbank_id) would both look
  // identical to a test that only ever seeds Salisbury's own articles.
  it("treats an article URL another food bank already stored as already-known", async () => {
    seedArticle({
      id: 900,
      foodbankId: DUNDEE,
      publishedDate: "2026-09-06 07:30:00.000000",
      title: "Network harvest appeal",
      url: "https://network.example/harvest-appeal/",
    });
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("Network harvest appeal", "https://network.example/harvest-appeal/")) }]);

    const fake = await run();

    // Still Dundee's row, unchanged -- not re-pointed at Salisbury, not copied.
    expect(articles()).toEqual([
      {
        id: 900,
        foodbank_id: DUNDEE,
        published_date: "2026-09-06 07:30:00.000000",
        title: "Network harvest appeal",
        url: "https://network.example/harvest-appeal/",
        featured: 0,
      },
    ]);
    // Nothing new was stored, so nothing is purged -- Salisbury's news page
    // genuinely has not changed.
    expect(purgeSend).not.toHaveBeenCalled();
    // ...and the crawl still closes cleanly.
    expect(lastCrawlOf(SALISBURY)).toBe(DJANGO_NOW);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });

  // A crawled article is never featured. The homepage's article block is
  // `WHERE a.featured = 1` behind a partial index, so featuring is an admin act
  // -- this literal is what keeps 17,000 crawled articles off the front page.
  it("never features what it stores", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);

    await run();

    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankarticle WHERE featured = 1").get()).toEqual({ n: 0 });
  });
});

// ===========================================================================
// THE CACHE PURGE
// ===========================================================================

describe("the cache purge", () => {
  // crawlers.py:59-62: `if found_new_article: save(do_decache=True) else:
  // save(do_decache=False)`. Every crawl of every feed re-reads items that are
  // already stored, so "nothing new" is the normal outcome for ~470 food banks
  // seven times a day -- purging on every crawl regardless would be ~3,300
  // needless purges daily and would flush the cache the site depends on.
  it("does not purge when every item in the feed is already stored", async () => {
    seedArticle({ id: 900, foodbankId: SALISBURY, publishedDate: "2026-09-06 07:30:00.000000", title: "Known", url: "https://salisbury.example/known/" });
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("Known", "https://salisbury.example/known/")) }]);

    const fake = await run();

    expect(purgeSend).not.toHaveBeenCalled();
    // ...but the crawl still completes: last_crawl means "when we last looked",
    // not "when we last found" (crawlers.py:58 stamps it unconditionally).
    expect(lastCrawlOf(SALISBURY)).toBe(DJANGO_NOW);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet()).toMatchObject({ remaining: 1 });
    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });

  // One new item among known ones is still a purge: foundNew is an OR across
  // the whole feed, not a property of the last item examined.
  //
  // THE NEW ITEM IS FIRST AND THE KNOWN ONE LAST, deliberately. MUTANT
  // found-new-assignment (`foundNew = inserted` instead of `if (inserted)
  // foundNew = true`) survived this file's first mutation sweep because the
  // fixture had them the other way round -- and it is the realistic order, too:
  // feeds are newest-first, so the new item leads and the ones already stored
  // follow it. Under that mutant a food bank's news page would be purged only
  // when the LAST item in the feed happened to be new, i.e. almost never.
  it("purges when any item in the feed is new, not only when the last one is", async () => {
    seedArticle({ id: 900, foodbankId: SALISBURY, publishedDate: "2026-09-06 07:30:00.000000", title: "Known", url: "https://salisbury.example/known/" });
    feedReplies.set(SALISBURY_FEED, [
      { status: 200, body: rss(`${item("Brand new", "https://salisbury.example/new/")}${item("Known", "https://salisbury.example/known/")}`) },
    ]);

    await run();

    expect(articles().map((row) => row.url)).toEqual(["https://salisbury.example/known/", "https://salisbury.example/new/"]);
    expect(purgeSend).toHaveBeenCalledTimes(1);
  });

  // THE TAG COMES FROM THE ROW, NOT THE MESSAGE. Both are in scope at
  // articles.ts:90 (`foodbank.slug` and `msg.slug`) and they are equal in every
  // message the cron sends, so a fixture where they match cannot tell them
  // apart. A slug renamed between enqueue and dequeue is the case that can: the
  // cached pages are under the NEW slug, so purging the old one would leave the
  // food bank's news page stale until the next edit -- silently, since the purge
  // itself succeeds.
  it("purges the tag for the slug in the row, not the slug in the message", async () => {
    db.prepare("UPDATE foodbank SET slug = ? WHERE id = ?").run("salisbury-and-district", SALISBURY);
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);

    await run({ crawlSetId: CRAWL_SET, foodbankId: SALISBURY, slug: "salisbury" });

    expect(purgeSend).toHaveBeenCalledWith({ tags: ["fb-salisbury-and-district", "fb-all"] });
  });

  // Both tags, in this order and no others. `fb-all` is the aggregate tag the
  // homepage, the sitemaps, the site-wide RSS and every list endpoint carry
  // (packages/urls/src/cacheTags.ts): a new article changes the homepage's
  // article block as well as the food bank's own page, so dropping it would
  // leave the front page showing yesterday's news with nothing to indicate it.
  it("sends exactly the food bank tag and the aggregate tag", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);

    await run();

    expect(purgeSend.mock.calls).toEqual([[{ tags: ["fb-salisbury", "fb-all"] }]]);
  });

  // The send is AWAITED, and this is the assertion that proves it: a `void
  // env.PURGE_Q.send(...)` mutant acks the message and closes the crawl item
  // cheerfully. It matters twice over -- an un-awaited send can be cancelled
  // when the invocation ends, and a failing one must not be able to leave the
  // crawl item closed and the countdown decremented while the cache still holds
  // the stale page.
  it("retries the message and leaves the crawl item open when the purge queue fails", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);
    purgeSend.mockRejectedValueOnce(new Error("queue unavailable"));

    const fake = await run();

    expect(fake.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(fake.messages[0]!.ack).not.toHaveBeenCalled();
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet()).toMatchObject({ remaining: 2, finish: null });
    // The article IS already stored, so the retry will find nothing new and
    // will not purge again -- see the redelivery block. The stale page is fixed
    // by the next crawl that finds something, or by hand.
    expect(articles()).toHaveLength(1);
  });
});

// ===========================================================================
// FEED-LEVEL FAILURES: "NOTHING TODAY, TRY AGAIN TOMORROW"
// ===========================================================================
//
// The module comment is explicit that Django has no safety guard here at all:
// feedparser never throws, it sets a bozo flag and returns what it could, so an
// unreachable or malformed feed produced zero items that day and the next cron
// tried again. Every case below reproduces that -- close the CrawlItem cleanly
// with foundNew = false, ack, move on -- and each asserts the full closing set,
// because "no articles" is only half the contract: a path that skipped
// last_crawl or the countdown would leave /admin/crawlsets/ showing a run that
// never finishes.

describe("feed-level failures close the crawl item and ack", () => {
  /** The closing set every one of these must still perform. */
  function expectClosedCleanly(fake: FakeBatch): void {
    expect(articles()).toEqual([]);
    expect(purgeSend).not.toHaveBeenCalled();
    expect(lastCrawlOf(SALISBURY)).toBe(DJANGO_NOW);
    expect(crawlItems()[0]).toMatchObject({ finish: DJANGO_NOW, url: SALISBURY_FEED });
    expect(crawlSet()).toMatchObject({ remaining: 1 });
    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(fake.messages[0]!.retry).not.toHaveBeenCalled();
  }

  it("treats a 404 as an empty feed", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 404, body: "<html><body>Not found</body></html>" }]);

    expectClosedCleanly(await run());
  });

  it("treats a 500 as an empty feed", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 500, body: "upstream error" }]);

    expectClosedCleanly(await run());
  });

  // THE `res.ok` GUARD, which is not the same statement as the two above.
  // A CMS that serves its error page with a 404 but a valid feed body -- or,
  // more realistically, a caching layer returning a stale 404 for a feed that
  // exists -- must store nothing. Dropping `if (res.ok)` would parse the body
  // anyway, and here that body is a perfectly good feed, so the mutant stores
  // articles rather than erroring.
  it("does not parse the body of a non-ok response even when it is a valid feed", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 404, body: rss(item("Would have been stored", "https://salisbury.example/1/")) }]);

    expectClosedCleanly(await run());
  });

  // DNS failure, TLS failure, connection reset: the fetch rejects. Django's
  // feedparser swallowed all of these; the port catches them and logs, and the
  // log line is the ONLY trace, so its contents are asserted -- it names the
  // URL, which is what someone reading the tail of the logs needs.
  it("treats a network failure as an empty feed, and logs the URL", async () => {
    feedReplies.set(SALISBURY_FEED, [new TypeError("fetch failed")]);

    expectClosedCleanly(await run());
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`articles: fetch failed for ${SALISBURY_FEED}`);
    expect(logs[0]).toContain("fetch failed");
  });

  // The 20s AbortSignal firing, which is what a 148s hang now looks like. It
  // has to land on the "nothing today" side rather than the retry side: a feed
  // that is permanently slow would otherwise burn three retries and a
  // dead-letter message every two hours.
  it("treats its own 20s timeout as an empty feed", async () => {
    feedReplies.set(SALISBURY_FEED, [new DOMException("The operation was aborted due to timeout", "TimeoutError")]);

    expectClosedCleanly(await run());
    expect(logs[0]).toContain("articles: fetch failed for");
  });

  // fast-xml-parser THROWS on XML that is not well-formed, where feedparser's
  // tag-soup parser tolerated it -- parseFeed catches that and returns []. The
  // consumer has no separate handling for it, which is the point: a CMS
  // mid-migration emitting broken XML is a bad day for the food bank, not an
  // infrastructure failure for us.
  it("treats malformed XML as an empty feed", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: "<rss><channel><item><title>Unclosed" }]);

    expectClosedCleanly(await run());
    // No log line at all: parseFeed absorbs this one, so an unparseable feed is
    // even quieter than an unreachable one. Worth knowing when a food bank asks
    // why their news never appears.
    expect(logs).toEqual([]);
  });

  // The commonest "wrong thing at the right URL": a feed URL that now serves an
  // HTML page. Well-formed enough to parse, no <rss>/<RDF>/<feed> root, so
  // parseFeed returns [] rather than throwing.
  it("treats an HTML page served at the feed URL as an empty feed", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: "<html><body><h1>News</h1><p>Coming soon</p></body></html>" }]);

    expectClosedCleanly(await run());
  });

  it("treats a valid but empty feed as an empty feed", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss("") }]);

    expectClosedCleanly(await run());
  });

  // THE NULLABLE COLUMN THE ROW TYPE SAYS IS A STRING.
  // ArticleCrawlFoodbankRow declares `rss_url: string`, the column is nullable,
  // and getFoodbankForArticleCrawl has no IS NOT NULL guard (the cron's filter
  // is not repeated at dequeue time) -- so an admin clearing the feed URL in
  // the enqueue-to-dequeue window hands this consumer a null. It survives:
  // fetch(null) rejects with a TypeError, which lands in the same catch as any
  // other network failure. Pinned as-is, and noted as suspect: the crawl item
  // is stored with url NULL, which on /admin/crawlsets/ is indistinguishable
  // from a crawl item whose URL was simply never recorded.
  it("survives a feed URL cleared between enqueue and dequeue", async () => {
    db.prepare("UPDATE foodbank SET rss_url = NULL WHERE id = ?").run(SALISBURY);

    const fake = await run();

    expect(articles()).toEqual([]);
    expect(crawlItems()[0]).toMatchObject({ url: null, finish: DJANGO_NOW });
    expect(lastCrawlOf(SALISBURY)).toBe(DJANGO_NOW);
    expect(logs[0]).toContain("articles: fetch failed for null");
    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });

  // The cron filters closed food banks out (getFoodbanksWithRss's
  // `is_closed = 0`, a deliberate divergence from getarticles.py:21) but this
  // lookup does not, so a food bank closed while its message was in flight is
  // still crawled once. That is the right failure mode: the alternative is a
  // thrown "no longer exists" that burns three retries and a dead-letter
  // message for a food bank that is merely closed.
  it("still crawls a food bank closed since the message was enqueued", async () => {
    db.prepare("UPDATE foodbank SET is_closed = 1 WHERE id = ?").run(SALISBURY);
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("Closing down", "https://salisbury.example/1/")) }]);

    const fake = await run();

    expect(articles()).toHaveLength(1);
    expect(purgeSend).toHaveBeenCalledTimes(1);
    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// INFRASTRUCTURE FAILURES RETRY, THEY DO NOT ACK
// ===========================================================================

describe("infrastructure failures retry", () => {
  // The window getFoodbankForArticleCrawl exists to cover. A food bank deleted
  // between the cron's enqueue and this dequeue throws rather than acking, so
  // the message retries three times (wrangler.jsonc's max_retries: 3) and then
  // reaches articles-dlq, whose consumer decrements the countdown so the run
  // can still finish. Acking here instead would leave crawlset.remaining stuck
  // and the run "in progress" for ever.
  it("throws for a food bank deleted between enqueue and dequeue, and writes nothing", async () => {
    db.prepare("DELETE FROM foodbank WHERE id = ?").run(SALISBURY);

    const fake = await run();

    expect(fake.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(fake.messages[0]!.ack).not.toHaveBeenCalled();
    // NO crawl item at all: the food bank is looked up before the item is
    // opened, so a dead message leaves nothing behind to be mistaken for a
    // stalled crawl.
    expect(crawlItems()).toEqual([]);
    expect(crawlSet()).toMatchObject({ remaining: 2 });
    expect(fetchCalls).toEqual([]);
    expect(logs[0]).toContain("articles: message failed for foodbank 22 (salisbury)");
    expect(logs[0]).toContain("articles: foodbank 22 (salisbury) no longer exists");
  });

  // The retry delay is not decoration: the failures that reach this path are
  // D1 errors and vanished rows, and an immediate retry against a database
  // that is having a bad minute just spends the three attempts faster. 60
  // seconds x 3 is the window before articles-dlq.
  it("asks for a 60-second delay, not an immediate retry", async () => {
    db.prepare("DELETE FROM foodbank WHERE id = ?").run(SALISBURY);

    const fake = await run();

    expect(fake.messages[0]!.retry.mock.calls).toEqual([[{ delaySeconds: 60 }]]);
  });

  // A D1 failure opening the crawl item. Nothing has been written yet, so the
  // retry is clean -- this is the one infrastructure failure with no partial
  // state at all.
  it("retries a D1 failure while opening the crawl item, having written nothing", async () => {
    failIf = (sql) => (/INSERT INTO crawlitem/i.test(sql) ? new Error("D1_ERROR: Network connection lost") : null);

    const fake = await run();

    expect(fake.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(crawlItems()).toEqual([]);
    expect(lastCrawlOf(SALISBURY)).toBe("2026-09-06 18:21:04.552000");
    expect(fetchCalls).toEqual([]);
  });

  // A D1 failure stamping last_crawl, which happens AFTER the articles are
  // stored. The message retries, so the articles are stored and the crawl item
  // is left open -- exactly the state the upsert in insertCrawlItem exists to
  // handle. Pinned because it is the shape a reader needs to trust: partial
  // work plus a retry, never partial work plus an ack.
  it("retries a D1 failure stamping last_crawl, leaving the crawl item open", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);
    failIf = (sql) => (/UPDATE foodbank SET last_crawl/i.test(sql) ? new Error("D1_ERROR: Network connection lost") : null);

    const fake = await run();

    expect(fake.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(fake.messages[0]!.ack).not.toHaveBeenCalled();
    expect(articles()).toHaveLength(1); // already committed -- D1 has no transaction here
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet()).toMatchObject({ remaining: 2 });
    expect(purgeSend).not.toHaveBeenCalled();
  });

  // A D1 failure closing the crawl item, i.e. after last_crawl and the purge
  // have already happened. The countdown has NOT moved, so the redelivery is
  // what closes the item and decrements -- see the redelivery block for the
  // proof that it decrements exactly once.
  it("retries a D1 failure closing the crawl item, after last_crawl is already stamped", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);
    failIf = (sql) => (/UPDATE crawlitem SET finish/i.test(sql) ? new Error("D1_ERROR: Network connection lost") : null);

    const fake = await run();

    expect(fake.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(lastCrawlOf(SALISBURY)).toBe(DJANGO_NOW);
    expect(purgeSend).toHaveBeenCalledTimes(1);
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet()).toMatchObject({ remaining: 2 });
  });

  // A D1 failure decrementing the countdown -- the last statement in the
  // handler. The crawl item is already closed, so on redelivery finishCrawlItem
  // matches nothing (`AND finish IS NULL`), returns false, and the decrement is
  // SKIPPED for ever: this crawl set can never reach remaining 0 and never gets
  // its finish stamped. SUSPECT, pinned as-is: the failure is genuinely rare and
  // the alternative (decrementing without the finish guard) would double-count,
  // which is worse. The visible symptom is a run stuck on /admin/crawlsets/.
  it("retries a D1 failure decrementing the countdown, though the redelivery can no longer decrement", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);
    failIf = (sql) => (/UPDATE crawlset SET remaining/i.test(sql) ? new Error("D1_ERROR: Network connection lost") : null);

    const first = await run();
    expect(first.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet()).toMatchObject({ remaining: 2 });

    // The redelivery, with D1 healthy again.
    failIf = null;
    const second = await run();

    expect(second.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(crawlSet()).toMatchObject({ remaining: 2, finish: null }); // never counted down
  });
});

// ===========================================================================
// THE D1 WRITE INSIDE THE FETCH TRY-BLOCK
// ===========================================================================

describe("a D1 failure while storing an article (SUSPECT)", () => {
  // THE MODULE'S HEADER COMMENT SAYS: "Only a genuine infrastructure failure (a
  // D1 write erroring) is left uncaught, to retry via the outer handler below."
  // That is true of three of the four D1 writes. It is NOT true of
  // insertArticleIfNew, which sits INSIDE the try block that exists for the
  // fetch (articles.ts:62-86): a D1 error there is caught by the clause
  // commented "Network failure or fetch timeout", logged as
  // "articles: fetch failed for <url>", and the message is then ACKED with the
  // crawl item closed and the countdown decremented.
  //
  // The consequence is the silent kind this tier exists for: the article is
  // never retried, and the next crawl only re-offers it while the item is still
  // in the feed window -- a WordPress feed carries ten items, so a story that
  // ages out before the next successful crawl is lost permanently, and the only
  // trace is a log line blaming the food bank's web server for a database error.
  //
  // ASSERTED AS-IS, NOT FIXED, per TESTING.md. Reported in suspectedBugs.
  it("is logged as a fetch failure and acked, so the article is never retried", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("Would have been stored", "https://salisbury.example/1/")) }]);
    failIf = (sql) => (/INSERT OR IGNORE INTO foodbankarticle/i.test(sql) ? new Error("D1_ERROR: Network connection lost") : null);

    const fake = await run();

    expect(articles()).toEqual([]);
    // Acked, not retried: the message is gone and so is the article.
    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(fake.messages[0]!.retry).not.toHaveBeenCalled();
    // The crawl closes as a success -- last_crawl advances, the item is
    // finished, the countdown moves -- so nothing downstream can tell.
    expect(lastCrawlOf(SALISBURY)).toBe(DJANGO_NOW);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet()).toMatchObject({ remaining: 1 });
    // And the log line names the food bank's feed, not the database.
    expect(logs[0]).toContain(`articles: fetch failed for ${SALISBURY_FEED}`);
    expect(logs[0]).toContain("D1_ERROR");
  });

  // The other half of the same block: `foundNew` is declared OUTSIDE the try,
  // so items stored before the failure still trigger the purge. That is the
  // better half of the behaviour -- the pages for the articles that DID land
  // get invalidated -- and it is asserted so that a "tidy-up" moving foundNew
  // inside the try cannot quietly stop purging on a partial crawl.
  it("still purges for the articles that were stored before the failure", async () => {
    feedReplies.set(SALISBURY_FEED, [
      { status: 200, body: rss(`${item("Stored", "https://salisbury.example/1/")}${item("Lost", "https://salisbury.example/2/")}`) },
    ]);
    let inserts = 0;
    failIf = (sql) => {
      if (!/INSERT OR IGNORE INTO foodbankarticle/i.test(sql)) return null;
      inserts += 1;
      return inserts === 2 ? new Error("D1_ERROR: Network connection lost") : null;
    };

    const fake = await run();

    expect(articles().map((row) => row.url)).toEqual(["https://salisbury.example/1/"]);
    expect(purgeSend).toHaveBeenCalledWith({ tags: ["fb-salisbury", "fb-all"] });
    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// AT-LEAST-ONCE DELIVERY
// ===========================================================================

describe("redelivery of the same message", () => {
  // Cloudflare Queues is at-least-once, so this is a routine event rather than
  // a disaster scenario. Everything about the second pass has to be a no-op
  // except the fetch itself: one crawl item (the upsert, backed by
  // crawlitem_crawlset_foodbank_uniq), one set of articles (INSERT OR IGNORE
  // against article_url_uniq), ONE decrement (finishCrawlItem's `AND finish IS
  // NULL` returning false), and no second purge.
  //
  // The double-decrement is the one that would do real damage: with two
  // consumers finishing the same message twice, crawlset.remaining reaches 0
  // early, `finish` is stamped while food banks are still being crawled, and
  // /admin/crawlsets/ reports a completed run that is still running.
  it("is idempotent: one crawl item, one set of articles, one decrement, one purge", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);

    await run();
    const afterFirst = { articles: articles(), items: crawlItems(), set: crawlSet() };

    // The redelivery lands a minute later, so a second last_crawl stamp would
    // be visible as a different value rather than hidden by the frozen clock.
    vi.setSystemTime(new Date("2026-09-06T20:23:41.037Z"));
    const second = await run();

    expect(articles()).toEqual(afterFirst.articles);
    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]).toEqual(afterFirst.items[0]); // same id, same start, same finish
    expect(crawlSet()).toEqual(afterFirst.set); // remaining still 1, not 0
    expect(purgeSend).toHaveBeenCalledTimes(1);
    expect(second.messages[0]!.ack).toHaveBeenCalledTimes(1);
    // last_crawl DOES advance -- the stamp is unconditional (crawlers.py:58),
    // so a redelivery moves it. Harmless, and pinned so it is not mistaken for
    // a second crawl having found something.
    expect(lastCrawlOf(SALISBURY)).toBe("2026-09-06 20:23:41.037000");
  });

  // The redelivery that matters most: one that lands after a failure BEFORE the
  // crawl item was closed. The upsert must reopen the SAME row -- a plain
  // INSERT would violate crawlitem_crawlset_foodbank_uniq (or, without the
  // index, leave an orphan row whose finish is never stamped, indistinguishable
  // from a stalled crawl) -- and the countdown must move exactly once.
  it("reopens the same crawl item and counts down once after a mid-crawl failure", async () => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);
    failIf = (sql) => (/UPDATE crawlitem SET finish/i.test(sql) ? new Error("D1_ERROR: Network connection lost") : null);

    const first = await run();
    expect(first.messages[0]!.retry).toHaveBeenCalledTimes(1);
    const openItemId = crawlItems()[0]!.id;

    failIf = null;
    const second = await run();

    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]).toMatchObject({ id: openItemId, start: DJANGO_NOW, finish: DJANGO_NOW });
    expect(crawlSet()).toMatchObject({ remaining: 1 });
    expect(second.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });

  // THE UPSERT IS SCOPED TO THIS RUN, not to the food bank. The conflict
  // target is crawlitem_crawlset_foodbank_uniq(crawl_set_id, foodbank_id)
  // (0008_needcheck.sql), so the crawl item Salisbury got two hours ago in the
  // PREVIOUS run must not be reopened and re-stamped by this one -- that row is
  // the history /admin/crawlsets/ renders, and rewriting it would make every
  // past run look like it finished at the current time. MUTANT
  // crawlitem-crawlset-hardcoded-6 (`crawlSetId: 6` in the insertCrawlItem call
  // instead of `msg.crawlSetId`) is exactly that: it conflicts onto the seeded
  // row, re-stamps a finished item from a previous run, and leaves this run
  // with no item of its own. Every other test in this file seeds a single crawl
  // set, so none of them can see it.
  //
  // The neighbouring crawl set is seeded by hand rather than through
  // seedCrawlSet(): crawlset_runid_uniq is a UNIQUE index on run_id, so two
  // fixtures sharing the helper's hard-coded run_id cannot both exist.
  it("opens a new crawl item for this run rather than reopening the previous run's", async () => {
    db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, finish, expected, remaining) VALUES (6, 'article', 'articles-2026-09-06-18', ?, ?, 2, 1)").run(
      "2026-09-06 18:20:00.000000",
      null,
    );
    db.prepare(
      "INSERT INTO crawlitem (id, crawl_set_id, crawl_type, start, finish, foodbank_id, url) VALUES (500, 6, 'article', ?, ?, ?, ?)",
    ).run("2026-09-06 18:20:01.000000", "2026-09-06 18:21:04.552000", SALISBURY, SALISBURY_FEED);
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);

    await run();

    expect(crawlItems()).toEqual([
      // The previous run's item, byte for byte as it was seeded.
      {
        id: 500,
        crawl_set_id: 6,
        crawl_type: "article",
        start: "2026-09-06 18:20:01.000000",
        finish: "2026-09-06 18:21:04.552000",
        foodbank_id: SALISBURY,
        url: SALISBURY_FEED,
        need_id: null,
      },
      // ...and a brand new one for this run.
      {
        id: 501,
        crawl_set_id: CRAWL_SET,
        crawl_type: "article",
        start: DJANGO_NOW,
        finish: DJANGO_NOW,
        foodbank_id: SALISBURY,
        url: SALISBURY_FEED,
        need_id: null,
      },
    ]);
    // Only this run's countdown moved. The older run is still showing 1
    // outstanding food bank, which is its own business.
    expect(crawlSet()).toMatchObject({ remaining: 1 });
    expect(crawlSet(6)).toMatchObject({ remaining: 1, finish: null });
  });

  // The last message of a run stamps the crawl set's finish. Django's own
  // article crawl does stamp one -- getarticles.py:39-40 sets
  // crawl_set.finish after the loop -- but only because it is a single
  // synchronous management command; there is no such "after the loop" in a
  // queue consumer, so the countdown reaching zero is what stands in for it
  // (the same mechanism, and the same reason, as needcheck's, where Django
  // stamps nothing at all and every 'need' CrawlSet in production has finish
  // IS NULL). This is the assertion that /admin/crawlsets/ shows a completed
  // article run at all.
  it("stamps the crawl set's finish when the last message of the run counts down to zero", async () => {
    db.prepare("UPDATE crawlset SET expected = 1, remaining = 1 WHERE id = ?").run(CRAWL_SET);
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);

    await run();

    expect(crawlSet()).toEqual({ id: CRAWL_SET, expected: 1, remaining: 0, finish: DJANGO_NOW });
  });

  // ...and a redelivery after that must not push it negative or re-stamp the
  // finish. decrementCrawlSetRemaining's `AND remaining > 0` is the second
  // guard behind finishCrawlItem's, and this is the test that keeps both.
  it("does not drive the countdown below zero on a redelivery after the run finished", async () => {
    db.prepare("UPDATE crawlset SET expected = 1, remaining = 1 WHERE id = ?").run(CRAWL_SET);
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);

    await run();
    vi.setSystemTime(new Date("2026-09-06T20:24:41.037Z"));
    await run();

    expect(crawlSet()).toEqual({ id: CRAWL_SET, expected: 1, remaining: 0, finish: DJANGO_NOW });
  });

  // A message whose crawl set has been pruned (or that was never created --
  // recordEnqueueFailure's territory) still has to complete: the crawl item is
  // written and closed, the articles are stored, and the missing countdown is
  // simply not counted. It acks, because there is nothing a retry could fix.
  it("completes a message whose crawl set no longer exists, without erroring", async () => {
    db.prepare("DELETE FROM crawlset WHERE id = ?").run(CRAWL_SET);
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("One", "https://salisbury.example/1/")) }]);

    const fake = await run();

    expect(articles()).toHaveLength(1);
    expect(crawlItems()[0]).toMatchObject({ crawl_set_id: CRAWL_SET, finish: DJANGO_NOW });
    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([]);
  });
});

// ===========================================================================
// THE BATCH
// ===========================================================================

describe("the batch", () => {
  const DUNDEE_MESSAGE: ArticlesMessage = { crawlSetId: CRAWL_SET, foodbankId: DUNDEE, slug: "dundee" };

  beforeEach(() => {
    feedReplies.set(SALISBURY_FEED, [{ status: 200, body: rss(item("Salisbury one", "https://salisbury.example/1/")) }]);
    feedReplies.set(DUNDEE_FEED, [{ status: 200, body: rss(item("Dundee one", "https://dundee.example/1/")) }]);
  });

  // wrangler.jsonc sets max_batch_size 5 for this queue, so a batch is
  // routinely five different food banks. Each must get its own crawl item, its
  // own articles and its own ack.
  it("processes every message in the batch and acks each one separately", async () => {
    const fake = await run(MESSAGE, DUNDEE_MESSAGE);

    expect(articles().map((row) => [row.foodbank_id, row.url])).toEqual([
      [SALISBURY, "https://salisbury.example/1/"],
      [DUNDEE, "https://dundee.example/1/"],
    ]);
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([SALISBURY, DUNDEE]);
    expect(crawlSet()).toMatchObject({ remaining: 0, finish: DJANGO_NOW });
    for (const message of fake.messages) expect(message.ack).toHaveBeenCalledTimes(1);
  });

  // ONE BAD MESSAGE MUST NOT COST THE OTHER FOUR. The try/catch is inside the
  // loop; hoisting it outside (a plausible tidy-up) would abandon the rest of
  // the batch on the first dead food bank, and since Cloudflare redelivers the
  // whole batch, the four healthy ones would be re-crawled every time until the
  // dead one exhausted its retries.
  it("keeps going after a message that fails, settling each one on its own", async () => {
    db.prepare("DELETE FROM foodbank WHERE id = ?").run(SALISBURY);

    const fake = await run(MESSAGE, DUNDEE_MESSAGE);

    expect(fake.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(fake.messages[0]!.ack).not.toHaveBeenCalled();
    expect(fake.messages[1]!.ack).toHaveBeenCalledTimes(1);
    expect(fake.messages[1]!.retry).not.toHaveBeenCalled();
    // Dundee's work is fully done despite Salisbury's failure.
    expect(articles().map((row) => row.foodbank_id)).toEqual([DUNDEE]);
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([DUNDEE]);
    expect(crawlSet()).toMatchObject({ remaining: 1 });
  });

  // Sequential, not Promise.all. The fetch stub yields to the event loop, so a
  // parallel implementation would interleave visibly here -- fetch, fetch, then
  // the two purges -- rather than finishing one food bank before starting the
  // next. It matters because max_concurrency (15) is the knob that bounds how
  // hard this Worker leans on food banks' hosting; a batch that fanned out
  // internally would multiply it by max_batch_size without anything in the
  // config saying so.
  it("processes a batch one message at a time", async () => {
    await run(MESSAGE, DUNDEE_MESSAGE);

    expect(events).toEqual([
      `fetch ${SALISBURY_FEED}`,
      "purge fb-salisbury,fb-all",
      "ack salisbury",
      `fetch ${DUNDEE_FEED}`,
      "purge fb-dundee,fb-all",
      "ack dundee",
    ]);
  });

  // ackAll()/retryAll() would settle messages this handler never looked at. A
  // retryAll() in the catch is the specific mutant: it would re-deliver the
  // food banks that had already succeeded, re-crawling and re-purging them
  // every time one dead food bank in the batch failed.
  it("never settles the whole batch at once", async () => {
    db.prepare("DELETE FROM foodbank WHERE id = ?").run(SALISBURY);

    const fake = await run(MESSAGE, DUNDEE_MESSAGE);

    expect(fake.ackAll).not.toHaveBeenCalled();
    expect(fake.retryAll).not.toHaveBeenCalled();
  });

  // An empty batch is not a thing Cloudflare delivers, but it is the one input
  // for which "did nothing" is the whole contract, so it is asserted as an
  // ABSENCE OF SIDE EFFECTS rather than as a property of the fixture. The
  // previous version of this test asserted `fake.messages` was empty -- which
  // is true of batchOf() before the handler is called at all, and would have
  // passed against an empty function body just as happily as against the real
  // one. Everything below is something the handler could have done and did not.
  it("does nothing at all for an empty batch", async () => {
    // run() substitutes the default message for an empty list, so build the
    // empty batch directly rather than through it.
    const fake = batchOf();

    await expect(handleArticlesQueue(fake.batch, buildEnv())).resolves.toBeUndefined();

    expect(sessionModes).toEqual([]); // not even a D1 session was opened
    expect(fetchCalls).toEqual([]);
    expect(purgeSend).not.toHaveBeenCalled();
    expect(articles()).toEqual([]);
    expect(crawlItems()).toEqual([]);
    expect(crawlSet()).toMatchObject({ remaining: 2, finish: null });
    expect(lastCrawlOf(SALISBURY)).toBe("2026-09-06 18:21:04.552000"); // the seeded value, untouched
    expect(fake.ackAll).not.toHaveBeenCalled();
    expect(fake.retryAll).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  // A MALFORMED MESSAGE TAKES THE WHOLE BATCH DOWN. SUSPECT, pinned as-is.
  //
  // The catch block interpolates `message.body.foodbankId` into its log line,
  // so a body that is null throws a SECOND time inside the catch -- this time
  // with nothing to catch it. handleArticlesQueue rejects, the messages after
  // it in the batch are never processed, and the poisoned message is neither
  // acked nor retried explicitly: Cloudflare redelivers the whole batch, which
  // hits the same body and throws again, until the batch's retries are
  // exhausted and every message in it -- including the healthy ones -- lands in
  // articles-dlq.
  //
  // Nothing produces a null body today (scheduled/index.ts:198 and the admin's
  // Force Article Crawl both send the three-field object), so this is a
  // robustness gap rather than a live incident. Reported in suspectedBugs.
  it("rejects, and abandons the rest of the batch, when a message body is null", async () => {
    const fake = batchOf(null, DUNDEE_MESSAGE);

    await expect(handleArticlesQueue(fake.batch, buildEnv())).rejects.toThrow(TypeError);

    expect(fake.messages[0]!.ack).not.toHaveBeenCalled();
    expect(fake.messages[0]!.retry).not.toHaveBeenCalled();
    // The healthy message behind it was never even looked at.
    expect(fake.messages[1]!.ack).not.toHaveBeenCalled();
    expect(fetchCalls).toEqual([]);
    expect(articles()).toEqual([]);
  });

  // The other malformed shape, and the one that behaves properly: an object
  // missing its fields. `foodbankId` is undefined, the engine refuses to bind
  // it, and the throw is caught by the loop's own catch -- which can build its
  // log line, because `undefined` interpolates fine. So the message retries and
  // the rest of the batch continues.
  //
  // node:sqlite's refusal is "Provided value cannot be bound to SQLite
  // parameter 1." (measured here). D1 refuses an undefined bind too; the exact
  // wording there is NOT VERIFIED from this suite.
  it("retries a message whose body is missing its fields, and carries on", async () => {
    const fake = batchOf({ crawlSetId: CRAWL_SET }, DUNDEE_MESSAGE);

    await handleArticlesQueue(fake.batch, buildEnv());

    expect(fake.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(fake.messages[1]!.ack).toHaveBeenCalledTimes(1);
    expect(articles().map((row) => row.foodbank_id)).toEqual([DUNDEE]);
    expect(logs[0]).toContain("articles: message failed for foodbank undefined (undefined)");
  });

  // A message naming a food bank id that has never existed is the same path as
  // a deleted one -- worth its own line because it is what a hand-crafted or
  // replayed message looks like, and because "no longer exists" is the log an
  // operator will search for.
  it("retries a message for a food bank id that has never existed", async () => {
    const fake = batchOf({ crawlSetId: CRAWL_SET, foodbankId: 999999, slug: "not-a-food-bank" });

    await handleArticlesQueue(fake.batch, buildEnv());

    expect(fake.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(crawlItems()).toEqual([]);
    expect(logs[0]).toContain("articles: foodbank 999999 (not-a-food-bank) no longer exists");
  });
});
