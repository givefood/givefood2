import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/api2/constituencies.ts -- the two constituency endpoints of gfapi2,
// GET /constituencies/ and GET /constituency/<slug>/, ported from
// gfapi2/views.py:834-915 (`constituencies` and `constituency`) plus
// givefood/models/political.py's `ParliamentaryConstituency.foodbanks()` and
// givefood/utils/geo.py:180's `geojson_dict()`. Both are dual-mounted at
// /api/2/* and /api/*.
//
// WHY THIS FILE EXISTS. Every failure mode of these two endpoints is a 200
// with a well-formed document in it. The list endpoint has no WHERE clause,
// no ORDER BY and no pagination, so adding any of the three would still
// answer 200 with plausible JSON; the detail endpoint concatenates two
// unsorted, unmerged lists whose entries are indistinguishable in the
// published shape, so losing a list, sorting one, or resolving a location's
// parent to the wrong food bank all publish the same field names with
// different values. Nothing below asserts a status and stops: the json and
// geojson bodies are asserted WHOLE, field for field, and the exclusions are
// seeded rather than assumed.
//
// REAL EVERYTHING. The real root app from src/index.ts (so these run at the
// real mount points, through the real middleware stack, and reach the real
// 404 and 500 pages), the real migrations via schema.testkit's MIGRATIONS_SQL,
// real SQLite through node:sqlite behind the real packages/db queries, and the
// real @givefood/serialise formatters for xml/yaml. Nothing here leaves the
// machine, so nothing is mocked.
//
// PARITY CLAIMS BELOW WERE RUN, NOT REASONED. The one place this port and
// Django can disagree on input handling is a REPEATED ?format= parameter, and
// the Django half of that comparison came out of a Python process on this
// machine (Django 5.2.6, `QueryDict("format=xml&format=yaml").get("format")`
// -> "yaml"). See the "repeated ?format=" test. Everything else claimed about
// Django here is quoted structure from the two source files named above, read
// at /Users/jasoncartwright/Sites/foodcharity.
//
// MUTATION-TESTED (TESTING.md's convention), in an rsync'd copy of the tree
// OUTSIDE the repo -- never by editing a source file in place. 41 mutants
// across the handler, packages/db's constituencies.ts and lib/apiResponse.ts,
// each applied on its own and this file re-run against it; 38 killed. A
// sample, each one actually run rather than imagined:
//   - the two entry lists concatenated the other way round, sorted by name,
//     or one of them dropped -- 4
//   - the id union losing its Set, losing the location parents, or reverting
//     to two sequential getFoodbanksByIds calls -- 3
//   - a location's needs/homepage read off the location instead of its parent,
//     and its gf_url built from its own slug (i.e. B3 spread into geojson) -- 3
//   - B3 "fixed" in the json branch by taking html from gf_url -- 1
//   - geojson coordinates emitted lat-first, read from the wrong halves of
//     lat_lng, or left as strings -- 3
//   - the boundary wrapped as a Feature, unshifted to the front, omitted, or
//     its NULL "fixed" into {} -- 4
//   - parseBoundaryGeojson losing its trim or its trailing-comma strip -- 2
//   - `format !== "geojson"` narrowed to `=== "json"` and inverted -- 2
//   - `?? "json"` loosened to `|| "json"` -- 1
//   - the two max-ages swapped, and the list passed the SINGULAR object name
//     (which would let it answer geojson) -- 3
//   - SITE_DOMAIN derived from the request -- 1
//   - a CORS header added to apiResponse's 400 -- 1
//   - ORDER BY name added to the list query, and that query narrowed to three
//     columns -- 2
//   - is_closed dropped from either half of the batch, the location projection
//     reverted to SELECT *, the batch unrolled into sequential awaits, and its
//     two results read in the wrong order -- 5
//
// THE THREE SURVIVORS ARE THE SAME BUG AND IT IS RECORDED, NOT CHASED:
// nulling `phone_number`, `contact_email` or `facebook_page` on a location
// entry changes nothing, because NEITHER output format publishes them. See
// "publishes none of the contact fields it computes" -- they are computed for
// every entry (phoneOrFoodbankPhone / emailOrFoodbankEmail included) and
// discarded, so no test written against these two endpoints can reach them.
//
// FROZEN BUGS PINNED HERE, NOT FIXED (PLAN.md §7.3, and the module's own
// comments):
//   B3  -- a location entry's `slug` is reused to build /api/2/foodbank/<slug>/
//          and /needs/at/<slug>/, neither of which exists. Proved by fetching
//          the URLs the endpoint publishes and asserting the 404, rather than
//          by asserting the string alone.
//   B12 -- `needs` is dereferenced unguarded, so a food bank with no
//          latest_need 500s the whole constituency.
//   The unguarded parent lookup: a location whose foodbank_id resolves to no
//   row 500s the same way. There are no FOREIGN KEY declarations anywhere in
//   packages/db/migrations, so that is a reachable state in production, not a
//   fixture artefact.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// The D1DatabaseSession surface packages/db uses, over node:sqlite -- the same
// shim as routes/api2/foodbanks.test.ts and routes/api2/locations.test.ts, for
// the same reason: D1 is async where node:sqlite is synchronous, and that is
// the only difference that matters, the SQL text, the binding and the NULL
// semantics being SQLite's on both sides.
//
// `prepared` records the SQL that reached the engine and `roundTrips` records
// the WAITS (a batch of N statements is one wait, a lone all()/first() is one
// wait). Both are needed and neither can stand in for the other here: this
// handler's documented cost story is "one getFoodbanksByIds call covering BOTH
// the organisation ids and the location parents' ids, instead of two
// sequential calls" (constituencies.ts:60-66), and a body assertion cannot see
// the difference between one call and two.
//
// batch() runs its statements IN ORDER and returns one result per input, in
// that order -- the contract getFoodbanksForConstituency indexes straight into.
function d1Session(db: DatabaseSync, prepared: string[], roundTrips: string[][]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      roundTrips.push([sql]);
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      roundTrips.push([sql]);
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      roundTrips.push([sql]);
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      prepared.push(sql);
      return statement(sql, []);
    },
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) => {
      roundTrips.push(statements.map((s) => s.sql));
      return statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} }));
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: string[];
let roundTrips: string[][];

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared, roundTrips) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();
const json = async (path: string): Promise<unknown> => JSON.parse(await body(path)) as unknown;

// ===========================================================================
// SEEDS
// ===========================================================================

// Django's own timestamp format, from 0022_normalise_timestamps.sql: six
// fractional digits, space separator, no offset. Neither endpoint publishes a
// timestamp, but the columns are NOT NULL and a fixture that invented an
// ISO-with-Z shape here would be quietly untrue to the database.
const CREATED = "2020-01-24 16:30:23.173268";
const MODIFIED = "2026-08-14 09:15:00.000000";

// Real stored boundary shapes. Production ones run to ~1.6 MB; nothing here
// needs the size, only that a leak into a body where it does not belong would
// be unambiguous, and that the two constituencies' boundaries differ so
// "appends the RIGHT constituency's boundary" is answerable.
const SALISBURY_BOUNDARY = '{"type":"Polygon","coordinates":[[[-1.9,51.0],[-1.7,51.0],[-1.7,51.1],[-1.9,51.0]]]}';
const PLAIN_BOUNDARY = '{"type":"Polygon","coordinates":[[[-0.8,51.2],[-0.7,51.2],[-0.7,51.3],[-0.8,51.2]]]}';

// The stored form Salisbury actually gets: leading/trailing whitespace AND one
// trailing comma, which is the exact shape geojson_dict() (geo.py:180-188)
// strips before json.loads(). parseBoundaryGeojson reproduces it; without the
// strip this row's geojson response is a 500.
const SALISBURY_BOUNDARY_STORED = `\n  ${SALISBURY_BOUNDARY},\n  `;

const uuidFor = (prefix: string, id: number): string => (prefix + String(id).padStart(31, "0")).slice(0, 32);

interface ConstituencySeed {
  id: number;
  slug: string;
  name: string | null;
  country: string | null;
  boundary: string | null;
}

function seedConstituency(c: ConstituencySeed): void {
  db.prepare(
    `INSERT INTO parliamentaryconstituency
       (id, name, slug, country, mp, mp_party, mp_parl_id, mp_display_name, email,
        centroid, latitude, longitude, boundary_geojson, pcon24cd)
     VALUES (?, ?, ?, ?, 'John Glen', 'Conservative', ?, 'Mr John Glen MP', ?,
        '51.06,-1.79', 51.06, -1.79, ?, ?)`,
  ).run(c.id, c.name, c.slug, c.country, 4000 + c.id, `${c.slug}@parliament.invalid`, c.boundary, `E140007${c.id}`);
}

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  constituencyId: number;
  latLng: string;
  latestNeedId: number | null;
  isClosed?: 0 | 1;
}

// Every column with a NOT NULL constraint, plus the three the entry builder
// computes and NEITHER output format publishes (phone_number, contact_email,
// facebook_page -- see the "dead fields" test). They carry recognisable values
// so a body that starts leaking one says so by name.
function seedFoodbank(f: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, uuid, name, slug, address, postcode, country, lat_lng, latitude, longitude,
        network, charity_number, charity_just_foodbank, facebook_page, contact_email, phone_number,
        url, shopping_list_url, parliamentary_constituency_id, parliamentary_constituency_name,
        parliamentary_constituency_slug, mp, mp_party, mp_parl_id,
        address_is_administrative, is_closed, no_locations, days_between_needs,
        latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', ?, 51.07, -1.79,
        'Trussell Trust', '1130136', 0, ?, ?, ?,
        ?, ?, ?, 'Seeded Constituency',
        'seeded-constituency', 'John Glen', 'Conservative', 4051,
        0, ?, 0, 14,
        ?, ?, ?)`,
  ).run(
    f.id,
    uuidFor("f", f.id),
    f.name,
    f.slug,
    f.latLng,
    `https://facebook.invalid/${f.slug}`,
    `info@${f.slug}.invalid`,
    `01722 4119${String(f.id).padStart(2, "0")}`,
    `https://${f.slug}.invalid/`,
    `https://${f.slug}.invalid/list/`,
    f.constituencyId,
    f.isClosed ?? 0,
    f.latestNeedId,
    CREATED,
    MODIFIED,
  );
}

interface LocationSeed {
  id: number;
  foodbankId: number;
  slug: string;
  name: string;
  constituencyId: number;
  latLng: string;
  isClosed?: 0 | 1;
  phone?: string | null;
  email?: string | null;
}

// boundary_geojson is filled on every location for the same reason the food
// bank rows carry a facebook_page: it is a column the narrow projection in
// getFoodbanksForConstituency deliberately does not read, and a revert to
// SELECT * would put a 2 MB blob back on the wire for every location in the
// constituency without changing one byte of the response.
function seedLocation(l: LocationSeed): void {
  db.prepare(
    `INSERT INTO foodbanklocation
       (id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng, latitude, longitude,
        ward, district, parliamentary_constituency_id, parliamentary_constituency_name,
        parliamentary_constituency_slug, mp, mp_party, mp_parl_id,
        is_closed, is_donation_point, is_mobile, boundary_geojson, phone_number, email, modified, edited)
     VALUES (?, ?, ?, ?, ?, '2 Low Street', 'SP2 2BB', 'England', ?, 51.08, -1.80,
        'Bemerton', 'Salisbury', ?, 'Seeded Constituency',
        'seeded-constituency', 'John Glen', 'Conservative', 4051,
        ?, 0, 0, ?, ?, ?, ?, ?)`,
  ).run(
    l.id,
    uuidFor("l", l.id),
    l.foodbankId,
    l.name,
    l.slug,
    l.latLng,
    l.constituencyId,
    l.isClosed ?? 0,
    PLAIN_BOUNDARY,
    l.phone === undefined ? null : l.phone,
    l.email === undefined ? null : l.email,
    MODIFIED,
    MODIFIED,
  );
}

function seedNeed(id: number, foodbankId: number, changeText: string, excess: string | null): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text,
       published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 1, 'scrape', ?, ?)`,
  ).run(id, uuidFor("n", id), foodbankId, changeText, excess, CREATED, MODIFIED);
}

// Six constituencies, each one earning its place:
//
//   41 salisbury      the main fixture -- two open food banks, three open
//                     locations, and every exclusion seeded around them. Its
//                     boundary is stored with the whitespace and trailing
//                     comma geojson_dict() strips.
//   42 aldershot      holds the parent food bank of one of Salisbury's
//                     locations, so "resolve a location's parent" is a real
//                     cross-constituency lookup and not a no-op, and holds a
//                     location of its own so Salisbury's list can be shown to
//                     exclude it.
//   43 empty-vale     no food banks and no locations at all.
//   44 (name NULL)    one open food bank with NO latest_need -> frozen bug B12.
//                     Its NULL name also pins that the list endpoint publishes
//                     the column raw rather than coalescing it to "".
//   45 ynys-mon       boundary_geojson IS NULL -> the geojson branch 500s while
//                     the json branch still answers 200, so the crash is
//                     provably the boundary and not the food bank. Non-ASCII
//                     name and a NULL country, both published raw.
//   46 orphan-heath   one open location whose foodbank_id resolves to no row.
//
// INSERTION ORDER IS NOT NAME ORDER (Salisbury, Aldershot, Empty Vale, NULL,
// Ynys Môn, Orphan Heath). The list endpoint has no ORDER BY -- deliberately,
// matching `ParliamentaryConstituency.objects.all()` -- and seeding
// alphabetically would make an added `ORDER BY name` invisible.
function seed(): void {
  seedConstituency({ id: 41, slug: "salisbury", name: "Salisbury", country: "England", boundary: SALISBURY_BOUNDARY_STORED });
  seedConstituency({ id: 42, slug: "aldershot", name: "Aldershot", country: "England", boundary: PLAIN_BOUNDARY });
  seedConstituency({ id: 43, slug: "empty-vale", name: "Empty Vale", country: "Scotland", boundary: PLAIN_BOUNDARY });
  seedConstituency({ id: 44, slug: "needless-heath", name: null, country: "Wales", boundary: PLAIN_BOUNDARY });
  seedConstituency({ id: 45, slug: "ynys-mon", name: "Ynys Môn", country: null, boundary: null });
  seedConstituency({ id: 46, slug: "orphan-heath", name: "Orphan Heath", country: "England", boundary: PLAIN_BOUNDARY });

  // Salisbury's own two, seeded Wilton-then-Amesbury so rowid order and
  // alphabetical order disagree. `foodbanks()` sorts neither list, and a
  // fixture seeded alphabetically cannot tell the two apart.
  seedFoodbank({ id: 1, slug: "wilton", name: "Wilton Foodbank", constituencyId: 41, latLng: "51.08,-1.86", latestNeedId: 500 });
  seedFoodbank({ id: 2, slug: "amesbury", name: "Amesbury Foodbank", constituencyId: 41, latLng: "51.17,-1.78", latestNeedId: 501 });

  // Closed, in Salisbury, WITH a need -- so it can only be missing from the
  // organisation list because of `is_closed = 0`, not because dereferencing it
  // would have thrown. Its open location below still drags its data into the
  // response, which is Django's behaviour too (location_obj() filters the
  // LOCATION's is_closed, never the parent's).
  seedFoodbank({ id: 3, slug: "closed-fb", name: "Closed Foodbank", constituencyId: 41, latLng: "51.05,-1.70", latestNeedId: 502, isClosed: 1 });

  // Aldershot's, and the parent of Salisbury's "Bemerton Room" location.
  seedFoodbank({ id: 4, slug: "aldershot-fb", name: "Aldershot Foodbank", constituencyId: 42, latLng: "51.2481,-0.7586", latestNeedId: 503 });

  seedFoodbank({ id: 5, slug: "needless-fb", name: "Needless Foodbank", constituencyId: 44, latLng: "51.50,-3.20", latestNeedId: null });
  seedFoodbank({ id: 6, slug: "ynys-mon-fb", name: "Ynys Môn Foodbank", constituencyId: 45, latLng: "53.28,-4.35", latestNeedId: 504 });

  // Salisbury's locations, again seeded out of alphabetical order.
  seedLocation({ id: 11, foodbankId: 1, slug: "tidworth-hall", name: "Tidworth Hall", constituencyId: 41, latLng: "51.2400,-1.6700" });
  seedLocation({
    id: 12,
    foodbankId: 4, // parent lives in ALDERSHOT, not Salisbury
    slug: "bemerton-room",
    name: "Bemerton Room",
    constituencyId: 41,
    latLng: "51.0700,-1.8000",
    phone: "01980 000111",
    email: "bemerton@example.invalid",
  });
  seedLocation({ id: 13, foodbankId: 3, slug: "closed-parent-room", name: "Closed Parent Room", constituencyId: 41, latLng: "51.0600,-1.7100" });

  // Excluded by `is_closed = 0` on the location itself.
  seedLocation({ id: 14, foodbankId: 1, slug: "shut-annexe", name: "Shut Annexe", constituencyId: 41, latLng: "51.09,-1.75", isClosed: 1 });

  // In Aldershot, under a Salisbury parent -- the mirror image of Bemerton
  // Room, so "filtered by the LOCATION's constituency, not its parent's" is
  // proved in both directions.
  seedLocation({ id: 15, foodbankId: 1, slug: "farnborough-room", name: "Farnborough Room", constituencyId: 42, latLng: "51.29,-0.75" });

  // No foodbank row has id 999. There are no FOREIGN KEY declarations in any
  // migration, so D1 permits exactly this.
  seedLocation({ id: 16, foodbankId: 999, slug: "orphan-room", name: "Orphan Room", constituencyId: 46, latLng: "51.40,-1.40" });

  seedNeed(500, 1, "Tinned tomatoes\r\nUHT milk", "Baked beans");
  seedNeed(501, 2, "Nothing", null); // excess NULL -- published as JSON null, not ""
  seedNeed(502, 3, "Cereal\r\nLong life juice", "Pasta");
  seedNeed(503, 4, "Pasta\r\nRice", "Christmas puddings");
  seedNeed(504, 6, "Tinned fish", null);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seed();
  prepared = [];
  roundTrips = [];
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// GET /constituencies/
// ===========================================================================

describe("api2 constituencies -- GET /api/2/constituencies/", () => {
  // THE WHOLE BODY. Five values per row, all six rows, in the order the
  // database hands them back. Both URLs are hardcoded to
  // https://www.givefood.org.uk in the source and are NOT derived from the
  // request (constituencies.ts:22-25), which is why they are written out
  // rather than built from ORIGIN's request host.
  it("publishes every constituency, with both hardcoded URLs, in database order", async () => {
    const res = await get("/api/2/constituencies/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(await res.text())).toEqual([
      {
        name: "Salisbury",
        slug: "salisbury",
        country: "England",
        urls: {
          self: "https://www.givefood.org.uk/api/2/constituency/salisbury/",
          html: "https://www.givefood.org.uk/needs/in/constituency/salisbury/",
        },
      },
      {
        name: "Aldershot",
        slug: "aldershot",
        country: "England",
        urls: {
          self: "https://www.givefood.org.uk/api/2/constituency/aldershot/",
          html: "https://www.givefood.org.uk/needs/in/constituency/aldershot/",
        },
      },
      {
        // No food banks and no locations anywhere in it. The list endpoint
        // applies no filter of any kind, so it is published like any other.
        name: "Empty Vale",
        slug: "empty-vale",
        country: "Scotland",
        urls: {
          self: "https://www.givefood.org.uk/api/2/constituency/empty-vale/",
          html: "https://www.givefood.org.uk/needs/in/constituency/empty-vale/",
        },
      },
      {
        // `name` and `country` are both nullable columns and both are
        // published RAW -- a `?? ""` or a `|| "Unknown"` anywhere on this path
        // would change the type on the wire for a consumer.
        name: null,
        slug: "needless-heath",
        country: "Wales",
        urls: {
          self: "https://www.givefood.org.uk/api/2/constituency/needless-heath/",
          html: "https://www.givefood.org.uk/needs/in/constituency/needless-heath/",
        },
      },
      {
        name: "Ynys Môn",
        slug: "ynys-mon",
        country: null,
        urls: {
          self: "https://www.givefood.org.uk/api/2/constituency/ynys-mon/",
          html: "https://www.givefood.org.uk/needs/in/constituency/ynys-mon/",
        },
      },
      {
        name: "Orphan Heath",
        slug: "orphan-heath",
        country: "England",
        urls: {
          self: "https://www.givefood.org.uk/api/2/constituency/orphan-heath/",
          html: "https://www.givefood.org.uk/needs/in/constituency/orphan-heath/",
        },
      },
    ]);
  });

  // The order above is only load-bearing while it DIFFERS from every order
  // someone might "tidy" the query into. Said out loud so it cannot rot into a
  // fixture that happens to be alphabetical.
  it("is seeded so that database order and name order genuinely disagree", async () => {
    const rows = (await json("/api/2/constituencies/")) as Array<{ name: string | null; slug: string }>;
    const slugs = rows.map((r) => r.slug);

    expect(slugs).toEqual(["salisbury", "aldershot", "empty-vale", "needless-heath", "ynys-mon", "orphan-heath"]);
    expect(slugs).not.toEqual([...slugs].sort());
    // Nor is it name order: Aldershot would lead, and the NULL name would sort
    // first of all in SQLite.
    expect(rows.map((r) => r.name)).not.toEqual([...rows.map((r) => r.name)].sort());
  });

  // `ParliamentaryConstituency.objects.all()`, verbatim: no WHERE, no ORDER BY,
  // no LIMIT. All three are things a well-meaning change would add, and none of
  // them would fail any body assertion above once the fixture had been
  // "corrected" to match.
  it("issues exactly one unfiltered, unordered, unlimited SELECT", async () => {
    await get("/api/2/constituencies/");

    expect(prepared).toEqual(["SELECT * FROM parliamentaryconstituency"]);
    expect(roundTrips).toHaveLength(1);
  });

  // SUSPECT, PINNED NOT FIXED. That statement is `SELECT *`, so it pulls
  // boundary_geojson for every constituency -- ~1.6 MB each for the largest,
  // 650 rows in production -- to publish three columns, none of which is the
  // blob. packages/db/src/constituencies.ts:34-42 states the hard rule
  // ("nothing in the codebase issues SELECT * on parliamentaryconstituency")
  // and names getAllConstituencies as the reason the narrow variants exist;
  // this endpoint is its only caller. Asserting what it DOES today, so that
  // narrowing it later is a deliberate, visible change.
  it("fetches the boundary blobs it never publishes, and publishes none of them", async () => {
    const text = await body("/api/2/constituencies/");

    expect(prepared[0]).toBe("SELECT * FROM parliamentaryconstituency");
    expect(text).toContain('"slug": "salisbury"');
    expect(text).not.toContain("boundary");
    expect(text).not.toContain("Polygon");
    expect(text).not.toContain("centroid");
    expect(text).not.toContain("mp_parl_id");
  });

  it("caches for a day and allows any origin", async () => {
    const res = await get("/api/2/constituencies/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400, s-maxage=86400");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // gfapi2/func.py's ALLOWED_FORMATS gives `constituencies` the STD set only.
  // geojson is allowed for `constituency` (singular) and refused here, and
  // getting the two tables the wrong way round is invisible to any test that
  // only ever asks for json.
  it("refuses geojson, which its singular sibling allows", async () => {
    const list = await get("/api/2/constituencies/?format=geojson");
    const detail = await get("/api/2/constituency/salisbury/?format=geojson");

    expect(list.status).toBe(400);
    expect(detail.status).toBe(200);
  });

  // The 400 branch returns BEFORE the CORS header is set (apiResponse), which
  // PLAN.md §7.7.2 records as a real asymmetry to reproduce rather than fix: a
  // browser client sees an opaque CORS failure, not a clean 400.
  it("answers a bad format with an empty, uncached, CORS-less 400", async () => {
    for (const format of ["geojson", "csv", "JSON", "", "html"]) {
      const res = await get(`/api/2/constituencies/?format=${format}`);

      expect(res.status, format).toBe(400);
      expect(await res.text(), format).toBe("");
      expect(res.headers.get("Access-Control-Allow-Origin"), format).toBeNull();
      expect(res.headers.get("Cache-Control"), format).toBeNull();
    }
  });

  // dicttoxml's shape: the root is the object name and each item is wrapped in
  // its singular (xml.ts's SINGULAR table). The NULL country self-closes rather
  // than rendering the literal text "null", which is the js2xmlparser quirk
  // xml.ts's Absent handling exists for -- worth an assertion here because this
  // is one of the few endpoints with a genuinely NULL column in its output.
  it("renders xml as <constituencies><constituency>, with NULLs self-closed", async () => {
    const res = await get("/api/2/constituencies/?format=xml");
    const text = await res.text();

    expect(res.headers.get("Content-Type")).toBe("text/xml");
    expect(text.startsWith("<?xml version='1.0'?>\n<constituencies>")).toBe(true);
    expect(text.match(/<constituency>/g)).toHaveLength(6);
    expect(text).toContain(
      [
        "    <constituency>",
        "        <name>Ynys Môn</name>",
        "        <slug>ynys-mon</slug>",
        "        <country/>",
        "        <urls>",
        "            <self>https://www.givefood.org.uk/api/2/constituency/ynys-mon/</self>",
        "            <html>https://www.givefood.org.uk/needs/in/constituency/ynys-mon/</html>",
        "        </urls>",
        "    </constituency>",
      ].join("\n"),
    );
  });

  // js-yaml with sortKeys, so the key order is alphabetical (country, name,
  // slug, urls) and NOT the insertion order the json body has. The NULL is a
  // bare `null`.
  it("renders yaml with sorted keys", async () => {
    const res = await get("/api/2/constituencies/?format=yaml");
    const text = await res.text();

    expect(res.headers.get("Content-Type")).toBe("text/yaml");
    expect(text.startsWith("- country: England\n  name: Salisbury\n  slug: salisbury\n  urls:\n")).toBe(true);
    expect(text).toContain("- country: null\n  name: Ynys Môn\n  slug: ynys-mon\n");
  });

  // gfapi2 is mounted at BOTH /api/2/* and /api/* (PLAN.md §10.2.2), and every
  // URL in the body is hardcoded to the /api/2 form regardless of which mount
  // served it -- the Python source does not derive them from the request path
  // either.
  it("serves an identical body from the bare /api mount", async () => {
    expect(await body("/api/constituencies/")).toBe(await body("/api/2/constituencies/"));
  });

  // EVERY URL IN BOTH BODIES IS A HARDCODED www.givefood.org.uk, not the
  // request's own origin (constituencies.ts:22-25, "not derived from the
  // request (see task point 12)"). Asked from a DIFFERENT host, because every
  // other request in this file arrives at www.givefood.org.uk and so cannot
  // tell a hardcoded domain from a derived one -- a `new URL(c.req.url).origin`
  // would pass all of them and then publish beta URLs off the beta deployment.
  it("hardcodes www.givefood.org.uk, whatever host the request arrived on", async () => {
    const beta = await app.fetch(new Request("https://beta.givefood.org.uk/api/2/constituencies/"), env(), execCtx);
    const detail = await app.fetch(new Request("https://beta.givefood.org.uk/api/2/constituency/salisbury/"), env(), execCtx);

    expect(beta.status).toBe(200);
    expect(await beta.text()).toBe(await body("/api/2/constituencies/"));
    expect(detail.status).toBe(200);
    expect(await detail.text()).toBe(await body("/api/2/constituency/salisbury/"));
  });

  // Django's APPEND_SLASH, reproduced by index.ts's notFound handler: the route
  // is registered WITH its trailing slash, so the slashless form must redirect
  // rather than 404.
  it("301s the slashless form", async () => {
    const res = await get("/api/2/constituencies");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/api/2/constituencies/`);
  });
});

// ===========================================================================
// GET /constituency/<slug>/  -- json
// ===========================================================================

// The four entries Salisbury must publish, in the one order the source
// produces: `foodbanks()` builds the organisation list, then the location
// list, then concatenates them (political.py:99-133). Neither sub-list is
// sorted and the two are never merged -- PLAN.md §7.3's frozen bug B3.
const SALISBURY_ENTRY_NAMES = ["Wilton Foodbank", "Amesbury Foodbank", "Tidworth Hall", "Bemerton Room", "Closed Parent Room"];

describe("api2 constituency -- GET /api/2/constituency/<slug>/", () => {
  // THE WHOLE BODY, json. Every key and every value, over a fixture where an
  // organisation entry, a location whose parent is in the SAME constituency, a
  // location whose parent is in ANOTHER one, and a location whose parent is
  // CLOSED all sit next to each other. Each `needs`/`excess` pair below comes
  // off a different food bank's latest need, so a parent resolved to the wrong
  // row shows up as text and not as a shape change.
  it("publishes organisations then locations, unsorted, with each entry's needs resolved", async () => {
    const res = await get("/api/2/constituency/salisbury/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(await res.text())).toEqual({
      name: "Salisbury",
      slug: "salisbury",
      foodbanks: [
        {
          name: "Wilton Foodbank",
          slug: "wilton",
          lat_lng: "51.08,-1.86",
          needs: "Tinned tomatoes\r\nUHT milk",
          excess: "Baked beans",
          urls: {
            self: "https://www.givefood.org.uk/api/2/foodbank/wilton/",
            html: "https://www.givefood.org.uk/needs/at/wilton/",
            homepage: "https://wilton.invalid/",
            shopping_list: "https://wilton.invalid/list/",
            map: "https://www.givefood.org.uk/needs/at/wilton/map.png",
          },
        },
        {
          name: "Amesbury Foodbank",
          slug: "amesbury",
          lat_lng: "51.17,-1.78",
          needs: "Nothing",
          excess: null, // the column is NULL and is published as null, not ""
          urls: {
            self: "https://www.givefood.org.uk/api/2/foodbank/amesbury/",
            html: "https://www.givefood.org.uk/needs/at/amesbury/",
            homepage: "https://amesbury.invalid/",
            shopping_list: "https://amesbury.invalid/list/",
            map: "https://www.givefood.org.uk/needs/at/amesbury/map.png",
          },
        },
        {
          // A LOCATION. Its needs, homepage and shopping list are the PARENT
          // food bank's (Wilton's), while its name, slug and lat_lng are its
          // own -- so a mutant that read the location's own row for all six
          // fields, or the parent's for all six, is caught either way.
          //
          // `self`, `html` and `map` are built from the LOCATION's slug and all
          // three 404. That is frozen bug B3, proved by fetching them below.
          name: "Tidworth Hall",
          slug: "tidworth-hall",
          lat_lng: "51.2400,-1.6700",
          needs: "Tinned tomatoes\r\nUHT milk",
          excess: "Baked beans",
          urls: {
            self: "https://www.givefood.org.uk/api/2/foodbank/tidworth-hall/",
            html: "https://www.givefood.org.uk/needs/at/tidworth-hall/",
            homepage: "https://wilton.invalid/",
            shopping_list: "https://wilton.invalid/list/",
            map: "https://www.givefood.org.uk/needs/at/tidworth-hall/map.png",
          },
        },
        {
          // Parent food bank is in ALDERSHOT, so its ids are not in the
          // constituency's own food bank list at all. If the id batch stopped
          // covering the location parents this entry would throw, not degrade.
          name: "Bemerton Room",
          slug: "bemerton-room",
          lat_lng: "51.0700,-1.8000",
          needs: "Pasta\r\nRice",
          excess: "Christmas puddings",
          urls: {
            self: "https://www.givefood.org.uk/api/2/foodbank/bemerton-room/",
            html: "https://www.givefood.org.uk/needs/at/bemerton-room/",
            homepage: "https://aldershot-fb.invalid/",
            shopping_list: "https://aldershot-fb.invalid/list/",
            map: "https://www.givefood.org.uk/needs/at/bemerton-room/map.png",
          },
        },
        {
          // Its parent food bank IS CLOSED and is correctly absent from the
          // organisation entries above -- yet its needs, homepage and shopping
          // list are published here through the open location. Django does
          // exactly this (location_obj() filters the location's is_closed, not
          // the parent's), so it is reproduced, not fixed.
          name: "Closed Parent Room",
          slug: "closed-parent-room",
          lat_lng: "51.0600,-1.7100",
          needs: "Cereal\r\nLong life juice",
          excess: "Pasta",
          urls: {
            self: "https://www.givefood.org.uk/api/2/foodbank/closed-parent-room/",
            html: "https://www.givefood.org.uk/needs/at/closed-parent-room/",
            homepage: "https://closed-fb.invalid/",
            shopping_list: "https://closed-fb.invalid/list/",
            map: "https://www.givefood.org.uk/needs/at/closed-parent-room/map.png",
          },
        },
      ],
    });
  });

  // Stated separately from the whole-body assertion because it is the one
  // property of that body a reviewer would otherwise have to infer: the two
  // lists are concatenated in a fixed order and neither is sorted.
  it("keeps the two lists in source order, neither sorted nor merged", async () => {
    const doc = (await json("/api/2/constituency/salisbury/")) as { foodbanks: Array<{ name: string }> };
    const names = doc.foodbanks.map((f) => f.name);

    expect(names).toEqual(SALISBURY_ENTRY_NAMES);
    expect(names).not.toEqual([...names].sort());
  });

  // FROZEN BUG B3, proved rather than asserted. The location entries publish
  // three URLs built from the location's own slug, and all three are for
  // FOOD BANK routes. Fetching them through the real router is the only way to
  // show they are broken; a string assertion would pass just as happily if the
  // route existed.
  it("publishes location URLs that 404 -- frozen bug B3", async () => {
    const doc = (await json("/api/2/constituency/salisbury/")) as {
      foodbanks: Array<{ slug: string; urls: { self: string; html: string; map: string } }>;
    };
    const location = doc.foodbanks[2] as { slug: string; urls: { self: string; html: string; map: string } };

    expect(location.slug).toBe("tidworth-hall");
    // `map` is deliberately not in this loop: /needs/at/<slug>/map.png is
    // served out of R2 by routes/media.ts, which this harness does not bind,
    // so its answer carries no information about the slug either way. `self`
    // and `html` are pure routing.
    for (const url of [location.urls.self, location.urls.html]) {
      expect((await get(new URL(url).pathname)).status, url).toBe(404);
    }
    // ... while the SAME location's real page, which the geojson branch builds
    // correctly from the parent's slug, is served.
    expect((await get("/needs/at/wilton/tidworth-hall/")).status).toBe(200);
  });

  // Seeded exclusions, asserted as absences. A filter that did nothing would
  // pass every assertion above, all of whose rows are meant to be present.
  it("excludes the closed food bank, the closed location, and everything in another constituency", async () => {
    const text = await body("/api/2/constituency/salisbury/");

    // Closed organisation: no entry of its own, even though its need text AND
    // its homepage URL are both present via the open location beneath it --
    // which is why this looks for the entry's `"slug"` line and not for the
    // bare string "closed-fb", a substring of `https://closed-fb.invalid/`.
    expect(text).toContain("Cereal");
    expect(text).toContain("https://closed-fb.invalid/");
    expect(text).not.toContain('"slug": "closed-fb"');
    expect(text).not.toContain("Closed Foodbank");
    // Closed location.
    expect(text).not.toContain("shut-annexe");
    // Aldershot's own food bank and its own location, neither of which is in
    // Salisbury -- note the parent food bank of "Farnborough Room" IS a
    // Salisbury food bank, so this only stays out if the LOCATION's own
    // parliamentary_constituency_id is what the query filters on.
    expect(text).not.toContain("Aldershot Foodbank");
    expect(text).not.toContain("farnborough-room");
    // ... and the mirror image: Aldershot's response holds Farnborough Room and
    // not Bemerton Room, whose parent it owns.
    const aldershot = await body("/api/2/constituency/aldershot/");
    expect(aldershot).toContain("farnborough-room");
    expect(aldershot).not.toContain("bemerton-room");
  });

  it("answers a constituency with nothing in it with an empty list, not a 404", async () => {
    const res = await get("/api/2/constituency/empty-vale/");

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ name: "Empty Vale", slug: "empty-vale", foodbanks: [] });
  });

  it("404s an unknown slug", async () => {
    expect((await get("/api/2/constituency/no-such-constituency/")).status).toBe(404);
  });

  it("caches for a week and allows any origin", async () => {
    const res = await get("/api/2/constituency/salisbury/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=604800, s-maxage=604800");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("serves an identical body from the bare /api mount", async () => {
    expect(await body("/api/constituency/salisbury/")).toBe(await body("/api/2/constituency/salisbury/"));
  });

  it("301s the slashless form", async () => {
    const res = await get("/api/2/constituency/salisbury");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/api/2/constituency/salisbury/`);
  });

  it("answers a bad format with an empty, uncached, CORS-less 400", async () => {
    for (const format of ["csv", "GEOJSON", "", "html"]) {
      const res = await get(`/api/2/constituency/salisbury/?format=${format}`);

      expect(res.status, format).toBe(400);
      expect(await res.text(), format).toBe("");
      expect(res.headers.get("Access-Control-Allow-Origin"), format).toBeNull();
    }
  });

  // ANY format other than the literal "geojson" takes the json-shaped branch --
  // `if (format !== "geojson")` -- so xml and yaml carry the food bank list,
  // not features. The 400 for an unknown format happens later, in apiResponse,
  // which is why the branch is reached by values that never reach a response.
  it("renders xml and yaml from the json-shaped branch, not the geojson one", async () => {
    const xml = await body("/api/2/constituency/salisbury/?format=xml");
    const yaml = await body("/api/2/constituency/salisbury/?format=yaml");

    expect(xml.startsWith("<?xml version='1.0'?>\n<constituency>")).toBe(true);
    expect(xml.match(/<foodbank>/g)).toHaveLength(5);
    expect(xml).toContain("<name>Wilton Foodbank</name>");
    expect(xml).toContain("<excess/>"); // Amesbury's NULL excess, self-closed rather than the text "null"
    expect(xml).not.toContain("FeatureCollection");

    // Keys sorted (excess, lat_lng, name, needs, slug, urls), list items
    // indented under their key, and a CRLF `needs` emitted as a DOUBLE-QUOTED
    // scalar with the carriage return escaped -- not as a `|-` block literal,
    // which cannot carry a \r. PyYAML would fold it differently; yaml.ts's
    // header records that as an accepted structural-not-byte divergence, so
    // this pins the JS side rather than wishing for the Python one.
    expect(yaml).toContain("foodbanks:\n  - excess: Baked beans\n    lat_lng: 51.08,-1.86\n    name: Wilton Foodbank\n");
    expect(yaml).toContain('needs: "Tinned tomatoes\\r\\nUHT milk"');
    expect(yaml).not.toContain("FeatureCollection");
  });

  // js2xmlparser drops an empty array entirely; xml.ts recodes it as `{}` so
  // the key still appears as a self-closing element. Worth pinning on a real
  // endpoint response, because "the key vanished" is exactly the kind of change
  // a consumer's parser fails on and no status code shows.
  it("keeps an empty foodbanks list as a self-closing element in xml", async () => {
    const text = await body("/api/2/constituency/empty-vale/?format=xml");

    expect(text).toBe(
      [
        "<?xml version='1.0'?>",
        "<constituency>",
        "    <name>Empty Vale</name>",
        "    <slug>empty-vale</slug>",
        "    <foodbanks/>",
        "</constituency>",
      ].join("\n"),
    );
  });

  // FROZEN BUG B12 (PLAN.md §7.3, and the module's own comment on
  // ConstituencyFoodbankEntry.needs): `entry.needs` is cast and dereferenced
  // without a guard, so ONE food bank with no latest_need takes the whole
  // constituency down -- in both formats. Django does the same
  // (`foodbank.get("needs").change_text` on a None), so the crash is
  // reproduced rather than masked. Pinned as a 500, not fixed.
  it("500s a constituency containing a food bank with no latest need -- frozen bug B12", async () => {
    expect((await get("/api/2/constituency/needless-heath/")).status).toBe(500);
    expect((await get("/api/2/constituency/needless-heath/?format=geojson")).status).toBe(500);
  });

  // The same unguarded shape one level along: `foodbankById.get(loc.foodbank_id)
  // as FoodbankWithLatestNeed` is a cast over a Map miss, so a location whose
  // parent row has gone reads `undefined.latestNeed`. No migration declares a
  // FOREIGN KEY, so this is reachable in production, and it takes out the whole
  // constituency rather than the one entry.
  it("500s a constituency whose location points at a food bank that no longer exists", async () => {
    expect((await get("/api/2/constituency/orphan-heath/")).status).toBe(500);
  });

  // Neither output format publishes phone_number, contact_email or
  // facebook_page, though buildConstituencyFoodbankEntries computes all three
  // for every entry (including running phoneOrFoodbankPhone /
  // emailOrFoodbankEmail for the locations). Faithful to Django, whose
  // `foodbanks()` is shared with other callers; here it is dead work, and the
  // fallback helpers are unobservable from either response. Asserted so that
  // "the fallback is untested" is a recorded fact rather than an omission.
  it("publishes none of the contact fields it computes", async () => {
    for (const path of ["/api/2/constituency/salisbury/", "/api/2/constituency/salisbury/?format=geojson"]) {
      const text = await body(path);

      expect(text, path).toContain("Bemerton Room");
      expect(text, path).not.toContain("01722 411901"); // Wilton's phone
      expect(text, path).not.toContain("01980 000111"); // Bemerton Room's own phone
      expect(text, path).not.toContain("bemerton@example.invalid");
      expect(text, path).not.toContain("info@wilton.invalid");
      expect(text, path).not.toContain("facebook.invalid");
    }
  });
});

// ===========================================================================
// GET /constituency/<slug>/?format=geojson
// ===========================================================================

describe("api2 constituency -- the geojson branch", () => {
  // THE WHOLE BODY, geojson. A different field list off the same entries, so
  // it needs its own assertion rather than sharing the json one:
  //   - coordinates are [lng, lat], parsed to NUMBERS from the lat_lng string
  //     (note "51.2400,-1.6700" -> 51.24 / -1.67, which a passthrough of the
  //     string would fail);
  //   - `url` is gf_url, the only place a location gets a URL that actually
  //     resolves (/needs/at/<parent slug>/<location slug>/) -- in flat
  //     contradiction to the json branch's `self` and `html`;
  //   - the constituency's own boundary is appended as the RAW parsed geometry,
  //     NOT wrapped in a Feature, which is what the Python does too.
  it("publishes one Point feature per entry, then the raw boundary geometry", async () => {
    const res = await get("/api/2/constituency/salisbury/?format=geojson");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(await res.text())).toEqual({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.86, 51.08] },
          properties: {
            name: "Wilton Foodbank",
            slug: "wilton",
            needs: "Tinned tomatoes\r\nUHT milk",
            excess: "Baked beans",
            url: "https://www.givefood.org.uk/needs/at/wilton/",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.78, 51.17] },
          properties: {
            name: "Amesbury Foodbank",
            slug: "amesbury",
            needs: "Nothing",
            excess: null,
            url: "https://www.givefood.org.uk/needs/at/amesbury/",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.67, 51.24] },
          properties: {
            name: "Tidworth Hall",
            slug: "tidworth-hall",
            needs: "Tinned tomatoes\r\nUHT milk",
            excess: "Baked beans",
            // The parent's slug then the location's -- the URL the json
            // branch's `self`/`html` should have used and did not.
            url: "https://www.givefood.org.uk/needs/at/wilton/tidworth-hall/",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.8, 51.07] },
          properties: {
            name: "Bemerton Room",
            slug: "bemerton-room",
            needs: "Pasta\r\nRice",
            excess: "Christmas puddings",
            url: "https://www.givefood.org.uk/needs/at/aldershot-fb/bemerton-room/",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.71, 51.06] },
          properties: {
            name: "Closed Parent Room",
            slug: "closed-parent-room",
            needs: "Cereal\r\nLong life juice",
            excess: "Pasta",
            url: "https://www.givefood.org.uk/needs/at/closed-fb/closed-parent-room/",
          },
        },
        // The boundary, bare. No "type": "Feature" wrapper, no properties, no
        // geometry key -- it IS the geometry, pushed straight into the array.
        { type: "Polygon", coordinates: [[[-1.9, 51], [-1.7, 51], [-1.7, 51.1], [-1.9, 51]]] },
      ],
    });
  });

  // Two separate claims about that last element, each one a plausible "tidy-up"
  // away: that it is not a Feature, and that it is THIS constituency's boundary
  // rather than any boundary that happened to be lying around (every location
  // row is seeded with PLAIN_BOUNDARY, which is a different polygon).
  it("appends the constituency's own boundary, unwrapped", async () => {
    const doc = (await json("/api/2/constituency/salisbury/?format=geojson")) as {
      features: Array<Record<string, unknown>>;
    };
    const last = doc.features[doc.features.length - 1] as Record<string, unknown>;

    expect(last).toEqual(JSON.parse(SALISBURY_BOUNDARY) as unknown);
    expect(last["type"]).toBe("Polygon");
    expect(last["properties"]).toBeUndefined();
    expect(last["geometry"]).toBeUndefined();
  });

  // geojson_dict() (geo.py:180-188) strips surrounding whitespace and ONE
  // trailing comma before json.loads. Salisbury's stored boundary carries both,
  // so this response is a 500 the moment either half of parseBoundaryGeojson
  // goes. Stated against the raw stored text so the fixture cannot drift into
  // being already-clean.
  it("strips the whitespace and the one trailing comma the stored boundary carries", async () => {
    const stored = db.prepare("SELECT boundary_geojson AS b FROM parliamentaryconstituency WHERE slug = 'salisbury'").get() as { b: string };

    expect(stored.b).not.toBe(stored.b.trim());
    expect(stored.b.trim().endsWith(",")).toBe(true);
    expect(() => JSON.parse(stored.b) as unknown).toThrow();

    expect((await get("/api/2/constituency/salisbury/?format=geojson")).status).toBe(200);
  });

  // A constituency with a NULL boundary 500s, because `?? ""` feeds
  // JSON.parse("") -- and Django 500s here too, on `None.strip()`. The json
  // branch of the SAME constituency answers 200, which is what makes the crash
  // provably the boundary rather than anything about its food banks.
  it("500s on a NULL boundary while the json branch of the same constituency is fine", async () => {
    const geo = await get("/api/2/constituency/ynys-mon/?format=geojson");
    const plain = await get("/api/2/constituency/ynys-mon/");

    expect(geo.status).toBe(500);
    expect(plain.status).toBe(200);
    expect(JSON.parse(await plain.text())).toEqual({
      name: "Ynys Môn",
      slug: "ynys-mon",
      foodbanks: [
        {
          name: "Ynys Môn Foodbank",
          slug: "ynys-mon-fb",
          lat_lng: "53.28,-4.35",
          needs: "Tinned fish",
          excess: null,
          urls: {
            self: "https://www.givefood.org.uk/api/2/foodbank/ynys-mon-fb/",
            html: "https://www.givefood.org.uk/needs/at/ynys-mon-fb/",
            homepage: "https://ynys-mon-fb.invalid/",
            shopping_list: "https://ynys-mon-fb.invalid/list/",
            map: "https://www.givefood.org.uk/needs/at/ynys-mon-fb/map.png",
          },
        },
      ],
    });
  });

  // An empty constituency's FeatureCollection is the boundary alone -- not an
  // empty array, and not a null hole where the entries would be.
  it("answers an empty constituency with a boundary-only FeatureCollection", async () => {
    const doc = await json("/api/2/constituency/empty-vale/?format=geojson");

    expect(doc).toEqual({ type: "FeatureCollection", features: [JSON.parse(PLAIN_BOUNDARY) as unknown] });
  });

  it("caches for a week and allows any origin", async () => {
    const res = await get("/api/2/constituency/salisbury/?format=geojson");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=604800, s-maxage=604800");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ===========================================================================
// THE QUERIES
// ===========================================================================

// Every body assertion above is equally true of a version that made two
// sequential id-batch calls, or that read the locations with SELECT *. The
// handler's own comments make performance claims -- "one getFoodbanksByIds
// call covering BOTH the organisation entries' own ids and the location
// entries' parent-food-bank ids, instead of two sequential calls ... this
// endpoint was ~3.5x slower than Django's" (constituencies.ts:60-66) and
// packages/db's "the two SELECTs are independent ... so session.batch() sends
// them in one D1 round trip" -- and neither is visible in a response.
describe("api2 constituency -- the queries behind it", () => {
  it("waits for D1 four times: the constituency, the batch, the ids, the needs", async () => {
    await get("/api/2/constituency/salisbury/");

    expect(roundTrips).toHaveLength(4);
    expect(roundTrips[0]).toEqual(["SELECT * FROM parliamentaryconstituency WHERE slug = ?"]);
    // ONE wait carrying BOTH the food bank and the location statements.
    expect(roundTrips[1]).toHaveLength(2);
    expect(roundTrips[2]).toHaveLength(1);
    expect(roundTrips[3]).toHaveLength(1);
  });

  // THE DE-DUPLICATED UNION. Salisbury's own food banks are ids 1 and 2; its
  // locations' parents are 1 (again), 4 and 3. One query, four placeholders --
  // five would mean the Set went, and two queries would mean the union went.
  it("fetches the organisation ids and the location parents in ONE de-duplicated query", async () => {
    await get("/api/2/constituency/salisbury/");

    const idQueries = prepared.filter((sql) => sql.startsWith("SELECT * FROM foodbank WHERE id IN"));
    expect(idQueries).toEqual(["SELECT * FROM foodbank WHERE id IN (?, ?, ?, ?)"]);
  });

  // The latest needs of those four food banks, resolved in one further query --
  // genuinely dependent on the rows above (the need ids are columns of them),
  // so it cannot join the batch, but it must not become one query per row
  // either.
  it("resolves every latest need in one further query, not one per food bank", async () => {
    await get("/api/2/constituency/salisbury/");

    const needQueries = prepared.filter((sql) => sql.includes("foodbankchange_full"));
    expect(needQueries).toEqual(["SELECT * FROM foodbankchange_full WHERE id IN (?, ?, ?, ?)"]);
  });

  // getFoodbanksByIds returns early on an empty id list. A constituency with
  // nothing in it must therefore issue NO id query at all -- not
  // `WHERE id IN ()`, which is a SQLite syntax error and would be a 500.
  it("issues no id query at all for a constituency with nothing in it", async () => {
    const res = await get("/api/2/constituency/empty-vale/");

    expect(res.status).toBe(200);
    expect(prepared.filter((sql) => sql.includes("WHERE id IN"))).toEqual([]);
    expect(roundTrips).toHaveLength(2);
  });

  // The locations are read through a named column list, not SELECT *:
  // foodbanklocation.boundary_geojson runs to 2.3 MB on one production row and
  // nothing on this path reads it. Stated as a negative that cannot pass
  // vacuously -- the rows that carry the blob are still in the body.
  it("reads the locations through a projection that omits boundary_geojson", async () => {
    const text = await body("/api/2/constituency/salisbury/");

    const locationQueries = prepared.filter((sql) => sql.includes("foodbanklocation_full"));
    expect(locationQueries).toHaveLength(1);
    expect(locationQueries[0]).not.toContain("SELECT *");
    expect(locationQueries[0]).not.toContain("boundary_geojson");
    expect(text).toContain("tidworth-hall");
    expect(text).not.toContain("Polygon");
  });

  // Both halves of the batch filter on is_closed, and both filter on the
  // constituency id. Asserted against the statement text as well as the body
  // because the body assertions above would all still pass if the WHERE clause
  // moved into JavaScript -- and that would mean reading every food bank in the
  // country on every request.
  it("filters in SQL, not in JavaScript", async () => {
    await get("/api/2/constituency/salisbury/");

    expect(roundTrips[1]).toEqual([
      "SELECT * FROM foodbank WHERE parliamentary_constituency_id = ? AND is_closed = 0",
      expect.stringContaining("FROM foodbanklocation_full WHERE parliamentary_constituency_id = ? AND is_closed = 0") as unknown as string,
    ]);
  });

  // The 404 path must not do the work. `getConstituencyBySlug` returning null
  // returns before buildConstituencyFoodbankEntries is reached, so an unknown
  // slug costs one round trip -- not four.
  it("stops after one query on an unknown slug", async () => {
    await get("/api/2/constituency/no-such-constituency/");

    expect(prepared).toEqual(["SELECT * FROM parliamentaryconstituency WHERE slug = ?"]);
  });

  // The bad-format 400 is decided in apiResponse, AFTER the handler has done
  // all of its work -- the format check is not a guard at the top. So a
  // rejected format still costs the full four round trips and still builds the
  // entries. Pinning current behaviour, not endorsing it.
  it("does all the work before rejecting a bad format", async () => {
    const res = await get("/api/2/constituency/salisbury/?format=csv");

    expect(res.status).toBe(400);
    expect(roundTrips).toHaveLength(4);
  });
});

// ===========================================================================
// ?format= HANDLING
// ===========================================================================

describe("api2 constituencies -- the format parameter", () => {
  it("defaults to json when the parameter is absent", async () => {
    const res = await get("/api/2/constituencies/");

    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe(await body("/api/2/constituencies/?format=json"));
  });

  // DIVERGES FROM DJANGO, pinned rather than fixed. Django's QueryDict.get()
  // returns the LAST value for a repeated key -- run on this machine against
  // the Django installed here (5.2.6):
  //   QueryDict("format=xml&format=yaml").get("format", "json")  ->  'yaml'
  // Hono's c.req.query() returns the FIRST. So this one request produces xml
  // here and yaml in production Django. Harmless in practice (a client sending
  // ?format= twice is asking for whatever it gets) and not worth diverging
  // from Hono's own semantics to chase, but it is a real difference and it
  // should be a deliberate one.
  it("takes the FIRST repeated format, where Django takes the last", async () => {
    const res = await get("/api/2/constituencies/?format=xml&format=yaml");

    expect(res.headers.get("Content-Type")).toBe("text/xml");
  });

  // An empty ?format= is NOT the default -- `?? "json"` only fills in for an
  // absent parameter, and "" is not in any ALLOWED_FORMATS list. Django agrees
  // exactly (QueryDict("format=").get("format", "json") -> '', run here on
  // 5.2.6), so the 400 is parity and not an accident of the port.
  it("treats an empty ?format= as a bad format, exactly as Django does", async () => {
    expect((await get("/api/2/constituencies/?format=")).status).toBe(400);
    expect((await get("/api/2/constituency/salisbury/?format=")).status).toBe(400);
  });

  // The allow-list is case-sensitive on both sides (Python does an `in` test on
  // the raw string too), so "JSON" is a 400 and not a json response.
  it("is case-sensitive about format names", async () => {
    expect((await get("/api/2/constituencies/?format=JSON")).status).toBe(400);
    expect((await get("/api/2/constituency/salisbury/?format=GeoJSON")).status).toBe(400);
  });

  // Query parameters other than `format` are ignored rather than rejected --
  // a cache-buster on the end of a URL must not change the document.
  it("ignores unknown query parameters", async () => {
    expect(await body("/api/2/constituencies/?cb=12345")).toBe(await body("/api/2/constituencies/"));
    expect(await body("/api/2/constituency/salisbury/?slug=aldershot")).toBe(await body("/api/2/constituency/salisbury/"));
  });
});
