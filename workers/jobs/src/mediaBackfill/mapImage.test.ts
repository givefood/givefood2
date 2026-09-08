import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import { backfillMapImage, isMapImageKey } from "./mapImage";
import type { Env } from "../../worker-configuration";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a config
// change rather than a test change. Same suppression, same reasoning, as
// packages/db/src/schema.testkit.ts:35 and queues/jobs.test.ts:10.
import { DatabaseSync } from "node:sqlite";

// mediaBackfill/mapImage.ts -- the Static Maps half of the "media-backfill"
// queue message. queues/jobs.ts calls isMapImageKey() and then
// backfillMapImage(); queues/jobs.test.ts already pins WHICH SIDE of the
// ack/retry line each outcome lands on. This file pins the other half: the URL
// that gets BILLED and the bytes that land in R2.
//
// WHY THAT NEEDS ITS OWN SUITE. Every failure this module can have is silent by
// construction. workers/site's routes/media.ts 404s an R2 miss immediately and
// enqueues one of these, so nobody is waiting on the answer; the queue consumer
// logs to `wrangler tail` and nothing else. A map that comes back centred on
// the wrong food bank, missing its donation-point pins, or drawn at the wrong
// zoom is a 200 with correct-looking bytes -- the exact "wrong DATA on a
// correct-looking page" case. So every test below asserts a VALUE off the
// request or off the stored object, never that a promise resolved.
//
// PARITY. This is a port of gfwfbn/views.py's `foodbank_map` (:439-487) and
// `foodbank_location_map` (:866-928), read in full at
// /Users/jasoncartwright/Sites/foodcharity. Both Django views proxy
// maps.googleapis.com live on every request; the port moves the same URL
// construction into the backfill consumer and persists the result. Where the
// port deliberately diverges from those views the test says so and pins the
// PORT's behaviour, per this repo's convention. Four such divergences are
// marked DIVERGENCE below.
//
// REAL THINGS, NOT MOCKS:
//   * node:sqlite carrying the WHOLE real migration set. This module reaches
//     four shared packages/db functions -- getFoodbankBySlug (a batch across
//     `foodbank` and the `foodbankchange_full` VIEW), getFoodbankLocationBySlugs
//     (the `foodbanklocation_full` view), getDonationPointsByFoodbankId (the
//     `foodbankdonationpoint_full` view) and getLocationLatLngsByFoodbankId (the
//     base table) -- so it reads three tables through three views. A narrow
//     hand-built fixture here is the github #51 gap waiting to happen, which is
//     why queues/jobs.test.ts made the same call.
//   * the real packages/db queries, running their real SQL, including the JS-side
//     name sort that decides donation-point marker order.
//
// MOCKED, and only this: `fetch` (maps.googleapis.com -- billed per call) and
// the R2 bucket, which has no node-side double.

// ===========================================================================
// HARNESS
// ===========================================================================

type Bindable = null | number | bigint | string | Uint8Array;

interface SqliteStatement {
  all(...params: Bindable[]): Record<string, unknown>[];
  get(...params: Bindable[]): Record<string, unknown> | undefined;
  run(...params: Bindable[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

let db: SqliteDatabase;

/** Fail the next D1 statement whose SQL this returns an Error for. */
let failIf: ((sql: string) => Error | null) | null;

/** Every consistency mode handed to DB.withSession, in order. */
let sessionModes: unknown[];

interface BatchableStatement {
  __exec: () => { results: Record<string, unknown>[]; success: true; meta: Record<string, unknown> };
}

/**
 * The D1 Sessions API surface packages/db uses, over the real engine.
 *
 * `batch()` is not decoration: getFoodbankBySlug is implemented as a two-
 * statement batch and indexes `results[0]!.results`, so a session double without
 * it fails BOTH branches of this module with a TypeError -- which the consumer's
 * catch would turn into a retry, i.e. it would look exactly like the Google
 * outage these tests are trying to tell apart from a working lookup.
 *
 * `first()` answers null, never undefined, because getFoodbankLocationBySlugs
 * tests `row ? ... : null`.
 *
 * There is no `run()` here on purpose: mapImage.ts issues no writes at all, and
 * a double that cannot write is one more way for an accidental UPDATE in this
 * read-only path to show up as a failing test rather than as a changed row.
 */
function d1Session(): unknown {
  function statement(sql: string, params: Bindable[]): unknown {
    const guard = (): void => {
      const err = failIf?.(sql);
      if (err) throw err;
    };
    return {
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T>() => {
        guard();
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      all: async <T>() => {
        guard();
        return { results: db.prepare(sql).all(...params) as T[], success: true, meta: {} };
      },
      __exec: () => {
        guard();
        return { results: db.prepare(sql).all(...params), success: true as const, meta: {} };
      },
    };
  }
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: BatchableStatement[]) => statements.map((s) => s.__exec()),
    getBookmark: () => null,
  };
}

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

interface StoredObject {
  key: string;
  body: Uint8Array;
  httpMetadata: Record<string, unknown>;
}

let media: Map<string, StoredObject>;
/** Set to make MEDIA.put reject, for the "R2 is down" test. */
let mediaPutError: Error | null;

function mediaBucket(): unknown {
  return {
    head: async (key: string) => media.get(key) ?? null,
    get: async (key: string) => media.get(key) ?? null,
    put: async (key: string, value: ArrayBuffer, options?: { httpMetadata?: Record<string, unknown> }) => {
      if (mediaPutError) throw mediaPutError;
      const stored: StoredObject = { key, body: new Uint8Array(value), httpMetadata: options?.httpMetadata ?? {} };
      media.set(key, stored);
      return stored;
    },
  };
}

// ---------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------

/** A modelled reply. An Error means the fetch itself rejected (DNS, TLS, abort). */
type Reply = { status: number; body: string | Uint8Array } | Error;

let staticMapReply: Reply;
let fetchedUrls: string[];

/** Real PNG magic bytes, so "what landed in R2" is a byte comparison, not a length one. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x2a, 0x2b, 0x2c]);

function stubFetch(): void {
  vi.stubGlobal("fetch", async (input: unknown): Promise<Response> => {
    const url = String(input);
    fetchedUrls.push(url);
    // Anything but the Static Maps endpoint is a test bug, never a silent
    // default: a second billed Google call added to this module later must fail
    // loudly here rather than be absorbed.
    if (!url.startsWith("https://maps.googleapis.com/maps/api/staticmap?")) throw new Error(`unmodelled fetch: ${url}`);
    if (staticMapReply instanceof Error) throw staticMapReply;
    return new Response(staticMapReply.body as BodyInit, { status: staticMapReply.status });
  });
}

/** The search params of the nth (default: only) Static Maps request. */
function requestParams(index = 0): URLSearchParams {
  return new URL(fetchedUrls[index]!).searchParams;
}

// ---------------------------------------------------------------------------
// The env
// ---------------------------------------------------------------------------

let env: Env;

function buildEnv(): Env {
  return {
    DB: {
      withSession: (mode: unknown) => {
        sessionModes.push(mode);
        return d1Session();
      },
    },
    MEDIA: mediaBucket(),
    GMAP_STATIC_KEY: "static-maps-key",
  } as unknown as Env;
}

// ===========================================================================
// FIXTURES
// ===========================================================================

// Deliberately unequal ids and unequal coordinates everywhere. `slug` and
// `locslug` are adjacent capture groups handed to the same function as two
// positional arguments, so a fixture where any two coincide cannot see a
// transposition.
const SALISBURY = 22;
const DUNDEE = 41;

const SALISBURY_LAT_LNG = "51.0688,-1.7945";
const DUNDEE_LAT_LNG = "56.4620,-2.9707";

interface FoodbankSeed {
  id: number;
  slug: string;
  latLng?: string;
  deliveryAddress?: string | null;
  deliveryLatLng?: string | null;
  noLocations?: number;
  noDonationPoints?: number | null;
}

/** Fills every NOT NULL column the real `foodbank` table declares. */
function seedFoodbank(seed: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       delivery_address, delivery_lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, no_donation_points,
       days_between_needs, created, modified
     ) VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', ?, ?, ?, 0, ?, ?, ?, 0, 0, ?, ?, 14, ?, ?)`,
  ).run(
    seed.id,
    `uuid-${seed.slug}`,
    `${seed.slug} Foodbank`,
    seed.slug,
    seed.latLng ?? SALISBURY_LAT_LNG,
    seed.deliveryAddress ?? null,
    seed.deliveryLatLng ?? null,
    `info@${seed.slug}.example`,
    `https://${seed.slug}.example/`,
    `https://${seed.slug}.example/shopping-list/`,
    seed.noLocations ?? 0,
    seed.noDonationPoints === undefined ? 0 : seed.noDonationPoints,
    "2020-01-01 00:00:00.000000",
    "2026-08-01 09:15:22.412000",
  );
}

interface LocationSeed {
  id: number;
  foodbankId: number;
  slug: string;
  name?: string;
  latLng: string;
  boundaryGeojson?: string | null;
  isClosed?: 0 | 1;
}

function seedLocation(seed: LocationSeed): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, country, lat_lng, boundary_geojson, is_closed, modified)
     VALUES (?, ?, ?, ?, ?, 'England', ?, ?, ?, ?)`,
  ).run(
    seed.id,
    `uuid-loc-${seed.id}`,
    seed.foodbankId,
    seed.name ?? `Location ${seed.id}`,
    seed.slug,
    seed.latLng,
    seed.boundaryGeojson ?? null,
    seed.isClosed ?? 0,
    "2026-08-01 09:15:22.412000",
  );
}

function seedDonationPoint(seed: { id: number; foodbankId: number; name: string; latLng: string; isClosed?: 0 | 1 }): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode, lat_lng, is_closed, in_store_only, modified)
     VALUES (?, ?, ?, ?, ?, '2 Market Place', 'SP1 2BB', ?, ?, 0, ?)`,
  ).run(
    seed.id,
    `uuid-dp-${seed.id}`,
    seed.foodbankId,
    seed.name,
    seed.name.toLowerCase().replace(/ /g, "-"),
    seed.latLng,
    seed.isClosed ?? 0,
    "2026-08-01 09:15:22.412000",
  );
}

/** A GeoJSON Feature with a Polygon geometry, in the shape the admin textarea holds. */
function polygonFeature(ring: [number, number][]): string {
  return JSON.stringify({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } });
}

/** A ring of `n` distinct points, for the >100-point simplification tests. */
function ringOf(n: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => [i / 10000, 50 + i / 10000] as [number, number]);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(MIGRATIONS_SQL);
  failIf = null;
  sessionModes = [];

  media = new Map();
  mediaPutError = null;

  fetchedUrls = [];
  staticMapReply = { status: 200, body: PNG_BYTES };

  stubFetch();
  env = buildEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

// ===========================================================================
// isMapImageKey
// ===========================================================================
//
// This predicate is the ONLY thing standing between an R2 key and a billed
// Google call: queues/jobs.ts asks it first, and anything it rejects falls
// through to isPlacePhotoKey and then to a throw. Both halves of that matter --
// a false negative makes a real map key un-backfillable for ever (routes/media.ts
// keeps 404ing and re-enqueuing), and a false positive sends a photo or
// screenshot key into a Static Maps request.

describe("isMapImageKey", () => {
  // The four shapes the module's own header lists, which are the four URL
  // patterns workers/site actually serves. All four must be accepted or the
  // corresponding image is permanently missing from the site.
  it.each([
    ["media/needs/at/salisbury/map.png", "food bank, default size"],
    ["media/needs/at/salisbury/maps/300.png", "food bank, sized"],
    ["media/needs/at/salisbury/branch-street/map.png", "location, default size"],
    ["media/needs/at/salisbury/branch-street/maps/1080.png", "location, sized"],
  ])("accepts %s (%s)", (key) => {
    expect(isMapImageKey(key)).toBe(true);
  });

  // Keys that belong to OTHER backfill branches, or to no branch at all. A false
  // positive on any of these would put a photo/screenshot/favicon key into
  // backfillMapImage, where it throws a different error and the jobs-dlq line
  // names the wrong subsystem.
  it.each([
    ["media/needs/at/salisbury/photo.jpg", "the place-photo branch's key"],
    ["media/needs/at/salisbury/branch-street/photo.jpg", "a location photo"],
    ["media/needs/at/salisbury/favicon.png", "never implemented here"],
    ["media/needs/at/salisbury/screenshots/homepage.png", "the Browser Rendering branch"],
    ["media/needs/at/map.png", "no slug at all"],
    ["media/needs/at/a/b/c/map.png", "one path segment too deep"],
    ["/media/needs/at/salisbury/map.png", "a leading slash -- R2 keys have none"],
    ["media/needs/at/salisbury/map.PNG", "uppercase extension"],
    ["media/needs/at/salisbury/maps/.png", "an empty size"],
    ["media/needs/at/salisbury/maps/large.png", "a non-numeric size"],
    ["media/needs/at/salisbury/map.png?v=2", "a query string riding on the key"],
    ["media/needs/at/salisbury/map.png ", "a trailing space"],
    ["xmedia/needs/at/salisbury/map.png", "an unanchored prefix"],
    ["", "the empty string"],
    // MUTANT-DRIVEN, and the reason is that every entry above is FOOD-BANK-shaped
    // -- two segments after `at/`, or three ending `maps/<digits>.png`. None of
    // them is three-segments-then-`map.png`, so LOCATION_MAP_RE's own `$` was
    // holding nothing down: deleting that one anchor in a scratch copy of the
    // module left this entire file green. These are the location-shaped forms of
    // the query-string and trailing-junk cases, and without them a key like
    // `<slug>/<locslug>/map.png?v=2` is a billed Static Maps call whose PNG is
    // stored under a key routes/media.ts will never ask for again.
    ["media/needs/at/salisbury/branch-street/map.png?v=2", "a LOCATION key with a query string"],
    ["media/needs/at/salisbury/branch-street/maps/1080.png.bak", "a LOCATION key with an editor's backup suffix"],
    // ...and these two hold down the ESCAPE on the dot of `map\.png`, in both
    // patterns. Unescaped, `map.png` also matches "mapqpng" -- which nothing else
    // in this table distinguishes, so the typo would be accepted and fetched.
    ["media/needs/at/salisbury/mapqpng", "what an unescaped dot would accept (food bank shape)"],
    ["media/needs/at/salisbury/branch-street/mapqpng", "the same, location shape"],
  ])("rejects %s (%s)", (key) => {
    expect(isMapImageKey(key)).toBe(false);
  });

  // JS `$` (no `m` flag) anchors at the true end of the string, unlike Python's
  // `$`, which also matches before a final newline. Pinned because this regex is
  // a transliteration of Django URL patterns and the difference is invisible
  // until someone enqueues a key with a stray newline: here it is rejected and
  // dead-letters, rather than being backfilled under a key nothing can read back.
  it("rejects a key with a trailing newline, where the same pattern in Python would not", () => {
    expect(isMapImageKey("media/needs/at/salisbury/map.png\n")).toBe(false);
    // The location pattern carries its own `$`, and no food-bank-shaped key
    // exercises it -- see the note in the reject table above.
    expect(isMapImageKey("media/needs/at/salisbury/branch-street/map.png\n")).toBe(false);
  });

  // A size that is well-formed but not one of the three configured ones is
  // ACCEPTED here and only rejected later, inside backfillMapImage. That split
  // is deliberate-looking (the predicate is about shape, the handler about
  // config) but it means a `maps/999.png` enqueue costs three retries and a dead
  // letter rather than being ignored. See the invalid-size test below for the
  // other end of it.
  it("accepts any digit-string size, leaving the 300/600/1080 check to the handler", () => {
    expect(isMapImageKey("media/needs/at/salisbury/maps/999.png")).toBe(true);
    expect(isMapImageKey("media/needs/at/salisbury/maps/0600.png")).toBe(true);
  });
});

// ===========================================================================
// backfillMapImage -- routing
// ===========================================================================

describe("backfillMapImage: routing", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG });
    seedLocation({ id: 501, foodbankId: SALISBURY, slug: "branch-street", latLng: "51.0700,-1.7800" });
  });

  // The caller (queues/jobs.ts) only reaches this after isMapImageKey, but the
  // module's own header promises a throw for anything else -- so a future caller
  // that forgets the guard fails loudly instead of fetching a map of nowhere.
  it("throws for a key that is not map-shaped, without touching Google or R2", async () => {
    await expect(backfillMapImage(env, "media/needs/at/salisbury/photo.jpg")).rejects.toThrow(
      "backfillMapImage: key doesn't look like a map path: media/needs/at/salisbury/photo.jpg",
    );
    expect(fetchedUrls).toEqual([]);
    expect(media.size).toBe(0);
  });

  // `maps` is a legal location slug as far as LOCATION_MAP_RE is concerned, so a
  // food-bank-looking key that reads `<slug>/maps/map.png` is handled by the
  // LOCATION branch, with locslug "maps", and dead-letters on "no location"
  // rather than being read as a food bank map.
  //
  // THIS IS A SHAPE EFFECT, NOT AN ORDERING ONE, and the distinction is worth the
  // sentence because the sibling placePhoto.ts really does depend on its ordering
  // (its own header says ORDER MATTERS, and its location pattern genuinely also
  // matches a donation-point path). Here the two patterns are disjoint:
  // FOODBANK_MAP_RE demands digits after `maps/`, so it does not match this key
  // at all. Brute-forced over every 1-to-4-segment key built from `a`, `b`,
  // `maps`, `map.png`, `300.png`, `map`, `maps.png`, `0` and `x.png` -- no key
  // matches both -- and confirmed by mutation: swapping the two `exec` blocks in
  // backfillMapImage leaves this whole file green. So do not read this test as
  // guarding the order of those blocks; it guards which SHAPE reaches which
  // branch.
  //
  // SUSPECT, pinned rather than fixed: no route in workers/site emits this shape
  // today (the sized food-bank form is always `maps/<digits>.png`), so it is
  // unreachable rather than broken.
  it("SUSPECT: reads <slug>/maps/map.png as a LOCATION map whose locslug is 'maps'", async () => {
    await expect(backfillMapImage(env, "media/needs/at/salisbury/maps/map.png")).rejects.toThrow(
      "media-backfill: no location for salisbury/maps (media/needs/at/salisbury/maps/map.png)",
    );
  });

  // The mirror of that: the sized food-bank form has three segments after `at/`
  // and must NOT be mistaken for a location, because "300.png" is not a valid
  // tail for the location pattern. Asserted through the CENTRE of the resulting
  // request, which is the food bank's coordinate and not the location's.
  it("reads <slug>/maps/300.png as a FOOD BANK map, not a location one", async () => {
    await backfillMapImage(env, "media/needs/at/salisbury/maps/300.png");

    expect(requestParams().get("center")).toBe(SALISBURY_LAT_LNG);
    // A location map would carry `zoom` and `visual_refresh`; a food bank map has
    // neither. This is the cheapest way to prove which branch ran.
    expect(requestParams().get("zoom")).toBeNull();
    expect(requestParams().get("visual_refresh")).toBeNull();
  });

  // D1 is read through ONE session per backfill, opened "first-unconstrained" --
  // the mode that lets D1 answer from any read replica. That is the right
  // trade-off for a backfill (nobody is waiting, and a few seconds of replica lag
  // costs nothing), but it is also the reason a food bank created seconds ago can
  // 404 here; pinned so a change of mode is a deliberate one.
  it("opens exactly one first-unconstrained D1 session per backfill", async () => {
    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(sessionModes).toEqual(["first-unconstrained"]);
  });
});

// ===========================================================================
// backfillMapImage -- the food bank map request
// ===========================================================================
//
// gfwfbn/views.py:439-487 `foodbank_map`.

describe("backfillMapImage: food bank map request", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG });
    seedFoodbank({ id: DUNDEE, slug: "dundee", latLng: DUNDEE_LAT_LNG });
  });

  // The whole request, parameter by parameter and IN ORDER, against
  // gfwfbn/views.py:472-480's params list. Asserting the ordered key list as well
  // as the values catches the one thing a per-key assertion cannot: `markers`
  // being appended in the wrong place, which is what decides pin stacking (see
  // the marker-ordering test below).
  it("builds the Static Maps URL Django builds, with the same parameters in the same order", async () => {
    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]!.startsWith("https://maps.googleapis.com/maps/api/staticmap?")).toBe(true);

    const params = requestParams();
    expect([...params.keys()]).toEqual(["center", "size", "scale", "maptype", "format", "language", "key", "markers"]);
    expect(params.get("center")).toBe(SALISBURY_LAT_LNG); // Salisbury's row, not Dundee's
    expect(params.get("size")).toBe("600x400");
    expect(params.get("scale")).toBe("1");
    expect(params.get("maptype")).toBe("roadmap");
    expect(params.get("format")).toBe("png");
    expect(params.get("key")).toBe("static-maps-key"); // env.GMAP_STATIC_KEY reached the request
  });

  // DIVERGENCE, deliberate and documented in the module: Django passes
  // `request.LANGUAGE_CODE` (gfwfbn/views.py:478), so a Welsh visitor got a Welsh
  // map. The backfill has no request and no locale, stores ONE object per key,
  // and hardcodes "en". Pinned because "language" silently becoming per-request
  // again would mean the first locale to miss decides the labels for everyone.
  it("hardcodes language=en, unlike Django's per-request LANGUAGE_CODE", async () => {
    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(requestParams().get("language")).toBe("en");
  });

  // The bytes and the metadata, read back off the bucket. PLAN.md §3.7's
  // httpMetadata shape, matching Django's @cache_page(SECONDS_IN_WEEK) -- 604800
  // seconds. A wrong cacheControl here is invisible until an edge cache holds
  // (or drops) every map on the site.
  it("stores the response bytes under the exact key, with a one-week cacheControl", async () => {
    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    const stored = media.get("media/needs/at/salisbury/map.png");
    expect(stored).toBeDefined();
    expect(Array.from(stored!.body)).toEqual(Array.from(PNG_BYTES));
    expect(stored!.httpMetadata).toEqual({ contentType: "image/png", cacheControl: "public, max-age=604800" });
    // Nothing else was written: a key naming one food bank must not touch another.
    expect([...media.keys()]).toEqual(["media/needs/at/salisbury/map.png"]);
  });

  // gfwfbn/views.py:405-408's MAP_SIZE_CONFIG, all three entries. The scale is
  // the retina multiplier, so 300 and 1080 are physically 300x300 and 1080x720 --
  // getting the pair wrong produces an image of the right dimensions at the wrong
  // density, which looks fine in a test that only checks `size`.
  it.each([
    ["media/needs/at/dundee/maps/300.png", "150x150", "2"],
    ["media/needs/at/dundee/maps/600.png", "600x400", "1"],
    ["media/needs/at/dundee/maps/1080.png", "540x360", "2"],
    ["media/needs/at/dundee/map.png", "600x400", "1"], // the unsized form defaults to 600
  ])("%s asks for %s at scale %s", async (key, dimensions, scale) => {
    await backfillMapImage(env, key);

    expect(requestParams().get("center")).toBe(DUNDEE_LAT_LNG); // the slug in the key routed
    expect(requestParams().get("size")).toBe(dimensions);
    expect(requestParams().get("scale")).toBe(scale);
    expect(media.has(key)).toBe(true);
  });

  // A size the shape-check accepts but the config does not. Django answers
  // HttpResponseBadRequest (views.py:445-446); here it throws, which
  // queues/jobs.ts turns into three retries and a dead letter. Asserting "no
  // fetch" is the load-bearing half: the size check runs BEFORE the billed call,
  // so a bad enqueue costs nothing but log lines.
  it.each([
    ["media/needs/at/salisbury/maps/999.png", "999"],
    ["media/needs/at/salisbury/maps/0600.png", "0600"], // string keys: "0600" is not "600"
    ["media/needs/at/salisbury/maps/301.png", "301"],
  ])("throws for %s without calling Google", async (key, size) => {
    await expect(backfillMapImage(env, key)).rejects.toThrow(`media-backfill: invalid map size ${size} for ${key}`);
    expect(fetchedUrls).toEqual([]);
    expect(media.size).toBe(0);
  });

  // A slug deleted between the R2 miss and this dequeue. Throws before the billed
  // call, and the message ends at jobs-dlq -- correct, because nothing else in the
  // system would ever mention a media key that can never be satisfied.
  it("throws for a slug with no food bank row, without calling Google", async () => {
    await expect(backfillMapImage(env, "media/needs/at/vanished/map.png")).rejects.toThrow(
      "media-backfill: no foodbank for slug vanished (media/needs/at/vanished/map.png)",
    );
    expect(fetchedUrls).toEqual([]);
  });
});

// ===========================================================================
// backfillMapImage -- the food bank map markers
// ===========================================================================
//
// gfwfbn/views.py:451-470 and :481-484. This is the part of the port with the
// most branching and the least visibility: a missing marker set is a map that
// still renders, still caches for a week, and simply has fewer pins on it than
// the page's text claims.

describe("backfillMapImage: food bank map markers", () => {
  const RED = "icon:https://www.givefood.org.uk/static/img/mapmarkers/32/red.png";
  const YELLOW = "icon:https://www.givefood.org.uk/static/img/mapmarkers/16/yellow.png";
  const BLUE = "icon:https://www.givefood.org.uk/static/img/mapmarkers/16/blue.png";

  // The simplest case: one red pin on the food bank's own coordinate, and no
  // other marker sets at all.
  it("sends one red marker at the food bank's coordinate when it has nothing else", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG });

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(requestParams().getAll("markers")).toEqual([`${RED}|${SALISBURY_LAT_LNG}`]);
  });

  // THE STACKING ORDER, which is the reason the three sets are appended in this
  // sequence and not another. Google draws later-appended `markers` sets on top,
  // so blue then yellow then red puts the food bank's own 32px red pin above its
  // 16px satellites. Django appends dp_markers, then loc_markers, then
  // main_markers (views.py:481-484); reordering them here would hide the red pin
  // under a donation point at any zoom where they overlap, which is most of them.
  it("appends donation points, then locations, then the food bank -- so the red pin draws on top", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG, noLocations: 1, noDonationPoints: 1 });
    seedLocation({ id: 501, foodbankId: SALISBURY, slug: "branch-street", latLng: "51.0700,-1.7800" });
    seedDonationPoint({ id: 601, foodbankId: SALISBURY, name: "Tesco Southampton Road", latLng: "51.0600,-1.8100" });

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(requestParams().getAll("markers")).toEqual([
      `${BLUE}|51.0600,-1.8100|`,
      `${YELLOW}|51.0700,-1.7800|`,
      `${RED}|${SALISBURY_LAT_LNG}`,
    ]);
  });

  // THE TRAILING PIPE ON THE SATELLITE SETS IS NOT A TYPO. Django builds those
  // two strings by appending `"%s|" % lat_lng` per row (views.py:459, :467), so
  // every one ends in a bare `|`; the port reproduces it with `join("|") + "|"`.
  // Google tolerates it. Pinned separately from the ordering test so that
  // "tidying" it away is a visible change rather than a silent one.
  it("keeps Django's trailing pipe on the location and donation-point marker sets", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", noLocations: 2, noDonationPoints: 2 });
    seedLocation({ id: 501, foodbankId: SALISBURY, slug: "one", latLng: "51.01,-1.01" });
    seedLocation({ id: 502, foodbankId: SALISBURY, slug: "two", latLng: "51.02,-1.02" });
    seedDonationPoint({ id: 601, foodbankId: SALISBURY, name: "Aldi", latLng: "51.11,-1.11" });
    seedDonationPoint({ id: 602, foodbankId: SALISBURY, name: "Boots", latLng: "51.12,-1.12" });

    const markers = await backfillMapImage(env, "media/needs/at/salisbury/map.png").then(() => requestParams().getAll("markers"));

    expect(markers[0]).toBe(`${BLUE}|51.11,-1.11|51.12,-1.12|`);
    expect(markers[1]).toBe(`${YELLOW}|51.01,-1.01|51.02,-1.02|`);
    // ...and NOT on the main set, which Django builds differently (views.py:452).
    expect(markers[2]!.endsWith("|")).toBe(false);
  });

  // Donation points come back from getDonationPointsByFoodbankId ALREADY SORTED
  // BY NAME (a JS-side sort, mirroring Django's `.order_by("name")` on
  // models/foodbank.py:552). Seeded deliberately out of order so a sort that
  // silently stopped happening changes this string. Marker order is cosmetic on
  // the image itself, but it is what makes the generated URL -- and therefore
  // Google's own cache key -- stable across backfills.
  it("orders donation-point markers by name, not by insertion", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", noDonationPoints: 3 });
    seedDonationPoint({ id: 601, foodbankId: SALISBURY, name: "Waitrose Castle Street", latLng: "51.31,-1.31" });
    seedDonationPoint({ id: 602, foodbankId: SALISBURY, name: "Aldi Brown Street", latLng: "51.11,-1.11" });
    seedDonationPoint({ id: 603, foodbankId: SALISBURY, name: "Morrisons Bridge Street", latLng: "51.21,-1.21" });

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(requestParams().getAll("markers")[0]).toBe(`${BLUE}|51.11,-1.11|51.21,-1.21|51.31,-1.31|`);
  });

  // THE EXCLUSION THAT MATTERS MOST. Both satellite queries filter by
  // foodbank_id, and a filter that stopped filtering would pass every test that
  // only seeds matching rows. Dundee's location and donation point are seeded at
  // coordinates 5 degrees away, so if either leaked into Salisbury's map the
  // string below changes AND the resulting image would be zoomed out to Scotland.
  it("excludes another food bank's locations and donation points", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG, noLocations: 1, noDonationPoints: 1 });
    seedFoodbank({ id: DUNDEE, slug: "dundee", latLng: DUNDEE_LAT_LNG, noLocations: 1, noDonationPoints: 1 });
    seedLocation({ id: 501, foodbankId: SALISBURY, slug: "branch-street", latLng: "51.0700,-1.7800" });
    seedLocation({ id: 502, foodbankId: DUNDEE, slug: "lochee", latLng: "56.4700,-3.0200" });
    seedDonationPoint({ id: 601, foodbankId: SALISBURY, name: "Tesco", latLng: "51.0600,-1.8100" });
    seedDonationPoint({ id: 602, foodbankId: DUNDEE, name: "Asda", latLng: "56.4500,-2.9500" });

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    const markers = requestParams().getAll("markers");
    expect(markers).toEqual([`${BLUE}|51.0600,-1.8100|`, `${YELLOW}|51.0700,-1.7800|`, `${RED}|${SALISBURY_LAT_LNG}`]);
    expect(markers.join("|")).not.toContain("56.4"); // no Dundee coordinate anywhere
  });

  // `no_locations` and `no_donation_points` are denormalised counters, and the
  // port gates the QUERY on them exactly as Django gates the marker string
  // (views.py:456, :464). A zero counter means the rows are never even read --
  // so a counter that has drifted out of step with reality silently drops pins.
  // Seeding rows that MUST be excluded is the only way to see the gate at all.
  it("skips the satellite queries entirely when the denormalised counters are zero", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG, noLocations: 0, noDonationPoints: 0 });
    seedLocation({ id: 501, foodbankId: SALISBURY, slug: "branch-street", latLng: "51.0700,-1.7800" });
    seedDonationPoint({ id: 601, foodbankId: SALISBURY, name: "Tesco", latLng: "51.0600,-1.8100" });

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    // The rows exist and are correctly attributed -- they are simply not asked for.
    expect(requestParams().getAll("markers")).toEqual([`${RED}|${SALISBURY_LAT_LNG}`]);
  });

  // DIVERGENCE. Django writes `if foodbank.no_donation_points != 0`, and
  // `no_donation_points` is NULLABLE (0001_core.sql declares it so, unlike
  // `no_locations`). In Python `None != 0` is True, so Django would go looking;
  // in JS `if (foodbank.no_donation_points)` is falsy for null, so the port does
  // not. The location gate is written `!== 0`, which DOES match Django -- the two
  // sit four lines apart and are written differently.
  //
  // In practice a NULL counter with live donation points is a broken row either
  // way; pinned as the port's behaviour, not endorsed, and reported.
  it("SUSPECT: a NULL no_donation_points drops the blue pins, where Django's != 0 would keep them", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG, noDonationPoints: null });
    seedDonationPoint({ id: 601, foodbankId: SALISBURY, name: "Tesco", latLng: "51.0600,-1.8100" });

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(requestParams().getAll("markers")).toEqual([`${RED}|${SALISBURY_LAT_LNG}`]);
  });

  // DIVERGENCE, and this one is the port fixing Django. Django emits the icon
  // prefix as soon as the counter is non-zero, so a food bank whose counter says
  // 3 but whose rows are gone gets `markers=icon:...blue.png|` -- a marker set
  // with no coordinates, which Google answers 400 for. The port checks
  // `length > 0` and omits the parameter, so the map still renders.
  it("omits a marker set whose rows have gone, where Django would send a bare icon", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG, noLocations: 4, noDonationPoints: 3 });

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(requestParams().getAll("markers")).toEqual([`${RED}|${SALISBURY_LAT_LNG}`]);
  });

  // Neither Django's `foodbank.locations()` nor this port filters is_closed --
  // a closed location still gets a pin. Deliberate (see
  // getLocationsByFoodbankId's own comment in packages/db) and asserted so that
  // "obviously we should hide closed ones" is a conversation rather than a
  // silent edit.
  it("includes a CLOSED location's marker, matching Django's unfiltered locations()", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG, noLocations: 2 });
    seedLocation({ id: 501, foodbankId: SALISBURY, slug: "open-one", latLng: "51.0700,-1.7800", isClosed: 0 });
    seedLocation({ id: 502, foodbankId: SALISBURY, slug: "shut-one", latLng: "51.0900,-1.7600", isClosed: 1 });

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(requestParams().getAll("markers")[0]).toBe(`${YELLOW}|51.0700,-1.7800|51.0900,-1.7600|`);
  });

  // A delivery-only food bank gets a second red pin. Django: `if
  // foodbank.delivery_address: main_markers += "|%s" % foodbank.delivery_lat_lng`
  // (views.py:453-454).
  it("adds the delivery coordinate to the red marker set when both fields are set", async () => {
    seedFoodbank({
      id: SALISBURY,
      slug: "salisbury",
      latLng: SALISBURY_LAT_LNG,
      deliveryAddress: "Unit 4, Southampton Road",
      deliveryLatLng: "51.0611,-1.7811",
    });

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(requestParams().getAll("markers")).toEqual([`${RED}|${SALISBURY_LAT_LNG}|51.0611,-1.7811`]);
    // MUTANT: centring the map on `delivery_lat_lng` instead of `lat_lng`
    // survived every other test in this file, because this is the only fixture
    // that has a delivery geocode at all -- everywhere else that column is NULL,
    // so the wrong expression falls back to the right value. A delivery food
    // bank's map must still be centred on the food bank itself.
    expect(requestParams().get("center")).toBe(SALISBURY_LAT_LNG);
  });

  // DIVERGENCE, and the port is again the safer one. Django tests
  // `delivery_address` ALONE, so a row with an address but no geocode appends the
  // literal string "None" to the markers parameter -- Google 400s the whole
  // request and the food bank gets no map at all. The port requires both.
  it("omits the delivery pin when the address has no geocode, where Django would send 'None'", async () => {
    seedFoodbank({
      id: SALISBURY,
      slug: "salisbury",
      latLng: SALISBURY_LAT_LNG,
      deliveryAddress: "Unit 4, Southampton Road",
      deliveryLatLng: null,
    });

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(requestParams().getAll("markers")).toEqual([`${RED}|${SALISBURY_LAT_LNG}`]);
  });

  // The other asymmetry: a geocode with no address is ignored by both. Django
  // never looks at delivery_lat_lng unless delivery_address is truthy.
  it("ignores a delivery geocode with no delivery address, matching Django", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG, deliveryAddress: null, deliveryLatLng: "51.0611,-1.7811" });

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(requestParams().getAll("markers")).toEqual([`${RED}|${SALISBURY_LAT_LNG}`]);
    // The same centre mutant as above: an unused delivery geocode must not become
    // the centre of the map either.
    expect(requestParams().get("center")).toBe(SALISBURY_LAT_LNG);
  });
});

// ===========================================================================
// backfillMapImage -- the location map request
// ===========================================================================
//
// gfwfbn/views.py:866-928 `foodbank_location_map`.

describe("backfillMapImage: location map request", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG, noLocations: 1, noDonationPoints: 1 });
    seedLocation({ id: 501, foodbankId: SALISBURY, slug: "branch-street", latLng: "51.0777,-1.7833" });
    // Satellites that a location map must NOT pick up. The two branches share a
    // module and a message type but not a marker list.
    seedDonationPoint({ id: 601, foodbankId: SALISBURY, name: "Tesco", latLng: "51.0600,-1.8100" });
  });

  // The whole request against views.py:882-893. `zoom` and `visual_refresh` are
  // the two parameters the food bank branch does not send, and there are NO
  // markers on a location map at all -- Django's location view builds none.
  it("builds the location Static Maps URL Django builds, centred on the LOCATION", async () => {
    await backfillMapImage(env, "media/needs/at/salisbury/branch-street/map.png");

    const params = requestParams();
    expect([...params.keys()]).toEqual(["center", "zoom", "size", "scale", "maptype", "format", "visual_refresh", "language", "key"]);
    expect(params.get("center")).toBe("51.0777,-1.7833"); // the location's coordinate, NOT the food bank's
    expect(params.get("visual_refresh")).toBe("true");
    expect(params.get("size")).toBe("600x400");
    expect(params.get("key")).toBe("static-maps-key");
    // No pins: neither the food bank's own red one nor its donation point.
    expect(params.getAll("markers")).toEqual([]);
  });

  // ONE SESSION, TWO QUERIES. This branch reads the food bank and then the
  // location, and both must ride the SAME D1 session. A second withSession()
  // would put the second read on a possibly different read replica, so a
  // location created moments after its food bank could resolve against a replica
  // that has the food bank but not the location -- dead-lettering as "no
  // location" for a row that plainly exists. MUTANT: giving the location lookup
  // its own `env.DB.withSession(...)` is invisible to every other test here,
  // because the routing suite's session assertion only ever runs the food bank
  // branch.
  it("reads both rows through the single first-unconstrained session, not one session each", async () => {
    await backfillMapImage(env, "media/needs/at/salisbury/branch-street/map.png");

    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  it("stores the location PNG under the exact key, with the same one-week metadata", async () => {
    await backfillMapImage(env, "media/needs/at/salisbury/branch-street/maps/1080.png");

    const stored = media.get("media/needs/at/salisbury/branch-street/maps/1080.png");
    expect(Array.from(stored!.body)).toEqual(Array.from(PNG_BYTES));
    expect(stored!.httpMetadata).toEqual({ contentType: "image/png", cacheControl: "public, max-age=604800" });
    expect(requestParams().get("size")).toBe("540x360");
    expect(requestParams().get("scale")).toBe("2");
  });

  // THE PORT FOLLOWS DJANGO'S CODE, NOT DJANGO'S COMMENT. views.py:878 reads
  // `# Use zoom 12 if boundary exists` above `zoom = 11 if location.boundary_geojson else 15`.
  // The port copied the 11. Pinned with the discrepancy named so nobody
  // "corrects" it to 12 on the strength of the comment.
  it("uses zoom 15 without a boundary and zoom 11 with one, following Django's code over its comment", async () => {
    await backfillMapImage(env, "media/needs/at/salisbury/branch-street/map.png");
    expect(requestParams(0).get("zoom")).toBe("15");

    db.prepare("UPDATE foodbanklocation SET boundary_geojson = ? WHERE id = 501").run(
      polygonFeature([
        [-1.7945, 51.0688],
        [-1.79, 51.07],
        [-1.8, 51.06],
        [-1.7945, 51.0688],
      ]),
    );
    await backfillMapImage(env, "media/needs/at/salisbury/branch-street/map.png");
    expect(requestParams(1).get("zoom")).toBe("11");
  });

  // ZOOM IS DECIDED BY THE RAW COLUMN, THE PATH BY WHETHER IT PARSES. So a
  // location whose admin-pasted GeoJSON is malformed gets the zoomed-OUT map
  // meant for showing a boundary, with no boundary drawn on it -- a blank-looking
  // map rather than a missing one. Both Django and the port do this
  // (views.py:878 vs :895's try/except); pinned because it is the visible
  // symptom of a data-entry error, and someone will one day report it as a bug
  // in this consumer.
  it("still zooms out to 11 for an UNPARSEABLE boundary, and draws no path", async () => {
    db.prepare("UPDATE foodbanklocation SET boundary_geojson = ? WHERE id = 501").run('{"geometry": {"type": "Poly');

    await backfillMapImage(env, "media/needs/at/salisbury/branch-street/map.png");

    expect(requestParams().get("zoom")).toBe("11");
    expect(requestParams().get("path")).toBeNull();
    // ...and the map is still fetched and still stored. A bad boundary must not
    // cost the location its map.
    expect(media.has("media/needs/at/salisbury/branch-street/map.png")).toBe(true);
  });

  // An empty string is falsy in both languages, so it takes the no-boundary path
  // rather than the unparseable one. `boundary_geojson` is a blank-able TextField
  // (models/foodbank.py:787), so "" and NULL are both real production values.
  it("treats an empty boundary string as no boundary at all", async () => {
    db.prepare("UPDATE foodbanklocation SET boundary_geojson = '' WHERE id = 501").run();

    await backfillMapImage(env, "media/needs/at/salisbury/branch-street/map.png");

    expect(requestParams().get("zoom")).toBe("15");
    expect(requestParams().get("path")).toBeNull();
  });

  // The location must belong to THIS food bank. getFoodbankLocationBySlugs
  // filters on `foodbank_slug` (the column the foodbanklocation_full view
  // reconstructs after 0019 dropped the denormalised one), reproducing Django's
  // `get_object_or_404(FoodbankLocation, slug=locslug, foodbank=foodbank)`.
  // Location slugs are only unique per food bank, so without that filter this
  // would serve Dundee's Lochee map at Salisbury's URL.
  it("does not accept a location slug that belongs to a different food bank", async () => {
    seedFoodbank({ id: DUNDEE, slug: "dundee", latLng: DUNDEE_LAT_LNG, noLocations: 1 });
    seedLocation({ id: 502, foodbankId: DUNDEE, slug: "lochee", latLng: "56.4700,-3.0200" });

    await expect(backfillMapImage(env, "media/needs/at/salisbury/lochee/map.png")).rejects.toThrow(
      "media-backfill: no location for salisbury/lochee (media/needs/at/salisbury/lochee/map.png)",
    );
    expect(fetchedUrls).toEqual([]);
  });

  it("throws for an unknown location slug, without calling Google", async () => {
    await expect(backfillMapImage(env, "media/needs/at/salisbury/vanished/map.png")).rejects.toThrow(
      "media-backfill: no location for salisbury/vanished",
    );
    expect(fetchedUrls).toEqual([]);
  });

  // The food bank is looked up FIRST, so a location key under a dead slug reports
  // the food bank as missing rather than the location. The distinction is the
  // whole value of the jobs-dlq log line.
  it("reports the FOOD BANK as missing when a location key names a dead slug", async () => {
    await expect(backfillMapImage(env, "media/needs/at/vanished/branch-street/map.png")).rejects.toThrow(
      "media-backfill: no foodbank for slug vanished (media/needs/at/vanished/branch-street/map.png)",
    );
  });

  // The size check runs before either lookup on this branch too, so an invalid
  // size costs neither a D1 read nor a Google call.
  it("throws for an invalid size on a location key before doing any work", async () => {
    await expect(backfillMapImage(env, "media/needs/at/salisbury/branch-street/maps/450.png")).rejects.toThrow(
      "media-backfill: invalid map size 450 for media/needs/at/salisbury/branch-street/maps/450.png",
    );
    expect(sessionModes).toEqual([]); // not even a session was opened
    expect(fetchedUrls).toEqual([]);
  });
});

// ===========================================================================
// backfillMapImage -- the boundary polygon
// ===========================================================================
//
// gfwfbn/views.py:895-921, plus givefood/utils/geo.py:179-187's geojson_dict.
// `boundary_geojson` is a raw, unvalidated Textarea an admin pastes into, so
// every shape below is a shape production genuinely holds.

describe("backfillMapImage: boundary polygon", () => {
  const PATH_PREFIX = "fillcolor:0xf7a72333|color:0xf7a723ff|weight:1";

  function seedBoundary(raw: string): void {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG, noLocations: 1 });
    seedLocation({ id: 501, foodbankId: SALISBURY, slug: "branch-street", latLng: "51.0777,-1.7833", boundaryGeojson: raw });
  }

  async function pathFor(raw: string): Promise<string | null> {
    seedBoundary(raw);
    await backfillMapImage(env, "media/needs/at/salisbury/branch-street/map.png");
    return requestParams().get("path");
  }

  // THE LNG/LAT SWAP, which is the single easiest thing to get wrong here and the
  // hardest to notice: GeoJSON stores [lng, lat] and Google Static Maps wants
  // "lat,lng" (views.py:917-919's own comment). Swapped, a Salisbury boundary is
  // drawn in the Atlantic off Somalia -- on a map that still returns 200 and still
  // caches for a week. The exact string is asserted, prefix included.
  it("emits lat,lng points from [lng, lat] GeoJSON, behind Django's orange fill", async () => {
    const path = await pathFor(
      polygonFeature([
        [-1.7945, 51.0688],
        [-1.79, 51.07],
        [-1.8, 51.06],
        [-1.7945, 51.0688],
      ]),
    );

    expect(path).toBe(`${PATH_PREFIX}|51.0688,-1.7945|51.0700,-1.7900|51.0600,-1.8000|51.0688,-1.7945`);
  });

  // 4dp, always -- views.py:919's "%.4f", which pads as well as truncates. ~11m
  // of accuracy, chosen for URL length rather than fidelity. A stray extra digit
  // per point is ~1 byte x up to 126 points against Google's URL limit.
  //
  // The third point is the interesting one and the reason it is here: 51.06885
  // LOOKS like a tie that should round up, and rounds DOWN, because the nearest
  // double to it is 51.068849999... -- below the midpoint. Node v24.15.0 and
  // Python 3.13.0 were both run on this machine and both answer 51.0688, so the
  // port matches Django here; the first point (51.068851, genuinely above the
  // midpoint) rounds up in both. See the tie test below for the one case where
  // the two languages actually disagree.
  it("rounds every coordinate to exactly four decimal places, padding short ones", async () => {
    const path = await pathFor(
      polygonFeature([
        [-1.794551, 51.068851],
        [-2, 52],
        [-1.79455, 51.06885],
      ]),
    );

    expect(path).toBe(`${PATH_PREFIX}|51.0689,-1.7946|52.0000,-2.0000|51.0688,-1.7946`);
  });

  // DIVERGENCE, on exact binary ties only. JS `toFixed` rounds a tie to the
  // larger magnitude; CPython's "%.4f" rounds half to even. VERIFIED BY RUNNING
  // BOTH on this machine (node v24.15.0, Python 3.13.0): 0.15625 -- which is
  // 5/32, so exactly representable and an exact tie at 4dp -- gives "0.1563" from
  // toFixed and "0.1562" from "%.4f". It needs a dyadic-rational coordinate to
  // bite, which real GPS data essentially never produces, so this is a
  // completeness note rather than a live defect. Every other value tried
  // (51.06885, -1.79455, 1.23445, 55.95315, 2.00005, 0.00005) agreed exactly.
  it("DIVERGENCE: rounds an exact 4dp tie away from zero, where CPython rounds half to even", async () => {
    const path = await pathFor(polygonFeature([[0.15625, 51.0]]));

    expect(path).toBe(`${PATH_PREFIX}|51.0000,0.1563`); // Django would have written 0.1562
  });

  // geo.py:179-187 geojson_dict strips ONE trailing comma after .strip(), and
  // givefood/tests/test_utils.py:218-222 is Django's own test for it. It exists
  // because admins paste GeoJSON out of larger documents and bring the separator
  // with them. Without the strip the whole boundary is silently dropped.
  it("parses a boundary with the trailing comma admins paste in, as Django's geojson_dict does", async () => {
    const path = await pathFor(`${polygonFeature([[-1.7945, 51.0688]])},`);

    expect(path).toBe(`${PATH_PREFIX}|51.0688,-1.7945`);
  });

  it("parses a boundary wrapped in whitespace and newlines", async () => {
    const path = await pathFor(`\n  ${polygonFeature([[-1.7945, 51.0688]])}  \n`);

    expect(path).toBe(`${PATH_PREFIX}|51.0688,-1.7945`);
  });

  // THE ONLY INPUTS FOR WHICH THE `.trim()` DOES ANY WORK. JSON.parse already
  // skips ordinary leading whitespace, so deleting the trim leaves the test above
  // green -- it takes a character that JS calls whitespace and JSON does not to
  // see it. Both of these come from real pasting: a non-breaking space out of a
  // rendered web page, and a BOM out of a Windows-saved .geojson file.
  //
  // The BOM case is a DIVERGENCE, verified by running both on this machine (node
  // v24.15.0, Python 3.13.0): JS `trim()` removes U+FEFF, Python's `str.strip()`
  // does not ('﻿'.isspace() is False), so Django's json.loads raises and the
  // boundary is silently dropped where the port draws it. The NBSP case matches
  // (Python calls U+00A0 whitespace).
  it.each([
    [" ", "a non-breaking space"],
    ["﻿", "a byte-order mark, which Django's strip() would NOT remove"],
  ])("parses a boundary prefixed with %j (%s)", async (prefix) => {
    const path = await pathFor(`${prefix}${polygonFeature([[-1.7945, 51.0688]])}`);

    expect(path).toBe(`${PATH_PREFIX}|51.0688,-1.7945`);
  });

  // The comma-then-whitespace order Django's strip() handles and the port's
  // /,\s*$/ handles too, just in one step instead of two.
  it("parses a trailing comma followed by whitespace", async () => {
    const path = await pathFor(`${polygonFeature([[-1.7945, 51.0688]])},\n `);

    expect(path).toBe(`${PATH_PREFIX}|51.0688,-1.7945`);
  });

  // Only ONE comma is stripped, so a doubled one still fails to parse -- and
  // fails the way the good path does, by dropping the boundary rather than
  // throwing. Django reaches the same end through json.JSONDecodeError in its
  // except clause (views.py:920-921).
  it("drops the boundary for a DOUBLE trailing comma, since only one is stripped", async () => {
    expect(await pathFor(`${polygonFeature([[-1.7945, 51.0688]])},,`)).toBeNull();
  });

  // Everything that is valid JSON but not a Polygon Feature. Django guards with
  // `boundary_dict.get("geometry")` and `== "Polygon"` (views.py:897); each of
  // these silently yields no path, which is right -- a Point has no outline and
  // a MultiPolygon's coordinates are nested one level deeper, so drawing
  // `coordinates[0]` would emit garbage.
  it.each([
    ['{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.79, 51.06]}}', "a Point"],
    ['{"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": [[[[-1.79, 51.06]]]]}}', "a MultiPolygon"],
    ['{"type": "Feature", "properties": {}}', "no geometry at all"],
    ['{"type": "Polygon", "coordinates": [[[-1.79, 51.06]]]}', "a bare geometry with no Feature wrapper"],
    ['{"type": "Feature", "geometry": {"type": "Polygon"}}', "a Polygon with no coordinates"],
    ['{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": []}}', "a Polygon with an empty ring list"],
    ['{"type": "Feature", "geometry": {"type": "polygon", "coordinates": [[[-1.79, 51.06]]]}}', "lowercase 'polygon'"],
    ["not json at all", "free text an admin typed"],
    ["null", "the JSON literal null"],
  ])("draws no path for %s (%s)", async (raw) => {
    expect(await pathFor(raw)).toBeNull();
  });

  // Only the OUTER RING is drawn (views.py:899's `coordinates[0]  # Get outer
  // ring`). A polygon with a hole would otherwise emit its hole's points as a
  // second, unconnected run of the same path.
  it("draws only the outer ring of a polygon that has a hole", async () => {
    const path = await pathFor(
      JSON.stringify({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-1.8, 51.0],
              [-1.7, 51.0],
              [-1.7, 51.1],
            ],
            [
              [-9.9, 9.9],
              [-9.8, 9.9],
            ],
          ],
        },
      }),
    );

    expect(path).toBe(`${PATH_PREFIX}|51.0000,-1.8000|51.0000,-1.7000|51.1000,-1.7000`);
    expect(path).not.toContain("9.9"); // the hole contributed nothing
  });

  // ---------------------------------------------------------------------------
  // Simplification (views.py:903-912)
  // ---------------------------------------------------------------------------
  //
  // The point counts below were CROSS-CHECKED AGAINST CPYTHON: the Django
  // algorithm was transcribed into a scratch script and run under Python 3.13.0
  // on this machine alongside the port's own arithmetic, for n = 100, 101, 150,
  // 250 and 1000 plus the closed-ring case. Every count matched. The port's
  // `Math.floor(n / 100)` and Python's `n // 100` agree for positive ints, and
  // `simplified.some(...)` reproduces Python's value-equality `not in`.

  /** How many "lat,lng" points a path parameter carries, ignoring the style prefix. */
  function pointCount(path: string): number {
    return path.split("|").length - 3;
  }

  // At or under the limit, nothing is dropped -- so a 100-point boundary is drawn
  // exactly as pasted.
  it("keeps all 100 points of a boundary at the limit", async () => {
    const path = await pathFor(polygonFeature(ringOf(100)));

    expect(pointCount(path!)).toBe(100);
    expect(path!.endsWith("|50.0099,0.0099")).toBe(true); // the 100th point, 4dp
  });

  // step = max(2, floor(101/100)) = 2. The floor would be 1 -- i.e. no reduction
  // at all -- which is exactly what the max(2, ...) exists to prevent, and which
  // a naive `floor` alone would leave at 101 points.
  it("halves a 101-point boundary, because the step floor is clamped to 2", async () => {
    const path = await pathFor(polygonFeature(ringOf(101)));

    expect(pointCount(path!)).toBe(51);
    expect(path!.startsWith(`${PATH_PREFIX}|50.0000,0.0000|50.0002,0.0002|`)).toBe(true); // every second point
  });

  // THE LIMIT IS NOT A LIMIT. 250 points at step 2 gives 125 kept plus the
  // appended last one = 126, comfortably over the max_points of 100 the code's
  // own comment claims. This is Django's arithmetic, ported faithfully
  // (confirmed at 126 in CPython), so it is pinned rather than reported as a
  // defect in this repo -- but a boundary of a few thousand points can still
  // produce a URL long enough for Google to reject.
  it("emits 126 points for a 250-point boundary -- the 'max 100' is not enforced", async () => {
    const path = await pathFor(polygonFeature(ringOf(250)));

    expect(pointCount(path!)).toBe(126);
    expect(path!.endsWith("|50.0249,0.0249")).toBe(true); // the true last point, appended
  });

  // A big one: step = floor(1000/100) = 10, giving indices 0, 10, ... 990 = 100
  // points, plus index 999 which the step misses. The appended tail is the whole
  // reason for the `if (!simplified.some(...))` -- without it the drawn polygon
  // stops short of closing.
  it("appends the true last point that the step misses, closing a 1000-point ring", async () => {
    const path = await pathFor(polygonFeature(ringOf(1000)));

    expect(pointCount(path!)).toBe(101);
    expect(path!.endsWith("|50.0999,0.0999")).toBe(true);
  });

  // ...and does NOT append it when the step already kept a point with the same
  // VALUE, which is what a properly closed ring (first point == last point) looks
  // like. Python's `coordinates[-1] not in simplified` compares by value, and the
  // port's `some(([lng, lat]) => ...)` does too -- an identity check (`includes`)
  // would duplicate the closing point on every closed boundary in the database.
  it("does not duplicate the closing point of a ring whose last point repeats its first", async () => {
    const ring = ringOf(250);
    ring[249] = [ring[0]![0], ring[0]![1]]; // a closed ring, a fresh array with equal values

    const path = await pathFor(polygonFeature(ring));

    expect(pointCount(path!)).toBe(125); // 126 if the value check were an identity check
    expect(path!.endsWith("|50.0248,0.0248")).toBe(true);
  });

  // ...and the LATITUDE half of that comparison is load-bearing on its own. Every
  // other ring in this file walks a diagonal, where lng and lat move together, so
  // `lng === last[0] && lat === last[1]` and a lng-only check agree on all of
  // them -- deleting `&& lat === last[1]` left the whole file green. A boundary
  // that returns to the same meridian at a different latitude (every rectangle
  // does) separates them: the lng-only version decides the closing point is
  // already in the sample, and the drawn polygon stops short of closing.
  it("appends a closing point that shares a longitude with a kept point but not its latitude", async () => {
    const ring = ringOf(250);
    ring[249] = [ring[0]![0], 51.5]; // the kept point at index 0's lng, a different lat

    const path = await pathFor(polygonFeature(ring));

    expect(pointCount(path!)).toBe(126); // 125 if the check compared lng alone
    expect(path!.endsWith("|51.5000,0.0000")).toBe(true);
  });

  // A Polygon whose outer ring is EMPTY still gets a `path` parameter -- one with
  // no points in it, which Google answers 400 for, so the location loses its map
  // and the message dead-letters. `coordinates?.[0]` is truthy for `[]`, so the
  // guard that rejects a MISSING ring does not reject an empty one. SUSPECT and
  // pinned rather than fixed; it also holds that guard's current shape down,
  // since adding `?.length` to it turns this into no path at all.
  it("SUSPECT: still emits a pointless path parameter for a polygon with an empty outer ring", async () => {
    expect(await pathFor('{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[]]}}')).toBe(PATH_PREFIX);
  });
});

// ===========================================================================
// backfillMapImage -- failure and redelivery
// ===========================================================================

describe("backfillMapImage: failure and redelivery", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latLng: SALISBURY_LAT_LNG, noLocations: 1 });
    seedLocation({ id: 501, foodbankId: SALISBURY, slug: "branch-street", latLng: "51.0777,-1.7833" });
  });

  // A non-200 from Google throws, and the error names the CENTRE rather than the
  // key -- which is the only identifying detail the jobs-dlq line will carry.
  // Pinned because a 5xx here is transient (queues/jobs.ts retries it) and a
  // message that cannot be traced back to a food bank is the exact failure mode
  // jobsDlq.ts's own header describes.
  it.each([500, 502, 503, 403, 400])("throws on an upstream %s, storing nothing", async (status) => {
    staticMapReply = { status, body: "upstream said no" };

    await expect(backfillMapImage(env, "media/needs/at/salisbury/map.png")).rejects.toThrow(
      `staticmap: upstream ${status} for ${SALISBURY_LAT_LNG}`,
    );
    expect(media.size).toBe(0);
  });

  // WHICH STATUSES COUNT AS SUCCESS is `response.ok` -- the whole 2xx band -- and
  // not `status === 200`. Nothing else in this file tells the two apart, so
  // narrowing the check to 200 passed every test. It is also a small DIVERGENCE:
  // Django's food bank view is `if response.status_code != 200`
  // (gfwfbn/views.py:485-486), so it would reject what the port stores. Pinned
  // with a 206, the plausible case (a proxy or CDN in front of Google answering a
  // ranged request), and SUSPECT to the extent that any 2xx carrying an error
  // body is then cached under this key for a week.
  it("treats a 2xx that is not 200 as success and stores the bytes", async () => {
    staticMapReply = { status: 206, body: PNG_BYTES };

    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    const stored = media.get("media/needs/at/salisbury/map.png");
    expect(Array.from(stored!.body)).toEqual(Array.from(PNG_BYTES));
  });

  // DIVERGENCE: Django's LOCATION view has no status check at all
  // (views.py:925-927 hands `response.content` straight to HttpResponse), so a
  // 403 there was served to the visitor as a 200 image/png containing Google's
  // error text. The port checks both branches. This is the credential-broke-
  // silently case -- an unbilled key answers 403 -- and it is why the port
  // throwing is the better behaviour even though it diverges.
  it("throws on an upstream error for a LOCATION map too, unlike Django's unchecked location view", async () => {
    staticMapReply = { status: 403, body: "The provided API key is expired." };

    await expect(backfillMapImage(env, "media/needs/at/salisbury/branch-street/map.png")).rejects.toThrow(
      "staticmap: upstream 403 for 51.0777,-1.7833",
    );
    expect(media.size).toBe(0);
  });

  // A rejected fetch -- DNS, TLS, an aborted socket -- propagates unchanged
  // rather than being turned into the module's own error. Worth pinning
  // separately from the non-200 case: the two reach jobs-dlq with completely
  // different text, and only one of them mentions this module at all.
  it("lets a rejected fetch propagate as-is", async () => {
    staticMapReply = new Error("Network connection lost.");

    await expect(backfillMapImage(env, "media/needs/at/salisbury/map.png")).rejects.toThrow("Network connection lost.");
    expect(media.size).toBe(0);
  });

  // The put is the LAST thing that happens, so this is the case where the billed
  // Google call has already been made and paid for -- and the retry will make it
  // again. Pinned as the cost of the current ordering rather than presented as
  // ideal; there is no cheaper ordering available, since the bytes have to exist
  // before they can be stored.
  it("propagates an R2 failure, having already paid for the Google call", async () => {
    mediaPutError = new Error("R2: internal error");

    await expect(backfillMapImage(env, "media/needs/at/salisbury/map.png")).rejects.toThrow("R2: internal error");
    expect(fetchedUrls).toHaveLength(1);
    expect(media.size).toBe(0);
  });

  // THE SAME, ON THE LOCATION BRANCH, and it is its own test rather than a
  // parameterised one because the two branches each have their own
  // `await env.MEDIA.put(...)` line. MUTANT: dropping the `await` from the
  // location one -- exactly what a refactor drops -- survived the whole file,
  // because only the food bank branch had an R2 failure test. Unawaited, the
  // rejection escapes as an unhandled rejection, backfillMapImage RESOLVES, and
  // queues/jobs.ts (which acks on return and retries on throw) ACKS a message
  // whose PNG was never stored. routes/media.ts then 404s that key for ever and
  // re-enqueues on every request: a permanently missing map, and nothing
  // anywhere says so.
  it("propagates an R2 failure on the LOCATION branch too, rather than acking a map it never stored", async () => {
    mediaPutError = new Error("R2: internal error");

    await expect(backfillMapImage(env, "media/needs/at/salisbury/branch-street/map.png")).rejects.toThrow("R2: internal error");
    expect(fetchedUrls).toHaveLength(1);
    expect(media.size).toBe(0);
  });

  // A D1 failure on the FIRST statement (the getFoodbankBySlug batch) escapes
  // before anything is billed. The equivalent for the location branch is below.
  it("propagates a D1 failure on the food bank lookup, without calling Google", async () => {
    failIf = (sql) => (sql.includes("FROM foodbank WHERE slug") ? new Error("D1_ERROR: Network connection lost") : null);

    await expect(backfillMapImage(env, "media/needs/at/salisbury/map.png")).rejects.toThrow("D1_ERROR: Network connection lost");
    expect(fetchedUrls).toEqual([]);
  });

  // The satellite queries are NOT wrapped in anything either, so a D1 blip while
  // fetching donation points fails the whole map rather than producing one with
  // fewer pins. That is the right side of the trade -- a silently pin-less map
  // caches for a week -- and it is pinned so that "just catch and continue" is a
  // visible decision.
  it("fails the whole map when the donation-point query fails, rather than dropping the pins", async () => {
    db.prepare("UPDATE foodbank SET no_donation_points = 1 WHERE id = ?").run(SALISBURY);
    seedDonationPoint({ id: 601, foodbankId: SALISBURY, name: "Tesco", latLng: "51.0600,-1.8100" });
    failIf = (sql) => (sql.includes("foodbankdonationpoint_full") ? new Error("D1_ERROR: Network connection lost") : null);

    await expect(backfillMapImage(env, "media/needs/at/salisbury/map.png")).rejects.toThrow("D1_ERROR: Network connection lost");
    expect(fetchedUrls).toEqual([]);
    expect(media.size).toBe(0);
  });

  it("propagates a D1 failure on the location lookup, without calling Google", async () => {
    failIf = (sql) => (sql.includes("foodbanklocation_full") ? new Error("D1_ERROR: Network connection lost") : null);

    await expect(backfillMapImage(env, "media/needs/at/salisbury/branch-street/map.png")).rejects.toThrow("D1_ERROR: Network connection lost");
    expect(fetchedUrls).toEqual([]);
  });

  // AT-LEAST-ONCE DELIVERY, AND NO GUARD AGAINST IT. Cloudflare Queues can
  // deliver the same message twice, and routes/media.ts can enqueue twice for two
  // requests racing the same 404. The sibling backfillPlacePhoto opens with an
  // `env.MEDIA.head(key)` check for exactly this; backfillMapImage has none, so a
  // redelivery buys a second Static Maps call and overwrites an identical object.
  //
  // SUSPECT, pinned rather than fixed: it is a billed call with no idempotency
  // guard, and the asymmetry with the photo branch four files away is what makes
  // it look unintended rather than chosen. queues/jobs.test.ts pins the same
  // behaviour from the consumer's side.
  it("SUSPECT: re-fetches and re-puts on a second delivery, with no R2 head guard", async () => {
    await backfillMapImage(env, "media/needs/at/salisbury/map.png");
    await backfillMapImage(env, "media/needs/at/salisbury/map.png");

    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls[0]).toBe(fetchedUrls[1]); // byte-identical requests: nothing was gained
    expect(media.size).toBe(1);
  });

  // ...and the second delivery is at least IDEMPOTENT in its effect: the same
  // key, the same bytes, the same metadata. If the second put ever wrote
  // different bytes for the same key, a redelivery would change what visitors see
  // for a week with nothing in the logs to say why.
  it("leaves the same object behind after a redelivery, whatever it cost", async () => {
    await backfillMapImage(env, "media/needs/at/salisbury/map.png");
    const first = media.get("media/needs/at/salisbury/map.png")!;

    staticMapReply = { status: 200, body: PNG_BYTES };
    await backfillMapImage(env, "media/needs/at/salisbury/map.png");
    const second = media.get("media/needs/at/salisbury/map.png")!;

    expect(second.key).toBe(first.key);
    expect(Array.from(second.body)).toEqual(Array.from(first.body));
    expect(second.httpMetadata).toEqual(first.httpMetadata);
  });
});
