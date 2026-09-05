import { DUMP_SCHEMA, NOT_RESOLVED, defineScalarTag, dump } from "js-yaml";
import { formatPyStrDatetime, parsePyDatetime } from "./pyDatetime";
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

// A datetime carried as a class rather than a string, so js-yaml emits it
// as a bare timestamp scalar -- `created: 2020-01-24 16:30:23.173268` --
// which is what PyYAML emits and, structurally, a timestamp rather than a
// string. Handed to dump() as a plain string it comes out single-quoted,
// because js-yaml (correctly) quotes any string a reader would resolve as
// another type; that quoting changes the value's TYPE on the wire, which
// is exactly what structural parity is meant to preserve.
//
// How this works in js-yaml 5 (which is not the 4.x API most examples
// show), read from the dumper rather than assumed:
//   - a value matched by a tag's identify() becomes a scalar node whose
//     `tagged` flag is the INVERSE of the tag's `implicit` -- so an
//     implicit tag never has its name printed;
//   - plain (unquoted) style is permitted only when the printed text, run
//     back through the schema's implicit resolvers, resolves to a tag with
//     the same NAME as the node's own.
// So this tag is named exactly as YAML's own timestamp tag. The schema's
// built-in `!!timestamp` resolver already accepts `YYYY-MM-DD HH:MM:SS.f`
// (YAML 1.1 allows a space separator and a fraction), which satisfies the
// same-name check whichever resolver runs first; `resolve` below is there
// so the tag is well-formed, not because loading is ever done here.
class PyTimestamp {
  constructor(readonly value: string) {}
}

const PY_TIMESTAMP_TAG = defineScalarTag<string>("tag:yaml.org,2002:timestamp", {
  implicit: true,
  implicitFirstChars: [..."0123456789"],
  resolve: (source) => (parsePyDatetime(source) ? source : NOT_RESOLVED),
  identify: (data) => data instanceof PyTimestamp,
  represent: (data) => (data as PyTimestamp).value,
});

const SCHEMA = DUMP_SCHEMA.withTags(PY_TIMESTAMP_TAG);

function toPlainJs(v: SerialisableValue): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(toPlainJs);
  if (isFloatValue(v)) return v.__float;
  if (isDatetimeValue(v)) return new PyTimestamp(formatPyStrDatetime(v.__datetime));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) out[k] = toPlainJs((v as Record<string, SerialisableValue>)[k] as SerialisableValue);
  return out;
}

export function formatYaml(data: SerialisableValue[] | { [key: string]: SerialisableValue }): string {
  return dump(toPlainJs(data), { sortKeys: true, schema: SCHEMA });
}
