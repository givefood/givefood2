import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { Timings } from "../lib/timings";

// PLAN.md §3.5 "RenderTime — do not port as a body rewrite". The Django
// original does response.content.replace(b"PUTTHERENDERTIMEHERE", ...) on
// EVERY response including image/jpeg and application/json, which forces
// full buffering and is incompatible with streaming an R2 object body --
// exactly the mechanism the photo migration depends on (see routes/media.ts).
//
// Trap: Date.now() does not advance during code execution on Workers -- a
// literal port would report 0ms for everything. Use performance.now().
//
// `render` is the whole request. The per-backend metrics in front of it
// (db, kv, r2) come from the Timings collector published here and filled in
// by lib/timings.ts's wrappers -- see that module for what they measure.
export const serverTiming: MiddlewareHandler<AppEnv> = async (c, next) => {
  const t0 = performance.now();
  const timings = new Timings();
  c.set("requestStartTime", t0);
  c.set("timings", timings);
  await next();
  const now = performance.now();
  const render = `render;dur=${(now - t0).toFixed(3)}`;
  // ONE c.header() call however many metrics there are: after the response
  // exists, each call makes Hono rebuild it (see serverTiming.test.ts), so a
  // call per metric would clone every response once per backend it touched.
  c.header("Server-Timing", [...timings.entries(now), render].join(", "), { append: true });
};

// For a page route that wants the debug comment's "Took Nms" to mean the
// same thing Django's did (view + DB + template render, not just the
// render call) -- see debugcomment.njk. Reads the start time this
// middleware already recorded rather than each route handler timing itself.
//
// WHOLE MILLISECONDS. This used to be toFixed(3), matching Django, which
// prints a real fraction ("Took 64.066ms"). On Workers the fraction was
// always exactly ".000": timers are deliberately coarsened against timing
// attacks, so performance.now() does not advance during synchronous
// execution and only moves at I/O boundaries. Three digits of guaranteed
// zero is not precision, it is decoration that reads like precision --
// which is worse than none, because someone will eventually believe it.
//
// A deliberate divergence from Django, and only in the human-facing
// string: the Server-Timing header above keeps its decimals, since that is
// a machine-readable field where the format is conventional and a consumer
// may reasonably parse a float.
export function elapsedMs(c: Context<AppEnv>): string {
  return String(Math.round(performance.now() - c.get("requestStartTime")));
}
