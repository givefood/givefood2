import { describe, expect, it } from "vitest";
import type { Session } from "@givefood/db";
import { R_EARTHDISTANCE, R_PYTHON, haversineMeters, miles } from "@givefood/geo";
import { findDonationpoints, type DonationpointSearchResult } from "./findDonationpoints";

// findDonationpoints() is the "Donation points near you" half of the /needs/
// index page (routes/wfbn/index.ts), ported from givefood/utils/geo.py's
// find_donationpoints() (:407-449). Three things about it are load-bearing
// and none of them is visible from the shape of the code:
//
//   1. ONE global ranking over both source tables. Django runs two
//      querysets, caps each at `quantity`, chain()s them, sorts by
//      distance and caps again; this ranks the merged candidate set once.
//      PLAN.md §7.5.2 proves those agree for skip_first=False -- but only
//      if the cap here is applied to the MERGE, not per table.
//   2. the WP 2.5 candidate/hydrate split. The whole reason this function
//      is two round trips instead of one is that ranking runs over
//      id+lat+lng rows (a covering index scan over 1000-5700 rows) and
//      full rows are fetched only for the 20 survivors. A "simplification"
//      that hydrated every open row would still return the right answer,
//      and would put the dominant cost back on every uncached search.
//   3. the deliberate absence of url/photo_url. Django builds those with
//      reverse() mid-request, where the active language is set; this
//      function has no locale, so building them here would emit
//      unprefixed English URLs on every Welsh/Irish/Gaelic page.
//
// The tests below run the REAL @givefood/db query functions against a fake
// D1 session, rather than mocking that package out: the null-to-false
// boolean coercion, the id-order restoration after `WHERE id IN (...)` and
// the batched latest_need join are all part of what this function's output
// depends on, and mocking them away would test a much smaller thing than
// the one the page actually calls.

type Row = Record<string, unknown>;

type TableName =
  | "foodbankdonationpoint"
  | "foodbanklocation"
  | "foodbankdonationpoint_full"
  | "foodbanklocation_full"
  | "foodbank"
  | "foodbankchange_full";

interface RecordedQuery {
  sql: string;
  binds: unknown[];
}

// A stand-in for D1DatabaseSession that answers the handful of statements
// @givefood/db issues on this path, and records them so tests can assert on
// WHICH ids got hydrated -- see load-bearing point 2 above.
function fakeSession(tables: Partial<Record<TableName, Row[]>>): { session: Session; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const session = {
    prepare(sql: string) {
      const recorded: RecordedQuery = { sql, binds: [] };
      queries.push(recorded);
      const table = /FROM (\w+)/.exec(sql)?.[1] as TableName | undefined;
      const statement = {
        bind(...binds: unknown[]) {
          recorded.binds = binds;
          return statement;
        },
        async all() {
          const rows = (table && tables[table]) ?? [];
          if (recorded.binds.length === 0) return { results: [...rows] };
          // Every bound statement on this path is `WHERE id IN (...)`, which
          // carries no ORDER BY -- SQLite may return those rows in any order
          // it likes (see getFoodbanksByIds's own comment on exactly this).
          // Handing them back REVERSED keeps that promise honest: nothing in
          // the output may depend on D1's row order.
          return { results: [...rows.filter((row) => recorded.binds.includes(row.id))].reverse() };
        },
      };
      return statement;
    },
  };
  return { session: session as unknown as Session, queries };
}

interface PointSpec {
  id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  foodbankId?: number;
  // Raw D1 INTEGER, not a boolean: the 0/1/NULL that actually comes back
  // over the wire, so coerceBooleans() runs for real.
  placeHasPhoto?: 0 | 1 | null;
  // Candidate row present, full-view row missing -- the read-replica /
  // deleted-mid-request case.
  omitFullRow?: boolean;
}

interface FoodbankSpec {
  id: number;
  name: string;
  slug: string;
  facebookPage?: string | null;
  latestNeedId?: number | null; // null: no latest need at all
  needText?: string;
  omitNeedRow?: boolean; // latest_need_id set, foodbankchange row gone
  // Donation point rows still name this food bank, but the foodbank table
  // has no row for it -- the third of the three "row vanished between two
  // statements" cases this function can hit.
  omitFoodbankRow?: boolean;
}

interface Scenario {
  donationpoints?: PointSpec[];
  locations?: PointSpec[];
  foodbanks?: FoodbankSpec[];
}

const DEFAULT_FOODBANK: FoodbankSpec = {
  id: 1,
  name: "Croydon Foodbank",
  slug: "croydon",
  facebookPage: "croydonfoodbank",
  needText: "Tinned tomatoes, Nappies (size 5)",
};

function needIdOf(foodbank: FoodbankSpec): number | null {
  return foodbank.latestNeedId === undefined ? 100 + foodbank.id : foodbank.latestNeedId;
}

function build({ donationpoints = [], locations = [], foodbanks = [DEFAULT_FOODBANK] }: Scenario) {
  const foodbankById = new Map(foodbanks.map((foodbank) => [foodbank.id, foodbank]));

  const coordinateRows = (points: PointSpec[]): Row[] =>
    points.map((point) => ({ id: point.id, latitude: point.lat, longitude: point.lng }));

  // foodbank_name/foodbank_slug are joined in by the *_full views
  // (migrations/0019_drop_foodbank_cache.sql), so they always agree with
  // the parent food bank row -- the fixtures derive them the same way.
  const fullRows = (points: PointSpec[]): Row[] =>
    points
      .filter((point) => !point.omitFullRow)
      .map((point) => {
        const foodbank = foodbankById.get(point.foodbankId ?? 1)!;
        return {
          id: point.id,
          foodbank_id: foodbank.id,
          foodbank_name: foodbank.name,
          foodbank_slug: foodbank.slug,
          name: point.name,
          slug: point.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          place_has_photo: point.placeHasPhoto === undefined ? 1 : point.placeHasPhoto,
          latitude: point.lat,
          longitude: point.lng,
          is_closed: 0,
        };
      });

  const foodbankRows: Row[] = foodbanks
    .filter((foodbank) => !foodbank.omitFoodbankRow)
    .map((foodbank) => ({
      id: foodbank.id,
      name: foodbank.name,
      slug: foodbank.slug,
      facebook_page: foodbank.facebookPage ?? null,
      latest_need_id: needIdOf(foodbank),
      is_closed: 0,
    }));

  const needRows: Row[] = foodbanks
    .filter((foodbank) => needIdOf(foodbank) !== null && !foodbank.omitNeedRow)
    .map((foodbank) => ({
      id: needIdOf(foodbank),
      change_text: foodbank.needText ?? `Need for ${foodbank.slug}`,
      published: 1,
    }));

  return fakeSession({
    foodbankdonationpoint: coordinateRows(donationpoints),
    foodbanklocation: coordinateRows(locations),
    foodbankdonationpoint_full: fullRows(donationpoints),
    foodbanklocation_full: fullRows(locations),
    foodbank: foodbankRows,
    foodbankchange_full: needRows,
  });
}

// Real UK coordinates, so the mileages below are the numbers the page
// actually prints. Origin is Charing Cross for every test.
const LONDON = { lat: 51.5074, lng: -0.1278 };
const CROYDON = { lat: 51.3762, lng: -0.0982 }; // ~15 km
const WATFORD = { lat: 51.6565, lng: -0.3903 }; // ~24 km
const OXFORD = { lat: 51.752, lng: -1.2577 }; // ~85 km
const MANCHESTER = { lat: 53.4808, lng: -2.2426 }; // ~262 km
const EDINBURGH = { lat: 55.9533, lng: -3.1883 }; // ~536 km

const labels = (results: DonationpointSearchResult[]) => results.map((r) => `${r.type}:${r.name}`);

const sqlFor = (queries: RecordedQuery[], table: TableName) =>
  queries.filter((q) => new RegExp(`FROM ${table}\\b`).test(q.sql));

// The mileage the page should print for a point, computed independently of
// the function under test. Used instead of "the distances come out sorted",
// which a function that gave every row the SAME distance would also satisfy.
const milesFromLondon = (point: { lat: number; lng: number }) =>
  miles(haversineMeters(LONDON.lat, LONDON.lng, point.lat, point.lng, R_EARTHDISTANCE));

// The two branches of the return build separate object literals with the
// same fields typed out twice, so the key set is asserted for BOTH -- a
// field added to (or dropped from) one branch only is exactly the kind of
// divergence copy-pasted literals produce, and the template renders both
// kinds of row through the same markup.
const EXPECTED_KEYS = [
  "distance_mi",
  "facebook_page",
  "foodbank_name",
  "foodbank_slug",
  "latest_need_change_text",
  "latest_need_id",
  "name",
  "place_has_photo",
  "slug",
  "type",
];

// Wraps a built session so the donation-point candidate scan settles a
// macrotask later than the location one, recording issue/settle order.
// Only used by the concurrency test below.
function traceCandidateScans(session: Session, trace: string[]): Session {
  const inner = session as unknown as { prepare(sql: string): Record<string, unknown> };
  return {
    prepare(sql: string) {
      const statement = inner.prepare(sql) as { bind(...b: unknown[]): unknown; all(): Promise<unknown> };
      const leg = /FROM foodbankdonationpoint\b/.test(sql)
        ? "donationpoints"
        : /FROM foodbanklocation\b/.test(sql)
          ? "locations"
          : null;
      if (leg === null) return statement;
      trace.push(`${leg}:issued`);
      return {
        bind: (...binds: unknown[]) => statement.bind(...binds),
        async all() {
          const rows = await statement.all();
          if (leg === "donationpoints") await new Promise((resolve) => setTimeout(resolve, 0));
          trace.push(`${leg}:settled`);
          return rows;
        },
      };
    },
  } as unknown as Session;
}

describe("findDonationpoints", () => {
  it("ranks both source tables in one list, nearest first, tagged by where the row came from", async () => {
    // The documented happy path. Candidates are declared in an order that
    // has nothing to do with distance, and interleaved across the two
    // tables, so neither "return them as they arrive" nor "donation points
    // first, then locations" can pass.
    const { session } = build({
      donationpoints: [
        { id: 11, name: "Oxford Tesco", ...OXFORD },
        { id: 12, name: "Edinburgh Sainsburys", ...EDINBURGH },
      ],
      locations: [
        { id: 21, name: "Croydon Church", ...CROYDON },
        { id: 22, name: "Manchester Hall", ...MANCHESTER },
        { id: 23, name: "Watford Library", ...WATFORD },
      ],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    expect(labels(results)).toEqual([
      "location:Croydon Church",
      "location:Watford Library",
      "donationpoint:Oxford Tesco",
      "location:Manchester Hall",
      "donationpoint:Edinburgh Sainsburys",
    ]);
    // Distances must come out non-decreasing whatever the input order --
    // the page prints them next to each other.
    const distances = results.map((r) => r.distance_mi);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    // ...and each row must carry ITS OWN distance. Sortedness alone is
    // satisfied by a function that stamps one distance onto every row (the
    // shape of a closure bug in the ranked.map()), which would print
    // "9.3 miles" against Edinburgh. Every mileage is checked against an
    // independent calculation from that row's own coordinates.
    expect(distances).toEqual([
      milesFromLondon(CROYDON),
      milesFromLondon(WATFORD),
      milesFromLondon(OXFORD),
      milesFromLondon(MANCHESTER),
      milesFromLondon(EDINBURGH),
    ]);
    expect(new Set(distances).size).toBe(5);
  });

  it("caps the MERGED list at quantity, not quantity per source table", async () => {
    // Django caps each queryset at `quantity`, chain()s them, re-sorts and
    // slices to `quantity` again (geo.py:435-436). Capping only per leg
    // here would return 4 rows for quantity=2 -- twice as many donation
    // points as the page asked for.
    const { session, queries } = build({
      donationpoints: [
        { id: 11, name: "Oxford Tesco", ...OXFORD },
        { id: 12, name: "Manchester Asda", ...MANCHESTER },
      ],
      locations: [
        { id: 21, name: "Croydon Church", ...CROYDON },
        { id: 22, name: "Watford Library", ...WATFORD },
      ],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 2);
    expect(labels(results)).toEqual(["location:Croydon Church", "location:Watford Library"]);
    // Both winners came from one table, so the other leg's id list is empty
    // -- and an empty id list must not become `WHERE id IN ()`, which is a
    // SQLite syntax error.
    expect(sqlFor(queries, "foodbankdonationpoint_full")).toHaveLength(0);
  });

  it("skips the location hydrate too when no location made the cut", async () => {
    // Mirror of the case above, for the other leg. Both are worth pinning:
    // the empty-list guard lives in getLocationsByIds/getDonationPointsByIds
    // separately, and only one of the two being reached is a plausible way
    // for `WHERE id IN ()` -- a SQLite syntax error, i.e. a 500 on the
    // /needs/ page -- to reach production.
    const { session, queries } = build({
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
      locations: [{ id: 21, name: "Edinburgh Church", ...EDINBURGH }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 1);
    expect(labels(results)).toEqual(["donationpoint:Croydon Tesco"]);
    expect(sqlFor(queries, "foodbanklocation_full")).toHaveLength(0);
  });

  it("splits one quantity across both legs when the winners are mixed", async () => {
    // The case that actually distinguishes a merged cap from a per-leg one
    // when BOTH legs contribute. Django caps each queryset at `quantity`,
    // chain()s and re-slices (geo.py:435-436); PLAN.md §7.5.2 proves the
    // single global sort+slice here agrees for skip_first=False. So for
    // quantity=3 over the 5 candidates below, the answer is the global top
    // three -- two donation points and one location -- and, crucially, only
    // those three ids get hydrated. A per-leg cap would hydrate three of
    // each and print six rows.
    const { session, queries } = build({
      donationpoints: [
        { id: 11, name: "Croydon Tesco", ...CROYDON },
        { id: 12, name: "Oxford Tesco", ...OXFORD },
        { id: 13, name: "Edinburgh Sainsburys", ...EDINBURGH },
      ],
      locations: [
        { id: 21, name: "Watford Library", ...WATFORD },
        { id: 22, name: "Manchester Hall", ...MANCHESTER },
      ],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 3);
    expect(labels(results)).toEqual([
      "donationpoint:Croydon Tesco",
      "location:Watford Library",
      "donationpoint:Oxford Tesco",
    ]);
    // Ids are bound in ranked order within each leg, and the far-away
    // candidates never get fetched at all.
    expect(sqlFor(queries, "foodbankdonationpoint_full")[0]!.binds).toEqual([11, 12]);
    expect(sqlFor(queries, "foodbanklocation_full")[0]!.binds).toEqual([21]);
  });

  it("never skips the nearest point -- find_donationpoints has no skip_first", async () => {
    // findLocations() takes a skipFirst flag (for /needs/at/<slug>/nearby/,
    // which drops the food bank itself); Django's find_donationpoints has
    // no such parameter at all, so this one passes `false` unconditionally.
    // A search launched from a donation point's own coordinates must still
    // show that donation point, at zero miles.
    const { session } = build({
      donationpoints: [{ id: 11, name: "Charing Cross Tesco", ...LONDON }],
      locations: [{ id: 21, name: "Croydon Church", ...CROYDON }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    expect(labels(results)).toEqual(["donationpoint:Charing Cross Tesco", "location:Croydon Church"]);
    expect(results[0]!.distance_mi).toBe(0);
  });

  it("measures distance with the earthdistance radius, not the api/1 python one", async () => {
    // PLAN.md §7.5.1 keeps two Earth radii on purpose: Postgres
    // earth_distance()'s 6378168 m (what Django's find_donationpoints
    // annotates with, via EarthDistance) and geo.py's own 6367000 m (api/1
    // only). They differ by 0.175% -- small enough that a swap looks
    // plausible in a diff, big enough to change a published mileage.
    const { session } = build({ donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }] });

    const [result] = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    const earthdistance = miles(haversineMeters(LONDON.lat, LONDON.lng, CROYDON.lat, CROYDON.lng, R_EARTHDISTANCE));
    expect(result!.distance_mi).toBe(earthdistance);
    expect(result!.distance_mi).not.toBe(
      miles(haversineMeters(LONDON.lat, LONDON.lng, CROYDON.lat, CROYDON.lng, R_PYTHON)),
    );
    // Croydon is ~15 km from Charing Cross: a metres/miles slip would land
    // an order of magnitude outside this.
    expect(result!.distance_mi).toBeGreaterThan(9);
    expect(result!.distance_mi).toBeLessThan(10);
  });

  it("reads facebook_page and the latest need from each row's own parent food bank", async () => {
    // Neither foodbankdonationpoint nor foodbanklocation carries
    // facebook_page or a need: both come from the parent food bank, fetched
    // by foodbank_id. With results from two different food banks in one
    // list, a lookup that grabbed "the first food bank" (or keyed the map
    // wrongly) would attribute one charity's shopping list to the other's
    // donation point -- wrong information on a public page.
    const { session } = build({
      foodbanks: [
        { id: 1, name: "Croydon Foodbank", slug: "croydon", facebookPage: "croydonfb", needText: "Rice, Tea" },
        { id: 2, name: "Oxford Foodbank", slug: "oxford", facebookPage: null, needText: "Nappies, UHT milk" },
      ],
      donationpoints: [{ id: 11, name: "Oxford Tesco", ...OXFORD, foodbankId: 2 }],
      locations: [{ id: 21, name: "Croydon Church", ...CROYDON, foodbankId: 1 }],
    });

    const [croydon, oxford] = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    expect(croydon).toMatchObject({
      foodbank_slug: "croydon",
      foodbank_name: "Croydon Foodbank",
      facebook_page: "croydonfb",
      latest_need_change_text: "Rice, Tea",
      latest_need_id: 101,
    });
    expect(oxford).toMatchObject({
      foodbank_slug: "oxford",
      foodbank_name: "Oxford Foodbank",
      facebook_page: null, // nullable column, preserved rather than defaulted
      latest_need_change_text: "Nappies, UHT milk",
      latest_need_id: 102,
    });
  });

  it("keeps donation points and locations in separate id maps", async () => {
    // foodbankdonationpoint.id and foodbanklocation.id are independent
    // sequences, so the same number routinely names one of each. One shared
    // Map keyed on id would silently hand back whichever row was inserted
    // last -- a location's name and slug under a donation point's heading.
    const { session } = build({
      donationpoints: [{ id: 7, name: "Croydon Tesco", ...CROYDON }],
      locations: [{ id: 7, name: "Watford Library", ...WATFORD }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    expect(labels(results)).toEqual(["donationpoint:Croydon Tesco", "location:Watford Library"]);
    expect(results.map((r) => r.slug)).toEqual(["croydon-tesco", "watford-library"]);
  });

  it("hydrates only the ranked survivors, never the whole candidate set", async () => {
    // WP 2.5's entire point (module comment, load-bearing item 2): rank over
    // id+lat+lng, then fetch full rows for the winners alone. This asserts
    // the bound ids, so hydrating all five candidates -- the shape of the
    // "simpler" one-query version -- fails here rather than in production
    // load.
    const { session, queries } = build({
      donationpoints: [
        { id: 11, name: "Croydon Tesco", ...CROYDON },
        { id: 12, name: "Oxford Tesco", ...OXFORD },
        { id: 13, name: "Edinburgh Sainsburys", ...EDINBURGH },
      ],
      locations: [
        { id: 21, name: "Watford Library", ...WATFORD },
        { id: 22, name: "Manchester Hall", ...MANCHESTER },
      ],
    });

    await findDonationpoints(session, LONDON.lat, LONDON.lng, 2);
    // The candidate scans select three columns, not `*`, and take no binds.
    expect(sqlFor(queries, "foodbankdonationpoint")[0]!.sql).toContain("SELECT id, latitude, longitude");
    expect(sqlFor(queries, "foodbanklocation")[0]!.sql).toContain("SELECT id, latitude, longitude");
    expect(sqlFor(queries, "foodbankdonationpoint_full")[0]!.binds).toEqual([11]);
    expect(sqlFor(queries, "foodbanklocation_full")[0]!.binds).toEqual([21]);
  });

  it("asks for OPEN donation points and only locations flagged as donation points", async () => {
    // The single most swappable line in this function: @givefood/db exports
    // both getOpenLocationCoordinates (every open location -- what
    // findLocations.ts ranks) and getOpenDonationPointLocationCoordinates
    // (open AND is_donation_point = 1). Django's find_donationpoints filters
    // `FoodbankLocation.objects.filter(is_closed=False, is_donation_point=True)`
    // (geo.py:407-449); reaching for the wrong one here would list every
    // food bank's distribution centre -- addresses the public is explicitly
    // NOT asked to take donations to -- under "Donation points near you".
    //
    // The filtering happens in SQLite, so a fixture cannot demonstrate it:
    // the fake session answers by table name and ignores WHERE entirely.
    // Asserting the SQL text is therefore the only way to pin which of the
    // two candidate sets this function actually asked for -- and every
    // other test in this file passes with either.
    const { session, queries } = build({
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
      locations: [{ id: 21, name: "Watford Library", ...WATFORD }],
    });

    await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    const donationPointScan = sqlFor(queries, "foodbankdonationpoint")[0]!.sql;
    const locationScan = sqlFor(queries, "foodbanklocation")[0]!.sql;
    expect(donationPointScan).toContain("is_closed = 0");
    expect(locationScan).toContain("is_closed = 0");
    expect(locationScan).toContain("is_donation_point = 1");
    // `is_donation_point = 1` rather than `!= 0`: the column is nullable,
    // and D1's three-valued WHERE logic drops NULL rows for `= 1`, which is
    // what Django's `is_donation_point=True` does too (see
    // getOpenDonationPointLocations's own comment).
    expect(locationScan).not.toContain("is_donation_point != 0");
  });

  it("issues both candidate scans concurrently, not one after the other", async () => {
    // Two covering-index scans over 1000-5700 rows each (load-bearing item
    // 2 in the module comment), on the hottest page on the site. They sit
    // in one Promise.all so their latency overlaps; awaiting each in turn
    // reads identically in a diff and doubles the fixed cost of every
    // uncached search. The interleaving below is only reachable if the
    // second scan is issued before the first has settled.
    const trace: string[] = [];
    const { session } = build({
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
      locations: [{ id: 21, name: "Watford Library", ...WATFORD }],
    });

    const results = await findDonationpoints(traceCandidateScans(session, trace), LONDON.lat, LONDON.lng, 10);
    expect(trace).toEqual([
      "donationpoints:issued",
      "locations:issued",
      "locations:settled",
      "donationpoints:settled",
    ]);
    // And the slower leg's rows still make it into the answer -- a
    // Promise.all that dropped a result would show up here, not in latency.
    expect(labels(results)).toEqual(["donationpoint:Croydon Tesco", "location:Watford Library"]);
  });

  it("orders results by distance even when D1 returns the hydrated rows in another order", async () => {
    // `WHERE id IN (...)` has no ORDER BY, so SQLite's row order is
    // arbitrary -- the fake session deliberately reverses it. Output order
    // must come from the ranking, not from whatever came back.
    const { session } = build({
      donationpoints: [
        { id: 11, name: "Croydon Tesco", ...CROYDON },
        { id: 12, name: "Oxford Tesco", ...OXFORD },
        { id: 13, name: "Edinburgh Sainsburys", ...EDINBURGH },
      ],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 3);
    expect(results.map((r) => r.name)).toEqual(["Croydon Tesco", "Oxford Tesco", "Edinburgh Sainsburys"]);
  });

  it("puts a donation point before a location at exactly the same distance", async () => {
    // Django chain()s donationpoints then location_donationpoints and sorts
    // with Python's stable sorted(), so an exact tie keeps the donation
    // point first. The port relies on the same stability, spreading donation
    // point candidates first -- pin it, because "sort by distance" alone
    // does not say which of two equal rows wins.
    const { session } = build({
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
      locations: [{ id: 21, name: "Croydon Church", ...CROYDON }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    expect(labels(results)).toEqual(["donationpoint:Croydon Tesco", "location:Croydon Church"]);
    expect(results[0]!.distance_mi).toBe(results[1]!.distance_mi);
  });

  it("de-duplicates parent food bank ids into a single query", async () => {
    // A food bank with several donation points is the normal case (one
    // supermarket chain, many stores), and D1 caps a statement at 100 bound
    // parameters. Losing the Set here means 20 results bind 20 ids -- and
    // repeats the same latest_need join up to 20 times.
    const { session, queries } = build({
      donationpoints: [
        { id: 11, name: "Croydon Tesco", ...CROYDON },
        { id: 12, name: "Watford Tesco", ...WATFORD },
      ],
      locations: [{ id: 21, name: "Oxford Church", ...OXFORD }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    expect(results).toHaveLength(3);
    expect(sqlFor(queries, "foodbank")[0]!.binds).toEqual([1]);
    // ...and one batched need lookup for that one food bank, not one per row.
    expect(sqlFor(queries, "foodbankchange_full")).toHaveLength(1);
    expect(sqlFor(queries, "foodbankchange_full")[0]!.binds).toEqual([101]);
  });

  it("fetches every distinct parent food bank in ONE statement, not one per food bank", async () => {
    // The de-duplication test above proves repeats collapse; it cannot see
    // an N+1, because every one of its rows shares a single parent, so a
    // per-id loop and a batched read issue the same one query. This one has
    // three distinct parents among four results -- the normal shape for a
    // city-centre search -- so a loop costs three food bank reads and three
    // need reads instead of one of each. Twenty results spanning a dozen
    // food banks would be 22 extra serial round trips on the busiest page
    // on the site, and no test would have noticed.
    const { session, queries } = build({
      foodbanks: [
        { id: 1, name: "Croydon Foodbank", slug: "croydon", needText: "Rice" },
        { id: 2, name: "Watford Foodbank", slug: "watford", needText: "Nappies" },
        { id: 3, name: "Oxford Foodbank", slug: "oxford", needText: "UHT milk" },
      ],
      donationpoints: [
        { id: 11, name: "Croydon Tesco", ...CROYDON, foodbankId: 1 },
        { id: 12, name: "Oxford Tesco", ...OXFORD, foodbankId: 3 },
      ],
      locations: [
        { id: 21, name: "Watford Library", ...WATFORD, foodbankId: 2 },
        { id: 22, name: "Manchester Hall", ...MANCHESTER, foodbankId: 1 },
      ],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    expect(sqlFor(queries, "foodbank")).toHaveLength(1);
    expect(sqlFor(queries, "foodbankchange_full")).toHaveLength(1);
    // Order is not asserted -- only that all three parents, and all three
    // of their needs, were asked for together. The repeated parent (food
    // bank 1 owns both a donation point and a location) is still counted
    // once, so this covers the de-duplication case as well.
    expect([...sqlFor(queries, "foodbank")[0]!.binds].sort()).toEqual([1, 2, 3]);
    expect([...sqlFor(queries, "foodbankchange_full")[0]!.binds].sort()).toEqual([101, 102, 103]);
    // ...and every row still ends up with its OWN parent's need, which is
    // the thing the batching must not trade away.
    expect(results.map((r) => `${r.foodbank_slug}:${r.latest_need_change_text}`)).toEqual([
      "croydon:Rice",
      "watford:Nappies",
      "oxford:UHT milk",
      "croydon:Rice",
    ]);
  });

  it("turns a NULL place_has_photo into false rather than leaking null to the template", async () => {
    // place_has_photo is INTEGER 0/1/NULL in D1 and NULL in production for
    // rows never checked against the Places API. The template branches on it
    // to decide whether to request a photo, so `?? false` has to hold: null
    // means "no photo we know of", and a null reaching the template renders
    // the photo markup for an image that 404s.
    const { session } = build({
      donationpoints: [
        { id: 11, name: "Croydon Tesco", ...CROYDON, placeHasPhoto: 1 },
        { id: 12, name: "Watford Tesco", ...WATFORD, placeHasPhoto: 0 },
        { id: 13, name: "Oxford Tesco", ...OXFORD, placeHasPhoto: null },
      ],
      locations: [{ id: 21, name: "Manchester Hall", ...MANCHESTER, placeHasPhoto: null }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    expect(results.map((r) => r.place_has_photo)).toEqual([true, false, false, false]);
  });

  it("returns no url or photo_url, unlike Django's find_donationpoints", async () => {
    // geo.py:438-446 decorates each row with url/photo_url (and, for
    // donation points, homepage_url) via reverse(). Those are locale-aware
    // only because Django builds them mid-request; here there is no active
    // language, so the template builds them from slug/foodbank_slug via
    // {{ url(...) }}. Adding a url field back to this result would produce
    // silently unprefixed English links on /cy/, /ga/ and /gd/.
    // Both branches are checked: the source types the same ten fields out
    // twice, and only one of them being given a url would still ship the
    // bug on half the rows.
    const { session } = build({
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
      locations: [{ id: 21, name: "Watford Library", ...WATFORD }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    const donationpoint = results.find((r) => r.type === "donationpoint")!;
    const location = results.find((r) => r.type === "location")!;
    expect(Object.keys(donationpoint).sort()).toEqual(EXPECTED_KEYS);
    expect(Object.keys(location).sort()).toEqual(EXPECTED_KEYS);
  });

  it("builds a fresh object rather than spreading the database row", async () => {
    // The exact key sets above already forbid extra fields; this says WHY
    // it matters and fails with a legible message if a `...row` spread is
    // ever introduced. DonationPointRow and FoodbankLocationRow carry the
    // whole table -- including boundary_geojson, a large polygon blob on
    // locations -- and these objects go straight into a template context,
    // once per row, on the busiest page on the site. `latestNeed` is
    // called out too: it is a nested object on the food bank row, and
    // handing the template the whole need (rather than the two fields it
    // reads) is how a "just pass the parent through" refactor starts.
    const { session } = build({
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
      locations: [{ id: 21, name: "Watford Library", ...WATFORD }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).not.toHaveProperty("id");
      expect(result).not.toHaveProperty("foodbank_id");
      expect(result).not.toHaveProperty("latitude");
      expect(result).not.toHaveProperty("longitude");
      expect(result).not.toHaveProperty("is_closed");
      expect(result).not.toHaveProperty("latestNeed");
    }
  });

  // github #13. Both of these asserted TypeErrors as "frozen bug B12". The
  // justification did not hold for this file: B12 is about the five API views
  // PLAN.md:7305 names, which attribute-access None in PYTHON and raise.
  // Django's find_donationpoints() (geo.py:407) never touches latest_need at
  // all, and this function feeds an HTML page whose template swallows the
  // lookup. See findLocations.ts's note for the full reasoning and how it was
  // checked.
  it("returns a blank need when the parent food bank has none", async () => {
    const { session } = build({
      foodbanks: [{ id: 1, name: "Croydon Foodbank", slug: "croydon", latestNeedId: null }],
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);

    expect(results.map((r) => r.name)).toEqual(["Croydon Tesco"]);
    expect(results[0]!.latest_need_change_text).toBe("");
    expect(results[0]!.latest_need_id).toBeNull();
    // The row is otherwise whole -- a blank cell, not a dropped result.
    expect(results[0]!.foodbank_name).toBe("Croydon Foodbank");
  });

  it("does the same when latest_need_id points at a need row that is gone", async () => {
    // Worth keeping separate, and it is why the guard is on `latestNeed`
    // rather than on the id: getFoodbanksByIds resolves a DANGLING
    // latest_need_id to `latestNeed: null` rather than erroring, so a fix
    // that had checked `latest_need_id !== null` would still have crashed
    // here.
    const { session } = build({
      foodbanks: [{ id: 1, name: "Croydon Foodbank", slug: "croydon", latestNeedId: 999, omitNeedRow: true }],
      locations: [{ id: 21, name: "Croydon Church", ...CROYDON }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.latest_need_change_text).toBe("");
    expect(results[0]!.latest_need_id).toBeNull();
  });

  // THESE THREE USED TO ASSERT A 500. Their own comment called it "reported
  // as a suspected bug, not fixed here" -- github #48 is where it is fixed.
  // A ranked id whose row has gone now drops out of the list, which is the
  // outcome Django reaches by construction: it ranks and hydrates in one
  // queryset, so a row deleted a moment earlier is simply not a candidate.
  // The unguarded `!`s were the port's own two-phase read showing through.
  //
  // What has NOT changed is the B12 pair above: a parent food bank that is
  // FOUND and has a null latest_need still throws, because Django throws
  // there too. Found-but-null and not-found-at-all are different faults and
  // only the second one is the port's doing.
  it("drops a ranked row whose parent food bank has itself vanished", async () => {
    const { session } = build({
      foodbanks: [{ id: 1, name: "Croydon Foodbank", slug: "croydon", omitFoodbankRow: true }],
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
    });

    await expect(findDonationpoints(session, LONDON.lat, LONDON.lng, 10)).resolves.toEqual([]);
  });

  it("drops a ranked candidate that has no row in the _full view", async () => {
    const { session } = build({
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON, omitFullRow: true }],
    });

    await expect(findDonationpoints(session, LONDON.lat, LONDON.lng, 10)).resolves.toEqual([]);
  });

  it("drops a vanished LOCATION while keeping the donation points around it", async () => {
    // The location branch is a separate object literal with its own lookup,
    // so the donation-point case above does not cover it. A location deleted
    // between the candidate scan and the hydrate read is the likelier of the
    // two in practice: locations are edited far more often than donation
    // points.
    //
    // Seeded WITH a surviving donation point, unlike the two above: "drops
    // the bad one" and "returns nothing at all" are the same assertion on a
    // one-row fixture, and only the first of those is the fix.
    const { session } = build({
      locations: [{ id: 21, name: "Croydon Church", ...CROYDON, omitFullRow: true }],
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    expect(results.map((r) => r.name)).toEqual(["Croydon Tesco"]);
    expect(results[0]!.type).toBe("donationpoint");
  });

  it("returns an empty list, and issues no hydrate queries, when nothing is open", async () => {
    // Every donation point closed is a real state for a small area -- the
    // page renders its "no results" branch (routes/wfbn/index.ts converts
    // [] to null for Django's falsy-empty-list semantics). It must not cost
    // a `WHERE id IN ()` round trip to find that out.
    const { session, queries } = build({});

    expect(await findDonationpoints(session, LONDON.lat, LONDON.lng, 10)).toEqual([]);
    expect(queries).toHaveLength(2);
  });

  it("returns nothing for quantity 0, without hydrating anything", async () => {
    const { session, queries } = build({
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
      locations: [{ id: 21, name: "Watford Library", ...WATFORD }],
    });

    expect(await findDonationpoints(session, LONDON.lat, LONDON.lng, 0)).toEqual([]);
    // The candidate scans still run (they are what gets sliced to nothing),
    // but nothing beyond them.
    expect(queries).toHaveLength(2);
  });

  it("returns every candidate when quantity exceeds the candidate count", async () => {
    // Rural searches routinely have fewer than the 20 the index page asks
    // for; slicing past the end must yield the short list, not pad or throw.
    const { session } = build({
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
      locations: [{ id: 21, name: "Watford Library", ...WATFORD }],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 20);
    expect(labels(results)).toEqual(["donationpoint:Croydon Tesco", "location:Watford Library"]);
  });

  it("drops the FARTHEST result for a negative quantity, rather than returning none", async () => {
    // A negative quantity reaches Array.prototype.slice(0, quantity), where
    // a negative end counts back from the end of the list: quantity=-1
    // returns everything but the last candidate, and quantity=-99 returns
    // nothing. Nobody would predict that from the parameter's name, and
    // it is the opposite of the "fewer is safer" reading -- but it is
    // unreachable today (routes/wfbn/index.ts passes a literal 20), so it
    // is documented here rather than fixed, and reported as a latent trap.
    const { session } = build({
      donationpoints: [
        { id: 11, name: "Croydon Tesco", ...CROYDON },
        { id: 12, name: "Oxford Tesco", ...OXFORD },
      ],
      locations: [{ id: 21, name: "Watford Library", ...WATFORD }],
    });

    expect(labels(await findDonationpoints(session, LONDON.lat, LONDON.lng, -1))).toEqual([
      "donationpoint:Croydon Tesco",
      "location:Watford Library",
    ]);
    expect(await findDonationpoints(session, LONDON.lat, LONDON.lng, -99)).toEqual([]);
  });

  it("returns nothing, and hydrates nothing, for a NaN quantity", async () => {
    // The failure mode if a caller ever computed `quantity` from a query
    // string: Number("") is 0 but Number("twenty") is NaN, and slice()
    // coerces a NaN end to 0. An empty results section is the benign end
    // of that -- the alternative, had slice treated NaN as Infinity, would
    // be hydrating and rendering every open donation point in the country.
    const { session, queries } = build({
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
      locations: [{ id: 21, name: "Watford Library", ...WATFORD }],
    });

    expect(await findDonationpoints(session, LONDON.lat, LONDON.lng, Number.NaN)).toEqual([]);
    expect(queries).toHaveLength(2);
  });

  it("keeps hydration bounded by quantity, not by the size of the candidate set", async () => {
    // Load-bearing item 2 at production scale: 1000-5700 open rows, of
    // which the page shows 20. The existing five-candidate tests would all
    // still pass if hydration were accidentally proportional to the
    // candidate count; this one would not. Six statements total, whatever
    // the scan returns: two candidate scans, two hydrates, one food bank
    // read, one need read.
    const many = (base: number, count: number, latStep: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: base + i,
        name: `Point ${base + i}`,
        lat: LONDON.lat + latStep * (i + 1),
        lng: LONDON.lng,
      }));

    const { session, queries } = build({
      donationpoints: many(1000, 300, 0.01),
      locations: many(2000, 300, 0.011),
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 20);
    expect(results).toHaveLength(20);
    const distances = results.map((r) => r.distance_mi);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    const hydrated = [
      ...sqlFor(queries, "foodbankdonationpoint_full")[0]!.binds,
      ...sqlFor(queries, "foodbanklocation_full")[0]!.binds,
    ];
    expect(hydrated).toHaveLength(20);
    // Both legs won some, so this is not the "one leg only" shortcut, and
    // 20 bound ids is comfortably under D1's 100-parameter statement cap.
    expect(sqlFor(queries, "foodbankdonationpoint_full")[0]!.binds.length).toBeGreaterThan(0);
    expect(sqlFor(queries, "foodbanklocation_full")[0]!.binds.length).toBeGreaterThan(0);
    expect(queries).toHaveLength(6);
  });

  it("ranks a NULL-coordinate candidate as if it sat at 0,0 instead of dropping it", async () => {
    // Both coordinate columns are nullable in production (see
    // DonationPointRow), and the candidate query does not exclude nulls.
    // JS arithmetic coerces null to 0, so such a row is measured from the
    // Gulf of Guinea -- ~3,500 miles from anywhere in the UK, hence last.
    // Current behaviour, and the safe end of the failure: the visible bug
    // would be a null-coordinate row ranking FIRST, at zero miles, above
    // the genuinely nearest donation point.
    const { session } = build({
      donationpoints: [
        { id: 11, name: "Ungeocoded Tesco", lat: null, lng: null },
        { id: 12, name: "Croydon Tesco", ...CROYDON },
      ],
    });

    const results = await findDonationpoints(session, LONDON.lat, LONDON.lng, 10);
    expect(results.map((r) => r.name)).toEqual(["Croydon Tesco", "Ungeocoded Tesco"]);
    expect(results[1]!.distance_mi).toBeGreaterThan(3000);
  });

  it("does not throw on NaN search coordinates, which the caller screens for", async () => {
    // routes/wfbn/index.ts rejects a non-numeric lat/lng before calling this
    // (Number.isNaN plus isUk), so NaN never reaches here in production.
    // Documenting what happens anyway: every distance is NaN and the rows
    // come back unranked rather than the function blowing up mid-page.
    const { session } = build({
      donationpoints: [{ id: 11, name: "Croydon Tesco", ...CROYDON }],
      locations: [{ id: 21, name: "Watford Library", ...WATFORD }],
    });

    const results = await findDonationpoints(session, Number.NaN, Number.NaN, 10);
    expect(results).toHaveLength(2);
    expect(results.every((r) => Number.isNaN(r.distance_mi))).toBe(true);
  });
});
