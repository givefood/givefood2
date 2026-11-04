// Keep node:sqlite refusing to bind `undefined`, the way D1 does.
//
// Many suites fake D1 with a real node:sqlite database, and some of them pin
// that a query bound with `undefined` throws (see "rejects an undefined
// result" in packages/db/src/adminJobs.test.ts, or the malformed-message
// tests in workers/jobs/src/queues). D1 rejects `undefined`
// (D1_TYPE_ERROR), and so did node:sqlite up to Node 24. From Node 26
// node:sqlite quietly binds it as NULL, so those fakes stopped matching D1
// and the tests started passing writes that production would refuse.
//
// Wrapping the statement methods here restores the old error in one place
// instead of in every hand-rolled fake. On Node 24 and earlier it changes
// nothing, because node:sqlite already throws before the wrapper would.

const NODE_SQLITE = "node:sqlite";
const sqlite = (await import(/* @vite-ignore */ NODE_SQLITE)) as {
  StatementSync: { prototype: Record<string, (...args: unknown[]) => unknown> };
};

const proto = sqlite.StatementSync.prototype;

function assertBindable(params: unknown[]): void {
  params.forEach((value, i) => {
    if (value === undefined) {
      throw new TypeError(`Provided value cannot be bound to SQLite parameter ${i + 1}.`);
    }
    if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
      for (const [name, named] of Object.entries(value)) {
        if (named === undefined) {
          throw new TypeError(`Provided value cannot be bound to SQLite parameter ${name}.`);
        }
      }
    }
  });
}

for (const method of ["run", "get", "all", "iterate"]) {
  const original = proto[method];
  if (typeof original !== "function") continue;
  proto[method] = function (this: unknown, ...params: unknown[]) {
    assertBindable(params);
    return original.apply(this, params);
  };
}
