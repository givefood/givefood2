import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSlugRedirectById,
  getSlugRedirectMap,
  getSlugRedirectsPage,
  slugRedirectOldSlugTaken,
  upsertSlugRedirect,
} from "./slugRedirects";
import type { Session } from "./types";

// slugRedirects.ts is five statements and no logic, and every one of its
// failure modes is SILENT. A wrong ORDER BY renders a perfectly good admin
// list in the wrong order. A uniqueness check that matches nothing returns
// "free" and lets the UNIQUE index throw a D1 error at the admin instead of
// a sentence. A map read that drops a row 404s a renamed food bank's old URL
// forever, for everyone, with nothing in the logs. None of that throws where
// it happens, which is why this file runs the real SQL against a real engine
// and asserts ROWS -- which slugs, in which order, holding which values --
// rather than shapes.
//
// The scar this repo already carries is migration 0019: it dropped four
// cached columns, four queries kept naming them, and /dashboard/beautybanks/
// was a live 500 nobody noticed until someone measured it. A fixture built
// from the MIGRATION (0016_slugredirect.sql, transcribed verbatim below,
// indexes included) rather than from SlugRedirectRow is what makes that
// class of drift fail here: a query naming a column the table no longer has
// dies with "no such column", loudly, in CI.
//
// WHY THE IMPORT IS A DYNAMIC ONE. packages/db's tsconfig pins
// `"types": ["@cloudflare/workers-types"]` and the package has no
// @types/node, so a plain `import { DatabaseSync } from "node:sqlite"` fails
// `pnpm typecheck` for everyone with TS2591. Routing the specifier through a
// const means TypeScript never tries to resolve the module, the shape is
// declared here, and the tests get a real engine without a dependency
// change. Copied from adminJobs.test.ts, which established the pattern.
//
// MUTATION-TESTED, 2026-09-07. The module was copied to a scratchpad and
// broken 51 ways -- ORDER BY flipped and deleted, WHERE predicates dropped,
// `IS NOT` swapped for `!=`, LIMIT off-by-oned, same-typed binds swapped,
// first-row-instead-of-all in both readers -- and every mutant was re-run
// against this file. 48 of 51 fail here. The three that do not are equivalent
// mutants, recorded so nobody wastes an afternoon trying to "close" them:
//
//   * `SELECT *` in place of the COLUMNS list, in either reader. The table has
//     exactly those five columns in exactly that order, so the two queries are
//     byte-identical TODAY. The explicit list earns its keep only against a
//     future migration, and asserting that would mean seeding a column the
//     real schema does not have -- which is the circular fixture this file
//     exists to avoid.
//   * `.bind(..., String(existingId))` on the UPDATE. `id` is an INTEGER
//     PRIMARY KEY, so SQLite applies INTEGER affinity to '4' and matches row
//     4. Equivalent in D1 for the same reason; a property of the engine, not
//     a gap here.
//
// Two controls were run alongside them to prove the harness was actually
// loading the mutant: a genuinely equivalent edit had to survive, and a
// renamed table had to fail. An earlier run of this battery reported all 51
// "killed" because a stale node on the PATH meant vitest never started and
// every non-zero exit was scored as a kill. Any future mutation run of this
// file must assert the test COUNT it observed, not just the exit code.
//
// THE D1 100-BOUND-PARAMETER LIMIT does not bite this module: nothing here
// builds a variable-length IN list or chunks its bindings, and the widest
// statement binds four (the INSERT). getSlugRedirectMap reads the whole
// table with no parameters at all -- which is its own risk, covered by the
// "reads every row" test below. If a future change adds an IN list here, it
// needs tests at 100 and 101.

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
const NODE_SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(/* @vite-ignore */ NODE_SQLITE)) as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

// migrations/0016_slugredirect.sql, verbatim -- columns, NOT NULLs and BOTH
// indexes.
//
// The UNIQUE index is not decoration here: it is the constraint
// slugRedirectOldSlugTaken exists to keep an admin from hitting, and the
// migration's own comment says why it must exist at all ("two rows with the
// same old_slug would make the KV blob's old->new map silently
// non-deterministic"). A fixture without it would let these tests set up a
// state the real database refuses, and would quietly turn the "duplicate is
// rejected" tests below into assertions about nothing.
//
// The created index is here because it changes which plan the engine picks
// for the list page's ORDER BY; a fixture without it tests a different query
// plan from production.
const SCHEMA = `
CREATE TABLE slugredirect (
  id INTEGER PRIMARY KEY,
  old_slug TEXT NOT NULL,            -- CharField(max_length=200, unique=True)
  new_slug TEXT NOT NULL,            -- CharField(max_length=200)
  created TEXT NOT NULL,
  modified TEXT NOT NULL
);
CREATE UNIQUE INDEX slugredirect_old_slug_uniq ON slugredirect(old_slug);
CREATE INDEX slugredirect_created_idx ON slugredirect(created DESC);
`;

// The slice of the D1 Sessions API this module uses, over node:sqlite.
// Copied from adminJobs.test.ts rather than reinvented so the packages/db
// suites agree about what D1 does -- in particular that `.first()` answers
// null, not undefined, for no row, which is the difference between
// `if (!existing) return c.notFound()` and a TypeError in
// routes/admin/slugRedirect.ts:86.
type Bindable = null | number | bigint | string | Uint8Array;

// The prepared-statement shape d1Session hands back, named so the
// "coalesces to null itself" test below can wrap one without reaching for
// `any` (packages/db's tsconfig runs with noUncheckedIndexedAccess, which
// turns an index-signature stand-in into four "possibly undefined" errors).
interface StatementLike {
  bind: (...args: unknown[]) => StatementLike;
  first: () => Promise<unknown>;
  all: () => Promise<unknown>;
  run: () => Promise<unknown>;
}

function d1Session(database: SqliteDatabase): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (database.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: database.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      database.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

let db: SqliteDatabase;
let session: Session;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  session = d1Session(db);
});

afterEach(() => {
  vi.useRealTimers();
});

// Django's `str(datetime)` -- "YYYY-MM-DD HH:MM:SS.ffffff" -- which is what
// the ETL wrote into these 57 rows and what pyNow() writes on every save.
// These columns are TEXT and SQLite compares TEXT bytewise, so the FORMAT is
// load-bearing for `ORDER BY created DESC`: 'T' (0x54) sorts above ' ' (0x20),
// so a single toISOString() value sorts above every Django value from the
// same day regardless of the actual time (packages/models/src/pyDatetime.ts's
// header; ticket #9 measured it returning the wrong "latest need").
//
// sep05am and sep05pm deliberately share a DATE and differ only in the time,
// so an ordering that compared only the first ten characters cannot pass the
// tests below by accident.
const T = {
  jan2020: "2020-01-14 09:31:02.114000",
  mar2024: "2024-03-02 11:04:59.000000",
  sep05am: "2026-09-05 08:12:03.140000",
  sep05pm: "2026-09-05 19:28:08.853000",
  sep06: "2026-09-06 05:00:00.000000",
};

function seedRedirect(row: { id?: number; old_slug: string; new_slug: string; created: string; modified?: string }): void {
  db.prepare("INSERT INTO slugredirect (id, old_slug, new_slug, created, modified) VALUES (?, ?, ?, ?, ?)").run(
    row.id ?? null,
    row.old_slug,
    row.new_slug,
    row.created,
    row.modified ?? row.created,
  );
}

// Reads a row straight out of the table, bypassing the module. A write test
// that verified itself through the module's own reader would pass just as
// happily if both halves were wrong in the same direction.
function stored(oldSlug: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT * FROM slugredirect WHERE old_slug = ?").get(oldSlug);
  return row ? { ...(row as Record<string, unknown>) } : null;
}

function wholeTable(): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM slugredirect ORDER BY id").all().map((row) => ({ ...(row as Record<string, unknown>) }));
}

const oldSlugs = (rows: { old_slug: string }[]): string[] => rows.map((row) => row.old_slug);

// Date only, so the awaits in these tests still resolve on a real event loop.
function freezeClock(instant: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

// Five real-shaped renames. The ids are DELIBERATELY scrambled against the
// created order: the expected `-created` sequence is ids 3, 5, 1, 4, 2, which
// is neither ascending nor descending by id, so an `ORDER BY id` (or a query
// that lost its ORDER BY altogether and fell back to rowid order) cannot
// produce the expected answer by luck. That is the whole point of seeding
// five rows rather than two.
function seedFiveRenames(): void {
  seedRedirect({ id: 3, old_slug: "durham", new_slug: "county-durham", created: T.sep06 });
  seedRedirect({ id: 5, old_slug: "hull", new_slug: "kingston-upon-hull", created: T.sep05pm });
  seedRedirect({ id: 1, old_slug: "brixton", new_slug: "norwood-and-brixton", created: T.sep05am });
  seedRedirect({ id: 4, old_slug: "epsom", new_slug: "epsom-and-ewell", created: T.mar2024 });
  seedRedirect({ id: 2, old_slug: "salisbury-old", new_slug: "salisbury", created: T.jan2020 });
}

const NEWEST_FIRST = ["durham", "hull", "brixton", "epsom", "salisbury-old"];

describe("getSlugRedirectsPage", () => {
  // gfadmin/views.py:2278 is `SlugRedirect.objects.all().order_by("-created")`
  // -- newest first. Django's own list has no pagination at all, so the
  // ordering is the ONE piece of behaviour ported straight across, and it is
  // also the one an admin notices last: a list sorted the wrong way still
  // renders, still holds every row, and just buries the redirect that was
  // added thirty seconds ago at the bottom of the page.
  it("returns every row newest-created first, not in id or insertion order", async () => {
    seedFiveRenames();

    const page = await getSlugRedirectsPage(session, 1, 10);

    expect(oldSlugs(page.rows)).toEqual(NEWEST_FIRST);
  });

  // The same-day half of that claim, stated on its own because it is the half
  // a broken implementation still passes. "durham" (Sep 6) beating a Sep 5 row
  // proves only that dates compare; "hull" (19:28) beating "brixton" (08:12)
  // is what proves the whole TEXT timestamp compares.
  it("orders two redirects created on the same day by their time of day", async () => {
    seedFiveRenames();

    const page = await getSlugRedirectsPage(session, 1, 10);

    expect(oldSlugs(page.rows).indexOf("hull")).toBeLessThan(oldSlugs(page.rows).indexOf("brixton"));
  });

  // Ticket #9's trap, demonstrated in THIS table rather than argued about: a
  // lone toISOString() value in `created` sorts above every Django-format
  // value from the same day, so the row that is chronologically OLDEST by
  // eleven hours comes back first. Nothing in this repo should ever write one
  // -- upsertSlugRedirect uses pyNow(), and the test below proves it -- but
  // an ETL re-run or a hand-fixed row could, and this is what it would look
  // like: not an error, just a list in an order nobody can explain.
  it("sorts a stray ISO-format created above same-day Django-format ones (lexicographic TEXT, ticket #9)", async () => {
    seedRedirect({ old_slug: "hull", new_slug: "kingston-upon-hull", created: T.sep05pm });
    seedRedirect({ old_slug: "iso-written", new_slug: "somewhere", created: "2026-09-05T08:00:00.000Z" });

    const page = await getSlugRedirectsPage(session, 1, 10);

    expect(oldSlugs(page.rows)).toEqual(["iso-written", "hull"]);
  });

  // `total` is a COUNT over the whole table, not over the page. Deriving it
  // from `rows.length` would make the admin's "showing 1 of 1 pages" correct
  // on the last page and wrong on every other one, and would silently hide
  // every redirect past the first hundred.
  it("counts the whole table while returning only one page of rows", async () => {
    seedFiveRenames();

    const page = await getSlugRedirectsPage(session, 1, 2);

    expect(oldSlugs(page.rows)).toEqual(["durham", "hull"]);
    expect(page.total).toBe(5);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(2);
  });

  // OFFSET is (page - 1) * pageSize, so page 1 must start at row 0. An
  // off-by-one here -- `page * pageSize` -- hides the newest redirect of all
  // and shows a stale page to anyone who has just saved one.
  it("pages through the ordered list without repeating or skipping a row", async () => {
    seedFiveRenames();

    const [first, second, third] = await Promise.all([
      getSlugRedirectsPage(session, 1, 2),
      getSlugRedirectsPage(session, 2, 2),
      getSlugRedirectsPage(session, 3, 2),
    ]);

    expect(oldSlugs(first.rows)).toEqual(["durham", "hull"]);
    expect(oldSlugs(second.rows)).toEqual(["brixton", "epsom"]);
    expect(oldSlugs(third.rows)).toEqual(["salisbury-old"]);
    expect([...oldSlugs(first.rows), ...oldSlugs(second.rows), ...oldSlugs(third.rows)]).toEqual(NEWEST_FIRST);

    // `page` is echoed straight back and the template renders "page N of M"
    // from it (routes/admin/slugRedirect.ts:63). Asserted on pages 2 and 3
    // specifically: MUTANT `page: 1` hard-coded into the returned object
    // survives every other test in this file, because every one of them asks
    // for page 1 -- the pager would then read "page 1 of 3" on all three
    // pages and the Previous link would point at itself.
    expect([first.page, second.page, third.page]).toEqual([1, 2, 3]);
  });

  // ORDER BY **created**, not modified -- gfadmin/views.py:2278 is
  // `order_by("-created")`. MUTANT `ORDER BY modified DESC` survives the
  // ordering tests above because seedFiveRenames leaves `modified` defaulted
  // to `created`, so the two columns agree and either query gives the same
  // answer. Here they are deliberately in OPPOSITE orders: created ascending
  // is modified descending, so exactly one of the two possible queries can
  // pass. The bug it guards is the read-side twin of the "never touches
  // created" write test below -- sorting by `modified` would kick a
  // six-year-old redirect to the top of the list the moment someone fixed a
  // typo in it, and bury whatever was genuinely new.
  it("orders by created and not by modified, so editing an old row does not reshuffle the list", async () => {
    seedRedirect({ id: 1, old_slug: "salisbury-old", new_slug: "salisbury", created: T.jan2020, modified: T.sep06 });
    seedRedirect({ id: 2, old_slug: "epsom", new_slug: "epsom-and-ewell", created: T.mar2024, modified: T.sep05pm });
    seedRedirect({ id: 3, old_slug: "durham", new_slug: "county-durham", created: T.sep06, modified: T.sep05am });

    const page = await getSlugRedirectsPage(session, 1, 10);

    expect(oldSlugs(page.rows)).toEqual(["durham", "epsom", "salisbury-old"]);
  });

  // `total` counts ROWS. Two old slugs legitimately share one destination --
  // a food bank renamed twice keeps both of its old URLs alive, pointing at
  // the same new one -- so MUTANT `COUNT(DISTINCT new_slug)` (or
  // `COUNT(DISTINCT old_slug)`, which the UNIQUE index makes equivalent)
  // returns 1 where the truth is 3. It survives every other count test here
  // because seedFiveRenames gives all five rows distinct destinations. The
  // damage is the pager: total 1 means one page, and the two older redirects
  // become unreachable in the admin while still redirecting in production.
  it("counts rows, not distinct destinations, when several old slugs point at one food bank", async () => {
    seedRedirect({ id: 1, old_slug: "durham", new_slug: "county-durham", created: T.sep06 });
    seedRedirect({ id: 2, old_slug: "durham-city", new_slug: "county-durham", created: T.sep05pm });
    seedRedirect({ id: 3, old_slug: "durham-foodbank", new_slug: "county-durham", created: T.sep05am });

    const page = await getSlugRedirectsPage(session, 1, 2);

    expect(page.total).toBe(3);
    expect(page.hasNext).toBe(true);
    expect(oldSlugs(page.rows)).toEqual(["durham", "durham-city"]);
  });

  // hasNext is `offset + pageSize < total`, and both boundaries matter: a
  // `<=` here paints a "Next" link on the final page that leads to an empty
  // one, and a `-1` somewhere hides the last page's worth of redirects
  // entirely. Three assertions, one for each side of the boundary.
  it("reports hasNext true only while rows remain beyond this page", async () => {
    seedFiveRenames();

    expect((await getSlugRedirectsPage(session, 1, 2)).hasNext).toBe(true); // 2 < 5
    expect((await getSlugRedirectsPage(session, 2, 2)).hasNext).toBe(true); // 4 < 5
    expect((await getSlugRedirectsPage(session, 3, 2)).hasNext).toBe(false); // 6 < 5 is false
  });

  // The exact-multiple case, which is the one an off-by-one survives: five
  // rows in a page of five is a FULL page with nothing after it. A "the page
  // is full, so there must be more" implementation passes every test above
  // and fails only here.
  it("reports hasNext false when the last page is exactly full", async () => {
    seedFiveRenames();

    const page = await getSlugRedirectsPage(session, 1, 5);

    expect(page.rows).toHaveLength(5);
    expect(page.hasNext).toBe(false);
  });

  // ?page=99 is a URL anyone can type, and routes/admin/slugRedirect.ts
  // passes it through as long as it is a positive integer. It must render an
  // empty table with the real total, not throw and not claim there is more.
  it("returns no rows but the real total for a page past the end", async () => {
    seedFiveRenames();

    const page = await getSlugRedirectsPage(session, 4, 2);

    expect(page.rows).toEqual([]);
    expect(page.total).toBe(5);
    expect(page.hasNext).toBe(false);
  });

  // The empty state the admin list has and Django's template does not
  // (views.py:2278 renders an unconditional loop). total 0 also has to come
  // back as a number, because the template divides by pageSize to draw the
  // pager.
  it("returns an empty page and a zero total for an empty table", async () => {
    const page = await getSlugRedirectsPage(session, 1, 100);

    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.hasNext).toBe(false);
  });

  // The COLUMNS constant, pinned against the real table. If a later migration
  // adds a column and SlugRedirectRow grows to match while COLUMNS does not,
  // the admin's row objects silently lose a field and the template renders a
  // blank cell -- so the row's key set is asserted exactly, not just probed
  // for the fields this test happens to care about. (The inverse drift --
  // COLUMNS naming something the table lost -- dies here with "no such
  // column", which is migration 0019's failure caught at test time.)
  it("selects exactly the five declared columns, typed as the interface says", async () => {
    seedRedirect({ id: 7, old_slug: "durham", new_slug: "county-durham", created: T.sep06, modified: T.sep06 });

    const row = (await getSlugRedirectsPage(session, 1, 10)).rows[0]!;

    expect(Object.keys(row).sort()).toEqual(["created", "id", "modified", "new_slug", "old_slug"]);
    expect({ ...row }).toEqual({
      id: 7,
      old_slug: "durham",
      new_slug: "county-durham",
      created: T.sep06,
      modified: T.sep06,
    });
    expect(typeof row.id).toBe("number");
  });

  // DOCUMENTED, NOT ENDORSED. `ORDER BY created DESC` has no tiebreaker, so
  // rows sharing a `created` value are ordered by whatever the engine feels
  // like -- and LIMIT/OFFSET pagination over an unstable sort can repeat one
  // row on page 2 and drop another entirely. It does not happen today (this
  // asserts that it does not), because `created` comes from pyNow() at
  // millisecond resolution and the ETL preserved Django's per-row values. A
  // bulk INSERT that stamped one timestamp across many rows would change
  // that, and the fix would be a secondary sort on id, not a change here.
  it("pages tied created values without repeating or losing a row (no secondary sort exists)", async () => {
    const tied = "2026-09-05 12:00:00.000000";
    seedRedirect({ id: 1, old_slug: "aaa", new_slug: "aaa-new", created: tied });
    seedRedirect({ id: 2, old_slug: "bbb", new_slug: "bbb-new", created: tied });
    seedRedirect({ id: 3, old_slug: "ccc", new_slug: "ccc-new", created: tied });

    const first = await getSlugRedirectsPage(session, 1, 2);
    const second = await getSlugRedirectsPage(session, 2, 2);

    expect([...oldSlugs(first.rows), ...oldSlugs(second.rows)].sort()).toEqual(["aaa", "bbb", "ccc"]);
  });
});

describe("getSlugRedirectById", () => {
  // views.py:2290's get_object_or_404 -- the edit form's whole existence
  // check. It must fetch the row asked for and not, say, the first row in the
  // table, or editing redirect 42 would silently rewrite redirect 1.
  it("returns the whole row for the id asked for", async () => {
    seedFiveRenames();

    const row = await getSlugRedirectById(session, 4);

    expect({ ...row }).toEqual({
      id: 4,
      old_slug: "epsom",
      new_slug: "epsom-and-ewell",
      created: T.mar2024,
      modified: T.mar2024,
    });
  });

  // NULL, not undefined. routes/admin/slugRedirect.ts:85-86 stores this in
  // `existing` and tests `!existing` for the 404, then passes `existing?.id`
  // to both the uniqueness check and the writer -- so an undefined leaking
  // through would take the same branch, but the explicit `?? null` here is
  // what keeps D1's own contract (`.first()` answers null) true of this
  // function too. Pinned so nobody "simplifies" the coalesce away.
  it("returns null, not undefined, when no row has that id", async () => {
    seedFiveRenames();

    const row = await getSlugRedirectById(session, 999);

    expect(row).toBeNull();
    expect(row).not.toBeUndefined();
  });

  it("returns null on an empty table rather than throwing", async () => {
    expect(await getSlugRedirectById(session, 1)).toBeNull();
  });

  // `WHERE id = ?` -- EQUALITY, and the assertion has to be about a MISSING
  // id to prove it. MUTANT `WHERE id >= ?` passes both tests above: asking
  // for an id that exists still puts that row first, and asking for 999 still
  // matches nothing. The gap is where it shows. Deleting a redirect leaves
  // exactly this state, and /admin/slug-redirects/3/edit/ is a URL that
  // outlives the row it names -- in a bookmark, in a browser's history, in a
  // Slack message. Under `>=` that stale URL silently opens redirect 5's form
  // pre-filled with redirect 5's slugs, the admin corrects what they think is
  // redirect 3, and the save rewrites a different food bank's redirect. The
  // route's own 404 (routes/admin/slugRedirect.ts:85-86) is driven entirely
  // by this function answering null, so it cannot catch the substitution.
  // (`WHERE id <= ?` is covered too: it would answer with row 1 here.)
  it("returns null for an id in a gap, rather than the next row along", async () => {
    seedRedirect({ id: 1, old_slug: "brixton", new_slug: "norwood-and-brixton", created: T.sep05am });
    seedRedirect({ id: 2, old_slug: "epsom", new_slug: "epsom-and-ewell", created: T.mar2024 });
    seedRedirect({ id: 5, old_slug: "hull", new_slug: "kingston-upon-hull", created: T.sep05pm });

    expect(await getSlugRedirectById(session, 3)).toBeNull();
    expect(await getSlugRedirectById(session, 4)).toBeNull();
    // ...and the ids that DO exist still come back as themselves, so the
    // above is not passing because the query matches nothing at all.
    expect(await getSlugRedirectById(session, 2)).toMatchObject({ id: 2, old_slug: "epsom" });
    expect(await getSlugRedirectById(session, 5)).toMatchObject({ id: 5, old_slug: "hull" });
  });

  // The `?? null` in slugRedirects.ts:53, pinned against a session that
  // actually answers `undefined`. The test above cannot do it: d1Session
  // models D1 faithfully and already coalesces, so the module's own coalesce
  // is invisible through it and MUTANT `return row` (the coalesce deleted as
  // redundant) survives. This drives the module through a session that does
  // NOT coalesce -- which is what every hand-rolled test double and every
  // `.first()` shim in this repo has been at some point -- and proves the
  // null is the function's own guarantee rather than the harness's.
  // routes/admin/slugRedirect.ts:86 branches on `!existing`, so undefined
  // would take the same branch today; the reason to keep the coalesce is the
  // declared return type, which callers are entitled to read as "null".
  it("coalesces to null itself, not merely because the session already did", async () => {
    seedFiveRenames();
    const undefinedFirst = ((): Session => {
      const real = d1Session(db) as unknown as { prepare: (sql: string) => StatementLike };
      const strip = (stmt: StatementLike): StatementLike => ({
        bind: (...args: unknown[]) => strip(stmt.bind(...args)),
        first: async () => (await stmt.first()) ?? undefined,
        all: () => stmt.all(),
        run: () => stmt.run(),
      });
      return { prepare: (sql: string) => strip(real.prepare(sql)), getBookmark: () => null } as unknown as Session;
    })();

    expect(await getSlugRedirectById(undefinedFirst, 999)).toBeNull();
    // and the found case still survives the same plumbing
    expect(await getSlugRedirectById(undefinedFirst, 4)).toMatchObject({ id: 4, old_slug: "epsom" });
  });
});

describe("slugRedirectOldSlugTaken", () => {
  // THE FUNCTION'S WHOLE REASON TO EXIST, and the one case a plausible wrong
  // implementation gets wrong. On a create there is no row to exclude, so
  // `exceptId ?? null` binds NULL -- and SQLite's `id != NULL` evaluates to
  // NULL, never true, which filters out EVERY row and makes the check
  // silently always answer "free". The admin then submits, the UNIQUE index
  // raises SQLITE_CONSTRAINT, and app.onError renders a 500 over the form:
  // GitHub issue #12, in the shape it takes on this table.
  it("finds an existing old_slug on a create, where the exclusion binds NULL", async () => {
    seedFiveRenames();

    expect(await slugRedirectOldSlugTaken(session, "durham", undefined)).toBe(true);
  });

  // The mutant, RUN rather than reasoned about (TESTING.md's rule). This is
  // the same statement with `IS NOT` swapped for `!=`, executed against the
  // same seeded table: it matches nothing, so the check would report "free"
  // for a slug that is plainly taken. Keeping the proof here means the
  // one-character difference in slugRedirects.ts:64 has a test that explains
  // itself, instead of a comment asking to be trusted.
  it("would find nothing with `!=` -- the engine proof that `IS NOT` is required", () => {
    seedFiveRenames();

    const nullSafe = db.prepare("SELECT id FROM slugredirect WHERE old_slug = ? AND id IS NOT ?").all("durham", null);
    const mutant = db.prepare("SELECT id FROM slugredirect WHERE old_slug = ? AND id != ?").all("durham", null);

    expect(nullSafe).toHaveLength(1);
    expect(mutant).toHaveLength(0);
  });

  // The other half of the same predicate: on an EDIT, the row being edited
  // must not report itself as a clash, or re-saving an unchanged form (which
  // is exactly what an admin does when they only meant to fix the new_slug)
  // would be refused forever with "A redirect from durham already exists".
  it("excludes the row being edited, so an unchanged re-save is not a clash", async () => {
    seedFiveRenames();

    expect(await slugRedirectOldSlugTaken(session, "durham", 3)).toBe(false);
  });

  // ...but only that row. Retyping another redirect's old_slug into this one
  // is a real clash and must still be caught, or the UNIQUE index catches it
  // as a 500 instead.
  it("still reports a clash when a DIFFERENT row holds the slug", async () => {
    seedFiveRenames();

    expect(await slugRedirectOldSlugTaken(session, "durham", 5)).toBe(true);
  });

  it("reports an unused slug as free", async () => {
    seedFiveRenames();

    expect(await slugRedirectOldSlugTaken(session, "wolverhampton", undefined)).toBe(false);
  });

  // The exclusion sentinel has to be a value no row can hold, and NULL is the
  // only one. MUTANT `exceptId ?? 0` -- the shape of an edit made to quiet a
  // "number | null is not assignable" complaint -- survives every other test
  // in this describe, because ids here start at 1 and `id IS NOT 0` is then
  // true of every row, exactly as `id IS NOT NULL` is. Id 0 is the single
  // input that separates them, so it is the one seeded: under `?? 0` the row
  // excludes ITSELF from the create-time uniqueness check and the function
  // reports a plainly-taken slug as free.
  it("does not use 0 as the no-exclusion sentinel, so a row with id 0 is still found on a create", async () => {
    seedRedirect({ id: 0, old_slug: "durham", new_slug: "county-durham", created: T.sep06 });

    expect(await slugRedirectOldSlugTaken(session, "durham", undefined)).toBe(true);
  });

  // Boolean, not the row. The route does `if (await slugRedirectOldSlugTaken(...))`,
  // so a truthy row would work by accident -- but the return type says
  // boolean and callers may test `=== false`.
  it("answers with a boolean, not the matched row", async () => {
    seedFiveRenames();

    const taken = await slugRedirectOldSlugTaken(session, "durham", undefined);
    expect(taken).toBe(true);
    expect(typeof taken).toBe("boolean");
  });

  // DOCUMENTED, NOT ENDORSED: the comparison is SQLite's default BINARY
  // collation, so "Durham" and "durham" are different slugs here, and the
  // UNIQUE index agrees -- both can exist at once. That matches Django on
  // Postgres (a plain `unique=True` CharField is case-sensitive too), so it
  // is a faithful port, but it means an admin who types "Durham" gets a
  // redirect that never fires: middleware/slugRedirect.ts looks the path
  // segment up verbatim, and every food bank slug on the site is lowercase.
  // Pinned so the next person to see it knows it is inherited, not accidental.
  it("compares old_slug case-sensitively, so 'Durham' and 'durham' are different rows", async () => {
    seedFiveRenames();

    expect(await slugRedirectOldSlugTaken(session, "Durham", undefined)).toBe(false);

    seedRedirect({ old_slug: "Durham", new_slug: "county-durham", created: T.sep06 });
    expect(wholeTable().filter((row) => String(row.old_slug).toLowerCase() === "durham")).toHaveLength(2);
  });
});

describe("upsertSlugRedirect", () => {
  // TimestampedModel (givefood/models/base.py:12-19) is auto_now_add on
  // `created` and auto_now on `modified`; SQLite has neither, so both are
  // stamped in JS. Frozen clock, so the assertion is the exact string rather
  // than a regex that would also accept an ISO value.
  it("creates a row with created and modified both stamped in Django's format", async () => {
    freezeClock("2026-09-05T19:28:08.853Z");

    await upsertSlugRedirect(session, { oldSlug: "durham", newSlug: "county-durham" }, undefined);

    expect(stored("durham")).toEqual({
      id: 1,
      old_slug: "durham",
      new_slug: "county-durham",
      created: T.sep05pm,
      modified: T.sep05pm,
    });
  });

  // Ticket #9 at its write site, asserted as a shape as well as a value:
  // "2026-09-05 19:28:08.853000", never "2026-09-05T19:28:08.853Z". A
  // toISOString() here would put every newly created redirect at the TOP of
  // the admin list forever -- which looks right, because a new row belongs at
  // the top -- and would keep it there after every older row overtook it.
  it("never writes a toISOString() timestamp into created or modified", async () => {
    freezeClock("2026-09-05T19:28:08.853Z");

    await upsertSlugRedirect(session, { oldSlug: "durham", newSlug: "county-durham" }, undefined);

    const row = stored("durham")!;
    expect(row.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(String(row.created)).not.toContain("T");
    expect(String(row.created)).not.toContain("Z");
  });

  // The end-to-end version of the same claim, which is the one that would
  // actually be noticed: a redirect saved today has to sort above the 2020
  // rows the ETL loaded, through the real ORDER BY, in the real list query.
  it("writes a created value that sorts newest-first against the ETL's existing rows", async () => {
    seedRedirect({ old_slug: "salisbury-old", new_slug: "salisbury", created: T.jan2020 });
    seedRedirect({ old_slug: "epsom", new_slug: "epsom-and-ewell", created: T.mar2024 });
    freezeClock("2026-09-06T05:00:00.000Z");

    await upsertSlugRedirect(session, { oldSlug: "durham", newSlug: "county-durham" }, undefined);

    expect(oldSlugs((await getSlugRedirectsPage(session, 1, 10)).rows)).toEqual(["durham", "epsom", "salisbury-old"]);
  });

  // auto_now_add means created is set ONCE. An UPDATE that also stamped
  // `created` would reshuffle the admin list on every edit -- fixing a typo
  // in a two-year-old redirect's new_slug would jump it to the top and push
  // whatever was genuinely newest off the first page.
  it("updates both slugs and modified, and never touches created", async () => {
    seedRedirect({ id: 4, old_slug: "epsom", new_slug: "epsom-and-ewel", created: T.mar2024, modified: T.mar2024 });
    freezeClock("2026-09-06T05:00:00.000Z");

    await upsertSlugRedirect(session, { oldSlug: "epsom", newSlug: "epsom-and-ewell" }, 4);

    expect(stored("epsom")).toEqual({
      id: 4,
      old_slug: "epsom",
      new_slug: "epsom-and-ewell",
      created: T.mar2024,
      modified: T.sep06,
    });
  });

  // The `WHERE id = ?` on the UPDATE, which is the difference between editing
  // one redirect and rewriting all 57 with the same pair of slugs. A missing
  // WHERE would still leave the edited row correct, so the assertion has to be
  // about the OTHER rows.
  it("leaves every other row untouched on an update", async () => {
    seedFiveRenames();
    freezeClock("2026-09-06T05:00:00.000Z");
    const before = wholeTable().filter((row) => row.id !== 4);

    await upsertSlugRedirect(session, { oldSlug: "epsom", newSlug: "epsom-and-ewell" }, 4);

    expect(wholeTable().filter((row) => row.id !== 4)).toEqual(before);
  });

  // `existingId === undefined` is the create/update switch, and the branch is
  // taken on the identity of the value, not its truthiness -- so this pins
  // that an id genuinely reaches the UPDATE branch and does not insert a
  // second row. Two rows for one old_slug is the exact state the migration's
  // UNIQUE index exists to make impossible, so the failure mode here is a
  // constraint error in the admin, not a duplicate.
  it("updates rather than inserts when an id is given", async () => {
    seedRedirect({ id: 4, old_slug: "epsom", new_slug: "epsom-and-ewel", created: T.mar2024 });

    await upsertSlugRedirect(session, { oldSlug: "epsom", newSlug: "epsom-and-ewell" }, 4);

    expect(wholeTable()).toHaveLength(1);
  });

  // ...and the switch is on IDENTITY, `existingId === undefined`, not on
  // truthiness. MUTANT `if (!existingId)` is indistinguishable from the real
  // thing for every id from 1 up, so the test above cannot see it; id 0 is
  // the only value that tells them apart. Under `!existingId` this call takes
  // the CREATE branch, INSERTs a second row for an old_slug that already has
  // one, and the UNIQUE index turns an ordinary edit into a 500 over the
  // admin's typed values. Django's own view has the identical trap at
  // gfadmin/views.py:2288 (`if id:`), which is why the port's comment on
  // slugRedirects.ts:79 spells the check out rather than writing the short
  // version.
  it("takes the update branch for id 0, because the switch is `=== undefined` not truthiness", async () => {
    seedRedirect({ id: 0, old_slug: "epsom", new_slug: "epsom-and-ewel", created: T.mar2024 });
    freezeClock("2026-09-06T05:00:00.000Z");

    await upsertSlugRedirect(session, { oldSlug: "epsom", newSlug: "epsom-and-ewell" }, 0);

    expect(wholeTable()).toEqual([{ id: 0, old_slug: "epsom", new_slug: "epsom-and-ewell", created: T.mar2024, modified: T.sep06 }]);
  });

  // Why slugRedirectOldSlugTaken exists at all, proved rather than asserted:
  // without the pre-flight check the second create raises
  // SQLITE_CONSTRAINT_UNIQUE, which reaches D1 as an error and app.onError as
  // a 500 page over the admin's typed values. The route turns it into a 400
  // with a sentence (routes/admin/slugRedirect.ts:110-112) -- but only because
  // it asks first.
  it("lets the UNIQUE index reject a duplicate old_slug (this is what the pre-flight check prevents)", async () => {
    seedRedirect({ old_slug: "durham", new_slug: "county-durham", created: T.sep06 });

    await expect(upsertSlugRedirect(session, { oldSlug: "durham", newSlug: "somewhere-else" }, undefined)).rejects.toThrow(
      /UNIQUE constraint failed: slugredirect\.old_slug/,
    );
  });

  // The same constraint on the edit path, which is the one an
  // exceptId-shaped bug would open up: editing redirect 5 to claim redirect
  // 3's old_slug is still a duplicate.
  it("lets the UNIQUE index reject an update that steals another row's old_slug", async () => {
    seedFiveRenames();

    await expect(upsertSlugRedirect(session, { oldSlug: "durham", newSlug: "somewhere-else" }, 5)).rejects.toThrow(
      /UNIQUE constraint failed: slugredirect\.old_slug/,
    );
  });

  // DOCUMENTED, NOT ENDORSED. An UPDATE against an id that is gone matches no
  // rows, changes nothing, and reports success -- the admin gets its 302 back
  // to the list and their edit is not there. Unreachable through the only
  // caller today (routes/admin/slugRedirect.ts:85-86 has already 404'd on a
  // missing row before it gets here), and pinned as current behaviour rather
  // than fixed, because the fix belongs at the caller.
  it("silently does nothing when the id to update no longer exists", async () => {
    seedFiveRenames();
    const before = wholeTable();

    await upsertSlugRedirect(session, { oldSlug: "durham", newSlug: "somewhere-else" }, 999);

    expect(wholeTable()).toEqual(before);
  });

  // The round trip, through the module's own readers: a save has to be
  // visible to the edit form (getSlugRedirectById) AND to the middleware
  // (getSlugRedirectMap). The KV blob these two used to disagree through is
  // gone (middleware/slugRedirect.ts:14-21), and this is the property its
  // removal was meant to guarantee.
  it("is immediately visible to both the edit form and the redirect map", async () => {
    freezeClock("2026-09-06T05:00:00.000Z");

    await upsertSlugRedirect(session, { oldSlug: "durham", newSlug: "county-durham" }, undefined);

    expect(await getSlugRedirectById(session, 1)).toMatchObject({ old_slug: "durham", new_slug: "county-durham" });
    expect(await getSlugRedirectMap(session)).toEqual({ durham: "county-durham" });
  });
});

describe("getSlugRedirectMap", () => {
  // givefood/utils/cache.py:25's
  // `dict(SlugRedirect.objects.all().values_list("old_slug", "new_slug"))`,
  // and the exact shape middleware/slugRedirect.ts indexes into. Asserted as
  // the WHOLE object, so a map built the other way round (new -> old) fails
  // here rather than in production as a redirect loop.
  it("maps old_slug to new_slug for every row", async () => {
    seedFiveRenames();

    expect(await getSlugRedirectMap(session)).toEqual({
      durham: "county-durham",
      hull: "kingston-upon-hull",
      brixton: "norwood-and-brixton",
      epsom: "epsom-and-ewell",
      "salisbury-old": "salisbury",
    });
  });

  // The keys are the stored bytes, untouched. MUTANTS `map[row.old_slug
  // .trim()]` and `map[row.old_slug.toLowerCase()]` -- both the sort of
  // "tidy the data on the way out" edit that looks like an improvement --
  // survive the test above, because every slug seedFiveRenames writes is
  // already trimmed and already lowercase, so normalising them is a no-op.
  // They must not be normalised here: middleware/slugRedirect.ts looks the
  // raw path segment up in this map, so the map's keys have to match what D1
  // holds, byte for byte. Normalising in the reader makes a redirect fire for
  // a URL that has no row (/Durham/ matching the "durham" row) and, worse,
  // makes the admin's uniqueness check and the middleware's lookup disagree
  // about what "the same slug" means -- one case-sensitive, one not.
  // The two rows here also PROVE the drop is silent rather than loud: a
  // normalising map would collide them into one key and lose a row with no
  // error anywhere.
  it("keys the map on the stored old_slug verbatim, with no trim or case fold", async () => {
    seedRedirect({ old_slug: "Durham", new_slug: "county-durham", created: T.sep06 });
    seedRedirect({ old_slug: "durham", new_slug: "durham-city", created: T.sep05pm });
    seedRedirect({ old_slug: "epsom ", new_slug: "epsom-and-ewell ", created: T.mar2024 });

    const map = await getSlugRedirectMap(session);

    expect(map).toEqual({
      Durham: "county-durham",
      durham: "durham-city",
      "epsom ": "epsom-and-ewell ",
    });
  });

  // No LIMIT, and none may ever be added. This read feeds the middleware's
  // 5-minute memo, so a truncated map does not fail -- it 404s the renamed
  // food banks that fell off the end, for every visitor, until someone
  // notices. 150 rows is comfortably past both the admin list's PAGE_SIZE of
  // 100 and D1's 100-bound-parameter limit, either of which is a plausible
  // number for a "just add a limit" change to reach for.
  it("reads every row, with no pagination limit hiding the tail", async () => {
    for (let i = 0; i < 150; i += 1) {
      seedRedirect({ old_slug: `old-${i}`, new_slug: `new-${i}`, created: T.mar2024 });
    }

    const map = await getSlugRedirectMap(session);

    expect(Object.keys(map)).toHaveLength(150);
    expect(map["old-0"]).toBe("new-0");
    expect(map["old-149"]).toBe("new-149");
  });

  // The middleware treats an empty map as "no redirect" and falls through, so
  // this must be `{}` -- not null, not undefined. It is also what a brand new
  // database returns on the very first request through a cold isolate.
  it("returns an empty object for an empty table", async () => {
    const map = await getSlugRedirectMap(session);

    expect(map).toEqual({});
    expect(Object.keys(map)).toHaveLength(0);
  });

  // SUSPECT, PINNED AS-IS: the map is a plain `{}`, so a row whose old_slug is
  // "__proto__" is silently DROPPED. `map["__proto__"] = "county-durham"`
  // runs the prototype setter, which ignores a string value, leaving no own
  // property behind -- the row exists in D1, appears in the admin list, and
  // never redirects. Nobody has such a slug today and the URL would have to
  // be typed by hand, so this is documented rather than fixed;
  // `Object.create(null)` or a Map would close it. Not a failing test: this
  // asserts what the code DOES.
  it("silently drops a row whose old_slug is __proto__ (suspect: plain-object map)", async () => {
    seedRedirect({ old_slug: "__proto__", new_slug: "county-durham", created: T.sep06 });
    seedRedirect({ old_slug: "durham", new_slug: "county-durham", created: T.sep06 });

    const map = await getSlugRedirectMap(session);

    expect(Object.keys(map)).toEqual(["durham"]);
    expect(Object.hasOwn(map, "__proto__")).toBe(false);
    expect(map["__proto__"]).toBe(Object.prototype as unknown as string);
  });

  // SUSPECT, PINNED AS-IS, and the sharper end of the same thing: the map
  // INHERITS Object.prototype, so a lookup for a slug that is not in the
  // table can still come back truthy. middleware/slugRedirect.ts:73-80 does
  // `const newSlug = map[oldSlug]; if (newSlug) { ...301... }`, and its
  // SLUG_PATTERN accepts `[-\w]+` -- so /needs/at/toString/ 301s to
  // "/needs/at/function toString() { [native code] }/" instead of reaching
  // the 404 it deserves. Only the handful of Object.prototype member names
  // are affected and none is a plausible food bank slug, which is why this is
  // reported and pinned rather than fixed here.
  it("inherits Object.prototype keys, so an absent slug like toString still looks present (suspect)", async () => {
    seedRedirect({ old_slug: "durham", new_slug: "county-durham", created: T.sep06 });

    const map = await getSlugRedirectMap(session);

    expect(Object.hasOwn(map, "toString")).toBe(false);
    expect(map["toString"]).toBeTruthy();
    expect(typeof map["toString"]).toBe("function");
  });

  // The migration's own claim, tested: two rows with the same old_slug would
  // make this dict non-deterministic (last row wins), so the database refuses
  // them. That is why getSlugRedirectMap can flatten rows into an object at
  // all without an ordering rule.
  it("cannot be made ambiguous, because the UNIQUE index forbids a duplicate old_slug", async () => {
    seedRedirect({ old_slug: "durham", new_slug: "county-durham", created: T.sep06 });

    expect(() => seedRedirect({ old_slug: "durham", new_slug: "somewhere-else", created: T.jan2020 })).toThrow(
      /UNIQUE constraint failed: slugredirect\.old_slug/,
    );
  });
});
