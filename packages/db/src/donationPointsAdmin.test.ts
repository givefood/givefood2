import { describe, expect, it } from "vitest";
import { donationPointNameTaken } from "./donationPointsAdmin";
import type { Session } from "./types";

// GitHub issue #12: "500 adding a location with the same name as an existing
// location." Django's FoodbankDonationPointForm ran validate_unique() inside
// is_valid() and came back with the re-rendered form; this port sent the
// INSERT straight to D1, SQLite raised SQLITE_CONSTRAINT_UNIQUE and the admin
// lost everything they had typed behind a 500. donationPointNameTaken() is the
// pre-flight that closes that.
//
// WHAT THIS FILE COVERS, AND WHAT IT DOES NOT. Every function in this package
// is a D1 query, and TESTING.md is explicit that nothing here yet proves a
// query returns the right rows -- that needs a seeded database. So these tests
// are a CONTRACT ON THE QUERY: which table, which predicates, what gets bound,
// and how a row / no row becomes true / false. They cannot prove the SQL means
// what it says, because no engine runs.
//
// The engine-level proof exists, and lives in
// workers/site/src/routes/admin/donationPoint.test.ts, which runs this exact
// function against a real SQLite database with the real dp_fb_name_uniq index
// -- create, edit, the self-exclusion, and the NULL comparison below. It is
// over there rather than here because node:sqlite has no types under this
// package's tsconfig (`"types": ["@cloudflare/workers-types"]`), and adding
// them is a dependency change, not a test change. Read the two together: this
// file pins the query's shape, that one pins its behaviour.

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

describe("donationPointNameTaken", () => {
  it("asks foodbankdonationpoint for a row scoped by BOTH foodbank_id and name", async () => {
    const { session, calls } = recordingSession(null);
    await donationPointNameTaken(session, 7, "Tesco Extra", undefined);

    const { sql, params } = only(calls);
    // dp_fb_name_uniq is UNIQUE(foodbank_id, name), matching Django's
    // unique_together=('foodbank','name') -- the pair, not the name alone.
    // Dropping the foodbank_id predicate would reject the second food bank in
    // the country to open a Tesco Extra donation point.
    expect(sql).toContain("FROM foodbankdonationpoint");
    expect(sql).toContain("foodbank_id = ?");
    expect(sql).toContain("name = ?");
    expect(params.slice(0, 2)).toEqual([7, "Tesco Extra"]);
  });

  // THE MUTANT THIS FUNCTION EXISTS TO AVOID. On a create there is no row to
  // exclude, so exceptId binds as NULL -- and SQLite's `id != NULL` evaluates
  // to NULL, never true, which filters out every row and makes the check
  // silently always pass. That is issue #12 back again, wearing a check's
  // clothing. `id IS NOT ?` is the null-safe comparison, and is copied from
  // slugRedirects.ts:62-69, which documents the same trap.
  //
  // Asserted as a negative on the spelling as well as a positive, because the
  // two forms are one character apart and a reviewer's eye slides over it.
  // That SQLite really behaves this way is executed, not asserted, in
  // donationPoint.test.ts's "pins the SQLite NULL semantics" case.
  it("uses the NULL-safe `IS NOT`, never `!=`", async () => {
    const { session, calls } = recordingSession(null);
    await donationPointNameTaken(session, 7, "Tesco Extra", undefined);

    const { sql } = only(calls);
    expect(sql).toContain("id IS NOT ?");
    expect(sql).not.toMatch(/id\s*!=\s*\?/);
    expect(sql).not.toMatch(/id\s*<>\s*\?/);
  });

  it("binds NULL for the exclusion on a create", async () => {
    const { session, calls } = recordingSession(null);
    await donationPointNameTaken(session, 7, "Tesco Extra", undefined);

    // Not undefined: D1 rejects an undefined binding outright, so the
    // `?? null` is load-bearing even before the NULL semantics above.
    expect(only(calls).params[2]).toBeNull();
  });

  // The regression the exclusion exists for. The "Lookup Donation Point"
  // button's whole job is to refresh lat_lng / place_id / opening_hours on an
  // EXISTING row while leaving the Name alone, after which the admin saves; a
  // check that matched the row against its own unchanged name would make that
  // flow permanently unsavable. Django did this too --
  // Model._perform_unique_checks() does `qs.exclude(pk=...)` whenever the
  // instance has a pk.
  it("binds the row's own id for the exclusion on an edit", async () => {
    const { session, calls } = recordingSession(null);
    await donationPointNameTaken(session, 7, "Tesco Extra", 42);

    expect(only(calls).params).toEqual([7, "Tesco Extra", 42]);
  });

  it("reports a returned row as taken", async () => {
    const { session } = recordingSession({ id: 42 });
    expect(await donationPointNameTaken(session, 7, "Tesco Extra", undefined)).toBe(true);
  });

  it("reports no row as free", async () => {
    const { session } = recordingSession(null);
    expect(await donationPointNameTaken(session, 7, "Tesco Extra", undefined)).toBe(false);
  });

  // `!!row` rather than `row !== null`: id 0 is not a real primary key in this
  // schema, but a truthiness check on the ROW (not on a column) is what makes
  // that irrelevant. Pinned so a future rewrite to `SELECT COUNT(*)` -- where
  // a row always comes back and truthiness would answer "taken" every time --
  // is caught here rather than by an admin who cannot save anything.
  it("reads the row's presence, not a column's truthiness", async () => {
    const { session } = recordingSession({ id: 0 });
    expect(await donationPointNameTaken(session, 7, "Tesco Extra", undefined)).toBe(true);
  });
});
