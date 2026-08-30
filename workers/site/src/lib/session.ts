import type { Context } from "hono";
import type { AppEnv } from "../types";

// One D1 session per request -- gives every query within a single request
// consistent reads (never a partial-write view), which is all a stateless,
// anonymous, read-only API request needs. See PLAN.md §3.3 and
// packages/db/src/types.ts: every packages/db query goes through a
// Session, never a bare env.DB.prepare(), because this database has read
// replication enabled.
export function dbSession(c: Context<AppEnv>) {
  return c.env.DB.withSession("first-unconstrained");
}
