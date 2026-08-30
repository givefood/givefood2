// WP 2.3, PLAN.md §7.4.1. JSON.stringify(1.0) === "1" -- JS has no float/int
// distinction to preserve, so every float-valued field (distance_mi,
// GeoJSON coordinates) must be rendered through here instead, carried as
// a { __pyfloat } wrapper (see types.ts) so it survives untouched until a
// serialiser actually renders it.
//
// Verified against the real pinned library output (dicttoxml 1.7.16,
// matching production's uv.lock) for the edge cases below -- not just
// transcribed from the plan text. 1e16 -> "1e+16", 1e-5 -> "1e-05",
// 9999999999999998.0 stays plain decimal (just under the 1e16 threshold),
// -0.0 stays "-0.0".
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";

  const a = Math.abs(x);
  if (a >= 1e16 || a < 1e-4) {
    const parts = x.toExponential().split("e"); // always exactly 2 parts -- toExponential() always emits one "e"
    const mantissa = parts[0] as string;
    const exp = parts[1] as string;
    const sign = exp.startsWith("-") ? "-" : "+";
    const digits = exp.replace(/^[+-]/, "").padStart(2, "0");
    return `${mantissa}e${sign}${digits}`;
  }
  const s = String(x);
  return /[.e]/.test(s) ? s : s + ".0";
}

// Python round(x, 2): round-half-to-EVEN on the exact decimal value. JS
// toFixed rounds half-away-from-zero -- they differ only on an exact .xx5
// boundary, reachable for values like 0.125. Used for distance_mi.
export function pyRound2(x: number): number {
  const scaled = x * 100;
  const floor = Math.floor(scaled);
  if (scaled - floor === 0.5) {
    return (floor % 2 === 0 ? floor : floor + 1) / 100;
  }
  return Number(x.toFixed(2));
}
