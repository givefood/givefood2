import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import type { Env } from "../../worker-configuration";
import { handleFoodbankCheckJob, type FoodbankCheckResult } from "./foodbankCheck";
import { CHECK_USE_AI_FIELDS, FOODBANK_CHECK_RESPONSE_SCHEMA, type FoodbankCheckAiResponse } from "./checkPrompt";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning,
// as packages/db/src/schema.testkit.ts:35 and notify/needEmail.test.ts:6.
import { DatabaseSync } from "node:sqlite";

// adminJobs/foodbankCheck.ts -- the queue consumer behind the admin's "Run
// Check" button. It scrapes up to five of a food bank's own pages, pays for a
// Gemini call, and writes the whole comparison back onto one admin_job row.
//
// WHY THIS FILE IS WORTH THE LENGTH. Nobody watches a queue consumer. Every
// failure mode here is silent by construction, and the module's own header
// comment names the worst of them: a blocked fetch "does not surface as an
// error -- it returns null, the page is reported to the model and the admin as
// 'not found', and the AI comparison is then made against a page we simply
// failed to read". That is the same shape as the incident this tier exists for
// (a Browser Rendering credential that broke quietly for a day): the check page
// still renders, still shows a tidy two-column diff, and the diff is wrong.
//
// The consumer contract makes it worse rather than better. queues/jobs.ts:37-46
// dispatches this handler and its comment says it "catches its own errors and
// records them on the admin_job row rather than throwing", so a retry never
// happens and the DLQ never fills. NOTHING outside the admin_job row can
// observe a failure at all. So every test below reads the row back -- status,
// error, finished, and the parsed result payload -- rather than asserting that
// the call resolved.
//
// REAL THINGS, NOT MOCKS. node:sqlite carrying the WHOLE real migration set
// (MIGRATIONS_SQL rather than schemaFor(...): this handler reaches foodbank,
// foodbanklocation_full, foodbankdonationpoint_full, crawlitem and admin_job
// through four shared packages/db functions, and the full schema is the only
// fixture that cannot develop the github #51 gap where a shared query starts
// reading one more object); the real getFoodbankBySlug / getLocationsByFoodbankId
// / getDonationPointsByFoodbankId / markAdminJob* ; the real buildCheckPrompt
// and the real geminiJsonCall.
//
// MOCKED, and only this:
//   * `fetch` -- the food banks' own sites and Google's Gemini endpoint, the
//     only two things that leave the machine.
//   * `HTMLRewriter`, a workerd primitive with no node equivalent. See the
//     stand-in's own comment for exactly what it does and does not prove; the
//     short version is that the extraction fixtures below deliberately contain
//     no <script>/<style>, because whether workerd's `body` text handler sees
//     text inside a REMOVED subtree is unresolved (see the suspected-bug note
//     at the bottom of this comment) and no double can settle it.
//
// PARITY. gfadmin/views.py:861-1011 (_build_foodbank_check_data) and
// :1136-1210 (foodbank_check) at /Users/jasoncartwright/Sites/foodcharity were
// read directly for every claim in this file that cites them. Where the port
// diverges the test asserts the PORT and the comment says which way Django
// went; none of those divergences is asserted as a wish.
//
// MUTATION-TESTED, in a copy of the whole tree in the scratchpad (pnpm's
// workspace symlinks are relative, so a copy resolves @givefood/* into itself
// and never back into src/). Eighty mutants across this module, checkPrompt.ts
// and lib/gemini.ts; seventy-eight failed the file. The kills worth naming,
// because each is a test's reason to exist: the 403/429 retry widened to any
// error status or removed; a non-200 returning "" instead of null (which turns
// "we were blocked" into "this page is blank" for both the model and the
// admin); `text = chunk.text` for `text +=`; either blacklist host dropped;
// `!page.url` narrowed to `=== null`; `finish` dropped from the crawlitem
// INSERT and its two same-typed binds swapped; every one of the three nullish
// words, and the case-insensitivity; iterating the AI response instead of
// CHECK_USE_AI_FIELDS; the space-strip widened past phone_number or removed;
// the address comparison deleted (which is the bug the module's own comment
// records having had); each half of the postcode normalisation; and BOTH
// directions of the donation-point/location exclusion asymmetry.
//
// Two survivors of that round were left on purpose. Moving markAdminJobRunning
// a suspension-point later inside the try is equivalent -- it is still before
// the network, which is the only thing the ordering claim is about (moving it
// to the END is killed). And dropping a sentence from check.txt's fixed
// preamble belongs to checkPrompt.test.ts, which owns that template; this file
// asserts the SEAM -- the arguments handed to buildCheckPrompt and that the
// string sent to Gemini is the string stored -- rather than re-testing the
// wording.
//
// MUTATION-TESTED AGAIN on review, 116 mutants over the same module in a fresh
// copy of the tree. Ten survived the 86 tests that existed then, and the nine
// tests added since exist to kill them -- each names its mutant where it sits:
//   * the 750ms anti-bot backoff deleted, shortened, or fired without `await`
//     (three separate edits, none of them visible in any row this handler
//     writes);
//   * the retry re-fetching with the User-Agent alone, dropping the Accept
//     header that is half of why a retry gets through;
//   * `res.status !== 200` loosened to `!res.ok`, which reads a 204 as a
//     successfully-fetched empty page;
//   * `withSession("first-primary")`;
//   * the element handler registering the decompose selectors and then not
//     calling remove() -- which the HTMLRewriter double could not see at all
//     until it was taught to record real remove() calls;
//   * a hardcoded food bank id in EITHER of the two child-row lookups, invisible
//     because the fixture food bank's id was the only one this file ran a whole
//     job for;
//   * the found-location exclusion keyed on the MODEL's postcode rather than
//     our stored one, invisible because every fixture gave the model the same
//     postcode we hold;
//   * and our-locations discrepancy widened with the found-locations rule.
// Nothing survives now.
//
// NOT VERIFIED, and reported rather than papered over:
//   * whether HTMLRewriter's `.on("body", {text})` handler still receives text
//     from a subtree a different registration removed. needcheck/scrape.ts:55-68
//     records exactly that happening live for a `.on("*")` handler -- "a <style>
//     block's CSS came through as the markdown's first sentence" -- and this
//     module uses the same remove-plus-text pattern. If it behaves the same way
//     on `body`, every prompt this handler builds carries the page's CSS and
//     JavaScript, which is Gemini tokens paid for and noise the model has to
//     read past. Cannot be checked without workerd; reported.

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
 * The D1 Sessions API surface packages/db uses, over the real engine. It
 * carries SQL to node:sqlite and does nothing else -- a session that answered
 * canned rows would be a second implementation of the queries under test.
 *
 * `first()` answers null, never undefined, and `batch()` returns one result per
 * input statement in order: getFoodbankBySlug indexes straight into that array
 * (foodbank.ts:250-252), so a batch that coalesced or reordered would hand back
 * the wrong row without erroring anywhere.
 */
function d1Session(hooks: { failOn?: RegExp; failWith?: unknown }): unknown {
  function statement(sql: string, params: Bindable[]): unknown {
    const guard = (): void => {
      if (hooks.failOn?.test(sql)) throw hooks.failWith ?? new Error("D1_ERROR: Network connection lost");
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

// ---------------------------------------------------------------------------
// The HTMLRewriter stand-in
// ---------------------------------------------------------------------------
//
// HTMLRewriter is a workerd global and this suite runs in plain node
// (vitest.config.mts pins `environment: "node"` and explains why), so there is
// no real one to call. Same stand-in strategy, and same honesty about its
// limits, as routes/admin/proxy.test.ts:216-240.
//
// WHAT IT PROVES. The module's own code on this path is four decisions: WHICH
// selectors to register, that the removal set matches BeautifulSoup's
// `decompose` list in Django's htmlbodytext(), that the element handler
// actually calls remove() on what it is handed, and that the text handler
// ACCUMULATES (`text += chunk.text`) rather than assigns. All four are asserted
// below. The last comes of this double deliberately splitting every text run
// across two chunks -- a handler that assigned would keep only the second half,
// and with one chunk per run nothing would notice. The third comes of firing
// the element handler with a probe that records whether remove() was called,
// and stripping ONLY the selectors it really removed; stripping by registration
// instead (what this double did originally) let an element handler that
// removed nothing pass the whole file.
//
// WHAT IT DOES NOT PROVE. It finds <body> and the stripped tags with regexes,
// so it models neither malformed markup, nor implied tags, nor real chunk
// boundaries, nor workerd's dispatch semantics for a removed subtree. It
// treats a removed element's text as gone -- which is Django's BeautifulSoup
// behaviour and the port's evident intent -- but see this file's header: the
// repo's own scrape.ts:55-68 recorded the opposite happening live for a `*`
// handler. Nothing below asserts on that, and every extraction fixture in this
// file is free of <script>/<style> so its expected text is the same under
// either dispatch model.
//
// It is also an oracle in the other direction: `on()` records its selector, so
// "the handler asked for svg, style, script, iframe, canvas" is measured
// rather than assumed.

interface FakeTextChunk {
  text: string;
}
interface FakeElementHandler {
  element(el: { remove(): void }): void;
}
interface FakeTextHandler {
  text(chunk: FakeTextChunk): void;
}

const BODY_INNER = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;
const TAG = /<[^>]*>/g;

let rewriterSelectors: string[] = [];
/** The selectors whose element handler actually called remove() on what it was handed. */
let rewriterRemovals: string[] = [];

class FakeHTMLRewriter {
  private removeSelectors: string[] = [];
  private textSelectors: { selector: string; handler: FakeTextHandler }[] = [];

  on(selector: string, handler: FakeElementHandler | FakeTextHandler): this {
    rewriterSelectors.push(selector);
    if ("element" in handler) {
      // The element handler is fired with a probe that RECORDS whether it
      // called remove(), and only a selector it genuinely removed is stripped
      // below or reported in rewriterRemovals.
      //
      // MUTANT THIS KILLS: `element(el) { void el; }` -- a handler that
      // registers exactly the right selector list and then decomposes
      // nothing. An earlier version of this double fired a no-op element and
      // stripped tags purely from the REGISTRATION, so that mutant survived
      // all 86 tests: every food bank's <script> and <style> would have gone
      // to Gemini as prose and nothing here would have noticed.
      let removed = false;
      handler.element({ remove: () => void (removed = true) });
      if (removed) {
        this.removeSelectors.push(selector);
        rewriterRemovals.push(selector);
      }
    } else {
      this.textSelectors.push({ selector, handler });
    }
    return this;
  }

  transform(res: Response): Response {
    const textSelectors = this.textSelectors;
    // Derived from the selectors the handler actually registered, not
    // hardcoded: that is what lets the extraction below act as an oracle for
    // "it asked for the right tag set" rather than agreeing with it by
    // construction.
    const tags = this.removeSelectors
      .join(",")
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => /^[a-z]+$/i.test(tag));
    const stripper = tags.length > 0 ? new RegExp(`<(${tags.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi") : null;
    const out = res.text().then((html) => {
      const withoutStripped = stripper ? html.replace(stripper, "") : html;
      const body = BODY_INNER.exec(withoutStripped);
      // No <body> element at all: the `body` text handler never fires, which is
      // why fetchPageBodyText can answer "" for a 200 that had content.
      const inner = body ? body[1]! : "";
      for (const { selector, handler } of textSelectors) {
        if (selector !== "body") continue;
        for (const run of inner.split(TAG)) {
          if (run === "") continue;
          // Split in two -- see this block's comment: a `text = chunk.text`
          // mutant survives a double that delivers one chunk per run.
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

// ---------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------

const GEMINI_URL_PREFIX = "https://generativelanguage.googleapis.com/v1beta/models/";

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  method: string | undefined;
  body: string | undefined;
  signal: AbortSignal | null | undefined;
}

/** A modelled reply. An Error means the fetch itself rejected (DNS, TLS, abort). */
type Reply = { status: number; body: string } | Error;

let calls: FetchCall[];
/** Per-URL reply queues, consumed in order -- so a retry can be given a DIFFERENT answer. */
let pageReplies: Map<string, Reply[]>;
let geminiReplies: Reply[];
/** Snapshot hook: run on every page fetch, used to observe the row mid-flight. */
let onPageFetch: ((url: string) => void) | null;
let logs: string[];

function html(bodyInner: string): string {
  return `<html><head><title>Never in the prompt</title></head><body>${bodyInner}</body></html>`;
}

/** Gemini's real success envelope: the JSON payload arrives as TEXT inside a part. */
function geminiOk(ai: unknown): Reply {
  return { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ai) }] } }] }) };
}

function stubFetch(): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      method: init.method,
      body: typeof init.body === "string" ? init.body : undefined,
      signal: init.signal,
    });
    const queue = url.startsWith(GEMINI_URL_PREFIX) ? geminiReplies : pageReplies.get(url);
    if (!url.startsWith(GEMINI_URL_PREFIX)) onPageFetch?.(url);
    // An unmodelled URL is a test bug, never a silent default: a fetch this
    // handler grows later must fail loudly here rather than be absorbed.
    if (!queue || queue.length === 0) throw new Error(`unmodelled fetch: ${url}`);
    const reply = queue.length === 1 ? queue[0]! : queue.shift()!;
    if (reply instanceof Error) throw reply;
    // An empty modelled body becomes a NULL body, not "": undici refuses to
    // construct a Response with any body at all for the null-body statuses
    // (204, 205, 304), and the 204 case below is the one that separates the
    // shipped `res.status !== 200` from a looser `!res.ok`. `.text()` answers
    // "" for a null body either way, so nothing else here changes.
    return new Response(reply.body === "" ? null : reply.body, { status: reply.status });
  });
}

/** Every page URL asked for, in order, Gemini excluded. */
function pageCalls(): FetchCall[] {
  return calls.filter((call) => !call.url.startsWith(GEMINI_URL_PREFIX));
}

function geminiCalls(): FetchCall[] {
  return calls.filter((call) => call.url.startsWith(GEMINI_URL_PREFIX));
}

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write: a SPACE separator, six fractional
// digits, never a "T" and never a "Z". These columns are TEXT and SQLite
// compares TEXT bytewise -- see packages/models/src/pyDatetime.ts's header for
// the two production incidents that came of getting it wrong.
const DJANGO_NOW = "2026-09-05 19:28:08.853000";
const NOW = new Date("2026-09-05T19:28:08.853Z");
const PY_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

const SALISBURY = 22;
const JOB = "3f2a8c5e-0000-4000-8000-000000000001";

// The module's PAGE_HEADERS, spelled out here rather than imported: two copies
// that agree by construction would prove nothing about either.
const BOT_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
};

const SITE = "https://salisbury.example";

interface FoodbankSeed {
  id?: number;
  slug?: string;
  name?: string;
  address?: string;
  postcode?: string;
  country?: string;
  network?: string | null;
  phone_number?: string | null;
  contact_email?: string;
  charity_number?: string | null;
  facebook_page?: string | null;
  bankuet_slug?: string | null;
  url?: string;
  shopping_list_url?: string;
  rss_url?: string | null;
  news_url?: string | null;
  donation_points_url?: string | null;
  locations_url?: string | null;
  contacts_url?: string | null;
  delivery_address?: string | null;
}

// Every URL column gets a DIFFERENT path, so "the handler read the wrong
// column" is caught by the URL assertions rather than passing on a shared
// value. Every detail column gets a value that differs from the AI fixture's
// default only where a test says so.
function seedFoodbank(seed: FoodbankSeed = {}): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       network, phone_number, contact_email, charity_number, charity_just_foodbank,
       facebook_page, bankuet_slug, url, shopping_list_url,
       rss_url, news_url, donation_points_url, locations_url, contacts_url,
       delivery_address, address_is_administrative, is_closed, no_locations,
       days_between_needs, created, modified
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '51.0688,-1.7945', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 14, ?, ?)`,
  ).run(
    seed.id ?? SALISBURY,
    `uuid-${seed.slug ?? "salisbury"}`,
    seed.name ?? "Salisbury Foodbank",
    seed.slug ?? "salisbury",
    seed.address ?? "1 Bemerton Heath",
    seed.postcode ?? "SP2 9DY",
    seed.country ?? "England",
    seed.network === undefined ? "Trussell Trust" : seed.network,
    seed.phone_number === undefined ? "01722 349556" : seed.phone_number,
    seed.contact_email ?? "info@salisbury.example",
    seed.charity_number === undefined ? "1122447" : seed.charity_number,
    seed.facebook_page === undefined ? "salisburyfoodbank" : seed.facebook_page,
    seed.bankuet_slug === undefined ? "salisbury" : seed.bankuet_slug,
    seed.url ?? `${SITE}/`,
    seed.shopping_list_url ?? `${SITE}/what-we-need/`,
    seed.rss_url === undefined ? `${SITE}/feed/` : seed.rss_url,
    seed.news_url === undefined ? `${SITE}/news/` : seed.news_url,
    seed.donation_points_url === undefined ? `${SITE}/donate-food/` : seed.donation_points_url,
    seed.locations_url === undefined ? `${SITE}/locations/` : seed.locations_url,
    seed.contacts_url === undefined ? `${SITE}/contact/` : seed.contacts_url,
    seed.delivery_address === undefined ? null : seed.delivery_address,
    DJANGO_NOW,
    DJANGO_NOW,
  );
}

function seedLocation(seed: { id: number; name: string; slug: string; address?: string | null; postcode?: string | null; foodbankId?: number }): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng, is_closed, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'England', '51.0,-1.7', 0, ?)`,
  ).run(seed.id, `loc-${seed.id}`, seed.foodbankId ?? SALISBURY, seed.name, seed.slug, seed.address === undefined ? "The Hollows" : seed.address, seed.postcode === undefined ? "SP2 0HR" : seed.postcode, DJANGO_NOW);
}

function seedDonationPoint(seed: { id: number; name: string; slug: string; address?: string; postcode?: string; foodbankId?: number }): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng, is_closed, in_store_only, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'England', '51.0,-1.7', 0, 0, ?)`,
  ).run(seed.id, `dp-${seed.id}`, seed.foodbankId ?? SALISBURY, seed.name, seed.slug, seed.address ?? "Southampton Road", seed.postcode ?? "SP1 2LB", DJANGO_NOW);
}

function seedJob(id: string = JOB, status = "queued"): void {
  db.prepare("INSERT INTO admin_job (id, kind, target, status, created) VALUES (?, 'check', 'salisbury', ?, ?)").run(id, status, DJANGO_NOW);
}

/**
 * The AI's answer, defaulting to "found exactly what we hold" so that any
 * detailChanges:true below is caused by the ONE field the test overrode.
 */
function aiResponse(overrides: Partial<FoodbankCheckAiResponse> = {}): FoodbankCheckAiResponse {
  return {
    details: {
      name: "Salisbury Foodbank",
      address: "1 Bemerton Heath",
      postcode: "SP2 9DY",
      country: "England",
      phone_number: "01722 349556",
      contact_email: "info@salisbury.example",
      network: "Trussell Trust",
      charity_number: "1122447",
      facebook_page: "salisburyfoodbank",
      bankuet_slug: "salisbury",
      rss_url: `${SITE}/feed/`,
      news_url: `${SITE}/news/`,
      donation_points_url: `${SITE}/donate-food/`,
      locations_url: `${SITE}/locations/`,
      contacts_url: `${SITE}/contact/`,
      ...(overrides.details ?? {}),
    },
    locations: overrides.locations ?? [],
    donation_points: overrides.donation_points ?? [],
  };
}

/** All five pages answer 200 with an identifiable body. */
function stubAllPages(): void {
  pageReplies.set(`${SITE}/`, [{ status: 200, body: html("HOMEPAGE") }]);
  pageReplies.set(`${SITE}/what-we-need/`, [{ status: 200, body: html("SHOPPING") }]);
  pageReplies.set(`${SITE}/locations/`, [{ status: 200, body: html("LOCATIONS") }]);
  pageReplies.set(`${SITE}/contact/`, [{ status: 200, body: html("CONTACTS") }]);
  pageReplies.set(`${SITE}/donate-food/`, [{ status: 200, body: html("DONATIONPOINTS") }]);
}

// ===========================================================================
// RUNNING
// ===========================================================================

let env: Env;
/** The bookmark mode each DB.withSession() was asked for, in order. */
let sessionModes: string[];

/**
 * The Env this handler is given. withSession RECORDS its mode rather than
 * ignoring it -- notify/needFirebase.test.ts:515 and adminJobs/orderLines.ts's
 * own suite both pin theirs the same way, because the mode is invisible in the
 * shipped behaviour and is exactly the sort of argument a tidy-up drops.
 */
function testEnv(hooks: { failOn?: RegExp; failWith?: unknown } = {}): Env {
  return {
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session(hooks);
      },
    },
    GEMINI_API_KEY: "test-gemini-key",
  } as unknown as Env;
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Run the handler to completion, advancing the fake clock ONLY while it is
 * genuinely parked on a timer. Two sleeps live on this path -- the 750ms
 * anti-bot backoff in fetchPageBodyText and geminiJsonCall's 60s ServerError
 * retry -- and waiting out the second for real would cost a minute per test.
 * The conditional advance keeps every timestamp in the happy-path tests frozen
 * at NOW, which is what makes the exact `created`/`finished` assertions possible.
 */
async function runJob(jobId: string = JOB, slug = "salisbury"): Promise<void> {
  let settled = false;
  const promise = handleFoodbankCheckJob(env, jobId, slug).finally(() => {
    settled = true;
  });
  for (let guard = 0; guard < 200 && !settled; guard++) {
    await tick();
    if (!settled && vi.getTimerCount() > 0) await vi.advanceTimersByTimeAsync(61_000);
  }
  return promise;
}

interface JobRow {
  id: string;
  kind: string;
  target: string | null;
  status: string;
  result: string | null;
  error: string | null;
  created: string;
  finished: string | null;
}

function jobRow(id: string = JOB): JobRow | undefined {
  return db.prepare("SELECT * FROM admin_job WHERE id = ?").get(id) as unknown as JobRow | undefined;
}

/** The payload markAdminJobDone stringified onto the row, parsed back. */
function storedResult(id: string = JOB): FoodbankCheckResult {
  const row = jobRow(id);
  if (!row?.result) throw new Error(`job ${id} has no stored result (status ${row?.status ?? "missing"}, error ${row?.error ?? "none"})`);
  return JSON.parse(row.result) as FoodbankCheckResult;
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(MIGRATIONS_SQL);

  calls = [];
  pageReplies = new Map();
  geminiReplies = [];
  onPageFetch = null;
  logs = [];
  rewriterSelectors = [];
  rewriterRemovals = [];
  sessionModes = [];

  stubFetch();
  vi.stubGlobal("HTMLRewriter", FakeHTMLRewriter);
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));

  env = testEnv();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

// ===========================================================================
// THE JOB ROW -- the only place a failure can ever be seen
// ===========================================================================
describe("the admin_job row", () => {
  beforeEach(() => {
    seedFoodbank();
    seedJob();
    stubAllPages();
    geminiReplies = [geminiOk(aiResponse())];
  });

  // The three writes this handler makes to its own row, in the order the
  // polling page depends on. `finished` is stamped by markAdminJobDone with
  // pyNow(), never toISOString(): getAdminJobCounts compares `finished` against
  // a Django-format threshold (adminJobs.ts:86-97) and an ISO value sorts after
  // every same-day Django one, which is how the dashboard silently dropped 31
  // of 46 rows before pyDatetime.ts existed.
  it("finishes the job as done, with a result and a Django-format finished stamp", async () => {
    await runJob();

    const row = jobRow()!;
    expect(row.status).toBe("done");
    expect(row.error).toBeNull();
    expect(row.finished).toBe(DJANGO_NOW);
    expect(row.finished).not.toContain("T");
    expect(row.result).not.toBeNull();
    // Untouched by this handler -- it identifies the row, it is not its output.
    expect(row.kind).toBe("check");
    expect(row.target).toBe("salisbury");
    expect(row.created).toBe(DJANGO_NOW);
  });

  // markAdminJobRunning is the FIRST statement, before the food bank lookup and
  // before five scrapes plus a Gemini call that together take tens of seconds.
  // foodbank_check.njk:44-48 prints the status word LITERALLY inside its
  // spinner, so if this moved below the work the admin would be told "queued"
  // -- nothing has picked this up yet -- for the entire run, and the two states
  // a stuck job can be in would become indistinguishable from the page.
  it("marks the job running before it touches the network", async () => {
    const seen: string[] = [];
    onPageFetch = () => void seen.push(jobRow()!.status);

    await runJob();

    expect(seen).toEqual(["running", "running", "running", "running", "running"]);
  });

  // ONE session, opened "first-unconstrained", for the whole run -- the mode
  // every consumer in workers/jobs opens (notify/needEmail.ts:60,
  // queues/articles.ts:47, adminJobs/orderLines.ts:100), and the reason
  // packages/db takes a Session rather than the D1Database: the run's reads
  // and its five crawlitem writes and three admin_job UPDATEs share one
  // bookmark chain, so a read never lands behind a write this same run made.
  //
  // MUTANT THIS KILLS: `withSession("first-primary")`, and a second
  // `env.DB.withSession(...)` opened further down. Neither changes a single
  // row in this suite -- the mode is invisible in behaviour and only an
  // explicit assertion stops it being tidied away. Pinned the same way
  // notify/needFirebase.test.ts:515 pins its own.
  it("opens exactly one first-unconstrained session for the whole run", async () => {
    await runJob();

    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // THE CONSUMER CONTRACT. queues/jobs.ts:37-46 does not wrap this call in
  // anything of its own beyond the batch-level try: its comment says the
  // handler "catches its own errors and records them on the admin_job row
  // rather than throwing", because a retry would re-run the same paid Gemini
  // call against the same failure. A throw escaping here means message.retry()
  // and, after max_retries: 3, the jobs-dlq -- which is the queue nobody was
  // watching in this tier's founding incident.
  it("never throws for an unknown food bank -- it records the failure on the row", async () => {
    await expect(runJob(JOB, "nowhere")).resolves.toBeUndefined();

    const row = jobRow()!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("no such foodbank: nowhere");
    expect(row.result).toBeNull();
    expect(row.finished).toBe(DJANGO_NOW);
    // And nothing was spent: no scrape, no Gemini call, no crawl bookkeeping.
    expect(calls).toEqual([]);
    expect(crawlItems()).toEqual([]);
  });

  // A D1 blip halfway through. The row still has to end up readable: Re-run
  // lives in foodbank_check.njk's done branch (:63) and Retry in its failed
  // branch (:53), so a job stuck at "running" gets NEITHER -- just the 2s poll,
  // forever, with no way back to the button that started it.
  it("records a mid-run database failure as failed rather than leaving the job running", async () => {
    env = testEnv({ failOn: /INSERT INTO crawlitem/ });

    await expect(runJob()).resolves.toBeUndefined();

    const row = jobRow()!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("D1_ERROR: Network connection lost");
  });

  // The `String(err)` half of `err instanceof Error ? err.message : String(err)`.
  // Nothing in the module throws a non-Error today, but the fallback is there
  // and a `throw "..."` anywhere downstream must still leave a readable row
  // rather than the word "undefined".
  it("stringifies a thrown non-Error into the error column", async () => {
    env = testEnv({ failOn: /INSERT INTO crawlitem/, failWith: "sqlite exploded" });

    await runJob();

    expect(jobRow()!.error).toBe("sqlite exploded");
  });

  // SUSPECT (reported, not fixed). markAdminJobRunning/Done are plain UPDATEs
  // matched on id, so a message naming a job id that is not in the table -- a
  // row deleted, or a hand-crafted queue message -- runs the ENTIRE scrape and
  // pays for the Gemini call, then writes the result to nowhere and returns
  // successfully. Nothing raises, nothing is logged, and the queue acks. Pinned
  // as it stands.
  it("does the whole run and spends the Gemini call even when the job id does not exist", async () => {
    await runJob("no-such-job");

    expect(jobRow("no-such-job")).toBeUndefined();
    expect(pageCalls()).toHaveLength(5);
    expect(geminiCalls()).toHaveLength(1);
    // The crawl bookkeeping IS written, so the only trace of the wasted run is
    // five crawlitem rows with no job to explain them.
    expect(crawlItems()).toHaveLength(5);
  });

  // Cloudflare Queues is at-least-once, so the same tick can arrive twice.
  // markAdminJobDone overwrites cleanly -- but nothing else does: the second
  // delivery re-scrapes all five pages, pays for a second Gemini call, and
  // appends five MORE crawlitem rows. Pinned as it stands and reported: an
  // idempotent consumer would short-circuit on a job already "done".
  it("is idempotent on the job row but NOT on crawlitem or on spend when redelivered", async () => {
    geminiReplies = [geminiOk(aiResponse())];
    await runJob();
    const firstResult = jobRow()!.result;

    await runJob();

    expect(jobRow()!.status).toBe("done");
    expect(jobRow()!.result).toBe(firstResult);
    expect(crawlItems()).toHaveLength(10);
    expect(geminiCalls()).toHaveLength(2);
  });
});

// ===========================================================================
// WHICH PAGES GET FETCHED
// ===========================================================================
describe("the five candidate pages", () => {
  beforeEach(() => {
    seedFoodbank();
    seedJob();
    stubAllPages();
    geminiReplies = [geminiOk(aiResponse())];
  });

  // views.py:933-993's order, which is also the order the prompt lists them in
  // and the order the check page's preview tabs appear in. Asserted as the
  // exact URL sequence: five separate columns, five different paths, so a
  // handler reading the wrong column cannot pass this by coincidence.
  it("fetches the five URLs Django fetches, in Django's order", async () => {
    await runJob();

    expect(pageCalls().map((call) => call.url)).toEqual([`${SITE}/`, `${SITE}/what-we-need/`, `${SITE}/locations/`, `${SITE}/contact/`, `${SITE}/donate-food/`]);
  });

  // The bot-protection headers routes/admin/proxy.ts's fetchPreview sends, and
  // for the reason the module's header gives: several food bank sites 403 a
  // bot-UA request with no Accept header. A dropped Accept header here does not
  // fail anything -- it just quietly turns real pages into "not found" and
  // makes the AI comparison worthless.
  it("sends the bot User-Agent and the Accept headers on every page fetch", async () => {
    await runJob();

    for (const call of pageCalls()) {
      expect(call.headers).toEqual(BOT_HEADERS);
    }
  });

  // views.py:910-913's url_blacklist, applied at :937. A Facebook or Bank the Food shopping list
  // is a JS app that returns nothing useful to a plain GET, so Django skips it
  // -- and skipping means the page is reported to the model as "None", not
  // fetched and found empty.
  it.each([
    ["facebook.com", "https://www.facebook.com/salisburyfoodbank"],
    ["bankthefood.org", "https://bankthefood.org/foodbank/1234"],
  ])("never fetches a %s shopping list", async (_label, shoppingListUrl) => {
    db.exec("DELETE FROM foodbank");
    seedFoodbank({ shopping_list_url: shoppingListUrl });

    await runJob();

    expect(pageCalls().map((call) => call.url)).not.toContain(shoppingListUrl);
    expect(pageCalls()).toHaveLength(4);
    expect(storedResult().fetchedPages.map((page) => page.name)).toEqual(["homepage", "locations", "contacts", "donation_points"]);
    // Reported to the model as absent, in the shopping_list slot.
    expect(storedResult().prompt).toContain("shopping_list...\nNone\n\n");
  });

  // A blacklist that matched only a whole URL, or only a host, would miss this.
  // Django's test is `x not in url` -- a plain substring anywhere.
  it("matches the blacklist as a substring anywhere in the URL", async () => {
    db.exec("DELETE FROM foodbank");
    seedFoodbank({ shopping_list_url: `${SITE}/redirect?to=facebook.com/salisburyfoodbank` });

    await runJob();

    expect(pageCalls()).toHaveLength(4);
  });

  // The four optional URL columns are nullable in production (0001_core.sql), so
  // a food bank with no locations page must skip that fetch entirely -- no
  // request, no crawlitem row, no fetchedPages entry -- and still hand the model
  // a "None" placeholder in the right slot so the pages arrive in a fixed order.
  it("skips a null URL entirely rather than fetching an empty string", async () => {
    db.exec("DELETE FROM foodbank");
    seedFoodbank({ locations_url: null, contacts_url: null, donation_points_url: null });

    await runJob();

    expect(pageCalls().map((call) => call.url)).toEqual([`${SITE}/`, `${SITE}/what-we-need/`]);
    expect(crawlItems()).toHaveLength(2);
    expect(storedResult().fetchedPages.map((page) => page.name)).toEqual(["homepage", "shopping_list"]);
    expect(storedResult().prompt).toContain("locations...\nNone\n\ncontacts...\nNone\n\ndonation_points...\nNone\n\n");
  });

  // `url` and `shopping_list_url` are NOT NULL in production but can hold "",
  // which is falsy and takes the same skip branch. Worth pinning separately
  // because a `!== null` test would let "" through and fetch the Worker's own
  // origin.
  it("treats an empty-string URL as absent", async () => {
    db.exec("DELETE FROM foodbank");
    seedFoodbank({ url: "", shopping_list_url: "" });

    await runJob();

    expect(pageCalls().map((call) => call.url)).toEqual([`${SITE}/locations/`, `${SITE}/contact/`, `${SITE}/donate-food/`]);
    expect(storedResult().fetchedPages.map((page) => page.name)).toEqual(["locations", "contacts", "donation_points"]);
  });

  // proxyField is the seam between this Worker and WP 6.3's proxy allowlist:
  // the check page's preview iframes ask /admin/proxy/ for THESE field names
  // (lib/adminFormFields.ts's url-kind FOODBANK_FIELDS), and proxy.ts 400s
  // anything else. A name renamed here renders five previews that all fail.
  it("labels each page with the proxy field name routes/admin/proxy.ts accepts", async () => {
    await runJob();

    expect(storedResult().fetchedPages).toEqual([
      { name: "homepage", url: `${SITE}/`, found: true, proxyField: "url" },
      { name: "shopping_list", url: `${SITE}/what-we-need/`, found: true, proxyField: "shopping_list_url" },
      { name: "locations", url: `${SITE}/locations/`, found: true, proxyField: "locations_url" },
      { name: "contacts", url: `${SITE}/contact/`, found: true, proxyField: "contacts_url" },
      { name: "donation_points", url: `${SITE}/donate-food/`, found: true, proxyField: "donation_points_url" },
    ]);
  });

  // DIVERGENCE FROM DJANGO, pinned as it stands. views.py:918-929's fetch_page
  // memoises by URL in `downloaded_pages`, so a food bank whose contacts page
  // IS its homepage is downloaded once and gets ONE CrawlItem. The port has no
  // such cache: it fetches per candidate. That is a second request to the same
  // site inside one run (which is what bot protection counts) and a duplicated
  // crawlitem row.
  it("fetches a URL twice when two fields hold the same one, unlike Django's cache", async () => {
    db.exec("DELETE FROM foodbank");
    seedFoodbank({ contacts_url: `${SITE}/` });

    await runJob();

    expect(pageCalls().filter((call) => call.url === `${SITE}/`)).toHaveLength(2);
    expect(crawlItems().filter((item) => item.url === `${SITE}/`)).toHaveLength(2);
  });
});

// ===========================================================================
// fetchPageBodyText -- the quiet failure the module's own header names
// ===========================================================================
describe("fetching one page", () => {
  beforeEach(() => {
    // One candidate page only, so "which reply belonged to which fetch" is
    // never ambiguous. The other four columns are null.
    seedFoodbank({ shopping_list_url: "", locations_url: null, contacts_url: null, donation_points_url: null });
    seedJob();
    geminiReplies = [geminiOk(aiResponse())];
  });

  const HOME = `${SITE}/`;

  it("puts a 200 page's body text into the prompt and marks it found", async () => {
    pageReplies.set(HOME, [{ status: 200, body: html("\n  <h1>Salisbury Foodbank</h1>\n  <p>Call 01722 349556</p>\n") }]);

    await runJob();

    expect(storedResult().fetchedPages[0]!.found).toBe(true);
    // Text nodes concatenated in document order with no separator, exactly as
    // BeautifulSoup's soup.body.get_text() does -- markup gone, <title> (which
    // is outside <body>) never included.
    expect(storedResult().prompt).toContain("homepage...\n\n  Salisbury Foodbank\n  Call 01722 349556\n\n\n");
    expect(storedResult().prompt).not.toContain("Never in the prompt");
  });

  // The remove-set is Django's htmlbodytext() decompose list verbatim
  // (views.py's BeautifulSoup call, transcribed into the module's header), and
  // the text-set is `body` alone. Asserted as the registered selectors rather
  // than as extracted text, because whether workerd's body handler still sees a
  // removed subtree's text is unresolved -- see this file's header.
  it("registers Django's decompose set for removal and reads text from body only", async () => {
    pageReplies.set(HOME, [{ status: 200, body: html("hello") }]);

    await runJob();

    expect(rewriterSelectors).toEqual(["svg, style, script, iframe, canvas", "body"]);
    // ...and the element handler actually REMOVES what it is handed. The
    // double records real remove() calls (see its comment); registering the
    // selector is not the same claim as decomposing the element, and
    // `element(el) { void el; }` -- which reads as a perfectly sensible
    // no-op refactor -- passed every other test in this file, sending each
    // page's CSS and JavaScript to Gemini as prose.
    expect(rewriterRemovals).toEqual(["svg, style, script, iframe, canvas"]);
  });

  // The accumulator. HTMLRewriter delivers a text node in as many chunks as the
  // stream happens to break it into, so `text = chunk.text` would silently keep
  // only the last fragment of every page. The double splits every run in two on
  // purpose to make that mutant fail here.
  it("concatenates every text chunk rather than keeping the last", async () => {
    pageReplies.set(HOME, [{ status: 200, body: html("A very long sentence that the double will hand over in two pieces.") }]);

    await runJob();

    expect(storedResult().prompt).toContain("A very long sentence that the double will hand over in two pieces.");
  });

  // A 200 with no <body> element yields "" -- which is NOT null, so the page is
  // still reported as found. Pinned because "found" and "had content" are
  // different claims and the check page only shows the first.
  it("reports an empty extraction as found, not as missing", async () => {
    pageReplies.set(HOME, [{ status: 200, body: "<p>no body element at all</p>" }]);

    await runJob();

    expect(storedResult().fetchedPages[0]!.found).toBe(true);
    expect(storedResult().prompt).toContain("homepage...\n\n\n");
  });

  // THE CENTRAL QUIET FAILURE. A non-200 comes back as null, which reaches the
  // model and the admin as the word "None" -- indistinguishable from a page
  // that does not exist. The console line is the ONLY thing that tells the two
  // apart, which is why its content is asserted and not just its existence.
  it("logs the status and reports not-found on a non-200", async () => {
    pageReplies.set(HOME, [{ status: 404, body: "gone" }]);

    await runJob();

    expect(storedResult().fetchedPages[0]!.found).toBe(false);
    expect(storedResult().prompt).toContain("homepage...\nNone\n\n");
    expect(logs).toEqual([`foodbank-check: ${HOME} returned 404, treating the page as not found`]);
  });

  // The test is `res.status !== 200` and nothing looser. A 2xx that is not 200
  // is not a page: a 204 has no body at all and a 202 is "we have not made it
  // yet", both of which several CMS-fronted food bank sites answer for a URL
  // that no longer resolves.
  //
  // MUTANT THIS KILLS: `if (!res.ok)`, the obvious tidy-up. It reads a 204 as
  // a successfully-fetched EMPTY page -- so the model is shown a blank block
  // instead of the honest "None", the check page says found, and the one
  // console line that would have told an admin the page was unreadable is
  // never written. Every existing status test used a 4xx or a 5xx, which
  // `!res.ok` gets right, so this is the only shape that separates them.
  it.each([201, 202, 204, 206])("treats a %i as not found, exactly as it treats an error status", async (status) => {
    pageReplies.set(HOME, [{ status, body: "" }]);

    await runJob();

    expect(storedResult().fetchedPages[0]!.found).toBe(false);
    expect(storedResult().prompt).toContain("homepage...\nNone\n\n");
    expect(logs).toEqual([`foodbank-check: ${HOME} returned ${status}, treating the page as not found`]);
  });

  // views.py:918-929 stamps the CrawlItem either side of the request whatever
  // it returns, so a run of 403s still leaves a trail. Losing that would make
  // "this food bank blocks us" invisible in the crawl history as well as on the
  // page.
  it("still records the crawl when the page could not be read", async () => {
    pageReplies.set(HOME, [{ status: 500, body: "" }]);

    await runJob();

    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]!.url).toBe(HOME);
  });

  // The one-shot retry, and its exact trigger set. 403 and 429 are the two
  // statuses Cloudflare-fronted sites use to bounce a bot-UA request that a
  // second attempt often gets through.
  it.each([403, 429])("retries once on a %i and uses the second answer", async (status) => {
    pageReplies.set(HOME, [{ status, body: "blocked" }, { status: 200, body: html("SECOND ATTEMPT") }]);

    await runJob();

    expect(pageCalls()).toHaveLength(2);
    // BOTH attempts carry the WHOLE header set, not just the User-Agent.
    // MUTANT THIS KILLS: the retry re-fetching with `{ "User-Agent": ... }`
    // alone. The Accept header is half of why the retry gets through at all
    // (the module's header comment: several sites 403 a bot-UA request with no
    // Accept header), so a retry that drops it is a retry that reliably fails
    // -- and a failed retry is silent, by exactly the route this whole file is
    // about. Asserting `[1].headers["User-Agent"]` alone let that pass.
    expect(pageCalls().map((call) => call.headers)).toEqual([BOT_HEADERS, BOT_HEADERS]);
    expect(storedResult().fetchedPages[0]!.found).toBe(true);
    expect(storedResult().prompt).toContain("SECOND ATTEMPT");
    // The first attempt's status is never logged -- only the final one is, and
    // this run ended 200, so nothing is logged at all.
    expect(logs).toEqual([]);
  });

  // The backoff itself: 750ms, and AWAITED. Neither is observable in any row
  // this handler writes, so without this test three separate careless edits
  // are free -- deleting the sleep, shortening it, and `void new Promise(...)`
  // instead of `await`. All three turn the one-shot retry into a second
  // request fired at the same instant as the first, which is precisely what
  // the bot protection in front of these sites is counting.
  //
  // The delay is read off a setTimeout spy because a faked timer leaves no
  // other trace; the ordering half is read off the CLOCK, because runJob only
  // advances time while the handler is genuinely parked on a timer, so a
  // second attempt that did not wait is stamped at the same instant as the
  // first. AbortSignal.timeout does not appear in the spy: it is built on
  // node's internal timer, not this global (see the 20s/120s test).
  it("waits 750ms before the retry, and waits for it", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clock: number[] = [];
    onPageFetch = () => void clock.push(Date.now());
    pageReplies.set(HOME, [{ status: 403, body: "blocked" }, { status: 200, body: html("SECOND ATTEMPT") }]);

    await runJob();

    expect(timers.mock.calls.map((call) => call[1])).toEqual([750]);
    expect(clock).toHaveLength(2);
    expect(clock[1]!).toBeGreaterThan(clock[0]!);
  });

  // A retry that is also refused. Two requests, then null -- it does not loop.
  it("gives up after one retry when the second attempt is refused too", async () => {
    pageReplies.set(HOME, [{ status: 403, body: "blocked" }, { status: 403, body: "blocked" }]);

    await runJob();

    expect(pageCalls()).toHaveLength(2);
    expect(storedResult().fetchedPages[0]!.found).toBe(false);
    expect(logs).toEqual([`foodbank-check: ${HOME} returned 403, treating the page as not found`]);
  });

  // Only 403 and 429. A 500 or a 503 is the site being broken, not the site
  // blocking us, and hammering it again 750ms later helps nobody -- so the
  // retry must not widen to "any error status".
  it.each([500, 502, 503, 404, 401])("does not retry a %i", async (status) => {
    pageReplies.set(HOME, [{ status, body: "" }]);

    await runJob();

    expect(pageCalls()).toHaveLength(1);
  });

  // A rejected fetch -- DNS failure, TLS failure, or the 20s AbortSignal firing
  // -- is swallowed with no log line at all. That asymmetry with the non-200
  // path is deliberate in the code but it is also the state in which a food
  // bank's dead domain leaves NO trace anywhere except a found:false, so it is
  // pinned rather than assumed.
  it("swallows a rejected fetch silently, with no log line", async () => {
    pageReplies.set(HOME, [new TypeError("fetch failed")]);

    await runJob();

    expect(pageCalls()).toHaveLength(1);
    expect(storedResult().fetchedPages[0]!.found).toBe(false);
    expect(logs).toEqual([]);
  });

  // The rejection is caught around BOTH attempts, so a 403 followed by a
  // network failure is still a clean null rather than an escaping throw that
  // would fail the whole job.
  it("swallows a rejection on the retry attempt too", async () => {
    pageReplies.set(HOME, [{ status: 403, body: "" }, new TypeError("fetch failed")]);

    await runJob();

    expect(pageCalls()).toHaveLength(2);
    expect(jobRow()!.status).toBe("done");
    expect(storedResult().fetchedPages[0]!.found).toBe(false);
  });

  // Each request carries its own abort, and the two budgets differ on purpose:
  // 20s for a food bank's own page (views.py:908's timeout_sec = 20) and 120s
  // for Gemini, which is doing real work. Without them a server that accepts
  // the connection and never answers holds the queue consumer open until the
  // Worker's own limit kills it -- and a killed consumer leaves the job at
  // "running" forever, which is a spinner no admin can clear.
  //
  // Asserted through AbortSignal.timeout's argument rather than by waiting one
  // out: the signal is created by node's internal timer, not the global
  // setTimeout this suite fakes, so a real 20s wall-clock wait is the only
  // other way to observe it.
  it("bounds each page fetch at 20s and the Gemini call at 120s", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    pageReplies.set(HOME, [{ status: 403, body: "" }, { status: 200, body: html("x") }]);

    await runJob();

    // Two page attempts (the 403 and its retry) plus the one Gemini call.
    expect(timeout.mock.calls.map((call) => call[0])).toEqual([20_000, 20_000, 120_000]);
    expect(pageCalls()[0]).toHaveProperty("signal");
    expect(pageCalls()[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});

// ===========================================================================
// crawlitem -- the crawl history Django writes and nothing else does
// ===========================================================================
describe("crawl bookkeeping", () => {
  beforeEach(() => {
    seedFoodbank();
    seedJob();
    stubAllPages();
    geminiReplies = [geminiOk(aiResponse())];
  });

  // views.py:918-929's CrawlItem, with the port's stated choices: crawl_type
  // "check" and NO crawl_set (Django never groups check-crawls into a
  // CrawlSet). crawl_set_id NULL also matters at the schema level -- migration
  // 0008's crawlitem_crawlset_foodbank_uniq is UNIQUE on
  // (crawl_set_id, foodbank_id), and only SQLite treating NULLs as distinct
  // lets five rows for one food bank coexist.
  it("writes one 'check' row per fetched page, unattached to any crawl set", async () => {
    await runJob();

    const items = crawlItems();
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.url)).toEqual([`${SITE}/`, `${SITE}/what-we-need/`, `${SITE}/locations/`, `${SITE}/contact/`, `${SITE}/donate-food/`]);
    for (const item of items) {
      expect(item.crawl_type).toBe("check");
      expect(item.crawl_set_id).toBeNull();
      expect(item.need_id).toBeNull();
      expect(item.foodbank_id).toBe(SALISBURY);
    }
  });

  // start and finish are pyNow() either side of the fetch. A `finish IS NULL`
  // row is how 0008's comment says a stalled crawl is detected, so a check
  // crawl must never leave one behind -- and both must be Django-format, since
  // crawlitem_foodbank_finish_idx orders on `finish` as TEXT and an ISO value
  // sorts after every same-day Django one.
  //
  // The clock is pushed on by two seconds INSIDE each fetch, so start and
  // finish are genuinely different instants. With a frozen clock they are the
  // same string and binding them the wrong way round is invisible -- that
  // mutant survived an earlier version of this test.
  it("stamps start before finish, in Django's datetime format, never ISO", async () => {
    onPageFetch = () => void vi.setSystemTime(new Date(Date.now() + 2_000));

    await runJob();

    const items = crawlItems();
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item.start).toMatch(PY_DATETIME);
      expect(item.finish).toMatch(PY_DATETIME);
      expect(item.start < item.finish!).toBe(true);
    }
    // The first row's pair, spelled out: two seconds apart and in that order.
    expect(items[0]!.start).toBe(DJANGO_NOW);
    expect(items[0]!.finish).toBe("2026-09-05 19:28:10.853000");
  });

  // The row belongs to the food bank the message named, resolved through the
  // slug. A crawl history attributed to the wrong food bank is worse than none:
  // needcheck's own dashboards read this table by foodbank_id.
  it("attributes the crawl to the food bank the slug resolved to, not to row one", async () => {
    seedFoodbank({ id: 91, slug: "oxford", name: "Oxford Foodbank", url: "https://oxford.example/", shopping_list_url: "", locations_url: null, contacts_url: null, donation_points_url: null });
    pageReplies.set("https://oxford.example/", [{ status: 200, body: html("OXFORD") }]);
    db.prepare("INSERT INTO admin_job (id, kind, target, status, created) VALUES ('oxford-job', 'check', 'oxford', 'queued', ?)").run(DJANGO_NOW);

    await runJob("oxford-job", "oxford");

    expect(crawlItems()).toHaveLength(1);
    expect(crawlItems()[0]!.foodbank_id).toBe(91);
  });
});

// ===========================================================================
// THE PROMPT -- what the model is actually shown
// ===========================================================================
describe("the prompt", () => {
  beforeEach(() => {
    seedFoodbank();
    seedLocation({ id: 2, name: "Wilton", slug: "wilton", postcode: "SP2 0HR" });
    seedLocation({ id: 1, name: "Amesbury", slug: "amesbury", address: "Church Street", postcode: "SP4 7DL" });
    seedDonationPoint({ id: 5, name: "Tesco Southampton Road", slug: "tesco", postcode: "SP1 2LB" });
    seedJob();
    stubAllPages();
    geminiReplies = [geminiOk(aiResponse())];
  });

  /** The JSON block buildCheckPrompt embeds, parsed back out of the prompt. */
  function embeddedJson(prompt: string): { details: Record<string, string | null>; locations: unknown[]; donation_points: unknown[] } {
    const start = prompt.indexOf("{\n");
    const end = prompt.indexOf("\n}\n", start) + 2;
    return JSON.parse(prompt.slice(start, end)) as { details: Record<string, string | null>; locations: unknown[]; donation_points: unknown[] };
  }

  // views.py:867-885's foodbank_json["details"] -- the same fifteen keys in the
  // same order. This block is the model's entire picture of what we already
  // hold; a dropped key is a field the model is never asked to confirm, and the
  // check page then reports "no change" on it forever.
  it("shows the model Django's fifteen detail fields, in Django's order", async () => {
    await runJob();

    expect(Object.keys(embeddedJson(storedResult().prompt).details)).toEqual([
      "name",
      "address",
      "postcode",
      "country",
      "phone_number",
      "contact_email",
      "network",
      "charity_number",
      "facebook_page",
      "bankuet_slug",
      "rss_url",
      "news_url",
      "donation_points_url",
      "locations_url",
      "contacts_url",
    ]);
  });

  it("shows the model our stored values, straight off the row", async () => {
    await runJob();

    expect(embeddedJson(storedResult().prompt).details).toEqual({
      name: "Salisbury Foodbank",
      address: "1 Bemerton Heath",
      postcode: "SP2 9DY",
      country: "England",
      phone_number: "01722 349556",
      contact_email: "info@salisbury.example",
      network: "Trussell Trust",
      charity_number: "1122447",
      facebook_page: "salisburyfoodbank",
      bankuet_slug: "salisbury",
      rss_url: `${SITE}/feed/`,
      news_url: `${SITE}/news/`,
      donation_points_url: `${SITE}/donate-food/`,
      locations_url: `${SITE}/locations/`,
      contacts_url: `${SITE}/contact/`,
    });
  });

  // DIVERGENCE FROM DJANGO, pinned as it stands. views.py:886-902 puts `slug`
  // into every location and donation point it shows the model; the port sends
  // name/address/postcode only. Harmless for the comparison (which is done on
  // postcode) but it is a real difference in what the model reads, so it is
  // measured rather than assumed away.
  it("lists our locations and donation points as name/address/postcode -- no slug, unlike Django", async () => {
    await runJob();

    const json = embeddedJson(storedResult().prompt);
    expect(json.locations).toEqual([
      { name: "Amesbury", address: "Church Street", postcode: "SP4 7DL" },
      { name: "Wilton", address: "The Hollows", postcode: "SP2 0HR" },
    ]);
    expect(json.donation_points).toEqual([{ name: "Tesco Southampton Road", address: "Southampton Road", postcode: "SP1 2LB" }]);
  });

  // getLocationsByFoodbankId sorts by name (Django's
  // `.order_by("name")`, foodbank.py:546). Seeded id-descending on purpose:
  // Wilton is id 2 and Amesbury id 1, so insertion order and id order both
  // disagree with the answer, and a lost sort shows up here rather than as a
  // subtly differently-ordered prompt nobody reads.
  it("lists locations alphabetically, not in row order", async () => {
    await runJob();

    expect((embeddedJson(storedResult().prompt).locations as { name: string }[]).map((location) => location.name)).toEqual(["Amesbury", "Wilton"]);
  });

  // The five pages arrive in a fixed order under fixed headings, whether or not
  // they were fetched. The model is told which page each block came from, so a
  // reordering would attribute a contacts page's phone number to the homepage.
  it("labels the five page blocks in order, with None for the ones not read", async () => {
    pageReplies.set(`${SITE}/contact/`, [{ status: 404, body: "" }]);

    await runJob();

    const pages = storedResult().prompt.split("Using these webpages downloaded from the food bank's website...\n\n")[1]!;
    expect(pages).toBe(
      "homepage...\nHOMEPAGE\n\n" + "shopping_list...\nSHOPPING\n\n" + "locations...\nLOCATIONS\n\n" + "contacts...\nNone\n\n" + "donation_points...\nDONATIONPOINTS\n\n",
    );
  });

  it("names the food bank in the instruction line", async () => {
    await runJob();

    expect(storedResult().prompt).toContain("charity number, locations and donation points for Salisbury Foodbank.");
  });

  // The prompt handed to Gemini and the prompt stored on the row must be ONE
  // string. `?debug=prompt` on the check page prints the stored copy, and a
  // reviewer debugging a bad answer against a prompt that was not the one sent
  // is looking at the wrong evidence.
  it("stores exactly the prompt it sent", async () => {
    await runJob();

    const sent = JSON.parse(geminiCalls()[0]!.body!) as { contents: { parts: { text: string }[] }[] };
    expect(sent.contents[0]!.parts[0]!.text).toBe(storedResult().prompt);
  });
});

// ===========================================================================
// THE GEMINI CALL
// ===========================================================================
describe("the Gemini call", () => {
  beforeEach(() => {
    seedFoodbank();
    seedJob();
    stubAllPages();
  });

  // ai.py's gemini() call at views.py:1143-1149: gemini-2.5-flash, temperature
  // 0, JSON mime type, and FOODBANK_CHECK_RESPONSE_SCHEMA. Temperature 0 is not
  // cosmetic -- this is a data-entry comparison, and a non-zero temperature
  // makes two runs of the same unchanged page disagree, which reads to the
  // admin as a change that is not there.
  it("asks gemini-2.5-flash at temperature 0 with the transcribed response schema", async () => {
    geminiReplies = [geminiOk(aiResponse())];

    await runJob();

    expect(geminiCalls()).toHaveLength(1);
    expect(geminiCalls()[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=test-gemini-key");
    const body = JSON.parse(geminiCalls()[0]!.body!) as { generationConfig: { temperature: number; responseMimeType: string; responseSchema: unknown } };
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual(FOODBANK_CHECK_RESPONSE_SCHEMA);
  });

  // THE FOUNDING INCIDENT'S SHAPE FOR THIS HANDLER. A missing or revoked
  // GEMINI_API_KEY is a 4xx from Google, which geminiJsonCall turns into a
  // throw, which this handler records as a failed job. Nothing else anywhere
  // says so -- so this test is the claim that the failure at least reaches the
  // one row an admin can look at, with Google's own message intact.
  it("records the API's own message on the row when the key is rejected", async () => {
    geminiReplies = [{ status: 400, body: '{"error":{"message":"API key not valid"}}' }];

    await runJob();

    const row = jobRow()!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe('Gemini API error: 400 {"error":{"message":"API key not valid"}}');
    expect(row.result).toBeNull();
    // The scrape still happened and is still on the record: a re-run does not
    // need to guess which pages were reachable.
    expect(crawlItems()).toHaveLength(5);
  });

  // ai.py:59-65's ServerError retry, exercised through this handler because the
  // 60s sleep is the reason it lives on a queue at all. Two calls, then the
  // second answer is used -- so a transient 503 from Google costs a minute, not
  // a failed check the admin has to notice and re-run.
  it("survives one 5xx from Google by retrying, and uses the second answer", async () => {
    geminiReplies = [{ status: 503, body: "unavailable" }, geminiOk(aiResponse({ details: { charity_number: "9999999" } as never }))];

    await runJob();

    expect(geminiCalls()).toHaveLength(2);
    expect(jobRow()!.status).toBe("done");
    expect(storedResult().aiResponse.details.charity_number).toBe("9999999");
  });

  it("fails the job when both Gemini attempts 5xx", async () => {
    geminiReplies = [{ status: 500, body: "boom" }, { status: 500, body: "boom" }];

    await runJob();

    expect(geminiCalls()).toHaveLength(2);
    expect(jobRow()!.status).toBe("failed");
    expect(jobRow()!.error).toBe("Gemini server error: 500 boom");
  });

  // A 200 whose JSON is not the shape the handler destructures. `details` is
  // read with Object.keys() immediately, so a missing one throws -- and the
  // point of this test is that the throw lands on the row as a readable failure
  // rather than escaping into a queue retry that would pay for the same answer
  // again.
  //
  // SUSPECT (reported, not fixed): the message stored is the raw
  // `Object.keys(undefined)` TypeError -- "Cannot convert undefined or null to
  // object" -- which names neither Gemini nor the field. An admin reading the
  // failure banner on the check page has no way to tell that from a database
  // problem. Pinned exactly as it reads today.
  it("fails the job, without throwing, when the model omits `details`", async () => {
    geminiReplies = [geminiOk({ locations: [], donation_points: [] })];

    await expect(runJob()).resolves.toBeUndefined();

    expect(jobRow()!.status).toBe("failed");
    expect(jobRow()!.error).toBe("Cannot convert undefined or null to object");
  });

  it("fails the job, without throwing, when the model omits `locations`", async () => {
    geminiReplies = [geminiOk({ details: aiResponse().details, donation_points: [] })];

    await expect(runJob()).resolves.toBeUndefined();

    expect(jobRow()!.status).toBe("failed");
    expect(jobRow()!.result).toBeNull();
  });
});

// ===========================================================================
// NULLISH NORMALISATION -- views.py:1181-1188
// ===========================================================================
describe("textual nulls from the model", () => {
  beforeEach(() => {
    seedFoodbank();
    seedJob();
    stubAllPages();
  });

  // views.py:1181-1188 rewrites check_result["details"] IN PLACE, before both
  // the comparison and the render. That matters twice, and the module's comment
  // says so: the Found column shows empty rather than the word "none", and
  // check.html's `{% if detail_changes.x and check_result.details.x %}` can
  // never offer a Use button that would write the literal string "none" into
  // the column. So the assertion is on the STORED aiResponse, which is what the
  // template reads -- not on some intermediate.
  it.each(["none", "None", "NULL", "null", "Nothing", "  nothing  "])("blanks %o in the stored response", async (value) => {
    geminiReplies = [geminiOk(aiResponse({ details: { ...aiResponse().details, charity_number: value } }))];

    await runJob();

    expect(storedResult().aiResponse.details.charity_number).toBe("");
  });

  // Only the three exact words, and only as the WHOLE value. A charity called
  // "Nonesuch Trust" or a page saying "nothing to declare" must survive, or the
  // check would silently erase real answers.
  it.each(["Nonesuch", "nothing to declare", "no", "n/a", "none of the above"])("leaves %o alone", async (value) => {
    geminiReplies = [geminiOk(aiResponse({ details: { ...aiResponse().details, charity_number: value } }))];

    await runJob();

    expect(storedResult().aiResponse.details.charity_number).toBe(value);
  });

  // DIVERGENCE FROM DJANGO, pinned as it stands. Django's _normalise_nullish
  // returns the value UNCHANGED unless it is one of the three words; the port
  // trims every value on the way through. So a model answer of " 01722 349556 "
  // is stored trimmed here and untrimmed in Django. This is the safer of the
  // two, but it is a difference and it is measured.
  it("trims every value, not only the nullish ones -- Django trims none of them", async () => {
    geminiReplies = [geminiOk(aiResponse({ details: { ...aiResponse().details, news_url: `  ${SITE}/news/  ` } }))];

    await runJob();

    expect(storedResult().aiResponse.details.news_url).toBe(`${SITE}/news/`);
    // And the trimmed value is what the comparison sees, so this is not a
    // change against the identical stored value.
    expect(storedResult().detailChanges.news_url).toBe(false);
  });

  // The normalisation runs over Object.keys(details), so it reaches address and
  // postcode too -- which are not use-ai fields but ARE half of the address
  // comparison below.
  it("normalises address and postcode as well, since they feed the address comparison", async () => {
    geminiReplies = [geminiOk(aiResponse({ details: { ...aiResponse().details, address: "none", postcode: "none" } }))];

    await runJob();

    expect(storedResult().aiResponse.details.address).toBe("");
    expect(storedResult().aiResponse.details.postcode).toBe("");
    // Ours is "1 Bemerton Heath\nSP2 9DY", theirs is now "" -- a change.
    expect(storedResult().detailChanges.address).toBe(true);
  });
});

// ===========================================================================
// detailChanges -- views.py:1191-1206
// ===========================================================================
describe("detailChanges", () => {
  beforeEach(() => {
    seedFoodbank();
    seedJob();
    stubAllPages();
  });

  async function changes(details: Partial<FoodbankCheckAiResponse["details"]> = {}): Promise<Record<string, boolean>> {
    geminiReplies = [geminiOk(aiResponse({ details: { ...aiResponse().details, ...details } }))];
    await runJob();
    return storedResult().detailChanges;
  }

  // The key list is FIXED (CHECK_USE_AI_FIELDS plus the computed "address"),
  // and it is Django's detail_changes keys exactly. Two things ride on that:
  // check.html looks up detail_changes.<field> per row, and the module's own
  // comment notes Django has NO `network` entry -- so a port that iterated the
  // AI response instead would grow one and highlight a row Django never did.
  it("carries exactly Django's eleven keys, and no `network`", async () => {
    expect(Object.keys(await changes())).toEqual([...CHECK_USE_AI_FIELDS, "address"]);
    expect(Object.keys(await changes())).not.toContain("network");
    expect(CHECK_USE_AI_FIELDS).toHaveLength(10);
  });

  // Spelled out key by key rather than `Object.values(...).every(...)`:
  // `every` on an empty object is TRUE, so the shorter spelling passed for any
  // implementation that produced no keys at all -- including one that never
  // wrote detailChanges. The eleven keys are the contract the check page reads
  // per row, so they are the assertion.
  it("is false across the board when the model found what we already hold", async () => {
    expect(await changes()).toEqual({
      phone_number: false,
      contact_email: false,
      charity_number: false,
      facebook_page: false,
      bankuet_slug: false,
      rss_url: false,
      news_url: false,
      donation_points_url: false,
      locations_url: false,
      contacts_url: false,
      address: false,
    });
  });

  // Django's plain inequality per field, and the module's comment explains why
  // it is not "the model found something different": "we hold a value the AI did
  // not find" IS a change, so the row highlights and warns the reviewer that
  // what we hold may now be stale. The Use button is gated separately in the
  // template on the found value being non-empty.
  it("counts a value we hold and the model did not find as a change", async () => {
    expect((await changes({ charity_number: "" })).charity_number).toBe(true);
  });

  // The mirror: iterating the AI's own keys instead of the fixed list would
  // silently skip a field the model omitted from its JSON, and the check page
  // would report no change on a field nobody looked at.
  it("still reports a change for a field the model omitted entirely", async () => {
    geminiReplies = [geminiOk({ details: { name: "Salisbury Foodbank" }, locations: [], donation_points: [] })];

    await runJob();

    expect(storedResult().detailChanges.contacts_url).toBe(true);
    expect(storedResult().detailChanges.bankuet_slug).toBe(true);
  });

  // views.py:1195 -- phone_number is the ONE field Django normalises before
  // comparing, because the model's save() strips spaces on the way in
  // (foodbank.py:649-650). Without this, every food bank whose number the model
  // read as "01722 349556" against a stored "01722349556" would show a phantom
  // change on every single check.
  it("ignores spacing differences in phone_number only", async () => {
    const result = await changes({ phone_number: "01722349556", contact_email: "info@salisbury .example" });

    expect(result.phone_number).toBe(false);
    // Every other field is a plain string compare. An INTERNAL space is the
    // right control here rather than a leading one: normaliseAiString has
    // already trimmed both ends of every value (see the trimming test above),
    // so a leading space would be equal on any implementation and would prove
    // nothing about the space-stripping being scoped to phone_number.
    expect(result.contact_email).toBe(true);
  });

  // DIVERGENCE FROM DJANGO, disclosed in the module's own comment and pinned
  // here. Django strips literal SPACES (`.replace(" ", "")`); the port strips
  // all whitespace (`/\s+/`) so that the comparison agrees with the port's own
  // write path in routes/admin/useAi.ts:41. A tab or a non-breaking-space-free
  // newline inside a scraped number is therefore a change in Django and not one
  // here.
  it("strips tabs and newlines from phone_number too, which Django does not", async () => {
    expect((await changes({ phone_number: "01722\t349556" })).phone_number).toBe(false);
    expect((await changes({ phone_number: "01722\n349556" })).phone_number).toBe(false);
  });

  // views.py:1191-1194: "address" is address and postcode joined by a newline
  // and compared as one trimmed string, with none of phone_number's space
  // stripping. The module's comment records that this was previously skipped
  // ENTIRELY -- the Details table's Address row never highlighted on a real
  // change and postcode was dropped from the comparison -- so each half is
  // asserted separately.
  it("compares address and postcode together as one newline-joined string", async () => {
    expect((await changes({ address: "2 Bemerton Heath" })).address).toBe(true);
    expect((await changes({ postcode: "SP2 9DZ" })).postcode).toBeUndefined();
    expect((await changes({ postcode: "SP2 9DZ" })).address).toBe(true);
    expect((await changes({ address: "1 Bemerton Heath", postcode: "SP2 9DY" })).address).toBe(false);
  });

  // Neither half is space-normalised, so "SP29DY" against "SP2 9DY" IS a
  // change here even though the postcode-set comparison further down treats
  // them as the same place. Both behaviours are Django's; pinned because they
  // look contradictory side by side and a "tidy-up" would break one of them.
  it("does not space-normalise the postcode in the address comparison", async () => {
    expect((await changes({ postcode: "SP29DY" })).address).toBe(true);
  });

  // A food bank with no phone number and no charity number on file. Ours is
  // NULL, which coalesces to ""; the model finding nothing is also "". Not a
  // change -- otherwise every incomplete record would highlight every row on
  // every check and the highlighting would mean nothing.
  it("treats our NULL and the model's blank as agreeing", async () => {
    db.exec("DELETE FROM foodbank");
    seedFoodbank({ phone_number: null, charity_number: null, rss_url: null });
    geminiReplies = [geminiOk(aiResponse({ details: { ...aiResponse().details, phone_number: "", charity_number: "", rss_url: "" } }))];

    await runJob();

    expect(storedResult().detailChanges.phone_number).toBe(false);
    expect(storedResult().detailChanges.charity_number).toBe(false);
    expect(storedResult().detailChanges.rss_url).toBe(false);
  });

  // DIVERGENCE FROM DJANGO, pinned as it stands. The port trims OUR value
  // (`(foodbank[field] ?? "").trim()`); Django compares `(foodbank.x or "")`
  // raw for every field except address. A stored value with trailing
  // whitespace therefore highlights in Django and does not here. This is the
  // more useful behaviour, but it is a difference.
  it("trims our stored value before comparing, which Django does not", async () => {
    db.exec("DELETE FROM foodbank");
    seedFoodbank({ charity_number: "  1122447  " });
    geminiReplies = [geminiOk(aiResponse())];

    await runJob();

    expect(storedResult().detailChanges.charity_number).toBe(false);
  });
});

// ===========================================================================
// DISCREPANCIES -- views.py:1151-1180, the asymmetry the module's comment names
// ===========================================================================
describe("location and donation-point discrepancies", () => {
  beforeEach(() => {
    seedFoodbank();
    seedJob();
    stubAllPages();
  });

  // Our side: a location whose postcode the model did NOT find anywhere on the
  // food bank's own pages is flagged, because it may have closed. The
  // non-flagged row in the same run is what proves the flag is a decision
  // rather than a constant.
  it("flags one of our locations the model did not find, and only that one", async () => {
    seedLocation({ id: 1, name: "Amesbury", slug: "amesbury", postcode: "SP4 7DL" });
    seedLocation({ id: 2, name: "Wilton", slug: "wilton", postcode: "SP2 0HR" });
    geminiReplies = [geminiOk(aiResponse({ locations: [{ name: "Wilton", address: "The Hollows", postcode: "SP2 0HR" }] }))];

    await runJob();

    expect(storedResult().ourLocations).toEqual([
      { slug: "amesbury", name: "Amesbury", address: "The Hollows", postcode: "SP4 7DL", discrepancy: true },
      { slug: "wilton", name: "Wilton", address: "The Hollows", postcode: "SP2 0HR", discrepancy: false },
    ]);
  });

  it("flags one of our donation points the model did not find", async () => {
    seedDonationPoint({ id: 5, name: "Co-op Bemerton", slug: "coop", postcode: "SP2 9RB" });
    seedDonationPoint({ id: 6, name: "Tesco Southampton Road", slug: "tesco", postcode: "SP1 2LB" });
    geminiReplies = [geminiOk(aiResponse({ donation_points: [{ name: "Tesco Southampton Road", address: "Southampton Road", postcode: "SP1 2LB" }] }))];

    await runJob();

    expect(storedResult().ourDonationPoints).toEqual([
      { slug: "coop", name: "Co-op Bemerton", address: "Southampton Road", postcode: "SP2 9RB", discrepancy: true },
      { slug: "tesco", name: "Tesco Southampton Road", address: "Southampton Road", postcode: "SP1 2LB", discrepancy: false },
    ]);
  });

  // Each of our lists is checked against ITS OWN half of the model's answer.
  // A location the model listed as a donation point is not a match, and a
  // handler that pooled the two sets would quietly stop flagging real
  // mislistings.
  it("does not let a found donation point clear one of our locations", async () => {
    seedLocation({ id: 1, name: "Wilton", slug: "wilton", postcode: "SP2 0HR" });
    geminiReplies = [geminiOk(aiResponse({ donation_points: [{ name: "Wilton", address: "The Hollows", postcode: "SP2 0HR" }] }))];

    await runJob();

    expect(storedResult().ourLocations[0]!.discrepancy).toBe(true);
  });

  // views.py:1171-1175 -- a found location is new UNLESS it is one of ours, or
  // the food bank's own address. The main address exclusion exists because
  // every locations page lists the food bank's own site first, and without it
  // every single check would propose adding the food bank as a location of
  // itself.
  it("does not badge a found location that sits at the food bank's own address", async () => {
    seedLocation({ id: 1, name: "Wilton", slug: "wilton", postcode: "SP2 0HR" });
    geminiReplies = [
      geminiOk(
        aiResponse({
          locations: [
            { name: "Bemerton Heath", address: "1 Bemerton Heath", postcode: "SP2 9DY" },
            { name: "Wilton", address: "The Hollows", postcode: "SP2 0HR" },
            { name: "Downton", address: "The Borough", postcode: "SP5 3LX" },
          ],
        }),
      ),
    ];

    await runJob();

    expect(storedResult().foundLocations).toEqual([
      { name: "Bemerton Heath", address: "1 Bemerton Heath", postcode: "SP2 9DY", discrepancy: false },
      { name: "Wilton", address: "The Hollows", postcode: "SP2 0HR", discrepancy: false },
      { name: "Downton", address: "The Borough", postcode: "SP5 3LX", discrepancy: true },
    ]);
  });

  // THE ASYMMETRY THE MODULE'S COMMENT IS ABOUT. views.py:1176-1180's
  // donation-point loop excludes our LOCATIONS' postcodes, not the food bank's
  // own address postcode -- that is the locations loop's rule (:1173). Getting
  // them the same way round badges a donation point at one of our locations as
  // "new" with an Add button (a duplicate waiting to be created) and suppresses
  // one at the food bank's own postcode. Both halves are asserted in one run,
  // because a symmetrical implementation gets one of them right either way.
  it("excludes a found donation point at one of OUR LOCATIONS, but not one at the food bank's own postcode", async () => {
    seedLocation({ id: 1, name: "Wilton", slug: "wilton", postcode: "SP2 0HR" });
    geminiReplies = [
      geminiOk(
        aiResponse({
          donation_points: [
            { name: "Wilton drop-off", address: "The Hollows", postcode: "SP2 0HR" },
            { name: "Reception", address: "1 Bemerton Heath", postcode: "SP2 9DY" },
          ],
        }),
      ),
    ];

    await runJob();

    expect(storedResult().foundDonationPoints).toEqual([
      { name: "Wilton drop-off", address: "The Hollows", postcode: "SP2 0HR", discrepancy: false },
      { name: "Reception", address: "1 Bemerton Heath", postcode: "SP2 9DY", discrepancy: true },
    ]);
  });

  // ... and the reverse direction of the same asymmetry: our donation points do
  // NOT clear a found LOCATION. Only our locations and our own address do.
  it("does not let one of our donation points clear a found location", async () => {
    seedDonationPoint({ id: 5, name: "Tesco", slug: "tesco", postcode: "SP1 2LB" });
    geminiReplies = [geminiOk(aiResponse({ locations: [{ name: "Tesco", address: "Southampton Road", postcode: "SP1 2LB" }] }))];

    await runJob();

    expect(storedResult().foundLocations[0]!.discrepancy).toBe(true);
  });

  // DIVERGENCE FROM DJANGO, and a deliberate improvement: Django compares raw
  // postcode strings (`location["postcode"] not in [x["postcode"] ...]`), so
  // "SP2 0HR" held against a model answer of "sp2 0hr" or "SP20HR" is a
  // discrepancy there and is not one here. Without the normalisation the check
  // page would badge half of every food bank's locations as missing purely on
  // spacing.
  it("matches postcodes case- and space-insensitively, unlike Django's raw compare", async () => {
    seedLocation({ id: 1, name: "Wilton", slug: "wilton", postcode: "SP2 0HR" });
    geminiReplies = [geminiOk(aiResponse({ locations: [{ name: "Wilton", address: "The Hollows", postcode: " sp2  0hr " }] }))];

    await runJob();

    expect(storedResult().ourLocations[0]!.discrepancy).toBe(false);
    expect(storedResult().foundLocations[0]!.discrepancy).toBe(false);
  });

  // SUSPECT (reported, not fixed). normalisePostcode maps null and "" to the
  // same empty string, so one of our locations with no postcode on file is
  // "matched" by any model answer that also has no postcode -- two places that
  // are certainly not the same place. It reads as "we found it" on the check
  // page. Pinned as it stands.
  it("treats a NULL postcode and a blank found postcode as the same place", async () => {
    seedLocation({ id: 1, name: "Mobile unit", slug: "mobile", postcode: null });
    geminiReplies = [geminiOk(aiResponse({ locations: [{ name: "Somewhere else entirely", address: "unknown", postcode: "" }] }))];

    await runJob();

    expect(storedResult().ourLocations[0]!.discrepancy).toBe(false);
    expect(storedResult().foundLocations[0]!.discrepancy).toBe(false);
  });

  // DISCLOSED SIMPLIFICATION, pinned as it stands. views.py:1158-1169 also
  // excludes a postcode regex-scraped out of delivery_address, so a found place
  // at the delivery address is not badged as new in Django. This D1 schema has
  // no delivery_postcode column and the module says it does not parse the prose,
  // so that exclusion is absent here and the place IS badged.
  it("badges a found location at the delivery address, which Django would have excluded", async () => {
    db.exec("DELETE FROM foodbank");
    seedFoodbank({ delivery_address: "The Warehouse, Churchfields, Salisbury SP2 7NP" });
    geminiReplies = [geminiOk(aiResponse({ locations: [{ name: "Warehouse", address: "Churchfields", postcode: "SP2 7NP" }] }))];

    await runJob();

    expect(storedResult().foundLocations[0]!.discrepancy).toBe(true);
  });

  // Empty on both sides is the common case for a food bank with one site. The
  // arrays must be PRESENT and empty rather than absent: foodbank_check.njk:134
  // and :180 gate each half of the comparison on
  // `result.ourLocations.length or result.foundLocations.length`, and an
  // undefined array's `.length` is undefined, so a missing key deletes the
  // whole section from the page silently instead of raising.
  it("hands back four empty arrays when there is nothing on either side", async () => {
    geminiReplies = [geminiOk(aiResponse())];

    await runJob();

    const result = storedResult();
    expect(result.ourLocations).toEqual([]);
    expect(result.foundLocations).toEqual([]);
    expect(result.ourDonationPoints).toEqual([]);
    expect(result.foundDonationPoints).toEqual([]);
  });

  // Our side has exactly ONE exclusion set -- what the model found -- and the
  // food bank's own postcode is deliberately not part of it. Django agrees:
  // views.py:1150-1154's loop over foodbank_json["locations"] tests only
  // `not in [x["postcode"] for x in check_result["locations"]]`.
  //
  // MUTANT THIS KILLS: widening this test with `&& !ourAddressPostcodes.has(...)`,
  // which is the rule the FOUND-locations loop uses two lines below and reads
  // like a missed symmetry. It would stop flagging a location we hold at the
  // food bank's own postcode -- head-office collection points, which is where
  // a food bank that has stopped taking donations at its own door shows up.
  it("still flags one of our locations at the food bank's own postcode when the model did not find it", async () => {
    seedLocation({ id: 1, name: "Head office collection", slug: "head-office", address: "1 Bemerton Heath", postcode: "SP2 9DY" });
    geminiReplies = [geminiOk(aiResponse({ locations: [{ name: "Wilton", address: "The Hollows", postcode: "SP2 0HR" }] }))];

    await runJob();

    expect(storedResult().ourLocations).toEqual([{ slug: "head-office", name: "Head office collection", address: "1 Bemerton Heath", postcode: "SP2 9DY", discrepancy: true }]);
  });

  // views.py:1171's exclusion is `foodbank_json["details"]["postcode"]` -- the
  // postcode on OUR row, not the one the model reported for the same field.
  // Here the model misreads the head office as SP1 1AA, so the two differ and
  // the choice is visible.
  //
  // MUTANT THIS KILLS: `new Set([normalisePostcode(aiResponse.details.postcode)])`.
  // Every other test in this file gives the model the same postcode we hold,
  // so it survived all of them -- and in production it would badge the food
  // bank's own site as a NEW location with an Add button whenever the model
  // got the address wrong, which is exactly the run where a reviewer is least
  // able to tell.
  it("excludes a found location at OUR postcode, not at the postcode the model reported", async () => {
    geminiReplies = [
      geminiOk(
        aiResponse({
          details: { ...aiResponse().details, postcode: "SP1 1AA" },
          locations: [
            { name: "Bemerton Heath", address: "1 Bemerton Heath", postcode: "SP2 9DY" },
            { name: "Elsewhere", address: "Somewhere else", postcode: "SP1 1AA" },
          ],
        }),
      ),
    ];

    await runJob();

    expect(storedResult().foundLocations).toEqual([
      { name: "Bemerton Heath", address: "1 Bemerton Heath", postcode: "SP2 9DY", discrepancy: false },
      { name: "Elsewhere", address: "Somewhere else", postcode: "SP1 1AA", discrepancy: true },
    ]);
  });

  // EVERY row this handler reads is keyed on the id it resolved from the slug,
  // and the fixture food bank's id (22) is the only one most of this file ever
  // sees -- so `getLocationsByFoodbankId(session, 22)`, or its donation-point
  // twin, passed all 86 of the tests that existed before this one. This runs a
  // food bank with a DIFFERENT id, holding rows on BOTH sides, against a
  // Salisbury that holds different rows on both sides.
  //
  // A hardcoded or mis-bound id here does not fail: it hands the check page a
  // tidy comparison of one food bank's website against another food bank's
  // locations, and every row on both sides is badged as a discrepancy.
  it("reads the locations and donation points belonging to the food bank the slug resolved to", async () => {
    seedLocation({ id: 1, name: "Salisbury location", slug: "sal-loc", postcode: "SP2 0HR" });
    seedDonationPoint({ id: 5, name: "Salisbury drop-off", slug: "sal-dp", postcode: "SP1 2LB" });
    seedFoodbank({ id: 91, slug: "oxford", name: "Oxford Foodbank", address: "1 Oxford Road", postcode: "OX1 1AA", url: "https://oxford.example/", shopping_list_url: "", locations_url: null, contacts_url: null, donation_points_url: null });
    seedLocation({ id: 2, name: "Cowley", slug: "cowley", address: "Cowley Road", postcode: "OX4 1HZ", foodbankId: 91 });
    seedDonationPoint({ id: 6, name: "Summertown Co-op", slug: "summertown", address: "South Parade", postcode: "OX2 7JN", foodbankId: 91 });
    pageReplies.set("https://oxford.example/", [{ status: 200, body: html("OXFORD") }]);
    db.prepare("INSERT INTO admin_job (id, kind, target, status, created) VALUES ('oxford-job', 'check', 'oxford', 'queued', ?)").run(DJANGO_NOW);
    geminiReplies = [geminiOk(aiResponse({ locations: [{ name: "Cowley", address: "Cowley Road", postcode: "OX4 1HZ" }] }))];

    await runJob("oxford-job", "oxford");

    const result = storedResult("oxford-job");
    // Oxford's rows, and only Oxford's -- Salisbury's SP postcodes appear on
    // neither side, and Cowley is cleared by the model having found it.
    expect(result.ourLocations).toEqual([{ slug: "cowley", name: "Cowley", address: "Cowley Road", postcode: "OX4 1HZ", discrepancy: false }]);
    expect(result.ourDonationPoints).toEqual([{ slug: "summertown", name: "Summertown Co-op", address: "South Parade", postcode: "OX2 7JN", discrepancy: true }]);
    // The same rows in the prompt, so a wrong id is caught in what the model
    // is shown as well as in what the page is handed.
    expect(result.prompt).toContain('"name": "Cowley"');
    expect(result.prompt).toContain('"name": "Summertown Co-op"');
    expect(result.prompt).not.toContain("Salisbury location");
    expect(result.prompt).not.toContain("Salisbury drop-off");
  });

  // Rows belonging to ANOTHER food bank must not leak into either exclusion
  // set: a filter that returned everything would clear discrepancies that are
  // real. Seeded with the same postcodes the model returns, so a dropped
  // `WHERE foodbank_id = ?` flips both assertions.
  it("ignores another food bank's locations and donation points", async () => {
    seedFoodbank({ id: 91, slug: "oxford", name: "Oxford Foodbank" });
    seedLocation({ id: 9, name: "Oxford North", slug: "oxford-north", postcode: "SP5 3LX", foodbankId: 91 });
    seedDonationPoint({ id: 9, name: "Oxford Tesco", slug: "oxford-tesco", postcode: "SP5 3LX", foodbankId: 91 });
    geminiReplies = [
      geminiOk(
        aiResponse({
          locations: [{ name: "Downton", address: "The Borough", postcode: "SP5 3LX" }],
          donation_points: [{ name: "Downton Co-op", address: "The Borough", postcode: "SP5 3LX" }],
        }),
      ),
    ];

    await runJob();

    expect(storedResult().ourLocations).toEqual([]);
    expect(storedResult().ourDonationPoints).toEqual([]);
    expect(storedResult().foundLocations[0]!.discrepancy).toBe(true);
    expect(storedResult().foundDonationPoints[0]!.discrepancy).toBe(true);
  });
});

// ===========================================================================
// THE STORED PAYLOAD -- what the check page is handed whole
// ===========================================================================
describe("the stored FoodbankCheckResult", () => {
  // Seven of these eight keys are read by foodbank_check.njk directly
  // (detailChanges, aiResponse, ourLocations, foundLocations, ourDonationPoints,
  // foundDonationPoints, fetchedPages); the eighth, `prompt`, is what the
  // route's `?debug=prompt` branch serves behind the template's own link at
  // :59. Nunjucks is configured throwOnUndefined:false, so a key that stopped
  // being written renders an empty table rather than raising -- which is why
  // this is asserted as the whole key set rather than spot-checked.
  it("carries all eight keys the check page reads", async () => {
    seedFoodbank();
    seedLocation({ id: 1, name: "Wilton", slug: "wilton", postcode: "SP2 0HR" });
    seedDonationPoint({ id: 5, name: "Tesco", slug: "tesco", postcode: "SP1 2LB" });
    seedJob();
    stubAllPages();
    geminiReplies = [
      geminiOk(
        aiResponse({
          locations: [{ name: "Downton", address: "The Borough", postcode: "SP5 3LX" }],
          donation_points: [{ name: "Co-op", address: "The Borough", postcode: "SP5 3LX" }],
        }),
      ),
    ];

    await runJob();

    const result: FoodbankCheckResult = storedResult();
    expect(Object.keys(result).sort()).toEqual(["aiResponse", "detailChanges", "fetchedPages", "foundDonationPoints", "foundLocations", "ourDonationPoints", "ourLocations", "prompt"]);
    expect(result.prompt.length).toBeGreaterThan(500);
    expect(result.aiResponse.details.name).toBe("Salisbury Foodbank");
    expect(result.fetchedPages).toHaveLength(5);
    expect(Object.keys(result.detailChanges)).toHaveLength(11);
    expect(result.ourLocations).toHaveLength(1);
    expect(result.foundLocations).toHaveLength(1);
    expect(result.ourDonationPoints).toHaveLength(1);
    expect(result.foundDonationPoints).toHaveLength(1);
  });

  // The payload is JSON in a TEXT column, so anything that does not survive
  // JSON.stringify/parse is lost between the consumer and the page. A model
  // answer full of quotes, newlines and non-ASCII is the case that would break
  // a naive string concatenation, and food bank pages are full of all three.
  it("round-trips quotes, newlines and non-ASCII through the result column", async () => {
    seedFoodbank();
    seedJob();
    stubAllPages();
    geminiReplies = [
      geminiOk(
        aiResponse({
          details: { ...aiResponse().details, name: 'The "Big" Café — Ynys Môn' },
          locations: [{ name: "Line\nbreak", address: 'He said "hi"', postcode: "SP2 0HR" }],
        }),
      ),
    ];

    await runJob();

    expect(storedResult().aiResponse.details.name).toBe('The "Big" Café — Ynys Môn');
    expect(storedResult().foundLocations[0]!.name).toBe("Line\nbreak");
    expect(storedResult().foundLocations[0]!.address).toBe('He said "hi"');
  });

  // The found rows are the model's own objects with `discrepancy` added -- a
  // spread, not a rebuild -- so any extra key the schema grows arrives on the
  // page for free. Pinned because the check page's Add button posts these
  // values on.
  it("keeps the model's own name/address/postcode on each found row and adds only `discrepancy`", async () => {
    seedFoodbank();
    seedJob();
    stubAllPages();
    geminiReplies = [geminiOk(aiResponse({ locations: [{ name: "Downton", address: "The Borough\nDownton", postcode: "SP5 3LX" }] }))];

    await runJob();

    expect(Object.keys(storedResult().foundLocations[0]!)).toEqual(["name", "address", "postcode", "discrepancy"]);
    expect(storedResult().foundLocations[0]!.address).toBe("The Borough\nDownton");
  });
});
