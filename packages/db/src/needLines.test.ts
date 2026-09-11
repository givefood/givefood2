import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { beforeEach, describe, expect, it } from "vitest";
import { ITEM_CATEGORIES, ITEM_CATEGORY_GROUPS, getChangeLinesForNeed, getLatestLineForItem, replaceNeedLines } from "./needLines";
import type { NeedLineInput, NeedLineRow, NeedLineType } from "./needLines";
import type { Session } from "./types";

// WP 6.4's FoodbankChangeLine layer -- the three statements behind
// /admin/need/<uuid>/categorise/ (gfadmin/views.py:2041-2135 need_categorise),
// where an admin assigns one of 50 categories to each line of a scraped need.
//
// WHY A REAL DATABASE, NOT A MOCK. Two of these functions are a SELECT and
// nothing else and the third is a check-then-write; a session that hands back
// canned rows agrees with every possible statement, including the wrong ones.
// And the wrong ones here are SILENT. `WHERE need_id = ?` drifting to
// `foodbank_id = ?` shows the admin a form pre-filled from a different need's
// categorisation. `ORDER BY id DESC` drifting to `created DESC` picks an
// arbitrary line, because every line of one need shares a timestamp
// (needs.py:374 copies `created` from the parent need). Transposing
// upsertNeedLine's two binds makes the existence check match nothing, so every
// save appends a duplicate row instead of editing in place. None of those
// throws, none logs, and each renders a plausible page. This package already
// carries that exact scar: migration 0019 dropped six tables' cached parent
// columns and four queries went on naming them until /dashboard/beautybanks/
// was measured and found to be a live 500.
//
// So the statements below are run, by SQLite, against the real schema.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order, for the
// same reason -- a CREATE TABLE transcribed into a test file is a second copy
// of the truth and drifts from the first. Three facts it supplies that a
// hand-written schema would very likely have got wrong, and that tests below
// depend on:
//   * the column is `group_name`, not `group` (renamed in the port because
//     `group` is a SQL reserved word -- 0005_orders_and_charity.sql:13). Both
//     reading functions are `SELECT *`, so this file's "every column of
//     NeedLineRow" assertion is the only thing standing between a future
//     rename and a `row.group_name` that is silently `undefined`.
//   * `group_name TEXT NOT NULL`, which is what turns the prototype-key hole
//     below into a loud constraint error rather than a written row.
//   * there is NO unique index on (need_id, item) -- deliberately, matching
//     Django, which dedupes through the existing_need_lines prefetch and not a
//     constraint. Duplicates are therefore reachable, and which duplicate each
//     function picks is a real question with a real (and inconsistent) answer.
//     See "duplicate item" below.
//
// MUTATION-TESTED (TESTING.md's convention: the evidence a test is
// load-bearing rather than decoration). The module was copied into a
// scratchpad and broken, first 31 ways when this file was written and then a
// further 71 in an adversarial review pass. The SQL survived all of it: every
// mutant of the three statements died, including getChangeLinesForNeed's
// filter dropped, re-pointed at foodbank_id, inverted to `!=` and narrowed
// with `AND type = 'need'`; a `LIMIT 1` added to it; its Map keyed by
// category and by id instead of item, and built from the first row alone;
// both `SELECT *`s narrowed to a column subset; getLatestLineForItem's ORDER
// BY swapped for `created DESC`, `id ASC` and `created ASC`; its `=` loosened
// to LIKE, to COLLATE NOCASE and to `trim(item) = trim(?)`, and narrowed with
// `AND type = 'need'` and with a foodbank_id scope; upsertNeedLine's group
// lookup replaced by the category itself and by a `?? "Other"` default; the
// `throw` deleted and moved after the SELECT; `created` written as `new
// Date().toISOString()`; the INSERT's column list shifted by one and its
// need/foodbank, type/category and group/created binds transposed; the
// existence check's binds transposed, the check widened to item alone and to
// need alone, narrowed with `AND type = ?`, and re-ordered to take the lowest
// duplicate id; the two branches swapped and the update branch disabled
// outright; the UPDATE's group_name assignment dropped, its binds swapped,
// its `WHERE id = ?` re-pointed at need_id and its bind at params.needId;
// ITEM_CATEGORIES left unsorted and built from Object.values.
//
// Three of those deserve calling out because they are the FIX, not a break.
// Adding `type = ?` or `created = ?` to the UPDATE's SET list -- the Django
// parity the module does not have -- fails here, and so does rewriting the
// group lookup as `Object.hasOwn(...) ? ... : undefined`, which closes the
// prototype-key hole below. All three are deliberate. The divergences are
// pinned, and pinning them is what makes changing one a decision rather than
// an accident.
//
// FOUR MUTANTS SURVIVED THE FIRST VERSION OF THIS FILE and are the reason
// four tests below exist: fourteen separate single-entry changes to
// ITEM_CATEGORY_GROUPS' values (see the Django copy above that describe
// block), `ORDER BY id DESC` added to getChangeLinesForNeed, `[row.item.trim(),
// row]` as its Map key, and `params.item.trim()` in upsertNeedLine's existence
// check. Each is named in the comment of the test that now kills it.
//
// THE SURVIVORS THAT REMAIN, stated rather than hidden:
//   * deleting `LIMIT 1` from getLatestLineForItem -- or raising it to 2 --
//     changes nothing observable, because `.first()` takes the head of the
//     result set either way. That LIMIT is a performance guard, not a semantic
//     one: it is what lets the (item, id DESC) seek stop at the first entry
//     instead of materialising every row for the item, which is the whole of
//     migration 0021 (5,735 rows read for one lookup of "Tinned Soup" before
//     it existed).
//   * deleting the whole `ORDER BY id DESC` also survives, and that is worth
//     understanding rather than fixing. `EXPLAIN QUERY PLAN` on the
//     ORDER-BY-less form still reports `SEARCH ... USING INDEX
//     foodbankchangeline_item_id_idx (item=?)`, and that index is declared
//     `(item, id DESC)`, so scanning it forward yields the highest id first
//     anyway. Measured directly rather than assumed: re-running the same
//     fixture against a schema with 0021's index dropped moves the plan to
//     `foodbankchangeline_item_created_idx` and the ORDER-BY-less answer to
//     the WRONG row. So the query is right by accident once 0021 exists, and
//     would silently start returning an arbitrary line if that index were ever
//     removed as redundant. Only a query-plan assertion could kill this, and
//     that pins SQLite's optimiser rather than this module.
//   * `return row ?? null` cannot be distinguished from `return row`, because
//     the adapter below already converts node:sqlite's `undefined` into the
//     `null` real D1 returns. Modelling it any other way would be modelling a
//     D1 that does not exist.
//
// NO CHUNKING TO TEST, and that is itself the ported decision. D1 caps a
// statement at 100 bound parameters, which is the boundary every
// variable-length IN list in this package has to be tested at. Django built
// one here -- `filter(item__in=all_items)` over every line of the need
// (views.py:2062-2067) -- and a need with more than 100 lines would have
// exceeded that cap outright. needLines.ts:88-90 replaced it with one
// single-bind query per item on purpose, so no statement below binds more
// than seven values no matter how large the need.

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API this package is handed, backed by
// node:sqlite. Copied from crawlSets.test.ts (itself copied from
// adminDashboardStats.test.ts, itself from
// workers/site/src/routes/admin/foodbankLocation.test.ts) so every tier drives
// the real code through one adapter. Deliberately dumb -- it forwards the SQL
// untouched and interprets nothing, so the engine decides which rows come
// back, not this file.
// D1 rejects a statement binding more than 100 values, with this message
// (platform/limits: "Maximum bound parameters per query: 100"). node:sqlite
// has no such cap, so the fake has to impose it or a statement that cannot
// run in production passes here -- the same class of hole that let three
// bugs ship green before (see the fakes-must-not-be-looser rule).
const D1_MAX_BOUND_PARAMS = 100;

// Round trips, which is the whole point of the batch. `queries` counts
// prepare().first()/all()/run(); `batches` counts batch() calls, each of
// which is ONE round trip however many statements it carries.
const trips = { queries: 0, batches: 0, batchedStatements: 0 };

function d1Session(db: DatabaseSync): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      trips.queries += 1;
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      trips.queries += 1;
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      trips.queries += 1;
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  type Fake = ReturnType<typeof statement>;
  return {
    prepare: (sql: string) => statement(sql, []),
    // ATOMIC, because D1's is: a batch runs in an implicit transaction and
    // either all of it lands or none of it does. A fake that applied
    // statements one at a time would let a half-written set pass a test that
    // production would have rolled back.
    batch: async (statements: Fake[]) => {
      trips.batches += 1;
      trips.batchedStatements += statements.length;
      for (const s of statements) {
        if (s.params.length > D1_MAX_BOUND_PARAMS) {
          throw new Error(`D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR`);
        }
      }
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} }));
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    getBookmark: () => null,
  } as unknown as Session;
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

// EVERY TIMESTAMP IN THIS FILE IS DJANGO'S FORMAT: "YYYY-MM-DD HH:MM:SS.ffffff",
// which is what pyDatetime() writes and what migration 0022 rewrote the 25
// imported foodbankchangeline rows into (0022_normalise_timestamps.sql:58-60).
// That is not decoration. `created` is TEXT and every comparison over it is
// byte-wise, so the format is load-bearing: a toISOString() value
// ("2026-09-05T15:00:00Z") sorts ABOVE every space-separated one because 'T'
// (0x54) beats ' ' (0x20). One test below seeds exactly such a row on purpose.
const NEED_CREATED = "2026-09-05 15:00:00.000000";

// Two needs belonging to the SAME food bank, which is what production looks
// like (a food bank posts a new need every few days). Seeding them under one
// food bank is what makes the scoping tests real: a `WHERE foodbank_id = ?`
// mutant would return both needs' lines, where a `WHERE need_id = ?` returns
// one need's. Numerically distinct from the food bank id so a transposed bind
// cannot coincidentally match.
const SALISBURY = 7;
const NEED = 41;
const OTHER_NEED = 42;

interface LineSeed {
  id: number;
  need_id: number;
  foodbank_id?: number;
  item: string;
  type?: NeedLineType;
  category?: string;
  group_name?: string;
  created?: string;
}

// Seeds a row DIRECTLY, bypassing upsertNeedLine, so that the read tests are
// not reading back whatever the write function happened to do. `group_name` is
// free-form here for the same reason -- a fixture that re-derived it from
// ITEM_CATEGORY_GROUPS would make upsertNeedLine's derivation circular.
function seedLine(db: DatabaseSync, line: LineSeed): void {
  db.prepare(
    `INSERT INTO foodbankchangeline (id, need_id, foodbank_id, item, type, category, group_name, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    line.id,
    line.need_id,
    line.foodbank_id ?? SALISBURY,
    line.item,
    line.type ?? "need",
    line.category ?? "Other",
    line.group_name ?? "Other",
    line.created ?? NEED_CREATED,
  );
}

function allLines(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM foodbankchangeline ORDER BY id").all() as unknown as Record<string, unknown>[];
}

// givefood/const/item_types.py:3-53, copied by hand from the Django source in
// the Python file's own dict order, unwrapped from its `_()` calls (the msgid
// is the argument, and the msgid is what this port stores). Both halves of
// each pair: the category AND the group it belongs to.
//
// WHY A SECOND COPY, when the module under test is right there. Because an
// adversarial mutation run over this file found that fourteen single-entry
// group changes -- `Noodles: "Snack Food"`, `Sauce: "Meal Food"`,
// `"Baby Food": "Meal Food"`, `Laundry: "Toiletries"`, `"Carrier Bags":
// "Cleaning"`, `Biscuits: "Meal Food"`, `"Instant Mash": "Cooking"`,
// `Dental: "Cleaning"`, `Squash: "Cooking"`, `"Toilet Roll": "Cleaning"`,
// `Coffee: "Meal Food"`, `Vegetable: "Cooking"`, `Wipes: "Toiletries"`,
// `"Hot Chocolate": "Snack Food"` -- passed every test in the entire
// repository. They keep the key count at 50 and the group set at the same 8,
// so a count assertion, a group-set assertion and a spot check of eight
// favourites all wave them through.
//
// That was not a theoretical gap. `group_name` is a stored column, written on
// every categorise save and never recomputed, so a wrong entry here is
// permanent in the data: rows written before the change keep the old group,
// rows after get the new one, and the same item is filed under two groups
// forever. Nothing errors and nothing logs.
//
// And no other file covers it. workers/site/src/lib/itemCategories.test.ts
// diffs this table against Django by KEY -- `expect(Object.keys(
// ITEM_CATEGORY_GROUPS)).toEqual([...DJANGO_ITEM_CATEGORY_KEYS])`
// (itemCategories.test.ts:112) -- and asserts of the values only that each is
// a non-empty string, plus the single entry `"Other" -> "Other"`. The group
// each category maps to is pinned nowhere but here.
//
// Entry-for-entry and IN ORDER, via Object.entries, which also pins the
// insertion order of the object literal. That order is load-bearing for a
// second reason: itemCategories.test.ts uses `Object.keys()` of this very
// object as its proxy for item_types.py's dict order, because the Python file
// is not vendored into this repo. A tidy-up that alphabetised this literal
// would quietly demote that test's premise to folklore.
const DJANGO_ITEM_CATEGORY_GROUPS: readonly (readonly [string, string])[] = [
  ["Tinned Tomatoes", "Meal Food"],
  ["Tinned Meat", "Meal Food"],
  ["Tinned Vegetarian", "Meal Food"],
  ["Tinned Pasta", "Meal Food"],
  ["Confectionery", "Snack Food"],
  ["Cereal", "Meal Food"],
  ["Tinned Fruit", "Meal Food"],
  ["Milk", "Drink"],
  ["Fruit Juice", "Drink"],
  ["Squash", "Drink"],
  ["Condiment", "Cooking"],
  ["Noodles", "Meal Food"],
  ["Cooking Oil", "Cooking"],
  ["Tinned Fish", "Meal Food"],
  ["Soup", "Meal Food"],
  ["Crisps", "Snack Food"],
  ["Biscuits", "Snack Food"],
  ["Baked Beans", "Meal Food"],
  ["Tinned Vegetables", "Meal Food"],
  ["Pasta Sauce", "Cooking"],
  ["Pasta", "Meal Food"],
  ["Rice", "Meal Food"],
  ["Tea", "Drink"],
  ["Coffee", "Drink"],
  ["Sugar", "Cooking"],
  ["Spread", "Meal Food"],
  ["Vegetable", "Meal Food"],
  ["Instant Mash", "Meal Food"],
  ["Dessert", "Meal Food"],
  ["Washing Up Liquid", "Cleaning"],
  ["Toilet Roll", "Toiletries"],
  ["Shower Gel", "Toiletries"],
  ["Shampoo", "Toiletries"],
  ["Soap", "Toiletries"],
  ["Dental", "Toiletries"],
  ["Deodorant", "Toiletries"],
  ["Laundry", "Cleaning"],
  ["Sanitary Products", "Toiletries"],
  ["Baby Food", "Baby Supplies"],
  ["Baby Milk", "Baby Supplies"],
  ["Nappies", "Baby Supplies"],
  ["Wipes", "Baby Supplies"],
  ["Kitchen Roll", "Cleaning"],
  ["Household Supplies", "Cleaning"],
  ["Pet Food", "Other"],
  ["Carrier Bags", "Other"],
  ["Sauce", "Cooking"],
  ["Other", "Other"],
  ["Toiletries", "Toiletries"],
  ["Hot Chocolate", "Drink"],
];

describe("ITEM_CATEGORY_GROUPS", () => {
  // The module header says "each of the 49 categories". It is 50 --
  // givefood/const/item_types.py holds 50 keys, counted by running Python over
  // the file rather than by eye. Pinned as TESTING.md pins textClean's 173-of-
  // 252: the code is right and its own comment is wrong, and a test that
  // asserted the comment would be asserting a wish.
  //
  // The count is not trivia. workers/site/src/lib/itemCategories.ts holds a
  // SECOND hand-port of this table, one entry shorter ("Other" removed), and
  // its own suite asserts the two agree by exactly that one entry. A 51st
  // category added here and not there is a permanently empty "by item"
  // results page, reported to the user as "no food banks near you need this".
  it("holds all 50 of Django's categories, mapped onto 8 groups", () => {
    expect(Object.keys(ITEM_CATEGORY_GROUPS)).toHaveLength(50);
    expect([...new Set(Object.values(ITEM_CATEGORY_GROUPS))].sort()).toEqual([
      "Baby Supplies",
      "Cleaning",
      "Cooking",
      "Drink",
      "Meal Food",
      "Other",
      "Snack Food",
      "Toiletries",
    ]);
  });

  // Every value written into foodbankchangeline.group_name comes from here and
  // nowhere else (upsertNeedLine takes no group parameter), so this table IS
  // the group column's domain -- and, per the note above the copy, the only
  // place in the repo where the category -> group half of item_types.py is
  // checked at all. Asserted entry for entry against the hand copy rather than
  // spot-checked, because a spot check is exactly what fourteen surviving
  // single-entry mutants walked past.
  //
  // Compared as an ARRAY of entries, not as an object: `toEqual` on two
  // objects ignores key order, and the key order is itself under test (see the
  // copy's header -- itemCategories.test.ts borrows it as its stand-in for
  // item_types.py's dict order). This form kills a duplicated key inserted at
  // the top of the literal, which leaves both the count and every value
  // intact and moves only the position.
  //
  // Four entries worth knowing by heart, because they are the ones a
  // well-meaning reader "corrects": "Spread" is a Meal Food, not a Cooking
  // item; "Toiletries" is both a category and a group name, so a lookup that
  // had degenerated into returning the key would still look right for it and
  // wrong for the other 49; "Pet Food" and "Carrier Bags" are Other, not Meal
  // Food and not Cleaning; "Sauce" is Cooking while "Soup" is Meal Food.
  it("maps every category to the group Django maps it to, in Django's order", () => {
    expect(Object.entries(ITEM_CATEGORY_GROUPS)).toEqual(DJANGO_ITEM_CATEGORY_GROUPS);
  });
});

describe("ITEM_CATEGORIES", () => {
  // item_types.py:60-62 is `list(ITEM_CATEGORY_GROUPS.keys())` then `.sort()`,
  // and needLines.ts:62 is `Object.keys(...).sort()`. Both are codepoint
  // ordering over pure-ASCII Title Case strings, so they agree -- this array
  // is that Python list, produced by running CPython over the real
  // item_types.py rather than by reasoning about collation (TESTING.md's rule).
  //
  // This is the admin's category dropdown, in order (admin/needs.ts:377), and
  // it is also the allowlist upsertNeedLine's `throw` enforces. Pinned whole
  // rather than by length so a renamed category is a deliberate edit here.
  it("is Django's ITEM_CATEGORIES: the 50 keys, sorted, verbatim", () => {
    expect(ITEM_CATEGORIES).toEqual([
      "Baby Food",
      "Baby Milk",
      "Baked Beans",
      "Biscuits",
      "Carrier Bags",
      "Cereal",
      "Coffee",
      "Condiment",
      "Confectionery",
      "Cooking Oil",
      "Crisps",
      "Dental",
      "Deodorant",
      "Dessert",
      "Fruit Juice",
      "Hot Chocolate",
      "Household Supplies",
      "Instant Mash",
      "Kitchen Roll",
      "Laundry",
      "Milk",
      "Nappies",
      "Noodles",
      "Other",
      "Pasta",
      "Pasta Sauce",
      "Pet Food",
      "Rice",
      "Sanitary Products",
      "Sauce",
      "Shampoo",
      "Shower Gel",
      "Soap",
      "Soup",
      "Spread",
      "Squash",
      "Sugar",
      "Tea",
      "Tinned Fish",
      "Tinned Fruit",
      "Tinned Meat",
      "Tinned Pasta",
      "Tinned Tomatoes",
      "Tinned Vegetables",
      "Tinned Vegetarian",
      "Toilet Roll",
      "Toiletries",
      "Vegetable",
      "Washing Up Liquid",
      "Wipes",
    ]);
  });

  // The two exports have to stay the same set, because the dropdown offers
  // ITEM_CATEGORIES and upsertNeedLine validates against ITEM_CATEGORY_GROUPS.
  // An entry in the dropdown that is not a key here is an admin choosing a
  // category and getting a 500 out of the `throw` on save.
  it("offers exactly the categories upsertNeedLine will accept", () => {
    expect([...ITEM_CATEGORIES].sort()).toEqual(Object.keys(ITEM_CATEGORY_GROUPS).sort());
    // ...including "Other", which this export keeps and workers/site's
    // same-named export drops. The two arrays are NOT interchangeable and the
    // difference is one entry; see itemCategories.test.ts:180-199.
    expect(ITEM_CATEGORIES).toContain("Other");
  });
});

describe("getChangeLinesForNeed", () => {
  // `SELECT *` is only safe while the table's columns and NeedLineRow's fields
  // are the same set, and nothing in the type system checks that. This is the
  // migration-0019 failure in miniature: rename or drop a column and every
  // caller reads `undefined` off a row that still exists, with no error
  // anywhere. Asserted as an exact key set, not a subset, so an ADDED column
  // is caught too -- a new column silently arrives in every consumer's row
  // (and in the admin template's context) without ever being declared.
  it("returns every column of NeedLineRow and nothing else", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Tinned Tomatoes", type: "need", category: "Tinned Tomatoes", group_name: "Meal Food" });

    const line = (await getChangeLinesForNeed(d1Session(db), NEED)).get("Tinned Tomatoes")!;
    expect(Object.keys(line).sort()).toEqual(["category", "created", "foodbank_id", "group_name", "id", "item", "need_id", "type"]);
    expect(line).toEqual({
      id: 10,
      need_id: NEED,
      foodbank_id: SALISBURY,
      item: "Tinned Tomatoes",
      type: "need",
      category: "Tinned Tomatoes",
      group_name: "Meal Food",
      created: NEED_CREATED,
    } satisfies NeedLineRow);
  });

  // views.py:2046-2050's `existing_need_lines` is keyed by `line.item`, and the
  // caller looks each rendered change_text line up in it
  // (admin/needs.ts:303). Keying by anything else -- id, category -- turns
  // every previously-categorised line back into a blank dropdown, which reads
  // as "not categorised yet" and quietly loses the admin's earlier work.
  it("keys the map by item text", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Tinned Tomatoes", category: "Tinned Tomatoes" });
    seedLine(db, { id: 11, need_id: NEED, item: "Rice", category: "Rice" });

    const lines = await getChangeLinesForNeed(d1Session(db), NEED);
    expect([...lines.keys()].sort()).toEqual(["Rice", "Tinned Tomatoes"]);
    expect(lines.get("Rice")!.id).toBe(11);
  });

  // THE SCOPING TEST, and the reason both needs belong to food bank 7: a
  // `WHERE foodbank_id = ?` mutant returns four rows here instead of two, and
  // the categorise form for need 41 comes up pre-filled with need 42's
  // answers. Both needs are seeded with the SAME item text as well, so the
  // wrong row would land under the right key and be indistinguishable from
  // the right one without checking the id.
  it("returns only this need's lines, not the food bank's other needs'", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Tinned Tomatoes", category: "Tinned Tomatoes" });
    seedLine(db, { id: 11, need_id: NEED, item: "Rice", category: "Rice" });
    seedLine(db, { id: 12, need_id: OTHER_NEED, item: "Tinned Tomatoes", category: "Baked Beans" });
    seedLine(db, { id: 13, need_id: OTHER_NEED, item: "Soup", category: "Soup" });

    const lines = await getChangeLinesForNeed(d1Session(db), NEED);
    expect(lines.size).toBe(2);
    expect(lines.get("Tinned Tomatoes")!.id).toBe(10);
    expect(lines.get("Tinned Tomatoes")!.category).toBe("Tinned Tomatoes");
    // Present in the table, absent from this need's map.
    expect(lines.has("Soup")).toBe(false);
    expect(allLines(db)).toHaveLength(4);
  });

  // No type filter, deliberately. A need's excess lines
  // (`excess_change_text`) live in the same table under type='excess', and the
  // caller looks BOTH loops up in this one map (admin/needs.ts:300-313). An
  // `AND type = 'need'` added here would blank every excess dropdown on the
  // form while leaving the need ones filled -- a half-empty page that looks
  // like the admin simply never finished.
  it("returns need and excess lines together", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Rice", type: "need", category: "Rice" });
    seedLine(db, { id: 11, need_id: NEED, item: "Tinned Fruit", type: "excess", category: "Tinned Fruit" });

    const lines = await getChangeLinesForNeed(d1Session(db), NEED);
    expect(lines.size).toBe(2);
    expect(lines.get("Tinned Fruit")!.type).toBe("excess");
  });

  it("returns an empty map, not null, for a need with nothing categorised", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: OTHER_NEED, item: "Rice" });

    const lines = await getChangeLinesForNeed(d1Session(db), NEED);
    expect(lines.size).toBe(0);
    // The caller does `existing.get(item)` unconditionally on a GET
    // (admin/needs.ts:303), so a null here would be a TypeError on every
    // uncategorised need -- i.e. on the only needs this page is ever opened for.
    expect(lines.get("Rice")).toBeUndefined();
  });

  // SUSPECT, PINNED AS-IS. There is no unique index on (need_id, item), so two
  // rows can share one key -- and admin/needs.ts:357-363 documents the path
  // that creates them (correcting a line's text on a re-categorise inserts
  // rather than renames). `new Map(entries)` keeps the LAST entry for a
  // duplicate key, and the statement has no ORDER BY, so "last" is whatever
  // order SQLite's chosen index happens to walk.
  //
  // Measured, not assumed: the plan is
  // `SEARCH foodbankchangeline USING INDEX fcl_need_cat_type (need_id=?)`
  // (0003_homepage_data.sql:35), so rows come back ordered by CATEGORY, not by
  // id and not by insertion order. Below, row 11 is inserted second but sorts
  // first under "Baked Beans" < "Tinned Tomatoes", so the survivor is the
  // OLDER row 10. The admin's most recent answer is the one discarded.
  //
  // Worth knowing twice over, because upsertNeedLine resolves the same
  // ambiguity the other way -- it updates the HIGHEST id (see its own
  // duplicate test). So on a need with duplicates, the form shows one row's
  // category and the save writes to the other's.
  it("collapses duplicate items to one entry, and the survivor is index order not insertion order", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Tinned Tomatoes", category: "Tinned Tomatoes" });
    seedLine(db, { id: 11, need_id: NEED, item: "Tinned Tomatoes", category: "Baked Beans" });

    const lines = await getChangeLinesForNeed(d1Session(db), NEED);
    expect(lines.size).toBe(1);
    expect(lines.get("Tinned Tomatoes")!.id).toBe(10);
    expect(lines.get("Tinned Tomatoes")!.category).toBe("Tinned Tomatoes");
    // Both rows are still in the table -- nothing was deleted, only hidden.
    expect(allLines(db)).toHaveLength(2);
  });

  // THE SAME FIXTURE WITH THE CATEGORIES SWAPPED BETWEEN THE TWO ROWS, and the
  // reason it is a separate test rather than a duplicate of the one above: on
  // its own, that test is equally consistent with "the LOWEST id wins", which
  // is a comfortable-sounding rule and is not what happens. Here the lower id
  // carries the earlier category, so the survivor is id 11 -- the same rows,
  // the same statement, the opposite answer. What decides it is the category
  // text, because `SEARCH foodbankchangeline USING INDEX fcl_need_cat_type
  // (need_id=?)` walks (need_id, category, type) and `new Map(entries)` keeps
  // whichever entry arrives last.
  //
  // Mutation-tested, and this is the mutant it exists for: adding `ORDER BY id
  // DESC` to the statement survives the test above (id DESC also leaves row 10
  // last there) and dies here. So does `ORDER BY id ASC`, `ORDER BY created`,
  // and any other ordering imposed on a statement that currently has none.
  // Together the two tests say what is actually true -- the surfaced duplicate
  // tracks index order, which is category order -- rather than a rule that
  // happens to agree on one fixture.
  it("surfaces the duplicate that sorts last by category, which is not the highest or the lowest id", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Tinned Tomatoes", category: "Baked Beans" });
    seedLine(db, { id: 11, need_id: NEED, item: "Tinned Tomatoes", category: "Tinned Tomatoes" });

    const lines = await getChangeLinesForNeed(d1Session(db), NEED);
    expect(lines.size).toBe(1);
    expect(lines.get("Tinned Tomatoes")!.id).toBe(11);
    expect(lines.get("Tinned Tomatoes")!.category).toBe("Tinned Tomatoes");
  });

  // Item text is the Map's key, and nothing normalises it on the way in. That
  // matters because the categorise page splits change_text on "\n"
  // (admin/needs.ts:302), so a need scraped from a CRLF page produces items
  // with a trailing "\r" -- and the page then looks each rendered line up in
  // this map by the same unnormalised string. The two have to disagree about
  // whitespace in exactly the same way or nothing matches.
  //
  // Mutation-tested: keying the map `[row.item.trim(), row]` -- which reads
  // like a tidy-up and would even appear to FIX the CRLF problem -- survives
  // every other test in this file. It is not a fix: the stored row still says
  // "Rice\r", so a trimmed key would make the form show a categorisation that
  // the save path (which does not trim, see upsertNeedLine below) then fails
  // to find, and every save would append. Pinned so the two paths stay wrong
  // in the same direction until someone fixes both.
  it("keys the map by the raw item text, trailing carriage return and all", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Rice", category: "Rice" });
    seedLine(db, { id: 11, need_id: NEED, item: "Rice\r", category: "Pasta" });
    seedLine(db, { id: 12, need_id: NEED, item: " Soup", category: "Soup" });

    const lines = await getChangeLinesForNeed(d1Session(db), NEED);
    // Three distinct keys, not one -- "Rice" and "Rice\r" are two items here.
    expect([...lines.keys()].sort()).toEqual([" Soup", "Rice", "Rice\r"]);
    expect(lines.get("Rice")!.id).toBe(10);
    expect(lines.get("Rice\r")!.id).toBe(11);
    expect(lines.has("Soup")).toBe(false);
  });

  // needId is foodbankchange's INTEGER primary key, not its 32-char `need_id`
  // uuid -- two different columns, and the route reaches this function with
  // `need.id` while every URL in the admin carries the uuid
  // (admin/needs.ts:370). Handing the uuid over would match nothing and
  // silently render every line as uncategorised. Pinned by seeding a row whose
  // integer key and uuid are both plausible lookups.
  it("matches on the need's integer primary key, not its uuid", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Rice" });

    expect((await getChangeLinesForNeed(d1Session(db), NEED)).size).toBe(1);
    const uuid = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
    expect((await getChangeLinesForNeed(d1Session(db), uuid as unknown as number)).size).toBe(0);
  });
});

describe("getLatestLineForItem", () => {
  // The suggestion lookup: "we have categorised this exact item text before,
  // somewhere". Django's is `.filter(item__in=all_items).values('item')
  // .annotate(latest_id=Max('id'))` (views.py:2057-2070) -- MAX of the id,
  // over every line in the table, unscoped by need and unscoped by food bank.
  // That last part is the feature, not an oversight: the point is that
  // Salisbury's answer for "Tinned Tomatoes" seeds Brixton's form. A mutant
  // that scoped this by foodbank_id would turn the suggestion off for every
  // food bank's first need and nobody would see an error.
  it("finds the highest id anywhere, across needs and across food banks", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, foodbank_id: SALISBURY, item: "Tinned Tomatoes", category: "Soup" });
    seedLine(db, { id: 11, need_id: OTHER_NEED, foodbank_id: 99, item: "Tinned Tomatoes", category: "Tinned Tomatoes" });

    const line = await getLatestLineForItem(d1Session(db), "Tinned Tomatoes");
    expect(line!.id).toBe(11);
    expect(line!.foodbank_id).toBe(99);
    expect(line!.category).toBe("Tinned Tomatoes");
  });

  // THE ORDER-BY MUTANT THIS FUNCTION EXISTS TO SURVIVE, and the reason
  // migration 0021 added a whole index rather than rewriting the query.
  // FoodbankChangeLine.created is copied from the parent NEED's created
  // (needs.py:374), so it is not a per-line clock at all: every line of one
  // need shares it, and a reload or backfill can give a NEWER row an OLDER
  // timestamp.
  //
  // The winning row is deliberately in the MIDDLE of the created ordering,
  // not at either end. An earlier version of this test put the highest id on
  // the oldest timestamp, which killed `ORDER BY created DESC` and let
  // `ORDER BY created ASC` through -- the wrong query agreeing with the right
  // one by accident. Here the three orderings give three different answers:
  // created DESC -> 10, created ASC -> 11, id DESC -> 12. Django orders by id
  // (`.annotate(latest_id=Max('id'))`, views.py:2062-2067); so do we.
  it("orders by id, not by created, in either direction", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Rice", category: "Soup", created: "2026-09-05 15:00:00.000000" });
    seedLine(db, { id: 11, need_id: OTHER_NEED, item: "Rice", category: "Pasta", created: "2020-01-01 09:30:00.000000" });
    seedLine(db, { id: 12, need_id: 43, item: "Rice", category: "Rice", created: "2023-06-01 12:00:00.000000" });

    expect((await getLatestLineForItem(d1Session(db), "Rice"))!.id).toBe(12);
  });

  // The same mutant, dressed as the bug migration 0022 was written to clean
  // up. `created` is TEXT and every comparison over it is byte-wise, so once
  // two rows share a date the separator decides the order: a pre-0022 ISO
  // value ("2026-09-05T09:30:00Z") sorts ABOVE a Django-format one from the
  // same day ("2026-09-05 15:00:00.000000"), because 'T' (0x54) beats ' '
  // (0x20) -- even though it is five and a half hours EARLIER. Row 10 below
  // is that row: earliest in real time, lowest id, and the lexical maximum of
  // the column. 25 foodbankchangeline rows were in exactly this state before
  // 0022 ran (0022_normalise_timestamps.sql:58-60), and a re-import can put
  // them back at any time. Ordering by id is immune to all of it.
  it("is unaffected by a stray ISO-format created that outsorts a same-day Django one", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Soup", category: "Pasta", created: "2026-09-05T09:30:00Z" });
    seedLine(db, { id: 11, need_id: OTHER_NEED, item: "Soup", category: "Soup", created: "2026-09-05 15:00:00.000000" });

    // Proof the trap is real and not hypothetical, run by the same engine
    // that runs the query: the lexical maximum is the EARLIER row.
    expect(db.prepare("SELECT MAX(created) AS m FROM foodbankchangeline").get()).toEqual({ m: "2026-09-05T09:30:00Z" });
    expect((await getLatestLineForItem(d1Session(db), "Soup"))!.id).toBe(11);
  });

  // The ordinary case, where every candidate genuinely shares one timestamp
  // because they were written by one need's save. `created DESC` here is not
  // merely wrong, it is UNDEFINED -- SQLite may return any of the three -- so
  // an ordering by it would be a test that passes or fails by query plan.
  // Ordering by id is what makes the answer deterministic at all.
  it("breaks ties deterministically when every candidate shares a created", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Pasta", category: "Soup" });
    seedLine(db, { id: 11, need_id: NEED, item: "Pasta", category: "Rice" });
    seedLine(db, { id: 12, need_id: NEED, item: "Pasta", category: "Pasta" });

    expect((await getLatestLineForItem(d1Session(db), "Pasta"))!.id).toBe(12);
  });

  // The MISS case, which is the common one: a food bank's first ever need
  // has no prior line for any of its items, so this returns nothing for every
  // row of the form. An `AND`-heavy or mistyped predicate that returned a row
  // here would put a confident, wrong category into every dropdown.
  //
  // null, not undefined -- pinned as the signature's contract, though the
  // header is honest that no mutant can tell the two apart through an adapter
  // that already models D1's null. The caller's `found ?? (await
  // getLatestLineForItem(...))` (admin/needs.ts:304) treats them alike today;
  // the next consumer to write `=== null` should still be able to rely on it.
  it("returns null for an item never categorised anywhere", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Rice" });

    const line = await getLatestLineForItem(d1Session(db), "Tinned Tomatoes");
    expect(line).toBeNull();
    expect(line).not.toBeUndefined();
  });

  // Exact equality, case-sensitively. SQLite's `=` on TEXT is BINARY by
  // default; the risk is a column (or a query) acquiring COLLATE NOCASE, at
  // which point "rice" and "Rice" become one item and a food bank's
  // lower-case scrape starts inheriting another's categorisation. Harmless
  // here, wrong the moment two categories differ only in case.
  it("matches item text case-sensitively", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Tinned Tomatoes", category: "Tinned Tomatoes" });

    expect(await getLatestLineForItem(d1Session(db), "tinned tomatoes")).toBeNull();
    expect(await getLatestLineForItem(d1Session(db), "TINNED TOMATOES")).toBeNull();
    expect((await getLatestLineForItem(d1Session(db), "Tinned Tomatoes"))!.id).toBe(10);
  });

  // `=`, never LIKE. The two are one word apart and a LIKE looks like a
  // kindness on free-text item names, but item text comes off a scraped page
  // and is full of characters LIKE treats as wildcards. "R_ce" would match
  // "Rice" and "%" would match every row in a 333,000-row table, handing the
  // admin a confident suggestion drawn from an unrelated item.
  it("does not treat item text as a LIKE pattern", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Rice", category: "Rice" });

    expect(await getLatestLineForItem(d1Session(db), "R_ce")).toBeNull();
    expect(await getLatestLineForItem(d1Session(db), "%")).toBeNull();
    expect(await getLatestLineForItem(d1Session(db), "Ric%")).toBeNull();
  });

  // A LIVE FAILURE MODE, pinned so it is understood rather than rediscovered.
  // The categorise page splits change_text on "\n" (admin/needs.ts:302), so a
  // need scraped from a CRLF page yields items with a trailing "\r". That is a
  // different TEXT value to SQLite, so the suggestion silently never fires for
  // that food bank -- and worse, upsertNeedLine then stores "Rice\r" as a
  // permanent second spelling of the item, which never matches the clean one
  // again. Nothing here trims, on either side; asserted in both directions.
  it("does not trim: a CRLF-split item is a different item", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Rice", category: "Rice" });
    seedLine(db, { id: 11, need_id: OTHER_NEED, item: "Soup\r", category: "Soup" });

    expect(await getLatestLineForItem(d1Session(db), "Rice\r")).toBeNull();
    expect(await getLatestLineForItem(d1Session(db), " Rice")).toBeNull();
    expect(await getLatestLineForItem(d1Session(db), "Soup")).toBeNull();
    expect((await getLatestLineForItem(d1Session(db), "Soup\r"))!.id).toBe(11);
  });

  // The empty string is a real query, not a guard case: `"a\n\nb".split("\n")`
  // yields one, so a need whose change_text has a blank line asks this
  // function for "". There is no `if (!item) return null` in the module, so it
  // goes to the database -- and once one blank line has been categorised
  // anywhere, every subsequent blank line inherits that category as a
  // suggestion. Pinned as the behaviour, not endorsed.
  it("queries for an empty item rather than short-circuiting", async () => {
    const db = freshDb();
    expect(await getLatestLineForItem(d1Session(db), "")).toBeNull();

    seedLine(db, { id: 10, need_id: NEED, item: "", category: "Other" });
    expect((await getLatestLineForItem(d1Session(db), ""))!.id).toBe(10);
  });

  // No type filter, matching Django's `item__in` (which has none either). An
  // item last seen as somebody's EXCESS is still the best guess for what
  // category it belongs to -- the type says whether a food bank wants it or
  // has too much of it, not what kind of thing it is.
  it("suggests from an excess line as readily as a need line", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Tinned Fruit", type: "need", category: "Soup" });
    seedLine(db, { id: 11, need_id: OTHER_NEED, item: "Tinned Fruit", type: "excess", category: "Tinned Fruit" });

    const line = await getLatestLineForItem(d1Session(db), "Tinned Fruit");
    expect(line!.id).toBe(11);
    expect(line!.type).toBe("excess");
  });

  it("returns every column of NeedLineRow, same as the by-need read", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Rice", category: "Rice", group_name: "Meal Food" });

    const line = await getLatestLineForItem(d1Session(db), "Rice");
    expect(Object.keys(line!).sort()).toEqual(["category", "created", "foodbank_id", "group_name", "id", "item", "need_id", "type"]);
  });
});

describe("replaceNeedLines", () => {
  // The need this file's fixtures belong to. `needUuid`/`modified` feed the
  // is_categorised UPDATE that rides in the same batch; every other field is
  // the same shape upsertNeedLine took.
  const NEED_UUID = "11111111-2222-3333-4444-555555555555";
  const MODIFIED = "2026-09-11 16:45:00.000000";
  const base = { needId: NEED, foodbankId: SALISBURY, needCreated: NEED_CREATED, needUuid: NEED_UUID, modified: MODIFIED };

  // One line, the shape the route builds. Most tests below submit exactly
  // one, which under set semantics means "this need has exactly this line".
  const one = (over: Partial<NeedLineInput> = {}): NeedLineInput => ({
    item: "Tinned Tomatoes",
    type: "need",
    category: "Tinned Tomatoes",
    ...over,
  });

  const save = (session: Session, lines: NeedLineInput[], over: Partial<typeof base> = {}) =>
    replaceNeedLines(session, { ...base, ...over }, lines);

  beforeEach(() => {
    trips.queries = 0;
    trips.batches = 0;
    trips.batchedStatements = 0;
  });

  // THE REASON THIS IS PLURAL. The per-line predecessor did a SELECT and then
  // a write per line, sequentially: 2N+1 round trips, so 28 for the mean
  // 13.4-line need and 205 for the 102-line worst case in production. This
  // asserts the shape that replaced it -- ONE prefetch and ONE batch -- and
  // it is asserted at two very different line counts, because "2 round trips"
  // is only interesting if it does not move with N.
  it.each([1, 13, 40])("costs one query and one batch whatever the line count (%i lines)", async (n) => {
    const db = freshDb();
    const lines = Array.from({ length: n }, (_, i) => one({ item: `item-${i}` }));

    await save(d1Session(db), lines);

    expect(trips.queries).toBe(1); // getChangeLinesForNeed
    expect(trips.batches).toBe(1);
    expect(allLines(db)).toHaveLength(n);
  });

  // Above BATCH_SIZE it chunks, so the count goes up in steps rather than
  // with N -- and the whole set still lands. 60 lines plus the flag is 61
  // statements: two batches, not 61 round trips.
  it("chunks rather than scaling round trips, and still writes every line", async () => {
    const db = freshDb();
    const lines = Array.from({ length: 60 }, (_, i) => one({ item: `item-${i}` }));

    await save(d1Session(db), lines);

    expect(trips.batches).toBe(2);
    expect(trips.batchedStatements).toBe(61); // 60 inserts + the is_categorised UPDATE
    expect(allLines(db)).toHaveLength(60);
  });

  // No statement here binds a variable-length list, so D1's 100-parameter cap
  // is never approached however long the need. Asserted through the fake's
  // own enforcement of that cap: a need with more lines than the limit still
  // saves, where the `item__in` list Django built (views.py:2062-2067) would
  // have exceeded it outright.
  it("saves a need with more lines than D1's bound-parameter cap", async () => {
    const db = freshDb();
    const lines = Array.from({ length: 120 }, (_, i) => one({ item: `item-${i}` }));

    await save(d1Session(db), lines);

    expect(allLines(db)).toHaveLength(120);
  });

  // Every column, by name, on the create path. Asserted as a whole row rather
  // than field by field because the failure this catches is a shifted VALUES
  // tuple: add or reorder one column in the INSERT without moving its .bind()
  // partner and the statement still runs, still succeeds, and writes the item
  // text into `type` and the type into `category`. Nothing throws -- both
  // columns are TEXT NOT NULL and neither has a CHECK constraint.
  it("inserts a row with the derived group and the need's created", async () => {
    const db = freshDb();
    await save(d1Session(db), [one()]);

    expect(allLines(db)).toEqual([
      {
        id: 1,
        need_id: NEED,
        foodbank_id: SALISBURY,
        item: "Tinned Tomatoes",
        type: "need",
        category: "Tinned Tomatoes",
        group_name: "Meal Food",
        created: NEED_CREATED,
      },
    ]);
  });

  // The flag the route used to set in a second, separate write. It is in the
  // batch now, so it cannot be set for a need whose lines failed to land.
  it("sets is_categorised and modified in the same batch as the lines", async () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, input_method, created, modified) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(NEED, NEED_UUID, SALISBURY, "Tinned Tomatoes", "scrape", NEED_CREATED, NEED_CREATED);

    await save(d1Session(db), [one()]);

    const need = db.prepare("SELECT is_categorised, modified FROM foodbankchange WHERE need_id = ?").get(NEED_UUID) as Record<string, unknown>;
    expect(need.is_categorised).toBe(1);
    expect(need.modified).toBe(MODIFIED);
    expect(trips.batches).toBe(1);
  });

  // needs.py:372-376: `self.group = ITEM_CATEGORY_GROUPS[self.category]`, in
  // save(), on a field the ModelForm cannot reach (`editable=False`). The port
  // reproduces that by not taking a group parameter at all, which is the only
  // way to make it structurally impossible for a caller to disagree with the
  // table. Checked across several groups so a lookup that had degenerated into
  // "return the category" or "return a constant" fails.
  it("derives group_name from the category and never from the caller", async () => {
    const db = freshDb();
    const categories = ["Milk", "Nappies", "Crisps", "Washing Up Liquid", "Other"];

    await save(d1Session(db), categories.map((category, i) => one({ item: `item-${i}`, category })));

    expect(allLines(db).map((row) => [row.category, row.group_name])).toEqual([
      ["Milk", "Drink"],
      ["Nappies", "Baby Supplies"],
      ["Crisps", "Snack Food"],
      ["Washing Up Liquid", "Cleaning"],
      ["Other", "Other"],
    ]);
  });

  // needs.py:374: `self.created = self.need.created`. NOT now(). The whole
  // dashboards tier reads foodbankchangeline.created as "when this need was
  // published" -- fcl_created_idx and the (item, created DESC) index exist for
  // exactly those queries -- so stamping the categorisation time here would
  // date every historical line to the afternoon an admin got round to
  // categorising it, and quietly move thousands of items into the wrong week.
  // Asserted as byte-identical TEXT, because that is how it is compared.
  it("copies created from the need, not from the clock, byte for byte", async () => {
    const db = freshDb();
    const historic = "2019-04-01 09:30:00.123456";
    await save(d1Session(db), [one()], { needCreated: historic });

    expect(allLines(db)[0]!.created).toBe(historic);
    // The mutant is `new Date().toISOString()`, whose shape is visibly
    // different in both separator and precision -- and which would sort above
    // every Django-format row in the table (see the ISO test above).
    expect(String(allLines(db)[0]!.created)).not.toMatch(/T.*Z$/);
  });

  // The allowlist is app-level, not a DB constraint (§4.5: every choices field
  // in this schema is), so this `throw` is the ONLY thing keeping an arbitrary
  // string out of the category column -- and out of the "by item" search that
  // matches `category = ?`. The guard now runs over EVERY line before the
  // first write, so one bad category rejects the whole save instead of
  // committing the lines that happened to come before it.
  it("rejects an unknown category without touching the database", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Tinned Tomatoes", category: "Tinned Tomatoes", group_name: "Meal Food" });

    await expect(save(d1Session(db), [one({ category: "Tinned Unicorn" })])).rejects.toThrow("unknown item category: Tinned Unicorn");
    // Case matters: the dropdown's values are Title Case, and a client posting
    // a lower-case one is rejected rather than silently written.
    await expect(save(d1Session(db), [one({ category: "milk" })])).rejects.toThrow("unknown item category: milk");
    await expect(save(d1Session(db), [one({ category: "" })])).rejects.toThrow("unknown item category: ");

    expect(allLines(db)).toEqual([
      { id: 10, need_id: NEED, foodbank_id: SALISBURY, item: "Tinned Tomatoes", type: "need", category: "Tinned Tomatoes", group_name: "Meal Food", created: NEED_CREATED },
    ]);
    // Not even the prefetch ran: the guard is above it.
    expect(trips.batches).toBe(0);
  });

  // A GOOD LINE BEFORE A BAD ONE. This is the case the per-line version got
  // wrong -- it wrote "Tea" and then threw on "Hot Drinks", leaving a need
  // half-categorised and, because the flag never got set, looking untouched
  // in the admin. Validating every category up front makes it all-or-nothing.
  it("writes nothing at all when a later line's category is unknown", async () => {
    const db = freshDb();

    await expect(save(d1Session(db), [one({ item: "Tea", category: "Tea" }), one({ item: "Coffee", category: "Hot Drinks" })])).rejects.toThrow(
      "unknown item category: Hot Drinks",
    );

    expect(allLines(db)).toEqual([]);
  });

  // SUSPECT, PINNED AS-IS. `ITEM_CATEGORY_GROUPS[params.category]` is a bare
  // bracket lookup on an object literal, guarded only by `if (!group)`. Four
  // strings resolve through Object.prototype to something TRUTHY --
  // "constructor" and "toString" to functions, "__proto__" to the prototype
  // object -- so they sail past the allowlist check that is supposed to be the
  // only gate, and reach the INSERT as a bound value that is not a string.
  //
  // What saves it is the schema, not the code: `group_name TEXT NOT NULL`
  // (0003_homepage_data.sql:32), and node:sqlite binds a function as NULL, so
  // the row is refused by the constraint. That is defence in the wrong layer
  // and it is engine-specific -- D1 rejects an unsupported bind type outright
  // instead -- which is why this asserts "throws, and writes nothing" rather
  // than a message. The right fix is Object.hasOwn (or a null-prototype
  // table); it is not made here because tests pin current behaviour.
  //
  // One thing HAS improved: the throw now comes from inside a batch, so the
  // transaction rolls back rather than leaving the statements before it.
  it("lets Object.prototype keys past the allowlist guard, and the NOT NULL constraint catches them", async () => {
    const db = freshDb();
    for (const category of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      // Truthy, hence past `if (!group) throw` -- the guard's own premise.
      expect(Boolean(ITEM_CATEGORY_GROUPS[category])).toBe(true);
      const rejection = save(d1Session(db), [one({ category })]);
      await expect(rejection).rejects.toThrow();
      // Specifically NOT the clean error the caller would get for any other
      // string that is not a category.
      await expect(rejection).rejects.not.toThrow(`unknown item category: ${category}`);
    }
    expect(allLines(db)).toHaveLength(0);
  });

  // The mutant this kills is a transposed .bind() on the UPDATE: swap the
  // category and group and every row gets a group in its category column.
  // Re-saving must also keep ONE row -- appending on every visit is the bug
  // the whole rewrite is about.
  it("updates in place on a second save rather than appending a row", async () => {
    const db = freshDb();
    const session = d1Session(db);
    await save(session, [one({ category: "Baked Beans" })]);
    await save(session, [one({ category: "Tinned Tomatoes" })]);

    const rows = allLines(db);
    expect(rows).toHaveLength(1);
    // Same row: a line still in the submitted set is UPDATEd, not deleted and
    // reinserted, so getLatestLineForItem's `id DESC` ranking does not get
    // rewritten every time an old need is re-saved.
    expect(rows[0]!.id).toBe(1);
    expect(rows[0]!.category).toBe("Tinned Tomatoes");
    // The group is re-derived on the update path too, not left at the old
    // category's. An UPDATE that set `category` alone would leave "Baked
    // Beans"'s group behind -- both are "Meal Food", which is why this test
    // uses a category whose group actually changes.
    expect(rows[0]!.group_name).toBe("Meal Food");

    await save(session, [one({ category: "Shampoo" })]);
    expect(allLines(db)[0]!.group_name).toBe("Toiletries");
  });

  // THE DUPLICATION BUG THIS FUNCTION EXISTS TO FIX, at its own tier.
  // Reported 2026-09-11: load categorise, post, reload, post again.
  //
  //   1. The reviewer corrects the spelling. A row lands under the CORRECTED
  //      text.
  //   2. The page re-renders from change_text -- always -- so it shows the
  //      food bank's original spelling again, and posts that.
  //   3. The old upsert matched on `item`, found nothing, and INSERTED. Two
  //      rows for one line.
  //
  // Deleting what the form did not submit is what closes it. Note this also
  // proves `orig_item` is not the answer: by step 2 the stored row's text has
  // drifted away from change_text, so no text-matching key can find it.
  it("leaves one row when a corrected line is re-saved under its original text", async () => {
    const db = freshDb();
    const session = d1Session(db);
    await save(session, [one({ item: "Tinned tomatoes" })]); // step 1, corrected
    await save(session, [one({ item: "Tinned tomatos" })]); // step 2, as re-rendered

    expect(allLines(db).map((row) => row.item)).toEqual(["Tinned tomatos"]);
  });

  // The general form of the same rule: a row the form did not submit is gone.
  // That is also the only way to UN-categorise a line, which the old merge
  // made impossible -- clearing the dropdown did nothing at all.
  it("deletes a row the submitted set no longer contains", async () => {
    const db = freshDb();
    const session = d1Session(db);
    await save(session, [one({ item: "Tea", category: "Tea" }), one({ item: "Coffee", category: "Coffee" })]);

    await save(session, [one({ item: "Tea", category: "Tea" })]);

    expect(allLines(db).map((row) => row.item)).toEqual(["Tea"]);
  });

  // ...and the delete is scoped to THIS need. A DELETE that dropped its id
  // binding, or one written `WHERE need_id <> ?`, would clear other needs'
  // categorisation and every assertion above would still pass.
  it("deletes only this need's rows, never another need's", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: OTHER_NEED, item: "Rice", category: "Rice", group_name: "Meal Food" });

    await save(d1Session(db), [one({ item: "Tea", category: "Tea" })]);

    expect(allLines(db).map((row) => [row.need_id, row.item])).toEqual([
      [OTHER_NEED, "Rice"],
      [NEED, "Tea"],
    ]);
  });

  // The existence check is scoped by need as well as item. Dropping the
  // need_id half is the mutant that matters and it is invisible in any
  // single-need fixture: with it dropped, categorising "Tinned Tomatoes" for
  // this week's need REWRITES last week's line instead of creating one, so a
  // food bank's history collapses into a single row that keeps changing
  // category. Seeded across two needs of the same food bank so the mutant has
  // something to hit.
  it("keeps each need's line separate, even for identical item text", async () => {
    const db = freshDb();
    const session = d1Session(db);
    await save(session, [one({ category: "Baked Beans" })], { needId: NEED });
    await save(session, [one({ category: "Tinned Tomatoes" })], { needId: OTHER_NEED });

    const rows = allLines(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.need_id, row.category])).toEqual([
      [NEED, "Baked Beans"],
      [OTHER_NEED, "Tinned Tomatoes"],
    ]);
  });

  // An item that appears in BOTH change_text and excess_change_text. The
  // route submits both in one set, and they collapse to one row -- which is
  // what Django ends up with too, its existing_need_lines map being keyed by
  // item alone as well.
  //
  // SUSPECT, PINNED: the surviving row is typed by the FIRST occurrence and
  // categorised by the LAST, because Django's UPDATE writes category and
  // group only. So a line in both lists is counted as still wanted by
  // fcl_type_idx and every "by item" dashboard. Django writes `type` on that
  // update and would have ended at 'excess'.
  it("collapses a need line and an excess line of the same item into one row, typed by the first", async () => {
    const db = freshDb();

    await save(d1Session(db), [
      one({ item: "Tinned Fruit", type: "need", category: "Tinned Fruit" }),
      one({ item: "Tinned Fruit", type: "excess", category: "Dessert" }),
    ]);

    expect(allLines(db)).toHaveLength(1);
    expect(allLines(db)[0]!.type).toBe("need");
    expect(allLines(db)[0]!.category).toBe("Dessert");
  });

  // PRE-EXISTING duplicates -- two rows already sharing (need_id, item),
  // written by the old upsert before this rewrite. getChangeLinesForNeed
  // keys its Map by item, so it surfaces ONE of them, and that is the row
  // this updates: the same row the form rendered.
  //
  // The predecessor updated the OTHER one. Its existence check was a bare
  // `.first()` with no ORDER BY, answered by foodbankchangeline_item_id_idx
  // walking id DESCENDING, so it wrote to the highest id while the form had
  // shown the lowest -- an admin could correct a category, come back, and
  // see the old value still there. That is fixed here by construction.
  //
  // The other duplicate is left alone rather than cleaned up: it is not in
  // the Map, so the delete pass never sees it. Recorded, not fixed -- these
  // rows predate the rewrite and need a one-off sweep, not a write path that
  // second-guesses its own prefetch.
  it("updates the duplicate the form actually rendered, and leaves the other", async () => {
    const db = freshDb();
    seedLine(db, { id: 10, need_id: NEED, item: "Tinned Tomatoes", category: "Tinned Tomatoes", group_name: "Meal Food" });
    seedLine(db, { id: 11, need_id: NEED, item: "Tinned Tomatoes", category: "Baked Beans", group_name: "Meal Food" });
    const rendered = (await getChangeLinesForNeed(d1Session(db), NEED)).get("Tinned Tomatoes")!.id;

    await save(d1Session(db), [one({ category: "Shampoo" })]);

    const byId = new Map(allLines(db).map((row) => [row.id, row.category]));
    expect(byId.get(rendered)).toBe("Shampoo");
    expect(allLines(db)).toHaveLength(2);
  });

  // Making the lookup `params.item.trim()` passes almost everything else here
  // and is a duplicate-row generator: the check would look for "Rice" while
  // the INSERT (which does not trim) stored "Rice\r", so the second save of a
  // CRLF-scraped need matches nothing and appends.
  //
  // Asserted in both directions, because a trim on ONE side is the dangerous
  // shape: the same item text round-trips to one row across repeated saves,
  // and two items differing only in whitespace stay two rows.
  it("neither trims nor normalises item text, so a CRLF item is its own row and updates in place", async () => {
    const db = freshDb();
    const session = d1Session(db);
    const set = [
      one({ item: "Rice\r", category: "Pasta" }),
      one({ item: "Rice", category: "Soup" }),
      one({ item: " Rice", category: "Dessert" }),
    ];
    await save(session, set);
    // Saved AGAIN, unchanged: the round trip through the lookup has to land
    // on the same three rows, not append three more.
    await save(session, set);

    expect(allLines(db).map((row) => [row.id, row.item, row.category])).toEqual([
      [1, "Rice\r", "Pasta"],
      [2, "Rice", "Soup"],
      [3, " Rice", "Dessert"],
    ]);
  });

  // Django's FoodbankChangeLine.item is CharField(max_length=250), enforced by
  // the ModelForm on every save. SQLite has no such notion and this port does
  // no length check, so a 400-character scraped line is stored whole. Pinned
  // because the divergence runs one way only -- rows this port accepts would
  // be refused by the reference app, which matters if data ever flows back --
  // and because the alternative failure (silent truncation to 250) would be
  // far worse: the truncated text would never match the page's own line again
  // and the item would be permanently uncategorisable.
  it("stores an item longer than Django's max_length=250 without truncating it", async () => {
    const db = freshDb();
    const long = "Tinned Tomatoes ".repeat(25); // 400 characters
    await save(d1Session(db), [one({ item: long })]);

    expect(allLines(db)[0]!.item).toBe(long);
    expect(String(allLines(db)[0]!.item)).toHaveLength(400);
    // And it round-trips: the suggestion lookup can find it again, which is
    // what a truncating write would have broken.
    expect((await getLatestLineForItem(d1Session(db), long))!.id).toBe(1);
  });

  // Item text is scraped from a food bank's own page, so it arrives with
  // apostrophes, semicolons and whatever else the site's author typed. Every
  // statement here binds rather than interpolates; this is the assertion that
  // says so out loud, and it round-trips through both readers so a value that
  // was mangled on the way in would fail to be found on the way out.
  it("binds item text rather than interpolating it", async () => {
    const db = freshDb();
    const nasty = "Sainsbury's \"own brand\" beans'); DROP TABLE foodbankchangeline; --";
    await save(d1Session(db), [one({ item: nasty })]);

    expect(allLines(db)).toHaveLength(1);
    expect(allLines(db)[0]!.item).toBe(nasty);
    expect((await getLatestLineForItem(d1Session(db), nasty))!.category).toBe("Tinned Tomatoes");
    expect((await getChangeLinesForNeed(d1Session(db), NEED)).has(nasty)).toBe(true);
  });

  // `type` is a plain TEXT column with no CHECK, and NeedLineType is erased at
  // runtime, so whatever the route hands over is what lands in the table.
  // admin/needs.ts is the only validation there is (`if (type !== "need" &&
  // type !== "excess") continue`). Recorded here so the next person to relax
  // that route check knows there is no second line of defence -- and so that
  // both legal values are proved to round-trip, since fcl_type_idx and every
  // "still wanted" dashboard query filters on this column exactly.
  it("writes the type verbatim, with no normalisation and no database-level check", async () => {
    const db = freshDb();

    await save(d1Session(db), [
      one({ item: "Rice", type: "need" }),
      one({ item: "Tinned Fruit", type: "excess" }),
      one({ item: "Soup", type: "NEED" as NeedLineType }),
    ]);

    expect(allLines(db).map((row) => row.type)).toEqual(["need", "excess", "NEED"]);
  });
});
