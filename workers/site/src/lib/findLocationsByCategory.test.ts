import { beforeEach, describe, expect, it, vi } from "vitest";
import { R_EARTHDISTANCE, haversineMeters } from "@givefood/geo";
import type { Session } from "@givefood/db";

// findLocationsByCategory() is the query behind the "by item" tab on
// /needs/ (gfwfbn/views.py:93, routes/wfbn/index.ts:81) -- "who near me
// needs Baby Milk". Two things make it worth testing more carefully than
// its sibling findLocations():
//
//   1. It is the only search in the codebase whose filter lives on a
//      DIFFERENT row from the point being ranked. The category is a
//      property of the parent food bank's live need; half the candidates
//      are LOCATIONS, which have no need of their own. PLAN.md §4.8.5
//      calls this out, and the port keys the location half on
//      `coord.foodbank_id` while keying the food-bank half on `coord.id`.
//      Those two id spaces overlap freely (there is a location 7 and a
//      food bank 7), so a mix-up produces a plausible-looking results
//      page listing food banks that do not need the item at all -- no
//      error, no empty page, just wrong help offered to someone standing
//      in a supermarket aisle.
//
//   2. It deliberately does NOT follow Django's query shape. Django
//      builds an unbounded `foodbank_id__in=[...]` list, which would blow
//      D1's 100-bound-parameter cap for any common category; this port
//      fetches the matching ids as a query RESULT and tests them against
//      the open-candidate sets in JS. The tests below therefore pin the
//      resulting round-trip/bound-param shape as well as the rows -- a
//      "tidy-up" back towards the Django shape has to fail here.
//
// The module's own header also makes two claims that only a test can hold
// down: that the 20 km ceiling applied AFTER nearest() ranks and truncates
// is equivalent to Django's DB-side `distance__lte` before the slice, and
// that a null latest_need throws (frozen bug B12) rather than degrading.
//
// @givefood/geo and @givefood/models are used FOR REAL here -- the
// distances, the mile conversion and the phone/email fallbacks are part of
// the contract this function is being tested on. Only @givefood/db is
// faked, since D1 is out of scope for the node-environment suite.

const db = vi.hoisted(() => ({
  getFoodbankIdsByCategory: vi.fn(),
  getOpenFoodbankCoordinates: vi.fn(),
  getOpenLocationCoordinatesWithFoodbankId: vi.fn(),
  getFoodbanksByIds: vi.fn(),
  getLocationsByIds: vi.fn(),
}));
vi.mock("@givefood/db", () => db);

import { findLocationsByCategory } from "./findLocationsByCategory";

// A stand-in for the D1 session. Every query in packages/db takes one
// (read-replica safety, PLAN.md §3.3), and this module's only job with it
// is to thread the SAME one into all five calls -- asserted below, because
// a fresh session per query is exactly how a search silently reads a
// replica that has not caught up with a just-published need.
const session = { marker: "d1-session" } as unknown as Session;

// Roughly Trafalgar Square: the shape of lat/lng the /needs/ page hands in
// after geocoding, and inside isUk()'s box so the route would really call
// this function with it.
const SEARCH_LAT = 51.5;
const SEARCH_LNG = -0.1;

// Due north, haversine reduces to R * dLat exactly, so "N km away" is a
// readable, exact way to place a candidate relative to the 20 km ceiling.
const METRES_PER_DEGREE_NORTH = (Math.PI / 180) * R_EARTHDISTANCE;
function latMetresNorth(metres: number): number {
  return SEARCH_LAT + metres / METRES_PER_DEGREE_NORTH;
}
function latKmNorth(km: number): number {
  return latMetresNorth(km * 1000);
}
function metresFromSearch(lat: number, lng: number = SEARCH_LNG): number {
  return haversineMeters(SEARCH_LAT, SEARCH_LNG, lat, lng, R_EARTHDISTANCE);
}

interface TestFoodbank {
  id: number;
  lat: number | null;
  lng?: number | null;
  // The categories on this food bank's LIVE need -- the fake's stand-in
  // for the foodbankchangeline JOIN getFoodbankIdsByCategory does.
  needs: string[];
  name?: string;
  slug?: string;
  phone_number?: string | null;
  contact_email?: string;
  facebook_page?: string | null;
  latestNeed?: { id: number; change_text: string } | null;
}

interface TestLocation {
  id: number;
  foodbank_id: number;
  lat: number | null;
  lng?: number | null;
  name?: string;
  slug?: string;
  phone_number?: string | null;
  email?: string | null;
}

// The fakes below return only the columns this module actually reads, not
// the full 60-column foodbank / foodbanklocation_full rows -- if a future
// change starts reading another column, these rows need updating and the
// test will say so with an undefined rather than passing quietly.
function fullFoodbank(fb: TestFoodbank) {
  return {
    id: fb.id,
    name: fb.name ?? `Foodbank ${fb.id}`,
    slug: fb.slug ?? `foodbank-${fb.id}`,
    phone_number: fb.phone_number === undefined ? `0100 ${fb.id}` : fb.phone_number,
    contact_email: fb.contact_email ?? `fb${fb.id}@example.org`,
    facebook_page: fb.facebook_page === undefined ? `https://www.facebook.com/fb${fb.id}` : fb.facebook_page,
    latestNeed: fb.latestNeed === undefined ? { id: 900 + fb.id, change_text: `Need ${fb.id}` } : fb.latestNeed,
  };
}

// foodbanklocation_full denormalises the parent's name/slug/phone/email
// onto every location row -- that is where foodbank_name, foodbank_slug,
// foodbank_phone_number and foodbank_email come from.
function fullLocation(loc: TestLocation, parent: TestFoodbank) {
  const parentRow = fullFoodbank(parent);
  return {
    id: loc.id,
    foodbank_id: loc.foodbank_id,
    name: loc.name ?? `Location ${loc.id}`,
    slug: loc.slug ?? `location-${loc.id}`,
    foodbank_name: parentRow.name,
    foodbank_slug: parentRow.slug,
    foodbank_phone_number: parentRow.phone_number,
    foodbank_email: parentRow.contact_email,
    phone_number: loc.phone_number === undefined ? null : loc.phone_number,
    email: loc.email === undefined ? null : loc.email,
  };
}

function setWorld(world: { foodbanks: TestFoodbank[]; locations?: TestLocation[] }) {
  const foodbanks = world.foodbanks;
  const locations = world.locations ?? [];
  const foodbankById = new Map(foodbanks.map((fb) => [fb.id, fb]));

  // Mirrors packages/db/src/needs.ts: only food banks whose CURRENT need
  // carries the category (the JOIN on foodbank.latest_need_id), returned
  // as plain result rows, never as bound parameters.
  db.getFoodbankIdsByCategory.mockImplementation(async (_s: Session, category: string) =>
    foodbanks.filter((fb) => fb.needs.includes(category)).map((fb) => fb.id),
  );
  db.getOpenFoodbankCoordinates.mockImplementation(async () =>
    foodbanks.map((fb) => ({ id: fb.id, latitude: fb.lat, longitude: fb.lng === undefined ? SEARCH_LNG : fb.lng })),
  );
  db.getOpenLocationCoordinatesWithFoodbankId.mockImplementation(async () =>
    locations.map((loc) => ({
      id: loc.id,
      latitude: loc.lat,
      longitude: loc.lng === undefined ? SEARCH_LNG : loc.lng,
      foodbank_id: loc.foodbank_id,
    })),
  );
  // Both by-ids fakes reproduce the real ones' contract: caller order
  // preserved, unknown ids silently dropped, [] in gives [] out.
  db.getFoodbanksByIds.mockImplementation(async (_s: Session, ids: readonly number[]) =>
    ids.map((id) => foodbankById.get(id)).filter((fb): fb is TestFoodbank => fb !== undefined).map(fullFoodbank),
  );
  db.getLocationsByIds.mockImplementation(async (_s: Session, ids: readonly number[]) =>
    ids
      .map((id) => locations.find((loc) => loc.id === id))
      .filter((loc): loc is TestLocation => loc !== undefined)
      .map((loc) => fullLocation(loc, foodbankById.get(loc.foodbank_id)!)),
  );
}

function search(category: string, quantity = 20, lat = SEARCH_LAT, lng = SEARCH_LNG) {
  return findLocationsByCategory(session, lat, lng, category, quantity);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("findLocationsByCategory -- who actually gets listed", () => {
  it("returns only food banks whose live need carries the category, nearest first", () => {
    // The whole point of the "by item" tab: the nearest food bank overall
    // (fb 3, 1 km) must NOT appear when it needs Cereal and the visitor
    // searched Pasta. A results page that ignores the category is worse
    // than an empty one -- it sends someone to a food bank that does not
    // want what they are carrying.
    //
    // The nearer of the two survivors is deliberately the one with the
    // HIGHER id, and second in the candidate scan: the expected order
    // therefore matches neither insertion order nor id order, so the
    // "nearest first" half of this test's name is carried by the
    // assertion and not by luck. An implementation that filtered
    // correctly but never sorted would pass if fb 1 were the near one.
    setWorld({
      foodbanks: [
        { id: 1, lat: latKmNorth(12), needs: ["Pasta"] },
        { id: 2, lat: latKmNorth(2), needs: ["Pasta", "Cereal"] },
        { id: 3, lat: latKmNorth(1), needs: ["Cereal"] },
      ],
    });
    return search("Pasta").then((results) => {
      expect(results.map((r) => r.slug)).toEqual(["foodbank-2", "foodbank-1"]);
    });
  });

  it("interleaves food banks and locations in one distance order, not one type after the other", async () => {
    // geo.py:397-398 sorts the CHAINED list by distance
    // (`sorted(chain(foodbanks, locations), key=...)`), and the template
    // renders whatever order it gets. Ranking the two candidate sets
    // separately and concatenating would put every food bank above every
    // location, so the nearest result on the page would not be the
    // nearest place.
    setWorld({
      foodbanks: [
        { id: 1, lat: latKmNorth(2), needs: ["Pasta"] },
        { id: 2, lat: latKmNorth(12), needs: ["Pasta"] },
      ],
      locations: [{ id: 10, foodbank_id: 1, lat: latKmNorth(5) }],
    });
    const results = await search("Pasta");
    expect(results.map((r) => [r.type, r.slug])).toEqual([
      ["organisation", "foodbank-1"],
      ["location", "location-10"],
      ["organisation", "foodbank-2"],
    ]);
  });

  it("qualifies a location by its PARENT food bank's id, never by the location's own id", async () => {
    // PLAN.md §4.8.5, and the reason getOpenLocationCoordinatesWithFoodbankId
    // exists at all: the category set contains FOODBANK ids, and the two
    // id spaces overlap. Location 7 below belongs to food bank 99 (which
    // needs Cereal, not Pasta) and sits 1 km away -- testing the wrong
    // key would promote it to the top of a Pasta search purely because
    // the number 7 is in the set. Location 500's parent IS food bank 7,
    // so it belongs on the page even though 500 is in no set anywhere.
    //
    // Food bank 500 is the mirror-image trap, and the one the location
    // pair alone cannot catch: it needs Cereal, so it must stay off a
    // Pasta page -- but its id collides with location 500's. Any
    // implementation that lets LOCATION ids into the set the food-bank
    // half is tested against (folding both coordinate scans into one id
    // set is the obvious way to arrive there) lists it, and the visitor
    // is sent 3 km to a food bank that never asked for pasta.
    setWorld({
      foodbanks: [
        { id: 7, lat: latKmNorth(15), needs: ["Pasta"] },
        { id: 99, lat: latKmNorth(15), needs: ["Cereal"] },
        { id: 500, lat: latKmNorth(3), needs: ["Cereal"] },
      ],
      locations: [
        { id: 7, foodbank_id: 99, lat: latKmNorth(1) },
        { id: 500, foodbank_id: 7, lat: latKmNorth(2) },
      ],
    });
    const results = await search("Pasta");
    expect(results.map((r) => [r.type, r.slug])).toEqual([
      ["location", "location-500"],
      ["organisation", "foodbank-7"],
    ]);
  });

  it("hydrates a food bank and a location that share a numeric id from their own tables", async () => {
    // Follows from the same overlapping id spaces: the module keeps two
    // separate maps (locationById, foodbankById). Collapsing them into
    // one "id -> row" map would look like a simplification and would
    // silently render location 5 with food bank 5's name and slug.
    //
    // Location 5's parent is food bank 8, NOT food bank 5, which is what
    // makes this discriminating: a single shared map would resolve the
    // location's parent to whichever row id 5 happened to hold and print
    // "part of Camden Food Bank" under an Islington address.
    setWorld({
      foodbanks: [
        { id: 5, lat: latKmNorth(3), needs: ["Pasta"], name: "Camden Food Bank", slug: "camden" },
        {
          id: 8,
          lat: latKmNorth(30),
          needs: ["Pasta"],
          name: "Islington Foodbank",
          slug: "islington",
          facebook_page: "https://www.facebook.com/islington",
          latestNeed: { id: 611, change_text: "Pasta\nRice" },
        },
      ],
      locations: [{ id: 5, foodbank_id: 8, lat: latKmNorth(1), name: "St Mark's Church", slug: "st-marks" }],
    });
    const results = await search("Pasta");
    expect(results.map((r) => [r.type, r.name, r.slug])).toEqual([
      ["location", "St Mark's Church", "st-marks"],
      ["organisation", "Camden Food Bank", "camden"],
    ]);
    // The parent-derived fields on the location row: all four come from
    // food bank 8, none from the same-numbered food bank 5.
    expect(results[0]).toEqual(
      expect.objectContaining({
        foodbank_name: "Islington Foodbank",
        foodbank_slug: "islington",
        facebook_page: "https://www.facebook.com/islington",
        latest_need_id: 611,
      }),
    );
  });

  it("ignores a category match that has no open coordinate row to rank", async () => {
    // The two id sets are not guaranteed to agree: getFoodbankIdsByCategory
    // and getOpenFoodbankCoordinates are separate D1 queries, so a food
    // bank closed between them is in the category result but not in the
    // candidate scan. The direction of the intersection is what handles
    // that -- category ids are TESTED against the candidate set, never
    // used as the candidate set -- and a seed-from-category-ids
    // implementation would throw on `coords.find(...)!.latitude` for the
    // ids it cannot resolve.
    //
    // What this does NOT rule out is such an implementation inventing a
    // placeholder coordinate for the missing rows: (0, 0) or NaN both
    // land outside the 20 km ceiling, so the ceiling would hide the
    // ghost. The assertions below are the two effects that ARE
    // observable -- no throw, and the unresolvable ids never reaching a
    // `WHERE id IN (...)`.
    setWorld({ foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Pasta"] }] });
    db.getFoodbankIdsByCategory.mockResolvedValue([1, 2, 3]);
    const results = await search("Pasta");
    expect(results.map((r) => r.slug)).toEqual(["foodbank-1"]);
    // The whole call list, not "some call matched": ids 2 and 3 must not
    // reach a query in ANY round trip, including a speculative one whose
    // empty result would leave the page looking correct.
    expect(db.getFoodbanksByIds.mock.calls.map((call) => call[1])).toEqual([[1]]);
  });

  it("ignores a category id that belongs to no candidate at all, food bank or location", async () => {
    // The complementary shape, and the one that stays discriminating:
    // the category set is entirely disjoint from both candidate sets, so
    // an implementation ranking anything at all from it -- however it
    // sourced the coordinates -- lists a food bank the visitor cannot be
    // sent to. Nothing to rank, nothing to hydrate, no throw.
    setWorld({
      foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Cereal"] }],
      locations: [{ id: 10, foodbank_id: 1, lat: latKmNorth(2) }],
    });
    db.getFoodbankIdsByCategory.mockResolvedValue([404, 405]);
    await expect(search("Pasta")).resolves.toEqual([]);
    expect(db.getFoodbanksByIds.mock.calls.map((call) => call[1])).toEqual([[]]);
    expect(db.getLocationsByIds.mock.calls.map((call) => call[1])).toEqual([[]]);
  });

  it("lists a location whose parent food bank is not itself a ranked result", async () => {
    // The head-office-with-no-coordinates case, and the ordinary case of
    // a food bank whose registered address is miles from the church hall
    // it actually distributes from. Location eligibility and location
    // hydration both come from `coord.foodbank_id` and the location
    // row's own `foodbank_id`, never from the ranked organisation
    // winners -- which are empty here. Deriving either from the ranked
    // food banks leaves the whole "by item" list blank on exactly the
    // food banks whose locations matter most.
    setWorld({
      foodbanks: [
        {
          id: 1,
          lat: null,
          lng: null,
          needs: ["Pasta"],
          name: "Camden Food Bank",
          slug: "camden",
          facebook_page: "https://www.facebook.com/camdenfoodbank",
          latestNeed: { id: 77, change_text: "Pasta" },
        },
      ],
      locations: [{ id: 10, foodbank_id: 1, lat: latKmNorth(2) }],
    });
    const results = await search("Pasta");
    expect(results.map((r) => [r.type, r.slug])).toEqual([["location", "location-10"]]);
    expect(results[0]).toEqual(
      expect.objectContaining({
        foodbank_name: "Camden Food Bank",
        foodbank_slug: "camden",
        facebook_page: "https://www.facebook.com/camdenfoodbank",
        latest_need_change_text: "Pasta",
        latest_need_id: 77,
      }),
    );
  });

  it("breaks a distance tie the way Django's chain(foodbanks, locations) does -- food bank first", async () => {
    // geo.py:397-398 is `sorted(chain(foodbanks, locations), key=...)`,
    // and Python's sorted is stable, so a food bank and a location at
    // the same point come out food-bank-first. JS Array#sort has been
    // required to be stable since ES2019 and this module spreads the
    // food-bank candidates first, so the port reproduces that ordering
    // exactly -- swapping the two spreads would flip the top of the page
    // for every food bank whose main site IS one of its locations
    // (common: the same postcode appears in both tables).
    //
    // The tie is broken by CANDIDATE ORDER, not by id, so the location's
    // id is deliberately the lower of the two here: with a food bank 1
    // and a location 10 this test would also pass against an
    // implementation that happened to order ties by id (any pre-sort of
    // the candidate list before ranking does that, since the sort is
    // stable), which is a different rule that agrees with Django only
    // when the numbers line up.
    setWorld({
      foodbanks: [{ id: 42, lat: SEARCH_LAT, lng: SEARCH_LNG, needs: ["Pasta"] }],
      locations: [{ id: 7, foodbank_id: 42, lat: SEARCH_LAT, lng: SEARCH_LNG }],
    });
    const results = await search("Pasta");
    expect(results.map((r) => [r.type, r.slug])).toEqual([
      ["organisation", "foodbank-42"],
      ["location", "location-7"],
    ]);
    // Distance exactly 0: haversine's `Math.min(1, sqrt(a))` clamp keeps
    // asin() inside its domain, so standing on the food bank's own
    // doorstep prints "0 miles", never NaN.
    expect(results.map((r) => r.distance_mi)).toEqual([0, 0]);
  });

  it("orders the page by distance even when the hydration query hands rows back in another order", async () => {
    // The rows are joined back to their distances through the ranked
    // list (`withinRadius.map`), not by zipping the ranked list against
    // the hydration result. Those two only agree while the DB returns
    // rows in the requested order -- `WHERE id IN (...)` gives no such
    // guarantee, which is why getFoodbanksByIds re-sorts at all. A
    // zip-based decoration would put each row's name next to another
    // row's mileage: every distance on the page wrong, nothing obviously
    // broken.
    const world: TestFoodbank[] = [
      { id: 1, lat: latKmNorth(3), needs: ["Pasta"] },
      { id: 2, lat: latKmNorth(1), needs: ["Pasta"] },
      { id: 3, lat: latKmNorth(2), needs: ["Pasta"] },
    ];
    setWorld({ foodbanks: world });
    const byId = new Map(world.map((fb) => [fb.id, fb]));
    db.getFoodbanksByIds.mockImplementation(async (_s: Session, ids: readonly number[]) =>
      [...ids]
        .reverse()
        .map((id) => byId.get(id))
        .filter((fb): fb is TestFoodbank => fb !== undefined)
        .map(fullFoodbank),
    );
    const results = await search("Pasta");
    expect(results.map((r) => r.slug)).toEqual(["foodbank-2", "foodbank-3", "foodbank-1"]);
    // 1 km, 2 km, 3 km in miles -- each row carrying its OWN distance.
    //
    // Held to 8 decimal places, not the 3 or 4 a mileage on a web page
    // needs, because the number being pinned is Django's exact
    // conversion: uk.py's `miles()` is `meters * 0.000621371192`, and a
    // "tidied" 0.000621371 (or 1/1609.344, or any of the other constants
    // that print the same to 4dp) is a divergence from the Python source
    // that a loose tolerance would wave through. Ties on the radius too:
    // R_PYTHON instead of R_EARTHDISTANCE moves these by 0.175%.
    expect(results[0]!.distance_mi).toBeCloseTo(0.6213711920, 8);
    expect(results[1]!.distance_mi).toBeCloseTo(1.2427423840, 8);
    expect(results[2]!.distance_mi).toBeCloseTo(1.8641135760, 8);
  });

  it("returns nothing at all when no food bank needs the category", async () => {
    // The realistic case for a rare item, and for a stale bookmarked
    // /needs/?item=... link. It must be an empty list, not a throw and
    // not the un-filtered nearest list -- routes/wfbn/index.ts turns []
    // into null so the template hides the section entirely.
    setWorld({
      foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Cereal"] }],
      locations: [{ id: 10, foodbank_id: 1, lat: latKmNorth(1) }],
    });
    await expect(search("Baby Milk")).resolves.toEqual([]);
  });
});

describe("findLocationsByCategory -- the 20 km ceiling", () => {
  it("drops candidates beyond max_distance_meters even when there is room in the results", async () => {
    // find_locations_by_category(lat_lng, category, 20000, 20): unlike
    // find_locations(), this search is explicitly bounded. "Nearest food
    // bank needing nappies" being 60 miles away is not a useful answer,
    // and Django never returned one.
    setWorld({
      foodbanks: [
        { id: 1, lat: latKmNorth(19.9), needs: ["Pasta"] },
        { id: 2, lat: latKmNorth(20.1), needs: ["Pasta"] },
      ],
      // An out-of-range LOCATION as well, so the empty location-hydration
      // assertion below is about the ceiling rather than about a world
      // that had no locations to hydrate in the first place. Its parent
      // needs Pasta, so it is a fully qualified candidate and nothing but
      // the distance keeps it out.
      locations: [{ id: 10, foodbank_id: 1, lat: latKmNorth(25) }],
    });
    // State the geometry the assertion depends on, so a change to the
    // radius constant or the ceiling shows up here as a real failure
    // rather than as an unexplained one.
    expect(metresFromSearch(latKmNorth(19.9))).toBeLessThan(20000);
    expect(metresFromSearch(latKmNorth(20.1))).toBeGreaterThan(20000);
    const results = await search("Pasta", 20);
    expect(results.map((r) => r.slug)).toEqual(["foodbank-1"]);
    // Only the SURVIVOR is hydrated. Hydrating `ranked` instead of
    // `withinRadius` would render an identical page while quietly
    // widening every `WHERE id IN (...)` list to include rows nobody
    // will ever see -- the bound-parameter growth this port is shaped
    // to avoid, reintroduced invisibly.
    //
    // Asserted over the whole call list rather than with
    // toHaveBeenCalledWith, which only says SOME call matched: a second
    // round trip carrying the rejected ids would satisfy that and is
    // exactly what is being ruled out. One call each, and no parent
    // lookup at all, since no location survived to have a parent.
    expect(db.getFoodbanksByIds.mock.calls.map((call) => call[1])).toEqual([[1]]);
    expect(db.getLocationsByIds.mock.calls.map((call) => call[1])).toEqual([[]]);
  });

  it("puts the ceiling at 20 km, not 20 miles and not 20,000 of anything else", async () => {
    // Straddles the boundary by 10 cm either side, which pins WHERE the
    // ceiling is. Whether it is inclusive is a separate question, and the
    // test below answers it.
    setWorld({
      foodbanks: [
        { id: 1, lat: latMetresNorth(19999.9), needs: ["Pasta"] },
        { id: 2, lat: latMetresNorth(20000.1), needs: ["Pasta"] },
      ],
    });
    const results = await search("Pasta");
    expect(results.map((r) => r.slug)).toEqual(["foodbank-1"]);
  });

  it("keeps a candidate sitting at exactly 20000.0 m -- the ceiling is `<=`, not `<`", async () => {
    // The inclusivity of the comparison, which the straddling test above
    // cannot see. Django's own filter is
    // `distance__lte=max_distance_meters` (geo.py:339-344, :364-370, the
    // same two legs cited on the equivalence test below) -- lte, not lt
    // -- so a food bank standing exactly on the ceiling is IN. Tightening
    // this port's `<=` to `<`, which reads like a harmless off-by-one
    // tidy-up, drops it, and every other test in this file still passes.
    //
    // Sitting exactly on the boundary takes a contrived pair of
    // coordinates, because haversine's output near 20 km lands on a
    // sparse grid of doubles: stepping the latitude alone skips over
    // 20000.0. These were found by bisecting the LONGITUDE (which moves
    // the distance in far finer increments than latitude does at this
    // bearing) until the computed distance was exactly the double
    // 20000. The two expect()s below re-derive that geometry from
    // @givefood/geo itself, so if the radius constant or the haversine
    // form ever changes, THIS test fails first and says the fixture no
    // longer sits on the boundary -- rather than the ceiling assertion
    // failing for a reason that looks unrelated.
    const AT_CEILING_LAT = 51.67966218360219;
    const AT_CEILING_LNG = -0.09999992950439454;
    // One double past it to the north: the nearest representable
    // neighbour, 0.8 nanometres over the line, and out.
    const PAST_CEILING_LAT = 51.6796621836022;
    expect(metresFromSearch(AT_CEILING_LAT, AT_CEILING_LNG)).toBe(20000);
    expect(metresFromSearch(PAST_CEILING_LAT, AT_CEILING_LNG)).toBeGreaterThan(20000);

    setWorld({
      foodbanks: [
        { id: 1, lat: AT_CEILING_LAT, lng: AT_CEILING_LNG, needs: ["Pasta"] },
        { id: 2, lat: PAST_CEILING_LAT, lng: AT_CEILING_LNG, needs: ["Pasta"] },
      ],
    });
    const results = await search("Pasta");
    expect(results.map((r) => r.slug)).toEqual(["foodbank-1"]);
  });

  it("filtering after the ranking slice yields the same rows as Django's filter before it", async () => {
    // The module header's equivalence claim. Django runs
    // `.filter(distance__lte=20000)[:quantity]`; this port ranks, takes
    // the closest `quantity`, and only then drops anything over 20 km.
    // Those agree because the ranked list is distance-ascending, so
    // everything over the ceiling is a SUFFIX -- dropping it can never
    // discard a nearer in-range row that Django would have kept. With
    // quantity 4 and only three in-range candidates, both orders give
    // exactly those three: the out-of-range pair cannot displace them.
    setWorld({
      foodbanks: [
        { id: 1, lat: latKmNorth(1), needs: ["Pasta"] },
        { id: 2, lat: latKmNorth(2), needs: ["Pasta"] },
        { id: 3, lat: latKmNorth(3), needs: ["Pasta"] },
        { id: 4, lat: latKmNorth(25), needs: ["Pasta"] },
        { id: 5, lat: latKmNorth(30), needs: ["Pasta"] },
      ],
    });
    const results = await search("Pasta", 4);
    expect(results.map((r) => r.slug)).toEqual(["foodbank-1", "foodbank-2", "foodbank-3"]);
  });

  it("still fills the whole quantity with in-range rows when out-of-range candidates exist", async () => {
    // The other half of that equivalence, and the half the test above
    // cannot see: Django distance-filters each leg BEFORE its own
    // `[:quantity]` (geo.py:339-344, :364-370), so it always returns
    // `quantity` rows when that many are in range. The port slices
    // first, so it only agrees while every out-of-range candidate sorts
    // BEHIND every in-range one. Six candidates, four of them in range,
    // asking for three: an out-of-range row occupying a slot would show
    // up here as a short page, and as a nearer food bank than the
    // visitor was shown going unlisted.
    setWorld({
      foodbanks: [
        { id: 1, lat: latKmNorth(1), needs: ["Pasta"] },
        { id: 2, lat: latKmNorth(2), needs: ["Pasta"] },
        { id: 3, lat: latKmNorth(3), needs: ["Pasta"] },
        { id: 4, lat: latKmNorth(4), needs: ["Pasta"] },
        { id: 90, lat: latKmNorth(25), needs: ["Pasta"] },
        { id: 91, lat: latKmNorth(30), needs: ["Pasta"] },
      ],
    });
    const results = await search("Pasta", 3);
    expect(results.map((r) => r.slug)).toEqual(["foodbank-1", "foodbank-2", "foodbank-3"]);
  });

  it("silently drops a row with null coordinates instead of listing it 3,500 miles away", async () => {
    // foodbanklocation.latitude/longitude are nullable in production
    // (see FoodbankLocationRow) and the candidate query does not exclude
    // them, so a half-geocoded location really can reach the ranking.
    // JS arithmetic coerces the nulls to 0, putting it in the Gulf of
    // Guinea -- the 20 km ceiling is what keeps that off the page. No
    // throw, no NaN distance, just absent.
    setWorld({
      foodbanks: [{ id: 1, lat: latKmNorth(3), needs: ["Pasta"] }],
      locations: [
        { id: 10, foodbank_id: 1, lat: null, lng: null },
        { id: 11, foodbank_id: 1, lat: latKmNorth(1) },
      ],
    });
    const results = await search("Pasta");
    expect(results.map((r) => r.slug)).toEqual(["location-11", "foodbank-1"]);

    // ...and this is the proof that the ceiling is what did it, rather
    // than a null check somewhere in the candidate pipeline. Searching
    // from the Gulf of Guinea itself -- unreachable through the route,
    // which gates on isUk(), so this is a mechanism probe and not a live
    // path -- the same half-geocoded row is ranked at distance 0 and
    // listed, while the two real London rows fall outside the ceiling.
    //
    // Worth pinning because the two implementations are indistinguishable
    // on the assertion above but not in production: dropping null
    // coordinates before ranking silently changes which rows can occupy
    // the `quantity` slice, and this file's Django-parity claim is that
    // nothing is filtered before the distance test.
    const atNullIsland = await search("Pasta", 20, 0, 0);
    expect(atNullIsland.map((r) => [r.slug, r.distance_mi])).toEqual([["location-10", 0]]);
  });

  it("returns nothing rather than throwing when the search coordinate itself is NaN", async () => {
    // routes/wfbn/index.ts:66-73 rejects NaN before calling this (the
    // Number.isNaN checks feeding isUk), so this is defence in depth --
    // but it documents the shape of the degradation: every distance is
    // NaN, `NaN <= 20000` is false, so the ceiling empties the list
    // instead of rendering "NaN miles away" for twenty food banks.
    setWorld({ foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Pasta"] }] });
    await expect(search("Pasta", 20, Number.NaN, Number.NaN)).resolves.toEqual([]);
  });
});

describe("findLocationsByCategory -- the decorated row the template reads", () => {
  it("decorates a food bank the way geo.py:373-378 does, with name/slug copied into the foodbank_ fields", async () => {
    // Django sets foodbank.foodbank_name = foodbank.name and
    // foodbank.foodbank_slug = foodbank.slug precisely so wfbn/index.njk
    // can use ONE loop body for both result types -- the organisation
    // branch has to fill both pairs of fields or the "part of X" line and
    // the result link break for every food-bank-typed row.
    setWorld({
      foodbanks: [
        {
          id: 4,
          lat: latKmNorth(10),
          needs: ["Pasta"],
          name: "Salisbury Foodbank",
          slug: "salisbury",
          phone_number: "01722 341444",
          contact_email: "info@salisburyfoodbank.org.uk",
          facebook_page: "https://www.facebook.com/salisburyfoodbank",
          latestNeed: { id: 8123, change_text: "Pasta\nTinned Tomatoes" },
        },
      ],
    });
    const [row] = await search("Pasta");
    expect(row).toEqual({
      type: "organisation",
      name: "Salisbury Foodbank",
      slug: "salisbury",
      foodbank_slug: "salisbury",
      foodbank_name: "Salisbury Foodbank",
      // 10 km in MILES -- geo.py's `distance_mi = miles(distance)`. The
      // template prints this with a "miles" suffix, so a metres or km
      // value here is a wrong number under a correct-looking label. To 8
      // places for the reason given on the three-row ordering test: at
      // 4dp, every plausible wrong mile constant still passes.
      distance_mi: expect.closeTo(6.2137119200, 8),
      phone_number: "01722 341444",
      contact_email: "info@salisburyfoodbank.org.uk",
      facebook_page: "https://www.facebook.com/salisburyfoodbank",
      latest_need_change_text: "Pasta\nTinned Tomatoes",
      latest_need_id: 8123,
    });
  });

  it("takes a location's need and Facebook page from its parent food bank", async () => {
    // geo.py:390, `location.latest_need = location.foodbank.latest_need`:
    // a location has no need of its own and no facebook_page column at
    // all. Reading either off the location row gives undefined, which
    // renders as a blank shopping list next to a real address -- the one
    // thing the page exists to show.
    setWorld({
      foodbanks: [
        {
          id: 1,
          lat: latKmNorth(30),
          needs: ["Pasta"],
          name: "Camden Food Bank",
          slug: "camden",
          facebook_page: "https://www.facebook.com/camdenfoodbank",
          latestNeed: { id: 4242, change_text: "Pasta\nLong Life Milk" },
        },
      ],
      locations: [
        { id: 10, foodbank_id: 1, lat: latKmNorth(5), name: "St Mark's Church", slug: "st-marks-church" },
      ],
    });
    const results = await search("Pasta");
    // The parent food bank itself is 30 km away and correctly absent:
    // the ceiling is measured against each ranked point, not against the
    // organisation a location belongs to. Asserted on THIS call rather
    // than by searching a second time, so the call-shape assertions
    // below describe one search rather than two.
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "location",
      // The location's OWN name and slug, and the denormalised parent
      // name/slug -- the pair the "St Mark's Church, part of Camden Food
      // Bank" line and the /needs/at/camden/st-marks-church/ link need.
      name: "St Mark's Church",
      slug: "st-marks-church",
      foodbank_slug: "camden",
      foodbank_name: "Camden Food Bank",
      distance_mi: expect.closeTo(3.1068559600, 8),
      phone_number: "0100 1",
      contact_email: "fb1@example.org",
      facebook_page: "https://www.facebook.com/camdenfoodbank",
      latest_need_change_text: "Pasta\nLong Life Milk",
      latest_need_id: 4242,
    });
    // THE CASE THAT KEEPS THE MERGE HONEST. No organisation survived the
    // ceiling, so the one id read here can only have come from the winning
    // LOCATION's own foodbank_id. github #53 merged the two food bank reads
    // into one, and this is the assertion that says the union is
    // organisationIds ∪ parent ids rather than just the organisation
    // winners -- sourcing the parents from those instead is the easy
    // "simplification", since they usually overlap, and it would leave the
    // shopping list and the "part of ..." line blank in exactly this case,
    // and only in this case.
    //
    // It also pins WHERE the parent id comes from now: the ranked candidate
    // row, not the hydrated location row. Both carry foodbank_id and they
    // agree, but only the candidate has it before the read is issued, which
    // is the whole reason this is one wave instead of two.
    expect(db.getFoodbanksByIds.mock.calls.map((call) => call[1])).toEqual([[1]]);
  });

  it("prefers a location's own phone and email, and falls back on empty strings as well as nulls", async () => {
    // phone_or_foodbank_phone()/email_or_foodbank_email()
    // (givefood/models/foodbank.py:892-902) branch on Python truthiness
    // -- `if self.phone_number:` -- so a location row storing "" (which
    // the admin form produces for a cleared field, far more often than
    // NULL) must fall back to the food bank's number, not publish a
    // blank one. That is why the port uses `||`, not `??`.
    setWorld({
      // Parent beyond the ceiling, so the three locations are the whole
      // result list and the fallbacks line up one per row.
      foodbanks: [
        { id: 1, lat: latKmNorth(25), needs: ["Pasta"], phone_number: "0100 PARENT", contact_email: "parent@example.org" },
      ],
      locations: [
        { id: 10, foodbank_id: 1, lat: latKmNorth(1), phone_number: "0200 OWN", email: "own@example.org" },
        { id: 11, foodbank_id: 1, lat: latKmNorth(2), phone_number: null, email: null },
        { id: 12, foodbank_id: 1, lat: latKmNorth(3), phone_number: "", email: "" },
      ],
    });
    const results = await search("Pasta");
    expect(results.map((r) => [r.slug, r.phone_number, r.contact_email])).toEqual([
      ["location-10", "0200 OWN", "own@example.org"],
      ["location-11", "0100 PARENT", "parent@example.org"],
      ["location-12", "0100 PARENT", "parent@example.org"],
    ]);
  });

  it("passes a food bank's own null phone number straight through", async () => {
    // The organisation branch has no fallback to apply -- a food bank
    // with no phone number publishes null, and the template's own
    // {% if %} hides the row. Coercing it to "" here would print an
    // empty "Phone:" line instead.
    setWorld({ foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Pasta"], phone_number: null, facebook_page: null }] });
    const [row] = await search("Pasta");
    expect(row).toEqual(expect.objectContaining({ phone_number: null, facebook_page: null }));
  });
});

describe("findLocationsByCategory -- quantity, and the query shape D1 forces", () => {
  it("returns the closest `quantity` results and fetches full rows for those only", async () => {
    // WP 2.5's rule: rank thin coordinate rows, then fetch full rows for
    // the winners. Asking for full rows before the slice is what made
    // these searches the slowest thing in the API.
    setWorld({
      foodbanks: [
        { id: 1, lat: latKmNorth(1), needs: ["Pasta"] },
        { id: 2, lat: latKmNorth(2), needs: ["Pasta"] },
        { id: 3, lat: latKmNorth(3), needs: ["Pasta"] },
      ],
      locations: [
        { id: 10, foodbank_id: 1, lat: latKmNorth(4) },
        { id: 11, foodbank_id: 1, lat: latKmNorth(5) },
      ],
    });
    const results = await search("Pasta", 2);
    expect(results.map((r) => r.slug)).toEqual(["foodbank-1", "foodbank-2"]);
    expect(db.getFoodbanksByIds).toHaveBeenCalledWith(session, [1, 2]);
    // No location survived the slice, so no location row is fetched and
    // -- because there are no parent food banks to resolve -- the second
    // getFoodbanksByIds round trip is skipped entirely.
    expect(db.getLocationsByIds).toHaveBeenCalledWith(session, []);
    expect(db.getFoodbanksByIds).toHaveBeenCalledTimes(1);
  });

  it("asks for no rows at all when quantity is 0", async () => {
    // Boundary: nearest() slices [0,0). Nothing ranked means nothing to
    // hydrate, and the by-ids helpers must still be called safely with
    // an empty list rather than being handed `WHERE id IN ()`.
    setWorld({ foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Pasta"] }] });
    await expect(search("Pasta", 0)).resolves.toEqual([]);
    expect(db.getFoodbanksByIds).toHaveBeenCalledWith(session, []);
    expect(db.getLocationsByIds).toHaveBeenCalledWith(session, []);
  });

  it("keeps the D1 round trips and bound parameters bounded however many food banks match", async () => {
    // The reason this port diverges from Django. 500 food banks needing
    // Pasta is an ordinary Tuesday for a common category; Django's
    // `foodbank_id__in=<500 ids>` would be 500 bound parameters against
    // D1's cap of 100. Here the matching ids arrive as a query RESULT,
    // and the only id lists that ever reach a query are the <= quantity
    // winners. Six round trips (three candidate queries, two hydration
    // queries, one parent lookup), flat, regardless of category size --
    // the count must not grow with the number of matching food banks,
    // the number of results, or the number of distinct parents.
    setWorld({
      foodbanks: Array.from({ length: 500 }, (_, i) => ({
        id: i + 1,
        lat: latKmNorth(0.03 * (i + 1)),
        needs: ["Pasta"],
      })),
      // 500 locations too, one per food bank, each sitting between its
      // parent and the next food bank so the two types interleave. Both
      // id lists that reach a query therefore hold real winners, and
      // both have to stay bounded -- a category filter that only capped
      // the food-bank half would still blow the parameter cap on the
      // location half.
      locations: Array.from({ length: 500 }, (_, i) => ({
        id: 1001 + i,
        foodbank_id: i + 1,
        lat: latKmNorth(0.03 * (i + 1) + 0.015),
      })),
    });
    const results = await search("Pasta", 20);
    expect(results.length).toBe(20);
    expect(results.map((r) => r.type).slice(0, 4)).toEqual(["organisation", "location", "organisation", "location"]);
    const hydrationIds = db.getFoodbanksByIds.mock.calls.map((call) => call[1] as number[]);
    // Ten food banks and ten locations win. ONE call, not two (github #53):
    // the parents used to be read separately, in a wave of their own, because
    // their ids were taken from the hydrated location rows -- but this
    // function's candidate scan already carries foodbank_id, so both id lists
    // are known before either read is issued and they merge into one
    // statement. Here every location's parent is also a winning food bank, so
    // the union is the same ten ids and the second query bought nothing at
    // all.
    expect(hydrationIds).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
    expect(db.getLocationsByIds.mock.calls.map((call) => call[1])).toEqual([
      [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010],
    ]);
    // The invariant stated plainly: no id list reaching D1 can be longer
    // than `quantity`, whatever the category's popularity. D1's cap is
    // 100; Django's `foodbank_id__in=<500 ids>` would be 500.
    for (const call of [...db.getFoodbanksByIds.mock.calls, ...db.getLocationsByIds.mock.calls]) {
      expect((call[1] as number[]).length).toBeLessThanOrEqual(20);
    }
    // And the category query itself carries no id list at all -- two
    // bound params in the real query, so exactly two arguments here.
    expect(db.getFoodbankIdsByCategory).toHaveBeenCalledWith(session, "Pasta");
    const totalCalls =
      db.getFoodbankIdsByCategory.mock.calls.length +
      db.getOpenFoodbankCoordinates.mock.calls.length +
      db.getOpenLocationCoordinatesWithFoodbankId.mock.calls.length +
      db.getFoodbanksByIds.mock.calls.length +
      db.getLocationsByIds.mock.calls.length;
    expect(totalCalls).toBe(5);
  });

  it("resolves each parent food bank once for many locations sharing it", async () => {
    // A food bank with several distribution centres is the normal case,
    // and all of them are in range together. Without the Set the parent
    // id repeats per location, which is both a wider IN() list and an
    // invitation to reintroduce the per-row lookup this replaced.
    setWorld({
      foodbanks: [{ id: 1, lat: latKmNorth(19), needs: ["Pasta"] }],
      locations: [
        { id: 10, foodbank_id: 1, lat: latKmNorth(1) },
        { id: 11, foodbank_id: 1, lat: latKmNorth(2) },
        { id: 12, foodbank_id: 1, lat: latKmNorth(3) },
      ],
    });
    const results = await search("Pasta");
    expect(results.map((r) => r.slug)).toEqual(["location-10", "location-11", "location-12", "foodbank-1"]);
    // ONE call since github #53, and the id appears once in it: the Set over
    // organisationIds union parentFoodbankIds collapses a food bank that is
    // both a winner in its own right and the parent of three winning
    // locations. That used to be two separate reads of the same row.
    expect(db.getFoodbanksByIds.mock.calls.map((call) => call[1])).toEqual([[1]]);
  });

  it("threads one D1 session through every query, and passes the category through verbatim", async () => {
    // Every query in packages/db takes a session because this database
    // has read replication on (PLAN.md §3.3) -- a query issued outside
    // the caller's session can land on a replica that has not seen the
    // need published a moment ago, so the "by item" tab would filter on
    // yesterday's shopping lists. The category string is a validated
    // ITEM_CATEGORIES value with spaces in it ("Baby Milk"); it must
    // reach the query unnormalised, since the join matches
    // foodbankchangeline.category exactly.
    setWorld({
      foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Baby Milk"] }],
      locations: [{ id: 10, foodbank_id: 1, lat: latKmNorth(2) }],
    });
    await search("Baby Milk");
    expect(db.getFoodbankIdsByCategory).toHaveBeenCalledWith(session, "Baby Milk");
    expect(db.getOpenFoodbankCoordinates).toHaveBeenCalledWith(session);
    expect(db.getOpenLocationCoordinatesWithFoodbankId).toHaveBeenCalledWith(session);
    for (const call of [...db.getFoodbanksByIds.mock.calls, ...db.getLocationsByIds.mock.calls]) {
      expect(call[0]).toBe(session);
    }
  });

  it("issues the three candidate queries concurrently, not one after another", async () => {
    // Promise.all evaluates its array synchronously, so all three calls
    // are already on the wire before this function's first await --
    // which is exactly what makes the assertions below work without
    // awaiting anything. A `const ids = await getFoodbankIdsByCategory()`
    // rewrite would read as harmless and would serialise three D1 round
    // trips into the /needs/ page's time-to-first-byte.
    setWorld({
      foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Pasta"] }],
      locations: [{ id: 10, foodbank_id: 1, lat: latKmNorth(2) }],
    });
    const pending = search("Pasta");
    expect(db.getFoodbankIdsByCategory).toHaveBeenCalledTimes(1);
    expect(db.getOpenFoodbankCoordinates).toHaveBeenCalledTimes(1);
    expect(db.getOpenLocationCoordinatesWithFoodbankId).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toHaveLength(2);
  });

  it("issues the two hydration queries concurrently as well", async () => {
    // Same again for the second wave. Held open deliberately: the
    // food-bank hydration is gated on a promise this test controls, and
    // the location hydration must still have been issued while it is
    // outstanding. Only the PARENT lookup is allowed to be sequential,
    // because it cannot know its ids until the location rows arrive.
    const foodbanks: TestFoodbank[] = [{ id: 1, lat: latKmNorth(3), needs: ["Pasta"] }];
    const locations: TestLocation[] = [{ id: 10, foodbank_id: 1, lat: latKmNorth(1) }];
    setWorld({ foodbanks, locations });
    let releaseFoodbanks!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFoodbanks = resolve;
    });
    db.getFoodbanksByIds.mockImplementation(async (_s: Session, ids: readonly number[]) => {
      await gate;
      return ids.map((id) => fullFoodbank(foodbanks.find((fb) => fb.id === id)!));
    });
    const pending = search("Pasta");
    await vi.waitFor(() => expect(db.getLocationsByIds).toHaveBeenCalledTimes(1));
    releaseFoodbanks();
    await expect(pending).resolves.toHaveLength(2);
  });
});

describe("findLocationsByCategory -- degenerate arguments, unguarded on purpose", () => {
  it("does not sanity-check quantity: nearest()'s slice arithmetic shows straight through", async () => {
    // routes/wfbn/index.ts only ever passes the literal 20, so this is
    // documentation rather than a live path -- but it pins what the
    // absence of a guard actually means, so that adding one later is a
    // deliberate change. nearest() computes `slice(0, 0 + quantity)`:
    // a negative quantity therefore drops the FARTHEST result instead of
    // returning nothing, and a NaN quantity collapses to slice(0, 0).
    setWorld({
      foodbanks: [
        { id: 1, lat: latKmNorth(1), needs: ["Pasta"] },
        { id: 2, lat: latKmNorth(2), needs: ["Pasta"] },
        { id: 3, lat: latKmNorth(3), needs: ["Pasta"] },
      ],
    });
    expect((await search("Pasta", -1)).map((r) => r.slug)).toEqual(["foodbank-1", "foodbank-2"]);
    await expect(search("Pasta", Number.NaN)).resolves.toEqual([]);
  });

  it("passes an empty category to the query rather than short-circuiting on it", async () => {
    // The "is this a real category" check lives in the route
    // (gfwfbn/views.py:89-93 validates against ITEM_CATEGORIES_CHOICES
    // and silently ignores anything else), not here. Adding a
    // `if (!category) return []` fast path here would be a second,
    // divergent place where that decision is made -- and would hide a
    // route regression that started passing "" through.
    setWorld({ foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Pasta"] }] });
    await expect(search("")).resolves.toEqual([]);
    expect(db.getFoodbankIdsByCategory).toHaveBeenCalledWith(session, "");
  });

  it("matches the category by exact string, with no trimming, casing or normalisation", async () => {
    // foodbankchangeline.category is matched with `=` in SQL, so the
    // string has to survive this function untouched. A trim() or a
    // toLowerCase() added "defensively" would make " Pasta " and "pasta"
    // appear to work here while the D1 query returned nothing, and the
    // /needs/ page would show an empty "by item" section for a category
    // the dropdown itself offered.
    setWorld({ foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Baby Milk"] }] });
    await expect(search(" Baby Milk ")).resolves.toEqual([]);
    expect(db.getFoodbankIdsByCategory).toHaveBeenCalledWith(session, " Baby Milk ");
    await expect(search("baby milk")).resolves.toEqual([]);
    expect(db.getFoodbankIdsByCategory).toHaveBeenCalledWith(session, "baby milk");
    // A non-breaking space where the category's own space should be --
    // what a copy-pasted or CMS-mangled `?item=` value looks like. The
    // padded and lower-cased cases above are both invariant under a
    // whitespace-collapsing "normalisation" (they have no runs of
    // whitespace to collapse), so this is the case that holds down the
    // whole class: U+00A0 must reach the query as U+00A0 and match
    // nothing, not be folded into an ordinary space and match "Baby
    // Milk". 23 of the 49 ITEM_CATEGORIES have a space in them, so
    // this is the difference between an empty section and a wrong one.
    await expect(search("Baby\u00A0Milk")).resolves.toEqual([]);
    expect(db.getFoodbankIdsByCategory).toHaveBeenCalledWith(session, "Baby\u00A0Milk");
  });

  it("returns an empty list, and hydrates nothing, when there are no candidates at all", async () => {
    // A brand new database, or a coordinate scan that legitimately comes
    // back empty. Both by-ids helpers still get called with [] -- their
    // own contract is that [] short-circuits to [] without a query, so
    // this must not be guarded here with a `WHERE id IN ()` in mind.
    setWorld({ foodbanks: [] });
    await expect(search("Pasta")).resolves.toEqual([]);
    expect(db.getFoodbanksByIds).toHaveBeenCalledWith(session, []);
    expect(db.getLocationsByIds).toHaveBeenCalledWith(session, []);
    expect(db.getFoodbanksByIds).toHaveBeenCalledTimes(1);
  });
});

describe("findLocationsByCategory -- frozen crashes kept, port-only crashes dropped", () => {
  it("throws on a food bank with no latest need (frozen bug B12), rather than skipping the row", async () => {
    // The module says so explicitly: a null latest_need throws here
    // exactly as it 500s in Django, matching findLocations.ts and
    // api2/locations.ts. It is unreachable through this function today
    // because getFoodbankIdsByCategory's JOIN on
    // foodbank.latest_need_id can only return food banks that HAVE a
    // live need -- so this test is really guarding that db-layer join:
    // relax it (say, to match on category alone) and the /needs/ page
    // starts 500ing instead of quietly listing a needless food bank.
    setWorld({ foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Pasta"], latestNeed: null }] });
    await expect(search("Pasta")).rejects.toThrow(TypeError);
  });

  it("throws the same way when a location's parent food bank has no latest need", async () => {
    // Same frozen behaviour on the location branch, where the need is
    // read off the parent. Worth pinning separately: the location branch
    // dereferences a DIFFERENT row, so a fix or a guard applied to only
    // one of the two branches would leave this half broken.
    setWorld({
      foodbanks: [{ id: 1, lat: latKmNorth(19), needs: ["Pasta"], latestNeed: null }],
      locations: [{ id: 10, foodbank_id: 1, lat: latKmNorth(1) }],
    });
    await expect(search("Pasta")).rejects.toThrow(TypeError);
  });

  // THE THREE BELOW USED TO ASSERT A 500 on a row that vanished between the
  // coordinate scan and the hydration read, "documented here so a future
  // change to that is a deliberate decision rather than a silent one".
  // github #48 is that decision: the row is dropped and the rest of the list
  // survives. Django ranks and hydrates in one queryset and so cannot reach
  // this state at all; the crash was the port's own two-phase read showing
  // through.
  //
  // The two B12 tests above are untouched and still throw. The rule that
  // separates them: a row that is FOUND with a null latest_need fails in
  // Django too and must keep failing here; a row that is NOT FOUND is a
  // window Django does not have, and degrades to the shorter list Django
  // would have produced.
  it("drops a ranked winner whose full row is missing when hydration runs", async () => {
    setWorld({ foodbanks: [{ id: 1, lat: latKmNorth(1), needs: ["Pasta"] }] });
    db.getFoodbanksByIds.mockResolvedValue([]);
    await expect(search("Pasta")).resolves.toEqual([]);
  });

  it("drops a winning LOCATION whose own row is missing, keeping the rest", async () => {
    // Pinned separately because the two maps are populated from different
    // queries: a guard added to the organisation branch alone would leave
    // this one crashing, and vice versa.
    //
    // The food bank at 19 km is INSIDE the radius and survives, so this
    // asserts a drop rather than an empty list -- on a one-row world those
    // two are the same assertion and only the first is the fix.
    setWorld({
      foodbanks: [{ id: 1, lat: latKmNorth(19), needs: ["Pasta"] }],
      locations: [{ id: 10, foodbank_id: 1, lat: latKmNorth(1) }],
    });
    db.getLocationsByIds.mockResolvedValue([]);

    const results = await search("Pasta");
    expect(results.map((r) => r.type)).toEqual(["organisation"]);
  });

  it("drops a winning location whose PARENT food bank row is missing", async () => {
    // The parent lookup is a separate round trip issued after the location
    // rows come back, so a food bank deleted in between resolves to
    // undefined here. The parent is beyond the ceiling in this world, so the
    // organisation branch is not involved at all -- this is purely
    // foodbankById.get() on the location branch.
    setWorld({
      foodbanks: [{ id: 1, lat: latKmNorth(25), needs: ["Pasta"] }],
      locations: [{ id: 10, foodbank_id: 1, lat: latKmNorth(1) }],
    });
    db.getFoodbanksByIds.mockResolvedValue([]);
    await expect(search("Pasta")).resolves.toEqual([]);
  });
});
