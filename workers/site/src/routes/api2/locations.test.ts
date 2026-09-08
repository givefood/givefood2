import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/api2/locations.ts's list endpoint -- GET /api/2/locations/, ported
// from gfapi2/views.py's `locations`. The sibling search endpoint on the same
// router is untouched by this work and is not covered here.
//
// WHY THIS FILE EXISTS. This is the largest payload the site serves (572.8
// MB/day) and it was reading every column of every open location to emit a
// fixed list of fields -- including `boundary_geojson`, a TEXT blob that one
// production food bank alone accounts for 2.3 MB of and that NEITHER branch
// of this handler mentions. The query is now projected
// (getAllOpenLocationsFlagged): measured against production D1, 6,504,107 ->
// 3,037,895 bytes of result payload and a median 161 -> 99 ms, with rows_read
// unchanged at 3,924 so nothing about D1 billing moves.
//
// The claim that has to be defended is "no response byte moved", and the only
// honest way to defend it is to assert the WHOLE BODY of both formats. Every
// field below is read off a column that a hand-written 38-name projection
// could silently omit; a missing one does not throw, it publishes `null`.
// Two of them are the ones to watch, because they are the two that fall back
// through the LEFT JOIN to the parent food bank rather than being read
// straight off the row -- phone (phone_number -> foodbank_phone_number) and
// email (email -> foodbank_email).
//
// REAL EVERYTHING (real app, real router, real migrations), same harness as
// routes/public/sitemaps.test.ts and routes/admin/map.test.ts.

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

// A real stored boundary, big enough that its absence from the response is
// unambiguous and its presence would be obvious. This is the column the whole
// change is about.
const BOUNDARY = '{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[-1.9,51.0],[-1.8,51.0],[-1.8,51.1],[-1.9,51.0]]]}}';

function seedFoodbank(id: number, slug: string, name: string, phone: string | null, email: string): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng,
       network, charity_just_foodbank, contact_email, phone_number, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79',
       'Trussell Trust', 0, ?, ?, ?, ?, 0, 0, 0, 14, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(id, String(id).padStart(32, "a"), name, slug, email, phone, `https://${slug}.invalid/`, `https://${slug}.invalid/list/`);
}

interface LocationSeed {
  id: number;
  foodbankId: number;
  slug: string;
  name: string;
  isClosed?: 0 | 1;
  phone?: string | null;
  email?: string | null;
  boundary?: string | null;
  address?: string | null;
  postcode?: string | null;
}

function seedLocation(s: LocationSeed): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, ward, district,
       parliamentary_constituency_id, parliamentary_constituency_name, parliamentary_constituency_slug,
       mp, mp_party, mp_parl_id, is_closed, boundary_geojson, phone_number, email, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'England', '51.08,-1.80', 51.08, -1.80, 'Bemerton', 'Salisbury',
       4001, 'Salisbury', 'salisbury', 'John Glen', 'Conservative', 4051, ?, ?, ?, ?,
       '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    `${String(s.id).padStart(32, "e")}`,
    s.foodbankId,
    s.name,
    s.slug,
    s.address === undefined ? "2 Low Street" : s.address,
    s.postcode === undefined ? "SP2 2BB" : s.postcode,
    s.isClosed ?? 0,
    s.boundary ?? null,
    s.phone === undefined ? null : s.phone,
    s.email === undefined ? null : s.email,
  );
}

// Two open locations under one parent, plus a closed one in the middle of the
// id range. Location 11 carries a 2-line boundary and NO phone/email of its
// own, so it exercises both fallbacks AND the blob; location 13 carries its
// own phone and email and no boundary, so the fallbacks are proved to be
// fallbacks rather than unconditional.
function seed(): void {
  // The stored name is the bare "Salisbury": fullNameFoodbank() appends
  // " Foodbank" on the geojson branch, so a fixture already carrying the
  // suffix would have hidden that helper behind "Salisbury Foodbank Foodbank".
  seedFoodbank(1, "salisbury", "Salisbury", "01722 411900", "info@salisbury.invalid");
  seedLocation({ id: 11, foodbankId: 1, slug: "amesbury", name: "Amesbury Centre", boundary: BOUNDARY });
  seedLocation({ id: 12, foodbankId: 1, slug: "wilton", name: "Wilton Centre", isClosed: 1 });
  seedLocation({
    id: 13,
    foodbankId: 1,
    slug: "st-johns",
    name: "St John's Hall",
    phone: "01722 000111",
    email: "hall@salisbury.invalid",
    boundary: null,
  });
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

describe("api2 locations -- GET /api/2/locations/", () => {
  // THE WHOLE BODY, json. Every key and every value the endpoint publishes,
  // over a fixture where a location with a boundary sits next to one without.
  it("publishes every field, for every open location, with the parent fallbacks intact", async () => {
    const res = await get("/api/2/locations/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(await res.text())).toEqual([
      {
        id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeee11",
        name: "Amesbury Centre",
        slug: "amesbury",
        // No phone/email of its own -> the parent food bank's, through the
        // view's LEFT JOIN. foodbank_phone_number and foodbank_email are two
        // of the 38 projected columns; lose either and this goes null.
        phone: "01722 411900",
        email: "info@salisbury.invalid",
        address: "2 Low Street\r\nSP2 2BB", // fullAddressNullable joins with CRLF, verbatim from Django
        postcode: "SP2 2BB",
        lat_lng: "51.08,-1.80",
        urls: { html: `${ORIGIN}/needs/at/salisbury/amesbury/` },
        foodbank: {
          name: "Salisbury",
          slug: "salisbury",
          network: "Trussell Trust",
          urls: {
            self: `${ORIGIN}/api/2/foodbank/salisbury/`,
            html: `${ORIGIN}/needs/at/salisbury/`,
          },
        },
        politics: {
          parliamentary_constituency: "Salisbury",
          mp: "John Glen",
          mp_party: "Conservative",
          mp_parl_id: 4051,
          ward: "Bemerton",
          district: "Salisbury",
          urls: {
            self: `${ORIGIN}/api/2/constituency/salisbury/`,
            html: `${ORIGIN}/needs/in/constituency/salisbury/`,
          },
        },
      },
      {
        id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeee13",
        name: "St John's Hall",
        slug: "st-johns",
        // Its own, NOT the parent's -- so the two fields above are a genuine
        // fallback rather than an unconditional read of the parent.
        phone: "01722 000111",
        email: "hall@salisbury.invalid",
        address: "2 Low Street\r\nSP2 2BB", // fullAddressNullable joins with CRLF, verbatim from Django
        postcode: "SP2 2BB",
        lat_lng: "51.08,-1.80",
        urls: { html: `${ORIGIN}/needs/at/salisbury/st-johns/` },
        foodbank: {
          name: "Salisbury",
          slug: "salisbury",
          network: "Trussell Trust",
          urls: {
            self: `${ORIGIN}/api/2/foodbank/salisbury/`,
            html: `${ORIGIN}/needs/at/salisbury/`,
          },
        },
        politics: {
          parliamentary_constituency: "Salisbury",
          mp: "John Glen",
          mp_party: "Conservative",
          mp_parl_id: 4051,
          ward: "Bemerton",
          district: "Salisbury",
          urls: {
            self: `${ORIGIN}/api/2/constituency/salisbury/`,
            html: `${ORIGIN}/needs/in/constituency/salisbury/`,
          },
        },
      },
    ]);
  });

  // THE POINT OF THE CHANGE, stated as a negative that cannot be satisfied
  // vacuously: the boundary is not in the body, AND the location that owns it
  // still is. `not.toContain` on its own would also pass if the endpoint
  // returned nothing at all.
  it("never emits the boundary blob, while still emitting the location that has one", async () => {
    const body = await (await get("/api/2/locations/")).text();

    expect(body).toContain('"slug": "amesbury"');
    expect(body).not.toContain("boundary_geojson");
    expect(body).not.toContain("Polygon");
    expect(body).not.toContain("has_boundary");
  });

  // The geojson branch names its own, different field list off the same row,
  // so it needs its own whole-body assertion rather than sharing the one
  // above. Note `name` here is the COMBINED "Location, Foodbank" form.
  it("publishes the geojson branch's own field list, unchanged", async () => {
    const res = await get("/api/2/locations/?format=geojson");

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.8, 51.08] },
          properties: {
            name: "Amesbury Centre, Salisbury Foodbank", // fullNameLocation: the location, then fullNameFoodbank(parent)
            slug: "amesbury",
            address: "2 Low Street\r\nSP2 2BB", // fullAddressNullable joins with CRLF, verbatim from Django
            url: `${ORIGIN}/needs/at/salisbury/amesbury/`,
            network: "Trussell Trust",
            email: "info@salisbury.invalid",
            telephone: "01722 411900",
            foodbank: "Salisbury",
            foodbank_slug: "salisbury",
            foodbank_url: `${ORIGIN}/needs/at/salisbury/`,
            parliamentary_constituency: "Salisbury",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.8, 51.08] },
          properties: {
            name: "St John's Hall, Salisbury Foodbank",
            slug: "st-johns",
            address: "2 Low Street\r\nSP2 2BB", // fullAddressNullable joins with CRLF, verbatim from Django
            url: `${ORIGIN}/needs/at/salisbury/st-johns/`,
            network: "Trussell Trust",
            email: "hall@salisbury.invalid",
            telephone: "01722 000111",
            foodbank: "Salisbury",
            foodbank_slug: "salisbury",
            foodbank_url: `${ORIGIN}/needs/at/salisbury/`,
            parliamentary_constituency: "Salisbury",
          },
        },
      ],
    });
  });

  it("excludes closed locations", async () => {
    const body = await (await get("/api/2/locations/")).text();

    expect(body).not.toContain("wilton");
  });

  // THE PROJECTION. Everything above is equally true of the `SELECT *` this
  // replaced, so a revert would be invisible without looking at the statement
  // that reached the engine.
  it("issues one projected query, not SELECT *", async () => {
    await get("/api/2/locations/");

    const queries = prepared.filter((sql) => sql.includes("foodbanklocation"));
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).toContain("(boundary_geojson IS NOT NULL AND boundary_geojson != '') AS has_boundary");
  });
});

// ===========================================================================
// GET /api/2/locations/search/ -- github #48
// ===========================================================================
// The search endpoint on this router had no test of its own; this covers the
// one behaviour #48 changed. Ranking and hydration are separate D1 reads, so
// a row deleted between them is ranked and then not found. The handler used
// to assert `!` on those lookups, which turned the miss into a TypeError and
// a 500 for the WHOLE search. It now drops the entry, which is the result
// Django reaches by construction -- it ranks and hydrates in one queryset, so
// a row deleted a moment earlier simply is not a candidate.
describe("api2 locations -- GET /api/2/locations/search/ when a row vanishes mid-request", () => {
  // The list fixture carries no coordinates and no needs, because the list
  // endpoint needs neither. Both are added here rather than in seed() so the
  // other suites keep the narrow fixture they were written against.
  //
  // The need matters for a reason worth naming: frozen bug B12 dereferences
  // latest_need unguarded, so a ranked row without one 500s -- which would
  // mask exactly the distinction this test is drawing.
  const prepareForSearch = (): void => {
    db.exec(`
      INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, input_method, published, created, modified)
        VALUES (700, '00000000000000000000000000000700', 1, 'Pasta', 'manual', 1, '2026-01-01 00:00:00.000000', '2026-01-01 00:00:00.000000');
      UPDATE foodbank SET latitude = 51.07, longitude = -1.79, latest_need_id = 700 WHERE id = 1;
      UPDATE foodbanklocation SET latitude = 51.08, longitude = -1.80 WHERE id = 11;
      UPDATE foodbanklocation SET latitude = 51.09, longitude = -1.81 WHERE id = 13;
    `);
  };

  const search = async (): Promise<Array<{ slug: string; type: string; distance_m: number }>> => {
    const res = await get("/api/2/locations/search/?lat_lng=51.07,-1.79");
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{ slug: string; type: string; distance_m: number }>;
  };

  it("ranks the food bank and both open locations", async () => {
    prepareForSearch();

    const body = await search();

    // The closed location (12) must not be here, and both open ones must be.
    expect(body.map((r) => r.slug).sort()).toEqual(["amesbury", "salisbury", "st-johns"]);
    expect(body.map((r) => r.distance_m)).toEqual([...body.map((r) => r.distance_m)].sort((a, b) => a - b));
  });

  it("drops the vanished location and leaves the others with their own distances", async () => {
    prepareForSearch();
    const whole = await search();

    onPrepare = (sql) => {
      if (sql.includes("FROM foodbanklocation_full WHERE id IN")) db.exec("DELETE FROM foodbanklocation WHERE id = 11");
    };
    const afterDelete = await search();

    // A 200 with two entries, not a 500 with none.
    expect(afterDelete.map((r) => r.slug)).toEqual(whole.map((r) => r.slug).filter((slug) => slug !== "amesbury"));
    for (const row of afterDelete) {
      expect(row.distance_m, row.slug).toBe(whole.find((r) => r.slug === row.slug)!.distance_m);
    }
  });
});
