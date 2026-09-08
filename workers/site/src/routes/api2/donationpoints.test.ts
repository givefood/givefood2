import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/api2/donationpoints.ts's list endpoint -- GET /api/2/donationpoints/,
// ported from gfapi2/views.py's `donationpoints`. The sibling search endpoint
// on the same router was uncovered until github #48; it now has the block at
// the bottom of this file, which covers the one behaviour #48 changed and
// nothing else.
//
// WHY THIS FILE EXISTS. getAllOpenDonationPoints was `SELECT *` over
// foodbankdonationpoint_full, a ~41-column view, for 5,727 open rows -- and
// this handler names eleven fields off each row and ignores the rest.
// Measured against production D1: 10.6 MB of result payload -> 3.3 MB and a
// server-reported ~300 ms -> ~79 ms, with rows_read unchanged at 11,454, so
// nothing about D1 billing moves. The query is now projected.
//
// The claim that has to be defended is "no response byte moved", and the only
// honest way to defend it is to assert the WHOLE BODY. Every field below is
// read off a column that a hand-written twelve-name projection could silently
// omit; a missing one does not throw, it publishes `null`. Three are worth
// watching in particular, because they do not come off the donation-point row
// at all -- foodbank_name, foodbank_slug and foodbank_network reach it
// through the view's LEFT JOIN onto the parent food bank (0019 dropped the
// denormalised copies), so a projection that named the dropped columns would
// fail to prepare and one that dropped the joined ones publishes nulls.
//
// THIS FILE WAS WRITTEN BEFORE THE PROJECTION AND RUN GREEN AGAINST THE
// `SELECT *` VERSION FIRST, then re-run against the projected one. That
// order is the whole evidence: an expectation written after a change can
// only say what the code now does, not that it still does what it did.
//
// REAL EVERYTHING (real app, real router, real migrations), same harness as
// routes/api2/locations.test.ts and routes/public/sitemaps.test.ts.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

function d1Session(db: DatabaseSync, prepared: string[]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      prepared.push(sql);
      // A seam for simulating a row that vanishes MID-REQUEST -- see the
      // github #48 block at the bottom. Null except there; reset in
      // beforeEach.
      onPrepare?.(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: string[];
let onPrepare: ((sql: string) => void) | null = null;

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  network?: string;
  deliveryAddress?: string | null;
  deliveryLatLng?: string | null;
}

function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng,
       delivery_address, delivery_lat_lng, network, charity_just_foodbank, contact_email,
       phone_number, url, shopping_list_url, address_is_administrative, is_closed,
       no_locations, days_between_needs, parliamentary_constituency_name, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79',
       ?, ?, ?, 0, ?, '01722 411900', ?, ?, 0, 0, 0, 14, 'Salisbury',
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.slug,
    s.deliveryAddress ?? null,
    s.deliveryLatLng ?? null,
    s.network ?? "Trussell Trust",
    `info@${s.slug}.invalid`,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
  );
}

interface DonationPointSeed {
  id: number;
  foodbankId: number;
  slug: string;
  name: string;
  latitude: number;
  isClosed?: 0 | 1;
  phone?: string | null;
  url?: string | null;
}

// Every column the ETL writes, including the ones this endpoint must NOT
// publish: opening_hours, notes, plus_code_*, place_id, county/ward/district,
// store_id and the three flag columns are all filled with recognisable
// values, so a projection that widened back to `SELECT *` and a handler that
// started spreading the row would both show up in the body assertions below.
function seedDonationPoint(s: DonationPointSeed): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode,
       country, lat_lng, latitude, longitude, place_id, plus_code_compound, plus_code_global,
       place_has_photo, county, district, ward, lsoa, msoa,
       parliamentary_constituency_id, parliamentary_constituency_name, parliamentary_constituency_slug,
       mp, mp_party, mp_parl_id, is_closed, in_store_only, phone_number, url, opening_hours,
       wheelchair_accessible, company, company_slug, store_id, notes, modified)
     VALUES (?, ?, ?, ?, ?, '12 Castle Street', 'SP1 3TA', 'England', ?, ?, -1.79,
       'ChIJdd4hrwug2EcRmSrV3Vo6llI', 'PLUSCODECOMPOUND', 'PLUSCODEGLOBAL', 1,
       'Wiltshire', 'Salisbury District', 'Bemerton Ward', 'E01032015', 'E02006697',
       4001, 'Salisbury', 'salisbury', 'John Glen', 'Conservative', 4051,
       ?, 1, ?, ?, 'Mon-Sat 08:00-20:00', 1, 'Tesco Stores Ltd', 'tesco', 'STORE-4471',
       'Internal note, never published', '2026-08-14 11:02:03.918000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "d"),
    s.foodbankId,
    s.name,
    s.slug,
    `${s.latitude},-1.79`,
    s.latitude,
    s.isClosed ?? 0,
    s.phone === undefined ? "01722 000000" : s.phone,
    s.url === undefined ? "https://tesco.invalid/store/?utm_source=spam" : s.url,
  );
}

// Latitudes DESCEND while ids ascend, so rowid order and the partial
// dp_open_latlng_idx's order are two different sequences here. The endpoint
// has no ORDER BY -- Django's queryset has none either -- so whichever the
// engine picks is what ~5,700 features come back in, and the whole-body
// assertions below pin it. A projection narrow enough to change the query
// plan would reorder the live feed silently; this is what would catch that.
function seed(): void {
  seedFoodbank({ id: 1, slug: "salisbury", name: "Salisbury" });
  // A second food bank with a delivery address, for the endpoint's second
  // loop. Untouched by the projection, but it shares the feature array, so
  // leaving it out would let a whole-body assertion pass over half the body.
  seedFoodbank({
    id: 2,
    slug: "westbury",
    name: "Westbury",
    network: "IFAN",
    deliveryAddress: "Depot Road\r\nBA13 3AA",
    deliveryLatLng: "51.26,-2.19",
  });
  seedDonationPoint({ id: 11, foodbankId: 1, slug: "tesco-extra", name: "Tesco Extra", latitude: 51.03 });
  seedDonationPoint({ id: 12, foodbankId: 1, slug: "shut-wilko", name: "Shut Wilko", latitude: 51.02, isClosed: 1 });
  // No url and no phone: `web` falls to Python's literal `False` (not null)
  // through urlWithRefDonationPoint, and `telephone` to null.
  seedDonationPoint({ id: 13, foodbankId: 2, slug: "aldi", name: "Aldi Westbury", latitude: 51.01, phone: null, url: null });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seed();
  prepared = [];
  onPrepare = null;
});

afterEach(() => {
  db.close();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);

describe("api2 donationpoints -- GET /api/2/donationpoints/", () => {
  // THE WHOLE BODY. Every key and every value the endpoint publishes, in
  // emission order, over a fixture where an open donation point sits either
  // side of a closed one and a delivery-address food bank follows them.
  it("publishes every field, for every open donation point, then the delivery addresses", async () => {
    const res = await get("/api/2/donationpoints/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(await res.text())).toEqual({
      type: "FeatureCollection",
      features: [
        // Aldi (latitude 51.01) BEFORE Tesco (51.03) although its id is
        // higher: the engine answers `is_closed = 0` from the partial
        // dp_open_latlng_idx, so the feed arrives in latitude order. Pinned,
        // not tidied -- this is the order ~5,700 live features come back in.
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.79, 51.01] },
          properties: {
            name: "Aldi Westbury",
            slug: "aldi",
            address: "12 Castle Street\r\nSP1 3TA", // fullAddressUnconditional joins with CRLF, verbatim from Django
            url: `${ORIGIN}/needs/at/westbury/donationpoint/aldi/`,
            // Off the parent food bank, through the view's LEFT JOIN --
            // foodbank_network, one of the three columns 0019 dropped from
            // the base table.
            network: "IFAN",
            telephone: null,
            web: false, // Python's `return False`, not null -- see urlWithRefDonationPoint
            foodbank: "Westbury",
            foodbank_slug: "westbury",
            foodbank_url: `${ORIGIN}/needs/at/westbury/`,
            parliamentary_constituency: "Salisbury",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.79, 51.03] },
          properties: {
            name: "Tesco Extra",
            slug: "tesco-extra",
            address: "12 Castle Street\r\nSP1 3TA",
            url: `${ORIGIN}/needs/at/salisbury/donationpoint/tesco-extra/`,
            network: "Trussell Trust",
            telephone: "01722 000000",
            // urlWithRefDonationPoint: utm_* stripped, ref= appended.
            web: "https://tesco.invalid/store/?ref=givefood.org.uk",
            foodbank: "Salisbury",
            foodbank_slug: "salisbury",
            foodbank_url: `${ORIGIN}/needs/at/salisbury/`,
            parliamentary_constituency: "Salisbury",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-2.19, 51.26] },
          properties: {
            name: "Westbury delivery address",
            slug: "westbury",
            address: "1 High Street\r\nSP1 1AA",
            url: `${ORIGIN}/needs/at/westbury/`,
            network: "IFAN",
            telephone: "01722 411900",
            web: "https://westbury.invalid/?ref=givefood.org.uk",
            foodbank: "Westbury",
            foodbank_slug: "westbury",
            foodbank_url: `${ORIGIN}/needs/at/westbury/`,
            parliamentary_constituency: "Salisbury",
          },
        },
      ],
    });
  });

  // THE POINT OF THE CHANGE, stated as a negative that cannot be satisfied
  // vacuously: none of the ~30 unread columns reach the body, AND the rows
  // that carry them still do. `not.toContain` alone would also pass if the
  // endpoint returned an empty FeatureCollection.
  it("never emits any of the columns the projection drops", async () => {
    const body = await (await get("/api/2/donationpoints/")).text();

    expect(body).toContain('"slug": "tesco-extra"');
    for (const unread of [
      "Mon-Sat 08:00-20:00", // opening_hours
      "Internal note, never published", // notes
      "ChIJdd4hrwug2EcRmSrV3Vo6llI", // place_id
      "PLUSCODECOMPOUND",
      "PLUSCODEGLOBAL",
      "Wiltshire", // county
      "Salisbury District",
      "Bemerton Ward",
      "E01032015", // lsoa
      "E02006697", // msoa
      "Tesco Stores Ltd", // company
      "STORE-4471", // store_id
      "wheelchair_accessible",
      "in_store_only",
      "is_closed",
      "2026-08-14", // modified
    ]) {
      expect(body).not.toContain(unread);
    }
  });

  it("excludes closed donation points", async () => {
    const body = await (await get("/api/2/donationpoints/")).text();

    expect(body).not.toContain("shut-wilko");
    expect(body).not.toContain("Shut Wilko");
  });

  // A donation point whose parent row is gone keeps its place in the feed
  // with null parent fields rather than vanishing -- the view's JOIN is LEFT,
  // and the projection names the joined columns, so both halves of that have
  // to survive. Seeded here rather than in seed() because it is the only case
  // that needs an orphan.
  it("keeps an orphaned donation point, with null parent fields", async () => {
    seedDonationPoint({ id: 14, foodbankId: 999, slug: "orphan", name: "Orphaned Co-op", latitude: 51.005 });

    const body = JSON.parse(await (await get("/api/2/donationpoints/")).text()) as {
      features: Array<{ properties: Record<string, unknown> }>;
    };
    const orphan = body.features.find((f) => f.properties.slug === "orphan");

    expect(orphan).toBeDefined();
    expect(orphan!.properties.foodbank).toBeNull();
    expect(orphan!.properties.network).toBeNull();
    // Current behaviour, pinned rather than wished away: the URL interpolates
    // the null slug, exactly as getAllOpenDonationPointSlugs' own orphan case
    // does for the sitemap.
    expect(orphan!.properties.foodbank_url).toBe(`${ORIGIN}/needs/at/null/`);
  });

  it("sets the week-long public cache headers and the CORS header", async () => {
    const res = await get("/api/2/donationpoints/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=604800, s-maxage=604800");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // format defaults to geojson here, unlike every other gfapi2 endpoint, and
  // any other value is a bare 400 before ApiResponse's own (wider) table is
  // reached. Pinned because the projection changes what the query returns and
  // this is the guard that says the handler's contract did not move with it.
  it("400s on any format other than geojson", async () => {
    expect((await get("/api/2/donationpoints/?format=json")).status).toBe(400);
    expect((await get("/api/2/donationpoints/?format=xml")).status).toBe(400);
    expect((await get("/api/2/donationpoints/?format=geojson")).status).toBe(200);
  });

  // THE PROJECTION ITSELF. Everything above is equally true of the `SELECT *`
  // this replaced -- that is exactly why this file was run green against it
  // first -- so a revert would be invisible without looking at the statement
  // that reached the engine.
  it("issues one projected query against the view, not SELECT *", async () => {
    await get("/api/2/donationpoints/");

    const queries = prepared.filter((sql) => sql.includes("foodbankdonationpoint"));
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).toContain("FROM foodbankdonationpoint_full WHERE is_closed = 0");
  });
});

// ===========================================================================
// GET /api/2/donationpoints/search/ -- github #48
// ===========================================================================
// Ranking and hydration are separate D1 reads, so a row deleted between them
// is ranked and then not found. The handler used to assert `!` on those
// lookups, so the miss became a TypeError and a 500 for the whole search. It
// now drops the entry -- the result Django reaches by construction, since it
// ranks and hydrates in one queryset.
describe("api2 donationpoints -- GET /api/2/donationpoints/search/ when a row vanishes mid-request", () => {
  // The list fixture carries no needs, because the list endpoint does not
  // read them. The search endpoint does, through the PARENT food bank, and
  // frozen bug B12 dereferences latest_need unguarded -- so without this every
  // search below would 500 for a reason that has nothing to do with #48.
  const prepareForSearch = (): void => {
    db.exec(`
      INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, input_method, published, created, modified)
        VALUES (700, '00000000000000000000000000000700', 1, 'Pasta', 'manual', 1, '2026-01-01 00:00:00.000000', '2026-01-01 00:00:00.000000'),
               (701, '00000000000000000000000000000701', 2, 'Rice',  'manual', 1, '2026-01-01 00:00:00.000000', '2026-01-01 00:00:00.000000');
      UPDATE foodbank SET latest_need_id = 700 WHERE id = 1;
      UPDATE foodbank SET latest_need_id = 701 WHERE id = 2;
    `);
  };

  const search = async (): Promise<Array<{ slug: string; type: string; distance_m: number }>> => {
    const res = await get("/api/2/donationpoints/search/?lat_lng=51.03,-1.79");
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{ slug: string; type: string; distance_m: number }>;
  };

  it("ranks the open donation points and excludes the closed one", async () => {
    prepareForSearch();

    const body = await search();

    expect(body.map((r) => r.slug).sort()).toEqual(["aldi", "tesco-extra"]);
    expect(JSON.stringify(body)).not.toContain("shut-wilko");
  });

  it("drops the vanished donation point and leaves the other with its own distance", async () => {
    prepareForSearch();
    const whole = await search();

    onPrepare = (sql) => {
      if (sql.includes("FROM foodbankdonationpoint_full WHERE id IN")) db.exec("DELETE FROM foodbankdonationpoint WHERE id = 11");
    };
    const afterDelete = await search();

    // A 200 with the survivor in it, not a 500 with nothing.
    expect(afterDelete.map((r) => r.slug)).toEqual(whole.map((r) => r.slug).filter((slug) => slug !== "tesco-extra"));
    for (const row of afterDelete) {
      expect(row.distance_m, row.slug).toBe(whole.find((r) => r.slug === row.slug)!.distance_m);
    }
  });
});
