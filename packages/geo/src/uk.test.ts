import { describe, expect, it } from "vitest";
import { isUk, miles } from "./uk";

// Both helpers in this module are one-liners ported from
// givefood/utils/geo.py, and both are load-bearing in ways a one-liner does
// not advertise:
//
//   - `miles()` produces the `distance_mi` field of four public API search
//     endpoints (api1.ts:209 plus api2/{foodbanks,locations,donationpoints}
//     .ts, each wrapping it in `round2`) AND of the /needs/ HTML path, where
//     lib/find{Locations,Donationpoints,LocationsByCategory}.ts publish the
//     result UNROUNDED. The constant is a TRUNCATED 0.000621371192, not the
//     exact 1/1609.344, so the "obvious tidy-up" to a division changes
//     numbers that external consumers have been diffing for years (PLAN.md
//     §7.5.3: "The mile constant is 0.000621371192, not a rounder value.
//     Use it verbatim."). The test below demonstrates that at a realistic
//     distance rather than merely asserting it.
//
//   - `isUk()` is the only RANGE check on /api/2/{foodbanks,locations,
//     donationpoints}/search/ (foodbanks.ts:384, locations.ts:184,
//     donationpoints.ts:198) and the gate on the /needs/ HTML page
//     (wfbn/index.ts:67) -- exactly the four call sites PLAN.md's G12 row
//     lists for Django's `is_uk()`. (foodbanks.ts additionally has the
//     `.isdigit()` regex Django's `foodbank_search` has; locations and
//     donationpoints deliberately do not -- frozen bug B5.) It is also what
//     rejects the "0,0" sentinel that lib/geocode.ts returns when Google
//     Geocoding fails, so a widened box would silently turn geocoding
//     outages into 200s full of nonsense distances.
//
// Every float pinned below was computed from the Python original
// (givefood/utils/geo.py) and compared bit-for-bit with the JS result --
// where a test says "matches Python exactly", that comparison was actually
// run, not assumed.

// The box, transcribed from PLAN.md §7.5.4 (the SPEC), deliberately NOT
// imported from ./uk -- the constants are not exported, and importing them
// would make the edge tests below assert a constant against itself. Copying
// the spec's digits here is what turns those tests into a real check that
// uk.ts still agrees with the Django original.
const SW_LAT = 49.1;
const SW_LNG = -14.015517;
const NE_LAT = 61.061;
const NE_LNG = 2.0919117;

// The next representable double either side of `x`. Used to sit one single
// floating-point step outside each edge. This is computed rather than typed
// as a literal because hand-typed neighbours are deceptively easy to get
// wrong: `-14.015517000000002` LOOKS adjacent to -14.015517, but parses to
// -14.015517000000003 -- two steps out, which would quietly leave room for
// a sw_lng that was itself one step wrong to pass the test.
//
// This helper is itself verified by the first test in the isUk block below.
// Without that, a helper that overshot (returning a value many steps out)
// would still make the bracketing test pass while silently destroying the
// "no other constant can satisfy both tests" property that test claims.
function adjacentDouble(x: number, towards: "smaller" | "larger"): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  // Raw bit patterns count away from zero in both directions, so a step
  // "larger" is +1 for a positive x and -1 for a negative one.
  const awayFromZero = (x > 0) === (towards === "larger");
  view.setBigInt64(0, view.getBigInt64(0) + (awayFromZero ? 1n : -1n));
  return view.getFloat64(0);
}

describe("miles", () => {
  it("uses the truncated Django constant, so a metric mile is NOT exactly 1", () => {
    // 1609.344 m is one international mile by definition, yet Django's
    // multiply-by-0.000621371192 lands fractionally short of 1.0. Python
    // agrees to the last bit: 0.9999999996180481.
    expect(miles(1609.344)).toBe(0.9999999996180481);
    expect(miles(1609.344)).toBeLessThan(1); // short, never long
  });

  it("differs from both tempting 'tidier' refactors", () => {
    // The two rewrites that look harmless in a diff. Comparing against them
    // directly (rather than just pinning a literal) states the actual
    // requirement: whatever miles() does, it must not be either of these.
    // Both are exactly 1 for a whole mile and both drift in the last three
    // digits elsewhere.
    for (const meters of [1609.344, 12345.678, 6367000, 1000]) {
      expect(miles(meters)).not.toBe(meters / 1609.344);
      expect(miles(meters)).not.toBe(meters * (1 / 1609.344));
    }
    expect(1609.344 / 1609.344).toBe(1); // the refactor rounds a mile to exactly 1
    expect(miles(1609.344)).not.toBe(1); // the shipped code does not
  });

  it("refactoring to a division would change a PUBLISHED distance_mi", () => {
    // The test above only shows the raw doubles differ, which on its own is
    // a shrug -- the API rounds to 2dp, and at most distances the drift is
    // invisible after rounding. This test is the one that earns the "use it
    // verbatim" rule: it names a distance where the difference survives
    // rounding and reaches an API consumer.
    //
    // 24.14016 m is 0.015 miles exactly (a donation point across the car
    // park, well inside the range /api/2/donationpoints/search/ returns).
    // The shipped constant publishes 0.01; a division by 1609.344 publishes
    // 0.02 -- the value DOUBLES. Both raw doubles below match CPython
    // bit-for-bit.
    const shipped = miles(24.14016);
    const refactored = 24.14016 / 1609.344;
    expect(shipped).toBe(0.014999999994270721);
    expect(refactored).toBe(0.015000000000000001);
    expect(Number(shipped.toFixed(2))).toBe(0.01);
    expect(Number(refactored.toFixed(2))).toBe(0.02);

    // toFixed is used above as a stand-in for the shipped `round2`
    // (packages/serialise/src/float.ts, which geo does not depend on and so
    // cannot import). The two agree everywhere EXCEPT on an exact .xx5 tie,
    // where round2 goes half-to-even like Python; assert neither value is
    // such a tie, so this demonstration holds under the real rounding too.
    for (const v of [shipped, refactored]) {
      expect(v * 100 - Math.floor(v * 100)).not.toBe(0.5);
    }

    // And the warning for anyone tempted to "simplify" this test to a
    // rounder distance: at 16.09344 m (0.01 miles) both constants publish
    // 0.01, and at 8.04672 m (0.005 miles) the refactor lands EXACTLY on a
    // .xx5 tie, where round2's half-to-even rounds it back down to 0.00 and
    // the difference vanishes again. The distance above was chosen because
    // the difference actually shows.
    expect(Number(miles(16.09344).toFixed(2))).toBe(Number((16.09344 / 1609.344).toFixed(2)));
    expect(8.04672 / 1609.344).toBe(0.005); // the tie that hides the divergence
  });

  it("matches Python's float arithmetic bit-for-bit on awkward values", () => {
    // Run through CPython with the same literals: the doubles are
    // identical, which is what lets /api/1/ and /api/2/ keep reporting the
    // distance_mi values their consumers already have on file.
    expect(miles(12345.678)).toBe(7.671248654908176);
    expect(miles(4828.032)).toBe(2.999999998854144); // three miles, near-miss again
    expect(miles(6367000)).toBe(3956.270379464); // the /api/1/ earth radius
    expect(miles(1000)).toBe(0.621371192);
    expect(miles(1)).toBe(0.000621371192); // the constant itself, via the API
  });

  it("is a plain multiply: it does not round, clamp or guard its input", () => {
    // givefood/utils/geo.py:476 is `return meters*0.000621371192` and
    // nothing else. Rounding to 2dp happens at the API call sites (api1.ts
    // and api2/*.ts wrap it in `round2`, per PLAN.md §7.5.3's `pyRound2`),
    // so pushing that rounding down into miles() would double-round every
    // endpoint -- and would ALSO corrupt lib/findLocations.ts,
    // lib/findDonationpoints.ts and lib/findLocationsByCategory.ts, which
    // publish miles() to the /needs/ HTML path with no rounding at all.
    //
    // `twoDp` below is a deliberately crude half-away-from-zero rounder,
    // NOT a model of the shipped round2 (which is half-to-even); it is here
    // only to show that ANY 2dp rounding destroys information miles() must
    // keep, so the assertions hold whichever rounder someone reaches for.
    const twoDp = (n: number) => Math.round(n * 100) / 100;
    expect(miles(12345.678)).not.toBe(twoDp(miles(12345.678)));
    expect(twoDp(miles(1))).toBe(0); // rounding inside here would erase the constant
    expect(miles(1)).not.toBe(0);
    // Negative metres are physically meaningless but Django passes them
    // straight through, and nearest()/haversineMeters() are the only
    // callers, so a defensive Math.abs() here would hide a real bug
    // upstream rather than fix one.
    expect(miles(-1000)).toBe(-0.621371192);
    expect(miles(0)).toBe(0);
  });

  it("preserves the sign of negative zero, which JSON then flattens", () => {
    // toBe is Object.is, so this fails if a "tidy-up" ever introduces an
    // `|| 0` or a Math.abs(). Worth pinning both halves: the sign survives
    // the multiply, and JSON.stringify collapses it -- so no API consumer
    // can ever see `"distance_mi": -0`, and nobody needs to add a guard
    // here to prevent that.
    expect(Object.is(miles(-0), -0)).toBe(true);
    expect(JSON.stringify({ distance_mi: miles(-0) })).toBe('{"distance_mi":0}');
  });

  it("never throws on any NUMBER -- but a BigInt is a TypeError", () => {
    // haversineMeters() can only return a finite number for finite input,
    // but distance_mi is computed on rows read from D1 -- a NULL latitude
    // that slipped through would arrive here as NaN. Django would return
    // nan just as quietly; the failure has to surface as a nonsense
    // distance in the payload, not as a 500 from the whole search endpoint.
    expect(miles(Number.NaN)).toBeNaN();
    expect(miles(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(miles(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);

    // The one input that breaks the "quiet nonsense, never a 500" property.
    // `*` refuses to mix BigInt with Number, so a BigInt coordinate -- from
    // a JSON reviver, a hand-written BigInt() somewhere upstream, or a
    // future D1 driver returning INTEGER columns as BigInt -- is an
    // uncaught TypeError, i.e. exactly the 500 the rest of this function is
    // careful to avoid. Pinned so the divergence is on the record; isUk()
    // in the same module takes the same value happily (see its own test),
    // so the two exports do NOT fail together.
    expect(() => miles(1000n as unknown as number)).toThrow(TypeError);
  });

  it("turns a raw D1 NULL into a silent 0.0, but undefined into NaN", () => {
    // TypeScript says `number`, but these callers read straight off D1 rows
    // and a NULL column arrives as JS `null`. The two junk values behave
    // completely differently, and the dangerous one is `null`: it coerces
    // to 0 and yields a plausible-looking "0.0 miles away", which sorts to
    // the TOP of a search response and reads as an exact match. `undefined`
    // at least produces a visible NaN. Pinned so that anyone hardening the
    // callers knows a null coordinate cannot be spotted downstream of here.
    expect(miles(null as unknown as number)).toBe(0);
    expect(miles(undefined as unknown as number)).toBeNaN();
    // A numeric string coerces silently and correctly, so a caller who
    // forgot Number() is invisible here too -- same value as miles(1000).
    expect(miles("1000" as unknown as number)).toBe(0.621371192);
  });

  it("does not overflow or underflow into a special value at the extremes", () => {
    // The constant is < 1, so even MAX_VALUE stays finite: there is no
    // input that turns a finite distance into Infinity. At the other end
    // the smallest subnormal underflows to a positive zero rather than
    // producing -0 or NaN. Both matter because JSON.stringify(Infinity) is
    // the bare token `null`, which would corrupt an API response rather
    // than merely look wrong. CPython agrees on both.
    expect(miles(Number.MAX_VALUE)).toBe(1.1170347260596138e305);
    expect(Number.isFinite(miles(Number.MAX_VALUE))).toBe(true);
    expect(Object.is(miles(Number.MIN_VALUE), 0)).toBe(true);
  });
});

describe("isUk", () => {
  it("accepts real UK coordinates from every corner of the country", () => {
    expect(isUk(51.5074, -0.1278)).toBe(true); // London
    expect(isUk(51.4816, -3.1791)).toBe(true); // Cardiff
    expect(isUk(55.9533, -3.1883)).toBe(true); // Edinburgh
    expect(isUk(54.5973, -5.9301)).toBe(true); // Belfast
  });

  it("keeps Shetland, Scilly and Jersey inside the box", () => {
    // PLAN.md §7.5.4 names the first two by name: "a food bank on the
    // boundary is a real edge case in Shetland and the Isles of Scilly".
    // They are the reason the constants have six and seven decimal places,
    // and the reason nobody may round them off.
    expect(isUk(60.1553, -1.1453)).toBe(true); // Lerwick, Shetland
    expect(isUk(60.8362, -0.8848)).toBe(true); // Unst -- northernmost inhabited UK
    expect(isUk(49.9155, -6.3164)).toBe(true); // St Mary's, Isles of Scilly
    expect(isUk(57.596, -13.687)).toBe(true); // Rockall -- what sw_lng is stretched for
    // Jersey has food banks and sits 0.11 degrees above sw_lat -- the
    // closest real inhabited place to the southern edge, and the reason
    // that edge cannot be nudged north "for safety".
    expect(isUk(49.1858, -2.1043)).toBe(true); // St Helier, Jersey
  });

  it("treats every edge as INSIDE, because the comparisons are strict", () => {
    // givefood/utils/geo.py:191-206 uses `<` and `>`, never `<=`/`>=`
    // (PLAN.md §7.5.4: "Strict `<` / `>` comparisons"). A point sitting
    // exactly on a boundary is therefore in the UK. Each of these lines
    // flips to false the moment someone "hardens" a comparison operator,
    // which is precisely the Shetland/Scilly edge case §7.5.4 warns about.
    expect(isUk(SW_LAT, 0)).toBe(true); // exactly sw_lat
    expect(isUk(NE_LAT, 0)).toBe(true); // exactly ne_lat
    expect(isUk(50, SW_LNG)).toBe(true); // exactly sw_lng
    expect(isUk(50, NE_LNG)).toBe(true); // exactly ne_lng
    expect(isUk(SW_LAT, SW_LNG)).toBe(true); // exact SW corner
    expect(isUk(NE_LAT, NE_LNG)).toBe(true); // exact NE corner
    expect(isUk(SW_LAT, NE_LNG)).toBe(true); // exact SE corner
    expect(isUk(NE_LAT, SW_LNG)).toBe(true); // exact NW corner
  });

  it("(helper check) adjacentDouble really does move exactly one step", () => {
    // The bracketing test below is the strongest claim in this file, and it
    // rests entirely on this helper. A helper that overshot -- stepping ten
    // values, or a whole ULP-of-a-different-binade -- would leave every
    // assertion below green while silently allowing a sw_lng that is itself
    // several steps wrong. So verify the helper behaviourally, without
    // re-running its own bit arithmetic:
    for (const x of [SW_LAT, SW_LNG, NE_LAT, NE_LNG]) {
      for (const towards of ["smaller", "larger"] as const) {
        const n = adjacentDouble(x, towards);
        expect(n).not.toBe(x); // it moved
        expect(towards === "smaller" ? n < x : n > x).toBe(true); // the right way
        // It is reversible, which no overshooting implementation could be
        // for both directions at once.
        expect(adjacentDouble(n, towards === "smaller" ? "larger" : "smaller")).toBe(x);
        // And nothing lies strictly between: the exact midpoint of two
        // adjacent doubles is unrepresentable, so it must round back onto
        // one of the endpoints.
        const mid = (x + n) / 2;
        expect(mid === x || mid === n).toBe(true);
      }
    }
    // Independent anchors, computed once and hand-checked, so the helper
    // cannot drift in the same direction as the tests that use it. (Each of
    // these literals round-trips through Number() to the same double.)
    expect(adjacentDouble(SW_LAT, "smaller")).toBe(49.099999999999994);
    expect(adjacentDouble(NE_LAT, "larger")).toBe(61.06100000000001);
    expect(adjacentDouble(SW_LNG, "smaller")).toBe(-14.015517000000001);
    expect(adjacentDouble(NE_LNG, "larger")).toBe(2.0919117000000003);
  });

  it("rejects a point one floating-point step outside each edge", () => {
    // Together with the exact-edge test above, this is what actually pins
    // the four constants: each edge is bracketed between two ADJACENT
    // doubles, one accepted and one rejected, so no other value of sw_lat /
    // sw_lng / ne_lat / ne_lng can satisfy both tests. That covers the
    // realistic failure modes -- a transcription slip in the seventh
    // decimal, or a box widened "by an epsilon, for safety".
    expect(isUk(adjacentDouble(SW_LAT, "smaller"), 0)).toBe(false); // one step south of sw_lat
    expect(isUk(adjacentDouble(NE_LAT, "larger"), 0)).toBe(false); // one step north of ne_lat
    expect(isUk(50, adjacentDouble(SW_LNG, "smaller"))).toBe(false); // one step west of sw_lng
    expect(isUk(50, adjacentDouble(NE_LNG, "larger"))).toBe(false); // one step east of ne_lng
  });

  it("uses the full-precision constants, not rounded-off ones", () => {
    // Human-scale version of the ULP test: these four points are inside the
    // real box but OUTSIDE the box you would get from the tidier constants
    // named in each comment. Ported constants are exactly the kind of thing
    // that gets shortened during a later clean-up, and this test names the
    // shortened value that breaks it. (sw_lat is already tidy at 49.1, so
    // its risk is the opposite one -- a transcription slip northwards, or a
    // deliberate narrowing -- which is what the last line guards.)
    expect(isUk(50, -14.0155165)).toBe(true); // dies if sw_lng becomes -14.0155
    expect(isUk(50, 2.0919)).toBe(true); // dies if ne_lng becomes 2.09
    expect(isUk(61.0605, 0)).toBe(true); // dies if ne_lat becomes 61.06
    expect(isUk(49.10005, 0)).toBe(true); // dies if sw_lat becomes 49.11
  });

  it("rejects points failing on exactly one edge at a time", () => {
    // Four separate `if`s in Django, so each needs its own witness --
    // a single test point outside on two axes (Paris is both too far
    // south AND too far east) would not notice a deleted check.
    expect(isUk(48.8566, -0.5)).toBe(false); // too far south only (Normandy)
    expect(isUk(52.3676, 4.9041)).toBe(false); // too far east only (Amsterdam)
    expect(isUk(62.0, -6.7)).toBe(false); // too far north only (Faroes)
    expect(isUk(53.0, -20.0)).toBe(false); // too far west only (mid-Atlantic)
  });

  it("rejects the '0,0' sentinel that a failed geocode returns", () => {
    // lib/geocode.ts (and Django's geocode()) return the literal string
    // "0,0" on any Google Geocoding failure, and deliberately have no
    // separate "geocoding failed" branch -- the contract is that isUk()
    // rejects Null Island like any other out-of-UK point, turning the
    // outage into the same 400 a bad lat_lng gets (PLAN.md B7). If the
    // southern edge ever dropped below the equator that error path
    // disappears and an outage starts returning 200s.
    expect(isUk(0, 0)).toBe(false);
    expect(isUk(-0, -0)).toBe(false); // negative zero is still south of sw_lat
  });

  it("is a bounding box, NOT a UK membership test", () => {
    // Dublin, Calais and Jersey are all comfortably inside the rectangle,
    // and none of them is in the UK (Jersey is a Crown Dependency). This is
    // not a bug to be fixed with a polygon: the box is what Django ships,
    // and every /api/2/*/search/ endpoint inherits it. PLAN.md §4.8.1
    // records that there is no point-in-polygon anywhere in the codebase,
    // so someone tightening this into a real country check would change
    // which coordinates return 200 vs 400 on the public API. Documented
    // here so the looseness is visibly intentional rather than an untested
    // gap.
    expect(isUk(53.3498, -6.2603)).toBe(true); // Dublin, Republic of Ireland
    expect(isUk(50.9513, 1.8587)).toBe(true); // Calais, France
    expect(isUk(49.1858, -2.1043)).toBe(true); // St Helier, Jersey
  });

  it("returns true for NaN -- and so does Django", () => {
    // Every comparison against NaN is false, so all four `if`s fall
    // through and the function returns true. Verified against CPython:
    // `is_uk("nan,nan")` is True there too, because float("nan") parses
    // happily -- this is parity, not a JS quirk.
    //
    // The API route handlers know this and guard for it themselves:
    // api2/locations.ts and api2/donationpoints.ts both have a
    // parseQueryLatLng() that THROWS rather than let a NaN reach here,
    // citing "which would make `isUk(NaN, NaN) === true` ... it would let
    // a garbage lat_lng return a 200 instead of erroring", and
    // wfbn/index.ts:67 tests Number.isNaN itself before calling. Those
    // three guards are only worth having while this stays true.
    expect(isUk(Number.NaN, Number.NaN)).toBe(true);
    expect(isUk(Number.NaN, -0.1278)).toBe(true); // NaN latitude alone
    expect(isUk(51.5074, Number.NaN)).toBe(true); // NaN longitude alone
  });

  it("lets NaN through by MECHANISM, not by a special case", () => {
    // The distinction the test above cannot make on its own. NaN is not
    // "accepted": it merely fails to trigger any of the four rejections,
    // so the OTHER coordinate still decides. A well-meaning
    // `if (Number.isNaN(lat) || Number.isNaN(lng)) return true;` added to
    // preserve the documented Django parity would pass the previous test
    // and fail this one -- and would be a genuine behaviour change, since
    // Django's four `if`s reject these four points.
    expect(isUk(Number.NaN, 100)).toBe(false); // other axis too far east
    expect(isUk(Number.NaN, -99)).toBe(false); // other axis too far west
    expect(isUk(100, Number.NaN)).toBe(false); // other axis too far north
    expect(isUk(-99, Number.NaN)).toBe(false); // other axis too far south
  });

  it("rejects infinities on every axis", () => {
    // Unlike NaN, infinities do compare, so the box rejects them. Worth
    // asserting alongside the NaN case so the difference between the two
    // is on the record rather than discovered by a caller.
    expect(isUk(Number.POSITIVE_INFINITY, 0)).toBe(false);
    expect(isUk(Number.NEGATIVE_INFINITY, 0)).toBe(false);
    expect(isUk(51.5074, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isUk(51.5074, Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isUk(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(false);
  });

  it("silently coerces the junk TypeScript's `number` does not stop", () => {
    // Relational operators coerce, so isUk never rejects on type. The
    // shapes that can actually reach it are worth separating, because they
    // do NOT behave alike:
    //
    //   null      -> 0, so it is rejected (accidentally safe: Null Island
    //                is outside the box, which is the same luck the "0,0"
    //                geocode sentinel relies on)
    //   ""/[]     -> 0 as well, same accidental rejection
    //   undefined -> NaN-like, so it is ACCEPTED -- and the call sites'
    //                Number.isNaN() guards do not catch undefined, so a
    //                row destructured with a missing latitude would pass
    //                the UK gate
    //   {}        -> NaN-like too, so passing a whole D1 row by mistake is
    //                accepted rather than caught
    //   "51.5074" -> parses, so a caller who forgets Number() is invisible
    //                here and only shows up as a wrong distance later
    expect(isUk(null as unknown as number, null as unknown as number)).toBe(false);
    expect(isUk("" as unknown as number, "" as unknown as number)).toBe(false);
    expect(isUk([] as unknown as number, [] as unknown as number)).toBe(false);
    expect(isUk(undefined as unknown as number, undefined as unknown as number)).toBe(true);
    expect(isUk(undefined as unknown as number, -0.1278)).toBe(true);
    expect(isUk({} as unknown as number, {} as unknown as number)).toBe(true);
    expect(isUk("51.5074" as unknown as number, "-0.1278" as unknown as number)).toBe(true);
    // A BigInt does NOT throw here -- relational operators compare BigInt
    // against Number without the mixing error that `*` raises -- so isUk
    // and miles() in this same module disagree about the same input: the
    // gate says "in the UK", the distance calculation 500s. See the
    // TypeError pinned in miles' own test.
    expect(isUk(51n as unknown as number, 0n as unknown as number)).toBe(true);
    expect(isUk(10n as unknown as number, 0n as unknown as number)).toBe(false);
  });

  it("accepts the Django-shaped single 'lat,lng' string as being in the UK", () => {
    // Django's is_uk() takes ONE "lat,lng" string and splits it itself
    // (givefood/utils/geo.py:191-206); this port takes two numbers, so a
    // mechanical port of Django call-site code -- `is_uk(lat_lng)` becoming
    // `isUk(latLng)` -- compiles away under a cast and is silently WRONG.
    // The combined string coerces to NaN, a missing second argument
    // coerces to NaN, and NaN fails all four rejections, so the mis-call
    // returns TRUE for every input including a coordinate in the Pacific.
    // This is the single most dangerous way to hold this function, so it is
    // pinned rather than left to be discovered in production.
    expect(isUk("51.5074,-0.1278" as unknown as number, 0)).toBe(true);
    expect((isUk as unknown as (s: string) => boolean)("51.5074,-0.1278")).toBe(true);
    expect((isUk as unknown as (s: string) => boolean)("-33.8688,151.2093")).toBe(true); // Sydney
    // The mechanism, stated so the test cannot be "fixed" by someone who
    // thinks the string is being parsed: it is not.
    expect(Number("51.5074,-0.1278")).toBeNaN();
  });

  it("takes (lat, lng) in that order -- swapping them is not symmetric", () => {
    // The other ordering mistake this two-argument port makes possible.
    // London swapped reads as (-0.1278, 51.5074), which is south of sw_lat
    // and east of ne_lng -- caught here, but a food bank near (0, 0)-ish
    // would not be, hence asserting the asymmetry explicitly.
    expect(isUk(51.5074, -0.1278)).toBe(true);
    expect(isUk(-0.1278, 51.5074)).toBe(false);
    // And the reason that is safe to rely on: the latitude range
    // [49.1, 61.061] and the longitude range [-14.015517, 2.0919117] do not
    // overlap, so NO accepted point survives being transposed -- the
    // swapped longitude always lands south of sw_lat. A future widening of
    // the box (say, southwards for the Channel Islands) could break that
    // property and start silently accepting transposed pairs, so assert it
    // over the whole corpus rather than on London alone.
    const insideTheBox: [number, number][] = [
      [51.5074, -0.1278], // London
      [55.9533, -3.1883], // Edinburgh
      [60.1553, -1.1453], // Lerwick
      [49.9155, -6.3164], // St Mary's
      [49.1858, -2.1043], // St Helier
      [53.3498, -6.2603], // Dublin
      [SW_LAT, SW_LNG],
      [NE_LAT, NE_LNG],
      [SW_LAT, NE_LNG],
      [NE_LAT, SW_LNG],
    ];
    for (const [lat, lng] of insideTheBox) {
      expect(isUk(lat, lng)).toBe(true);
      expect(isUk(lng, lat)).toBe(false);
    }
    // The property those pairs are evidence for, asserted directly: the two
    // ranges are disjoint, with ne_lng below sw_lat by a wide margin.
    expect(NE_LNG).toBeLessThan(SW_LAT);
  });
});
