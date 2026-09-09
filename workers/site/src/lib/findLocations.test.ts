import { beforeEach, describe, expect, it, vi } from "vitest";
import { R_EARTHDISTANCE, R_PYTHON, haversineMeters, miles } from "@givefood/geo";
import type { CoordinateRow, FoodbankChangeRow, FoodbankLocationRow, FoodbankWithLatestNeed, Session } from "@givefood/db";

// findLocations() is the query behind the /needs/ index page and every
// /needs/at/<slug>/nearby/ page -- between them the busiest pair of pages
// on the site. It is a port of givefood/utils/geo.py's find_locations(),
// and almost everything worth testing about it is a JOIN it performs in
// application code that Postgres used to perform in SQL:
//
//   * two candidate scans, ranked as ONE list (PLAN.md §7.5.2), not
//     Django's two independently-capped querysets;
//   * a third round trip for the *parent* food bank of every winning
//     location, because a location row carries no facebook_page and no
//     latest_need of its own -- Django got those through
//     `location.foodbank` on a prefetched queryset;
//   * two different decoration shapes behind one result type, so the
//     template can render either kind of row with one macro.
//
// The db layer is mocked here on purpose. What is under test is the
// wiring -- which ids get hydrated, which parent supplies which field,
// what the ranking window is -- not the SQL, which is packages/db's
// contract. @givefood/geo and @givefood/models are NOT mocked: the miles
// conversion, the earthdistance radius and the phone/email fallbacks are
// part of what this function promises its callers, so they run for real.

const db = vi.hoisted(() => ({
  getOpenFoodbankCoordinates: vi.fn(),
  getOpenLocationCoordinates: vi.fn(),
  getFoodbanksByIds: vi.fn(),
  getLocationsByIds: vi.fn(),
}));
vi.mock("@givefood/db", () => db);

import { findLocations, type LocationSearchResult } from "./findLocations";

// A sentinel rather than a real D1DatabaseSession. Every read must be
// issued through THIS object -- PLAN.md §3.3: this database has read
// replication on, and a query that escapes the caller's session can land
// on a replica that has not caught up with a just-committed write.
const SESSION = { sessionMarker: "the caller's D1 session" } as unknown as Session;

// Central London, the origin every test searches from.
const LAT = 51.5074;
const LNG = -0.1278;

const coord = (id: number, latitude: number, longitude: number): CoordinateRow => ({ id, latitude, longitude });

// Real UK coordinates so the distances below are the sort of numbers these
// pages actually publish, and deliberately interleaved by type: nearest is
// a LOCATION, then two food banks, then a location. A implementation that
// ranked the two kinds separately and concatenated them would produce a
// plausible-looking list and fail every ordering assertion here.
const BATTERSEA = coord(201, 51.47, -0.17); // ~5 km  -- location, parent food bank 301
const CROYDON = coord(101, 51.3762, -0.0982); // ~15 km -- food bank
const WATFORD = coord(102, 51.6565, -0.3903); // ~25 km -- food bank
const OXFORD_LOC = coord(202, 51.752, -1.2577); // ~80 km -- location, parent food bank 302
const CLAPHAM = coord(203, 51.462, -0.138); // ~5 km  -- location, ALSO parent food bank 301
const CROYDON_OUTREACH = coord(204, 51.38, -0.1); // ~15 km -- location whose parent IS food bank 101

// `foodbank.id` and `foodbanklocation.id` are separate AUTOINCREMENT
// sequences, so the two tables' primary keys overlap for almost every
// small id in production. The fixtures above use disjoint 1xx/2xx ranges
// for legibility, which would hide a port that hydrated both kinds through
// one id map; these two exist so that at least one test does not.
const SHARED_ID_FOODBANK = coord(500, 51.45, -0.2); // ~8 km  -- food bank 500
const SHARED_ID_LOCATION = coord(500, 51.6, -0.15); // ~10 km -- location 500, parent food bank 301

const FOODBANK_COORDS = [CROYDON, WATFORD];
const LOCATION_COORDS = [BATTERSEA, OXFORD_LOC];

// Distance from LAT/LNG to each fixture, keyed by the slug it produces, so
// a test can assert that the distance published against a row is the
// distance to THAT row. Computed by the tests themselves from
// haversineMeters(); the miles figures in the comments were derived
// independently and are asserted separately.
const COORD_BY_SLUG: Record<string, CoordinateRow> = {
  "battersea-centre": BATTERSEA, // 3.161671 mi
  croydon: CROYDON, // 9.164536 mi
  watford: WATFORD, // 15.286265 mi
  "oxford-pantry": OXFORD_LOC, // 51.379853 mi
};

function need(id: number, changeText: string): FoodbankChangeRow {
  return { id, change_text: changeText } as unknown as FoodbankChangeRow;
}

// Only the columns findLocations actually reads. Casting keeps the fixtures
// legible -- FoodbankRow has 60+ columns and none of the others can change
// the outcome of this function.
function foodbank(row: Partial<FoodbankWithLatestNeed> & { id: number }): FoodbankWithLatestNeed {
  return {
    name: `Food bank ${row.id}`,
    slug: `food-bank-${row.id}`,
    phone_number: null,
    contact_email: `fb${row.id}@example.org`,
    facebook_page: null,
    latestNeed: need(9000 + row.id, `Need text for ${row.id}`),
    ...row,
  } as unknown as FoodbankWithLatestNeed;
}

function location(row: Partial<FoodbankLocationRow> & { id: number; foodbank_id: number }): FoodbankLocationRow {
  const parent = FOODBANKS.get(row.foodbank_id);
  return {
    name: `Location ${row.id}`,
    slug: `location-${row.id}`,
    foodbank_name: parent ? parent.name : `Food bank ${row.foodbank_id}`,
    foodbank_slug: parent ? parent.slug : `food-bank-${row.foodbank_id}`,
    foodbank_phone_number: parent ? parent.phone_number : null,
    foodbank_email: parent ? parent.contact_email : `fb${row.foodbank_id}@example.org`,
    phone_number: null,
    email: null,
    // The blob the "no spreading rows into the result" test is about.
    boundary_geojson: '{"type":"Polygon","coordinates":[]}',
    ...row,
  } as unknown as FoodbankLocationRow;
}

const FOODBANKS = new Map<number, FoodbankWithLatestNeed>(
  [
    foodbank({
      id: 101,
      name: "Croydon",
      slug: "croydon",
      phone_number: "020 1111 1111",
      contact_email: "croydon@example.org",
      facebook_page: "https://facebook.com/croydonfoodbank",
      latestNeed: need(9101, "Tinned soup\nPasta"),
    }),
    // No phone number and no Facebook page: the organisation branch has no
    // parent to fall back to, so these must survive to the template as null.
    foodbank({ id: 102, name: "Watford", slug: "watford", latestNeed: need(9102, "Nothing") }),
    foodbank({
      id: 301,
      name: "Wandsworth",
      slug: "wandsworth",
      phone_number: "020 3333 3333",
      contact_email: "wandsworth@example.org",
      facebook_page: "https://facebook.com/wandsworthfoodbank",
      latestNeed: need(9301, "Long life milk\nTinned fruit"),
    }),
    foodbank({
      id: 302,
      name: "Oxford",
      slug: "oxford",
      phone_number: "01865 000000",
      contact_email: "oxford@example.org",
      latestNeed: need(9302, "Nappies"),
    }),
    foodbank({ id: 500, name: "Shared Id Food Bank", slug: "shared-id-food-bank", latestNeed: need(9500, "Rice") }),
  ].map((fb) => [fb.id, fb]),
);

const LOCATIONS = new Map<number, FoodbankLocationRow>(
  [
    location({ id: 201, foodbank_id: 301, name: "Battersea Centre", slug: "battersea-centre" }),
    location({ id: 202, foodbank_id: 302, name: "Oxford Pantry", slug: "oxford-pantry" }),
    location({ id: 203, foodbank_id: 301, name: "Clapham Centre", slug: "clapham-centre" }),
    location({ id: 204, foodbank_id: 101, name: "Croydon Outreach", slug: "croydon-outreach" }),
    // Shares id 500 with a food bank, and 301 with two other locations'
    // parent -- see SHARED_ID_LOCATION.
    location({ id: 500, foodbank_id: 301, name: "Shared Id Centre", slug: "shared-id-centre" }),
  ].map((loc) => [loc.id, loc]),
);

// Stand-ins for the real by-ids readers, reproducing the one behaviour of
// theirs findLocations can observe: an id with no row is silently dropped
// (both functions `.filter(row => row !== undefined)`).
const fetchFoodbanks = (_session: Session, ids: readonly number[]): Promise<FoodbankWithLatestNeed[]> =>
  Promise.resolve(ids.map((id) => FOODBANKS.get(id)).filter((row): row is FoodbankWithLatestNeed => row !== undefined));
const fetchLocations = (_session: Session, ids: readonly number[]): Promise<FoodbankLocationRow[]> =>
  Promise.resolve(ids.map((id) => LOCATIONS.get(id)).filter((row): row is FoodbankLocationRow => row !== undefined));

beforeEach(() => {
  vi.clearAllMocks();
  db.getOpenFoodbankCoordinates.mockResolvedValue(FOODBANK_COORDS);
  db.getOpenLocationCoordinates.mockResolvedValue(LOCATION_COORDS);
  db.getFoodbanksByIds.mockImplementation(fetchFoodbanks);
  db.getLocationsByIds.mockImplementation(fetchLocations);
});

const identify = (results: LocationSearchResult[]) => results.map((r) => `${r.type}:${r.slug}`);

describe("findLocations ranking", () => {
  it("ranks food banks and locations as one combined list, nearest first", async () => {
    // The documented happy path, and the shape PLAN.md §7.5.2 is about:
    // ONE nearest() call over `[...foodbanks, ...locations]`. The expected
    // order interleaves the two kinds, so a port that ranked each kind
    // separately -- or that trusted the order D1 returned rows in -- cannot
    // pass.
    const results = await findLocations(SESSION, LAT, LNG, 4);
    expect(identify(results)).toEqual([
      "location:battersea-centre",
      "organisation:croydon",
      "organisation:watford",
      "location:oxford-pantry",
    ]);
  });

  it("pairs every result with the distance to its OWN coordinate row", async () => {
    // What every consumer relies on when it renders "nearest first" without
    // re-sorting: index.njk and nearby.njk both iterate the list as given.
    // Asserting per-row rather than "the list is sorted" is deliberate --
    // a `sorted()` check also passes when every row carries the SAME
    // distance (e.g. a decoration loop that closed over the first
    // Ranked entry instead of destructuring its own), which would publish
    // "3.2 miles away" against a food bank fifty miles off.
    const results = await findLocations(SESSION, LAT, LNG, 4);
    for (const result of results) {
      const own = COORD_BY_SLUG[result.slug]!;
      expect(result.distance_mi).toBe(miles(haversineMeters(LAT, LNG, own.latitude, own.longitude, R_EARTHDISTANCE)));
    }
    // Strictly increasing, not merely non-decreasing: these four fixtures
    // have no ties, so equal neighbours would mean a mispairing.
    const distances = results.map((r) => r.distance_mi);
    for (let i = 1; i < distances.length; i++) expect(distances[i]!).toBeGreaterThan(distances[i - 1]!);
    // Independently-derived values (metres -> miles by hand), so this fails
    // if the whole conversion chain drifts rather than only if it stops
    // agreeing with itself.
    expect(distances[0]!).toBeCloseTo(3.1617, 3);
    expect(distances[1]!).toBeCloseTo(9.1645, 3);
    expect(distances[2]!).toBeCloseTo(15.2863, 3);
    expect(distances[3]!).toBeCloseTo(51.3799, 3);
  });

  it("publishes distance_mi in miles, measured with the earthdistance radius", async () => {
    // PLAN.md §7.5.1 keeps two Earth radii, per endpoint: "Do not unify."
    // These pages are on the earthdistance (api/2) side, so assert the exact
    // value and assert it is NOT the api/1 R_PYTHON one -- the two differ by
    // 0.175%, which is invisible in a smoke test but a changed number on
    // every rendered "3.2 miles away".
    const [nearest] = await findLocations(SESSION, LAT, LNG, 1);
    expect(nearest!.distance_mi).toBe(miles(haversineMeters(LAT, LNG, BATTERSEA.latitude, BATTERSEA.longitude, R_EARTHDISTANCE)));
    expect(nearest!.distance_mi).not.toBe(miles(haversineMeters(LAT, LNG, BATTERSEA.latitude, BATTERSEA.longitude, R_PYTHON)));
    // Battersea is about three miles from Charing Cross. A units slip
    // (metres left unconverted, or kilometres) lands nowhere near this.
    expect(nearest!.distance_mi).toBeGreaterThan(2.5);
    expect(nearest!.distance_mi).toBeLessThan(3.5);
  });

  it("keeps the ranked order even when the hydration reads come back shuffled", async () => {
    // `WHERE id IN (...)` gives SQLite no ordering obligation. The result
    // order here must come from the distance ranking, not from whatever
    // order D1 hands rows back in -- so feed it the worst case, every
    // hydration read reversed, and demand the same answer.
    db.getFoodbanksByIds.mockImplementation((session: Session, ids: readonly number[]) =>
      fetchFoodbanks(session, ids).then((rows) => rows.reverse()),
    );
    db.getLocationsByIds.mockImplementation((session: Session, ids: readonly number[]) =>
      fetchLocations(session, ids).then((rows) => rows.reverse()),
    );
    const results = await findLocations(SESSION, LAT, LNG, 4);
    expect(identify(results)).toEqual([
      "location:battersea-centre",
      "organisation:croydon",
      "organisation:watford",
      "location:oxford-pantry",
    ]);
  });

  it("resolves a food-bank/location tie in the food bank's favour", async () => {
    // Several food banks share a building with one of their own locations,
    // so exact ties are real. Django builds `chain(foodbanks, locations)`
    // and calls `sorted()`, which is stable -- food banks first. This port
    // spreads the two candidate arrays in the same order into a JS sort,
    // which is also required to be stable. Byte-identical ordering between
    // Django and the Worker depends on that agreement.
    db.getOpenFoodbankCoordinates.mockResolvedValue([coord(101, LAT, LNG)]);
    db.getOpenLocationCoordinates.mockResolvedValue([coord(201, LAT, LNG)]);
    const results = await findLocations(SESSION, LAT, LNG, 2);
    expect(identify(results)).toEqual(["organisation:croydon", "location:battersea-centre"]);
    expect(results.map((r) => r.distance_mi)).toEqual([0, 0]);
  });
});

describe("findLocations quantity and skipFirst", () => {
  it("caps the result at `quantity` across both kinds together", async () => {
    // Django caps each queryset at `quantity` and merges; this ranks the
    // union once and slices once. PLAN.md §7.5.2 proves those agree for
    // every skip_first=False search, which is this call. Two results, not
    // two of each.
    expect(await findLocations(SESSION, LAT, LNG, 2)).toHaveLength(2);
    expect(identify(await findLocations(SESSION, LAT, LNG, 2))).toEqual([
      "location:battersea-centre",
      "organisation:croydon",
    ]);
  });

  it("gives the whole window to one kind when that kind holds the nearest rows", async () => {
    // The case above happens to be one-of-each, so it passes just as well
    // against a port that took the nearest food bank and the nearest
    // location and called it a top-2. These two do not: the top two here
    // are both locations, and in the mirror below both food banks -- which
    // is what "ranked as ONE list" actually means on a /needs/ search made
    // from a town whose nearest help is all outreach centres, or all
    // full food banks.
    db.getOpenLocationCoordinates.mockResolvedValue([BATTERSEA, SHARED_ID_LOCATION]);
    expect(identify(await findLocations(SESSION, LAT, LNG, 2))).toEqual([
      "location:battersea-centre",
      "location:shared-id-centre",
    ]);

    db.getOpenLocationCoordinates.mockResolvedValue([OXFORD_LOC]);
    expect(identify(await findLocations(SESSION, LAT, LNG, 2))).toEqual([
      "organisation:croydon",
      "organisation:watford",
    ]);
  });

  it("returns everything it has when quantity exceeds the candidate count", async () => {
    expect(await findLocations(SESSION, LAT, LNG, 500)).toHaveLength(4);
  });

  it("returns an empty list for quantity 0 without hydrating anything", async () => {
    const results = await findLocations(SESSION, LAT, LNG, 0);
    expect(results).toEqual([]);
    expect(db.getFoodbanksByIds).toHaveBeenCalledWith(SESSION, []);
    expect(db.getLocationsByIds).toHaveBeenCalledWith(SESSION, []);
  });

  it("skipFirst drops the nearest result and still returns `quantity` items", async () => {
    // gfwfbn/views.py's foodbank_nearby calls find_locations(lat_lng, 20,
    // True) to drop the food bank itself from its own nearby list. Django
    // writes that as `first_item = 1; quantity = quantity + 1` then
    // `[first_item:quantity]` -- i.e. TWENTY items, not nineteen. The
    // window shifts by one, it does not shrink.
    const withSkip = await findLocations(SESSION, LAT, LNG, 2, true);
    expect(withSkip).toHaveLength(2);
    expect(identify(withSkip)).toEqual(["organisation:croydon", "organisation:watford"]);
    // The skip happens BEFORE hydration: Battersea was the nearest row and
    // is not fetched at all. A port that hydrated the ranked list and then
    // dropped the first result would read one wasted full row -- with
    // boundary_geojson on it -- on every /needs/at/<slug>/nearby/ request.
    expect(db.getLocationsByIds).toHaveBeenCalledWith(SESSION, []);
    expect(db.getFoodbanksByIds).toHaveBeenCalledTimes(1);
  });

  it("scans globally under skipFirst, diverging from Django's two capped legs", async () => {
    // The divergence the module comment and nearby.ts's known-divergence
    // food bank list are about, exercised where it is actually visible.
    // Three locations here are nearer than any food bank (5.1 km, 10.4 km
    // and 14.3 km, against Croydon's 14.7 km). Django caps each queryset at
    // `quantity` BEFORE merging, so its location leg stops at the first
    // two and Croydon Outreach is never loaded at all; its skip_first
    // window then reaches past them into the food bank leg. This port ranks
    // all five together and takes items 1 and 2 of that one list, so the
    // third location survives and the food bank does not.
    //
    //   this port (global):  [shared-id-centre, croydon-outreach]
    //   Django (two legs):   [shared-id-centre, croydon]
    //
    // Deliberate, per PLAN.md's "Documented divergence" writeup -- so if
    // anyone ever reinstates the two-leg cap to chase byte-parity, this is
    // the test that has to be argued with. Every skip_first=False search is
    // unaffected (§7.5.2's proof), which is why only this test needs the
    // larger candidate set.
    db.getOpenLocationCoordinates.mockResolvedValue([BATTERSEA, CROYDON_OUTREACH, SHARED_ID_LOCATION]);
    const results = await findLocations(SESSION, LAT, LNG, 2, true);
    expect(identify(results)).toEqual(["location:shared-id-centre", "location:croydon-outreach"]);
  });

  it("clips the shifted window at the end of the candidate list", async () => {
    // skipFirst moves the window one along without extending the candidate
    // set, so a nearby page for a food bank in a thinly-served area gets
    // fewer than `quantity` rows -- four candidates, quantity four, three
    // results. nearby.ts renders whatever it gets, so the only wrong answer
    // here is padding the list or throwing on the short read.
    const withSkip = await findLocations(SESSION, LAT, LNG, 4, true);
    expect(identify(withSkip)).toEqual(["organisation:croydon", "organisation:watford", "location:oxford-pantry"]);
  });

  it("defaults skipFirst to false, which is what the /needs/ index page relies on", async () => {
    // routes/wfbn/index.ts calls findLocations(session, lat, lng, 20) with
    // no fifth argument. If the default ever flipped, the index page would
    // silently stop showing the user's nearest food bank.
    const defaulted = await findLocations(SESSION, LAT, LNG, 3);
    const explicit = await findLocations(SESSION, LAT, LNG, 3, false);
    expect(identify(defaulted)).toEqual(identify(explicit));
    expect(identify(defaulted)[0]).toBe("location:battersea-centre");
  });

  it("returns an empty list under skipFirst when there is only one candidate", async () => {
    // A /needs/at/<slug>/nearby/ page for the only open food bank in the
    // candidate set. nearby.ts turns an empty array into null for the
    // template's `{% if nearby %}` guard, so this must be [] and not a throw.
    db.getOpenFoodbankCoordinates.mockResolvedValue([CROYDON]);
    db.getOpenLocationCoordinates.mockResolvedValue([]);
    expect(await findLocations(SESSION, LAT, LNG, 20, true)).toEqual([]);
  });
});

describe("findLocations empty and partial candidate sets", () => {
  it("returns an empty list when no open rows exist at all", async () => {
    // Reachable for real during a migration or a bad deploy. The /needs/
    // index page must render an empty results section, not 500.
    db.getOpenFoodbankCoordinates.mockResolvedValue([]);
    db.getOpenLocationCoordinates.mockResolvedValue([]);
    expect(await findLocations(SESSION, LAT, LNG, 20)).toEqual([]);
  });

  it("works when only the location scan returns rows", async () => {
    // A food-bank-free result set is not hypothetical: it is what a search
    // from anywhere near a Salvation Army cluster looks like.
    db.getOpenFoodbankCoordinates.mockResolvedValue([]);
    expect(identify(await findLocations(SESSION, LAT, LNG, 20))).toEqual([
      "location:battersea-centre",
      "location:oxford-pantry",
    ]);
  });

  it("works when only the food bank scan returns rows", async () => {
    db.getOpenLocationCoordinates.mockResolvedValue([]);
    expect(identify(await findLocations(SESSION, LAT, LNG, 20))).toEqual([
      "organisation:croydon",
      "organisation:watford",
    ]);
  });

  it("ranks a row with a NULL latitude as if it were at 0,0 rather than dropping it", async () => {
    // packages/db types these columns as `number`, but PLAN.md §2.4.2 says
    // production really does hold NULLs, and the partial index they are
    // scanned through does not exclude them. A NULL arrives here as JS null,
    // and `null - 51.5074` is -51.5074, not NaN -- so the row is ranked as
    // Null Island, ~5,700 km away, and simply never wins. Documented, not
    // endorsed: nothing filters these out, and nothing throws on them.
    db.getOpenFoodbankCoordinates.mockResolvedValue([
      { id: 101, latitude: null, longitude: null } as unknown as CoordinateRow,
    ]);
    db.getOpenLocationCoordinates.mockResolvedValue([BATTERSEA]);
    const results = await findLocations(SESSION, LAT, LNG, 2);
    expect(identify(results)).toEqual(["location:battersea-centre", "organisation:croydon"]);
    const stranded = results[1]!;
    expect(Number.isFinite(stranded.distance_mi)).toBe(true);
    expect(stranded.distance_mi).toBeGreaterThan(3000); // ~3,560 miles, off the coast of Ghana
  });

  it("returns unranked leading rows with NaN distances when the ORIGIN is not a number", async () => {
    // Reachable from md/foodbank.ts and nearby.ts, which both do
    // `const [latStr, lngStr] = foodbank.lat_lng.split(",")` and then
    // `Number(lngStr)` -- a lat_lng with no comma in it (an admin typo, a
    // half-written geocode) makes lngStr undefined and lng NaN. Nothing
    // here validates the origin, so every haversine returns NaN, the sort
    // comparator sees NaN (spec: treated as +0, order preserved) and the
    // page renders the first rows of the candidate scan, in rowid order,
    // each captioned "NaN miles". Documented, not endorsed: the failure is
    // silent and wrong rather than loud, which is worth knowing before
    // anyone "tidies up" the callers' parsing.
    const results = await findLocations(SESSION, LAT, Number("not-a-longitude"), 2);
    expect(identify(results)).toEqual(["organisation:croydon", "organisation:watford"]);
    expect(results.every((r) => Number.isNaN(r.distance_mi))).toBe(true);
    // Still fully decorated -- it is only the distance that is junk.
    expect(results[0]!.latest_need_change_text).toBe("Tinned soup\nPasta");
  });
});

describe("findLocations hydration round trips", () => {
  it("fetches full rows only for the ranked winners, never for the whole open set", async () => {
    // The whole point of WP 2.5's split: the two scans read three columns
    // per open row, and only the survivors are read in full. If these ever
    // received the full candidate id lists, every uncached /needs/ request
    // would pull thousands of 40-80 column rows to render twenty.
    await findLocations(SESSION, LAT, LNG, 2);
    expect(db.getFoodbanksByIds).toHaveBeenNthCalledWith(1, SESSION, [101]);
    expect(db.getLocationsByIds).toHaveBeenCalledWith(SESSION, [201]);
  });

  it("issues a third read for the parent food bank of every winning location", async () => {
    // A foodbanklocation row carries no facebook_page and no latest_need,
    // so the location branch cannot be decorated without its parent. Django
    // got this free through `Prefetch("foodbank", ...)`; here it is an
    // explicit extra round trip, and it must be keyed on the WINNING
    // locations' foodbank_ids, not on anything wider.
    await findLocations(SESSION, LAT, LNG, 4);
    expect(db.getFoodbanksByIds).toHaveBeenNthCalledWith(1, SESSION, [101, 102]);
    expect(db.getFoodbanksByIds).toHaveBeenNthCalledWith(2, SESSION, [301, 302]);
    expect(db.getFoodbanksByIds).toHaveBeenCalledTimes(2);
  });

  it("deduplicates parents, so two locations of one food bank cost one lookup", async () => {
    // Salvation Army has ~596 open locations (see nearby.ts's divergence
    // note), so a nearby search can easily return twenty locations that all
    // share one parent. Without the Set this would bind the same id twenty
    // times into one IN clause.
    db.getOpenFoodbankCoordinates.mockResolvedValue([]);
    db.getOpenLocationCoordinates.mockResolvedValue([BATTERSEA, CLAPHAM]);
    await findLocations(SESSION, LAT, LNG, 2);
    expect(db.getFoodbanksByIds).toHaveBeenNthCalledWith(2, SESSION, [301]);
  });

  it("skips the parent query entirely when no location made the cut", async () => {
    // The `parentFoodbankIds.length === 0 ? [] : await ...` guard. On a
    // food-bank-only result set this saves a whole D1 round trip on one of
    // the two hottest pages, so it is worth a test of its own -- a
    // refactor to an unconditional call would be invisible in the output.
    db.getOpenLocationCoordinates.mockResolvedValue([]);
    await findLocations(SESSION, LAT, LNG, 2);
    expect(db.getFoodbanksByIds).toHaveBeenCalledTimes(1);
    expect(db.getLocationsByIds).toHaveBeenCalledWith(SESSION, []);
  });

  it("re-reads a food bank that both won on its own and parents a winning location", async () => {
    // Current behaviour, documented rather than endorsed: `parentFoodbankIds`
    // is not subtracted from `organisationIds`, so id 101 is fetched twice
    // in two separate D1 queries. Harmless for correctness -- the later
    // entry simply overwrites the earlier one in the id map -- but it is a
    // redundant round trip on a page that already makes three.
    db.getOpenFoodbankCoordinates.mockResolvedValue([CROYDON]);
    db.getOpenLocationCoordinates.mockResolvedValue([CROYDON_OUTREACH]);
    const results = await findLocations(SESSION, LAT, LNG, 2);
    expect(db.getFoodbanksByIds).toHaveBeenNthCalledWith(1, SESSION, [101]);
    expect(db.getFoodbanksByIds).toHaveBeenNthCalledWith(2, SESSION, [101]);
    expect(identify(results)).toEqual(["location:croydon-outreach", "organisation:croydon"]);
  });

  it("lets the later parent read win in the id map when one food bank is fetched twice", async () => {
    // The other half of the duplicate-fetch above, and the reason it is
    // merely wasteful rather than wrong: `new Map([...organisationFoodbanks,
    // ...parentFoodbanks])` is last-wins, so the organisation branch reads
    // whatever the SECOND query returned. Two separate D1 reads can
    // genuinely disagree -- an admin saving a new need between them is all
    // it takes -- so pin which one the page shows rather than assuming the
    // question never comes up. Reversing the spread would flip this.
    db.getOpenFoodbankCoordinates.mockResolvedValue([CROYDON]);
    db.getOpenLocationCoordinates.mockResolvedValue([CROYDON_OUTREACH]);
    db.getFoodbanksByIds
      .mockImplementationOnce(fetchFoodbanks)
      .mockImplementationOnce((session: Session, ids: readonly number[]) =>
        fetchFoodbanks(session, ids).then((rows) =>
          rows.map((row) => ({ ...row, name: "Croydon (second read)", latestNeed: need(9999, "Second read") })),
        ),
      );
    const results = await findLocations(SESSION, LAT, LNG, 2);
    const organisation = results.find((r) => r.type === "organisation")!;
    expect(organisation.name).toBe("Croydon (second read)");
    expect(organisation.latest_need_id).toBe(9999);
  });

  it("hydrates a food bank and a location that share an id from their own tables", async () => {
    // The two tables' primary keys overlap -- see SHARED_ID_FOODBANK. Both
    // ranked rows here are id 500, and each must be looked up in its own
    // map: one id map for both kinds, or an id list built without the kind
    // filter, would silently render one row's need against the other's
    // name. Nothing else in this file exercises it, because every other
    // fixture uses conveniently disjoint id ranges.
    db.getOpenFoodbankCoordinates.mockResolvedValue([SHARED_ID_FOODBANK]);
    db.getOpenLocationCoordinates.mockResolvedValue([SHARED_ID_LOCATION]);
    const results = await findLocations(SESSION, LAT, LNG, 2);
    expect(db.getFoodbanksByIds).toHaveBeenNthCalledWith(1, SESSION, [500]);
    expect(db.getLocationsByIds).toHaveBeenCalledWith(SESSION, [500]);
    expect(identify(results)).toEqual(["organisation:shared-id-food-bank", "location:shared-id-centre"]);
    expect(results[0]!.name).toBe("Shared Id Food Bank");
    expect(results[0]!.latest_need_id).toBe(9500);
    expect(results[1]!.name).toBe("Shared Id Centre");
    expect(results[1]!.foodbank_name).toBe("Wandsworth");
    expect(results[1]!.latest_need_id).toBe(9301);
  });

  it("issues both candidate scans concurrently, not one after the other", async () => {
    // Two full covering-index scans on the hottest page in the site. They
    // are in a Promise.all, so their latency overlaps; an `await` on each
    // in turn would look identical in a diff and double the fixed cost of
    // every uncached search. The interleaving below is only possible if
    // both calls are issued before either is awaited.
    const trace: string[] = [];
    db.getOpenFoodbankCoordinates.mockImplementation(() => {
      trace.push("foodbanks:issued");
      return new Promise((resolve) =>
        setTimeout(() => {
          trace.push("foodbanks:settled");
          resolve(FOODBANK_COORDS);
        }, 0),
      );
    });
    db.getOpenLocationCoordinates.mockImplementation(() => {
      trace.push("locations:issued");
      return Promise.resolve(LOCATION_COORDS).then((rows) => {
        trace.push("locations:settled");
        return rows;
      });
    });
    await findLocations(SESSION, LAT, LNG, 4);
    expect(trace).toEqual(["foodbanks:issued", "locations:issued", "locations:settled", "foodbanks:settled"]);
  });

  it("issues the two hydration reads concurrently, and the parent read only after them", async () => {
    // Same reasoning as the scan test above, for the second wave: the
    // winners' full rows are read in one Promise.all, so a page showing ten
    // food banks and ten locations pays one round trip, not two. The parent
    // read genuinely cannot join that wave -- it is keyed on foodbank_ids
    // that only exist once the location rows are back -- so this also pins
    // the shape as "two waves, three reads", which is what the /needs/
    // latency budget in PLAN.md assumes.
    const trace: string[] = [];
    db.getFoodbanksByIds.mockImplementation((session: Session, ids: readonly number[]) => {
      const label = `foodbanks[${ids.join(",")}]`;
      trace.push(`${label}:issued`);
      // Deliberately the slow one: if the two reads were awaited in turn,
      // this timer would have to settle before the locations read was even
      // issued, and the trace below could not interleave.
      return new Promise((resolve) =>
        setTimeout(() => {
          trace.push(`${label}:settled`);
          resolve(fetchFoodbanks(session, ids));
        }, 0),
      );
    });
    db.getLocationsByIds.mockImplementation((session: Session, ids: readonly number[]) => {
      trace.push("locations:issued");
      return fetchLocations(session, ids).then((rows) => {
        trace.push("locations:settled");
        return rows;
      });
    });
    await findLocations(SESSION, LAT, LNG, 4);
    expect(trace).toEqual([
      "foodbanks[101,102]:issued",
      "locations:issued",
      "locations:settled",
      "foodbanks[101,102]:settled",
      "foodbanks[301,302]:issued",
      "foodbanks[301,302]:settled",
    ]);
  });

  it("threads the caller's own session into every read", async () => {
    // PLAN.md §3.3: read replication is on, and every query in a request
    // must run through the session the caller created from its bookmark.
    // A read that reached for the raw binding instead could serve a stale
    // replica -- e.g. a food bank edited in the admin a second earlier.
    await findLocations(SESSION, LAT, LNG, 4);
    for (const mock of [db.getOpenFoodbankCoordinates, db.getOpenLocationCoordinates, db.getFoodbanksByIds, db.getLocationsByIds]) {
      expect(mock).toHaveBeenCalled();
      for (const call of mock.mock.calls) expect(call[0]).toBe(SESSION);
    }
  });
});

describe("findLocations organisation decoration", () => {
  it("duplicates name into foodbank_name and slug into foodbank_slug", async () => {
    // givefood/utils/geo.py: `foodbank.foodbank_name = foodbank.name` and
    // `foodbank.foodbank_slug = foodbank.slug`. The template renders both
    // kinds of row through the same markup, so an organisation has to
    // answer to the location field names too.
    db.getOpenLocationCoordinates.mockResolvedValue([]);
    const [croydon] = await findLocations(SESSION, LAT, LNG, 1);
    expect(croydon!.name).toBe("Croydon");
    expect(croydon!.foodbank_name).toBe("Croydon");
    expect(croydon!.slug).toBe("croydon");
    expect(croydon!.foodbank_slug).toBe("croydon");
    expect(croydon!.type).toBe("organisation");
  });

  it("publishes the food bank's own contact details with no fallback applied", async () => {
    // Django only calls phone_or_foodbank_phone()/email_or_foodbank_email()
    // in the LOCATION loop. A food bank is its own parent, so its columns
    // go out verbatim -- including a null phone_number, which the template
    // is expected to hide rather than receive a substitute for.
    db.getOpenLocationCoordinates.mockResolvedValue([]);
    const [croydon, watford] = await findLocations(SESSION, LAT, LNG, 2);
    expect(croydon!.phone_number).toBe("020 1111 1111");
    expect(croydon!.contact_email).toBe("croydon@example.org");
    expect(croydon!.facebook_page).toBe("https://facebook.com/croydonfoodbank");
    expect(watford!.phone_number).toBeNull();
    expect(watford!.facebook_page).toBeNull();
  });

  it("reads the latest need off the food bank row itself", async () => {
    db.getOpenLocationCoordinates.mockResolvedValue([]);
    const [croydon] = await findLocations(SESSION, LAT, LNG, 1);
    expect(croydon!.latest_need_change_text).toBe("Tinned soup\nPasta");
    expect(croydon!.latest_need_id).toBe(9101);
  });
});

describe("findLocations location decoration", () => {
  it("uses the location's own name and slug, with the parent's denormalised slug alongside", async () => {
    // foodbank_slug/foodbank_name are columns on foodbanklocation_full, not
    // fields read off the parent row -- the template builds
    // /needs/at/<foodbank_slug>/<slug>/ from this pair, so mixing them up
    // produces a 404 link rather than a visible error.
    const [battersea] = await findLocations(SESSION, LAT, LNG, 1);
    expect(battersea!.type).toBe("location");
    expect(battersea!.name).toBe("Battersea Centre");
    expect(battersea!.slug).toBe("battersea-centre");
    expect(battersea!.foodbank_name).toBe("Wandsworth");
    expect(battersea!.foodbank_slug).toBe("wandsworth");
  });

  it("falls back to the parent food bank's phone and email, Django's `or` semantics", async () => {
    // FoodbankLocation.phone_or_foodbank_phone() / email_or_foodbank_email()
    // are Python `or` expressions, which fall through on ANY falsy value.
    // An empty string is the realistic one: these columns are blank=True in
    // Django, so "not set" reaches the database as '' far more often than
    // as NULL. A `??` here would publish a blank phone number instead of
    // the food bank's real one.
    const [battersea] = await findLocations(SESSION, LAT, LNG, 1);
    expect(battersea!.phone_number).toBe("020 3333 3333");
    expect(battersea!.contact_email).toBe("wandsworth@example.org");

    db.getLocationsByIds.mockImplementation((session: Session, ids: readonly number[]) =>
      fetchLocations(session, ids).then((rows) => rows.map((row) => ({ ...row, phone_number: "", email: "" }))),
    );
    const [blank] = await findLocations(SESSION, LAT, LNG, 1);
    expect(blank!.phone_number).toBe("020 3333 3333");
    expect(blank!.contact_email).toBe("wandsworth@example.org");
  });

  it("publishes null when neither the location nor its food bank has a phone number", async () => {
    // `or` bottoms out at the parent's own null -- there is no third
    // fallback and no empty-string substitute. Plenty of real locations
    // belong to a food bank with no published phone number (Watford, in
    // these fixtures), and the template's `{% if phone_number %}` guard
    // relies on getting a falsy value rather than the string "null".
    db.getLocationsByIds.mockImplementation((session: Session, ids: readonly number[]) =>
      fetchLocations(session, ids).then((rows) =>
        rows.map((row) => ({ ...row, phone_number: null, foodbank_phone_number: null })),
      ),
    );
    const [battersea] = await findLocations(SESSION, LAT, LNG, 1);
    expect(battersea!.phone_number).toBeNull();
    // The email fallback is unaffected by the phone one -- separate helpers,
    // separate columns.
    expect(battersea!.contact_email).toBe("wandsworth@example.org");
  });

  it("prefers the location's own phone and email when it has them", async () => {
    db.getLocationsByIds.mockImplementation((session: Session, ids: readonly number[]) =>
      fetchLocations(session, ids).then((rows) =>
        rows.map((row) => ({ ...row, phone_number: "020 9999 9999", email: "battersea@example.org" })),
      ),
    );
    const [battersea] = await findLocations(SESSION, LAT, LNG, 1);
    expect(battersea!.phone_number).toBe("020 9999 9999");
    expect(battersea!.contact_email).toBe("battersea@example.org");
  });

  it("takes facebook_page and the latest need from the PARENT, not the location", async () => {
    // `location.latest_need = location.foodbank.latest_need` in
    // givefood/utils/geo.py. A location has no need of its own -- the whole
    // reason the third round trip exists. Asserting the parent's values,
    // not merely "not null", is what catches a lookup keyed on the wrong id.
    const [battersea] = await findLocations(SESSION, LAT, LNG, 1);
    expect(battersea!.facebook_page).toBe("https://facebook.com/wandsworthfoodbank");
    expect(battersea!.latest_need_change_text).toBe("Long life milk\nTinned fruit");
    expect(battersea!.latest_need_id).toBe(9301);
  });

  it("resolves each location against its own parent when several parents are in play", async () => {
    // Two locations, two different parents, fetched in one IN clause. If
    // the map lookup were positional rather than by foodbank_id, both rows
    // would inherit whichever parent came back first -- a wrong shopping
    // list shown against a real food bank's name.
    const results = await findLocations(SESSION, LAT, LNG, 4);
    const battersea = results.find((r) => r.slug === "battersea-centre")!;
    const oxford = results.find((r) => r.slug === "oxford-pantry")!;
    expect(battersea.latest_need_id).toBe(9301);
    expect(oxford.latest_need_id).toBe(9302);
    expect(oxford.facebook_page).toBeNull();
  });
});

describe("findLocations: a null latest_need, and missing rows", () => {
  // github #13. This pair asserted TypeErrors, on the grounds that "a null
  // latest_need throws here exactly as it 500s in Django" -- and that
  // justification was wrong for this file, which is what made it a high.
  //
  // B12 is real, and it is about the FIVE API views PLAN.md:7305 names:
  // gfapi1/views.py:143 and gfapi2/views.py:401,588 attribute-access None in
  // PYTHON and raise. Nothing that calls findLocations is one of them. On the
  // HTML side Django cannot fail: geo.py's find_locations() only ASSIGNS
  // `location.latest_need = location.foodbank.latest_need`, and
  // wfbn/index.html reaches the value through a TEMPLATE lookup, which
  // swallows the attribute error on None into string_if_invalid. Rendered
  // against the real template shape with latest_need=None it produces the
  // empty branch, not an exception -- run in the repo's own Django venv, not
  // reasoned about. wfbn/foodbank/nearby.html does not mention latest_need at
  // all, so that page could never fail there under any circumstances.
  //
  // The state is ordinary, not exotic: the admin creates it by adding a food
  // bank before its first need, or by unpublishing its only published one.
  it("returns a blank need for a winning food bank that has none", async () => {
    db.getOpenLocationCoordinates.mockResolvedValue([]);
    db.getFoodbanksByIds.mockImplementation((session: Session, ids: readonly number[]) =>
      fetchFoodbanks(session, ids).then((rows) => rows.map((row) => ({ ...row, latestNeed: null }))),
    );

    const results = await findLocations(SESSION, LAT, LNG, 1);

    expect(results).toHaveLength(1);
    // "" and not null: the route feeds this straight to resolveNeedText,
    // whose empty-string answer is what puts index.njk on the same branch
    // Django's template takes.
    expect(results[0]!.latest_need_change_text).toBe("");
    expect(results[0]!.latest_need_id).toBeNull();
    // The rest of the row is intact -- this is a blank cell, not a blank row.
    expect(results[0]!.name).toBeTruthy();
    expect(results[0]!.foodbank_slug).toBeTruthy();
  });

  it("keeps the other results when ONE of them has no latest_need", async () => {
    // THE ASSERTION THE SEVERITY RESTS ON. The failure was never one blank
    // row: the throw escaped Promise.all in routes/wfbn/index.ts and took the
    // whole page with it -- all twenty results, the donation-points tab and
    // the by-item tab. A fixture where every row lacks a need cannot tell
    // "degrades that row" from "degrades everything", so exactly one does.
    db.getOpenLocationCoordinates.mockResolvedValue([]);
    db.getFoodbanksByIds.mockImplementation((session: Session, ids: readonly number[]) =>
      fetchFoodbanks(session, ids).then((rows) => rows.map((row, i) => (i === 0 ? { ...row, latestNeed: null } : row))),
    );

    const results = await findLocations(SESSION, LAT, LNG, 4);

    expect(results.length).toBeGreaterThan(1);
    expect(results[0]!.latest_need_change_text).toBe("");
    expect(results.slice(1).every((r) => r.latest_need_change_text !== "")).toBe(true);
    expect(results.slice(1).every((r) => r.latest_need_id !== null)).toBe(true);
  });

  it("returns a blank need for a location whose PARENT food bank has none", async () => {
    // The location branch reads the need off the parent, and it is the more
    // likely leg in practice: a brand-new food bank that has never had a need
    // recorded can still have locations, and any of them can be somebody's
    // nearest result.
    db.getFoodbanksByIds.mockImplementation((session: Session, ids: readonly number[]) =>
      fetchFoodbanks(session, ids).then((rows) => rows.map((row) => ({ ...row, latestNeed: null }))),
    );

    const results = await findLocations(SESSION, LAT, LNG, 4);

    expect(results.some((r) => r.type === "location")).toBe(true);
    expect(results.every((r) => r.latest_need_change_text === "")).toBe(true);
    expect(results.every((r) => r.latest_need_id === null)).toBe(true);
  });

  // THIS PAIR USED TO ASSERT A 500, and their own comment said the 500 was
  // "pinned so that a change to either is deliberate". github #48 is that
  // deliberate change: a row that vanishes between the coordinate scan and
  // the hydration read now drops out of the list instead of throwing.
  //
  // Dropping is the DJANGO outcome, not a lenient one. Django ranks and
  // hydrates in a single query, so a row deleted a moment earlier is simply
  // not a candidate and the list comes back shorter. The two-phase port is
  // what created a window in which an id can outlive its row; degrading to a
  // shorter list is what closes it.
  //
  // THE OLD COMMENT NAMED THE WRONG TRIGGER, and it is worth correcting
  // rather than copying: it said "an admin CLOSING a food bank in between
  // makes the second return fewer rows". It does not. getFoodbanksByIds is
  // `SELECT * FROM foodbank WHERE id IN (...)` with no is_closed filter
  // (foodbank.ts's foodbanksByIdsStatement), so a closed food bank still
  // hydrates. Only DELETION shortens the result -- foodbankAdmin.ts:29 for a
  // food bank, locationsAdmin.ts:288 for a location.
  it("drops a ranked food bank that vanished between the scan and the hydration read", async () => {
    db.getOpenLocationCoordinates.mockResolvedValue([]);
    db.getFoodbanksByIds.mockResolvedValue([]);
    await expect(findLocations(SESSION, LAT, LNG, 1)).resolves.toEqual([]);
  });

  it("drops a ranked location that vanished, and keeps the rest of the list intact", async () => {
    db.getLocationsByIds.mockResolvedValue([]);
    const results = await findLocations(SESSION, LAT, LNG, 4);

    // The point of asking for 4 rather than 1: the surviving entries must
    // still be there, in order, with THEIR OWN distances. A fix that dropped
    // the missing row by shifting the array would show up here as an
    // organisation carrying a location's distance.
    expect(results.every((r) => r.type === "organisation")).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    const distances = results.map((r) => r.distance_mi);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);

    // With no location row there is nothing to look a parent up for, so the
    // third read is skipped rather than issued with a junk id.
    expect(db.getFoodbanksByIds).toHaveBeenCalledTimes(1);
  });

  // I WROTE THIS TEST DURING github #48 AND ITS PREMISE WAS WRONG. It asserted
  // that a null latest_need "still throws", on the rule that a miss Django
  // would also have hit must keep failing -- correct as a rule, wrong in
  // believing Django hits this one. It does not: the HTML path resolves the
  // value in a template, which swallows it. #13 is the correction, and the
  // rule that survives is narrower than the one I wrote: a row that is NOT
  // FOUND is a window this port's two-phase read opened, and is dropped
  // (asserted below); a row that is found carrying a null need is ordinary
  // data, and renders blank.
});

describe("LocationSearchResult shape", () => {
  // Listed here rather than derived from the module, so that adding or
  // renaming a field is a change this test has to be told about. Both
  // /needs/ and /needs/at/<slug>/nearby/ render organisation and location
  // rows through the same template markup, which only works while the two
  // branches agree on every key.
  const EXPECTED_KEYS = [
    "contact_email",
    "distance_mi",
    "facebook_page",
    "foodbank_name",
    "foodbank_slug",
    "latest_need_change_text",
    "latest_need_id",
    "name",
    "phone_number",
    "slug",
    "type",
  ];

  it("emits exactly the same key set for both branches", async () => {
    const results = await findLocations(SESSION, LAT, LNG, 4);
    const organisation = results.find((r) => r.type === "organisation")!;
    const location = results.find((r) => r.type === "location")!;
    expect(Object.keys(organisation).sort()).toEqual(EXPECTED_KEYS);
    expect(Object.keys(location).sort()).toEqual(EXPECTED_KEYS);
  });

  it("never leaks a database row's other columns into the result", async () => {
    // Both branches build a fresh object literal rather than spreading the
    // row. That matters: FoodbankLocationRow carries boundary_geojson, a
    // large TEXT blob, and these results are handed straight to a template
    // context -- one spread would put ~2,000 polygons through the renderer.
    const results = await findLocations(SESSION, LAT, LNG, 4);
    for (const result of results) {
      expect(result).not.toHaveProperty("boundary_geojson");
      expect(result).not.toHaveProperty("id");
      expect(result).not.toHaveProperty("latestNeed");
    }
  });
});
