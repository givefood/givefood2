import type { Context } from "hono";
import type { AppEnv } from "./types";

// Placeholder 404 body. PLAN.md's template port (§3.2, packages/templates)
// is not built yet -- once it is, this renders the real 404.njk through the
// same Nunjucks runtime as every other page, in the resolved language.
export async function render404(c: Context<AppEnv>): Promise<string> {
  return "<!doctype html><title>Not found</title><h1>Not found</h1>";
}
