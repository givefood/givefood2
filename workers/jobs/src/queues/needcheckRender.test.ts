import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import type { Env } from "../../worker-configuration";
import { handleNeedcheckRenderQueue, PermanentOpenRouterFailure, type NeedcheckRenderMessage } from "./needcheckRender";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning, as
// packages/db/src/schema.testkit.ts:35, queues/charity.test.ts:12 and
// adminJobs/foodbankCheck.test.ts.
import { DatabaseSync } from "node:sqlite";

// queues/needcheckRender.ts -- the needcheck RENDER_Q consumer, which its own
// sibling (routes/scheduled/index.ts) calls "the single highest-stakes piece of
// the jobs Worker".
//
// WHY THIS FILE IS WORTH THE LENGTH. This consumer is the only thing that
// decides what appears in the review queue a human reads every morning, and
// every one of its failure modes is invisible from the outside:
//
//   * S1 (render failed) and S6 (empty extraction over an existing published
//     need) are the two branches that must NOT wipe a food bank's shopping
//     list. Both exit by writing a FoodbankDiscrepancy -- if that write goes
//     missing, or goes to the wrong url, a blocked render becomes a silent
//     "this food bank needs nothing" and nobody hears about it.
//   * S5 (an unusable OpenRouter reply is a FAILURE, never an empty list) is
//     the difference between retrying and quietly publishing nothing.
//   * S7 (suppress a repeat of something already sitting unreviewed) is the
//     only thing standing between a redelivered message and a duplicate row in
//     the review queue.
//   * the crawlitem/crawlset bookkeeping is the only signal that a nightly
//     sweep ran at all -- `finish IS NULL` is how a stall is detected
//     (0008_needcheck.sql's own comment) and crawlset.remaining is how a
//     completed run is recognised.
//   * WP 5.4's PermanentOpenRouterFailure exists because an account-wide 402
//     cost production two full days in Aug 2026: ~1,024 messages each burning
//     their own retry budget on the identical failure.
//
// Get any of those wrong and the site keeps rendering perfectly, the cron keeps
// "succeeding", and the review queue is just quiet. Which looks exactly like a
// quiet day. So every test below reads a ROW back -- the crawlitem, the
// crawlset counter, the foodbankchange, the foodbankdiscrepancy, the food
// bank's last_need_check -- or reads the PROMPT that was actually sent, rather
// than asserting the handler resolved.
//
// REAL THINGS, NOT MOCKS:
//   * node:sqlite carrying the WHOLE real migration set (MIGRATIONS_SQL, not
//     schemaFor(...)): this consumer reaches foodbank, crawlitem, crawlset,
//     foodbankchange, foodbankdiscrepancy AND the foodbankchange_full VIEW
//     through nine shared packages/db functions. The full schema is the only
//     fixture that cannot develop the github #51 gap where a shared query
//     starts reading one more object -- and that view is precisely the object
//     that gap was about.
//   * the real insertCrawlItem upsert and the real finishCrawlItem `finish IS
//     NULL` guard, which together ARE the idempotency story for an at-least-
//     once queue. A canned double would be testing the double.
//   * the real buildNeedPrompt, decideNeedChange, cleanFoodbankNeedText,
//     needItemsKey/keysEqual and pyNow.
//   * the real getMarkdown / scrapeFacebook / scrapeBankTheFood / extractNeed,
//     driven through a stubbed `fetch`. These are the modules TESTING.md lists
//     as untested, and running the production combination is the only way to
//     show that e.g. an anti-bot interstitial really does arrive here as the S1
//     discrepancy branch rather than as page text.
//
// MOCKED, and only this:
//   * `fetch` -- Cloudflare's Browser Rendering REST endpoint, OpenRouter,
//     Facebook's embed plugin and bankthefood.org are the only things that
//     leave the machine.
//   * the MessageBatch, a runtime object Cloudflare hands in with no local
//     equivalent. ack/retry per message index is the ONLY externally
//     observable output this module has for a failed message.
//   * `HTMLRewriter`, a workerd primitive with no node equivalent, needed only
//     by scrapeFacebook. See the stand-in's own comment for what it does and
//     does not prove.
//
// NOT EXERCISED ON PURPOSE: scrape.ts's Browser Rendering 401/403 branch. It
// sets a MODULE-SCOPE latch (`restAuthFailed`) that is never cleared, so one
// test tripping it would silently divert every later test in this file onto the
// puppeteer binding path, which has no node equivalent at all. That branch
// belongs to a scrape.ts suite; the fetch stub here never answers 401 or 403
// for the markdown endpoint.
//
// PARITY. givefood/utils/crawlers.py:281-575 (do_foodbank_need_check) and
// :577-590 (do_foodbank_need_check_async) at
// /Users/jasoncartwright/Sites/foodcharity were read directly for every Django
// claim below. Where the port diverges the test asserts the PORT and the
// comment says which way Django went. No Python was executed for this file and
// nothing below claims otherwise; the citations are line references, read.
//
// MUTATION-TESTED TWICE, in a copy of the whole tree in the scratchpad (pnpm's
// workspace symlinks are relative, so a copy resolves @givefood/* into itself
// and never back into src/).
//
// The SECOND pass was an adversarial review of the first: 126 mutants across
// this module, needcheck/scrape.ts, needcheck/openrouter.ts,
// needcheck/decision.ts and packages/db/src/needcheck.ts, each applied to the
// copy and this file re-run. 104 died on the first pass's tests. The 22
// survivors split three ways, and the split is the useful part:
//
//   * TWO were holes nothing in the repo covered, now closed below and named
//     in their tests' comments: cleanFoodbankNeedText() dropped from the EXCESS
//     half of stage 7 (every excess fixture in the first pass happened to be
//     already-clean text), and the WP 5.4 discrepancy's foodbank_id, which was
//     never read back at all -- swapping it for msg.crawlSetId passed.
//   * SIX more were reachable through this consumer but caught by a sibling
//     suite. Closed here anyway, because this file's premise is that the real
//     modules run end to end: an unpublished-window fixture with no published
//     row in it to exclude; a facebook failure fixture whose body was empty, so
//     scrapeFacebook's `status !== 200` guard was never exercised; a REST
//     `{success:false}` envelope that carries a `result` (a 200 that is still a
//     render failure); a published need differing only in its EXCESS half; the
//     two-attempt loop's second call on a schema-less 200; and scrapeTypeFor's
//     facebook-before-bankthefood precedence.
//   * TWELVE were parameters of a request this consumer only forwards
//     (temperature/seed/model/require_parameters/response_format, the
//     rejectRequestPattern and 45s goto timeout, data: URI stripping, the
//     bankthefood EXPIRED handshake retry). Verified by running them that
//     openrouter.test.ts, scrape.test.ts and decision.test.ts each fail on
//     their own mutant, so they are covered where they belong and are NOT
//     re-asserted here.
//
// Two were equivalent mutants -- a `break` added to decision.ts's S7 loop,
// which only ever sets a flag, and re-numbering
// updateFoodbankLastNeedCheck's two bind parameters consistently.
//
// The first pass's own record follows. Twenty-nine mutants across this module,
// needcheck/scrape.ts, needcheck/openrouter.ts, needcheck/decision.ts and
// packages/db/src/needcheck.ts; all twenty-nine failed the file, none survived.
// The kills worth naming, because each is a test's reason to exist: the
// crawlitem's url swapped to the home page; the S1 early return deleted (which
// sends an unrendered page to the model); the S1 discrepancy pointed at the
// shopping list url; `finish(null)` dropped from the permanent-failure branch
// (the regression that branch's own comment records having had); that branch
// retrying instead of acking; the 60s backoff removed; NONPERTINENT_WINDOW
// widened to 20; the placeholder exclusion removed from priming, and separately
// the decision switched from lastPublished to primingNeed; the S6 discrepancy
// removed, and the S6 branch disabled entirely; a need filed for a nonpertinent
// repeat; the `if (!closed) return` guard removed; the facebook branch given
// web's early return; the batch run through Promise.all; last_need_check
// stamped in ISO; the missing-food-bank throw turned into a silent ack; the
// bankthefood scrape-type test; the challenge-marker check disabled; an
// unusable model reply read as an empty list; 402 reclassified as retryable;
// decision.ts's S6 condition; the crawlitem upsert reduced to a plain INSERT;
// finishCrawlItem's `finish IS NULL` guard; new needs written published; and
// `nonpertinent` left NULL.

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
 * The one SQL pattern that should blow up on the next statement matching it,
 * standing in for a D1 outage mid-message. Mutable between deliveries so a
 * TRANSIENT failure -- fails once, succeeds on the redelivery Cloudflare Queues
 * is guaranteed to send -- can be modelled, which is the only way to reach the
 * `closed === false` branch this module's idempotency rests on.
 */
let failOn: RegExp | null = null;

/** Every bookmark mode `withSession` was asked for, in call order. */
let sessionModes: string[] = [];

/**
 * The D1 Sessions API surface packages/db uses, over the real engine. It
 * carries SQL to node:sqlite and does nothing else -- a session answering
 * canned rows would be a second implementation of the queries under test, and
 * the crawlitem upsert, the `WHERE finish IS NULL` guard, the
 * `UPDATE ... RETURNING` decrement and the foodbankchange_full view are exactly
 * what has to be real here.
 *
 * `first()` answers null and never undefined, matching D1; `run()` reports
 * `meta.changes` (finishCrawlItem's entire return value) and `meta.last_row_id`
 * (insertFoodbankChange's).
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
 * can post things the type says are impossible -- the cron that produces these
 * lives in another module and a queue producer is not typechecked against its
 * consumer at runtime.
 */
function batchOf(bodies: unknown[]): { batch: MessageBatch<NeedcheckRenderMessage> } & AckLog {
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
  return { batch: { queue: "needcheck-render", messages } as unknown as MessageBatch<NeedcheckRenderMessage>, acks, retries };
}

// ---------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------

type Reply = { status: number; body: string } | Error;

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

let fetchCalls: FetchCall[];
/**
 * Scripted replies per endpoint, consumed in order. An endpoint called more
 * times than it was scripted for records itself here AND throws -- every one of
 * the four callers swallows a thrown fetch (that is how they model an
 * unreachable site), so without the record an over-eager retry loop would look
 * like a clean "site is down" result. Asserted empty after every test.
 */
let unscripted: string[];
let markdownReplies: Reply[];
let openRouterReplies: Reply[];
let facebookReplies: Reply[];
let bankTheFoodReplies: Reply[];

function nextReply(name: string, queue: Reply[]): Reply {
  const reply = queue.shift();
  if (!reply) {
    unscripted.push(name);
    throw new Error(`unscripted ${name} call`);
  }
  return reply;
}

/** `{success:true, result}` is the only shape getMarkdownViaRest treats as markdown. */
function markdownOk(markdown: string): Reply {
  return { status: 200, body: JSON.stringify({ success: true, result: markdown }) };
}

/** The OpenRouter chat-completions envelope: the extraction is a JSON STRING inside `content`. */
function openRouterOk(needed: string[], excess: string[]): Reply {
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ needed, excess }) } }] }) };
}

function fetchCallsTo(prefix: string): FetchCall[] {
  return fetchCalls.filter((call) => call.url.startsWith(prefix));
}

const MARKDOWN_URL = "https://api.cloudflare.com/client/v4/accounts/";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const FACEBOOK_URL = "https://www.facebook.com/v16.0/plugins/page.php";
const BTF_HELLO_URL = "https://api.bankthefood.org/api/auth/hello/";
const BTF_WIDGET_URL = "https://api.bankthefood.org/api/foodbank/GetWidgetFoodbank/";

/** The prompt string that actually reached the model on the nth OpenRouter call. */
function promptSent(index = 0): string {
  const call = fetchCallsTo(OPENROUTER_URL)[index];
  if (!call) throw new Error(`no OpenRouter call at index ${index}`);
  return (JSON.parse(call.body!) as { messages: { content: string }[] }).messages[0]!.content;
}

/**
 * A stand-in for workerd's HTMLRewriter, needed ONLY by scrapeFacebook.
 *
 * WHAT IT PROVES. That scrapeFacebook registers a text handler on `body` and an
 * element handler on the same decompose set Django's htmlbodytext() uses, and
 * that its text handler ACCUMULATES (`text += chunk.text`) rather than assigns
 * -- the last is why this double deliberately splits every text run into two
 * chunks. With one chunk per run, a `text = chunk.text` mutant survives.
 *
 * WHAT IT DOES NOT PROVE. It finds <body> and the stripped tags with regexes,
 * so it models neither malformed markup, implied tags, real chunk boundaries,
 * nor workerd's dispatch semantics for a REMOVED subtree -- scrape.ts:55-68
 * records a `*` handler seeing text inside a removed subtree live, and no
 * double can settle that. The Facebook fixture below therefore contains no
 * <script>/<style>, so its expected text is the same under either model.
 */
interface FakeElementHandler {
  element(el: { remove(): void }): void;
}
interface FakeTextHandler {
  text(chunk: { text: string }): void;
}

const BODY_INNER = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;
const TAG = /<[^>]*>/g;

let rewriterSelectors: string[];

class FakeHTMLRewriter {
  private removeSelectors: string[] = [];
  private textSelectors: { selector: string; handler: FakeTextHandler }[] = [];

  on(selector: string, handler: FakeElementHandler | FakeTextHandler): this {
    rewriterSelectors.push(selector);
    if ("element" in handler) {
      this.removeSelectors.push(selector);
      // Fired once with a no-op element, so a handler doing anything other than
      // remove() is still exercised rather than skipped.
      handler.element({ remove: () => {} });
    } else {
      this.textSelectors.push({ selector, handler });
    }
    return this;
  }

  transform(res: Response): Response {
    const textSelectors = this.textSelectors;
    // Derived from the selectors the handler actually registered, never
    // hardcoded: that is what lets the extraction act as an oracle for "it asked
    // for the right tag set" rather than agreeing with it by construction.
    const tags = this.removeSelectors
      .join(",")
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => /^[a-z]+$/i.test(tag));
    const stripper = tags.length > 0 ? new RegExp(`<(${tags.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi") : null;
    const out = res.text().then((html) => {
      const withoutStripped = stripper ? html.replace(stripper, "") : html;
      const body = BODY_INNER.exec(withoutStripped);
      const inner = body ? body[1]! : "";
      for (const { selector, handler } of textSelectors) {
        if (selector !== "body") continue;
        for (const run of inner.split(TAG)) {
          if (run === "") continue;
          const half = Math.ceil(run.length / 2);
          handler.text({ text: run.slice(0, half) });
          if (run.slice(half) !== "") handler.text({ text: run.slice(half) });
        }
      }
      return withoutStripped;
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(await out));
        controller.close();
      },
    });
    return new Response(stream, { status: res.status, headers: res.headers });
  }
}

let env: Env;
let errors: string[][];
let warns: string[];

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write: a SPACE separator, six fractional
// digits, never a "T" and never a "Z". crawlitem.start/finish,
// foodbankchange.created and foodbank.last_need_check are all TEXT and SQLite
// compares TEXT bytewise, so an ISO value sorts after every same-day Django one
// -- see pyDatetime.ts's header for the two production incidents that came of
// exactly that. getLastPublishedNeed's `ORDER BY created DESC` is one of the
// queries that ordering decides.
const DJANGO_NOW = "2026-09-05 19:28:08.853000";
const NOW = new Date("2026-09-05T19:28:08.853Z");

const SALISBURY = 22;
const DUNDEE = 23;
const CRAWL_SET = 7;

const SITE = "https://salisbury.example/";
const SHOPPING_LIST = "https://salisbury.example/shopping-list/";

interface FoodbankSeed {
  id?: number;
  slug?: string;
  name?: string;
  url?: string;
  shopping_list_url?: string;
  facebook_page?: string | null;
}

function seedFoodbank(seed: FoodbankSeed = {}): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       facebook_page, charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs, created, modified
     ) VALUES (?, ?, ?, ?, '1 Bemerton Heath', 'SP2 9DY', 'England', '51.0688,-1.7945', ?, 0, 'info@example.test', ?, ?, 0, 0, 0, 14, ?, ?)`,
  ).run(
    seed.id ?? SALISBURY,
    `uuid-${seed.slug ?? "salisbury"}`,
    // foodbank.name carries a UNIQUE index, so a second seed in one test has to
    // differ -- derived from the slug rather than passed at every call site.
    seed.name ?? `${seed.slug ?? "salisbury"} Foodbank`,
    seed.slug ?? "salisbury",
    seed.facebook_page === undefined ? null : seed.facebook_page,
    seed.url ?? SITE,
    seed.shopping_list_url ?? SHOPPING_LIST,
    DJANGO_NOW,
    DJANGO_NOW,
  );
}

/** The CrawlSet the cron opened (scheduled/index.ts): one per nightly sweep. */
function seedCrawlSet(remaining: number, id = CRAWL_SET): void {
  db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, expected, remaining) VALUES (?, 'need', ?, ?, ?, ?)").run(id, `need-${id}`, DJANGO_NOW, remaining, remaining);
}

interface NeedSeed {
  id: number;
  foodbankId?: number;
  changeText: string;
  excessChangeText?: string | null;
  published?: 0 | 1;
  created?: string;
}

function seedNeed(seed: NeedSeed): void {
  db.prepare(
    `INSERT INTO foodbankchange
       (id, need_id, foodbank_id, uri, change_text, change_text_original, excess_change_text, excess_change_text_original,
        published, nonpertinent, is_categorised, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'ai', ?, ?)`,
  ).run(
    seed.id,
    String(seed.id).padStart(32, "0"),
    seed.foodbankId ?? SALISBURY,
    SHOPPING_LIST,
    seed.changeText,
    seed.changeText,
    seed.excessChangeText === undefined ? "" : seed.excessChangeText,
    seed.excessChangeText === undefined ? "" : seed.excessChangeText,
    seed.published ?? 0,
    seed.created ?? "2026-09-01 09:00:00.000000",
    seed.created ?? "2026-09-01 09:00:00.000000",
  );
}

function message(overrides: Partial<NeedcheckRenderMessage> = {}): NeedcheckRenderMessage {
  return {
    crawlSetId: CRAWL_SET,
    foodbankId: SALISBURY,
    slug: "salisbury",
    name: "Salisbury Foodbank",
    url: SITE,
    shoppingListUrl: SHOPPING_LIST,
    facebookPage: null,
    ...overrides,
  };
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

interface ChangeRow {
  id: number;
  need_id: string;
  foodbank_id: number;
  uri: string;
  change_text: string;
  change_text_original: string;
  excess_change_text: string;
  excess_change_text_original: string;
  published: number;
  nonpertinent: number | null;
  is_categorised: number | null;
  input_method: string;
  created: string;
  modified: string;
}

/** Only rows this run created: the seeds all use ids below 1000. */
function newChanges(): ChangeRow[] {
  return db.prepare("SELECT * FROM foodbankchange WHERE input_method = 'ai' AND created = ? ORDER BY id").all(DJANGO_NOW) as unknown as ChangeRow[];
}

interface DiscrepancyRow {
  id: number;
  foodbank_id: number | null;
  need_id: number | null;
  url: string | null;
  discrepancy_type: string;
  discrepancy_text: string;
  status: string;
  created: string;
  modified: string;
}

function discrepancies(): DiscrepancyRow[] {
  return db.prepare("SELECT * FROM foodbankdiscrepancy ORDER BY id").all() as unknown as DiscrepancyRow[];
}

function lastNeedCheck(id = SALISBURY): string | null {
  return (db.prepare("SELECT last_need_check FROM foodbank WHERE id = ?").get(id) as { last_need_check: string | null }).last_need_check;
}

/** The whole production shape of one successful web message, in one line. */
function scriptWebSuccess(markdown: string, needed: string[], excess: string[] = []): void {
  markdownReplies = [markdownOk(markdown)];
  openRouterReplies = [openRouterOk(needed, excess)];
}

async function run(bodies: unknown[] = [message()]): Promise<AckLog> {
  const { batch, acks, retries } = batchOf(bodies);
  await handleNeedcheckRenderQueue(batch, env);
  return { acks, retries };
}

beforeEach(() => {
  // Date only, not setTimeout: getMarkdown/extractNeed/scrapeFacebook each arm a
  // real AbortSignal.timeout and faking the clock underneath those buys nothing.
  // Freezing Date is what makes the exact start/finish/created assertions below
  // possible at all.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(MIGRATIONS_SQL);

  failOn = null;
  sessionModes = [];
  fetchCalls = [];
  unscripted = [];
  markdownReplies = [];
  openRouterReplies = [];
  facebookReplies = [];
  bankTheFoodReplies = [];
  rewriterSelectors = [];
  errors = [];
  warns = [];

  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String)));
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warns.push(args.map(String).join(" ")));
  vi.stubGlobal("HTMLRewriter", FakeHTMLRewriter);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}): Promise<Response> => {
    fetchCalls.push({
      url,
      method: init.method,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | undefined,
    });
    let reply: Reply;
    if (url.startsWith(MARKDOWN_URL)) reply = nextReply("markdown", markdownReplies);
    else if (url === OPENROUTER_URL) reply = nextReply("openrouter", openRouterReplies);
    else if (url.startsWith(FACEBOOK_URL)) reply = nextReply("facebook", facebookReplies);
    else if (url === BTF_HELLO_URL || url === BTF_WIDGET_URL) reply = nextReply("bankthefood", bankTheFoodReplies);
    else throw new Error(`unexpected host: ${url}`);
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
    // Both present, so getMarkdown takes the REST path -- the one scrape.ts was
    // deliberately reverted onto on 2026-09-05 and the only one production uses.
    CF_ACCOUNT_ID: "211195b9bf606f797a6d2dbc0bf41791",
    CF_API_KEY: "test-cf-token",
    OPENROUTER_KEY: "test-openrouter-key",
  } as unknown as Env;
});

afterEach(() => {
  // A swallowed extra fetch is invisible in every other assertion (all four
  // callers treat a throwing fetch as "site down"), so it is checked here rather
  // than per test.
  expect(unscripted).toEqual([]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

// ===========================================================================
// THE HAPPY PATH -- a first need reaching the review queue
// ===========================================================================
describe("a web food bank with a new need", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
    scriptWebSuccess("# Shopping list\n- Tinned Tomatoes\n- UHT Milk", ["Tinned Tomatoes", "UHT Milk"], ["Baked Beans"]);
  });

  // crawlers.py:540-549's FoodbankChange(...). Every column is read back
  // because each one is load-bearing somewhere else: `published = 0` is what
  // puts the row in the review queue rather than on the site, `nonpertinent`
  // and `is_categorised` must be 0 and NOT NULL (PLAN.md §8.5.3's warning that
  // `nonpertinent = 0` in SQL excludes NULL, which is how 18,943 legacy rows
  // fell out of the admin's own filters), and `uri` is the SHOPPING LIST url,
  // not the food bank's home page.
  it("writes one foodbankchange with the cleaned text and the review-queue flags", async () => {
    const { acks, retries } = await run();

    const changes = newChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.foodbank_id).toBe(SALISBURY);
    expect(changes[0]!.change_text).toBe("Tinned Tomatoes\nUHT Milk");
    expect(changes[0]!.excess_change_text).toBe("Baked Beans");
    // Django writes change_text_original alongside change_text on creation, and
    // the admin's "reset to original" depends on the pair being identical here.
    expect(changes[0]!.change_text_original).toBe("Tinned Tomatoes\nUHT Milk");
    expect(changes[0]!.excess_change_text_original).toBe("Baked Beans");
    expect(changes[0]!.uri).toBe(SHOPPING_LIST);
    expect(changes[0]!.input_method).toBe("ai");
    expect(changes[0]!.published).toBe(0);
    expect(changes[0]!.nonpertinent).toBe(0);
    expect(changes[0]!.is_categorised).toBe(0);
    expect(changes[0]!.created).toBe(DJANGO_NOW);
    expect(changes[0]!.modified).toBe(DJANGO_NOW);
    // needs.py:287's model default -- 32 hex characters, dashless, which is the
    // shape getNeedByUuid() elsewhere in packages/db already expects.
    expect(changes[0]!.need_id).toMatch(/^[0-9a-f]{32}$/);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  // stage 7 (text.py:91-115). The model is told to return items one per array
  // element; the join and the clean happen here. "Uht" -> "UHT" is the single
  // most visible one on the live site, and the entity decode is what stops
  // "Tins of beans &amp; peas" reaching a rendered page verbatim.
  //
  // BOTH HALVES, and the excess half is the point. crawlers.py:481-482 runs
  // clean_foodbank_need_text() over need_text AND excess_text; the port does
  // the same at needcheckRender.ts:181-182. THE MUTANT THIS KILLS: dropping
  // cleanFoodbankNeedText from the excess line only. It survived a 92-mutant
  // sweep of the first version of this file, because every excess fixture in
  // it ("Baked Beans", "Beans", "Pasta") was already clean text and so read
  // back identically whether or not the clean ran -- and an uncleaned excess
  // is not a cosmetic defect: needItemsKey() strips to lowercase
  // alphanumerics, so "Pasta &amp; Sauce" and "Pasta & Sauce" have DIFFERENT
  // keys ("pastaampsauce" vs "pastasauce"), and the same unchanged page would
  // file a fresh excess "change" every night forever.
  it("joins the extracted arrays with newlines and cleans BOTH halves", async () => {
    openRouterReplies = [openRouterOk(["Uht Milk", "Beans &amp; Peas", "  Rice  "], ["Uht Milk", "Pasta &amp; Sauce", "  Soup  "])];

    await run();

    expect(newChanges()[0]!.change_text).toBe("UHT Milk\nBeans & Peas\nRice");
    expect(newChanges()[0]!.excess_change_text).toBe("UHT Milk\nPasta & Sauce\nSoup");
    // ...and the _original columns carry the CLEANED text too, not the raw
    // model output: Django writes need_text/excess_text into both
    // (crawlers.py:544-547), so the admin's "reset to original" restores the
    // cleaned wording rather than reintroducing "&amp;".
    expect(newChanges()[0]!.change_text_original).toBe("UHT Milk\nBeans & Peas\nRice");
    expect(newChanges()[0]!.excess_change_text_original).toBe("UHT Milk\nPasta & Sauce\nSoup");
  });

  // crawlers.py:285-291 opens the CrawlItem BEFORE any scraping and stamps
  // finish at :559-560. crawl_type "need" is what the crawl dashboards group
  // on; url is the shopping list url Django records at :289.
  it("opens and closes one crawlitem, pointing at the need it produced", async () => {
    await run();

    const items = crawlItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.foodbank_id).toBe(SALISBURY);
    expect(items[0]!.crawl_set_id).toBe(CRAWL_SET);
    expect(items[0]!.crawl_type).toBe("need");
    expect(items[0]!.url).toBe(SHOPPING_LIST);
    expect(items[0]!.start).toBe(DJANGO_NOW);
    expect(items[0]!.finish).toBe(DJANGO_NOW);
    expect(items[0]!.start).not.toContain("T");
    // Django attaches the FoodbankChange to the CrawlItem through a generic
    // content_type/object_id pair (crawlers.py:551-554); the port collapses that
    // to a plain need_id FK. Either way this is the link from "a crawl ran" to
    // "and here is what it found", and it must be the row just inserted.
    expect(items[0]!.need_id).toBe(newChanges()[0]!.id);
  });

  // Stage 11. last_need_check is what the admin's "not checked recently" view
  // reads, and crawlset.remaining is the only signal a sweep finished -- Django
  // has no equivalent of the counter at all (PLAN.md §8.5.2), so nothing
  // upstream would ever notice it being wrong.
  it("stamps last_need_check and decrements the crawlset exactly once", async () => {
    await run();

    expect(lastNeedCheck()).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(2);
    expect(crawlSet().expected).toBe(3);
    expect(crawlSet().finish).toBeNull();
  });

  it("closes the crawlset when it takes remaining to zero", async () => {
    seedCrawlSet(1, 99);

    await run([message({ crawlSetId: 99 })]);

    expect(crawlSet(99).remaining).toBe(0);
    expect(crawlSet(99).finish).toBe(DJANGO_NOW);
    // The set this message did NOT belong to must be untouched -- a decrement
    // ignoring its crawlSetId passes every test that seeds only one.
    expect(crawlSet(CRAWL_SET).remaining).toBe(3);
  });

  // Read replication is on for this database, so a bare prepare() can land on a
  // stale replica (packages/db/src/types.ts's header). ONE session per MESSAGE:
  // read-your-writes only holds inside a session, and the insert-then-update-
  // then-read sequence for a single food bank all has to be inside one.
  it("opens one first-unconstrained session per message", async () => {
    seedFoodbank({ id: DUNDEE, slug: "dundee", shopping_list_url: "https://dundee.example/list/" });
    markdownReplies.push(markdownOk("- Pasta"));
    openRouterReplies.push(openRouterOk(["Pasta"], []));

    await run([message(), message({ foodbankId: DUNDEE, slug: "dundee" })]);

    expect(sessionModes).toEqual(["first-unconstrained", "first-unconstrained"]);
  });

  it("logs nothing on success -- a quiet consumer is a working consumer", async () => {
    await run();

    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
  });

  // THE INCIDENT THIS WHOLE TIER EXISTS FOR: a Browser Rendering credential
  // that broke silently for a day. Both credentials this consumer spends leave
  // the Worker only here, and neither has any other observable effect -- a
  // handler that sent the wrong account, or no Authorization at all, produces
  // exactly the "quiet day in the review queue" that hid the original.
  it("spends both credentials, at the account the config names", async () => {
    await run();

    const render = fetchCallsTo(MARKDOWN_URL)[0]!;
    expect(render.url).toBe("https://api.cloudflare.com/client/v4/accounts/211195b9bf606f797a6d2dbc0bf41791/browser-rendering/markdown");
    expect(render.method).toBe("POST");
    expect(render.headers["Authorization"]).toBe("Bearer test-cf-token");
    expect(fetchCallsTo(OPENROUTER_URL)[0]!.headers["Authorization"]).toBe("Bearer test-openrouter-key");
  });

  // The cron enqueues open food banks only (getOpenFoodbanksForNeedCheck's
  // `WHERE is_closed = 0`), but the dequeue-time re-read deliberately has no
  // such filter, so a food bank closed DURING the multi-minute drain window is
  // still scraped and can still file a need for a reviewer to look at. Django
  // does the same -- crawlers.py:587 is a plain Foodbank.objects.get with no
  // exclude -- so this is parity, and a "fix" here would be the divergence.
  it("still checks a food bank closed between enqueue and dequeue", async () => {
    db.prepare("UPDATE foodbank SET is_closed = 1 WHERE id = ?").run(SALISBURY);

    const { acks } = await run();

    expect(acks).toEqual([0]);
    expect(newChanges()).toHaveLength(1);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
  });
});

// ===========================================================================
// THE FOOD BANK ROW IS RE-READ, NOT TRUSTED FROM THE MESSAGE
// ===========================================================================
describe("the food bank row", () => {
  // The module's own comment (and crawlers.py:579-590's pattern) says the row is
  // re-read fresh at dequeue time because the cron's snapshot goes stale during
  // the drain window -- realistically multi-minute at max_concurrency 25 over
  // ~1,024 messages. EVERY field of the message body below is wrong on purpose;
  // if any of them were used the assertions change.
  it("comes from D1, so an admin's mid-run edit wins over the message body", async () => {
    seedFoodbank({ url: "https://renamed.example/", shopping_list_url: "https://renamed.example/needs/" });
    seedCrawlSet(1);
    scriptWebSuccess("- Soup", ["Soup"]);

    await run([
      message({
        slug: "stale-slug",
        name: "Stale Name",
        url: "https://stale.example/",
        shoppingListUrl: "https://stale.example/old-list/",
        facebookPage: "stalepage",
      }),
    ]);

    // The page actually rendered is the fresh one...
    expect(JSON.parse(fetchCallsTo(MARKDOWN_URL)[0]!.body!).url).toBe("https://renamed.example/needs/");
    // ...and so are both urls written to rows a human later reads.
    expect(crawlItems()[0]!.url).toBe("https://renamed.example/needs/");
    expect(newChanges()[0]!.uri).toBe("https://renamed.example/needs/");
  });

  // The stalest thing an admin can change is the PLATFORM: a food bank moving
  // from its own site onto a Facebook page changes which scraper runs. Trusting
  // msg.shoppingListUrl would send this one to Browser Rendering.
  it("decides the scrape type from the fresh url, not the enqueued one", async () => {
    seedFoodbank({ shopping_list_url: "https://www.facebook.com/salisburyfoodbank" , facebook_page: "salisburyfoodbank" });
    seedCrawlSet(1);
    facebookReplies = [{ status: 200, body: "<html><body><p>We need Rice</p></body></html>" }];
    openRouterReplies = [openRouterOk(["Rice"], [])];

    await run([message({ shoppingListUrl: SHOPPING_LIST })]);

    expect(fetchCallsTo(MARKDOWN_URL)).toEqual([]);
    expect(fetchCallsTo(FACEBOOK_URL)).toHaveLength(1);
  });

  // A WHERE clause doing nothing passes any test that seeds one row.
  it("is the food bank the message names, not merely some food bank", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", url: "https://dundee.example/", shopping_list_url: "https://dundee.example/list/" });
    seedCrawlSet(2);
    scriptWebSuccess("- Nappies", ["Nappies"]);

    await run([message({ foodbankId: DUNDEE, slug: "dundee" })]);

    expect(JSON.parse(fetchCallsTo(MARKDOWN_URL)[0]!.body!).url).toBe("https://dundee.example/list/");
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([DUNDEE]);
    expect(newChanges()[0]!.foodbank_id).toBe(DUNDEE);
    expect(lastNeedCheck(SALISBURY)).toBeNull();
  });
});

// ===========================================================================
// S1 -- THE RENDER FAILED
// ===========================================================================
describe("when the page cannot be rendered", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
    seedNeed({ id: 1, changeText: "Tinned Tomatoes", published: 1, created: "2026-09-01 09:00:00.000000" });
  });

  // crawlers.py:306-333. THE point of this branch: an unreachable site must
  // never reach the model, because a prompt with an empty page reliably
  // extracts nothing, and nothing then looks like "this food bank needs
  // nothing". The published need is left exactly as it was.
  it("writes a discrepancy against the food bank's own url and never calls the model", async () => {
    markdownReplies = [
      { status: 500, body: "upstream error" },
      { status: 500, body: "upstream error" },
      { status: 500, body: "upstream error" },
    ];

    const { acks, retries } = await run();

    expect(discrepancies()).toHaveLength(1);
    expect(discrepancies()[0]!).toMatchObject({
      foodbank_id: SALISBURY,
      // foodbank.url (the home page), NOT shopping_list_url -- crawlers.py:315
      // does the same, and the admin's discrepancy list links this url.
      url: SITE,
      discrepancy_type: "website",
      discrepancy_text: `Website ${SITE} render failed`,
      status: "New",
      need_id: null,
      created: DJANGO_NOW,
      modified: DJANGO_NOW,
    });
    expect(fetchCallsTo(OPENROUTER_URL)).toEqual([]);
    expect(newChanges()).toEqual([]);
    // The published need is untouched -- the whole reason this branch exists.
    expect(db.prepare("SELECT change_text FROM foodbankchange WHERE id = 1").get()).toEqual({ change_text: "Tinned Tomatoes" });
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  // A render failure is a COMPLETED check, not a failed message: Django stamps
  // last_need_check at crawlers.py:319-320 and closes the CrawlItem at :321-322
  // on this path too. If it retried instead, a food bank whose site is simply
  // down -- the most common outcome in this whole pipeline -- would burn three
  // deliveries a night and dead-letter, and the crawl set would never close.
  it("still closes the crawlitem and decrements the counter", async () => {
    markdownReplies = [
      { status: 500, body: "x" },
      { status: 500, body: "x" },
      { status: 500, body: "x" },
    ];

    await run();

    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlItems()[0]!.need_id).toBeNull();
    expect(lastNeedCheck()).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(2);
  });

  // Cloudflare's REST API answers its OWN failures as HTTP 200 with
  // `success: false` in the envelope, and a failed /markdown call still
  // carries a `result` key. THE MUTANT THIS KILLS: reading `payload.result`
  // without checking `payload.success` -- the envelope's error text then
  // becomes the food bank's shopping list, reaches the model, and whatever it
  // extracts lands in the review queue attributed to a food bank whose site
  // was never even fetched. Nothing else in this file scripts a
  // success=false reply, so the check was free to delete.
  it("treats a 200 carrying success=false as a render failure, not as page text", async () => {
    const failedEnvelope = {
      status: 200,
      body: JSON.stringify({
        success: false,
        errors: [{ code: 7003, message: "Could not route to /markdown" }],
        result: "Could not route to /markdown, perhaps your object identifier is invalid?",
      }),
    };
    markdownReplies = [failedEnvelope, failedEnvelope, failedEnvelope];

    const { acks } = await run();

    expect(fetchCallsTo(OPENROUTER_URL)).toEqual([]);
    expect(discrepancies()[0]!.discrepancy_text).toBe(`Website ${SITE} render failed`);
    expect(newChanges()).toEqual([]);
    expect(acks).toEqual([0]);
    // The warn names the envelope's own errors array, which is the only place
    // a "the token is fine but the account can't reach this endpoint" failure
    // is ever visible -- it is not a 4xx and would otherwise be indistinguishable
    // from an ordinary unreachable site.
    expect(warns).toEqual([`needcheck: no markdown for ${SHOPPING_LIST} after 3 attempts (last: success=false [{"code":7003,"message":"Could not route to /markdown"}])`]);
  });

  // general.py:63-77's challenge markers, end to end. An anti-bot interstitial
  // is a 200 with non-empty markdown, so without the explicit check it reads as
  // the food bank's page and "Just a moment..." becomes its shopping list. This
  // is the mechanism S6 further downstream also exists to catch.
  it("treats an anti-bot interstitial as a render failure, after three attempts", async () => {
    markdownReplies = [
      markdownOk("Just a moment...\nEnable JavaScript and cookies to continue"),
      markdownOk("Just a moment..."),
      markdownOk("Checking your browser before accessing"),
    ];

    const { acks } = await run();

    expect(discrepancies()[0]!.discrepancy_text).toBe(`Website ${SITE} render failed`);
    expect(acks).toEqual([0]);
    // The degrading waitUntil ladder (general.py:82-88) really did degrade: a
    // site that never reaches full network idle gets one relaxed last attempt.
    expect(fetchCallsTo(MARKDOWN_URL).map((call) => JSON.parse(call.body!).gotoOptions.waitUntil)).toEqual(["networkidle0", "networkidle0", "networkidle2"]);
    expect(warns).toEqual([`needcheck: no markdown for ${SHOPPING_LIST} after 3 attempts (last: anti-bot challenge page)`]);
  });
});

// ===========================================================================
// THE FACEBOOK AND BANKTHEFOOD BRANCHES
// ===========================================================================
describe("a facebook food bank", () => {
  beforeEach(() => {
    seedFoodbank({ shopping_list_url: "https://www.facebook.com/salisburyfoodbank", facebook_page: "salisburyfoodbank" });
    seedCrawlSet(1);
  });

  // crawlers.py:334-342: the v16.0 embed URL, then htmlbodytext(). The page
  // text has to reach the PROMPT -- a scraper whose output went nowhere would
  // still ack, still close the crawlitem, and simply extract nothing forever.
  it("scrapes the embed page and puts its text in the prompt", async () => {
    facebookReplies = [{ status: 200, body: "<html><body><p>This week we need Rice and Pasta</p></body></html>" }];
    openRouterReplies = [openRouterOk(["Rice", "Pasta"], [])];

    await run();

    expect(fetchCallsTo(FACEBOOK_URL)[0]!.url).toContain(`href=${encodeURIComponent("https://www.facebook.com/salisburyfoodbank")}`);
    expect(promptSent()).toContain("This week we need Rice and Pasta");
    // The scrape_type reaches the prompt too: prompt.ts's FROM_PAGE_TAIL wraps
    // the page in a different number of blank lines per type, an artefact of the
    // Django template's three separate {% if %} blocks that PLAN.md §8.5.7 says
    // must be preserved byte-for-byte.
    expect(promptSent()).toMatch(/below:\n\n\n\n\n {4}[\s\S]*\n\n\n\n$/);
    expect(newChanges()[0]!.change_text).toBe("Rice\nPasta");
    // The decompose set Django's htmlbodytext() uses, asked for by name.
    expect(rewriterSelectors).toContain("svg, style, script, iframe, canvas");
    expect(rewriterSelectors).toContain("body");
  });

  // A DELIBERATE DIVERGENCE FROM THE WEB BRANCH, and the module says so:
  // crawlers.py:334-376 has no render-failure guard for facebook/bankthefood at
  // all, so a failed scrape falls through to the prompt as an EMPTY page rather
  // than returning early with a discrepancy. Pinned as the port does it.
  //
  // THE MUTANT THIS KILLS: deleting scrapeFacebook's `if (res.status !== 200)
  // return null`. The fixture body below is deliberately a REAL error page
  // rather than an empty one -- Facebook answers its "content isn't available"
  // interstitial as a 404 with a full HTML document, and with the status guard
  // gone that interstitial becomes the food bank's page text, goes to the
  // model as if it were a shopping list, and lands whatever the model makes of
  // it in the review queue. An empty-bodied 404 (which is what this fixture
  // used to be) reads identically with or without the guard.
  it("falls through to the model with an empty page when the embed fails", async () => {
    facebookReplies = [{ status: 404, body: "<html><body><p>This content isn't available right now</p></body></html>" }];
    openRouterReplies = [openRouterOk([], [])];

    const { acks } = await run();

    expect(discrepancies()).toEqual([]);
    expect(fetchCallsTo(OPENROUTER_URL)).toHaveLength(1);
    expect(promptSent()).not.toContain("isn't available");
    expect(promptSent()).toMatch(/below:\n\n\n\n\n {4}\n\n\n\n$/);
    expect(acks).toEqual([0]);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
  });

  // scrapeTypeFor tests facebook.com FIRST and returns, so a url naming both
  // platforms is scraped as facebook. A DIVERGENCE FROM DJANGO, pinned as the
  // port does it: crawlers.py:297-302 is three sequential `if`s with no elif
  // and no early return, so there the LAST match wins and the same url would
  // be scraped as bankthefood. Nothing in production is known to hit this (not
  // verified against the live data), but the branch order is a one-line edit
  // away from flipping, and the two scrapers produce completely different
  // page text for the same food bank -- which is the input-stability problem
  // scrape.ts's own 09-04/09-05 numbers record.
  it("scrapes a url naming both platforms as facebook, where Django would say bankthefood", async () => {
    db.prepare("UPDATE foodbank SET shopping_list_url = ? WHERE id = ?").run("https://www.facebook.com/pg/bankthefood.org/posts/", SALISBURY);
    facebookReplies = [{ status: 200, body: "<html><body><p>We need Rice</p></body></html>" }];
    openRouterReplies = [openRouterOk(["Rice"], [])];

    await run();

    expect(fetchCallsTo(FACEBOOK_URL)).toHaveLength(1);
    expect(fetchCalls.filter((call) => call.url.startsWith("https://api.bankthefood.org/"))).toEqual([]);
    expect(newChanges()[0]!.change_text).toBe("Rice");
  });

  // facebook_page is nullable and independent of shopping_list_url, so the two
  // can disagree. A null page name must not become the string "null" or
  // "undefined" in the embed url -- the scraper is skipped entirely, and the
  // prompt gets an empty page.

  it("does not call facebook at all when the page name is null", async () => {
    db.prepare("UPDATE foodbank SET facebook_page = NULL WHERE id = ?").run(SALISBURY);
    openRouterReplies = [openRouterOk([], [])];

    await run();

    expect(fetchCallsTo(FACEBOOK_URL)).toEqual([]);
    expect(promptSent()).toMatch(/below:\n\n\n\n\n {4}\n\n\n\n$/);
  });
});

describe("a bankthefood food bank", () => {
  beforeEach(() => {
    seedFoodbank({ shopping_list_url: "https://bankthefood.org/foodbank/4021/salisbury" });
    seedCrawlSet(1);
  });

  // crawlers.py:344-376: auth/hello/ for a bearer token, then
  // GetWidgetFoodbank/ keyed on the digits scraped out of the shopping list url.
  // The raw response text is the "page" -- Django does not parse it either.
  it("authenticates, fetches the widget, and feeds the raw body to the prompt", async () => {
    bankTheFoodReplies = [
      { status: 200, body: JSON.stringify({ Status: "OK", Data: { Tokens: { Token: "btf-token" } } }) },
      { status: 200, body: '{"Needs":"Tinned Fish, Rice"}' },
    ];
    openRouterReplies = [openRouterOk(["Tinned Fish", "Rice"], [])];

    await run();

    const calls = fetchCalls.filter((call) => call.url.startsWith("https://api.bankthefood.org/"));
    expect(calls.map((call) => call.url)).toEqual([BTF_HELLO_URL, BTF_WIDGET_URL]);
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer btf-token");
    // The /(\d+)/ key scrape -- "4021", not "salisbury" and not the whole url.
    expect(JSON.parse(calls[1]!.body!).Key1).toBe("4021");
    expect(promptSent()).toContain('{"Needs":"Tinned Fish, Rice"}');
    // ...and bankthefood's own blank-line envelope, distinct from web's.
    expect(promptSent()).toMatch(/below:\n\n\n\n\n\n\n {4}[\s\S]*\n\n$/);
    expect(newChanges()[0]!.change_text).toBe("Tinned Fish\nRice");
  });

  // Same divergence as facebook: no early return, no discrepancy, an empty page
  // goes to the model. Worth pinning separately because the failure is EARLIER
  // here -- no token at all means the widget call never happens.
  it("falls through with an empty page when the token call fails", async () => {
    bankTheFoodReplies = [{ status: 500, body: "nope" }];
    openRouterReplies = [openRouterOk([], [])];

    const { acks } = await run();

    expect(fetchCalls.filter((call) => call.url === BTF_WIDGET_URL)).toEqual([]);
    expect(discrepancies()).toEqual([]);
    expect(promptSent()).toMatch(/below:\n\n\n\n\n\n\n {4}\n\n$/);
    expect(acks).toEqual([0]);
  });
});

// ===========================================================================
// STAGE 4 -- PRIMING THE PROMPT WITH THE LAST PUBLISHED NEED
// ===========================================================================
describe("the prompt's PREVIOUS LIST block", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(1);
  });

  // crawlers.py:404-423. This is the whole reproducibility mechanism: the model
  // is told to reuse the previous wording for items still on the page, so
  // cosmetic re-wording ("Tin" vs "Tinned") does not register as a change in
  // decision.ts's key comparison. Without it the same page reappears in the
  // review queue every single day -- which is exactly what the 09-04/09-05
  // numbers in scrape.ts's header record happening.
  it("carries the last published need's wording, needs and excess", async () => {
    seedNeed({ id: 1, changeText: "Tinned Tomatoes\nUHT Milk", excessChangeText: "Baked Beans", published: 1 });
    scriptWebSuccess("- Tinned Tomatoes\n- UHT Milk", ["Tinned Tomatoes", "UHT Milk"], ["Baked Beans"]);

    await run();

    expect(promptSent()).toContain("PREVIOUS LIST (reference for wording only)");
    expect(promptSent()).toContain("Previously needed:\nTinned Tomatoes\nUHT Milk\n\n");
    expect(promptSent()).toContain("Previously in excess:\nBaked Beans\n\n");
  });

  // crawlers.py:409-411. "Facebook"/"Unknown"/"Nothing" are sentinel rows, not
  // real lists (they are contract elsewhere -- foodbankchange's own migration
  // comment), and priming with one teaches the model to answer "Nothing".
  it.each(["Facebook", "Unknown", "Nothing"])("is omitted when the last published need is the %s placeholder", async (placeholder) => {
    seedNeed({ id: 1, changeText: placeholder, published: 1 });
    scriptWebSuccess("- Soup", ["Soup"]);

    await run();

    // The HEADER, not the string "PREVIOUS LIST": the static preamble mentions
    // that phrase in its own instructions whether or not a previous list is
    // attached, so only the header line distinguishes primed from unprimed.
    expect(promptSent()).not.toContain("PREVIOUS LIST (reference for wording only)");
    expect(promptSent()).not.toContain(placeholder);
    // ...but the placeholder is still the row the CHANGE decision compares
    // against (crawlers.py passes last_published_need, not priming_need, to the
    // comparison at :525-538), so "Soup" is a change against "Nothing" and lands
    // in the queue. Priming and comparison are deliberately different variables.
    expect(newChanges()[0]!.change_text).toBe("Soup");
  });

  // The excess header is conditional in the template (prompt.ts's own branch),
  // and an empty excess must not emit a dangling "Previously in excess:" label
  // for the model to fill in.
  it("omits the excess paragraph when the last published need had none", async () => {
    seedNeed({ id: 1, changeText: "Tinned Tomatoes", excessChangeText: "", published: 1 });
    scriptWebSuccess("- Tinned Tomatoes", ["Tinned Tomatoes"]);

    await run();

    expect(promptSent()).toContain("Previously needed:\nTinned Tomatoes\n\n");
    expect(promptSent()).not.toContain("Previously in excess");
  });

  // `published = 1 ORDER BY created DESC LIMIT 1` -- three ways to get this
  // wrong, all seeded here: an unpublished row that is newer, a published row
  // that is older, and a published row belonging to a different food bank.
  it("is the newest PUBLISHED need for THIS food bank, not merely the newest row", async () => {
    seedFoodbank({ id: DUNDEE, slug: "dundee" });
    seedNeed({ id: 1, changeText: "Old Published", published: 1, created: "2026-08-01 09:00:00.000000" });
    seedNeed({ id: 2, changeText: "New Published", published: 1, created: "2026-09-01 09:00:00.000000" });
    seedNeed({ id: 3, changeText: "Newer But Unpublished", published: 0, created: "2026-09-02 09:00:00.000000" });
    seedNeed({ id: 4, changeText: "Another Foodbank", published: 1, created: "2026-09-03 09:00:00.000000", foodbankId: DUNDEE });
    scriptWebSuccess("- Soup", ["Soup"]);

    await run();

    expect(promptSent()).toContain("Previously needed:\nNew Published\n\n");
    expect(promptSent()).not.toContain("Old Published");
    expect(promptSent()).not.toContain("Newer But Unpublished");
    expect(promptSent()).not.toContain("Another Foodbank");
  });

  // The whole web-branch prompt, end to end. prompt.ts's tail spacing was
  // verified byte-for-byte against Django's template engine and PLAN.md §8.5.7
  // calls a whitespace change here the shape of the June 2026 incident, so the
  // exact bytes around the page are asserted rather than merely `toContain`.
  it("ends with the rendered markdown in web's exact blank-line envelope", async () => {
    scriptWebSuccess("# Shopping list\n- Soup", ["Soup"]);

    await run();

    expect(promptSent().endsWith("From this web page describing the food bank's needed and excess items below:\n\n\n    # Shopping list\n- Soup\n\n\n\n\n\n")).toBe(true);
  });
});

// ===========================================================================
// STAGES 8-9 -- THE CHANGE DECISION, THROUGH REAL ROWS
// ===========================================================================
describe("the change decision", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
  });

  // decision.ts is unit-tested on its own; what is tested HERE is that the real
  // rows reach it. An unchanged list must not produce a row -- otherwise the
  // review queue fills with ~1,024 identical entries every night and stops
  // being readable, which is the same outcome as it being wrong.
  it("writes nothing when the extraction matches the published need", async () => {
    seedNeed({ id: 1, changeText: "Tinned Tomatoes\nUHT Milk", excessChangeText: "", published: 1 });
    scriptWebSuccess("- Tinned Tomatoes\n- UHT Milk", ["Tinned Tomatoes", "UHT Milk"], []);

    const { acks } = await run();

    expect(newChanges()).toEqual([]);
    // ...and the bookkeeping still completes: an unchanged food bank is a
    // successful check, not a skipped one.
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlItems()[0]!.need_id).toBeNull();
    expect(lastNeedCheck()).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(2);
    expect(acks).toEqual([0]);
  });

  // needItemsKey strips to lowercase alphanumerics per line, so reordering and
  // separator drift are not changes. This is what stops a page that shuffles its
  // list on every render from filing a need every night.
  it("treats a reordered, re-punctuated list as unchanged", async () => {
    seedNeed({ id: 1, changeText: "Tinned Tomatoes\nUHT Milk", published: 1 });
    scriptWebSuccess("- x", ["uht-milk", "tinned tomatoes!"], []);

    await run();

    expect(newChanges()).toEqual([]);
  });

  // S7 (crawlers.py:484-518). Yesterday's extraction is still sitting
  // unreviewed; today's is identical. Filing it again would double the queue
  // every day the reviewer is on holiday.
  it("suppresses a repeat of something already sitting unpublished", async () => {
    seedNeed({ id: 1, changeText: "Soup\nRice", excessChangeText: "", published: 0, created: "2026-09-04 09:00:00.000000" });
    scriptWebSuccess("- Soup\n- Rice", ["Soup", "Rice"], []);

    const { acks } = await run();

    expect(newChanges()).toEqual([]);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlItems()[0]!.need_id).toBeNull();
    expect(acks).toEqual([0]);
  });

  // The CHANGE test compares both lists too, and that is a separate branch
  // from the suppression one above: crawlers.py:533-538 sets is_change from
  // TWO independent comparisons against the last published need, one per half.
  // THE MUTANT THIS KILLS: deleting decision.ts's second comparison (the
  // excess one). Every other test in this file that involves a published need
  // changes the NEEDS half, so the excess comparison could be deleted outright
  // and the whole file still passed -- and the food banks this silences are
  // exactly the ones that keep a stable shopping list and only ever update
  // what they are drowning in.
  it("files a change when only the excess half differs from the published need", async () => {
    seedNeed({ id: 1, changeText: "Soup\nRice", excessChangeText: "Pasta", published: 1 });
    scriptWebSuccess("- Soup\n- Rice", ["Soup", "Rice"], ["Beans"]);

    await run();

    expect(newChanges()).toHaveLength(1);
    expect(newChanges()[0]!.change_text).toBe("Soup\nRice");
    expect(newChanges()[0]!.excess_change_text).toBe("Beans");
    expect(crawlItems()[0]!.need_id).toBe(newChanges()[0]!.id);
  });

  // The unpublished window is UNPUBLISHED rows only -- `published = 0`, not
  // "every row for this food bank". THE MUTANT THIS KILLS: dropping that
  // predicate from getLastUnpublishedNeeds. The fixture is a food bank that
  // alternates between two lists (seasonal, and entirely ordinary): today's
  // extraction matches an OLDER PUBLISHED row, and must still be filed,
  // because a published row is a reviewed decision, not something already
  // sitting in the queue. With the predicate gone that older published row
  // suppresses the change and the site's list silently stops tracking the
  // page. No test here seeded a published row into this window before.
  it("does not let a published row suppress a change as if it were unreviewed", async () => {
    seedNeed({ id: 1, changeText: "Soup\nRice", excessChangeText: "", published: 1, created: "2026-08-01 09:00:00.000000" });
    seedNeed({ id: 2, changeText: "Pasta", excessChangeText: "", published: 1, created: "2026-09-01 09:00:00.000000" });
    scriptWebSuccess("- Soup\n- Rice", ["Soup", "Rice"], []);

    await run();

    expect(newChanges()).toHaveLength(1);
    expect(newChanges()[0]!.change_text).toBe("Soup\nRice");
  });

  // Suppression compares BOTH lists. A repeat of the needs with a different
  // excess is a genuine change and must still be filed -- a comparison that
  // dropped the excess half would silently swallow every excess-only update.
  it("does not suppress when only the needs half matches", async () => {
    seedNeed({ id: 1, changeText: "Soup\nRice", excessChangeText: "Pasta", published: 0 });
    scriptWebSuccess("- Soup\n- Rice", ["Soup", "Rice"], ["Beans"]);

    await run();

    expect(newChanges()).toHaveLength(1);
    expect(newChanges()[0]!.excess_change_text).toBe("Beans");
  });

  // NONPERTINENT_WINDOW = 10, crawlers.py:484's `[:10]`. The eleventh-newest
  // unpublished row is outside the window, so an identical extraction IS filed
  // again. Pinned because the boundary is invisible: with a window of 11 this
  // test's expectation flips, and nothing else in the system would notice.
  it("only looks back ten unpublished needs, so the eleventh does not suppress", async () => {
    // Two-digit seconds throughout: `created` is TEXT and sorts bytewise, so
    // "2026-09-04 09:00:09" > "2026-09-04 09:00:10" would be wrong with one.
    seedNeed({ id: 1, changeText: "Soup\nRice", excessChangeText: "", published: 0, created: "2026-09-04 09:00:01.000000" });
    for (let i = 2; i <= 11; i++) {
      seedNeed({ id: i, changeText: `Filler ${i}`, excessChangeText: "", published: 0, created: `2026-09-04 09:00:${String(i).padStart(2, "0")}.000000` });
    }
    scriptWebSuccess("- Soup\n- Rice", ["Soup", "Rice"], []);

    await run();

    expect(newChanges()).toHaveLength(1);
    expect(newChanges()[0]!.change_text).toBe("Soup\nRice");
  });

  // ...and the same fixture one row shorter DOES suppress. Without this pair the
  // test above passes for a window of 10, 11 or 10,000.
  it("does suppress when the identical need is the tenth-newest", async () => {
    seedNeed({ id: 1, changeText: "Soup\nRice", excessChangeText: "", published: 0, created: "2026-09-04 09:00:01.000000" });
    for (let i = 2; i <= 10; i++) {
      seedNeed({ id: i, changeText: `Filler ${i}`, excessChangeText: "", published: 0, created: `2026-09-04 09:00:${String(i).padStart(2, "0")}.000000` });
    }
    scriptWebSuccess("- Soup\n- Rice", ["Soup", "Rice"], []);

    await run();

    expect(newChanges()).toEqual([]);
  });

  // Another food bank's unpublished need must not suppress this one's. Identical
  // lists across food banks are entirely ordinary -- the same platform, the same
  // seasonal shortages -- so a missing WHERE here would silence one of them at
  // random, and only ever the one that happened to be crawled second.
  it("ignores unpublished needs belonging to a different food bank", async () => {
    seedFoodbank({ id: DUNDEE, slug: "dundee" });
    seedNeed({ id: 1, changeText: "Soup\nRice", excessChangeText: "", published: 0, foodbankId: DUNDEE });
    scriptWebSuccess("- Soup\n- Rice", ["Soup", "Rice"], []);

    await run();

    expect(newChanges()).toHaveLength(1);
    // The row that was filed is SALISBURY's own, with Salisbury's text -- a
    // length check alone would also pass if Dundee's seeded row had somehow
    // been counted as this run's output.
    expect(newChanges()[0]!.foodbank_id).toBe(SALISBURY);
    expect(newChanges()[0]!.change_text).toBe("Soup\nRice");
  });
});

// ===========================================================================
// S6 -- NEVER WIPE A PUBLISHED NEED ON AN EMPTY EXTRACTION
// ===========================================================================
describe("an empty extraction", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
  });

  // "the single most important safeguard in this pipeline" (the module's own
  // comment), crawlers.py:486-514. A 200 that renders to a cookie wall, a page
  // that moved its list behind JS, a provider that answered {} -- all of them
  // look like "no needs", and publishing that empties a live shopping list.
  it("with an existing published need writes a discrepancy and files nothing", async () => {
    seedNeed({ id: 1, changeText: "Tinned Tomatoes", excessChangeText: "", published: 1 });
    scriptWebSuccess("Cookies. Accept?", [], []);

    const { acks, retries } = await run();

    expect(discrepancies()).toHaveLength(1);
    expect(discrepancies()[0]!.discrepancy_text).toBe(`Empty needs extracted for ${SITE} despite an existing published need; skipped to avoid wiping it`);
    expect(discrepancies()[0]!.url).toBe(SITE);
    expect(discrepancies()[0]!.discrepancy_type).toBe("website");
    expect(newChanges()).toEqual([]);
    expect(db.prepare("SELECT change_text FROM foodbankchange WHERE id = 1").get()).toEqual({ change_text: "Tinned Tomatoes" });
    // Still a completed check, exactly like Django's :497-500.
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlItems()[0]!.need_id).toBeNull();
    expect(lastNeedCheck()).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(2);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  // The guard is `need_text OR excess_text` on the published row. A food bank
  // whose published need is excess-only is still a real list to protect.
  it("with an excess-only published need is still skipped", async () => {
    seedNeed({ id: 1, changeText: "", excessChangeText: "Baked Beans", published: 1 });
    scriptWebSuccess("nothing here", [], []);

    await run();

    expect(discrepancies()).toHaveLength(1);
    expect(newChanges()).toEqual([]);
  });

  // The other side of the guard, and NOT an oversight: a food bank that has
  // never published a need has nothing to wipe, so an empty extraction is
  // simply "no needs found today". No discrepancy, no row, no noise -- which is
  // the right outcome for a food bank whose site genuinely lists nothing, and
  // the reason S6 is conditional rather than a blanket "empty means broken".
  it("with no published need at all is silent, not a discrepancy", async () => {
    scriptWebSuccess("Welcome to our website", [], []);

    const { acks } = await run();

    expect(discrepancies()).toEqual([]);
    expect(newChanges()).toEqual([]);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(acks).toEqual([0]);
  });

  // SUSPECT (Django behaves identically, so this is a PARITY finding, not a
  // port defect). The S6 guard tests `last_published.change_text` for
  // truthiness, and the sentinel strings "Nothing"/"Unknown"/"Facebook" are
  // truthy. So a food bank whose published need is the "Nothing" placeholder
  // can never record a genuine "still nothing" check: every empty extraction
  // writes a fresh discrepancy instead, one per night, for as long as the
  // placeholder stands. Stage 4 excludes these same three strings from priming
  // (crawlers.py:409-411) precisely because they are not real lists; the S6
  // guard does not.
  it("is skipped as a wipe even when the published need is the Nothing placeholder", async () => {
    seedNeed({ id: 1, changeText: "Nothing", excessChangeText: "", published: 1 });
    scriptWebSuccess("Welcome to our website", [], []);

    await run();

    expect(discrepancies()).toHaveLength(1);
    expect(discrepancies()[0]!.discrepancy_text).toContain("despite an existing published need");
  });
});

// ===========================================================================
// S5 -- AN UNUSABLE MODEL REPLY IS A FAILURE, NEVER AN EMPTY LIST
// ===========================================================================
describe("when OpenRouter fails transiently", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
    seedNeed({ id: 1, changeText: "Tinned Tomatoes", published: 1 });
    markdownReplies = [markdownOk("- Tinned Tomatoes")];
  });

  // The retry path, and the reason S5 exists at all: reading an unusable reply
  // as `{needed: [], excess: []}` blamed the food bank's website for what was
  // really a bad provider, and quietly held the published need at its old
  // contents (crawlers.py's own comment at :447-450). The crawlitem is left
  // OPEN, which is the only way a stalled sweep is ever detected.
  it("leaves the crawlitem open and retries after 60s, with nothing written", async () => {
    openRouterReplies = [
      { status: 500, body: "provider error" },
      { status: 500, body: "provider error" },
    ];

    const { acks, retries } = await run();

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(lastNeedCheck()).toBeNull();
    expect(crawlSet().remaining).toBe(3);
    expect(newChanges()).toEqual([]);
    expect(discrepancies()).toEqual([]);
    expect(errors[0]![0]).toBe("needcheck-render: message failed for foodbank 22 (salisbury)");
    expect(errors[0]![1]).toContain("OpenRouter need extraction failed or returned unusable content");
  });

  // The 60s is not decoration. crawlers.py:451-474 sleeps 60s between its own
  // two attempts; a Worker cannot block wall clock, so that backoff moves onto
  // the queue redelivery. A bare `message.retry()` would redeliver immediately
  // at max_concurrency 25 straight back into the same provider outage.
  it("backs the retry off rather than redelivering immediately", async () => {
    openRouterReplies = [new TypeError("fetch failed"), new TypeError("fetch failed")];

    const { retries } = await run();

    expect(retries[0]!.options).toEqual({ delaySeconds: 60 });
  });

  // ai.py:86-151's two attempts, and the reason for them: OpenRouter re-routes
  // a repeat call, so an unparseable answer from one provider frequently parses
  // on the next. Measured at roughly 1 call in 10 (openrouter.ts's own note).
  it("succeeds on the second attempt after an unparseable first", async () => {
    openRouterReplies = [
      { status: 200, body: JSON.stringify({ choices: [{ message: { content: "Sure! Here are the needs: rice, pasta." } }] }) },
      openRouterOk(["Rice", "Pasta"], []),
    ];

    const { acks } = await run();

    expect(fetchCallsTo(OPENROUTER_URL)).toHaveLength(2);
    expect(newChanges()[0]!.change_text).toBe("Rice\nPasta");
    expect(acks).toEqual([0]);
  });

  // A 200 whose content parses but is missing the keys is the dangerous shape:
  // reading it as an empty extraction is precisely the S5 misreading, and here
  // there IS a published need for it to have wiped.
  it("retries rather than reading a schema-less 200 as an empty list", async () => {
    const schemaless = { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: ["Rice"] }) } }] }) };
    openRouterReplies = [schemaless, schemaless];

    const { acks, retries } = await run();

    // THE MUTANT THIS KILLS: isNeedExtraction() reduced to `true`. Both
    // attempts have to be spent, because the whole point of the second one is
    // that OpenRouter re-routes; an accept-anything schema check returns
    // {kind:"ok"} on the FIRST reply, `outcome.need.needed` is then undefined,
    // and the `.join()` blows up -- which retries too, so acks/retries alone
    // cannot tell the two apart. The call count can.
    expect(fetchCallsTo(OPENROUTER_URL)).toHaveLength(2);
    expect(acks).toEqual([]);
    expect(retries).toHaveLength(1);
    // ...and the logged reason is S5's, not a TypeError from a half-accepted
    // reply -- the line an operator greps when the review queue goes quiet.
    expect(errors[0]![1]).toContain("OpenRouter need extraction failed or returned unusable content");
    expect(db.prepare("SELECT change_text FROM foodbankchange WHERE id = 1").get()).toEqual({ change_text: "Tinned Tomatoes" });
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here. extractNeed's
  // `await res.json()` on a 2xx is the one call in that function outside a
  // try/catch, so a 200 carrying non-JSON (a proxy's HTML error page, a
  // truncated body) throws straight out of it instead of being classified. The
  // OUTCOME is the same as a retryable classification -- the message retries --
  // but the second attempt the two-attempt loop exists for never happens, and
  // the logged error is a SyntaxError rather than the S5 message.
  it("throws out of the extraction, skipping the second attempt, on a non-JSON 200", async () => {
    openRouterReplies = [{ status: 200, body: "<html>502 Bad Gateway</html>" }];

    const { retries } = await run();

    expect(fetchCallsTo(OPENROUTER_URL)).toHaveLength(1);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(crawlItems()[0]!.finish).toBeNull();
  });
});

// ===========================================================================
// WP 5.4 -- THE PERMANENT FAILURE THAT MUST NOT STORM
// ===========================================================================
describe("when OpenRouter fails permanently", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
    markdownReplies = [markdownOk("- Tinned Tomatoes")];
  });

  // A 402 is account-wide: it fails identically on every retry and on every
  // other food bank's message today. Retrying multiplies one failure ~1,024x
  // and cost production two full days in Aug 2026. So: ack, and record it where
  // a human already looks.
  it.each([402, 401, 403])("acks a %i and records it as a discrepancy instead of retrying", async (status) => {
    openRouterReplies = [{ status, body: "Insufficient credits" }];

    const { acks, retries } = await run();

    expect(fetchCallsTo(OPENROUTER_URL)).toHaveLength(1);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(discrepancies()).toHaveLength(1);
    expect(discrepancies()[0]!.discrepancy_text).toBe(`Need check failed: OpenRouter ${status}: Insufficient credits`);
    expect(discrepancies()[0]!.discrepancy_type).toBe("website");
    // THE MUTANT THIS KILLS: `foodbankId: message.body.crawlSetId` in the catch
    // block. This row's foodbank_id was asserted nowhere before, and the two
    // ids are adjacent same-typed fields on the same message body -- the
    // easiest possible slip. It also matters more here than on any other
    // discrepancy in this file: on an account-wide 402 the admin's discrepancy
    // list is where ~1,024 of these land at once, and one attributed to the
    // wrong food bank is worse than none, because a reviewer chases a site that
    // was never broken.
    expect(discrepancies()[0]!.foodbank_id).toBe(SALISBURY);
    expect(discrepancies()[0]!.need_id).toBeNull();
    expect(discrepancies()[0]!.status).toBe("New");
    expect(errors[0]![0]).toBe(`needcheck-render: permanent OpenRouter failure for foodbank 22 (salisbury)`);
  });

  // THE REGRESSION THIS BRANCH ALREADY HAD ONCE, named in the module's own
  // comment: it used to skip finish() entirely, which on an account-wide 402
  // left every crawlitem permanently `finish IS NULL` and crawlset.remaining
  // never reaching 0 -- reproducing through this path the exact bug the counter
  // exists to detect. Every exit from processOne closes the item.
  it("still closes the crawlitem and decrements the counter", async () => {
    openRouterReplies = [{ status: 402, body: "Insufficient credits" }];

    await run();

    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlItems()[0]!.need_id).toBeNull();
    expect(lastNeedCheck()).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(2);
  });

  // A DIVERGENCE INSIDE THE MODULE, pinned because it is genuinely surprising:
  // the permanent-failure discrepancy is written from the CATCH block, which
  // has no food bank row -- so its url comes from the MESSAGE BODY
  // (msg.url, the cron's enqueue-time snapshot), while every other discrepancy
  // in this file uses the freshly-read foodbank.url. If an admin corrected the
  // url mid-run, this one row points at the old one.
  it("uses the message body's url, not the freshly read one", async () => {
    db.prepare("UPDATE foodbank SET url = ? WHERE id = ?").run("https://corrected.example/", SALISBURY);
    openRouterReplies = [{ status: 402, body: "no" }];

    await run([message({ url: "https://stale.example/" })]);

    expect(discrepancies()[0]!.url).toBe("https://stale.example/");
  });

  // The catch block opens a SECOND session to write its discrepancy, because
  // the first one belongs to processOne's scope. Pinned as a fact about the
  // shape rather than as a complaint: on a replicated D1 the second session can
  // be pinned to a different replica than the one that just closed the
  // crawlitem, and the two writes are therefore not ordered against each other.
  it("opens a second session for the discrepancy write", async () => {
    openRouterReplies = [{ status: 402, body: "no" }];

    await run();

    expect(sessionModes).toEqual(["first-unconstrained", "first-unconstrained"]);
  });

  // The failure that would otherwise be truly invisible: the 402 handling
  // itself failing. The message must still ack (retrying is the storm this
  // branch exists to prevent) and the failure must still be logged.
  it("acks even when the discrepancy write itself fails", async () => {
    openRouterReplies = [{ status: 402, body: "no" }];
    failOn = /INSERT INTO foodbankdiscrepancy/;

    const { acks, retries } = await run();

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(discrepancies()).toEqual([]);
    expect(errors.map((line) => line[0])).toContain("needcheck-render: also failed to write the permanent-failure discrepancy");
  });

  // The class is exported so the consumer can distinguish this case from every
  // other error; nothing sets `name`, so it prints as "Error: ..." in a log.
  // Pinned as it is -- a future `this.name = ...` would change log lines an
  // operator greps.
  it("is signalled by an exported Error subclass carrying the reason", () => {
    const err = new PermanentOpenRouterFailure("OpenRouter 402: no");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PermanentOpenRouterFailure);
    expect(err.message).toBe("OpenRouter 402: no");
    expect(err.name).toBe("Error");
    // ...and an ordinary Error must NOT satisfy it, or every failure would ack.
    expect(new Error("boom")).not.toBeInstanceOf(PermanentOpenRouterFailure);
  });
});

// ===========================================================================
// THE FOOD BANK IS GONE
// ===========================================================================
describe("when the food bank no longer exists", () => {
  beforeEach(() => {
    seedCrawlSet(3);
  });

  // Deleted (or closed and purged) between the cron's enqueue and this dequeue.
  // Django hits Foodbank.DoesNotExist at crawlers.py:587, likewise uncaught.
  // The port retries -- three deliveries at 60s and then the DLQ, where
  // needcheckRenderDlq.ts is what finally decrements the counter so the set is
  // not stuck open forever.
  it("retries, opens no crawlitem and touches no network", async () => {
    const { acks, retries } = await run([message({ foodbankId: 999, slug: "vanished" })]);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    // The insert is downstream of the existence check, so no half-open row is
    // left behind for a food bank that does not exist.
    expect(crawlItems()).toEqual([]);
    expect(crawlSet().remaining).toBe(3);
    expect(fetchCalls).toEqual([]);
  });

  // This is a queue: the log line IS the incident report, and it has to name
  // the message well enough to find the food bank without it.
  it("logs the id and the slug from the message", async () => {
    await run([message({ foodbankId: 999, slug: "vanished" })]);

    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe("needcheck-render: message failed for foodbank 999 (vanished)");
    expect(errors[0]![1]).toContain("needcheck-render: foodbank 999 (vanished) no longer exists");
  });
});

// ===========================================================================
// AT-LEAST-ONCE REDELIVERY
// ===========================================================================
describe("when the same message is delivered twice", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
  });

  // The single most important property in this file. insertCrawlItem upserts on
  // crawlitem_crawlset_foodbank_uniq and finishCrawlItem guards on `finish IS
  // NULL`; together they mean a post-commit redelivery reopens the SAME row and
  // skips the decrement. Without the upsert the redelivery orphans a second row
  // that is never finished (indistinguishable from a stall); without the guard
  // remaining goes down twice for one food bank and the set closes early --
  // possibly before other food banks have been crawled at all.
  it("keeps one crawlitem and decrements remaining exactly once", async () => {
    scriptWebSuccess("- Soup", ["Soup"]);
    await run();
    markdownReplies = [markdownOk("- Soup")];
    openRouterReplies = [openRouterOk(["Soup"], [])];

    const { acks } = await run();

    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(crawlSet().remaining).toBe(2);
    expect(acks).toEqual([0]);
  });

  // ...and S7 is what stops the redelivery filing a DUPLICATE need. The second
  // delivery re-scrapes and re-extracts (there is no guard before the work), so
  // the only thing standing between an at-least-once queue and two identical
  // rows in the review queue is the nonpertinent window matching the row the
  // FIRST delivery just wrote.
  it("does not file a second, identical need", async () => {
    scriptWebSuccess("- Soup", ["Soup"]);
    await run();
    markdownReplies = [markdownOk("- Soup")];
    openRouterReplies = [openRouterOk(["Soup"], [])];

    await run();

    expect(newChanges()).toHaveLength(1);
    // The re-scrape and the re-extraction are real costs, paid twice: a second
    // Browser Rendering call and a second paid model call for one food bank.
    expect(fetchCallsTo(MARKDOWN_URL)).toHaveLength(2);
    expect(fetchCallsTo(OPENROUTER_URL)).toHaveLength(2);
  });

  // Uniqueness is (crawl_set_id, foodbank_id), so TOMORROW's sweep must open a
  // second row rather than reusing tonight's -- otherwise every food bank has
  // exactly one crawlitem forever and the retention prune has nothing to prune.
  it("opens a separate crawlitem under the next night's crawlset", async () => {
    seedCrawlSet(1, 8);
    scriptWebSuccess("- Soup", ["Soup"]);
    await run();
    markdownReplies = [markdownOk("- Soup")];
    openRouterReplies = [openRouterOk(["Soup"], [])];

    await run([message({ crawlSetId: 8 })]);

    const items = crawlItems();
    expect(items).toHaveLength(2);
    expect(items.map((row) => row.crawl_set_id)).toEqual([CRAWL_SET, 8]);
    expect(crawlSet(CRAWL_SET).remaining).toBe(2);
    expect(crawlSet(8).remaining).toBe(0);
  });

  // Two copies in ONE batch -- which max_batch_size 5 makes possible -- must
  // behave the same as two batches.
  it("survives both copies arriving in the same batch", async () => {
    markdownReplies = [markdownOk("- Soup"), markdownOk("- Soup")];
    openRouterReplies = [openRouterOk(["Soup"], []), openRouterOk(["Soup"], [])];

    const { acks, retries } = await run([message(), message()]);

    expect(crawlItems()).toHaveLength(1);
    expect(newChanges()).toHaveLength(1);
    expect(crawlSet().remaining).toBe(2);
    expect(acks).toEqual([0, 1]);
    expect(retries).toEqual([]);
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // finish() is three separate writes with no transaction around them. If
  // finishCrawlItem succeeds and a later one fails, the message retries; on
  // redelivery finishCrawlItem answers false (the row is already closed), the
  // `if (!closed) return` short-circuits, and the remaining writes are skipped
  // PERMANENTLY. crawlset.remaining stays one too high and `finish` is never
  // stamped, so that night's set reads as still running forever -- and
  // last_need_check stays null, so the food bank reads as never checked.
  //
  // The DLQ handler that would otherwise decrement never runs: the redelivery
  // ACKS. Nothing else in the system decrements. The same shape is in
  // queues/charity.ts's handler.
  it("permanently loses the decrement if the crawlitem closes but a later write fails", async () => {
    scriptWebSuccess("- Soup", ["Soup"]);
    failOn = /UPDATE foodbank SET last_need_check/;

    await run();

    // First delivery: item closed, the stamp blew up, the message retried.
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(lastNeedCheck()).toBeNull();
    expect(crawlSet().remaining).toBe(3);

    // The outage clears before the redelivery arrives.
    failOn = null;
    markdownReplies = [markdownOk("- Soup")];
    openRouterReplies = [openRouterOk(["Soup"], [])];
    const { acks, retries } = await run();

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    // ...and both are still unrecoverable. This is the suspected bug, asserted
    // as it is so the suite stays green and the defect stays visible.
    expect(lastNeedCheck()).toBeNull();
    expect(crawlSet().remaining).toBe(3);
    expect(crawlSet().finish).toBeNull();
  });
});

// ===========================================================================
// DOWNSTREAM D1 FAILURES
// ===========================================================================
describe("when a D1 write fails", () => {
  beforeEach(() => {
    seedFoodbank();
    seedCrawlSet(3);
    scriptWebSuccess("- Soup", ["Soup"]);
  });

  it("retries and opens no crawlitem when the crawlitem insert fails", async () => {
    failOn = /INSERT INTO crawlitem/;

    const { acks, retries } = await run();

    expect(crawlItems()).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(acks).toEqual([]);
    expect(retries).toHaveLength(1);
  });

  // The crawlitem is opened BEFORE the scrape (crawlers.py:285-291) precisely so
  // a crash mid-render leaves `finish IS NULL` behind -- 0008_needcheck.sql's
  // own comment: "a row with finish IS NULL is exactly how a stalled/crashed run
  // is detected". A handler that opened and closed the row around the work, or
  // closed it first, would look identical from the outside on the happy path.
  it("leaves the crawlitem open when closing it fails", async () => {
    failOn = /UPDATE crawlitem SET finish/;

    const { acks, retries } = await run();

    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet().remaining).toBe(3);
    expect(lastNeedCheck()).toBeNull();
    expect(acks).toEqual([]);
    expect(retries).toHaveLength(1);
  });

  // The need is inserted BEFORE the crawlitem is closed, so a failure here
  // leaves the item open and the message retries -- which is right: the review
  // queue not getting the need is the thing worth another delivery.
  it("retries with the crawlitem open when the need insert fails", async () => {
    failOn = /INSERT INTO foodbankchange/;

    const { acks, retries } = await run();

    expect(newChanges()).toEqual([]);
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(crawlSet().remaining).toBe(3);
    expect(acks).toEqual([]);
    expect(retries).toHaveLength(1);
  });

  // The S1 branch's discrepancy failing takes the whole message down with it,
  // rather than closing the crawlitem and losing the discrepancy silently.
  // Retrying is the right call -- a render failure nobody records is the exact
  // shape of the incident this tier exists for.
  it("retries when the render-failure discrepancy cannot be written", async () => {
    markdownReplies = [
      { status: 500, body: "x" },
      { status: 500, body: "x" },
      { status: 500, body: "x" },
    ];
    openRouterReplies = [];
    failOn = /INSERT INTO foodbankdiscrepancy/;

    const { acks, retries } = await run();

    expect(discrepancies()).toEqual([]);
    expect(crawlItems()[0]!.finish).toBeNull();
    expect(acks).toEqual([]);
    expect(retries).toHaveLength(1);
  });
});

// ===========================================================================
// BATCH ISOLATION AND MALFORMED MESSAGES
// ===========================================================================
describe("a batch", () => {
  // wrangler.jsonc gives needcheck-render max_batch_size 5. One food bank whose
  // check fails must not cost the other four theirs -- the try/catch is per
  // message for exactly this reason, and a throw escaping the loop would
  // silently redeliver four healthy messages every night.
  it("carries on after a message that fails", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", url: "https://dundee.example/", shopping_list_url: "https://dundee.example/list/" });
    seedCrawlSet(3);
    markdownReplies = [markdownOk("- Soup"), markdownOk("- Pasta")];
    openRouterReplies = [openRouterOk(["Soup"], []), openRouterOk(["Pasta"], [])];

    const { acks, retries } = await run([message(), message({ foodbankId: 999, slug: "vanished" }), message({ foodbankId: DUNDEE, slug: "dundee" })]);

    expect(acks).toEqual([0, 2]);
    expect(retries.map((r) => r.index)).toEqual([1]);
    expect(crawlItems().map((row) => row.foodbank_id)).toEqual([SALISBURY, DUNDEE]);
    expect(newChanges().map((row) => row.change_text)).toEqual(["Soup", "Pasta"]);
    expect(crawlSet().remaining).toBe(1);
  });

  // Serial, not Promise.all. Browser Rendering has a 30 Quick Actions/sec
  // ceiling and max_concurrency is already 25 across invocations; five
  // simultaneous renders inside one invocation on top of that is what the
  // sequential loop avoids.
  it("is processed one message at a time, in order", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", url: "https://dundee.example/", shopping_list_url: "https://dundee.example/list/" });
    seedCrawlSet(2);
    markdownReplies = [markdownOk("- Soup"), markdownOk("- Pasta")];
    openRouterReplies = [openRouterOk(["Soup"], []), openRouterOk(["Pasta"], [])];

    await run([message(), message({ foodbankId: DUNDEE, slug: "dundee" })]);

    expect(fetchCalls.map((call) => call.url).filter((url) => url.startsWith(MARKDOWN_URL) || url === OPENROUTER_URL)).toEqual([
      `${MARKDOWN_URL}211195b9bf606f797a6d2dbc0bf41791/browser-rendering/markdown`,
      OPENROUTER_URL,
      `${MARKDOWN_URL}211195b9bf606f797a6d2dbc0bf41791/browser-rendering/markdown`,
      OPENROUTER_URL,
    ]);
    expect(JSON.parse(fetchCallsTo(MARKDOWN_URL)[0]!.body!).url).toBe(SHOPPING_LIST);
    expect(JSON.parse(fetchCallsTo(MARKDOWN_URL)[1]!.body!).url).toBe("https://dundee.example/list/");
  });

  it("does nothing at all when it is empty", async () => {
    seedCrawlSet(3);

    await run([]);

    expect(sessionModes).toEqual([]);
    expect(crawlItems()).toEqual([]);
    expect(crawlSet().remaining).toBe(3);
  });

  // A body missing foodbankId fails at the bind and is handled gracefully:
  // logged with `undefined` in place of the id, and retried. Three wasted
  // deliveries, but they do end at the DLQ, which is where a human can see them.
  it("logs and retries a message with no foodbankId", async () => {
    seedCrawlSet(3);

    const { acks, retries } = await run([{ crawlSetId: CRAWL_SET }]);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(errors[0]![0]).toBe("needcheck-render: message failed for foodbank undefined (undefined)");
    expect(crawlItems()).toEqual([]);
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // The catch block dereferences `message.body.foodbankId` to build its log
  // line. For a body of null/undefined that dereference throws INSIDE the catch,
  // so the error escapes handleNeedcheckRenderQueue entirely: the rest of the
  // batch is never looked at, and messages after the bad one are neither acked
  // nor retried. One unparseable message therefore poisons up to four healthy
  // ones (max_batch_size 5) on every delivery until the batch exhausts
  // max_retries. Identical shape to queues/charity.ts's handler.
  it("takes the rest of the batch down with it when a body is null", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", url: "https://dundee.example/", shopping_list_url: "https://dundee.example/list/" });
    seedCrawlSet(3);
    scriptWebSuccess("- Soup", ["Soup"]);

    const { batch, acks, retries } = batchOf([message(), null, message({ foodbankId: DUNDEE, slug: "dundee" })]);
    await expect(handleNeedcheckRenderQueue(batch, env)).rejects.toThrow(TypeError);

    // The first message committed and acked before the crash...
    expect(acks).toEqual([0]);
    expect(newChanges().map((row) => row.change_text)).toEqual(["Soup"]);
    // ...and the third was never even looked at. Not acked, not retried, and
    // Dundee's site was never rendered.
    expect(retries).toEqual([]);
    expect(fetchCallsTo(MARKDOWN_URL)).toHaveLength(1);
    expect(crawlSet().remaining).toBe(2);
  });

  // A crawlSetId pointing at no set is NOT an error: the decrement's UPDATE
  // matches nothing and answers null. The message completes with a dangling
  // crawl_set_id. Pinned because that is the shape a manual one-off enqueue
  // takes, and because silence is the correct behaviour rather than an oversight.
  it("completes a message naming a crawlset that does not exist", async () => {
    seedFoodbank();
    seedCrawlSet(3);
    scriptWebSuccess("- Soup", ["Soup"]);

    const { acks } = await run([message({ crawlSetId: 4242 })]);

    expect(acks).toEqual([0]);
    expect(crawlItems()[0]!.crawl_set_id).toBe(4242);
    expect(crawlItems()[0]!.finish).toBe(DJANGO_NOW);
    expect(newChanges()).toHaveLength(1);
    expect(crawlSet().remaining).toBe(3);
  });

  // decrementCrawlSetRemaining's `AND remaining > 0` guard. An extra message
  // against an already-drained set (a redelivery of the very last one, say) must
  // not push the counter negative or re-stamp `finish`.
  it("leaves an already-drained crawlset at zero", async () => {
    seedFoodbank();
    seedCrawlSet(0, 77);
    scriptWebSuccess("- Soup", ["Soup"]);

    const { acks } = await run([message({ crawlSetId: 77 })]);

    expect(acks).toEqual([0]);
    expect(crawlSet(77).remaining).toBe(0);
    expect(crawlSet(77).finish).toBeNull();
  });
});
