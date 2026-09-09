// WP 2.3, PLAN.md §7.4.1. JSON.stringify(1.0) === "1" -- JS has no float/int
// distinction to preserve. csv.ts (the one format staying byte-exact with
// the Python API, see csv.ts) renders a float-valued field through here,
// carried as a { __float } wrapper (see types.ts) so it survives untouched
// until csv.ts actually renders it. json.ts, xml.ts and yaml.ts unwrap the
// same wrapper to a plain JS number instead -- an accepted structural-parity
// tradeoff, see each module's own header comment.
//
// Verified against the real pinned library output (dicttoxml 1.7.16,
// matching production's uv.lock) for the edge cases below -- not just
// transcribed from the plan text. 1e16 -> "1e+16", 1e-5 -> "1e-05",
// 9999999999999998.0 stays plain decimal (just under the 1e16 threshold),
// -0.0 stays "-0.0".
export function formatFloat(x: number): string {
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

// IS `x` EXACTLY HALFWAY between two n-decimal values? (github #14.)
//
// This has to be asked of the double's EXACT value, and the obvious way to
// ask it -- `x * 10**n - Math.floor(...) === 0.5` -- cannot, because that
// multiplication has a rounding error of its own. Doubles that are not ties
// produce a product landing exactly on .5, and half-to-even is then applied
// to a non-tie. Two real ones, expanded exactly:
//
//   57.1066945 is 57.106694500000003245...  -> x*1e6 == 57106694.5 exactly
//   51.50005   is 51.500050000000001659...  -> x*1e4 ==   515000.5 exactly
//
// Both are strictly ABOVE the boundary, so CPython rounds them up and the
// scaled-product test rounded them down. Measured against CPython over
// 80,000 UK-bounding-box coordinates: 5.0% disagreed at 6dp, 0.5% at 4dp,
// in both directions.
//
// So the question is asked of the bits instead. A double is
// mantissa x 2^exp exactly; x is a tie at n places iff
// mantissa x 10^n x 2 / 2^-exp is an odd integer. BigInt makes that exact
// arithmetic rather than floating-point arithmetic about floating point.
//
// THE BRANCH CANNOT JUST BE DELETED, which is the trap here: toFixed alone
// is right for every NON-tie and wrong for every true one. True ties are
// reachable -- any dyadic rational, e.g. 51.40625, 51.15625 or 0.125 -- and
// there CPython rounds half-to-even while toFixed rounds half-away-from-zero
// (round(51.40625, 4) is 51.4062; (51.40625).toFixed(4) is "51.4063").
function isExactHalfTie(x: number, ndigits: number): boolean {
  if (!Number.isFinite(x) || x === 0) return false;
  // ANSWERS "no" RATHER THAN THROWING for an ndigits this cannot reason
  // about, so the three pinned behaviours below it survive unchanged: an
  // `undefined` threaded in from a new caller, a NaN, and a fractional 4.5
  // all fall through to toFixed's own coercion exactly as they did before
  // #14, instead of dying in BigInt(). The 100 bound matches toFixed's own
  // range, so an absurd ndigits still reaches the RangeError rather than
  // computing 10n ** 1000000000n first.
  if (!Number.isInteger(ndigits) || Math.abs(ndigits) > 100) return false;

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  // Subnormals carry no implicit leading 1 and share one exponent.
  const mantissa = rawExponent === 0 ? fraction : fraction | (1n << 52n);
  const exponent = rawExponent === 0 ? -1074 : rawExponent - 1075;

  // x * 10^ndigits * 2 as an exact fraction, then: integral, and odd?
  //
  // Built as top/bot rather than the shorter `mantissa * 10^n * 2 / 2^-exp`
  // so that a NEGATIVE ndigits works too. pyRound's tie branch has always
  // accepted those and returned CPython's answer for them -- round(1250, -2)
  // is 1200 -- while its toFixed path throws RangeError; float.test.ts pins
  // that split deliberately, so this must not quietly turn it into a throw.
  let top = mantissa;
  let bot = 1n;
  const shift = exponent + 1;
  if (shift >= 0) top <<= BigInt(shift);
  else bot <<= BigInt(-shift);
  if (ndigits >= 0) top *= 10n ** BigInt(ndigits);
  else bot *= 10n ** BigInt(-ndigits);

  if (top % bot !== 0n) return false;
  return (top / bot) % 2n === 1n;
}

// Python's round(x, ndigits): round-half-to-EVEN on the double's exact
// value. JS's toFixed is also correctly rounded on the exact value but
// breaks ties AWAY FROM ZERO, so the two agree everywhere except on a true
// tie -- which is why the non-tie path below is simply toFixed and needs no
// arithmetic of its own.
//
// WP 3.6 (geo.json) needs 4dp on the all-items feed and 6dp on every scoped
// feed, and buildGeojson.ts calls that parity "STRICT byte-equality".
export function pyRound(x: number, ndigits: number): number {
  if (isExactHalfTie(x, ndigits)) {
    const factor = 10 ** ndigits;
    // Exact by construction on this branch: a tie is a dyadic rational whose
    // scaled value is representable, so the product carries no error here.
    const scaled = x * factor;
    const floor = Math.floor(scaled);
    return (floor % 2 === 0 ? floor : floor + 1) / factor;
  }
  return Number(x.toFixed(ndigits));
}

// Python round(x, 2), for distance_mi.
//
// NOW A CALL TO pyRound RATHER THAN A SECOND COPY (github #14). It carried
// the same scaled-product tie test and therefore the same defect; it was
// left as its own function on the grounds that its behaviour had been
// hand-verified and should not drift, which is exactly what kept the bug
// duplicated. Its inputs are miles(haversineMeters(...)) -- continuous
// doubles, for which an exact x*100 == .5 product is a roughly 1e-14 event
// -- so unlike the geo.json feeds this was never observably wrong. That
// makes it a latent copy of a live bug, not a second bug, and the fix is to
// stop having two of them.
export function round2(x: number): number {
  return pyRound(x, 2);
}
