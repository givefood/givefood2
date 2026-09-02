import type { Env } from "../worker-configuration";
import type { AdminSessionData } from "./lib/adminAuth";

// Shared Hono generics, so every route/middleware file's Context type is
// structurally identical to the one `app` in index.ts is instantiated with.
// A file typed against a narrower { Bindings: Env } alone is NOT assignable
// where a { Bindings: Env; Variables: Vars } context is expected -- Hono's
// Context is invariant enough in practice to make that a real compile error.
export type Vars = { lang: string; pathAfterPrefix: string; requestStartTime: number; adminUser?: AdminSessionData };
export type AppEnv = { Bindings: Env; Variables: Vars };
