import { defineConfig } from "vitest/config";

// One vitest run for the whole monorepo, from the root. Tests are colocated
// with the code as `<module>.test.ts` rather than gathered into a tests/
// directory, so a module and its contract sit next to each other and a file
// with no neighbouring test is visible at a glance.
//
// NODE ENVIRONMENT, not @cloudflare/vitest-pool-workers. Everything covered
// here is pure logic -- formatters, parsers, header policy, geo maths --
// which needs no D1, KV, R2 or queue binding, and running it in plain node
// keeps the suite fast enough to run on every save. Route handlers that DO
// need bindings are deliberately out of scope: they need the workers pool
// plus a seeded D1, which is its own piece of work. See TESTING.md for what
// that leaves uncovered, stated honestly rather than implied by a green tick.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "workers/*/src/**/*.test.ts"],
    environment: "node",
    // The Workers runtime is UTC and Django ran with TZ pinned to UTC, so
    // every timestamp helper here is written against UTC. Without this a
    // developer in BST would see pyDatetime tests fail for the hour offset
    // -- which is exactly the class of bug those helpers exist to prevent,
    // so the suite must not be the thing that hides it.
    env: { TZ: "UTC" },
  },
});
