import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractMessages, handleWhatsappHookQueue, parseCommand, type InboundMessage } from "./whatsappHook";
import worker from "../index";
import type { Env } from "../../worker-configuration";

// queues/whatsappHook.ts -- the inbound WhatsApp command consumer, ported from
// the command half of `whatsapp_hook` (givefood/views.py:1366-1472 in the
// reference checkout at /Users/jasoncartwright/Sites/foodcharity). Every
// citation below was checked against that copy rather than inherited from the
// port's own comments; the port's :1366-1470 is right, and where a citation
// here differs by a line or two from the one in whatsappHook.ts, the number
// here is the one that was read.
//
// WHY THIS FILE EXISTS AT ALL. This is the STOP path. Someone who no longer
// wants WhatsApp messages from a food bank has exactly one way to say so:
// text "unsubscribe <slug>" to the number. From WP 4.8 until 2026-09-05 there
// was no consumer on this queue at all, so every one of those messages was
// signature-verified, enqueued, 200'd to Meta and dropped -- an opt-out that
// looked like it worked from every angle except the only one that matters.
// The failure this file is written against is the same shape: nothing here
// answers a request, so a consumer that quietly stops acting on commands is
// indistinguishable from a quiet week. Every assertion below is therefore
// about a ROW that changed or a REPLY that went out, never about a status or
// an absence of throwing.
//
// REAL EVERYTHING EXCEPT META. The database is Node's own SQLite carrying the
// real migration 0020 DDL for `whatsappsubscriber` (schemaFor, not
// transcribed), and getFoodbankIdBySlug, getFoodbankNotifyTarget,
// findWhatsappSubscriber, insertWhatsappSubscriber and
// deleteWhatsappSubscriber are the shipped implementations running their real
// SQL against it. sendWhatsappText is the shipped Graph client, pyNow the
// shipped timestamp helper, and the queue routing goes through the real
// index.ts dispatcher (last describe block). Only `fetch` is faked, because
// the Graph API is the only thing that leaves the machine.
//
// THE REPLY COPY IS ASSERTED BYTE FOR BYTE, not with toContain. These six
// strings are what a real person reads on their phone, they have been in
// production for months, and views.py:1415/1428/1433/1453/1466/1471 is where
// each one is written; the port claims to reproduce them "word for word" and
// that claim is only worth anything if something checks it. All six were
// diffed against the Django source while writing this file.
//
// MUTATION-TESTED TWICE per TESTING.md's convention -- once as this file was
// written and once by an adversarial review of it -- with the repo copied to a
// scratchpad OUTSIDE it both times and no source file ever edited in place.
// The second sweep ran 105 distinct mutants across whatsappHook.ts,
// whatsappClient.ts, packages/db's four whatsappsubscriber queries and
// index.ts's dispatcher; it killed 100 and found THREE real holes the first
// sweep had reported clean. Those three are closed, and each of the tests that
// closes them names the mutant it exists for. The full record, with the
// measured number of tests each mutant turned red, is at the bottom of this
// file.

// ../index reaches queues/jobs.ts -> notify/needEmail.ts, which imports
// render() from a package whose src/generated/ is a gitignored build artefact.
// Nothing here renders anything; this keeps the suite working on a fresh
// checkout, which is the same reason cachePurge.test.ts and
// needWhatsApp.test.ts mock it.
vi.mock("@givefood/templates", () => ({ render: async () => "<html></html>" }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// `whatsappsubscriber` COMES FROM THE MIGRATIONS, not from a CREATE TABLE
// typed out here: 0020 makes foodbank_id and created NULLABLE (deliberately --
// production has rows that way), and a hand-copied fixture that made them NOT
// NULL would fail the insert path for a reason production never would.
//
// `foodbank` is narrow -- the four columns these two queries read -- following
// needWhatsApp.test.ts and the workers/site route fixtures: the real table has
// 20-odd NOT NULL columns that nothing on this path touches, and seeding them
// would test the fixture rather than the code. The UNIQUE index on slug IS
// reproduced (migration 0001 declares foodbank_slug_uniq), because it is what
// makes getFoodbankIdBySlug's `.first()` deterministic: without it a duplicate
// slug would silently pick a row by insertion order.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);
${schemaFor("whatsappsubscriber")}
`;

// NAMES WITHOUT "Foodbank" ON THE END, because that is how Django stores them:
// `Foodbank.name` is "Salisbury" and `full_name()` appends the word
// (models/foodbank.py:261-269). These replies append it inline instead, so the
// fixture has to carry the real shape or the parity assertions would be
// checking the wrong string.
const SALISBURY = { id: 1, uuid: "0f0dcbfd50b3439cbdefcf1b7de4e2e2", name: "Salisbury", slug: "salisbury" };
const SID_VALLEY = { id: 2, uuid: "a1b2c3d4e5f60718293a4b5c6d7e8f90", name: "Sid Valley", slug: "sid-valley" };
// One of the nine names in DONT_APPEND_FOOD_BANK (const/general.py:164-174) --
// the ones full_name() must NOT append "Foodbank" to. See the test that uses it.
const SALVATION = { id: 3, uuid: "ffffffffffffffffffffffffffffffff", name: "Salvation Army", slug: "salvation-army" };

// Meta sends `from` WITHOUT a leading "+" (views.py:1377-1378 adds one, and so
// does normaliseFrom here), so the fixture uses the wire shape and every
// assertion about a stored row uses the "+" shape. Getting these two the wrong
// way round is the bug normaliseFrom exists to prevent.
const FROM_WIRE = "447700900123";
const FROM_STORED = "+447700900123";
// The Graph API wants no "+" either, so an outbound reply is addressed with the
// wire shape again (whatsappClient.ts's normalisePhone).
const TO_GRAPH = "447700900123";

const GRAPH_URL = "https://graph.facebook.com/v24.0/890504590819478/messages";
const TOKEN = "test-whatsapp-token-not-a-real-one";

// Fixed so the `created` assertions are exact strings rather than regexes.
// Only Date is faked: AbortSignal.timeout(15_000) inside the Graph client uses
// real timers and must keep doing so.
const NOW = new Date("2026-09-08T11:22:33.456Z");
const NOW_PY = "2026-09-08 11:22:33.456000";

type Bindable = null | number | bigint | string | Uint8Array;

interface SqlCall {
  sql: string;
  params: Bindable[];
}

interface GraphCall {
  url: string;
  method: string | undefined;
  authorization: string | null;
  contentType: string | null;
  body: Record<string, unknown>;
}

interface SubscriberRow {
  id: number;
  phone_number: string;
  foodbank_id: number | null;
  created: string | null;
  last_notified: string | null;
}

let db: DatabaseSync;
let sql: SqlCall[];
let withSession: ReturnType<typeof vi.fn>;
/** Every bookmark handed to withSession, in order -- see the session test. */
let bookmarks: unknown[];
let graphCalls: GraphCall[];
/** Per-call Graph API responses, consumed in order; anything past the end is a 200. */
let graphResponses: Array<{ status: number; text?: string } | Error>;
/** Runs before each statement executes. Tests use it to inject a D1 failure or
 *  to change the database mid-command; the default does nothing. */
let sqlHook: (sql: string, params: Bindable[]) => void;
let logs: string[];
let warns: string[];
let errors: unknown[][];

// The slice of the D1 Sessions API packages/db uses, over node:sqlite:
// prepare().bind().first() for the two food bank reads and the subscriber
// lookup, .run() for the insert and the delete.
//
// bind() returns a NEW statement rather than mutating the receiver, matching
// D1's immutable prepared statements. Every statement is recorded, because two
// claims below are about WHICH statements ran and in what order -- the
// not-found paths are defined by the writes that did NOT happen, and "no row
// was written" is a weaker assertion than "no INSERT was even prepared".
function d1Session(database: DatabaseSync, log: SqlCall[]): D1DatabaseSession {
  const record = (statementSql: string, params: Bindable[]) => {
    log.push({ sql: statementSql, params });
    sqlHook(statementSql, params);
  };
  const statement = (statementSql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(statementSql, next as Bindable[]),
    first: async <T>() => {
      record(statementSql, params);
      return (database.prepare(statementSql).get(...params) as T | undefined) ?? null;
    },
    all: async <T>() => {
      record(statementSql, params);
      return { results: database.prepare(statementSql).all(...params) as T[], success: true, meta: {} };
    },
    run: async () => {
      record(statementSql, params);
      const result = database.prepare(statementSql).run(...params);
      return { success: true, meta: { last_row_id: Number(result.lastInsertRowid), changes: Number(result.changes) } };
    },
  });
  return {
    prepare: (statementSql: string) => statement(statementSql, []),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

// THE OTHER CHANNELS' SECRETS ARE POPULATED ON PURPOSE, same reasoning as
// needWhatsApp.test.ts: this Worker holds all four notification credentials at
// once, so "the WhatsApp token is missing" always means "missing while
// Postmark, VAPID and Firebase are present". An env with everything blank
// makes a token guard that checks the wrong secret untestable.
function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: { withSession } as unknown as D1Database,
    WHATSAPP_TOKEN: TOKEN,
    POSTMARK_TOKEN: "test-postmark-token",
    FIREBASE_SERVICE_ACCOUNT: "{}",
    VAPID_PRIVATE_KEY: "test-vapid-private",
    VAPID_PUBLIC_KEY: "test-vapid-public",
    VAPID_ADMIN_EMAIL: "admin@example.org",
    SITE_DOMAIN: "https://www.givefood.org.uk",
    ...overrides,
  } as Env;
}

// A real Meta inbound-message envelope, trimmed of the fields this code never
// reads but keeping the nesting exactly as Meta sends it: entry[] ->
// changes[] -> value.messages[]. Hand-flattening this in the fixtures would
// test a shape Meta does not send.
function metaEnvelope(messages: unknown[]): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "0",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "442039206758", phone_number_id: "890504590819478" },
              contacts: [{ profile: { name: "A Person" }, wa_id: FROM_WIRE }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

const textMessage = (body: string, from: string = FROM_WIRE) => ({
  from,
  id: "wamid.TEST",
  timestamp: "1757330553",
  type: "text",
  text: { body },
});

/** The whole queue message for one person texting one command. */
const command = (body: string, from: string = FROM_WIRE) => metaEnvelope([textMessage(body, from)]);

interface Batch {
  batch: MessageBatch<unknown>;
  acks: number[];
  retries: Array<{ index: number; options: QueueRetryOptions | undefined }>;
}

function batchOf(bodies: unknown[], queue = "whatsapp-hook"): Batch {
  const acks: number[] = [];
  const retries: Array<{ index: number; options: QueueRetryOptions | undefined }> = [];
  const messages = bodies.map((body, index) => ({
    id: `msg-${index}`,
    timestamp: NOW,
    body,
    attempts: 1,
    ack: () => void acks.push(index),
    retry: (options?: QueueRetryOptions) => void retries.push({ index, options }),
  }));
  return { batch: { queue, messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<unknown>, acks, retries };
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

function seedFoodbank(fb: { id: number; uuid: string; name: string; slug: string }): void {
  db.prepare("INSERT INTO foodbank (id, uuid, name, slug) VALUES (?, ?, ?, ?)").run(fb.id, fb.uuid, fb.name, fb.slug);
}

// Django-shaped `created`, not toISOString(): nothing on this path sorts on it,
// but a fixture that writes the wrong shape is how the wrong shape spreads.
function seedSubscriber(id: number, phone: string, foodbankId: number | null): void {
  db.prepare(
    "INSERT INTO whatsappsubscriber (id, phone_number, foodbank_id, created, last_notified) VALUES (?, ?, ?, '2026-01-01 00:00:00.000000', NULL)",
  ).run(id, phone, foodbankId);
}

function subscriberRows(): SubscriberRow[] {
  return db
    .prepare("SELECT id, phone_number, foodbank_id, created, last_notified FROM whatsappsubscriber ORDER BY id")
    .all() as never;
}

/** The text of every reply that went to Meta, in order. */
function replies(): string[] {
  return graphCalls.map((call) => (call.body.text as { body: string }).body);
}

/** Every statement that ran, for order assertions. */
function statements(): string[] {
  return sql.map((call) => call.sql);
}

// Which of the six replies each outbound message is. Used only where the claim
// is about ORDER across several commands -- every one of the six strings is
// asserted in full elsewhere. The `UNRECOGNISED` fallback is the point: a
// seventh reply, or a mangled one, shows up in the diff as its own text rather
// than being quietly bucketed with something else.
function replyKinds(): string[] {
  return replies().map((text) => {
    if (text.startsWith("You've successfully subscribed to updates from ")) return "subscribed";
    if (text.startsWith("You're already subscribed to updates from ")) return "already-subscribed";
    if (text.startsWith("You've been unsubscribed from ")) return "unsubscribed";
    if (text.startsWith("You weren't subscribed to ")) return "not-subscribed";
    if (text.includes("Please check the spelling")) return "no-such-foodbank (subscribe)";
    if (text.includes("Have a look on https://www.givefood.org.uk")) return "no-such-foodbank (unsubscribe)";
    return `UNRECOGNISED: ${text}`;
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  for (const fb of [SALISBURY, SID_VALLEY, SALVATION]) seedFoodbank(fb);

  sql = [];
  bookmarks = [];
  graphCalls = [];
  graphResponses = [];
  sqlHook = () => {};

  withSession = vi.fn((bookmark?: string) => {
    bookmarks.push(bookmark);
    return d1Session(db, sql);
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers as HeadersInit);
      graphCalls.push({
        url: String(url),
        method: init.method,
        authorization: headers.get("Authorization"),
        contentType: headers.get("Content-Type"),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      const next = graphResponses.shift();
      if (next instanceof Error) throw next;
      return new Response(next?.text ?? "ok", { status: next?.status ?? 200 });
    }),
  );

  // The console is the only trace this consumer leaves other than the row and
  // the reply, so the lines are captured and asserted rather than silenced.
  logs = [];
  warns = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(String(args[0])));
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warns.push(String(args[0])));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.close();
});

/** Nothing was written and nothing was sent -- the shape of every ignored message. */
function expectNothingHappened(): void {
  expect(subscriberRows()).toEqual([]);
  expect(graphCalls).toEqual([]);
  expect(sql).toEqual([]);
}

// ===========================================================================
// extractMessages -- Meta's envelope walk
//
// The payload is an EXTERNAL shape Meta can extend at will, and this walk is
// defensive at every level for that reason. Its failure mode is silence: a key
// that moved means zero messages, which is exactly what an ordinary quiet hour
// looks like. tools/whatsapp-command/verify.ts covers some of this too, but
// that is a standalone script run by `pnpm test`, not by vitest -- these are
// the assertions a plain `vitest run` sees.
// ===========================================================================

describe("extractMessages", () => {
  // The values, not the count: a walk that returned the `change` objects
  // instead of the `message` objects would still return one thing per message.
  it("pulls the message objects out of a real Meta envelope", () => {
    const out = extractMessages(metaEnvelope([textMessage("subscribe salisbury")]));

    expect(out).toHaveLength(1);
    expect(out[0]!.from).toBe(FROM_WIRE);
    expect(out[0]!.type).toBe("text");
    expect(out[0]!.text?.body).toBe("subscribe salisbury");
  });

  // Meta batches: one webhook POST can carry several entries, each with several
  // changes, each with several messages. The flattening order is the order the
  // commands are then acted on, so "subscribe X" followed by "unsubscribe X" in
  // one payload has to come out that way round and not reversed.
  it("flattens every entry, change and message in envelope order", () => {
    const payload = {
      entry: [
        { changes: [{ value: { messages: [textMessage("one"), textMessage("two")] } }, { value: { messages: [textMessage("three")] } }] },
        { changes: [{ value: { messages: [textMessage("four")] } }] },
      ],
    };

    expect(extractMessages(payload).map((m: InboundMessage) => m.text?.body)).toEqual(["one", "two", "three", "four"]);
  });

  // The envelope Meta actually sends most of the time. Delivery receipts
  // ("sent", "delivered", "read") arrive on the same webhook as inbound
  // messages and carry `statuses` instead of `messages` -- if this walk threw
  // or mis-read one, every real message would be stuck behind a retry loop of
  // receipts.
  it("yields nothing for a statuses-only delivery receipt", () => {
    const receipt = {
      entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.X", status: "delivered" }] } }] }],
    };

    expect(extractMessages(receipt)).toEqual([]);
  });

  // Every level of the walk, one missing key at a time. A single `?.` removed
  // anywhere in extractMessages turns one of these into a TypeError, which
  // becomes a retry, three more attempts, and a dead letter -- for a payload
  // that simply had nothing in it for us.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "not an envelope"],
    ["a number", 42],
    ["an empty object", {}],
    ["an array", []],
    ["entry that is not an array", { entry: "nope" }],
    // Both of these are here because `!Array.isArray(entries)` is doing real
    // work that a truthiness or `=== undefined` check would not: a number and
    // a plain object are not iterable, so a narrower guard reaches the
    // `for...of` and throws -- which is a retry, three more attempts and a
    // dead letter for a payload that simply is not one of ours.
    ["entry that is a number", { entry: 42 }],
    ["entry that is an object", { entry: { 0: "not iterable" } }],
    ["a null entry", { entry: [null] }],
    ["an entry with no changes", { entry: [{}] }],
    ["changes that are not an array", { entry: [{ changes: {} }] }],
    ["a null change", { entry: [{ changes: [null] }] }],
    ["a change with no value", { entry: [{ changes: [{}] }] }],
    ["a value with no messages", { entry: [{ changes: [{ value: {} }] }] }],
    ["messages that are not an array", { entry: [{ changes: [{ value: { messages: "nope" } }] }] }],
  ])("yields nothing, and does not throw, for %s", (_name, payload) => {
    expect(extractMessages(payload)).toEqual([]);
  });

  // One bad entry or change must not cost the good ones in the same envelope
  // their messages: both levels `continue` rather than returning, so a shape
  // Meta added to one of them does not blank the whole batch. Both levels are
  // exercised, in the order they nest -- an unreadable ENTRY first, then an
  // unreadable CHANGE inside a good one -- because the two guards are separate
  // lines and either could be turned into a `return` on its own.
  it("keeps going past an entry and a change it cannot read", () => {
    const payload = {
      entry: [
        { id: "0" }, // no `changes` at all
        { changes: [{ value: { statuses: [] } }, { value: { messages: [textMessage("still here")] } }] },
      ],
    };

    expect(extractMessages(payload).map((m: InboundMessage) => m.text?.body)).toEqual(["still here"]);
  });

  // NO FILTERING AND NO COPYING -- the messages come out exactly as they went
  // in, including entries that are not objects at all. That is deliberate
  // division of labour (handleOne does the type/from/body filtering), but it is
  // also why a `null` in the array is a live hazard: see the retry test at the
  // bottom of "which inbound messages are acted on".
  it("passes each message through unfiltered, by reference", () => {
    const message = textMessage("subscribe salisbury");

    expect(extractMessages(metaEnvelope([message]))[0]).toBe(message);
    expect(extractMessages(metaEnvelope([null, "hello", 7]))).toEqual([null, "hello", 7]);
  });
});

// ===========================================================================
// parseCommand -- the command slice
//
// views.py:1386-1391. Two prefixes, INCLUDING the trailing space, matched
// against the lowercased and trimmed body. The offsets (10 and 12) are the
// thing most likely to be silently wrong: one too many and every slug loses
// its first letter, so nothing matches a food bank ever again -- which reads
// from the log exactly like a week in which nobody subscribed. (One too FEW
// is harmless, and the mutation sweep at the bottom of this file proves it:
// the prefix check has already established that the next character is a
// space, and the slice is trimmed, so slice(9) and slice(10) cannot be told
// apart by any input.)
// ===========================================================================

describe("parseCommand", () => {
  it("parses the two commands people are told to send", () => {
    expect(parseCommand("subscribe salisbury")).toEqual({ action: "subscribe", slug: "salisbury" });
    expect(parseCommand("unsubscribe salisbury")).toEqual({ action: "unsubscribe", slug: "salisbury" });
  });

  // "unsubscribe " does not start with "subscribe ", so the order of the two
  // `if`s does not actually matter -- but a swapped pair of ACTIONS would be
  // invisible to a test that only checked the slug, and it would unsubscribe
  // everyone who asked to subscribe.
  it("does not read an unsubscribe as a subscribe", () => {
    expect(parseCommand("unsubscribe sid-valley")).toEqual({ action: "unsubscribe", slug: "sid-valley" });
  });

  // The slice offsets, isolated. A one-character slug is the sharpest case:
  // slice(11) leaves "a" as "" where a longer slug would still look plausible
  // in a diff, so this is the test that turns a +1 mutant from "a slug nobody
  // noticed was truncated" into a visible failure.
  it("slices at exactly the length of each prefix", () => {
    expect(parseCommand("subscribe a")).toEqual({ action: "subscribe", slug: "a" });
    expect(parseCommand("unsubscribe a")).toEqual({ action: "unsubscribe", slug: "a" });
  });

  // Real people type on phones with autocapitalisation on. Django lowercases
  // the whole body before matching (views.py:1383), and food bank slugs are
  // lowercase, so this is what makes "Subscribe Salisbury" work at all.
  it("lowercases before matching, so shouting still works", () => {
    expect(parseCommand("SUBSCRIBE Salisbury")).toEqual({ action: "subscribe", slug: "salisbury" });
    expect(parseCommand("UnSubScribe Sid-Valley")).toEqual({ action: "unsubscribe", slug: "sid-valley" });
  });

  // Both ends of the body and the far end of the slug. A phone keyboard adds a
  // trailing space more often than not, and a pasted command often carries a
  // newline -- neither must cost the person their unsubscribe.
  //
  // BOTH BRANCHES CARRY INTERIOR PADDING, and that is the whole point of the
  // second line rather than an accident of how it is written. The two slugs
  // are trimmed by two SEPARATE `.trim()` calls, one per branch. An earlier
  // version of this test wrote the unsubscribe case as
  // "\n unsubscribe salisbury \n" -- padded at the ENDS only, which the body's
  // own trim() already removes -- so `text.slice(12).trim()` -> `text.slice(12)`
  // survived the mutation sweep untouched. That mutant is the STOP path
  // handing D1 " salisbury", finding no food bank, and telling the person to
  // check their spelling forever.
  it("strips whitespace around the body and around the slug", () => {
    expect(parseCommand("  subscribe   salisbury  ")).toEqual({ action: "subscribe", slug: "salisbury" });
    expect(parseCommand("\n  unsubscribe   salisbury \n")).toEqual({ action: "unsubscribe", slug: "salisbury" });
  });

  // The separator is a LITERAL SPACE, not "any whitespace": trim() touches only
  // the ends of the body, so "subscribe\tsalisbury" never starts with
  // "subscribe " and is silently not a command. Django behaves identically
  // (views.py:1386's `startswith('subscribe ')`), so this is parity -- and it
  // is the case a reader of the test above would otherwise assume works.
  it("requires a literal space as the separator, not any whitespace", () => {
    expect(parseCommand("subscribe\tsalisbury")).toBeNull();
    expect(parseCommand("subscribe\nsalisbury")).toBeNull();
  });

  // This expectation was wrong on the first reading of the code and the test is
  // what settles it: "subscribe " looks like it should parse to an empty slug,
  // but the whole body is trimmed BEFORE the prefix is tested, so the trailing
  // space is gone and the input is indistinguishable from the bare word.
  // Recorded rather than quietly "fixed": the natural reading is the wrong one.
  it("treats a bare 'subscribe', with or without a trailing space, as not a command", () => {
    expect(parseCommand("subscribe")).toBeNull();
    expect(parseCommand("subscribe ")).toBeNull();
    expect(parseCommand("unsubscribe")).toBeNull();
    expect(parseCommand("unsubscribe   ")).toBeNull();
  });

  // The silence is the product decision, not an oversight: this number receives
  // ordinary conversation, and answering "unknown command" to every "thank you"
  // would be worse than saying nothing (the module's own header says so, and
  // views.py:1386-1391 has no else branch).
  it.each(["thanks, this is great", "STOP", "resubscribe me please", "I subscribe to your newsletter", "", "   "])(
    "ignores ordinary conversation: %j",
    (body) => {
      expect(parseCommand(body)).toBeNull();
    },
  );

  // "STOP" deserves its own note rather than just a row above: it is the word
  // the mobile industry has trained everyone to send, and it does nothing here.
  // WhatsApp's own block/report is the real opt-out of last resort, so this is
  // not a dead end for the user -- but it does mean the one word most people
  // will try is not a command in either Django or the port.
  it("does not treat the industry-standard STOP as an unsubscribe", () => {
    expect(parseCommand("STOP")).toBeNull();
    expect(parseCommand("stop")).toBeNull();
  });

  // Everything after the prefix is the slug, spaces and all. A person typing
  // the food bank's NAME rather than its slug lands here, gets no match, and is
  // told to check the spelling -- which is the correct and intended outcome.
  it("keeps the whole remainder as the slug, including interior spaces", () => {
    expect(parseCommand("subscribe sid valley")).toEqual({ action: "subscribe", slug: "sid valley" });
  });
});

// ===========================================================================
// subscribe
//
// views.py:1399-1434 _handle_subscribe. Look the food bank up by slug; if it
// is not there, say so; otherwise get_or_create and reply either "subscribed"
// or "already subscribed".
// ===========================================================================

describe("handleWhatsappHookQueue -- subscribe", () => {
  // THE CORE CLAIM: a row that did not exist now exists, with the number in the
  // stored shape, and the person was told. Asserted as the whole row rather
  // than field by field, because the columns this does NOT write are part of
  // the contract too -- last_notified stays NULL until the first send
  // (notifySubscribers.ts:126-128), and back-dating it here would silence the
  // first notification the person ever gets.
  it("writes the subscription and replies with Django's wording, word for word", async () => {
    const { batch, acks } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows()).toEqual([
      { id: 1, phone_number: FROM_STORED, foodbank_id: SALISBURY.id, created: NOW_PY, last_notified: null },
    ]);
    expect(replies()).toEqual([
      "You've successfully subscribed to updates from Salisbury Foodbank. You'll receive a message when they update " +
        "their shopping list. To unsubscribe, send 'unsubscribe salisbury'.",
    ]);
    expect(acks).toEqual([0]);
    // The happy path is SILENT on the error channel. Worth pinning explicitly:
    // every failure test below identifies itself by a console.error, so a
    // consumer that logged one on success too would make all of them vacuous.
    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
  });

  // The outbound half of the same reply: the endpoint, the sender id in the
  // URL, the Bearer token and the free-text (not template) message shape.
  // FREE TEXT IS CORRECT HERE and is the one thing about this send that is easy
  // to "fix" wrongly: an inbound message opens a 24-hour service window during
  // which free text is permitted, which is precisely the situation. Outside
  // that window Meta silently drops it, which is why notify/needWhatsApp.ts
  // uses an approved template instead.
  it("sends it as free text to the Graph API, not as a template", async () => {
    const { batch } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(graphCalls).toHaveLength(1);
    const call = graphCalls[0]!;
    expect(call.url).toBe(GRAPH_URL);
    expect(call.method).toBe("POST");
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.contentType).toBe("application/json");
    expect(call.body.messaging_product).toBe("whatsapp");
    expect(call.body.type).toBe("text");
    // The Graph API wants the number without a "+", and the row was just
    // written WITH one -- so this pins both halves of the round trip.
    expect(call.body.to).toBe(TO_GRAPH);
    expect(call.body.template).toBeUndefined();
  });

  // THE STATEMENTS, IN ORDER. A row-only assertion cannot see that the food
  // bank's name is read BEFORE the existing-subscriber check -- one wasted read
  // on the already-subscribed path -- nor that nothing else is queried. It is
  // also the cheapest way to catch a rewrite that dropped the slug lookup and
  // trusted the message.
  it("runs four statements: slug lookup, name, existing check, insert", async () => {
    const { batch } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(statements()).toEqual([
      "SELECT id FROM foodbank WHERE slug = ?",
      "SELECT uuid, slug, name FROM foodbank WHERE id = ?",
      "SELECT id FROM whatsappsubscriber WHERE phone_number = ?1 AND foodbank_id = ?2 ORDER BY id LIMIT 1",
      "INSERT INTO whatsappsubscriber (phone_number, foodbank_id, created) VALUES (?1, ?2, ?3)",
    ]);
    // The slug reaches SQL as a BOUND PARAMETER, never interpolated. The
    // injection test below is the other half of this claim.
    expect(sql[0]!.params).toEqual(["salisbury"]);
    expect(sql[2]!.params).toEqual([FROM_STORED, SALISBURY.id]);
  });

  // `created` is Django-shaped, not toISOString(). D1 stores it as TEXT and
  // SQLite compares TEXT lexicographically, so a "2026-09-08T11:22:33.456Z"
  // written here sorts AFTER every same-day Django value ("T" is 0x54, " " is
  // 0x20) -- the exact defect pyDatetime.ts exists to prevent, and the one that
  // already cost this repo a wrong "latest need" during the migration.
  it("stamps created in Django's format, not toISOString", async () => {
    const { batch } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    const created = subscriberRows()[0]!.created!;
    expect(created).toBe("2026-09-08 11:22:33.456000");
    expect(created).not.toContain("T");
    expect(created).not.toContain("Z");
    // Six fractional digits always, so every value this writes has the same
    // length and lexicographic order matches chronological order exactly.
    expect(created).toHaveLength(26);
  });

  // views.py:1420-1434's get_or_create and its `created == False` branch. Two things
  // must both hold: no second row, and a DIFFERENT reply -- because a person
  // who texts "subscribe" twice and gets the welcome message twice reasonably
  // concludes they are now subscribed twice.
  it("does not write a second row for someone already subscribed", async () => {
    seedSubscriber(1, FROM_STORED, SALISBURY.id);
    const { batch, acks } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows()).toHaveLength(1);
    expect(replies()).toEqual(["You're already subscribed to updates from Salisbury Foodbank."]);
    expect(acks).toEqual([0]);
    // No INSERT was even prepared.
    expect(statements().some((s) => s.startsWith("INSERT"))).toBe(false);
  });

  // ROWS THAT MUST NOT MATCH. The existing-subscriber check is
  // `phone_number = ?1 AND foodbank_id = ?2`; a check that dropped either half
  // would pass every test that seeded only the matching row. Both of these are
  // real production shapes -- one number legitimately appears against up to 10
  // different food banks (whatsappHook.ts:190-193 says so), and one food bank
  // obviously has many numbers.
  it("does not count a subscription to a different food bank", async () => {
    seedSubscriber(1, FROM_STORED, SID_VALLEY.id);
    const { batch } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows().map((r) => [r.phone_number, r.foodbank_id])).toEqual([
      [FROM_STORED, SID_VALLEY.id],
      [FROM_STORED, SALISBURY.id],
    ]);
    expect(replies()[0]).toContain("successfully subscribed");
  });

  it("does not count another number's subscription to the same food bank", async () => {
    seedSubscriber(1, "+447700900999", SALISBURY.id);
    const { batch } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    // Both rows in full: the stranger's row must survive untouched as well as
    // the new one being written, and a bare length of 2 cannot say that.
    expect(subscriberRows().map((r) => [r.phone_number, r.foodbank_id])).toEqual([
      ["+447700900999", SALISBURY.id],
      [FROM_STORED, SALISBURY.id],
    ]);
    expect(replies()[0]).toContain("successfully subscribed");
  });

  // views.py:1410-1417's Foodbank.DoesNotExist branch. The slug is echoed back
  // verbatim so the person can see what we heard -- which is why the quoting is
  // asserted along with the words.
  it("replies with the spelling advice, and writes nothing, for an unknown food bank", async () => {
    const { batch, acks } = batchOf([command("subscribe salisberry")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(replies()).toEqual([
      "Sorry, we couldn't find a foodbank with the name 'salisberry'. Please check the spelling and try again.",
    ]);
    expect(subscriberRows()).toEqual([]);
    expect(statements()).toEqual(["SELECT id FROM foodbank WHERE slug = ?"]);
    expect(acks).toEqual([0]);
  });

  // The slug is attacker-controlled: anyone who can send a WhatsApp message
  // chooses it. It reaches D1 as a bound parameter, so this is a lookup that
  // finds nothing rather than a statement that runs. Asserted by the table
  // still being there afterwards, which is the only assertion that would
  // actually fail if someone rewrote the query with a template literal.
  it("binds the slug rather than interpolating it", async () => {
    seedSubscriber(1, FROM_STORED, SALISBURY.id);
    const { batch } = batchOf([command("subscribe x'; delete from whatsappsubscriber; --")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows()).toHaveLength(1);
    expect(replies()[0]).toBe(
      "Sorry, we couldn't find a foodbank with the name 'x'; delete from whatsappsubscriber; --'. " +
        "Please check the spelling and try again.",
    );
  });

  // views.py:1377-1378. Meta sends the number without a "+" and every stored
  // number has one; a number that arrives WITH one must not end up as "++44...",
  // which would match nothing on the way back out and would be sent to the
  // Graph API as "+44..." after the client strips exactly one.
  it("adds the plus Meta omits, and does not double one that is already there", async () => {
    const { batch } = batchOf([command("subscribe salisbury", "447700900123"), command("subscribe sid-valley", "+447700900123")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows().map((r) => r.phone_number)).toEqual([FROM_STORED, FROM_STORED]);
  });

  // The `?? slug` fallback, and the only way to reach it: the food bank is
  // found by slug and then gone by the time it is read by id. That is a real
  // race -- gfadmin can delete a food bank at any moment, and these two reads
  // are separate statements on a session opened "first-unconstrained" -- and
  // without the fallback the reply would read "updates from undefined Foodbank".
  // Simulated by deleting the row between the two statements.
  it("falls back to the slug when the food bank vanishes between the two reads", async () => {
    sqlHook = (statementSql) => {
      if (statementSql.startsWith("SELECT uuid, slug, name")) db.prepare("DELETE FROM foodbank WHERE id = 1").run();
    };
    const { batch } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(replies()[0]).toContain("updates from salisbury Foodbank.");
    expect(replies()[0]).not.toContain("undefined");
    // The subscription is still written, and against the id that was read
    // before the row vanished -- so the person ends up subscribed to a food
    // bank that no longer exists. That is the current behaviour and it is
    // pinned, not endorsed; see suspectedBugs.
    expect(subscriberRows()).toEqual([
      { id: 1, phone_number: FROM_STORED, foodbank_id: SALISBURY.id, created: NOW_PY, last_notified: null },
    ]);
  });

  // SUSPECT, PINNED AS-IS, AND FAITHFUL TO DJANGO. The reply appends " Foodbank"
  // to `name` unconditionally, but nine food banks must not have it appended:
  // DONT_APPEND_FOOD_BANK (const/general.py:164-174) lists "Salvation Army",
  // "Oxford Food Hub", "Family Food Bank" and six more, and Django's own
  // full_name_en() (models/foodbank.py:261-269, which full_name() at :271-279
  // delegates to in every language) skips the suffix for exactly those. The
  // function named here was checked in the reference checkout: 261-269 is
  // full_name_en, not full_name. views.py:1428 does NOT use either -- it interpolates
  // `{foodbank.name} Foodbank` inline -- so Django sends "Salvation Army
  // Foodbank" too. The port has fullNameFoodbank() available in
  // @givefood/models and deliberately does not use it, which is the right call
  // for parity and the wrong one for the reader. Pinned so that changing it is
  // a visible decision rather than an accident.
  it("appends 'Foodbank' even to the names Django's full_name() exempts", async () => {
    const { batch } = batchOf([command("subscribe salvation-army")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(replies()[0]).toContain("updates from Salvation Army Foodbank.");
  });

  // The log line names the food bank but NOT the number -- "subscribed a
  // number to salisbury". That is deliberate: Workers logs are not the place
  // for a phone number. Asserted as an absence too, because the obvious
  // "improvement" while debugging is to add the number, and it would not be
  // noticed in review.
  it("logs the subscription without logging the phone number", async () => {
    const { batch } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(logs).toEqual(["whatsapp-hook: subscribed a number to salisbury"]);
    expect(logs.join("\n")).not.toContain("447700900123");
  });

  // THE INVISIBLE FAILURE, and the reason this tier exists. The Graph API
  // answering 500 does not throw and is not checked: sendWhatsappText returns
  // false and every caller ignores it. So the person is subscribed and will
  // start receiving need notifications having never been told the subscription
  // worked. The only trace is one console line, which is why it is asserted
  // exactly.
  it("keeps the subscription when the reply fails to send, and only logs it", async () => {
    graphResponses = [{ status: 500, text: "upstream boom" }];
    const { batch, acks, retries } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows()).toHaveLength(1);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(errors[0]![0]).toBe("whatsapp-hook: Graph API 500 for 447700900123: upstream boom");
  });

  // A 2xx THAT IS NOT 200 IS A FAILURE, deliberately and not by accident.
  // Django checks `response.status_code == 200` exactly
  // (notifications.py:512, read in the reference checkout), and the port
  // matched that rather than widening it to `res.ok`. Nothing downstream reads
  // the boolean sendWhatsappText returns, so this log line is the entire
  // observable difference between the two spellings -- which is exactly why it
  // is asserted rather than left to a `res.ok` rewrite to quietly erase.
  it("counts a 202 from the Graph API as a failure rather than a send", async () => {
    graphResponses = [{ status: 202, text: "queued" }];
    const { batch, acks } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(errors[0]![0]).toBe("whatsapp-hook: Graph API 202 for 447700900123: queued");
    expect(subscriberRows()).toHaveLength(1);
    expect(acks).toEqual([0]);
  });

  // The same silence when the fetch itself throws (DNS, TLS, the 15s abort).
  // Caught inside the client, so the consumer never sees it.
  it("keeps the subscription when the send throws outright", async () => {
    graphResponses = [new Error("network unreachable")];
    const { batch, acks } = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows()).toHaveLength(1);
    expect(acks).toEqual([0]);
    expect(errors[0]![0]).toBe("whatsapp-hook: send failed for 447700900123");
  });

  // A MISSING CREDENTIAL WRITES THE ROW AND SENDS NOTHING -- the exact shape of
  // the Browser Rendering credential that broke silently for a day in this
  // repo. The subscription is real, the person heard nothing, and the only
  // evidence is a console.warn from the client.
  //
  // TWO SENDERS, NEITHER OF THEM THE FIXTURE'S DEFAULT NUMBER. With one
  // command from FROM_WIRE this assertion could not tell "warns about the
  // recipient" from "warns about 447700900123" -- and a client whose warning
  // hardcoded a number survived the mutation sweep on exactly that. The
  // warning is the ONLY evidence a lost credential leaves, so it has to name
  // who was not reached.
  it("still writes the rows when WHATSAPP_TOKEN is unset, and warns per recipient rather than failing", async () => {
    const { batch, acks, retries } = batchOf([
      command("subscribe salisbury", "447700900777"),
      command("subscribe sid-valley", "447700900888"),
    ]);

    await handleWhatsappHookQueue(batch, buildEnv({ WHATSAPP_TOKEN: "" }));

    expect(subscriberRows().map((r) => [r.phone_number, r.foodbank_id])).toEqual([
      ["+447700900777", SALISBURY.id],
      ["+447700900888", SID_VALLEY.id],
    ]);
    expect(graphCalls).toEqual([]);
    expect(acks).toEqual([0, 1]);
    expect(retries).toEqual([]);
    expect(warns).toEqual([
      "whatsapp-hook: WHATSAPP_TOKEN not set, not sending to 447700900777",
      "whatsapp-hook: WHATSAPP_TOKEN not set, not sending to 447700900888",
    ]);
    // Nothing louder than a warn: this failure never reaches the log level an
    // alert would be built on, which is why it can run for a day unnoticed.
    expect(errors).toEqual([]);
  });
});

// ===========================================================================
// unsubscribe
//
// views.py:1437-1472 _handle_unsubscribe. This is the STOP path: the only
// mechanism a person has to make the messages stop other than blocking the
// number in WhatsApp itself.
// ===========================================================================

describe("handleWhatsappHookQueue -- unsubscribe", () => {
  it("deletes the subscription and replies with Django's wording, word for word", async () => {
    seedSubscriber(1, FROM_STORED, SALISBURY.id);
    const { batch, acks } = batchOf([command("unsubscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows()).toEqual([]);
    expect(replies()).toEqual([
      "You've been unsubscribed from Salisbury Foodbank. You won't receive any more updates. To subscribe again, " +
        "send 'subscribe salisbury'.",
    ]);
    expect(acks).toEqual([0]);
  });

  // ROWS THAT MUST SURVIVE. The delete is `phone_number = ?1 AND
  // foodbank_id = ?2`; dropping either half of that WHERE clause unsubscribes
  // either every subscriber of the food bank or this person from everything.
  // Both would be silent -- nobody complains about messages that stopped -- and
  // both pass a test that seeds only the row being deleted.
  it("deletes only this number's subscription to this food bank", async () => {
    seedSubscriber(1, FROM_STORED, SALISBURY.id);
    seedSubscriber(2, FROM_STORED, SID_VALLEY.id);
    seedSubscriber(3, "+447700900999", SALISBURY.id);
    seedSubscriber(4, "+447700900999", SID_VALLEY.id);
    const { batch } = batchOf([command("unsubscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows().map((r) => r.id)).toEqual([2, 3, 4]);
  });

  // THE ONE DELIBERATE DIVERGENCE FROM DJANGO in this file, and the reason it
  // is worth having. views.py:1459 uses `.get(phone_number=, foodbank=)`, which
  // raises MultipleObjectsReturned if the pair appears twice -- and migration
  // 0020's table has no unique constraint stopping that. In Django that
  // exception escapes whatsapp_hook, returns a 500 to Meta, and Meta
  // de-registers a webhook that stops returning 200: one duplicated row would
  // take the whole webhook down for everyone, and the person asking to stop
  // would stay subscribed. Here the DELETE takes them all and reports the count.
  it("deletes every duplicate row for the pair, where Django's .get() would have 500'd", async () => {
    seedSubscriber(1, FROM_STORED, SALISBURY.id);
    seedSubscriber(2, FROM_STORED, SALISBURY.id);
    seedSubscriber(3, FROM_STORED, SALISBURY.id);
    const { batch } = batchOf([command("unsubscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows()).toEqual([]);
    // One reply, not three.
    expect(replies()).toHaveLength(1);
    expect(logs).toEqual(["whatsapp-hook: unsubscribed a number from salisbury (3 row(s))"]);
  });

  // views.py:1468-1472's DoesNotExist branch. Distinguishing "you weren't
  // subscribed" from "done" is the whole reason deleteWhatsappSubscriber
  // returns a count, and it matters: a person who is told "you've been
  // unsubscribed" and then keeps getting messages (because the row was stored
  // under a different spelling of their number) has no way to tell what went
  // wrong.
  it("says so when there was nothing to delete", async () => {
    seedSubscriber(1, FROM_STORED, SID_VALLEY.id);
    const { batch, acks } = batchOf([command("unsubscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(replies()).toEqual(["You weren't subscribed to Salisbury Foodbank."]);
    expect(subscriberRows()).toHaveLength(1);
    expect(acks).toEqual([0]);
    expect(logs).toEqual([]);
  });

  // SUSPECT, PINNED AS-IS, AND INHERITED FROM DJANGO. Production stores some
  // numbers WITHOUT a leading "+" -- needWhatsApp.test.ts seeds both shapes for
  // that reason, and the send path strips the "+" so both shapes receive
  // messages perfectly well. But this path only ever looks for the "+" shape,
  // because normaliseFrom adds one unconditionally. So a person whose row was
  // stored without a "+" CANNOT UNSUBSCRIBE: they are told they were never
  // subscribed, and the notifications keep coming. Django has exactly the same
  // hole (views.py:1377-1378 adds the "+" the same way), so this is parity, not
  // a port regression -- but it is the STOP path failing closed in the wrong
  // direction, and it is reported rather than fixed here.
  it("cannot unsubscribe a row stored without a leading plus", async () => {
    seedSubscriber(1, "447700900123", SALISBURY.id);
    const { batch } = batchOf([command("unsubscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows()).toHaveLength(1);
    expect(replies()).toEqual(["You weren't subscribed to Salisbury Foodbank."]);
  });

  // views.py:1448-1455. A DIFFERENT not-found message from the subscribe path's
  // -- this one points at the website rather than at the spelling, because
  // someone trying to stop messages needs a way forward, not homework. The two
  // are easy to collapse into one shared string; they are not the same string.
  it("replies with the website link, not the spelling advice, for an unknown food bank", async () => {
    const { batch } = batchOf([command("unsubscribe salisberry")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(replies()).toEqual([
      "Sorry, we couldn't find a foodbank with the name 'salisberry'. Have a look on https://www.givefood.org.uk " +
        "to find the correct foodbank.",
    ]);
    expect(statements()).toEqual(["SELECT id FROM foodbank WHERE slug = ?"]);
  });

  it("runs three statements: slug lookup, name, delete", async () => {
    seedSubscriber(1, FROM_STORED, SALISBURY.id);
    const { batch } = batchOf([command("unsubscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(statements()).toEqual([
      "SELECT id FROM foodbank WHERE slug = ?",
      "SELECT uuid, slug, name FROM foodbank WHERE id = ?",
      "DELETE FROM whatsappsubscriber WHERE phone_number = ?1 AND foodbank_id = ?2",
    ]);
    expect(sql[2]!.params).toEqual([FROM_STORED, SALISBURY.id]);
  });

  it("falls back to the slug in the reply when the food bank vanishes mid-command", async () => {
    seedSubscriber(1, FROM_STORED, SALISBURY.id);
    sqlHook = (statementSql) => {
      if (statementSql.startsWith("SELECT uuid, slug, name")) db.prepare("DELETE FROM foodbank WHERE id = 1").run();
    };
    const { batch } = batchOf([command("unsubscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(replies()[0]).toContain("unsubscribed from salisbury Foodbank.");
    expect(subscriberRows()).toEqual([]);
  });

  // The same invisible failure as on the subscribe side, and worse here: the
  // row is gone, so the person WILL stop receiving messages, but they were
  // never told the unsubscribe worked. They will reasonably try again, be told
  // "You weren't subscribed", and conclude the whole thing is broken.
  it("still deletes the row when the confirmation cannot be sent", async () => {
    seedSubscriber(1, FROM_STORED, SALISBURY.id);
    graphResponses = [{ status: 401, text: "expired token" }];
    const { batch, acks } = batchOf([command("unsubscribe salisbury")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows()).toEqual([]);
    expect(acks).toEqual([0]);
    expect(errors[0]![0]).toBe("whatsapp-hook: Graph API 401 for 447700900123: expired token");
  });
});

// ===========================================================================
// Which inbound messages are acted on
//
// views.py:1373-1391's filtering. Everything rejected here is rejected in
// SILENCE, which is correct -- this number receives ordinary conversation --
// and is also why a filter that became too strict would never be noticed.
// ===========================================================================

describe("which inbound messages are acted on", () => {
  // views.py:1382 -- only text messages carry commands. Every one of these is
  // something Meta really sends to this number: a photo of a donation, a
  // thumbs-up reaction, a voice note, a shared location.
  it.each(["image", "reaction", "audio", "location", "sticker", "button", "interactive", "unsupported"])(
    "ignores a %s message entirely",
    async (type) => {
      const { batch, acks } = batchOf([
        metaEnvelope([{ from: FROM_WIRE, type, text: { body: "unsubscribe salisbury" } }]),
      ]);

      await handleWhatsappHookQueue(batch, buildEnv());

      expectNothingHappened();
      expect(acks).toEqual([0]);
    },
  );

  // The "thanks!" case. No reply of any kind -- not even an "unknown command"
  // -- because replying to every social message would be worse than silence.
  // Asserted through the whole consumer rather than through parseCommand alone,
  // because a caller that replied to a null command would still leave
  // parseCommand's own tests green.
  it("answers ordinary conversation with nothing at all", async () => {
    const { batch, acks } = batchOf([command("thanks, this is a great service")]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expectNothingHappened();
    expect(acks).toEqual([0]);
    expect(logs).toEqual([]);
  });

  // A command with no sender cannot be acted on and must not be guessed at:
  // without `from` there is nobody to subscribe.
  //
  // AN UNDOCUMENTED DIVERGENCE FROM DJANGO, in the port's favour. Django reads
  // `message.get('from', '')` (views.py:1375) and adds the "+" only when the
  // value is truthy (:1377) -- but it then passes `from_number` to
  // _handle_subscribe unconditionally (:1388), so a message with `from: ""`
  // and a valid command creates a WhatsappSubscriber row whose phone_number is
  // the empty string, and sends a reply to nobody. The port's `!from || !body`
  // guard skips instead. Meta always sends a `from`, so neither behaviour has
  // ever fired -- but the port's is the safe one and this is what pins it.
  it.each([
    ["no from at all", { type: "text", text: { body: "subscribe salisbury" } }],
    ["an empty from", { from: "", type: "text", text: { body: "subscribe salisbury" } }],
    ["no text object", { from: FROM_WIRE, type: "text" }],
    ["no body", { from: FROM_WIRE, type: "text", text: {} }],
    ["an empty body", { from: FROM_WIRE, type: "text", text: { body: "" } }],
    ["no type at all", { from: FROM_WIRE, text: { body: "subscribe salisbury" } }],
  ])("ignores a message with %s", async (_name, message) => {
    const { batch, acks } = batchOf([metaEnvelope([message])]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expectNothingHappened();
    expect(acks).toEqual([0]);
  });

  // One webhook, several commands, acted on in envelope order and all of them
  // acted on. A `break` where the loop wanted `continue`, or a handler that
  // only ever read messages[0], would lose everything after the first -- and
  // Meta batches under load, which is exactly when it matters.
  it("acts on every command in one webhook, in order", async () => {
    seedSubscriber(1, FROM_STORED, SID_VALLEY.id);
    const { batch } = batchOf([
      metaEnvelope([
        textMessage("subscribe salisbury"),
        textMessage("thanks!"),
        textMessage("unsubscribe sid-valley"),
        textMessage("subscribe salvation-army"),
      ]),
    ]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows().map((r) => r.foodbank_id)).toEqual([SALISBURY.id, SALVATION.id]);
    expect(replyKinds()).toEqual(["subscribed", "unsubscribed", "subscribed"]);
    // ...and each one addressed the food bank its own command named, which is
    // what a loop that reused the previous command's food bank would break.
    expect(replies()[0]).toContain("Salisbury Foodbank");
    expect(replies()[1]).toContain("Sid Valley Foodbank");
    expect(replies()[2]).toContain("Salvation Army Foodbank");
  });

  // Two people in one webhook -- Meta really does batch different senders into
  // one POST. Each is normalised and stored separately; a handler that hoisted
  // the `from` out of the loop would subscribe one person twice.
  it("keeps each sender's command to that sender", async () => {
    const { batch } = batchOf([
      metaEnvelope([textMessage("subscribe salisbury", "447700900111"), textMessage("subscribe sid-valley", "447700900222")]),
    ]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(subscriberRows().map((r) => [r.phone_number, r.foodbank_id])).toEqual([
      ["+447700900111", SALISBURY.id],
      ["+447700900222", SID_VALLEY.id],
    ]);
    expect(graphCalls.map((c) => c.body.to)).toEqual(["447700900111", "447700900222"]);
  });

  // Each command opens its OWN D1 session, with the bookmark
  // "first-unconstrained" -- meaning the first read may land on a replica that
  // has not caught up. Two commands in one webhook therefore do NOT share a
  // session and no bookmark is carried between them, so the second command's
  // reads are not guaranteed to see the first's write. Pinned because it is
  // invisible from every other angle and because the fix, if it ever matters,
  // is to thread getBookmark() through -- a change this assertion would make
  // visible.
  it("opens one unconstrained session per command, carrying no bookmark between them", async () => {
    const { batch } = batchOf([metaEnvelope([textMessage("subscribe salisbury"), textMessage("unsubscribe sid-valley")])]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(bookmarks).toEqual(["first-unconstrained", "first-unconstrained"]);
  });

  // SUSPECT, PINNED AS-IS. extractMessages pushes whatever is in the array,
  // including a null, and handleOne then reads `.type` off it -- a TypeError,
  // which the batch loop turns into a retry. Meta does not send this, so the
  // only way to get here is a corrupted or hostile payload that still carried a
  // valid signature; the cost is four attempts and a dead letter rather than a
  // quiet ack. Recorded, not fixed: the alternative (skipping non-objects) is a
  // one-line change that would also make a genuinely malformed payload
  // invisible.
  it("retries -- rather than ignores -- a payload with a null in the messages array", async () => {
    const { batch, acks, retries } = batchOf([metaEnvelope([null])]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(retries).toEqual([{ index: 0, options: undefined }]);
    expect(acks).toEqual([]);
    expect(errors[0]![0]).toBe("whatsapp-hook: message failed");
  });

  // SUSPECT, PINNED AS-IS -- the same hazard one level down, and the second
  // half of the malformed-payload question the null test above opens. `body`
  // is typed `string | undefined` but nothing checks it at runtime: a JSON
  // number passes the `!from || !body` guard (42 is truthy) and reaches
  // `body.trim()`, which throws. Four attempts and a dead letter for a message
  // that is not a command in any reading of it.
  //
  // A FALSY non-string is the opposite: 0 fails the truthiness guard and is
  // skipped in silence and acked, like any "thanks!". So which of the two a
  // malformed body gets depends on its VALUE and not its type, which is not a
  // split anyone would choose on purpose. Django's `.strip()` on a non-string
  // raises the same way (views.py:1383), so the throw is at least parity; the
  // truthiness split is the port's own.
  it("retries a text message whose body is a number, but silently acks a zero", async () => {
    const numeric = batchOf([metaEnvelope([{ from: FROM_WIRE, type: "text", text: { body: 42 } }])]);

    await handleWhatsappHookQueue(numeric.batch, buildEnv());

    expect(numeric.retries).toEqual([{ index: 0, options: undefined }]);
    expect(numeric.acks).toEqual([]);
    expect(errors[0]![0]).toBe("whatsapp-hook: message failed");
    expectNothingHappened();

    errors = [];
    const zero = batchOf([metaEnvelope([{ from: FROM_WIRE, type: "text", text: { body: 0 } }])]);

    await handleWhatsappHookQueue(zero.batch, buildEnv());

    expect(zero.acks).toEqual([0]);
    expect(zero.retries).toEqual([]);
    expect(errors).toEqual([]);
    expectNothingHappened();
  });

  // `text` itself replaced by a scalar. Meta has never sent this, but the walk
  // is `message.text?.body`, and on a string that is a property access which
  // quietly yields undefined rather than throwing -- so this one is acked in
  // silence where the numeric body above is dead-lettered. Pinned so the
  // difference between the two is on the record rather than discovered during
  // an incident.
  it("acks, in silence, a text message whose `text` is not an object", async () => {
    const { batch, acks, retries } = batchOf([
      metaEnvelope([{ from: FROM_WIRE, type: "text", text: "unsubscribe salisbury" }]),
    ]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(errors).toEqual([]);
    expectNothingHappened();
  });
});

// ===========================================================================
// The queue contract: ack, retry, and at-least-once delivery
//
// wrangler.jsonc gives "whatsapp-hook" max_batch_size 5, max_retries 3 and a
// whatsapp-hook-dlq dead-letter queue, so what this handler does with a failure
// decides whether a person's STOP is dropped, retried, or parked where a human
// can see it. Cloudflare delivers at least once, so every one of these paths
// can and will run twice for the same tick.
// ===========================================================================

describe("the queue contract", () => {
  // max_batch_size is 5, deliberately small because each message can send a
  // real WhatsApp message to a real person. Every message is acked
  // individually; ackAll() is never used, which is what keeps one failure from
  // acking the rest.
  // The rows are asserted as PAIRS and the replies by kind, not counted: three
  // rows is equally consistent with three people subscribed to the wrong food
  // bank, and with the fourth and fifth messages having been answered when
  // they should have been met with silence and a spelling correction.
  it("acks every message in a full batch, in order", async () => {
    const { batch, acks, retries } = batchOf([
      command("subscribe salisbury", "447700900001"),
      command("subscribe salisbury", "447700900002"),
      command("subscribe sid-valley", "447700900003"),
      command("thanks!", "447700900004"),
      command("subscribe nowhere", "447700900005"),
    ]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(acks).toEqual([0, 1, 2, 3, 4]);
    expect(retries).toEqual([]);
    expect(subscriberRows().map((r) => [r.phone_number, r.foodbank_id])).toEqual([
      ["+447700900001", SALISBURY.id],
      ["+447700900002", SALISBURY.id],
      ["+447700900003", SID_VALLEY.id],
    ]);
    // Four replies for five messages -- "thanks!" gets nothing at all -- and
    // the fifth is the spelling advice rather than a subscription.
    expect(replyKinds()).toEqual(["subscribed", "subscribed", "subscribed", "no-such-foodbank (subscribe)"]);
    expect(graphCalls.map((c) => c.body.to)).toEqual([
      "447700900001",
      "447700900002",
      "447700900003",
      "447700900005",
    ]);
  });

  // A D1 failure retries, with no delay option, and the module's comment says
  // why: re-running is safe because subscribe is find-then-insert and
  // unsubscribe is a delete. Three retries then whatsapp-hook-dlq.
  it("retries the message when a write fails, and the rest of the batch still runs", async () => {
    sqlHook = (statementSql, params) => {
      if (statementSql.startsWith("INSERT") && params[1] === SALISBURY.id) throw new Error("D1_ERROR: network");
    };
    const { batch, acks, retries } = batchOf([
      command("subscribe salisbury", "447700900001"),
      command("subscribe sid-valley", "447700900002"),
    ]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(retries).toEqual([{ index: 0, options: undefined }]);
    expect(acks).toEqual([1]);
    expect(subscriberRows().map((r) => [r.phone_number, r.foodbank_id])).toEqual([["+447700900002", SID_VALLEY.id]]);
    expect(errors[0]![0]).toBe("whatsapp-hook: message failed");
  });

  // IDEMPOTENCE UNDER AT-LEAST-ONCE DELIVERY, which is the property the retry
  // above depends on. The same webhook delivered twice leaves ONE row -- the
  // find-then-insert sees its own earlier write -- but it does send a second
  // WhatsApp message, and a different one. That second message is the visible
  // cost the module's comment acknowledges, and it is benign: "you're already
  // subscribed" is true.
  it("writes one row for a webhook delivered twice, and says so the second time", async () => {
    const first = batchOf([command("subscribe salisbury")]);
    await handleWhatsappHookQueue(first.batch, buildEnv());
    const second = batchOf([command("subscribe salisbury")]);

    await handleWhatsappHookQueue(second.batch, buildEnv());

    expect(subscriberRows()).toHaveLength(1);
    expect(replies()[0]).toContain("successfully subscribed");
    expect(replies()[1]).toBe("You're already subscribed to updates from Salisbury Foodbank.");
    expect(second.acks).toEqual([0]);
  });

  // The unsubscribe half of the same property: the delete is idempotent on the
  // row, and the second reply flips to "You weren't subscribed". Someone who
  // gets that message after successfully unsubscribing has hit a redelivery,
  // not a bug -- worth knowing when the support email arrives.
  it("deletes once for an unsubscribe delivered twice, and reports the second as 'weren't subscribed'", async () => {
    seedSubscriber(1, FROM_STORED, SALISBURY.id);
    const first = batchOf([command("unsubscribe salisbury")]);
    await handleWhatsappHookQueue(first.batch, buildEnv());
    const second = batchOf([command("unsubscribe salisbury")]);

    await handleWhatsappHookQueue(second.batch, buildEnv());

    expect(subscriberRows()).toEqual([]);
    expect(replies()[1]).toBe("You weren't subscribed to Salisbury Foodbank.");
    expect(logs).toEqual(["whatsapp-hook: unsubscribed a number from salisbury (1 row(s))"]);
  });

  // A MESSAGE THAT FAILS HALFWAY IS REPLAYED FROM THE TOP, commands included.
  // There is no per-command checkpoint -- the retry re-runs the whole payload
  // -- so the first command runs a second time. It is safe (one row, one extra
  // reply) but it is not free, and this is the test that shows what the person
  // actually receives across the two attempts.
  it("replays the earlier commands of a multi-command webhook when a later one fails", async () => {
    let failNext = true;
    sqlHook = (statementSql, params) => {
      if (failNext && statementSql.startsWith("INSERT") && params[1] === SID_VALLEY.id) {
        failNext = false;
        throw new Error("D1_ERROR: network");
      }
    };
    const payload = metaEnvelope([textMessage("subscribe salisbury"), textMessage("subscribe sid-valley")]);
    const first = batchOf([payload]);
    await handleWhatsappHookQueue(first.batch, buildEnv());

    // The retry Cloudflare would deliver: same body, same handler.
    const second = batchOf([payload]);
    await handleWhatsappHookQueue(second.batch, buildEnv());

    expect(first.retries).toEqual([{ index: 0, options: undefined }]);
    expect(second.acks).toEqual([0]);
    expect(subscriberRows().map((r) => r.foodbank_id)).toEqual([SALISBURY.id, SID_VALLEY.id]);
    expect(replyKinds()).toEqual([
      "subscribed", // attempt 1, salisbury
      "already-subscribed", // attempt 2, salisbury again -- the visible cost
      "subscribed", // attempt 2, sid-valley, which is what the retry was for
    ]);
  });

  // A body that is not an envelope at all is ACKED, not dead-lettered:
  // extractMessages returns [] and handleOne returns early. That is the right
  // call -- there is nothing a retry could achieve -- but it does mean a
  // producer that started sending the wrong shape would be completely silent.
  // The only defence is that workers/site enqueues the parsed JSON verbatim and
  // never constructs a body of its own.
  it.each([
    ["a string", "not an envelope"],
    ["null", null],
    ["an empty object", {}],
    ["a delivery receipt", { entry: [{ changes: [{ value: { statuses: [{ status: "read" }] } }] }] }],
  ])("acks %s without writing, sending, or logging anything", async (_name, body) => {
    const { batch, acks, retries } = batchOf([body]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expectNothingHappened();
    expect(errors).toEqual([]);
  });

  // A GRAPH API OUTAGE NEVER REACHES THE DEAD-LETTER QUEUE. sendWhatsappText
  // swallows the failure and returns false, so a whole batch of commands can be
  // processed while every single reply is lost, and the queue reports perfect
  // health. This is the one failure mode of this consumer that nothing --
  // not a retry, not a DLQ, not a discrepancy row -- will surface.
  //
  // THE THREE LOG LINES ARE ASSERTED IN FULL, not counted. Since the console is
  // the only record that these three people were left un-replied-to, a count
  // is worth very little: it cannot tell three lines naming three numbers from
  // three lines naming the same one. A client whose failure log hardcoded a
  // number survived the sweep against `expect(errors).toHaveLength(3)`, and
  // the outage it would then describe would be one person's, not three.
  it("acks a whole batch whose every reply failed to send, and names each lost recipient", async () => {
    graphResponses = [{ status: 503 }, { status: 503 }, { status: 503 }];
    const { batch, acks, retries } = batchOf([
      command("subscribe salisbury", "447700900001"),
      command("subscribe salisbury", "447700900002"),
      command("subscribe salisbury", "447700900003"),
    ]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(acks).toEqual([0, 1, 2]);
    expect(retries).toEqual([]);
    // All three subscriptions are real, and to the food bank each asked for.
    expect(subscriberRows().map((r) => [r.phone_number, r.foodbank_id])).toEqual([
      ["+447700900001", SALISBURY.id],
      ["+447700900002", SALISBURY.id],
      ["+447700900003", SALISBURY.id],
    ]);
    expect(errors.map((args) => args[0])).toEqual([
      "whatsapp-hook: Graph API 503 for 447700900001: ok",
      "whatsapp-hook: Graph API 503 for 447700900002: ok",
      "whatsapp-hook: Graph API 503 for 447700900003: ok",
    ]);
  });

  // An empty batch is not something the runtime delivers, but it is what a
  // filtered list would produce, and it must not do anything at all.
  it("does nothing for an empty batch", async () => {
    const { batch, acks, retries } = batchOf([]);

    await handleWhatsappHookQueue(batch, buildEnv());

    expect(acks).toEqual([]);
    expect(retries).toEqual([]);
    expectNothingHappened();
  });
});

// ===========================================================================
// Through the real index.ts queue dispatcher
//
// Routed through the SHIPPED dispatcher rather than by calling the handler
// directly, because the routing IS the thing that was missing for months: this
// queue had a producer, a wrangler declaration and a dead-letter queue, and no
// `case` in the switch. A test that only ever calls handleWhatsappHookQueue
// cannot tell the difference between the consumer that exists now and the one
// that did not exist then.
// ===========================================================================

describe("through the real index.ts queue dispatcher", () => {
  it('is what the "whatsapp-hook" queue name reaches', async () => {
    const { batch, acks, retries } = batchOf([command("subscribe salisbury")], "whatsapp-hook");

    await worker.queue(batch, buildEnv(), execCtx);

    expect(subscriberRows()).toEqual([
      { id: 1, phone_number: FROM_STORED, foodbank_id: SALISBURY.id, created: NOW_PY, last_notified: null },
    ]);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  // The dead-letter queue must NOT come back here: a message on whatsapp-hook-
  // dlq has already exhausted its three retries, and sending it round again is
  // how a poison message becomes an infinite loop. It goes to handleJobsDlq
  // instead, which logs and acks.
  //
  // SUSPECT, PINNED AS-IS: what it logs identifies nothing. jobsDlq.ts's
  // describe() looks for type/key/jobId/needId/tags, and a Meta envelope has
  // none of them, so a dead-lettered inbound WhatsApp message produces exactly
  // "whatsapp-hook-dlq: gave up on (no type)" -- no phone number, no command,
  // no food bank. Somebody's unsubscribe was lost and the log cannot say
  // whose. (Deliberately not "fixed" here: the phone number is the identifying
  // field, and putting it in the log is its own decision.)
  it("does not process commands arriving on whatsapp-hook-dlq, and logs nothing identifying", async () => {
    const { batch, acks } = batchOf([command("unsubscribe salisbury")], "whatsapp-hook-dlq");
    seedSubscriber(1, FROM_STORED, SALISBURY.id);

    await worker.queue(batch, buildEnv(), execCtx);

    // The seeded row in full, not a count: the claim is that the DLQ handler
    // ran NO part of the command, and an unchanged row says that where a
    // length of 1 would also be satisfied by a delete followed by an insert.
    expect(subscriberRows()).toEqual([
      {
        id: 1,
        phone_number: FROM_STORED,
        foodbank_id: SALISBURY.id,
        created: "2026-01-01 00:00:00.000000",
        last_notified: null,
      },
    ]);
    expect(graphCalls).toEqual([]);
    expect(sql).toEqual([]);
    expect(acks).toEqual([0]);
    expect(errors[0]![0]).toBe("whatsapp-hook-dlq: gave up on (no type)");
  });

  // The queue name in wrangler.jsonc and the case label in index.ts are two
  // separate strings that have to agree. If they ever stop agreeing, this is
  // what the runtime does: one log line naming the queue, nothing acked, and a
  // silent backlog until the retention period eats it.
  it("falls through to the default branch for a queue name nobody handles", async () => {
    const { batch, acks, retries } = batchOf([command("subscribe salisbury")], "whatsapp-hooks");

    await worker.queue(batch, buildEnv(), execCtx);

    expect(acks).toEqual([]);
    expect(retries).toEqual([]);
    expectNothingHappened();
    expect(errors[0]![0]).toBe('givefood2-jobs: unhandled queue "whatsapp-hooks"');
  });
});

// ===========================================================================
// MUTATION TESTING RECORD
//
// Per TESTING.md's convention. The repo was copied to a scratchpad OUTSIDE it
// -- no source file was ever edited in place, in either sweep -- and the
// module, the whatsappClient.ts half these replies reach, packages/db's four
// whatsappsubscriber queries and index.ts's dispatcher were broken there one
// change at a time, with this file re-run against each.
//
// SWEEP 1 (written with this file): 54 mutants, 51 killed.
// SWEEP 2 (adversarial review of it): 105 distinct mutants, 100 killed.
//
// Sweep 2 found FIVE survivors. Two are the genuinely equivalent slice
// offsets sweep 1 already identified. The other three were real holes that
// sweep 1 had reported clean, and all three are now closed:
//
//   * `text.slice(12).trim()` -> `text.slice(12)`, the UNSUBSCRIBE slug's
//     trim. Sweep 1 killed the subscribe branch's trim and recorded "trim()
//     dropped ... from the slug (1)" as if that covered both; the two
//     branches have separate `.trim()` calls, and the unsubscribe case in
//     "strips whitespace around the body and around the slug" was padded only
//     at the ENDS, which the body's own trim() removes first. The mutant
//     therefore changed nothing any test could see, while in production it
//     would hand D1 " salisbury" and make the STOP path permanently answer
//     "check the spelling". Closed by giving that case interior padding.
//   * whatsappClient.ts's failure log with the recipient replaced by a
//     hardcoded number. Every test that asserted the log line in full used
//     the fixture's own number, and the one test with three DIFFERENT
//     recipients asserted `errors).toHaveLength(3)`. Closed by asserting
//     those three lines in full.
//   * the same substitution in the WHATSAPP_TOKEN warning, surviving for the
//     same reason. Closed by sending that test's commands from two numbers
//     that are not the fixture default and asserting both warnings.
//
// The number in brackets below is how many tests actually went red, measured
// against this file, not estimated. Sweep 2's counts are quoted where they
// differ from sweep 1's or where sweep 2 added the mutant.
//
//   extractMessages: `entry` misread as `entries` (41); the message loop
//   pushing `change` instead of `message` (41); the entry guard narrowed from
//   Array.isArray to `=== undefined` (2); the same on messages (1); either
//   optional chain removed (1 each); the changes guard's `continue` turned
//   into `return` (1).
//
//   parseCommand: slice(10) -> slice(11) (28) and slice(12) -> slice(13) (16);
//   the subscribe branch returning the unsubscribe action (29) and vice versa
//   (16); the final `return null` falling through to a subscribe (11); trim()
//   dropped from the body (2) or from the slug (1); toLowerCase() dropped (1);
//   either prefix losing its trailing space (2 and 1).
//
//   normaliseFrom: the "+" never added (18) or added unconditionally (1).
//
//   handleOne: subscribe and unsubscribe swapped at the call site (34); the
//   `type !== "text"` check dropped (9) or widened to truthiness (8); the
//   null-command skip removed (3); either half of `!from || !body` dropped
//   (2 each).
//
//   subscribe/unsubscribe: the existing-subscriber check inverted (21) or made
//   dead (3); pyNow() replaced by toISOString() (3); the delete's count check
//   widened to `deleted < 0` (3); either `?? slug` fallback removed (1 each);
//   the reply wordings altered by one word (3, 3, 1, 1); the two not-found
//   texts swapped (2); the log line gaining the phone number (1) or losing the
//   row count (2); the two food bank reads reordered (1).
//
//   The batch loop: `await handleOne` left unawaited (37); ack() replaced by
//   retry() (35); retry() by ack() (3); retry() given a delaySeconds (3).
//
//   whatsappClient.ts, reached only through these replies: phone normalisation
//   removed (7); `status !== 200` widened to `!res.ok` (1); the token guard
//   made dead (1); the Bearer prefix dropped (1); the Graph version (1), the
//   phone-number id (1), the messaging_product (1) and the message `type` (1)
//   changed.
//
// Sweep 2's additions, all killed: extractMessages returning only the first
// message (6), reversed (5) or built with unshift (5); the batch loop reversed
// (2) or truncated to its first message (4); the envelope loop the same (3, 4);
// `from` (1) or `body` (3) hoisted out of the envelope loop to messages[0];
// `startsWith("subscribe ")` widened to `includes` (18); normaliseFrom's
// ternary branches swapped (18); subscribe's two arguments swapped at the call
// site (25); the not-found early return dropped on either side (3, 1); the two
// food bank reads reordered (1); an extra reply sent before the write (10);
// `deleted === 0` narrowed to `=== 1` (6) or widened to `!== 0` (7); the log
// lines deleted outright (1, 2); the LOG prefix changed (10); withSession's
// bookmark dropped (1) or changed to first-primary (1); the Graph client's
// POST turned into a PUT (1) and its `to`/message arguments swapped (23);
// index.ts's case label misspelled (1) and whatsapp-hook-dlq routed back into
// the live consumer (1); and, in packages/db, either predicate dropped from
// findWhatsappSubscriber's WHERE (5, 4) or the DELETE's (4, 3), its ORDER BY
// reversed (1), the insert's phone/foodbank bind order swapped (10), the
// insert back-dating last_notified (3), the delete's row count replaced by a
// constant (4) or by last_row_id (3), getFoodbankIdBySlug looking up by name
// (33) and getFoodbankNotifyTarget reading any row but the right one (13).
//
// THE TWO SURVIVORS, deliberately not chased, because no test could tell them
// apart from the original:
//
//   * `text.slice(10)` -> `slice(9)` and `text.slice(12)` -> `slice(11)`. The
//     prefix check has already established that the character at index 9 (or
//     11) is a space, and the slice is `.trim()`ed, so `(" " + s).trim()` and
//     `s.trim()` are the same string for every possible input. The offsets are
//     only load-bearing in the OTHER direction, and slice(11)/slice(13) are
//     killed by 28 and 16 tests respectively.
//
// AND ONE CLAIM SWEEP 1 MADE THAT DOES NOT HOLD. It listed
// `if (messages.length === 0) return;` -> "any other comparison" as a third
// equivalent survivor. Only the comparisons that stay false on an empty array
// are equivalent (`< 0`, `<= 0`); `=== 1` returns early for every
// single-message envelope, which is the common case, and sweep 2 measured it
// turning 33 tests red. The guard is load-bearing under that mutation and the
// record is corrected rather than left flattering.
// ===========================================================================
