import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { findCrawlSetByRunId, insertCrawlSet, type Session } from "@givefood/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateCrawlSet, handleScheduled, HANDLERS } from "./index";

// getOrCreateCrawlSet -- the fan-out crons' shared CrawlSet claim.
//
// WHY THIS FILE EXISTS. On 2026-09-09 this function lost two full days of
// crawling in one day. charityinfo (05:30) and needcheck (15:00) both threw
// "D1_ERROR: D1 DB storage operation exceeded timeout which caused object to
// be reset" out of insertCrawlSet -- a transient fault in D1's storage layer,
// on the primary. Cron Triggers do not retry, so needcheck enqueued zero of
// 1,023 food banks and the site recorded 0 need updates that day, against
// 14-32 on every other day.
//
// The cruel part, and the thing these tests are really about: the INSERT had
// COMMITTED. Only the acknowledgement timed out. So crawlset held a row for a
// run that never happened, and that row then blocked its own recovery -- the
// find-by-run_id at the top reports it as a duplicate delivery and skips. A
// naive "retry the INSERT" reproduces the same outcome by a different route,
// because the retry hits crawlset_runid_uniq and takes the lost-the-race path.
//
// REAL SQLITE, not a canned session, for the same reason needcheck.test.ts
// gives: crawlset_runid_uniq is load-bearing here, and only a real database
// enforces it. The session wrapper below adds fault injection on top.
//
// MUTATION-TESTED. The module was copied to a scratchpad and broken: the
// `landed.start === start` comparison inverted and replaced with `true`;
// `start` moved inside the retry loop so each attempt regenerates it; the
// re-read deleted so UNIQUE alone decides; the UNIQUE branch moved back above
// the re-read; CRAWLSET_INSERT_ATTEMPTS set to 1. Each is killed below.

type Bindable = string | number | null;

/**
 * Real SQLite behind a D1-shaped Session.
 *
 * `failWrite` runs AFTER the statement executes, which is the whole point: a
 * D1 storage timeout can leave the write committed and still throw.
 * `hideRead` makes a re-read miss a row that is really there -- what a replica
 * that has not caught up looks like from the Worker's side.
 */
function d1Session(db: DatabaseSync, failWrite?: () => Error | null, hideRead?: () => boolean): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (hideRead?.() ? null : ((db.prepare(sql).get(...params) as T | undefined) ?? null)),
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const result = db.prepare(sql).run(...params);
      const injected = failWrite?.();
      if (injected) throw injected;
      return { success: true, meta: { last_row_id: Number(result.lastInsertRowid) } };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

/** The exact error D1 threw on 2026-09-09. */
function d1Timeout(): Error {
  return new Error("D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.");
}

const RUN_ID = "needcheck-2026-09-09T15:00";

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function rowsFor(runId: string): unknown[] {
  return db.prepare("SELECT id, start FROM crawlset WHERE run_id = ?").all(runId);
}

describe("getOrCreateCrawlSet -- the ordinary paths", () => {
  it("creates the crawl set and returns its id", async () => {
    const id = await getOrCreateCrawlSet(d1Session(db), "need", RUN_ID, "needcheck");

    expect(id).not.toBeNull();
    expect((await findCrawlSetByRunId(d1Session(db), RUN_ID))!.id).toBe(id);
  });

  // The duplicate-delivery guard the whole at-least-once contract rests on.
  it("skips when the run already exists", async () => {
    await insertCrawlSet(d1Session(db), "need", RUN_ID);

    expect(await getOrCreateCrawlSet(d1Session(db), "need", RUN_ID, "needcheck")).toBeNull();
    expect(rowsFor(RUN_ID)).toHaveLength(1);
  });
});

describe("getOrCreateCrawlSet -- a write that threw after committing", () => {
  // THE 2026-09-09 CASE. Before the fix this returned null and the sweep did
  // nothing; the run was then unrecoverable, because the committed row made
  // every later attempt look like a duplicate delivery.
  it("adopts its own committed row instead of losing the run", async () => {
    let thrown = false;
    const session = d1Session(db, () => {
      if (thrown) return null;
      thrown = true;
      return d1Timeout();
    });

    const id = await getOrCreateCrawlSet(session, "need", RUN_ID, "needcheck");

    expect(id).not.toBeNull();
    // Adopted, not re-inserted: exactly one row, and it is the one we claimed.
    expect(rowsFor(RUN_ID)).toHaveLength(1);
    expect((await findCrawlSetByRunId(d1Session(db), RUN_ID))!.id).toBe(id);
  });

  // Kills `landed.start === start` -> `true`. A row that is NOT ours means a
  // concurrent invocation genuinely won, and adopting it would fan out twice
  // -- 2,046 crawls, duplicate needs, duplicate notifications.
  it("does NOT adopt a row a concurrent invocation wrote", async () => {
    const session = d1Session(db, () => {
      // Someone else claims the run id while our write is in flight; ours then
      // fails for real, so the only row present is theirs.
      db.prepare("DELETE FROM crawlset WHERE run_id = ?").run(RUN_ID);
      db.prepare("INSERT INTO crawlset (crawl_type, run_id, start) VALUES ('need', ?, '2020-01-01 00:00:00.000000')").run(RUN_ID);
      return d1Timeout();
    });

    expect(await getOrCreateCrawlSet(session, "need", RUN_ID, "needcheck")).toBeNull();
    expect(rowsFor(RUN_ID)).toHaveLength(1);
  });

  // Kills moving the UNIQUE branch back above the re-read.
  //
  // The sequence: attempt 1 commits then throws a timeout; the re-read misses
  // it (a replica that has not caught up); the loop therefore retries, and
  // SQLite itself raises UNIQUE on attempt 2 because the row really is there.
  // At that point the row IS ours and the run must continue -- so the re-read
  // has to come FIRST. Check UNIQUE before re-reading and this returns null,
  // which is 2026-09-09 all over again by a different route.
  it("adopts its own row when the retry raises UNIQUE", async () => {
    let writes = 0;
    let reads = 0;
    const session = d1Session(
      db,
      // Only counts statements that EXECUTED: attempt 2 raises UNIQUE inside
      // SQLite, so it never reaches this hook. `reads` is what proves the
      // retry happened.
      () => (++writes === 1 ? d1Timeout() : null),
      // Reads: 1 is the up-front duplicate check (must see nothing, and the
      // table is empty anyway), 2 is the re-read we force to miss.
      () => ++reads === 2,
    );

    vi.useFakeTimers();
    const pending = getOrCreateCrawlSet(session, "need", RUN_ID, "needcheck");
    await vi.advanceTimersByTimeAsync(5_000);
    const id = await pending;

    // 1 up-front duplicate check, 2 the re-read forced to miss, 3 the re-read
    // after the retry hit UNIQUE. A third read only happens if the loop really
    // retried and then re-read instead of trusting the constraint.
    expect(reads).toBe(3);
    expect(writes).toBe(1);
    expect(id).not.toBeNull();
    expect(rowsFor(RUN_ID)).toHaveLength(1);
    expect((await findCrawlSetByRunId(d1Session(db), RUN_ID))!.id).toBe(id);
  });
});

describe("getOrCreateCrawlSet -- a write that genuinely failed", () => {
  // Kills CRAWLSET_INSERT_ATTEMPTS = 1. The transient case the retry exists
  // for: nothing committed, so a second attempt should just work.
  it("retries and succeeds when the first attempt left no row", async () => {
    let calls = 0;
    const session = d1Session(db, () => {
      calls++;
      if (calls > 1) return null;
      db.prepare("DELETE FROM crawlset WHERE run_id = ?").run(RUN_ID); // nothing committed
      return d1Timeout();
    });

    vi.useFakeTimers();
    const pending = getOrCreateCrawlSet(session, "need", RUN_ID, "needcheck");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).not.toBeNull();
    expect(calls).toBe(2);
    expect(rowsFor(RUN_ID)).toHaveLength(1);
  });

  // A permanent fault must THROW, not return null: null means "another
  // invocation has this run", and swallowing a real outage as a no-op is how
  // 2026-09-09 stayed invisible until someone went looking.
  it("throws after exhausting its attempts", async () => {
    let calls = 0;
    const session = d1Session(db, () => {
      calls++;
      db.prepare("DELETE FROM crawlset WHERE run_id = ?").run(RUN_ID);
      return d1Timeout();
    });

    vi.useFakeTimers();
    const pending = getOrCreateCrawlSet(session, "need", RUN_ID, "needcheck");
    const settled = expect(pending).rejects.toThrow("exceeded timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;

    expect(calls).toBe(3);
  });
});

// DISPATCH IS BY EXACT STRING, so the two lists must be the same strings.
// Cloudflare sets `controller.cron` to the trigger text as configured, and a
// cron with no HANDLERS entry only logs. days_between_needs shipped keyed
// "30 3 * * 0" against wrangler's "30 3 * * SUN" and silently never ran on
// Workers -- found 2026-09-15, when every quiet open food bank still held the
// value Django computed on 2026-08-30. A handler with no trigger is dead code
// that looks scheduled, so the check runs both ways.
describe("cron dispatch", () => {
  function declaredCrons(): string[] {
    // `.href`, as workers/site/src/routes/admin/jobs.test.ts does: this
    // package typechecks against workers-types, whose URL is not node:url's.
    const path = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url).href);
    const block = /"crons"\s*:\s*\[([\s\S]*?)\]/.exec(readFileSync(path, "utf8"));
    if (!block) throw new Error(`no "crons" array in ${path}`);
    // Line comments first: they quote the rejected "30 3 * * 0".
    return (block[1]!
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n")
      .match(/"([^"]*)"/g) ?? []).map((quoted) => quoted.slice(1, -1));
  }

  it("has a handler for every cron wrangler.jsonc declares, and no others", () => {
    const declared = declaredCrons();
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual(Object.keys(HANDLERS).sort());
  });

  // The key comparison above cannot tell WHICH handler sits under a key, so
  // pin the one that was lost.
  it("runs days_between_needs under the Sunday string Cloudflare sends", async () => {
    expect(HANDLERS["30 3 * * SUN"]?.name).toBe("daysBetweenNeeds");
    const waitUntil = vi.fn();
    const env = { DB: { withSession: () => ({ prepare: () => ({ run: async () => ({ success: true, meta: {} }) }) }) } };
    await handleScheduled({ cron: "30 3 * * SUN", scheduledTime: 0 } as ScheduledController, env as never, { waitUntil } as unknown as ExecutionContext);
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0]![0];
    expect(console.error).not.toHaveBeenCalled();
  });
});
