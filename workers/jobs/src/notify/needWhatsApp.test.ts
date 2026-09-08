import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNotifyNeedWhatsApp, type NotifyNeedWhatsAppMessage } from "./needWhatsApp";
import { handleJobsQueue } from "../queues/jobs";
import type { Env } from "../../worker-configuration";

// The WhatsApp channel of gfadmin/views.py:2006's Notify, ported from
// send_whatsapp_notification() / send_whatsapp_template_notification()
// (givefood/utils/notifications.py:523-657 in the reference checkout at
// /Users/jasoncartwright/Sites/foodcharity -- the module's own header cites
// :521-660, which is a few lines out against that copy; the line numbers used
// below are the ones actually read there, not the ones inherited from the
// port's comments).
//
// WHY THIS FILE IS LONG FOR AN 80-LINE MODULE. Everything this consumer does
// is invisible. It runs off a queue with no request behind it, its only
// output is a POST to Meta and an UPDATE to a column nobody reads, and every
// one of its five early returns logs a line and then behaves exactly like a
// successful run that had nothing to do. The failure this repo has already
// lived through -- a Browser Rendering credential that broke silently for a
// day -- is the same shape as this module's first branch: `if
// (!env.WHATSAPP_TOKEN) return`. So the assertions below are about what was
// SENT and what was WRITTEN, and the silent paths are pinned by asserting the
// absence of both plus the exact log line that is their only trace.
//
// REAL EVERYTHING EXCEPT META. The database is Node's own SQLite carrying the
// real migrations' `whatsappsubscriber`, `foodbankchange` and
// `foodbankchange_full` DDL (schemaFor, not transcribed), and getNeedById,
// getWhatsappSubscribersPage, getFoodbankNotifyTarget and
// setWhatsappLastNotified are the shipped implementations running their real
// SQL against it. buildNeedTemplate / sendWhatsappTemplate are the shipped
// client. changeList and pyNow are the shipped helpers. Only `fetch` (the
// Graph API) and `JOBS_Q.send` are fakes, because those are the two things
// that leave the machine.
//
// MUTATION-TESTED per TESTING.md's convention: the repo was copied to a
// scratchpad OUTSIDE it, the module broken there on purpose, and this file
// re-run against each mutant. 36 mutants over two sweeps, across
// needWhatsApp.ts and the whatsappClient.ts half that only this handler
// reaches. Killed, with the number of tests that went red:
//
//   PAGE_SIZE 25 -> 1000 (2) and -> 24 (2); lastId advanced only on a
//   successful send (1); the last_notified write dropped (11) or issued once
//   per subscriber (1) or applied to everyone rather than the successes (5);
//   pyNow() replaced by toISOString() (9); the next page enqueued before the
//   loop (11) or with msg.afterId instead of lastId (7) or not awaited (2) or
//   enqueued from the empty-page branch too (4); the three template items
//   reordered (6) or the third blanked (3); name and slug transposed (7); the
//   need guard narrowed to `need === null` (2); the food bank guard narrowed
//   to `=== undefined` (1); the food bank read moved ahead of the subscriber
//   page (1); the token guard removed (2) or widened to also require another
//   secret (2); the message `type` string mistyped (5); the subscriber page
//   query ignoring afterId (4); the page walked backwards (15); the
//   missing-need console.error downgraded to a log (3). In the client:
//   `status !== 200` widened to `!res.ok` (1), a thrown fetch counted as a
//   send (1), phone normalisation removed (6), the header parameter given
//   the slug (2), the body parameter list missing the name (6), the template
//   renamed (1), the Graph version (1), the phone-number id (1), the
//   messaging_product (1), the language code (1), the button index typed as a
//   number (1), and the Bearer prefix dropped from the Authorization header
//   (1).
//
// ONE EQUIVALENT MUTANT, deliberately not chased: widening `if
// (notified.length > 0)` to `>= 0`. setWhatsappLastNotified starts with its
// own `if (ids.length === 0) return`, so the widened guard prepares no
// statement and changes nothing observable. No test could tell the two apart.
//
// ---------------------------------------------------------------------------
// ADVERSARIAL REVIEW PASS. The suite above was re-mutated independently, in a
// fresh out-of-tree copy of the repo, by an agent trying to break it rather
// than to confirm it. 38 mutants across needWhatsApp.ts, whatsappClient.ts,
// queues/jobs.ts, packages/db's notifySubscribers.ts and packages/models'
// changeList/pyNow; 32 died on that pass, and the three closed below plus
// three further variants of them (the stamp moved after the enqueue, a second
// session opened for the stamp, and the phone number and log prefix swapped at
// the sendWhatsappTemplate call) die now. Notable kills, in case they are ever
// weakened:
// the free-text send substituted for the approved template (28 red), the
// subscriber page's foodbank_id predicate dropped (21) and its `id > ?2`
// widened to `>=` (3), the page walked backwards (15), the last_notified bind
// order transposed (11), the enqueue hoisted above the send loop (11), the
// need guard narrowed so a NULL foodbank_id falls through (2), and the
// dispatcher acking a failure instead of retrying it (3).
//
// A NOTE ON MUTATION-TESTING THIS REPO, because the first attempt produced a
// clean-looking and completely false result: pnpm's workspace links inside
// node_modules are RELATIVE (`@givefood/db -> ../../../../packages/db`). A
// copy that symlinks node_modules wholesale therefore resolves every
// `@givefood/*` import back to the REAL repo, so mutations to packages/db and
// packages/models appear to survive no matter how good the tests are. The
// copy has to redirect @givefood into itself. Two "survivors" were that bug.
// A third was a mutant applied to the wrong one of two identical query
// strings in notifySubscribers.ts (webpush's, not WhatsApp's).
//
// THREE GENUINE SURVIVORS, all now closed:
//   1. `void setWhatsappLastNotified(...)` -- the stamp not awaited. The
//      ordering test claimed to catch exactly this and could not, because the
//      d1Session fake settled synchronously. Fixed in the fake, not by adding
//      an assertion; see the comment there.
//   2. `withSession("first-primary")` and a session created per query --
//      nothing asserted how this handler reaches D1. New test under "how it
//      reaches D1".
//   3. `LOG = "notify-need"` -- the log prefix on the only trace a failed send
//      leaves. New test under "a send that fails".
//
// TWO SURVIVORS LEFT ALONE, both equivalent rather than uncovered: dropping
// the page query's `ORDER BY id` (SQLite returns this fixture in rowid order
// anyway, so no assertion can distinguish it from the ordered form -- the DESC
// mutant above is what that test genuinely kills), and removing
// setWhatsappLastNotified's own empty-ids guard, which the handler's
// `notified.length > 0` makes unreachable. One mutant belongs to a neighbour
// and was left there: dropping `AbortSignal.timeout(15_000)` from the client
// survives THIS file but is killed by whatsappClient.test.ts, which owns it.

// @givefood/templates is mocked only because `../queues/jobs` (imported at the
// bottom of this file for the ack/retry tests) reaches needEmail.ts, which
// imports render() from a package whose src/generated/ is a gitignored build
// artefact. Nothing under test here renders anything; this keeps the suite
// working on a fresh checkout, which is the same reason foodbankAddSub.test.ts
// mocks it.
vi.mock("@givefood/templates", () => ({ render: async () => "<html></html>" }));

// TAKEN FROM THE MIGRATIONS, NOT TRANSCRIBED. `foodbankchange` loses its
// `foodbank_name` column in 0019, long after 0001 creates it, and
// `foodbankchange_full` is dropped and recreated around that -- so a
// hand-copied CREATE TABLE here would have been wrong on the day it was
// pasted. `whatsappsubscriber` comes from 0020 with its foodbank_id index,
// which is the index getWhatsappSubscribersPage's only query uses.
//
// `foodbank` is narrow (the four columns this path reads) following the
// precedent of the workers/site route fixtures: uuid/slug/name are what
// getFoodbankNotifyTarget selects, and name/slug are what foodbankchange_full
// LEFT JOINs for. Deliberately NOT a unique index on slug -- nothing here
// looks a food bank up by slug.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL
);
${schemaFor("foodbankchange", "foodbankchange_full", "whatsappsubscriber")}
`;

type Bindable = null | number | bigint | string | Uint8Array;

interface SqlCall {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite:
// prepare().bind().first() for the need and the food bank, .all() for the
// subscriber page, .run() for the last_notified stamp.
//
// bind() returns a NEW statement rather than mutating the receiver, matching
// D1's immutable prepared statements. Every statement that runs is recorded,
// because two of the claims below are about the NUMBER of statements rather
// than their result: setWhatsappLastNotified is deliberately one UPDATE for
// the whole page's successes (notifySubscribers.ts:157-168) and not one per
// subscriber, and it must not run at all when nothing succeeded.
//
// EVERY STATEMENT YIELDS BEFORE IT TOUCHES THE DATABASE, and that `await` is
// load-bearing rather than decorative. node:sqlite is synchronous, so a fake
// that ran the statement inside the async function's synchronous prologue
// would settle every query before the caller could reach its next line -- and
// under such a fake an UNAWAITED database call is indistinguishable from an
// awaited one. That made the ordering claim in "has already stamped the page
// before it enqueues the next one" untestable: MUTANT stamp-not-awaited
// (`void setWhatsappLastNotified(...)`) survived the entire suite, having
// written the row on a microtask that happened to run early enough. Real D1
// resolves over a network round trip and never does that, so the statement is
// recorded synchronously (D1 dispatches immediately) and its EFFECT deferred
// by a tick, which is the behaviour the handler is actually written against.
function d1Session(db: DatabaseSync, log: SqlCall[]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      log.push({ sql, params });
      await Promise.resolve();
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async <T>() => {
      log.push({ sql, params });
      await Promise.resolve();
      return { results: db.prepare(sql).all(...params) as T[], success: true, meta: {} };
    },
    run: async () => {
      log.push({ sql, params });
      await Promise.resolve();
      const result = db.prepare(sql).run(...params);
      return { success: true, meta: { last_row_id: Number(result.lastInsertRowid), changes: Number(result.changes) } };
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

// notifications.py:20-21 and whatsappClient.ts:20-25. The phone-number id is
// the WhatsApp Business sender and is public; pinned here because a wrong one
// posts to a real Graph endpoint that belongs to somebody else, which returns
// a perfectly ordinary error this module logs and ignores.
const GRAPH_URL = "https://graph.facebook.com/v24.0/890504590819478/messages";
const TOKEN = "test-whatsapp-token-not-a-real-one";

// Fixed so that every last_notified assertion below is an exact string rather
// than a regex. Only Date is faked: AbortSignal.timeout(15_000) inside the
// client uses real timers and must keep doing so.
const NOW = new Date("2026-09-08T11:22:33.456Z");
const NOW_PY = "2026-09-08 11:22:33.456000";

interface GraphCall {
  url: string;
  method: string | undefined;
  authorization: string | null;
  contentType: string | null;
  body: Record<string, unknown>;
}

interface QueueSend {
  body: unknown;
  /** How many Graph calls had already been made when the next page was enqueued. */
  graphCallsAtSendTime: number;
  /** The subscriber table as it stood at that instant. */
  rowsAtSendTime: SubscriberRow[];
}

interface SubscriberRow {
  id: number;
  phone_number: string;
  foodbank_id: number | null;
  last_notified: string | null;
}

let db: DatabaseSync;
let sql: SqlCall[];
let graphCalls: GraphCall[];
let queueSends: QueueSend[];
let jobsQueueSend: ReturnType<typeof vi.fn>;
let withSession: ReturnType<typeof vi.fn>;
/** Per-call Graph API responses, consumed in order; anything past the end is a 200. */
let graphResponses: Array<{ status: number; text?: string } | Error>;
let warns: string[];
let errors: unknown[][];
let logs: string[];

const SALISBURY = { id: 1, uuid: "0f0dcbfd50b3439cbdefcf1b7de4e2e2", name: "Salisbury Foodbank", slug: "salisbury" };
const DEVIZES = { id: 2, uuid: "a1b2c3d4e5f60718293a4b5c6d7e8f90", name: "Devizes", slug: "devizes" };
const TRUSSELL = { id: 3, uuid: "ffffffffffffffffffffffffffffffff", name: "Big Foodbank", slug: "big" };

// The need every test notifies about unless it says otherwise. Three items,
// which is exactly what the approved template has slots for.
const NEED_ID = 7;
const THREE_ITEMS = "Tinned Meat\nUHT Milk\nTinned Fruit";

function seedFoodbank(fb: { id: number; uuid: string; name: string; slug: string }): void {
  db.prepare("INSERT INTO foodbank (id, uuid, name, slug) VALUES (?, ?, ?, ?)").run(fb.id, fb.uuid, fb.name, fb.slug);
}

// Django-shaped timestamps in created/modified, not toISOString(): nothing
// here sorts on them, but a fixture that writes the wrong shape is how the
// wrong shape spreads.
function seedNeed(id: number, foodbankId: number | null, changeText: string): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, input_method, created, modified)
     VALUES (?, ?, ?, ?, 1, 'admin', '2026-09-08 09:00:00.000000', '2026-09-08 09:00:00.000000')`,
  ).run(id, `need${String(id).padStart(28, "0")}`, foodbankId, changeText);
}

function seedSubscriber(id: number, phone: string, foodbankId: number | null, lastNotified: string | null = null): void {
  db.prepare(
    "INSERT INTO whatsappsubscriber (id, phone_number, foodbank_id, created, last_notified) VALUES (?, ?, ?, '2026-01-01 00:00:00.000000', ?)",
  ).run(id, phone, foodbankId, lastNotified);
}

function subscriberRows(): SubscriberRow[] {
  return db.prepare("SELECT id, phone_number, foodbank_id, last_notified FROM whatsappsubscriber ORDER BY id").all() as never;
}

function lastNotifiedById(): Record<number, string | null> {
  return Object.fromEntries(subscriberRows().map((row) => [row.id, row.last_notified]));
}

// THE OTHER CHANNELS' SECRETS ARE POPULATED ON PURPOSE. This Worker holds
// all four notification credentials at once, so in production "the WhatsApp
// token is missing" always means "missing while Postmark, VAPID and Firebase
// are present". An env that left them all undefined made the credential guard
// untestable: MUTANT token-guard-checks-wrong-secret (`if
// (!env.WHATSAPP_TOKEN && !env.POSTMARK_TOKEN)`) survived the whole suite,
// and in production it would fall through with no WhatsApp token and POST
// `Authorization: Bearer undefined` to Meta once per subscriber.
function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: { withSession } as unknown as D1Database,
    JOBS_Q: { send: jobsQueueSend } as unknown as Queue<unknown>,
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

function message(afterId: number, needId: number = NEED_ID): NotifyNeedWhatsAppMessage {
  return { type: "notify-need-whatsapp", needId, afterId };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  for (const fb of [SALISBURY, DEVIZES, TRUSSELL]) seedFoodbank(fb);
  seedNeed(NEED_ID, SALISBURY.id, THREE_ITEMS);

  // INTERLEAVED ACROSS FOOD BANKS ON PURPOSE. 11 and 13/14 sit between and
  // after Salisbury's own two, so a `WHERE foodbank_id = ?` that did nothing
  // would send five messages instead of two and page on to id 14 -- neither
  // of which a fixture holding only Salisbury's rows could ever notice. Row
  // 13 has a NULL foodbank_id, which is legal in the 0020 schema.
  //
  // One number stored WITH a leading "+" and one WITHOUT, because both shapes
  // are in production and the Graph API rejects the "+" form.
  seedSubscriber(10, "+447700900010", SALISBURY.id);
  seedSubscriber(11, "+447700900011", DEVIZES.id);
  seedSubscriber(12, "447700900012", SALISBURY.id);
  seedSubscriber(13, "+447700900013", null);
  seedSubscriber(14, "+447700900014", DEVIZES.id);

  sql = [];
  graphCalls = [];
  queueSends = [];
  graphResponses = [];

  withSession = vi.fn((_bookmark?: string) => d1Session(db, sql));
  jobsQueueSend = vi.fn(async (body: unknown) => {
    queueSends.push({ body, graphCallsAtSendTime: graphCalls.length, rowsAtSendTime: subscriberRows() });
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

  // The console is this consumer's ONLY output on four of its five paths, so
  // the lines are captured and asserted rather than merely silenced.
  warns = [];
  errors = [];
  logs = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warns.push(String(args[0])));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(String(args[0])));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.close();
});

/** Nothing left the machine and nothing was written -- the shape of every silent return. */
function expectNothingHappened(): void {
  expect(graphCalls).toEqual([]);
  expect(queueSends).toEqual([]);
  expect(subscriberRows().every((row) => row.last_notified === null)).toBe(true);
}

// ===========================================================================

describe("handleNotifyNeedWhatsApp -- the send", () => {
  // THE PARITY ASSERTION, and the reason it is byte-for-byte rather than
  // toMatchObject: this payload's shape is a contract with a template Meta
  // approved, not a message body this code composes. `foodbankneed2`'s
  // parameters are POSITIONAL -- header {{1}} and body {{1}} are the food
  // bank name, body {{2}}..{{4}} are three items, and the button's URL suffix
  // is the slug -- so swapping name for slug, or reordering the components,
  // produces a message Meta accepts with a 200 and delivers reading "Salisbury
  // needs salisbury". Transcribed from notifications.py:559-612, component for
  // component.
  //
  // Kills the mutants that swap header/body text, that reorder the three
  // items, that put the slug in the header, and that rename the template.
  it("posts the approved template, component for component, exactly as Django builds it", async () => {
    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(graphCalls).toHaveLength(2);
    const call = graphCalls[0]!;
    expect(call.url).toBe(GRAPH_URL);
    expect(call.method).toBe("POST");
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.contentType).toBe("application/json");
    expect(call.body).toEqual({
      messaging_product: "whatsapp",
      // notifications.py:499 and :557 -- both of Django's send paths call
      // lstrip('+'), because the Graph API wants the number without a leading
      // "+" and this row is stored with one.
      to: "447700900010",
      type: "template",
      template: {
        name: "foodbankneed2",
        language: { code: "en" },
        components: [
          { type: "header", parameters: [{ type: "text", text: "Salisbury Foodbank" }] },
          {
            type: "body",
            parameters: [
              { type: "text", text: "Salisbury Foodbank" },
              { type: "text", text: "Tinned Meat" },
              { type: "text", text: "UHT Milk" },
              { type: "text", text: "Tinned Fruit" },
            ],
          },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "salisbury" }] },
        ],
      },
    });
  });

  // A number stored WITHOUT the "+" must not lose its first digit. `+` is
  // stripped by a regex anchored at the start, so "447700900012" survives
  // whole; a `replace("+", "")` with no anchor would too, but a slice(1)
  // would silently dial 47700900012.
  it("leaves a number stored without a leading plus alone", async () => {
    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(graphCalls.map((c) => c.body.to)).toEqual(["447700900010", "447700900012"]);
  });

  // A DELIBERATE DIVERGENCE FROM DJANGO, pinned as it is. Django writes
  // `to_phone.lstrip('+')`, which removes EVERY leading "+"; the port's
  // `replace(/^\+/, "")` removes exactly one. No production number has two,
  // so the two spellings agree on all real data -- but if one ever did, this
  // port sends "+44..." to Meta and the send fails where Django's would have
  // worked. Recorded, not fixed.
  it("strips only ONE leading plus, where Django's lstrip would strip both", async () => {
    db.prepare("UPDATE whatsappsubscriber SET phone_number = '++447700900010' WHERE id = 10").run();

    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(graphCalls[0]!.body.to).toBe("+447700900010");
  });

  // notifications.py:551-554 pads to three with empty strings. The template's
  // own wording is what makes a blank slot read sensibly, so the padding is
  // load-bearing: a template call with two parameters where Meta expects four
  // is rejected by Meta, and every subscriber of a food bank needing one item
  // gets nothing at all. (Not verified against the live API from here -- what
  // IS verified is that Django pads rather than omitting, which is the
  // behaviour this pins.)
  it("pads a one-item need out to the template's three slots with empty strings", async () => {
    seedNeed(8, SALISBURY.id, "Tinned Meat");

    await handleNotifyNeedWhatsApp(message(0, 8), buildEnv());

    const body = graphCalls[0]!.body.template as { components: Array<{ parameters: Array<{ text: string }> }> };
    expect(body.components[1]!.parameters.map((p) => p.text)).toEqual(["Salisbury Foodbank", "Tinned Meat", "", ""]);
  });

  // The other end of the same clamp: a fourth item is DROPPED, silently. The
  // approved template has three slots and cannot be given a fourth, so this
  // is the only thing the port could do -- but it means a food bank asking for
  // five things tells its WhatsApp subscribers about three. Faithful to
  // notifications.py:551-554, which slices the same way, and pinned so that a
  // later "helpfully" joined fourth item is a visible change.
  it("silently drops everything after the third item", async () => {
    seedNeed(8, SALISBURY.id, "Pasta\nRice\nTea\nCoffee\nSugar");

    await handleNotifyNeedWhatsApp(message(0, 8), buildEnv());

    const body = graphCalls[0]!.body.template as { components: Array<{ parameters: Array<{ text: string }> }> };
    expect(body.components[1]!.parameters.map((p) => p.text)).toEqual(["Salisbury Foodbank", "Pasta", "Rice", "Tea"]);
  });

  // changeList() is FoodbankChange.change_list()'s raw `split("\n")` -- no
  // blank-line filtering, unlike nonEmptyLines() which the /md/ pages use.
  // Verified against givefood/models/needs.py:134-135, which is two lines
  // long and does exactly this. So a leading blank line in change_text costs
  // the notification its first real item, and this pins that the port has the
  // same defect rather than quietly fixing one channel out of four.
  it("does not skip blank lines, so a leading newline costs the first item", async () => {
    seedNeed(8, SALISBURY.id, "\nTinned Meat\nUHT Milk\nTinned Fruit");

    await handleNotifyNeedWhatsApp(message(0, 8), buildEnv());

    const body = graphCalls[0]!.body.template as { components: Array<{ parameters: Array<{ text: string }> }> };
    expect(body.components[1]!.parameters.map((p) => p.text)).toEqual(["Salisbury Foodbank", "", "Tinned Meat", "UHT Milk"]);
  });

  // The same raw split leaves a "\r" attached when the stored text has CRLF
  // endings, because Python's str.split("\n") does too. Pinned rather than
  // trimmed: whatever this sends, Django sent the identical bytes.
  it("carries a CR through into the template parameter, as Python's split does", async () => {
    seedNeed(8, SALISBURY.id, "Pasta\r\nRice");

    await handleNotifyNeedWhatsApp(message(0, 8), buildEnv());

    const body = graphCalls[0]!.body.template as { components: Array<{ parameters: Array<{ text: string }> }> };
    expect(body.components[1]!.parameters.map((p) => p.text)).toEqual(["Salisbury Foodbank", "Pasta\r", "Rice", ""]);
  });

  // SUSPECT, and pinned as-is. "Nothing" / "Unknown" / "Facebook" are the
  // three sentinel change_text values (PLAN.md §7): they mean "this food bank
  // needs nothing", "we could not tell" and "check their Facebook page". This
  // channel does not filter them, so a need whose text is the "Nothing"
  // sentinel WhatsApps every subscriber a template reading "Salisbury Foodbank
  // needs: Nothing". Django does not filter them either --
  // send_whatsapp_notification (notifications.py:627-657) was read in full and
  // has no sentinel check anywhere in it -- so this is ported behaviour rather
  // than a port bug; the gate is upstream, in whether an admin presses Notify
  // for a need whose text is a sentinel at all.
  it("sends the 'Nothing' sentinel as if it were an item, exactly as Django does", async () => {
    seedNeed(8, SALISBURY.id, "Nothing");

    await handleNotifyNeedWhatsApp(message(0, 8), buildEnv());

    const body = graphCalls[0]!.body.template as { components: Array<{ parameters: Array<{ text: string }> }> };
    expect(body.components[1]!.parameters.map((p) => p.text)).toEqual(["Salisbury Foodbank", "Nothing", "", ""]);
    expect(graphCalls).toHaveLength(2);
  });

  // The header/body text is the food bank's `name`, NOT full_name() -- which
  // is what the notification EMAIL's subject uses. notifySubscribers.ts's own
  // comment records that this was checked per channel rather than assumed
  // consistent, and notifications.py:548 is the WhatsApp one:
  // `foodbank_name = need.foodbank.name`. Worth a test that would fail if an
  // alt_name or a full_name() ever crept in.
  it("titles the message with the food bank's plain name and links with its slug", async () => {
    db.prepare("UPDATE foodbank SET name = 'Renamed Foodbank', slug = 'renamed' WHERE id = ?").run(SALISBURY.id);

    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    const template = graphCalls[0]!.body.template as { components: Array<{ parameters: Array<{ text: string }> }> };
    expect(template.components[0]!.parameters[0]!.text).toBe("Renamed Foodbank");
    expect(template.components[2]!.parameters[0]!.text).toBe("renamed");
  });
});

describe("handleNotifyNeedWhatsApp -- who gets messaged", () => {
  // THE FILTER TEST. Five subscribers exist and three of them belong to other
  // food banks (or to none), with ids interleaved among Salisbury's own. A
  // `WHERE foodbank_id = ?` that was dropped, or an afterId comparison that
  // was `>=`, changes this list -- and changing it means WhatsApping people
  // who never subscribed to this food bank, which is the worst thing this
  // module can do.
  it("messages this food bank's subscribers and nobody else's", async () => {
    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(graphCalls.map((c) => c.body.to)).toEqual(["447700900010", "447700900012"]);
    // And the excluded rows are untouched in the table, not merely unmessaged.
    expect(lastNotifiedById()).toEqual({ 10: NOW_PY, 11: null, 12: NOW_PY, 13: null, 14: null });
  });

  // Keyset paging is EXCLUSIVE on afterId (`id > ?2`). Off by one in the
  // other direction and every page re-sends its predecessor's last message --
  // a duplicate WhatsApp to a real person on every page boundary.
  it("does not re-send to the subscriber whose id is the afterId", async () => {
    await handleNotifyNeedWhatsApp(message(10), buildEnv());

    expect(graphCalls.map((c) => c.body.to)).toEqual(["447700900012"]);
  });

  // ORDER BY id, not insertion order and not rowid-by-accident. The whole
  // paging scheme is keyset on id, so a page that came back unordered would
  // set lastId to whatever happened to be last and skip everyone between.
  it("walks subscribers in id order regardless of insertion order", async () => {
    db.exec("DELETE FROM whatsappsubscriber");
    seedSubscriber(30, "447700900030", SALISBURY.id);
    seedSubscriber(10, "447700900010", SALISBURY.id);
    seedSubscriber(20, "447700900020", SALISBURY.id);

    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(graphCalls.map((c) => c.body.to)).toEqual(["447700900010", "447700900020", "447700900030"]);
    expect(queueSends[0]!.body).toEqual({ type: "notify-need-whatsapp", needId: NEED_ID, afterId: 30 });
  });
});

describe("handleNotifyNeedWhatsApp -- how it reaches D1", () => {
  // THE DATABASE HAS READ REPLICATION ENABLED (PLAN.md §3.3, confirmed there
  // on 2026-08-30 for the provisioned `givefood` database), which is why
  // packages/db refuses to take the raw binding and takes a session instead
  // (db/src/types.ts:1-7). A bare `env.DB.prepare()` "will work in every
  // local/dev test and intermittently return stale data in production" -- so
  // no local test can catch that regression by its results, only by the shape
  // of the call. Hence asserting the call itself.
  //
  // ONE session, not one per query: the page read and the last_notified write
  // that follows it share a bookmark chain, and a second withSession() would
  // start unconstrained again and could read a replica behind the write this
  // handler just made. Kills MUTANT session-mode-first-primary and MUTANT
  // session-per-query, neither of which changes a single result locally.
  //
  // "first-unconstrained" is pinned as the repo-wide convention (all four
  // notify channels and every other jobs consumer use it), NOT as an
  // endorsement: it permits the need row read below to come from a replica
  // that has not yet caught up with the admin request that created it, which
  // would land in the "need is missing" branch and silently kill the fan-out.
  // Not observed in production from here -- recorded as the risk this mode
  // accepts.
  it("runs the whole handler through one first-unconstrained D1 session", async () => {
    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(withSession.mock.calls).toEqual([["first-unconstrained"]]);
    // And every statement really did go through it, rather than some of them
    // reaching a binding the fake env does not even provide a prepare() on.
    expect(sql.map((call) => call.sql.split(" ").slice(0, 2).join(" "))).toEqual([
      "SELECT *",
      "SELECT id,",
      "SELECT uuid,",
      "UPDATE whatsappsubscriber",
    ]);
  });
});

describe("handleNotifyNeedWhatsApp -- the last_notified stamp", () => {
  // notifications.py:652-654 stamps last_notified per successful send. The
  // value must be Django's `str(datetime)` and not toISOString(): D1 stores
  // these as TEXT and SQLite compares TEXT lexicographically, and " " (0x20)
  // sorts before "T" (0x54), so a single ISO write in this column would sort
  // ahead of every Django-written value for the same day. Asserted as an exact
  // string, six fractional digits included.
  it("stamps Django's str(datetime), not an ISO timestamp", async () => {
    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    const stamps = subscriberRows()
      .filter((row) => row.last_notified !== null)
      .map((row) => row.last_notified);
    expect(stamps).toEqual([NOW_PY, NOW_PY]);
    expect(NOW_PY).not.toContain("T");
    expect(NOW_PY).not.toContain("Z");
  });

  // ONE UPDATE FOR THE PAGE, not one per subscriber -- the module's own
  // comment says so, and it is why the handler collects ids as it goes. At 25
  // subscribers a per-subscriber stamp is 25 D1 round trips instead of one,
  // which is the difference between a page that finishes and one that does
  // not. Counted from the statement log rather than inferred.
  it("writes the whole page's successes in a single UPDATE", async () => {
    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    const updates = sql.filter((call) => call.sql.startsWith("UPDATE whatsappsubscriber"));
    expect(updates).toHaveLength(1);
    // The stamp first, then the ids -- setWhatsappLastNotified binds `nowIso`
    // ahead of the IN list, and a transposition would write a phone number's
    // worth of nonsense into last_notified and silently match no rows.
    expect(updates[0]!.params).toEqual([NOW_PY, 10, 12]);
  });

  // A page where every send failed must issue NO update at all: nobody was
  // notified, so nothing may claim they were. During a Meta outage this is
  // every page, and a stamp written anyway would mark 51 people as notified
  // about a need none of them heard about.
  //
  // The guard that does this is the handler's own `if (notified.length > 0)`;
  // setWhatsappLastNotified's `ids.length === 0` is belt-and-braces behind it
  // and is unreachable from here (MUTANT db-empty-guard-removed survives this
  // suite on its own, and correctly so -- neither guard is individually
  // observable, only the pair).
  //
  // NOT because an empty IN list would throw. An earlier version of this
  // comment said `IN ()` is a SQLite syntax error; it is not -- `UPDATE t SET
  // x = ? WHERE id IN ()` runs clean and matches nothing, checked on this
  // machine's node:sqlite, which is the same engine D1 is. So removing both
  // guards would be a silent wasted round trip rather than a crash, which is
  // strictly harder to notice and is the reason to assert the statement count.
  it("issues no UPDATE when every send failed", async () => {
    graphResponses = [{ status: 401, text: "expired token" }, { status: 401, text: "expired token" }];

    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(sql.some((call) => call.sql.startsWith("UPDATE"))).toBe(false);
    expect(lastNotifiedById()).toEqual({ 10: null, 11: null, 12: null, 13: null, 14: null });
  });

  // The stamp is written BEFORE the next page is enqueued. Cloudflare can
  // start the next message the instant it lands, and while the two pages do
  // not overlap in subscribers, a `void`-ed or post-enqueue stamp is how a
  // page's successes get lost when the isolate is torn down at the end of the
  // handler. Reading the table from inside send() is the only way to assert
  // the ORDER rather than the end state.
  //
  // Kills MUTANT stamp-not-awaited (`void setWhatsappLastNotified(...)`) and
  // MUTANT stamp-after-enqueue -- but ONLY because d1Session defers each
  // statement's effect by a microtask; see the comment on that fake. Against
  // the earlier synchronous fake both mutants survived this exact assertion,
  // which is why the fake is written the way it is rather than the obvious way.
  it("has already stamped the page before it enqueues the next one", async () => {
    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(queueSends).toHaveLength(1);
    expect(queueSends[0]!.rowsAtSendTime.map((row) => [row.id, row.last_notified])).toEqual([
      [10, NOW_PY],
      [11, null],
      [12, NOW_PY],
      [13, null],
      [14, null],
    ]);
    // And every send had already happened, so the next page cannot start
    // racing this one halfway through.
    expect(queueSends[0]!.graphCallsAtSendTime).toBe(2);
  });
});

describe("handleNotifyNeedWhatsApp -- a send that fails", () => {
  // Django checks `response.status_code == 200` exactly, on both send paths,
  // and the port matches rather than widening to res.ok. The Graph API answers
  // 200 on an accepted message, so a 201 here is genuinely unexpected -- but
  // it is worth pinning that it counts as a FAILURE, because that decides
  // whether last_notified moves.
  it("treats a 201 as a failure, exactly as Django's `== 200` does", async () => {
    graphResponses = [{ status: 201, text: "created" }];

    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(lastNotifiedById()[10]).toBeNull();
    expect(lastNotifiedById()[12]).toBe(NOW_PY);
  });

  // ONE FAILURE DOES NOT STOP THE PAGE, and -- this is the part worth
  // pinning -- the failed subscriber is PAGED PAST anyway. lastId is set from
  // every subscriber the loop touches, success or not, so a person whose send
  // failed is never retried by any later page and never by any retry of this
  // message: the next message's afterId is already beyond them. The only trace
  // is a console.error and a "sent 1/2" line.
  it("skips a failed send permanently -- the next page starts beyond it", async () => {
    graphResponses = [{ status: 400, text: "bad phone number" }];

    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(graphCalls).toHaveLength(2);
    expect(lastNotifiedById()).toEqual({ 10: null, 11: null, 12: NOW_PY, 13: null, 14: null });
    expect(queueSends[0]!.body).toEqual({ type: "notify-need-whatsapp", needId: NEED_ID, afterId: 12 });
    expect(logs).toContain(`notify-need-whatsapp: need ${NEED_ID} sent 1/2, next after id 12`);
  });

  // THE ONLY TRACE A FAILED SEND LEAVES, so what it is labelled with decides
  // whether anyone can find it. The client writes this line, but the prefix on
  // it comes from THIS module's `LOG` constant and is passed in as the fourth
  // argument -- whatsappClient.test.ts hands the client the string
  // "notify-need-whatsapp" itself, so nothing over there can tell whether the
  // WhatsApp handler actually supplies it. MUTANT log-prefix-renamed (LOG =
  // "notify-need") survived the whole suite: every send still failed the same
  // way, and the operator grepping the tail for the channel name during a Meta
  // outage would have found nothing at all.
  //
  // Asserted whole rather than by prefix, because the status code, the
  // recipient and Meta's own response body are the three things that turn
  // "sends are failing" into "the token expired".
  it("labels a failed send with this channel's own name, status, recipient and Meta's reply", async () => {
    graphResponses = [{ status: 401, text: '{"error":{"message":"Session expired"}}' }];

    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(errors).toEqual([
      [`notify-need-whatsapp: Graph API 401 for 447700900010: {"error":{"message":"Session expired"}}`],
    ]);
  });

  // A thrown fetch -- a DNS failure, a 15-second timeout, a torn-down socket
  // -- is caught by the client and reported as a failed send, not as an
  // exception. That is what keeps a Meta outage from throwing out of the
  // handler, retrying the page three times and re-sending to everyone whose
  // message DID get through before the outage started.
  it("survives fetch throwing, and carries on to the next subscriber", async () => {
    graphResponses = [new Error("connect ETIMEDOUT")];

    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(graphCalls).toHaveLength(2);
    expect(lastNotifiedById()[10]).toBeNull();
    expect(lastNotifiedById()[12]).toBe(NOW_PY);
    expect(queueSends).toHaveLength(1);
  });

  // The whole channel being down does not stop the fan-out either: the next
  // page is still enqueued, so the remaining subscribers are still walked
  // (and still fail). Costly but correct -- it is what makes a partial outage
  // recover on its own rather than stopping at the first bad page.
  it("still enqueues the next page when every send in this one failed", async () => {
    graphResponses = [{ status: 500 }, { status: 500 }];

    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(queueSends.map((s) => s.body)).toEqual([{ type: "notify-need-whatsapp", needId: NEED_ID, afterId: 12 }]);
    expect(logs).toContain(`notify-need-whatsapp: need ${NEED_ID} sent 0/2, next after id 12`);
  });
});

describe("handleNotifyNeedWhatsApp -- self-paging", () => {
  const PAGE_SIZE = 25;

  function seedBigFoodbank(): number[] {
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) {
      const id = 100 + i;
      seedSubscriber(id, `44770099${String(1000 + i)}`, TRUSSELL.id);
      ids.push(id);
    }
    return ids;
  }

  // PAGE_SIZE is 25 and it is a constant in the module, not a binding, so the
  // only way it is wrong is silently. A page that returned everything would
  // work perfectly at today's 51 subscribers across the whole estate and fail
  // the day one food bank has a few hundred -- which is precisely the scenario
  // the paging exists for and the one nobody will test by hand.
  it("sends exactly one page of 25 and hands the 26th to the next message", async () => {
    seedNeed(9, TRUSSELL.id, THREE_ITEMS);
    const ids = seedBigFoodbank();

    await handleNotifyNeedWhatsApp(message(0, 9), buildEnv());

    expect(graphCalls).toHaveLength(PAGE_SIZE);
    expect(queueSends[0]!.body).toEqual({ type: "notify-need-whatsapp", needId: 9, afterId: ids[PAGE_SIZE - 1] });
    // The 26th onwards are untouched, not merely unsent.
    expect(subscriberRows().filter((row) => row.last_notified !== null)).toHaveLength(PAGE_SIZE);
  });

  // The full chain, driven end to end: three messages for 30 subscribers,
  // every one messaged exactly once, and the chain STOPS. The stop is the
  // assertion that matters -- an empty page that still enqueued its successor
  // is an infinite loop billed per message, and it would look completely
  // healthy in the logs (a "done" line every few seconds, forever).
  it("walks every subscriber exactly once and then stops", async () => {
    seedNeed(9, TRUSSELL.id, THREE_ITEMS);
    const ids = seedBigFoodbank();
    const env = buildEnv();

    // BOUNDED, and the bound is asserted. A chain that never terminates is
    // the failure this test exists to catch, and an unbounded `while` catches
    // it by hanging the whole vitest worker until it is SIGABRTed -- which is
    // how the "empty page still enqueues" and "afterId never advances"
    // mutants first showed up here. Ten iterations is four times what 30
    // subscribers need, so overshooting means the chain is broken, not slow.
    let next: NotifyNeedWhatsAppMessage | null = message(0, 9);
    const afterIds: number[] = [];
    let guard = 0;
    while (next && guard++ < 10) {
      const before = queueSends.length;
      await handleNotifyNeedWhatsApp(next, env);
      next = queueSends.length > before ? (queueSends[before]!.body as NotifyNeedWhatsAppMessage) : null;
      if (next) afterIds.push(next.afterId);
    }

    expect(next).toBeNull();
    expect(afterIds).toEqual([ids[24], ids[29]]);
    // Three messages consumed, two enqueued: no message enqueues more than
    // one successor, and the last enqueues none.
    expect(queueSends).toHaveLength(2);
    expect(graphCalls).toHaveLength(30);
    expect(new Set(graphCalls.map((c) => c.body.to)).size).toBe(30);
    expect(subscriberRows().filter((row) => row.last_notified !== null)).toHaveLength(30);
    expect(logs).toContain("notify-need-whatsapp: need 9 done after id 129");
  });

  // A final message that finds nothing is ALWAYS spent, even when the last
  // real page was short: the handler cannot tell a full page from a short one,
  // so a food bank with two subscribers costs two messages, not one. Cheap,
  // but pinned because the alternative (`if (subscribers.length < PAGE_SIZE)
  // return`) is an obvious-looking optimisation that would silently truncate
  // any page where a row was deleted between the query and the count.
  it("spends one extra message discovering the list is finished", async () => {
    const env = buildEnv();
    await handleNotifyNeedWhatsApp(message(0), env);
    expect(queueSends).toHaveLength(1);

    await handleNotifyNeedWhatsApp(queueSends[0]!.body as NotifyNeedWhatsAppMessage, env);

    expect(queueSends).toHaveLength(1);
    expect(graphCalls).toHaveLength(2);
    expect(logs).toContain(`notify-need-whatsapp: need ${NEED_ID} done after id 12`);
  });

  // The terminating message does not even look the food bank up: the empty
  // page returns before getFoodbankNotifyTarget. Worth pinning because it is
  // the reason a deleted food bank does not turn the last message of every
  // fan-out into an error line.
  it("stops without reading the food bank when the page is empty", async () => {
    await handleNotifyNeedWhatsApp(message(999), buildEnv());

    expect(sql.some((call) => call.sql.includes("SELECT uuid, slug, name FROM foodbank"))).toBe(false);
    expectNothingHappened();
    expect(errors).toEqual([]);
  });

  // A food bank with no WhatsApp subscribers at all -- the common case, since
  // there are 51 subscribers across the entire estate. One query, no send, no
  // enqueue, one log line.
  it("does nothing at all for a food bank nobody has subscribed to", async () => {
    seedNeed(9, TRUSSELL.id, THREE_ITEMS);

    await handleNotifyNeedWhatsApp(message(0, 9), buildEnv());

    expectNothingHappened();
    expect(logs).toContain("notify-need-whatsapp: need 9 done after id 0");
  });
});

describe("handleNotifyNeedWhatsApp -- the silent returns", () => {
  // THE FAILURE THIS REPO HAS ALREADY HAD. A missing credential returns
  // quietly: no send, no stamp, and -- the part that makes it invisible -- no
  // next message, so the fan-out for that need simply stops. Nothing retries
  // it when the token comes back; the admin who pressed Notify saw a 302 and
  // has no way to tell that the WhatsApp channel did nothing. The one warning
  // line is the entire signal, so it is asserted verbatim.
  //
  // The database is not even opened, which is asserted too: it is the
  // difference between "skipped the channel" and "did the work and dropped it
  // at the last step".
  it("skips the whole channel when WHATSAPP_TOKEN is unset, and stops the chain", async () => {
    await handleNotifyNeedWhatsApp(message(0), buildEnv({ WHATSAPP_TOKEN: undefined as unknown as string }));

    expect(warns).toEqual(["notify-need-whatsapp: WHATSAPP_TOKEN not set, skipping"]);
    expect(withSession).not.toHaveBeenCalled();
    expectNothingHappened();
  });

  // An empty-string secret is what an unset wrangler secret looks like in
  // some deploy paths, and `!""` is the same as `!undefined` here. Pinned so
  // that a rewrite to `env.WHATSAPP_TOKEN === undefined` -- which would then
  // fall through and post an `Authorization: Bearer ` header to Meta for every
  // subscriber -- fails here.
  it("treats an empty-string token as no token", async () => {
    await handleNotifyNeedWhatsApp(message(0), buildEnv({ WHATSAPP_TOKEN: "" }));

    expect(warns).toEqual(["notify-need-whatsapp: WHATSAPP_TOKEN not set, skipping"]);
    expectNothingHappened();
  });

  // A need id with no row. Reachable in practice: the admin's Notify enqueues
  // four messages and then the need can be deleted while they are in flight.
  // Returns rather than throwing, which is deliberate -- throwing would retry
  // three times against a row that will never exist and then land in jobs-dlq
  // for a need that was legitimately deleted.
  it("gives up on a need that no longer exists, without retrying", async () => {
    await handleNotifyNeedWhatsApp(message(0, 4242), buildEnv());

    expect(errors).toEqual([["notify-need-whatsapp: need 4242 is missing or has no food bank"]]);
    expectNothingHappened();
  });

  it("gives up on a need whose foodbank_id is NULL", async () => {
    seedNeed(8, null, THREE_ITEMS);

    await handleNotifyNeedWhatsApp(message(0, 8), buildEnv());

    expect(errors).toEqual([["notify-need-whatsapp: need 8 is missing or has no food bank"]]);
    expectNothingHappened();
  });

  // The guard is `!need?.foodbank_id`, a truthiness test, so a foodbank_id of
  // 0 reads as "no food bank". SQLite's INTEGER PRIMARY KEY never allocates 0
  // and the ETL carries Postgres ids, so this is unreachable on real data --
  // pinned only because it is the one input that tells a truthiness guard
  // apart from a null check, and a future rewrite to `=== null` would change
  // this row's fate from "skipped" to "food bank 0 not found".
  it("reads a foodbank_id of 0 as no food bank at all", async () => {
    seedNeed(8, 0, THREE_ITEMS);

    await handleNotifyNeedWhatsApp(message(0, 8), buildEnv());

    expect(errors).toEqual([["notify-need-whatsapp: need 8 is missing or has no food bank"]]);
    expectNothingHappened();
  });

  // SUSPECT, pinned as-is. The food bank row is read AFTER the subscriber
  // page, so a need pointing at a deleted food bank with live subscribers
  // stops the fan-out dead: nothing is sent, nothing is stamped, and NO next
  // message is enqueued, so the remaining pages are never walked either. The
  // subscribers exist and the need exists; only the parent is gone. D1 has no
  // foreign keys (PLAN.md §4.5), so this is a state the database permits.
  // One console.error is the whole trace.
  it("stops the entire fan-out when the food bank row is missing but subscribers are not", async () => {
    seedNeed(8, 99, THREE_ITEMS);
    seedSubscriber(20, "447700900020", 99);

    await handleNotifyNeedWhatsApp(message(0, 8), buildEnv());

    expect(errors).toEqual([["notify-need-whatsapp: food bank 99 not found"]]);
    expect(graphCalls).toEqual([]);
    expect(queueSends).toEqual([]);
    expect(lastNotifiedById()[20]).toBeNull();
  });
});

describe("handleNotifyNeedWhatsApp -- redelivery", () => {
  // CLOUDFLARE QUEUES ARE AT-LEAST-ONCE, so the same message can arrive
  // twice: on a retry after a later failure, or on an ordinary redelivery.
  // This handler is NOT idempotent, and cannot easily be -- last_notified is
  // the only per-subscriber state and it is written after the send, not
  // before. A redelivered message therefore WhatsApps the same two people a
  // second time. Pinned because it is the behaviour to reason about when
  // deciding whether a failure should throw (retry the page, duplicating
  // sends) or return (drop the page silently), which is the choice every
  // branch in this module makes.
  it("sends again on a redelivered message -- there is no idempotency guard", async () => {
    const env = buildEnv();
    const msg = message(0);

    await handleNotifyNeedWhatsApp(msg, env);
    await handleNotifyNeedWhatsApp(msg, env);

    expect(graphCalls.map((c) => c.body.to)).toEqual([
      "447700900010",
      "447700900012",
      "447700900010",
      "447700900012",
    ]);
    // Two identical next-page messages too, so the tail of the chain is
    // duplicated as well as its head.
    expect(queueSends.map((s) => s.body)).toEqual([
      { type: "notify-need-whatsapp", needId: NEED_ID, afterId: 12 },
      { type: "notify-need-whatsapp", needId: NEED_ID, afterId: 12 },
    ]);
  });

  // An already-stamped last_notified is NOT read as "already notified": the
  // page query has no such filter, so the value is overwritten. Seeding a
  // yesterday stamp and asserting it moves is what proves the column is
  // write-only here rather than a de-duplication key someone might assume it
  // is.
  it("overwrites an existing last_notified rather than skipping the subscriber", async () => {
    db.prepare("UPDATE whatsappsubscriber SET last_notified = '2026-09-07 08:00:00.000000' WHERE id = 10").run();

    await handleNotifyNeedWhatsApp(message(0), buildEnv());

    expect(graphCalls).toHaveLength(2);
    expect(lastNotifiedById()[10]).toBe(NOW_PY);
  });
});

// ===========================================================================
// The consumer's ack/retry contract. The wrangler config gives the "jobs"
// queue max_retries 3 and a jobs-dlq dead-letter queue, so what this handler
// does with a failure decides whether it is dropped, retried three times, or
// parked somewhere a human can see it. handleJobsQueue is the real dispatcher
// (queues/jobs.ts:19-29) -- routed through it rather than reimplemented,
// because the routing itself is part of the claim: the `type` string this
// module puts on its next-page message has to be the same string the switch
// matches, and a typo would reach `default:` and throw the whole chain into
// jobs-dlq.
// ===========================================================================

function batchOf(bodies: unknown[]): { batch: MessageBatch<never>; acks: number[]; retries: number[] } {
  const acks: number[] = [];
  const retries: number[] = [];
  const messages = bodies.map((body, index) => ({
    id: `msg-${index}`,
    timestamp: NOW,
    body,
    attempts: 1,
    ack: () => void acks.push(index),
    retry: () => void retries.push(index),
  }));
  return { batch: { queue: "jobs", messages } as unknown as MessageBatch<never>, acks, retries };
}

describe("as the 'jobs' queue consumer delivers it", () => {
  it("acks a page that was sent, and routes the message by its own type string", async () => {
    const { batch, acks, retries } = batchOf([message(0)]);

    await handleJobsQueue(batch, buildEnv());

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(graphCalls).toHaveLength(2);
  });

  // Every failure this module handles itself ends in ack, not retry: a
  // missing token, a deleted need, a dead food bank and a Graph API outage
  // are all "return quietly". That is the deliberate design (queues/jobs.ts
  // :61-68 says so) and it is what stops one broken channel taking the other
  // three down -- but it is also why a broken WhatsApp token produces no
  // dead-letter message and no alert of any kind.
  it("acks -- never retries -- a page where the credential is missing", async () => {
    const { batch, acks, retries } = batchOf([message(0)]);

    await handleJobsQueue(batch, buildEnv({ WHATSAPP_TOKEN: "" }));

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(graphCalls).toEqual([]);
  });

  it("acks a page for a need that no longer exists", async () => {
    const { batch, acks, retries } = batchOf([message(0, 4242)]);

    await handleJobsQueue(batch, buildEnv());

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  // THE ONE FAILURE THAT DOES RETRY, and the cost of it is the point. The
  // enqueue of the next page is awaited and not guarded, so a queue outage
  // throws out of the handler, handleJobsQueue calls retry(), and the retried
  // message re-runs the WHOLE page -- re-sending a real WhatsApp message to
  // everyone who already received one, because last_notified is not consulted
  // on the way in. Three retries, then jobs-dlq. Pinned as behaviour, not
  // endorsed.
  it("retries -- and so re-sends the whole page -- when enqueuing the next page fails", async () => {
    jobsQueueSend.mockImplementationOnce(async () => {
      throw new Error("queue unavailable");
    });
    const { batch, acks, retries } = batchOf([message(0)]);

    await handleJobsQueue(batch, buildEnv());

    expect(retries).toEqual([0]);
    expect(acks).toEqual([]);
    // The sends already happened and the stamps are already written, so the
    // retry starts from an afterId of 0 again with two people already
    // messaged.
    expect(graphCalls).toHaveLength(2);
    expect(lastNotifiedById()).toEqual({ 10: NOW_PY, 11: null, 12: NOW_PY, 13: null, 14: null });
  });

  // A MALFORMED MESSAGE IS THE ONE THING THAT REACHES THE DEAD-LETTER QUEUE.
  // `needId: undefined` never gets as far as this module's own guards: it
  // fails at the BIND, one layer lower. node:sqlite refuses it outright
  // ("Provided value cannot be bound to SQLite parameter 1" -- run, not
  // assumed), so the handler throws, handleJobsQueue retries, and after
  // max_retries 3 the message lands in jobs-dlq. That is the right place for
  // a body that can never succeed, though it costs four attempts to get
  // there. Whether the real D1 binding rejects undefined identically is NOT
  // VERIFIED from here -- nothing in this repo runs against real D1 -- so the
  // claim this test pins is the local one: an unbindable needId throws rather
  // than being reported as a missing need.
  //
  // Pinned deliberately as a RETRY rather than an ack, because the obvious
  // "tidy-up" here -- validating the body and returning -- would silently
  // change a message that reaches a human into one that does not.
  it("retries a message with no needId at all, so it ends in jobs-dlq", async () => {
    const { batch, acks, retries } = batchOf([{ type: "notify-need-whatsapp", afterId: 0 }]);

    await handleJobsQueue(batch, buildEnv());

    expect(retries).toEqual([0]);
    expect(acks).toEqual([]);
    expect(graphCalls).toEqual([]);
    expect(queueSends).toEqual([]);
    // The dispatcher's own log line is what a maintainer would see, and it
    // carries the offending body.
    expect(errors[0]![0]).toBe(`givefood2-jobs: "jobs" message failed`);
    expect(errors[0]![1]).toEqual({ type: "notify-need-whatsapp", afterId: 0 });
  });

  // A body with the right type but a non-numeric needId, e.g. the dashless
  // need UUID an admin route uses in its URLs. Same outcome, and worth its own
  // test because the string does not throw at the bind boundary either.
  it("acks a message whose needId is the need UUID rather than the row id", async () => {
    const { batch, acks } = batchOf([{ type: "notify-need-whatsapp", needId: "need00000000000000000000000007", afterId: 0 }]);

    await handleJobsQueue(batch, buildEnv());

    expect(acks).toEqual([0]);
    expect(graphCalls).toEqual([]);
  });

  // One bad message must not cost the good ones in the same batch their
  // sends: max_batch_size is 10 on this queue, so a batch really does mix
  // needs. handleJobsQueue try/catches per message, which is what makes that
  // true -- and the ordering assertion is what would catch a rewrite to
  // Promise.all that interleaved two food banks' sends.
  it("keeps a failing message in a batch from stopping the others", async () => {
    jobsQueueSend.mockImplementationOnce(async () => {
      throw new Error("queue unavailable");
    });
    seedNeed(9, TRUSSELL.id, THREE_ITEMS);
    seedSubscriber(40, "447700900040", TRUSSELL.id);
    const { batch, acks, retries } = batchOf([message(0), message(0, 9)]);

    await handleJobsQueue(batch, buildEnv());

    expect(retries).toEqual([0]);
    expect(acks).toEqual([1]);
    expect(graphCalls.map((c) => c.body.to)).toEqual(["447700900010", "447700900012", "447700900040"]);
  });
});
