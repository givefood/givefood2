import { Hono } from "hono";
import type { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { serverTiming } from "../middleware/serverTiming";
import { timedD1, timedKv, timedR2, Timings } from "./timings";

// lib/timings.ts is the per-backend half of Server-Timing: `db`, `kv` and `r2`
// ahead of serverTiming's `render`. Two things can go wrong with it, and they
// fail very differently:
//
//   1. The numbers lie. A sum instead of busy time, a batch counted as N, an
//      interval left open by a throw -- each gives a header that parses fine
//      and misleads whoever reads it. The Timings tests pin the arithmetic
//      from a stubbed clock.
//
//   2. The wrappers break the thing they wrap. Every D1 query on the site now
//      goes through a Proxy, so a statement batch() cannot recognise, or a
//      method called with the Proxy as `this` (workerd's bindings are native
//      and throw "Illegal invocation"), takes the whole site down at runtime
//      only. The wrapper tests record `this` and the objects each call
//      received, the same way lib/session.test.ts does for the raw session.

const env = {} as unknown as AppEnv["Bindings"];

function stubClock(readings: [number, ...number[]]) {
  let i = 0;
  return vi.spyOn(performance, "now").mockImplementation(() => readings[Math.min(i++, readings.length - 1)] ?? readings[0]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// A promise the test settles by hand, so overlapping calls can be made to
// finish in a chosen order.
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A real request through serverTiming, running `body` inside the handler and
// awaiting it before responding -- which is what every route does with its D1
// reads, and what puts their time into the header.
async function inTimedRequest<T>(body: (c: Context<AppEnv>) => T | Promise<T>, mountServerTiming = true) {
  let value: T | undefined;
  const app = new Hono<AppEnv>();
  if (mountServerTiming) app.use("*", serverTiming);
  app.get("/", async (c) => {
    value = await body(c);
    return c.text("ok");
  });
  const res = await app.request("https://x/", {}, env);
  return { value, header: res.headers.get("Server-Timing") ?? "" };
}

describe("Timings", () => {
  it("charges a call's wall-clock time to its metric as one round trip", async () => {
    stubClock([1000, 1012.5]);
    const timings = new Timings();
    await timings.time("db", async () => "row");
    expect(timings.entries(2000)).toEqual(['db;dur=12.500;desc="1 round trip"']);
  });

  it("hands back what the work resolved to, untouched", async () => {
    const row = { id: 1 };
    expect(await new Timings().time("db", async () => row)).toBe(row);
  });

  it("adds sequential calls together", async () => {
    stubClock([1000, 1010, 1020, 1025]);
    const timings = new Timings();
    await timings.time("db", async () => null);
    await timings.time("db", async () => null);
    expect(timings.entries(2000)).toEqual(['db;dur=15.000;desc="2 round trips"']);
  });

  it("reports busy time rather than a sum when calls overlap", async () => {
    // Promise.all() over two D1 reads: A runs 1000-1020, B 1000-1030. Summed
    // that is 50ms of D1 inside a 30ms wait. The clock is read only when the
    // backend goes from idle to busy and back, so exactly two readings.
    const clock = stubClock([1000, 1030]);
    const timings = new Timings();
    const a = deferred();
    const b = deferred();
    const both = Promise.all([timings.time("db", () => a.promise), timings.time("db", () => b.promise)]);
    a.resolve(null);
    await a.promise;
    b.resolve(null);
    await both;
    expect(timings.entries(2000)).toEqual(['db;dur=30.000;desc="2 round trips"']);
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("charges a call still in flight up to the instant the header is written", async () => {
    stubClock([1000]);
    const timings = new Timings();
    void timings.time("db", () => new Promise(() => {}));
    expect(timings.entries(1040)).toEqual(['db;dur=40.000;desc="1 round trip"']);
  });

  it("closes the interval, and rethrows, when the work throws synchronously", async () => {
    // Left open, inFlight never returns to 0 and the next call's time is
    // never added -- the second call below would then report 0 + (now - 1000).
    stubClock([1000, 1000, 1100, 1105]);
    const timings = new Timings();
    const boom = new TypeError("Cannot read properties of undefined (reading 'prepare')");
    expect(() =>
      timings.time("db", () => {
        throw boom;
      }),
    ).toThrow(boom);
    await timings.time("db", async () => null);
    expect(timings.entries(2000)).toEqual(['db;dur=5.000;desc="2 round trips"']);
  });

  it("closes the interval, and passes the same rejection on, when the work rejects", async () => {
    stubClock([1000, 1007]);
    const timings = new Timings();
    const err = new Error("D1_ERROR: no such table");
    await expect(timings.time("db", async () => Promise.reject(err))).rejects.toBe(err);
    expect(timings.entries(2000)).toEqual(['db;dur=7.000;desc="1 round trip"']);
  });

  it("lists metrics in the order they were first used, each on its own clock", async () => {
    stubClock([1000, 1003, 1003, 1023]);
    const timings = new Timings();
    await timings.time("kv", async () => null);
    await timings.time("db", async () => null);
    expect(timings.entries(2000)).toEqual(['kv;dur=3.000;desc="1 round trip"', 'db;dur=20.000;desc="1 round trip"']);
  });

  it("emits nothing for a request that touched no backend", () => {
    expect(new Timings().entries(2000)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

interface FakeStatement {
  sql: string;
  params: unknown[];
}

// A recording D1DatabaseSession double. Every statement it mints is kept, so
// a test can check batch() was handed THOSE objects and not wrappers of them,
// and every method records the `this` it ran with.
function sessionDouble() {
  const minted: FakeStatement[] = [];
  const seen: { method: string; self: unknown; args: unknown[] }[] = [];
  function statement(sql: string, params: unknown[]): FakeStatement {
    const s: FakeStatement & Record<string, unknown> = {
      sql,
      params,
      bind(this: unknown, ...values: unknown[]) {
        seen.push({ method: "bind", self: this, args: values });
        return statement(sql, values);
      },
    };
    for (const method of ["first", "all", "run", "raw"]) {
      s[method] = async function (this: unknown, ...args: unknown[]) {
        seen.push({ method, self: this, args });
        return { method, sql: s.sql, params: s.params, args };
      };
    }
    minted.push(s);
    return s;
  }
  const session = {
    prepare(this: unknown, sql: string) {
      seen.push({ method: "prepare", self: this, args: [sql] });
      return statement(sql, []);
    },
    async batch(this: unknown, statements: unknown[]) {
      seen.push({ method: "batch", self: this, args: [statements] });
      return statements.map(() => ({ results: [] }));
    },
    getBookmark(this: unknown) {
      seen.push({ method: "getBookmark", self: this, args: [] });
      return "bookmark";
    },
  };
  return { session, raw: session as unknown as D1DatabaseSession, minted, seen };
}

describe("timedD1", () => {
  it("times each of first, all, run and raw as a db round trip", async () => {
    const d = sessionDouble();
    const { header } = await inTimedRequest(async (c) => {
      const s = timedD1(c, d.raw);
      await s.prepare("SELECT 1 WHERE id = ?").bind(7).first("id");
      await s.prepare("SELECT 2").all();
      await s.prepare("UPDATE t SET x = 1").run();
      await s.prepare("SELECT 3").raw();
    });
    expect(header).toMatch(/^db;dur=\d+\.\d{3};desc="4 round trips", render;dur=\d+\.\d{3}$/);
  });

  it("passes every argument and result straight through", async () => {
    const d = sessionDouble();
    const { value } = await inTimedRequest((c) => timedD1(c, d.raw).prepare("SELECT name FROM t WHERE id = ?").bind(7).first("name"));
    expect(value).toEqual({ method: "first", sql: "SELECT name FROM t WHERE id = ?", params: [7], args: ["name"] });
  });

  it("runs every method with the real session or statement as `this`, never the Proxy", async () => {
    const d = sessionDouble();
    await inTimedRequest(async (c) => {
      const s = timedD1(c, d.raw);
      await s.prepare("SELECT ?").bind(1).all();
      await s.batch([s.prepare("SELECT 2")]);
      s.getBookmark();
    });
    const [prepared, bound] = d.minted;
    expect(d.seen.map((call) => [call.method, call.self])).toEqual([
      ["prepare", d.session],
      ["bind", prepared],
      ["all", bound],
      ["prepare", d.session],
      ["batch", d.session],
      ["getBookmark", d.session],
    ]);
  });

  it("counts a batch as ONE round trip and hands D1 its own statement objects", async () => {
    // Identity, not shape: workerd compiles a batch from the statement objects
    // it minted, so a Proxy that merely forwards their properties is still not
    // one of them.
    const d = sessionDouble();
    const { header } = await inTimedRequest(async (c) => {
      const s = timedD1(c, d.raw);
      await s.batch([s.prepare("SELECT a FROM t WHERE id = ?").bind(1), s.prepare("SELECT b FROM u")]);
    });
    const batched = d.seen.find((call) => call.method === "batch")!.args[0] as unknown[];
    expect(batched).toHaveLength(2);
    expect(batched[0]).toBe(d.minted[1]); // the bound statement, not the one prepare() made
    expect(batched[1]).toBe(d.minted[2]);
    expect(header).toMatch(/^db;dur=\d+\.\d{3};desc="1 round trip", render;/);
  });

  it("does not count prepare() or bind(), which do no I/O", async () => {
    const d = sessionDouble();
    const { header } = await inTimedRequest((c) => {
      timedD1(c, d.raw).prepare("SELECT 1").bind(1);
    });
    expect(header).toMatch(/^render;dur=/);
  });

  it("hands the session back untouched when serverTiming is not mounted", async () => {
    const d = sessionDouble();
    const { value } = await inTimedRequest((c) => timedD1(c, d.raw), false);
    expect(value).toBe(d.raw);
  });
});

// ---------------------------------------------------------------------------
// KV and R2
// ---------------------------------------------------------------------------

function bindingDouble(methods: string[], syncMethods: string[] = []) {
  const seen: { method: string; self: unknown; args: unknown[] }[] = [];
  const binding: Record<string, unknown> = {};
  for (const method of methods) {
    binding[method] = async function (this: unknown, ...args: unknown[]) {
      seen.push({ method, self: this, args });
      return `${method}-result`;
    };
  }
  for (const method of syncMethods) {
    binding[method] = function (this: unknown, ...args: unknown[]) {
      seen.push({ method, self: this, args });
      return { uploadId: "u1" };
    };
  }
  return { binding, seen };
}

describe("timedKv and timedR2", () => {
  it("times each KV call as a kv round trip, with the real binding as `this`", async () => {
    const d = bindingDouble(["get", "put", "delete"]);
    const kv = d.binding as unknown as KVNamespace;
    const { value, header } = await inTimedRequest(async (c) => {
      const timed = timedKv(c, kv);
      await timed.put("k", "v", { expirationTtl: 60 });
      await timed.delete("k");
      return timed.get("k");
    });
    expect(value).toBe("get-result");
    expect(d.seen).toEqual([
      { method: "put", self: kv, args: ["k", "v", { expirationTtl: 60 }] },
      { method: "delete", self: kv, args: ["k"] },
      { method: "get", self: kv, args: ["k"] },
    ]);
    expect(header).toMatch(/^kv;dur=\d+\.\d{3};desc="3 round trips", render;/);
  });

  it("times R2 calls as r2, separately from any KV in the same request", async () => {
    const r2 = bindingDouble(["get"]).binding as unknown as R2Bucket;
    const kv = bindingDouble(["get"]).binding as unknown as KVNamespace;
    const { header } = await inTimedRequest(async (c) => {
      await timedR2(c, r2).get("media/photo.jpg");
      await timedKv(c, kv).get("k");
    });
    expect(header).toMatch(/^r2;dur=\d+\.\d{3};desc="1 round trip", kv;dur=\d+\.\d{3};desc="1 round trip", render;/);
  });

  it("leaves a synchronous method synchronous and untimed", async () => {
    // R2's resumeMultipartUpload() returns an R2MultipartUpload, not a promise
    // of one. Timed, it would come back as a Promise and every caller would
    // break -- and it does no I/O to time anyway.
    const d = bindingDouble([], ["resumeMultipartUpload"]);
    const bucket = d.binding as unknown as R2Bucket;
    const { value, header } = await inTimedRequest((c) => {
      const upload = timedR2(c, bucket).resumeMultipartUpload("key", "u1");
      return { isPromise: upload instanceof Promise, upload };
    });
    expect(value).toEqual({ isPromise: false, upload: { uploadId: "u1" } });
    expect(d.seen[0]!.self).toBe(bucket);
    expect(header).toMatch(/^render;dur=/);
  });

  it("hands the binding back untouched when serverTiming is not mounted", async () => {
    const kv = bindingDouble(["get"]).binding as unknown as KVNamespace;
    const { value } = await inTimedRequest((c) => timedKv(c, kv), false);
    expect(value).toBe(kv);
  });
});
