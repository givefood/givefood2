import { describe, expect, it } from "vitest";
import { formatFloat, pyRound, round2 } from "./float";

// float.ts exists because JavaScript lost information Python had: a Python
// `float` always reprs with a decimal point (`repr(51.0) == "51.0"`), while
// `String(51.0) === "51"`. Three production endpoints are contractually
// byte-identical to the Django site they replace -- the four geo.json feeds
// (gfwfbn/views.py:207-339, built as raw JSON TEXT in
// workers/site/src/lib/buildGeojson.ts), the API v1/v2 CSV output
// (unicodecsv, via csv.ts), and the XML output (dicttoxml). All three route
// every float through formatFloat, so a regression here is a silent
// diff in a public API body, not a crash.
//
// The reference values below were checked against a real CPython 3 REPL
// (`repr(x)` / `round(x, n)`), not copied from the module's own comments --
// including the places where this code DIVERGES from Python. Those
// divergences are pinned as-is, with the Python answer named in the comment,
// so a future fix shows up as a deliberately-changed test rather than a
// surprise.

describe("formatFloat", () => {
  it("gives an integral double the trailing '.0' that JSON.stringify drops", () => {
    // This single behaviour is the reason the module exists. The UK straddles
    // the 0 meridian and buildGeojson.ts cites a live Sheffield-area donation
    // point sitting at exactly latitude 53.0, so "53" vs "53.0" is an
    // everyday response body, not a contrived edge case.
    expect(formatFloat(51)).toBe("51.0");
    expect(formatFloat(53)).toBe("53.0");
    expect(formatFloat(-1)).toBe("-1.0");
    // The thing that would have happened without this module:
    expect(JSON.stringify(51.0)).toBe("51");
  });

  it("keeps a fractional value exactly as Python reprs it, digits and all", () => {
    expect(formatFloat(0.5)).toBe("0.5");
    expect(formatFloat(-0.1234)).toBe("-0.1234");
    expect(formatFloat(123456.789)).toBe("123456.789");
    // repr() is shortest-round-trip, so the classic float artefact keeps all
    // 17 digits in Python too -- it must NOT be tidied to "0.3" here.
    expect(formatFloat(0.1 + 0.2)).toBe("0.30000000000000004");
  });

  it("distinguishes -0.0 from 0.0, which `x === 0` alone cannot", () => {
    // Python's repr(-0.0) is "-0.0" and the module header says this was
    // verified against the pinned dicttoxml 1.7.16. A naive `x === 0` test
    // returning "0.0" would silently drop the sign, since -0 === 0 in JS.
    expect(formatFloat(0)).toBe("0.0");
    expect(formatFloat(-0)).toBe("-0.0");
    // Guard the implementation detail that makes it work: Object.is, not ===.
    expect(-0 === 0).toBe(true);
  });

  it("switches to exponential at Python's thresholds, not JavaScript's", () => {
    // Python reprs scientifically at >= 1e16 and < 1e-4. JavaScript's own
    // String() only does so at >= 1e21 and < 1e-6, so the whole 1e16..1e21
    // band would come out as a long digit string if the module trusted
    // String(). Each of these is a real CPython repr().
    expect(formatFloat(1e16)).toBe("1e+16");
    expect(formatFloat(-1e16)).toBe("-1e+16");
    expect(formatFloat(1.5e16)).toBe("1.5e+16");
    expect(formatFloat(1e-5)).toBe("1e-05");
    expect(formatFloat(-1e-5)).toBe("-1e-05");
    // The band where JS and Python disagree about the format itself:
    expect(String(1e17)).toBe("100000000000000000");
    expect(formatFloat(1e17)).toBe("1e+17");
  });

  it("holds the exact boundaries either side of both thresholds", () => {
    // 9999999999999998.0 is the largest double below 1e16 and stays plain
    // decimal -- the module header calls this out explicitly, and CPython
    // agrees. An off-by-one on `>=` would flip it to "1e+16".
    expect(formatFloat(9999999999999998)).toBe("9999999999999998.0");
    expect(formatFloat(1e15)).toBe("1000000000000000.0");
    // 2**53, the last integer with no gap above it, still in the plain band.
    // CPython: repr(2.0**53) == '9007199254740992.0'.
    expect(formatFloat(2 ** 53)).toBe("9007199254740992.0");
    // 1e-4 itself is NOT below the threshold, so it stays plain; the next
    // step down is scientific. The plain side of that boundary keeps every
    // significant digit rather than collapsing to the leading zeros --
    // CPython: repr(0.000123456) == '0.000123456'.
    expect(formatFloat(1e-4)).toBe("0.0001");
    expect(formatFloat(0.000123456)).toBe("0.000123456");
    expect(formatFloat(9.999e-5)).toBe("9.999e-05");
  });

  it("pads the exponent to two digits but never truncates a longer one", () => {
    // padStart(2, "0") is what turns JS's "1e-5" into Python's "1e-05". The
    // risk with a padder is that someone later "tidies" it into a slice or a
    // fixed-width format and clips a three-digit exponent, so pin both ends.
    expect((1e-5).toExponential()).toBe("1e-5"); // what JS gives us
    expect(formatFloat(1e-5)).toBe("1e-05"); // what Python wants
    expect(formatFloat(1e-100)).toBe("1e-100");
    expect(formatFloat(1e300)).toBe("1e+300");
    // The extremes of the double range, both still exact CPython reprs.
    expect(formatFloat(5e-324)).toBe("5e-324");
    expect(formatFloat(1.7976931348623157e308)).toBe("1.7976931348623157e+308");
    expect(formatFloat(-1.7976931348623157e308)).toBe("-1.7976931348623157e+308");
  });

  it("keeps the full shortest-round-trip mantissa in the exponential branch", () => {
    // Every example above has a one- or two-digit mantissa, so all of them
    // would still pass if the branch called toExponential(6) or sliced the
    // mantissa -- the exponent formatting would be untouched and the digits
    // lost would be digits nobody asserted. These two carry a full 17-digit
    // mantissa, which is the case that actually pins "no fixed precision".
    //
    // They are also a direct parity check on the DIGITS rather than the
    // shape: JS toExponential() and Python repr() are both shortest-round-trip,
    // so they must agree character for character once the exponent is padded.
    // CPython: repr(1.2345678901234567e-07) == '1.2345678901234566e-07'
    // (the literal is not exactly representable, and both languages print the
    // ...566 double they actually got -- neither invents the ...567).
    expect(formatFloat(1.2345678901234567e-7)).toBe("1.2345678901234566e-07");
    // CPython: repr(-9.876543210987654e+21) == '-9.876543210987654e+21'
    expect(formatFloat(-9.876543210987654e21)).toBe("-9.876543210987654e+21");
    expect(formatFloat(1.2345678901234567e-7)).toHaveLength("1.2345678901234566e-07".length);
  });

  it("spells the non-finite values the way json.dumps does, not repr", () => {
    // repr() would say nan / inf / -inf. These outputs land in JSON and XML
    // bodies, where Python's json.dumps emits NaN / Infinity / -Infinity --
    // so the capitalised spelling is correct and must not be "fixed".
    // Reachable in geo.json: buildGeojson.ts:96-98 does Number(parts[1]) on a
    // raw lat_lng column, and a malformed one yields NaN rather than a throw.
    expect(formatFloat(NaN)).toBe("NaN");
    expect(formatFloat(Infinity)).toBe("Infinity");
    expect(formatFloat(-Infinity)).toBe("-Infinity");
    // The consequence, spelled out because it is the surprising half: those
    // three spellings are NOT valid JSON, so a geo.json body built from a
    // malformed lat_lng is rejected by a strict parser. That is Django's
    // behaviour too -- CPython json.dumps([nan, inf, -inf]) emits
    // '[NaN, Infinity, -Infinity]' -- so it is parity, not a bug to fix here.
    expect(() => JSON.parse(formatFloat(NaN))).toThrow(SyntaxError);
    expect(() => JSON.parse(formatFloat(Infinity))).toThrow(SyntaxError);
  });

  it("never groups digits, so the output stays valid JSON and one CSV field", () => {
    // The output is concatenated straight into a JSON coordinate array and
    // into CSV rows (csv.ts:26). A "tidy up the numbers" refactor reaching
    // for toLocaleString would produce "1,234,567.5": invalid JSON, and in
    // CSV a comma that splits one field into two unquoted ones.
    expect((1234567.5).toLocaleString("en-US")).toBe("1,234,567.5"); // the trap
    expect(formatFloat(1234567.5)).toBe("1234567.5");
    expect(formatFloat(1234567.5)).not.toContain(",");
    expect(formatFloat(9999999999999998)).not.toContain(",");
  });

  it("is number-only: null and undefined are the caller's problem, not handled here", () => {
    // Unreachable today -- buildGeojson.ts:97-98 coerces with Number() first
    // and csv.ts:22 maps null/undefined to "" before it can get here -- but
    // the two failure modes are asymmetric and one of them is silent, so pin
    // what a widened caller contract would actually buy. undefined falls
    // through to String(undefined), which contains an "e" and therefore
    // satisfies the /[.e]/ guard, emitting the bare text `undefined` into a
    // response body (invalid JSON, no exception). null is not === 0, so
    // Math.abs(null) === 0 sends it down the a < 1e-4 branch and it dies on
    // null.toExponential().
    expect(formatFloat(undefined as unknown as number)).toBe("undefined");
    expect(() => formatFloat(null as unknown as number)).toThrow(TypeError);
    // A numeric STRING is the realistic version of this, because every value
    // in this app arrives from a D1 column and csv.ts:24 is the only thing
    // stopping one reaching here (`typeof v === "number"`, else String(v)).
    // Its failure mode is magnitude-dependent, which is the worst kind: the
    // guards use Number.isNaN/=== (no coercion) but Math.abs coerces, so a
    // string big enough to miss `a < 1e-4` sails through String(x) and looks
    // fine, while a small one reaches x.toExponential() and throws. A caller
    // widened to accept strings would therefore pass its own tests and then
    // 500 on the first sub-1e-4 coordinate in production.
    expect(formatFloat("51" as unknown as number)).toBe("51.0");
    expect(formatFloat("51.5" as unknown as number)).toBe("51.5");
    expect(() => formatFloat("0.00001" as unknown as number)).toThrow(TypeError);
    // And the silent ones, for the same reason as `undefined` above: both
    // contain a "." or an "e", so the /[.e]/ guard passes them through as-is
    // and the literal text lands in the response body with no exception.
    expect(formatFloat(true as unknown as number)).toBe("true");
    expect(formatFloat({} as unknown as number)).toBe("[object Object]");
    expect(formatFloat("abc" as unknown as number)).toBe("abc.0"); // no "." or "e", so it gets one
  });

  it("round-trips: JSON.parse(formatFloat(x)) is bit-identical to x", () => {
    // The output is spliced into a response body as raw JSON text
    // (buildGeojson.ts:99 concatenates it straight into a coordinate array),
    // so it has to be a faithful literal for the value, not just a
    // plausible-looking one. Python's repr guarantees this; anything that
    // rounded or truncated digits here would break it while still looking
    // fine in a diff.
    //
    // JSON.parse, deliberately, not Number(): Number is far more forgiving
    // than the consumer is. Number("+1e16"), Number(" 51.0 ") and
    // Number("0x10") all round-trip happily while being invalid JSON, so a
    // Number-based check would bless output that breaks every client of the
    // feed. JSON.parse also preserves -0, so Object.is still discriminates.
    const values = [
      0, -0, 1, -1, 51, 0.5, 0.1 + 0.2, 123456.789, 9999999999999998, 2 ** 53, 1e15, 1e16, 1.5e16, 1e17, 1e21, 1e-4, 0.000123456, 9.999e-5,
      1e-5, 1e-100, 1e300, 5e-324, 1.7976931348623157e308, -0.1234, 1.0000000000000002,
    ];
    for (const v of values) {
      expect(Object.is(JSON.parse(formatFloat(v)), v)).toBe(true);
    }
    // The gap being closed, so nobody "simplifies" it back to Number():
    expect(Number("+1e16")).toBe(1e16);
    expect(() => JSON.parse("+1e16")).toThrow(SyntaxError);
  });

  it("never emits a bare integer and never drops a digit, for any finite input", () => {
    // The whole contract in one loop: every finite output carries either a
    // decimal point or an exponent, every exponent is signed and at least two
    // digits wide, AND the text still parses back to the identical double.
    // The shape check alone is not enough -- a plain-band implementation that
    // reached for x.toFixed(6) would satisfy the regex on every input while
    // quietly truncating a coordinate, so both are asserted together.
    const shape = /^-?(?:\d+\.\d+|\d(?:\.\d+)?e[+-]\d{2,})$/;
    const offenders: string[] = [];
    let plainBand = 0;
    let exponential = 0;
    for (let i = 0; i < 2000; i++) {
      // A deterministic spread across the plain band, both thresholds and
      // well beyond them, in both signs -- no Math.random, so a failure here
      // is reproducible.
      const exponent = (i % 60) - 30;
      const mantissa = ((i * 7919) % 1000) / 100 - 5;
      const v = mantissa * 10 ** exponent;
      if (v === 0) continue;
      const s = formatFloat(v);
      if (!shape.test(s)) offenders.push(`shape: ${v} -> ${s}`);
      // JSON.parse rather than Number for the reason given in the test above:
      // the output is raw JSON text, and Number accepts literals JSON rejects.
      if (!Object.is(JSON.parse(s), v)) offenders.push(`round-trip: ${v} -> ${s}`);
      if (s.includes("e")) exponential++;
      else plainBand++;
    }
    expect(offenders).toEqual([]);
    // Guard the SPREAD as well as the assertions. If someone narrows the
    // generator above, this loop could keep passing while only ever touching
    // one of the two branches -- these two lines make that a failure instead.
    expect(plainBand).toBeGreaterThan(500);
    expect(exponential).toBeGreaterThan(500);
  });
});

describe("round2", () => {
  it("rounds half-to-even on a real tie, where toFixed rounds half-up", () => {
    // The documented reason round2 exists at all. 0.125 is exactly
    // representable as a double, so it really is a tie, and Python's
    // round(0.125, 2) is 0.12 (round-half-to-EVEN) while JS toFixed says
    // 0.13. Both sides asserted, so the test says what it is preventing.
    expect((0.125).toFixed(2)).toBe("0.13"); // the bug being avoided
    expect(round2(0.125)).toBe(0.12); // matches CPython round(0.125, 2)
    // ...and to even means 0.135 goes the other way, up to 14.
    expect(round2(0.135)).toBe(0.14);
  });

  it("applies the same tie-break symmetrically for negatives", () => {
    // The tie branch uses Math.floor, which goes toward -Infinity, so the
    // negative case is the one most likely to be broken by a refactor to
    // Math.trunc or a `Math.abs` shortcut. CPython: round(-0.125, 2) == -0.12.
    expect(round2(-0.125)).toBe(-0.12);
    expect(round2(-0.375)).toBe(-0.38);
    expect(round2(0.375)).toBe(0.38);
  });

  it("rounds ordinary distance_mi values the way Django's round() does", () => {
    // The production input: gfapi1/views.py:133 does round(foodbank.distance_mi, 2)
    // where distance_mi is givefood/utils/geo.py:474 miles(m) == m * 0.000621371192.
    // These metre values, and the CPython answers, are the actual contract.
    const miles = (m: number) => m * 0.000621371192;
    expect(round2(miles(500))).toBe(0.31);
    expect(round2(miles(1609))).toBe(1); // CPython: 1.0
    expect(round2(miles(2414))).toBe(1.5);
    expect(round2(miles(10000))).toBe(6.21);
    expect(round2(miles(48280))).toBe(30); // CPython: 30.0
    expect(round2(miles(100000))).toBe(62.14);
    // ...and the value 30 is then rendered by formatFloat, which is what puts
    // the ".0" back that Python never lost. The two helpers are a pair.
    expect(formatFloat(round2(miles(48280)))).toBe("30.0");
  });

  it("matches CPython round() across the WHOLE distance_mi domain, not just six samples", () => {
    // The module header used to claim round2 was "hand-verified against real
    // Python output for distance_mi", and the divergence test below asserted
    // in a COMMENT that no integer metre count reached the broken branch --
    // which was the justification for leaving round2 as its own copy of the
    // defect (github #14 has since routed it through pyRound). Six
    // hand-picked metre values cannot support either claim, and a prose
    // comment supports nothing at all -- so check the entire production
    // input domain instead.
    //
    // The reasoning that makes this equivalent to a CPython comparison
    // without running CPython:
    //   * toFixed(2) is correctly rounded HALF-UP on the double's exact value;
    //     CPython round(x, 2) is correctly rounded HALF-TO-EVEN on the same
    //     exact value. They can only disagree where that exact value is an
    //     exact .xx5, i.e. where x is an odd multiple of 0.125.
    //   * For such an x, x * 100 is an odd multiple of 12.5 and therefore
    //     exact in binary, so round2's `scaled - floor === 0.5` test always
    //     fires on a genuine tie. Genuine ties can never slip past it.
    // So: zero tie-branch hits over the domain means round2 === toFixed there,
    // AND no genuine tie exists there, AND therefore round2 === CPython there.
    // (Verified independently in a CPython REPL: 0 ties over the same range.)
    //
    // 0..200,000 m is the real span -- gfapi1/views.py caps the nearby search
    // well inside it, and the far end is ~124 miles.
    const miles = (m: number) => m * 0.000621371192;
    const ties: number[] = [];
    const mismatches: string[] = [];
    for (let m = 0; m <= 200000; m++) {
      const v = miles(m);
      const scaled = v * 100;
      if (scaled - Math.floor(scaled) === 0.5) ties.push(m);
      if (!Object.is(round2(v), Number(v.toFixed(2)))) mismatches.push(`${m}m -> ${round2(v)} vs ${Number(v.toFixed(2))}`);
    }
    expect(ties).toEqual([]);
    expect(mismatches).toEqual([]);
    // If a future change to miles()'s constant, or to the tie test, starts
    // routing real distances through the half-to-even branch, the two lines
    // above fail and the known divergence stops being theoretical.
  });

  it("passes non-finite values through instead of throwing", () => {
    // distance_mi comes from a haversine over user-supplied lat/lng; a NaN
    // there must surface as "NaN" in the response rather than a 500 from the
    // serialiser. Number(NaN.toFixed(2)) is NaN, so this holds by accident --
    // pin it so a rewrite around toFixed keeps it.
    expect(round2(NaN)).toBeNaN();
    expect(round2(Infinity)).toBe(Infinity);
    expect(round2(-Infinity)).toBe(-Infinity);
    // Beyond toFixed's plain-decimal range it still returns the value itself.
    expect(round2(1e21)).toBe(1e21);
  });

  it("is stable when re-applied to an already-rounded value", () => {
    // api2 rounds once, but the value then flows through several writers; a
    // second pass must not drift it, or a cached vs freshly-built body would
    // differ.
    for (const v of [3.14159, 0.125, -0.125, 62.1371192, 0.005, 30]) {
      expect(round2(round2(v))).toBe(round2(v));
    }
  });

  it("turns a negative zero INPUT positive, but keeps one it produces", () => {
    // Asymmetric and easy to trip over, because formatFloat renders the two
    // differently ("0.0" vs "-0.0"). (-0).toFixed(2) is "0.00", while
    // (-0.001).toFixed(2) is "-0.00". CPython keeps the sign in both cases
    // (round(-0.0, 2) == -0.0 and round(-0.001, 2) == -0.0), so the first
    // line is a small divergence and the second is parity.
    expect(Object.is(round2(-0), -0)).toBe(false);
    expect(round2(-0)).toBe(0);
    expect(formatFloat(round2(-0))).toBe("0.0"); // CPython repr: '-0.0'
    expect(Object.is(round2(-0.001), -0)).toBe(true);
    expect(formatFloat(round2(-0.001))).toBe("-0.0"); // CPython repr: '-0.0'
  });

  // github #14. This asserted the divergences, "pinned rather than fixed".
  // The tie test was applied to the PRODUCT `x * 100`, which carries its own
  // rounding error, so doubles that are not ties produced a product landing
  // exactly on .5 and half-to-even was applied to a non-tie. 2.675 as a
  // double is really 2.67499999999999982, below the boundary, so CPython
  // rounds it DOWN -- but 2.675 * 100 is exactly 267.5 in binary.
  //
  // Every expectation below is CPython's own answer, taken from
  // `json.dumps(round(v, 2))` rather than reasoned about.
  it("matches Python when x*100 lands on .5 only through float error", () => {
    expect(2.675 * 100).toBe(267.5); // the product really is a false tie
    expect(round2(2.675)).toBe(2.67);
    expect(round2(-2.675)).toBe(-2.67);
    expect(round2(0.005)).toBe(0.01);
    expect(round2(0.015)).toBe(0.01);
    expect(round2(0.025)).toBe(0.03);
    expect(round2(0.615)).toBe(0.61);
    expect(round2(12.345)).toBe(12.35);
    expect(round2(32.735)).toBe(32.73);
    // The direction runs BOTH ways -- 0.015 down, 0.025 up -- so the fix is
    // not a bias correction. And it is not "toFixed everywhere" either: on a
    // TRUE tie toFixed rounds away from zero where CPython rounds to even.
    // 0.125 is exactly representable, so it is a real tie, and the two
    // disagree.
    expect((0.125).toFixed(2)).toBe("0.13");
    expect(round2(0.125)).toBe(0.12); // CPython: 0.12
    // None of this was reachable through distance_mi in practice -- no
    // integer metre count from 1 to 200,000 produces a miles() value whose
    // *100 is an exact half -- which is why round2's "hand-verified" claim
    // held even while it carried the defect. That made it a LATENT copy of a
    // live bug rather than a second bug, and github #14 removed the copy by
    // making round2 a call to pyRound. The observable exposure was always
    // pyRound on coordinates; see the matching test below.
  });
});

describe("pyRound", () => {
  it("keeps an integral coordinate integral, for formatFloat to re-decimalise", () => {
    // The exact pairing buildGeojson.ts:99 relies on: round(51.0, 4) is the
    // Python float 51.0, and Number((51.0).toFixed(4)) is 51 -- identical
    // values, and formatFloat then prints both as "51.0". If pyRound ever
    // returned a string or a scaled integer this pipeline breaks silently.
    expect(pyRound(51, 4)).toBe(51);
    expect(pyRound(53, 6)).toBe(53);
    expect(formatFloat(pyRound(53, 4))).toBe("53.0");
    expect(formatFloat(pyRound(0, 6))).toBe("0.0");
  });

  it("truncates real UK coordinates to the 4dp and 6dp the feeds use", () => {
    // gfwfbn/views.py:218-220 picks decimal_places 4 for the all-items feed
    // and 6 for every scoped feed. CPython round() answers, both places.
    expect(pyRound(51.5073509, 4)).toBe(51.5074);
    expect(pyRound(51.5073509, 6)).toBe(51.507351);
    expect(pyRound(-0.1277583, 4)).toBe(-0.1278);
    expect(pyRound(-0.1277583, 6)).toBe(-0.127758);
    expect(pyRound(-1.23456789, 6)).toBe(-1.234568);
    expect(pyRound(0.123456789, 6)).toBe(0.123457);
  });

  it("actually quantises to the requested precision, across the UK bounding box", () => {
    // The property the geo.json byte-contract depends on, checked over a
    // deterministic sweep of the whole UK box rather than the six hand-picked
    // coordinates above: the result must be exactly representable at that many
    // decimal places (so formatFloat can never print a 7th digit into the
    // coordinate array) and must stay within half a unit in the last place of
    // the input (so it is a ROUNDING, not a truncation or a no-op). A pyRound
    // that returned x unchanged, or rounded at the wrong precision, passes
    // neither check.
    const overPrecise: string[] = [];
    const drifted: string[] = [];
    let checked = 0;
    let ties = 0;
    for (let i = 0; i < 3000; i++) {
      // Roughly Land's End to Shetland, Fermanagh to Lowestoft.
      const lat = 49.9 + ((i * 0.0037117) % 11.0);
      const lng = -8.2 + ((i * 0.0091733) % 10.0);
      for (const v of [lat, lng]) {
        for (const n of [4, 6]) {
          // Which of pyRound's two branches this input takes, recomputed here
          // rather than inferred, so the spread assertion below is real.
          const scaled = v * 10 ** n;
          if (scaled - Math.floor(scaled) === 0.5) ties++;
          const r = pyRound(v, n);
          // Exactly representable at n places: re-quantising is a no-op.
          if (!Object.is(r, Number(r.toFixed(n)))) overPrecise.push(`${v} @${n} -> ${r}`);
          // Rendered text agrees -- no 7th decimal reaches the response body.
          const decimals = /^-?\d+\.(\d+)$/.exec(formatFloat(r));
          if (decimals && (decimals[1] as string).length > n) overPrecise.push(`${v} @${n} -> ${formatFloat(r)}`);
          // Half a unit in the last place, plus a hair of slack: the tie
          // branch divides by 10**n (not exact in binary) and the input
          // carries its own representation error, so the bound is not exact.
          if (Math.abs(r - v) > 0.5 * 10 ** -n * (1 + 1e-6)) drifted.push(`${v} @${n} -> ${r}`);
          checked++;
        }
      }
    }
    expect(overPrecise).toEqual([]);
    expect(drifted).toEqual([]);
    expect(checked).toBe(12000);
    // Guard WHICH branches the sweep reaches, not just how many inputs it
    // saw. `checked === 12000` is satisfied by a generator that only ever
    // produces messy decimals, and those take the Number(x.toFixed(n)) path
    // every time -- so the half-to-even tie branch, the one carrying the
    // known Python divergence pinned further down, would go completely
    // unexercised by this property while the test still passed. These two
    // lines make that a failure. (Currently 262 ties of 12000.)
    expect(ties).toBeGreaterThan(100);
    expect(checked - ties).toBeGreaterThan(10000);
  });

  it("agrees with round2 at ndigits 2 on the TIE branch, not just the toFixed one", () => {
    // The module says pyRound uses the "same round-half-to-even tie-break as
    // round2", and deliberately keeps round2 as a separate copy so the
    // already-verified one cannot drift. That decision is only safe while the
    // two actually agree.
    //
    // Eighths are used because they make the claim testable: v * 100 is
    // (i * 12.5), so every ODD eighth is an exact .5 and lands on the tie
    // branch, while every even eighth goes down the toFixed path. A spread of
    // "messy" decimals -- the obvious thing to reach for -- hits the tie
    // branch essentially never, so it would compare the two functions only
    // where both are just Number(x.toFixed(2)) and would pass even if one
    // copy's tie-break were flipped to half-to-ODD or half-away-from-zero.
    const mismatches: string[] = [];
    let ties = 0;
    for (let i = -4000; i < 4000; i++) {
      const v = i / 8; // -500 .. 500 in steps of 0.125
      const scaled = v * 100;
      if (scaled - Math.floor(scaled) === 0.5) ties++;
      // Object.is via toBe, so a 0 / -0 disagreement counts as a mismatch too.
      if (!Object.is(pyRound(v, 2), round2(v))) mismatches.push(`${v}: ${pyRound(v, 2)} vs ${round2(v)}`);
    }
    expect(mismatches).toEqual([]);
    // Exactly half the sample is an odd eighth. Asserted so that narrowing
    // the generator can never silently stop exercising the tie branch.
    expect(ties).toBe(4000);
    // And on the documented tie itself.
    expect(pyRound(0.125, 2)).toBe(round2(0.125));
    expect(pyRound(-0.125, 2)).toBe(round2(-0.125));
  });

  it("rounds half-to-even at ndigits 0, matching Python's bare round()", () => {
    // ndigits 0 is the classic banker's-rounding demonstration and the
    // cheapest way to prove the tie-break is to-EVEN and not to-odd or
    // away-from-zero. Every value here is an exact double, so these are
    // genuine ties. CPython: 0, 2, 2, 4, -2, -2.
    expect(pyRound(0.5, 0)).toBe(0);
    expect(pyRound(1.5, 0)).toBe(2);
    expect(pyRound(2.5, 0)).toBe(2);
    expect(pyRound(3.5, 0)).toBe(4);
    expect(pyRound(-1.5, 0)).toBe(-2);
    expect(pyRound(-2.5, 0)).toBe(-2);
    // Divergence in sign only: CPython round(-0.5, 0) is -0.0, this gives +0,
    // which formatFloat then prints as "0.0" rather than "-0.0".
    expect(Object.is(pyRound(-0.5, 0), -0)).toBe(false);
    expect(formatFloat(pyRound(-0.5, 0))).toBe("0.0"); // CPython repr: '-0.0'
  });

  it("passes non-finite values through, like round2", () => {
    expect(pyRound(NaN, 4)).toBeNaN();
    expect(pyRound(Infinity, 6)).toBe(Infinity);
    expect(pyRound(-Infinity, 6)).toBe(-Infinity);
  });

  it("is stable when re-applied at the same precision", () => {
    // buildGeojson rounds once per coordinate, but the all-items feed and the
    // scoped feeds round the SAME source coordinate at 4dp and 6dp; a value
    // already at 4dp must survive a 6dp pass unchanged.
    expect(pyRound(pyRound(51.5073509, 4), 6)).toBe(51.5074);
    for (const v of [51.5074, -0.1278, 53, 0.123457]) {
      expect(pyRound(v, 6)).toBe(v);
    }
  });

  it("rejects an out-of-range ndigits ONLY on the non-tie path", () => {
    // "generalised to an arbitrary precision" is narrower than it sounds: the
    // non-tie path is Number(x.toFixed(ndigits)), and toFixed only spans
    // 0..100, so a negative ndigits throws.
    expect(() => pyRound(1234, -2)).toThrow(RangeError);
    expect(() => pyRound(2500, -2)).toThrow(RangeError); // 25.0 exactly: no tie, still throws
    expect(() => pyRound(1.5, 101)).toThrow(RangeError);
    expect(pyRound(1.5, 100)).toBe(1.5);
    // ...but the RangeError is NOT a guard, because the tie branch returns
    // before toFixed is ever reached. An input whose x * 10**ndigits lands on
    // an exact .5 sails straight through with a negative ndigits and returns
    // a number -- so "pyRound throws on negative ndigits" is false, and code
    // that relies on it to reject a bad precision will be wrong for one input
    // in two. Pinned rather than fixed (see the structured report). The
    // answers it gives on that path happen to be right: CPython
    // round(1250, -2) == 1200, round(1350, -2) == 1400, round(-1250, -2) == -1200.
    expect(pyRound(1250, -2)).toBe(1200);
    expect(pyRound(1350, -2)).toBe(1400);
    expect(pyRound(-1250, -2)).toBe(-1200);
  });

  it("silently degrades to 0dp HALF-UP when ndigits is missing, rather than throwing", () => {
    // `decimalPlaces` is threaded through four call layers in
    // buildGeojson.ts (buildGeojson -> foodbankFeatures -> pointFeature ->
    // here) before it reaches pyRound, so an undefined arriving from a new
    // caller or a reordered argument list is a live refactor hazard -- and
    // this is the quiet failure it produces.
    //
    // 10 ** undefined is NaN, so `scaled - floor === 0.5` is NaN === 0.5,
    // false, and the tie branch is skipped entirely. Execution lands on
    // toFixed(undefined), which ToIntegerOrInfinity()s to toFixed(0) -- 0
    // decimal places AND toFixed's half-away-from-zero, i.e. the exact
    // rounding rule this function exists to avoid. Coordinates would be
    // truncated to whole degrees, ~110km of error, with no exception.
    expect(pyRound(2.5, undefined as unknown as number)).toBe(3); // pyRound(2.5, 0) is 2; CPython round(2.5) is 2
    expect(pyRound(51.5073509, undefined as unknown as number)).toBe(52);
    expect(pyRound(2.5, 0)).toBe(2); // both halves asserted, so the divergence is unmissable
    // NaN behaves identically, for the same reason.
    expect(pyRound(2.5, NaN)).toBe(3);
    // A fractional ndigits is truncated toward zero by toFixed's own
    // coercion, so 4.5 quietly means 4 rather than being rejected.
    expect(pyRound(51.5073509, 4.5)).toBe(51.5074);
    expect(pyRound(51.5073509, 4.5)).toBe(pyRound(51.5073509, 4));
  });

  it("keeps the minus sign on a longitude just west of the Greenwich meridian", () => {
    // Not a contrived edge case: the prime meridian runs through London, and
    // buildGeojson.ts:98 gets longitude from Number(lat_lng.split(",")[1]), so
    // a donation point a couple of metres west of the line arrives as
    // -0.00002. CPython round(-2e-05, 4) is -0.0, repr '-0.0' -- and this
    // matches, because Math.floor(-0.2) is -1, the tie test fails, and
    // (-0.00002).toFixed(4) is "-0.0000", which Number() reads back as -0.
    expect(Object.is(pyRound(-0.00002, 4), -0)).toBe(true);
    expect(formatFloat(pyRound(-0.00002, 4))).toBe("-0.0"); // CPython repr: '-0.0'
    // The 6dp scoped feeds keep the value instead, and Python reprs a number
    // that small in exponential form -- so the coordinate array really does
    // contain -2e-05 rather than -0.000002. Still valid JSON, and still
    // byte-identical to Django's json.dumps output.
    expect(formatFloat(pyRound(-0.00002, 6))).toBe("-2e-05"); // CPython repr: '-2e-05'
    expect(formatFloat(pyRound(-0.000002, 6))).toBe("-2e-06"); // CPython repr: '-2e-06'
    // github #14: the worst-placed instance of the false tie, because it
    // flipped the value AND lost the sign. -0.00005 * 1e4 is exactly -0.5 in
    // binary, so the old tie branch took floor(-0.5) == -1, rounded to even
    // and landed on +0 -- while the double is slightly larger than 5e-05 in
    // magnitude, so CPython does not see a tie at all and rounds away.
    expect(pyRound(-0.00005, 4)).toBe(-0.0001);
    expect(formatFloat(pyRound(-0.00005, 4))).toBe("-0.0001"); // CPython repr: '-0.0001'
    // A stored longitude of exactly "-0.0" would also lose its sign: Number()
    // preserves negative zero, but toFixed does not.
    expect(Object.is(Number("-0.0"), -0)).toBe(true); // how it would arrive
    expect(formatFloat(pyRound(-0, 4))).toBe("0.0"); // CPython repr: '-0.0'
  });

  // github #14, and the reason it was a medium rather than a curiosity: this
  // is reachable from live data. Geocoders emit 5-to-7 decimal places
  // (geo.py:72-75 stores Google's lat/lng verbatim, and the repo's own rows
  // carry 51.5073509), and geo.json is a byte-exact contract. Measured
  // against CPython over 80,000 UK-bounding-box coordinates: the old code
  // disagreed on 4.90% at 6dp and 0.42% at 4dp.
  //
  // Every expectation is CPython's own answer, from json.dumps(round(v, n)).
  it("matches Python on coordinates whose *10^n lands on a false tie", () => {
    expect(51.50005 * 1e4).toBe(515000.5); // the product really is a false tie
    expect(pyRound(51.50005, 4)).toBe(51.5001);
    expect(formatFloat(pyRound(51.50005, 4))).toBe("51.5001");
    // Both directions, which is what rules out a one-sided correction.
    expect(pyRound(51.50015, 4)).toBe(51.5001);
    expect(pyRound(57.98525, 4)).toBe(57.9853);
    expect(pyRound(0.12345, 4)).toBe(0.1235);
    expect(pyRound(-0.1999985, 6)).toBe(-0.199998);
    expect(pyRound(-0.1999975, 6)).toBe(-0.199997);
    expect(pyRound(0.00005, 4)).toBe(0.0001);
    expect(pyRound(57.1066945, 6)).toBe(57.106695);
    expect(pyRound(53.98505, 4)).toBe(53.9851);
  });

  // THE HALF THAT KEEPS THE FIX FROM BEING "JUST USE toFixed". Genuine ties
  // are reachable -- every dyadic rational is one -- and there CPython rounds
  // half-to-EVEN while toFixed rounds half-away-from-zero. Deleting the tie
  // branch would pass every assertion above and break these.
  it("still rounds a TRUE tie half-to-even, where toFixed rounds away from zero", () => {
    for (const [value, expected, toFixedGives] of [
      [51.03125, 51.0312, "51.0313"],
      [51.15625, 51.1562, "51.1563"],
      [51.40625, 51.4062, "51.4063"],
      [51.53125, 51.5312, "51.5313"],
    ] as const) {
      expect(pyRound(value, 4), `${value}`).toBe(expected);
      // Asserted alongside, so the two rules are visibly different rather
      // than coincidentally equal on this fixture.
      expect(value.toFixed(4), `${value} toFixed`).toBe(toFixedGives);
    }
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(2.5, 0)).toBe(2);
    // Half-to-even means the odd neighbour goes UP, not that everything
    // goes down.
    expect(pyRound(0.375, 2)).toBe(0.38);
  });
});
