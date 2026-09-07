// @ts-ignore -- node:sqlite has no types under this package's tsconfig, whose
// `"types": ["@cloudflare/workers-types"]` deliberately excludes @types/node
// (foodbankAdmin.test.ts's header explains the same constraint). The import
// works at runtime -- vitest runs this file in a node environment -- and the
// casts below are the whole cost of getting a real SQL engine in here.
// `@ts-ignore` rather than `@ts-expect-error`: if someone later adds
// @types/node to this package, an expect-error directive would itself become
// the error and break `pnpm typecheck` for everyone, which is the exact
// outcome this comment exists to avoid.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ITEM_LIST_SORTS, getItemCaloriesPer100g, getOrderItemByName, getOrderItemBySlug, getOrderItemsPage, upsertOrderItem, type ItemListSort } from "./orderItemAdmin";
import type { Session } from "./types";

// orderItemAdmin.ts is five statements and a slugifier, and every one of its
// failure modes is SILENT. A `WHERE slug = ?` that quietly matched `name`, an
// `ORDER BY name` that lost its COLLATE NOCASE, a uniquifier whose
// self-exclusion stopped excluding -- none of those throw, none of them change
// the SHAPE of anything, and none of them show up in a log. They just hand the
// admin the wrong item, or the wrong page of items, or refuse a save forever.
// Migration 0019 is this repo's own scar for exactly this class: it dropped
// the cached `foodbank_*` columns, four queries kept naming them, and nothing
// went red until /dashboard/beautybanks/ was measured and found to be a silent
// 500.
//
// So this file runs the real statements against a real SQLite database built
// from packages/db/migrations/0014_orderitem.sql, and asserts ROWS -- which
// ids, in which order, with which values -- not shapes. A recording fake of
// the kind locationsAdmin.test.ts uses would prove nothing here: these
// functions ARE their SQL.
//
// THREE THINGS THIS FILE DELIBERATELY DOES NOT TEST, so their absence is not
// read as an oversight:
//
//  * Django-format timestamps. `orderitem` has no created/modified columns at
//    all -- OrderItem inherits plain models.Model, not TimestampedModel
//    (models/orders.py:291), and 0014's own comment says so. Nothing in this
//    module builds a datetime threshold or orders by one, so the "TEXT
//    compared bytewise" trap that bites every other module in this package
//    cannot arise here.
//  * D1's 100-bound-parameter statement limit. No function here builds a
//    variable-length IN list or chunks its bindings; the most any statement
//    binds is four (the UPDATE). If a future change adds an IN list it needs
//    a test at 100 and at 101.
//  * D1's 50-BYTE cap on a LIKE/GLOB pattern, which is the whole reason
//    uniqueSlug uses substr() rather than `slug LIKE ?1 || '-%'`. Real SQLite
//    has no such cap, so the error cannot be reproduced here. What IS tested
//    is the behaviour the rewrite had to preserve: a 55-character slug still
//    disambiguates correctly. See "disambiguates a slug well past D1's
//    50-byte LIKE limit" below.

// ---------------------------------------------------------------------------
// The schema, copied from packages/db/migrations/0014_orderitem.sql:38-45 --
// the table AND both indexes, not inferred from OrderItemRow. Catching a
// disagreement between the migration and the TypeScript is half the point of
// running real SQL.
//
// orderitem_name_uniq is load-bearing in this file, not decoration: it is the
// constraint getOrderItemByName's pre-check fronts, and a test that inserted
// duplicate names into an unconstrained table would be describing a database
// that does not exist. orderitem_slug_idx is deliberately NON-unique, for the
// reason 0014 spells out at length -- Django never uniquified `slug`, so
// production may hold a legacy collision, and several tests below seed one.
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE orderitem (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  calories INTEGER NOT NULL
);
CREATE UNIQUE INDEX orderitem_name_uniq ON orderitem(name);
CREATE INDEX orderitem_slug_idx ON orderitem(slug);
`;

// ---------------------------------------------------------------------------
// The slice of the D1 Sessions API this module uses, over node:sqlite. Copied
// from adminLists.test.ts's d1Session, which copied it from
// workers/site/src/routes/admin/foodbankLocation.test.ts. Nothing here
// interprets the SQL -- it hands the string straight to the engine, which is
// the only reason these tests are worth more than the fake-session ones.
// ---------------------------------------------------------------------------
type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
};

function d1Session(db: SqliteDb) {
  const statement = (sql: string, params: unknown[]) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

let db: SqliteDb;
let session: Session;

beforeEach(() => {
  // @ts-ignore -- see the import comment
  db = new DatabaseSync(":memory:") as SqliteDb;
  db.exec(SCHEMA);
  session = d1Session(db);
});

// Every seed names its slug EXPLICITLY rather than deriving it. Deriving it
// would mean reimplementing slugify() in the test fixture and then asserting
// the module against that reimplementation -- circular, and blind to the one
// bug it would matter for. It also lets a test seed the legacy slug collisions
// that 0014 says production may contain and upsertOrderItem would never write.
interface Seed {
  id: number;
  name: string;
  slug: string;
  calories?: number;
}

function seed(...rows: Seed[]): void {
  for (const row of rows) {
    db.prepare("INSERT INTO orderitem (id, name, slug, calories) VALUES (?, ?, ?, ?)").run(row.id, row.name, row.slug, row.calories ?? 0);
  }
}

// Read the table back raw, for the write-path tests. Reading through
// getOrderItemBySlug instead would make an upsert test pass or fail on the
// read function's bugs as well as its own.
function allRows(): Array<{ id: number; name: string; slug: string; calories: number }> {
  return db.prepare("SELECT id, name, slug, calories FROM orderitem ORDER BY id").all() as Array<{ id: number; name: string; slug: string; calories: number }>;
}

function slugOf(id: number): string | undefined {
  return allRows().find((r) => r.id === id)?.slug;
}

// ===========================================================================
// getOrderItemBySlug -- Django's get_object_or_404(OrderItem, slug=slug)
// (gfadmin/views.py:2255), which is what resolves /admin/item/:slug/edit/.
// ===========================================================================
describe("getOrderItemBySlug", () => {
  it("returns the whole row, every column the edit form binds", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    // Asserted as a whole object rather than field by field: the form pre-fills
    // from this row, so a SELECT that silently stopped returning `calories`
    // would hand the admin a blank field they would then re-type, or save as 0.
    expect({ ...(await getOrderItemBySlug(session, "baked-beans")) }).toEqual({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });
  });

  it("returns null for an unknown slug, so the route can 404", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans" });

    // routes/admin/items.ts:98 turns this null into c.notFound(). A function
    // that returned undefined instead would still be falsy there, but `first()`
    // normalising to null is the contract the whole package shares.
    expect(await getOrderItemBySlug(session, "nope")).toBeNull();
  });

  // THE COLUMN-SWAP MUTANT. `name` and `slug` are both TEXT, both present on
  // every row, and both plausible-looking in a WHERE clause. Seeding a row
  // whose NAME is a valid-looking slug is the only way a test notices the
  // difference; without it, `WHERE name = ?` passes every other case in this
  // block because the fixture's names and slugs are distinguishable only to a
  // human.
  it("matches on slug, never on name", async () => {
    seed({ id: 4, name: "baked-beans", slug: "tinned-tomatoes" });

    expect(await getOrderItemBySlug(session, "baked-beans")).toBeNull();
    expect((await getOrderItemBySlug(session, "tinned-tomatoes"))?.id).toBe(4);
  });

  // SQLite's `=` on TEXT is byte-wise unless the column or the comparison says
  // otherwise, and neither does here. Pinned because getOrderItemsPage two
  // screens away DOES use COLLATE NOCASE, and "we collate case-insensitively
  // in this module" is exactly the kind of half-true generalisation that gets
  // a NOCASE added to a lookup. It must not be: slugs are lowercase by
  // construction, and a case-insensitive lookup would make a legacy pair that
  // differs only in case resolve to one row.
  it("matches the slug exactly -- no case folding", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans" });

    expect(await getOrderItemBySlug(session, "Baked-Beans")).toBeNull();
    expect(await getOrderItemBySlug(session, "BAKED-BEANS")).toBeNull();
  });

  // The `ORDER BY id LIMIT 1` the module's comment exists for. 0014 refuses to
  // make orderitem_slug_idx UNIQUE because production may already hold a pair
  // of names that slugify alike; in Django that pair makes
  // get_object_or_404(slug=...) raise MultipleObjectsReturned -- a hard 500 on
  // /admin/item/<slug>/edit/, and one of the two rows permanently uneditable.
  //
  // HONEST ABOUT WHAT THIS KILLS. `ORDER BY id DESC` dies here, and so does
  // any rewrite that takes a different row. Deleting the ORDER BY does NOT,
  // and neither does deleting the LIMIT -- both were run:
  //
  //  * Deleting `ORDER BY id`: SQLite answers this from orderitem_slug_idx,
  //    whose entries for one slug are ordered by rowid, so ascending ids come
  //    back anyway. Checked with the index dropped as well (a plain SCAN, also
  //    rowid order) and at 50 duplicate rows inserted in descending id order.
  //    There is no fixture in this storage engine that separates the two --
  //    which is exactly why the clause is worth keeping: D1 is a different
  //    build, and the day the planner or the index changes, the flip is silent.
  //  * Deleting `LIMIT 1`: invisible through `first()`, which takes the first
  //    row of whatever comes back. It is there to stop D1 metering the scan of
  //    a duplicate set, not to change the answer.
  //
  // The test pins the GUARANTEE, not today's accident. It is also the setup
  // the "un-shadows" case below depends on, and that one does kill mutants.
  it("returns the lower id when a legacy pair shares a slug, rather than 500ing like Django", async () => {
    // Inserted high id first, so insertion order and id order disagree.
    seed({ id: 20, name: "Value Baked Beans", slug: "baked-beans", calories: 70 }, { id: 10, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    expect((await getOrderItemBySlug(session, "baked-beans"))?.id).toBe(10);
  });
});

// ===========================================================================
// getOrderItemByName -- the pre-flight for ModelForm.validate_unique()'s
// "Order item with this Name already exists." (models/orders.py:293's
// unique=True). github #12's class of bug: without it the INSERT reaches D1,
// SQLITE_CONSTRAINT_UNIQUE fires, and app.onError renders a 500 over
// everything the admin typed.
// ===========================================================================
// Note the one asymmetry with getOrderItemBySlug: this statement has no
// ORDER BY, and deliberately needs none, because orderitem_name_uniq caps the
// result at one row. Adding `ORDER BY id DESC` here was run as a mutant and
// changes nothing -- there is never a second row to reorder. The slug lookup
// carries an ORDER BY precisely because its index is NOT unique.
describe("getOrderItemByName", () => {
  it("returns the clashing row, including its id", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    // The `id` specifically: routes/admin/items.ts:129 compares it against the
    // row being edited (`clash.id !== existing?.id`) to let an admin re-save an
    // item without renaming it. A SELECT that stopped returning id would make
    // that comparison `undefined !== 4` -- true -- and every edit unsavable.
    expect({ ...(await getOrderItemByName(session, "Baked Beans")) }).toEqual({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });
  });

  it("returns null when the name is free", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans" });

    expect(await getOrderItemByName(session, "Tinned Tomatoes")).toBeNull();
  });

  // The mirror of getOrderItemBySlug's column-swap test, and the more
  // dangerous direction: a check that matched on `slug` would let two rows
  // with the same NAME through the pre-check and straight into the UNIQUE
  // index -- issue #12 back again, wearing a validator's clothing.
  it("matches on name, never on slug", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans" });

    expect(await getOrderItemByName(session, "baked-beans")).toBeNull();
  });

  // The pre-check must agree with the constraint it fronts EXACTLY. SQLite's
  // `=` and orderitem_name_uniq are both BINARY, so "Baked Beans" and "baked
  // beans" are two legal, distinct rows -- and this check says so too. Adding
  // a COLLATE NOCASE here would be worse than useless: it would reject a name
  // the database would happily have stored, with an error message naming a
  // duplicate the admin cannot see. (The trailing-space case is the same
  // point; the route trims before it gets here, forms.CharField's strip=True.)
  it("is case-sensitive, matching orderitem_name_uniq's own collation", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans" });

    expect(await getOrderItemByName(session, "baked beans")).toBeNull();
    expect(await getOrderItemByName(session, "BAKED BEANS")).toBeNull();
    expect(await getOrderItemByName(session, "Baked Beans ")).toBeNull();
    expect((await getOrderItemByName(session, "Baked Beans"))?.id).toBe(4);
  });
});

// ===========================================================================
// getItemCaloriesPer100g -- givefood/utils/text.py:118-130 get_calories, whose
// whole body is `OrderItem.objects.get(name=text)` inside a try, with
// `except OrderItem.DoesNotExist: calories = 0`.
// ===========================================================================
describe("getItemCaloriesPer100g", () => {
  it("returns the row's kcal per 100g for an exact name", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    expect(await getItemCaloriesPer100g(session, "Baked Beans")).toBe(78);
  });

  // Django's `except DoesNotExist: calories = 0`, ported as `?? 0`. The caller
  // (WP 6.5b's Order.save()) multiplies this by a weight, so anything other
  // than a number here -- null, undefined -- propagates as NaN into a stored
  // total rather than raising. Asserting `toBe(0)` rather than `toBeFalsy()`
  // is the difference between catching that and not.
  it("returns 0 for an unknown name, exactly as Django's DoesNotExist branch does", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    const missing = await getItemCaloriesPer100g(session, "Unicorn Steaks");
    expect(missing).toBe(0);
    expect(Number.isNaN(missing)).toBe(false);
  });

  // A genuinely 0-calorie item and a missing item are indistinguishable in the
  // return value -- that is Django's behaviour too, and the reason this is a
  // test rather than a bug report. Pinned so `?? 0` is never "simplified" to
  // `|| 0` on the theory that it makes no difference: it makes none TODAY only
  // because `calories` is NOT NULL. It would the moment the column went
  // nullable, and this test documents which of the two the code relies on.
  it("cannot distinguish a 0-calorie row from a missing one", async () => {
    seed({ id: 4, name: "Sparkling Water", slug: "sparkling-water", calories: 0 });

    expect(await getItemCaloriesPer100g(session, "Sparkling Water")).toBe(0);
    expect(await getItemCaloriesPer100g(session, "Still Water")).toBe(0);
  });

  // The lookup is on `name` and is byte-wise, so an order line whose text
  // differs by one capital silently scores zero calories instead of erroring.
  // That is Django's behaviour verbatim (`OrderItem.objects.get(name=text)`
  // against a Postgres column with no citext), and it is the reason the
  // calorie totals on /admin/order/ are approximate. Pinned so nobody
  // "improves" it into a NOCASE match and quietly changes historical figures.
  it("scores 0 for a name that differs only in case -- silently, like Django", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    expect(await getItemCaloriesPer100g(session, "baked beans")).toBe(0);
  });

  // The module's own comment: "exact-name lookup (`name`, never `slug`)".
  // orderline joins to orderitem on the NAME STRING (0014's header says so
  // too), so a slug lookup here would return 0 for every real order line.
  it("looks up by name, never by slug", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    expect(await getItemCaloriesPer100g(session, "baked-beans")).toBe(0);
  });
});

// ===========================================================================
// upsertOrderItem -- OrderItem.save() (models/orders.py:305-308) in full:
// slugify the name, write the row. Plus the slug uniquification Django does
// NOT do, which is where all the interesting behaviour is.
// ===========================================================================
describe("upsertOrderItem (create)", () => {
  it("inserts the row and returns the slug it actually wrote", async () => {
    const slug = await upsertOrderItem(session, { name: "Baked Beans", calories: 78 }, undefined);

    expect(slug).toBe("baked-beans");
    // Read back rather than trusting the return value: an INSERT that bound
    // its columns in the wrong order ("name, slug, calories" against values
    // "name, calories, slug") returns a perfectly correct slug and stores
    // nonsense. SQLite would not complain -- calories is INTEGER, but its
    // type affinity is advisory, and a TEXT slug lands in it happily.
    expect(allRows()).toEqual([{ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 }]);
  });

  // PARITY, RUN NOT REASONED (TESTING.md's rule). Each expected slug below was
  // produced by running django.utils.text.slugify itself -- checked on both
  // Django 5.2.6 and the 6.1 in foodcharity's venv, which agree -- and then
  // compared against this module's local copy:
  //
  //   "Baked Beans"                -> "baked-beans"
  //   "Tea & Coffee"               -> "tea-coffee"
  //   "Baked_Beans"                -> "baked_beans"
  //   "Café Crème"                 -> "cafe-creme"
  //   "Long-Life Milk  1L"         -> "long-life-milk-1l"
  //   "UHT Milk (Semi-Skimmed)"    -> "uht-milk-semi-skimmed"
  //   "  --Beans--  "              -> "beans"
  //   "Heinz  Beanz 4x415g"        -> "heinz-beanz-4x415g"
  //   "Beans - Value"              -> "beans-value"
  //   "Baked_Beans_"               -> "baked_beans"
  //
  // The accented and underscore cases are the ones worth having: NFKD is what
  // turns "Café" into "cafe" rather than dropping the letter entirely ("caf"),
  // and `\w` keeping "_" is what makes "baked_beans" a legal slug -- which in
  // turn is why uniqueSlug uses substr and not LIKE, where "_" is a wildcard.
  // (Mutating `.normalize("NFKD")` to "NFC" kills this row: the é stays one
  // code point, no combining mark is exposed, and the non-ASCII strip takes the
  // whole letter.)
  //
  // Deliberately NOT credited to COMBINING_MARKS_RE, though the module's
  // ordering invites it. Deleting that replace() entirely changes NOTHING
  // here or anywhere else in this file -- run, not reasoned -- because every
  // combining mark is >= U+0300 and the `[^\x00-\x7F]` strip on the next line
  // removes it regardless. The line is redundant, not load-bearing; a test
  // claiming to pin it would be pinning the line after it.
  //
  // THE LAST TWO ROWS EACH KILL A MUTANT THAT THE OTHER EIGHT SURVIVE, which
  // is the whole reason they are here:
  //
  //  * "Beans - Value" kills `[-\s]+` -> `\s+`. Every other name in the table
  //    keeps its hyphens and its spaces apart, so collapsing a MIXED run of
  //    the two is never exercised: the mutant returns "beans---value" here and
  //    "long-life-milk-1l" everywhere else. Product names in this table look
  //    like "Rice - Basmati" constantly.
  //  * "Baked_Beans_" kills `^[-_]+|[-_]+$` -> `^-+|-+$`. Django's final step
  //    is `.strip("-_")`, stripping BOTH characters from BOTH ends; the mutant
  //    strips only hyphens, and "  --Beans--  " cannot tell the difference
  //    because it has no underscore at either end. Django gives "baked_beans";
  //    the mutant leaves "baked_beans_".
  it.each([
    ["Baked Beans", "baked-beans"],
    ["Tea & Coffee", "tea-coffee"],
    ["Baked_Beans", "baked_beans"],
    ["Café Crème", "cafe-creme"],
    ["Long-Life Milk  1L", "long-life-milk-1l"],
    ["UHT Milk (Semi-Skimmed)", "uht-milk-semi-skimmed"],
    ["  --Beans--  ", "beans"],
    ["Heinz  Beanz 4x415g", "heinz-beanz-4x415g"],
    ["Beans - Value", "beans-value"],
    ["Baked_Beans_", "baked_beans"],
  ])("slugifies %j to %j, matching Django's slugify()", async (name, expected) => {
    expect(await upsertOrderItem(session, { name, calories: 100 }, undefined)).toBe(expected);
    expect(slugOf(1)).toBe(expected);
  });

  // The two non-ASCII whitespace cases, split out of the table above because
  // their inputs are invisible in a test name and have to be written as
  // escapes to be reviewable at all. Both are what a name pasted out of a
  // supermarket web page or a spreadsheet actually contains, and between them
  // they kill the mutant that DELETES `.replace(/[^\x00-\x7F]/g, "")` on the
  // theory that JS's ASCII-only `\w` already drops everything non-ASCII.
  //
  // It does not, because JS's `\s` is NOT ASCII-only: U+FEFF matches `\s`, so
  // without the explicit strip the BOM would become a HYPHEN rather than
  // vanishing. Run against Django 5.2.6, which is the arbiter here:
  //
  //   "Baked\u00A0Beans" -> "baked-beans"   (NFKD folds NBSP to a real space)
  //   "Baked\uFEFFBeans" -> "bakedbeans"    (NFKD leaves it; ascii-ignore eats it)
  //
  // The pair is the point: two invisible characters, one becomes a separator
  // and one disappears, and the port agrees with Django on both.
  it("folds a non-breaking space to a separator, exactly as Django's NFKD does", async () => {
    expect(await upsertOrderItem(session, { name: "Baked\u00A0Beans", calories: 78 }, undefined)).toBe("baked-beans");
  });

  it("drops a zero-width no-break space rather than turning it into a separator", async () => {
    expect(await upsertOrderItem(session, { name: "Baked\uFEFFBeans", calories: 78 }, undefined)).toBe("bakedbeans");
  });

  // slugify("!!!") is "", which in Django yields the row a /admin/item//edit/
  // URL -- a path that matches no route, so the item is unreachable forever.
  // The port substitutes "item". Worth its own test because the fallback is a
  // bare `base || "item"` that an "unused default" cleanup would delete.
  it('falls back to "item" when the name slugifies to nothing', async () => {
    expect(await upsertOrderItem(session, { name: "!!!", calories: 5 }, undefined)).toBe("item");
    expect(slugOf(1)).toBe("item");
  });

  // THE MUTANT THE `?2 IS NULL OR` GUARD EXISTS FOR. On a create there is no
  // row to exclude, so existingId binds as NULL -- and SQLite's `id <> NULL`
  // is NULL, never true, so a bare `AND id <> ?2` would filter out EVERY row,
  // hand uniqueSlug an empty taken-set, and return the colliding root slug
  // every time. Two rows would then share a slug and one would become
  // permanently uneditable: the exact defect uniqueSlug was written to
  // prevent, reintroduced by a predicate that reads correctly. This is the
  // same three-valued-logic trap donationPointsAdmin.ts documents at length,
  // solved there with `IS NOT` and here with an explicit NULL guard.
  //
  // The OTHER direction was run too: rewriting `id <> ?2` to `id IS NOT ?2`
  // changes nothing and no test goes red. That is correct, not a gap -- with
  // the `?2 IS NULL OR` guard in front, the two spellings can only ever be
  // compared against a non-NULL id, where they agree. It is worth knowing which
  // of the two is load-bearing: the GUARD is, and a cleanup that deletes it on
  // the grounds that `IS NOT` would have been safe anyway removes the wrong
  // half.
  it("still sees existing rows on a create, despite binding NULL for the exclusion", async () => {
    seed({ id: 1, name: "Baked Beans", slug: "baked-beans" });

    expect(await upsertOrderItem(session, { name: "Baked  Beans", calories: 78 }, undefined)).toBe("baked-beans-2");
  });

  it("suffixes -2, then -3, as further names collide", async () => {
    seed({ id: 1, name: "Baked Beans", slug: "baked-beans" });

    expect(await upsertOrderItem(session, { name: "Baked  Beans", calories: 1 }, undefined)).toBe("baked-beans-2");
    expect(await upsertOrderItem(session, { name: "Baked   Beans", calories: 2 }, undefined)).toBe("baked-beans-3");
    expect(allRows().map((r) => r.slug)).toEqual(["baked-beans", "baked-beans-2", "baked-beans-3"]);
  });

  // The counter restarts from 2 and takes the first FREE number -- it is not a
  // max()+1. Pinned because the two are indistinguishable until a row is
  // deleted, and this fixture is the state a delete leaves behind.
  it("fills a gap in the numbering rather than counting past the highest", async () => {
    seed({ id: 1, name: "Baked Beans", slug: "baked-beans" }, { id: 2, name: "Baked Beans Value", slug: "baked-beans-3" });

    expect(await upsertOrderItem(session, { name: "Baked  Beans", calories: 1 }, undefined)).toBe("baked-beans-2");
  });

  // THE REASON substr() REPLACED LIKE. D1 caps a LIKE/GLOB pattern at 50 BYTES
  // and errors above it. This name -- lifted verbatim from the module's own
  // comment -- slugifies to 55 characters, so `slug LIKE ?1 || '-%'` would
  // have thrown on the save for exactly the long, near-identical supermarket
  // names most likely to need disambiguating in the first place. (The comment
  // says 52; it is 55. Counted, not estimated. The point is unaffected.)
  it("disambiguates a slug well past D1's 50-byte LIKE limit", async () => {
    const long = "Sainsbury's Naturally Sweet Sweetcorn In Water 198g (157g*)";
    const first = await upsertOrderItem(session, { name: long, calories: 60 }, undefined);
    expect(first).toBe("sainsburys-naturally-sweet-sweetcorn-in-water-198g-157g");
    expect(first.length).toBe(55);

    // A distinct legal name -- lowercase "in" -- that slugifies identically.
    const second = await upsertOrderItem(session, { name: long.replace(" In ", " in "), calories: 60 }, undefined);
    expect(second).toBe("sainsburys-naturally-sweet-sweetcorn-in-water-198g-157g-2");
  });

  // The prefix predicate over-matches on purpose: "baked-beans-on-toast"
  // starts with "baked-beans-", so it lands in the taken-set for root
  // "baked-beans". That is harmless -- the candidates are only ever the root
  // and root-N, and an over-matched sibling can never equal one -- and this
  // test is what proves the over-match stays harmless. A uniquifier that
  // bumped to -2 here would rename an item every time an unrelated longer
  // name existed, which is how slugs drift away from the URLs already
  // published against them.
  it("does not bump the slug just because a longer, unrelated slug shares its prefix", async () => {
    seed({ id: 1, name: "Baked Beans On Toast", slug: "baked-beans-on-toast" });

    expect(await upsertOrderItem(session, { name: "Baked Beans", calories: 78 }, undefined)).toBe("baked-beans");
  });

  // slugify's `\w` keeps underscores, so "baked_beans" is a legal slug that
  // must stay distinct from "baked-beans" -- the root itself is compared with
  // `=`, and only the SIBLING search uses the prefix predicate.
  //
  // A CORRECTION TO THE FOLKLORE, since the module's comment invites it: "_"
  // being a LIKE wildcard is NOT observable in this function's output.
  // uniqueSlug loads the matches into a JS Set and then tests candidates
  // against it with exact string equality, so a slug LIKE over-matched can
  // never equal `root` or `root-N` and is discarded there. Mutating substr
  // back to `slug LIKE ?1 || '-%'` leaves every test in this file green,
  // deliberately -- the real and only reason for substr is D1's 50-byte
  // pattern cap, which real SQLite does not have and this suite therefore
  // cannot reproduce (see the header). The test below is still worth keeping:
  // it pins that an underscore survives slugify at all, which is what makes
  // the question arise.
  //
  // The same argument covers a second surviving mutant, also run: widening the
  // prefix predicate to `substr(slug, 1, length(?1)) = ?1`, which drops the
  // trailing dash and over-matches "baked-beansXYZ" as well. It is invisible
  // for the identical reason -- an over-matched slug lands in the Set and is
  // then never equal to a candidate. What is NOT invisible is the opposite
  // slip, NARROWING the predicate: `length(?1)` without the `+ 1`, or a start
  // index of 0, both make it match nothing and are killed by "suffixes -2,
  // then -3". If you are editing this predicate, that is the direction that
  // bites.
  it("treats an underscore as an ordinary slug character", async () => {
    seed({ id: 1, name: "Baked-Beans", slug: "baked-beans" });

    expect(await upsertOrderItem(session, { name: "Baked_Beans", calories: 78 }, undefined)).toBe("baked_beans");
    expect(allRows().map((r) => r.slug)).toEqual(["baked-beans", "baked_beans"]);
  });

  // WHY getOrderItemByName EXISTS. upsertOrderItem uniquifies the SLUG and
  // nothing else -- the NAME goes straight into a table carrying
  // orderitem_name_uniq, and a duplicate throws out of the query rather than
  // returning a form error. This is github #12's failure mode reproduced
  // against the real index: the pre-check in routes/admin/items.ts:128 is the
  // only thing standing between an admin and a 500 that eats their form. If
  // this test ever goes green-by-not-throwing, either the index was dropped
  // or upsert grew an INSERT OR IGNORE -- both worth a hard stop.
  it("does NOT pre-check the name: a duplicate reaches orderitem_name_uniq and throws", async () => {
    seed({ id: 1, name: "Baked Beans", slug: "baked-beans" });

    await expect(upsertOrderItem(session, { name: "Baked Beans", calories: 78 }, undefined)).rejects.toThrow(/UNIQUE constraint failed: orderitem\.name/);
  });
});

describe("upsertOrderItem (edit)", () => {
  it("updates the existing row in place rather than inserting a second one", async () => {
    seed({ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    const slug = await upsertOrderItem(session, { name: "Baked Beans 415g", calories: 81 }, 7);

    expect(slug).toBe("baked-beans-415g");
    // The row count is the assertion that matters: an upsert whose
    // existingId branch fell through to the INSERT would return the right
    // slug, render the right redirect, and quietly double the table.
    expect(allRows()).toEqual([{ id: 7, name: "Baked Beans 415g", slug: "baked-beans-415g", calories: 81 }]);
  });

  // THE MUTANT THE SELF-EXCLUSION EXISTS FOR, and the counterpart to the NULL
  // test above. Drop `AND (?2 IS NULL OR id <> ?2)` and the row being edited
  // matches its own slug, so every save renames it: baked-beans, then
  // baked-beans-2, then baked-beans-3, walking the slug -- and the published
  // /admin/item/<slug>/ URL -- one step further away on every single save.
  // Django's Model._perform_unique_checks() does the same `qs.exclude(pk=...)`
  // whenever the instance has a pk.
  it("keeps its own slug when re-saved without a rename", async () => {
    seed({ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    expect(await upsertOrderItem(session, { name: "Baked Beans", calories: 80 }, 7)).toBe("baked-beans");
    expect(await upsertOrderItem(session, { name: "Baked Beans", calories: 82 }, 7)).toBe("baked-beans");
    expect(allRows()).toEqual([{ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 82 }]);
  });

  // The exclusion must not be so broad that it stops seeing OTHER rows.
  it("still defers to another row's slug when renamed onto it", async () => {
    seed({ id: 1, name: "Baked Beans", slug: "baked-beans" }, { id: 7, name: "Tinned Tomatoes", slug: "tinned-tomatoes" });

    expect(await upsertOrderItem(session, { name: "Baked  Beans", calories: 78 }, 7)).toBe("baked-beans-2");
    expect(slugOf(1)).toBe("baked-beans"); // untouched
    expect(slugOf(7)).toBe("baked-beans-2");
  });

  // The legacy-collision endgame, and the one place the two halves of this
  // module visibly interlock. 0014 allows a duplicate `slug` to have survived
  // the load. /admin/item/baked-beans/edit/ resolves to the LOWER id (see
  // getOrderItemBySlug), so that is the row an admin can reach -- and saving
  // it, even unchanged, moves it to "baked-beans-2", because the OTHER row
  // still holds "baked-beans" and is not excluded. The previously
  // unreachable row inherits the URL.
  //
  // Surprising, but correct and terminating: one save per duplicate resolves
  // the pair permanently, whereas Django would have 500'd on the edit page
  // forever. Pinned here because it is the behaviour a reader would most
  // likely mistake for a bug and "fix" by excluding same-slug rows too --
  // which would leave the collision in place indefinitely.
  it("un-shadows a legacy duplicate: saving the reachable row re-slugs IT, not the other", async () => {
    seed({ id: 10, name: "Baked Beans", slug: "baked-beans", calories: 78 }, { id: 20, name: "Value Baked Beans", slug: "baked-beans", calories: 70 });

    const reachable = await getOrderItemBySlug(session, "baked-beans");
    expect(reachable?.id).toBe(10);

    await upsertOrderItem(session, { name: reachable!.name, calories: reachable!.calories }, reachable!.id);

    expect(slugOf(10)).toBe("baked-beans-2");
    expect(slugOf(20)).toBe("baked-beans");
    // And the collision is gone: the slug now resolves to exactly one row.
    expect((await getOrderItemBySlug(session, "baked-beans"))?.id).toBe(20);
  });

  // SUSPECT, PINNED NOT FIXED. An existingId matching no row makes the UPDATE
  // affect zero rows, but upsertOrderItem returns a slug regardless and
  // routes/admin/items.ts:138 redirects to /admin/items/ as if the save
  // succeeded -- the admin's edit vanishes with no error anywhere. Not
  // reachable through the current route (existingId always comes from a
  // get_object_or_404-equivalent read moments earlier), and Django's
  // form.save() on a stale instance does the same silent nothing, so this is
  // parity rather than a regression. Asserted as-is per TESTING.md: the test
  // states the behaviour, the report names the risk.
  it("silently writes nothing when existingId matches no row, but still returns a slug", async () => {
    seed({ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    expect(await upsertOrderItem(session, { name: "Ghost Item", calories: 1 }, 999)).toBe("ghost-item");
    expect(allRows()).toEqual([{ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 78 }]);
  });
});

// ===========================================================================
// ITEM_LIST_SORTS -- the allowlist routes/admin/items.ts:40 filters `?sort=`
// through before it is INTERPOLATED into the ORDER BY.
// ===========================================================================
describe("ITEM_LIST_SORTS", () => {
  // Two facts in one assertion, and both matter. The membership is the
  // injection boundary: `sort` reaches the SQL by string interpolation, so
  // anything that widens this list past the private ITEM_SORT_SQL map's keys
  // is either a SQL error or a hole. The ORDER is the UI: items.njk's column
  // headers are generated in this order.
  it("is exactly name and calories, in that order", () => {
    expect([...ITEM_LIST_SORTS]).toEqual(["name", "calories"]);
  });

  // ITEM_SORT_SQL is private, so a new entry added to ITEM_LIST_SORTS without
  // a matching entry there is a type error only if the author is looking --
  // and at runtime it interpolates `undefined` into the ORDER BY and 500s the
  // whole list page. This loop is the guard: every allowlisted value must
  // produce SQL that a real engine will run.
  it("every value in it produces runnable SQL in both directions", async () => {
    seed({ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    for (const sort of ITEM_LIST_SORTS) {
      for (const direction of ["asc", "desc"] as const) {
        const page = await getOrderItemsPage(session, sort, direction, 1, 10);
        expect(page.rows.map((r) => r.id)).toEqual([1]);
      }
    }
  });
});

// ===========================================================================
// getOrderItemsPage -- gfadmin/views.py:2241-2249 items(), which is
// `OrderItem.objects.all()` with no order_by and no pagination at all. The
// port adds both, so all of the behaviour below is the port's own and none of
// it is covered by Django parity. It is also the only paginated read in this
// module, which makes ORDER BY, LIMIT/OFFSET and the total the whole surface.
// ===========================================================================
describe("getOrderItemsPage", () => {
  // Mixed capitalisation on purpose. SQLite's default collation is BINARY, so
  // "Butter" (0x42) sorts before "apple" (0x61) -- every capitalised name
  // ahead of every lowercase one. The source Postgres ran en_US.utf8 and never
  // did that, and an admin scanning 1,200 grocery names down a column would
  // see a list that looks alphabetical twice over. Deleting the COLLATE NOCASE
  // is a one-word edit that throws no error and changes nothing structural --
  // this seed is the only thing that catches it. Verified against real SQLite:
  // bytewise gives [Banana, apple, cherry], NOCASE gives [apple, Banana,
  // cherry].
  it("sorts by name case-insensitively, not bytewise", async () => {
    seed(
      { id: 1, name: "cherry", slug: "cherry" },
      { id: 2, name: "Banana", slug: "banana" },
      { id: 3, name: "apple", slug: "apple" },
      { id: 4, name: "Damson", slug: "damson" },
    );

    const page = await getOrderItemsPage(session, "name", "asc", 1, 10);
    expect(page.rows.map((r) => r.name)).toEqual(["apple", "Banana", "cherry", "Damson"]);
  });

  it("reverses the whole order on desc", async () => {
    seed({ id: 1, name: "cherry", slug: "cherry" }, { id: 2, name: "Banana", slug: "banana" }, { id: 3, name: "apple", slug: "apple" });

    const page = await getOrderItemsPage(session, "name", "desc", 1, 10);
    expect(page.rows.map((r) => r.name)).toEqual(["cherry", "Banana", "apple"]);
  });

  // The module's comment says NOCASE is "ASCII-only -- not a full linguistic
  // collation". This is what that costs, run rather than asserted from the
  // docs: "Éclair" is two bytes starting 0xC3, so it sorts after every ASCII
  // name regardless of case, where en_US.utf8 would have filed it under E.
  // Pinned as a KNOWN LIMITATION, not a wish. If someone later ports a real
  // collator (types.ts's NAME_COLLATOR does this in JS for the public lists),
  // this test should be updated deliberately, not discovered by surprise.
  it("files accented names last -- NOCASE folds ASCII only", async () => {
    seed({ id: 1, name: "Éclair", slug: "eclair" }, { id: 2, name: "zebra cake", slug: "zebra-cake" }, { id: 3, name: "apple", slug: "apple" });

    const page = await getOrderItemsPage(session, "name", "asc", 1, 10);
    expect(page.rows.map((r) => r.name)).toEqual(["apple", "zebra cake", "Éclair"]);
  });

  it("sorts by calories, breaking ties on id ascending", async () => {
    seed(
      { id: 3, name: "Aaa", slug: "aaa", calories: 100 },
      { id: 1, name: "Bbb", slug: "bbb", calories: 100 },
      { id: 2, name: "Ccc", slug: "ccc", calories: 50 },
    );

    const page = await getOrderItemsPage(session, "calories", "asc", 1, 10);
    expect(page.rows.map((r) => r.id)).toEqual([2, 1, 3]);
  });

  // The tiebreak is `id ASC` even when the primary key is DESC -- it is
  // appended after the direction, not swung with it. Worth its own case
  // because "make the tiebreak follow the direction" looks like a tidy-up and
  // is indistinguishable from correct until you look at a tied pair. With
  // calories DESC the mutant gives [3, 1, 2]; the real code gives [1, 3, 2].
  it("keeps the id tiebreak ascending even when the sort is descending", async () => {
    seed(
      { id: 3, name: "Aaa", slug: "aaa", calories: 100 },
      { id: 1, name: "Bbb", slug: "bbb", calories: 100 },
      { id: 2, name: "Ccc", slug: "ccc", calories: 50 },
    );

    const page = await getOrderItemsPage(session, "calories", "desc", 1, 10);
    expect(page.rows.map((r) => r.id)).toEqual([1, 3, 2]);
  });

  // The one fixture where the COLLATION, not the bytes, decides the
  // comparison: `name COLLATE NOCASE` makes "APPLE", "apple" and "Apple" three
  // EQUAL sort keys, while orderitem_name_uniq -- which is BINARY -- lets all
  // three exist as distinct rows. A ten-year-old item list typed in by several
  // admins genuinely holds sets like this, and it is the only way `id ASC` gets
  // to decide the WHOLE order rather than just a tail.
  //
  // KILLS TWO MUTANTS the rest of the block does not, both run:
  //  * Deleting `COLLATE NOCASE`: BINARY sorts "APPLE" < "Apple" < "apple", so
  //    the mutant returns 1, 3, 2. The "sorts by name case-insensitively" case
  //    above catches a NOCASE drop across DIFFERENT words; this one catches it
  //    within one word, which is the harder and likelier data.
  //  * Swinging the tiebreak to `id DESC`: every name ties, so the mutant
  //    reverses the lot -- 3, 2, 1.
  //
  // DOES NOT kill "delete `, id ASC`", and the measurement is worth recording
  // because it looks like it should. Under THIS statement -- which selects four
  // columns and therefore scans the table -- SQLite's sorter preserves rowid
  // order for equal keys at every size tried (3 rows to 16,000 all-tied rows,
  // both directions, spilling payloads, paged and unpaged). Change the select
  // list to `SELECT id` and the SAME fixture returns 1, 3, 2 without the
  // tiebreak, because the plan switches to a covering scan of the BINARY name
  // index and the sorter inherits that order. That is the whole argument for
  // the clause in one experiment: the order is a property of the chosen PLAN,
  // not of the query, and D1 is free to choose differently.
  //
  // Both directions assert the SAME ids, which is the other point: `id ASC`
  // does not swing with `direction`.
  it("breaks a COLLATE NOCASE tie on id, in both directions", async () => {
    seed({ id: 1, name: "APPLE", slug: "apple-caps" }, { id: 2, name: "apple", slug: "apple-lower" }, { id: 3, name: "Apple", slug: "apple-title" });

    expect((await getOrderItemsPage(session, "name", "asc", 1, 10)).rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect((await getOrderItemsPage(session, "name", "desc", 1, 10)).rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  // WHY THE TIEBREAK IS THERE AT ALL, stated as the failure it prevents:
  // `calories` has heavy ties across 1,200 rows, and an ORDER BY that is not a
  // total order lets a page-and-offset query return a tied row on page 1 AND
  // page 2, or on neither. The admin sees a list that is subtly wrong in a way
  // no count reveals.
  //
  // HONEST ABOUT WHAT THIS KILLS, same as getOrderItemBySlug's ordering case:
  // deleting `, id ASC` does NOT turn THIS test red. Measured against real
  // SQLite at 5, 50, 200, 1,200 and 5,000 rows, in both directions, and with a
  // top-25 LIMIT over a 1,000-way tie: an INTEGER tie comes back in rowid order
  // whether or not you ask for it. What this test pins is therefore the
  // CONTRACT rather than today's accident -- and the contract is the point,
  // because D1 is not this SQLite build and a sort that spills is under no
  // obligation to be stable.
  //
  // No test in this file kills the OUTRIGHT DELETION of `, id ASC`, and none
  // can: see "breaks a COLLATE NOCASE tie on id" above, which chases the same
  // mutant through the collation instead and records why the deletion is
  // invisible here but not under a different query plan. What IS killed, by
  // the case above this one, is swinging the tiebreak WITH the direction.
  it("partitions a fully-tied table across pages with no row repeated or lost", async () => {
    seed(
      { id: 1, name: "Aaa", slug: "aaa", calories: 100 },
      { id: 2, name: "Bbb", slug: "bbb", calories: 100 },
      { id: 3, name: "Ccc", slug: "ccc", calories: 100 },
      { id: 4, name: "Ddd", slug: "ddd", calories: 100 },
      { id: 5, name: "Eee", slug: "eee", calories: 100 },
    );

    const seen: number[] = [];
    for (let page = 1; page <= 3; page++) {
      seen.push(...(await getOrderItemsPage(session, "calories", "asc", page, 2)).rows.map((r) => r.id));
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns one page of rows while reporting the whole table's total", async () => {
    seed(
      { id: 1, name: "Aaa", slug: "aaa" },
      { id: 2, name: "Bbb", slug: "bbb" },
      { id: 3, name: "Ccc", slug: "ccc" },
      { id: 4, name: "Ddd", slug: "ddd" },
      { id: 5, name: "Eee", slug: "eee" },
    );

    const page = await getOrderItemsPage(session, "name", "asc", 1, 2);

    // `total` drives totalPages() and the "1,200 items" heading. A COUNT that
    // picked up the LIMIT -- or that counted the returned array -- would show
    // "2 items" and one page, hiding 1,198 rows behind a pager that renders no
    // links at all.
    expect(page.total).toBe(5);
    expect(page.rows.map((r) => r.name)).toEqual(["Aaa", "Bbb"]);
  });

  it("applies OFFSET so page 2 is the next slice, not the same one", async () => {
    seed(
      { id: 1, name: "Aaa", slug: "aaa" },
      { id: 2, name: "Bbb", slug: "bbb" },
      { id: 3, name: "Ccc", slug: "ccc" },
      { id: 4, name: "Ddd", slug: "ddd" },
      { id: 5, name: "Eee", slug: "eee" },
    );

    expect((await getOrderItemsPage(session, "name", "asc", 2, 2)).rows.map((r) => r.name)).toEqual(["Ccc", "Ddd"]);
    expect((await getOrderItemsPage(session, "name", "asc", 3, 2)).rows.map((r) => r.name)).toEqual(["Eee"]);
  });

  // hasNext is `offset + pageSize < total`, and the boundary is where a
  // one-character slip (<= for <) shows up: with 4 rows at 2 per page, page 2
  // is the last one and must not offer a "Next" link into an empty page.
  it("computes hasNext at the exact page boundary", async () => {
    seed(
      { id: 1, name: "Aaa", slug: "aaa" },
      { id: 2, name: "Bbb", slug: "bbb" },
      { id: 3, name: "Ccc", slug: "ccc" },
      { id: 4, name: "Ddd", slug: "ddd" },
    );

    expect((await getOrderItemsPage(session, "name", "asc", 1, 2)).hasNext).toBe(true);
    expect((await getOrderItemsPage(session, "name", "asc", 2, 2)).hasNext).toBe(false);
    // A page size that exactly equals the total is one page, never two.
    expect((await getOrderItemsPage(session, "name", "asc", 1, 4)).hasNext).toBe(false);
  });

  // Deliberately page 3 of 3 with a RAGGED last page (7 rows, 3 per page), not
  // another 2-of-2. hasNext must be computed from the OFFSET, and on any
  // two-page fixture `page + pageSize` and `offset + pageSize` happen to agree
  // -- the arithmetic bug only separates from the correct code once the page
  // number and the offset have diverged far enough. Here `offset + pageSize`
  // is 9 (no next page, correctly) while `page + pageSize` is 6, which is
  // still under the total of 7 and would render a "Next" link onto nothing.
  // Confirmed by mutation: this is the only assertion in the file that kills
  // that swap.
  it("computes hasNext from the offset, not the page number", async () => {
    seed(
      { id: 1, name: "Aaa", slug: "aaa" },
      { id: 2, name: "Bbb", slug: "bbb" },
      { id: 3, name: "Ccc", slug: "ccc" },
      { id: 4, name: "Ddd", slug: "ddd" },
      { id: 5, name: "Eee", slug: "eee" },
      { id: 6, name: "Fff", slug: "fff" },
      { id: 7, name: "Ggg", slug: "ggg" },
    );

    const last = await getOrderItemsPage(session, "name", "asc", 3, 3);
    expect(last.rows.map((r) => r.name)).toEqual(["Ggg"]);
    expect(last.hasNext).toBe(false);
    expect((await getOrderItemsPage(session, "name", "asc", 2, 3)).hasNext).toBe(true);
  });

  it("echoes back the page and pageSize it was asked for", async () => {
    seed({ id: 1, name: "Aaa", slug: "aaa" });

    const page = await getOrderItemsPage(session, "name", "asc", 3, 25);

    // Not recomputed or clamped: routes/admin/items.ts feeds these straight
    // into the pagination links and into totalPages(). A function that
    // normalised an out-of-range page back to 1 here would render "Page 1 of
    // 1" over an empty table and strand the admin.
    expect(page.page).toBe(3);
    expect(page.pageSize).toBe(25);
  });

  it("returns an empty page past the end without claiming another one follows", async () => {
    seed({ id: 1, name: "Aaa", slug: "aaa" }, { id: 2, name: "Bbb", slug: "bbb" });

    const page = await getOrderItemsPage(session, "name", "asc", 9, 10);
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(2);
    expect(page.hasNext).toBe(false);
  });

  // An empty table must report total 0 and no next page -- totalPages()
  // divides by this downstream, so a null or a NaN here is a broken pager.
  //
  // A CORRECTION, since the obvious reading of this test is wrong: it does NOT
  // exercise `countRow?.n ?? 0`. `SELECT COUNT(*)` returns a row on an empty
  // table -- `{ n: 0 }` -- so `first()` is never null and the `?? 0` never
  // fires. Mutating it to `?? -1` leaves this test, and every other test in the
  // file, green: the fallback is unreachable defensive code as long as the
  // statement is an unfiltered COUNT. Left unkilled deliberately rather than
  // faked with a stubbed session, which would test the stub. What this test
  // really pins is that COUNT and the empty row list agree at zero.
  it("survives an empty table", async () => {
    const page = await getOrderItemsPage(session, "name", "asc", 1, 10);
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.hasNext).toBe(false);
  });

  // What the list page hands the template: four keys, no more and no fewer.
  // items.njk spreads every row into an object it then adds `edit_url` to, so a
  // column that stopped being selected reaches the template as `undefined` and
  // renders as an empty cell -- silent, and one of the four is the `slug` the
  // edit link is built from.
  //
  // It does NOT catch a rewrite to `SELECT *`, which returns exactly these four
  // keys too, and the mutant was run to confirm that. Nothing in this file can:
  // the table has precisely these columns, so the two statements are identical
  // until a migration adds a fifth. Named columns are still the right SQL --
  // that is the day `*` would start leaking a column the type does not declare
  // -- but this test is not what enforces it.
  it("returns exactly the four declared columns per row", async () => {
    seed({ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    const page = await getOrderItemsPage(session, "name", "asc", 1, 10);
    expect(Object.keys(page.rows[0]!).sort()).toEqual(["calories", "id", "name", "slug"]);
    expect({ ...page.rows[0] }).toEqual({ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 });
  });

  // Direction is a two-member union in TypeScript, but it arrives from a query
  // string via routes/admin/items.ts:38 and the SQL builder is a bare
  // `direction === "desc" ? "DESC" : "ASC"`. Anything that is not exactly
  // "desc" sorts ascending -- it never falls through to an empty string, which
  // would leave `ORDER BY name COLLATE NOCASE , id ASC` (still valid SQL, so
  // silent) or worse. Cast because the type correctly forbids what the runtime
  // must survive.
  it("treats any direction other than the exact string desc as ascending", async () => {
    seed({ id: 1, name: "Bbb", slug: "bbb" }, { id: 2, name: "Aaa", slug: "aaa" });

    const page = await getOrderItemsPage(session, "name", "DESC" as unknown as "asc", 1, 10);
    expect(page.rows.map((r) => r.name)).toEqual(["Aaa", "Bbb"]);
  });

  // ItemListSort is used as a value here only to keep the import honest --
  // the type is exported and every caller narrows a query string into it.
  it("accepts a narrowed ItemListSort", async () => {
    seed({ id: 1, name: "Aaa", slug: "aaa", calories: 12 });

    const sort: ItemListSort = "calories";
    expect((await getOrderItemsPage(session, sort, "asc", 1, 10)).rows[0]?.calories).toBe(12);
  });
});
