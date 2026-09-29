import type { Context } from "hono";
import type { AppEnv } from "../types";
import { timedD1 } from "./timings";

// One D1 session per request -- gives every query within a single request
// consistent reads (never a partial-write view), which is all a stateless,
// anonymous, read-only API request needs. See PLAN.md §3.3 and
// packages/db/src/types.ts: every packages/db query goes through a
// Session, never a bare env.DB.prepare(), because this database has read
// replication enabled.
//
// Also the one place D1 time is measured for Server-Timing's `db` metric
// (lib/timings.ts): wrapping the session here is what makes every query
// reach the header without any call site having to opt in.
export function dbSession(c: Context<AppEnv>) {
  return timedD1(c, c.env.DB.withSession("first-unconstrained"));
}
