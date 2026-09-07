import { describe, expect, it } from "vitest";
import { R_EARTHDISTANCE, R_PYTHON, haversineMeters } from "./haversine";

// These seventeen lines are the whole of the geo maths behind every search
// endpoint on the site. WP 2.5 deleted PostgreSQL's cube/earthdistance
// extension and the three GiST indexes with it (PLAN.md §7.5.1), so every
// `distance_m` and `distance_mi` the API publishes now comes out of this
// function. The contract is parity with TWO ancestors at once --
// givefood/utils/geo.py's distance_meters() for /api/1/*, and Postgres
// earth_distance() for /api/2/* -- which is why there are two radii, and why
// PLAN.md says in terms: "Keep both constants, per endpoint. Do not unify."
//
// GOLDEN VALUES: the `meters` figures in DJANGO_GOLDEN below were produced by
// running the real Django function -- givefood/utils/geo.py:distance_meters()
// -- on these coordinates in CPython. They are not numbers this
// implementation printed, so they cannot drift along with it. That is
// checkable rather than merely asserted, and it checks out: two of the four
// (London-Edinburgh, Trafalgar-Buckingham) are NOT the double V8 produces for
// the same inputs -- they sit 4.7e-10 m and 1.9e-10 m away, a few ULP, the
// signature of a different libm. A table regenerated from this implementation
// would match V8 to the bit on all four.
//
// What these tests deliberately do NOT assert is bit-for-bit equality with
// CPython. V8's Math.sin/cos/asin and CPython's libm disagree by about one
// ULP: over a 20,000-pair sweep of random UK coordinates the two agreed
// exactly only 16% of the time, worst-case relative error 1.4e-13 -- under a
// micrometre over 500 km. What has to match is what the API actually prints,
// so the tests below assert closeness as doubles AND exact equality after
// Math.trunc(), which is what api1.ts and the api2 routes emit as
// `distance_m` (PLAN.md §7.5.3: "Python int() truncates, never rounds").
// Math.trunc did not disagree once across that same 20,000-pair sweep.
//
// The OTHER ancestor -- Postgres earth_distance(), which backs every
// /api/2/*/search/ response -- is covered further down by reimplementing it
// from its documented definition (ll_to_earth + Euclidean chord) rather than
// by trusting the radius constant alone. Until that test existed, nothing in
// this file distinguished R_EARTHDISTANCE from any other number near 6.38e6.

const DJANGO_GOLDEN = [
  // A long leg, where an error in the cos(lat) term shows up loudest.
  { name: "London to Edinburgh", from: [51.5074, -0.1278], to: [55.9533, -3.1883], meters: 533317.149514746 },
  // Sub-kilometre, the range that actually decides a nearest-food-bank sort.
  { name: "Trafalgar Square to Buckingham Palace", from: [51.508, -0.1281], to: [51.5014, -0.1419], meters: 1203.7724472786583 },
  // The two ends of the UK bounding box in PLAN.md §7.5.4 -- Lerwick and the
  // Isles of Scilly, the pair most likely to expose a sign error in longitude.
  { name: "Lerwick to St Mary's", from: [60.1553, -1.145], to: [49.9145, -6.322], meters: 1183909.946407704 },
  // Across the Irish Sea: both coordinates west of the meridian, so a
  // longitude sign bug cancels out here but not in the pair above.
  { name: "Cardiff to Belfast", from: [51.4816, -3.1791], to: [54.5973, -5.9301], meters: 391926.54611172446 },
] as const;

describe("haversineMeters", () => {
  it("reproduces givefood/utils/geo.py's distance_meters() to well under a micrometre", () => {
    for (const { name, from, to, meters } of DJANGO_GOLDEN) {
      const actual = haversineMeters(from[0], from[1], to[0], to[1], R_PYTHON);
      // 1e-6 m is a micrometre: a libm ULP difference lands far inside it,
      // while a wrong radian constant, a swapped cos/sin, or a missing
      // halving of dLat lands kilometres outside.
      //
      // What this tolerance does NOT police -- and an earlier version of this
      // comment wrongly claimed it did -- is the FORM the module comment
      // insists on. Running the rejected 2*R*asin(chord/2R) route over these
      // same four pairs puts it 3.1e-10 m from the CPython golden at worst:
      // comfortably INSIDE a micrometre, and truncating to the same integer.
      // The two forms are algebraically identical and differ only in the last
      // bits, so no golden tolerance loose enough to survive V8-vs-CPython
      // ULP noise can also reject the chord form.
      //
      // The form is nonetheless pinned, just not here. What separates the two
      // is behaviour at impossible inputs: the haversine form can drive `a`
      // negative past |lat| > 90 and return NaN, while the chord form -- a
      // Euclidean distance, never negative under the sqrt -- cannot. So the
      // "impossible latitude" test near the bottom of this describe block is
      // the real discriminator. Swap the implementation to the chord form and
      // that test fails; this one does not.
      expect(Math.abs(actual - meters), name).toBeLessThan(1e-6);
    }
  });

  it("agrees with Django exactly at the whole-metre precision the API publishes", () => {
    // This is the assertion that actually protects the public contract:
    // /api/1/foodbanks/ and /api/2/*/search/ emit Math.trunc(distanceM), so
    // parity is a question about integers, not about doubles. A consumer
    // diffing v1 responses before and after the migration compares these.
    for (const { name, from, to, meters } of DJANGO_GOLDEN) {
      const actual = haversineMeters(from[0], from[1], to[0], to[1], R_PYTHON);
      expect(Math.trunc(actual), name).toBe(Math.trunc(meters));
    }
    // The loop above compares the implementation against DJANGO_GOLDEN, so a
    // regression that moved all four goldens identically -- someone
    // regenerating the table from this implementation after a bad edit --
    // would pass it. These are the same four integers written out by hand, so
    // that failure mode has to survive a second, unlinked copy of the numbers.
    // All four, not a spot-check: two of them (Lerwick-Scilly, Cardiff-Belfast)
    // were the only pairs left unpinned, and they are the two that carry the
    // longitude-sign and Irish-Sea cases the table exists for.
    expect(Math.trunc(haversineMeters(51.5074, -0.1278, 55.9533, -3.1883, R_PYTHON))).toBe(533317);
    expect(Math.trunc(haversineMeters(51.508, -0.1281, 51.5014, -0.1419, R_PYTHON))).toBe(1203);
    expect(Math.trunc(haversineMeters(60.1553, -1.145, 49.9145, -6.322, R_PYTHON))).toBe(1183909);
    expect(Math.trunc(haversineMeters(51.4816, -3.1791, 54.5973, -5.9301, R_PYTHON))).toBe(391926);
  });

  it("reads its inputs as degrees, not radians", () => {
    // The classic haversine bug, and the one a golden-value test can hide if
    // the goldens were ever regenerated from the implementation. One degree
    // of latitude is ~111 km on this sphere; feeding degrees to sin() as if
    // they were radians gives a number in the millions instead.
    const oneDegreeOfLatitude = haversineMeters(0, 0, 1, 0, R_PYTHON);
    expect(oneDegreeOfLatitude).toBeGreaterThan(111_000);
    expect(oneDegreeOfLatitude).toBeLessThan(111_200);
    // And the reverse mistake -- multiplying by 180/PI -- would shrink it.
    expect(oneDegreeOfLatitude).toBeCloseTo(111125.113, 3);
  });

  it("returns exactly zero for a point measured against itself", () => {
    // Not "close to zero": exactly zero. /api/2/foodbank/<slug>/ builds
    // `nearby_foodbanks` by ranking the whole open set from the food bank's
    // OWN coordinates and then dropping index 0 (nearest.ts `skipFirst`,
    // ported from find_foodbanks(ll, 10, True)). That only drops the right
    // row while the self-distance sorts strictly first. A formula that
    // returned 1e-9 for identical inputs would still usually work, and would
    // occasionally leave the food bank listed among its own neighbours.
    expect(haversineMeters(51.5074, -0.1278, 51.5074, -0.1278, R_PYTHON)).toBe(0);
    expect(haversineMeters(0, 0, 0, 0, R_EARTHDISTANCE)).toBe(0);
    expect(haversineMeters(-33.8688, 151.2093, -33.8688, 151.2093, R_PYTHON)).toBe(0);
    // R_EARTHDISTANCE too, at a real UK food bank's coordinates -- but NOT
    // because skipFirst runs on that sphere. It does not: the only
    // skipFirst=true call in the whole port is api2/foodbanks.ts:206, and it
    // passes R_PYTHON, because Django's Foodbank.nearby() is
    // find_foodbanks(lat_lng, 10, True) and find_foodbanks() is the
    // pure-Python leg (foodbank.py:305, noted in that route's own comment).
    // An earlier version of this comment had that backwards.
    //
    // It is asserted on the second radius because exact zero has to be a
    // property of the FORMULA rather than of one constant: `2 * R * asin(0)`
    // must be exactly 0 for every R. Pinning it only on R_PYTHON would let
    // through a change that happened to hold for one sphere -- and
    // /api/2/*/search/ is the endpoint that runs on this one, routinely
    // queried with `?lat_lng=` set to a food bank's own coordinates (that is
    // how the site's own "nearest to this food bank" links are built), where
    // PLAN.md B6 requires the first row to publish distance_mi as a literal
    // `0.0`.
    expect(haversineMeters(51.4816, -3.1791, 51.4816, -3.1791, R_EARTHDISTANCE)).toBe(0);

    // Negative zero is a live input, not a curiosity: `?lat_lng=-0,-0` and a
    // D1 column holding -0 both reach this function via Number(), and
    // Number("-0") is -0, not 0. Two things have to hold. First, -0 must not
    // be a different PLACE from 0 -- cos(-0) === cos(0) and x - (-0) === x,
    // so the whole calculation is unaffected.
    expect(haversineMeters(-0, -0, 55.9533, -3.1883, R_PYTHON)).toBe(haversineMeters(0, 0, 55.9533, -3.1883, R_PYTHON));
    // Second, the self-distance must be +0 and not -0. toBe() is Object.is(),
    // which separates them, so this assertion is doing real work: a result of
    // -0 would mean `2 * R * 0` had picked up a sign somewhere, and while -0
    // still sorts equal to 0, it would signal exactly the kind of drift in
    // the final multiply that the exact-zero guarantee rules out.
    expect(Object.is(haversineMeters(-0, -0, -0, -0, R_PYTHON), 0)).toBe(true);
  });

  it("is exactly symmetric, which is what makes the swapped argument order safe", () => {
    // Django calls distance_meters(foodbank.latt(), foodbank.long(), latt,
    // long) -- item first, query point second. nearest.ts calls
    // haversineMeters(lat, lng, itemLat, itemLng, R) -- query point FIRST.
    // The port silently relies on the two orders producing the identical
    // double; if they differed even in the last bit, two food banks at the
    // same distance could tie-break differently from Django. Exact equality,
    // not closeness, is the property being pinned.
    for (const { name, from, to } of DJANGO_GOLDEN) {
      const forwards = haversineMeters(from[0], from[1], to[0], to[1], R_PYTHON);
      const backwards = haversineMeters(to[0], to[1], from[0], from[1], R_PYTHON);
      expect(backwards, name).toBe(forwards);
    }
    // Four hand-picked UK pairs is a thin basis for an EXACT-equality claim:
    // symmetry here rests on Math.sin being exactly odd and on IEEE multiply
    // being commutative, neither of which is anything to do with the UK. So
    // sweep a deterministic global grid, on both radii, including the poles
    // and both sides of the antimeridian, where sin/cos are least well
    // behaved. 690 pairs, zero disagreements when this was written.
    for (let lat1 = -88; lat1 <= 88; lat1 += 8) {
      for (let lng1 = -175; lng1 <= 175; lng1 += 25) {
        // A deliberately lopsided partner, so the pair is never a reflection
        // that would make the two argument orders trivially identical.
        const lat2 = -lat1 * 0.7 + 3;
        const lng2 = lng1 * 0.4 - 11;
        for (const R of [R_PYTHON, R_EARTHDISTANCE]) {
          const label = `${lat1},${lng1} <-> ${lat2},${lng2} @ ${R}`;
          expect(haversineMeters(lat2, lng2, lat1, lng1, R), label).toBe(haversineMeters(lat1, lng1, lat2, lng2, R));
        }
      }
    }
  });

  it("treats R as a pure scale factor, so neither radius is baked into the maths", () => {
    // The same pair measured on both spheres must differ by exactly the ratio
    // of the radii. If someone ever "simplified" the function by folding a
    // constant radius into it and keeping the parameter for show, the /api/1
    // and /api/2 numbers would converge and this ratio would collapse to 1.
    for (const { name, from, to } of DJANGO_GOLDEN) {
      const python = haversineMeters(from[0], from[1], to[0], to[1], R_PYTHON);
      const earth = haversineMeters(from[0], from[1], to[0], to[1], R_EARTHDISTANCE);
      expect(earth / python, name).toBeCloseTo(R_EARTHDISTANCE / R_PYTHON, 12);
    }
    // R = 0 collapses the sphere to a point; nothing guards against it, and
    // the honest current behaviour is a plain zero rather than a throw.
    expect(haversineMeters(51.5074, -0.1278, 55.9533, -3.1883, 0)).toBe(0);
  });

  it("caps at exactly half the circumference for antipodal points", () => {
    // asin's argument reaches exactly 1 here, so the result is PI*R to the
    // bit. Worth pinning because it is the only input class where the
    // Math.min(1, ...) guard is anywhere near live, and because a formula
    // that overshot PI*R would mean the sqrt argument had gone out of domain.
    expect(haversineMeters(0, 0, 0, 180, R_PYTHON)).toBe(Math.PI * R_PYTHON);
    expect(haversineMeters(90, 0, -90, 0, R_PYTHON)).toBe(Math.PI * R_PYTHON);
    expect(haversineMeters(45, 0, -45, 180, R_EARTHDISTANCE)).toBe(Math.PI * R_EARTHDISTANCE);
  });

  it("never returns NaN, however close to the antipode the inputs get", () => {
    // The reason Math.min(1, Math.sqrt(a)) is there: `a` is <= 1 in exact
    // arithmetic but not in floating point, and Math.asin(x > 1) is NaN. A
    // NaN distance is not a visible crash -- it is a row that sorts into an
    // arbitrary position in nearest(), because every comparison against NaN
    // is false, so the API would quietly return the wrong ten food banks.
    //
    // (An earlier note here claimed the min() never actually fires, on the
    // grounds that Math.sqrt rounds 1 + 2 ULP back to exactly 1. It does not:
    // Math.sqrt(1.0000000000000004) is 1.0000000000000002, still above 1, and
    // Math.asin of that is NaN. The guard is load-bearing, and the test below
    // pins inputs that prove it. This sweep does not reach them because it
    // uses EXACT antipodes; the clamp fires just off exact.)
    const maximum = Math.PI * R_PYTHON;
    // A deterministic grid rather than Math.random(), so a failure is
    // reproducible rather than a once-a-month mystery in CI.
    for (let lat = -90; lat <= 90; lat += 2.5) {
      for (let lng = -180; lng <= 180; lng += 7.5) {
        const antipodeLng = lng > 0 ? lng - 180 : lng + 180;
        const d = haversineMeters(lat, lng, -lat, antipodeLng, R_PYTHON);
        expect(Number.isFinite(d), `${lat},${lng}`).toBe(true);
        expect(d, `${lat},${lng}`).toBeLessThanOrEqual(maximum);
        // Lower bound as well as upper, because "finite and <= PI*R" is
        // satisfied by a function that returns 0 for everything -- this sweep
        // was, on its own, passable by a stub. Antipodal points are BY
        // DEFINITION half a circumference apart, so the honest assertion is
        // that each one lands ON the maximum. The tolerance is one metre out
        // of 20,000 km: asin has an infinite derivative at 1, so an `a` short
        // of 1 by a couple of ULP costs a fraction of a metre (worst observed
        // deficit across this exact grid: 0.19 m). Anything that actually
        // broke the formula misses by kilometres.
        expect(d, `${lat},${lng}`).toBeGreaterThan(maximum - 1);
      }
    }
    // The specific pair found to push the intermediate sum to 1 + 2 ULP.
    expect(haversineMeters(43.60485034430795, 64.196431470632, -43.60485034430795, -115.803568529368, R_PYTHON)).toBe(
      maximum,
    );
  });

  it("clamps sqrt(a) at 1, on the near-antipodal inputs where it genuinely overshoots", () => {
    // The module's only defensive line is `Math.min(1, Math.sqrt(a))`, with
    // the comment "FP drift can push sqrt(a) fractionally over 1 at distance
    // 0". Nothing tested it, and the exact-antipode sweep above cannot: at a
    // true antipode `a` lands on 1 and the min() is a no-op. Delete the
    // Math.min and every test in this file still passed.
    //
    // These pairs are the counter-example. They are near-antipodal, offset by
    // a nanodegree in latitude, which is where the two nearly-equal terms of
    // `a` sum to 1.0000000000000004 -- 1 + 2 ULP. Math.sqrt of that is
    // 1.0000000000000002, which is STILL above 1, and Math.asin(x > 1) is
    // NaN. Found by scanning ~12M near-antipodal pairs; 784 of them overshoot,
    // so this is rare rather than impossible, and `?lat_lng=` takes any two
    // numbers a caller cares to send.
    //
    // Why it matters beyond tidiness: a NaN distance is invisible. It does
    // not throw. It flows into nearest(), where every comparison against NaN
    // is false, so the row keeps whatever position the input order gave it
    // and can surface inside the top ten -- and JSON.stringify writes it out
    // as `null`, not as an error.
    const clampFiring: [number, number, number, number][] = [
      [-70.712, -78.328, 70.712000001, 101.672],
      [-65.247, -0.992999999999995, 65.247000001, 179.007],
      [-58.939, -87.941, 58.939000001, 92.059],
    ];
    for (const [lat1, lng1, lat2, lng2] of clampFiring) {
      const label = `${lat1},${lng1} -> ${lat2},${lng2}`;
      const d = haversineMeters(lat1, lng1, lat2, lng2, R_PYTHON);
      expect(d, label).not.toBeNaN();
      // Half a circumference, exactly -- asin(1) is PI/2 to the bit.
      expect(d, label).toBe(Math.PI * R_PYTHON);
    }
    // Guard the guard: if V8's Math.sin/cos/sqrt ever changed enough that
    // these pairs stopped overshooting, the assertions above would still pass
    // while quietly testing nothing. This fails loudly in that case, so the
    // pairs get refreshed rather than silently rotting into decoration.
    //
    // Run over ALL THREE pairs, not just the first. Two of the three were
    // unguarded before, which is the same rot in miniature: pairs 2 and 3
    // exist so the test does not rest on one coordinate, and that is only
    // true while each of them is independently still overshooting.
    const rad = Math.PI / 180;
    const sqrtA = ([lat1, lng1, lat2, lng2]: [number, number, number, number]) =>
      Math.sqrt(
        Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
          Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2,
      );
    for (const pair of clampFiring) {
      expect(sqrtA(pair), `${pair} no longer overshoots -- refresh the pairs`).toBeGreaterThan(1);
      // And that the overshoot is genuinely fatal without the clamp, rather
      // than something Math.asin would absorb: this is the NaN the guard
      // exists to stop.
      expect(Math.asin(sqrtA(pair))).toBeNaN();
    }

    // The module's comment gives the WRONG reason for its own guard: "FP drift
    // can push sqrt(a) fractionally over 1 at distance 0". At distance 0 the
    // drift does not exist -- dLat and dLng are exactly 0, sin(0) is exactly
    // 0, so `a` is exactly 0 and sqrt(a) is exactly 0, nowhere near 1. The
    // overshoot happens at the OTHER end of the range, half a circumference
    // away, which is why the pairs above are near-antipodal.
    //
    // Pinned rather than corrected because the fix belongs in the source
    // comment, not here (see the note in the review). It matters practically:
    // anyone trusting that comment would conclude the guard only ever fires on
    // self-distances, and might "simplify" it to a distance-0 special case --
    // which is exactly the shape of edit these three pairs then catch.
    const selfPoints: [number, number][] = [
      [51.5074, -0.1278],
      [-33.8688, 151.2093],
      [89.9999, 179.9999],
      [0, 0],
    ];
    for (const [lat, lng] of selfPoints) {
      expect(sqrtA([lat, lng, lat, lng]), `self-distance at ${lat},${lng}`).toBe(0);
    }
  });

  it("takes the short way across the antimeridian rather than the long way round", () => {
    // sin(dLng/2)**2 is invariant under a full turn, so a 359.8-degree
    // longitude gap is measured as the 0.2 degrees it really is. Nothing in
    // the UK needs this, but /api/1/foodbanks/?lat_lng= accepts any pair of
    // numbers a caller sends, and a 20,000 km answer for two points 22 km
    // apart would be a spectacular way to fail.
    const acrossTheLine = haversineMeters(0, 179.9, 0, -179.9, R_PYTHON);
    const sameGapNoWrap = haversineMeters(0, 0, 0, 0.2, R_PYTHON);
    expect(acrossTheLine).toBeCloseTo(sameGapNoWrap, 6);
    // Anchor the pair to a number computed from geometry rather than from the
    // module: along the equator the great-circle distance is just R times the
    // longitude gap in radians. Comparing the wrapped case only against the
    // unwrapped one is a RELATIVE check -- an implementation with the whole
    // result scaled by a half would keep them equal to each other, and the
    // old `< 23_000` upper bound waved 11,112 m through. This does not.
    const equatorialArc = R_PYTHON * 0.2 * (Math.PI / 180);
    expect(equatorialArc).toBeCloseTo(22225.0227, 4); // ~22.2 km, for the reader
    expect(sameGapNoWrap).toBeCloseTo(equatorialArc, 9);
    expect(acrossTheLine).toBeCloseTo(equatorialArc, 6);
  });

  it("brings a full 360-degree turn back to a nanometre of zero, but not to zero", () => {
    // (360 - 0) * (PI/180) is not exactly 2*PI in binary floating point, so
    // the same point addressed as lng -0.12 and lng 359.88 comes back at
    // ~1e-9 m rather than 0. Documented rather than fixed: it is a billionth
    // of a metre, it truncates to 0 in the API response, and the exact-zero
    // guarantee that skipFirst depends on holds for the identical-argument
    // case tested above, which is the only case that arises in practice.
    const wrapped = haversineMeters(51.5, -0.12, 51.5, 359.88, R_PYTHON);
    expect(wrapped).toBeGreaterThan(0);
    expect(wrapped).toBeLessThan(1e-8);
    expect(Math.trunc(wrapped)).toBe(0);
  });

  it("propagates NaN from a missing coordinate instead of substituting zero", () => {
    // Current behaviour, pinned as documentation rather than endorsed: the
    // function does no validation, exactly like its Django ancestor. A row
    // whose latitude is NULL in D1 becomes a NaN distance, and because every
    // comparison with NaN is false, Array.prototype.sort leaves that row
    // roughly where it started rather than pushing it to the end -- so it can
    // surface INSIDE the top ten. Callers, not this function, must filter
    // coordinate-less rows out of the candidate set.
    expect(haversineMeters(NaN, -0.1278, 55.9533, -3.1883, R_PYTHON)).toBeNaN();
    expect(haversineMeters(51.5074, NaN, 55.9533, -3.1883, R_PYTHON)).toBeNaN();
    expect(haversineMeters(51.5074, -0.1278, NaN, -3.1883, R_PYTHON)).toBeNaN();
    expect(haversineMeters(51.5074, -0.1278, 55.9533, NaN, R_PYTHON)).toBeNaN();
    expect(haversineMeters(51.5074, -0.1278, 55.9533, -3.1883, NaN)).toBeNaN();
    // undefined and null arrive here from an untyped D1 row just as easily as
    // NaN does; undefined coerces to NaN, but null coerces to 0, so a null
    // latitude silently measures from the equator instead of failing loudly.
    const undef = undefined as unknown as number;
    expect(haversineMeters(undef, -0.1278, 55.9533, -3.1883, R_PYTHON)).toBeNaN();
    // The null case has to be measured against a DISTANT second point. The
    // obvious spelling -- haversineMeters(null, 0, 0, 0) === 0 -- proves
    // nothing, because 0 is also what a defensive `if (lat === null) return 0`
    // would return, and those two behaviours are opposites in production: one
    // measures from the equator (a wrong but ordinary distance, sorted like
    // any other), the other reports distance zero and sorts the broken row
    // FIRST, straight to the top of every search response. Edinburgh is 6,224
    // km from (0, 0), so the two are 6,224 km apart here.
    const nul = null as unknown as number;
    expect(haversineMeters(nul, 0, 55.9533, -3.1883, R_PYTHON)).toBe(haversineMeters(0, 0, 55.9533, -3.1883, R_PYTHON));
    expect(Math.trunc(haversineMeters(nul, 0, 55.9533, -3.1883, R_PYTHON))).toBe(6224473);
    // Infinity is likewise not special-cased.
    expect(haversineMeters(Infinity, 0, 0, 0, R_PYTHON)).toBeNaN();
  });

  it("keeps absurd but finite coordinates finite, and names the one finite input that does not", () => {
    // /api/1/foodbanks/?lat_lng= parses with Number() and does not bound the
    // result, so `?lat_lng=1e300,1e300` reaches this function. The module's
    // standing invariant is "never NaN", and the sweep above only exercises
    // sane latitudes -- this pins the far end of the input domain, where
    // argument reduction inside Math.sin is doing the heavy lifting.
    const maximum = Math.PI * R_PYTHON;
    const absurd: [number, number, number, number][] = [
      [0, 0, 0, 1e15],
      [0, 0, 0, 1e300],
      [0, 0, 1e15, 0],
      [0, 0, 0, Number.MAX_VALUE],
      [Number.MAX_VALUE, 0, 0, 0],
      [0, 0, 0, -1e15],
    ];
    for (const [lat1, lng1, lat2, lng2] of absurd) {
      const d = haversineMeters(lat1, lng1, lat2, lng2, R_PYTHON);
      const label = `${lat1},${lng1} -> ${lat2},${lng2}`;
      // Garbage in, garbage out -- but bounded garbage. sin/cos stay in
      // [-1,1] however large the angle, so `a` stays in [0,1] and the answer
      // is a real distance on the sphere, just a meaningless one.
      expect(Number.isFinite(d), label).toBe(true);
      expect(d, label).toBeGreaterThanOrEqual(0);
      expect(d, label).toBeLessThanOrEqual(maximum);
    }

    // The exception, and the honest limit of the "never NaN" invariant: it is
    // the DIFFERENCE that has to stay finite, not the inputs. Opposite-signed
    // extremes overflow (lat2 - lat1 === -Infinity), and sin(-Infinity) is
    // NaN, which then survives sqrt/min/asin untouched. Recorded so nobody
    // reads the loop above as a promise the function cannot keep.
    expect(haversineMeters(1e308, 1e308, -1e308, -1e308, R_PYTHON)).toBeNaN();
  });

  it("does not normalise out-of-range latitudes, matching Django's lack of validation", () => {
    // Geographically, (100, 0) is the same place as (80, 180) -- over the
    // pole. This function does no such normalisation: it treats 100 as a
    // plain number, so the pair reads as 20 degrees of latitude apart. Django
    // did not validate either, so this is parity, not a fix waiting to
    // happen; it is recorded here so that nobody "corrects" it and quietly
    // changes what the API returns for junk `?lat_lng=` input.
    // 100 and 80 are read as 20 degrees of latitude apart, giving the same
    // answer as a plain 20-degree meridian arc.
    expect(haversineMeters(100, 0, 80, 0, R_PYTHON)).toBe(haversineMeters(0, 0, 20, 0, R_PYTHON));
    expect(haversineMeters(100, 0, 80, 0, R_PYTHON)).toBeCloseTo(2222502.269, 3);
  });

  it("returns NaN, not a distance, where an impossible latitude makes the intermediate negative", () => {
    // The one case the Math.min(1, ...) guard does NOT cover: it clamps the
    // top of the range only. Past +/-90 degrees cos(lat) turns negative, so
    // the cos(lat1)*cos(lat2)*sin(dLng/2)**2 term subtracts instead of adding
    // and floating-point error can leave the sum a hair BELOW zero
    // (-9.2e-19 for the pair below). Math.sqrt of that is NaN, and NaN
    // survives Math.min and Math.asin untouched.
    //
    // This is a genuine divergence from the Django ancestor, verified by
    // running givefood/utils/geo.py:distance_meters(91, 0, 89, 180) in
    // CPython: math.sqrt raises "ValueError: math domain error" there, so
    // Django 500s where the Worker instead ranks the row with a NaN distance
    // and JSON.stringify writes it out as null. Only reachable through
    // unvalidated `?lat_lng=` input with |lat| > 90, so it is documented here
    // rather than papered over -- changing it would change API behaviour.
    expect(haversineMeters(91, 0, 89, 180, R_PYTHON)).toBeNaN();
    // Inside the real latitude range this cannot happen: cos(lat) >= 0 for
    // |lat| <= 90, so every term is non-negative and the sum cannot go under
    // zero. The antipodal sweep above is the standing proof of that.
    expect(haversineMeters(89, 0, -89, 180, R_PYTHON)).not.toBeNaN();
    // Both radii, because this is also the assertion that pins the FORM (see
    // the golden-value test at the top): a chord-based implementation builds
    // 3-D Cartesian points and takes a Euclidean distance, which has nothing
    // that can go negative under a sqrt, so it returns a real number here
    // instead of NaN. That makes these four lines the only thing in the file
    // standing between /api/1 and a silent switch to the rejected form.
    expect(haversineMeters(91, 0, 89, 180, R_EARTHDISTANCE)).toBeNaN();
    // A second, independent overshoot pair, so the discriminator does not
    // rest on one coordinate that a future V8 might round differently.
    expect(haversineMeters(-91, 0, -89, 180, R_PYTHON)).toBeNaN();
  });
});

// The /api/1 ancestor is pinned by CPython golden values above. The /api/2
// ancestor -- Postgres `earth_distance()` from the cube/earthdistance
// extension that WP 2.5 deleted -- had no equivalent, so R_EARTHDISTANCE was
// only ever checked against R_PYTHON. These two helpers rebuild it from the
// definition PLAN.md §7.5.1 gives: "ll_to_earth(lat,lng) maps to 3-D
// Cartesian metres on a sphere of R = 6,378,168 m, and earth_distance() is
// exactly haversine on that sphere", with the note that Postgres computes it
// as `2*R*asin(chord/2R)` from the straight-line chord between the two
// Cartesian points. That is a genuinely different algebraic route -- no
// sin(dLat/2), no cos(lat1)*cos(lat2) -- so agreement is evidence, not
// construction. (It is also the exact form the module comment rejects for
// /api/1, which makes this the one place the size of that difference is
// actually measured.)
// Postgres's own sphere radius, written out as a literal on purpose. Reading
// R_EARTHDISTANCE here instead would make the whole comparison circular --
// both sides would move together and the test could never fail on a wrong
// constant. This 6378168 is the earthdistance extension's EARTH_RADIUS, a
// golden value from the ancestor system in exactly the way the CPython
// `meters` figures above are.
const PG_SPHERE_R = 6378168;

function llToEarth(lat: number, lng: number): [number, number, number] {
  const phi = lat * (Math.PI / 180);
  const lambda = lng * (Math.PI / 180);
  return [PG_SPHERE_R * Math.cos(phi) * Math.cos(lambda), PG_SPHERE_R * Math.cos(phi) * Math.sin(lambda), PG_SPHERE_R * Math.sin(phi)];
}

// The straight-line distance through the Earth: what Postgres's `<->`
// operator returns and what `ORDER BY` in the deleted GiST queries sorted on.
function chordMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const [x1, y1, z1] = llToEarth(lat1, lng1);
  const [x2, y2, z2] = llToEarth(lat2, lng2);
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2 + (z1 - z2) ** 2);
}

function postgresEarthDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return 2 * PG_SPHERE_R * Math.asin(Math.min(1, chordMeters(lat1, lng1, lat2, lng2) / (2 * PG_SPHERE_R)));
}

// A deterministic scatter of points across the UK bounding box from
// PLAN.md §7.5.4. Jittered rather than a regular grid, because a regular grid
// is full of exactly-equidistant points and the ordering test below would
// then be measuring tie-break order rather than distance. A seeded LCG, not
// Math.random(), so a failure is reproducible.
const UK_POINTS: [number, number][] = (() => {
  let seed = 1;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: 40 }, () => [49.1 + next() * 11.96, -14.015517 + next() * 16.107] as [number, number]);
})();

describe("parity with Postgres earth_distance(), the /api/2 ancestor", () => {
  // Guard the corpus, for the same reason the clamp test guards its pairs.
  // Everything below rests on claims about UK_POINTS that nothing checked:
  // "40 points", "1,600 pairs", "jittered rather than a regular grid, because
  // a regular grid is full of exactly-equidistant points and the ordering test
  // would then be measuring tie-break order rather than distance". If the
  // corpus ever collapsed -- and it easily could, because that LCG is not the
  // textbook one its constants suggest: `seed * 1103515245` is 1.2e18 on the
  // very first step, past 2^53, so every value after it is the double-rounded
  // remains of the real recurrence -- the sweeps would still be green while
  // comparing one point against itself 1,600 times.
  it("draws a corpus that actually spreads across the UK, with no ties to hide behind", () => {
    expect(UK_POINTS).toHaveLength(40);
    expect(new Set(UK_POINTS.map((p) => p.join(","))).size).toBe(40);
    // Inside the is_uk() box of PLAN.md §7.5.4, written out as literals for
    // the same reason PG_SPHERE_R is: importing isUk() would make this agree
    // with uk.ts rather than with the plan. These are the real UK, so the
    // parity sweep is measuring the coordinates the endpoints actually see.
    for (const [lat, lng] of UK_POINTS) {
      const label = `${lat},${lng}`;
      expect(lat >= 49.1 && lat <= 61.061, label).toBe(true);
      expect(lng >= -14.015517 && lng <= 2.0919117, label).toBe(true);
    }
    // Genuinely scattered, not clustered in one county: the golden pairs cover
    // the long legs, so this corpus has to cover the width of the country for
    // the two tests below to mean anything.
    const lats = UK_POINTS.map((p) => p[0]);
    const lngs = UK_POINTS.map((p) => p[1]);
    expect(Math.max(...lats) - Math.min(...lats)).toBeGreaterThan(10);
    expect(Math.max(...lngs) - Math.min(...lngs)).toBeGreaterThan(14);

    for (let i = 0; i < UK_POINTS.length; i++) {
      const [queryLat, queryLng] = UK_POINTS[i]!;
      const label = `query ${queryLat},${queryLng}`;
      const greatCircle = UK_POINTS.map(([lat, lng]) => haversineMeters(queryLat, queryLng, lat, lng, R_EARTHDISTANCE));
      const chord = UK_POINTS.map(([lat, lng]) => chordMeters(queryLat, queryLng, lat, lng));
      // No exact ties on either measure. With a tie, BOTH sorts below would
      // fall back to V8's sort stability and agree for a reason that has
      // nothing to do with the monotonicity PLAN.md §7.5.1 is claiming.
      // Tightest margin measured when this was written: two neighbours 8.4 m
      // apart in distance from the same query point -- nine orders of
      // magnitude above the nanometre the two routes disagree by, so the
      // ordering test cannot flip on rounding either.
      expect(new Set(greatCircle).size, label).toBe(40);
      expect(new Set(chord).size, label).toBe(40);
      // And the chord ordering is never the array's own order, so the
      // ordering test cannot pass by both sides being no-ops -- which is
      // exactly what would happen against an implementation that returned a
      // constant, since a stable sort leaves a constant comparator's input
      // untouched.
      const byChord = [...UK_POINTS.keys()].sort((a, b) => chord[a]! - chord[b]!);
      expect(byChord.join(","), label).not.toBe([...UK_POINTS.keys()].join(","));
      // Every point's own nearest neighbour is itself, at exactly zero.
      expect(byChord[0], label).toBe(i);
      expect(greatCircle[i], label).toBe(0);
    }
  });

  it("reproduces earth_distance() to under two nanometres across the UK", () => {
    // This is the assertion that gives R_EARTHDISTANCE a reason to exist.
    // Every other test of it in this file measures it AGAINST R_PYTHON -- the
    // 0.175% ratio, the 935 m gap -- which pins the pair's spacing but says
    // nothing about whether the pair sits where Postgres sat. Move both
    // constants together and those tests still pass; this one does not, and
    // neither does it if R_EARTHDISTANCE alone drifts to 6378137, the WGS84
    // semi-major axis and the easiest wrong number to reach for here.
    let worst = 0;
    for (const [lat1, lng1] of UK_POINTS) {
      for (const [lat2, lng2] of UK_POINTS) {
        const ours = haversineMeters(lat1, lng1, lat2, lng2, R_EARTHDISTANCE);
        const postgres = postgresEarthDistance(lat1, lng1, lat2, lng2);
        worst = Math.max(worst, Math.abs(ours - postgres));
        // Whole metres are what the API publishes, so integer equality is
        // the actual contract; a consumer diffing /api/2 search responses
        // against the pre-migration Postgres output compares these.
        expect(Math.trunc(ours), `${lat1},${lng1} -> ${lat2},${lng2}`).toBe(Math.trunc(postgres));
      }
    }
    // 1,600 pairs. Measured worst-case divergence when written: 1.98e-9 m.
    // Bounded at 1e-6 m so ULP noise cannot make this flaky, while still
    // sitting nine orders of magnitude below the published precision. This
    // number is also the honest answer to "how much does the haversine form
    // differ from the chord form the module rejects" -- nanometres.
    expect(worst).toBeLessThan(1e-6);
    expect(worst).toBeGreaterThan(0); // they are genuinely different routes
  });

  it("also matches on the four golden pairs, on the /api/2 sphere", () => {
    // The golden pairs exist to test R_PYTHON, but they are the long legs and
    // the sub-kilometre leg, so they are worth re-running here: the UK
    // scatter above is all mid-range, and the cos(lat) term misbehaves most
    // at the extremes (Lerwick to Scilly spans the whole country).
    for (const { name, from, to } of DJANGO_GOLDEN) {
      const ours = haversineMeters(from[0], from[1], to[0], to[1], R_EARTHDISTANCE);
      expect(ours, name).toBeCloseTo(postgresEarthDistance(from[0], from[1], to[0], to[1]), 6);
    }
    // And the literal, so a change that shifted every /api/2 distance by the
    // same amount still cannot pass: London to Edinburgh is 935 m longer on
    // the earthdistance sphere than on the Python one.
    expect(Math.trunc(haversineMeters(51.5074, -0.1278, 55.9533, -3.1883, R_EARTHDISTANCE))).toBe(534252);
  });

  it("ranks points in the same order as the chord operator Postgres sorted on", () => {
    // PLAN.md §7.5.1 justifies deleting the GiST indexes on this invariant:
    // "The `<->` operator used for ORDER BY is *chord* distance, which is
    // monotonic in great-circle distance, so ordering is provably identical
    // while the reported value stays a true metre distance." Every nearest-N
    // response depends on it and nothing asserted it. If it failed, /api/2
    // search would return the right distances in the wrong ORDER -- the kind
    // of regression that looks fine in a spot check of one response.
    for (const [queryLat, queryLng] of UK_POINTS) {
      const indices = UK_POINTS.map((_, i) => i);
      const byGreatCircle = [...indices].sort(
        (a, b) =>
          haversineMeters(queryLat, queryLng, UK_POINTS[a]![0], UK_POINTS[a]![1], R_EARTHDISTANCE) -
          haversineMeters(queryLat, queryLng, UK_POINTS[b]![0], UK_POINTS[b]![1], R_EARTHDISTANCE),
      );
      const byChord = [...indices].sort(
        (a, b) =>
          chordMeters(queryLat, queryLng, UK_POINTS[a]![0], UK_POINTS[a]![1]) -
          chordMeters(queryLat, queryLng, UK_POINTS[b]![0], UK_POINTS[b]![1]),
      );
      expect(byGreatCircle.join(","), `query ${queryLat},${queryLng}`).toBe(byChord.join(","));
    }
  });
});

describe("R_PYTHON and R_EARTHDISTANCE", () => {
  it("differ by the 0.175% PLAN.md refuses to unify away", () => {
    // PLAN.md §7.5.1: "The two radii differ by 0.175%... Keep both constants,
    // per endpoint. Do not unify." Asserted as a ratio rather than by
    // restating the two literals, so this test says something the constant
    // declarations do not already say.
    const divergencePercent = ((R_EARTHDISTANCE - R_PYTHON) / R_PYTHON) * 100;
    expect(divergencePercent).toBeCloseTo(0.1754, 4);
    expect(R_EARTHDISTANCE).toBeGreaterThan(R_PYTHON);
  });

  it("are not interchangeable: swapping them moves a real answer by most of a kilometre", () => {
    // 0.175% sounds ignorable until it is metres in a published response.
    // London to Edinburgh differs by 935 m between the two spheres -- three
    // orders of magnitude above the whole-metre precision `distance_m` is
    // printed at, so using the /api/2 radius on /api/1 (or the reverse) is
    // instantly visible to any consumer diffing against the Django output.
    const onPythonSphere = haversineMeters(51.5074, -0.1278, 55.9533, -3.1883, R_PYTHON);
    const onEarthdistanceSphere = haversineMeters(51.5074, -0.1278, 55.9533, -3.1883, R_EARTHDISTANCE);
    expect(onEarthdistanceSphere - onPythonSphere).toBeCloseTo(935.46, 2);
  });

  it("pick out their own endpoint's golden value: R_PYTHON is the one geo.py used", () => {
    // Which constant belongs to which endpoint is the single easiest thing to
    // get backwards in this file, and TypeScript cannot catch it -- both are
    // `number`. So identify R_PYTHON by BEHAVIOUR: it, and only it, lands on
    // the value CPython's distance_meters() returned for this pair.
    const { from, to, meters } = DJANGO_GOLDEN[0];
    expect(Math.abs(haversineMeters(from[0], from[1], to[0], to[1], R_PYTHON) - meters)).toBeLessThan(1e-6);
    expect(Math.abs(haversineMeters(from[0], from[1], to[0], to[1], R_EARTHDISTANCE) - meters)).toBeGreaterThan(900);
  });
});
