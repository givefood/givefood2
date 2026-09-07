import { beforeEach, describe, expect, it } from "vitest";
import { foodbankNameTaken, foodbankSlugForName, foodbankSlugTaken, insertFoodbank, updateFoodbankFields } from "./foodbankAdmin";
import type { Session } from "./types";

// github #12: "500 adding a location with the same name as an existing
// location. Check for this class of error across the admin - it should
// validate first? Django did this automatically for us."
//
// This is the Foodbank half. `foodbank_name_uniq` and `foodbank_slug_uniq`
// (migrations/0001_core.sql:47-48) are the two indexes an admin can violate
// by typing a name, and the two functions below are the validate_unique()
// call Django's ModelForm made for free (givefood/models/foodbank.py:61's
// `unique=True`) and this port has to make for itself.
//
// THE FAKE SESSION BELOW IS OPERATOR-AWARE, and that is the whole point of
// this file. The bug these checks can silently reintroduce is a SQLite
// semantic, not a logic error: `id != NULL` evaluates to NULL rather than
// true, so on a create -- where there is no row to exclude -- an `id != ?`
// check matches NOTHING and always passes, leaving a uniqueness check that
// reads correctly and guards nothing. A fake that compared ids in
// JavaScript would happily agree with that mutant. This one reads the
// operator out of the SQL and applies SQLite's own three-valued logic to
// whichever it finds, so `IS NOT` and `!=` behave differently here exactly
// as they do in the database.
//
// Those semantics were RUN, not reasoned about (TESTING.md's rule). Against
// real SQLite, with rows 1 and 2 present:
//
//   SELECT id FROM foodbank WHERE name='Brixton Food Bank' AND id IS NOT NULL  -> [1]
//   SELECT id FROM foodbank WHERE name='Brixton Food Bank' AND id != NULL      -> []
//   SELECT id FROM foodbank WHERE name='Brixton Food Bank' AND id IS NOT 1     -> []
//   SELECT id FROM foodbank WHERE name='Brixton Food Bank' AND id IS NOT 2     -> [1]
//   SELECT (NULL != NULL), (1 != NULL), (1 IS NOT NULL)                        -> NULL, NULL, 1
//
// Verified with node:sqlite in a scratchpad, not committed: packages/db has
// no @types/node and the repo typechecks with @cloudflare/workers-types
// only, so a test importing node:sqlite fails `pnpm typecheck` for everyone.

// SQLite's three-valued logic. A WHERE clause keeps a row only when its
// expression is TRUE; UNKNOWN (null) drops it, same as false.
type Ternary = true | false | null;

function sqlEquals(a: unknown, b: unknown): Ternary {
  return a === null || b === null ? null : a === b;
}

function sqlNotEquals(a: unknown, b: unknown): Ternary {
  const equal = sqlEquals(a, b);
  return equal === null ? null : !equal;
}

// `IS NOT` is the null-safe form: it never returns UNKNOWN, and it treats
// NULL as equal to NULL, so `1 IS NOT NULL` is true.
function sqlIsNot(a: unknown, b: unknown): Ternary {
  return a !== b;
}

interface FakeRow {
  id: number;
  name: string;
  slug: string;
}

// Only the three statement shapes this module issues. Anything else throws
// rather than quietly returning no rows, so a rewritten query fails loudly
// here instead of turning these tests green against code they no longer
// describe.
const SELECT_CHECK = /^SELECT id FROM foodbank WHERE (name|slug) = \? AND id (IS NOT|IS|!=|<>|=) \?$/;
const INSERT_ROW = /^INSERT INTO foodbank \(([^)]*)\) VALUES \(([^)]*)\) RETURNING id$/;
const UPDATE_ROW = /^UPDATE foodbank SET (.*) WHERE id = \?$/;

class FakeDatabase {
  rows: FakeRow[] = [];
  private nextId = 1;

  // The two UNIQUE indexes, modelled from 0001_core.sql:47-48. Enforced so a
  // test cannot set up a state the real database would have refused -- these
  // tests are about the check in front of the constraint, and would mean
  // nothing run against a table that tolerated duplicates.
  private enforceUnique(candidate: FakeRow): void {
    for (const row of this.rows) {
      if (row.id === candidate.id) continue;
      if (row.name === candidate.name) throw new Error("D1_ERROR: UNIQUE constraint failed: foodbank.name");
      if (row.slug === candidate.slug) throw new Error("D1_ERROR: UNIQUE constraint failed: foodbank.slug");
    }
  }

  select(sql: string, params: unknown[]): FakeRow | null {
    const match = SELECT_CHECK.exec(sql);
    if (!match) throw new Error(`fake session: unrecognised SELECT: ${sql}`);
    const [, column, operator] = match;
    const [wanted, exceptId] = params;
    for (const row of this.rows) {
      const columnMatches = sqlEquals(row[column as "name" | "slug"], wanted);
      const notExcluded =
        operator === "IS NOT" ? sqlIsNot(row.id, exceptId) : operator === "IS" || operator === "=" ? sqlEquals(row.id, exceptId) : sqlNotEquals(row.id, exceptId);
      if (columnMatches === true && notExcluded === true) return row;
    }
    return null;
  }

  insert(sql: string, params: unknown[]): { id: number } {
    const match = INSERT_ROW.exec(sql);
    if (!match) throw new Error(`fake session: unrecognised INSERT: ${sql}`);
    const columns = match[1]!.split(",").map((c) => c.trim());
    const written = Object.fromEntries(columns.map((column, i) => [column, params[i]]));
    const row: FakeRow = { id: this.nextId, name: String(written.name), slug: String(written.slug) };
    this.enforceUnique(row);
    this.rows.push(row);
    this.nextId += 1;
    return { id: row.id };
  }

  update(sql: string, params: unknown[]): void {
    const match = UPDATE_ROW.exec(sql);
    if (!match) throw new Error(`fake session: unrecognised UPDATE: ${sql}`);
    const assignments = match[1]!.split(",").map((a) => a.trim().replace(/ = \?$/, ""));
    const id = params[params.length - 1];
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`fake session: no row with id ${String(id)}`);
    const written = Object.fromEntries(assignments.map((column, i) => [column, params[i]]));
    const updated: FakeRow = {
      ...row,
      ...(typeof written.name === "string" ? { name: written.name } : {}),
      ...(typeof written.slug === "string" ? { slug: written.slug } : {}),
    };
    this.enforceUnique(updated);
    Object.assign(row, updated);
  }

  session(): Session {
    const db = this;
    return {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            bound = values;
            return statement;
          },
          async first<T>(): Promise<T | null> {
            if (sql.startsWith("INSERT")) return db.insert(sql, bound) as T;
            return db.select(sql, bound) as T | null;
          },
          async run() {
            db.update(sql, bound);
            return { success: true };
          },
        };
        return statement;
      },
    } as unknown as Session;
  }
}

// Every column insertFoodbank does not fill in for itself -- i.e. what
// FOODBANK_FIELDS makes the admin type (workers/site/src/lib/
// adminFormFields.ts:88-118).
function fields(name: string): Record<string, string | number | null> {
  return {
    name,
    address: "1 Test Street\r\nTestville",
    postcode: "SW1A 1AA",
    country: "England",
    lat_lng: "51.5,-0.1",
    contact_email: "test@example.org",
    url: "https://example.org/",
    shopping_list_url: "https://example.org/list/",
  };
}

let db: FakeDatabase;
let session: Session;

beforeEach(() => {
  db = new FakeDatabase();
  session = db.session();
});

function idOf(name: string): number {
  const row = db.rows.find((r) => r.name === name);
  if (!row) throw new Error(`no food bank named ${name}`);
  return row.id;
}

describe("foodbankNameTaken", () => {
  it("reports a name another row already holds", async () => {
    // The CREATE case, and the one that kills the `id != ?` mutant: with no
    // row to exclude the helper binds NULL, `id != NULL` is UNKNOWN rather
    // than true, and a naive check would filter out every row here and wave
    // the duplicate through to the INSERT that 500s.
    await insertFoodbank(session, fields("Brixton Food Bank"));
    expect(await foodbankNameTaken(session, "Brixton Food Bank", undefined)).toBe(true);
  });

  it("passes a name nothing else holds", async () => {
    await insertFoodbank(session, fields("Brixton Food Bank"));
    expect(await foodbankNameTaken(session, "Camden Food Bank", undefined)).toBe(false);
  });

  it("does not report a row's own name back to it", async () => {
    // THE regression exceptId exists for. FoodbankForm and
    // FoodbankPoliticsForm post all 30 fields including the unchanged name,
    // so an unexcluded check would reject every ordinary save -- editing a
    // phone number on a food bank nobody is renaming.
    await insertFoodbank(session, fields("Brixton Food Bank"));
    expect(await foodbankNameTaken(session, "Brixton Food Bank", idOf("Brixton Food Bank"))).toBe(false);
  });

  it("reports another row's name on an edit", async () => {
    // Renaming Camden onto Brixton. The exclusion is by id, so the OTHER row
    // still counts -- an exceptId that suppressed the whole check would
    // leave the edit path silently unguarded again.
    await insertFoodbank(session, fields("Brixton Food Bank"));
    await insertFoodbank(session, fields("Camden Food Bank"));
    expect(await foodbankNameTaken(session, "Brixton Food Bank", idOf("Camden Food Bank"))).toBe(true);
  });

  it("is case-sensitive, because foodbank_name_uniq is", async () => {
    // SQLite's UNIQUE on TEXT compares bytes, so "brixton food bank" really
    // is a legal second NAME. It is not a legal second slug -- which is why
    // the slug check below is a separate constraint and not a formality.
    await insertFoodbank(session, fields("Brixton Food Bank"));
    expect(await foodbankNameTaken(session, "brixton food bank", undefined)).toBe(false);
  });
});

describe("foodbankSlugTaken", () => {
  it("catches a collision the name check cannot see", async () => {
    // Django never had this problem and never had this constraint: `slug` is
    // editable=False with no unique=True (givefood/models/foodbank.py:63), so
    // it wrote the second row and the public page blew up later with
    // MultipleObjectsReturned. slugify() drops the full stop and the
    // apostrophe, so these two genuinely different names share one slug.
    await insertFoodbank(session, fields("St. Mary's Foodbank"));
    const clashing = "St Marys Foodbank";
    expect(await foodbankNameTaken(session, clashing, undefined)).toBe(false);
    expect(await foodbankSlugTaken(session, foodbankSlugForName(clashing), undefined)).toBe(true);
  });

  it("does not report a row's own slug back to it", async () => {
    // Same regression as the name check, and easier to get wrong: every save
    // that posts an unchanged name re-derives the row's existing slug.
    await insertFoodbank(session, fields("Brixton Food Bank"));
    expect(await foodbankSlugTaken(session, foodbankSlugForName("Brixton Food Bank"), idOf("Brixton Food Bank"))).toBe(false);
  });

  it("reports another row's slug on an edit", async () => {
    await insertFoodbank(session, fields("Brixton Food Bank"));
    await insertFoodbank(session, fields("Camden Food Bank"));
    expect(await foodbankSlugTaken(session, "brixton-food-bank", idOf("Camden Food Bank"))).toBe(true);
  });

  it("passes a slug nothing else holds", async () => {
    await insertFoodbank(session, fields("Brixton Food Bank"));
    expect(await foodbankSlugTaken(session, "camden-food-bank", undefined)).toBe(false);
  });
});

describe("foodbankSlugForName", () => {
  // A slug check is only worth anything if it predicts the slug the write
  // will actually store. These two pin that agreement: a handler validating
  // one slug while the INSERT stored a different one would let a collision
  // through with a uniqueness check visibly in place.
  it("returns the slug insertFoodbank actually writes", async () => {
    const name = "St. Mary's Foodbank";
    const created = await insertFoodbank(session, fields(name));
    expect(created.slug).toBe(foodbankSlugForName(name));
    expect(db.rows).toEqual([{ id: created.id, name, slug: foodbankSlugForName(name) }]);
  });

  it("returns the slug updateFoodbankFields actually writes on a rename", async () => {
    await insertFoodbank(session, fields("Brixton Food Bank"));
    const renamed = "Brixton & Herne Hill Food Bank";
    const newSlug = await updateFoodbankFields(session, idOf("Brixton Food Bank"), { name: renamed }, true);
    expect(newSlug).toBe(foodbankSlugForName(renamed));
    expect(db.rows[0]).toMatchObject({ name: renamed, slug: foodbankSlugForName(renamed) });
  });

  it("returns null when the form posted no name", async () => {
    // The 4 partial forms (address/phone/email/fsa-id) never post `name`, so
    // no slug is re-derived and neither index can be touched -- which is why
    // the handler skips both lookups for them.
    await insertFoodbank(session, fields("Brixton Food Bank"));
    expect(await updateFoodbankFields(session, idOf("Brixton Food Bank"), { phone_number: "02079460000" }, true)).toBeNull();
  });
});
