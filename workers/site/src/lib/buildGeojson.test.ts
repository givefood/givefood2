import { beforeEach, describe, expect, it, vi } from "vitest";

// geo.json is in PLAN.md's STRICT byte-equality corpus, so most of these
// tests assert whole response bodies rather than a parsed object: the two
// things most likely to break parity (Django's `, `/`: ` separators from
// json.dumps, and a Python float printed as "53.0" where JSON.stringify
// would print "53") are invisible to JSON.parse and would sail through a
// toEqual() on the decoded structure.
//
// The other reason for whole-body assertions is FEATURE ORDER and PROPERTY
// KEY ORDER. Both come from the Python source's code order (gfwfbn/views.py:
// 207-339 -- boundary, then foodbanks, then locations, then donation
// points; and each dict literal's own key order), and the map front end
// draws features in the order it receives them. A reordering is a real
// diff nobody would notice in a structural comparison.
//
// A NOTE ON NEGATIVE ASSERTIONS, because this file is mostly a matrix of
// "which scope includes what": every `not.toContain` below is paired with a
// positive assertion that the feature it is talking about is still THERE.
// On its own, `expect(body).not.toContain("address")` is also satisfied by
// a build that emitted no features at all, and `indexOf(a) < indexOf(b)`
// is also satisfied when `a` is missing entirely and indexOf returns -1.
// Both traps are live here (an empty FeatureCollection is a legitimate
// response shape for this module), so neither form appears unguarded.
//
// The whole @givefood/db surface is mocked: this module's contract is
// "which query does each scope run, and how is the result serialised",
// which is exactly what the mock makes visible. The four other imports
// (@givefood/serialise, @givefood/urls, @givefood/models, ./countries) are
// deliberately REAL -- the url shapes and the ensure_ascii/float formatting
// are half of what's being asserted here.
vi.mock("@givefood/db", () => ({
  getAllOpenDonationPoints: vi.fn(),
  getAllOpenFoodbanks: vi.fn(),
  getAllOpenLocationsFlagged: vi.fn(),
  getConstituencyBySlug: vi.fn(),
  getDonationPointsByFoodbankId: vi.fn(),
  getFoodbankBySlug: vi.fn(),
  getFoodbankLocationBySlugs: vi.fn(),
  getFoodbanksByConstituencyId: vi.fn(),
  getFoodbanksByCountry: vi.fn(),
  getLocationsByFoodbankIdUnsorted: vi.fn(),
  getOpenDonationPointsByConstituencyId: vi.fn(),
  getOpenDonationPointsByCountry: vi.fn(),
  getOpenLocationsByConstituencyId: vi.fn(),
  getOpenLocationsByCountry: vi.fn(),
}));

import {
  getAllOpenDonationPoints,
  getAllOpenFoodbanks,
  getAllOpenLocationsFlagged,
  getConstituencyBySlug,
  getDonationPointsByFoodbankId,
  getFoodbankBySlug,
  getFoodbankLocationBySlugs,
  getFoodbanksByConstituencyId,
  getFoodbanksByCountry,
  getLocationsByFoodbankIdUnsorted,
  getOpenDonationPointsByConstituencyId,
  getOpenDonationPointsByCountry,
  getOpenLocationsByConstituencyId,
  getOpenLocationsByCountry,
  type DonationPointRow,
  type DonationPointRowNarrow,
  type FoodbankLocationRow,
  type FoodbankLocationRowFlagged,
  type FoodbankRow,
  type Session,
} from "@givefood/db";
import { buildGeojsonResponse } from "./buildGeojson";

// A sentinel, not a real D1 session -- every assertion below that passes it
// to a query mock is checking that the CALLER's session (the one carrying
// the request's read-your-writes bookmark) is threaded through, rather than
// this module opening one of its own.
const session = { sentinel: "d1-session" } as unknown as Session;

// Only the columns this module actually reads are set; the rest of each row
// type is irrelevant here and is cast away rather than filled with fake
// data that would imply these tests cover it.
function makeFoodbank(overrides: Partial<FoodbankRow> = {}): FoodbankRow {
  return {
    id: 42,
    name: "Testville",
    alt_name: null,
    slug: "testville",
    address: "1 High Street, Testville",
    postcode: "AB1 2CD",
    lat_lng: "53.0,-1.5",
    delivery_address: null,
    delivery_lat_lng: null,
    ...overrides,
  } as unknown as FoodbankRow;
}

function makeLocation(overrides: Partial<FoodbankLocationRow> = {}): FoodbankLocationRow {
  return {
    id: 7,
    foodbank_id: 42,
    foodbank_name: "Testville",
    foodbank_slug: "testville",
    name: "Church Hall",
    slug: "church-hall",
    address: "2 Low Street",
    postcode: "AB3 4EF",
    lat_lng: "52.5,-2.25",
    boundary_geojson: null,
    ...overrides,
  } as unknown as FoodbankLocationRow;
}

// The all-items feed's row shape: the same location MINUS boundary_geojson,
// PLUS the 0/1 has_boundary flag -- what getAllOpenLocationsFlagged returns
// (packages/db/src/locations.ts). Kept as a separate factory rather than an
// override on makeLocation, because the whole point of the projection is
// that the key is ABSENT, and a factory that could still carry it would let
// the all-items tests below pass against a row production never produces.
function makeLocationFlagged(overrides: Partial<FoodbankLocationRowFlagged> = {}): FoodbankLocationRowFlagged {
  const { boundary_geojson: _dropped, ...rest } = makeLocation() as FoodbankLocationRow;
  return { ...rest, has_boundary: 0, ...overrides } as unknown as FoodbankLocationRowFlagged;
}

function makeDonationPoint(overrides: Partial<DonationPointRow> = {}): DonationPointRow {
  return {
    id: 9,
    foodbank_id: 42,
    foodbank_name: "Testville",
    foodbank_slug: "testville",
    name: "Big Supermarket",
    slug: "big-supermarket",
    address: "3 Retail Park",
    postcode: "AB5 6GH",
    lat_lng: "51.75,0.25",
    ...overrides,
  } as unknown as DonationPointRow;
}

// The all-items feed's donation-point row shape: the twelve columns
// getAllOpenDonationPoints projects, and nothing else (packages/db/src/
// donationpoints.ts). Kept as its own factory rather than an override on
// makeDonationPoint for the same reason makeLocationFlagged is separate --
// the whole point of the projection is which keys are ABSENT, and a factory
// that could still carry foodbank_id or opening_hours would let the
// all-items test below pass against a row production never produces.
function makeDonationPointNarrow(overrides: Partial<DonationPointRowNarrow> = {}): DonationPointRowNarrow {
  return {
    id: 9,
    name: "Big Supermarket",
    slug: "big-supermarket",
    address: "3 Retail Park",
    postcode: "AB5 6GH",
    lat_lng: "51.75,0.25",
    phone_number: null,
    url: null,
    parliamentary_constituency_name: "Testville North",
    foodbank_name: "Testville",
    foodbank_slug: "testville",
    foodbank_network: "Trussell Trust",
    ...overrides,
  };
}

// The `"name": "..."` values a response carries, in emission order. Used
// wherever a test needs to say "these features, in this order, and nothing
// else" without spelling out four full Point literals -- the byte-exact
// shape of one of those is already pinned by the whole-body tests.
function featureNames(body: string): string[] {
  return [...body.matchAll(/"name": "([^"]*)"/g)].map((m) => m[1] as string);
}

// A stored boundary_geojson column, in the compact shape packages/serialise's
// geojsonBoundary.ts records for production rows -- including a coordinate
// written as "53.30" and one as "-4.20000".
//
// Those trailing zeros used to be asserted as SURVIVORS, on the old
// number-pass-through. github #22 changed that: Django json.loads/dumps the
// whole body, so it prints -4.2 and 53.3, and the port now does too. The
// fixture is kept in its non-canonical form precisely because it exercises
// that -- and it is synthetic either way, since the real ONS data contains
// no trailing-zero coordinates at all.
const STORED_LOCATION_BOUNDARY =
  '{"type":"Feature","properties":{"stored":"gone"},"geometry":{"type":"Polygon","coordinates":[[[-4.20000,53.30]]]}}';

// A stored constituency boundary keeping its real ONS fields, one of which
// holds a raw (unescaped) non-ASCII character in the database.
const STORED_CONSTITUENCY_BOUNDARY =
  '{"type":"Feature","properties":{"PCON24CD":"W07000041","PCON24NM":"Ynys Môn"},"geometry":{"type":"Polygon","coordinates":[[[-4.4,53.3]]]}}';

const LIST_QUERIES = [
  getAllOpenFoodbanks,
  getAllOpenLocationsFlagged,
  getAllOpenDonationPoints,
  getFoodbanksByCountry,
  getOpenLocationsByCountry,
  getOpenDonationPointsByCountry,
  getLocationsByFoodbankIdUnsorted,
  getDonationPointsByFoodbankId,
  getFoodbanksByConstituencyId,
  getOpenLocationsByConstituencyId,
  getOpenDonationPointsByConstituencyId,
];

beforeEach(() => {
  vi.resetAllMocks();
  // Every list query defaults to empty, so each test only has to populate
  // the rows it is actually about; the three lookups default to "not
  // found", the case the module turns into a 404.
  for (const query of LIST_QUERIES) vi.mocked(query).mockResolvedValue([] as never);
  vi.mocked(getFoodbankBySlug).mockResolvedValue(null);
  vi.mocked(getFoodbankLocationBySlugs).mockResolvedValue(null);
  vi.mocked(getConstituencyBySlug).mockResolvedValue(null);
});

describe("buildGeojsonResponse: the all-items feed (/needs/geo.json)", () => {
  it("renders a food bank as a complete, Django-formatted FeatureCollection", async () => {
    // The whole point of the module, in one assertion. Three separate
    // parity rules are visible in this string and each has its own test
    // below as well: json.dumps's `, `/`: ` separators, GeoJSON's
    // [longitude, latitude] order, and a whole-number coordinate printed
    // as "53.0" (Python repr) rather than "53" (JSON.stringify).
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank()]);

    expect(await buildGeojsonResponse(session, "en", { kind: "all" })).toBe(
      '{"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", ' +
        '"coordinates": [-1.5, 53.0]}, "properties": {"type": "f", "name": "Testville Foodbank", ' +
        '"url": "/needs/at/testville/"}}]}',
    );
  });

  it("queries only the three open-rows-everywhere lists, through the caller's session", async () => {
    // `Foodbank.objects.filter(is_closed=False)` and friends -- the
    // all-items branch never touches a slug-scoped query. If a future
    // refactor routed this scope through the country/constituency helpers
    // it would quietly start filtering, and the public map would lose rows.
    await buildGeojsonResponse(session, "en", { kind: "all" });

    expect(getAllOpenFoodbanks).toHaveBeenCalledWith(session);
    expect(getAllOpenLocationsFlagged).toHaveBeenCalledWith(session);
    expect(getAllOpenDonationPoints).toHaveBeenCalledWith(session);
    expect(getFoodbanksByCountry).not.toHaveBeenCalled();
    expect(getFoodbanksByConstituencyId).not.toHaveBeenCalled();
    expect(getFoodbankBySlug).not.toHaveBeenCalled();
    expect(getFoodbankLocationBySlugs).not.toHaveBeenCalled();
    expect(getConstituencyBySlug).not.toHaveBeenCalled();
  });

  it("drops the address PROPERTY but keeps every feature, delivery points included", async () => {
    // `if all_items: feature["properties"].pop("address", None)` -- the
    // Python source strips address from the whole-country download purely
    // for size. This feed is the biggest response the site serves, so a
    // regression here is a bandwidth bill, not just a diff.
    //
    // The four names are asserted first, and in order, because pop()ing a
    // key and dropping the whole feature are indistinguishable to a bare
    // `not.toContain("address")` -- an empty FeatureCollection passes that
    // too. In particular the DELIVERY point survives on this feed: only
    // its address property goes, and it is the one feature whose own name
    // ends in "Address".
    //
    // The needle is `"address"` WITH its quotes rather than the bare word,
    // so that this test isn't quietly depending on `Delivery Address`
    // having a capital A to stay green.
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([
      makeFoodbank({ delivery_address: "Depot Road", delivery_lat_lng: "53.1,-1.6" }),
    ]);
    vi.mocked(getAllOpenLocationsFlagged).mockResolvedValue([makeLocationFlagged()]);
    vi.mocked(getAllOpenDonationPoints).mockResolvedValue([makeDonationPoint()]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "all" })) as string;
    expect(featureNames(body)).toEqual([
      "Testville Foodbank",
      "Testville Foodbank Delivery Address",
      "Church Hall",
      "Big Supermarket",
    ]);
    expect(body).toContain('"coordinates": [-1.6, 53.1]');
    expect(body).not.toContain('"address"');
    // ...but the postcodes/street lines only ever reached the response
    // through "address", so their absence is the real check.
    expect(body).not.toContain("High Street");
    expect(body).not.toContain("Depot Road");
    expect(body).not.toContain("Low Street");
    expect(body).not.toContain("Retail Park");
    expect(body).not.toContain("AB1 2CD");
  });

  it("emits food banks, then locations, then donation points", async () => {
    // Feature order is the Python view's loop order, and the map front end
    // draws in receive order. Asserted as the sequence of "type" codes so
    // the test names the rule rather than restating a body.
    vi.mocked(getAllOpenDonationPoints).mockResolvedValue([makeDonationPoint()]);
    vi.mocked(getAllOpenLocationsFlagged).mockResolvedValue([makeLocationFlagged()]);
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank()]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "all" })) as string;
    expect(body.match(/"type": "([fld]|lb|b)"/g)).toEqual(['"type": "f"', '"type": "l"', '"type": "d"']);
  });

  it("keeps a location flagged as having a boundary as a plain point", async () => {
    // `if location.boundary_geojson and not all_items` -- the all-items
    // feed deliberately never ships polygons (they are far larger than the
    // points they replace). 40 of 1,962 open production locations have one,
    // so dropping the `and not all_items` half would bloat this feed hard.
    //
    // has_boundary: 1 is the projected row's way of saying "this location
    // has one" (getAllOpenLocationsFlagged) -- the flag exists precisely so
    // the row can carry that fact without carrying the ~2.3 MB blob, and a
    // build that started reading it as a boundary would emit `"lb"` here.
    vi.mocked(getAllOpenLocationsFlagged).mockResolvedValue([makeLocationFlagged({ has_boundary: 1 })]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "all" })) as string;
    expect(body).toContain('"type": "Point"');
    expect(body).toContain('"type": "l"');
    // The location's OWN lat_lng, not a coordinate lifted out of the
    // polygon it is standing in for.
    expect(body).toContain('"coordinates": [-2.25, 52.5]');
    expect(body).not.toContain("lb");
    expect(body).not.toContain("Polygon");
    expect(body).not.toContain("has_boundary");
  });

  it("still emits a plain point if a row somehow arrives WITH a boundary column", async () => {
    // The `and not all_items` guard, tested independently of the projection.
    // Two separate things now keep polygons off this feed: the query does
    // not fetch the column, and `includeBoundary` is false for this scope.
    // The test above can only fail the first; feeding the mock a row that
    // does carry boundary_geojson -- the shape getAllOpenLocations returns,
    // i.e. exactly what a revert of the projection would put here -- is the
    // only way to keep failing the second. Without this, deleting
    // `&& includeBoundary` from locationFeature is a live mutant.
    vi.mocked(getAllOpenLocationsFlagged).mockResolvedValue([
      makeLocation({ boundary_geojson: STORED_LOCATION_BOUNDARY }),
    ] as never);

    const body = (await buildGeojsonResponse(session, "en", { kind: "all" })) as string;
    expect(body).toContain('"type": "l"');
    expect(body).toContain('"coordinates": [-2.25, 52.5]');
    expect(body).not.toContain("Polygon");
    expect(body).not.toContain("-4.20000");
  });

  it("builds a whole location feature from the PROJECTED row shape", async () => {
    // The other all-items tests read one property at a time; this one pins the
    // complete feature a projected row produces, because the risk the
    // projection introduces is a MISSING COLUMN, and a missing column reaches
    // the response as `null`/`undefined` rather than as an error. Every field
    // locationFeature touches is visible here -- name, foodbank_name,
    // foodbank_slug, slug and lat_lng -- so dropping any one of them from
    // getAllOpenLocationsFlagged's 38-name list fails this with a readable
    // diff instead of shipping `"name": null` to the public map.
    vi.mocked(getAllOpenLocationsFlagged).mockResolvedValue([makeLocationFlagged()]);

    expect(await buildGeojsonResponse(session, "en", { kind: "all" })).toBe(
      '{"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", ' +
        '"coordinates": [-2.25, 52.5]}, "properties": {"type": "l", "name": "Church Hall", ' +
        '"foodbank": "Testville", "url": "/needs/at/testville/church-hall/"}}]}',
    );
  });

  it("builds a whole donation point feature from the PROJECTED row shape", async () => {
    // The donation-point mirror of the case above, and it exists for exactly
    // the same reason: getAllOpenDonationPoints is projected to twelve
    // columns, and a name dropped from that list arrives here as `undefined`
    // and serialises as `"name": null` on the public map rather than
    // throwing. Every field donationPointFeature touches is visible in this
    // one string -- name, foodbank_name, foodbank_slug, slug and lat_lng --
    // fed by a row that carries ONLY the projected keys.
    vi.mocked(getAllOpenDonationPoints).mockResolvedValue([makeDonationPointNarrow()]);

    expect(await buildGeojsonResponse(session, "en", { kind: "all" })).toBe(
      '{"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", ' +
        '"coordinates": [0.25, 51.75]}, "properties": {"type": "d", "name": "Big Supermarket", ' +
        '"foodbank": "Testville", "url": "/needs/at/testville/donationpoint/big-supermarket/"}}]}',
    );
  });

  it("rounds coordinates to 4 decimal places", async () => {
    // decimal_places = 4 on this feed only (gfwfbn/views.py:216-219).
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank({ lat_lng: "51.1234567,-0.1234567" })]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "all" })) as string;
    expect(body).toContain('"coordinates": [-0.1235, 51.1235]');
  });

  it("returns an empty feature list, not null, when nothing is open", async () => {
    // null is reserved for the three get_object_or_404 cases; a caller that
    // saw null here would 404 the whole public map.
    expect(await buildGeojsonResponse(session, "en", { kind: "all" })).toBe(
      '{"type": "FeatureCollection", "features": []}',
    );
  });
});

describe("buildGeojsonResponse: the food bank feed (/needs/at/<slug>/geo.json)", () => {
  it("keeps address, at 6 decimal places, in the Python dict's key order", async () => {
    // decimal_places = 6 for every scoped feed, and `address` survives
    // (only the all-items branch pops it). Key order is the dict literal's
    // own: type, name, address, url.
    vi.mocked(getFoodbankBySlug).mockResolvedValue(makeFoodbank({ lat_lng: "51.1234567,-0.1234567" }) as never);

    const body = (await buildGeojsonResponse(session, "en", { kind: "foodbank", slug: "testville" })) as string;
    expect(getFoodbankBySlug).toHaveBeenCalledWith(session, "testville");
    expect(body).toContain('"coordinates": [-0.123457, 51.123457]');
    expect(body).toContain(
      '"properties": {"type": "f", "name": "Testville Foodbank", ' +
        '"address": "1 High Street, Testville\\r\\nAB1 2CD", "url": "/needs/at/testville/"}',
    );
  });

  it("returns null for an unknown slug so the caller can 404", async () => {
    // get_object_or_404(Foodbank, slug=slug). Returning an empty
    // FeatureCollection instead would make every typo'd slug look like a
    // real food bank with nothing in it.
    expect(await buildGeojsonResponse(session, "en", { kind: "foodbank", slug: "nope" })).toBeNull();
    expect(getLocationsByFoodbankIdUnsorted).not.toHaveBeenCalled();
    expect(getDonationPointsByFoodbankId).not.toHaveBeenCalled();
  });

  it("reads locations with the UNSORTED query, by the food bank's id", async () => {
    // The view builds its own `FoodbankLocation.objects.filter(...)`
    // queryset with no .order_by, unlike Foodbank.locations()'s
    // .order_by("name") -- so this scope must use the unsorted helper or
    // the feature order silently changes. The module comment is explicit
    // that donation points, by contrast, DO use the sorted helper.
    vi.mocked(getFoodbankBySlug).mockResolvedValue(makeFoodbank({ id: 42 }) as never);

    await buildGeojsonResponse(session, "en", { kind: "foodbank", slug: "testville" });
    expect(getLocationsByFoodbankIdUnsorted).toHaveBeenCalledWith(session, 42);
    expect(getDonationPointsByFoodbankId).toHaveBeenCalledWith(session, 42);
  });

  it("emits locations in the order the query returned them, never re-sorted", async () => {
    // The other half of "unsorted": asking for the unsorted query is no use
    // if this module then imposes an order of its own. These three names
    // are deliberately neither alphabetical nor reverse-alphabetical, so a
    // stray .sort() (or a sort by slug, or by id) shows up as a different
    // sequence rather than coincidentally matching.
    vi.mocked(getFoodbankBySlug).mockResolvedValue(makeFoodbank() as never);
    vi.mocked(getLocationsByFoodbankIdUnsorted).mockResolvedValue([
      makeLocation({ id: 3, name: "Middle Hall", slug: "middle-hall" }),
      makeLocation({ id: 1, name: "Zebra Hall", slug: "zebra-hall" }),
      makeLocation({ id: 2, name: "Alpha Hall", slug: "alpha-hall" }),
    ]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "foodbank", slug: "testville" })) as string;
    expect(featureNames(body)).toEqual(["Testville Foodbank", "Middle Hall", "Zebra Hall", "Alpha Hall"]);
  });

  it("renders a location's boundary as an lb polygon, replacing the stored properties", async () => {
    // `boundary["properties"] = {...}` is a reassignment, so the stored
    // "stored":"gone" key really is gone -- and "address" is absent from
    // the replacement dict even on an address-carrying feed, because the
    // Python literal (gfwfbn/views.py:290-295) has no address key.
    // -4.2 / 53.3, not the stored -4.20000 / 53.30: json.dumps re-prints
    // every float through CPython's repr, and github #22 made this pass do
    // the same. The guard that remains is 51.0 NOT becoming 51 -- asserted
    // in geojsonBoundary.test.ts, where the pass itself is tested.
    vi.mocked(getFoodbankBySlug).mockResolvedValue(makeFoodbank() as never);
    vi.mocked(getLocationsByFoodbankIdUnsorted).mockResolvedValue([
      makeLocation({ boundary_geojson: STORED_LOCATION_BOUNDARY }),
    ]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "foodbank", slug: "testville" })) as string;
    expect(body).toContain('"coordinates": [[[-4.2, 53.3]]]');
    expect(body).toContain(
      '"properties": {"type": "lb", "name": "Church Hall", "foodbank": "Testville", ' +
        '"url": "/needs/at/testville/church-hall/"}',
    );
    expect(body).not.toContain("gone");
    expect(body).not.toContain('"address": "2 Low Street');
    // The polygon REPLACES the point; it is not emitted alongside one.
    expect(body).not.toContain('"coordinates": [-2.25, 52.5]');
  });

  it("adds the delivery address as a second f feature, using the raw address column", async () => {
    // Asserted as the whole body because the interesting claims are all
    // positional: the delivery feature comes SECOND, it reuses the food
    // bank's own url (both points link to the same page), and its address
    // is `delivery_address` verbatim -- NOT run through full_address(), so
    // no "\r\nAB1 2CD" postcode line is appended to it the way there is on
    // the main feature two properties earlier in the same string.
    //
    // (An earlier version of this test compared indexOf("Delivery Address")
    // against indexOf of the main name. That passes when the MAIN feature
    // is missing, because indexOf returns -1 and -1 is less than anything.)
    vi.mocked(getFoodbankBySlug).mockResolvedValue(
      makeFoodbank({ delivery_address: "Depot Road, Testville", delivery_lat_lng: "53.25,-1.75" }) as never,
    );

    expect(await buildGeojsonResponse(session, "en", { kind: "foodbank", slug: "testville" })).toBe(
      '{"type": "FeatureCollection", "features": [' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.5, 53.0]}, ' +
        '"properties": {"type": "f", "name": "Testville Foodbank", ' +
        '"address": "1 High Street, Testville\\r\\nAB1 2CD", "url": "/needs/at/testville/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.75, 53.25]}, ' +
        '"properties": {"type": "f", "name": "Testville Foodbank Delivery Address", ' +
        '"address": "Depot Road, Testville", "url": "/needs/at/testville/"}}]}',
    );
  });

  it("skips the delivery feature when delivery_address is null or empty", async () => {
    // `if foodbank.delivery_address:` is a truthiness check in Python, and
    // the column is "" rather than NULL for plenty of rows -- an
    // `!== null` port would emit a nameless point at 0,0-ish coordinates
    // for every one of them.
    //
    // featureNames() rather than `not.toContain("Delivery Address")`: the
    // bare negative is also satisfied by dropping the food bank itself, and
    // "emits no delivery point" and "emits nothing" are very different bugs.
    for (const deliveryAddress of [null, ""]) {
      vi.mocked(getFoodbankBySlug).mockResolvedValue(
        makeFoodbank({ delivery_address: deliveryAddress, delivery_lat_lng: "53.25,-1.75" }) as never,
      );
      const body = (await buildGeojsonResponse(session, "en", { kind: "foodbank", slug: "testville" })) as string;
      expect(featureNames(body)).toEqual(["Testville Foodbank"]);
      expect(body).not.toContain('"coordinates": [-1.75, 53.25]');
    }
  });

  it("throws if delivery_address is set while delivery_lat_lng is null", async () => {
    // Deliberate parity, called out in the module comment: Django checks
    // only `delivery_address` and then dereferences `delivery_lat_lng`
    // unguarded, so `.split(",")` raises there too. The pairing is an
    // application-level invariant; this test exists so that a future
    // "defensive" null-guard is a conscious divergence, not a silent one.
    vi.mocked(getFoodbankBySlug).mockResolvedValue(
      makeFoodbank({ delivery_address: "Depot Road", delivery_lat_lng: null }) as never,
    );

    await expect(buildGeojsonResponse(session, "en", { kind: "foodbank", slug: "testville" })).rejects.toThrow(
      TypeError,
    );
  });
});

describe("buildGeojsonResponse: the location feed (/needs/at/<slug>/<locslug>/geo.json)", () => {
  it("returns only that location -- no food bank or donation point queries at all", async () => {
    // `foodbanks = Foodbank.objects.none()` /
    // `donationpoints = FoodbankDonationPoint.objects.none()`: this feed
    // draws one location's own marker, and including its parent food bank
    // would put a second, wrong pin on the location page's map.
    vi.mocked(getFoodbankLocationBySlugs).mockResolvedValue(makeLocation());

    const body = (await buildGeojsonResponse(session, "en", {
      kind: "location",
      slug: "testville",
      locslug: "church-hall",
    })) as string;

    expect(getFoodbankLocationBySlugs).toHaveBeenCalledWith(session, "testville", "church-hall");
    expect(getFoodbankBySlug).not.toHaveBeenCalled();
    expect(getDonationPointsByFoodbankId).not.toHaveBeenCalled();
    expect(body).toBe(
      '{"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", ' +
        '"coordinates": [-2.25, 52.5]}, "properties": {"type": "l", "name": "Church Hall", ' +
        '"foodbank": "Testville", "address": "2 Low Street\\r\\nAB3 4EF", ' +
        '"url": "/needs/at/testville/church-hall/"}}]}',
    );
  });

  it("rounds to 6 decimal places here too, not the all-items feed's 4", async () => {
    // decimalPlaces is `allItems || scope.kind === "country" ? 4 : 6`, and
    // this is the scope where getting it wrong is invisible in the fixtures
    // used elsewhere: 52.5/-2.25 round identically at 4dp and 6dp, so a
    // `scope.kind === "foodbank" ? 6 : 4` mistake would have passed every
    // other test in this file. These digits separate the two.
    vi.mocked(getFoodbankLocationBySlugs).mockResolvedValue(makeLocation({ lat_lng: "52.1234567,-2.7654321" }));

    const body = (await buildGeojsonResponse(session, "en", {
      kind: "location",
      slug: "testville",
      locslug: "church-hall",
    })) as string;
    expect(body).toContain('"coordinates": [-2.765432, 52.123457]');
  });

  it("renders this location's own boundary as an lb polygon", async () => {
    // includeBoundary is `!allItems && scope.kind !== "country"`, so the
    // single-location feed opts IN -- this is the polygon the location
    // detail page's map draws instead of a pin. Without this test,
    // narrowing includeBoundary to just the foodbank scope would still pass
    // (the all-items and country scopes both assert the negative, and no
    // other test gave this scope a boundary row).
    vi.mocked(getFoodbankLocationBySlugs).mockResolvedValue(
      makeLocation({ boundary_geojson: STORED_LOCATION_BOUNDARY }),
    );

    expect(
      await buildGeojsonResponse(session, "en", { kind: "location", slug: "testville", locslug: "church-hall" }),
    ).toBe(
      '{"type": "FeatureCollection", "features": [{"type": "Feature", "properties": ' +
        '{"type": "lb", "name": "Church Hall", "foodbank": "Testville", ' +
        '"url": "/needs/at/testville/church-hall/"}, "geometry": {"type": "Polygon", ' +
        '"coordinates": [[[-4.2, 53.3]]]}}]}',
    );
  });

  it("returns null when the slug pair matches nothing", async () => {
    // The Python source's `if not locations.exists(): raise Http404`.
    expect(
      await buildGeojsonResponse(session, "en", { kind: "location", slug: "testville", locslug: "nope" }),
    ).toBeNull();
  });

  it("emits an empty address string when a location has neither address nor postcode", async () => {
    // FoodbankLocation.full_address() (givefood/models/foodbank.py:907-915)
    // branches and falls through to "" -- unlike Foodbank's unconditional
    // "%s\r\n%s", which would render the literal "None\r\nNone" here. Both
    // columns really are nullable on this model.
    vi.mocked(getFoodbankLocationBySlugs).mockResolvedValue(makeLocation({ address: null, postcode: null }));

    const body = (await buildGeojsonResponse(session, "en", {
      kind: "location",
      slug: "testville",
      locslug: "church-hall",
    })) as string;
    expect(body).toContain('"address": ""');
    expect(body).not.toContain("null");
  });

  it("keeps a lone address or a lone postcode without the \\r\\n join", async () => {
    // The two middle branches of the same Python method -- a join applied
    // unconditionally would leave a dangling newline in the popup text.
    vi.mocked(getFoodbankLocationBySlugs).mockResolvedValue(makeLocation({ address: "2 Low Street", postcode: null }));
    expect(
      await buildGeojsonResponse(session, "en", { kind: "location", slug: "testville", locslug: "church-hall" }),
    ).toContain('"address": "2 Low Street"');

    vi.mocked(getFoodbankLocationBySlugs).mockResolvedValue(makeLocation({ address: null, postcode: "AB3 4EF" }));
    expect(
      await buildGeojsonResponse(session, "en", { kind: "location", slug: "testville", locslug: "church-hall" }),
    ).toContain('"address": "AB3 4EF"');
  });
});

describe("buildGeojsonResponse: the constituency feed", () => {
  it("puts the constituency outline first, ahead of every point feature", async () => {
    // The `if parlcon_slug:` block runs before the food bank loop, so the
    // polygon is feature 0. On the map that means the outline is drawn
    // underneath the pins rather than on top of them.
    //
    // Asserted with startsWith, not `indexOf("b") < indexOf("f")`: that
    // comparison is also true when the boundary is missing altogether and
    // indexOf hands back -1, which is precisely the regression a test about
    // the boundary's position most needs to catch.
    vi.mocked(getConstituencyBySlug).mockResolvedValue({
      id: 5,
      slug: "ynys-mon",
      boundary_geojson: STORED_CONSTITUENCY_BOUNDARY,
    } as never);
    vi.mocked(getFoodbanksByConstituencyId).mockResolvedValue([makeFoodbank()]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "constituency", parlconSlug: "ynys-mon" })) as string;
    expect(getConstituencyBySlug).toHaveBeenCalledWith(session, "ynys-mon");
    expect(
      body.startsWith(
        '{"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"PCON24CD": "W07000041"',
      ),
    ).toBe(true);
    expect(body.match(/"type": "([fld]|lb|b)"/g)).toEqual(['"type": "b"', '"type": "f"']);
    expect(getFoodbanksByConstituencyId).toHaveBeenCalledWith(session, 5);
    expect(getOpenLocationsByConstituencyId).toHaveBeenCalledWith(session, 5);
    expect(getOpenDonationPointsByConstituencyId).toHaveBeenCalledWith(session, 5);
  });

  it("only sets type on the stored outline, leaving the ONS fields alone", async () => {
    // `boundary["properties"]["type"] = "b"` is a single-key assignment,
    // not a replacement (unlike the "lb" case) -- the ONS codes stay, and
    // "type" is appended AFTER them because Python appends a new dict key
    // at the end of iteration order. The raw "ô" byte in the column comes
    // back \u-escaped, which is json.dumps's ensure_ascii=True default.
    vi.mocked(getConstituencyBySlug).mockResolvedValue({
      id: 5,
      slug: "ynys-mon",
      boundary_geojson: STORED_CONSTITUENCY_BOUNDARY,
    } as never);

    expect(await buildGeojsonResponse(session, "en", { kind: "constituency", parlconSlug: "ynys-mon" })).toBe(
      '{"type": "FeatureCollection", "features": [{"type": "Feature", "properties": ' +
        '{"PCON24CD": "W07000041", "PCON24NM": "Ynys M\\u00f4n", "type": "b"}, ' +
        '"geometry": {"type": "Polygon", "coordinates": [[[-4.4, 53.3]]]}}]}',
    );
  });

  it("keeps address, 6 decimal places and lb polygons, like the other two scoped feeds", async () => {
    // This scope shares includeAddress/decimalPlaces/includeBoundary with
    // the foodbank and location feeds, and nothing else here exercised any
    // of the three for it: an implementation that special-cased the
    // constituency feed to the country feed's rules (4dp, no boundary) or
    // to the all-items feed's (no address) would have gone unnoticed.
    vi.mocked(getConstituencyBySlug).mockResolvedValue({ id: 5, slug: "x", boundary_geojson: null } as never);
    vi.mocked(getFoodbanksByConstituencyId).mockResolvedValue([makeFoodbank({ lat_lng: "51.1234567,-0.1234567" })]);
    vi.mocked(getOpenLocationsByConstituencyId).mockResolvedValue([
      makeLocation({ boundary_geojson: STORED_LOCATION_BOUNDARY }),
    ]);
    vi.mocked(getOpenDonationPointsByConstituencyId).mockResolvedValue([makeDonationPoint()]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "constituency", parlconSlug: "x" })) as string;
    expect(body).toContain('"coordinates": [-0.123457, 51.123457]');
    expect(body).toContain('"address": "1 High Street, Testville\\r\\nAB1 2CD"');
    expect(body).toContain('"address": "3 Retail Park\\r\\nAB5 6GH"');
    expect(body).toContain('"type": "lb"');
    expect(body.match(/"type": "([fld]|lb|b)"/g)).toEqual(['"type": "f"', '"type": "lb"', '"type": "d"']);
  });

  it("returns null for an unknown constituency slug", async () => {
    expect(await buildGeojsonResponse(session, "en", { kind: "constituency", parlconSlug: "nope" })).toBeNull();
    expect(getFoodbanksByConstituencyId).not.toHaveBeenCalled();
  });

  it("skips the outline rather than crashing when a constituency has no boundary", async () => {
    // A DELIBERATE divergence, documented in the module: Django's
    // `boundary_geojson_dict()` would raise on None.strip() and 500 the
    // page. All 650 production rows have one, so this is the unreachable
    // path -- pinned so a future refactor doesn't "restore parity" by
    // reintroducing the crash, and so the rest of the feed still renders.
    vi.mocked(getConstituencyBySlug).mockResolvedValue({ id: 5, slug: "empty", boundary_geojson: null } as never);
    vi.mocked(getFoodbanksByConstituencyId).mockResolvedValue([makeFoodbank()]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "constituency", parlconSlug: "empty" })) as string;
    expect(body).not.toContain('"type": "b"');
    expect(featureNames(body)).toEqual(["Testville Foodbank"]);
  });
});

describe("buildGeojsonResponse: the country feed (/<country>/geo.json)", () => {
  it("maps each of the four country slugs to its stored display name", async () => {
    // COUNTRY_MAPPING's values are the exact strings in every row's
    // `country` column -- querying with the SLUG instead would silently
    // return zero rows for all four countries, and "northern-ireland" is
    // the one where the difference is impossible to miss.
    for (const [slug, name] of [
      ["scotland", "Scotland"],
      ["england", "England"],
      ["wales", "Wales"],
      ["northern-ireland", "Northern Ireland"],
    ]) {
      await buildGeojsonResponse(session, "en", { kind: "country", countrySlug: slug as string });
      expect(getFoodbanksByCountry).toHaveBeenLastCalledWith(session, name);
      expect(getOpenLocationsByCountry).toHaveBeenLastCalledWith(session, name);
      expect(getOpenDonationPointsByCountry).toHaveBeenLastCalledWith(session, name);
    }
  });

  it("returns null for a slug outside the mapping, without querying D1", async () => {
    // Routing already constrains the slug, so this is belt-and-braces --
    // but the alternative to 404ing is querying `country = undefined`,
    // which would return an empty map page rather than a 404. The empty
    // string and the display NAME are in here alongside a plain unknown
    // because both are what a hand-built or mis-plumbed caller would
    // actually pass: the lookup is by slug and it is case-sensitive.
    for (const slug of ["france", "", "England", "SCOTLAND", "northern_ireland"]) {
      expect(await buildGeojsonResponse(session, "en", { kind: "country", countrySlug: slug })).toBeNull();
    }
    expect(getFoodbanksByCountry).not.toHaveBeenCalled();
  });

  it("SUSPECTED BUG: a slug naming an Object.prototype key is not rejected", async () => {
    // COUNTRY_MAPPING is a plain object literal, so it inherits from
    // Object.prototype and `COUNTRY_MAPPING["constructor"]` is the Object
    // function itself -- truthy. `if (!countryName) return null` therefore
    // does NOT fire, and D1 is queried with a FUNCTION where the column
    // value should be (the declared Record<string, string> says otherwise;
    // that type is a lie for inherited keys). Same for "toString",
    // "valueOf", "hasOwnProperty", "__proto__".
    //
    // Not reachable today -- index.ts pins countrySlug to the four real
    // slugs with a route regex -- and NOT fixed here, because the fix
    // (Object.hasOwn, or a null-prototype map) belongs in countries.ts and
    // this file may not touch source. Pinned so the day that route param
    // loosens, someone sees the current behaviour spelled out.
    const body = await buildGeojsonResponse(session, "en", { kind: "country", countrySlug: "constructor" });

    expect(body).not.toBeNull();
    expect(getFoodbanksByCountry).toHaveBeenCalledTimes(1);
    expect(typeof vi.mocked(getFoodbanksByCountry).mock.calls[0]?.[1]).toBe("function");
  });

  it("keeps address (unlike all-items) but rounds to 4dp (unlike the other scoped feeds)", async () => {
    // The two-way divergence this scope exists for: country_geojson is a
    // DIFFERENT Django view (givefood/views.py:285-427) that hardcodes
    // decimal_places = 4 while still emitting address. Getting either half
    // from the wrong neighbour is the exact mistake the scope guards.
    vi.mocked(getFoodbanksByCountry).mockResolvedValue([makeFoodbank({ lat_lng: "51.1234567,-0.1234567" })]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "country", countrySlug: "england" })) as string;
    expect(body).toContain('"coordinates": [-0.1235, 51.1235]');
    expect(body).toContain('"address": "1 High Street, Testville\\r\\nAB1 2CD"');
  });

  it("still emits a delivery point, from the same shared helper", async () => {
    // country_geojson's own foodbank loop (givefood/views.py:343) writes
    // the delivery condition as `foodbank.delivery_address and
    // foodbank.delivery_lat_lng`, where the shared view checks only the
    // address. The module comment argues the two are equivalent under the
    // application-level pairing invariant and so reuses ONE helper for both
    // call sites -- which is only true if the country scope really does
    // still produce the second feature.
    vi.mocked(getFoodbanksByCountry).mockResolvedValue([
      makeFoodbank({ delivery_address: "Depot Road, Testville", delivery_lat_lng: "53.25,-1.75" }),
    ]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "country", countrySlug: "wales" })) as string;
    expect(featureNames(body)).toEqual(["Testville Foodbank", "Testville Foodbank Delivery Address"]);
    expect(body).toContain('"address": "Depot Road, Testville"');
  });

  it("never renders a location boundary as a polygon", async () => {
    // country_geojson's location loop (givefood/views.py:367-392) has no
    // `if location.boundary_geojson` branch at all -- every location is a
    // plain point. This is the one thing the country scope does NOT share
    // with the other three address-carrying feeds.
    vi.mocked(getOpenLocationsByCountry).mockResolvedValue([makeLocation({ boundary_geojson: STORED_LOCATION_BOUNDARY })]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "country", countrySlug: "wales" })) as string;
    expect(body).toContain('"type": "l"');
    expect(body).toContain('"type": "Point"');
    expect(body).toContain('"coordinates": [-2.25, 52.5]');
    expect(body).not.toContain("Polygon");
    expect(body).not.toContain("-4.20000");
  });
});

describe("buildGeojsonResponse: locale handling", () => {
  it("prefixes every url with the request's language", async () => {
    // reverse() inside an i18n_patterns request carries the current
    // language prefix, and all three url names here are in @givefood/urls'
    // I18N_SCOPED set. An unprefixed url would bounce a Welsh visitor out
    // of Welsh the moment they clicked a map pin.
    vi.mocked(getFoodbanksByCountry).mockResolvedValue([makeFoodbank()]);
    vi.mocked(getOpenLocationsByCountry).mockResolvedValue([makeLocation()]);
    vi.mocked(getOpenDonationPointsByCountry).mockResolvedValue([makeDonationPoint()]);

    const body = (await buildGeojsonResponse(session, "gd", { kind: "country", countrySlug: "scotland" })) as string;
    expect(body).toContain('"url": "/gd/needs/at/testville/"');
    expect(body).toContain('"url": "/gd/needs/at/testville/church-hall/"');
    expect(body).toContain('"url": "/gd/needs/at/testville/donationpoint/big-supermarket/"');
    // English is the unprefixed default, not a "/en" prefix.
    const english = (await buildGeojsonResponse(session, "en", { kind: "country", countrySlug: "scotland" })) as string;
    expect(english).toContain('"url": "/needs/at/testville/"');
    expect(english).not.toContain("/en/needs/");
  });

  it("prefixes the lb polygon's url too, not just the point features'", async () => {
    // The boundary branch builds its url from the same urlForLocale call,
    // but it is a completely separate code path through
    // replaceBoundaryProperties -- and it is the one a Welsh visitor to a
    // location page with a catchment polygon actually clicks.
    vi.mocked(getFoodbankLocationBySlugs).mockResolvedValue(
      makeLocation({ boundary_geojson: STORED_LOCATION_BOUNDARY }),
    );

    expect(
      await buildGeojsonResponse(session, "cy", { kind: "location", slug: "testville", locslug: "church-hall" }),
    ).toContain('"url": "/cy/needs/at/testville/church-hall/"');
  });

  it("uses Foodbank.full_name()'s locale rules for the feature name", async () => {
    // full_name() is locale-aware: cy with an alt_name returns it verbatim
    // (no suffix at all), gd prefixes the translated word, en/ga both
    // append the English "Foodbank". The delivery feature's
    // " Delivery Address" suffix is built on top of whichever applies.
    const welshName = makeFoodbank({ name: "Testville", alt_name: "Banc Bwyd Tref-y-prawf" });
    vi.mocked(getFoodbankBySlug).mockResolvedValue(welshName as never);
    expect(await buildGeojsonResponse(session, "cy", { kind: "foodbank", slug: "testville" })).toContain(
      '"name": "Banc Bwyd Tref-y-prawf"',
    );

    // cy WITHOUT an alt_name is the branch that falls through to the
    // translated prefix rather than to the English suffix -- the two cy
    // cases produce completely different strings and only one of them is
    // the alt_name passthrough above.
    vi.mocked(getFoodbankBySlug).mockResolvedValue(makeFoodbank() as never);
    expect(await buildGeojsonResponse(session, "cy", { kind: "foodbank", slug: "testville" })).toContain(
      '"name": "Banc Bwyd Testville"',
    );

    vi.mocked(getFoodbankBySlug).mockResolvedValue(makeFoodbank() as never);
    expect(await buildGeojsonResponse(session, "gd", { kind: "foodbank", slug: "testville" })).toContain(
      '"name": "Banca-b\\u00ecdh Testville"',
    );

    // ga is a supported locale that takes the ENGLISH suffix while still
    // getting a url prefix -- the one combination where name and url
    // disagree about whether the page is "English".
    vi.mocked(getFoodbankBySlug).mockResolvedValue(makeFoodbank() as never);
    const irish = (await buildGeojsonResponse(session, "ga", { kind: "foodbank", slug: "testville" })) as string;
    expect(irish).toContain('"name": "Testville Foodbank"');
    expect(irish).toContain('"url": "/ga/needs/at/testville/"');
  });

  it("escapes every non-ASCII character as \\uXXXX, in names it generates itself", async () => {
    // json.dumps's ensure_ascii=True default, verified live: a curly
    // apostrophe comes back as ’ from /needs/geo.json. JS's
    // JSON.stringify would emit the raw UTF-8 bytes and break byte parity
    // on a large fraction of real food bank names.
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank({ name: "St John’s" })]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "all" })) as string;
    expect(body).toContain('"name": "St John\\u2019s Foodbank"');
    expect(body).not.toContain("’");

    // An astral character is escaped as the SURROGATE PAIR CPython emits
    // (🍎), not as the single \u{1f34e} code point a
    // codePointAt-based escaper would produce -- verified against
    // python3's json.dumps, which is the only thing that makes this a
    // parity rule rather than a preference.
    vi.mocked(getAllOpenDonationPoints).mockResolvedValue([makeDonationPoint({ name: "Apple 🍎 Store" })]);
    const astral = (await buildGeojsonResponse(session, "en", { kind: "all" })) as string;
    expect(astral).toContain('"name": "Apple \\ud83c\\udf4e Store"');
  });
});

describe("buildGeojsonResponse: coordinate text", () => {
  it("emits longitude before latitude", async () => {
    // GeoJSON is [x, y]; the database column is "lat,lng". Swapping them
    // puts every UK food bank somewhere off the coast of Somalia, and the
    // response stays perfectly valid JSON while doing it.
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank({ lat_lng: "51.5074,-0.1278" })]);

    expect(await buildGeojsonResponse(session, "en", { kind: "all" })).toContain('"coordinates": [-0.1278, 51.5074]');
  });

  it("prints a whole-number coordinate with a decimal point, including at the meridian", async () => {
    // The reason pyRound/formatFloat exist rather than toFixed+Number:
    // Python's round(53.0, 4) reprs as "53.0" but JSON.stringify(53) is
    // "53". The module header cites a real Sheffield-area donation point
    // at exactly lat 53.0, and the UK straddles longitude 0, so this hits
    // production data rather than being a theoretical edge.
    vi.mocked(getAllOpenDonationPoints).mockResolvedValue([makeDonationPoint({ lat_lng: "53,0" })]);

    expect(await buildGeojsonResponse(session, "en", { kind: "all" })).toContain('"coordinates": [0.0, 53.0]');
  });

  it("keeps the minus sign on a longitude that rounds to negative zero", async () => {
    // Just west of Greenwich at 4dp: Python's round(-0.00001, 4) is -0.0
    // and json.dumps writes "-0.0". formatFloat's Object.is(-0) branch is
    // what keeps that sign; a plain String(x) would print "0".
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank({ lat_lng: "51.5,-0.00001" })]);

    expect(await buildGeojsonResponse(session, "en", { kind: "all" })).toContain('"coordinates": [-0.0, 51.5]');
  });

  it("rounds half-to-even, matching Python's round() rather than toFixed()", async () => {
    // round(51.12345, 4) == 51.1234 in Python (verified with python3, not
    // assumed), because 511234.5 ties and 511234 is the even half. The
    // obvious hand-rolled alternative, Math.round(x * 1e4) / 1e4, rounds
    // half AWAY from zero and would emit 51.1235 here -- a last-digit
    // difference that fails byte parity while looking identical on a map.
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank({ lat_lng: "51.12345,-1.5" })]);

    expect(await buildGeojsonResponse(session, "en", { kind: "all" })).toContain('"coordinates": [-1.5, 51.1234]');
  });

  it("writes a sub-1e-4 coordinate in Python's exponential form on a 6dp feed", async () => {
    // formatFloat switches to exponential text below 1e-4, and only a 6dp
    // feed can produce a non-zero value that small (the same longitude on
    // the 4dp all-items feed rounds to a plain "0.0", asserted here too so
    // the pair is visibly a consequence of decimal_places and not of the
    // formatter alone). python3 agrees on both:
    //   json.dumps(round(0.000001, 6)) -> "1e-06"
    //   json.dumps(round(0.000001, 4)) -> "0.0"
    // A String(x) formatter would emit JS's "1e-6" -- one digit short of
    // Python's zero-padded two-digit exponent, and a byte-parity failure
    // right next to Greenwich, where UK longitudes actually are.
    vi.mocked(getFoodbankBySlug).mockResolvedValue(makeFoodbank({ lat_lng: "51.5,0.000001" }) as never);
    expect(await buildGeojsonResponse(session, "en", { kind: "foodbank", slug: "testville" })).toContain(
      '"coordinates": [1e-06, 51.5]',
    );

    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank({ lat_lng: "51.5,0.000001" })]);
    expect(await buildGeojsonResponse(session, "en", { kind: "all" })).toContain('"coordinates": [0.0, 51.5]');
  });

  it("tolerates a space after the comma in a stored lat_lng", async () => {
    // Both sides tolerate it, which is why this is parity and not luck:
    // Python's float(" -0.1") trims surrounding whitespace and so does
    // JS's Number(). A stricter parse here would turn any stored
    // "lat, lng" row into NaN coordinates on one side only.
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank({ lat_lng: "51.5, -0.1" })]);

    expect(await buildGeojsonResponse(session, "en", { kind: "all" })).toContain('"coordinates": [-0.1, 51.5]');
  });

  it("emits a bare NaN, and does not throw, for a lat_lng with no comma", async () => {
    // Documented, not endorsed: a malformed column produces
    // "coordinates": [NaN, NaN], which is not parseable JSON (Django would
    // instead have raised ValueError in float() and 500'd). Every
    // production row is well-formed "lat,lng", so this is a data-invariant
    // question rather than a live bug -- pinned so that the day someone
    // adds validation, they see this test and choose the behaviour
    // deliberately.
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank({ lat_lng: "not-a-coordinate" })]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "all" })) as string;
    expect(body).toContain('"coordinates": [NaN, NaN]');
    expect(() => JSON.parse(body)).toThrow();
  });

  it("turns an EMPTY lat_lng into [NaN, 0.0], not [NaN, NaN]", async () => {
    // The asymmetry is worth its own test because it is genuinely
    // surprising and the "no comma" case above does not reach it:
    // "".split(",") is [""], Number("") is 0 (not NaN) while
    // Number(undefined) is NaN, so an empty column yields a HALF-valid
    // coordinate -- latitude 0.0, longitude NaN. Python's float("") raises
    // ValueError instead, so there is no Django output to match; this is
    // the port's own behaviour, pinned rather than endorsed. A caller
    // adding a `if (!lat_lng)` skip would be a deliberate change, and this
    // test is where they will see it.
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank({ lat_lng: "" })]);

    const body = (await buildGeojsonResponse(session, "en", { kind: "all" })) as string;
    expect(body).toContain('"coordinates": [NaN, 0.0]');
  });

  it("ignores anything after a second comma in a stored lat_lng", async () => {
    // split(",") keeps every field but only [0] and [1] are read, so a
    // three-field row degrades to its first two rather than throwing --
    // the same as Python's `lat, lng = latlng.split(",")[:2]`-shaped
    // indexing in the source. Recorded because "extra junk in the column"
    // is the malformed shape most likely to actually occur next to the
    // empty and comma-less ones above.
    vi.mocked(getAllOpenFoodbanks).mockResolvedValue([makeFoodbank({ lat_lng: "51.5,-0.1,999" })]);

    expect(await buildGeojsonResponse(session, "en", { kind: "all" })).toContain('"coordinates": [-0.1, 51.5]');
  });
});
