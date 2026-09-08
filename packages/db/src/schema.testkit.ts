// The real D1 schema, as one SQL string, for tests that run against an
// in-memory SQLite database.
//
// NOT a test file (vitest collects `*.test.ts` only) and not shipped: nothing
// in the Worker import graph reaches it, so it never enters a bundle. It
// lives in src/ rather than a tests/ tree because that is where this repo
// keeps tests, and a helper should sit with the thing it helps.
//
// WHY THIS IS SHARED RATHER THAN INLINED. 23 db test files each grew their
// own copy of this loader, which was 23 chances for the fixture schema to
// drift from the migrations it claims to be. It also broke `pnpm typecheck`
// in a way none of them noticed -- see the paths note below.
//
// READ FROM THE MIGRATIONS, never hand-written. A fixture schema typed out
// by hand tests the test author's memory of the columns; this tests the
// columns the database actually has, so a migration that adds a NOT NULL
// column fails the suites that don't supply it -- which is the correct and
// useful outcome.
//
// STRING PATHS, NOT `URL`. `readdirSync(new URL(...))` is valid Node and
// does not typecheck in this package: @cloudflare/workers-types and
// @types/node each declare a global `URL`, they differ (workers-types'
// URLSearchParams iterator lacks `[Symbol.dispose]`), and node:fs's
// `PathLike` wants Node's. Converting to a string at the boundary sidesteps
// the clash entirely and is what produced 46 of the 105 typecheck errors
// this file was extracted to fix.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// For schemaFor() at the bottom of this file. `@ts-ignore` rather than
// `@ts-expect-error`, following the test files' own convention: node:sqlite is
// real under vitest's node environment but absent from this package's
// @types/node, and a suppression that itself becomes an error the day the
// tooling is FIXED is worse than one line of noise.
// @ts-ignore -- no node:sqlite types under this package's tsconfig
import { DatabaseSync } from "node:sqlite";

// `.href`, not the URL object: fileURLToPath's signature is
// `string | import("node:url").URL`, and `new URL(...)` here resolves to
// workers-types' URL, which is not that type -- the same clash described
// above, one layer down. Handing it the string is both simpler and the only
// spelling that typechecks.
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url).href);

// Lexical sort is the apply order: the files are numbered 0001_, 0002_, ...
// exactly so that this works, and `wrangler d1 migrations apply` uses the
// same ordering.
export const MIGRATIONS_SQL: string = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
  .join("\n");

// The DDL for a NAMED SUBSET of the schema -- the objects asked for, plus the
// indexes that belong to them -- exactly as SQLite reports it once every
// migration has been applied.
//
// WHY THIS EXISTS RATHER THAN MIGRATIONS_SQL. The workers/site route suites
// hand-build a NARROW fixture: only the tables that route touches, and often
// only the columns it reads. That is deliberate -- applying all the migrations
// instead would force each seed to satisfy every NOT NULL column of the real
// table, which is a different and much heavier kind of test. But when a shared
// packages/db function starts reading a table those narrow fixtures do not
// have, every one of them 500s at once; that is what happened when
// getFoodbankBySlug began reading `foodbankchange_full` unconditionally
// (github #51), and eight suites needed the same two objects added.
//
// PASTING THE DDL INTO EACH SUITE WOULD BE EIGHT SECOND COPIES OF THE TRUTH,
// which is the failure this whole file exists to prevent -- and a regex over
// the CREATE TABLE text would not even be a correct copy: 0019 does
// `ALTER TABLE foodbankchange DROP COLUMN foodbank_name` long after 0001
// created it, and drops and recreates `foodbankchange_full` around it. So this
// runs the migrations into a scratch in-memory database and asks the engine
// what the object looks like AT THE END, which is the only answer that stays
// true across the next migration.
//
// Emitted in creation order (sqlite_master's rowid), so a table precedes its
// own indexes. Auto-created indexes (`sqlite_autoindex_*`, whose
// sqlite_master.sql is NULL) are skipped: they come back with the table.
//
// The caller is responsible for the objects a VIEW reads through -- asking for
// `foodbankchange_full` gets the view's own CREATE VIEW, not the `foodbank`
// table it joins to, and SQLite will happily create a view over a table that
// does not exist and then fail at SELECT time. In practice the narrow fixtures
// already have the parent table; that is why they are narrow and not empty.
interface ScratchDatabase {
  prepare(sql: string): { all(...params: string[]): Array<{ sql: string }> };
}

let scratch: ScratchDatabase | null = null;

export function schemaFor(...names: string[]): string {
  // Built once per process, and only if something asks: the suites that want
  // the whole schema should not pay for a second database.
  if (scratch === null) {
    const db = new DatabaseSync(":memory:");
    db.exec(MIGRATIONS_SQL);
    // Through `unknown`, because `DatabaseSync` is an implicit `any` under this
    // package's tsconfig (see the node:sqlite note at the top) and tsc rejects
    // the direct assertion as insufficiently overlapping.
    scratch = db as unknown as ScratchDatabase;
  }
  const placeholders = names.map(() => "?").join(", ");
  const rows = scratch
    .prepare(
      `SELECT sql FROM sqlite_master
        WHERE sql IS NOT NULL AND (name IN (${placeholders}) OR tbl_name IN (${placeholders}))
        ORDER BY rowid`,
    )
    .all(...names, ...names);
  // A typo in a name is otherwise silent -- the fixture comes up without the
  // table and the suite fails somewhere else entirely, with "no such table".
  if (rows.length === 0) throw new Error(`schemaFor: no such object in the migrations: ${names.join(", ")}`);
  return rows.map((row) => `${row.sql};`).join("\n");
}
