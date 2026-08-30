import { pyFloatRepr } from "./pyfloat";
import { isPlainObject, isPyDatetime, isPyFloat, type PyValue } from "./types";

// WP 2.3, PLAN.md §7.4.4. **Structural, not byte, parity** -- a deliberate
// maintainer decision (2026-08-30), not an oversight. PyYAML renders a
// multiline string as a single-quoted *folded* scalar where every embedded
// newline becomes a blank line plus a continuation indent
// (`needs: 'Beans\n\n  Pasta'`), and no JS YAML library can be configured
// to reproduce that -- matching it means hand-porting PyYAML's scalar-style
// analysis, several days of work. PLAN.md's own expectation, quoted:
// "I expect [YAML traffic] is a rounding error, since nothing in the docs
// pushes people towards it and it is not in any dump." The measurement
// PLAN.md specifies to confirm that (14 days of production logs) was never
// run and isn't available now, so the maintainer chose structural parity
// directly rather than guess at byte parity's value: same keys (sorted,
// matching PyYAML's `sort_keys=True` default), same values, valid YAML
// that parses back to the same object -- via a block literal (`|-`) for
// multiline strings instead of PyYAML's folded-scalar style.
//
// Verified against real `yaml.dump(data, allow_unicode=True,
// default_flow_style=False)` output (PyYAML 6.0.3, matching production's
// uv.lock) for the parts this module DOES still reproduce structurally:
// keys sorted recursively at every mapping level; block sequences at the
// SAME indent as their parent key, not indented further; empty containers
// render inline as `{}`/`[]` even under block style; `null`/`true`/`false`
// unquoted; empty string as `''`.

function needsQuoting(s: string): boolean {
  if (s === "") return true;
  if (/^\s|\s$/.test(s)) return true; // leading/trailing whitespace
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true; // leading indicator char
  if (/: |:$| #/.test(s)) return true; // would read as a mapping value or a comment
  // YAML 1.1 boolean/null words, case-insensitive per PyYAML's resolver
  if (/^(null|~|true|false|yes|no|on|off|y|n)$/i.test(s)) return true;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return true; // looks like a number
  return false;
}

const YAML_ESC: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function quotedScalar(s: string): string {
  let out = '"';
  for (const ch of s) out += YAML_ESC[ch] ?? ch;
  return out + '"';
}

// PyYAML's (YAML 1.1) implicit-float resolver requires a decimal point in
// the mantissa -- a bare "1e+16" parses back as a plain string, not a
// float, verified by round-tripping through real yaml.safe_load. pyFloatRepr
// matches Python's repr(float) exactly (needed for JSON/XML), which omits
// the point for an exact power of ten in exponential form, so YAML needs
// its own pass to keep the value a float on reparse -- inserting ".0" here
// changes nothing about the represented number, only whether YAML's
// resolver recognises it.
function yamlFloatRepr(x: number): string {
  const repr = pyFloatRepr(x);
  const eIndex = repr.indexOf("e");
  if (eIndex === -1 || repr.includes(".")) return repr;
  return repr.slice(0, eIndex) + ".0" + repr.slice(eIndex);
}

function scalar(v: PyValue): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : yamlFloatRepr(v);
  if (isPyFloat(v)) return yamlFloatRepr(v.__pyfloat);
  if (isPyDatetime(v)) return v.__pydatetime; // unquoted, 6-digit, matching real PyYAML's rendering of a raw datetime
  if (Array.isArray(v)) return "[]"; // only reachable for an EMPTY array -- render()/renderInline() recurse for non-empty ones
  if (isPlainObject(v)) return "{}"; // only reachable for an EMPTY object, same reasoning
  const s = v as string;
  return needsQuoting(s) ? quotedScalar(s) : s;
}

function isEmptyContainer(v: PyValue): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

// A block literal scalar (`|-`): every line taken verbatim, no escaping
// needed regardless of content, which is exactly why it's the simple,
// always-correct choice here instead of reproducing PyYAML's folded style.
function blockLiteral(s: string, indent: string): string {
  const lines = s.split("\n").map((line) => indent + "  " + line);
  return "|-\n" + lines.join("\n");
}

function render(v: PyValue, indent: string): string {
  if (typeof v === "string" && v.includes("\n")) return blockLiteral(v, indent);
  if (Array.isArray(v) || isPlainObject(v)) {
    if (isEmptyContainer(v)) return Array.isArray(v) ? "[]" : "{}";
    if (Array.isArray(v)) {
      return v.map((item) => `${indent}- ${renderInline(item, indent + "  ")}`).join("\n");
    }
    const obj = v as Record<string, PyValue>;
    const keys = Object.keys(obj).sort();
    return keys
      .map((k) => {
        const val = obj[k] as PyValue;
        const isNested = (Array.isArray(val) || isPlainObject(val)) && !isEmptyContainer(val);
        const isMultiline = typeof val === "string" && val.includes("\n");
        if (isNested) {
          const childIndent = Array.isArray(val) ? indent : indent + "  ";
          return `${indent}${k}:\n${render(val, childIndent)}`;
        }
        if (isMultiline) return `${indent}${k}: ${render(val, indent)}`;
        return `${indent}${k}: ${scalar(val)}`;
      })
      .join("\n");
  }
  return scalar(v);
}

// A block sequence/mapping nested as the FIRST value on a `- ` line
// renders inline after the dash rather than on its own indented line
// (matching PyYAML: `- name: A\n  slug: a`, not `-\n  name: A`).
function renderInline(v: PyValue, indent: string): string {
  if (isPlainObject(v) && !isEmptyContainer(v)) {
    const obj = v as Record<string, PyValue>;
    const keys = Object.keys(obj).sort();
    return keys
      .map((k, i) => {
        const val = obj[k] as PyValue;
        const isNested = (Array.isArray(val) || isPlainObject(val)) && !isEmptyContainer(val);
        const isMultiline = typeof val === "string" && val.includes("\n");
        const prefix = i === 0 ? "" : indent;
        if (isNested) {
          const childIndent = Array.isArray(val) ? indent : indent + "  ";
          return `${prefix}${k}:\n${render(val, childIndent)}`;
        }
        if (isMultiline) return `${prefix}${k}: ${render(val, indent)}`;
        return `${prefix}${k}: ${scalar(val)}`;
      })
      .join("\n");
  }
  return render(v, indent);
}

export function pyYaml(data: { [key: string]: PyValue }): string {
  if (Object.keys(data).length === 0) return "{}\n";
  return render(data, "") + "\n";
}
