import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertConstituencySubscriber } from "./constituencySubscribers";
import type { Session } from "./types";

// gfwrite `email` (gfwrite/views.py:69-85) -- the "email your MP about food
// banks in your constituency" page. Tick the subscribe box and Django built a
// ConstituencySubscriber and saved it; this module is that save().
//
// WHY THIS FILE RUNS A REAL DATABASE. The module is one INSERT and a call to
// pyNow(), and EVERY way it can be wrong is silent. A transposed pair of
// bindings puts the constituent's name in the email column and their address
// in the name column -- both are TEXT, so nothing raises, nothing logs, and
// the page still renders the draft letter. A `created` written with
// toISOString() sorts wrongly against every ETL-migrated row in the same
// table. A column that a later migration dropped keeps being named until the
// first real insert throws. A fake session handing back canned rows agrees
// with every one of those, because there is nothing here BUT the SQL. So the
// fixture below is Node's own SQLite executing the module's real statement
// against the real schema.
//
// AND IT IS A WRITE-ONLY TABLE, which raises the stakes rather than lowering
// them. PLAN.md, quoted verbatim in the module header and again in
// 0007_write.sql: "Written by gfwrite/views.py:80-85, read by nothing, ever.
// No send path, no admin view, no cron." Nothing downstream reads these rows,
// so nothing downstream can ever notice they are wrong. This file is the only
// thing that will.
//
// THE SCHEMA IS THE MIGRATION FILES THEMSELVES, applied in order, not a
// transcribed CREATE TABLE -- the same convention adminSubscribers.test.ts
// documents, and for the same reason: migration 0019 dropped `foodbank_name`
// off five tables and four queries elsewhere went on naming a column that no
// longer existed, silently, until someone measured /dashboard/beautybanks/. A
// hand-copied schema in a test file is a second copy of the truth, and it
// drifts exactly the same way.
//
// MUTATION-TESTED, per TESTING.md's convention: the module was copied into a
// scratchpad, broken 38 different ways -- every binding swap and column-list
// permutation, the lowercasing dropped/inverted/locale-tainted/applied to the
// wrong field, pyNow() replaced by toISOString(), `created` hoisted to module
// scope so it froze for the isolate's lifetime, the `await` dropped, failures
// swallowed, values interpolated instead of bound, the id and last_contacted
// written, OR IGNORE / OR REPLACE / ON CONFLICT / RETURNING appended -- and
// the suite re-run against each. All 38 fail here. One of them (a bare `ON
// CONFLICT DO NOTHING`) originally survived every assertion in this file and
// is why the "sends a plain INSERT" test at the bottom exists.

type Bindable = null | number | bigint | string | Uint8Array;

interface Sent {
  sql: string;
  params: Bindable[];
}

// Adapts node:sqlite to the slice of the D1 Sessions API this module uses:
// prepare().bind().run(). bind() returns a NEW statement rather than mutating
// the prepared one, matching D1's immutable prepared statements.
//
// `prepared` and `sent` are recorded separately on purpose. `prepared` proves
// how many round trips were spent (and that an early return really did skip
// the database); `sent` carries the bound parameter list, which is how the
// D1-100-bound-parameter tests below can see the arity of the statement rather
// than inferring it from the rows that came out.
function d1Session(db: DatabaseSync) {
  const prepared: string[] = [];
  const sent: Sent[] = [];

  function statement(sql: string, params: Bindable[]) {
    return {
      sql,
      params,
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      async run() {
        // Yields to the macrotask queue BEFORE touching SQLite, because D1 is
        // a network round trip and node:sqlite is not. Without this the write
        // would land the instant .run() is called, and a mutant that dropped
        // the `await` -- leaving a floating promise the Worker may never wait
        // for -- would still pass every assertion in this file. With it, an
        // un-awaited write is exactly what it is in production: a row that has
        // not been written yet when the response goes out.
        await new Promise((resolve) => setTimeout(resolve, 0));
        sent.push({ sql, params });
        const { changes, lastInsertRowid } = db.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) } };
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

interface SubscriberRow {
  id: number;
  created: string;
  last_contacted: string | null;
  email: string;
  name: string | null;
  parliamentary_constituency_id: number;
  parliamentary_constituency_name: string | null;
}

const SALISBURY = { id: 1, name: "Salisbury", slug: "salisbury" };
const DEVIZES = { id: 2, name: "East Wiltshire", slug: "east-wiltshire" };

let db: DatabaseSync;
let session: Session;
let prepared: string[];
let sent: Sent[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  for (const constituency of [SALISBURY, DEVIZES]) {
    // Every NOT NULL column 0001_core.sql declares on parliamentaryconstituency
    // (slug, mp_parl_id, centroid), filled with whatever satisfies it. These
    // rows exist so the "the port trusts the caller's denormalised name" test
    // has a real name to disagree with -- constituencysubscriber itself has NO
    // foreign key (0007_write.sql:5, "No FK (§4.5, same as every other
    // table)"), so nothing here is required for an insert to succeed.
    db.prepare(
      "INSERT INTO parliamentaryconstituency (id, name, slug, country, mp, mp_party, mp_parl_id, mp_display_name, email, centroid) " +
        "VALUES (?, ?, ?, 'England', 'A N Other MP', 'Independent', ?, 'A N Other', 'a.other.mp@parliament.uk', '51.0688,-1.7945')",
    ).run(constituency.id, constituency.name, constituency.slug, 4000 + constituency.id);
  }
  ({ session, prepared, sent } = d1Session(db));
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

// The shape workers/site/src/routes/write/index.ts:276-281 builds. Defaults
// chosen so every value is distinguishable from every other -- four adjacent
// TEXT/INTEGER columns holding plausible-looking strings is precisely the
// arrangement in which a transposed binding is invisible.
function details(overrides: Partial<Parameters<typeof insertConstituencySubscriber>[1]> = {}) {
  return {
    email: "ada@example.org",
    name: "Ada Lovelace",
    parliamentaryConstituencyId: SALISBURY.id,
    parliamentaryConstituencyName: SALISBURY.name,
    ...overrides,
  };
}

// Spread into a plain object: node:sqlite hands back null-prototype rows, and
// toEqual against those reads badly.
function allRows(): SubscriberRow[] {
  return db
    .prepare("SELECT * FROM constituencysubscriber ORDER BY id")
    .all()
    .map((row) => ({ ...row }) as unknown as SubscriberRow);
}

function onlyRow(): SubscriberRow {
  const rows = allRows();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

// A row that reached the table by some route other than this function -- the
// one-off Postgres copy (tools/pg-to-d1). Its id is a real Postgres sequence
// value and its `created` is in the format Django's str(datetime) produces,
// which is what the ordering tests below compare against.
function seedMigratedRow(row: { id: number; email: string; created?: string }): void {
  db.prepare(
    "INSERT INTO constituencysubscriber (id, created, last_contacted, email, name, parliamentary_constituency_id, parliamentary_constituency_name) " +
      "VALUES (?, ?, NULL, ?, 'Grace Hopper', ?, ?)",
  ).run(row.id, row.created ?? "2026-09-05 19:28:08.853000", row.email, SALISBURY.id, SALISBURY.name);
}

describe("insertConstituencySubscriber: what lands in the table", () => {
  it("writes one row with every value in its own column", async () => {
    await insertConstituencySubscriber(session, details());

    // Column by column, not "a row exists". email/name and
    // parliamentary_constituency_name are three adjacent nullable TEXT
    // columns; any permutation of them inserts without complaint, and since
    // nothing ever reads this table there is no downstream page that would
    // look wrong.
    const row = onlyRow();
    expect(row.email).toBe("ada@example.org");
    expect(row.name).toBe("Ada Lovelace");
    expect(row.parliamentary_constituency_id).toBe(SALISBURY.id);
    expect(row.parliamentary_constituency_name).toBe("Salisbury");
  });

  it("leaves last_contacted NULL", async () => {
    // Django's field is `editable=False, null=True` (subscribers.py:66) and
    // its own comment says only a send path would ever set it -- and there is
    // no send path. A value here would be a claim that this address has
    // already been written to.
    await insertConstituencySubscriber(session, details());

    expect(onlyRow().last_contacted).toBeNull();
  });

  it("returns undefined -- the caller gets no id back", async () => {
    // Pinned because the alternative is a plausible-looking refactor: adding
    // `RETURNING id` (as foodbankAdmin.ts's insertFoodbank does) would need
    // .first() instead of .run() and would change the D1 round trip's shape.
    // Nothing reads this table, so nobody needs the id, and the route ignores
    // the result entirely.
    await expect(insertConstituencySubscriber(session, details())).resolves.toBeUndefined();
  });

  it("omits id, so SQLite assigns the next rowid after the migrated Postgres ids", async () => {
    // The module header's claim, executed: "id is omitted so SQLite assigns
    // the next rowid itself, same as every other Worker-side insert in this
    // codebase." Django's id is a BigAutoField backed by a Postgres sequence
    // and the ETL copied those values across verbatim, so a mutant that bound
    // its own id -- or a "1" -- would collide with the copied rows. `INTEGER
    // PRIMARY KEY` picks max(rowid)+1, which is 4243 here, not 1.
    seedMigratedRow({ id: 4242, email: "grace@example.org" });

    await insertConstituencySubscriber(session, details());

    expect(allRows().map((row) => row.id)).toEqual([4242, 4243]);
  });
});

describe("insertConstituencySubscriber: the email lowercasing", () => {
  // ConstituencySubscriber.save() lowercases before storing
  // (givefood/models/subscribers.py:72-74, "Ensure email address is
  // lowercase"). The port does it HERE, in the model layer, rather than in the
  // route -- which is the whole reason the module carries a paragraph about
  // it. Move it to the caller and this test is the thing that notices.
  it("lowercases the stored address, matching ConstituencySubscriber.save()", async () => {
    await insertConstituencySubscriber(session, details({ email: "Ada.Lovelace@Example.ORG" }));

    expect(onlyRow().email).toBe("ada.lovelace@example.org");
  });

  // THE SPLIT THIS MODULE EXISTS TO PRESERVE. views.py:76-77 reads
  // `request.POST.get("email")` for the draft letter's from_field and for the
  // Mailchannels from address, and Django's save() mutated only the model
  // instance -- never request.POST. So the constituent sees their address
  // exactly as they typed it while the stored row is lowercased.
  //
  // A one-character mutant (`params.email = params.email.toLowerCase()`
  // instead of lowercasing at the binding) passes every other test in this
  // file and silently rewrites the From: header of the letter the constituent
  // is about to send to their MP.
  it("does not mutate the caller's own params object", async () => {
    const params = details({ email: "Ada.Lovelace@Example.ORG" });

    await insertConstituencySubscriber(session, params);

    expect(params.email).toBe("Ada.Lovelace@Example.ORG");
  });

  it("lowercases ONLY the email -- not the name, not the constituency name", async () => {
    // Django lowercases `self.email` and nothing else; `name` is the human's
    // own capitalisation of their own name and must survive. A blanket
    // .toLowerCase() over the params would be an easy tidy-up to make and
    // would quietly downcase every subscriber's name.
    await insertConstituencySubscriber(
      session,
      details({ email: "ADA@EXAMPLE.ORG", name: "Ada LOVELACE", parliamentaryConstituencyName: "Salisbury" }),
    );

    const row = onlyRow();
    expect(row.email).toBe("ada@example.org");
    expect(row.name).toBe("Ada LOVELACE");
    expect(row.parliamentary_constituency_name).toBe("Salisbury");
  });

  // TESTING.md's rule: a parity claim is checked by running Python, not by
  // reasoning about it. Every code point from U+0000 to U+1C88 was lowercased
  // by both CPython 3 (`str.lower()`) and V8 (`String.prototype.toLowerCase`)
  // and compared: ZERO disagreements, including the full-mapping cases that
  // change length ('İ' U+0130 -> "i" + U+0307 combining dot, in both) and
  // 'ẞ' U+1E9E -> 'ß'. The 55 divergences that exist across the whole BMP+SMP
  // start at U+1C89 and are all Unicode-version skew on Old Cyrillic,
  // Garay and Medefaidrin letters -- nothing an email address can carry.
  //
  // This matters because Django lowercased before Postgres ever saw the value
  // and the port lowercases before D1 does; if the two engines disagreed, the
  // same subscriber submitting the same address either side of the cutover
  // would be stored under two different strings.
  it("agrees with CPython's str.lower() on the non-ASCII an address can hold", async () => {
    await insertConstituencySubscriber(session, details({ email: "ÀDA.İẞ@EXAMPLE.ORG" }));

    // Verified against python3: 'ÀDA.İẞ@EXAMPLE.ORG'.lower() is exactly this.
    expect(onlyRow().email).toBe("àda.i̇ß@example.org");
  });
});

describe("insertConstituencySubscriber: values are bound, not formatted", () => {
  // Django's ORM parameterised everything; a hand-written INSERT is where that
  // guarantee can be lost. `name` comes straight off an unauthenticated public
  // form (views.py:76 / routes/write/index.ts:230), so this is the one input
  // on the site that reaches a write statement with no cleaning at all.
  it("stores a name full of SQL syntax verbatim and leaves the table standing", async () => {
    const hostile = "Robert'); DROP TABLE constituencysubscriber;--";

    await insertConstituencySubscriber(session, details({ name: hostile }));

    expect(onlyRow().name).toBe(hostile);
    expect(db.prepare("SELECT COUNT(*) AS n FROM constituencysubscriber").get()).toMatchObject({ n: 1 });
  });

  it("stores values exactly as given -- no trimming, no normalising", async () => {
    // views.py:76-77 uses `request.POST.get(...)` directly rather than
    // form.cleaned_data, so the value Django stored was the RAW, un-trimmed
    // POST value -- a divergence routes/write/index.ts:220-229 documents at
    // length and reproduces on purpose ("validate trimmed, use raw"). If this
    // layer started trimming, the port would stop matching the original in the
    // one respect its caller went out of its way to preserve.
    await insertConstituencySubscriber(session, details({ email: "  Ada@Example.org  ", name: "  Ada  " }));

    const row = onlyRow();
    expect(row.email).toBe("  ada@example.org  ");
    expect(row.name).toBe("  Ada  ");
  });

  // SUSPECT, pinned as-is. Django's columns are varchar: email 254, name 100,
  // parliamentary_constituency_name 100 (givefood/migrations/0001_initial.py:
  // 468-477, confirmed against Django 5.2.6's own defaults -- models.EmailField
  // is 254 while forms.EmailField is 320). Postgres would have raised
  // DataError on anything longer. 0007_write.sql declares plain TEXT, which
  // has no length at all, and the route's own validation caps the email at the
  // FORM's 320 -- so an address between 255 and 320 characters passes
  // validation here and is stored, where the original would have 500ed.
  //
  // Left alone deliberately: this table is write-only, nothing downstream
  // reads or re-serialises these values, and truncating would lose data that
  // Postgres would simply have refused. Recorded so that the divergence is
  // known rather than discovered.
  it("accepts values longer than the varchar limits Postgres enforced", async () => {
    const longEmail = `${"a".repeat(290)}@example.org`; // 302 chars: form-valid, varchar(254)-invalid
    const longName = "N".repeat(300);

    await insertConstituencySubscriber(session, details({ email: longEmail, name: longName }));

    const row = onlyRow();
    // Content first, length second. A `.slice(0, 254)` / `.slice(0, 100)`
    // "safety" truncation is the mutant these numbers exist to kill, but a
    // length-only assertion would also pass for a value that arrived mangled
    // some other way, and mangling 300 characters of somebody's name is not
    // obviously less likely than truncating it.
    expect(row.email).toBe(longEmail);
    expect(row.name).toBe(longName);
    expect(row.email).toHaveLength(302); // past varchar(254)
    expect(row.name).toHaveLength(300); // past varchar(100)
  });
});

describe("insertConstituencySubscriber: the created timestamp", () => {
  // Ticket #9, and the single most consequential line in the module. D1 stores
  // datetimes as TEXT and SQLite compares TEXT lexicographically, so the
  // SEPARATOR decides the ordering before the clock does: "T" is 0x54, " " is
  // 0x20, so any toISOString() value sorts after every Django-format value
  // from the same day whatever the actual time.
  //
  // Read this next to the module's OWN comment at constituencySubscribers.ts:
  // 22-24 -- `"T"-separated, millisecond-precision` -- inherited from
  // subscribers.ts:21. That comment is STALE: pyNow() has written Django's
  // space-separated six-digit format since ticket #9, and what the comment
  // describes is exactly the bug that change was made to fix. Anyone
  // "restoring" the documented behaviour would reintroduce it, which is why
  // the assertion is on the literal string rather than a regex.
  it("stamps Django's space-separated microsecond format, not toISOString", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-05T08:00:00.000Z") });

    await insertConstituencySubscriber(session, details());

    const { created } = onlyRow();
    expect(created).toBe("2026-09-05 08:00:00.000000");
    expect(created).not.toContain("T");
    expect(created).not.toContain("Z");
  });

  it("always pads to six fractional digits, so every value is the same length", async () => {
    // pyDatetime pads JavaScript's three milliseconds out to Python's six
    // microseconds. Equal-length strings are what make lexicographic order and
    // chronological order agree exactly -- ".7" would sort after ".007000".
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-05T08:00:00.007Z") });

    await insertConstituencySubscriber(session, details());

    expect(onlyRow().created).toBe("2026-09-05 08:00:00.007000");
  });

  it("sorts chronologically against a row the Postgres copy migrated", async () => {
    // The clock is frozen at 08:00 and the migrated row was written at 19:28
    // the SAME day, so the migrated row is genuinely the newer of the two and
    // any `ORDER BY created DESC` must say so.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-05T08:00:00.000Z") });
    seedMigratedRow({ id: 4242, email: "grace@example.org", created: "2026-09-05 19:28:08.853000" });

    await insertConstituencySubscriber(session, details());

    const newest = db.prepare("SELECT email FROM constituencysubscriber ORDER BY created DESC LIMIT 1").get() as unknown as { email: string };
    expect(newest.email).toBe("grace@example.org");

    // And the counterexample, run in the same engine rather than argued: the
    // toISOString spelling of that very same 08:00 instant compares GREATER
    // than the 19:28 migrated row. This is the comparison that returned the
    // wrong "latest published need" during the 2026-09-05 migration and
    // dropped 31 of 46 foodbankchange rows out of the dashboard's 24-hour
    // window.
    const wrong = db.prepare("SELECT ('2026-09-05T08:00:00.000Z' > '2026-09-05 19:28:08.853000') AS inverted").get() as unknown as { inverted: number };
    expect(wrong.inverted).toBe(1);
  });

  // Migration 0022 normalised the ISO-shaped timestamps the port had already
  // written -- twenty columns across eleven tables, listed from a scan of the
  // live data. constituencysubscriber.created is NOT among them, which is only
  // safe as long as this function keeps writing the Django format: there is no
  // repair pass for this column, and no reader that would ever reveal a bad
  // value. Asserting the shape the migration would have looked for keeps that
  // implicit dependency visible.
  it("writes a value migration 0022's ISO detector would not match", async () => {
    await insertConstituencySubscriber(session, details());

    const iso = db.prepare("SELECT COUNT(*) AS n FROM constituencysubscriber WHERE created LIKE '____-__-__%Z'").get() as unknown as { n: number };
    expect(iso.n).toBe(0);
  });
});

describe("insertConstituencySubscriber: the statement it sends", () => {
  it("spends exactly one round trip, with exactly five bound parameters", async () => {
    await insertConstituencySubscriber(session, details());

    expect(prepared).toHaveLength(1);
    expect(sent).toHaveLength(1);
    // D1 caps a single statement at 100 bound parameters. Five is a fixed
    // arity -- there is no list, no chunking and no variable-length IN clause
    // here -- so the cap is structurally unreachable. Asserted anyway because
    // "denormalise a few more constituency fields onto the row" is an ordinary
    // change to make, and the number is where it would first be visible.
    expect(sent[0]!.params).toHaveLength(5);
  });

  it("binds the five values in the order the column list declares them", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-05T08:00:00.000Z") });

    await insertConstituencySubscriber(session, details({ email: "ADA@EXAMPLE.ORG" }));

    // The bound list, not just the resulting row -- so that a reordering which
    // happens to be symmetrical in the fixture (two TEXT columns swapped, both
    // populated) cannot pass. Note the lowercasing is visible HERE, at the
    // binding, which is what proves it happens on the way to the database
    // rather than to the caller's object.
    expect(sent[0]!.params).toEqual(["2026-09-05 08:00:00.000000", "ada@example.org", "Ada Lovelace", SALISBURY.id, "Salisbury"]);
  });

  // The migration-0019 guard. That migration deleted the denormalised
  // `foodbank_name` column off five tables and replaced it with a view, and
  // four queries elsewhere went on naming it -- silently, because a query that
  // names a dropped column only fails when it actually runs, and the pages
  // that ran it were not being watched. constituencysubscriber kept ITS
  // denormalised column (parliamentary_constituency_name, 0007:12), so the two
  // tables now follow opposite conventions and a tidy-up that harmonised them
  // would break every subscribe on the /write/ page.
  it("names only columns that exist on the table, and never id or last_contacted", async () => {
    await insertConstituencySubscriber(session, details());

    const columns = db
      .prepare("SELECT name FROM pragma_table_info('constituencysubscriber')")
      .all()
      .map((row) => (row as unknown as { name: string }).name);
    const written = /INSERT INTO constituencysubscriber \(([^)]*)\)/.exec(sent[0]!.sql)?.[1]?.split(",").map((c) => c.trim());

    expect(written).toEqual(["created", "email", "name", "parliamentary_constituency_id", "parliamentary_constituency_name"]);
    for (const column of written!) expect(columns).toContain(column);
    // Omitted on purpose, both of them: id so SQLite continues the Postgres
    // sequence, last_contacted so the row is not born pre-contacted.
    expect(written).not.toContain("id");
    expect(written).not.toContain("last_contacted");
  });

  it("propagates a failed write instead of resolving quietly", async () => {
    // parliamentary_constituency_id is NOT NULL (0007:11). The route awaits
    // this call before rendering the draft letter, so a swallowed error would
    // mean the constituent is shown a page implying they are subscribed while
    // nothing was written. `await ... .run()` -- not a floating promise -- is
    // what makes the rejection reach the route's error handler.
    const broken = details({ parliamentaryConstituencyId: null as unknown as number });

    await expect(insertConstituencySubscriber(session, broken)).rejects.toThrow(/NOT NULL constraint failed: constituencysubscriber\.parliamentary_constituency_id/);
    expect(allRows()).toEqual([]);
  });
});

describe("insertConstituencySubscriber: the constituency it records", () => {
  it("writes to the constituency it was given, not a hardcoded one", async () => {
    // Every other test in this file uses SALISBURY, so a mutant that ignored
    // the argument and bound a constant would survive all of them. This one
    // subscribes to the OTHER constituency, which is the only way the
    // parameter has to be carried through for the assertion to hold.
    await insertConstituencySubscriber(session, details({ parliamentaryConstituencyId: DEVIZES.id, parliamentaryConstituencyName: DEVIZES.name }));

    const row = onlyRow();
    expect(row.parliamentary_constituency_id).toBe(DEVIZES.id);
    expect(row.parliamentary_constituency_name).toBe("East Wiltshire");
  });

  // DIVERGENCE FROM DJANGO, pinned rather than corrected. Django's save()
  // denormalised the name off the related object itself --
  // `self.parliamentary_constituency_name = self.parliamentary_constituency
  // .name` (subscribers.py:76-77) -- so the stored name could not disagree
  // with the constituency it pointed at. The port takes both from the caller
  // and never looks at the parliamentaryconstituency table, so the pair is
  // only as consistent as routes/write/index.ts:279-280 makes it.
  //
  // Parity holds today because that one caller passes `constituency.id` and
  // `constituency.name` off the same row it just loaded. Nothing in this layer
  // enforces it, which is what this test says out loud.
  it("stores the denormalised name it was handed, even when it contradicts the row", async () => {
    await insertConstituencySubscriber(session, details({ parliamentaryConstituencyId: SALISBURY.id, parliamentaryConstituencyName: "Somewhere Else Entirely" }));

    expect(onlyRow().parliamentary_constituency_name).toBe("Somewhere Else Entirely");
    // The real name, right there in the same database, unconsulted.
    const real = db.prepare("SELECT name FROM parliamentaryconstituency WHERE id = ?").get(SALISBURY.id) as unknown as { name: string };
    expect(real.name).toBe("Salisbury");
  });

  it("accepts NULL for the denormalised name", async () => {
    // parliamentaryconstituency.name is itself nullable (0001_core.sql:131),
    // so the caller's `constituency.name` is typed `string | null` and this
    // path is reachable rather than theoretical. Django would have stored None
    // in exactly the same circumstance, so NULL here is parity, not a gap.
    await insertConstituencySubscriber(session, details({ parliamentaryConstituencyName: null }));

    expect(onlyRow().parliamentary_constituency_name).toBeNull();
  });

  it("inserts against a constituency id that has no row, because there is no foreign key", async () => {
    // 0007_write.sql:5, verbatim: "No FK (§4.5, same as every other table)."
    // Django's ForeignKey WAS enforced by Postgres, so this is a real
    // difference in what the database will accept -- harmless here (the
    // constituency comes from a row the route has already loaded) but worth
    // knowing before anyone reads these rows expecting a guaranteed join.
    await insertConstituencySubscriber(session, details({ parliamentaryConstituencyId: 999_999, parliamentaryConstituencyName: "Nowhere" }));

    expect(onlyRow().parliamentary_constituency_id).toBe(999_999);
  });
});

describe("insertConstituencySubscriber: repeat subscriptions", () => {
  // Parity, and deliberately unlike FoodbankSubscriber. That model carries
  // `unique_together = ('email', 'foodbank')` (subscribers.py:27-28), backed
  // by sub_email_fb_uniq, and adminSubscribers.ts has an ON CONFLICT clause
  // to cope with it. ConstituencySubscriber's Meta declares only `app_label`
  // (subscribers.py:82-83) -- no unique_together at all -- so ticking the box
  // twice genuinely made two rows in Django, and makes two here.
  //
  // Adding a plausible-looking ON CONFLICT DO NOTHING would therefore be a
  // behaviour change dressed up as a hardening -- and, as the next test spells
  // out, one that no assertion on the resulting ROWS can detect.
  it("writes a second row for the same address rather than deduping", async () => {
    await insertConstituencySubscriber(session, details());
    await insertConstituencySubscriber(session, details());

    const rows = allRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.email)).toEqual(["ada@example.org", "ada@example.org"]);
    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });

  // THE ONE MUTANT IN THIS MODULE THAT NO ASSERTION ON THE ROWS CAN CATCH, and
  // the reason this test asserts the statement text rather than its effect.
  // Appending a bare `ON CONFLICT DO NOTHING` to the INSERT leaves all 25 of
  // the other tests here green: SQLite accepts the untargeted form with no
  // conflict target and no unique index whatsoever, and since this table has
  // nothing to conflict on, the clause does nothing at all today.
  //
  // An earlier version of the comment above claimed such a clause "would fail
  // against the real table anyway: there is no unique index for it to name".
  // Run against the real schema, that turns out to be true only of the
  // TARGETED form -- `ON CONFLICT (email) DO NOTHING` really does raise "ON
  // CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint" --
  // while the bare form is accepted silently. `INSERT OR IGNORE` and `INSERT
  // OR REPLACE` are likewise accepted and likewise inert.
  //
  // Which makes this a time bomb rather than a bug. It costs nothing until the
  // day someone adds the unique index the NEXT test guards against, at which
  // point a dormant DO NOTHING starts discarding subscriptions -- with no
  // exception, no row count anyone checks, and (this table being write-only)
  // no reader anywhere that could ever reveal the loss.
  it("sends a plain INSERT: no OR IGNORE, no OR REPLACE, no ON CONFLICT, no RETURNING", async () => {
    await insertConstituencySubscriber(session, details());

    const { sql } = sent[0]!;
    expect(sql.startsWith("INSERT INTO constituencysubscriber (")).toBe(true);
    expect(sql).not.toMatch(/\bON\s+CONFLICT\b/i);
    expect(sql).not.toMatch(/\bINSERT\s+OR\b/i);
    // The statement stops at the VALUES tuple. This pins the placeholder count
    // in the SQL itself (five, matching the five columns and the five bound
    // values asserted above) and rules out any trailing clause -- RETURNING
    // included -- that changes what D1 sends without changing what lands.
    expect(sql.trimEnd().endsWith("VALUES (?, ?, ?, ?, ?)")).toBe(true);
  });

  it("is backed by a non-unique index on the constituency, and nothing else", async () => {
    // consub_parlcon_idx (0007:14) mirrors the index Django's ForeignKey
    // created automatically. If it were ever declared UNIQUE, the second
    // constituent in a constituency to tick the box would get a 500 on a page
    // whose whole purpose is to help them write to their MP -- and the first
    // failure would be in production, not here, because the table starts
    // empty.
    const indexes = db
      .prepare("SELECT name, \"unique\" AS is_unique FROM pragma_index_list('constituencysubscriber')")
      .all()
      .map((row) => ({ ...row }) as unknown as { name: string; is_unique: number });

    expect(indexes).toEqual([{ name: "consub_parlcon_idx", is_unique: 0 }]);
  });
});
