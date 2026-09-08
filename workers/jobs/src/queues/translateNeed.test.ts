import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import type { Env } from "../../worker-configuration";
import { handleTranslateNeed, type TranslateNeedMessage } from "./translateNeed";
import { handleJobsQueue } from "./jobs";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning,
// as packages/db/src/schema.testkit.ts:35 and queues/charity.test.ts:7-12.
import { DatabaseSync } from "node:sqlite";

// queues/translateNeed.ts -- the "jobs" queue's `translate-need` consumer.
// Three messages (cy, ga, gd) are enqueued by workers/site every time an
// admin publishes a need (routes/admin/needs.ts:194 and :509,
// routes/admin/needNew.ts:159); each one calls Google Cloud Translation and
// replaces one FoodbankChangeTranslation row.
//
// WHY THIS FILE IS WORTH THE LENGTH. Nothing here is ever seen by a human on
// the way past. The only externally visible product of a translate-need
// message is a row in `foodbankchangetranslation` that nobody looks at unless
// they browse the site in Welsh, Irish or Scottish Gaelic -- and when that row
// is missing the site does not break, it silently renders ENGLISH
// (@givefood/models' resolveNeedText: `locale !== "en" && translatedText ?
// translatedText : rawText`). So every failure mode of this module degrades to
// "the Welsh page is in English", which is precisely the shape of the incident
// this tier exists for: a credential that broke silently for a day with a
// dead-letter queue filling up behind it. GCP_TRANSLATE_KEY is exactly such a
// credential, and the block below on a missing key is the test that pins what
// actually happens when it goes.
//
// Consequently every test here reads the ROW BACK, or asserts the exact
// outbound request, rather than awaiting the handler and checking it resolved.
//
// REAL THINGS, NOT MOCKS:
//   * node:sqlite carrying the WHOLE real migration set (MIGRATIONS_SQL rather
//     than schemaFor(...)), for the same reason charity.test.ts:41-46 gives:
//     getNeedById reads the `foodbankchange_full` VIEW, which LEFT JOINs
//     `foodbank`, and 0019 drops a column from the underlying table long after
//     0001 creates it. A narrower fixture is another chance to develop the
//     github #51 gap where a shared query starts reading one more object.
//   * the real getNeedById and replaceNeedTranslation from @givefood/db --
//     the delete-then-insert IS the behaviour under test here, so a canned
//     double would be testing the double.
//   * the real handleJobsQueue in the last block, because whether a failed
//     translation acks or retries is decided there, not here, and "it throws"
//     only matters if something turns that into a retry.
//
// MOCKED, and only this: `fetch` (translation.googleapis.com is the one thing
// that leaves the machine) and Cloudflare's MessageBatch, a runtime object
// with no local equivalent.
//
// PARITY. givefood/utils/general.py:179-221 (get_translation /
// translate_need) and givefood/models/needs.py:345-355
// (FoodbankChangeTranslation) at /Users/jasoncartwright/Sites/foodcharity were
// read directly for every Django claim below. Four real divergences are pinned
// as the port behaves, each flagged in place: the HTTP method, the failure
// mode of a non-200, the order of the delete relative to the API call, and a
// NULL foodbank_id. No Python was executed for this file and nothing below
// claims otherwise -- the citations are line references, read.
//
// REVIEWED by mutation, 2026-09-08: 46 mutants were applied to a COPY of the
// repo in a scratchpad -- this module, packages/db's replaceNeedTranslation
// (the DELETE's two predicates and the INSERT's bind order) and
// queues/jobs.ts's ack/retry -- and the suite was re-run against each. Four
// survived and are now killed by tests that name them in place: reading
// `.at(-1)` instead of `[0]` from Google's `translations` array; `q:
// text.trim()` on the way out; authenticating the excess-text request with a
// different one of this Env's ten keys; and encoding the key for one target
// language but not another. All four had the same shape -- they changed only
// the SECOND request, or only a case no fixture exercised -- which is why a
// few assertions below are deliberately repeated on fetchCalls[1] and on a
// non-cy message.
//
// Every Django, wrangler.jsonc and packages/db line reference below was re-read
// during that pass. Five were a few lines out and are corrected; one was
// substantively wrong (what Django does with a non-200) and is rewritten in
// place, in the 403 block.

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
 * standing in for a D1 outage mid-message. This module has no error handling of
 * its own at all, so the only way to see what a half-failed write leaves behind
 * is to break one statement and read the table.
 */
let failOn: RegExp | null = null;

/** Every bookmark mode `withSession` was asked for, in call order. */
let sessionModes: string[] = [];

/**
 * The D1 Sessions API surface packages/db uses, carried to node:sqlite. Answers
 * no canned rows: getNeedById's view read and replaceNeedTranslation's
 * DELETE-then-INSERT are the behaviour under test, so they run against a real
 * engine and a real schema.
 *
 * `first()` answers null and never undefined, matching D1.
 *
 * FIDELITY LIMIT, stated rather than hidden: real D1 rejects an `undefined`
 * bind value at .bind() time with D1_TYPE_ERROR, whereas node:sqlite rejects it
 * at execution time with a TypeError. Both throw out of the same await inside
 * handleTranslateNeed, which is all the malformed-message test below depends
 * on, but the message text differs and nothing asserts on it.
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
  method: string;
  headers: Record<string, string>;
  /** The raw request body, so the form encoding itself can be asserted rather than inferred. */
  body: string;
  /** ...and the same thing parsed, for the per-field assertions. */
  params: URLSearchParams;
}

let fetchCalls: FetchCall[];

/**
 * How many requests had been ISSUED at the moment each one was answered.
 * translateText is called for change_text and excess_change_text inside a
 * Promise.all, so both requests are in flight together; a refactor that awaited
 * them one after the other would record [1, 2] here instead of [2, 2] and
 * would double the wall-clock cost of every publish. Nothing else would notice.
 */
let inFlightAtReply: number[];

type Reply = { status: number; body: string };

/** What Google answers. Overridden per test; the default echoes the target language back so a wrong `target` is visible in the stored row. */
let respond: (call: FetchCall) => Reply | Error;

function translatedReply(text: string): Reply {
  return { status: 200, body: JSON.stringify({ data: { translations: [{ translatedText: text }] } }) };
}

let env: Env;

/**
 * console.error's arguments, RAW rather than stringified. handleJobsQueue logs
 * `(label, message.body, err)` -- the body is an object, and a `String()` pass
 * over it would flatten the only part of the log line that identifies which
 * need and language failed into "[object Object]".
 */
let errors: unknown[][];

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write into foodbankchange.created/modified:
// a SPACE separator, six fractional digits, never a "T" and never a "Z". This
// module writes no timestamps of its own (foodbankchangetranslation has no
// created/modified column -- 0006_need_translations.sql), but the need row it
// reads carries them, and a fixture in ISO spelling would be a lie about what
// is in production.
const DJANGO_NOW = "2026-09-05 19:28:08.853000";

const SALISBURY = 22;
const DUNDEE = 23;
const NEED = 501;
const OTHER_NEED = 502;

const API_KEY = "AIza-Sy/Test+Key=";

interface FoodbankSeed {
  id?: number;
  slug?: string;
  name?: string;
}

function seedFoodbank(seed: FoodbankSeed = {}): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs, created, modified
     ) VALUES (?, ?, ?, ?, '1 Bemerton Heath', 'SP2 9DY', 'England', '51.0688,-1.7945', 0, 'info@example.test', 'https://example.test/', 'https://example.test/need/', 0, 0, 0, 14, ?, ?)`,
  ).run(seed.id ?? SALISBURY, `uuid-${seed.slug ?? "salisbury"}`, seed.name ?? "Salisbury Foodbank", seed.slug ?? "salisbury", DJANGO_NOW, DJANGO_NOW);
}

interface NeedSeed {
  id?: number;
  foodbankId?: number | null;
  changeText?: string;
  excessChangeText?: string | null;
  published?: number;
}

function seedNeed(seed: NeedSeed = {}): void {
  db.prepare(
    `INSERT INTO foodbankchange (
       id, need_id, foodbank_id, change_text, excess_change_text, published, input_method, created, modified
     ) VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)`,
  ).run(
    seed.id ?? NEED,
    // 32-char dashless, as 0001_core.sql specifies. Deliberately NOT the row
    // id: the "reads by numeric id" test below leans on the two being
    // different, because a lookup by UUID would still find a row here.
    `abcdef${String(seed.id ?? NEED).padStart(26, "0")}`,
    seed.foodbankId === undefined ? SALISBURY : seed.foodbankId,
    seed.changeText ?? "Beans, Soup, Nappies",
    seed.excessChangeText === undefined ? null : seed.excessChangeText,
    seed.published ?? 1,
    DJANGO_NOW,
    DJANGO_NOW,
  );
}

interface TranslationRow {
  id: number;
  need_id: number;
  foodbank_id: number | null;
  language: string;
  change_text: string | null;
  excess_change_text: string | null;
}

function translations(): TranslationRow[] {
  return db.prepare("SELECT id, need_id, foodbank_id, language, change_text, excess_change_text FROM foodbankchangetranslation ORDER BY id").all() as unknown as TranslationRow[];
}

function seedTranslation(row: { needId: number; language: string; changeText: string | null; excessChangeText?: string | null; foodbankId?: number | null }): void {
  db.prepare("INSERT INTO foodbankchangetranslation (need_id, foodbank_id, language, change_text, excess_change_text) VALUES (?, ?, ?, ?, ?)").run(
    row.needId,
    row.foodbankId === undefined ? SALISBURY : row.foodbankId,
    row.language,
    row.changeText,
    row.excessChangeText === undefined ? null : row.excessChangeText,
  );
}

function message(overrides: Partial<TranslateNeedMessage> = {}): TranslateNeedMessage {
  return { type: "translate-need", needId: NEED, language: "cy", ...overrides };
}

beforeEach(() => {
  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(MIGRATIONS_SQL);

  failOn = null;
  sessionModes = [];
  fetchCalls = [];
  inFlightAtReply = [];
  errors = [];
  respond = (call) => translatedReply(`[${call.params.get("target")}] ${call.params.get("q")}`);

  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const body = String(init.body ?? "");
    const call: FetchCall = {
      url: String(url),
      method: String(init.method),
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
      params: new URLSearchParams(body),
    };
    fetchCalls.push(call);
    // Yield once before answering. Both translateText() calls are made
    // synchronously into Promise.all, so by the time any reply is built every
    // concurrent request has already been recorded -- see inFlightAtReply.
    await Promise.resolve();
    inFlightAtReply.push(fetchCalls.length);
    const reply = respond(call);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, { status: reply.status });
  });

  env = {
    GCP_TRANSLATE_KEY: API_KEY,
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session();
      },
    },
  } as unknown as Env;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

// ===========================================================================
// THE HAPPY PATH -- the row is the entire product of this module
// ===========================================================================
describe("a need with change text only", () => {
  beforeEach(() => {
    seedFoodbank();
    seedNeed();
  });

  // Django's translate_need (general.py:203-221) writes need, language,
  // change_text and excess_change_text, and FoodbankChangeTranslation.save()
  // (needs.py:353-355) fills foodbank in from need.foodbank. Every one of those
  // five columns is asserted, because a wrong `language` or `need_id` produces
  // a row that is simply never read -- the page falls back to English and
  // nothing anywhere reports a problem.
  it("writes exactly one translation row with the text Google returned", async () => {
    await handleTranslateNeed(message(), env);

    expect(translations()).toEqual([
      {
        id: 1,
        need_id: NEED,
        foodbank_id: SALISBURY,
        language: "cy",
        change_text: "[cy] Beans, Soup, Nappies",
        // No excess text on the need, so no second call and a NULL column --
        // Django's `if need.excess_change_text:` (general.py:209) has exactly
        // the same effect.
        excess_change_text: null,
      },
    ]);
  });

  // A DELIBERATE DIVERGENCE, pinned rather than wished away. Django builds one
  // long GET: `translate_url = "%s&source=%s&target=%s&q=%s&format=text"` with
  // `urllib.parse.quote(text)` (general.py:183-185). The port POSTs the same
  // four fields as a form body, which is why the "very long need text" test
  // below can pass 8 kB of items without hitting a URL length limit. Same
  // endpoint, same parameters, different verb -- and the key stays in the
  // query string in both.
  it("POSTs a form body to the v2 endpoint with the key in the query string", async () => {
    await handleTranslateNeed(message(), env);

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    // The whole URL, not a substring match: a stray path segment or a v3
    // endpoint would be a 404 that shows up only as a missing Welsh page.
    expect(call.url).toBe("https://translation.googleapis.com/language/translate/v2?key=AIza-Sy%2FTest%2BKey%3D");
    // ...and the key is percent-encoded, not pasted raw. A real GCP key can
    // contain "-" and "_" and would survive naively, but the mutant that drops
    // encodeURIComponent breaks silently the first time one contains a "+"
    // or "/" -- authentication failures are the hardest failure here to see.
    expect(call.url).not.toContain("AIza-Sy/Test+Key=");
    expect(call.body).toBe("q=Beans%2C+Soup%2C+Nappies&source=en&target=cy&format=text");
  });

  // Each field on its own, so a body that happened to contain the right bytes
  // in the wrong roles still fails. `format=text` is what stops Google
  // returning HTML markup around the translation, and `source=en` is Django's
  // own default (general.py:179's `source="en"`) -- letting Google
  // auto-detect would mistranslate a one-word need like "Nothing".
  it("sends q, source, target and format", async () => {
    await handleTranslateNeed(message({ language: "gd" }), env);

    // The URL is asserted here as well as in the cy test above, because every
    // other URL assertion in this file is made on a cy message: a mutant that
    // encoded the key correctly for one language and not another survived
    // until this line existed. The endpoint and the credential do not depend
    // on the target language, and this is where that is pinned.
    expect(fetchCalls[0]!.url).toBe("https://translation.googleapis.com/language/translate/v2?key=AIza-Sy%2FTest%2BKey%3D");
    const params = fetchCalls[0]!.params;
    expect(params.get("q")).toBe("Beans, Soup, Nappies");
    expect(params.get("source")).toBe("en");
    expect(params.get("target")).toBe("gd");
    expect(params.get("format")).toBe("text");
    // The key travels in the URL only. A copy in the body would be sent to
    // Google in a second place for no reason and would show up in any body
    // that gets logged.
    expect(params.get("key")).toBeNull();
    expect(translations()[0]!.language).toBe("gd");
    expect(translations()[0]!.change_text).toBe("[gd] Beans, Soup, Nappies");
  });

  // ONE session for the read and the write, not one each. D1 has read
  // replication on (packages/db/src/types.ts's header), so a second session
  // could be pinned to a replica that has not seen this session's DELETE when
  // the INSERT lands.
  it("opens exactly one first-unconstrained session", async () => {
    await handleTranslateNeed(message(), env);

    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // Nothing in this module logs, at all. The only reason a translate failure is
  // ever visible is handleJobsQueue's console.error around it (see the last
  // block), so a "successful" run being silent is the contract -- but it means
  // there is no positive signal that translations are happening either.
  it("logs nothing", async () => {
    await handleTranslateNeed(message(), env);

    expect(errors).toEqual([]);
  });
});

// ===========================================================================
// EXCESS TEXT -- the second, conditional call
// ===========================================================================
describe("a need that also has excess text", () => {
  beforeEach(() => {
    seedFoodbank();
    seedNeed({ excessChangeText: "Pasta, Rice" });
  });

  it("translates both texts into the same language and stores both", async () => {
    await handleTranslateNeed(message({ language: "ga" }), env);

    expect(fetchCalls.map((call) => call.params.get("q"))).toEqual(["Beans, Soup, Nappies", "Pasta, Rice"]);
    expect(fetchCalls.map((call) => call.params.get("target"))).toEqual(["ga", "ga"]);
    expect(translations()).toEqual([
      { id: 1, need_id: NEED, foodbank_id: SALISBURY, language: "ga", change_text: "[ga] Beans, Soup, Nappies", excess_change_text: "[ga] Pasta, Rice" },
    ]);
  });

  // KILLS THE SECOND-CREDENTIAL MUTANT, which survived the original suite:
  // every url/method/header assertion in this file reads fetchCalls[0], so
  // swapping the excess call's first argument for another of this Env's ten
  // keys (env.GMAP_STATIC_KEY, say -- same type, one identifier apart) changed
  // nothing any test looked at. In production that is the silent-credential
  // incident in its nastiest form: the needs list translates, the excess list
  // 403s, the whole message retries, and the half that worked is paid for
  // again on every attempt. Both requests must be the same request but for
  // `q`, so all four wire properties are asserted on the second call too.
  it("sends the excess request to the same endpoint, with the same key and the same fields", async () => {
    await handleTranslateNeed(message(), env);

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]!.url).toBe(fetchCalls[0]!.url);
    expect(fetchCalls[1]!.url).toBe("https://translation.googleapis.com/language/translate/v2?key=AIza-Sy%2FTest%2BKey%3D");
    expect(fetchCalls[1]!.method).toBe("POST");
    expect(fetchCalls[1]!.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(fetchCalls[1]!.body).toBe("q=Pasta%2C+Rice&source=en&target=cy&format=text");
  });

  // Promise.all, not two awaits. Three languages x two texts is six billed
  // Google calls per publish; serialising them would double the time an admin's
  // publish takes to become visible in Welsh for no benefit.
  it("issues both requests concurrently", async () => {
    await handleTranslateNeed(message(), env);

    expect(inFlightAtReply).toEqual([2, 2]);
  });

  // Django: `if need.excess_change_text:` -- an EMPTY STRING is falsy in
  // Python and in JS alike, so neither one pays for a call to translate "".
  // This is real parity, not a coincidence: the port's `need.excess_change_text
  // ? ... : Promise.resolve(null)` is the same truthiness test.
  // The `q` of the one surviving call is asserted, not just the count: "one
  // request was made" is equally true of a version that skipped the CHANGE
  // text and translated the excess one instead.
  it("does not call Google for an empty-string excess text", async () => {
    db.prepare("UPDATE foodbankchange SET excess_change_text = '' WHERE id = ?").run(NEED);

    await handleTranslateNeed(message(), env);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.params.get("q")).toBe("Beans, Soup, Nappies");
    expect(translations()[0]!.excess_change_text).toBeNull();
  });

  it("does not call Google for a NULL excess text", async () => {
    db.prepare("UPDATE foodbankchange SET excess_change_text = NULL WHERE id = ?").run(NEED);

    await handleTranslateNeed(message(), env);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.params.get("q")).toBe("Beans, Soup, Nappies");
    expect(translations()[0]!.excess_change_text).toBeNull();
  });
});

// ===========================================================================
// WHAT GOOGLE SENT BACK
// ===========================================================================
describe("the response Google returns", () => {
  beforeEach(() => {
    seedFoodbank();
    seedNeed();
  });

  // A 200 whose shape is not what we expect is NOT an error here: the optional
  // chain answers null and a row is still written, with change_text NULL. That
  // is worth pinning in both directions -- the row exists (so nothing retries)
  // and it is empty (so the page renders English via resolveNeedText's
  // falsy-translation fallback). A quota-exceeded 200 body would land exactly
  // here.
  //
  // This row shape cannot exist in Django: `change_text = models.TextField()`
  // (needs.py:350) is NOT NULL there, whereas D1's column is nullable
  // (migrations/0006_need_translations.sql). So a translation row with a NULL
  // change_text is a port-only state, and anything reading the table for
  // "which languages have we translated?" must treat present-but-null as
  // "attempted and got nothing", not as "translated".
  it("stores NULL when the body has no data envelope", async () => {
    respond = () => ({ status: 200, body: "{}" });

    await handleTranslateNeed(message(), env);

    expect(translations()).toEqual([{ id: 1, need_id: NEED, foodbank_id: SALISBURY, language: "cy", change_text: null, excess_change_text: null }]);
  });

  it("stores NULL when the translations array is empty", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ data: { translations: [] } }) });

    await handleTranslateNeed(message(), env);

    expect(translations()[0]!.change_text).toBeNull();
  });

  it("stores NULL when the first translation has no translatedText", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ data: { translations: [{ detectedSourceLanguage: "en" }] } }) });

    await handleTranslateNeed(message(), env);

    expect(translations()[0]!.change_text).toBeNull();
  });

  // KILLS THE `.at(-1)` MUTANT. Every other test in this file answers with a
  // one-element `translations` array, so `[0]`, `.at(-1)` and `.pop()` are
  // indistinguishable across the whole suite -- an off-by-one here would have
  // shipped green. Google's v2 API returns one entry per `q` and this module
  // only ever sends one `q`, so a two-entry body is not a production shape;
  // what the test pins is that the INDEX is fixed at the first entry, which is
  // the only choice that is right for every body Google can send.
  it("stores the first translation when Google returns more than one", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ data: { translations: [{ translatedText: "first" }, { translatedText: "second" }] } }) });

    await handleTranslateNeed(message(), env);

    expect(translations()[0]!.change_text).toBe("first");
  });

  // `?? null`, not `|| null`: an empty translation is stored as "" and stays
  // distinguishable from "Google told us nothing". Kills the `||` mutant. It
  // makes no difference on the page -- resolveNeedText treats both as falsy and
  // falls back to English -- but it does to anyone reading the table to work
  // out whether a language was ever attempted.
  it("stores an empty string as an empty string, not as NULL", async () => {
    respond = () => translatedReply("");

    await handleTranslateNeed(message(), env);

    expect(translations()[0]!.change_text).toBe("");
    expect(translations()[0]!.change_text).not.toBeNull();
  });

  // Google's v2 API HTML-escapes apostrophes and ampersands in translatedText
  // even under format=text. Neither Django nor the port unescapes them
  // (general.py:191 returns the string verbatim), so the entities are stored
  // and rendered as-is. Pinned as behaviour, not endorsed: this is the same
  // family as feedParser.test.ts's `caf&eacute;` note in TESTING.md.
  it("stores HTML entities verbatim, exactly as Django does", async () => {
    respond = () => translatedReply("Bwyd babanod &amp; ffrwythau &#39;ffres&#39;");

    await handleTranslateNeed(message(), env);

    expect(translations()[0]!.change_text).toBe("Bwyd babanod &amp; ffrwythau &#39;ffres&#39;");
  });

  // Need text is one item per line and routinely runs to dozens of lines. Form
  // encoding turns a newline into %0D%0A or %0A depending on the encoder, so
  // this asserts the round trip rather than the wire bytes: whatever the
  // encoder does, Google must be asked to translate the same string that is in
  // the column, including its line breaks and non-ASCII characters.
  it("sends multi-line and non-ASCII need text through intact", async () => {
    const text = "Beans\nSoup\nNappies (size 4–6)\nCafé style coffee";
    db.prepare("UPDATE foodbankchange SET change_text = ? WHERE id = ?").run(text, NEED);

    await handleTranslateNeed(message(), env);

    expect(fetchCalls[0]!.params.get("q")).toBe(text);
  });

  // KILLS THE `q: text.trim()` MUTANT, which survived the original suite:
  // every fixture above is already-clean text, so a stray trim (or any other
  // "tidy the text on the way out" edit) changed nothing any assertion could
  // see. This consumer must do NO cleaning of its own -- cleanFoodbankNeedText
  // (packages/models' textClean.ts:21-45, which trims, collapses double spaces
  // and drops blank lines) already ran in the ADMIN ROUTE above this layer
  // (routes/admin/needNew.ts:107-109, routes/admin/needs.ts:467-470), so
  // cleaning again here would translate one string and store the translation
  // of another, and the stored Welsh would not line up with the English it is
  // supposed to mirror.
  it("sends the column's bytes verbatim, without trimming or reflowing them", async () => {
    const text = "  Beans\n\n  Soup  \n";
    db.prepare("UPDATE foodbankchange SET change_text = ? WHERE id = ?").run(text, NEED);

    await handleTranslateNeed(message(), env);

    expect(fetchCalls[0]!.params.get("q")).toBe(text);
    expect(translations()[0]!.change_text).toBe(`[cy] ${text}`);
  });

  // Django puts the text in the URL (general.py:184's urllib.parse.quote), so a
  // need long enough to blow past a server's URL limit fails there; the port's
  // POST body has no such ceiling. 8 kB is well past the ~4 kB where that
  // starts to bite and is not an unrealistic need list.
  it("sends a very long need text in one request", async () => {
    const long = Array.from({ length: 400 }, (_, index) => `Item number ${index}`).join("\n");
    expect(long.length).toBeGreaterThan(4096);
    db.prepare("UPDATE foodbankchange SET change_text = ? WHERE id = ?").run(long, NEED);

    await handleTranslateNeed(message(), env);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.params.get("q")).toBe(long);
  });

  // The three sentinel values are contract (PLAN.md §7): "Nothing" means the
  // food bank needs nothing, not that the field is blank. This module has no
  // special case for them, so they are shipped to Google and the translation is
  // stored like any other -- which is right for display (a Welsh page should
  // say "Dim byd") but does mean roughly a third of all translate-need messages
  // pay for a call to translate a single stock word. Pinned as behaviour;
  // Django does the same thing.
  it("translates the sentinel change texts like any other text", async () => {
    db.prepare("UPDATE foodbankchange SET change_text = 'Nothing' WHERE id = ?").run(NEED);

    await handleTranslateNeed(message(), env);

    expect(fetchCalls[0]!.params.get("q")).toBe("Nothing");
    expect(translations()[0]!.change_text).toBe("[cy] Nothing");
  });
});

// ===========================================================================
// WHICH NEED, AND WHICH FOOD BANK
// ===========================================================================
describe("the need row it works from", () => {
  // TranslateNeedMessage.needId is the numeric rowid (packages/db's
  // needAdminExtras.ts:29 says so explicitly), and getNeedById looks up
  // `WHERE id = ?`. The fixture gives every need a need_id UUID that is NOT
  // its rowid so a lookup through the wrong column finds nothing rather than
  // finding the right row by luck.
  it("is found by numeric id, not by the need_id uuid", async () => {
    seedFoodbank();
    seedNeed({ id: NEED, changeText: "the right need" });
    seedNeed({ id: OTHER_NEED, changeText: "the wrong need" });

    await handleTranslateNeed(message({ needId: OTHER_NEED }), env);

    expect(fetchCalls[0]!.params.get("q")).toBe("the wrong need");
    expect(translations()).toEqual([
      { id: 1, need_id: OTHER_NEED, foodbank_id: SALISBURY, language: "cy", change_text: "[cy] the wrong need", excess_change_text: null },
    ]);
  });

  // foodbank_id is copied off the NEED row -- the message does not carry one.
  // Django reaches the same value through `self.foodbank = self.need.foodbank`
  // in FoodbankChangeTranslation.save() (needs.py:353-355). A wrong value here
  // is invisible: every read path in this app filters on (language, need_id)
  // and never on foodbank_id, so the column is denormalised bookkeeping that
  // only an analyst would ever notice being wrong.
  it("copies foodbank_id from the need row", async () => {
    seedFoodbank();
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank" });
    seedNeed({ foodbankId: DUNDEE });

    await handleTranslateNeed(message(), env);

    expect(translations()[0]!.foodbank_id).toBe(DUNDEE);
  });

  // A DELIBERATE DIVERGENCE, pinned rather than wished away. foodbankchange
  // .foodbank_id is nullable in D1 (0001_core.sql:112) and the port writes the
  // NULL straight through. Django cannot reach this state: its
  // FoodbankChangeTranslation.foodbank is a non-null FK, so
  // `self.foodbank = self.need.foodbank` with a food-bank-less need raises
  // IntegrityError and no row is written at all. The port silently writes a
  // half-orphaned row instead.
  //
  // In practice the admin refuses to publish a need with no food bank
  // ("Cannot publish a need with no food bank set", routes/admin/needs.ts:186),
  // so nothing enqueues one today -- this is what a manual enqueue would do.
  it("writes a NULL foodbank_id for a need with no food bank, where Django would refuse the row", async () => {
    seedNeed({ foodbankId: null });

    await handleTranslateNeed(message(), env);

    expect(translations()).toEqual([{ id: 1, need_id: NEED, foodbank_id: null, language: "cy", change_text: "[cy] Beans, Soup, Nappies", excess_change_text: null }]);
  });

  // No `published` guard anywhere in this module. Django only ever enqueues on
  // publish (needs.py:310-317's `do_translate = self.published`) and so does
  // this port (routes/admin/needs.ts:193-195), but the consumer itself will
  // translate whatever id it is handed. Worth pinning because it is the
  // difference between "the queue is a trusted internal channel" and "the queue
  // validates" -- it does not validate.
  it("translates an unpublished need without complaint", async () => {
    seedFoodbank();
    seedNeed({ published: 0 });

    await handleTranslateNeed(message(), env);

    // The whole row, not a count: "one row exists" would still hold for a
    // version that wrote an empty or half-filled row for an unpublished need.
    expect(translations()).toEqual([
      { id: 1, need_id: NEED, foodbank_id: SALISBURY, language: "cy", change_text: "[cy] Beans, Soup, Nappies", excess_change_text: null },
    ]);
  });

  // The message's own comment: "deleted since enqueue -- nothing to translate".
  // An admin who publishes and then deletes a need leaves three messages in
  // flight; each must ack quietly rather than burning three retries and a DLQ
  // slot on a row that will never come back.
  it("does nothing at all when the need has been deleted since enqueue", async () => {
    seedFoodbank();

    await expect(handleTranslateNeed(message({ needId: 9999 }), env)).resolves.toBeUndefined();

    // No paid API call, no row, no log -- but one session was still opened.
    expect(fetchCalls).toEqual([]);
    expect(translations()).toEqual([]);
    expect(errors).toEqual([]);
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });
});

// ===========================================================================
// REPLACE SEMANTICS -- what the write does to rows that are already there
// ===========================================================================
describe("when a translation already exists", () => {
  beforeEach(() => {
    seedFoodbank();
    seedNeed();
  });

  // Cloudflare Queues is at-least-once, so the same publish can deliver the
  // same (need, language) twice. replaceNeedTranslation DELETEs before it
  // INSERTs, so a redelivery leaves ONE row, not two. Without that the page
  // would still render (getNeedTranslation takes .first()), but the table would
  // grow a duplicate per redelivery forever and nothing would report it.
  it("a redelivery of the same message leaves exactly one row, with the newer text", async () => {
    await handleTranslateNeed(message(), env);
    respond = () => translatedReply("second attempt");
    await handleTranslateNeed(message(), env);

    const rows = translations();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.change_text).toBe("second attempt");
    // NOT asserted: that the row's id changed. It does not -- the table is a
    // plain `id INTEGER PRIMARY KEY` (0006_need_translations.sql), so SQLite
    // hands the freed rowid straight back to the INSERT and a delete-then-
    // insert is indistinguishable from an upsert by id alone. The DELETE's
    // real signature is in the two tests below, where it collapses duplicates
    // and clears a stale excess column.
    // ...and it was translated again, which is the cost of the redelivery:
    // there is no "already have this one" check anywhere.
    expect(fetchCalls).toHaveLength(2);
  });

  // The DELETE is scoped to (need_id, language). A missing `language` in that
  // WHERE clause would wipe the other two languages on every publish, and the
  // damage would show up as "the Irish page went back to English" days later,
  // for a food bank nobody was looking at.
  it("leaves the other languages' rows for the same need untouched", async () => {
    seedTranslation({ needId: NEED, language: "ga", changeText: "Irish text" });
    seedTranslation({ needId: NEED, language: "gd", changeText: "Gaelic text" });

    await handleTranslateNeed(message({ language: "cy" }), env);

    expect(translations().map((row) => [row.language, row.change_text])).toEqual([
      ["ga", "Irish text"],
      ["gd", "Gaelic text"],
      ["cy", "[cy] Beans, Soup, Nappies"],
    ]);
  });

  // ...and scoped to this need. A missing `need_id` would empty the whole
  // language on every publish -- every Welsh translation on the site, from one
  // admin clicking Publish.
  it("leaves the same language's rows for other needs untouched", async () => {
    seedNeed({ id: OTHER_NEED });
    seedTranslation({ needId: OTHER_NEED, language: "cy", changeText: "another need's Welsh" });

    await handleTranslateNeed(message(), env);

    expect(translations().map((row) => [row.need_id, row.change_text])).toEqual([
      [OTHER_NEED, "another need's Welsh"],
      [NEED, "[cy] Beans, Soup, Nappies"],
    ]);
  });

  // There is no unique index on (need_id, language) -- 0006_need_translations
  // .sql creates only a non-unique (language, need_id) index, matching Postgres
  // (needTranslations.ts:46-52 explains why the port did not tighten it). So
  // duplicates CAN exist from before; the DELETE clears all of them, which is
  // the self-healing property that keeps the absence of the constraint
  // survivable.
  it("clears pre-existing duplicate rows rather than leaving one behind", async () => {
    seedTranslation({ needId: NEED, language: "cy", changeText: "old one" });
    seedTranslation({ needId: NEED, language: "cy", changeText: "old two" });

    await handleTranslateNeed(message(), env);

    // id 1 again, not 3: with both older rows deleted there is no higher rowid
    // left, and SQLite reuses the lowest free one (0006_need_translations.sql
    // declares a plain `id INTEGER PRIMARY KEY`, not AUTOINCREMENT). Asserted
    // as it behaves so the row identity is not silently assumed to be stable.
    expect(translations()).toEqual([{ id: 1, need_id: NEED, foodbank_id: SALISBURY, language: "cy", change_text: "[cy] Beans, Soup, Nappies", excess_change_text: null }]);
  });

  // A previously-stored excess translation must not survive into a need that no
  // longer has excess text -- the DELETE removes the whole row, so the stale
  // Welsh "we have too much pasta" cannot outlive the English it came from.
  it("drops a stale excess translation when the need no longer has excess text", async () => {
    seedTranslation({ needId: NEED, language: "cy", changeText: "old", excessChangeText: "stale excess" });

    await handleTranslateNeed(message(), env);

    expect(translations()).toHaveLength(1);
    expect(translations()[0]!.excess_change_text).toBeNull();
  });
});

// ===========================================================================
// FAILURE -- the part that decides whether a broken key is ever noticed
// ===========================================================================
describe("when Google fails", () => {
  beforeEach(() => {
    seedFoodbank();
    seedNeed();
  });

  // A DELIBERATE DIVERGENCE, and the most consequential one here. Django's
  // get_translation (general.py:186-191) has `if request.status_code == 200:`
  // and otherwise falls off the end returning None, so a 403 raises nothing
  // there. The None travels on into translate_need's
  // `FoodbankChangeTranslation(change_text=translated_change)` /
  // `.save()` (general.py:214-220) -- and `change_text = models.TextField()`
  // (needs.py:350) carries no null=True, so what Django attempts is an INSERT
  // of NULL into a NOT NULL column.
  //
  // Corrected during review: this comment used to claim Django "writes a row
  // with change_text NULL and the task reports success", which the model
  // declaration contradicts. READ, NOT RUN -- no Python was executed for this
  // file, and the claim above is about what needs.py declares, not about an
  // observed traceback.
  //
  // The port throws before any write instead, which is what turns a broken key
  // into three retries and a jobs-dlq entry that handleJobsDlq logs
  // (workers/jobs/wrangler.jsonc:149-151 -- max_retries 3, dead_letter_queue
  // "jobs-dlq"). That is the better behaviour, and it is the reason this test
  // asserts the exact message: the STATUS and the response body are the only
  // description of the failure that reaches the log.
  it("throws with the status and the response body, and writes nothing", async () => {
    respond = () => ({ status: 403, body: '{"error":{"message":"API key not valid"}}' });

    await expect(handleTranslateNeed(message(), env)).rejects.toThrow('Google Translate API failed: 403 {"error":{"message":"API key not valid"}}');

    expect(translations()).toEqual([]);
  });

  // ...and the previous translation is still there. This is the other half of
  // the divergence: Django DELETEs first and translates second
  // (general.py:207-208), so a failed Django translation leaves the need with
  // NO translation at all. The port translates first and deletes only once it
  // has something to insert, so a Google outage costs the site nothing --
  // yesterday's Welsh text is still on the page.
  it("leaves the existing translation in place, unlike Django which deletes first", async () => {
    seedTranslation({ needId: NEED, language: "cy", changeText: "yesterday's good Welsh" });
    respond = () => ({ status: 500, body: "upstream error" });

    await expect(handleTranslateNeed(message(), env)).rejects.toThrow(/Google Translate API failed: 500/);

    expect(translations()).toEqual([{ id: 1, need_id: NEED, foodbank_id: SALISBURY, language: "cy", change_text: "yesterday's good Welsh", excess_change_text: null }]);
  });

  // A 200 with an HTML body -- a captive portal, a Google error page, an
  // edge-injected block page. res.json() rejects and the message fails; it is
  // NOT quietly stored as a null translation.
  it("throws when a 200 body is not JSON", async () => {
    respond = () => ({ status: 200, body: "<html>Service unavailable</html>" });

    await expect(handleTranslateNeed(message(), env)).rejects.toThrow(SyntaxError);

    expect(translations()).toEqual([]);
  });

  // DNS, TLS or a dropped connection. There is no try/catch and no timeout in
  // this module at all, so the rejection travels straight out to
  // handleJobsQueue.
  it("propagates a rejected fetch untouched", async () => {
    respond = () => new TypeError("fetch failed");

    await expect(handleTranslateNeed(message(), env)).rejects.toThrow("fetch failed");

    expect(translations()).toEqual([]);
  });

  // THE INCIDENT SHAPE THIS TIER EXISTS FOR. GCP_TRANSLATE_KEY is a secret
  // (wrangler.jsonc:233) with no local default; if it is missing from the
  // deployed Worker the code does not check, it interpolates `undefined` into
  // the query string and asks Google to authenticate with the literal string
  // "undefined". Google answers 400, the message retries three times and lands
  // in jobs-dlq. Nothing anywhere says "the translate key is missing".
  it("sends the literal string undefined when the key is unset, and fails on Google's answer", async () => {
    env = { ...env, GCP_TRANSLATE_KEY: undefined as unknown as string };
    respond = () => ({ status: 400, body: '{"error":{"message":"API key not valid. Please pass a valid API key."}}' });

    await expect(handleTranslateNeed(message(), env)).rejects.toThrow(/Google Translate API failed: 400/);

    expect(fetchCalls[0]!.url).toBe("https://translation.googleapis.com/language/translate/v2?key=undefined");
    expect(translations()).toEqual([]);
  });

  // All-or-nothing across the two texts: Promise.all rejects as soon as either
  // call fails, so a need whose change text translated fine still writes
  // nothing. Right call -- half a translation would render as a Welsh needs
  // list beside an English excess list -- but it does mean the successful call
  // was paid for and thrown away, and will be paid for again on the retry.
  it("writes nothing when only the excess text fails", async () => {
    db.prepare("UPDATE foodbankchange SET excess_change_text = 'Pasta, Rice' WHERE id = ?").run(NEED);
    respond = (call) => (call.params.get("q") === "Pasta, Rice" ? { status: 429, body: "rate limited" } : translatedReply("this one worked"));

    await expect(handleTranslateNeed(message(), env)).rejects.toThrow(/Google Translate API failed: 429/);

    expect(fetchCalls).toHaveLength(2);
    expect(translations()).toEqual([]);
  });
});

// ===========================================================================
// FAILURE -- D1 side
// ===========================================================================
describe("when D1 fails", () => {
  beforeEach(() => {
    seedFoodbank();
    seedNeed();
  });

  // The read comes first, so a D1 outage costs nothing but the retry -- no
  // Google call is made and no money is spent.
  it("throws without calling Google when the need read fails", async () => {
    failOn = /SELECT \* FROM foodbankchange_full/;

    await expect(handleTranslateNeed(message(), env)).rejects.toThrow("D1_ERROR: Network connection lost");

    expect(fetchCalls).toEqual([]);
  });

  // SUSPECT -- pinned as it behaves, reported, NOT fixed here.
  //
  // replaceNeedTranslation's DELETE and INSERT are two separate statements with
  // no transaction and no session.batch() around them (packages/db's
  // needTranslations.ts:57-61; its own test file notes the same thing at
  // needTranslations.test.ts:406). If the DELETE commits and the INSERT fails,
  // the need is left with NO translation for that language at all -- worse than
  // where it started. The message does retry, so the usual outcome is
  // self-healing on redelivery; the row is permanently lost only if all three
  // retries fail, and the page then renders English with nothing to say why.
  it("loses the existing translation if the delete commits and the insert fails", async () => {
    seedTranslation({ needId: NEED, language: "cy", changeText: "yesterday's good Welsh" });
    failOn = /INSERT INTO foodbankchangetranslation/;

    await expect(handleTranslateNeed(message(), env)).rejects.toThrow("D1_ERROR: Network connection lost");

    // The old row is gone and no new one replaced it.
    expect(translations()).toEqual([]);
  });

  // The reverse order: a failing DELETE stops before the INSERT, so the old
  // row survives and no duplicate is created. This is the benign half and is
  // asserted so a future change that reordered the two statements is caught.
  it("leaves the existing translation alone if the delete itself fails", async () => {
    seedTranslation({ needId: NEED, language: "cy", changeText: "yesterday's good Welsh" });
    failOn = /DELETE FROM foodbankchangetranslation/;

    await expect(handleTranslateNeed(message(), env)).rejects.toThrow("D1_ERROR: Network connection lost");

    expect(translations()).toEqual([{ id: 1, need_id: NEED, foodbank_id: SALISBURY, language: "cy", change_text: "yesterday's good Welsh", excess_change_text: null }]);
  });
});

// ===========================================================================
// MESSAGE BODIES THE TYPE SAYS ARE IMPOSSIBLE
// ===========================================================================
//
// The producer is a different Worker (workers/site) sending over a queue.
// Nothing typechecks one against the other, so TranslateNeedMessage is a
// description of what is meant to arrive, not a guarantee.
describe("a malformed message", () => {
  beforeEach(() => {
    seedFoodbank();
    seedNeed();
  });

  // No needId: the bind throws (D1_TYPE_ERROR in production, TypeError here --
  // see the fidelity note on d1Session). It fails loudly rather than
  // translating some arbitrary row, which is the important half.
  it("with no needId throws before reaching Google", async () => {
    await expect(handleTranslateNeed({ type: "translate-need" } as unknown as TranslateNeedMessage, env)).rejects.toThrow(TypeError);

    expect(fetchCalls).toEqual([]);
    expect(translations()).toEqual([]);
  });

  // No validation of `language` anywhere -- not against the type's cy/ga/gd
  // union, not against the 4-language scope 0006_need_translations.sql
  // describes. A producer bug that sent "fr" would spend money at Google and
  // write a row that no read path in this app can ever return
  // (getNeedTranslation is only ever called with the request's own locale).
  // Pinned as behaviour; the type union is compile-time only.
  it("with an unsupported language is translated and stored anyway", async () => {
    await handleTranslateNeed({ type: "translate-need", needId: NEED, language: "fr" } as unknown as TranslateNeedMessage, env);

    expect(fetchCalls[0]!.params.get("target")).toBe("fr");
    expect(translations()[0]!.language).toBe("fr");
  });

  // `type` is consumed by handleJobsQueue's switch, never by this function, so
  // a direct call with the wrong type still runs. This documents that the
  // dispatch is the only gate -- there is no second check here.
  it("with the wrong type still translates when called directly", async () => {
    await handleTranslateNeed({ type: "media-backfill", needId: NEED, language: "cy" } as unknown as TranslateNeedMessage, env);

    expect(translations()).toEqual([
      { id: 1, need_id: NEED, foodbank_id: SALISBURY, language: "cy", change_text: "[cy] Beans, Soup, Nappies", excess_change_text: null },
    ]);
  });
});

// ===========================================================================
// THROUGH THE REAL "jobs" QUEUE CONSUMER
// ===========================================================================
//
// Everything above calls handleTranslateNeed directly. This module decides
// nothing about acks, retries or logging -- handleJobsQueue (queues/jobs.ts,
// wired in index.ts) does -- so the real consumer is mounted here to check
// what a thrown translation actually costs. wrangler.jsonc gives "jobs"
// max_batch_size 10, max_retries 3 and dead_letter_queue "jobs-dlq".
describe("dispatched through handleJobsQueue", () => {
  interface AckLog {
    acks: number[];
    retries: { index: number; options: unknown }[];
  }

  function batchOf(bodies: unknown[]): { batch: Parameters<typeof handleJobsQueue>[0] } & AckLog {
    const acks: number[] = [];
    const retries: { index: number; options: unknown }[] = [];
    const messages = bodies.map((body, index) => ({
      id: `msg-${index}`,
      timestamp: new Date("2026-09-05T19:28:08.853Z"),
      attempts: 1,
      body,
      ack: () => void acks.push(index),
      retry: (options?: unknown) => void retries.push({ index, options }),
    }));
    return { batch: { queue: "jobs", messages } as unknown as Parameters<typeof handleJobsQueue>[0], acks, retries };
  }

  beforeEach(() => {
    seedFoodbank();
    seedNeed();
  });

  it("routes a translate-need message to this handler and acks it", async () => {
    const { batch, acks, retries } = batchOf([message()]);

    await handleJobsQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(translations()[0]!.change_text).toBe("[cy] Beans, Soup, Nappies");
  });

  // A BARE retry(), with no delaySeconds -- unlike the charity and
  // needcheck-render consumers, which back off 60s. A Google 429 is therefore
  // redelivered immediately and at full batch size, which is the one thing
  // most likely to keep it a 429. Pinned as it behaves.
  it("retries with no backoff when the translation fails", async () => {
    respond = () => ({ status: 429, body: "rate limited" });
    const { batch, acks, retries } = batchOf([message()]);

    await handleJobsQueue(batch, env);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: undefined }]);
    // The log line is the only record this failure leaves anywhere. It carries
    // the whole message body, so the need and language are identifiable.
    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe('givefood2-jobs: "jobs" message failed');
    expect(errors[0]![1]).toEqual({ type: "translate-need", needId: NEED, language: "cy" });
    expect(String(errors[0]![2])).toContain("Google Translate API failed: 429");
  });

  // The deleted-need path returns rather than throwing, so it ACKS. Three
  // messages for a deleted need disappear without a log line -- correct, but
  // it is also indistinguishable from three successful translations from
  // outside.
  it("acks a message for a need that no longer exists, with no log line", async () => {
    const { batch, acks, retries } = batchOf([message({ needId: 9999 })]);

    await handleJobsQueue(batch, env);

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(errors).toEqual([]);
  });

  // A publish sends cy, ga and gd as one sendBatch, so all three routinely
  // arrive together. One language failing must not cost the other two -- the
  // try/catch in handleJobsQueue is per message, and a throw that escaped the
  // loop would leave two good translations unwritten and redelivered.
  it("keeps the other two languages when one of the three fails", async () => {
    respond = (call) => (call.params.get("target") === "ga" ? { status: 500, body: "upstream error" } : translatedReply(`[${call.params.get("target")}] ok`));
    const { batch, acks, retries } = batchOf([message({ language: "cy" }), message({ language: "ga" }), message({ language: "gd" })]);

    await handleJobsQueue(batch, env);

    expect(acks).toEqual([0, 2]);
    expect(retries.map((entry) => entry.index)).toEqual([1]);
    expect(translations().map((row) => [row.language, row.change_text])).toEqual([
      ["cy", "[cy] ok"],
      ["gd", "[gd] ok"],
    ]);
  });

  // The at-least-once guarantee, end to end through the real consumer: the
  // same publish delivered twice leaves one row per language, not two.
  it("is idempotent when the whole publish is redelivered", async () => {
    const bodies = [message({ language: "cy" }), message({ language: "ga" }), message({ language: "gd" })];

    await handleJobsQueue(batchOf(bodies).batch, env);
    const second = batchOf(bodies);
    await handleJobsQueue(second.batch, env);

    expect(second.acks).toEqual([0, 1, 2]);
    expect(translations().map((row) => row.language)).toEqual(["cy", "ga", "gd"]);
    // Six Google calls for three languages: a redelivery re-translates. That is
    // the price of having no "already translated" check, and it is why the
    // idempotency lives in the DELETE rather than in a skip.
    expect(fetchCalls).toHaveLength(6);
  });
});
