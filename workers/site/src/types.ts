import type { Env } from "../worker-configuration";
import type { AdminSessionData } from "./lib/adminAuth";
import type { Timings } from "./lib/timings";

// Shared Hono generics, so every route/middleware file's Context type is
// structurally identical to the one `app` in index.ts is instantiated with.
// A file typed against a narrower { Bindings: Env } alone is NOT assignable
// where a { Bindings: Env; Variables: Vars } context is expected -- Hono's
// Context is invariant enough in practice to make that a real compile error.
// csrfIssued: set by lib/csrf.ts issueCsrfToken() on EVERY path, and read by
// middleware/pageCacheControl.ts. A response carrying a CSRF token is
// per-visitor and must never enter a shared cache; see that middleware for
// why the Set-Cookie header alone was not a sufficient signal.
// timings: set by middleware/serverTiming.ts, optional on purpose -- a test
// app that mounts a route without that middleware has none, and every
// lib/timings.ts wrapper then hands its binding back untouched.
export type Vars = { lang: string; pathAfterPrefix: string; requestStartTime: number; adminUser?: AdminSessionData; csrfIssued?: boolean; timings?: Timings };
export type AppEnv = { Bindings: Env; Variables: Vars };
