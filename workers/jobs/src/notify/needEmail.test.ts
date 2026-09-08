import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import type { Env } from "../../worker-configuration";
import { handleNotifyNeedEmail, type NotifyNeedEmailMessage } from "./needEmail";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning,
// as packages/db/src/schema.testkit.ts:35.
import { DatabaseSync } from "node:sqlite";

// notify/needEmail.ts -- the notification email 5,855 people receive when a
// food bank's shopping list changes. Ported from
// givefood/utils/notifications.py:24-78 (post_to_subscriber) and
// gfadmin/views.py:1993-1997's loop over confirmed subscribers.
//
// WHY THIS FILE IS WORTH THE LENGTH. This handler runs on a queue: nobody is
// watching it, nothing it does is visible in a browser, and every failure mode
// it has is silent by construction. It sends bulk mail to real inboxes, and
// then it enqueues ITSELF again -- so the two directions of failure are both
// expensive and both invisible:
//
//   * it stops when it should not: a food bank's later pages never get their
//     mail and no error is raised anywhere, because "no subscribers left" and
//     "I gave up" produce the identical console line and the identical
//     absence of a queue message; or
//   * it does not stop when it should: re-enqueueing on an empty page is an
//     infinite loop of paid queue messages against a database that has run
//     out of rows to return.
//
// Neither shows up as an exception, a 500, or a red dashboard. The only thing
// that can notice either is a test that counts the sends and the enqueues.
// This is the same class as the incident this tier exists for -- a Browser
// Rendering credential that broke silently for a day -- and the POSTMARK_TOKEN
// test below is that incident's exact shape for this handler.
//
// REAL THINGS, NOT MOCKS. node:sqlite carrying the whole real migration set,
// the real @givefood/db queries (getNeedById, getConfirmedSubscribersPage,
// buildNeedEmailContext), and the real render() over the real .njk templates.
// Only what leaves the machine is faked: Postmark's HTTPS endpoint, the queue
// producer, and Math.random (the subject emoji). Everything asserted below is
// therefore a claim about bytes that would really have gone to a subscriber.
//
// THE SCHEMA COMES FROM THE MIGRATIONS, not from a hand-written CREATE TABLE.
// MIGRATIONS_SQL rather than schemaFor(...) because this handler reaches four
// tables through three shared packages/db functions plus the
// foodbankchange_full VIEW, and the whole point of the shared testkit is that
// a query which starts reading one more object does not silently 500 a suite
// whose fixture predates it (github #51). The full schema cannot have that
// gap at all.
//
// PARITY CLAIMS WERE EXECUTED. Django 5.2.6 (the version actually installed at
// /Users/jasoncartwright/Sites/foodcharity) was run for apnumber's exact
// output at 0, 1, 9, 10 and 11 -- see the subject-line block. Nothing else in
// this file cites Django behaviour that was not read directly out of
// notifications.py.
//
// MUTATION-TESTED, 2026-09-08: 91 mutants applied to a COPY of the repo in a
// scratchpad -- needEmail.ts itself plus the four shared modules it reaches
// through (packages/db's subscribers.ts, needEmailContext.ts,
// needAdminExtras.ts and packages/models' noItems), and the precompiled
// template bundle. Ten survived and are now killed by the tests that name
// them below. Two survivors are left alive DELIBERATELY because they are
// semantically equivalent and cannot be killed by any test:
//
//   * passing `subscribers[0]` instead of `null` to buildNeedEmailContext --
//     all three fields it would set are overwritten by the explicit
//     properties after `...base` in the per-subscriber context;
//   * building the utm campaign from `foodbank.name` instead of
//     `need.foodbank_name` -- foodbankchange_full is
//     `SELECT c.*, f.name AS foodbank_name ... LEFT JOIN foodbank f`
//     (migration 0019:86-89), so under D1 those are the same bytes by
//     construction. The needEmailContext.ts comment about the "DENORMALISED
//     column" describes Django's schema, where they could genuinely differ.
//
// Mutants applied to the .njk sources do nothing: @givefood/templates ships
// precompiled (src/generated/precompiled.js), so template-level mutation has
// to go through the bundle. It was, and the bodies asserted below catch it.

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

/** One outbound Postmark call, decoded. */
interface PostmarkCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: {
    From: string;
    To: string;
    Subject: string;
    TextBody: string;
    HtmlBody: string;
    MessageStream: string;
    Headers: Array<{ Name: string; Value: string }>;
  };
}

/** What a run of the handler did to the outside world. */
interface Harness {
  env: Env;
  /** Every SQL statement prepared, in order -- see the "asks for exactly four things" test. */
  sql: string[];
  posts: PostmarkCall[];
  /** Message bodies handed to JOBS_Q.send(). */
  queued: NotifyNeedEmailMessage[];
  /** Interleaved side-effect log, so "the next page is enqueued AFTER the sends" is assertable. */
  order: string[];
  errors: string[];
  logs: string[];
}

let db: SqliteDatabase;

// The D1 Sessions API surface packages/db uses, over the real engine. It
// carries SQL to node:sqlite and records it, and does nothing else: a session
// that interpreted the SQL or answered canned rows would be a second
// implementation of the very queries under test.
//
// `first()` answers null, never undefined, because getNeedById's `row ? ... :
// null` and buildNeedEmailContext's `if (!foodbank)` both hang off that.
// bind() returns a NEW statement rather than mutating, matching D1's immutable
// prepared statements.
function d1Session(log: string[], failOn: RegExp | null): unknown {
  function statement(sql: string, params: Bindable[]): unknown {
    return {
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T,>() => {
        log.push(sql);
        if (failOn?.test(sql)) throw new Error("D1_ERROR: Network connection lost");
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      all: async <T,>() => {
        log.push(sql);
        if (failOn?.test(sql)) throw new Error("D1_ERROR: Network connection lost");
        return { results: db.prepare(sql).all(...params) as T[] };
      },
      run: async () => {
        log.push(sql);
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null };
}

interface HarnessOptions {
  /** Defaults to a real-looking Postmark server token; "" is the missing-credential case. */
  postmarkToken?: string;
  /** wrangler.jsonc's vars.SITE_DOMAIN. */
  siteDomain?: string;
  /** Postmark's reply. Defaults to the 200 + JSON envelope a real accepted send returns. */
  reply?: (call: PostmarkCall) => Response | Promise<Response>;
  /** Make every D1 statement matching this throw, standing in for a replica blip. */
  failSql?: RegExp;
}

// Postmark's real success envelope, trimmed to the fields that exist. The
// handler ignores the body entirely on a 200 -- asserted below -- but a stub
// that returned nothing would make that hard to tell from a stub that had not
// been called.
const POSTMARK_OK = JSON.stringify({ To: "x", SubmittedAt: "2026-09-05T19:28:09Z", MessageID: "b7bc2f4a", ErrorCode: 0, Message: "OK" });

function harness(options: HarnessOptions = {}): Harness {
  const sql: string[] = [];
  const posts: PostmarkCall[] = [];
  const queued: NotifyNeedEmailMessage[] = [];
  const order: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];

  // Any URL other than Postmark's throws rather than returning a default: an
  // outbound call this handler grows later must fail loudly here, not be
  // absorbed by a permissive stub.
  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    if (url !== "https://api.postmarkapp.com/email") throw new Error(`unmodelled fetch: ${url}`);
    const call: PostmarkCall = {
      url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    };
    posts.push(call);
    order.push(`post:${call.body.To}`);
    return options.reply ? await options.reply(call) : new Response(POSTMARK_OK, { status: 200 });
  });

  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));

  const env = {
    DB: { withSession: () => d1Session(sql, options.failSql ?? null) },
    JOBS_Q: {
      send: async (body: NotifyNeedEmailMessage) => {
        queued.push(body);
        order.push(`queue:${body.afterId}`);
      },
    },
    SITE_DOMAIN: options.siteDomain ?? "https://www.givefood.org.uk",
    POSTMARK_TOKEN: options.postmarkToken ?? "1f2e3d4c-5b6a-7988-9a0b-1c2d3e4f5a6b",
  } as unknown as Env;

  return { env, sql, posts, queued, order, errors, logs };
}

/** Every To: the run sent to, in send order. */
function recipients(h: Harness): string[] {
  return h.posts.map((post) => post.body.To);
}

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write: a SPACE separator and six fractional
// digits, never a "T" and never a "Z". These columns are TEXT and SQLite
// compares TEXT bytewise, which is why migration 0022 had to go back and
// rewrite the ISO-spelled foodbankarticle rows. Seeding toISOString() here
// would be testing a database this Worker does not have.
const DJANGO_NOW = "2026-09-05 19:28:08.853000";
const NOW = new Date("2026-09-05T19:28:08.853Z");

// Ids deliberately not in name, slug or insertion order, so a query that
// returned "the first row" could never be accidentally right.
const SALISBURY = 22;
const WEST_NORFOLK = 88;
const SALISBURY_NEED = 4211;
const WEST_NORFOLK_NEED = 91;

function seedFoodbank(seed: { id: number; slug: string; name: string; altName?: string | null; noDonationPoints?: number | null }): void {
  db.prepare(
    "INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng, " +
      "charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative, " +
      "is_closed, no_locations, no_donation_points, days_between_needs, created, modified) " +
      "VALUES (?, ?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.0688,-1.7945', 0, " +
      "'info@example.org', 'https://example.org/', 'https://example.org/list/', 0, 0, 0, ?, 14, ?, ?)",
  ).run(
    seed.id,
    `uuid-${seed.slug}`,
    seed.name,
    seed.altName ?? null,
    seed.slug,
    seed.noDonationPoints === undefined ? 3 : seed.noDonationPoints,
    DJANGO_NOW,
    DJANGO_NOW,
  );
}

// A published, scraped need. Written to the BASE table: getNeedById reads
// foodbankchange_full, the view 0019 created, and foodbank_name/foodbank_slug
// arrive from its LEFT JOIN rather than from a stored column.
function seedNeed(
  seed: { id: number; foodbankId: number | null; changeText?: string; excessChangeText?: string | null; created?: string } = {
    id: SALISBURY_NEED,
    foodbankId: SALISBURY,
  },
): void {
  db.prepare(
    "INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text, published, " +
      "nonpertinent, is_categorised, input_method, created, modified) VALUES (?, ?, ?, ?, ?, 1, 0, 1, 'scrape', ?, ?)",
  ).run(
    seed.id,
    `need-${seed.id}`.padEnd(32, "0"),
    seed.foodbankId,
    seed.changeText ?? "Tinned Meat\nUHT Milk\nTea & Coffee",
    seed.excessChangeText ?? null,
    seed.created ?? DJANGO_NOW,
    DJANGO_NOW,
  );
}

function seedSubscriber(seed: { id: number; foodbankId: number; email: string; confirmed: number; created?: string; unsubKey?: string }): void {
  db.prepare("INSERT INTO foodbanksubscriber (id, created, foodbank_id, email, confirmed, sub_key, unsub_key) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    seed.id,
    seed.created ?? DJANGO_NOW,
    seed.foodbankId,
    seed.email,
    seed.confirmed,
    `sub-${seed.id}`,
    seed.unsubKey ?? `unsub-${seed.id}`,
  );
}

function seedArticle(seed: { id: number; foodbankId: number; publishedDate: string; title: string; url: string }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, 0)").run(
    seed.id,
    seed.foodbankId,
    seed.publishedDate,
    seed.title,
    seed.url,
  );
}

/** The ordinary starting message: page one of a food bank's fan-out. */
function firstPage(needId = SALISBURY_NEED): NotifyNeedEmailMessage {
  return { type: "notify-need-email", needId, afterId: 0 };
}

beforeEach(() => {
  // buildNeedEmailContext measures its 28-day article window from Date.now(),
  // so without a frozen clock the "News from..." block would mean something
  // different every day this file ran -- and the subject/emoji tests would be
  // the only ones left saying anything.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = new DatabaseSync(":memory:") as SqliteDatabase;
  db.exec(SCHEMA);
  seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury", altName: "Banc Bwyd Salisbury" });
  seedNeed({ id: SALISBURY_NEED, foodbankId: SALISBURY });
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===========================================================================
// THE GUARDS -- the four ways this handler declines to send
// ===========================================================================

describe("handleNotifyNeedEmail -- the guards", () => {
  // D1 declares no foreign keys (PLAN.md §4.5) and the fan-out spans many
  // queue messages, so the need row can be deleted between page 3 and page 4
  // of its own send. The only correct answer is to stop: re-enqueueing would
  // spin forever against a row that is never coming back, and throwing would
  // burn three retries and a DLQ slot on a message nothing can ever satisfy.
  it("stops without sending or re-enqueueing when the need row has been deleted", async () => {
    const h = harness();

    await handleNotifyNeedEmail(firstPage(4242), h.env);

    expect(h.posts).toEqual([]);
    expect(h.queued).toEqual([]);
    expect(h.errors).toEqual(["notify-need-email: need 4242 no longer exists"]);
    // One statement, and no subscriber lookup: the guard must short-circuit
    // before the page query, or a deleted need still costs a D1 round trip on
    // every message of an in-flight fan-out.
    expect(h.sql).toHaveLength(1);
  });

  // foodbankchange.foodbank_id is nullable, and every line of both templates
  // dereferences the food bank. Django's own view would 500 here.
  it("stops on a need with no food bank at all, before looking for subscribers", async () => {
    seedNeed({ id: 7777, foodbankId: null });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(7777), h.env);

    expect(h.posts).toEqual([]);
    expect(h.queued).toEqual([]);
    expect(h.errors).toEqual(["notify-need-email: need 7777 has no food bank"]);
    expect(h.sql).toHaveLength(1);
  });

  // THE TERMINAL CONDITION OF THE WHOLE FAN-OUT, and the single most expensive
  // line in the file to get wrong. Every page ends by enqueueing the next one;
  // the ONLY thing that ever stops that chain is this empty-page return. A
  // refactor that moved the JOBS_Q.send() above this check, or dropped the
  // check, would produce a queue message every few seconds forever, for every
  // food bank ever notified, with no error and nothing in the logs but a
  // steadily growing bill.
  it("stops the fan-out -- does NOT enqueue another page -- when the page comes back empty", async () => {
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.queued).toEqual([]);
    expect(h.posts).toEqual([]);
    expect(h.logs).toEqual([`notify-need-email: need ${SALISBURY_NEED} done after id 0`]);
    // The context is never built for an empty page: two statements (the need,
    // the subscriber page) and no food bank or article lookup.
    expect(h.sql).toHaveLength(2);
  });

  // The same at-least-once reasoning one step further along: the food bank row
  // itself can go while the fan-out is in flight, leaving orphan subscriber
  // rows that the page query still happily returns. buildNeedEmailContext
  // answers null, and this handler then stops -- silently, and WITHOUT sending
  // to the subscribers it just fetched. Pinned as behaviour, not endorsed: see
  // suspectedBugs, because "food bank vanished" and "everyone is unsubscribed"
  // are two very different events that both end the fan-out here.
  it("stops when the food bank row is gone even though confirmed subscribers remain", async () => {
    seedNeed({ id: 5150, foodbankId: 999 });
    seedSubscriber({ id: 1, foodbankId: 999, email: "orphan@example.com", confirmed: 1 });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(5150), h.env);

    expect(h.posts).toEqual([]);
    expect(h.queued).toEqual([]);
    expect(h.errors).toEqual(["notify-need-email: no email context for need 5150"]);
  });

  // A D1 failure is NOT one of the handled cases -- it propagates, and
  // queues/jobs.ts:24-27 turns that into message.retry(). That is the correct
  // shape for a replica blip (retry the page) and it is worth pinning, because
  // wrapping this handler in a try/catch "for robustness" would convert every
  // transient database error into a silently skipped page of subscribers with
  // no retry and no DLQ entry.
  it("lets a database failure escape, so the queue retries the page rather than dropping it", async () => {
    const h = harness({ failSql: /foodbanksubscriber/ });

    await expect(handleNotifyNeedEmail(firstPage(), h.env)).rejects.toThrow("D1_ERROR: Network connection lost");

    expect(h.posts).toEqual([]);
    expect(h.queued).toEqual([]);
  });
});

// ===========================================================================
// WHO GETS THE MAIL
// ===========================================================================

describe("handleNotifyNeedEmail -- recipient selection", () => {
  // Every row seeded here that must NOT receive mail is a row a broken filter
  // would send to, and all four failures are silent -- an unconfirmed address
  // is by definition someone who never proved they wanted this, and another
  // food bank's list is a data-protection incident rather than a bug report.
  it("mails only this food bank's confirmed subscribers above the cursor, and nobody else", async () => {
    seedFoodbank({ id: WEST_NORFOLK, slug: "west-norfolk", name: "West Norfolk" });
    seedSubscriber({ id: 10, foodbankId: SALISBURY, email: "below-cursor@example.com", confirmed: 1 });
    seedSubscriber({ id: 11, foodbankId: SALISBURY, email: "at-cursor@example.com", confirmed: 1 });
    seedSubscriber({ id: 12, foodbankId: SALISBURY, email: "unconfirmed@example.com", confirmed: 0 });
    seedSubscriber({ id: 13, foodbankId: WEST_NORFOLK, email: "other-foodbank@example.com", confirmed: 1 });
    seedSubscriber({ id: 14, foodbankId: SALISBURY, email: "yes@example.com", confirmed: 1 });
    const h = harness();

    await handleNotifyNeedEmail({ type: "notify-need-email", needId: SALISBURY_NEED, afterId: 11 }, h.env);

    expect(recipients(h)).toEqual(["yes@example.com"]);
  });

  // The cursor is `id > ?`, strictly. An `>=` would re-send to the last
  // recipient of the previous page on every single page boundary -- a
  // duplicate nobody would ever report as a bug, just as mild irritation.
  it("treats the cursor as exclusive: the subscriber whose id IS the cursor is not re-sent to", async () => {
    seedSubscriber({ id: 30, foodbankId: SALISBURY, email: "previous-page@example.com", confirmed: 1 });
    seedSubscriber({ id: 31, foodbankId: SALISBURY, email: "this-page@example.com", confirmed: 1 });
    const h = harness();

    await handleNotifyNeedEmail({ type: "notify-need-email", needId: SALISBURY_NEED, afterId: 30 }, h.env);

    expect(recipients(h)).toEqual(["this-page@example.com"]);
  });

  // Keyset paging is only correct if the order matches the cursor column.
  // Inserted deliberately out of id order, so an ORDER BY dropped (SQLite
  // would then answer in whatever order the index scan produced) or moved to
  // `created`/`email` reorders the page -- and a reordered page skips
  // subscribers permanently, because the next cursor is the LAST id sent to,
  // not the highest.
  //
  // THE FIXTURE IS THE TEST HERE, and an earlier version of it was not.
  // These three rows used to be first@/second@/third@ with one shared
  // `created`, which sort alphabetically in the same order as their ids -- so
  // the `ORDER BY id -> ORDER BY email` mutant this comment claims to kill
  // passed the whole suite untouched (mutation run, 2026-09-08). Both
  // secondary columns now run BACKWARDS against id: alphabetically the page
  // is abe/mo/zoe and by `created` it is 90/44/12, so any of the three
  // orderings produces a visibly different recipient list.
  it("walks subscribers in id order, not in email or created order", async () => {
    seedSubscriber({ id: 90, foodbankId: SALISBURY, email: "abe@example.com", confirmed: 1, created: "2019-01-01 00:00:00.000000" });
    seedSubscriber({ id: 12, foodbankId: SALISBURY, email: "zoe@example.com", confirmed: 1, created: "2026-06-01 00:00:00.000000" });
    seedSubscriber({ id: 44, foodbankId: SALISBURY, email: "mo@example.com", confirmed: 1, created: "2022-03-01 00:00:00.000000" });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(recipients(h)).toEqual(["zoe@example.com", "mo@example.com", "abe@example.com"]);
    expect(h.queued).toEqual([{ type: "notify-need-email", needId: SALISBURY_NEED, afterId: 90 }]);
  });

  // confirmed is `INTEGER NOT NULL DEFAULT 0` and the predicate is
  // `confirmed = 1`, so this is really a check that nothing coerces. Seeded
  // because the subscribe flow writes 0 first and 1 only after the emailed
  // confirmation link is clicked: getting this wrong mails everyone who ever
  // typed their address into the form and then thought better of it.
  it("never mails an unconfirmed subscriber, even when it is the only row", async () => {
    seedSubscriber({ id: 5, foodbankId: SALISBURY, email: "never-confirmed@example.com", confirmed: 0 });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts).toEqual([]);
    expect(h.queued).toEqual([]);
  });
});

// ===========================================================================
// PAGING -- the self-re-enqueueing loop
// ===========================================================================

describe("handleNotifyNeedEmail -- paging", () => {
  function seedSubscribers(count: number, firstId = 100): void {
    for (let i = 0; i < count; i++) {
      seedSubscriber({ id: firstId + i, foodbankId: SALISBURY, email: `sub${firstId + i}@example.com`, confirmed: 1 });
    }
  }

  // PAGE_SIZE is 25 and is not exported, so it is pinned through what a run
  // actually does. The number matters: it is the blast radius of a retry (the
  // module's own AT-LEAST-ONCE note), and raising it silently would multiply
  // the duplicate mail a partway-failed page produces.
  it("sends exactly 25 emails per message and hands the 25th id to the next one", async () => {
    seedSubscribers(27);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts).toHaveLength(25);
    expect(recipients(h)[0]).toBe("sub100@example.com");
    expect(recipients(h)[24]).toBe("sub124@example.com");
    expect(h.queued).toEqual([{ type: "notify-need-email", needId: SALISBURY_NEED, afterId: 124 }]);
  });

  // The whole fan-out driven end to end by feeding each enqueued message back
  // in, which is what the "jobs" consumer does for real. Two properties that
  // no single-message test can see: every subscriber is reached EXACTLY once
  // across the pages, and the chain terminates.
  it("drains a 27-subscriber food bank in three messages, mailing each address exactly once", async () => {
    seedSubscribers(27);
    const h = harness();

    let next: NotifyNeedEmailMessage | undefined = firstPage();
    const sent: string[] = [];
    const pages: number[] = [];
    for (let guard = 0; next && guard < 10; guard++) {
      const before = h.posts.length;
      const message: NotifyNeedEmailMessage = next;
      h.queued.length = 0;
      await handleNotifyNeedEmail(message, h.env);
      pages.push(h.posts.length - before);
      sent.push(...recipients(h).slice(before));
      next = h.queued[0];
    }

    expect(pages).toEqual([25, 2, 0]);
    expect(sent).toHaveLength(27);
    expect(new Set(sent).size).toBe(27);
    expect(sent[26]).toBe("sub126@example.com");
  });

  // A page shorter than PAGE_SIZE still enqueues, so every fan-out costs one
  // extra message that finds nothing. Deliberate, per the module's comment
  // ("Enqueued only after the current one is sent, so a failure retries this
  // page rather than skipping ahead") -- pinned so that stopping early on a
  // short page is a decision someone makes on purpose rather than a tidy-up.
  it("still enqueues one more message after a page that was not full", async () => {
    seedSubscribers(3);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts).toHaveLength(3);
    expect(h.queued).toEqual([{ type: "notify-need-email", needId: SALISBURY_NEED, afterId: 102 }]);
  });

  // The next page is enqueued only AFTER the last Postmark call of this page
  // returns. If it were enqueued first, a page that then threw would be both
  // retried (this page again) and already advanced (the next page in flight),
  // which duplicates a page and races two senders against the same list.
  it("enqueues the next page after the sends, not before them", async () => {
    seedSubscribers(2);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.order).toEqual(["post:sub100@example.com", "post:sub101@example.com", "queue:101"]);
  });

  // Cloudflare Queues are AT-LEAST-ONCE, so the same tick genuinely arrives
  // twice, and this handler writes no per-subscriber sent marker (the module
  // says so, and calls the alternative not worth a schema change). The
  // consequence is that a redelivery re-sends the whole page. Pinned as the
  // documented cost of the design: if someone later adds a marker, this test
  // is the one that must be deliberately rewritten.
  it("re-sends the whole page when the same message is delivered twice", async () => {
    seedSubscribers(2);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);
    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(recipients(h)).toEqual(["sub100@example.com", "sub101@example.com", "sub100@example.com", "sub101@example.com"]);
    expect(h.queued).toHaveLength(2);
  });

  // The base context -- food bank row and 28-day article window -- is built
  // once per PAGE, not once per subscriber. Four statements for a 25-recipient
  // page; moving buildNeedEmailContext inside the loop would make it 52, which
  // is invisible in every rendered body and visible only on the D1 bill and in
  // the wall clock of a food bank with thousands of subscribers.
  it("asks the database for exactly four things per page, however many subscribers it mails", async () => {
    seedSubscribers(6);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts).toHaveLength(6);
    expect(h.sql).toHaveLength(4);
    expect(h.sql[0]).toContain("FROM foodbankchange_full");
    expect(h.sql[1]).toContain("FROM foodbanksubscriber");
    expect(h.sql[2]).toContain("FROM foodbank ");
    expect(h.sql[3]).toContain("FROM foodbankarticle");
  });

  // Nothing is written. That is why redelivery duplicates, and it is also why
  // this handler cannot corrupt anything: an UPDATE that crept in here (a
  // `notified` stamp, a last_contacted touch) would run once per queue
  // delivery against rows nobody is watching.
  it("issues no writes at all", async () => {
    seedSubscribers(3);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.sql.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toEqual([]);
  });
});

// ===========================================================================
// THE POSTMARK REQUEST
// ===========================================================================

describe("handleNotifyNeedEmail -- the Postmark request", () => {
  beforeEach(() => {
    seedSubscriber({ id: 42, foodbankId: SALISBURY, email: "alice@example.com", confirmed: 1, unsubKey: "unsub-alice" });
  });

  // notifications.py:100-150's send_email, with is_broadcast=True. MessageStream
  // is the field with real consequences: "outbound" is the transactional
  // stream, and Postmark suspends an account that sends bulk mail on it. The
  // module keeps a second sender rather than parameterising exactly so this
  // cannot be flipped by a caller; the test is what stops it being flipped
  // here.
  it("posts to Postmark on the broadcast stream, from mail@givefood.org.uk, with the server token header", async () => {
    const h = harness({ postmarkToken: "token-for-this-test" });

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts).toHaveLength(1);
    const call = h.posts[0]!;
    expect(call.url).toBe("https://api.postmarkapp.com/email");
    expect(call.method).toBe("POST");
    expect(call.headers).toEqual({
      "X-Postmark-Server-Token": "token-for-this-test",
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    expect(call.body.From).toBe("mail@givefood.org.uk");
    expect(call.body.To).toBe("alice@example.com");
    expect(call.body.MessageStream).toBe("broadcast");
  });

  // RFC 8058 one-click unsubscribe (notifications.py:65-70 and :132-137).
  // Gmail and Yahoo require both headers on bulk mail; without them the whole
  // broadcast stream's reputation degrades, which is a failure that shows up
  // weeks later as "our emails stopped arriving" and never as an error.
  // The angle brackets are part of the spec, not decoration.
  it("carries both RFC 8058 headers, with the recipient's own unsubscribe key in angle brackets", async () => {
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts[0]!.body.Headers).toEqual([
      { Name: "List-Unsubscribe", Value: "<https://www.givefood.org.uk/needs/at/salisbury/updates/unsubscribe/?key=unsub-alice>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
  });

  // The header is built from env.SITE_DOMAIN; the same link inside both
  // template bodies is hardcoded to https://www.givefood.org.uk. On a staging
  // deploy that divergence is a mail whose one-click header points at staging
  // and whose visible link points at production. Recorded in suspectedBugs
  // rather than fixed -- SITE_DOMAIN is production in wrangler.jsonc, so
  // nothing is broken today.
  it("takes the header's origin from SITE_DOMAIN while the body's link stays hardcoded to production", async () => {
    const h = harness({ siteDomain: "https://staging.givefood.org.uk" });

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts[0]!.body.Headers[0]!.Value).toBe(
      "<https://staging.givefood.org.uk/needs/at/salisbury/updates/unsubscribe/?key=unsub-alice>",
    );
    expect(h.posts[0]!.body.TextBody).toContain("https://www.givefood.org.uk/needs/at/salisbury/updates/unsubscribe/?key=unsub-alice");
    expect(h.posts[0]!.body.TextBody).not.toContain("staging.givefood.org.uk");
  });

  // The slug in the unsubscribe URL comes from the FOOD BANK ROW
  // (base.foodbank_slug), not from a slugify() of the need's denormalised
  // name -- a distinction that only shows up for a food bank whose name and
  // slug disagree, which is most of them after a rename. A wrong slug here is
  // a 404 on the one link a recipient clicks when they are already annoyed.
  it("builds the unsubscribe URL from the food bank's real slug, not from its name", async () => {
    seedFoodbank({ id: 61, slug: "kings-lynn", name: "West Norfolk" });
    seedNeed({ id: 62, foodbankId: 61 });
    seedSubscriber({ id: 63, foodbankId: 61, email: "bob@example.com", confirmed: 1, unsubKey: "unsub-bob" });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(62), h.env);

    expect(h.posts[0]!.body.Headers[0]!.Value).toBe("<https://www.givefood.org.uk/needs/at/kings-lynn/updates/unsubscribe/?key=unsub-bob>");
  });
});

// ===========================================================================
// THE SUBJECT LINE
// ===========================================================================

describe("handleNotifyNeedEmail -- the subject line", () => {
  // Math.random is the only nondeterminism in this handler. Pinned to index 0
  // ("🍝") so every subject below is a fixed string rather than a regex, which
  // is what makes the item-count assertions exact.
  function pinEmoji(index: number): void {
    vi.spyOn(Math, "random").mockReturnValue(index / 17);
  }

  async function subjectFor(changeText: string): Promise<string> {
    seedNeed({ id: 500, foodbankId: SALISBURY, changeText });
    seedSubscriber({ id: 1, foodbankId: SALISBURY, email: "alice@example.com", confirmed: 1 });
    const h = harness();
    pinEmoji(0);
    await handleNotifyNeedEmail(firstPage(500), h.env);
    return h.posts[0]!.body.Subject;
  }

  // notifications.py:45-47: "%s %s needs %s items" % (emoji,
  // need.foodbank.full_name(), apnumber(need.no_items())). full_name() appends
  // "Foodbank"; the Welsh alt_name seeded on this fixture must NOT appear,
  // because these emails are English-only and buildNeedEmailContext pins the
  // locale to "en".
  it("is emoji, English full_name, and the item count -- never the Welsh alt_name", async () => {
    expect(await subjectFor("Tinned Meat\nUHT Milk\nTea & Coffee")).toBe("🍝 Salisbury Foodbank needs three items");
  });

  // django.contrib.humanize's apnumber. RUN, not remembered: under
  // /Users/jasoncartwright/Sites/foodcharity's own Django 5.2.6,
  // apnumber(1)="one", apnumber(9)="nine", apnumber(10)=10, apnumber(11)=11
  // and apnumber(0)=0 -- words only for 1..9, the integer otherwise. The
  // singular reads "needs one items" in Django too; that is the original's
  // grammar and it is preserved, not corrected.
  it("spells one to nine as words and everything else as digits, including the ungrammatical singular", async () => {
    expect(await subjectFor("Beans")).toBe("🍝 Salisbury Foodbank needs one items");
  });

  it("switches to digits at ten, the apnumber boundary", async () => {
    const nine = "a\nb\nc\nd\ne\nf\ng\nh\ni";
    expect(await subjectFor(nine)).toBe("🍝 Salisbury Foodbank needs nine items");
  });

  it("uses digits for ten items", async () => {
    const ten = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
    expect(await subjectFor(ten)).toBe("🍝 Salisbury Foodbank needs 10 items");
  });

  // FoodbankChange.no_items() zeroes exactly two sentinels, and deliberately
  // NOT "Facebook" -- packages/models/src/index.ts:196-201 says so, and says
  // it was checked against needs.py rather than assumed symmetric with
  // has_needs(). So a food bank whose list is "we post it on Facebook" gets a
  // subject claiming it needs "one items". Odd, faithful, and pinned.
  it("counts the 'Nothing' and 'Unknown' sentinels as zero but 'Facebook' as one", async () => {
    expect(await subjectFor("Nothing")).toBe("🍝 Salisbury Foodbank needs 0 items");
  });

  it("counts 'Unknown' as zero", async () => {
    expect(await subjectFor("Unknown")).toBe("🍝 Salisbury Foodbank needs 0 items");
  });

  it("counts 'Facebook' as one item, unlike the other two sentinels", async () => {
    expect(await subjectFor("Facebook")).toBe("🍝 Salisbury Foodbank needs one items");
  });

  // The count comes from change_text, the PUBLISHED list, never from
  // change_text_original -- the pre-cleaning text needcheck.ts stores
  // alongside it (needcheck.ts:166's `VALUES (..?5, ?5..)`). The two differ on
  // every AI-extracted need whose text was cleaned, and they are adjacent
  // columns with near-identical names on the same row, so reading the wrong
  // one is a one-word slip. It would put a count in the subject line that
  // contradicts the list in the body, on the AI-extracted needs that are most
  // of them. Seeded with a deliberately different line count, because with
  // change_text_original NULL -- which it is on every other fixture in this
  // file -- the mutation is invisible.
  it("counts the published change_text, not the uncleaned change_text_original beside it", async () => {
    db.prepare("UPDATE foodbankchange SET change_text_original = ? WHERE id = ?").run("a\nb\nc\nd\ne\nf\ng", SALISBURY_NEED);
    seedSubscriber({ id: 1, foodbankId: SALISBURY, email: "alice@example.com", confirmed: 1 });
    const h = harness();
    pinEmoji(0);

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts[0]!.body.Subject).toBe("🍝 Salisbury Foodbank needs three items");
  });

  // The emoji is drawn PER EMAIL, inside the subscriber loop, because
  // notifications.py builds the subject inside post_to_subscriber. Hoisting it
  // out of the loop would be tidier and would make every recipient of one
  // publish see the same emoji -- which is not what the original does. Two
  // recipients, two different draws, one run.
  it("draws a fresh emoji for each recipient rather than once per page", async () => {
    seedSubscriber({ id: 1, foodbankId: SALISBURY, email: "alice@example.com", confirmed: 1 });
    seedSubscriber({ id: 2, foodbankId: SALISBURY, email: "bob@example.com", confirmed: 1 });
    const h = harness();
    const draws = [0, 16 / 17];
    let call = 0;
    vi.spyOn(Math, "random").mockImplementation(() => draws[call++ % draws.length]!);

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts[0]!.body.Subject).toBe("🍝 Salisbury Foodbank needs three items");
    expect(h.posts[1]!.body.Subject).toBe("🥧 Salisbury Foodbank needs three items");
  });

  // The full emoji table, in order, checked against notifications.py:26-44 by
  // driving Math.random across all 17 indices. A subject line is the one part
  // of a bulk mail every recipient sees before deciding whether to open it; a
  // dropped or mistyped entry here (they are multi-codepoint sequences --
  // "🍽️" carries a variation selector) would render as a tofu box in some
  // clients and be reported by nobody.
  it("draws from exactly the seventeen emoji notifications.py lists, in order", async () => {
    for (let i = 0; i < 17; i++) seedSubscriber({ id: 200 + i, foodbankId: SALISBURY, email: `sub${i}@example.com`, confirmed: 1 });
    const h = harness();
    let call = 0;
    vi.spyOn(Math, "random").mockImplementation(() => call++ / 17);

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts.map((post) => post.body.Subject.split(" ")[0])).toEqual([
      "🍝",
      "🍲",
      "🍛",
      "🥫",
      "🌽",
      "🥕",
      "🥔",
      "🍚",
      "🍽️",
      "🍴",
      "🥘",
      "🍅",
      "🫘",
      "🫛",
      "🥄",
      "🥣",
      "🥧",
    ]);
  });
});

// ===========================================================================
// THE RENDERED BODIES
// ===========================================================================

describe("handleNotifyNeedEmail -- the rendered bodies", () => {
  // Two subscribers whose per-recipient fields differ in every way they can:
  // different subscription date, different time of day (one side of noon
  // each), different unsubscribe key.
  const ALICE = { id: 42, foodbankId: SALISBURY, email: "alice@example.com", confirmed: 1, created: DJANGO_NOW, unsubKey: "unsub-alice" };
  const BOB = {
    id: 43,
    foodbankId: SALISBURY,
    email: "bob@example.com",
    confirmed: 1,
    created: "2024-01-01 09:05:00.000000",
    unsubKey: "unsub-bob",
  };

  // The text half is the body already sitting in delivered inboxes. Asserted
  // through the real templates rather than by inspecting the context, because
  // half of what can go wrong lives in the .njk files -- {% autoescape false %}
  // on the text half in particular, without which "Tea & Coffee" ships as
  // "Tea &amp; Coffee" to a plain-text reader.
  it("sends the plain-text half with the item list unescaped and the news block present", async () => {
    seedSubscriber(ALICE);
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: "2026-09-01 10:00:00.000000", title: "Harvest Appeal", url: "https://example.org/harvest" });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    const text = h.posts[0]!.body.TextBody;
    expect(text).toContain("We've found a new list of items requested by Salisbury Foodbank. They are...");
    expect(text).toContain("Tinned Meat\nUHT Milk\nTea & Coffee");
    expect(text).not.toContain("Tea &amp; Coffee");
    expect(text).toContain("News from Salisbury Foodbank...");
    expect(text).toContain("Harvest Appeal");
  });

  // The HTML half is a separate render of a separate template, and the two are
  // sent in the same request. A regression that rendered one template twice
  // would give every recipient two identical halves -- and mail clients that
  // prefer text/html would show the plain text as an unstyled wall, or vice
  // versa, with no error anywhere.
  it("sends a genuinely different HTML half, wrapped in the email shell", async () => {
    seedSubscriber(ALICE);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    const { TextBody, HtmlBody } = h.posts[0]!.body;
    expect(HtmlBody).toContain("<!doctype html>");
    expect(HtmlBody).toContain("<p>Tinned Meat<br>UHT Milk<br>Tea &amp; Coffee</p>");
    expect(TextBody).not.toContain("<!doctype html>");
    expect(HtmlBody).not.toBe(TextBody);
  });

  // THE ONE PARAGRAPH THAT IS PER-RECIPIENT. The module builds the base
  // context once per page and spreads only three fields in per subscriber; if
  // those three were folded into the base instead, every recipient of a page
  // would be told they subscribed on the FIRST recipient's date -- and, far
  // worse, would be handed the first recipient's unsubscribe key, so one
  // person clicking unsubscribe would remove somebody else. Nothing about
  // that failure is visible in a send log.
  it("gives each recipient their own subscription date, time and unsubscribe key", async () => {
    seedSubscriber(ALICE);
    seedSubscriber(BOB);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    // The double full stop after "p.m." is Django's own, preserved verbatim.
    expect(h.posts[0]!.body.TextBody).toContain(
      "subscribed to them at www.givefood.org.uk on 5th September 2026 at 7:28 p.m.. To unsubscribe visit " +
        "https://www.givefood.org.uk/needs/at/salisbury/updates/unsubscribe/?key=unsub-alice",
    );
    expect(h.posts[1]!.body.TextBody).toContain(
      "subscribed to them at www.givefood.org.uk on 1st January 2024 at 9:05 a.m.. To unsubscribe visit " +
        "https://www.givefood.org.uk/needs/at/salisbury/updates/unsubscribe/?key=unsub-bob",
    );
    expect(h.posts[0]!.body.TextBody).not.toContain("unsub-bob");
    expect(h.posts[1]!.body.TextBody).not.toContain("unsub-alice");
  });

  // THE TWO HOURS THE 12-HOUR CLOCK GETS WRONG, and neither was reachable
  // from the fixtures above (7:28 p.m. and 9:05 a.m. are both comfortably
  // inside the range). Two mutants in formatSubscribedTime survived the whole
  // suite until this test existed (mutation run, 2026-09-08):
  //
  //   * `hours24 < 12` -> `hours24 <= 12`, which relabels every noon-to-1pm
  //     subscription "a.m.";
  //   * dropping the `% 12 === 0 ? 12` wrap, which renders midnight as
  //     "0:07 a.m." and noon as "0:00 p.m.".
  //
  // Neither is visible in a send log, and both land in the one paragraph a
  // recipient reads when they are trying to work out why they are on this
  // list -- exactly the paragraph that has to be believable.
  it("renders noon as 12 p.m. and midnight as 12 a.m., not 0", async () => {
    seedSubscriber({ id: 50, foodbankId: SALISBURY, email: "midnight@example.com", confirmed: 1, created: "2026-09-05 00:07:00.000000", unsubKey: "k50" });
    seedSubscriber({ id: 51, foodbankId: SALISBURY, email: "noon@example.com", confirmed: 1, created: "2026-09-05 12:00:00.000000", unsubKey: "k51" });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts[0]!.body.TextBody).toContain("on 5th September 2026 at 12:07 a.m.. To unsubscribe");
    expect(h.posts[1]!.body.TextBody).toContain("on 5th September 2026 at 12:00 p.m.. To unsubscribe");
  });

  // The SAME claim about the RFC 8058 header, which is built separately from
  // the body and from a separate expression -- `subscriber.unsub_key` in the
  // template context, `subscriber.unsub_key` again in the header URL. Two
  // subscribers, because with one seeded recipient `subscribers[0].unsub_key`
  // and `subscriber.unsub_key` are the same string and a mutant that reads the
  // page's FIRST key for every header survives untouched. It did survive an
  // earlier version of this file, which is why this test exists separately
  // from the header-shape test above.
  //
  // What it would cost in production: Gmail's one-click unsubscribe button
  // would remove the first recipient of the page on behalf of whoever pressed
  // it. The person who asked to leave keeps getting mail; someone who did not
  // ask stops getting it. Neither ever finds out.
  it("puts each recipient's own key in their List-Unsubscribe header, not the page's first key", async () => {
    seedSubscriber(ALICE);
    seedSubscriber(BOB);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts.map((post) => post.body.Headers[0]!.Value)).toEqual([
      "<https://www.givefood.org.uk/needs/at/salisbury/updates/unsubscribe/?key=unsub-alice>",
      "<https://www.givefood.org.uk/needs/at/salisbury/updates/unsubscribe/?key=unsub-bob>",
    ]);
  });

  // Foodbank.articles_month()'s 28-day window, and the foodbank_id filter,
  // reaching the actual mail. Both failures are quiet: a widened window puts
  // last spring's news in today's mail, and a dropped filter puts a DIFFERENT
  // CHARITY'S headlines under "News from Salisbury Foodbank". The out-of-window
  // row is one day the wrong side of the cutoff, which is where an off-by-one
  // lives.
  it("includes only this food bank's articles from the last 28 days", async () => {
    seedFoodbank({ id: WEST_NORFOLK, slug: "west-norfolk", name: "West Norfolk" });
    seedSubscriber(ALICE);
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: "2026-08-08 23:00:00.000000", title: "Just Inside The Window", url: "https://example.org/a" });
    seedArticle({ id: 2, foodbankId: SALISBURY, publishedDate: "2026-08-07 23:00:00.000000", title: "One Day Too Old", url: "https://example.org/b" });
    seedArticle({ id: 3, foodbankId: WEST_NORFOLK, publishedDate: "2026-09-01 10:00:00.000000", title: "Another Charity Entirely", url: "https://example.org/c" });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    const text = h.posts[0]!.body.TextBody;
    expect(text).toContain("Just Inside The Window");
    expect(text).not.toContain("One Day Too Old");
    expect(text).not.toContain("Another Charity Entirely");
  });

  // THE WHOLE NEWS BLOCK, byte for byte, with TWO in-window articles. Every
  // other article fixture in this file seeds exactly one row whose title is
  // already title-case and whose url has no querystring, and that single row
  // let four separate mutants through the entire suite (mutation run,
  // 2026-09-08):
  //
  //   * `articleRows.slice(0, 1)` -- the classic "return the first element
  //     instead of all of them". With one row seeded it is undetectable, and
  //     in production it truncates every food bank's news to one headline.
  //   * `ORDER BY published_date DESC` -> `ASC`, which puts the oldest news
  //     at the top of the block. Django orders "-published_date"
  //     (foodbank.py:573-575), so this is a parity claim, not a preference.
  //   * dropping titleCapitalised(), which ships an RSS feed's raw
  //     "NEWER VAN APPEAL" shouting at 5,855 inboxes.
  //   * dropping url_with_ref(), which loses the ref=givefood.org.uk that is
  //     the only way a food bank's own analytics attributes the traffic --
  //     and the merge case (a url that ALREADY has a querystring) is the one
  //     that would break first, so one of the two seeds has one.
  //
  // Asserted as a single contiguous chunk rather than four independent
  // `toContain`s, because the ORDER mutant is invisible to a set of
  // membership checks.
  it("lists every in-window article newest-first, capitalised, with the ref param merged in", async () => {
    seedSubscriber(ALICE);
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: "2026-08-20 08:30:00.000000", title: "older harvest appeal at the co-op", url: "https://example.org/older?utm_source=rss" });
    seedArticle({ id: 2, foodbankId: SALISBURY, publishedDate: "2026-09-02 17:45:00.000000", title: "NEWER VAN APPEAL", url: "https://example.org/newer" });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts[0]!.body.TextBody).toContain(
      "News from Salisbury Foodbank...\n\n" +
        "Newer Van Appeal\nhttps://example.org/newer?ref=givefood.org.uk\n\n" +
        "Older Harvest Appeal At The Co-op\nhttps://example.org/older?utm_source=rss&ref=givefood.org.uk\n",
    );
  });

  // ONE BAD RSS ROW MUST NOT COST A PAGE OF MAIL. urlWithRefFoodbank() runs
  // the stored url through `new URL()`, which THROWS on a scheme-less string
  // -- and foodbankarticle is populated by crawling third-party RSS, so a
  // url like this is a row the crawler will eventually write, not a
  // hypothetical. needEmailContext.ts:123-134 catches it and falls back to
  // the raw url; nothing in the suite reached that catch, so a mutant
  // returning "" from it survived (mutation run, 2026-09-08) -- which would
  // ship a headline with no link at all.
  //
  // The second assertion is the one that matters for a queue consumer: the
  // GOOD article, and the rest of the mail, still go out. If that throw
  // escaped instead, it would escape from inside the per-page context build,
  // so the whole page of 25 recipients would fail and retry forever on a row
  // that will never parse.
  it("falls back to the raw url for an unparseable article link, and still sends the page", async () => {
    seedSubscriber(ALICE);
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: "2026-09-01 10:00:00.000000", title: "Broken Link Row", url: "givefood.org.uk/news/no-scheme" });
    seedArticle({ id: 2, foodbankId: SALISBURY, publishedDate: "2026-09-02 10:00:00.000000", title: "Good Link Row", url: "https://example.org/good" });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    const text = h.posts[0]!.body.TextBody;
    expect(text).toContain("Broken Link Row\ngivefood.org.uk/news/no-scheme");
    expect(text).toContain("Good Link Row\nhttps://example.org/good?ref=givefood.org.uk");
    expect(h.queued).toEqual([{ type: "notify-need-email", needId: SALISBURY_NEED, afterId: 42 }]);
  });

  // SUSPECT, PINNED, NOT FIXED: every notification email's HTML half ships an
  // EMPTY article date. buildNeedEmailContext already formats published_date
  // through djangoDate(.., "N j, Y, P") (needEmailContext.ts:99), and then
  // need_notification.njk applies `|date("N j, Y, P")` to that same value a
  // second time -- which cannot parse "Sept. 2, 2026, 5:45 p.m." as a
  // timestamp, and djangoDate answers "" rather than raising
  // (filters.ts:137-143). Django's own notification.html:17 renders
  // `{{ article.published_date }}` bare and so shows the date.
  //
  // Asserted as it behaves, per this repo's standing rule, and reported in
  // suspectedBugs. It doubles as the kill for the mutant that passes the raw
  // stored timestamp through instead of the pre-formatted one: raw, the
  // template's second `|date` WOULD parse it, and the span would fill in.
  it("ships an empty article date span in the HTML half -- the double |date bug", async () => {
    seedSubscriber(ALICE);
    seedArticle({ id: 2, foodbankId: SALISBURY, publishedDate: "2026-09-02 17:45:00.000000", title: "NEWER VAN APPEAL", url: "https://example.org/newer" });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    const html = h.posts[0]!.body.HtmlBody;
    expect(html).toContain('<a href="https://example.org/newer?ref=givefood.org.uk">Newer Van Appeal</a><br><span class="articledate"></span>');
    expect(html).not.toContain("Sept. 2, 2026");
    expect(html).not.toContain("2026-09-02");
  });

  // `{% if articles.length %}`, not `{% if articles %}` -- an empty JS array
  // is truthy in nunjucks where an empty Django queryset is not. Without the
  // `.length` the block renders its heading over nothing, so every food bank
  // with no recent news mails out a bare "News from X..." followed by blank
  // lines.
  it("omits the news block entirely when there are no recent articles", async () => {
    seedSubscriber(ALICE);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts[0]!.body.TextBody).not.toContain("News from");
  });

  // The excess list ("we have too much of these") is a whole paragraph that
  // appears only when excess_change_text is set, and it is split on newlines
  // and re-joined with commas by the template's own loop.
  it("renders the excess-items paragraph only for a need that has one", async () => {
    seedNeed({ id: 600, foodbankId: SALISBURY, excessChangeText: "Pasta\nBaked Beans" });
    seedSubscriber(ALICE);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(600), h.env);

    expect(h.posts[0]!.body.TextBody).toContain("Salisbury Foodbank currently doesn't need anymore of these items: Pasta, Baked Beans.");
  });

  it("leaves the excess paragraph out when the need has no excess text", async () => {
    seedSubscriber(ALICE);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts[0]!.body.TextBody).not.toContain("currently doesn't need anymore");
  });

  // THE "FIND DONATION POINTS" LINE, which is a whole visible line of both
  // halves and was asserted nowhere: removing it from the template, and
  // flipping `no_donation_points !== 0` to `=== 0`, both passed the entire
  // suite (mutation run, 2026-09-08). Flipped, it is precisely inverted --
  // the food banks that HAVE donation points stop being told where they are,
  // and the ones with none get a link to an empty page.
  //
  // The NULL case is the interesting third value and it is not defensiveness:
  // both templates test `!= 0`, and in Python `None != 0` is TRUE, so a food
  // bank whose count has never been computed still gets the line. This is the
  // divergence needEmailContext.ts:101-109 warns against "harmonising" with
  // the confirmed-subscription email, which uses plain truthiness.
  it("shows the donation-points line for a positive count and for an uncomputed NULL, but not for zero", async () => {
    seedFoodbank({ id: 80, slug: "kings-lynn", name: "West Norfolk", noDonationPoints: 0 });
    seedNeed({ id: 81, foodbankId: 80 });
    seedSubscriber({ id: 82, foodbankId: 80, email: "zero@example.com", confirmed: 1 });
    seedFoodbank({ id: 83, slug: "never-counted", name: "Never Counted", noDonationPoints: null });
    seedNeed({ id: 84, foodbankId: 83 });
    seedSubscriber({ id: 85, foodbankId: 83, email: "null@example.com", confirmed: 1 });
    seedSubscriber(ALICE);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);
    await handleNotifyNeedEmail(firstPage(81), h.env);
    await handleNotifyNeedEmail(firstPage(84), h.env);

    // Salisbury, no_donation_points = 3.
    expect(h.posts[0]!.body.TextBody).toContain("🛒 Find donation points https://www.givefood.org.uk/needs/at/salisbury/donationpoints/");
    expect(h.posts[0]!.body.HtmlBody).toContain(">donation points</a>");
    // West Norfolk, no_donation_points = 0 -- the only value that hides it.
    expect(h.posts[1]!.body.TextBody).not.toContain("Find donation points");
    expect(h.posts[1]!.body.HtmlBody).not.toContain(">donation points</a>");
    // Never Counted, no_donation_points NULL -- shown, per `None != 0`.
    expect(h.posts[2]!.body.TextBody).toContain("🛒 Find donation points https://www.givefood.org.uk/needs/at/never-counted/donationpoints/");
  });

  // THE UTM QUERYSTRING, on every internal link of the HTML half and on none
  // of the text half. `utm: ""` survived the whole suite (mutation run,
  // 2026-09-08), which would silently zero this charity's own attribution for
  // the single largest traffic source it has -- 5,855 mails' worth of clicks
  // arriving as direct traffic, with nothing broken and nothing to notice.
  //
  // The literal "&" (not "&amp;") is the point of the `|safe` on every use in
  // need_notification.njk, and it is what makes the querystring byte-identical
  // to Django's hand-written one. The campaign is
  // slugify(foodbank_name)-date(need.created, "Y-m-d").
  //
  // The text half genuinely has none: notification.txt carries no utm params
  // in the Django original either, so its bare links are matched, not missing.
  it("carries the utm querystring with a literal ampersand through the HTML half only", async () => {
    seedSubscriber(ALICE);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    const { HtmlBody, TextBody } = h.posts[0]!.body;
    expect(HtmlBody).toContain(
      '<a href="https://www.givefood.org.uk/needs/at/salisbury/?utm_source=notificationemail&utm_medium=email&utm_campaign=salisbury-2026-09-05">Salisbury Foodbank</a>',
    );
    expect(HtmlBody).not.toContain("utm_medium=email&amp;utm_campaign");
    expect(TextBody).not.toContain("utm_source");
  });

  // Both halves are rendered per recipient (they have to be -- the
  // per-subscriber paragraph is inside them), which is 2 x N template renders
  // per page. Pinned as a fact about the shape rather than a complaint: it is
  // what makes the previous test's per-recipient key possible at all.
  it("renders both templates for every recipient", async () => {
    seedSubscriber(ALICE);
    seedSubscriber(BOB);
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts.map((post) => post.body.TextBody.includes("unsub-alice"))).toEqual([true, false]);
    expect(h.posts.map((post) => post.body.HtmlBody.includes("unsub-bob"))).toEqual([false, true]);
  });
});

// ===========================================================================
// FAILURE, WHICH IS THE POINT OF TESTING A QUEUE CONSUMER
// ===========================================================================

describe("handleNotifyNeedEmail -- what happens when sending fails", () => {
  beforeEach(() => {
    seedSubscriber({ id: 1, foodbankId: SALISBURY, email: "alice@example.com", confirmed: 1 });
    seedSubscriber({ id: 2, foodbankId: SALISBURY, email: "bob@example.com", confirmed: 1 });
  });

  // THE INCIDENT THIS TIER EXISTS FOR, in this handler's shape. An unset
  // POSTMARK_TOKEN does not throw, does not retry, does not reach a
  // dead-letter queue and does not stop the fan-out: every page runs to
  // completion, enqueues the next, and sends nothing. A 5,855-recipient
  // broadcast completes "successfully" with zero mail delivered, and the only
  // trace is a console.log -- at LOG level, not error, so it does not even
  // stand out in the Workers dashboard's error view.
  //
  // Asserted exactly as it behaves, and reported in suspectedBugs rather than
  // fixed.
  it("sends nothing at all, silently, when POSTMARK_TOKEN is unset -- and still advances the fan-out", async () => {
    const h = harness({ postmarkToken: "" });

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.posts).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.logs).toEqual([
      "notify-need-email: POSTMARK_TOKEN not set -- skipping alice@example.com",
      "notify-need-email: POSTMARK_TOKEN not set -- skipping bob@example.com",
      `notify-need-email: need ${SALISBURY_NEED} sent 2, next after id 2`,
    ]);
    // The whole point: the chain keeps going, so the missing credential is
    // spread evenly across every page rather than stopping at the first.
    expect(h.queued).toEqual([{ type: "notify-need-email", needId: SALISBURY_NEED, afterId: 2 }]);
  });

  // Django checks `result.status_code == 200` exactly, not `2xx`, and the port
  // matches that rather than "improving" it (notifications.py:145). A 202
  // would be treated as a failure by both. Postmark answers 422 with an
  // ErrorCode for a hard bounce or a suppressed address, which is the common
  // real case.
  it("logs a non-200 from Postmark and carries on to the next recipient", async () => {
    const h = harness({
      reply: (call) =>
        call.body.To === "alice@example.com"
          ? new Response(JSON.stringify({ ErrorCode: 406, Message: "You tried to send to a recipient that has been marked as inactive." }), { status: 422 })
          : new Response(POSTMARK_OK, { status: 200 }),
    });

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(recipients(h)).toEqual(["alice@example.com", "bob@example.com"]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("notify-need-email: Postmark 422 for alice@example.com");
    // The response body is read into the log line, which is the only way a
    // maintainer ever learns WHICH Postmark error it was.
    expect(h.errors[0]).toContain("marked as inactive");
  });

  // `response.status !== 200`, EXACTLY, and the module's comment says so:
  // "Django checks == 200 exactly, not any 2xx. Matched, not 'improved'"
  // (notifications.py:145 is `if result.status_code == 200`). Loosening it to
  // `>= 300` or `!response.ok` is the obvious tidy-up, and it is a real
  // behaviour change: a 2xx that is not 200 would start being counted as a
  // delivered send. Asserted with 202 because 422 and 500 -- the two realistic
  // Postmark failures the tests above use -- cannot tell the two spellings
  // apart, and a `>= 300` mutant survived this file until this test existed.
  it("treats any status that is not exactly 200 as a failure, 2xx included", async () => {
    const h = harness({ reply: () => new Response(POSTMARK_OK, { status: 202 }) });

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.errors).toHaveLength(2);
    expect(h.errors[0]).toContain("notify-need-email: Postmark 202 for alice@example.com");
  });

  // ...and the failure is not propagated, so queues/jobs.ts acks the message.
  // The consequence is that alice's mail is never retried and never lands in
  // the DLQ: one 422 is one permanently lost notification. That is Django's
  // behaviour too (send_email logs and returns False, and the caller ignores
  // it), so it is matched rather than corrected -- but the return value of
  // sendBroadcast being discarded means nothing anywhere counts the failures.
  it("neither throws nor stops the fan-out after a failed send", async () => {
    const h = harness({ reply: () => new Response("nope", { status: 500 }) });

    await expect(handleNotifyNeedEmail(firstPage(), h.env)).resolves.toBeUndefined();

    expect(h.posts).toHaveLength(2);
    expect(h.queued).toEqual([{ type: "notify-need-email", needId: SALISBURY_NEED, afterId: 2 }]);
  });

  // A thrown fetch is Cloudflare's shape for a dropped connection or a DNS
  // failure. It is caught inside sendBroadcast, so it behaves exactly like a
  // 500: logged, skipped, fan-out continues. Worth its own test because a
  // network wobble is the failure most likely to hit a whole page at once --
  // and this handler will happily lose all 25 of them and report success.
  it("swallows a thrown fetch the same way, losing that recipient's mail", async () => {
    const h = harness({
      reply: (call) => {
        if (call.body.To === "alice@example.com") throw new TypeError("Network connection lost.");
        return new Response(POSTMARK_OK, { status: 200 });
      },
    });

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(recipients(h)).toEqual(["alice@example.com", "bob@example.com"]);
    expect(h.errors[0]).toContain("notify-need-email: send failed for alice@example.com");
    expect(h.queued).toHaveLength(1);
  });

  // The cursor advances on a FAILED send as well as a successful one --
  // `lastId = subscriber.id` sits outside any success check. So a page where
  // every send failed still hands the next page a cursor past all of them,
  // and nothing will ever come back for those addresses. Pinned because the
  // alternative (not advancing) would loop the same page forever, which is
  // worse; the real fix is a retry the module deliberately does not have.
  it("advances the cursor past recipients whose send failed", async () => {
    const h = harness({ reply: () => new Response("nope", { status: 500 }) });

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.queued).toEqual([{ type: "notify-need-email", needId: SALISBURY_NEED, afterId: 2 }]);
    expect(h.logs).toContain(`notify-need-email: need ${SALISBURY_NEED} sent 2, next after id 2`);
  });

  // The success log says "sent 2" whether two emails were delivered, two were
  // rejected by Postmark, or two were skipped for want of a credential. It is
  // counting subscribers walked, not mail sent. Named here because it is the
  // line a maintainer would reach for first when asking "did the notification
  // go out?", and it cannot answer that question.
  it("reports the page as sent even when every send in it failed", async () => {
    const h = harness({ reply: () => new Response("nope", { status: 500 }) });

    await handleNotifyNeedEmail(firstPage(), h.env);

    expect(h.logs).toEqual([`notify-need-email: need ${SALISBURY_NEED} sent 2, next after id 2`]);
  });
});

// ===========================================================================
// THE MESSAGE CONTRACT
// ===========================================================================

describe("NotifyNeedEmailMessage", () => {
  // The message this handler enqueues must be one it (and queues/jobs.ts's
  // dispatch) can consume: same `type` discriminant, same field names. A typo
  // in the re-enqueued literal would send page two into the dispatcher's
  // `default:` branch, which throws "unknown job type" -- three retries and a
  // dead-letter entry per page, for every food bank, and the first page would
  // still have gone out perfectly.
  it("enqueues exactly the shape it consumes, so the next page round-trips", async () => {
    seedSubscriber({ id: 1, foodbankId: SALISBURY, email: "alice@example.com", confirmed: 1 });
    const h = harness();

    await handleNotifyNeedEmail(firstPage(), h.env);

    const next = h.queued[0]!;
    expect(next).toEqual({ type: "notify-need-email", needId: SALISBURY_NEED, afterId: 1 });
    // Typed, not just shaped: this assignment is the compile-time half of the
    // claim, and it is why the interface is exported at all.
    const roundTrip: NotifyNeedEmailMessage = next;
    expect(roundTrip.type).toBe("notify-need-email");

    // And it really is consumable: fed back in, it finds nothing left and
    // terminates rather than erroring.
    await handleNotifyNeedEmail(roundTrip, h.env);
    expect(h.posts).toHaveLength(1);
    expect(h.queued).toHaveLength(1);
  });
});
