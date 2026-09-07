import { describe, expect, it } from "vitest";
import { locationNameTaken, locationSlugTaken, locationSlug } from "./locationsAdmin";
import type { Session } from "./types";

// GitHub issue #12, verbatim: "500 adding a location with the same name as an
// existing location." Django's FoodbankLocationForm is a ModelForm over a
// model with `unique_together = ('foodbank', 'name')`
// (givefood/models/foodbank.py:794-795), so validate_unique() ran inside
// is_valid() and the clash came back on the re-rendered form with every typed
// value still bound. This port sent the INSERT straight to D1, SQLite raised
// SQLITE_CONSTRAINT_UNIQUE against loc_fb_name_uniq, and app.onError rendered
// the 500 page over the admin's ten fields. locationNameTaken() and
// locationSlugTaken() are the pre-flights that close that.
//
// WHAT THIS FILE COVERS, AND WHAT IT DOES NOT. Every function in this package
// is a D1 query, and TESTING.md is explicit that nothing here yet proves a
// query returns the right rows -- that needs a seeded database. So these tests
// are a CONTRACT ON THE QUERY: which table, which predicates, what gets bound,
// and how a row / no row becomes true / false. They cannot prove the SQL means
// what it says, because no engine runs.
//
// The engine-level proof exists and lives in
// workers/site/src/routes/admin/foodbankLocation.test.ts, which runs these
// exact functions against a real SQLite database with the real loc_fb_name_uniq
// and loc_foodbank_slug_idx indexes -- create, edit, the self-exclusion, the
// NULL comparison, and the fact that the slug index is NOT unique. It is over
// there rather than here because node:sqlite has no types under this package's
// tsconfig (`"types": ["@cloudflare/workers-types"]`), and adding them is a
// dependency change, not a test change. Read the two together: this file pins
// the queries' shape, that one pins their behaviour. (donationPointsAdmin.test
// .ts is split the same way, for the same reason.)
//
// locationSlug is the exception -- it is pure, so it is tested here for real.

interface Recorded {
  sql: string;
  params: unknown[];
}

// Records what the function asks the database for, and dictates the answer.
// Deliberately dumb -- it must not interpret the SQL, or these tests would be
// asserting against a second implementation of the thing under test.
function recordingSession(answer: { id: number } | null): { session: Session; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const session = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return { first: async () => answer };
        },
      };
    },
  } as unknown as Session;
  return { session, calls };
}

const only = (calls: Recorded[]): Recorded => {
  expect(calls).toHaveLength(1);
  return calls[0]!;
};

const SALISBURY = 7;

describe("locationNameTaken", () => {
  it("asks foodbanklocation for a row scoped by BOTH foodbank_id and name", async () => {
    const { session, calls } = recordingSession(null);
    await locationNameTaken(session, SALISBURY, "Bemerton Heath Centre", undefined);

    const { sql, params } = only(calls);
    // loc_fb_name_uniq is UNIQUE(foodbank_id, name), matching Django's
    // unique_together=('foodbank','name') -- the pair, not the name alone.
    // Dropping the foodbank_id predicate would reject the second food bank in
    // the country to open a location called "Amesbury".
    expect(sql).toContain("FROM foodbanklocation");
    expect(sql).toContain("foodbank_id = ?");
    expect(sql).toContain("name = ?");
    expect(params.slice(0, 2)).toEqual([SALISBURY, "Bemerton Heath Centre"]);
  });

  // THE MUTANT THIS FUNCTION EXISTS TO AVOID. On a create there is no row to
  // exclude, so exceptId binds as NULL -- and SQLite's `id != NULL` evaluates
  // to NULL, never true, which filters out every row and makes the check
  // silently always pass. That is issue #12 back again, wearing a check's
  // clothing. `id IS NOT ?` is the null-safe comparison, copied from
  // slugRedirects.ts:62-69, which documents the same trap.
  //
  // Asserted as a negative on the spelling as well as a positive, because the
  // two forms are one character apart and a reviewer's eye slides over it.
  // That SQLite really behaves this way is executed, not asserted, in
  // foodbankLocation.test.ts's "pins the SQLite NULL semantics" case.
  it("uses the NULL-safe `IS NOT`, never `!=`", async () => {
    const { session, calls } = recordingSession(null);
    await locationNameTaken(session, SALISBURY, "Bemerton Heath Centre", undefined);

    const { sql } = only(calls);
    expect(sql).toContain("id IS NOT ?");
    expect(sql).not.toMatch(/id\s*!=\s*\?/);
    expect(sql).not.toMatch(/id\s*<>\s*\?/);
  });

  it("binds NULL for the exclusion on a create", async () => {
    const { session, calls } = recordingSession(null);
    await locationNameTaken(session, SALISBURY, "Bemerton Heath Centre", undefined);

    expect(only(calls).params[2]).toBeNull();
  });

  // The exclusion the edit path depends on. admin.js injects a Lookup button
  // onto this form whose whole job is to refill lat_lng / address / postcode
  // on an EXISTING row while leaving the Name alone; without the row's own id
  // reaching the query, that save would be refused forever.
  it("binds the row's own id for the exclusion on an edit", async () => {
    const { session, calls } = recordingSession(null);
    await locationNameTaken(session, SALISBURY, "Bemerton Heath Centre", 412);

    expect(only(calls).params[2]).toBe(412);
  });

  it("reports a returned row as taken and no row as free", async () => {
    const taken = recordingSession({ id: 412 });
    expect(await locationNameTaken(taken.session, SALISBURY, "Bemerton Heath Centre", undefined)).toBe(true);

    const free = recordingSession(null);
    expect(await locationNameTaken(free.session, SALISBURY, "Wilton", undefined)).toBe(false);
  });
});

describe("locationSlugTaken", () => {
  it("asks foodbanklocation for a row scoped by BOTH foodbank_id and slug", async () => {
    const { session, calls } = recordingSession(null);
    await locationSlugTaken(session, SALISBURY, "st-marys-hall", undefined);

    const { sql, params } = only(calls);
    expect(sql).toContain("FROM foodbanklocation");
    expect(sql).toContain("foodbank_id = ?");
    expect(sql).toContain("slug = ?");
    expect(params.slice(0, 2)).toEqual([SALISBURY, "st-marys-hall"]);
  });

  // A separate query on a separate column, not the name check with a different
  // argument: `slug = ?` must not drift back to `name = ?`, or the check would
  // silently become a duplicate of the one above and every slug collision would
  // sail through again.
  it("filters on slug, not on name", async () => {
    const { session, calls } = recordingSession(null);
    await locationSlugTaken(session, SALISBURY, "st-marys-hall", undefined);

    expect(only(calls).sql).not.toContain("name = ?");
  });

  it("uses the NULL-safe `IS NOT`, never `!=`", async () => {
    const { session, calls } = recordingSession(null);
    await locationSlugTaken(session, SALISBURY, "st-marys-hall", undefined);

    const { sql } = only(calls);
    expect(sql).toContain("id IS NOT ?");
    expect(sql).not.toMatch(/id\s*!=\s*\?/);
    expect(sql).not.toMatch(/id\s*<>\s*\?/);
  });

  it("binds NULL on a create and the row's own id on an edit", async () => {
    const create = recordingSession(null);
    await locationSlugTaken(create.session, SALISBURY, "st-marys-hall", undefined);
    expect(only(create.calls).params[2]).toBeNull();

    const edit = recordingSession(null);
    await locationSlugTaken(edit.session, SALISBURY, "st-marys-hall", 412);
    expect(only(edit.calls).params[2]).toBe(412);
  });
});

// Pure, so this one is tested for real rather than by contract. It is also
// the whole justification for locationSlugTaken existing at all: if the
// derivation did not collide, a slug check would be dead code.
describe("locationSlug", () => {
  it("collapses names that differ only in punctuation", () => {
    expect(locationSlug("St Mary's Hall")).toBe("st-marys-hall");
    expect(locationSlug("St Marys Hall")).toBe("st-marys-hall");
    expect(locationSlug("Barrow-in-Furness")).toBe("barrow-in-furness");
    expect(locationSlug("Barrow in Furness")).toBe("barrow-in-furness");
    // Two names loc_fb_name_uniq happily accepts as different, one slug.
    expect(locationSlug("Foodbank — North")).toBe(locationSlug("Foodbank North"));
  });

  it("strips accents to ASCII the way the stored slugs already are", () => {
    expect(locationSlug("Café Centre")).toBe("cafe-centre");
  });

  // Documented, not endorsed: a name with no ASCII word characters slugifies
  // to the empty string, which makes the location's own URLs unroutable. That
  // is a real defect and a faithful port of Django's (models/foodbank.py:772
  // derives the slug identically, with no fallback), and it is NOT what the
  // uniqueness checks are for -- pinned here so the next person to touch this
  // knows it is a known gap rather than an accident of this change.
  it("returns an empty slug for a name with no ASCII word characters", () => {
    expect(locationSlug("北京")).toBe("");
  });
});
