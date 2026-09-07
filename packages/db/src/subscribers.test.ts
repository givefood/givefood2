import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmSubscriber,
  deleteMobileSubscriber,
  deleteSubscriberById,
  deleteWebpushSubscription,
  findMobileSubscriber,
  getConfirmedSubscribersPage,
  getSubscriberByEmailAndFoodbank,
  getSubscriberBySubKey,
  getSubscriberByUnsubKey,
  insertSubscriber,
  upsertMobileSubscriber,
  upsertWebpushSubscription,
} from "./subscribers";
import type { Session } from "./types";

// WP 3.7's write side: the public double opt-in email flow
// (gfwfbn/views.py:1101-1224 `updates`), web push subscribe/unsubscribe
// (gfwfbn/views.py `webpush_subscribe`/`webpush_unsubscribe`), the shipped
// native app's mobsub contract (gfwfbn/views.py:1355-1414), and the
// newsletter fan-out's recipient page (gfadmin/views.py:1994's
// `FoodbankSubscriber.objects.filter(foodbank=foodbank, confirmed=True)`).
//
// WHY THIS FILE RUNS A REAL DATABASE. Every function in this module is one
// or two SQL statements and nothing else, and EVERY way they can be wrong is
// silent -- there is no 500 and no log line, only the wrong rows:
//
//   * a dropped `foodbank_id` predicate in getSubscriberByEmailAndFoodbank
//     tells a genuinely-new subscriber they are already subscribed, and they
//     never get a confirmation email at all;
//   * sub_key and unsub_key are adjacent opaque 16-hex columns, so a lookup
//     that reads the wrong one confirms nobody and unsubscribes the person
//     who clicked "confirm";
//   * `confirmed = 1` missing from the fan-out page mails everyone who ever
//     typed their address into the box and never clicked the link, which is
//     the entire point of double opt-in;
//   * `id >= ?` instead of `id > ?` re-mails the last subscriber of every
//     page for ever;
//   * `donationpoint_id = ?` instead of `IS ?` never matches a NULL, so
//     every re-registration from the (very common) no-donation-point case
//     inserts another duplicate row instead of updating the existing one --
//     and the app reports success either way.
//
// A session that hands back canned rows agrees with all of those. So the
// fixture below is Node's own SQLite running the module's real statements.
//
// THE SCHEMA IS THE MIGRATION FILES THEMSELVES, applied in order, not a
// transcribed CREATE TABLE -- the convention adminSubscribers.test.ts and
// notifySubscribers.test.ts already follow, for the reason migration 0019
// taught this package: it dropped `foodbank_name` off six tables and four
// queries elsewhere went on naming a column that no longer existed,
// silently, until /dashboard/beautybanks/ was measured and found to be a
// live 500. A hand-copied schema in a test file is a second copy of the
// truth and drifts exactly the same way. Three details of the real schema
// are load-bearing below:
//
//   * `foodbanksubscriber.foodbank_name` is GONE (0019:59) and comes back
//     only through foodbanksubscriber_full's LEFT JOIN (0019:101-104) --
//     which is what all three subscriber reads select from;
//   * sub_key_idx and unsub_key_idx are UNIQUE but SEPARATE (0004:27-28), so
//     one string can legitimately be one row's sub_key and another row's
//     unsub_key -- that is what makes the column-swap mutant killable;
//   * mobilesubscriber has NO unique index on the triple (0004:39-45), by
//     deliberate decision, so duplicates are reachable and the behaviour
//     when they exist is a real question rather than an impossible one.

type Bindable = null | number | bigint | string | Uint8Array;

interface Sent {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API this module uses -- prepare().bind() then
// .first() / .all() / .run() -- backed by node:sqlite. Deliberately dumb: it
// forwards the SQL untouched so the ENGINE decides which rows come back and
// in what order. Interpreting the SQL here would make these tests assert
// against a second implementation of SQLite rather than against the module.
//
// `meta.last_row_id` and `meta.changes` are mapped from node:sqlite's
// `lastInsertRowid`/`changes` because three functions return values derived
// from them -- insertSubscriber's new id, and the two deletes' booleans.
// Number(), because node:sqlite can hand back a BigInt and `insertSubscriber`
// is typed `Promise<number>`.
//
// `prepared` and `sent` are kept apart on purpose: `prepared` counts round
// trips (how upsertWebpushSubscription's SELECT-then-write is shown to be
// two statements and not one), while `sent` carries the bound parameter
// list, which is how a statement's ARITY can be asserted -- something no
// assertion on the resulting rows could ever reveal.
function d1Session(db: DatabaseSync): { session: Session; prepared: string[]; sent: Sent[] } {
  const prepared: string[] = [];
  const sent: Sent[] = [];

  function statement(sql: string, params: Bindable[]) {
    const record = () => sent.push({ sql, params });
    return {
      // bind() returns a NEW statement rather than mutating this one,
      // matching D1's immutable prepared statements.
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

// Two food banks in every fixture, because almost every failure this file
// exists to catch is a statement that ignores its foodbank_id argument -- and
// a fixture holding one food bank passes those exactly as happily as a
// correct implementation does.
const SALISBURY = 7;
const DEVIZES = 12;

// A food bank id no `foodbank` row has. D1 has no foreign keys (PLAN.md
// §4.5) and 0004 declares none, so a subscriber can genuinely point at
// nothing -- which is the case foodbanksubscriber_full's LEFT JOIN exists to
// survive.
const ORPHANED_FB = 4242;

// Django's sub_key/unsub_key are `sha256(...).hexdigest()[:16]`
// (models/subscribers.py:54-55). Shaped like the real thing, and
// deliberately unlike each other, so a value landing in the wrong column is
// visible rather than plausible.
const KEYS = {
  adaSub: "3f7a1c9e2b4d6081",
  adaUnsub: "a1b2c3d4e5f60718",
  graceSub: "9e8d7c6b5a493827",
  graceUnsub: "0f1e2d3c4b5a6978",
};

let db: DatabaseSync;
let session: Session;
let prepared: string[];
let sent: Sent[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seedFoodbank(SALISBURY, { name: "Salisbury", slug: "salisbury" });
  seedFoodbank(DEVIZES, { name: "Devizes", slug: "devizes" });
  ({ session, prepared, sent } = d1Session(db));
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

// Every NOT NULL column 0001_core.sql declares on `foodbank`, filled with
// whatever satisfies it. Only `name` and `slug` are ever read here, by
// foodbanksubscriber_full's join -- spelt out in full rather than trimmed to
// the interesting two because it is the real DDL the fixture applies, and a
// shorter INSERT simply will not run.
function seedFoodbank(id: number, fields: { name: string; slug: string }): void {
  db.prepare(
    "INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, charity_just_foodbank, " +
      "contact_email, url, shopping_list_url, address_is_administrative, is_closed, no_locations, days_between_needs, " +
      "created, modified) " +
      "VALUES (?, ?, ?, ?, '1 High St', 'SP1 1AA', 'England', '51.0688,-1.7945', 1, 'info@example.org', " +
      "'https://example.org/', 'https://example.org/list/', 0, 0, 0, 14, " +
      "'2020-01-01 00:00:00.000000', '2026-09-05 19:28:08.853000')",
  ).run(id, `uuid-${fields.slug}`, fields.name, fields.slug);
}

// A row that reached the table by some route other than insertSubscriber --
// the one-off Postgres copy, or the admin's bulk add. `created` defaults to
// the space-separated microsecond format the ETL wrote
// (tools/pg-to-d1/extract_core.py), which is what the timestamp assertions
// below compare against.
function seedSubscriber(row: {
  id?: number;
  foodbankId: number;
  email: string;
  confirmed: number;
  subKey: string;
  unsubKey: string;
  created?: string;
  lastContacted?: string | null;
}): void {
  db.prepare(
    "INSERT INTO foodbanksubscriber (id, created, last_contacted, foodbank_id, email, confirmed, sub_key, unsub_key) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.id ?? null,
    row.created ?? "2026-09-05 19:28:08.853000",
    row.lastContacted ?? null,
    row.foodbankId,
    row.email,
    row.confirmed,
    row.subKey,
    row.unsubKey,
  );
}

function seedWebPush(row: {
  id: number;
  foodbankId: number;
  endpoint: string;
  p256dh?: string;
  auth?: string;
  browser?: string | null;
  created?: string;
}): void {
  db.prepare(
    "INSERT INTO webpushsubscription (id, created, foodbank_id, endpoint, p256dh, auth, browser) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.id,
    row.created ?? "2026-08-01 09:00:00.000000",
    row.foodbankId,
    row.endpoint,
    row.p256dh ?? `p256dh-${row.id}`,
    row.auth ?? `auth-${row.id}`,
    row.browser ?? "Firefox",
  );
}

// donationpoint_id is a bare INTEGER with no foreign key (D1 has none), so
// these are plain ids rather than seeded donation point rows -- nothing in
// this module joins to foodbankdonationpoint.
function seedMobile(row: {
  id: number;
  deviceId: string;
  foodbankId: number;
  donationpointId?: number | null;
  platform?: string;
  created?: string;
  timezone?: string | null;
  locale?: string | null;
  appVersion?: string | null;
  osVersion?: string | null;
  deviceModel?: string | null;
  subType?: string | null;
}): void {
  db.prepare(
    "INSERT INTO mobilesubscriber (id, created, device_id, platform, timezone, locale, app_version, os_version, " +
      "device_model, sub_type, foodbank_id, donationpoint_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.id,
    row.created ?? "2026-08-01 09:00:00.000000",
    row.deviceId,
    row.platform ?? "ios",
    row.timezone ?? "Europe/London",
    row.locale ?? "en-GB",
    row.appVersion ?? "1.0.0",
    row.osVersion ?? "18.1",
    row.deviceModel ?? "iPhone15,2",
    row.subType ?? "need",
    row.foodbankId,
    row.donationpointId ?? null,
  );
}

// node:sqlite hands back null-prototype rows; toEqual against those reads
// badly, so anything asserted structurally goes through this first.
const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

interface SubscriberTableRow {
  id: number;
  created: string;
  last_contacted: string | null;
  foodbank_id: number;
  email: string;
  confirmed: number;
  sub_key: string;
  unsub_key: string;
}

interface WebPushTableRow {
  id: number;
  created: string;
  foodbank_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  browser: string | null;
}

interface MobileTableRow {
  id: number;
  created: string;
  device_id: string;
  platform: string;
  timezone: string | null;
  locale: string | null;
  app_version: string | null;
  os_version: string | null;
  device_model: string | null;
  sub_type: string | null;
  foodbank_id: number;
  donationpoint_id: number | null;
}

const allSubscribers = (): SubscriberTableRow[] =>
  db
    .prepare("SELECT * FROM foodbanksubscriber ORDER BY id")
    .all()
    .map((row) => plain<SubscriberTableRow>(row));

const allWebPush = (): WebPushTableRow[] =>
  db
    .prepare("SELECT * FROM webpushsubscription ORDER BY id")
    .all()
    .map((row) => plain<WebPushTableRow>(row));

const allMobile = (): MobileTableRow[] =>
  db
    .prepare("SELECT * FROM mobilesubscriber ORDER BY id")
    .all()
    .map((row) => plain<MobileTableRow>(row));

// ===========================================================================
// getSubscriberByEmailAndFoodbank -- the subscribe path's dupe pre-check
// ===========================================================================

describe("getSubscriberByEmailAndFoodbank", () => {
  beforeEach(() => {
    seedSubscriber({ foodbankId: SALISBURY, email: "ada@example.org", confirmed: 1, subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });
  });

  it("returns the matching row, mapped, with confirmed as a real boolean", async () => {
    const row = await getSubscriberByEmailAndFoodbank(session, "ada@example.org", SALISBURY);

    // The whole row, not a shape check. `confirmed` is INTEGER 1 in storage
    // and `true` here because coerceBooleans runs over it -- and
    // routes/wfbn/updates.ts:176 branches on `!sub.confirmed`, where a raw 0
    // would be falsy but a raw 1 and a `true` are indistinguishable. The
    // interesting half is therefore the 0 case, asserted below.
    expect(row).toEqual({
      id: 1,
      created: "2026-09-05 19:28:08.853000",
      last_contacted: null,
      foodbank_id: SALISBURY,
      email: "ada@example.org",
      confirmed: true,
      sub_key: KEYS.adaSub,
      unsub_key: KEYS.adaUnsub,
      // Not declared on FoodbankSubscriberRow, but really present: the read
      // is `SELECT *` from foodbanksubscriber_full, and the view adds BOTH
      // joined columns (0019:102). Pinned rather than trimmed because
      // toEqual would otherwise fail on it, and because the interface
      // quietly under-describing the row is exactly the kind of drift these
      // tests are here to make visible.
      foodbank_slug: "salisbury",
      foodbank_name: "Salisbury",
    });
  });

  it("maps an unconfirmed row's confirmed to false, not 0", async () => {
    seedSubscriber({ foodbankId: DEVIZES, email: "grace@example.org", confirmed: 0, subKey: KEYS.graceSub, unsubKey: KEYS.graceUnsub });

    const row = await getSubscriberByEmailAndFoodbank(session, "grace@example.org", DEVIZES);
    // `=== false`, not `toBeFalsy()`: 0 is falsy too, and the point of
    // coerceBooleans is that the DB layer never hands 0/1 to a caller.
    expect(row?.confirmed).toBe(false);
  });

  it("returns null when nobody with that address subscribes to that food bank", async () => {
    expect(await getSubscriberByEmailAndFoodbank(session, "nobody@example.org", SALISBURY)).toBeNull();
  });

  // THE MUTANT THIS KILLS: a statement that drops the foodbank_id predicate.
  // sub_email_fb_uniq is UNIQUE(email, foodbank_id) (0004:25), matching
  // Django's unique_together('email','foodbank') -- one person subscribing to
  // two food banks is ordinary and must stay possible. Without the second
  // predicate this returns Salisbury's row for a Devizes signup, the route
  // says "already subscribed to that food bank" (updates.ts:129), and the
  // person never receives a confirmation email at all. Nothing raises.
  it("is scoped to the food bank: the same address elsewhere is not a dupe", async () => {
    expect(await getSubscriberByEmailAndFoodbank(session, "ada@example.org", DEVIZES)).toBeNull();
  });

  // The mirror image: a statement that dropped the EMAIL predicate and kept
  // only foodbank_id would return somebody else's row and block every new
  // subscriber to a food bank that already has one.
  it("is scoped to the address: a different subscriber to the same food bank is not a dupe", async () => {
    seedSubscriber({ foodbankId: SALISBURY, email: "grace@example.org", confirmed: 1, subKey: KEYS.graceSub, unsubKey: KEYS.graceUnsub });

    const row = await getSubscriberByEmailAndFoodbank(session, "grace@example.org", SALISBURY);
    expect(row?.email).toBe("grace@example.org");
    expect(row?.id).toBe(2);
  });

  // The module's own header says callers must pass an already-lowercased
  // address, because Django lowercased in FoodbankSubscriber.save()
  // (models/subscribers.py:42) BEFORE unique_together ever saw the value.
  // SQLite's default collation is BINARY, so this comparison really is
  // case-sensitive and the guarantee lives entirely in the caller
  // (routes/wfbn/updates.ts:125 does the .toLowerCase()). Executed here, not
  // taken on trust: "restoring parity" by lowercasing inside this function
  // would ALSO have to lowercase in insertSubscriber, or the pre-check and
  // the stored row would disagree.
  it("does not fold case, so a mixed-case address misses an existing lowercase row", async () => {
    expect(await getSubscriberByEmailAndFoodbank(session, "Ada@Example.org", SALISBURY)).toBeNull();
  });

  // LEFT JOIN, not JOIN (0019:28-32). D1 has no foreign keys, so a
  // subscriber whose food bank row is missing is representable -- and an
  // inner join would make that subscriber invisible to the dupe check, to
  // confirm and to unsubscribe alike. They would be unable to subscribe
  // (UNIQUE violation on an insert the pre-check said was safe) and unable
  // to leave (a 404 on their own unsubscribe link).
  it("still finds a subscriber whose food bank row is missing, with a null foodbank_name", async () => {
    seedSubscriber({ foodbankId: ORPHANED_FB, email: "orphan@example.org", confirmed: 1, subKey: "1111222233334444", unsubKey: "5555666677778888" });

    const row = await getSubscriberByEmailAndFoodbank(session, "orphan@example.org", ORPHANED_FB);
    expect(row?.id).toBe(2);
    expect(row?.foodbank_name).toBeNull();
  });

  // foodbank_name is a LIVE join, not the denormalised copy Django's
  // save() wrote (models/subscribers.py:58-59) and 0019:59 deleted. Renaming
  // the food bank changes what this read returns with no subscriber row
  // touched -- which is the entire point of the migration, and the thing a
  // "restore the column for parity" change would undo.
  it("reads foodbank_name live from the parent rather than from a stored copy", async () => {
    db.prepare("UPDATE foodbank SET name = ? WHERE id = ?").run("Salisbury & District", SALISBURY);

    const row = await getSubscriberByEmailAndFoodbank(session, "ada@example.org", SALISBURY);
    expect(row?.foodbank_name).toBe("Salisbury & District");
    // And the base table genuinely has nowhere to have cached it.
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('foodbanksubscriber')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).not.toContain("foodbank_name");
  });
});

// ===========================================================================
// getSubscriberBySubKey / getSubscriberByUnsubKey
// ===========================================================================

describe("getSubscriberBySubKey and getSubscriberByUnsubKey", () => {
  beforeEach(() => {
    seedSubscriber({ foodbankId: SALISBURY, email: "ada@example.org", confirmed: 0, subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });
    seedSubscriber({ foodbankId: DEVIZES, email: "grace@example.org", confirmed: 1, subKey: KEYS.graceSub, unsubKey: KEYS.graceUnsub });
  });

  it("finds the pending subscriber by their sub_key", async () => {
    const row = await getSubscriberBySubKey(session, KEYS.adaSub);
    expect(row?.email).toBe("ada@example.org");
    expect(row?.confirmed).toBe(false);
  });

  it("finds the subscriber by their unsub_key", async () => {
    const row = await getSubscriberByUnsubKey(session, KEYS.graceUnsub);
    expect(row?.email).toBe("grace@example.org");
  });

  it("returns null for a key nobody holds", async () => {
    expect(await getSubscriberBySubKey(session, "deadbeefdeadbeef")).toBeNull();
    expect(await getSubscriberByUnsubKey(session, "deadbeefdeadbeef")).toBeNull();
  });

  // THE COLUMN-SWAP MUTANT, and the reason it needs a purpose-built fixture.
  // Both keys are opaque 16-hex strings living in adjacent TEXT columns, so
  // `WHERE sub_key = ?` and `WHERE unsub_key = ?` are indistinguishable in
  // any fixture where no value appears in both columns -- every earlier test
  // in this describe would pass with the two functions' statements swapped.
  //
  // sub_key_idx and unsub_key_idx are separate UNIQUE indexes (0004:27-28),
  // never a shared one, so ONE string being row 3's sub_key and row 4's
  // unsub_key is legal. With that seeded, a swap is fatal: confirming with
  // Boudicca's link would confirm Cleopatra, and clicking Cleopatra's
  // one-click unsubscribe would delete Boudicca instead.
  it("reads its own column: one string can be one row's sub_key and another row's unsub_key", async () => {
    const SHARED = "c0ffee1234567890";
    seedSubscriber({ foodbankId: SALISBURY, email: "boudicca@example.org", confirmed: 0, subKey: SHARED, unsubKey: "aaaa111122223333" });
    seedSubscriber({ foodbankId: SALISBURY, email: "cleopatra@example.org", confirmed: 1, subKey: "bbbb444455556666", unsubKey: SHARED });

    expect((await getSubscriberBySubKey(session, SHARED))?.email).toBe("boudicca@example.org");
    expect((await getSubscriberByUnsubKey(session, SHARED))?.email).toBe("cleopatra@example.org");
  });

  // Parity, pinned deliberately. Django's confirm action is
  // `get_object_or_404(FoodbankSubscriber, sub_key=key)` -- the key alone,
  // never scoped by the food bank whose page the link was opened on
  // (gfwfbn/views.py:1157). So a valid key confirms its own subscription
  // even when presented under another food bank's URL, and the port does the
  // same. Adding a foodbank predicate here would look like a hardening and
  // would in fact 404 real confirmation links, because the email's link is
  // built from the subscriber's own food bank slug and nothing guarantees
  // the two agree after a slug redirect.
  it("looks up by key alone, unscoped by food bank, exactly as Django does", async () => {
    // grace subscribes to DEVIZES; the key still resolves with no food bank
    // context supplied at all.
    const row = await getSubscriberBySubKey(session, KEYS.graceSub);
    expect(row?.foodbank_id).toBe(DEVIZES);
  });

  it("carries unsub_key and foodbank_name through the view for the confirm/unsubscribe pages", async () => {
    const row = await getSubscriberBySubKey(session, KEYS.adaSub);
    expect(row?.unsub_key).toBe(KEYS.adaUnsub);
    expect(row?.foodbank_name).toBe("Salisbury");
  });

  // The unsub side asserted as a WHOLE ROW, because until this existed every
  // other test of getSubscriberByUnsubKey read `email` and nothing else --
  // and two mutants walked straight through the lot of them:
  //
  //   * dropping mapSubscriberRow (`return row as FoodbankSubscriberRow`), so
  //     `confirmed` comes back as the raw INTEGER 1 instead of `true`. Its
  //     sub_key twin is killed by the `toBe(false)` above; this one had
  //     nothing;
  //   * `FROM foodbanksubscriber` instead of foodbanksubscriber_full, so
  //     foodbank_name and foodbank_slug are absent entirely -- `undefined`,
  //     which is not something a `?.foodbank_name` check anywhere would flag.
  //
  // routes/wfbn/updates.ts:210 currently reads only `sub.id` off this, which
  // is the reason to pin it rather than a reason not to: the three lookups
  // are declared to return one shape, and the hole stays invisible until the
  // first template renders a food bank's name on an unsubscribe page.
  it("returns the same fully-mapped, view-joined row the email lookup does", async () => {
    expect(await getSubscriberByUnsubKey(session, KEYS.graceUnsub)).toEqual({
      id: 2,
      created: "2026-09-05 19:28:08.853000",
      last_contacted: null,
      foodbank_id: DEVIZES,
      email: "grace@example.org",
      confirmed: true,
      sub_key: KEYS.graceSub,
      unsub_key: KEYS.graceUnsub,
      foodbank_slug: "devizes",
      foodbank_name: "Devizes",
    });
  });

  // THE MUTANT: `sub_key LIKE ?` / `unsub_key LIKE ?` in place of `= ?`.
  // Every other test in this describe passes with it, because a hex digest
  // contains no `%` or `_` to act as a wildcard and every fixture key is
  // already lowercase. What separates the two operators is case: SQLite's
  // LIKE folds ASCII, `=` under the default BINARY collation does not -- and
  // sub_key_idx/unsub_key_idx are UNIQUE under that same BINARY collation, so
  // "3F7A…" and "3f7a…" are two rows the index would happily hold at once
  // and LIKE would resolve to whichever the scan reached first. The same
  // argument the email test above makes, on the two columns where the value
  // is a bearer token rather than an address.
  it("compares keys byte-exactly, so a case-shifted key resolves to nobody", async () => {
    expect(await getSubscriberBySubKey(session, KEYS.adaSub.toUpperCase())).toBeNull();
    expect(await getSubscriberByUnsubKey(session, KEYS.graceUnsub.toUpperCase())).toBeNull();
  });

  // Same LEFT JOIN argument as above, restated for the two key lookups
  // because they are the ones on the unsubscribe path: an orphaned
  // subscriber who cannot unsubscribe is a deliverability problem, not just
  // a 404.
  it("still resolves a key belonging to a subscriber whose food bank row is missing", async () => {
    seedSubscriber({ foodbankId: ORPHANED_FB, email: "orphan@example.org", confirmed: 1, subKey: "1111222233334444", unsubKey: "5555666677778888" });

    expect((await getSubscriberByUnsubKey(session, "5555666677778888"))?.email).toBe("orphan@example.org");
  });
});

// ===========================================================================
// insertSubscriber
// ===========================================================================

describe("insertSubscriber", () => {
  it("writes one row with each value in its own column and confirmed hard-coded to 0", async () => {
    const id = await insertSubscriber(session, {
      foodbankId: SALISBURY,
      email: "ada@example.org",
      subKey: KEYS.adaSub,
      unsubKey: KEYS.adaUnsub,
    });

    expect(id).toBe(1);
    const rows = allSubscribers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      foodbank_id: SALISBURY,
      email: "ada@example.org",
      // The literal 0 is the double opt-in itself. Flip it to 1 and every
      // address that was merely typed into the box starts receiving the
      // newsletter without ever having clicked the confirmation link -- the
      // rows look identical in the admin, nothing raises, and the only
      // symptom is spam complaints. (adminSubscribers.ts is the deliberate
      // escape hatch that writes 1; this one must not be.)
      confirmed: 0,
      sub_key: KEYS.adaSub,
      unsub_key: KEYS.adaUnsub,
      // Django's field is editable=False, null=True and only the newsletter
      // send writes it (models/subscribers.py:18). A brand-new subscriber
      // marked as already contacted would be skipped by whatever next reads
      // it.
      last_contacted: null,
    });
  });

  // The double opt-in stated end to end, across the two functions that
  // implement it: a brand-new subscriber is invisible to the fan-out until
  // confirmSubscriber has run. Asserted here as well as on the stored column
  // because the two halves live in different describes and a `confirmed`
  // literal of 1 in the INSERT would look perfectly reasonable in isolation
  // -- adminSubscribers.ts's bulk add really does write 1, deliberately.
  it("leaves the new subscriber out of the newsletter until they confirm", async () => {
    const id = await insertSubscriber(session, { foodbankId: SALISBURY, email: "ada@example.org", subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });

    expect(await getConfirmedSubscribersPage(session, SALISBURY, 0, 25)).toEqual([]);

    await confirmSubscriber(session, id);
    expect((await getConfirmedSubscribersPage(session, SALISBURY, 0, 25)).map((row) => row.email)).toEqual(["ada@example.org"]);
  });

  // sub_key and unsub_key are the two adjacent opaque columns again, and here
  // it is the BINDING order rather than a WHERE clause. Transposed, the
  // confirmation email's link would unsubscribe the person the moment they
  // clicked it and the unsubscribe link in every later newsletter would 404.
  // Nothing about the stored row would look wrong.
  it("does not transpose sub_key and unsub_key", async () => {
    await insertSubscriber(session, { foodbankId: SALISBURY, email: "ada@example.org", subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });

    // Read back through the same lookups the confirm/unsubscribe routes use,
    // so this asserts the round trip rather than the column order twice.
    expect((await getSubscriberBySubKey(session, KEYS.adaSub))?.email).toBe("ada@example.org");
    expect(await getSubscriberBySubKey(session, KEYS.adaUnsub)).toBeNull();
  });

  it("returns the new row's id, which is what the caller has to identify it by", async () => {
    await insertSubscriber(session, { foodbankId: SALISBURY, email: "ada@example.org", subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });
    const second = await insertSubscriber(session, {
      foodbankId: DEVIZES,
      email: "grace@example.org",
      subKey: KEYS.graceSub,
      unsubKey: KEYS.graceUnsub,
    });

    expect(second).toBe(2);
    // meta.last_row_id, not a count of rows in the table: with the first row
    // deleted the two would disagree, and the id is the one that must be
    // right.
    expect(allSubscribers().map((row) => row.id)).toEqual([1, 2]);
  });

  // Ticket #9, and the reason the module's own header comment (subscribers
  // .ts:23-25, "a \"T\"-separated, millisecond-precision UTC string") is
  // STALE and must not be believed. pyNow() has written Django's
  // space-separated microsecond format since that ticket, and migration 0022
  // rewrote the two rows this table had already been given in the ISO form.
  //
  // The separator decides the sort before the clock does: "T" is 0x54 and " "
  // is 0x20, so within a day EVERY toISOString() value sorts after EVERY
  // Django-format value whatever the real time. Anyone "restoring" what the
  // comment claims would reintroduce exactly the bug 0022 exists to repair.
  it("stamps created in Django's space-separated microsecond format, not toISOString", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-05T08:00:00.000Z") });

    await insertSubscriber(session, { foodbankId: SALISBURY, email: "ada@example.org", subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });

    expect(allSubscribers()[0]!.created).toBe("2026-09-05 08:00:00.000000");
  });

  // The failure executed rather than argued. The clock is frozen at 08:00 and
  // the migrated row was written at 19:28 the SAME day, so chronologically
  // the migrated row is the newer -- and every `ORDER BY created DESC` and
  // `WHERE created >= ?` in the admin depends on the text agreeing with that.
  it("sorts chronologically against rows the Postgres copy migrated", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-05T08:00:00.000Z") });
    seedSubscriber({
      foodbankId: DEVIZES,
      email: "grace@example.org",
      confirmed: 1,
      subKey: KEYS.graceSub,
      unsubKey: KEYS.graceUnsub,
      created: "2026-09-05 19:28:08.853000",
    });

    await insertSubscriber(session, { foodbankId: SALISBURY, email: "ada@example.org", subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });

    const newest = plain<{ email: string }>(db.prepare("SELECT email FROM foodbanksubscriber ORDER BY created DESC LIMIT 1").get());
    expect(newest.email).toBe("grace@example.org");

    // The counterexample, run in the same engine: the toISOString spelling of
    // that same 08:00 instant compares GREATER than the 19:28 migrated row.
    const inverted = plain<{ wrong: number }>(
      db.prepare("SELECT ('2026-09-05T08:00:00.000Z' > '2026-09-05 19:28:08.853000') AS wrong").get(),
    );
    expect(inverted.wrong).toBe(1);
  });

  // No ON CONFLICT clause, deliberately: routes/wfbn/updates.ts:142-155
  // catches this exact error text to reproduce Django's
  // `except IntegrityError` (gfwfbn/views.py:1150), because the pre-check
  // above narrows the race window without closing it. Swallowing the
  // constraint here -- an `INSERT OR IGNORE`, say -- would make the route's
  // catch dead code AND make the new subscriber a silent no-op that reports
  // success and sends a confirmation email whose key was never stored.
  it("raises the UNIQUE violation rather than swallowing a duplicate (email, foodbank)", async () => {
    seedSubscriber({ foodbankId: SALISBURY, email: "ada@example.org", confirmed: 1, subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });

    await expect(
      insertSubscriber(session, { foodbankId: SALISBURY, email: "ada@example.org", subKey: "eeee111122223333", unsubKey: "ffff444455556666" }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(allSubscribers()).toHaveLength(1);
  });

  // The same address at a DIFFERENT food bank is not a duplicate --
  // unique_together is the pair. A statement that bound a constant food bank
  // id, or dropped the column, would refuse every second subscription in the
  // country and pass every other test in this describe, all of which use one
  // food bank.
  it("writes to the food bank it was given, so the same address can subscribe twice", async () => {
    await insertSubscriber(session, { foodbankId: SALISBURY, email: "ada@example.org", subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });
    await insertSubscriber(session, { foodbankId: DEVIZES, email: "ada@example.org", subKey: KEYS.graceSub, unsubKey: KEYS.graceUnsub });

    expect(allSubscribers().map((row) => row.foodbank_id)).toEqual([SALISBURY, DEVIZES]);
  });

  // The INSERT must name only columns that survived 0019. "Restore parity
  // with Django's denormalised foodbank_name" is a plausible-sounding change
  // that would make every public subscribe throw "no such column" -- and
  // this is the one statement on that path, so it would take the whole
  // signup form down.
  it("does not name foodbank_name, which 0019 dropped, and still reads it back through the view", async () => {
    await insertSubscriber(session, { foodbankId: SALISBURY, email: "ada@example.org", subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });

    const row = await getSubscriberBySubKey(session, KEYS.adaSub);
    expect(row?.foodbank_name).toBe("Salisbury");
  });

  // SUSPECT, pinned as-is rather than fixed. `id INTEGER PRIMARY KEY` is a
  // rowid alias with no AUTOINCREMENT, so SQLite reuses the largest deleted
  // id -- Postgres sequences never do, so Django could not produce this.
  // Unsubscribing is a hard delete (deleteSubscriberById below), so the next
  // subscriber to that food bank can inherit the departed one's id. The one
  // place that matters is getConfirmedSubscribersPage's keyset cursor: a
  // fan-out already past `afterId` would skip a brand-new subscriber who
  // landed on a recycled, lower id. Small, but real, and invisible.
  it("reuses a deleted subscriber's id, which Postgres would never have done", async () => {
    const first = await insertSubscriber(session, { foodbankId: SALISBURY, email: "ada@example.org", subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });
    await deleteSubscriberById(session, first);

    const second = await insertSubscriber(session, {
      foodbankId: SALISBURY,
      email: "grace@example.org",
      subKey: KEYS.graceSub,
      unsubKey: KEYS.graceUnsub,
    });
    expect(second).toBe(first);
  });
});

// ===========================================================================
// confirmSubscriber / deleteSubscriberById
// ===========================================================================

describe("confirmSubscriber", () => {
  beforeEach(() => {
    seedSubscriber({ id: 1, foodbankId: SALISBURY, email: "ada@example.org", confirmed: 0, subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });
    seedSubscriber({ id: 2, foodbankId: SALISBURY, email: "grace@example.org", confirmed: 0, subKey: KEYS.graceSub, unsubKey: KEYS.graceUnsub });
  });

  // The `WHERE id = ?` is the whole statement, so a missing or mis-bound
  // predicate confirms EVERY pending subscriber in the table -- one person
  // clicking their own confirmation link would opt in everybody who had ever
  // started a signup and never finished it. That is the failure this asserts
  // against, which is why the untouched neighbour is checked as hard as the
  // updated row.
  it("confirms exactly the one row, leaving every other pending subscriber pending", async () => {
    await confirmSubscriber(session, 1);

    expect(allSubscribers().map((row) => [row.id, row.confirmed])).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it("writes the integer 1, which is what every downstream filter compares against", async () => {
    await confirmSubscriber(session, 1);

    // `confirmed = 1` is the literal in getConfirmedSubscribersPage below and
    // in foodbankTabs.ts's admin list. A stored `true`, "1" or 2 would leave
    // the subscriber invisible to both while looking confirmed in the row.
    const count = plain<{ n: number }>(
      db.prepare("SELECT COUNT(*) AS n FROM foodbanksubscriber WHERE foodbank_id = ? AND confirmed = 1").get(SALISBURY),
    );
    expect(count.n).toBe(1);
  });

  it("is idempotent, and touches nothing but confirmed", async () => {
    const before = allSubscribers()[0]!;
    await confirmSubscriber(session, 1);
    await confirmSubscriber(session, 1);

    // Django's confirm re-saves the whole model (gfwfbn/views.py:1161), which
    // would have re-run save() and could have rewritten other fields; this
    // touches one column. created and both keys must survive, or the
    // already-emailed unsubscribe link stops working.
    expect(allSubscribers()[0]).toEqual({ ...before, confirmed: 1 });
  });

  it("is a silent no-op for an id nobody holds", async () => {
    await expect(confirmSubscriber(session, 999)).resolves.toBeUndefined();
    expect(allSubscribers().map((row) => row.confirmed)).toEqual([0, 0]);
  });
});

describe("deleteSubscriberById", () => {
  beforeEach(() => {
    seedSubscriber({ id: 1, foodbankId: SALISBURY, email: "ada@example.org", confirmed: 1, subKey: KEYS.adaSub, unsubKey: KEYS.adaUnsub });
    seedSubscriber({ id: 2, foodbankId: SALISBURY, email: "grace@example.org", confirmed: 1, subKey: KEYS.graceSub, unsubKey: KEYS.graceUnsub });
  });

  // A real hard delete, matching Django's `sub.delete()` (gfwfbn/views.py's
  // unsubscribe action) rather than a soft `confirmed = 0`. Worth pinning
  // both halves: the row is gone, and it is the ONLY row gone. An
  // unscoped DELETE on this path would empty the newsletter list for every
  // food bank on the site, triggered by one person clicking one link in one
  // email, with a 200 response and nothing in the logs.
  it("removes exactly the one row", async () => {
    await deleteSubscriberById(session, 1);

    expect(allSubscribers().map((row) => row.id)).toEqual([2]);
  });

  it("frees the address to subscribe again, which a soft delete would not", async () => {
    await deleteSubscriberById(session, 1);

    // sub_email_fb_uniq would still be holding the pair if this were a flag
    // flip, and the person would be permanently unable to re-subscribe --
    // they would just be told "already subscribed" for ever.
    const id = await insertSubscriber(session, {
      foodbankId: SALISBURY,
      email: "ada@example.org",
      subKey: "eeee111122223333",
      unsubKey: "ffff444455556666",
    });
    expect(id).toBeGreaterThan(0);
    expect(allSubscribers().map((row) => row.email).sort()).toEqual(["ada@example.org", "grace@example.org"]);
  });

  it("is a silent no-op for an id nobody holds", async () => {
    await expect(deleteSubscriberById(session, 999)).resolves.toBeUndefined();
    expect(allSubscribers()).toHaveLength(2);
  });
});

// ===========================================================================
// upsertWebpushSubscription
// ===========================================================================

describe("upsertWebpushSubscription", () => {
  const ENDPOINT_A = "https://fcm.googleapis.com/fcm/send/aaaaaaaa";
  const ENDPOINT_B = "https://updates.push.services.mozilla.com/wpush/v2/bbbbbbbb";

  it("inserts a new subscription and reports created: true with its id", async () => {
    const result = await upsertWebpushSubscription(session, {
      foodbankId: SALISBURY,
      endpoint: ENDPOINT_A,
      p256dh: "BP256DH_AAAA",
      auth: "AUTH_AAAA",
      browser: "Firefox",
    });

    // `created` is handed straight into the JSON response
    // (routes/wfbn/webpush.ts:102), which is what static/js/webpush.js keys
    // its "subscribed" vs "already subscribed" UI off. It is Django's
    // update_or_create() return tuple, ported.
    expect(result).toEqual({ id: 1, created: true });
    expect(allWebPush()).toEqual([
      {
        id: 1,
        created: expect.any(String),
        foodbank_id: SALISBURY,
        endpoint: ENDPOINT_A,
        p256dh: "BP256DH_AAAA",
        auth: "AUTH_AAAA",
        browser: "Firefox",
      },
    ]);
  });

  it("stamps created in Django's format on the insert path too", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-05T08:00:00.000Z") });

    await upsertWebpushSubscription(session, { foodbankId: SALISBURY, endpoint: ENDPOINT_A, p256dh: "x", auth: "y", browser: null });

    expect(allWebPush()[0]!.created).toBe("2026-09-05 08:00:00.000000");
  });

  it("updates the existing row in place and reports created: false", async () => {
    seedWebPush({ id: 41, foodbankId: SALISBURY, endpoint: ENDPOINT_A, p256dh: "OLD_P256DH", auth: "OLD_AUTH", browser: "Chrome" });

    const result = await upsertWebpushSubscription(session, {
      foodbankId: SALISBURY,
      endpoint: ENDPOINT_A,
      p256dh: "NEW_P256DH",
      auth: "NEW_AUTH",
      browser: "Firefox",
    });

    // The id is PRESERVED. Not a detail: an INSERT OR REPLACE would delete
    // and re-insert under a fresh rowid, and the fan-out
    // (workers/jobs/src/notify/needWebPush.ts) pages by id and deletes gone
    // endpoints BY id -- a row that changes id mid-fan-out is either skipped
    // or has some other row's 410 charged against it.
    expect(result).toEqual({ id: 41, created: false });
    expect(allWebPush()).toHaveLength(1);
    expect(allWebPush()[0]).toMatchObject({ id: 41, p256dh: "NEW_P256DH", auth: "NEW_AUTH", browser: "Firefox" });
  });

  it("leaves created and endpoint alone when it updates", async () => {
    seedWebPush({ id: 41, foodbankId: SALISBURY, endpoint: ENDPOINT_A, created: "2024-03-01 11:22:33.000000" });

    await upsertWebpushSubscription(session, { foodbankId: SALISBURY, endpoint: ENDPOINT_A, p256dh: "NEW", auth: "NEW", browser: null });

    // Django's update_or_create writes only `defaults`; the lookup kwargs and
    // the auto_now_add created stay untouched. Restamping created would make
    // every re-registration look like a brand-new subscriber and destroy the
    // only signal there is about how old a push endpoint is.
    expect(allWebPush()[0]).toMatchObject({ created: "2024-03-01 11:22:33.000000", endpoint: ENDPOINT_A });
  });

  // THE MUTANT: `browser = COALESCE(?, browser)` on the UPDATE -- "don't
  // overwrite a good value with a null", which reads as care and is a
  // divergence. Django's update_or_create writes every key of `defaults`
  // unconditionally, None included, so a re-registration that reports no
  // browser string must CLEAR the column. Neither existing update test can
  // see it: one writes a new non-null browser over an old one, the other
  // starts from a row whose browser was already null. This is the
  // non-null -> null direction, which is the only one COALESCE changes.
  it("clears browser to null on update when the new registration has none", async () => {
    seedWebPush({ id: 41, foodbankId: SALISBURY, endpoint: ENDPOINT_A, browser: "Chrome" });

    await upsertWebpushSubscription(session, { foodbankId: SALISBURY, endpoint: ENDPOINT_A, p256dh: "x", auth: "y", browser: null });

    expect(allWebPush()[0]!.browser).toBeNull();
  });

  it("stores a null browser rather than an empty string", async () => {
    // routes/wfbn/webpush.ts:99 already converts "" to null; this is the
    // column agreeing with it, so `browser IS NOT NULL` filters mean what
    // they say.
    await upsertWebpushSubscription(session, { foodbankId: SALISBURY, endpoint: ENDPOINT_A, p256dh: "x", auth: "y", browser: null });

    expect(allWebPush()[0]!.browser).toBeNull();
  });

  // THE MUTANT: an existence check that drops the `endpoint` predicate. It
  // would find the food bank's FIRST subscription whatever browser it came
  // from and overwrite its keys with the new device's -- so one person
  // subscribing on their laptop silently breaks the notification they
  // already had on their phone, and the laptop never gets a row at all.
  // p256dh and auth are opaque base64url, so nothing downstream can tell.
  it("matches on the endpoint, not just the food bank: a second endpoint is a new row", async () => {
    seedWebPush({ id: 41, foodbankId: SALISBURY, endpoint: ENDPOINT_A, p256dh: "A_P256DH", auth: "A_AUTH" });

    const result = await upsertWebpushSubscription(session, {
      foodbankId: SALISBURY,
      endpoint: ENDPOINT_B,
      p256dh: "B_P256DH",
      auth: "B_AUTH",
      browser: "Safari",
    });

    expect(result.created).toBe(true);
    expect(allWebPush()).toHaveLength(2);
    // The untouched neighbour is the assertion that matters.
    expect(allWebPush()[0]).toMatchObject({ id: 41, endpoint: ENDPOINT_A, p256dh: "A_P256DH", auth: "A_AUTH" });
  });

  // The other half of webpush_fb_endpoint_uniq's pair (0004:37). One browser
  // subscribing to two food banks is ordinary -- the endpoint is a property
  // of the browser, not of the subscription -- so a check that dropped
  // foodbank_id would turn the second food bank's subscribe into an update of
  // the first's, and that person would silently stop hearing from the food
  // bank they originally chose.
  it("matches on the food bank too: the same endpoint under another food bank is a new row", async () => {
    seedWebPush({ id: 41, foodbankId: SALISBURY, endpoint: ENDPOINT_A, p256dh: "SALISBURY_P256DH", auth: "SALISBURY_AUTH" });

    const result = await upsertWebpushSubscription(session, {
      foodbankId: DEVIZES,
      endpoint: ENDPOINT_A,
      p256dh: "DEVIZES_P256DH",
      auth: "DEVIZES_AUTH",
      browser: "Firefox",
    });

    expect(result.created).toBe(true);
    expect(allWebPush().map((row) => [row.foodbank_id, row.p256dh])).toEqual([
      [SALISBURY, "SALISBURY_P256DH"],
      [DEVIZES, "DEVIZES_P256DH"],
    ]);
  });

  // THE MUTANT: `endpoint LIKE ?` in the existence check instead of
  // `endpoint = ?`. It looks like nothing, and it survives every other
  // fixture in this file -- but a real push endpoint ends in a base64url
  // token, and base64url's alphabet includes `_`, which is LIKE's
  // single-character wildcard. So the pattern built from THIS device's
  // endpoint matches a DIFFERENT device's endpoint that happens to differ
  // only at that position: the upsert takes the update branch, overwrites
  // the other device's p256dh/auth with this one's keys, and never inserts a
  // row of its own. The other browser then receives payloads it cannot
  // decrypt and this one is never registered at all -- and since both keys
  // are opaque base64url, nothing downstream can tell. Hence a fixture with
  // a literal underscore rather than the tidy `aaaaaaaa` endpoints above.
  it("treats the endpoint as a literal, not a LIKE pattern, though FCM tokens contain `_`", async () => {
    const WITH_UNDERSCORE = "https://fcm.googleapis.com/fcm/send/dQw4w9Wg_XcQ";
    const NEIGHBOUR = "https://fcm.googleapis.com/fcm/send/dQw4w9WgZXcQ";
    seedWebPush({ id: 41, foodbankId: SALISBURY, endpoint: NEIGHBOUR, p256dh: "NEIGHBOUR_P256DH", auth: "NEIGHBOUR_AUTH" });

    const result = await upsertWebpushSubscription(session, {
      foodbankId: SALISBURY,
      endpoint: WITH_UNDERSCORE,
      p256dh: "MINE_P256DH",
      auth: "MINE_AUTH",
      browser: "Chrome",
    });

    expect(result.created).toBe(true);
    expect(allWebPush().map((row) => [row.endpoint, row.p256dh])).toEqual([
      [NEIGHBOUR, "NEIGHBOUR_P256DH"],
      [WITH_UNDERSCORE, "MINE_P256DH"],
    ]);
  });

  // Not a performance note: it is what makes the created/not-created
  // distinction possible at all, and it is the reason the module explicitly
  // is NOT an `INSERT ... ON CONFLICT DO UPDATE` (which cannot report which
  // branch it took without a RETURNING clause D1 does not expose here).
  it("is exactly two statements -- a SELECT then one write -- on both branches", async () => {
    await upsertWebpushSubscription(session, { foodbankId: SALISBURY, endpoint: ENDPOINT_A, p256dh: "x", auth: "y", browser: null });
    expect(prepared).toHaveLength(2);
    expect(prepared[0]).toContain("SELECT id FROM webpushsubscription");
    expect(prepared[1]).toContain("INSERT INTO webpushsubscription");

    await upsertWebpushSubscription(session, { foodbankId: SALISBURY, endpoint: ENDPOINT_A, p256dh: "z", auth: "w", browser: null });
    expect(prepared).toHaveLength(4);
    expect(prepared[3]).toContain("UPDATE webpushsubscription");
  });

  // p256dh and auth are both opaque base64url of similar length in adjacent
  // columns, so a transposition produces payloads no browser can decrypt and
  // is invisible in the data. Asserted per column on the UPDATE branch as
  // well as the INSERT, because the two statements bind them independently.
  it("keeps p256dh and auth in their own columns on both branches", async () => {
    await upsertWebpushSubscription(session, { foodbankId: SALISBURY, endpoint: ENDPOINT_A, p256dh: "P_ONE", auth: "A_ONE", browser: null });
    expect(allWebPush()[0]).toMatchObject({ p256dh: "P_ONE", auth: "A_ONE" });

    await upsertWebpushSubscription(session, { foodbankId: SALISBURY, endpoint: ENDPOINT_A, p256dh: "P_TWO", auth: "A_TWO", browser: null });
    expect(allWebPush()[0]).toMatchObject({ p256dh: "P_TWO", auth: "A_TWO" });
  });
});

// ===========================================================================
// deleteWebpushSubscription
// ===========================================================================

describe("deleteWebpushSubscription", () => {
  const ENDPOINT_A = "https://fcm.googleapis.com/fcm/send/aaaaaaaa";
  const ENDPOINT_B = "https://updates.push.services.mozilla.com/wpush/v2/bbbbbbbb";

  beforeEach(() => {
    seedWebPush({ id: 1, foodbankId: SALISBURY, endpoint: ENDPOINT_A });
    seedWebPush({ id: 2, foodbankId: SALISBURY, endpoint: ENDPOINT_B });
    seedWebPush({ id: 3, foodbankId: DEVIZES, endpoint: ENDPOINT_A });
  });

  it("deletes only the (food bank, endpoint) row and reports true", async () => {
    const deleted = await deleteWebpushSubscription(session, { foodbankId: SALISBURY, endpoint: ENDPOINT_A });

    expect(deleted).toBe(true);
    // Both neighbours survive: the same browser's OTHER food bank (id 3) and
    // the same food bank's OTHER browser (id 2). A predicate missing either
    // column unsubscribes people who never asked to be.
    expect(allWebPush().map((row) => row.id)).toEqual([2, 3]);
  });

  // Django's `.filter(...).delete()` returns a deleted_count of 0 here and
  // the view reports `deleted: false` with a 200, never a 404
  // (gfwfbn/views.py:1336-1345). `meta.changes` is the same count for a D1
  // DELETE, and the boolean flows straight into the JSON.
  it("reports false, not an error, when there was nothing to delete", async () => {
    const deleted = await deleteWebpushSubscription(session, { foodbankId: SALISBURY, endpoint: "https://example.com/never-registered" });

    expect(deleted).toBe(false);
    expect(allWebPush()).toHaveLength(3);
  });

  it("reports false for the right endpoint under the wrong food bank", async () => {
    seedWebPush({ id: 4, foodbankId: DEVIZES, endpoint: "https://example.com/devizes-only" });

    expect(await deleteWebpushSubscription(session, { foodbankId: SALISBURY, endpoint: "https://example.com/devizes-only" })).toBe(false);
    expect(allWebPush()).toHaveLength(4);
  });

  // THE SAME `endpoint LIKE ?` MUTANT as on the upsert, and worse here
  // because it destroys rather than overwrites. `_` is LIKE's
  // single-character wildcard and base64url push tokens routinely contain
  // one, so one person unsubscribing on one browser deletes every
  // registration whose endpoint differs from theirs only at that character,
  // and still returns a perfectly ordinary `true`. The neighbour seeded here
  // differs by exactly the one character the wildcard would cover.
  it("treats the endpoint as a literal, not a LIKE pattern", async () => {
    const WITH_UNDERSCORE = "https://fcm.googleapis.com/fcm/send/dQw4w9Wg_XcQ";
    const NEIGHBOUR = "https://fcm.googleapis.com/fcm/send/dQw4w9WgZXcQ";
    seedWebPush({ id: 10, foodbankId: DEVIZES, endpoint: WITH_UNDERSCORE });
    seedWebPush({ id: 11, foodbankId: DEVIZES, endpoint: NEIGHBOUR });

    expect(await deleteWebpushSubscription(session, { foodbankId: DEVIZES, endpoint: WITH_UNDERSCORE })).toBe(true);
    expect(allWebPush().map((row) => row.id)).toEqual([1, 2, 3, 11]);
  });
});

// ===========================================================================
// findMobileSubscriber -- and the `IS ?` that makes it work at all
// ===========================================================================

const DEVICE = "3B7E1F9C-2A4D-4E8B-9F10-5C6D7E8F9012";
const OTHER_DEVICE = "8A1C2D3E-4F50-6172-8394-A5B6C7D8E9F0";
const DONATION_POINT = 55;

describe("findMobileSubscriber", () => {
  beforeEach(() => {
    seedMobile({ id: 1, deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: null });
    seedMobile({ id: 2, deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: DONATION_POINT });
    seedMobile({ id: 3, deviceId: DEVICE, foodbankId: DEVIZES, donationpointId: null });
    seedMobile({ id: 4, deviceId: OTHER_DEVICE, foodbankId: SALISBURY, donationpointId: null });
  });

  // THE BUG CLASS THIS WHOLE HELPER EXISTS FOR, executed rather than argued.
  // SQLite treats NULL as distinct from everything including itself, so
  // `donationpoint_id = NULL` is NULL -- never true -- and matches no row.
  // Most mobsub registrations have no donation point, so with `= ?` the
  // lookup would find nothing, upsertMobileSubscriber would take the INSERT
  // branch every time, and every app launch would add another duplicate row.
  // The endpoint returns {"success": true} either way; the only symptom is a
  // table that grows without bound and N notifications per device.
  it("matches a NULL donationpoint_id, which `= ?` never could", async () => {
    const row = await findMobileSubscriber(session, { deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: null });
    expect(row?.id).toBe(1);

    // The counterexample in the same engine, so the claim above is a fact
    // about SQLite and not about this test's imagination.
    const wrong = plain<{ n: number }>(
      db
        .prepare("SELECT COUNT(*) AS n FROM mobilesubscriber WHERE device_id = ? AND foodbank_id = ? AND donationpoint_id = ?")
        .get(DEVICE, SALISBURY, null),
    );
    expect(wrong.n).toBe(0);
  });

  // Asserted on the spelling as well as on the rows, because `IS ?` and
  // `= ?` are one character apart and a reviewer's eye slides straight over
  // it -- the same belt-and-braces locationsAdmin.test.ts applies to
  // `id IS NOT ?`.
  it("spells the predicate `donationpoint_id IS ?`, never `= ?`", async () => {
    await findMobileSubscriber(session, { deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: null });

    const { sql } = sent[0]!;
    expect(sql).toContain("donationpoint_id IS ?");
    expect(sql).not.toMatch(/donationpoint_id\s*=\s*\?/);
  });

  // `IS` also compares two non-NULL values exactly like `=`, which is what
  // lets one predicate serve the whole column. Without this case the helper
  // could be "fixed" to `donationpoint_id IS NULL` unconditionally and the
  // NULL test above would still pass.
  it("matches a non-NULL donationpoint_id exactly, the way `=` would", async () => {
    const row = await findMobileSubscriber(session, { deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: DONATION_POINT });
    expect(row?.id).toBe(2);
  });

  it("treats the donation point as part of the identity: null and a value are different subscriptions", async () => {
    const withoutDp = await findMobileSubscriber(session, { deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: null });
    const withDp = await findMobileSubscriber(session, { deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: DONATION_POINT });
    expect([withoutDp?.id, withDp?.id]).toEqual([1, 2]);
  });

  it("is scoped by food bank and by device", async () => {
    expect((await findMobileSubscriber(session, { deviceId: DEVICE, foodbankId: DEVIZES, donationpointId: null }))?.id).toBe(3);
    expect((await findMobileSubscriber(session, { deviceId: OTHER_DEVICE, foodbankId: SALISBURY, donationpointId: null }))?.id).toBe(4);
  });

  it("returns null for a device that has never registered", async () => {
    expect(await findMobileSubscriber(session, { deviceId: "never-seen", foodbankId: SALISBURY, donationpointId: null })).toBeNull();
  });

  // THE MUTANT: `device_id LIKE ?`. Nothing else in this file distinguishes
  // it from `= ?`, because a UUID carries no `%` or `_` -- the difference is
  // that LIKE folds ASCII case and `=` does not. That is a live distinction
  // for this column and not a theoretical one: iOS's identifierForVendor is
  // uppercase hex and the same UUID lowercased is what several HTTP clients
  // and JSON layers hand back, so a device really can present both spellings
  // across app versions. With LIKE the two collapse into one identity, this
  // lookup hits a row it should not, and upsertMobileSubscriber overwrites
  // one device's registration with another's. With `=` they stay separate --
  // which is what the port does today, and what this pins.
  it("matches device_id byte-exactly, not as a case-folding LIKE pattern", async () => {
    expect(
      await findMobileSubscriber(session, { deviceId: DEVICE.toLowerCase(), foodbankId: SALISBURY, donationpointId: null }),
    ).toBeNull();
  });

  // The row is handed back with NO boolean coercion and NO column mapping --
  // `row as unknown as MobileSubscriberRow` (subscribers.ts:235). So the key
  // set is exactly the table's columns, and MobileSubscriberRow claiming
  // otherwise would be a lie no compiler could catch. Pinned as an exact
  // list so that a future ALTER TABLE on mobilesubscriber fails here and
  // forces the interface to be updated with it -- which is precisely what
  // did NOT happen when 0019 dropped foodbank_name from five tables.
  it("returns the raw row: every column of mobilesubscriber and nothing else", async () => {
    const row = await findMobileSubscriber(session, { deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: DONATION_POINT });

    expect(Object.keys(plain(row)).sort()).toEqual(
      [
        "app_version",
        "created",
        "device_id",
        "device_model",
        "donationpoint_id",
        "foodbank_id",
        "id",
        "locale",
        "os_version",
        "platform",
        "sub_type",
        "timezone",
      ].sort(),
    );
  });
});

// ===========================================================================
// upsertMobileSubscriber
// ===========================================================================

describe("upsertMobileSubscriber", () => {
  const REGISTRATION = {
    deviceId: DEVICE,
    foodbankId: SALISBURY,
    donationpointId: null,
    platform: "ios",
    timezone: "Europe/London",
    locale: "en-GB",
    appVersion: "2.4.1",
    osVersion: "18.1",
    deviceModel: "iPhone15,2",
    subType: "need",
  };

  it("inserts a new row with every field in its own column", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-05T08:00:00.000Z") });

    await upsertMobileSubscriber(session, REGISTRATION);

    // Eleven bound values across eleven columns, half of them nullable TEXT
    // holding short similar-looking strings -- a shift by one puts the locale
    // in app_version and the OS version in device_model, and the endpoint
    // still answers {"success": true}. Asserted as the whole row for that
    // reason.
    expect(allMobile()).toEqual([
      {
        id: 1,
        created: "2026-09-05 08:00:00.000000",
        device_id: DEVICE,
        platform: "ios",
        timezone: "Europe/London",
        locale: "en-GB",
        app_version: "2.4.1",
        os_version: "18.1",
        device_model: "iPhone15,2",
        sub_type: "need",
        foodbank_id: SALISBURY,
        donationpoint_id: null,
      },
    ]);
  });

  it("stores nulls for the optional fields the app omitted", async () => {
    // routes/wfbn/mobsub.ts:67-72 turns every absent POST field into null,
    // matching Django's `request.POST.get(...)` returning None. Storing ""
    // instead would make "the app did not send a locale" indistinguishable
    // from "the app sent an empty locale".
    await upsertMobileSubscriber(session, {
      ...REGISTRATION,
      timezone: null,
      locale: null,
      appVersion: null,
      osVersion: null,
      deviceModel: null,
      subType: null,
    });

    expect(allMobile()[0]).toMatchObject({
      timezone: null,
      locale: null,
      app_version: null,
      os_version: null,
      device_model: null,
      sub_type: null,
    });
  });

  // Django's update_or_create() UPDATES the found row; it does not delete and
  // recreate it. The module says so in a comment (subscribers.ts:248-255) and
  // this is that comment made executable: `INSERT OR REPLACE` would satisfy
  // "one row, new metadata" and fail here, because it assigns a fresh rowid
  // and resets `created`.
  it("updates the existing row in place, keeping its id and its created date", async () => {
    seedMobile({
      id: 77,
      deviceId: DEVICE,
      foodbankId: SALISBURY,
      donationpointId: null,
      platform: "ios",
      created: "2024-03-01 11:22:33.000000",
      appVersion: "1.0.0",
    });

    await upsertMobileSubscriber(session, { ...REGISTRATION, appVersion: "2.4.1" });

    expect(allMobile()).toHaveLength(1);
    expect(allMobile()[0]).toMatchObject({ id: 77, created: "2024-03-01 11:22:33.000000", app_version: "2.4.1" });
  });

  it("rewrites every one of the seven metadata columns on an update", async () => {
    seedMobile({
      id: 77,
      deviceId: DEVICE,
      foodbankId: SALISBURY,
      platform: "android",
      timezone: "America/New_York",
      locale: "en-US",
      appVersion: "1.0.0",
      osVersion: "14",
      deviceModel: "Pixel 7",
      subType: "digest",
    });

    await upsertMobileSubscriber(session, REGISTRATION);

    // A column left out of the SET list is a value that goes stale for ever
    // -- the device tells the server it upgraded, the server records nothing,
    // and the app_version column becomes useless for exactly the thing it is
    // there for.
    expect(allMobile()[0]).toMatchObject({
      platform: "ios",
      timezone: "Europe/London",
      locale: "en-GB",
      app_version: "2.4.1",
      os_version: "18.1",
      device_model: "iPhone15,2",
      sub_type: "need",
    });
  });

  // THE MUTANT: `timezone = COALESCE(?, timezone)`, and the same on locale,
  // app_version, os_version, device_model and sub_type -- six nullable
  // columns where "don't overwrite a good value with a null" reads like a
  // kindness and is a divergence. Django's update_or_create writes every key
  // of `defaults`, None included, and mobsub passes `request.POST.get(...)`
  // straight through, so a device that stops sending a field must clear it.
  // The existing null test drives only the INSERT branch, where COALESCE
  // against a fresh row is indistinguishable from a plain bind; this is the
  // non-null -> null direction on the branch that has an old value to keep.
  // Left uncaught, `app_version` in particular silently records the highest
  // version a device ever reported rather than the one it is running.
  it("clears every nullable column on update rather than keeping the old value", async () => {
    seedMobile({
      id: 77,
      deviceId: DEVICE,
      foodbankId: SALISBURY,
      donationpointId: null,
      timezone: "America/New_York",
      locale: "en-US",
      appVersion: "1.0.0",
      osVersion: "14",
      deviceModel: "Pixel 7",
      subType: "digest",
    });

    await upsertMobileSubscriber(session, {
      ...REGISTRATION,
      timezone: null,
      locale: null,
      appVersion: null,
      osVersion: null,
      deviceModel: null,
      subType: null,
    });

    expect(allMobile()).toHaveLength(1);
    expect(allMobile()[0]).toMatchObject({
      id: 77,
      timezone: null,
      locale: null,
      app_version: null,
      os_version: null,
      device_model: null,
      sub_type: null,
    });
  });

  it("never rewrites the identity columns it matched on", async () => {
    seedMobile({ id: 77, deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: DONATION_POINT });

    await upsertMobileSubscriber(session, { ...REGISTRATION, donationpointId: DONATION_POINT });

    expect(allMobile()[0]).toMatchObject({ device_id: DEVICE, foodbank_id: SALISBURY, donationpoint_id: DONATION_POINT });
  });

  // The NULL trap again, now on the path where it actually costs something.
  // With `= ?` in the match clause the find would miss, this would take the
  // INSERT branch, and every launch of the app on a device with no donation
  // point selected would add a row -- unbounded growth plus one push
  // notification per duplicate. Two calls, one row, is the assertion.
  it("re-registering a device with no donation point updates rather than duplicating", async () => {
    await upsertMobileSubscriber(session, REGISTRATION);
    await upsertMobileSubscriber(session, { ...REGISTRATION, appVersion: "2.5.0" });
    await upsertMobileSubscriber(session, { ...REGISTRATION, appVersion: "2.6.0" });

    expect(allMobile()).toHaveLength(1);
    expect(allMobile()[0]).toMatchObject({ id: 1, app_version: "2.6.0" });
  });

  it("keeps one device's subscriptions to two food banks separate", async () => {
    await upsertMobileSubscriber(session, REGISTRATION);
    await upsertMobileSubscriber(session, { ...REGISTRATION, foodbankId: DEVIZES });

    expect(allMobile().map((row) => row.foodbank_id)).toEqual([SALISBURY, DEVIZES]);
  });

  it("keeps a food bank's subscription and its donation point's subscription separate", async () => {
    await upsertMobileSubscriber(session, REGISTRATION);
    await upsertMobileSubscriber(session, { ...REGISTRATION, donationpointId: DONATION_POINT });

    expect(allMobile().map((row) => row.donationpoint_id)).toEqual([null, DONATION_POINT]);
  });

  it("keeps two devices apart", async () => {
    await upsertMobileSubscriber(session, REGISTRATION);
    await upsertMobileSubscriber(session, { ...REGISTRATION, deviceId: OTHER_DEVICE });

    expect(allMobile().map((row) => row.device_id)).toEqual([DEVICE, OTHER_DEVICE]);
  });

  it("is a find then a single write, never a blind INSERT OR REPLACE", async () => {
    await upsertMobileSubscriber(session, REGISTRATION);
    expect(prepared).toHaveLength(2);
    expect(prepared[0]).toContain("SELECT * FROM mobilesubscriber");
    expect(prepared[1]).toContain("INSERT INTO mobilesubscriber");
    // Eleven bindings, always -- fixed arity, so no length of input can walk
    // this statement towards D1's 100-bound-parameter ceiling.
    expect(sent[1]!.params).toHaveLength(11);

    await upsertMobileSubscriber(session, REGISTRATION);
    expect(prepared).toHaveLength(4);
    expect(prepared[3]).toContain("UPDATE mobilesubscriber");
    expect(sent[3]!.params).toHaveLength(8);
  });

  // SUSPECT, pinned as-is. 0004:39-45 deliberately declines to put a unique
  // index on the triple, so duplicates are representable -- and the pre-0004
  // Postgres table had no constraint either, so production may well hold
  // some. Django's update_or_create() calls get() on this lookup and would
  // raise MultipleObjectsReturned (a 500, loudly); this port takes .first()
  // and silently updates ONE of them, leaving the other frozen with whatever
  // platform/timezone/app_version it had. The stale twin keeps receiving
  // notifications for ever, because nothing else in the fan-out dedupes by
  // device_id. Asserted as "one row changed, the other did not" rather than
  // by id, since which row .first() picks is the query planner's choice.
  it("updates only one of two duplicate rows where Django would have raised", async () => {
    seedMobile({ id: 10, deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: null, appVersion: "1.0.0" });
    seedMobile({ id: 11, deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: null, appVersion: "1.0.0" });

    await upsertMobileSubscriber(session, { ...REGISTRATION, appVersion: "2.4.1" });

    const versions = allMobile().map((row) => row.app_version);
    expect(allMobile()).toHaveLength(2);
    expect(versions.filter((v) => v === "2.4.1")).toHaveLength(1);
    expect(versions.filter((v) => v === "1.0.0")).toHaveLength(1);
  });
});

// ===========================================================================
// deleteMobileSubscriber
// ===========================================================================

describe("deleteMobileSubscriber", () => {
  beforeEach(() => {
    seedMobile({ id: 1, deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: null });
    seedMobile({ id: 2, deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: DONATION_POINT });
    seedMobile({ id: 3, deviceId: DEVICE, foodbankId: DEVIZES, donationpointId: null });
    seedMobile({ id: 4, deviceId: OTHER_DEVICE, foodbankId: SALISBURY, donationpointId: null });
  });

  it("deletes exactly the identified subscription and reports true", async () => {
    const deleted = await deleteMobileSubscriber(session, { deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: null });

    expect(deleted).toBe(true);
    // Every neighbour that differs in exactly one of the three identity
    // columns survives. Drop any one predicate and this device loses
    // subscriptions it never asked to cancel -- and the response is
    // {"deleted": true} either way.
    expect(allMobile().map((row) => row.id)).toEqual([2, 3, 4]);
  });

  it("matches a NULL donationpoint_id, so unsubscribing the common case works at all", async () => {
    // With `= ?` this deletes nothing, returns {"deleted": false}, and the
    // user's "turn off notifications" does nothing at all -- for ever,
    // silently, with a 200.
    expect(await deleteMobileSubscriber(session, { deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: null })).toBe(true);
  });

  it("deletes the donation point's subscription without touching the food bank's", async () => {
    const deleted = await deleteMobileSubscriber(session, { deviceId: DEVICE, foodbankId: SALISBURY, donationpointId: DONATION_POINT });

    expect(deleted).toBe(true);
    expect(allMobile().map((row) => row.id)).toEqual([1, 3, 4]);
  });

  // Django reports `deleted: deleted_count > 0` with a 200 rather than
  // 404ing a no-op (gfwfbn/views.py:1409-1414, and mobsub.ts:95-97 says so
  // explicitly). A device that unsubscribes twice -- ordinary, because the
  // app retries -- must get a clean answer, not an error.
  it("reports false rather than raising when there was nothing to delete", async () => {
    expect(await deleteMobileSubscriber(session, { deviceId: "never-registered", foodbankId: SALISBURY, donationpointId: null })).toBe(false);
    expect(allMobile()).toHaveLength(4);
  });

  it("reports false for the right device under the wrong food bank's donation point", async () => {
    expect(await deleteMobileSubscriber(session, { deviceId: DEVICE, foodbankId: DEVIZES, donationpointId: DONATION_POINT })).toBe(false);
    expect(allMobile()).toHaveLength(4);
  });

  // Django's `.filter(...).delete()` is a queryset delete, not a get-then
  // -delete: it removes every matching row and returns the count. So where
  // upsertMobileSubscriber above quietly touches one of a duplicate pair,
  // this one clears both -- which is the right behaviour for an unsubscribe
  // and is worth pinning precisely because the two functions share a match
  // clause and behave differently with the same rows.
  it("clears every duplicate matching the triple, not just the first", async () => {
    seedMobile({ id: 10, deviceId: OTHER_DEVICE, foodbankId: DEVIZES, donationpointId: null });
    seedMobile({ id: 11, deviceId: OTHER_DEVICE, foodbankId: DEVIZES, donationpointId: null });

    expect(await deleteMobileSubscriber(session, { deviceId: OTHER_DEVICE, foodbankId: DEVIZES, donationpointId: null })).toBe(true);
    expect(allMobile().map((row) => row.id)).toEqual([1, 2, 3, 4]);
  });
});

// ===========================================================================
// getConfirmedSubscribersPage -- the newsletter fan-out's recipient list
// ===========================================================================

describe("getConfirmedSubscribersPage", () => {
  // Ids deliberately NOT in insertion order, and deliberately sparse. The
  // rows go in as 25, 3, 14, 7, 10 so that "returns them in insertion order"
  // and "returns them in id order" are different answers -- without that, a
  // missing ORDER BY passes, since SQLite would hand back rowid order anyway.
  // The gaps also make `id > ?` testable with cursor values that are not
  // themselves row ids.
  beforeEach(() => {
    seedSubscriber({ id: 25, foodbankId: SALISBURY, email: "e@example.org", confirmed: 1, subKey: "sub25000000000000", unsubKey: "uns25000000000000" });
    seedSubscriber({ id: 3, foodbankId: SALISBURY, email: "a@example.org", confirmed: 1, subKey: "sub03000000000000", unsubKey: "uns03000000000000" });
    seedSubscriber({ id: 14, foodbankId: SALISBURY, email: "d@example.org", confirmed: 1, subKey: "sub14000000000000", unsubKey: "uns14000000000000" });
    seedSubscriber({ id: 7, foodbankId: SALISBURY, email: "b@example.org", confirmed: 1, subKey: "sub07000000000000", unsubKey: "uns07000000000000" });
    seedSubscriber({ id: 10, foodbankId: SALISBURY, email: "c@example.org", confirmed: 1, subKey: "sub10000000000000", unsubKey: "uns10000000000000" });
  });

  it("returns confirmed subscribers in ascending id order, whatever order they were written in", async () => {
    const page = await getConfirmedSubscribersPage(session, SALISBURY, 0, 25);

    // Exact emails in an exact order -- not a length, not a set. Keyset
    // paging is only correct if the ordering the cursor assumes is the
    // ordering the query produces; those two agreeing is the entire
    // mechanism.
    expect(page.map((row) => row.email)).toEqual(["a@example.org", "b@example.org", "c@example.org", "d@example.org", "e@example.org"]);
    expect(page.map((row) => row.id)).toEqual([3, 7, 10, 14, 25]);
  });

  // The three-page walk workers/jobs/src/notify/needEmail.ts:72-93 actually
  // performs, with a page size small enough that the boundaries land inside
  // the data. `id >= ?2` instead of `id > ?2` re-sends to the last recipient
  // of every page for ever; a missing ORDER BY skips people outright. Both
  // failures are one duplicate or one missing email -- there is no page to
  // look wrong and nothing is logged.
  it("walks the whole list exactly once across pages, with no repeats and no gaps", async () => {
    const seen: number[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = await getConfirmedSubscribersPage(session, SALISBURY, cursor, 2);
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.id));
      cursor = page[page.length - 1]!.id;
    }

    expect(seen).toEqual([3, 7, 10, 14, 25]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  // THE ONE CLAIM IN THIS FILE THE ROWS CANNOT MAKE, so it is asserted on the
  // statement text instead -- and the reason is executed below rather than
  // taken on trust. `ORDER BY id` is the contract the cursor above depends
  // on, but on THIS table it is a no-op the planner elides:
  // sub_fb_confirmed_idx is (foodbank_id, confirmed) (0004:26), SQLite
  // appends the rowid to every index key, so the search already emits
  // ascending ids -- and with that index dropped a full table scan emits
  // rowid order too. Deleting the clause therefore changes no result any
  // fixture on this schema can produce.
  //
  // Which is exactly why it must not be deleted. The ordering is currently a
  // property of the STORAGE, not of the query; widen, reorder or replace
  // sub_fb_confirmed_idx (0017 did precisely that to three other tables) and
  // the fan-out starts skipping recipients with nothing anywhere to notice.
  // Compare notifySubscribers.test.ts's getWebPushSubscriptionsPage, where
  // webpushsubscription's only index really does hand rows back in ENDPOINT
  // order and the identical clause IS provable from the rows.
  it("orders by id explicitly, which the current index makes unprovable from the rows alone", async () => {
    await getConfirmedSubscribersPage(session, SALISBURY, 0, 25);
    expect(prepared[0]).toContain("ORDER BY id");

    // The module's own statement, and the same one with the clause removed
    // -- its real four-column list, not a trimmed `SELECT id`, so the
    // planner makes the same choice it makes in production (asking for only
    // `id` turns this into a covering-index scan and answers a different
    // question).
    const SELECTION = "SELECT id, email, created, unsub_key FROM foodbanksubscriber ";
    const PREDICATE = "WHERE foodbank_id = ?1 AND confirmed = 1 AND id > ?2 ";
    const ORDERED = `${SELECTION}${PREDICATE}ORDER BY id LIMIT ?3`;
    const UNORDERED = `${SELECTION}${PREDICATE}LIMIT ?3`;
    const plan = (sql: string) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(SALISBURY, 0, 25)
        .map((row) => (row as unknown as { detail: string }).detail);

    expect(plan(ORDERED)[0]).toContain("USING INDEX sub_fb_confirmed_idx");
    expect(plan(ORDERED)).toEqual(plan(UNORDERED));

    // And with the index gone the bare scan still comes back in id order --
    // there is no arrangement of this table that would expose the missing
    // clause, which is the whole point.
    db.exec("DROP INDEX sub_fb_confirmed_idx");
    expect(db.prepare(UNORDERED).all(SALISBURY, 0, 25).map((row) => (row as unknown as { id: number }).id)).toEqual([3, 7, 10, 14, 25]);
  });

  it("excludes the cursor row itself: `id > ?`, not `>=`", async () => {
    const page = await getConfirmedSubscribersPage(session, SALISBURY, 10, 25);
    expect(page.map((row) => row.id)).toEqual([14, 25]);
  });

  it("accepts a cursor that is not itself a row id", async () => {
    // The cursor is only ever the last id sent, but 0 is the documented
    // start value and gaps make in-between values reachable after a
    // subscriber unsubscribes mid-fan-out.
    expect((await getConfirmedSubscribersPage(session, SALISBURY, 11, 25)).map((row) => row.id)).toEqual([14, 25]);
  });

  // needEmail.ts:73 uses the empty page as its termination condition. A final
  // page that exactly fills the limit is the ordinary case (25 subscribers, a
  // PAGE_SIZE of 25), so the consumer always re-enqueues once more and must
  // get an empty array rather than the last page again.
  it("returns an empty array once the cursor is past the last subscriber", async () => {
    expect(await getConfirmedSubscribersPage(session, SALISBURY, 25, 25)).toEqual([]);
  });

  // THE FILTER THAT DEFINES THE FEATURE. Django's queryset is
  // `FoodbankSubscriber.objects.filter(foodbank=foodbank, confirmed=True)`
  // (gfadmin/views.py:1994). Drop `confirmed = 1` and every address that was
  // typed into the box and never confirmed starts receiving the newsletter --
  // the whole point of double opt-in, gone, with no error anywhere. The
  // pending rows here are seeded at ids INSIDE the confirmed range on
  // purpose, so a filter that does nothing changes the result rather than
  // merely appending to it.
  it("excludes unconfirmed subscribers, including ones interleaved by id", async () => {
    seedSubscriber({ id: 8, foodbankId: SALISBURY, email: "pending@example.org", confirmed: 0, subKey: "sub08000000000000", unsubKey: "uns08000000000000" });
    seedSubscriber({ id: 20, foodbankId: SALISBURY, email: "alsopending@example.org", confirmed: 0, subKey: "sub20000000000000", unsubKey: "uns20000000000000" });

    const page = await getConfirmedSubscribersPage(session, SALISBURY, 0, 25);
    expect(page.map((row) => row.id)).toEqual([3, 7, 10, 14, 25]);
    expect(page.map((row) => row.email)).not.toContain("pending@example.org");
  });

  // The unconfirmed rows must not consume the LIMIT either. A filter applied
  // in JavaScript after a `LIMIT 2` would return one row here and the caller
  // would page correctly but mail half the list.
  it("does not let excluded rows eat into the page's limit", async () => {
    seedSubscriber({ id: 4, foodbankId: SALISBURY, email: "pending@example.org", confirmed: 0, subKey: "sub04000000000000", unsubKey: "uns04000000000000" });
    seedSubscriber({ id: 5, foodbankId: DEVIZES, email: "devizes@example.org", confirmed: 1, subKey: "sub05000000000000", unsubKey: "uns05000000000000" });

    expect((await getConfirmedSubscribersPage(session, SALISBURY, 0, 2)).map((row) => row.id)).toEqual([3, 7]);
  });

  // THE OTHER FILTER, and the worse failure of the two: without
  // `foodbank_id = ?1` this sends Salisbury's shopping list to Devizes's
  // subscribers, at which point the food bank people actually want to help
  // gets nothing and the wrong one gets a mailshot. Seeded with Devizes ids
  // interleaved through Salisbury's so a dropped predicate changes the ORDER
  // as well as the contents.
  it("returns only the requested food bank's subscribers", async () => {
    seedSubscriber({ id: 5, foodbankId: DEVIZES, email: "dev1@example.org", confirmed: 1, subKey: "sub05000000000000", unsubKey: "uns05000000000000" });
    seedSubscriber({ id: 12, foodbankId: DEVIZES, email: "dev2@example.org", confirmed: 1, subKey: "sub12000000000000", unsubKey: "uns12000000000000" });

    expect((await getConfirmedSubscribersPage(session, SALISBURY, 0, 25)).map((row) => row.id)).toEqual([3, 7, 10, 14, 25]);
    expect((await getConfirmedSubscribersPage(session, DEVIZES, 0, 25)).map((row) => row.id)).toEqual([5, 12]);
  });

  it("returns an empty array for a food bank with no subscribers at all", async () => {
    expect(await getConfirmedSubscribersPage(session, ORPHANED_FB, 0, 25)).toEqual([]);
  });

  // Exactly four columns, not `SELECT *`. This is the one query in the
  // codebase whose result set is measured in thousands (5,855 confirmed
  // subscribers), and unlike the reads above it goes to the base table, not
  // to foodbanksubscriber_full -- no join, because the food bank's own row is
  // already loaded once per page by the consumer. `unsub_key` is here because
  // notification.txt/.html render the one-click unsubscribe link from it and
  // it also becomes the RFC 8058 List-Unsubscribe header
  // (needEmail.ts:118); `created` because the email prints the date the
  // person subscribed. A drift to `SELECT *` would also pull sub_key into
  // every queue message on this path.
  it("selects exactly id, email, created and unsub_key", async () => {
    const [row] = await getConfirmedSubscribersPage(session, SALISBURY, 0, 1);

    expect(Object.keys(plain(row)).sort()).toEqual(["created", "email", "id", "unsub_key"]);
    expect(prepared[0]).not.toContain("SELECT *");
    expect(prepared[0]).toContain("FROM foodbanksubscriber ");
    expect(prepared[0]).not.toContain("foodbanksubscriber_full");
  });

  // THE MUTANT: `SELECT id, email, created, sub_key AS unsub_key`. The key
  // set is unchanged, the type is unchanged, and every other assertion in
  // this describe reads id, email or created -- so the one column whose
  // VALUE nothing checked was the one the entire unsubscribe machinery is
  // built from. needEmail.ts:118 renders the one-click link from it AND puts
  // it in the RFC 8058 List-Unsubscribe header, so an aliased sub_key would
  // 404 every unsubscribe link in every newsletter while confirming
  // somebody's subscription instead. This is the one path where a broken
  // unsubscribe is a deliverability problem rather than an inconvenience.
  // The fixture's `subNN…`/`unsNN…` keys exist to make the swap legible.
  it("carries each subscriber's own unsub_key, not their sub_key", async () => {
    const page = await getConfirmedSubscribersPage(session, SALISBURY, 0, 25);

    expect(page.map((row) => [row.email, row.unsub_key])).toEqual([
      ["a@example.org", "uns03000000000000"],
      ["b@example.org", "uns07000000000000"],
      ["c@example.org", "uns10000000000000"],
      ["d@example.org", "uns14000000000000"],
      ["e@example.org", "uns25000000000000"],
    ]);
  });

  it("hands back created in the stored text form, unparsed", async () => {
    // needEmail.ts:100-101 feeds this straight to formatSubscribedDate /
    // formatSubscribedTime, whose own parser expects the stored string. The
    // DB layer must not helpfully turn it into a Date.
    const [row] = await getConfirmedSubscribersPage(session, SALISBURY, 0, 1);
    expect(row!.created).toBe("2026-09-05 19:28:08.853000");
  });

  // A LIMIT of 25 is three bound parameters, and so is a LIMIT of 500. Worth
  // stating because the obvious "optimisation" on this path -- fetching ids
  // first and re-reading them with an `IN (?,?,...)` list -- would work in
  // every hand-test and then fail on the 100th subscriber, which is an
  // entirely ordinary size for the largest food bank on the site (a few
  // hundred). D1 caps one statement at 100 bound parameters.
  it("binds three parameters whatever the page size, so D1's 100-parameter cap is unreachable", async () => {
    await getConfirmedSubscribersPage(session, SALISBURY, 0, 500);
    expect(sent[0]!.params).toEqual([SALISBURY, 0, 500]);
    expect(sent[0]!.params).toHaveLength(3);
  });

  it("returns at most `limit` rows", async () => {
    expect(await getConfirmedSubscribersPage(session, SALISBURY, 0, 1)).toHaveLength(1);
    expect(await getConfirmedSubscribersPage(session, SALISBURY, 0, 3)).toHaveLength(3);
    expect(await getConfirmedSubscribersPage(session, SALISBURY, 0, 99)).toHaveLength(5);
  });

  // SUSPECT, pinned because it is a live trap rather than a curiosity.
  // SQLite documents a NEGATIVE limit as "no limit at all", so a caller that
  // derived its page size by subtraction and went negative would silently
  // pull the whole table into one queue message instead of raising -- 5,855
  // rows on the largest fan-out, in a Worker with a memory ceiling. The
  // module does not clamp it. LIMIT 0 is the ordinary SQL answer and would,
  // separately, spin a fan-out that never terminates because the consumer
  // treats an empty page as "done" -- so it stops, which is at least safe.
  it("treats a negative limit as unlimited and a zero limit as empty", async () => {
    expect(await getConfirmedSubscribersPage(session, SALISBURY, 0, -1)).toHaveLength(5);
    expect(await getConfirmedSubscribersPage(session, SALISBURY, 0, 0)).toHaveLength(0);
  });

  // `confirmed` is INTEGER, and the statement compares it to the literal 1
  // rather than testing truthiness. Nothing in the port writes anything but
  // 0 or 1, so this is the boundary being stated rather than a live case:
  // if some future writer stored 2 (or the ETL's Python `True`, which
  // extract_core.py converts to an int for exactly this reason), the row
  // would be silently invisible to the newsletter while looking subscribed
  // everywhere a template just checks for truthiness.
  it("compares confirmed to the literal 1, so any other non-zero value is invisible", async () => {
    db.prepare("UPDATE foodbanksubscriber SET confirmed = 2 WHERE id = 7").run();

    expect((await getConfirmedSubscribersPage(session, SALISBURY, 0, 25)).map((row) => row.id)).toEqual([3, 10, 14, 25]);
  });
});
