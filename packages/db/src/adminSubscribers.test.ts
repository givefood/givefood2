import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertConfirmedSubscribers, type AdminSubscriberInsert } from "./adminSubscribers";
import type { Session } from "./types";

// gfadmin/views.py:1594-1612 foodbank_addsub -- the admin's "paste a list of
// addresses" bulk add, ported in workers/site/src/routes/admin/foodbankAddSub
// .ts on top of this one function.
//
// WHY THIS FILE RUNS A REAL DATABASE. Everything insertConfirmedSubscribers
// contains is one SQL statement, and every way it can be wrong is SILENT: a
// `confirmed` literal of 0 instead of 1 inserts rows nobody ever emails, a
// swapped sub_key/unsub_key binding mints working links that unsubscribe the
// person who clicks "confirm", an ON CONFLICT target of the wrong pair either
// throws at runtime or dedupes across food banks. None of those raise, none
// of them log, and a fake session that hands back canned rows agrees with all
// of them. So the fixture below is Node's own SQLite running the module's
// real statement against the real schema.
//
// THE SCHEMA IS THE MIGRATION FILES THEMSELVES, applied in order, not a
// transcribed CREATE TABLE. That is deliberate and it is the scar this
// package carries: migration 0019 dropped `foodbank_name` off five tables --
// foodbanksubscriber included (0019:59) -- and four queries elsewhere went on
// naming columns that no longer existed, silently, until someone measured
// /dashboard/beautybanks/. A hand-copied schema in a test file is a second
// copy of the truth that drifts the same way. Reading migrations/*.sql means
// this test sees exactly the columns production has, and would have failed
// the moment 0019 landed if the module had not been updated with it.

// THE CLOCK IS SPIED AS WELL AS FROZEN -- the one thing in this module a real
// database cannot observe. `const created = pyNow()` sits ABOVE the map
// (adminSubscribers.ts:47) so that every address in one paste shares a single
// timestamp; moving that call into the map -- `bind(pyNow(), ...)`, a
// one-word edit -- changes that, and NO amount of frozen fake timers can see
// it, because a frozen clock returns the same string whether it is asked once
// or sixty times. That mutant was run against this file and survived every
// other test in it. Counting the calls is the only thing that kills it.
//
// It calls through to the real pyNow by default, so the two format tests
// below still assert what packages/models/src/pyDatetime.ts genuinely
// produces rather than what this file wishes it produced. Nothing else is
// stubbed: the database underneath is Node's own SQLite running the module's
// real statement.
const { pyNowSpy } = vi.hoisted(() => ({ pyNowSpy: vi.fn<() => string>() }));
vi.mock("@givefood/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@givefood/models")>();
  pyNowSpy.mockImplementation(actual.pyNow);
  return { ...actual, pyNow: pyNowSpy };
});

// MUTATION-TESTED, per TESTING.md's convention: the module was copied into
// the scratchpad, broken thirty-one ways, and this file re-run against each
// one. Two mutants survive, and both were then checked against SQLite itself
// rather than assumed -- they are equivalent, not gaps:
//
//   * `ON CONFLICT(foodbank_id, email)` -- SQLite matches a conflict target
//     to a unique index as a SET of columns, so the flipped order resolves to
//     sub_email_fb_uniq exactly as written and behaves identically.
//   * `session.prepare(sql)` hoisted out of the map and one statement reused
//     for every row -- D1's `bind()` returns a NEW statement rather than
//     mutating the receiver, so the rows still differ.
//
// Everything else -- the confirmed literal, each binding position, the
// conflict target, DO NOTHING vs DO UPDATE, the count, the batch, the clock
// -- is killed by a named test below.

type Bindable = null | number | bigint | string | Uint8Array;

interface Sent {
  sql: string;
  params: Bindable[];
}

interface FakeStatement extends Sent {
  bind(...values: unknown[]): FakeStatement;
}

// Adapts node:sqlite to the D1 Sessions API surface this module uses --
// prepare().bind() to build statements, and batch() to send them.
//
// batch() RUNS THEM IN A TRANSACTION, because D1's does: a batch is applied
// atomically, and that is the entire reason the module builds one instead of
// awaiting N inserts in a loop. Django's version had no transaction
// (views.py:1602-1608 is a bare Python for-loop of .save() calls), so a
// duplicate halfway down a pasted list committed everything above it, 500ed,
// and never attempted anything below. Modelling the transaction here is what
// makes "nothing at all was written" an assertable claim rather than a
// paragraph of prose in the module header.
function d1Session(db: DatabaseSync) {
  const prepared: string[] = [];
  const batches: Sent[][] = [];

  function statement(sql: string, params: Bindable[]): FakeStatement {
    // bind() returns a NEW statement rather than mutating this one, matching
    // D1's immutable prepared statements -- a harness that mutated in place
    // would let the last row's bindings quietly overwrite every earlier row's
    // and turn a 60-address paste into 60 copies of the last address.
    return { sql, params, bind: (...values: unknown[]) => statement(sql, values as Bindable[]) };
  }

  const session = {
    prepare(sql: string) {
      prepared.push(sql);
      return statement(sql, []);
    },
    async batch(statements: FakeStatement[]) {
      batches.push(statements.map((s) => ({ sql: s.sql, params: s.params })));
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => {
          const { changes, lastInsertRowid } = db.prepare(s.sql).run(...s.params);
          return { success: true, results: [], meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) } };
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getBookmark: () => null,
  };

  return { session: session as unknown as Session, prepared, batches };
}

interface SubscriberRow {
  id: number;
  created: string;
  last_contacted: string | null;
  foodbank_id: number;
  email: string;
  confirmed: number;
  sub_key: string;
  unsub_key: string;
}

const SALISBURY = { id: 1, name: "Salisbury", slug: "salisbury" };
const DEVIZES = { id: 2, name: "Devizes", slug: "devizes" };

let db: DatabaseSync;
let session: Session;
let prepared: string[];
let batches: Sent[][];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  for (const fb of [SALISBURY, DEVIZES]) {
    // Every NOT NULL column 0001_core.sql declares on `foodbank`, filled with
    // whatever satisfies it -- only `name` and `slug` are ever read here, by
    // foodbanksubscriber_full's join. Spelt out rather than trimmed to the
    // interesting two because the real DDL is what the fixture applies, and a
    // shorter INSERT simply will not run.
    db.prepare(
      "INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, charity_just_foodbank, " +
        "contact_email, url, shopping_list_url, address_is_administrative, is_closed, no_locations, days_between_needs, created, modified) " +
        "VALUES (?, ?, ?, ?, '1 Test Street', 'SP2 9DY', 'England', '51.0688,-1.7945', 1, 'info@example.org', " +
        "'https://example.org/', 'https://example.org/list/', 0, 0, 0, 7, ?, ?)",
    ).run(fb.id, `uuid-${fb.slug}`, fb.name, fb.slug, "2020-01-01 00:00:00.000000", "2020-01-01 00:00:00.000000");
  }
  ({ session, prepared, batches } = d1Session(db));
  // mockClear, not mockReset: the call-through implementation installed by the
  // factory above must survive into every test, only the call log resets.
  pyNowSpy.mockClear();
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

// A row that reached the table by some route OTHER than this function --
// either the one-off Postgres copy or the public double opt-in flow in
// subscribers.ts. Its `created` is in the Postgres-shaped format the ETL
// wrote (tools/pg-to-d1), which is what the ordering tests below compare
// against.
function seedSubscriber(row: {
  foodbankId: number;
  email: string;
  confirmed: number;
  subKey: string;
  unsubKey: string;
  created?: string;
  lastContacted?: string | null;
}): void {
  db.prepare(
    "INSERT INTO foodbanksubscriber (created, last_contacted, foodbank_id, email, confirmed, sub_key, unsub_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.created ?? "2026-09-05 19:28:08.853000",
    row.lastContacted ?? null,
    row.foodbankId,
    row.email,
    row.confirmed,
    row.subKey,
    row.unsubKey,
  );
}

// Spread into a plain object: node:sqlite hands back null-prototype rows, and
// the assertions read better against ordinary objects.
function allRows(): SubscriberRow[] {
  return db
    .prepare("SELECT * FROM foodbanksubscriber ORDER BY id")
    .all()
    .map((row) => ({ ...row }) as unknown as SubscriberRow);
}

function rowsFor(foodbankId: number): SubscriberRow[] {
  return allRows().filter((row) => row.foodbank_id === foodbankId);
}

// The shape workers/site/src/routes/admin/foodbankAddSub.ts:107-109 builds:
// an already-lowercased address plus a freshly minted key pair. The keys are
// deliberately unlike each other and unlike the address, so a binding that
// lands in the wrong column is visible rather than plausible.
function paste(email: string, n: number): AdminSubscriberInsert {
  return { email, subKey: `sub${String(n).padStart(13, "0")}`, unsubKey: `uns${String(n).padStart(13, "0")}` };
}

describe("insertConfirmedSubscribers: what it writes", () => {
  it("stores one row per pasted address, each value in its own column", async () => {
    const added = await insertConfirmedSubscribers(session, SALISBURY.id, [paste("ada@example.org", 1), paste("grace@example.org", 2), paste("hedy@example.org", 3)]);

    expect(added).toBe(3);
    const rows = allRows();
    expect(rows.map((row) => row.email)).toEqual(["ada@example.org", "grace@example.org", "hedy@example.org"]);
    // sub_key and unsub_key are adjacent TEXT columns holding
    // indistinguishable 16-character hashes in production, so a transposed
    // pair is invisible in the data and visible only in what the emails do:
    // the confirm link would unsubscribe and the unsubscribe link would 404.
    // Asserting per column, not "the row has two keys somewhere".
    expect(rows.map((row) => row.sub_key)).toEqual(["sub0000000000001", "sub0000000000002", "sub0000000000003"]);
    expect(rows.map((row) => row.unsub_key)).toEqual(["uns0000000000001", "uns0000000000002", "uns0000000000003"]);
    expect(rows.every((row) => row.foodbank_id === SALISBURY.id)).toBe(true);
  });

  // BOUND, NOT INTERPOLATED, and this is a reachable case rather than a
  // contrived one: @givefood/models' EMAIL_RE is
  // `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` (index.ts:70), which accepts an apostrophe
  // and a double hyphen, so foodbankAddSub.ts's validation passes an address
  // like this one straight through to here. Concatenate it into the SQL text
  // instead of binding it and the statement either fails to parse or -- with
  // `--` in it -- has its tail commented out and does something other than
  // what it reads as, from a textarea any admin can paste into.
  it("binds the address rather than interpolating it, so quotes and comment markers stay data", async () => {
    const quoted = "o'brien--@example.org";

    const added = await insertConfirmedSubscribers(session, SALISBURY.id, [paste(quoted, 1)]);

    expect(added).toBe(1);
    // Byte for byte out of the column, not merely "a row exists".
    expect(allRows().map((row) => row.email)).toEqual([quoted]);
    // And the stored value still matches itself, so the ON CONFLICT lookup is
    // comparing the same text the INSERT wrote.
    expect(await insertConfirmedSubscribers(session, SALISBURY.id, [paste(quoted, 2)])).toBe(0);
  });

  // THE ONE LITERAL IN THE STATEMENT, and the whole reason this function
  // exists apart from subscribers.ts's insertSubscriber(), which hardcodes 0
  // for the public flow's double opt-in. Everything downstream gates on it:
  // foodbankTabs.ts:146 lists the admin's subscribers with
  // `WHERE foodbank_id = ? AND confirmed = 1`, and
  // subscribers.ts's getConfirmedSubscribersPage -- the newsletter fan-out --
  // pages with `AND confirmed = 1`. Flip this literal to 0 and the page still
  // reports "3 added", the rows are still in the table, and not one of them
  // is ever shown or ever emailed. Nothing raises.
  it("stamps confirmed = 1, the documented escape hatch out of double opt-in", async () => {
    await insertConfirmedSubscribers(session, SALISBURY.id, [paste("ada@example.org", 1)]);

    expect(allRows()[0]!.confirmed).toBe(1);
    // Not merely truthy: `confirmed` is INTEGER and the queries above compare
    // it to the literal 1, so a stored `true`, "1" or 2 would fail them.
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbanksubscriber WHERE foodbank_id = ? AND confirmed = 1").get(SALISBURY.id)).toMatchObject({ n: 1 });
  });

  it("leaves last_contacted NULL", async () => {
    // Django's field is `editable=False, null=True` and only the newsletter
    // send sets it (models/subscribers.py:18). A bulk add that stamped it
    // would mark brand-new addresses as already contacted and skip them in
    // whatever next reads it. MUTANT THIS KILLS: last_contacted added to the
    // column list and bound to `created` -- nothing else in this file looks
    // at the column, so it is this assertion or nothing.
    await insertConfirmedSubscribers(session, SALISBURY.id, [paste("ada@example.org", 1)]);

    expect(allRows()[0]!.last_contacted).toBeNull();
  });

  // Django's FoodbankSubscriber.save() denormalises the parent's name onto
  // every row (`self.foodbank_name = self.foodbank.name`,
  // models/subscribers.py:59). Migration 0019 deleted that column and
  // replaced it with a view. This test is the guard on that split: the INSERT
  // must name only surviving columns -- and it is not a formality, because
  // "restore parity with Django" is a plausible-sounding change that would
  // make every bulk add throw "no such column" against the real table.
  it("does not write foodbank_name, which 0019 dropped, and still reads it back through the view", async () => {
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('foodbanksubscriber')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).not.toContain("foodbank_name");

    await insertConfirmedSubscribers(session, SALISBURY.id, [paste("ada@example.org", 1)]);

    // foodbanksubscriber_full (0019:101-104) is what subscribers.ts's reads
    // actually select from, so this is the round trip that matters: the name
    // comes off the parent by join, live, instead of off a copy that goes
    // stale the moment the food bank is renamed.
    const view = db.prepare("SELECT * FROM foodbanksubscriber_full WHERE email = ?").get("ada@example.org") as unknown as {
      foodbank_name: string;
      foodbank_slug: string;
      confirmed: number;
    };
    expect(view.foodbank_name).toBe("Salisbury");
    expect(view.foodbank_slug).toBe("salisbury");
    expect(view.confirmed).toBe(1);
  });
});

describe("insertConfirmedSubscribers: ON CONFLICT (email, foodbank_id)", () => {
  it("skips an address that already subscribes and returns only the genuinely new count", async () => {
    // In Django this line was the 500: unique_together('email','foodbank')
    // raised IntegrityError out of an unguarded .save() loop. Here it is a
    // number the page can report, which is what
    // foodbankAddSub.ts:124 turns into "already subscribed".
    seedSubscriber({ foodbankId: SALISBURY.id, email: "ada@example.org", confirmed: 1, subKey: "existing-sub-01", unsubKey: "existing-uns-01" });

    const added = await insertConfirmedSubscribers(session, SALISBURY.id, [paste("ada@example.org", 1), paste("grace@example.org", 2)]);

    expect(added).toBe(1);
    expect(allRows().map((row) => row.email)).toEqual(["ada@example.org", "grace@example.org"]);
  });

  // DO NOTHING, not DO UPDATE -- and the difference is worth pinning because
  // it is invisible to the caller, which sees only a count. An address that
  // subscribed publicly but never clicked the confirmation link stays
  // unconfirmed after an admin pastes it in, and keeps the sub_key that was
  // already emailed to it (so the original link still works). SUSPECT, not
  // endorsed: an operator using the "escape hatch out of double opt-in" on a
  // pending address gets no escape and no warning -- the page tells them
  // "already subscribed" while the person still receives nothing. Django's
  // behaviour here was a 500, so there is no parity answer to copy.
  it("leaves the existing row completely untouched, including an unconfirmed one", async () => {
    seedSubscriber({
      foodbankId: SALISBURY.id,
      email: "ada@example.org",
      confirmed: 0,
      subKey: "pending-sub-001",
      unsubKey: "pending-uns-001",
      created: "2026-09-05 19:28:08.853000",
    });

    const added = await insertConfirmedSubscribers(session, SALISBURY.id, [paste("ada@example.org", 1)]);

    expect(added).toBe(0);
    expect(allRows()).toEqual([
      {
        id: 1,
        created: "2026-09-05 19:28:08.853000",
        last_contacted: null,
        foodbank_id: SALISBURY.id,
        email: "ada@example.org",
        confirmed: 0,
        sub_key: "pending-sub-001",
        unsub_key: "pending-uns-001",
      },
    ]);
  });

  // The conflict target is the PAIR. sub_email_fb_uniq is
  // UNIQUE(email, foodbank_id) (0004:25), matching Django's
  // unique_together('email','foodbank'), and one person subscribing to two
  // food banks is ordinary. A target of `(email)` alone would not even
  // compile against this schema, but a foodbankId that failed to reach the
  // binding would silently make the second food bank's add a no-op reported
  // as "already subscribed".
  //
  // The add here goes to DEVIZES (id 2) while the existing row belongs to
  // SALISBURY (id 1), on purpose: the argument has to be carried through to
  // the column for this to pass. A mutant that bound a constant 1 -- or any
  // rearrangement that let the caller's foodbankId go unused -- survives every
  // other test in this file, because every other test uses one food bank.
  it("writes to the food bank it was given, and treats the same address elsewhere as a separate subscription", async () => {
    seedSubscriber({ foodbankId: SALISBURY.id, email: "ada@example.org", confirmed: 1, subKey: "salisbury-sub-1", unsubKey: "salisbury-uns-1" });

    const added = await insertConfirmedSubscribers(session, DEVIZES.id, [paste("ada@example.org", 1)]);

    expect(added).toBe(1);
    expect(rowsFor(DEVIZES.id).map((row) => row.email)).toEqual(["ada@example.org"]);
    // The other food bank's row must be exactly as it was -- same keys, same
    // id, nothing rewritten by a statement that thought it owned the address.
    expect(rowsFor(SALISBURY.id)).toEqual([
      {
        id: 1,
        created: "2026-09-05 19:28:08.853000",
        last_contacted: null,
        foodbank_id: SALISBURY.id,
        email: "ada@example.org",
        confirmed: 1,
        sub_key: "salisbury-sub-1",
        unsub_key: "salisbury-uns-1",
      },
    ]);
  });

  // The same address twice in ONE paste. foodbankAddSub.ts:96-102 already
  // removes these upstream and counts them separately, but the statements in
  // a batch are applied in order against the same transaction, so the second
  // one conflicts with the first even though neither existed when the batch
  // was built. Without that, "N added" would over-report and the operator
  // would think two people were subscribed.
  it("collapses a repeat inside the same paste to one row", async () => {
    const added = await insertConfirmedSubscribers(session, SALISBURY.id, [paste("ada@example.org", 1), paste("ada@example.org", 2)]);

    expect(added).toBe(1);
    // First writer wins: DO NOTHING keeps row 1's keys, not row 2's -- both
    // of them, because a DO UPDATE that rewrote only one would leave a row
    // whose confirm link and unsubscribe link came from different mintings.
    expect(allRows().map((row) => [row.email, row.sub_key, row.unsub_key])).toEqual([
      ["ada@example.org", "sub0000000000001", "uns0000000000001"],
    ]);
  });

  // SUSPECT, pinned as-is. Django lowercased in the model's save()
  // (models/subscribers.py:43), BEFORE unique_together ever saw the value, so
  // "Ada@Example.org" and "ada@example.org" could never both exist. This
  // function does not lowercase; sub_email_fb_uniq is a plain TEXT index with
  // SQLite's default BINARY collation, so both rows insert and one person
  // gets two copies of every newsletter with two different unsubscribe links.
  // The port relies entirely on its caller (foodbankAddSub.ts:86, and
  // routes/wfbn/updates.ts on the public side) to lowercase first -- a
  // guarantee Django held structurally and this layer does not.
  it("does not lowercase, so a differently-cased address inserts a second row", async () => {
    seedSubscriber({ foodbankId: SALISBURY.id, email: "ada@example.org", confirmed: 1, subKey: "existing-sub-01", unsubKey: "existing-uns-01" });

    const added = await insertConfirmedSubscribers(session, SALISBURY.id, [paste("Ada@Example.org", 1)]);

    expect(added).toBe(1);
    expect(allRows().map((row) => row.email)).toEqual(["ada@example.org", "Ada@Example.org"]);
  });
});

describe("insertConfirmedSubscribers: the created timestamp", () => {
  // Ticket #9. D1 stores datetimes as TEXT and SQLite compares TEXT
  // lexicographically, so the SEPARATOR decides the sort order before the
  // clock does: "T" is 0x54 and " " is 0x20, so any toISOString() value sorts
  // after every Django-format value from the same day whatever the time.
  //
  // Read this test next to the module's own comment at adminSubscribers.ts:43
  // ("Same \"T\"-separated ISO string ..."), inherited from subscribers.ts:21.
  // That comment is STALE -- pyNow() has written Django's space-separated
  // format since ticket #9 -- and it describes precisely the bug the format
  // was changed to fix. Anyone "restoring" what the comment claims would
  // reintroduce it, which is why the assertion is on the literal string.
  it("stamps Django's space-separated microsecond format, not toISOString", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-05T08:00:00.000Z") });

    await insertConfirmedSubscribers(session, SALISBURY.id, [paste("ada@example.org", 1)]);

    expect(allRows()[0]!.created).toBe("2026-09-05 08:00:00.000000");
  });

  // pyNow() is called ONCE, above the map, so every address in a paste shares
  // a timestamp. Worth pinning both ways round: it is what makes a bulk add
  // identifiable as one action in the admin's list, and it means `created`
  // cannot be used to recover the order within a paste.
  //
  // MUTANT THIS KILLS: `bind(created, ...)` -> `bind(pyNow(), ...)`, i.e. the
  // clock read per row instead of per paste. A frozen-clock assertion cannot
  // see it -- freezing time makes the two indistinguishable, which is exactly
  // why that mutant walked through the previous version of this test. The
  // one-shot return value is the tell: with the call hoisted, all three rows
  // carry it; with the call inside the map, only the first does and the other
  // two carry the real wall clock.
  it("reads the clock once for the whole paste, not once per address", async () => {
    pyNowSpy.mockReturnValueOnce("2020-02-29 23:59:59.999000");

    await insertConfirmedSubscribers(session, SALISBURY.id, [paste("ada@example.org", 1), paste("grace@example.org", 2), paste("hedy@example.org", 3)]);

    expect(pyNowSpy).toHaveBeenCalledTimes(1);
    expect(allRows().map((row) => row.created)).toEqual([
      "2020-02-29 23:59:59.999000",
      "2020-02-29 23:59:59.999000",
      "2020-02-29 23:59:59.999000",
    ]);
  });

  // The ticket-#9 failure, executed rather than argued. The clock is frozen
  // at 08:00 and the migrated row was written at 19:28 the SAME day, so
  // chronologically the migrated row is the newer of the two -- and
  // adminStats.ts's `WHERE created >= ?` windows and every `ORDER BY created
  // DESC` in the admin depend on the text agreeing with that.
  it("sorts chronologically against rows the Postgres copy migrated", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-05T08:00:00.000Z") });
    seedSubscriber({
      foodbankId: SALISBURY.id,
      email: "grace@example.org",
      confirmed: 1,
      subKey: "migrated-sub-01",
      unsubKey: "migrated-uns-01",
      created: "2026-09-05 19:28:08.853000",
    });

    await insertConfirmedSubscribers(session, SALISBURY.id, [paste("ada@example.org", 1)]);

    const newest = db.prepare("SELECT email FROM foodbanksubscriber ORDER BY created DESC LIMIT 1").get() as unknown as { email: string };
    expect(newest.email).toBe("grace@example.org");

    // And the counterexample, run in the same engine: the toISOString
    // spelling of the very same 08:00 instant compares GREATER than the 19:28
    // migrated row, which would have put the wrong row at the top of that
    // query. This is the comparison that silently dropped 31 of 46
    // foodbankchange rows out of the dashboard's 24-hour window.
    const wrong = db.prepare("SELECT ('2026-09-05T08:00:00.000Z' > '2026-09-05 19:28:08.853000') AS inverted").get() as unknown as { inverted: number };
    expect(wrong.inverted).toBe(1);
  });
});

describe("insertConfirmedSubscribers: one batch, applied atomically", () => {
  it("sends exactly one batch holding one statement per row", async () => {
    await insertConfirmedSubscribers(session, SALISBURY.id, [paste("ada@example.org", 1), paste("grace@example.org", 2), paste("hedy@example.org", 3)]);

    // N round trips instead of one is not a correctness bug on its own, but
    // it is what costs the atomicity below -- a loop of awaited .run() calls
    // reproduces Django's partial-application defect exactly.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  // D1 caps a single statement at 100 bound parameters. This module sends one
  // single-row INSERT per address -- five bindings each, always -- so the cap
  // is unreachable however long the paste is. Built as one multi-row
  // `VALUES (...),(...)` list instead, the same code would pass every
  // hand-test up to twenty addresses (20 x 5 = exactly 100) and start failing
  // at the twenty-first, which is an entirely ordinary size for the page this
  // feeds. So the boundary is exercised AT 20, one OVER at 21, and well past
  // it at 60 -- a size where a chunker added "for safety" would also show up,
  // as more than one batch.
  it("keeps five bindings per statement at, one over, and far past D1's 100-parameter cap", async () => {
    // Distinct key ranges per size: sub_key_idx and unsub_key_idx are UNIQUE
    // across the whole table (0004:27-28), so reusing paste()'s counter
    // between the three calls would collide rather than test anything.
    for (const [size, keyBase] of [[20, 1000], [21, 2000], [60, 3000]] as const) {
      const rows = Array.from({ length: size }, (_, i) => paste(`p${size}n${i}@example.org`, keyBase + i));
      expect(await insertConfirmedSubscribers(session, SALISBURY.id, rows)).toBe(size);
    }

    // Content, not a count: every address is present, exactly once, in the
    // order it was pasted. A length assertion accepts a long paste that came
    // back reordered or with one address written twice and another not at all
    // -- naming all 101 of them does not, and it is one of the assertions
    // that kills the mutant which sends the statements in reverse order.
    expect(allRows().map((row) => row.email)).toEqual([
      ...Array.from({ length: 20 }, (_, i) => `p20n${i}@example.org`),
      ...Array.from({ length: 21 }, (_, i) => `p21n${i}@example.org`),
      ...Array.from({ length: 60 }, (_, i) => `p60n${i}@example.org`),
    ]);
    // One batch per call, holding one statement per address -- never a second
    // batch, at any of the three sizes.
    expect(batches.map((batch) => batch.length)).toEqual([20, 21, 60]);
    const statements = batches.flat();
    expect(new Set(statements.map((statement) => statement.params.length))).toEqual(new Set([5]));
    // One statement text shared by every row -- so it is a repeated
    // single-row insert, not a generated list that grows with the input.
    expect(new Set(statements.map((statement) => statement.sql)).size).toBe(1);
  });

  it("does not go near the database for an empty list", async () => {
    const added = await insertConfirmedSubscribers(session, SALISBURY.id, []);

    expect(added).toBe(0);
    // The early return, not just a zero. Submitting the form with an empty
    // textarea (or a paste of nothing but blank lines, which
    // foodbankAddSub.ts filters out before it gets here) must not spend a D1
    // round trip -- and `session.batch([])` is a statement list D1 has no
    // reason to accept. MUTANTS THIS KILLS: the guard deleted outright, and
    // the guard's condition weakened to something never true -- both of which
    // still return 0 and are invisible to an assertion on the return value
    // alone, which is why `prepared` and `batches` are asserted instead.
    expect(prepared).toEqual([]);
    expect(batches).toEqual([]);
  });

  // The fix for Django's worst behaviour here, made visible. sub_key_idx and
  // unsub_key_idx are UNIQUE (0004:27-28) and the ON CONFLICT clause names
  // only the (email, foodbank_id) pair, so a key collision is NOT swallowed
  // -- it raises. Two rows sharing a sub_key is not hypothetical: it is
  // exactly what minting keys from a millisecond-resolution clock inside one
  // request used to produce, which is why subscriberKeys.ts added a per-row
  // nonce.
  //
  // What matters is what survives the failure. Django committed every line
  // above the bad one and abandoned every line below it; one batch means the
  // transaction rolls back whole, so the operator can fix the paste and
  // resubmit it without wondering which half already went in.
  it("writes nothing at all when one statement in the batch fails", async () => {
    const collide: AdminSubscriberInsert[] = [
      { email: "ada@example.org", subKey: "duplicate-key-1", unsubKey: "uns0000000000001" },
      { email: "grace@example.org", subKey: "duplicate-key-1", unsubKey: "uns0000000000002" },
      { email: "hedy@example.org", subKey: "sub0000000000003", unsubKey: "uns0000000000003" },
    ];

    await expect(insertConfirmedSubscribers(session, SALISBURY.id, collide)).rejects.toThrow(/UNIQUE constraint failed: foodbanksubscriber\.sub_key/);

    // Not "two rows" and not "one row": none. The first address had already
    // been applied inside the transaction when the second one raised.
    expect(allRows()).toEqual([]);
  });
});

describe("insertConfirmedSubscribers: counting", () => {
  it("adds up meta.changes across the batch rather than counting the rows it sent", async () => {
    seedSubscriber({ foodbankId: SALISBURY.id, email: "grace@example.org", confirmed: 1, subKey: "existing-sub-01", unsubKey: "existing-uns-01" });

    const added = await insertConfirmedSubscribers(session, SALISBURY.id, [
      paste("ada@example.org", 1),
      paste("grace@example.org", 2), // already there -> 0 changes
      paste("hedy@example.org", 3),
    ]);

    // `rows.length` would say 3 and the page would report "3 added, 0 already
    // subscribed" -- foodbankAddSub.ts:124 derives `already` by subtracting
    // this number, so an over-count does not just inflate one figure, it
    // hides the other one entirely.
    expect(added).toBe(2);
  });

  // The one place a real database cannot reach: `?? 0` guards against a
  // result whose meta carries no `changes`. D1 documents the field, so this
  // is defensive -- but `n + undefined` is NaN, and NaN propagates through
  // foodbankAddSub.ts's arithmetic into a report reading "NaN added, NaN
  // already subscribed". Cheap to hold, so held.
  it("treats a missing meta.changes as zero rather than turning the count into NaN", async () => {
    const statement = { bind: () => statement };
    const blind = {
      prepare: () => statement,
      batch: async (statements: unknown[]) => statements.map(() => ({ success: true, meta: {} })),
    } as unknown as Session;

    const added = await insertConfirmedSubscribers(blind, SALISBURY.id, [paste("ada@example.org", 1), paste("grace@example.org", 2)]);

    expect(added).toBe(0);
    expect(Number.isNaN(added)).toBe(false);
  });
});
