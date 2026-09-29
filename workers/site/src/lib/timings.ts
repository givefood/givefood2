import type { Context } from "hono";
import type { AppEnv } from "../types";

// The breakdown half of Server-Timing. middleware/serverTiming.ts reports one
// number, `render`, for the whole request; this module splits it by backend,
// so a slow response says WHICH wait made it slow:
//
//   Server-Timing: db;dur=41.000;desc="2 round trips", kv;dur=3.000;desc="1 round trip", render;dur=45.000
//
// ONLY I/O IS MEASURABLE ON WORKERS, so only I/O is measured. performance.now()
// advances at I/O boundaries and nowhere else (the trap serverTiming.ts's own
// comment describes), so a CPU-bound span -- a Nunjucks render, a big
// JSON.stringify -- always reads 0 and would be a metric that can never say
// anything. What is left is the part worth knowing: how long the request sat
// waiting on D1, KV and R2. On most pages `render` minus these is ~0, and that
// is the timer's resolution, not a gap in the instrumentation.
//
// BUSY TIME, NOT A SUM. Each `dur` is the wall-clock time during which at least
// one call to that backend was in flight. Several pages Promise.all() their D1
// reads, and summing those would report more D1 time than the request took --
// "db > render" reads like a bug in the header. How MANY calls there were is
// what `desc` is for: the round-trip count foodbank.ts's batch() comment had to
// infer by hand from `render` alone.
//
// Nothing here is created unless serverTiming is mounted. A test app that
// mounts a route without it gets every binding back untouched, which is what
// keeps lib/session.test.ts's identity assertions about the raw session true.

interface Metric {
  roundTrips: number;
  busyMs: number;
  inFlight: number;
  since: number;
}

export class Timings {
  // A Map, not an object: iteration order is first use, which is the order
  // the header lists them in, and a metric name can never collide with a
  // prototype property.
  readonly #metrics = new Map<string, Metric>();

  time<T>(name: string, work: () => Promise<T>): Promise<T> {
    let metric = this.#metrics.get(name);
    if (!metric) {
      metric = { roundTrips: 0, busyMs: 0, inFlight: 0, since: 0 };
      this.#metrics.set(name, metric);
    }
    const m = metric;
    m.roundTrips++;
    if (m.inFlight++ === 0) m.since = performance.now();
    const settle = () => {
      if (--m.inFlight === 0) m.busyMs += performance.now() - m.since;
    };
    let pending: Promise<T>;
    try {
      pending = work();
    } catch (err) {
      // A synchronous throw (a binding that is not there, a bad argument) has
      // to close the interval too, or every later call to the same backend
      // this request would see inFlight > 0 and never add its time.
      settle();
      throw err;
    }
    return Promise.resolve(pending).finally(settle);
  }

  // Every metric recorded so far as Server-Timing entries, in first-use order.
  // `now` is the reading serverTiming already took for `render`, so a call
  // still in flight when the response was built is charged up to that same
  // instant -- not dropped, and not allowed to outlast the request it is part
  // of by a second, later clock read.
  entries(now: number): string[] {
    return [...this.#metrics].map(([name, m]) => {
      const dur = m.busyMs + (m.inFlight > 0 ? now - m.since : 0);
      return `${name};dur=${dur.toFixed(3)};desc="${m.roundTrips} round trip${m.roundTrips === 1 ? "" : "s"}"`;
    });
  }
}

// A Proxy that hands every non-function property straight through and every
// method back bound to the REAL object -- workerd's bindings are native
// objects whose methods throw "Illegal invocation" when `this` is anything
// else, the Proxy included. `override` picks the methods that get timed.
function intercept<T extends object>(target: T, override: (prop: PropertyKey, method: Function) => Function | undefined): T {
  return new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      return override(prop, value) ?? value.bind(t);
    },
  });
}

// ---------------------------------------------------------------------------
// D1. Only lib/session.ts calls this: every D1 query the Worker makes goes
// through a session, so wrapping it there covers all of them.
// ---------------------------------------------------------------------------

// Wrapped statement -> the real one, so batch() can hand D1 its own objects
// back. A batch is compiled from each statement's SQL and bound params, read
// off the statement object itself; a Proxy it has never seen is not one of
// its statements, whatever it forwards.
const REAL_STATEMENT = new WeakMap<object, D1PreparedStatement>();

const STATEMENT_ROUND_TRIPS = new Set<PropertyKey>(["first", "all", "run", "raw"]);

function timedStatement(timings: Timings, statement: D1PreparedStatement): D1PreparedStatement {
  const wrapped = intercept(statement, (prop, method) => {
    // bind() returns a NEW statement, and that is the one that runs -- left
    // unwrapped, every parameterised query (nearly all of them) goes untimed.
    if (prop === "bind") return (...values: unknown[]) => timedStatement(timings, method.apply(statement, values));
    if (STATEMENT_ROUND_TRIPS.has(prop)) return (...args: unknown[]) => timings.time("db", () => method.apply(statement, args));
    return undefined;
  });
  REAL_STATEMENT.set(wrapped, statement);
  return wrapped;
}

export function timedD1(c: Context<AppEnv>, session: D1DatabaseSession): D1DatabaseSession {
  const timings = c.get("timings");
  if (!timings) return session;
  return intercept(session, (prop, method) => {
    if (prop === "prepare") return (query: string) => timedStatement(timings, method.call(session, query));
    // ONE round trip however many statements it carries -- sending several
    // in one is the entire reason batch() is used (foodbank.ts,
    // foodbankDetail.ts), so counting it as N would hide the saving.
    if (prop === "batch") {
      return (statements: D1PreparedStatement[]) =>
        timings.time("db", () => method.call(session, statements.map((s) => REAL_STATEMENT.get(s) ?? s)));
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// KV and R2. No session to hang these off, so call sites wrap the binding at
// the point of use: `timedKv(c, c.env.DATA).get(key)`.
// ---------------------------------------------------------------------------

// Each is one request to the service. Anything else on the binding -- R2's
// resumeMultipartUpload() is synchronous and does no I/O -- passes through
// untimed.
const BINDING_ROUND_TRIPS = new Set<PropertyKey>(["get", "getWithMetadata", "head", "put", "delete", "list", "createMultipartUpload"]);

function timedBinding<T extends object>(c: Context<AppEnv>, name: string, binding: T): T {
  const timings = c.get("timings");
  if (!timings) return binding;
  return intercept(binding, (prop, method) =>
    BINDING_ROUND_TRIPS.has(prop) ? (...args: unknown[]) => timings.time(name, () => method.apply(binding, args)) : undefined,
  );
}

export function timedKv(c: Context<AppEnv>, kv: KVNamespace): KVNamespace {
  return timedBinding(c, "kv", kv);
}

export function timedR2(c: Context<AppEnv>, bucket: R2Bucket): R2Bucket {
  return timedBinding(c, "r2", bucket);
}
