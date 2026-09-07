import { describe, expect, it, vi } from "vitest";
import { nearest, type Ranked } from "./nearest";
import { haversineMeters, R_EARTHDISTANCE, R_PYTHON } from "./haversine";

// nearest() is the single ranking primitive behind all four API search
// endpoints, the /needs/ index page and `nearby_foodbanks`. Between them
// those were 13.7 million Postgres KNN queries in 16 days (PLAN.md
// §2.4.4), so every one of them is now a call into this 10-line function.
// Two things about it are load-bearing and neither is obvious from the
// code:
//
//   1. the slice arithmetic. Django writes `quantity = quantity + 1` then
//      `sorted[1:quantity]` for skip_first; this writes `start + quantity`.
//      They agree, and a "tidy-up" to the intuitive `slice(1, quantity)`
//      would silently return 9 nearby food banks instead of 10 on every
//      /api/2/foodbank/<slug>/ response. Checked against a transcription
//      of the Python, over every list size and quantity, rather than at
//      one convenient example -- see "matches Django's
//      first_item/quantity+1 window".
//   2. the claim in the module comment that one global sort+slice is
//      contract-exact for the two-independently-capped-then-merged Python
//      querysets. That is PLAN.md §7.5.2's proof, and the test below
//      re-derives it against an independent model of the Python algorithm
//      rather than restating it.

// A deliberately dull item type: nearest() is generic and must not care
// what shape the caller's rows are, only what getLatLng returns.
type Point = { name: string; lat: number; lng: number };
const coords = (p: Point): readonly [number, number] => [p.lat, p.lng];
const names = (ranked: Ranked<Point>[]) => ranked.map((r) => r.item.name);

// Real UK coordinates, so the distances in these tests are the sort of
// numbers the endpoints actually publish. Origin is central London.
const LONDON: readonly [number, number] = [51.5074, -0.1278];
const CROYDON: Point = { name: "croydon", lat: 51.3762, lng: -0.0982 };
const WATFORD: Point = { name: "watford", lat: 51.6565, lng: -0.3903 };
const OXFORD: Point = { name: "oxford", lat: 51.752, lng: -1.2577 };
const MANCHESTER: Point = { name: "manchester", lat: 53.4808, lng: -2.2426 };
const EDINBURGH: Point = { name: "edinburgh", lat: 55.9533, lng: -3.1883 };
const UK: Point[] = [MANCHESTER, EDINBURGH, CROYDON, OXFORD, WATFORD];
// The full distance ordering of UK from LONDON, written out once so the
// tests below can assert an ORDER rather than only "the two calls agree
// with each other" -- see the radius-parity test for why that distinction
// matters.
const UK_BY_DISTANCE = ["croydon", "watford", "oxford", "manchester", "edinburgh"];

// Twelve points strung north along a meridian from MERIDIAN_ORIGIN, so
// distance is strictly monotonic in the index: p0 is nearest, p11 furthest,
// no ties. That lets the tests below state the expected ranking by NAME,
// without recomputing any haversine -- a reference order that cannot drift
// with the implementation it is checking.
const MERIDIAN_ORIGIN: readonly [number, number] = [51.5, 0];
const meridian: Point[] = Array.from({ length: 12 }, (_, i) => ({
  name: `p${i}`,
  lat: 51.5 + (i + 1) * 0.017,
  lng: 0,
}));
const meridianNames = meridian.map((p) => p.name);

describe("nearest", () => {
  it("returns the closest `quantity` items, nearest first", () => {
    // The documented happy path. Input order is deliberately scrambled
    // relative to distance so a no-op sort cannot pass this.
    const ranked = nearest(UK, LONDON[0], LONDON[1], coords, 3, R_EARTHDISTANCE);
    expect(names(ranked)).toEqual(["croydon", "watford", "oxford"]);
  });

  it("reports a real great-circle distance in metres, not a sort key", () => {
    // Callers publish `distance_m`/`distance_mi` straight from this field
    // (api1.ts, api2/*.ts), so it has to be the true metre distance and
    // not, say, the chord distance Postgres' `<->` operator orders by --
    // PLAN.md §7.5.1 keeps those separate on purpose.
    const ranked = nearest([CROYDON], LONDON[0], LONDON[1], coords, 1, R_EARTHDISTANCE)[0]!;
    expect(ranked.distanceM).toBe(haversineMeters(LONDON[0], LONDON[1], CROYDON.lat, CROYDON.lng, R_EARTHDISTANCE));
    // Croydon is ~15 km from Charing Cross. A units slip (km, miles,
    // radians) would land orders of magnitude outside this.
    expect(ranked.distanceM).toBeGreaterThan(14_000);
    expect(ranked.distanceM).toBeLessThan(16_000);
  });

  it("emits distances in non-decreasing order, whatever the input order", () => {
    // The invariant every consumer relies on when it renders "nearest
    // first" without re-sorting -- and that findLocationsByCategory.ts
    // leans on harder than that: it applies Django's 20 km ceiling AFTER
    // the slice, on the argument that "a threshold filter over a
    // distance-ascending list commutes with taking its head". That is only
    // true while this list really is distance-ascending.
    //
    // Asserting `distances` equals its own sorted copy would pass on an
    // empty or single-element result and says nothing about WHICH items
    // came back, so pin the actual ranking as well, from a deliberately
    // reversed input.
    const ranked = nearest([...UK].reverse(), LONDON[0], LONDON[1], coords, UK.length, R_EARTHDISTANCE);
    expect(names(ranked)).toEqual(UK_BY_DISTANCE);
    const distances = ranked.map((r) => r.distanceM);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    // Strictly increasing here (no two UK cities are equidistant from
    // London), which rules out a comparator that collapses distinct
    // distances to "equal" and leaves the input order showing through.
    for (let i = 1; i < distances.length; i++) expect(distances[i]!).toBeGreaterThan(distances[i - 1]!);
  });

  it("threads the radius through rather than hardcoding one", () => {
    // PLAN.md §7.5: "The two radii differ by 0.175%... Keep both
    // constants, per endpoint. Do not unify." /api/1/ and /api/2/ publish
    // measurably different distances for the same pair of points and
    // consumers may diff them. If nearest() ever closed over a single R,
    // this test is what notices.
    const viaPython = nearest([MANCHESTER], LONDON[0], LONDON[1], coords, 1, R_PYTHON)[0]!;
    const viaEarthdistance = nearest([MANCHESTER], LONDON[0], LONDON[1], coords, 1, R_EARTHDISTANCE)[0]!;
    expect(viaPython.distanceM).not.toBe(viaEarthdistance.distanceM);
    const spread = (viaEarthdistance.distanceM - viaPython.distanceM) / viaPython.distanceM;
    // The 0.175% PLAN.md quotes, as a sanity bracket a reader can check by
    // eye...
    expect(spread).toBeGreaterThan(0.0017);
    expect(spread).toBeLessThan(0.0018);
    // ...and then the exact claim, derived from the constants rather than
    // from a hand-rounded 0.00175. haversineMeters is `2 * R * asin(a)`,
    // i.e. R only ever SCALES the result, so the two distances must stand
    // in exactly the ratio of the two radii, to the last few bits. That is
    // what makes the "same ordering under either radius" corollary below
    // safe. An R that leaked into the angle -- into `a` rather than the
    // multiplier -- would still land inside the 0.0017..0.0018 bracket
    // above but would miss this by orders of magnitude.
    expect(viaEarthdistance.distanceM / viaPython.distanceM).toBeCloseTo(R_EARTHDISTANCE / R_PYTHON, 12);
  });

  it("produces the same ordering under either radius", () => {
    // The corollary of the above, and the reason the radius split is safe:
    // scaling every distance by a constant cannot reorder them, so
    // /api/1/ and /api/2/ disagree about metres but never about which food
    // bank is nearest.
    //
    // Comparing the two calls only to EACH OTHER would pass just as
    // happily if nearest() ignored both radii and handed back the input
    // order, so pin both against the known ranking.
    const byPython = names(nearest(UK, LONDON[0], LONDON[1], coords, UK.length, R_PYTHON));
    const byEarthdistance = names(nearest(UK, LONDON[0], LONDON[1], coords, UK.length, R_EARTHDISTANCE));
    expect(byPython).toEqual(UK_BY_DISTANCE);
    expect(byEarthdistance).toEqual(UK_BY_DISTANCE);
    expect(byPython).toEqual(byEarthdistance);
  });

  describe("skipFirst", () => {
    it("still returns `quantity` items, matching Django's quantity+1", () => {
      // givefood/utils/geo.py find_foodbanks(): `if skip_first: first_item
      // = 1; quantity = quantity + 1` then `sorted_foodbanks[first_item:
      // quantity]` -- i.e. [1:11] for quantity=10, which is TEN items.
      // This module spells the same arithmetic as `start + quantity`.
      // The bug this guards: `slice(1, quantity)` returns nine, and every
      // /api/2/foodbank/<slug>/ response quietly loses a nearby food bank.
      const withoutSkip = nearest(UK, LONDON[0], LONDON[1], coords, 3, R_EARTHDISTANCE, false);
      const withSkip = nearest(UK, LONDON[0], LONDON[1], coords, 3, R_EARTHDISTANCE, true);
      expect(withoutSkip).toHaveLength(3);
      expect(withSkip).toHaveLength(3);
    });

    it("drops exactly the first item and shifts the window one along", () => {
      expect(names(nearest(UK, LONDON[0], LONDON[1], coords, 3, R_EARTHDISTANCE, true))).toEqual([
        "watford",
        "oxford",
        "manchester",
      ]);
    });

    it("defaults to false, because every API search endpoint needs it false", () => {
      // The default is what /api/1/foodbanks/search/, /api/2/*/search/ and
      // the /needs/ index page all rely on -- a caller that forgets the
      // argument must get the un-skipped window, not a silently shifted
      // one.
      const explicit = nearest(UK, LONDON[0], LONDON[1], coords, 3, R_EARTHDISTANCE, false);
      const defaulted = nearest(UK, LONDON[0], LONDON[1], coords, 3, R_EARTHDISTANCE);
      expect(names(defaulted)).toEqual(names(explicit));
      // Pin the ranking too, not just "the two agree": an implementation
      // that ignored skipFirst entirely would satisfy the comparison above
      // and fail here.
      expect(names(defaulted)).toEqual(["croydon", "watford", "oxford"]);
      // An explicit `undefined` must take the default as well, because the
      // flag is threaded through optional parameters on the way in --
      // findLocations(session, lat, lng, quantity, skipFirst = false) hands
      // its own possibly-omitted argument straight down. A `skipFirst ??
      // false` guard and a default parameter agree here; an
      // `arguments.length`-style check would not.
      expect(names(nearest(UK, LONDON[0], LONDON[1], coords, 3, R_EARTHDISTANCE, undefined))).toEqual([
        "croydon",
        "watford",
        "oxford",
      ]);
    });

    it("drops the search origin itself when it is in the candidate set", () => {
      // The module comment's justification for keeping skipFirst at all:
      // `foodbank.nearby()` ranks a food bank against the full open
      // food-bank list, "dropping the food bank itself, which is always
      // index 0 at distance 0". That depends on haversine returning
      // exactly 0 (not a clamp artefact) for a point against itself, so
      // assert the whole chain, not just the slice.
      const self: Point = { name: "self", lat: 51.5074, lng: -0.1278 };
      const all = [MANCHESTER, self, CROYDON, WATFORD];
      const unskipped = nearest(all, self.lat, self.lng, coords, 4, R_EARTHDISTANCE);
      expect(unskipped[0]!.item.name).toBe("self");
      expect(unskipped[0]!.distanceM).toBe(0);
      expect(names(nearest(all, self.lat, self.lng, coords, 2, R_EARTHDISTANCE, true))).toEqual(["croydon", "watford"]);
    });

    it("drops the true nearest when the origin is NOT in the candidate set", () => {
      // The frozen quirk documented in api2/foodbanks.ts: a closed food
      // bank is absent from the open-food-bank candidate set, so
      // skip_first drops a real neighbour instead of the food bank itself.
      // Django does exactly this and the port keeps it, so pin it -- if
      // someone "fixes" it by filtering on identity instead, that is a
      // deliberate behaviour change and this test should be the thing that
      // forces the conversation.
      expect(names(nearest(UK, LONDON[0], LONDON[1], coords, 2, R_EARTHDISTANCE, true))).toEqual(["watford", "oxford"]);
      expect(names(nearest(UK, LONDON[0], LONDON[1], coords, 2, R_EARTHDISTANCE, true))).not.toContain("croydon");
    });

    it("matches Django's first_item/quantity+1 window at every size and quantity", () => {
      // The two tests above pin the window at one hand-picked (quantity=3,
      // 5 candidates) point. The slice arithmetic is the one thing the
      // module comment calls out as load-bearing, so check it against a
      // literal transcription of givefood/utils/geo.py rather than against
      // three expected names:
      //
      //   first_item = 0
      //   if skip_first:
      //       first_item = 1
      //       quantity = quantity + 1
      //   return sorted_foodbanks[first_item:quantity]
      //
      // The reference ranking here is `meridianNames` -- known by
      // CONSTRUCTION, not recomputed -- so this test isolates the window
      // arithmetic from the distance maths entirely. (JS `.slice(a, b)` and
      // Python `[a:b]` clamp identically over this range of indices,
      // negatives included, so the model is faithful.)
      const djangoWindow = (sortedNames: string[], quantity: number, skipFirst: boolean): string[] => {
        let firstItem = 0;
        if (skipFirst) {
          firstItem = 1;
          quantity = quantity + 1;
        }
        return sortedNames.slice(firstItem, quantity);
      };

      // Guard the assumption the reference order rests on: the meridian
      // really is strictly increasing in distance from MERIDIAN_ORIGIN, so
      // `meridianNames` is the true ranking and any disagreement below is
      // the window, not the ordering.
      const [oLat, oLng] = MERIDIAN_ORIGIN;
      expect(names(nearest(meridian, oLat, oLng, coords, meridian.length, R_EARTHDISTANCE))).toEqual(meridianNames);

      // Scramble the input so the window is being taken from a genuinely
      // sorted list, not from insertion order that happens to look right.
      const scrambled = [8, 0, 11, 3, 7, 1, 10, 4, 9, 2, 6, 5].map((i) => meridian[i]!);
      for (let size = 0; size <= meridian.length; size++) {
        const subsetNames = meridianNames.slice(0, size);
        const subset = scrambled.filter((p) => subsetNames.includes(p.name));
        // Quantities either side of every interesting boundary: negative,
        // zero, one, mid-list, exactly the list length, and past the end.
        for (const quantity of [-2, -1, 0, 1, 2, size, size + 1, 20]) {
          for (const skipFirst of [false, true]) {
            const got = names(nearest(subset, oLat, oLng, coords, quantity, R_EARTHDISTANCE, skipFirst));
            expect(got).toEqual(djangoWindow(subsetNames, quantity, skipFirst));
          }
        }
      }
    });
  });

  describe("PLAN.md §7.5.2 -- one global sort+slice equals Django's merged legs", () => {
    // The module comment's whole reason for existing: find_locations()
    // and find_donationpoints() run TWO querysets, each independently
    // `[:quantity]`, then chain() + sort + slice. This port ranks the
    // combined set once. §7.5.2 argues those agree for skip_first=False
    // because "any member of the true global top-20 can have at most 19
    // items closer than it -- and therefore is always present in its own
    // leg's 20".
    //
    // Rather than restate the argument, model the Python algorithm
    // independently and check the two really do agree -- across many
    // different splits of the same points between the two legs, including
    // the adversarial ones (all of the winners in a single leg).
    const djangoTwoLegMerge = (
      legA: Point[],
      legB: Point[],
      lat: number,
      lng: number,
      quantity: number,
      skipFirst: boolean,
    ): string[] => {
      const rank = (leg: Point[]) =>
        leg
          .map((p) => ({ p, d: haversineMeters(lat, lng, p.lat, p.lng, R_EARTHDISTANCE) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, quantity); // each queryset's own LIMIT quantity
      const merged = [...rank(legA), ...rank(legB)].sort((a, b) => a.d - b.d);
      // `if skip_first: first_item = 1; quantity = quantity + 1`
      const firstItem = skipFirst ? 1 : 0;
      const end = skipFirst ? quantity + 1 : quantity;
      return merged.slice(firstItem, end).map((r) => r.p.name);
    };

    it("agrees with the two-leg merge for every split, at every quantity (skip_first=False)", () => {
      // 4096 splits x 6 quantities. A deterministic exhaustive sweep beats
      // one hand-picked example: the failure mode §7.5.2 retires is a
      // pathological split, so enumerate them all rather than guess.
      const [oLat, oLng] = MERIDIAN_ORIGIN;
      for (let mask = 0; mask < 1 << meridian.length; mask++) {
        const legA = meridian.filter((_, i) => (mask >> i) & 1);
        const legB = meridian.filter((_, i) => !((mask >> i) & 1));
        for (const quantity of [1, 2, 3, 5, 10, 12]) {
          const global = names(nearest([...legA, ...legB], oLat, oLng, coords, quantity, R_EARTHDISTANCE));
          expect(global).toEqual(djangoTwoLegMerge(legA, legB, oLat, oLng, quantity, false));
        }
      }
    });

    it("diverges from the two-leg merge under skip_first, exactly as §7.5.2 says", () => {
      // "The divergence exists only for skip_first=True, which the APIs
      // never use." Demonstrate that it is real -- this is why skipFirst
      // is documented as being for foodbank.nearby()'s single-list path,
      // and why routes/wfbn/nearby.ts carries a known-divergence note
      // rather than claiming parity.
      //
      // Leg A holds the three nearest, leg B the rest. At quantity=2 the
      // Python legs are capped at 2, so p2 never reaches the merge and the
      // window [1:3] lands on p1 and leg B's nearest instead.
      const legA = meridian.slice(0, 3);
      const legB = meridian.slice(3, 6);
      const [oLat, oLng] = MERIDIAN_ORIGIN;
      const global = names(nearest([...legA, ...legB], oLat, oLng, coords, 2, R_EARTHDISTANCE, true));
      const django = djangoTwoLegMerge(legA, legB, oLat, oLng, 2, true);
      expect(global).toEqual(["p1", "p2"]);
      expect(django).toEqual(["p1", "p3"]);
      expect(global).not.toEqual(django);
    });
  });

  describe("boundaries", () => {
    it("returns an empty array for an empty candidate set", () => {
      // Reachable for real: a D1 read that returns no open rows must
      // produce an empty search result, not a throw inside a request.
      expect(nearest([] as Point[], LONDON[0], LONDON[1], coords, 10, R_EARTHDISTANCE)).toEqual([]);
      expect(nearest([] as Point[], LONDON[0], LONDON[1], coords, 10, R_EARTHDISTANCE, true)).toEqual([]);
    });

    it("returns everything it has when quantity exceeds the candidate count", () => {
      expect(names(nearest(UK, LONDON[0], LONDON[1], coords, 500, R_EARTHDISTANCE))).toEqual(UK_BY_DISTANCE);
      // skipFirst still costs exactly one item, never more -- and it costs
      // the NEAREST one. A length check alone would be just as happy with
      // an over-running window that dropped the furthest instead.
      expect(names(nearest(UK, LONDON[0], LONDON[1], coords, 500, R_EARTHDISTANCE, true))).toEqual(
        UK_BY_DISTANCE.slice(1),
      );
    });

    it("returns an empty array for quantity 0 under either skipFirst", () => {
      expect(nearest(UK, LONDON[0], LONDON[1], coords, 0, R_EARTHDISTANCE)).toEqual([]);
      expect(nearest(UK, LONDON[0], LONDON[1], coords, 0, R_EARTHDISTANCE, true)).toEqual([]);
    });

    it("handles a single candidate, which skipFirst then empties", () => {
      expect(names(nearest([CROYDON], LONDON[0], LONDON[1], coords, 10, R_EARTHDISTANCE))).toEqual(["croydon"]);
      expect(nearest([CROYDON], LONDON[0], LONDON[1], coords, 10, R_EARTHDISTANCE, true)).toEqual([]);
    });

    it("never mutates the caller's array, even a frozen one", () => {
      // Callers pass the combined candidate list built from cached D1
      // coordinate rows (findLocations.ts, findDonationpoints.ts) -- and
      // those rows come out of a per-request cache, so an in-place sort
      // here would reorder a shared array under whatever else holds a
      // reference to it.
      //
      // Freezing is the sharp form of this test. The signature says
      // `readonly T[]`, but that is erased at runtime: a `items.sort(...)`
      // that skipped the `.map()` copy would reorder a live array with the
      // types still green. Frozen, that regression throws here instead of
      // being caught only by the value comparison below (which an
      // already-nearly-sorted fixture could miss, since V8's TimSort does
      // not write back when no element moves). The fixture is UK, whose
      // input order is genuinely not distance order.
      const input: readonly Point[] = Object.freeze([...UK]);
      const before = [...input];
      nearest(input, LONDON[0], LONDON[1], coords, 2, R_EARTHDISTANCE);
      expect(input).toEqual(before);
      // Same again through the skipFirst path, which is the one that takes
      // a different slice of the same internal array.
      nearest(input, LONDON[0], LONDON[1], coords, 2, R_EARTHDISTANCE, true);
      expect(input).toEqual(before);
    });

    it("hands back the caller's own object identities, not copies", () => {
      // The callers immediately map results back to database ids
      // (`ranked.map(r => r.item.coord.id)`), so `item` has to be the very
      // object that went in.
      const ranked = nearest(UK, LONDON[0], LONDON[1], coords, 1, R_EARTHDISTANCE);
      expect(ranked[0]!.item).toBe(CROYDON);
    });

    it("calls getLatLng exactly once per candidate", () => {
      // WP 2.5's whole performance story is that ranking ~8,700 points in
      // memory is cheaper than the KNN queries it replaced. Evaluating the
      // accessor inside the comparator instead of the map would make it
      // O(n log n) and, worse, would let a stateful accessor see a
      // different order.
      const spy = vi.fn(coords);
      nearest(UK, LONDON[0], LONDON[1], spy, 2, R_EARTHDISTANCE);
      expect(spy).toHaveBeenCalledTimes(UK.length);
      // ...and once per candidate, in input order, each with its own row --
      // a count alone would also be satisfied by five calls with the same
      // item, which is exactly the shape a mis-wired `map((_, i) =>
      // getLatLng(items[0]))` regression takes.
      expect(spy.mock.calls.map((call) => call[0])).toEqual(UK);
    });

    it("takes coordinates only from getLatLng, never from the item's own fields", () => {
      // The `coords` accessor every other test in this file uses reads
      // `p.lat`/`p.lng` -- exactly the fields a `nearest()` that reached
      // into the row itself would read -- so no test above can tell the
      // accessor and the shortcut apart. No real caller has a usable
      // top-level shape: findLocations.ts and findDonationpoints.ts pass
      // `(c) => [c.coord.latitude, c.coord.longitude]` (nested one level)
      // and routes/wfbn/constituencies.ts parses a "lat,lng" string. So
      // rank rows whose own `lat`/`lng`/`latitude`/`longitude` fields are
      // decoys wired to the OPPOSITE order, and read the real coordinates
      // out of a `centroid` string the way constituencies.ts does.
      type Row = {
        id: string;
        centroid: string;
        lat: number;
        lng: number;
        latitude: number;
        longitude: number;
      };
      const decoyed = (real: Point, decoy: Point, id: string): Row => ({
        id,
        centroid: `${real.lat},${real.lng}`,
        lat: decoy.lat,
        lng: decoy.lng,
        latitude: decoy.lat,
        longitude: decoy.lng,
      });
      const rows: Row[] = [
        decoyed(EDINBURGH, CROYDON, "really-edinburgh"),
        decoyed(CROYDON, EDINBURGH, "really-croydon"),
      ];
      const viaCentroid = (row: Row): readonly [number, number] => {
        const [lat, lng] = row.centroid.split(",");
        return [Number(lat), Number(lng)];
      };
      const ranked = nearest(rows, LONDON[0], LONDON[1], viaCentroid, 2, R_EARTHDISTANCE);
      expect(ranked.map((r) => r.item.id)).toEqual(["really-croydon", "really-edinburgh"]);
      // ...and the published metres come from the accessor's coordinates
      // too, not just the ordering.
      expect(ranked[0]!.distanceM).toBe(
        haversineMeters(LONDON[0], LONDON[1], CROYDON.lat, CROYDON.lng, R_EARTHDISTANCE),
      );
    });

    it("ranks items it cannot introspect at all", () => {
      // nearest() is generic in T and the module never names a field of it.
      // Primitive items are the strongest statement of that: a regression
      // that spread the row (`{...item}`), or read a property off it, or
      // assumed an object shape, cannot survive a plain string. Slugs with
      // coordinates held to one side is a shape a caller could plausibly
      // adopt.
      const at = new Map<string, Point>([
        ["manchester", MANCHESTER],
        ["croydon", CROYDON],
        ["watford", WATFORD],
      ]);
      const slugs = ["manchester", "croydon", "watford"];
      const ranked = nearest(
        slugs,
        LONDON[0],
        LONDON[1],
        (slug) => [at.get(slug)!.lat, at.get(slug)!.lng],
        2,
        R_EARTHDISTANCE,
      );
      expect(ranked.map((r) => r.item)).toEqual(["croydon", "watford"]);
    });

    it("ranks the whole candidate set, not a truncated prefix of it", () => {
      // WP 2.5 replaced 13.7M Postgres KNN queries with an in-memory scan
      // over the full open-coordinate sets (getOpenFoodbankCoordinates +
      // getOpenLocationCoordinates, ~8,700 rows for the /needs/ index and
      // /api/2/locations/search/). The module comment's instruction is to
      // "rank the full candidate set... and slice once", so this checks the
      // top-20 against an INDEPENDENT model -- repeated argmin, not
      // sort-then-slice -- at production scale. A future "optimisation"
      // that only scanned the first N candidates, or a heap-based top-k
      // with an off-by-one, passes every small fixture above and fails
      // here.
      let seed = 20260906;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      const bulk: Point[] = Array.from({ length: 8700 }, (_, i) => ({
        name: `c${i}`,
        lat: 49.9 + rnd() * 8.8, // UK bounding box, so the maths stays in
        lng: -7.6 + rnd() * 9.4, // the range the endpoints actually see
      }));

      const ranked = nearest(bulk, LONDON[0], LONDON[1], coords, 20, R_EARTHDISTANCE);
      expect(ranked).toHaveLength(20);

      const remaining = new Map(
        bulk.map((p) => [p.name, haversineMeters(LONDON[0], LONDON[1], p.lat, p.lng, R_EARTHDISTANCE)]),
      );
      const expected: string[] = [];
      for (let i = 0; i < 20; i++) {
        let best: string | null = null;
        for (const [name, d] of remaining) if (best === null || d < remaining.get(best)!) best = name;
        expected.push(best!);
        remaining.delete(best!);
      }
      expect(names(ranked)).toEqual(expected);
      // The defining property of a top-k, stated without reference to how
      // either side computed it: nothing left out is closer than the 20th.
      const cutoff = ranked[19]!.distanceM;
      for (const d of remaining.values()) expect(d).toBeGreaterThanOrEqual(cutoff);
    });
  });

  describe("degenerate input", () => {
    it("keeps tied candidates in their original order", () => {
      // Several food banks share a building with one of their locations,
      // so exact distance ties are real. JS sort is required to be stable
      // and Python's sorted() is stable, so the two agree on tie order --
      // which is what keeps a Django-vs-Worker diff of a search response
      // byte-identical rather than merely set-equal.
      const tied: Point[] = [
        { name: "first", lat: 51.5074, lng: -0.1278 },
        { name: "second", lat: 51.5074, lng: -0.1278 },
        { name: "third", lat: 51.5074, lng: -0.1278 },
      ];
      const ranked = nearest(tied, LONDON[0], LONDON[1], coords, 3, R_EARTHDISTANCE);
      expect(names(ranked)).toEqual(["first", "second", "third"]);
      expect(ranked.map((r) => r.distanceM)).toEqual([0, 0, 0]);
    });

    it("keeps tie order stable at a size where an unstable sort would show", () => {
      // Three elements is not a stability test: V8's Array#sort used an
      // insertion sort for short arrays and only became unconditionally
      // stable (TimSort) in V8 7.0, and a hand-rolled replacement
      // comparator/sort here would likewise only misbehave once the array
      // is long enough to partition. 48 candidates in 12 tie groups of 4
      // -- the Salvation Army pattern, where one food bank has hundreds of
      // co-located locations (see routes/wfbn/nearby.ts's divergence note)
      // -- puts real work through the sort.
      //
      // This is what makes a Django-vs-Worker response diff byte-identical
      // rather than merely set-equal: Python's sorted() is stable, so the
      // port has to be too.
      const groups: Point[] = [];
      for (let g = 0; g < 12; g++) {
        for (let k = 0; k < 4; k++) {
          groups.push({ name: `g${g}i${k}`, lat: 51.5 + (g + 1) * 0.017, lng: 0 });
        }
      }
      // Present them out of distance order; within each tie group the
      // i0..i3 sequence is the input order that must survive.
      const shuffled = [...groups.slice(24), ...groups.slice(0, 12), ...groups.slice(12, 24)];
      const [oLat, oLng] = MERIDIAN_ORIGIN;
      const ranked = nearest(shuffled, oLat, oLng, coords, groups.length, R_EARTHDISTANCE);
      expect(names(ranked)).toEqual(groups.map((p) => p.name));
      // And the window cuts mid-tie-group without reordering it: the
      // /needs/ index page's 20th and 21st results must not swap between
      // deploys.
      expect(names(nearest(shuffled, oLat, oLng, coords, 6, R_EARTHDISTANCE))).toEqual([
        "g0i0",
        "g0i1",
        "g0i2",
        "g0i3",
        "g1i0",
        "g1i1",
      ]);
    });

    it("propagates a NaN distance instead of dropping or zeroing the candidate", () => {
      // Three columns in production are nullable-with-NULLs (PLAN.md
      // §2.4.2) and a NULL latitude arrives here as NaN. nearest() does
      // not filter: the row survives ranking with distanceM = NaN, and a
      // caller that publishes it emits `null` through the JSON serialiser
      // rather than a plausible-looking wrong number. Documented, not
      // endorsed -- see the suspected-bug note in this module's report.
      // Reachable through a real accessor, not just in theory:
      // routes/wfbn/constituencies.ts builds its coordinates with
      // `Number(centroid.split(",")[0])`, which yields NaN for any
      // constituency whose centroid column is empty or malformed.
      const broken: Point = { name: "no-coords", lat: NaN, lng: NaN };
      const ranked = nearest([CROYDON, broken], LONDON[0], LONDON[1], coords, 2, R_EARTHDISTANCE);
      expect(ranked).toHaveLength(2);
      // Pin the position, not just membership: `toContain` would pass
      // equally on a filter-then-reappend, and the whole point is that the
      // broken row is carried through the ranking untouched.
      expect(names(ranked)).toEqual(["croydon", "no-coords"]);
      expect(ranked[1]!.distanceM).toBeNaN();
      // The real row beside it is still measured correctly -- one bad
      // coordinate must not poison its neighbours' distances.
      const croydonM = haversineMeters(LONDON[0], LONDON[1], CROYDON.lat, CROYDON.lng, R_EARTHDISTANCE);
      expect(ranked[0]!.distanceM).toBe(croydonM);
    });

    it("lets a NaN candidate outrank a real one, because NaN comparisons sort as equal", () => {
      // ECMA-262 SortCompare coerces a NaN comparator result to +0, so
      // `a.distanceM - b.distanceM` says "equal" for every pair involving
      // NaN and stability preserves the input order. With the broken row
      // first, it wins the nearest slot despite having no distance at all.
      // This is the concrete harm of the previous test's non-filtering.
      const broken: Point = { name: "no-coords", lat: NaN, lng: NaN };
      expect(names(nearest([broken, CROYDON], LONDON[0], LONDON[1], coords, 1, R_EARTHDISTANCE))).toEqual([
        "no-coords",
      ]);
    });

    it("lets a NaN row push the genuinely nearest candidate out of the window", () => {
      // The worst version of the above, and the one that would actually be
      // reported as a bug: the broken row is neither first nor last, so the
      // inconsistent comparator (NaN -> "equal" against everything, while
      // the real pair still compares normally) leaves the output NOT sorted
      // by distance at all. Croydon is 15 km away and Manchester 262 km,
      // yet a quantity=2 search returns Manchester and drops Croydon.
      //
      // Pinned rather than endorsed -- see this module's suspected-bug
      // report. The exact permutation is V8's stable sort resolving an
      // inconsistent comparator, so what matters below is the harm (the
      // nearest real row is missing, and the result is out of order), which
      // any stable sort reaches the same way.
      const broken: Point = { name: "no-coords", lat: NaN, lng: NaN };
      const ranked = nearest([MANCHESTER, broken, CROYDON], LONDON[0], LONDON[1], coords, 2, R_EARTHDISTANCE);
      expect(names(ranked)).toEqual(["manchester", "no-coords"]);
      expect(names(ranked)).not.toContain("croydon");
      // The full ranking is genuinely unsorted -- Croydon, the closest
      // point of the three, comes last.
      const full = nearest([MANCHESTER, broken, CROYDON], LONDON[0], LONDON[1], coords, 3, R_EARTHDISTANCE);
      expect(names(full)).toEqual(["manchester", "no-coords", "croydon"]);
      expect(full[2]!.distanceM).toBeLessThan(full[0]!.distanceM);
    });

    it("returns the input's leading rows, unranked, when the ORIGIN is NaN", () => {
      // The NaN tests above all put the bad coordinate on a CANDIDATE. A
      // bad ORIGIN is the reachable one, and it is worse: it poisons every
      // distance at once.
      //
      // api1.ts's /api/1/foodbanks/search/ carries "B6: no is_uk() check,
      // no numeric validation on `lattlong` -- deliberate, do not add
      // either", then does `Number(latStr)` on the raw query string before
      // calling nearest(). So `?lattlong=banana` arrives here as lat = lng
      // = NaN, and so does `?lattlong=51.5` -- no comma means `lngStr` is
      // undefined and Number(undefined) is NaN.
      //
      // What comes back is not "nothing" and not an error: every distance
      // is NaN, so every comparator result is NaN, which ECMA-262
      // SortCompare coerces to +0. The sort is then a no-op over a
      // consistently-"equal" list and the response is simply the first
      // `quantity` candidates in D1 row order, published with distance_m
      // serialising to null. Pinned, not endorsed -- see this module's
      // suspected-bug report.
      //
      // Asserting the input ORDER is the strong form. `every(isNaN)` alone
      // would pass just as well for an implementation that sorted NaNs to
      // the end, or dropped them, or threw.
      const ranked = nearest(UK, NaN, NaN, coords, 3, R_EARTHDISTANCE);
      expect(names(ranked)).toEqual(["manchester", "edinburgh", "croydon"]); // = UK's input order
      expect(names(ranked)).not.toEqual(UK_BY_DISTANCE.slice(0, 3));
      for (const r of ranked) expect(r.distanceM).toBeNaN();
      // A half-parsed "51.5" with no comma behaves identically -- one NaN
      // in either position is enough.
      expect(names(nearest(UK, 51.5, NaN, coords, 3, R_EARTHDISTANCE))).toEqual(names(ranked));
      expect(names(nearest(UK, NaN, -0.1278, coords, 3, R_EARTHDISTANCE))).toEqual(names(ranked));
      // skipFirst then drops input row 0, which is nobody's nearest
      // anything -- the /api/2/foodbank/<slug>/ nearby list degenerates to
      // "rows 1..10 of the table".
      expect(names(nearest(UK, NaN, NaN, coords, 2, R_EARTHDISTANCE, true))).toEqual(["edinburgh", "croydon"]);
    });

    it("does not throw on a non-integer or non-finite quantity", () => {
      // `quantity` is a bare `number` on the exported signature with no
      // guard before `.slice()`, and while no caller passes anything but a
      // literal 10 or 20 today, the coercion rules are worth pinning
      // because each one fails SILENTLY and differently.
      //
      // Note the Django divergence: Python raises "slice indices must be
      // integers" for every non-integer bound below, so there is no
      // upstream behaviour to match here -- only JS's own coercion, which
      // ToIntegerOrInfinity defines as NaN -> 0 and truncation toward zero.
      const q = (quantity: number, skipFirst?: boolean) =>
        names(nearest(UK, LONDON[0], LONDON[1], coords, quantity, R_EARTHDISTANCE, skipFirst));
      expect(q(NaN)).toEqual([]); // NaN window is EMPTY, not unbounded
      expect(q(NaN, true)).toEqual([]);
      expect(q(-0)).toEqual([]); // -0 behaves as 0, not as "everything"
      expect(q(-0, true)).toEqual([]);
      expect(q(2.7)).toEqual(["croydon", "watford"]); // truncated, not rounded to 3
      expect(q(2.7, true)).toEqual(["watford", "oxford"]);
      expect(q(Infinity)).toEqual(UK_BY_DISTANCE);
      expect(q(Infinity, true)).toEqual(UK_BY_DISTANCE.slice(1));
      expect(q(Number.MAX_SAFE_INTEGER)).toEqual(UK_BY_DISTANCE);
    });

    it("ranks antipodal and pole coordinates without producing NaN", () => {
      // haversine.ts clamps sqrt(a) at 1 specifically so floating-point
      // drift cannot push asin() out of domain. The clamp matters at the
      // far end too: an antipode is where sqrt(a) reaches 1 exactly.
      const antipode: Point = { name: "antipode", lat: -51.5074, lng: 179.8722 };
      const pole: Point = { name: "pole", lat: 90, lng: 0 };
      const ranked = nearest([antipode, pole, CROYDON], LONDON[0], LONDON[1], coords, 3, R_EARTHDISTANCE);
      expect(names(ranked)).toEqual(["croydon", "pole", "antipode"]);
      for (const r of ranked) expect(Number.isFinite(r.distanceM)).toBe(true);
      // Half the circumference, to within a metre.
      expect(ranked[2]!.distanceM).toBeCloseTo(Math.PI * R_EARTHDISTANCE, 0);
    });

    it("does not throw on a negative quantity, though no caller passes one", () => {
      // Not reachable today -- every call site passes a literal 10 or 20 --
      // but the negative-index slice is worth pinning because it is a
      // silent data loss rather than an error, and because it happens to
      // agree with Python's `sorted[0:-1]`.
      expect(names(nearest(UK, LONDON[0], LONDON[1], coords, -1, R_EARTHDISTANCE))).toEqual([
        "croydon",
        "watford",
        "oxford",
        "manchester",
      ]);
      expect(nearest(UK, LONDON[0], LONDON[1], coords, -1, R_EARTHDISTANCE, true)).toEqual([]);
    });
  });
});
