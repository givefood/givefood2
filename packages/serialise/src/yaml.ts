import { dump } from "js-yaml";
import { isDatetimeValue, isFloatValue, type SerialisableValue } from "./types";

// WP 2.3, PLAN.md §7.4.4. Structural, not byte, parity -- a deliberate
// maintainer decision (2026-08-30), not an oversight. PyYAML renders a
// multiline string as a single-quoted *folded* scalar where every embedded
// newline becomes a blank line plus a continuation indent, which no JS
// YAML library can be configured to reproduce -- matching it exactly means
// hand-porting PyYAML's scalar-style analysis, several days of work for a
// format the plan itself expects has near-zero real usage (the 14-day
// production measurement PLAN.md specifies was never run; see §7.10.1 S1).
//
// js-yaml (one dependency, argparse, used only by its CLI) already
// produces sorted keys and a `|-` block literal for multiline strings by
// default -- checked directly, not assumed -- so no PyYAML-specific
// styling logic is needed here at all, only unwrapping the value tree the
// same way json.ts does.
function toPlainJs(v: SerialisableValue): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(toPlainJs);
  if (isFloatValue(v)) return v.__float;
  if (isDatetimeValue(v)) return v.__datetime;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) out[k] = toPlainJs((v as Record<string, SerialisableValue>)[k] as SerialisableValue);
  return out;
}

export function formatYaml(data: SerialisableValue[] | { [key: string]: SerialisableValue }): string {
  return dump(toPlainJs(data), { sortKeys: true });
}
