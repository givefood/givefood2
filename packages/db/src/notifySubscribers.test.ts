import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteWebpushSubscriptionsByIds,
  deleteWhatsappSubscriber,
  findWhatsappSubscriber,
  getFoodbankNotifyTarget,
  getWebPushSubscriptionsPage,
  getWhatsappSubscribersPage,
  insertWhatsappSubscriber,
  setWhatsappLastNotified,
} from "./notifySubscribers";
import type { Session } from "./types";

// The database side of gfadmin/views.py:1999-2006's Notify button -- the three
// channels that go out alongside email (Firebase, web push, WhatsApp) -- plus
// the inbound WhatsApp subscribe/unsubscribe commands
// (givefood/views.py:1399-1470).
//
// WHY THIS FILE RUNS A REAL DATABASE RATHER THAN A MOCK. Every function here
// is one SQL statement and nothing else, so a fake session handing back canned
// rows would agree with every wrong implementation of it. And on this path the
// wrongness is SILENT in a way that has no page to look wrong on -- these
// queries feed a queue consumer, not a template:
//
//   * a dropped `foodbank_id` predicate sends one food bank's shopping list to
//     another food bank's subscribers;
//   * `id >= afterId` instead of `id >` re-notifies the last subscriber of
//     every page, forever, and the only symptom is somebody's phone buzzing
//     twice;
//   * a missing ORDER BY makes keyset paging skip subscribers outright -- and
//     on webpushsubscription that is not hypothetical, because SQLite really
//     does pick webpush_fb_endpoint_uniq and hand the rows back in ENDPOINT
//     order (executed, not argued, in "the ORDER BY is load-bearing" below);
//   * p256dh and auth swapped produces payloads no browser can decrypt, and
//     both columns are opaque base64url, so nothing downstream can tell;
//   * last_notified stamped over the whole page rather than the successes
//     claims a send that never happened.
//
// None of those raise. None of them log. The only thing that would ever notice
// is a test that runs the SQL.
//
// MUTATION-TESTED, per TESTING.md's convention, AND THEN REVIEWED
// ADVERSARIALLY: the module was copied into a scratchpad, broken 82 ways, and
// this file re-run against each. 77 die -- SELECT * and an is_closed filter on
// the food bank read; its id predicate neutered; ORDER BY, LIMIT and the
// foodbank_id predicate each dropped from both paging queries; `id >` widened
// to `id >=` on both; p256dh and auth swapped; the page's limit and cursor
// bound the wrong way round; both empty-array early returns removed; the delete
// returning ids.length instead of meta.changes; the WhatsApp page gaining a
// `last_notified IS NULL` filter; findWhatsappSubscriber losing its foodbank_id
// predicate, matching by LIKE, swapping its binds, and rewritten as
// `row?.id || null`; the insert's binds transposed each way, its created column
// dropped, its last_notified back-dated, its timestamp re-formatted with
// toISOString, and its await removed; the unsubscribe delete losing either
// predicate, narrowed to a single row, and reporting a boolean as a count; the
// last_notified stamp binding its ids before the timestamp, widened to the
// whole table, narrowed to blank rows only, and reduced to a single id; and the
// IN list collapsed to one placeholder or one bound id.
//
// SIX OF THOSE 77 ONLY DIE BECAUSE OF THE SECOND PASS. The first version of
// this file passed against all six, and each hole was the same kind of thing --
// a fixture in which every row matched, so a filter that excluded something had
// nothing to exclude, and an ordering that was wrong was wrong in the same
// direction as the data. They are named on the tests that now kill them:
//
//   * `WHERE id = ?` widened to `id >= ?` on the food bank read. The only miss
//     probe was id 4242, ABOVE every seeded food bank, so the operator itself
//     was never pinned -- now probed below the fixture as well.
//   * `AND browser IS NOT NULL` on the web push page and `AND created IS NOT
//     NULL` on the WhatsApp page. Both columns are nullable in the real schema;
//     every row the fixtures seeded had a value.
//   * The same predicate class on findWhatsappSubscriber and on the unsubscribe
//     delete, where the consequences are the worst in the file: a duplicate
//     subscription that bills twice per need, and an unsubscribe that replies
//     "You weren't subscribed" while deleting nothing.
//   * `ORDER BY id` swapped for `ORDER BY phone_number` on the WhatsApp page,
//     invisible while that fixture's numbers ascended alongside its ids. They
//     now descend, as the web push block's endpoints already did.
//   * `ORDER BY id` DELETED, from the WhatsApp page and from
//     findWhatsappSubscriber. Neither can be caught against today's index set:
//     whatsappsubscriber's only index is on (foodbank_id) alone, so every plan
//     available over this schema hands rows back in rowid order and the clause
//     changes nothing. Both are now executed against the one plausible widening
//     of that index -- to (foodbank_id, last_notified), same leading column --
//     under which the un-ordered forms really do return different rows. See the
//     two "even when the index" tests.
//
// FIVE SURVIVE, recorded rather than papered over, because each is equivalent
// or uncatchable without a fixture that lies:
//   * reordering the food bank SELECT list (D1 maps rows by column name), and
//     dropping `LIMIT 1` from findWhatsappSubscriber (`.first()` takes the
//     first row regardless) -- both behaviour-preserving, so the assertions are
//     deliberately written not to fail on them;
//   * deleting the food bank read's `?? null`: `Session` is D1DatabaseSession,
//     whose `.first()` is typed `Promise<T | null>`, so the coalesce is
//     unreachable against the real binding;
//   * `AND endpoint LIKE 'https://%'` on the web push page and `AND
//     phone_number LIKE '+%'` on the WhatsApp page. Killing those needs a row
//     with a non-https endpoint or a number without its "+", and production has
//     neither -- push services are https and normaliseFrom() adds the "+"
//     before the value reaches this layer. A fixture invented to catch them
//     would be asserting against data that cannot occur.
//
// THE SCHEMA IS THE MIGRATION FILES THEMSELVES, applied in order, not a
// transcribed CREATE TABLE -- the convention constituencySubscribers.test.ts
// and needAdminExtras.test.ts already follow, for the reason migration 0019
// taught this codebase: that migration dropped `foodbank_name` off six tables
// and four queries elsewhere went on naming a column that no longer existed,
// silently, until /dashboard/beautybanks/ was measured and found to be a live
// 500. A hand-copied schema in a test file is a second copy of the truth and
// drifts exactly the same way. Five details of the real schema are
// load-bearing below:
//
//   * webpushsubscription's only index is UNIQUE(foodbank_id, endpoint)
//     (0004_subscribers.sql:37), which is what makes that ORDER BY provable
//     from the fixture alone;
//   * whatsappsubscriber's only index is on (foodbank_id) ALONE (0020:40),
//     which is why its two ORDER BYs are provable only against a widened
//     index and not from any arrangement of rows;
//   * whatsappsubscriber.foodbank_id is NULLABLE (0020:34), unlike Django's
//     NOT NULL ForeignKey -- so `foodbank_id = ?` vs NULL is reachable here;
//   * webpushsubscription.browser (0004:35) and whatsappsubscriber.created
//     (0020:34) are nullable too, which is what the rows with NULLs in them
//     are for: they are the only thing standing between a spurious `IS NOT
//     NULL` predicate and a subscriber who silently stops being notified;
//   * whatsappsubscriber has NO unique index on (phone_number, foodbank_id),
//     which Django's Postgres does have -- see the "duplicate pairs" block.

type Bindable = null | number | bigint | string | Uint8Array;

interface Sent {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API these functions use -- prepare().bind()
// then .first() / .all() / .run() -- backed by node:sqlite. Deliberately dumb:
// it forwards the SQL untouched, so the ENGINE decides which rows come back
// and in what order. Interpreting the SQL here would mean testing this file's
// second implementation of SQLite rather than the module.
//
// `prepared` and `sent` are kept separately on purpose. `prepared` counts
// round trips, which is how the two empty-array early returns below can be
// shown to have skipped the database entirely rather than merely to have
// changed nothing. `sent` carries the bound parameter list, which is how the
// D1-100-bound-parameter cases can see a statement's ARITY -- something no
// assertion on the resulting rows could ever reveal.
function d1Session(db: DatabaseSync): { session: Session; prepared: string[]; sent: Sent[] } {
  const prepared: string[] = [];
  const sent: Sent[] = [];

  function statement(sql: string, params: Bindable[]) {
    const record = () => sent.push({ sql, params });
    return {
      // bind() returns a NEW statement rather than mutating this one, matching
      // D1's immutable prepared statements.
      bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
      first: async <T>() => {
        record();
        return (db.prepare(sql).get(...params) as T | undefined) ?? null;
      },
      all: async () => {
        record();
        return { results: db.prepare(sql).all(...params), success: true, meta: {} };
      },
      run: async () => {
        record();
        const info = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
    };
  }

  const session = {
    prepare(sql: string) {
      prepared.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  };

  return { session: session as unknown as Session, prepared, sent };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

// Three food banks, because almost every failure this file exists to catch is
// a query that ignores its foodbank_id argument -- and a fixture with one food
// bank in it passes those just as happily as a correct one does.
const SALISBURY = 7;
const DEVIZES = 12;
const CLOSED_FB = 99;

const SALISBURY_UUID = "b0a1c2d3e4f5460788990a1b2c3d4e5f";

let db: DatabaseSync;
let session: Session;
let prepared: string[];
let sent: Sent[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  ({ session, prepared, sent } = d1Session(db));
});

// Every NOT NULL column 0001_core.sql declares on foodbank, filled with
// whatever satisfies it. foodbank_name_uniq and foodbank_slug_uniq are real
// UNIQUE indexes, so name and slug have to differ per row.
function seedFoodbank(
  id: number,
  fields: { uuid: string; name: string; slug: string; isClosed?: number; altName?: string | null },
): void {
  db.prepare(
    "INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng, " +
      "charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative, " +
      "is_closed, no_locations, days_between_needs, created, modified) " +
      "VALUES (?, ?, ?, ?, ?, '1 High St', 'SP1 1AA', 'England', '51.0688,-1.7945', " +
      "0, 'info@example.org', 'https://example.org/', 'https://example.org/list/', 0, " +
      "?, 0, 14, '2020-01-01 00:00:00.000000', '2026-09-05 19:28:08.853000')",
  ).run(id, fields.uuid, fields.name, fields.altName ?? null, fields.slug, fields.isClosed ?? 0);
}

function seedWebPush(row: {
  id: number;
  foodbankId: number;
  endpoint: string;
  p256dh?: string;
  auth?: string;
  browser?: string | null;
}): void {
  db.prepare(
    "INSERT INTO webpushsubscription (id, created, foodbank_id, endpoint, p256dh, auth, browser) " +
      "VALUES (?, '2026-08-01 09:00:00.000000', ?, ?, ?, ?, ?)",
  ).run(
    row.id,
    row.foodbankId,
    row.endpoint,
    row.p256dh ?? `p256dh-${row.id}`,
    row.auth ?? `auth-${row.id}`,
    // `=== undefined`, NOT `??`. p256dh and auth are NOT NULL columns so `??`
    // is fine for those, but `browser` is nullable and a `??` here would
    // quietly turn `browser: null` back into "Firefox" -- leaving the
    // NULL-browser test below seeding a row indistinguishable from every other
    // one, and passing while proving nothing. A defaulting helper that cannot
    // express NULL is how a fixture ends up seeding only rows that match.
    row.browser === undefined ? "Firefox" : row.browser,
  );
}

function seedWhatsapp(row: {
  id: number;
  phone: string;
  foodbankId: number | null;
  created?: string | null;
  lastNotified?: string | null;
}): void {
  db.prepare("INSERT INTO whatsappsubscriber (id, phone_number, foodbank_id, created, last_notified) VALUES (?, ?, ?, ?, ?)").run(
    row.id,
    row.phone,
    row.foodbankId,
    // `=== undefined` for the same reason seedWebPush gives: `created` is
    // nullable here (0020:34) although Django's auto_now_add always fills it,
    // so the fixture has to be able to express the NULL that D1 permits.
    row.created === undefined ? "2026-08-01 09:00:00.000000" : row.created,
    row.lastNotified ?? null,
  );
}

// node:sqlite hands back null-prototype rows; toEqual against those reads
// badly, so everything asserted structurally goes through this first.
const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

interface WebPushRow {
  id: number;
  created: string;
  foodbank_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  browser: string | null;
}

interface WhatsappRow {
  id: number;
  phone_number: string;
  foodbank_id: number | null;
  created: string | null;
  last_notified: string | null;
}

const allWebPush = (): WebPushRow[] =>
  db
    .prepare("SELECT * FROM webpushsubscription ORDER BY id")
    .all()
    .map((row) => plain<WebPushRow>(row));

const allWhatsapp = (): WhatsappRow[] =>
  db
    .prepare("SELECT * FROM whatsappsubscriber ORDER BY id")
    .all()
    .map((row) => plain<WhatsappRow>(row));

// ===========================================================================
// getFoodbankNotifyTarget
// ===========================================================================

describe("getFoodbankNotifyTarget", () => {
  beforeEach(() => {
    seedFoodbank(SALISBURY, { uuid: SALISBURY_UUID, name: "Salisbury", slug: "salisbury", altName: "Banc Bwyd Caersallog" });
    seedFoodbank(DEVIZES, { uuid: "11112222333344445555666677778888", name: "Devizes", slug: "devizes" });
  });

  it("returns the three fields the notification needs, and only those three", async () => {
    const row = await getFoodbankNotifyTarget(session, SALISBURY);

    // The KEY SET, not just the values. `SELECT *` would work identically for
    // every consumer -- needFirebase/needWebPush/needWhatsApp each read only
    // uuid, slug and name -- while dragging 60-odd columns of every food bank
    // through a queue consumer that runs once per page of subscribers. The
    // narrow projection is the whole point of this function existing separately
    // from getFoodbankById, so it is asserted rather than assumed.
    //
    // Set, not sequence: reordering a SELECT list is behaviour-preserving (D1
    // maps rows by column name) and a test that failed on it would be noise.
    expect(Object.keys(plain(row)).sort()).toEqual(["name", "slug", "uuid"]);
    expect(plain(row)).toEqual({ uuid: SALISBURY_UUID, slug: "salisbury", name: "Salisbury" });
  });

  it("returns the food bank the id names, not the first row in the table", async () => {
    // A mutant that ignored `id` and took whatever came back first would pass
    // every single-row fixture. Firebase addresses a TOPIC built from this uuid
    // (notifications.py:203, `foodbank-{uuid}`), so getting the wrong row here
    // publishes Salisbury's shopping list to every device subscribed to Devizes.
    expect(plain(await getFoodbankNotifyTarget(session, DEVIZES))).toEqual({
      uuid: "11112222333344445555666677778888",
      slug: "devizes",
      name: "Devizes",
    });
  });

  it("returns null when the id has no row -- probed BELOW the seeded ids as well as above", async () => {
    // All three consumers branch on this: needWebPush.ts:63 and
    // needWhatsApp.ts:55 log "food bank N not found" and abandon the page,
    // whatsappHook.ts:145 falls back to the slug in its reply.
    //
    // BOTH DIRECTIONS, AND THE LOW ONE IS THE POINT. `WHERE id = ?` mutated to
    // `WHERE id >= ?` -- a plausible slip, and the operator class this repo has
    // already been bitten by -- survives a probe of 4242, because nothing is
    // above it and the answer is null either way. Probed at 1, that same mutant
    // returns SALISBURY: the consumer for a food bank that no longer exists
    // would then send a real notification, titled with a different food bank's
    // name, to whoever is subscribed to the id it was actually given. A
    // one-sided miss probe pins the row lookup but not the OPERATOR.
    expect(await getFoodbankNotifyTarget(session, 4242)).toBeNull();
    expect(await getFoodbankNotifyTarget(session, 1)).toBeNull();

    // What this deliberately does NOT pin is the module's `?? null`. `Session`
    // is D1's `D1DatabaseSession` and its `.first()` is typed
    // `Promise<T | null>`, so against the real binding the coalesce is
    // unreachable: deleting it is an equivalent mutation, and the harness
    // below models D1's null rather than node:sqlite's undefined precisely so
    // this file does not pretend otherwise.
  });

  it("returns a CLOSED food bank as readily as an open one", async () => {
    // There is no `is_closed = 0` predicate, and there must not be. Django
    // reaches this row by dereferencing `need.foodbank` -- a plain FK, filtered
    // by nothing -- so a closed food bank that still publishes a need still
    // notifies its subscribers. Adding the filter that most other queries in
    // this package carry would make this return null, and the consumers treat
    // null as "abandon the page": the notification would vanish with an error
    // line and no other trace.
    seedFoodbank(CLOSED_FB, { uuid: "99998888777766665555444433332222", name: "Closed Place", slug: "closed-place", isClosed: 1 });

    expect(plain(await getFoodbankNotifyTarget(session, CLOSED_FB))).toMatchObject({ name: "Closed Place" });
  });

  it("returns the raw `name` column, not full_name() and not alt_name", async () => {
    // The module header's claim, verified against notifications.py:206, 313 and
    // 548: all three channels name the food bank the notification `f"{need.foodbank.name}
    // needs ..."`. That is `name`, NOT `full_name()`, which appends " Foodbank"
    // (foodbank.py:261-269) and is what the EMAIL subject uses -- so the two
    // paths genuinely differ and harmonising them would change the wording of
    // every push notification the site sends.
    //
    // alt_name is the Welsh name full_name() substitutes under `cy`
    // (foodbank.py:271-279); the fixture gives Salisbury one specifically so a
    // query that reached for it would be visible here.
    const row = plain<{ name: string }>(await getFoodbankNotifyTarget(session, SALISBURY));
    expect(row.name).toBe("Salisbury");
    expect(row.name).not.toContain("Foodbank");
    expect(row.name).not.toBe("Banc Bwyd Caersallog");
  });

  it("spends one round trip with the id as its only bound parameter", async () => {
    await getFoodbankNotifyTarget(session, SALISBURY);

    // One statement, one parameter. This runs once per PAGE of subscribers --
    // needWebPush.ts:62 and needWhatsApp.ts:54 both call it after fetching the
    // page -- so a second round trip added here is a second round trip per
    // queue message for the whole fan-out.
    expect(prepared).toHaveLength(1);
    expect(sent[0]!.params).toEqual([SALISBURY]);
    expect(sent[0]!.sql).toContain("FROM foodbank");
  });
});

// ===========================================================================
// getWebPushSubscriptionsPage
// ===========================================================================

describe("getWebPushSubscriptionsPage", () => {
  // ENDPOINTS DESCEND AS IDS ASCEND. This is not decoration: webpushsubscription's
  // only index is UNIQUE(foodbank_id, endpoint), SQLite plans this query as a
  // SEARCH through it, and so an ORDER BY-less version of the statement returns
  // rows in endpoint order. Making endpoint order the exact reverse of id order
  // is what turns "the ORDER BY works" from an assertion that passes by luck
  // into one the engine has to earn.
  beforeEach(() => {
    seedWebPush({ id: 1, foodbankId: SALISBURY, endpoint: "https://push.example/zulu" });
    seedWebPush({ id: 2, foodbankId: SALISBURY, endpoint: "https://push.example/yankee" });
    seedWebPush({ id: 3, foodbankId: SALISBURY, endpoint: "https://push.example/xray" });
    seedWebPush({ id: 4, foodbankId: SALISBURY, endpoint: "https://push.example/whiskey" });
    seedWebPush({ id: 5, foodbankId: SALISBURY, endpoint: "https://push.example/victor" });
    // Another food bank's subscribers, and a food bank with none at all. Both
    // shapes matter: the first proves the filter filters, the second proves an
    // empty result is a real answer rather than a crash.
    seedWebPush({ id: 6, foodbankId: DEVIZES, endpoint: "https://push.example/alpha" });
    seedWebPush({ id: 7, foodbankId: DEVIZES, endpoint: "https://push.example/bravo" });
  });

  it("returns only the requested food bank's subscriptions", async () => {
    // The failure this prevents has no visible symptom on this site at all: the
    // wrong browser gets a notification about a shopping list for a food bank
    // 20 miles away, and nothing here ever knows. Devizes' two rows sit either
    // side of the limit deliberately -- ids 6 and 7 are the HIGHEST in the
    // table, so a dropped foodbank_id predicate shows up as extra rows on the
    // last page rather than at the front where a `toHaveLength` might catch it.
    const page = await getWebPushSubscriptionsPage(session, SALISBURY, 0, 100);

    expect(page.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns an empty page for a food bank nobody subscribed to", async () => {
    // needWebPush.ts:57-60's termination condition -- an empty page is what
    // ends the fan-out. A query that fell back to "every subscription" when the
    // food bank had none would notify the entire country.
    expect(await getWebPushSubscriptionsPage(session, CLOSED_FB, 0, 100)).toEqual([]);
  });

  it("orders by id, not by the order the index hands rows back", async () => {
    const page = await getWebPushSubscriptionsPage(session, SALISBURY, 0, 3);
    expect(page.map((row) => row.id)).toEqual([1, 2, 3]);

    // THE COUNTEREXAMPLE, EXECUTED IN THE SAME ENGINE rather than reasoned
    // about. Delete the ORDER BY and this is what production would do -- and
    // because the consumer pages on `afterId = lastId`, the very first page
    // would come back [5,4,3] and set afterId to 3, so subscribers 4 and 5
    // would be notified and then skipped while 1 and 2 are notified twice.
    const unordered = db
      .prepare("SELECT id FROM webpushsubscription WHERE foodbank_id = ?1 AND id > ?2 LIMIT ?3")
      .all(SALISBURY, 0, 3)
      .map((row) => (row as unknown as { id: number }).id);
    expect(unordered).toEqual([5, 4, 3]);
  });

  it("treats afterId as EXCLUSIVE, so the last subscriber of a page is never re-sent", async () => {
    // `id > ?2`, not `id >= ?2`. The consumer sets `afterId` to the id it just
    // finished (needWebPush.ts:104), so a `>=` would re-notify that subscriber
    // on every subsequent page: one extra buzz per page, per need, forever, and
    // no error anywhere. One character, and only this assertion sees it.
    const page = await getWebPushSubscriptionsPage(session, SALISBURY, 2, 100);

    expect(page.map((row) => row.id)).toEqual([3, 4, 5]);
    expect(page.map((row) => row.id)).not.toContain(2);
  });

  it("walks the whole list in pages of two and stops", async () => {
    // The real fan-out, run end to end: five subscribers, PAGE_SIZE of two.
    // Keyset paging (`id > afterId`) rather than LIMIT/OFFSET, because the
    // pages are separate queue messages and an OFFSET scan would re-read
    // everything ahead of it each time.
    const seen: number[] = [];
    let afterId = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = await getWebPushSubscriptionsPage(session, SALISBURY, afterId, 2);
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.id));
      afterId = page[page.length - 1]!.id;
    }

    // Every subscriber exactly once, in order, and the loop terminated on its
    // own -- the three properties the whole paging design is for.
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(afterId).toBe(5);
  });

  it("honours the limit, and a short final page is a short page rather than a wrap", async () => {
    expect((await getWebPushSubscriptionsPage(session, SALISBURY, 0, 2)).map((r) => r.id)).toEqual([1, 2]);
    expect((await getWebPushSubscriptionsPage(session, SALISBURY, 4, 2)).map((r) => r.id)).toEqual([5]);
    expect(await getWebPushSubscriptionsPage(session, SALISBURY, 5, 2)).toEqual([]);
  });

  it("selects exactly the four columns RFC 8291 encryption needs, each in its own key", async () => {
    // p256dh and auth are both opaque base64url blobs of the right sort of
    // length, so a transposed pair is invisible in the row, in the payload, and
    // in the log. It surfaces only as every push failing to decrypt in the
    // browser -- which produces no error on this side of the wire at all.
    // Distinguishable seeds are what make the swap detectable here.
    seedWebPush({ id: 8, foodbankId: CLOSED_FB, endpoint: "https://push.example/one", p256dh: "THE-P256DH", auth: "THE-AUTH" });

    const [row] = await getWebPushSubscriptionsPage(session, CLOSED_FB, 0, 10);

    expect(plain(row)).toEqual({ id: 8, endpoint: "https://push.example/one", p256dh: "THE-P256DH", auth: "THE-AUTH" });
    // `browser` and `created` exist on the table and are deliberately not
    // fetched -- nothing in the send path reads either. Compared as a set, for
    // the reason getFoodbankNotifyTarget's equivalent assertion gives.
    expect(Object.keys(plain(row!)).sort()).toEqual(["auth", "endpoint", "id", "p256dh"]);
  });

  it("returns a subscription whose browser was never recorded", async () => {
    // THE NULLABLE-COLUMN HOLE, and the only row in this block that the happy
    // path does not already seed. `browser` is `TEXT` with no NOT NULL
    // (0004_subscribers.sql:35); it is filled from the User-Agent at subscribe
    // time, so a client that sent none leaves it NULL.
    //
    // Mutant this kills: `AND browser IS NOT NULL` bolted onto the WHERE. It
    // survived every other assertion in this file, because every other seeded
    // row has a browser -- which is exactly the shape of hole a fixture that
    // only seeds MATCHING rows leaves behind. In production the filter would
    // silently stop notifying the subscribers nobody can identify, and the
    // fan-out would still report a clean page.
    //
    // "uniform" keeps this block's endpoints-descend-as-ids-ascend invariant
    // intact, so it cannot accidentally weaken the ORDER BY case above.
    seedWebPush({ id: 9, foodbankId: SALISBURY, endpoint: "https://push.example/uniform", browser: null });
    // The fixture verifying its own claim. If seedWebPush's defaulting ever
    // reverts to `??`, this row becomes an ordinary Firefox row and the
    // assertion below would go on passing while testing nothing at all -- which
    // is the exact failure mode this test was added to fix.
    expect(allWebPush().find((row) => row.id === 9)!.browser).toBeNull();

    const page = await getWebPushSubscriptionsPage(session, SALISBURY, 0, 100);

    expect(page.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 9]);
  });

  it("binds foodbank, cursor and limit in that order, in one round trip", async () => {
    await getWebPushSubscriptionsPage(session, SALISBURY, 2, 25);

    expect(prepared).toHaveLength(1);
    // The numbered placeholders (?1/?2/?3) still bind POSITIONALLY. Two ints
    // and an int adjacent to each other is exactly the arrangement in which a
    // reordering runs perfectly and returns the wrong rows -- bind the limit
    // where the cursor goes and a 25-subscriber food bank silently notifies
    // whoever happens to have an id above 25.
    expect(sent[0]!.params).toEqual([SALISBURY, 2, 25]);
  });
});

// ===========================================================================
// deleteWebpushSubscriptionsByIds
// ===========================================================================

describe("deleteWebpushSubscriptionsByIds", () => {
  beforeEach(() => {
    seedWebPush({ id: 1, foodbankId: SALISBURY, endpoint: "https://push.example/one" });
    seedWebPush({ id: 2, foodbankId: SALISBURY, endpoint: "https://push.example/two" });
    seedWebPush({ id: 3, foodbankId: SALISBURY, endpoint: "https://push.example/three" });
    seedWebPush({ id: 4, foodbankId: DEVIZES, endpoint: "https://push.example/four" });
  });

  it("deletes exactly the ids it was given and leaves everything else standing", async () => {
    // notifications.py:426-427: a push service answering 404 or 410 is saying
    // the subscription is dead. The consumer collects those ids per page
    // (needWebPush.ts:110-113) and hands them here. Deleting one row too many
    // silently unsubscribes somebody who never asked to be.
    const deleted = await deleteWebpushSubscriptionsByIds(session, [1, 3]);

    expect(deleted).toBe(2);
    expect(allWebPush().map((row) => row.id)).toEqual([2, 4]);
  });

  it("returns the number of rows that actually went, not the length of the list", async () => {
    // `result.meta.changes`, which is what the consumer prints. A page can name
    // an id that a concurrent page already deleted -- the same endpoint can be
    // registered against several food banks, and each fan-out deletes
    // independently -- so ids.length would over-report. Two of these three
    // exist.
    expect(await deleteWebpushSubscriptionsByIds(session, [2, 4, 999])).toBe(2);
    expect(allWebPush().map((row) => row.id)).toEqual([1, 3]);
  });

  it("does not touch the database at all for an empty list", async () => {
    const deleted = await deleteWebpushSubscriptionsByIds(session, []);

    expect(deleted).toBe(0);
    // `prepared` empty, not merely "changes 0": the guard is there to skip a
    // D1 round trip on every page where nothing was gone, which is nearly all
    // of them. Note it is NOT protecting against a syntax error -- SQLite
    // accepts an empty `IN ()` list as an extension and reports 0 changes --
    // so the only evidence the early return still works is this counter.
    expect(prepared).toEqual([]);
    expect(allWebPush()).toHaveLength(4);
  });

  it("emits one placeholder per id, bound positionally", async () => {
    await deleteWebpushSubscriptionsByIds(session, [3, 1]);

    expect(sent[0]!.sql).toBe("DELETE FROM webpushsubscription WHERE id IN (?, ?)");
    // Bound, not interpolated. The ids come from a loop over rows this same
    // module returned so they are trustworthy today, but the statement is built
    // with string concatenation, which is the one construct in this package
    // that COULD carry a value into the SQL text if someone changed the source
    // of the list.
    expect(sent[0]!.params).toEqual([3, 1]);
  });

  it("is not scoped to a food bank -- it trusts the caller's ids completely", async () => {
    // Pinned because it is a real property rather than an oversight: the ids
    // always come straight from getWebPushSubscriptionsPage, which already
    // scoped them. A future caller that assembled ids from somewhere else would
    // find no second predicate protecting it, and id 4 belongs to Devizes.
    expect(await deleteWebpushSubscriptionsByIds(session, [4])).toBe(1);
    expect(allWebPush().map((row) => row.id)).toEqual([1, 2, 3]);
  });

  describe("D1's 100-bound-parameter statement limit", () => {
    beforeEach(() => {
      db.exec("DELETE FROM webpushsubscription");
      for (let id = 1; id <= 101; id++) {
        seedWebPush({ id, foodbankId: SALISBURY, endpoint: `https://push.example/${id}` });
      }
    });

    it("sends exactly 100 parameters for 100 ids -- at the cap, and they all go", async () => {
      const ids = Array.from({ length: 100 }, (_, i) => i + 1);

      expect(await deleteWebpushSubscriptionsByIds(session, ids)).toBe(100);
      // One parameter per id and nothing else in the statement, so 100 ids is
      // exactly the cap. The module's own comment ("A page is far smaller than
      // that, but the cap is the reason this takes the page's ids rather than
      // accumulating across the whole fan-out") is what keeps it there:
      // PAGE_SIZE is 25 (needWebPush.ts), so today the largest possible call is
      // 25 ids.
      expect(sent[0]!.params).toHaveLength(100);
      expect((sent[0]!.sql.match(/\?/g) ?? []).length).toBe(100);
      expect(allWebPush().map((row) => row.id)).toEqual([101]);
    });

    // SUSPECT, PINNED AS-IS. There is no chunking: 101 ids build a 101-parameter
    // statement, which D1 rejects outright ("too many SQL variables"). node:sqlite's
    // own limit is 32766, so the engine under this test runs it happily and the
    // rows really do go -- the divergence is in D1, not here, and asserting a
    // throw would be asserting a wish. Unreachable today because the only caller
    // pages at 25; it becomes reachable the moment PAGE_SIZE goes past 100.
    // Recorded so the arity is a decision rather than an accident.
    it("would build an over-cap statement for 101 ids rather than chunking", async () => {
      const ids = Array.from({ length: 101 }, (_, i) => i + 1);

      await deleteWebpushSubscriptionsByIds(session, ids);

      expect(prepared).toHaveLength(1);
      expect(sent[0]!.params).toHaveLength(101);
      expect(allWebPush()).toEqual([]);
    });
  });
});

// ===========================================================================
// getWhatsappSubscribersPage
// ===========================================================================

describe("getWhatsappSubscribersPage", () => {
  // PHONE NUMBERS DESCEND AS IDS ASCEND, for the reason the web push block
  // gives for its endpoints. With the numbers ascending alongside the ids --
  // which is how this fixture was first written -- `ORDER BY id` mutated to
  // `ORDER BY phone_number` returns the same rows in the same order and not one
  // assertion in this file moves. Opposing the two orders is what makes the
  // ORDER BY's COLUMN testable and not merely its direction.
  beforeEach(() => {
    seedWhatsapp({ id: 1, phone: "+447700900003", foodbankId: SALISBURY });
    seedWhatsapp({ id: 2, phone: "+447700900002", foodbankId: SALISBURY, lastNotified: "2026-08-20 10:00:00.000000" });
    seedWhatsapp({ id: 3, phone: "+447700900001", foodbankId: SALISBURY });
    seedWhatsapp({ id: 4, phone: "+447700900004", foodbankId: DEVIZES });
    // The same number as id 1, subscribed to a second food bank. Production has
    // a number subscribed to 10 (0020_whatsappsubscriber.sql:42-44), so this is
    // the normal case, not an edge one.
    seedWhatsapp({ id: 5, phone: "+447700900003", foodbankId: DEVIZES });
  });

  it("returns only this food bank's subscribers, in id order", async () => {
    const page = await getWhatsappSubscribersPage(session, SALISBURY, 0, 100);

    expect(page.map((row) => row.id)).toEqual([1, 2, 3]);
    // Two things at once, because the fixture opposes the orders. +447700900003
    // is subscribed to BOTH food banks: dropping the foodbank_id predicate would
    // not merely add rows, it would send this person Salisbury's shopping list
    // when Devizes published -- a WhatsApp template message, which costs money
    // per send and which they can report as spam. And the numbers coming back
    // DESCENDING is what fails an `ORDER BY phone_number`, which is otherwise
    // indistinguishable from `ORDER BY id` here and pages the fan-out by a
    // column the cursor does not advance on.
    expect(page.map((row) => row.phone_number)).toEqual(["+447700900003", "+447700900002", "+447700900001"]);
  });

  it("has NO confirmed / last_notified gate -- everyone gets every need", async () => {
    // Deliberately unlike getConfirmedSubscribersPage (subscribers.ts:332-349),
    // which carries `AND confirmed = 1`. notifications.py:640 is a bare
    // `WhatsappSubscriber.objects.filter(foodbank=need.foodbank)`: a WhatsApp
    // subscriber opted in through WhatsApp itself, so there is no double-opt-in
    // step to gate on. Subscriber 2 was already notified three weeks ago and
    // must still be in this page -- an `AND last_notified IS NULL` that looked
    // like a sensible de-dupe would mean every subscriber hears about exactly
    // one need, ever, and then goes quiet.
    const page = await getWhatsappSubscribersPage(session, SALISBURY, 0, 100);

    expect(page.map((row) => row.id)).toContain(2);
  });

  it("excludes a row whose foodbank_id is NULL", async () => {
    // whatsappsubscriber.foodbank_id is NULLABLE in D1 (0020:34) although
    // Django's ForeignKey is NOT NULL -- so this state is reachable here and
    // was not reachable in Postgres. SQLite's three-valued logic makes
    // `NULL = 7` neither true nor false, so the row is simply invisible: no
    // error, no log, a subscriber who never hears anything again. Pinned so the
    // behaviour is known rather than discovered.
    seedWhatsapp({ id: 6, phone: "+447700900006", foodbankId: null });

    const page = await getWhatsappSubscribersPage(session, SALISBURY, 0, 100);
    expect(page.map((row) => row.id)).not.toContain(6);
    // And it is invisible to every food bank, not just this one.
    expect(await getWhatsappSubscribersPage(session, DEVIZES, 0, 100)).toHaveLength(2);
  });

  it("treats afterId as EXCLUSIVE and orders by id", async () => {
    // Same one-character risk as the web push page: `>=` re-sends the last
    // subscriber of each page. A WhatsApp template send is billed, so a
    // duplicate here costs real money as well as goodwill.
    const page = await getWhatsappSubscribersPage(session, SALISBURY, 1, 100);

    expect(page.map((row) => row.id)).toEqual([2, 3]);
  });

  it("honours the limit rather than returning the whole list", async () => {
    // Asserted separately from the walk below, because the walk alone does NOT
    // pin it: with three subscribers and a page size of two, a query that
    // ignored its LIMIT returns [1,2,3] on the first page and an empty second
    // page, and the ids seen end up identical either way. Found by the mutation
    // run -- "drop the LIMIT" survived until this case existed. It matters
    // because a real food bank's page would then be the whole subscriber list
    // in one queue message, which is the CPU-limit failure the paging exists to
    // avoid, and it would surface only on the largest food bank.
    expect((await getWhatsappSubscribersPage(session, SALISBURY, 0, 2)).map((row) => row.id)).toEqual([1, 2]);
    expect((await getWhatsappSubscribersPage(session, SALISBURY, 0, 1)).map((row) => row.id)).toEqual([1]);
  });

  it("walks the list in pages and terminates", async () => {
    const seen: number[] = [];
    let afterId = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = await getWhatsappSubscribersPage(session, SALISBURY, afterId, 2);
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.id));
      afterId = page[page.length - 1]!.id;
    }

    expect(seen).toEqual([1, 2, 3]);
  });

  it("selects exactly id and phone_number", async () => {
    const [row] = await getWhatsappSubscribersPage(session, SALISBURY, 0, 1);

    // `last_notified` is written by setWhatsappLastNotified below and read by
    // nothing on the send path; `created` likewise. Fetching them would be
    // harmless but would make the send path look as though it consulted them.
    expect(plain(row)).toEqual({ id: 1, phone_number: "+447700900003" });
  });

  it("returns a subscriber whose created column is NULL", async () => {
    // The nullable-column hole again, this table's version of it. `created` is
    // plain `TEXT` here (0020:34) even though Django's auto_now_add always
    // filled it, so a row written by anything other than insertWhatsappSubscriber
    // -- a manual fix-up, a future import -- can hold NULL.
    //
    // Mutant this kills: `AND created IS NOT NULL` in the WHERE, which survived
    // the whole of the rest of this file because every other seeded row carries
    // a created. A subscriber dropped this way is never notified again and
    // nothing anywhere reports a smaller page.
    seedWhatsapp({ id: 7, phone: "+447700900000", foodbankId: SALISBURY, created: null });
    // Self-verifying, for the reason the web push equivalent gives: a helper
    // that cannot express NULL turns this into an ordinary row silently.
    expect(allWhatsapp().find((row) => row.id === 7)!.created).toBeNull();

    const page = await getWhatsappSubscribersPage(session, SALISBURY, 0, 100);

    expect(page.map((row) => row.id)).toEqual([1, 2, 3, 7]);
  });

  it("orders by id even when the index stops handing rows back in id order", async () => {
    // THE ORDER BY, PROVED RATHER THAN ASSUMED -- and it took a second attempt.
    // Against today's schema, deleting `ORDER BY id` from this statement changes
    // NOTHING: whatsappsubscriber's only index is on (foodbank_id) alone
    // (0020:40), so SQLite answers this as a covering search through it in rowid
    // order and the rows come back ascending regardless. That mutant survived
    // the first version of this file, and no arrangement of THIS fixture can
    // kill it, because `ORDER BY id` on an INTEGER PRIMARY KEY is rowid order
    // and every plan available over this schema produces exactly that.
    //
    // The clause is load-bearing anyway, because the order of a SELECT without
    // ORDER BY is a property of the PLAN, not of the table -- so it changes when
    // the plan does. Widening that index to (foodbank_id, last_notified) is the
    // least exotic change anyone could make to it: same leading column, so this
    // query still uses it, and it is what you would add to answer "who has not
    // been notified since X". Under it the un-ordered form pages the food bank
    // BACKWARDS. Executed here rather than argued, in the same engine.
    db.exec(
      "UPDATE whatsappsubscriber SET last_notified = '2026-08-30 10:00:00.000000' WHERE id = 1;" +
        "UPDATE whatsappsubscriber SET last_notified = '2026-08-20 10:00:00.000000' WHERE id = 2;" +
        "UPDATE whatsappsubscriber SET last_notified = '2026-08-10 10:00:00.000000' WHERE id = 3;" +
        "DROP INDEX whatsappsubscriber_foodbank_idx;" +
        "CREATE INDEX whatsappsubscriber_foodbank_idx ON whatsappsubscriber(foodbank_id, last_notified);",
    );

    const unordered = db
      .prepare("SELECT id FROM whatsappsubscriber WHERE foodbank_id = ?1 AND id > ?2 LIMIT ?3")
      .all(SALISBURY, 0, 2)
      .map((row) => (row as unknown as { id: number }).id);
    expect(unordered).toEqual([3, 2]);

    // What that would cost, spelled out, because the consumer pages on
    // `afterId = the last id of the page` (needWhatsApp.ts): the first page
    // returns [3,2] and sets afterId to 2, the second asks for `id > 2` and
    // returns [3] again, the third is empty and the fan-out stops. Subscriber 3
    // is messaged twice -- a billed template send -- and subscriber 1 is never
    // messaged at all. No error, no log, nothing to notice.
    expect((await getWhatsappSubscribersPage(session, SALISBURY, 0, 2)).map((row) => row.id)).toEqual([1, 2]);
    expect((await getWhatsappSubscribersPage(session, SALISBURY, 2, 2)).map((row) => row.id)).toEqual([3]);
  });

  it("binds foodbank, cursor and limit in that order", async () => {
    await getWhatsappSubscribersPage(session, DEVIZES, 4, 25);

    expect(prepared).toHaveLength(1);
    expect(sent[0]!.params).toEqual([DEVIZES, 4, 25]);
  });
});

// ===========================================================================
// findWhatsappSubscriber
// ===========================================================================

describe("findWhatsappSubscriber", () => {
  beforeEach(() => {
    seedWhatsapp({ id: 10, phone: "+447700900001", foodbankId: SALISBURY });
    seedWhatsapp({ id: 11, phone: "+447700900001", foodbankId: DEVIZES });
    seedWhatsapp({ id: 12, phone: "+447700900002", foodbankId: SALISBURY });
  });

  it("returns the id of the matching row", async () => {
    expect(await findWhatsappSubscriber(session, "+447700900001", SALISBURY)).toBe(10);
  });

  it("returns null when the pair has no row", async () => {
    // The read half of views.py:1420-1423's get_or_create. null is what makes
    // whatsappHook.ts:147-152 go on to INSERT and reply "You've successfully
    // subscribed"; a non-null answer replies "You're already subscribed" and
    // writes nothing. Get this wrong in either direction and the subscribe
    // command becomes a no-op that claims success.
    expect(await findWhatsappSubscriber(session, "+447700900009", SALISBURY)).toBeNull();
  });

  it("matches on BOTH phone number and food bank, never on either alone", async () => {
    // The same number is subscribed to Salisbury and Devizes, which production
    // does to a depth of 10. A phone-only match would tell somebody they are
    // already subscribed to a food bank they have never heard of, and their
    // subscribe would silently never happen. A foodbank-only match would
    // subscribe the wrong person's number.
    expect(await findWhatsappSubscriber(session, "+447700900001", DEVIZES)).toBe(11);
    expect(await findWhatsappSubscriber(session, "+447700900002", DEVIZES)).toBeNull();
  });

  it("compares the phone number exactly -- no normalising, no prefix match", async () => {
    // normaliseFrom() (whatsappHook.ts:85-87) prepends the "+" before the value
    // ever reaches this layer, so the stored form always carries it. A LIKE, or
    // a match that ignored the "+", would let "447700900001" find a row it
    // should not, and the corresponding INSERT elsewhere would store the
    // un-prefixed form -- two rows for one person, one of which the unsubscribe
    // command can never find.
    expect(await findWhatsappSubscriber(session, "447700900001", SALISBURY)).toBeNull();
    expect(await findWhatsappSubscriber(session, "+44770090000", SALISBURY)).toBeNull();
  });

  it("returns the LOWEST id when the pair somehow appears twice", async () => {
    // `ORDER BY id LIMIT 1` where Django uses `.get()`. D1 has no unique index
    // on (phone_number, foodbank_id), so a duplicate really is possible here
    // (see the insert tests below for why that matters), and the caller needs
    // ONE defined answer rather than "whichever row the engine reaches first".
    //
    // WHAT THIS TEST CAN AND CANNOT PROVE ON ITS OWN, recorded because the
    // mutation run found it: deleting the ORDER BY does NOT fail this case.
    // whatsappsubscriber's only index is on (foodbank_id) alone, so SQLite
    // answers the query by walking that index in rowid order and a bare LIMIT 1
    // lands on the lowest id anyway -- demonstrated below rather than asserted,
    // so the claim is the engine's and not this comment's. The assertion here
    // pins the CONTRACT (lowest id, deterministically); the test that follows
    // pins the CLAUSE.
    seedWhatsapp({ id: 9, phone: "+447700900001", foodbankId: SALISBURY });

    expect(await findWhatsappSubscriber(session, "+447700900001", SALISBURY)).toBe(9);

    const unordered = plain<{ id: number }>(
      db.prepare("SELECT id FROM whatsappsubscriber WHERE phone_number = ?1 AND foodbank_id = ?2 LIMIT 1").get("+447700900001", SALISBURY),
    );
    expect(unordered.id).toBe(9);
  });

  it("still returns the LOWEST id once the index stops handing rows back in id order", async () => {
    // The other half, and the one that makes `ORDER BY id LIMIT 1` more than
    // decoration. Same technique as the paging block's ordering test: widen the
    // send path's existing index from (foodbank_id) to (foodbank_id,
    // last_notified) -- same leading column, still used by this lookup -- and
    // the rows for the pair arrive stamp-first instead of id-first. The
    // un-ordered form then answers 10 where the module answers 9.
    //
    // Which matters here more than anywhere else in this file: this function's
    // answer is a subscriber id that whatsappHook.ts uses to decide whether a
    // "subscribe" is a no-op, and an answer that depends on the query plan is
    // one that can change under a migration nobody connected to this code.
    seedWhatsapp({ id: 9, phone: "+447700900001", foodbankId: SALISBURY, lastNotified: "2026-08-30 10:00:00.000000" });
    db.exec(
      "UPDATE whatsappsubscriber SET last_notified = '2026-08-10 10:00:00.000000' WHERE id = 10;" +
        "DROP INDEX whatsappsubscriber_foodbank_idx;" +
        "CREATE INDEX whatsappsubscriber_foodbank_idx ON whatsappsubscriber(foodbank_id, last_notified);",
    );

    const unordered = plain<{ id: number }>(
      db.prepare("SELECT id FROM whatsappsubscriber WHERE phone_number = ?1 AND foodbank_id = ?2 LIMIT 1").get("+447700900001", SALISBURY),
    );
    expect(unordered.id).toBe(10);

    expect(await findWhatsappSubscriber(session, "+447700900001", SALISBURY)).toBe(9);
  });

  it("reports a row whose id is 0 as found, not as absent", async () => {
    // `row ? row.id : null` tests the ROW, not the id. Rewritten as
    // `row?.id || null` -- a plausible tidy-up -- id 0 would come back as null
    // and the consumer would insert a second subscription for somebody who
    // already has one. id 0 is not a value the Postgres sequence produces, but
    // SQLite will happily accept it into an INTEGER PRIMARY KEY, which is
    // exactly the sort of thing an import script does.
    seedWhatsapp({ id: 0, phone: "+447700900007", foodbankId: SALISBURY });

    expect(await findWhatsappSubscriber(session, "+447700900007", SALISBURY)).toBe(0);
  });

  it("finds a subscriber whose created is NULL and who has already been notified", async () => {
    // The nullable-column hole on the READ half of get_or_create, and the
    // consequence is the worst of the three places this file closes it.
    // `created` is nullable (0020:34) and `last_notified` is set on every
    // successful send, so a long-standing subscriber looks like this row.
    //
    // Mutants killed: `AND created IS NOT NULL`, and `AND last_notified IS
    // NULL` -- the sort of predicate someone adds meaning "only the ones we
    // have not dealt with yet". Either makes this function answer null for
    // somebody who IS subscribed, whereupon whatsappHook.ts:147-152 inserts a
    // second row and replies "You've successfully subscribed". The person then
    // receives every future need twice, on billed template messages, and the
    // duplicate pair is exactly the state the insert block below explains
    // Postgres refused and D1 does not.
    seedWhatsapp({ id: 13, phone: "+447700900003", foodbankId: SALISBURY, created: null, lastNotified: "2026-08-20 10:00:00.000000" });
    expect(plain<WhatsappRow>(allWhatsapp().find((row) => row.id === 13))).toMatchObject({
      created: null,
      last_notified: "2026-08-20 10:00:00.000000",
    });

    expect(await findWhatsappSubscriber(session, "+447700900003", SALISBURY)).toBe(13);
  });

  it("spends one round trip, binding phone then food bank", async () => {
    await findWhatsappSubscriber(session, "+447700900001", SALISBURY);

    expect(prepared).toHaveLength(1);
    expect(sent[0]!.params).toEqual(["+447700900001", SALISBURY]);
  });
});

// ===========================================================================
// insertWhatsappSubscriber
// ===========================================================================

describe("insertWhatsappSubscriber", () => {
  const PY_NOW = "2026-09-05 19:28:08.853000";

  it("writes one row with each value in its own column", async () => {
    await insertWhatsappSubscriber(session, "+447700900001", SALISBURY, PY_NOW);

    const rows = allWhatsapp();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone_number: "+447700900001", foodbank_id: SALISBURY, created: PY_NOW });
  });

  it("leaves last_notified NULL rather than back-dating it to the subscribe", async () => {
    // The Django field is `null=True, editable=False` (subscribers.py:144) and
    // is set only by a successful send (notifications.py:650-654). A value here
    // would be a claim that this person has already been messaged -- harmless
    // today because nothing on the send path reads the column, which is exactly
    // why it would never be noticed.
    await insertWhatsappSubscriber(session, "+447700900001", SALISBURY, PY_NOW);

    expect(allWhatsapp()[0]!.last_notified).toBeNull();
  });

  it("omits id, so SQLite continues after the ids the Postgres copy carried over", async () => {
    // whatsappsubscriber was populated by a one-off copy from Postgres
    // (0020_whatsappsubscriber.sql), so the table already holds real sequence
    // values. Binding an id -- or a 1 -- would collide with them. `INTEGER
    // PRIMARY KEY` picks max(rowid)+1.
    seedWhatsapp({ id: 4242, phone: "+447700900099", foodbankId: SALISBURY });

    await insertWhatsappSubscriber(session, "+447700900001", SALISBURY, PY_NOW);

    expect(allWhatsapp().map((row) => row.id)).toEqual([4242, 4243]);
  });

  it("names only columns the table has -- never id, last_notified or foodbank_name", async () => {
    // The migration-0019 guard, and 0020 inherited the same decision: Django's
    // model carries a denormalised `foodbank_name` (subscribers.py:142, written
    // by its save()) and D1 deliberately does not, because a cached copy of the
    // parent's name goes stale on a rename. A query naming a dropped column
    // fails only when it actually runs -- which for this one means the first
    // real inbound "subscribe" message, in production, answered with silence.
    await insertWhatsappSubscriber(session, "+447700900001", SALISBURY, PY_NOW);

    const columns = db
      .prepare("SELECT name FROM pragma_table_info('whatsappsubscriber')")
      .all()
      .map((row) => (row as unknown as { name: string }).name);
    const written = /INSERT INTO whatsappsubscriber \(([^)]*)\)/
      .exec(sent[0]!.sql)?.[1]
      ?.split(",")
      .map((column) => column.trim());

    expect(written).toEqual(["phone_number", "foodbank_id", "created"]);
    for (const column of written!) expect(columns).toContain(column);
    expect(columns).not.toContain("foodbank_name");
  });

  it("binds the three values in the order the column list declares them", async () => {
    await insertWhatsappSubscriber(session, "+447700900001", SALISBURY, PY_NOW);

    expect(prepared).toHaveLength(1);
    // The bound list as well as the resulting row: phone_number and created are
    // adjacent TEXT columns, so a transposition still inserts cleanly and only
    // shows up as a subscriber whose number is a timestamp.
    expect(sent[0]!.params).toEqual(["+447700900001", SALISBURY, PY_NOW]);
  });

  it("stores the caller's timestamp verbatim, without reformatting it", async () => {
    // The parameter is named `createdIso`, but its only caller passes pyNow()
    // (whatsappHook.ts:153) -- Django's space-separated six-digit format, per
    // ticket #9. This layer does no formatting of its own, which means the
    // format guarantee lives entirely in the caller; if that ever changed to
    // toISOString(), nothing here would object. Asserted with a deliberately
    // ISO-shaped value to make the absence of any normalising visible.
    await insertWhatsappSubscriber(session, "+447700900001", SALISBURY, "2026-09-05T19:28:08.853Z");

    expect(allWhatsapp()[0]!.created).toBe("2026-09-05T19:28:08.853Z");
  });

  it("writes a Django-format created that sorts correctly against the migrated rows", async () => {
    // Why the format matters, executed rather than argued. D1 stores these as
    // TEXT and SQLite compares TEXT lexicographically: "T" is 0x54 and " " is
    // 0x20, so an ISO value sorts AFTER every Django value from the same day
    // whatever the real time. Migration 0022 exists to repair exactly this, and
    // it did repair whatsappsubscriber.created (0022:110-112) -- there is no second
    // repair pass, so the only thing keeping this column consistent is that
    // pyNow() keeps writing this shape.
    seedWhatsapp({ id: 1, phone: "+447700900099", foodbankId: SALISBURY, created: "2026-09-05 19:28:08.853000" });

    await insertWhatsappSubscriber(session, "+447700900001", SALISBURY, "2026-09-05 08:00:00.000000");

    const newest = plain<{ phone_number: string }>(
      db.prepare("SELECT phone_number FROM whatsappsubscriber ORDER BY created DESC LIMIT 1").get(),
    );
    expect(newest.phone_number).toBe("+447700900099");

    // The counterexample in the same engine: the ISO spelling of that 08:00
    // instant compares GREATER than the 19:28 migrated row. This inversion cost
    // 31 of 46 foodbankchange rows their place in a dashboard window during the
    // 2026-09-05 migration.
    const inverted = plain<{ wrong: number }>(
      db.prepare("SELECT ('2026-09-05T08:00:00.000Z' > '2026-09-05 19:28:08.853000') AS wrong").get(),
    );
    expect(inverted.wrong).toBe(1);
  });

  it("binds hostile input rather than interpolating it", async () => {
    // The phone number arrives from Meta's webhook, which is unauthenticated
    // input as far as this layer is concerned.
    const hostile = "+44'); DROP TABLE whatsappsubscriber;--";

    await insertWhatsappSubscriber(session, hostile, SALISBURY, PY_NOW);

    expect(allWhatsapp()[0]!.phone_number).toBe(hostile);
    expect(plain<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM whatsappsubscriber").get()).n).toBe(1);
  });

  it("resolves to undefined -- the caller gets no id back", async () => {
    // Unlike insertAdminNeed, there is no `RETURNING id` and no read of
    // last_row_id: whatsappHook.ts:153 ignores the result and replies to the
    // person. Adding one would change the round trip's shape for no reader.
    await expect(insertWhatsappSubscriber(session, "+447700900001", SALISBURY, PY_NOW)).resolves.toBeUndefined();
  });

  it("propagates a failed write instead of resolving quietly", async () => {
    // phone_number is NOT NULL (0020:33). The consumer awaits this before
    // sending "You've successfully subscribed", so a swallowed error would mean
    // a confirmation message for a subscription that does not exist. The `await`
    // on .run() -- rather than a floating promise -- is what carries the
    // rejection out to the queue handler, which retries the message.
    await expect(insertWhatsappSubscriber(session, null as unknown as string, SALISBURY, PY_NOW)).rejects.toThrow(
      /NOT NULL constraint failed: whatsappsubscriber\.phone_number/,
    );
    expect(allWhatsapp()).toEqual([]);
  });

  it("inserts against a food bank id with no row, because D1 declares no foreign key", async () => {
    // Django's FK was enforced by Postgres with ON DELETE CASCADE
    // (subscribers.py:141); D1 declares no foreign keys anywhere (PLAN.md §4.5).
    // Harmless at the only call site -- the id comes from a slug lookup that
    // just succeeded -- but it means nothing in the database guarantees these
    // rows join, and a food bank deleted in Django leaves its WhatsApp
    // subscribers behind here rather than cascading them away.
    await insertWhatsappSubscriber(session, "+447700900001", 999_999, PY_NOW);

    expect(allWhatsapp()[0]!.foodbank_id).toBe(999_999);
  });

  // SUSPECT, PINNED AS-IS, AND THE MOST CONSEQUENTIAL THING IN THIS FILE.
  //
  // 0020_whatsappsubscriber.sql:42-44 says "Django has no unique constraint
  // here ... Not enforced, deliberately, to match the source." That is wrong.
  // WhatsappSubscriber.Meta declares `unique_together = ('phone_number',
  // 'foodbank')` (givefood/models/subscribers.py:148), applied by
  // givefood/migrations/0001_initial.py's AlterUniqueTogether and backed in
  // Postgres by `givefood_whatsappsub_phone_foodbank_uniq`, created by
  // givefood/migrations/0007_missing_unique_constraints.py:43-44 -- whose own
  // header says WhatsappSubscriber "without the constraint races into duplicate
  // rows and then notifies the same device twice". The claim the migration was
  // reasoning from ("a number can legitimately appear against several different
  // food banks") is true and is NOT in tension with the constraint: the
  // constraint is on the PAIR.
  //
  // So D1 permits a state Postgres refused, and it is reachable: whatsappHook.ts
  // does find-then-insert with no transaction, so two webhook deliveries of the
  // same "subscribe" (Meta retries; so does the queue) can both find nothing and
  // both insert. The person is then notified twice per need -- billed template
  // messages -- forever.
  //
  // Not fixed here, and no failing test written for it: this file adds a test,
  // and adding a unique index is a migration. Pinned as the behaviour that
  // exists so the divergence is recorded rather than rediscovered.
  it("accepts a duplicate (phone_number, foodbank_id) pair that Postgres would have refused", async () => {
    await insertWhatsappSubscriber(session, "+447700900001", SALISBURY, PY_NOW);
    await insertWhatsappSubscriber(session, "+447700900001", SALISBURY, PY_NOW);

    expect(allWhatsapp().map((row) => row.id)).toEqual([1, 2]);

    // The index that would have stopped it is genuinely absent, not merely
    // unenforced -- asserted against the engine so that adding it later turns
    // this test red and brings someone back to this comment.
    const indexes = db
      .prepare('SELECT name, "unique" AS is_unique FROM pragma_index_list(\'whatsappsubscriber\')')
      .all()
      .map((row) => plain<{ name: string; is_unique: number }>(row));
    expect(indexes).toEqual([{ name: "whatsappsubscriber_foodbank_idx", is_unique: 0 }]);
  });
});

// ===========================================================================
// deleteWhatsappSubscriber
// ===========================================================================

describe("deleteWhatsappSubscriber", () => {
  beforeEach(() => {
    seedWhatsapp({ id: 10, phone: "+447700900001", foodbankId: SALISBURY });
    seedWhatsapp({ id: 11, phone: "+447700900001", foodbankId: DEVIZES });
    seedWhatsapp({ id: 12, phone: "+447700900002", foodbankId: SALISBURY });
  });

  it("deletes the pair's row and reports one", async () => {
    // views.py:1463's `subscription.delete()`. The count is what lets
    // whatsappHook.ts:197 choose between "You've been unsubscribed" and "You
    // weren't subscribed" -- so a delete that reported the wrong number would
    // tell somebody they are still subscribed when they are not.
    expect(await deleteWhatsappSubscriber(session, "+447700900001", SALISBURY)).toBe(1);
    expect(allWhatsapp().map((row) => row.id)).toEqual([11, 12]);
  });

  it("leaves the SAME NUMBER's other food banks alone", async () => {
    // The single most damaging thing a dropped predicate could do on this path.
    // One production number is subscribed to 10 food banks
    // (0020_whatsappsubscriber.sql:42-44); "unsubscribe salisbury" removing all
    // ten would look, to the person, exactly like a working unsubscribe -- they
    // would only find out months later when nothing ever arrives again, and
    // there is no record of what they had been subscribed to.
    await deleteWhatsappSubscriber(session, "+447700900001", SALISBURY);

    expect(allWhatsapp().map((row) => plain(row))).toEqual([
      expect.objectContaining({ id: 11, phone_number: "+447700900001", foodbank_id: DEVIZES }),
      expect.objectContaining({ id: 12, phone_number: "+447700900002", foodbank_id: SALISBURY }),
    ]);
  });

  it("leaves other numbers subscribed to the same food bank alone", async () => {
    await deleteWhatsappSubscriber(session, "+447700900002", SALISBURY);

    expect(allWhatsapp().map((row) => row.id)).toEqual([10, 11]);
  });

  it("returns 0 when the pair was never subscribed", async () => {
    // Not an error: views.py:1468-1472 catches DoesNotExist and replies "You
    // weren't subscribed to X Foodbank." 0 is that reply.
    expect(await deleteWhatsappSubscriber(session, "+447700900009", SALISBURY)).toBe(0);
    expect(allWhatsapp()).toHaveLength(3);
  });

  it("deletes EVERY row for the pair, not one", async () => {
    // The deliberate divergence whatsappHook.ts:179-195 documents at length.
    // Django's `.get()` would raise MultipleObjectsReturned on a duplicate,
    // uncaught, returning a 500 to Meta -- which de-registers a webhook that
    // stops answering 200, taking the unsubscribe command down for everybody.
    // (In Django the duplicate could not actually arise, because Postgres has
    // the unique index the insert tests above describe; in D1 it can, which is
    // what makes this defence load-bearing HERE rather than merely careful.)
    seedWhatsapp({ id: 13, phone: "+447700900001", foodbankId: SALISBURY });

    expect(await deleteWhatsappSubscriber(session, "+447700900001", SALISBURY)).toBe(2);
    expect(allWhatsapp().map((row) => row.id)).toEqual([11, 12]);
  });

  it("compares the phone number exactly", async () => {
    // Same reasoning as findWhatsappSubscriber: normaliseFrom() has already
    // added the "+", and a match that ignored it would unsubscribe a row the
    // person did not name.
    expect(await deleteWhatsappSubscriber(session, "447700900001", SALISBURY)).toBe(0);
    expect(allWhatsapp()).toHaveLength(3);
  });

  it("unsubscribes a subscriber whose created is NULL and who has already been notified", async () => {
    // The same nullable-column hole on the unsubscribe path, where it is worse
    // still: a predicate that excluded this row (`AND created IS NOT NULL`, or
    // an `AND last_notified IS NULL` meaning "only the ones we have not messaged
    // yet") deletes nothing, returns 0, and whatsappHook.ts:197 replies "You
    // weren't subscribed" -- to somebody who is, who has just asked to stop, and
    // whose only way to stop is this command. The messages keep arriving and the
    // reply says they are not coming.
    seedWhatsapp({ id: 13, phone: "+447700900003", foodbankId: SALISBURY, created: null, lastNotified: "2026-08-20 10:00:00.000000" });
    expect(plain<WhatsappRow>(allWhatsapp().find((row) => row.id === 13))).toMatchObject({
      created: null,
      last_notified: "2026-08-20 10:00:00.000000",
    });

    expect(await deleteWhatsappSubscriber(session, "+447700900003", SALISBURY)).toBe(1);
    expect(allWhatsapp().map((row) => row.id)).toEqual([10, 11, 12]);
  });

  it("spends one round trip, binding phone then food bank", async () => {
    await deleteWhatsappSubscriber(session, "+447700900001", SALISBURY);

    expect(prepared).toHaveLength(1);
    expect(sent[0]!.params).toEqual(["+447700900001", SALISBURY]);
  });
});

// ===========================================================================
// setWhatsappLastNotified
// ===========================================================================

describe("setWhatsappLastNotified", () => {
  const PY_NOW = "2026-09-05 19:28:08.853000";

  beforeEach(() => {
    seedWhatsapp({ id: 1, phone: "+447700900001", foodbankId: SALISBURY });
    seedWhatsapp({ id: 2, phone: "+447700900002", foodbankId: SALISBURY });
    seedWhatsapp({ id: 3, phone: "+447700900003", foodbankId: SALISBURY });
    seedWhatsapp({ id: 4, phone: "+447700900004", foodbankId: DEVIZES });
  });

  const lastNotified = (): (string | null)[] => allWhatsapp().map((row) => row.last_notified);

  it("stamps exactly the ids it was given and no others", async () => {
    // notifications.py:650-654 stamps last_notified only inside `if success:`.
    // The consumer therefore collects ids as it goes (needWhatsApp.ts:70-76)
    // rather than updating the page, and this statement must respect that: a
    // mutant that updated every row for the food bank would record a send for
    // the subscribers whose message FAILED, which is the one thing this column
    // is meant to be evidence of.
    await setWhatsappLastNotified(session, [1, 3], PY_NOW);

    expect(lastNotified()).toEqual([PY_NOW, null, PY_NOW, null]);
  });

  it("binds the timestamp FIRST and the ids after it", async () => {
    await setWhatsappLastNotified(session, [1, 3], PY_NOW);

    expect(sent[0]!.sql).toBe("UPDATE whatsappsubscriber SET last_notified = ? WHERE id IN (?, ?)");
    // The `?` for SET comes before the IN list's placeholders, so `nowIso` must
    // be spread FIRST. Get the order wrong and the statement still runs: it
    // sets last_notified to the number 1 and looks for ids "3" and the
    // timestamp -- matching nothing, changing nothing, raising nothing. The
    // page would silently record no sends at all. Asserted on the bound list
    // rather than only on the resulting rows, because "nothing changed" is
    // indistinguishable from "there was nothing to change".
    expect(sent[0]!.params).toEqual([PY_NOW, 1, 3]);
  });

  it("does not touch the database at all when no send succeeded", async () => {
    // needWhatsApp.ts:76 guards this itself (`if (notified.length > 0)`), so
    // the early return is the second of two belts -- but it is the one that
    // survives a refactor of the consumer. As with the web push delete, SQLite
    // would accept `IN ()` and change nothing, so only the round-trip counter
    // can tell the guard is still there.
    await setWhatsappLastNotified(session, [], PY_NOW);

    expect(prepared).toEqual([]);
    expect(lastNotified()).toEqual([null, null, null, null]);
  });

  it("overwrites an existing last_notified rather than only filling blanks", async () => {
    // Every need re-stamps every subscriber who received it. A `WHERE
    // last_notified IS NULL` added as an optimisation would freeze the column
    // at each subscriber's first-ever notification.
    seedWhatsapp({ id: 5, phone: "+447700900005", foodbankId: SALISBURY, lastNotified: "2026-01-01 00:00:00.000000" });

    await setWhatsappLastNotified(session, [5], PY_NOW);

    expect(allWhatsapp().find((row) => row.id === 5)!.last_notified).toBe(PY_NOW);
  });

  it("is not scoped to a food bank -- the ids are trusted as given", async () => {
    // Same property as the web push delete, and pinned for the same reason: the
    // ids always come from getWhatsappSubscribersPage, which already scoped
    // them. Nothing in the statement re-checks that, so id 4 (Devizes) is
    // stamped when named.
    await setWhatsappLastNotified(session, [4], PY_NOW);

    expect(lastNotified()).toEqual([null, null, null, PY_NOW]);
  });

  it("stores the timestamp verbatim, in the format that sorts against migrated rows", async () => {
    // Migration 0022 repaired two ISO-shaped values in this very column
    // (0022:114-116) after the port wrote them. There is no third repair pass,
    // so the format is only as good as pyNow() at the call site -- this layer
    // reformats nothing. The assertion is the shape 0022's own detector looks
    // for, inverted: after a correct write, it matches nothing.
    await setWhatsappLastNotified(session, [1], PY_NOW);

    expect(allWhatsapp()[0]!.last_notified).toBe(PY_NOW);
    const isoShaped = plain<{ n: number }>(
      db.prepare("SELECT COUNT(*) AS n FROM whatsappsubscriber WHERE last_notified LIKE '____-__-__%Z'").get(),
    );
    expect(isoShaped.n).toBe(0);
  });

  it("resolves to undefined", async () => {
    await expect(setWhatsappLastNotified(session, [1], PY_NOW)).resolves.toBeUndefined();
  });

  describe("D1's 100-bound-parameter statement limit", () => {
    beforeEach(() => {
      db.exec("DELETE FROM whatsappsubscriber");
      for (let id = 1; id <= 101; id++) {
        seedWhatsapp({ id, phone: `+4477009${String(id).padStart(5, "0")}`, foodbankId: SALISBURY });
      }
    });

    // SUSPECT, PINNED AS-IS. The module's comment says this takes ids in bulk
    // for the "same 100-parameter cap reasoning as the delete above" -- but this
    // statement binds the TIMESTAMP as well, so its arity is ids.length + 1. The
    // delete's cap is reached at 100 ids; this one's is reached at 99. Ninety-
    // nine ids is 100 parameters and fits; 100 ids is 101 and D1 would reject
    // the whole statement with "too many SQL variables", which in the consumer
    // means the page's successful sends go unrecorded (and, since the delete
    // beside it would still have fitted, the two functions would fail at
    // different list lengths).
    //
    // Unreachable today -- PAGE_SIZE is 25 (needWhatsApp.ts:26) -- and node:sqlite's
    // own limit is 32766, so the engine here runs both happily. Asserted on the
    // ARITY rather than on a throw, because a throw is the wish, not the behaviour.
    it("fits inside the cap at 99 ids: 99 placeholders plus the timestamp is exactly 100", async () => {
      const ids = Array.from({ length: 99 }, (_, i) => i + 1);

      await setWhatsappLastNotified(session, ids, PY_NOW);

      expect(sent[0]!.params).toHaveLength(100);
      expect((sent[0]!.sql.match(/\?/g) ?? []).length).toBe(100);
      expect(allWhatsapp().filter((row) => row.last_notified === PY_NOW)).toHaveLength(99);
    });

    it("builds a 101-parameter statement for 100 ids -- one over D1's cap, and it does not chunk", async () => {
      const ids = Array.from({ length: 100 }, (_, i) => i + 1);

      await setWhatsappLastNotified(session, ids, PY_NOW);

      expect(prepared).toHaveLength(1);
      expect(sent[0]!.params).toHaveLength(101);
      expect(sent[0]!.params[0]).toBe(PY_NOW);
    });
  });
});
