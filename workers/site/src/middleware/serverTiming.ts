import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

// PLAN.md §3.5 "RenderTime — do not port as a body rewrite". The Django
// original does response.content.replace(b"PUTTHERENDERTIMEHERE", ...) on
// EVERY response including image/jpeg and application/json, which forces
// full buffering and is incompatible with streaming an R2 object body --
// exactly the mechanism the photo migration depends on (see routes/media.ts).
//
// Trap: Date.now() does not advance during code execution on Workers -- a
// literal port would report 0ms for everything. Use performance.now().
export const serverTiming: MiddlewareHandler<AppEnv> = async (c, next) => {
  const t0 = performance.now();
  c.set("requestStartTime", t0);
  await next();
  const durationMs = performance.now() - t0;
  c.header("Server-Timing", `render;dur=${durationMs.toFixed(3)}`, { append: true });
};

// For a page route that wants the debug comment's "Took Nms" to mean the
// same thing Django's did (view + DB + template render, not just the
// render call) -- see debugcomment.njk. Reads the start time this
// middleware already recorded rather than each route handler timing itself.
export function elapsedMs(c: Context<AppEnv>): string {
  return (performance.now() - c.get("requestStartTime")).toFixed(3);
}
