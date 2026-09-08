import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { api3App } from "../routes/api3";
import type { AppEnv } from "../types";
import { dbSession } from "./session";

// lib/session.ts is one expression, and it is the single point at which every
// D1 read and write the PUBLIC Worker performs decides which copy of the
// database it is allowed to talk to. 168 call sites across 87 files under
// workers/site/src call `dbSession(c)` (counted by grep for this file); the
// only other `withSession` in the Worker is middleware/slugRedirect.ts's own,
// and workers/jobs never comes through here at all.
//
// NO DJANGO ANCESTOR TO PORT. /Users/jasoncartwright/Sites/foodcharity's
// givefood/settings.py:139-149 declares one `default` Postgres connection and
// the file contains no DATABASE_ROUTERS (read for this test file), so the
// original had no replica to be stale against and nothing here corresponds to
// a Python function. The contract comes from PLAN.md §3.3's binding map
// instead, which records that the provisioned `givefood` D1 database has read
// replication enabled and that "bare `prepare()` calls will work in every
// local/dev test and intermittently return stale data in production".
//
// WHY A ONE-EXPRESSION FUNCTION GETS A TEST FILE. Every way of getting this
// wrong produces a Worker that passes its whole suite, serves 200s, and
// returns data that is quietly out of date -- no error, no log line, no
// failing page. Two of those ways are not even compile errors, which is why
// the assertions below are about the exact argument rather than about types:
//
//   - `withSession(constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint)`
//     with `type D1SessionBookmark = string`, read out of the installed
//     @cloudflare/workers-types 5.20260905.1 index.d.ts (the copy in this
//     repo's node_modules, lines 14330-14357). Because a bookmark is just
//     `string`, `withSession("first-unconstrianed")` typechecks perfectly and
//     is not the constraint anyone meant. What D1 does at runtime with a
//     bookmark it never issued is NOT verified here -- the point is only that
//     the compiler will not catch the typo, so a test has to.
//   - the parameter is OPTIONAL, so a mutant that drops the argument
//     entirely typechecks too.
//
// That same header documents what the two constants mean: "first-primary"
// sends the first query to the primary, "first-unconstrained" lets the first
// query go anywhere, and both give sequential consistency for the rest of the
// session. So the choice this module makes is precisely "the first read of
// every request may be served by a lagging replica" -- deliberate for the
// anonymous read-only traffic its own comment describes, and inherited by the
// admin's read-after-write flows whether they want it or not. See the
// bookmark test, which pins that absence rather than wishing it away.
//
// REAL EVERYTHING that can be real: real Hono contexts from a real
// `app.fetch()`, the real `api3App` sub-app mounted the way index.ts:240
// mounts it, real @givefood/db queries, and a real SQLite engine seeded from
// the real migrations via schemaFor(). The D1 BINDING is a double because
// there is no local D1 -- and it is a recording double, because what this
// module does IS what it asks the binding for.
//
// MUTATION-TESTED in a copy of the repo outside it (TESTING.md's
// no-scratch-files rule), by editing session.ts in the copy and re-running
// this file against it. 13 mutants applied, 13 dead: "first-unconstrained" ->
// "first-primary", -> "First-Unconstrained", -> "first-unconstrained " (a
// trailing space); the argument dropped; the return wrapped in
// `{ prepare: s.prepare.bind(s) }`; the return spread into `{ ...s }`; the
// call destructured to an unbound `withSession`; the session memoised on the
// context so a second call returns the first; the binding cached in a
// module-level variable across requests; `?? c.env.DB` appended as a
// fallback; the function made `async`; the binding chosen as
// `env.DB_REPLICA ?? env.DB`; and withSession called twice with the second
// session returned.
//
// Two of those are the whole reason for tests that would otherwise look like
// padding, and are named here as the evidence they are load-bearing: the
// `env.DB_REPLICA ?? env.DB` mutant is killed ONLY by the decoy-binding test,
// and the unbound-`withSession` mutant ONLY by the one that records `this`.

const ORIGIN = "https://www.givefood.org.uk";
const PAGE = `${ORIGIN}/api/2/foodbanks/`;

// Hono's fetch() wants an ExecutionContext; nothing under test touches it.
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// A recording D1Database double.
//
// Every question this file asks is a question about the CALL: which method,
// with which arguments, on which object, how many times, and what came back.
// The double records all five rather than deciding any of them itself.
// ---------------------------------------------------------------------------

interface SessionRecord {
  tag: string;
  /** `this` at the moment each method ran -- see the unbound-method test. */
  batchSelf: unknown[];
  bookmarkSelf: unknown[];
}

interface DbDouble {
  DB: D1Database;
  /** One entry per withSession() call, in order, with its arguments and `this`. */
  calls: { args: unknown[]; self: unknown }[];
  /** The session handed back by each call, in the same order. */
  returned: D1DatabaseSession[];
  /** The recorder behind each of those sessions, same order. */
  records: SessionRecord[];
}

function sessionDouble(tag: string): { session: D1DatabaseSession; record: SessionRecord } {
  const record: SessionRecord = { tag, batchSelf: [], bookmarkSelf: [] };
  const session = {
    tag,
    prepare: (sql: string) => ({ sql, bind: () => ({ first: async () => null }) }),
    // Present because packages/db calls session.batch() in nine modules
    // (charity, adminSubscribers, constituencies, adminSearch, foodbankAdmin,
    // orderWrite, foodbank, foodbankDetail, adminStats). A dbSession that
    // handed back anything other than the session itself would take all of
    // them out at once, at runtime only.
    batch(this: unknown) {
      record.batchSelf.push(this);
      return Promise.resolve([]);
    },
    getBookmark(this: unknown) {
      record.bookmarkSelf.push(this);
      return `bookmark-for-${tag}`;
    },
  };
  return { session: session as unknown as D1DatabaseSession, record };
}

function dbDouble(): DbDouble {
  const calls: DbDouble["calls"] = [];
  const returned: D1DatabaseSession[] = [];
  const records: SessionRecord[] = [];
  const DB = {
    withSession(this: unknown, ...args: unknown[]) {
      calls.push({ args, self: this });
      const { session, record } = sessionDouble(`session-${returned.length + 1}`);
      returned.push(session);
      records.push(record);
      return session;
    },
  };
  return { DB: DB as unknown as D1Database, calls, returned, records };
}

function envWith(DB: unknown, extra: Record<string, unknown> = {}): AppEnv["Bindings"] {
  return { DB, SITE_DOMAIN: ORIGIN, ...extra } as unknown as AppEnv["Bindings"];
}

interface RunResult<T> {
  value: T | undefined;
  error: unknown;
  status: number;
}

// ONE Hono app that can serve many requests, each running a different body --
// which is what a warm isolate is, and what the binding-caching test needs.
// Registering a second `app.all("*")` per request would not work: Hono chains
// handlers matched on the same path, and the first one to return a Response
// short-circuits the rest, so request two would silently re-run request one's
// body.
//
// Everything goes through a real `app.fetch()` rather than a hand-built
// `{ env: {...} }` object: the module's only input is a Context and `c.env` is
// Hono's own per-request property, so a stub context would let a change in how
// the module reaches the binding pass unnoticed -- exactly the class of thing
// this file exists to catch. The handler's return value is carried out in a
// closure because a D1 session cannot be serialised into a response body.
function warmApp() {
  let current: ((c: Context<AppEnv>) => unknown) | null = null;
  let value: unknown;
  let error: unknown;
  const app = new Hono<AppEnv>();
  app.all("*", (c) => {
    try {
      value = current!(c);
    } catch (e) {
      error = e;
      throw e; // Hono turns this into the 500 a real request would get.
    }
    return c.text("ok");
  });
  return {
    async run<T>(env: AppEnv["Bindings"], body: (c: Context<AppEnv>) => T, request: Request = new Request(PAGE)): Promise<RunResult<T>> {
      current = body as (c: Context<AppEnv>) => unknown;
      value = undefined;
      error = undefined;
      const res = await app.fetch(request, env, execCtx);
      return { value: value as T | undefined, error, status: res.status };
    },
  };
}

async function inRequest<T>(env: AppEnv["Bindings"], body: (c: Context<AppEnv>) => T, request?: Request): Promise<RunResult<T>> {
  return warmApp().run(env, body, request);
}

describe("the constraint dbSession anchors the session at", () => {
  // THE WHOLE MODULE, in one assertion. "first-primary" is the other legal
  // constant and it is one word away: it would send the first query of every
  // request to the primary -- correct-looking, slower everywhere, and
  // invisible in every local test because a dev D1 has no replicas. Asserted
  // by VALUE rather than matched loosely, because a bookmark is typed as plain
  // `string` (see the header): nothing but an exact comparison can tell the
  // constraint from a typo.
  it("asks for first-unconstrained, spelled exactly", async () => {
    const db = dbDouble();

    await inRequest(envWith(db.DB), (c) => dbSession(c));

    expect(db.calls.map((call) => call.args)).toEqual([["first-unconstrained"]]);
  });

  // The argument LIST, not just the first argument. withSession's parameter is
  // optional (workers-types 5.20260905.1, index.d.ts:14351-14353), so a mutant
  // that drops it compiles and runs -- and an unanchored session is not the
  // documented "first query can go anywhere" behaviour this module claims for
  // itself, it is whatever the platform defaults to.
  it("passes exactly one argument, so the constraint cannot be silently dropped", async () => {
    const db = dbDouble();

    await inRequest(envWith(db.DB), (c) => dbSession(c));

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.args).toHaveLength(1);
  });

  // PINS AN ABSENCE, and it is the most consequential thing in this file.
  // PLAN.md §3.3 requires the Sessions API "propagating the returned bookmark
  // across a request (and, for the admin's read-after-write flows, across
  // requests -- e.g. in the session/response)". Nothing in the port does the
  // second half: `getBookmark` appears in no source file outside a comment in
  // packages/db/src/types.ts (grepped across workers/ and packages/ for this
  // file). So every request starts afresh at "first-unconstrained", including
  // the GET that follows an admin POST-and-redirect.
  //
  // This test does not ask for that to change. It pins that a request ARRIVING
  // with a bookmark in each place one could plausibly be carried is still
  // anchored at the constant, so that a future change which starts reading one
  // off the request has to fail here and say so out loud, rather than landing
  // as a silent consistency change.
  it("never anchors at a bookmark, whatever the request carries", async () => {
    const db = dbDouble();
    const request = new Request(`${PAGE}?bookmark=00000003-0000006e-00004ef8-9f14ecfe4a1c2ba1e5c67a0d6a03d8ff`, {
      headers: {
        Cookie: "d1-bookmark=00000001-0000006e-00004ef8-9f14ecfe4a1c2ba1e5c67a0d6a03d8ff",
        "X-D1-Bookmark": "00000002-0000006e-00004ef8-9f14ecfe4a1c2ba1e5c67a0d6a03d8ff",
      },
    });

    await inRequest(envWith(db.DB), (c) => dbSession(c), request);

    expect(db.calls.map((call) => call.args)).toEqual([["first-unconstrained"]]);
  });
});

describe("what it hands back", () => {
  // Identity, not shape. `{ ...session }` and `{ prepare: s.prepare }` both
  // look like a session and both survive any test written as "it has a prepare
  // method" -- and both would break the nine packages/db modules that call
  // session.batch(), plus any future bookmark propagation, at runtime only.
  // D1DatabaseSession is a native class, so a spread of one is not one.
  it("returns the session object the binding gave it, not a copy of it", async () => {
    const db = dbDouble();

    const { value } = await inRequest(envWith(db.DB), (c) => dbSession(c));

    expect(value).toBe(db.returned[0]);
  });

  // The two methods a wrapper would lose, exercised THROUGH the returned value
  // with the `this` each one saw recorded -- a wrapper forwarding `prepare`
  // alone sails past an existence check on `batch`.
  it("keeps batch() and getBookmark() callable on the session, with the session as `this`", async () => {
    const db = dbDouble();

    const { value } = await inRequest(envWith(db.DB), (c) => dbSession(c));
    const session = value!;
    const batched = await session.batch([]);
    const bookmark = session.getBookmark();

    expect(batched).toEqual([]);
    expect(bookmark).toBe("bookmark-for-session-1");
    expect(db.records[0]!.batchSelf[0]).toBe(session);
    expect(db.records[0]!.bookmarkSelf[0]).toBe(session);
  });

  // Every call site spells it `const session = dbSession(c)` and passes the
  // result straight into a query with no await. If this ever became async --
  // an `async function`, or a `.then()` bolted on -- packages/db would call
  // .prepare() on a Promise and all 168 call sites would 500 at once. Cheap to
  // assert, catastrophic to miss.
  it("returns the session synchronously, not a promise of one", async () => {
    const db = dbDouble();

    const { value } = await inRequest(envWith(db.DB), (c) => dbSession(c));

    expect(value).not.toBeInstanceOf(Promise);
    expect((value as unknown as { then?: unknown }).then).toBeUndefined();
  });

  // There is no fallback, and there must not be one. A `?? c.env.DB` appended
  // to the expression would be unreachable against a real binding and would,
  // on the day it was reached, hand packages/db the raw D1Database -- which
  // has prepare() and batch() and would work, unsessioned and replica-blind,
  // which is precisely the failure PLAN.md §3.3 names. Pinned by having
  // withSession return nothing at all.
  it("passes back whatever withSession returned, substituting no other binding", async () => {
    const DB = { withSession: () => undefined };

    const { value } = await inRequest(envWith(DB), (c) => dbSession(c));

    expect(value).toBeUndefined();
  });
});

describe("how it reaches the binding", () => {
  // `c.env.DB.withSession(...)` is a METHOD call, and D1Database is a native
  // class: pulled off the binding and called loose, the real thing throws
  // rather than working. A mutant that destructures
  // (`const { withSession } = c.env.DB`) therefore breaks production while
  // still passing any test that only checks the argument, because a plain
  // object double does not care about its receiver. Recording `this` is what
  // makes that difference visible here.
  it("calls withSession as a method on the DB binding itself", async () => {
    const db = dbDouble();
    const env = envWith(db.DB);

    await inRequest(env, (c) => dbSession(c));

    expect(db.calls[0]!.self).toBe(env.DB);
  });

  // PLAN.md §3.3: "use the Sessions API, not bare `prepare()`". Asserted at
  // the one place in the public Worker where the raw binding is in scope, by
  // recording EVERY property read on it -- so if this module ever grew a
  // `c.env.DB.prepare(...)` shortcut, or a `.batch()` for "just one quick
  // query", it shows up here as a second key.
  it("touches nothing on the binding except withSession", async () => {
    const reads: string[] = [];
    const { session } = sessionDouble("proxied");
    const DB = new Proxy({ withSession: () => session } as Record<string, unknown>, {
      get(target, key) {
        if (typeof key === "string") reads.push(key);
        return Reflect.get(target, key);
      },
    });

    await inRequest(envWith(DB), (c) => dbSession(c));

    expect(reads).toEqual(["withSession"]);
  });

  // The binding must come out of THIS request's env every time. A module-level
  // `let db` memo would be the classic Workers isolate bug: bindings are
  // per-request, one isolate serves many requests, and a cached one lets
  // request A's database answer request B. Both requests go through one app
  // instance on purpose -- that is what a warm isolate is.
  it("reads the DB binding out of each request's own env", async () => {
    const first = dbDouble();
    const second = dbDouble();
    const isolate = warmApp();

    const a = await isolate.run(envWith(first.DB), (c) => dbSession(c));
    const b = await isolate.run(envWith(second.DB), (c) => dbSession(c));

    expect(a.value).toBe(first.returned[0]);
    expect(b.value).toBe(second.returned[0]);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });

  // A decoy binding that would happily answer withSession() too, for the same
  // reason every query test in this repo seeds a row that must not come back:
  // a module reaching for the wrong member of `env` is indistinguishable from
  // one reaching for the right member, unless a wrong one exists.
  it("opens the session on DB and on no other binding", async () => {
    const real = dbDouble();
    const decoy = dbDouble();

    await inRequest(envWith(real.DB, { DB_REPLICA: decoy.DB, SESSIONS: decoy.DB }), (c) => dbSession(c));

    expect(real.calls).toHaveLength(1);
    expect(decoy.calls).toEqual([]);
  });
});

describe("one session per call", () => {
  // CURRENT BEHAVIOUR, PINNED, not endorsed: there is no memo on the context,
  // so a handler calling dbSession(c) twice gets two independent sessions with
  // two independent bookmark chains, the second anchored at
  // "first-unconstrained" all over again -- its first read can be served by a
  // replica that has not seen the first session's write. Every handler in the
  // Worker today takes one session per request (routes/write/index.ts and the
  // admin routes each call it once per handler), so this is latent rather than
  // live; memoising it would be a behaviour change rather than a refactor,
  // which is exactly why it is written down.
  it("opens a brand new session on every call, sharing nothing between them", async () => {
    const db = dbDouble();

    const { value } = await inRequest(envWith(db.DB), (c) => [dbSession(c), dbSession(c)] as const);

    expect(db.calls.map((call) => call.args)).toEqual([["first-unconstrained"], ["first-unconstrained"]]);
    expect(value![0]).not.toBe(value![1]);
    expect(value![0]).toBe(db.returned[0]);
    expect(value![1]).toBe(db.returned[1]);
  });
});

describe("when the binding is not what it should be", () => {
  // A deploy that lost its d1_databases entry, or a `wrangler dev` run without
  // one. The useful property is that it fails LOUDLY and at the first call:
  // Hono turns the throw into a 500, which shows up in logs and in the error
  // rate. The alternative -- a guard returning undefined -- would push the
  // failure down into packages/db as "cannot read properties of undefined
  // (reading 'prepare')", one stack frame further from the cause. The exact
  // message is V8's business and is deliberately not asserted.
  it("throws a TypeError and 500s the request when DB is missing entirely", async () => {
    const { error, status } = await inRequest(envWith(undefined), (c) => dbSession(c));

    expect(error).toBeInstanceOf(TypeError);
    expect(status).toBe(500);
  });

  // The same for a binding that answers prepare() but has no withSession --
  // the shape a stub, a hand-rolled local double, or a binding of the wrong
  // vintage would have. Whether D1's own deprecated alpha v1 databases (named
  // as such on `dump()` in workers-types) are such a shape is NOT verified
  // here; the point is that the failure is immediate and loud either way.
  it("throws a TypeError when the binding has no withSession", async () => {
    const { error, status } = await inRequest(envWith({ prepare: () => {} }), (c) => dbSession(c));

    expect(error).toBeInstanceOf(TypeError);
    expect(status).toBe(500);
  });

  // No try/catch and no fallback: a failure from D1 itself reaches the caller
  // unchanged, so index.ts's onError sees the real error rather than a
  // substituted one.
  it("lets an error from withSession propagate unchanged", async () => {
    const boom = new Error("Invalid bookmark");
    const DB = {
      withSession: () => {
        throw boom;
      },
    };

    const { error, status } = await inRequest(envWith(DB), (c) => dbSession(c));

    expect(error).toBe(boom);
    expect(status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Through the real /api/3 sub-app, against a real SQLite engine.
//
// Everything above proves what dbSession asks the binding for. This proves the
// shipped path goes through it, and that queries genuinely run on the object
// it returned -- a handler holding one session while its queries ran on
// another would still render a correct-looking page, and nothing above would
// notice. `/api/3/slugfromid/<uuid>/` is the smallest real route that reaches
// D1: one statement (packages/db/src/foodbank.ts:345-351) and a text body that
// IS the value read out of the row.
// ---------------------------------------------------------------------------

const SALISBURY_UUID_DASHLESS = "8c1e9a3f4b7d4e2fa1c05d6b8e9f0a12";
const SALISBURY_UUID_DASHED = "8c1e9a3f-4b7d-4e2f-a1c0-5d6b8e9f0a12";
const EXETER_UUID_DASHLESS = "2f5b7c1d3e6a4f8b9c0d1e2f3a4b5c6d";

type Bindable = null | number | bigint | string | Uint8Array;

describe("through the real api3 sub-app", () => {
  let db: DatabaseSync;
  let app: Hono<AppEnv>;
  let env: AppEnv["Bindings"];
  let modes: unknown[];
  // Which session object ran each statement, so "the query ran on the session
  // dbSession returned" is assertable rather than assumed.
  let ran: { sql: string; params: Bindable[]; on: object }[];
  let opened: object[];

  // A D1 session over node:sqlite, the same shape as routes/api3.test.ts's,
  // plus the recording this file needs. Real SQL, real parameter binding, real
  // rows -- only the transport is a double.
  function d1Session(): D1DatabaseSession {
    const session: Record<string, unknown> = {};
    const statement = (sql: string, params: Bindable[]): Record<string, unknown> => ({
      bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
      first: async () => {
        ran.push({ sql, params, on: session });
        return db.prepare(sql).get(...params) ?? null;
      },
      all: async () => {
        ran.push({ sql, params, on: session });
        return { results: db.prepare(sql).all(...params), success: true, meta: {} };
      },
    });
    session.prepare = (sql: string) => statement(sql, []);
    session.getBookmark = () => null;
    return session as unknown as D1DatabaseSession;
  }

  function seedFoodbank(id: number, slug: string, uuid: string): void {
    db.prepare(
      `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng,
         charity_just_foodbank, contact_email, url, shopping_list_url,
         address_is_administrative, is_closed, no_locations, days_between_needs, created, modified)
       VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79',
         0, ?, ?, ?, 0, 0, 0, 14,
         '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
    ).run(id, uuid, slug.charAt(0).toUpperCase() + slug.slice(1), slug, `info@${slug}.invalid`, `https://${slug}.invalid/`, `https://${slug}.invalid/list/`);
  }

  beforeEach(() => {
    modes = [];
    ran = [];
    opened = [];

    // schemaFor(), not hand-written DDL: this is the `foodbank` table as the
    // real migrations leave it, so a NOT NULL column added tomorrow fails this
    // fixture rather than letting it drift away from production.
    db = new DatabaseSync(":memory:");
    db.exec(schemaFor("foodbank"));
    seedFoodbank(1, "salisbury", SALISBURY_UUID_DASHLESS);
    // The row that must NOT come back. Without a second row, a query with its
    // WHERE clause deleted -- or a dbSession handing back a session pointed
    // somewhere else entirely -- still answers "salisbury" to everything.
    seedFoodbank(2, "exeter", EXETER_UUID_DASHLESS);

    const DB = {
      withSession(mode?: string) {
        modes.push(mode);
        const session = d1Session();
        opened.push(session as unknown as object);
        return session;
      },
    };

    // index.ts:240 verbatim -- the real sub-app at the real mount point, so
    // the path, the method and the handler are the shipped ones rather than a
    // route this file invented.
    app = new Hono<AppEnv>();
    app.route("/api/3", api3App);
    env = envWith(DB);
  });

  const get = (path: string) => app.fetch(new Request(`${ORIGIN}${path}`), env, execCtx);

  // The end-to-end claim, by value: the body is a slug that exists only in
  // SQLite, it was read by a statement that ran on the session dbSession
  // opened, and that session was anchored at the constraint this module names.
  it("serves a row read through the session it opened, in first-unconstrained mode", async () => {
    const res = await get(`/api/3/slugfromid/${SALISBURY_UUID_DASHED}/`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("salisbury");
    expect(modes).toEqual(["first-unconstrained"]);
    expect(opened).toHaveLength(1);
    // The statement ran on the object the handler got from dbSession, not on
    // some other session opened alongside it.
    expect(ran).toHaveLength(1);
    expect(ran[0]!.on).toBe(opened[0]);
    // And it carried the parameter down, dashless as the column stores it
    // (packages/db/src/uuid.ts normalizeUuid) -- proof the answer is a lookup
    // and not simply the first row in the table.
    expect(ran[0]!.params).toEqual([SALISBURY_UUID_DASHLESS]);
  });

  // The other polarity, from the same fixture: two real rows exist and neither
  // matches, so this 404 is a real miss rather than an empty database. A
  // session is still opened for it, because api3.ts calls dbSession before it
  // can know whether the row exists.
  it("404s on a uuid in neither row, having opened exactly one session", async () => {
    const res = await get("/api/3/slugfromid/11111111-2222-3333-4444-555555555555/");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(modes).toEqual(["first-unconstrained"]);
    expect(ran.map((r) => r.params)).toEqual([["11111111222233334444555555555555"]]);
  });

  // A second request through the same app and the same env gets its own
  // session, anchored again -- the isolate-level pin from above, this time on
  // the real route rather than a test handler. It also picks the decoy row up
  // by its own uuid, which is what makes the exclusion above meaningful: both
  // rows are readable, and the WHERE clause is what chooses between them.
  it("opens a fresh session per request rather than reusing one across them", async () => {
    const first = await get(`/api/3/slugfromid/${SALISBURY_UUID_DASHED}/`);
    const second = await get(`/api/3/slugfromid/${EXETER_UUID_DASHLESS}/`);

    expect(await first.text()).toBe("salisbury");
    expect(await second.text()).toBe("exeter");
    expect(modes).toEqual(["first-unconstrained", "first-unconstrained"]);
    expect(opened).toHaveLength(2);
    expect(opened[0]).not.toBe(opened[1]);
    expect(ran.map((r) => r.on)).toEqual([opened[0], opened[1]]);
  });

  // A route that never reaches D1 must never open a session: the index is a
  // static string (api3.ts:16). Pinned because "dbSession is free" is only
  // true while it stays a local object -- if opening a session ever starts
  // costing something, this is the test that says which requests pay for it.
  //
  // The UNSLASHED path, because a sub-app's own `.get("/")` matches the bare
  // mount prefix and not the prefix with a trailing slash -- the Hono quirk
  // index.ts:230-235 documents, which is why index.ts:239 registers
  // `/api/3/` on the app itself. That second copy is index.ts's, not this
  // sub-app's, and is asserted in routes/api3.test.ts.
  it("opens no session at all for the api3 index, which touches no data", async () => {
    const res = await get("/api/3");

    expect(await res.text()).toBe("Give Food API 3");
    expect(modes).toEqual([]);
    expect(ran).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The TYPE is part of the contract: routes/admin/orderActions.ts:82 declares a
// parameter as `ReturnType<typeof dbSession>`, and every packages/db function
// takes `Session = D1DatabaseSession`. If this module's return type ever
// widened to `any` -- one `as any` inside it would do it -- all 168 call sites
// would keep compiling while quietly losing every argument check they have.
//
// The runtime assertion below is trivial by design; the TEST is the
// declaration, which only `pnpm typecheck` can fail. It is written as a value
// so that it cannot be quietly dropped as dead code.
// ---------------------------------------------------------------------------

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type NotAny<T> = 0 extends 1 & T ? false : true;

const SESSION_TYPE_CONTRACT: [Exactly<ReturnType<typeof dbSession>, D1DatabaseSession>, NotAny<ReturnType<typeof dbSession>>] = [true, true];

it("returns exactly a D1DatabaseSession, and not `any`", () => {
  expect(SESSION_TYPE_CONTRACT).toEqual([true, true]);
});
