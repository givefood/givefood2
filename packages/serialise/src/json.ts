import { formatDjangoJsonDatetime } from "./pyDatetime";
import { isDatetimeValue, isFloatValue, type SerialisableValue } from "./types";

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
// A __float-wrapped value unwraps to a plain number (so 1.0 renders as
// "1", same as any other JS number -- the accepted tradeoff).
//
// A __datetime value is formatted the way DjangoJSONEncoder formats it
// (pyDatetime.ts). An earlier version of this comment argued the raw D1
// string could pass through "as-is, no truncation" under structural
// parity. That was wrong on both counts, and the maintainer's 2026-08-30
// decision (PLAN.md §7.10.1 S1) applied structural parity to YAML ONLY --
// "JSON, XML and CSV remain byte-exact". The raw string was also not one
// shape but two (see pyDatetime.ts), which no reading of "parity" covers.
function toPlainJs(v: SerialisableValue): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(toPlainJs);
  if (isFloatValue(v)) return v.__float;
  if (isDatetimeValue(v)) return formatDjangoJsonDatetime(v.__datetime);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) out[k] = toPlainJs((v as Record<string, SerialisableValue>)[k] as SerialisableValue);
  return out;
}

export function formatJson(v: SerialisableValue, indent: number | null = 2): string {
  return JSON.stringify(toPlainJs(v), null, indent ?? undefined);
}
