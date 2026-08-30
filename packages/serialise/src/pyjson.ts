import { isPyDatetime, isPyFloat, type PyValue } from "./types";

// WP 2.3, PLAN.md §7.4.2. Structural, not byte, parity (maintainer decision,
// 2026-08-30 -- see PLAN.md §7.10.1 S1 and §7.4.4's note). Byte-exact would
// need a hand-written encoder (JSON.stringify(1.0) === "1" -- JS has no
// float/int distinction), but for structural parity that's unnecessary
// complexity: unwrap the value tree to plain JS values and hand it to the
// native JSON.stringify, which is V8-optimised (C++) and meaningfully
// faster than a hand-rolled recursive string builder for the larger
// payloads (e.g. /api/2/foodbanks/, 1000+ rows) -- a real consideration
// for a Worker's CPU-ms budget, not just less code.
//
// A __pyfloat-wrapped value unwraps to a plain number (so 1.0 renders as
// "1", same as any other JS number -- the accepted tradeoff). A
// __pydatetime value unwraps to its raw string as-is, no truncation --
// structural parity doesn't require matching Python's 3-vs-6-digit
// precision split between formats, only the same underlying value.
function toPlainJs(v: PyValue): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(toPlainJs);
  if (isPyFloat(v)) return v.__pyfloat;
  if (isPyDatetime(v)) return v.__pydatetime;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) out[k] = toPlainJs((v as Record<string, PyValue>)[k] as PyValue);
  return out;
}

export function pyJson(v: PyValue, indent: number | null = 2): string {
  return JSON.stringify(toPlainJs(v), null, indent ?? undefined);
}
