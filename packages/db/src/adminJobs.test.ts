import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pyDatetime } from "@givefood/models";
import {
  getAdminJob,
  getAdminJobCounts,
  getLatestAdminJob,
  getRecentAdminJobs,
  insertAdminJob,
  markAdminJobDone,
  markAdminJobFailed,
  markAdminJobRunning,
} from "./adminJobs";
import type { Session } from "./types";

// adminJobs.ts is eight statements and no logic, which is precisely why it
// needs an engine underneath it. Every failure mode this module has is
// SILENT: a dropped predicate returns the wrong row, a CASE band in the wrong
// order returns the right rows in the wrong sequence, and a threshold in the
// wrong text format returns a smaller number. None of them throws, none of
// them logs, and the page renders happily either way. That is the scar this
// repo already carries -- migration 0019 broke four queries with no error
// anywhere, and getAdminDashboardStats spent its life comparing an ISO
// threshold against Django-format columns and quietly dropping 31 of 46 rows
// (see packages/models/src/pyDatetime.ts's header, and 0022's).
//
// So the fixture is a REAL SQLite database created from the REAL schema in
// migrations/0013_admin_jobs.sql, and every assertion below is about rows:
// which ones come back, in which order, holding which values.
//
// WHY THE IMPORT IS A DYNAMIC ONE. packages/db's tsconfig pins
// `"types": ["@cloudflare/workers-types"]` and the package has no
// @types/node, so a plain `import { DatabaseSync } from "node:sqlite"` fails
// `pnpm typecheck` for everyone with TS2591 -- which is exactly why
// locationsAdmin.test.ts and donationPointsAdmin.test.ts pushed their
// engine-level halves out into workers/site instead. Routing the specifier
// through a const means TypeScript never tries to resolve the module, the
// shape is declared here, and the tests get a real engine without a
// dependency change. `tsc --noEmit` in this package was run against this
// file, not assumed.

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

// migrations/0013_admin_jobs.sql, verbatim -- column names, types, NOT NULL
// constraints and the index. Transcribed from the migration rather than from
// AdminJobRow on purpose: the interface and the table disagreeing is one of
// the things these tests exist to catch, so deriving the fixture from the
// types would make that check circular. The index is here because
// getRecentAdminJobs and getLatestAdminJob both order by `created` and an
// index changes which plan the engine picks; a fixture without it is testing
// a different query plan from production.
const SCHEMA = `
CREATE TABLE admin_job (
  id TEXT PRIMARY KEY,               -- uuid
  kind TEXT NOT NULL,                -- check | needtestbed | urls-suggest | ...
  target TEXT,                       -- foodbank slug, or whatever \`kind\` needs
  status TEXT NOT NULL,              -- queued | running | done | failed
  result TEXT,                       -- JSON payload the page renders
  error TEXT,
  created TEXT NOT NULL,
  finished TEXT
);
CREATE INDEX admin_job_created_idx ON admin_job(created DESC);
`;

// The D1 Sessions API surface this package uses, over node:sqlite. Copied
// from workers/site/src/routes/admin/foodbankLocation.test.ts rather than
// reinvented, so the two suites agree about what D1 does -- in particular
// that `.first()` answers null, not undefined, for no row, which is the
// difference between `if (!job)` and `job.status` throwing in
// routes/admin/foodbankCheck.ts.
type Bindable = null | number | bigint | string | Uint8Array;

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

// Django's `str(datetime)`, which is what pyNow() writes and what the ETL
// already wrote -- never toISOString(). Six fractional digits throughout so
// every value is the same length and lexicographic order agrees with
// chronological order exactly (pyDatetime.ts's "SIX FRACTIONAL DIGITS
// ALWAYS" note). Spread across two days so a same-day-only fixture cannot
// pass an ordering test by accident.
const T = {
  sep03: "2026-09-03 07:15:00.000000",
  sep04: "2026-09-04 09:00:00.000000",
  sep05am: "2026-09-05 08:12:03.140000",
  sep05noon: "2026-09-05 12:00:00.000000",
  sep05pm: "2026-09-05 19:28:08.853000",
  sep06early: "2026-09-06 05:00:00.000000",
  sep06late: "2026-09-06 06:00:00.000000",
};

function seedJob(job: {
  id: string;
  kind?: string;
  target?: string | null;
  status?: string;
  result?: string | null;
  error?: string | null;
  created: string;
  finished?: string | null;
}): void {
  db.prepare("INSERT INTO admin_job (id, kind, target, status, result, error, created, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    job.id,
    job.kind ?? "check",
    job.target ?? null,
    job.status ?? "done",
    job.result ?? null,
    job.error ?? null,
    job.created,
    job.finished ?? null,
  );
}

// Spread into a plain object: node:sqlite hands back null-prototype rows, and
// a plain object keeps `toEqual` diffs readable.
function stored(id: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM admin_job WHERE id = ?").get(id);
  if (!row) throw new Error(`no admin_job row with id ${id}`);
  return { ...(row as Record<string, unknown>) };
}

function ids(rows: { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

// Date only, so the awaits in these tests still resolve on a real event loop.
function freezeClock(instant: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  session = d1Session(db);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("insertAdminJob", () => {
  // The whole row, not a spot check. A .bind() that drifts out of step with
  // its own column list writes a food bank slug into `kind` and a kind into
  // `target` without SQLite objecting -- both columns are TEXT -- and the
  // first symptom is /admin/job/:id/ redirecting to /admin/foodbank/check/
  // for a job whose target it no longer knows (routes/admin/foodbankCheck
  // .ts:145 builds that URL out of job.target).
  it("writes exactly one queued row, with every other column NULL", async () => {
    freezeClock("2026-09-05T19:28:08.853Z");
    await insertAdminJob(session, { id: "job-1", kind: "check", target: "salisbury" });

    expect(stored("job-1")).toEqual({
      id: "job-1",
      kind: "check",
      target: "salisbury",
      // A literal in the statement, not a bound value: the enqueue side and
      // the consumer agree on this exact word, and adminJobStatus polls
      // while status is "queued" or "running".
      status: "queued",
      result: null,
      error: null,
      created: T.sep05pm,
      // Not "" and not the created time -- getAdminJobCounts counts
      // finished_24h off this column, so a job that has not finished must be
      // NULL rather than any string, or it would be counted the moment it
      // was enqueued.
      finished: null,
    });
  });

  // TICKET #9, at its write site. pyNow() exists because SQLite compares TEXT
  // lexicographically and 'T' (0x54) sorts above ' ' (0x20), so ONE ISO value
  // in this column sorts above EVERY Django-format value from the same day --
  // and admin_job really did hold two of them, repaired by
  // 0022_normalise_timestamps.sql:102-108. If this write site ever goes back
  // to toISOString(), getLatestAdminJob starts handing the check page a stale
  // result and getAdminJobCounts starts under-counting, with nothing raised.
  it("stamps created in Django's format, never JavaScript's ISO", async () => {
    await insertAdminJob(session, { id: "job-1", kind: "check", target: "salisbury" });

    const created = String(stored("job-1").created);
    expect(created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(created).not.toContain("T");
    expect(created).not.toContain("Z");
  });

  // The format claim above is only worth anything if the engine agrees, so
  // the comparison is executed rather than reasoned about: a job enqueued now
  // must beat a row the ETL wrote earlier, through the actual ORDER BY.
  it("writes a created that really does sort after an older Django-format row", async () => {
    seedJob({ id: "older", target: "salisbury", created: "2020-01-01 00:00:00.000000" });
    await insertAdminJob(session, { id: "newer", kind: "check", target: "salisbury" });

    expect((await getLatestAdminJob(session, "check", "salisbury"))?.id).toBe("newer");
  });

  // orderForm.ts and foodbankCheck.ts both pass a real target today, but the
  // parameter is `string | null` and `target` is a nullable column. Pinned
  // together with its consequence in getLatestAdminJob's own describe block:
  // a NULL target is write-only, because `target = ?` can never match NULL.
  it("accepts a null target", async () => {
    await insertAdminJob(session, { id: "job-1", kind: "urls-suggest", target: null });

    expect(stored("job-1").target).toBeNull();
  });

  // `id TEXT PRIMARY KEY`, so a reused id is refused rather than silently
  // overwriting the earlier job's row and losing its result. Both call sites
  // pass crypto.randomUUID(), so this is a guard on the schema, not a
  // reachable path -- but the alternative behaviour (INSERT OR REPLACE)
  // would be a data loss nobody would ever see.
  it("refuses a duplicate id instead of overwriting the earlier job", async () => {
    await insertAdminJob(session, { id: "job-1", kind: "check", target: "salisbury" });

    await expect(insertAdminJob(session, { id: "job-1", kind: "check", target: "oxford" })).rejects.toThrow(/UNIQUE|PRIMARY/i);
    expect(stored("job-1").target).toBe("salisbury");
  });
});

describe("getAdminJob", () => {
  // SELECT *, so the columns the caller gets are whatever the TABLE has --
  // and AdminJobRow is a hand-maintained claim about that. This is the
  // schema-versus-types disagreement check: add a column in a migration
  // without adding it to the interface (or drop one the interface still
  // promises) and this fails here rather than as an undefined in a template
  // three pages away.
  it("returns every column AdminJobRow declares, and no others", async () => {
    seedJob({ id: "job-1", target: "salisbury", created: T.sep05pm, finished: T.sep05pm, result: "{}" });

    const job = await getAdminJob(session, "job-1");
    expect(Object.keys(job!).sort()).toEqual(["created", "error", "finished", "id", "kind", "result", "status", "target"]);
  });

  it("returns the addressed row's values", async () => {
    seedJob({ id: "job-1", kind: "order-lines", target: "GF12345", status: "failed", error: "boom", created: T.sep05am, finished: T.sep05noon });
    seedJob({ id: "job-2", kind: "check", target: "salisbury", created: T.sep05pm });

    expect(await getAdminJob(session, "job-1")).toMatchObject({
      id: "job-1",
      kind: "order-lines",
      target: "GF12345",
      status: "failed",
      error: "boom",
      created: T.sep05am,
      finished: T.sep05noon,
      result: null,
    });
  });

  // null, not undefined, and not a throw. routes/admin/foodbankCheck.ts:138
  // does `if (!job) return c.notFound()` and order.ts:27 passes the result
  // straight into a template -- a ?job= id from an old bookmark, or from a
  // job in a database that has since been reset, must land on 404 rather
  // than on app.onError.
  it("answers null for an id that is not there", async () => {
    seedJob({ id: "job-1", created: T.sep05pm });

    expect(await getAdminJob(session, "no-such-job")).toBeNull();
  });
});

describe("markAdminJobRunning", () => {
  it("moves the job to running and leaves every other column alone", async () => {
    seedJob({ id: "job-1", kind: "check", target: "salisbury", status: "queued", created: T.sep05am });

    await markAdminJobRunning(session, "job-1");

    expect(stored("job-1")).toEqual({
      id: "job-1",
      kind: "check",
      target: "salisbury",
      status: "running",
      result: null,
      error: null,
      created: T.sep05am,
      // Deliberately still NULL. `finished` means finished; a running job
      // with a finish time would be counted by getAdminJobCounts'
      // finished_24h the moment the status later changed.
      finished: null,
    });
  });

  // The missing-WHERE mutant. `UPDATE admin_job SET status = 'running'` with
  // no predicate is valid SQL that reports success and marks the entire
  // table running -- which the jobs page would then render as a stampede of
  // stuck work, and which no test that seeds only one row can catch.
  it("touches only the addressed row", async () => {
    seedJob({ id: "job-1", status: "queued", created: T.sep05am });
    seedJob({ id: "job-2", status: "queued", created: T.sep05noon });
    seedJob({ id: "job-3", status: "done", created: T.sep05pm, finished: T.sep05pm });

    await markAdminJobRunning(session, "job-2");

    expect(stored("job-1").status).toBe("queued");
    expect(stored("job-2").status).toBe("running");
    expect(stored("job-3").status).toBe("done");
  });

  // A queue message naming a job id that was never inserted -- or one whose
  // row a database reset removed -- updates nothing and raises nothing. The
  // consumer (workers/jobs/src/adminJobs/foodbankCheck.ts:99) then does the
  // whole scrape and calls markAdminJobDone, which also matches no row, so
  // the work happens and is never recorded. Pinned as the current behaviour,
  // not endorsed: nothing here reports it.
  it("silently does nothing for an unknown id", async () => {
    seedJob({ id: "job-1", status: "queued", created: T.sep05am });

    await expect(markAdminJobRunning(session, "no-such-job")).resolves.toBeUndefined();
    expect(stored("job-1").status).toBe("queued");
  });

  // No status guard in the WHERE clause, so a re-delivered queue message
  // sends a finished job back to "running" -- and adminJobStatus polls while
  // status is queued or running, so the check page would go back to
  // spinning over a result it already has. Recorded because it is a real
  // consequence of the statement as written, and Cloudflare Queues are
  // at-least-once.
  it("will move an already-finished job back to running", async () => {
    seedJob({ id: "job-1", status: "done", result: '{"ok":true}', created: T.sep05am, finished: T.sep05noon });

    await markAdminJobRunning(session, "job-1");

    expect(stored("job-1").status).toBe("running");
    // The stale finish time and result stay put, so the row now claims to be
    // running and to have finished at the same time.
    expect(stored("job-1").finished).toBe(T.sep05noon);
    expect(stored("job-1").result).toBe('{"ok":true}');
  });
});

describe("markAdminJobDone", () => {
  it("stores the status, the JSON result and the finish time", async () => {
    seedJob({ id: "job-1", kind: "check", target: "salisbury", status: "running", created: T.sep05am });
    freezeClock("2026-09-05T19:28:08.853Z");

    await markAdminJobDone(session, "job-1", { no_lines: 4, no_items: 37 });

    expect(stored("job-1")).toEqual({
      id: "job-1",
      kind: "check",
      target: "salisbury",
      status: "done",
      result: '{"no_lines":4,"no_items":37}',
      error: null,
      // Untouched: the jobs list orders on `created`, so a writer that reset
      // it would shuffle finished jobs to the top of the third band as they
      // completed.
      created: T.sep05am,
      finished: T.sep05pm,
    });
  });

  // The consumers store an object and the page does `JSON.parse(job.result!)`
  // with a non-null assertion (foodbankCheck.ts:103,112). This is the round
  // trip that has to hold for that assertion to be safe -- byte-for-byte out
  // of the column, then back into the same object.
  it("round-trips a nested result through the TEXT column", async () => {
    seedJob({ id: "job-1", status: "running", created: T.sep05am });
    const result = { prompt: "Check https://example.org/needs", aiResponse: { needs: ["Beans", "Rice"], confidence: 0.9 } };

    await markAdminJobDone(session, "job-1", result);

    expect(JSON.parse(String(stored("job-1").result))).toEqual(result);
  });

  // JSON.stringify, not String(): a string result is stored WITH its quotes,
  // because the reader parses rather than reads. Storing `ok` bare would make
  // JSON.parse throw on the check page and take the whole page down with it.
  it("stores a bare string result as quoted JSON", async () => {
    seedJob({ id: "job-1", status: "running", created: T.sep05am });

    await markAdminJobDone(session, "job-1", "ok");

    expect(stored("job-1").result).toBe('"ok"');
    expect(JSON.parse(String(stored("job-1").result))).toBe("ok");
  });

  // The distinction that keeps the `job.result!` assertion honest: a null
  // result becomes the four characters "null", which JSON.parse handles,
  // NOT a SQL NULL, which would make JSON.parse(null) return null too but
  // only by luck of coercion -- and `result: null` in the column is the
  // state the template's "still running" branch is written for.
  it("stores a null result as the text 'null', not as SQL NULL", async () => {
    seedJob({ id: "job-1", status: "running", created: T.sep05am });

    await markAdminJobDone(session, "job-1", null);

    expect(stored("job-1").result).toBe("null");
    expect(stored("job-1").result).not.toBeNull();
  });

  // THE ONE INPUT THAT THROWS. JSON.stringify(undefined) is undefined, not a
  // string, and neither SQLite nor D1 will bind undefined to a parameter. In
  // the consumer this lands inside the try/catch (orderLines.ts:191-193), so
  // a job that actually succeeded would be recorded as failed with a binding
  // error for a message. `result: unknown` lets any caller do this, so it is
  // pinned rather than left to be discovered.
  it("rejects an undefined result rather than storing anything", async () => {
    seedJob({ id: "job-1", status: "running", created: T.sep05am });

    await expect(markAdminJobDone(session, "job-1", undefined)).rejects.toThrow();
    expect(stored("job-1").status).toBe("running");
  });

  it("touches only the addressed row", async () => {
    seedJob({ id: "job-1", status: "running", created: T.sep05am });
    seedJob({ id: "job-2", status: "running", created: T.sep05noon });

    await markAdminJobDone(session, "job-2", { ok: true });

    expect(stored("job-1")).toMatchObject({ status: "running", result: null, finished: null });
    expect(stored("job-2").status).toBe("done");
  });

  // The SET list names status, result and finished -- not error. A job that
  // failed and was retried onto success keeps the old error text beside its
  // new result, and admin/jobs.njk has both columns. Current behaviour,
  // recorded so that clearing it later is a visible decision rather than an
  // accident.
  it("leaves a previously recorded error in place", async () => {
    seedJob({ id: "job-1", status: "failed", error: "Gemini timed out", created: T.sep05am, finished: T.sep05noon });

    await markAdminJobDone(session, "job-1", { ok: true });

    expect(stored("job-1")).toMatchObject({ status: "done", error: "Gemini timed out" });
  });
});

describe("markAdminJobFailed", () => {
  it("stores the status, the message and the finish time", async () => {
    seedJob({ id: "job-1", kind: "order-lines", target: "GF12345", status: "running", created: T.sep05am });
    freezeClock("2026-09-05T19:28:08.853Z");

    await markAdminJobFailed(session, "job-1", "Order row 12 no longer exists");

    expect(stored("job-1")).toEqual({
      id: "job-1",
      kind: "order-lines",
      target: "GF12345",
      status: "failed",
      result: null,
      error: "Order row 12 no longer exists",
      created: T.sep05am,
      finished: T.sep05pm,
    });
  });

  // Stored verbatim, and long: orderLines.ts hands over whole sentences and
  // foodbankCheck.ts hands over `err.message`, which for a D1 failure is the
  // raw SQLite text. A writer that truncated or normalised it would take away
  // the only record of why a job died.
  it("stores the message verbatim, including one that names an API key", async () => {
    seedJob({ id: "job-1", status: "running", created: T.sep05am });
    const message = "GEMINI_API_KEY is not configured, so the items text could not be parsed into order lines.";

    await markAdminJobFailed(session, "job-1", message);

    expect(stored("job-1").error).toBe(message);
  });

  // MUTANT THAT SURVIVED the test above: `.bind(error.trim(), pyNow(), id)`.
  // "Verbatim" was asserted with a message that had nothing to trim, so a
  // writer that normalised whitespace passed. It matters because the message
  // this column really receives is `err.message` from a caught exception
  // (foodbankCheck.ts, orderLines.ts): a D1 failure's text is multi-line and
  // usually ends in a newline, and the leading indent is where the SQL
  // fragment sits. Truncation and tidying are the template's job at render
  // time -- admin/jobs.njk:129 does `|truncate(120)` -- precisely so the
  // stored text stays whole for the person who has to read the rest of it.
  it("stores the message with its leading and trailing whitespace intact", async () => {
    seedJob({ id: "job-1", status: "running", created: T.sep05am });
    const message = "  D1_ERROR: no such column: finished_at\n  SELECT * FROM admin_job\n";

    await markAdminJobFailed(session, "job-1", message);

    expect(stored("job-1").error).toBe(message);
  });

  // An empty message is stored as "", not NULL. The template's test for "did
  // this fail" is the status column, so an empty error is a job that failed
  // and said nothing -- distinguishable from a job that never failed, which
  // has NULL here.
  it("stores an empty message as an empty string, not NULL", async () => {
    seedJob({ id: "job-1", status: "running", created: T.sep05am });

    await markAdminJobFailed(session, "job-1", "");

    expect(stored("job-1").error).toBe("");
    expect(stored("job-1").error).not.toBeNull();
  });

  it("touches only the addressed row", async () => {
    seedJob({ id: "job-1", status: "running", created: T.sep05am });
    seedJob({ id: "job-2", status: "queued", created: T.sep05noon });

    await markAdminJobFailed(session, "job-1", "boom");

    expect(stored("job-2")).toMatchObject({ status: "queued", error: null, finished: null });
  });

  // Mirror of markAdminJobDone's error case: `result` is not in this SET
  // list, so a job that stored a result and then failed keeps both.
  it("leaves a previously stored result in place", async () => {
    seedJob({ id: "job-1", status: "done", result: '{"no_lines":4}', created: T.sep05am, finished: T.sep05noon });

    await markAdminJobFailed(session, "job-1", "boom");

    expect(stored("job-1")).toMatchObject({ status: "failed", result: '{"no_lines":4}' });
  });
});

describe("getLatestAdminJob", () => {
  // The check page's own lookup: kind AND target, newest first, one row. The
  // fixture seeds rows that must be excluded for each half of that predicate
  // -- a newer job of the same kind for a DIFFERENT food bank, and a newer
  // job of a DIFFERENT kind for the same food bank -- because a filter that
  // does nothing passes every test whose fixture only contains matching rows.
  beforeEach(() => {
    seedJob({ id: "sal-oldest", kind: "check", target: "salisbury", created: T.sep03 });
    seedJob({ id: "sal-middle", kind: "check", target: "salisbury", created: T.sep05am });
    seedJob({ id: "sal-newest", kind: "check", target: "salisbury", created: T.sep05pm });
    seedJob({ id: "oxf-newer", kind: "check", target: "oxford", created: T.sep06late });
    seedJob({ id: "sal-other-kind", kind: "needtestbed", target: "salisbury", created: T.sep06late });
  });

  // The `LIMIT 1` is the one thing in this statement no test can pin, and
  // that is worth writing down rather than leaving as an apparent gap:
  // `.first()` returns the head of the result set whatever the LIMIT says,
  // so deleting it (or raising it to 2) is invisible from here and from the
  // route. It stays in the SQL because it is what stops the engine
  // materialising every job a food bank has ever had; it is a cost, not a
  // correctness, guard. Everything else below is observable and is asserted.
  it("returns the newest job for that kind and target", async () => {
    expect((await getLatestAdminJob(session, "check", "salisbury"))?.id).toBe("sal-newest");
  });

  // Drop `target = ?` and this returns oxf-newer, so /admin/foodbank/
  // salisbury/check/ would render Oxford's scrape as Salisbury's -- a wrong
  // page with no error anywhere, which is this tier's whole failure mode.
  it("does not fall through to another food bank's newer job", async () => {
    expect((await getLatestAdminJob(session, "check", "oxford"))?.id).toBe("oxf-newer");
    expect((await getLatestAdminJob(session, "check", "salisbury"))?.target).toBe("salisbury");
  });

  // Drop `kind = ?` and the newest row for salisbury is a needtestbed job,
  // whose stored result has an entirely different shape -- foodbankCheck.ts
  // would then JSON.parse it and hand the wrong object to the template.
  it("does not fall through to another kind's newer job", async () => {
    expect((await getLatestAdminJob(session, "check", "salisbury"))?.kind).toBe("check");
  });

  // MUTANT THAT SURVIVED the block above until this test existed:
  // `AND lower(target) = lower(?)`. So did `AND target LIKE ?`, because
  // SQLite's LIKE is case-insensitive over ASCII. Both passed every other
  // assertion here for the dullest possible reason -- no fixture held two
  // targets that differed only in case, so a comparison that had stopped
  // being exact had nothing to trip over.
  //
  // It is a plain `=` against a column with no COLLATE NOCASE, so the match
  // is byte-exact. That matters because `target` is whatever the caller
  // passed, not a validated slug: /admin/foodbank/Salisbury/check/ and
  // /admin/foodbank/salisbury/check/ are different rows here, and a
  // case-folding "fix" would quietly let one food bank's page show another
  // row's scrape. Asserted for `kind` too, which is a bare string literal at
  // every call site and has the same exposure.
  it("matches kind and target byte-exactly, not case-insensitively", async () => {
    seedJob({ id: "sal-capitalised", kind: "check", target: "Salisbury", created: T.sep06late });
    seedJob({ id: "check-capitalised", kind: "Check", target: "salisbury", created: T.sep06late });

    // Both near-misses are newer than sal-newest, so a case-insensitive
    // comparison would return one of them instead.
    expect((await getLatestAdminJob(session, "check", "salisbury"))?.id).toBe("sal-newest");
    // And they really are in the table -- it is the comparison refusing
    // them, not the fixture omitting them.
    expect((await getLatestAdminJob(session, "check", "Salisbury"))?.id).toBe("sal-capitalised");
    expect((await getLatestAdminJob(session, "Check", "salisbury"))?.id).toBe("check-capitalised");
  });

  it("answers null when that food bank has never been checked", async () => {
    expect(await getLatestAdminJob(session, "check", "wilton")).toBeNull();
  });

  // TICKET #9 IN THIS QUERY, executed. `ORDER BY created DESC` is a TEXT
  // sort, and 'T' (0x54) beats ' ' (0x20), so a single ISO-format row wins
  // over every Django-format row from the same day no matter what time it
  // actually holds -- 08:12 beating 19:28 here. admin_job really did contain
  // two such rows before 0022_normalise_timestamps.sql:102-108 rewrote them.
  // This test is what says out loud that the correctness of this query lives
  // entirely in pyNow()'s output format, not in the SQL.
  it("is fooled by an ISO-format created, which is why pyNow exists", async () => {
    seedJob({ id: "iso-morning", kind: "check", target: "salisbury", created: "2026-09-05T08:12:03.140Z" });

    expect((await getLatestAdminJob(session, "check", "salisbury"))?.id).toBe("iso-morning");
  });

  // SQLite's `= NULL` is never true, so a job inserted with a NULL target is
  // write-only: this lookup can never find it, whatever the caller passes.
  // The signature says `target: string`, so today's callers cannot reach it
  // -- but insertAdminJob accepts `target: null`, and a future kind with no
  // target would enqueue rows that this function would report as "never
  // run", re-running the work on every page visit. Same NULL-in-a-WHERE
  // class as locationsAdmin.ts's `id IS NOT ?`.
  it("can never find a job whose target is NULL", async () => {
    seedJob({ id: "no-target", kind: "urls-suggest", target: null, created: T.sep06late });

    expect(await getLatestAdminJob(session, "urls-suggest", null as unknown as string)).toBeNull();
    expect(await getLatestAdminJob(session, "urls-suggest", "")).toBeNull();
    // The row is really there -- it is the comparison that cannot see it.
    expect(stored("no-target").kind).toBe("urls-suggest");
  });

  // Status is not part of the predicate, and that is deliberate: the page
  // wants the latest job whatever became of it, so a failed run is shown as
  // a failed run rather than silently replaced by the last successful one.
  it("returns the newest job even when it failed", async () => {
    seedJob({ id: "sal-failed", kind: "check", target: "salisbury", status: "failed", error: "boom", created: T.sep06late });

    expect((await getLatestAdminJob(session, "check", "salisbury"))?.id).toBe("sal-failed");
  });

  // pyNow() has millisecond resolution, so two enqueues inside the same
  // millisecond produce identical `created` values and SQL leaves the tie
  // undefined -- there is no id or rowid tiebreaker in the ORDER BY. Asserted
  // as "one of the two" rather than a specific row, because pinning whichever
  // this engine happens to return would be asserting an accident. Recorded so
  // that a future "why did the check page show the older result" has a
  // written-down answer.
  it("leaves a same-millisecond tie undecided", async () => {
    seedJob({ id: "tie-a", kind: "check", target: "wilton", created: T.sep06late });
    seedJob({ id: "tie-b", kind: "check", target: "wilton", created: T.sep06late });

    expect(["tie-a", "tie-b"]).toContain((await getLatestAdminJob(session, "check", "wilton"))?.id);
  });
});

describe("getRecentAdminJobs", () => {
  // Six rows chosen so that the CASE band and the created sort disagree in
  // both directions: the NEWEST row overall is a done job (so a query that
  // lost the CASE puts it first), and the OLDEST row overall is queued (so a
  // query that lost the created sort, or reversed it, moves it). Two rows
  // share the "else" band with a done row between them, which is what proves
  // done and failed are not separately ordered.
  beforeEach(() => {
    seedJob({ id: "done-newest", status: "done", created: T.sep06late, finished: T.sep06late });
    seedJob({ id: "cancelled", status: "cancelled", created: T.sep06early });
    seedJob({ id: "running-new", status: "running", created: T.sep05pm });
    seedJob({ id: "failed-mid", status: "failed", error: "boom", created: T.sep05noon, finished: T.sep05noon });
    seedJob({ id: "running-old", status: "running", created: T.sep04 });
    seedJob({ id: "queued-oldest", status: "queued", created: T.sep03 });
  });

  // The exact sequence, which is the only assertion that can fail for the
  // right reason. Running first (a job in flight is the one an admin came to
  // the page about), then queued (a job whose consumer never picked it up
  // must not age quietly down the list), then everything finished, newest
  // first within each band.
  it("returns running, then queued, then the rest, newest first inside each band", async () => {
    expect(ids(await getRecentAdminJobs(session, 25))).toEqual([
      "running-new",
      "running-old",
      "queued-oldest",
      "done-newest",
      "cancelled",
      "failed-mid",
    ]);
  });

  // The CASE has no arm for anything but running and queued, so a status
  // this port has never written -- a hand-edited row, or a status a later
  // work package adds without touching this query -- lands in the ELSE band
  // with the finished jobs rather than disappearing. Pinned because "a new
  // status silently sorts as finished" is a decision, and because a CASE
  // rewritten with a NULL-producing arm would put it somewhere else.
  it("sorts an unrecognised status into the finished band, not out of the list", async () => {
    const rows = await getRecentAdminJobs(session, 25);
    expect(ids(rows)).toContain("cancelled");
    expect(ids(rows).indexOf("cancelled")).toBeGreaterThan(ids(rows).indexOf("queued-oldest"));
  });

  // LIMIT applies after the ORDER BY, which is the difference between "the
  // 25 jobs that matter" and "25 arbitrary jobs". The fixture's newest row
  // overall is a done job, so a limit that bit before the sort -- or a sort
  // that lost its CASE -- would put done-newest in this answer.
  it("keeps the top of the sorted list, not the newest rows", async () => {
    expect(ids(await getRecentAdminJobs(session, 2))).toEqual(["running-new", "running-old"]);
    expect(ids(await getRecentAdminJobs(session, 4))).toEqual(["running-new", "running-old", "queued-oldest", "done-newest"]);
  });

  it("returns nothing for a limit of zero", async () => {
    expect(await getRecentAdminJobs(session, 0)).toEqual([]);
  });

  // SQLite treats a NEGATIVE limit as no limit at all -- `LIMIT -1` is the
  // documented idiom for "everything". routes/admin/jobs.ts passes the
  // constant 25 so this is unreachable today, but a limit that ever arrives
  // from a query string would turn this page into an unbounded table scan
  // rendered in full. Pinned as a hazard, not as desired behaviour.
  it("returns EVERY row for a negative limit", async () => {
    // The whole sequence rather than a count. A length assertion alone says
    // "six rows came back" and would be satisfied by six rows in any order,
    // which is the weakest possible reading of a function whose entire job
    // is the order. Same list as the sorted test above, because LIMIT never
    // reorders -- it only cuts.
    expect(ids(await getRecentAdminJobs(session, -1))).toEqual([
      "running-new",
      "running-old",
      "queued-oldest",
      "done-newest",
      "cancelled",
      "failed-mid",
    ]);
  });

  // TICKET #9 IN THE THIRD QUERY. getLatestAdminJob and getAdminJobCounts
  // each have their own pinned version of this hazard; this one belongs here
  // because `created DESC` inside a band is the same lexicographic TEXT
  // sort, and an ISO-format value jumps to the TOP of its band whatever time
  // it actually holds -- one second past midnight outranking 19:28 the same
  // day, below. Nothing in the SQL rejects the format, so the jobs page's
  // ordering is only ever as correct as pyNow() is. This is the assertion
  // that says so for the list view, and the reason no write site into
  // admin_job may use toISOString().
  it("is fooled by an ISO-format created, which is why pyNow exists", async () => {
    seedJob({ id: "iso-running", status: "running", created: "2026-09-05T00:00:01.000Z" });

    expect(ids(await getRecentAdminJobs(session, 3))).toEqual(["iso-running", "running-new", "running-old"]);
  });

  it("returns an empty array, not null, when there are no jobs at all", async () => {
    db.exec("DELETE FROM admin_job");

    expect(await getRecentAdminJobs(session, 25)).toEqual([]);
  });

  // No kind, target or status filter: this is the whole table's list view,
  // and rows with a NULL target belong on it. A WHERE clause quietly
  // acquiring `target IS NOT NULL` would hide exactly the jobs that have no
  // other page to be seen on.
  it("lists jobs of every kind, including ones with no target", async () => {
    seedJob({ id: "no-target", kind: "urls-suggest", target: null, status: "running", created: T.sep06late });

    const rows = await getRecentAdminJobs(session, 25);
    expect(rows[0]?.id).toBe("no-target");
    expect(rows[0]?.target).toBeNull();
  });

  // SELECT * has to keep meaning "the whole row". admin/jobs.njk:117-130
  // renders six of the eight columns, so a SELECT narrowed to exactly those
  // six would render identically today and break /admin/job/:id/'s
  // AdminJobRow contract silently -- `result` is the column that page reads
  // and this list does not show. Asserted as the exact row and the exact key
  // set, not toMatchObject, because toMatchObject cannot see a MISSING
  // column, which is the only failure this test is here for.
  it("returns whole rows, with exactly AdminJobRow's columns", async () => {
    // Spread for the same reason as stored(): node:sqlite rows are
    // null-prototype, and a plain object keeps the diff readable.
    const failed = { ...(await getRecentAdminJobs(session, 25)).find((row) => row.id === "failed-mid")! };

    expect(failed).toEqual({
      id: "failed-mid",
      kind: "check",
      target: null,
      status: "failed",
      result: null,
      error: "boom",
      created: T.sep05noon,
      finished: T.sep05noon,
    });
  });
});

describe("getAdminJobCounts", () => {
  // A fixture where every clause of both FILTERs has a row that must be
  // excluded by it. `since` is midnight on the 5th, so the 3rd and 4th are
  // outside the window and the 5th and 6th are inside.
  const SINCE = "2026-09-05 00:00:00.000000";

  beforeEach(() => {
    // Counted by finished_24h.
    seedJob({ id: "done-inside", status: "done", created: T.sep05am, finished: T.sep05noon });
    seedJob({ id: "failed-inside", status: "failed", error: "boom", created: T.sep05am, finished: T.sep05pm });
    // The >= boundary itself. A `>` would drop a job that finished on the
    // exact microsecond of the threshold; the port says >=, and Django's
    // `finished_at__gte` did too (gfadmin/views.py:75-78).
    seedJob({ id: "done-on-boundary", status: "done", created: T.sep03, finished: SINCE });
    // Outside the window: finished, but before `since`.
    seedJob({ id: "done-outside", status: "done", created: T.sep03, finished: T.sep04 });
    // Inside the window by time, but not a finished status. Without the
    // `status IN ('done','failed')` half of the FILTER these two would be
    // counted as finished work.
    seedJob({ id: "running-with-finish", status: "running", created: T.sep05am, finished: T.sep05pm });
    seedJob({ id: "cancelled-with-finish", status: "cancelled", created: T.sep05am, finished: T.sep05pm });
    // Done, but never stamped -- NULL >= '2026-09-05...' is NULL, so it is
    // excluded. This is the row that proves the comparison is a comparison
    // and not a `status` test wearing one. Created OUTSIDE the window on
    // purpose: with `created` here instead of `finished` the count would
    // come out at 3 either way if this row were created inside it, and the
    // FILTER would be reading the wrong column with nothing to show for it.
    seedJob({ id: "done-no-finish", status: "done", created: T.sep03, finished: null });
    // Outstanding: one of each, one of them older than the whole window, so
    // a `since` predicate leaking into the second FILTER would be visible.
    seedJob({ id: "queued-ancient", status: "queued", created: "2026-01-01 00:00:00.000000" });
    seedJob({ id: "running-now", status: "running", created: T.sep05pm });
    // A FOURTH outstanding job, for no reason except to make the two numbers
    // this function returns unequal. With finished_24h and outstanding both
    // at 3 the headline assertion below could not tell the two FILTERs apart
    // at all: swapping the aliases, or accidentally computing one expression
    // twice, produced 3 and 3 and read as correct.
    seedJob({ id: "queued-recent", status: "queued", created: T.sep05pm });
  });

  it("counts done and failed jobs finished since the threshold, and nothing else", async () => {
    expect(await getAdminJobCounts(session, SINCE)).toEqual({ finished_24h: 3, outstanding: 4 });
  });

  // THE MUTANT THIS BLOCK MOST NEEDED AND DID NOT HAVE: rewriting the second
  // FILTER as `WHERE finished IS NULL` survived every assertion here,
  // because in a fixture like the one above the two questions happen to
  // count the same rows. They are not the same question, and `done-no-finish`
  // is the row that separates them -- a job whose consumer died between
  // doing the work and writing the UPDATE. It is done, so nothing is going
  // to run it and it must not be offered as work in flight; and it has no
  // finish time to compare, so it is not in the 24-hour window either. It is
  // counted by neither number, which is the honest answer and also the one
  // that stops the admin chasing a job that is already over.
  it("counts a done job that was never stamped as neither outstanding nor finished", async () => {
    db.exec("DELETE FROM admin_job");
    seedJob({ id: "done-never-stamped", status: "done", created: T.sep05am, finished: null });

    expect(await getAdminJobCounts(session, SINCE)).toEqual({ finished_24h: 0, outstanding: 0 });
  });

  // outstanding is queued + running, ignoring `since` entirely: a job stuck
  // in the queue since January is exactly the thing this number is for, and
  // a threshold leaking into that FILTER would hide it.
  it("counts every queued or running job however old", async () => {
    expect((await getAdminJobCounts(session, "2026-09-06 00:00:00.000000")).outstanding).toBe(4);
    expect((await getAdminJobCounts(session, "1970-01-01 00:00:00.000000")).outstanding).toBe(4);
  });

  // DIVERGENCE FROM DJANGO, recorded rather than smoothed over. Django's
  // tasks_outstanding counted DBTaskResult rows with status READY only
  // (gfadmin/views.py:80) -- ready, i.e. not yet started. This port counts
  // queued AND running, because the D1 half is all this page can see of the
  // work and a job that started and never finished is the one worth
  // showing. The module's own comment calls it "the D1 half" of that number;
  // this is the assertion that says how it differs.
  it("includes running jobs, which Django's tasks_outstanding did not", async () => {
    db.exec("DELETE FROM admin_job");
    seedJob({ id: "running-only", status: "running", created: T.sep05pm });

    expect((await getAdminJobCounts(session, SINCE)).outstanding).toBe(1);
  });

  // TICKET #9 IN THE OTHER SHAPE, and the one that was measured live:
  // getAdminDashboardStats built this threshold with toISOString() and
  // compared it against Django-format columns, dropping every same-day row
  // (31 of 46 on foodbankchange). Because 'T' sorts above ' ', an ISO
  // threshold is greater than EVERY Django-format value from its own day, so
  // finished_24h collapses to the rows from later days -- here, none.
  // routes/admin/jobs.ts:59 uses pyDatetime for exactly this reason.
  it("silently under-counts if the threshold is built with toISOString", async () => {
    const iso = new Date("2026-09-05T00:00:00.000Z").toISOString();

    expect((await getAdminJobCounts(session, iso)).finished_24h).toBe(0);
    // And the correct spelling of the same instant finds them, so the
    // difference is the format and not the fixture.
    expect((await getAdminJobCounts(session, pyDatetime(new Date("2026-09-05T00:00:00.000Z")))).finished_24h).toBe(3);
  });

  // An aggregate with no GROUP BY always yields exactly one row, so the
  // `?? { finished_24h: 0, outstanding: 0 }` fallback in the module is
  // unreachable in practice -- an empty table answers with zeros, not with
  // no row. Pinned because the two paths are indistinguishable from the
  // caller and only one of them is ever taken.
  it("answers zeros for an empty table rather than no row", async () => {
    db.exec("DELETE FROM admin_job");

    expect(await getAdminJobCounts(session, SINCE)).toEqual({ finished_24h: 0, outstanding: 0 });
  });

  it("returns numbers, not strings, under exactly these two keys", async () => {
    const counts = await getAdminJobCounts(session, SINCE);

    expect(Object.keys(counts).sort()).toEqual(["finished_24h", "outstanding"]);
    expect(typeof counts.finished_24h).toBe("number");
    expect(typeof counts.outstanding).toBe("number");
  });
});

// The two ends joined up, through the real writers and the real readers: the
// route enqueues, the consumer marks it running and then done, and the jobs
// page's own threshold (routes/admin/jobs.ts:59, pyDatetime of now minus 24
// hours) sees it. Each function is pinned on its own above; this is the proof
// that the timestamps one writes are in the format the next one compares --
// which is the single thing no per-function test can establish, and the exact
// seam ticket #9 broke.
describe("enqueue, run, finish -- as the admin sees it", () => {
  it("shows up in the counts and at the top of the list as it moves through", async () => {
    freezeClock("2026-09-05T19:28:08.853Z");
    const since = pyDatetime(new Date(Date.now() - 86_400_000));

    await insertAdminJob(session, { id: "job-1", kind: "check", target: "salisbury" });
    expect(await getAdminJobCounts(session, since)).toEqual({ finished_24h: 0, outstanding: 1 });
    expect(ids(await getRecentAdminJobs(session, 25))).toEqual(["job-1"]);

    await markAdminJobRunning(session, "job-1");
    expect(await getAdminJobCounts(session, since)).toEqual({ finished_24h: 0, outstanding: 1 });

    await markAdminJobDone(session, "job-1", { needs: ["Beans"] });
    expect(await getAdminJobCounts(session, since)).toEqual({ finished_24h: 1, outstanding: 0 });

    // And the check page finds it without being handed the id.
    const latest = await getLatestAdminJob(session, "check", "salisbury");
    expect(latest?.id).toBe("job-1");
    expect(JSON.parse(latest!.result!)).toEqual({ needs: ["Beans"] });
  });

  // The failure path, and the one place the 24h window can be got wrong in
  // the harmless-looking direction: a job that finished 23 hours ago is
  // inside the window, one that finished 25 hours ago is outside, and both
  // comparisons are string comparisons across a date boundary.
  it("counts a failure from 23 hours ago and not one from 25", async () => {
    freezeClock("2026-09-05T19:28:08.853Z");
    const since = pyDatetime(new Date(Date.now() - 86_400_000));

    seedJob({ id: "recent", status: "failed", error: "boom", created: T.sep04, finished: pyDatetime(new Date(Date.now() - 23 * 3_600_000)) });
    seedJob({ id: "stale", status: "failed", error: "boom", created: T.sep03, finished: pyDatetime(new Date(Date.now() - 25 * 3_600_000)) });

    expect((await getAdminJobCounts(session, since)).finished_24h).toBe(1);
  });
});
