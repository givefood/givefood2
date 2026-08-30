// WP 2.3. The shared value tree every serialiser walks. Plain JS `number`
// is ambiguous between Python int and float (JSON.stringify(1.0) === "1"),
// so a value that must render as a Python float carries the `__pyfloat`
// wrapper explicitly -- see pyfloat.ts. pyjson.ts unwraps it to a plain
// number for structural parity (losing the int/float distinction, an
// accepted tradeoff -- see pyjson.ts); pyxml.ts/pycsv.ts render it through
// pyFloatRepr for byte parity. Likewise a datetime is carried as a
// pre-formatted string wrapper, never a JS `Date`, so XML can render it
// with full 6-digit precision (PLAN.md §7.4.6) without JSON needing to
// agree on the same format.
export type PyValue =
  | null
  | boolean
  | string
  | number
  | { __pyfloat: number }
  | { __pydatetime: string }
  | PyValue[]
  | { [key: string]: PyValue };

export function isPyFloat(v: PyValue): v is { __pyfloat: number } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "__pyfloat" in v;
}

export function isPyDatetime(v: PyValue): v is { __pydatetime: string } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "__pydatetime" in v;
}

export function isPlainObject(v: PyValue): v is { [key: string]: PyValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !isPyFloat(v) && !isPyDatetime(v);
}
