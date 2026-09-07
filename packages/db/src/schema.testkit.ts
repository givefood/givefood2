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
