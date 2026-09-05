// WP 2.3. The shared value tree every format writer walks. Plain JS
// `number` is ambiguous between an int and a float (JSON.stringify(1.0)
// === "1"), so a value that must render with float formatting carries the
// `__float` wrapper explicitly -- see float.ts. json.ts unwraps it to a
// plain number (an accepted tradeoff, see json.ts); xml.ts/csv.ts render
// it with full float formatting, since those two stay byte-exact with the
// Python API they're replacing. Likewise a datetime is carried as the RAW
// D1 column string in a wrapper, never a JS `Date`, and each writer
// formats it the way its Python counterpart does -- three fractional
// digits for JSON, six for XML, str()-style for YAML (PLAN.md §7.4.6,
// pyDatetime.ts). The raw string is not itself any of those three.
export type SerialisableValue =
  | null
  | boolean
  | string
  | number
  | { __float: number }
  | { __datetime: string }
  | SerialisableValue[]
  | { [key: string]: SerialisableValue };

export function isFloatValue(v: SerialisableValue): v is { __float: number } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "__float" in v;
}

export function isDatetimeValue(v: SerialisableValue): v is { __datetime: string } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "__datetime" in v;
}

export function isPlainObject(v: SerialisableValue): v is { [key: string]: SerialisableValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !isFloatValue(v) && !isDatetimeValue(v);
}
