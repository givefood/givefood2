import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import { backfillPlacePhoto, isPlacePhotoKey } from "./placePhoto";
import type { Env } from "../../worker-configuration";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning, as
// packages/db/src/schema.testkit.ts:35 and queues/jobs.test.ts:10.
import { DatabaseSync } from "node:sqlite";

// mediaBackfill/placePhoto.ts -- the half of the media-backfill consumer that
// buys photographs from Google, ported from givefood/utils/geo.py:107-141
// photo_from_place_id() behind gfwfbn/views.py:493-505 foodbank_photo() and
// its two siblings.
//
// WHY THIS MODULE IS WORTH THIS MUCH TEST. Two things make it unusual:
//
//   1. EVERY CALL IT MAKES IS BILLED. A Place Details lookup and a Place
//      Photo fetch, per photo, on an account whose whole reason for moving
//      this work out of the request path (PLAN.md §3.7) was that Django
//      re-proxied Google on every cache miss. A guard that stops working
//      does not fail -- it spends.
//   2. NOTHING WATCHES IT. It runs as a queue consumer, so its only visible
//      output on an ordinary day is a console.log line. That is why the
//      assertions below read the LOG TEXT as carefully as they read the R2
//      object: on the quiet paths the log line is the entire product, and
//      this is the codebase where a Browser Rendering credential broke for a
//      day because nobody could see it.
//
// THE CENTRAL DISTINCTION, and the reason for the shape of this file: the
// module's own comment says "EVERY 'no photo here' OUTCOME RETURNS QUIETLY
// rather than throwing", because a throw is a queue retry and then jobs-dlq.
// So each test below pins one condition to one side of that line:
//
//   returns  -> queues/jobs.ts acks. The message is gone. Correct for a
//               permanent answer ("this place has no photograph"), because
//               retrying it three times is pure cost for the same answer.
//   throws   -> wrangler.jsonc's max_retries: 3 then jobs-dlq. Correct for a
//               Google outage or a rejected key, which a later attempt fixes.
//
// REAL THINGS, NOT MOCKS:
//   * node:sqlite carrying the WHOLE real migration set. Not schemaFor(...):
//     this module reaches `foodbank`, `placephoto` and THREE VIEWS --
//     `foodbankchange_full` (through getFoodbankBySlug's batch, which is what
//     the github #51 gap was: a shared query starting to read a view the
//     narrow fixtures lacked), `foodbanklocation_full` and
//     `foodbankdonationpoint_full`. Running the migrations also forces every
//     seed below to satisfy the real NOT NULL columns, and 0019 both drops
//     columns from these tables and recreates the views, so no regex over the
//     CREATE TABLE text would give the right answer anyway.
//   * the real packages/db functions -- getFoodbankBySlug,
//     getFoodbankLocationBySlugs, getDonationPointBySlugs, upsertPlacePhoto --
//     running their real SQL, including upsertPlacePhoto's real
//     ON CONFLICT(place_id) and its two real UNIQUE indexes.
//
// MOCKED, and only this: `fetch` (the two billed Google endpoints) and the R2
// bucket, which is the one dependency with no node-side double at all.

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

/**
 * The D1 Sessions API surface packages/db uses, over the real engine.
 *
 * `batch()` is not decoration: getFoodbankBySlug -- the lookup for the
 * `at/<slug>/photo.jpg` shape, i.e. the commonest key this consumer sees -- is
 * implemented as a two-statement batch and indexes `results[0]!.results`. A
 * session double without it would fail that shape with a TypeError, which
 * queues/jobs.ts would turn into a retry: it would look exactly like the
 * Google outage these tests are trying to tell apart from a working lookup.
 *
 * `first()` answers null, never undefined, because the db layer tests `if (!row)`.
 */
interface BatchableStatement {
  __exec: () => { results: Record<string, unknown>[]; success: true; meta: Record<string, unknown> };
}

/**
 * ONE ordered trace of every observable side effect -- D1, R2 and the network
 * interleaved -- because the interesting property of this module is the ORDER
 * of the three: HEAD before the billed calls (or the idempotency guard buys
 * nothing) and PUT before the D1 write (which is what makes the photo_ref
 * collision below unrecoverable). Three separate arrays cannot express that.
 */
let events: string[];

/**
 * The operation and its target table, not the SQL text: the statements come out
 * of packages/db, and pinning their exact wording here would make this suite
 * fail for edits that have nothing to do with this module.
 */
function sqlTag(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  const parsed = /^(SELECT|INSERT INTO|UPDATE|DELETE FROM)\s+(?:\*\s+FROM\s+)?([A-Za-z_]+)/i.exec(flat);
  return parsed ? `d1 ${parsed[1]!.toUpperCase()} ${parsed[2]}` : `d1 ${flat.slice(0, 30)}`;
}

function d1Session(): unknown {
  function statement(sql: string, params: Bindable[]): unknown {
    return {
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T>() => {
        events.push(sqlTag(sql));
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      all: async <T>() => {
        events.push(sqlTag(sql));
        return { results: db.prepare(sql).all(...params) as T[], success: true, meta: {} };
      },
      run: async () => {
        events.push(sqlTag(sql));
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      // node:sqlite's all() executes writes perfectly well and answers [], so
      // one code path serves both halves of a batch.
      __exec: () => {
        events.push(sqlTag(sql));
        return { results: db.prepare(sql).all(...params), success: true as const, meta: {} };
      },
    };
  }
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (batched: BatchableStatement[]) => batched.map((s) => s.__exec()),
    getBookmark: () => null,
  };
}

/** Every bookmark mode handed to env.DB.withSession(), in order. */
let sessionModes: string[];

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

interface StoredObject {
  key: string;
  body: Uint8Array;
  etag: string;
  httpMetadata: Record<string, unknown>;
}

let media: Map<string, StoredObject>;
/** Set to make the next MEDIA.put reject, for the "R2 is down" test. */
let mediaPutError: Error | null;
let etagCounter: number;
/** Ordered trace of the bucket operations, so "head before fetch" is observable. */
let mediaOps: string[];

/**
 * An in-memory R2 bucket -- a stand-in, not the real thing, but with real
 * semantics for the two operations that carry logic here: `head` answers null
 * for a key never put (the whole idempotency guard hangs off exactly that), and
 * `put` answers an object whose `etag` is the value stored as `placephoto.md5`.
 * The etag is a counter so a test can prove the md5 came from the put RESULT
 * and not from anywhere else -- and, in the re-fetch test, that it was refreshed
 * rather than left at the first value.
 */
function mediaBucket(): unknown {
  return {
    head: async (key: string) => {
      mediaOps.push(`head ${key}`);
      events.push(`r2 head ${key}`);
      return media.get(key) ?? null;
    },
    put: async (key: string, value: ArrayBuffer, options?: { httpMetadata?: Record<string, unknown> }) => {
      mediaOps.push(`put ${key}`);
      events.push(`r2 put ${key}`);
      if (mediaPutError) throw mediaPutError;
      const stored: StoredObject = {
        key,
        body: new Uint8Array(value),
        etag: `etag-${++etagCounter}`,
        httpMetadata: options?.httpMetadata ?? {},
      };
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

let replies: Map<string, Reply[]>;
let fetchCalls: string[];

/** origin + pathname, i.e. the URL with the query string (which carries the API key) dropped. */
function routeKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function reply(route: string, ...queue: Reply[]): void {
  replies.set(route, queue);
}

const PLACE_DETAILS = "https://maps.googleapis.com/maps/api/place/details/json";
const PLACE_PHOTO = "https://maps.googleapis.com/maps/api/place/photo";

function stubFetch(): void {
  vi.stubGlobal("fetch", async (input: unknown): Promise<Response> => {
    const url = String(input);
    fetchCalls.push(url);
    events.push(`fetch ${routeKey(url)}`);
    const queue = replies.get(routeKey(url));
    // An unmodelled URL is a test bug, never a silent default: a third billed
    // endpoint added to this module later must fail loudly here rather than be
    // absorbed by some catch block.
    if (!queue || queue.length === 0) throw new Error(`unmodelled fetch: ${url}`);
    const next = queue.length === 1 ? queue[0]! : queue.shift()!;
    if (next instanceof Error) throw next;
    return new Response(next.body as BodyInit, { status: next.status });
  });
}

/** Real JPEG magic bytes, so "what landed in R2" is a byte comparison, not a length one. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
/** A second, DIFFERENT body, for the re-fetch test -- so "the object was replaced" is provable. */
const JPEG_BYTES_2 = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);

/** A Place Details 200 whose `photos` array is whatever the caller passes. */
function detailsOk(...photos: unknown[]): Reply {
  return { status: 200, body: JSON.stringify({ status: "OK", result: { photos } }) };
}

// ---------------------------------------------------------------------------
// The env, and the fixtures
// ---------------------------------------------------------------------------

let env: Env;
/** Every console.log line -- on the quiet paths this is the module's ONLY output. */
let logs: string[];

// Deliberately distinct place ids for the four seeded places, and deliberately
// CROSS-WIRED slugs (see seedAll): the three key shapes are three different db
// functions with two slug arguments each, and a fixture where the arguments
// could be swapped without changing the answer cannot see a transposition.
const FOODBANK_PLACE = "ChIJ-foodbank-salisbury";
const LOCATION_PLACE = "ChIJ-location-central";
const DONATIONPOINT_PLACE = "ChIJ-donationpoint-tesco";
const DECOY_PLACE = "ChIJ-decoy-dundee-central";

const SALISBURY = 22;
const DUNDEE = 41;

const FOODBANK_KEY = "media/needs/at/salisbury/photo.jpg";
const LOCATION_KEY = "media/needs/at/salisbury/central/photo.jpg";
const DONATIONPOINT_KEY = "media/needs/at/salisbury/donationpoint/tesco/photo.jpg";

interface FoodbankSeed {
  id: number;
  slug: string;
  placeId?: string | null;
  placeHasPhoto?: 0 | 1 | null;
}

/** Fills every NOT NULL column the real foodbank table declares. */
function seedFoodbank(seed: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       place_id, place_has_photo,
       address_is_administrative, is_closed, no_locations, no_donation_points,
       days_between_needs, created, modified
     ) VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.0688,-1.7945',
               0, ?, ?, ?, ?, ?, 0, 0, 0, 0, 14, ?, ?)`,
  ).run(
    seed.id,
    `uuid-${seed.slug}`,
    `${seed.slug} Foodbank`,
    seed.slug,
    `info@${seed.slug}.example`,
    `https://${seed.slug}.example/`,
    `https://${seed.slug}.example/shopping-list/`,
    seed.placeId ?? null,
    seed.placeHasPhoto ?? null,
    "2020-01-01 00:00:00.000000",
    "2026-08-01 09:15:22.412000",
  );
}

function seedLocation(seed: { id: number; foodbankId: number; slug: string; placeId?: string | null; placeHasPhoto?: 0 | 1 | null }): void {
  db.prepare(
    `INSERT INTO foodbanklocation (
       id, uuid, foodbank_id, name, slug, country, lat_lng,
       place_id, place_has_photo, is_closed, modified
     ) VALUES (?, ?, ?, ?, ?, 'England', '51.0688,-1.7945', ?, ?, 0, ?)`,
  ).run(
    seed.id,
    `uuid-loc-${seed.id}`,
    seed.foodbankId,
    `Location ${seed.id}`,
    seed.slug,
    seed.placeId ?? null,
    seed.placeHasPhoto ?? null,
    "2026-08-01 09:15:22.412000",
  );
}

function seedDonationPoint(seed: { id: number; foodbankId: number; slug: string; placeId?: string | null; placeHasPhoto?: 0 | 1 | null }): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (
       id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng,
       place_id, place_has_photo, is_closed, in_store_only, modified
     ) VALUES (?, ?, ?, ?, ?, '2 Market Place', 'SP1 1BB', 'England', '51.0688,-1.7945', ?, ?, 0, 0, ?)`,
  ).run(
    seed.id,
    `uuid-dp-${seed.id}`,
    seed.foodbankId,
    `Donation Point ${seed.id}`,
    seed.slug,
    seed.placeId ?? null,
    seed.placeHasPhoto ?? null,
    "2026-08-01 09:15:22.412000",
  );
}

/**
 * The standing fixture, built so that every wrong lookup has somewhere wrong to
 * land -- a filter that does nothing passes any fixture that only holds rows it
 * should match:
 *
 *   foodbank "salisbury"  -- the target of FOODBANK_KEY
 *     location "central"        -- the target of LOCATION_KEY
 *     donation point "tesco"    -- the target of DONATIONPOINT_KEY
 *   foodbank "dundee"
 *     location "central"        -- SAME SLUG, different parent. A lookup that
 *                                  dropped the foodbank_slug half of its WHERE
 *                                  would find this one.
 *   foodbank "central"          -- a food bank whose SLUG is the location slug,
 *     location "salisbury"         holding a location whose slug is the food
 *                                  bank's. A transposed argument pair
 *                                  (foodbankSlug <-> locationSlug) resolves
 *                                  here instead, with a different place_id.
 */
function seedAll(): void {
  seedFoodbank({ id: SALISBURY, slug: "salisbury", placeId: FOODBANK_PLACE, placeHasPhoto: 1 });
  seedLocation({ id: 1, foodbankId: SALISBURY, slug: "central", placeId: LOCATION_PLACE, placeHasPhoto: 1 });
  seedDonationPoint({ id: 1, foodbankId: SALISBURY, slug: "tesco", placeId: DONATIONPOINT_PLACE, placeHasPhoto: 1 });

  seedFoodbank({ id: DUNDEE, slug: "dundee", placeId: "ChIJ-foodbank-dundee", placeHasPhoto: 1 });
  seedLocation({ id: 2, foodbankId: DUNDEE, slug: "central", placeId: DECOY_PLACE, placeHasPhoto: 1 });

  seedFoodbank({ id: 77, slug: "central", placeId: "ChIJ-transposed-foodbank", placeHasPhoto: 1 });
  seedLocation({ id: 3, foodbankId: 77, slug: "salisbury", placeId: "ChIJ-transposed-location", placeHasPhoto: 1 });
  seedDonationPoint({ id: 2, foodbankId: 77, slug: "salisbury", placeId: "ChIJ-transposed-dp", placeHasPhoto: 1 });
}

function photoRows(): Record<string, unknown>[] {
  return db.prepare("SELECT place_id, photo_ref, html_attributions, r2_key, bytes, md5 FROM placephoto ORDER BY id").all();
}

beforeEach(() => {
  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(MIGRATIONS_SQL);

  media = new Map();
  mediaPutError = null;
  mediaOps = [];
  etagCounter = 0;

  replies = new Map();
  fetchCalls = [];
  events = [];
  sessionModes = [];
  logs = [];

  stubFetch();

  env = {
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session();
      },
    },
    MEDIA: mediaBucket(),
    GMAP_PLACES_KEY: "places-key",
  } as unknown as Env;

  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => String(a)).join(" ")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

// ===========================================================================
// isPlacePhotoKey
// ===========================================================================
//
// The gate queues/jobs.ts's handleMediaBackfill uses to decide whether a key is
// this module's business at all. It has two failure directions and they are not
// symmetrical:
//
//   too narrow -> the key falls through to handleMediaBackfill's
//                 "not implemented" throw, retries three times and lands in
//                 jobs-dlq. Noisy, recoverable, visible.
//   too wide   -> a key from some other family is handed to backfillPlacePhoto,
//                 which looks up a place that does not exist and returns
//                 QUIETLY. The message acks and nothing ever says so.
//
// The second is why the negative cases below are as detailed as the positive.

describe("isPlacePhotoKey", () => {
  // The three URL shapes gfwfbn/urls/generic.py:12-17 declares, spelled as R2
  // keys (routes/media.ts derives the key as "media" + url.pathname).
  it.each([
    ["media/needs/at/salisbury/photo.jpg", "the food bank's own photo"],
    ["media/needs/at/salisbury/donationpoint/tesco/photo.jpg", "a donation point photo"],
    ["media/needs/at/salisbury/central/photo.jpg", "a location photo"],
  ])("accepts %s (%s)", (key) => {
    expect(isPlacePhotoKey(key)).toBe(true);
  });

  // The other media families that share the `media/needs/at/<slug>/` prefix.
  // These are handled elsewhere -- map.png/maps/<size>.png by mapImage.ts,
  // favicon.png and screenshots/*.png not by this Worker at all -- and
  // claiming one here would mean an R2 miss on a map silently acking with a
  // "no place for" log instead of reaching the Static Maps backfill.
  it.each([
    ["media/needs/at/salisbury/map.png", "mapImage.ts's territory"],
    ["media/needs/at/salisbury/maps/300.png", "mapImage.ts's sized variant"],
    ["media/needs/at/salisbury/central/map.png", "a location map"],
    ["media/needs/at/salisbury/favicon.png", "routes/wfbn/favicon.ts, live and keyless"],
    ["media/needs/at/salisbury/screenshots/homepage.png", "routes/wfbn/screenshot.ts"],
    ["media/needs/at/salisbury/donationpoint/tesco/favicon.png", "a donation point favicon"],
  ])("rejects %s (%s)", (key) => {
    expect(isPlacePhotoKey(key)).toBe(false);
  });

  // The three patterns are anchored at both ends. Without ^ a key from any
  // other R2 namespace ending in this shape would be claimed; without $ a
  // query string or a suffix would be. Both would land on the silent side.
  it.each([
    ["/media/needs/at/salisbury/photo.jpg", "a leading slash -- routes/media.ts prepends 'media', it does not keep the slash"],
    ["cache/media/needs/at/salisbury/photo.jpg", "some other namespace with the shape embedded"],
    ["media/needs/at/salisbury/photo.jpg?s=540", "a query string that belongs in the URL, never in the key"],
    ["media/needs/at/salisbury/photo.jpg/", "a trailing slash"],
    ["media/needs/at/salisbury/photo.jpeg", "the four-letter extension"],
    ["media/needs/at/salisbury/photo.JPG", "uppercase -- these regexes carry no /i flag"],
    ["media/needs/at/salisbury/photoxjpg", "the dot is escaped, so it matches a literal dot only"],
    ["media/needs/at//photo.jpg", "an empty slug -- [^/]+ needs at least one character"],
    ["media/needs/at/salisbury/a/b/c/photo.jpg", "four segments, matching none of the three shapes"],
    ["media/needs/salisbury/photo.jpg", "the 'at/' segment missing"],
    ["", "the empty string"],
  ])("rejects %s (%s)", (key) => {
    expect(isPlacePhotoKey(key)).toBe(false);
  });

  // THE SAME ANCHORS, ON THE OTHER TWO PATTERNS. Every case in the block above
  // is a FOOD BANK-shaped key, so all of them exercise FOODBANK_PHOTO_RE and
  // none of them reach the other two: a prefixed or suffixed food bank key has
  // the wrong segment count for LOCATION_PHOTO_RE (which wants three segments
  // after `at/`) and for DONATIONPOINT_PHOTO_RE (which wants four), so those
  // two patterns' own `^` and `$` were never tested at all.
  //
  // MUTANTS THIS KILLS -- all four SURVIVED this suite as first written, and
  // each is a one-character edit:
  //   * `^` removed from LOCATION_PHOTO_RE
  //   * `$` removed from LOCATION_PHOTO_RE
  //   * `^` removed from DONATIONPOINT_PHOTO_RE
  //   * `photo\.jpg` unescaped to `photo.jpg` in DONATIONPOINT_PHOTO_RE
  // Widening the gate is the failure direction that leaves no evidence (see the
  // block comment above): queues/jobs.ts hands the wider key straight to
  // backfillPlacePhoto, which resolves no place, logs one line and acks.
  it.each([
    ["cache/media/needs/at/salisbury/central/photo.jpg", "a LOCATION shape embedded in another namespace -- kills LOCATION_PHOTO_RE losing its ^"],
    ["cache/media/needs/at/salisbury/donationpoint/tesco/photo.jpg", "a DONATION POINT shape in another namespace -- kills DONATIONPOINT_PHOTO_RE losing its ^"],
    ["media/needs/at/salisbury/central/photo.jpg?s=540", "a location key that kept the ?s= routes/media.ts strips -- kills LOCATION_PHOTO_RE losing its $"],
    ["media/needs/at/salisbury/donationpoint/tesco/photo.jpg?s=540", "the same suffix on the donation point shape"],
    ["media/needs/at/salisbury/central/photo.jpg/", "a trailing slash on the location shape"],
    ["media/needs/at/salisbury/donationpoint/tesco/photo.jpg/", "a trailing slash on the donation point shape"],
    ["media/needs/at/salisbury/central/photo.JPG", "uppercase -- neither of these two carries /i either"],
    ["media/needs/at/salisbury/donationpoint/tesco/photo.JPG", "the same on the donation point shape"],
    ["media/needs/at/salisbury/central/photoxjpg", "the dot is escaped in the location pattern too"],
    ["media/needs/at/salisbury/donationpoint/tesco/photoxjpg", "and in the donation point pattern -- the last surviving mutant of the review pass was `photo\\.jpg` unescaped to `photo.jpg` in DONATIONPOINT_PHOTO_RE alone"],
    ["media/needs/at//central/photo.jpg", "an empty food bank slug in the location shape"],
    ["media/needs/at/salisbury//photo.jpg", "an empty location slug -- the quantifier is +, not *"],
    ["media/needs/at/salisbury/donationpoint//photo.jpg", "an empty donation point slug"],
  ])("rejects %s (%s)", (key) => {
    expect(isPlacePhotoKey(key)).toBe(false);
  });

  // The module's header warns that "the two-segment location pattern also
  // matches a donation point path with locslug='donationpoint', so the donation
  // point shape has to be tested first". As written that hazard cannot actually
  // bite: DONATIONPOINT_PHOTO_RE needs four path segments after `at/` and
  // LOCATION_PHOTO_RE exactly three, so no string satisfies both. What the
  // location pattern DOES accept is a three-segment path whose location slug is
  // the literal word "donationpoint" -- a real food bank could have one -- and
  // that is a location key, correctly.
  //
  // Pinned rather than "fixed": the ordering is still load-bearing in
  // routes/media.ts and in gfwfbn/urls/generic.py, where Hono and Django match
  // by segment and register in this same order. Reordering the three constants
  // here would be harmless today and a trap the day a pattern grows a `.*`.
  //
  // MEASURED, on the review pass, in a copy of the repo under the scratchpad
  // (never in src/): 73 mutants in a first sweep, then 19 more aimed at what
  // that sweep under-probed -- chiefly the location and donation point patterns,
  // whose operators nothing had reached. Every one of them now fails the suite
  // except two EQUIVALENT MUTANTS, which are the same fact stated twice:
  //
  //   * resolvePlace rewritten to try LOCATION_PHOTO_RE before
  //     DONATIONPOINT_PHOTO_RE;
  //   * the donation point branch rewritten to fall THROUGH to the location
  //     lookup when no donation point row is found, instead of returning null.
  //
  // Neither can change an answer, for the reason above: DONATIONPOINT_PHOTO_RE
  // matches exactly seven slash-separated segments and LOCATION_PHOTO_RE
  // exactly six, both patterns are anchored at both ends, and `[^/]+` cannot
  // span a separator -- so no string satisfies both. No test can kill either,
  // so none pretends to. The neighbouring mutant that is NOT equivalent -- the
  // donation point branch querying the location table on the way rather than
  // instead -- does die, on the `events` assertion further down.
  it("treats a location literally slugged 'donationpoint' as a location key, not a donation point one", () => {
    expect(isPlacePhotoKey("media/needs/at/salisbury/donationpoint/photo.jpg")).toBe(true);
  });

  // Slugs come off a URL path, and the two-segment shape's `[^/]+` is wider
  // than Django's `<slug:...>` converter ([-a-zA-Z0-9_]+). Nothing downstream
  // is harmed -- the value is a bound parameter in a SELECT and matches no row
  // -- but the gate's real width is worth stating rather than assumed.
  it("accepts slugs Django's slug converter would have rejected, because [^/]+ is wider", () => {
    expect(isPlacePhotoKey("media/needs/at/sid valley/photo.jpg")).toBe(true);
    expect(isPlacePhotoKey("media/needs/at/a.b/c%20d/photo.jpg")).toBe(true);
  });
});

// ===========================================================================
// backfillPlacePhoto -- resolving the key to a place
// ===========================================================================

describe("backfillPlacePhoto: which row the key resolves to", () => {
  beforeEach(() => {
    seedAll();
    reply(PLACE_DETAILS, detailsOk({ photo_reference: "PHOTOREF-1" }));
    reply(PLACE_PHOTO, { status: 200, body: JPEG_BYTES });
  });

  // The place_id in the Place Details request is the whole proof of routing:
  // it is read out of the row the key found, so asserting it proves BOTH slugs
  // in the key reached the right db function with the right argument order.
  // The fixture holds four other places any wrong lookup could have found.
  it("takes the food bank's own place_id for at/<slug>/photo.jpg", async () => {
    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(new URL(fetchCalls[0]!).searchParams.get("place_id")).toBe(FOODBANK_PLACE);
    // The place_id list, not a row COUNT: "one row exists" and "one row exists
    // and it is this place" are different claims, and only the second one
    // notices a lookup that resolved to one of the four decoys.
    expect(photoRows().map((row) => row.place_id)).toEqual([FOODBANK_PLACE]);
  });

  // The decoy that matters here is dundee's location, which is ALSO slugged
  // "central": getFoodbankLocationBySlugs filters on both slug and
  // foodbank_slug, and a query that lost the second half would resolve to
  // whichever row SQLite reached first.
  it("takes the location's place_id for at/<slug>/<locslug>/photo.jpg, not the same-slugged location under another food bank", async () => {
    await backfillPlacePhoto(env, LOCATION_KEY);

    expect(new URL(fetchCalls[0]!).searchParams.get("place_id")).toBe(LOCATION_PLACE);
    expect(photoRows()[0]!.place_id).toBe(LOCATION_PLACE);
  });

  // The other direction of the same risk: the fixture holds a food bank slugged
  // "central" with a location slugged "salisbury", so swapping the two captured
  // groups resolves to a real row with a DIFFERENT place_id rather than to
  // nothing. A test with only one food bank could not tell the two apart.
  it("does not transpose the two slugs -- the decoy food bank 'central' holding a location 'salisbury' is untouched", async () => {
    await backfillPlacePhoto(env, LOCATION_KEY);

    expect(new URL(fetchCalls[0]!).searchParams.get("place_id")).not.toBe("ChIJ-transposed-location");
    expect(photoRows().map((row) => row.place_id)).toEqual([LOCATION_PLACE]);
  });

  it("takes the donation point's place_id for at/<slug>/donationpoint/<dpslug>/photo.jpg", async () => {
    await backfillPlacePhoto(env, DONATIONPOINT_KEY);

    expect(new URL(fetchCalls[0]!).searchParams.get("place_id")).toBe(DONATIONPOINT_PLACE);
    expect(photoRows()[0]!.place_id).toBe(DONATIONPOINT_PLACE);
  });

  // A donation-point-shaped key is looked up in foodbankdonationpoint_full and
  // NOWHERE ELSE: exactly one SELECT, and a missing donation point is a quiet
  // return even though a location carrying those very slugs exists.
  //
  // HONEST LIMIT OF THIS TEST, established by mutation rather than assumed: it
  // does NOT discriminate the "fall through to the location lookup on a miss"
  // mutant, which survives the whole suite. It cannot, because LOCATION_PHOTO_RE
  // does not match a donation-point-shaped key in the first place (six segments
  // against seven -- see the isPlacePhotoKey block), so the fallthrough finds
  // nothing to do. What the `events` assertion DOES kill is a resolvePlace that
  // queries a second table on the way -- the shape a "look in both, prefer the
  // donation point" rewrite would take -- which the log line alone cannot see,
  // because the answer and the log line are identical either way while the
  // round trips are not.
  it("looks a donation-point-shaped key up in exactly one table, and does not fall back to the location one", async () => {
    db.prepare("DELETE FROM foodbankdonationpoint WHERE id = 1").run();
    seedLocation({ id: 9, foodbankId: SALISBURY, slug: "tesco", placeId: "ChIJ-should-not-be-used", placeHasPhoto: 1 });

    await backfillPlacePhoto(env, DONATIONPOINT_KEY);

    expect(events).toEqual(["d1 SELECT foodbankdonationpoint_full"]);
    expect(fetchCalls).toEqual([]);
    expect(logs).toEqual([`media-backfill: no place for ${DONATIONPOINT_KEY}`]);
  });

  // Both the read and the write go through the D1 Sessions API rather than a
  // bare env.DB.prepare(), which is the standing rule in packages/db/src/types.ts:
  // this database has read replication on, and a bare call can land on a replica
  // that has not caught up. Two sessions, because the read and the write are
  // created separately -- pinned so that a later refactor sharing one session
  // (or dropping to env.DB.prepare) is visible.
  it("opens both its D1 sessions as first-unconstrained", async () => {
    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(sessionModes).toEqual(["first-unconstrained", "first-unconstrained"]);
  });
});

// ===========================================================================
// The quiet returns
// ===========================================================================
//
// Every test in this block asserts that the promise RESOLVES and that the log
// line names the reason -- because queues/jobs.ts acks on a resolve, and once
// it has, the log line is the only evidence the message ever existed.

describe("backfillPlacePhoto: the outcomes that return quietly", () => {
  beforeEach(() => {
    seedAll();
    reply(PLACE_DETAILS, detailsOk({ photo_reference: "PHOTOREF-1" }));
    reply(PLACE_PHOTO, { status: 200, body: JPEG_BYTES });
  });

  // A slug deleted between routes/media.ts's 404-and-enqueue and this dequeue,
  // or a key for a food bank that never existed. Nothing a retry could fix, so
  // it acks -- deliberately UNLIKE the map branch, whose backfillFoodbankMap
  // throws on the same condition and lets the message reach jobs-dlq.
  it("returns without touching R2 or Google when the key names no place at all", async () => {
    await expect(backfillPlacePhoto(env, "media/needs/at/vanished/photo.jpg")).resolves.toBeUndefined();

    expect(logs).toEqual(["media-backfill: no place for media/needs/at/vanished/photo.jpg"]);
    expect(fetchCalls).toEqual([]);
    expect(mediaOps).toEqual([]);
    expect(photoRows()).toEqual([]);
  });

  // A place that exists but was never geocoded. Django's photo_from_place_id
  // is never reached in this state either -- models/foodbank.py:662-665 sets
  // place_has_photo = False whenever place_id is empty -- so there is nothing
  // to ask Google about.
  it("returns when the row exists but has no place_id", async () => {
    db.prepare("UPDATE foodbank SET place_id = NULL WHERE slug = 'salisbury'").run();

    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(logs).toEqual([`media-backfill: place has no place_id for ${FOODBANK_KEY}`]);
    expect(mediaOps).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  // THE ADMIN'S DELETE BUTTON. Django's photo_delete (gfadmin/views.py:1877-1913)
  // leaves place_has_photo = 1, so geo.py:107-141 re-fetches the identical photo
  // on the next page view -- its "Delete" is a cache bust. The port's
  // clearPlaceHasPhoto() sets the flag to 0 and THIS CHECK is the half that makes
  // the delete stick. If it stops working the deleted photo comes back, at the
  // price of two more billed calls, and the admin has no way to remove it.
  //
  // The head() assertion is part of it: the flag is checked BEFORE R2 is
  // touched, so a deleted photo costs not even a HEAD.
  it("returns without a HEAD or a fetch when place_has_photo is 0, so a delete stays deleted", async () => {
    db.prepare("UPDATE foodbank SET place_has_photo = 0 WHERE slug = 'salisbury'").run();

    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(logs).toEqual([`media-backfill: place_has_photo is 0, not refetching ${FOODBANK_KEY}`]);
    expect(mediaOps).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(photoRows()).toEqual([]);
  });

  // The same guard on the other two shapes. All three read the flag through a
  // different db function and a different table, and the delete route can clear
  // it on any of them (clearPlaceHasPhoto takes the owning table), so a guard
  // that only worked for food banks would make a deleted LOCATION photo come
  // back while a deleted food bank photo stayed gone.
  it("honours place_has_photo = 0 on a location and on a donation point too", async () => {
    db.prepare("UPDATE foodbanklocation SET place_has_photo = 0 WHERE id = 1").run();
    db.prepare("UPDATE foodbankdonationpoint SET place_has_photo = 0 WHERE id = 1").run();

    await backfillPlacePhoto(env, LOCATION_KEY);
    await backfillPlacePhoto(env, DONATIONPOINT_KEY);

    expect(logs).toEqual([
      `media-backfill: place_has_photo is 0, not refetching ${LOCATION_KEY}`,
      `media-backfill: place_has_photo is 0, not refetching ${DONATIONPOINT_KEY}`,
    ]);
    expect(fetchCalls).toEqual([]);
  });

  // SUSPECT, pinned rather than changed. The guard is `place.hasPhoto === false`,
  // and coerceBooleans maps SQL NULL to null rather than false -- so a row whose
  // place_has_photo has never been set goes straight through to two billed
  // Google calls. Django's foodbank_photo (gfwfbn/views.py:499-501) tests
  // `if not foodbank.place_has_photo`, under which None is falsy and the view
  // 404s without calling Google at all.
  //
  // Whether this matters depends on how many production rows are NULL, which is
  // NOT VERIFIED here -- no production query was run. It is a divergence in the
  // spending direction, so it is reported.
  it("SUSPECT: a NULL place_has_photo does NOT block the fetch, unlike Django's falsy test", async () => {
    db.prepare("UPDATE foodbank SET place_has_photo = NULL WHERE slug = 'salisbury'").run();

    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(fetchCalls.map(routeKey)).toEqual([PLACE_DETAILS, PLACE_PHOTO]);
    // The bytes, not `media.has(...)`: what makes this divergence matter is that
    // a photograph was actually bought and stored for a row Django would have
    // 404ed on, so the assertion says so.
    expect(Array.from(media.get(FOODBANK_KEY)!.body)).toEqual(Array.from(JPEG_BYTES));
    expect(photoRows().map((row) => row.place_id)).toEqual([FOODBANK_PLACE]);
  });

  // "Google has no photograph of this place" is a permanent, correct answer, so
  // it acks. Retrying it would buy the same Place Details call three more times
  // for the same reply -- and geo.py's cache does not have an equivalent to this
  // path at all, because Django caches the BLOB and never the absence.
  it.each([
    ["ZERO_RESULTS", JSON.stringify({ status: "ZERO_RESULTS" })],
    ["NOT_FOUND", JSON.stringify({ status: "NOT_FOUND" })],
  ])("returns quietly when Place Details answers %s", async (_status, body) => {
    reply(PLACE_DETAILS, { status: 200, body });

    await expect(backfillPlacePhoto(env, FOODBANK_KEY)).resolves.toBeUndefined();

    expect(logs).toEqual([`media-backfill: Google has no photo for ${FOODBANK_PLACE} (${FOODBANK_KEY})`]);
    // Only ONE billed call was made: the photo fetch is never attempted.
    expect(fetchCalls.map(routeKey)).toEqual([PLACE_DETAILS]);
    expect(media.size).toBe(0);
    expect(photoRows()).toEqual([]);
  });

  // status OK with nothing usable in it. Five real shapes, all of which Django
  // handles WORSE. geo.py:119 is
  // `places_json.get("result", {}).get("photos", [{}])[0].get("photo_reference", None)`
  // and geo.py:121-122 then fetches maps/api/place/photo with whatever came
  // out, unconditionally. Run under CPython 3.13.0 on this machine, that
  // expression gives:
  //
  //   {"status":"OK"}                         -> None
  //   {"result":{}}                           -> None
  //   {"result":{"photos":[]}}                -> IndexError
  //   {"photos":[{"html_attributions":[..]}]} -> None
  //
  // So of the five shapes below, three make Django issue a billed request for
  // `photo_reference=None` that cannot succeed, one (the empty photos array) is
  // an unhandled IndexError, and the last -- an empty photo_reference -- is a
  // billed request for the empty string. The port returning here instead is a
  // deliberate improvement on the source rather than a port of it, and is
  // pinned as such.
  it.each([
    ["no result object at all", JSON.stringify({ status: "OK" })],
    ["a result with no photos array", JSON.stringify({ status: "OK", result: {} })],
    ["an empty photos array", JSON.stringify({ status: "OK", result: { photos: [] } })],
    ["a first photo with no photo_reference", JSON.stringify({ status: "OK", result: { photos: [{ html_attributions: ["<a>x</a>"] }] } })],
    ["a first photo whose photo_reference is the empty string", JSON.stringify({ status: "OK", result: { photos: [{ photo_reference: "" }] } })],
  ])("returns quietly on an OK response with %s, without the second billed call", async (_case, body) => {
    reply(PLACE_DETAILS, { status: 200, body });

    await expect(backfillPlacePhoto(env, FOODBANK_KEY)).resolves.toBeUndefined();

    expect(logs).toEqual([`media-backfill: Google has no photo for ${FOODBANK_PLACE} (${FOODBANK_KEY})`]);
    expect(fetchCalls.map(routeKey)).toEqual([PLACE_DETAILS]);
    expect(photoRows()).toEqual([]);
  });
});

// ===========================================================================
// The write
// ===========================================================================

describe("backfillPlacePhoto: what it stores on success", () => {
  beforeEach(() => {
    seedAll();
    reply(
      PLACE_DETAILS,
      detailsOk(
        { photo_reference: "PHOTOREF-1", html_attributions: ['<a href="https://maps.google.com/x">Alice</a>', "<a>Bob</a>"] },
        // A SECOND photo, which must be ignored: geo.py:119 takes photos[0]
        // and so does this port. Without a decoy here, "takes the first" and
        // "takes the last" are the same assertion.
        { photo_reference: "PHOTOREF-2", html_attributions: ["<a>Never</a>"] },
      ),
    );
    reply(PLACE_PHOTO, { status: 200, body: JPEG_BYTES });
  });

  // The bytes, the key and the httpMetadata, asserted as a byte comparison
  // rather than a length: a body accidentally read as text and re-encoded
  // would still have plausible length. cacheControl is Django's
  // @cache_page(SECONDS_IN_WEEK) on the three photo views, carried onto the
  // stored object so the CDN answer matches what Django's answer was.
  it("puts the exact response bytes under the message's own key, with a week's cache control", async () => {
    await backfillPlacePhoto(env, FOODBANK_KEY);

    const stored = media.get(FOODBANK_KEY);
    expect(stored).toBeDefined();
    expect(Array.from(stored!.body)).toEqual(Array.from(JPEG_BYTES));
    expect(stored!.httpMetadata).toEqual({ contentType: "image/jpeg", cacheControl: "public, max-age=604800" });
    expect([...media.keys()]).toEqual([FOODBANK_KEY]);
    expect(logs).toEqual([`media-backfill: stored ${FOODBANK_KEY} (10 bytes)`]);
  });

  // The placephoto row, in full. This row is what makes the admin's photos tab
  // and its delete route work at all (getOwnedPhoto/deletePlacePhoto both take
  // its id), so "the photo is in R2" is only half of success.
  //
  // md5 is the etag the PUT ANSWERED -- R2 computes MD5 for a single-part
  // upload and returns it as the etag, which is the same value
  // tools/pg-to-r2/load_photos.py wrote with hashlib for the bulk-loaded rows.
  // The counter etag proves it came from the put result rather than being
  // recomputed or defaulted.
  it("records the placephoto row with the first photo's reference, both attributions and the put's own etag", async () => {
    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(photoRows()).toEqual([
      {
        place_id: FOODBANK_PLACE,
        photo_ref: "PHOTOREF-1",
        // html_attributions is the EMPTY STRING in all 7,117 rows Django left
        // behind; this consumer stores what Google actually returned, joined
        // with a single space. Two entries, so the join is observable.
        html_attributions: '<a href="https://maps.google.com/x">Alice</a> <a>Bob</a>',
        r2_key: FOODBANK_KEY,
        bytes: JPEG_BYTES.byteLength,
        md5: "etag-1",
      },
    ]);
  });

  // html_attributions absent from Google's reply -- which is the shape the
  // Place Details `fields=photo` response takes when there is nothing to
  // attribute. `(photo.html_attributions ?? []).join(" ")` makes that the
  // empty string, NOT the string "undefined" and NOT NULL: the column is
  // nullable, and a NULL here would read differently from the 7,117 bulk-loaded
  // rows that all hold ''.
  it("stores the empty string, not null, when Google returns no attributions", async () => {
    reply(PLACE_DETAILS, detailsOk({ photo_reference: "PHOTOREF-1" }));

    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(photoRows()[0]!.html_attributions).toBe("");
  });

  // The two billed requests, in order, with the parameters geo.py:116-123 uses.
  // `fields=photo` is what keeps the first call on the cheapest Place Details
  // SKU -- dropping it would silently multiply the bill on a call that would
  // still work perfectly -- and maxwidth is geo.py's `size = 1080` default.
  it("makes exactly the two documented Google requests, in order, with geo.py's parameters", async () => {
    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(fetchCalls.map(routeKey)).toEqual([PLACE_DETAILS, PLACE_PHOTO]);

    const details = new URL(fetchCalls[0]!).searchParams;
    expect(details.get("place_id")).toBe(FOODBANK_PLACE);
    expect(details.get("fields")).toBe("photo");
    expect(details.get("key")).toBe("places-key");

    const photo = new URL(fetchCalls[1]!).searchParams;
    expect(photo.get("maxwidth")).toBe("1080");
    // The reference from the FIRST photo of the response, not the second.
    expect(photo.get("photo_reference")).toBe("PHOTOREF-1");
    expect(photo.get("key")).toBe("places-key");
  });

  // THE WHOLE SEQUENCE, D1 and R2 and the network interleaved. Two orderings
  // in it are load-bearing and neither is visible in any other test:
  //
  //   * the HEAD comes before both billed calls -- that IS the idempotency
  //     guard; a HEAD moved after the fetches would still make every test that
  //     only counts rows pass, while doubling the bill on every redelivery.
  //   * the R2 put comes before the D1 write, which is what makes the
  //     photo_ref collision in the retry block below permanent.
  //
  // The two SELECTs at the front are getFoodbankBySlug's batch, and the reason
  // this suite runs the whole migration set: the second reads a VIEW.
  it("heads R2, fetches both endpoints, puts, and only then writes the row", async () => {
    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(events).toEqual([
      "d1 SELECT foodbank",
      "d1 SELECT foodbankchange_full",
      `r2 head ${FOODBANK_KEY}`,
      `fetch ${PLACE_DETAILS}`,
      `fetch ${PLACE_PHOTO}`,
      `r2 put ${FOODBANK_KEY}`,
      "d1 INSERT INTO placephoto",
    ]);
  });

  // The same write set for a location key, because the r2_key column is what a
  // later delete uses to find the object: a location photo recorded under the
  // food bank's key would delete the wrong object.
  it("records the location's own key in r2_key for a location photo", async () => {
    await backfillPlacePhoto(env, LOCATION_KEY);

    expect(photoRows()).toEqual([
      {
        place_id: LOCATION_PLACE,
        photo_ref: "PHOTOREF-1",
        html_attributions: '<a href="https://maps.google.com/x">Alice</a> <a>Bob</a>',
        r2_key: LOCATION_KEY,
        bytes: JPEG_BYTES.byteLength,
        md5: "etag-1",
      },
    ]);
  });
});

// ===========================================================================
// Idempotency -- Cloudflare Queues is at-least-once
// ===========================================================================

describe("backfillPlacePhoto: redelivery", () => {
  beforeEach(() => {
    seedAll();
    reply(PLACE_DETAILS, detailsOk({ photo_reference: "PHOTOREF-1" }));
    reply(PLACE_PHOTO, { status: 200, body: JPEG_BYTES });
  });

  // THE GUARD THE MAP BRANCH DOES NOT HAVE. Two deliveries of the same message
  // -- a queue redelivery, or two requests racing routes/media.ts's ten-second
  // 404 window -- must buy exactly one photo. Both calls are billed per
  // request, so a broken HEAD guard doubles the cost of every new place
  // silently and forever.
  it("buys the photo once across a redelivery and leaves one row", async () => {
    await backfillPlacePhoto(env, FOODBANK_KEY);
    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(fetchCalls.map(routeKey)).toEqual([PLACE_DETAILS, PLACE_PHOTO]);
    expect(mediaOps).toEqual([`head ${FOODBANK_KEY}`, `put ${FOODBANK_KEY}`, `head ${FOODBANK_KEY}`]);
    // THE ROW'S CONTENT, not its count. md5 still "etag-1" is the proof the
    // second delivery never reached the put: mediaBucket mints the next counter
    // etag on every put, so a second put that ON CONFLICT-updated the same row
    // in place would leave exactly one row -- indistinguishable from this under
    // a toHaveLength(1), and two more billed Google calls poorer.
    expect(photoRows()).toEqual([
      {
        place_id: FOODBANK_PLACE,
        photo_ref: "PHOTOREF-1",
        html_attributions: "",
        r2_key: FOODBANK_KEY,
        bytes: JPEG_BYTES.byteLength,
        md5: "etag-1",
      },
    ]);
    // Both lines, in order: the second delivery's ONLY output is the skip line.
    expect(logs).toEqual([
      `media-backfill: stored ${FOODBANK_KEY} (${JPEG_BYTES.byteLength} bytes)`,
      `media-backfill: ${FOODBANK_KEY} already in R2`,
    ]);
  });

  // The guard is on R2, NOT on the placephoto row, and that is the right way
  // round: R2 is what serves the request. So an object deleted from the bucket
  // while its row survives IS re-bought -- and upsertPlacePhoto's
  // ON CONFLICT(place_id) DO UPDATE then refreshes bytes, md5 and photo_ref in
  // place rather than inserting a second row or (as INSERT OR REPLACE would)
  // handing the row a new id that the admin's delete links no longer point at.
  it("re-fetches when the R2 object is gone but the row remains, updating the row in place", async () => {
    await backfillPlacePhoto(env, FOODBANK_KEY);
    const firstId = db.prepare("SELECT id FROM placephoto").get()!.id;

    media.delete(FOODBANK_KEY);
    reply(PLACE_DETAILS, detailsOk({ photo_reference: "PHOTOREF-2" }));
    reply(PLACE_PHOTO, { status: 200, body: JPEG_BYTES_2 });

    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(db.prepare("SELECT id, photo_ref, bytes, md5 FROM placephoto").all()).toEqual([
      { id: firstId, photo_ref: "PHOTOREF-2", bytes: JPEG_BYTES_2.byteLength, md5: "etag-2" },
    ]);
  });

  // A second place whose photo is already in R2 must not stop the first from
  // being fetched -- i.e. the HEAD is keyed on the message's key and not on
  // anything shared. Cheap, but this is a Map lookup in the double and a real
  // bucket in production, and "returns quietly" is an easy thing to over-trigger.
  it("is not confused by another place's object already sitting in the bucket", async () => {
    media.set(LOCATION_KEY, { key: LOCATION_KEY, body: JPEG_BYTES, etag: "etag-existing", httpMetadata: {} });

    await backfillPlacePhoto(env, FOODBANK_KEY);

    expect(media.has(FOODBANK_KEY)).toBe(true);
    expect(photoRows().map((row) => row.place_id)).toEqual([FOODBANK_PLACE]);
  });
});

// ===========================================================================
// The failures that must retry, and reach jobs-dlq
// ===========================================================================
//
// backfillPlacePhoto has no try/catch of its own, so anything that throws here
// propagates through handleMediaBackfill to handleJobsQueue's catch, which logs
// and calls message.retry() -- wrangler.jsonc's max_retries: 3, then jobs-dlq.
// Asserting the MESSAGE TEXT matters as much as the throw: that string is what
// jobsDlq.ts prints, and it is the only account anyone gets of a photo that
// never arrived.

describe("backfillPlacePhoto: the failures that must retry", () => {
  beforeEach(() => {
    seedAll();
    reply(PLACE_DETAILS, detailsOk({ photo_reference: "PHOTOREF-1" }));
    reply(PLACE_PHOTO, { status: 200, body: JPEG_BYTES });
  });

  // Google being down is transient, so it must NOT ack. The message carries the
  // place_id, which is the one identifier that makes a DLQ line actionable.
  it("throws with the status and the place_id when Place Details answers 5xx", async () => {
    reply(PLACE_DETAILS, { status: 503, body: "upstream unavailable" });

    await expect(backfillPlacePhoto(env, FOODBANK_KEY)).rejects.toThrow(`Place Details HTTP 503 for ${FOODBANK_PLACE}`);
    expect(media.size).toBe(0);
    expect(photoRows()).toEqual([]);
  });

  // THE CREDENTIAL-BROKE-SILENTLY CASE. Google answers 200 and says
  // REQUEST_DENIED in the body, which is the shape a revoked, unbilled or
  // referrer-restricted key takes. Treating it like ZERO_RESULTS would ack
  // every message on the queue in turn and leave no photo and no trace --
  // exactly the failure mode this Worker has already had once, with Browser
  // Rendering. It throws instead, so the third retry lands in jobs-dlq.
  it.each([["REQUEST_DENIED"], ["OVER_QUERY_LIMIT"], ["INVALID_REQUEST"], ["UNKNOWN_ERROR"]])(
    "throws on a Place Details status of %s, so a broken key reaches the DLQ",
    async (status) => {
      reply(PLACE_DETAILS, { status: 200, body: JSON.stringify({ status }) });

      await expect(backfillPlacePhoto(env, FOODBANK_KEY)).rejects.toThrow(`Place Details status ${status} for ${FOODBANK_PLACE}`);
      expect(fetchCalls.map(routeKey)).toEqual([PLACE_DETAILS]);
    },
  );

  // A body with no `status` at all -- an HTML error page, a proxy's JSON, a
  // truncated response. The check is `!== "OK"`, so this throws too, with the
  // literal word "undefined" in the message. Ugly but correct: unrecognised is
  // the retry side, and the alternative would be to treat any garbage 200 as
  // "no photo here" and ack it.
  it("throws on a 200 whose body has no status field, rather than treating it as 'no photo'", async () => {
    reply(PLACE_DETAILS, { status: 200, body: JSON.stringify({ result: { photos: [{ photo_reference: "PHOTOREF-1" }] } }) });

    await expect(backfillPlacePhoto(env, FOODBANK_KEY)).rejects.toThrow(`Place Details status undefined for ${FOODBANK_PLACE}`);
  });

  // The second call failing. NOTE the message names neither the key nor the
  // place: `Place Photo HTTP 403` on its own. Pinned as-is because
  // handleJobsQueue logs the message body alongside the error and jobsDlq.ts
  // prints the key, so the pair is still identifiable -- but the error string
  // read on its own says nothing about which photo it is.
  it("throws on a Place Photo failure, having already paid for the details call", async () => {
    reply(PLACE_PHOTO, { status: 403, body: "forbidden" });

    await expect(backfillPlacePhoto(env, FOODBANK_KEY)).rejects.toThrow("Place Photo HTTP 403");
    expect(fetchCalls.map(routeKey)).toEqual([PLACE_DETAILS, PLACE_PHOTO]);
    expect(media.size).toBe(0);
    expect(photoRows()).toEqual([]);
  });

  // The transport itself failing rather than the response -- a DNS blip, a TLS
  // reset, a subrequest limit. Nothing catches it, so it retries, which is
  // right. Included because a `try { await fetch }` added later "for
  // robustness" would flip this to the ack side and make an outage invisible.
  it("propagates a rejected fetch rather than swallowing it", async () => {
    reply(PLACE_DETAILS, new Error("Network connection lost"));

    await expect(backfillPlacePhoto(env, FOODBANK_KEY)).rejects.toThrow("Network connection lost");
  });

  // R2 failing on the put. The billed calls have already been made and paid
  // for, and the retry will make them again -- pinned as the cost of the
  // current ordering rather than presented as ideal. Storing nothing is still
  // correct: a placephoto row pointing at an object that is not there would be
  // worse than no row.
  it("throws when the R2 put fails, writing no row", async () => {
    mediaPutError = new Error("R2: internal error");

    await expect(backfillPlacePhoto(env, FOODBANK_KEY)).rejects.toThrow("R2: internal error");
    expect(fetchCalls.map(routeKey)).toEqual([PLACE_DETAILS, PLACE_PHOTO]);
    expect(photoRows()).toEqual([]);
  });

  // SUSPECT, pinned rather than fixed -- the interaction of the idempotency
  // guard with the put-before-write ordering.
  //
  // placephoto has a UNIQUE index on photo_ref (0018_placephoto.sql), and
  // placePhotos.ts says a collision there is "left to throw rather than be
  // swallowed, because it means two places claim one Google photo reference and
  // that is worth seeing in the DLQ". It does throw -- but the object is
  // ALREADY IN R2 by then, so the retry hits the `head` guard, logs "already in
  // R2" and RESOLVES. The message acks on attempt two. It never reaches
  // jobs-dlq, and the placephoto row is never written at all: the photo is
  // served fine from R2 for ever, while the admin's photos tab cannot see it
  // and photo_delete cannot delete it.
  //
  // Reported, not corrected. Two places sharing a photo_reference may well be
  // impossible in practice; what is pinned here is that if it happens, the
  // documented "worth seeing in the DLQ" outcome is not what occurs.
  it("SUSPECT: a photo_ref collision throws once, then the R2 guard makes the retry ack with no row written", async () => {
    db.prepare(
      "INSERT INTO placephoto (place_id, photo_ref, html_attributions, r2_key, bytes, md5) VALUES ('ChIJ-someone-else', 'PHOTOREF-1', '', 'media/needs/at/elsewhere/photo.jpg', 5, 'md5-x')",
    ).run();

    await expect(backfillPlacePhoto(env, FOODBANK_KEY)).rejects.toThrow(/UNIQUE constraint failed: placephoto\.photo_ref/);
    // The object is in the bucket even though the write failed.
    expect(media.has(FOODBANK_KEY)).toBe(true);

    // The retry. It resolves -- so queues/jobs.ts acks and the message is gone.
    await expect(backfillPlacePhoto(env, FOODBANK_KEY)).resolves.toBeUndefined();
    expect(logs).toEqual([`media-backfill: ${FOODBANK_KEY} already in R2`]);

    // ...and no row for this place was ever recorded.
    expect(photoRows().map((row) => row.place_id)).toEqual(["ChIJ-someone-else"]);
  });

  // The other UNIQUE index, place_id, is the one the upsert actually targets,
  // so the same collision on THAT column is handled rather than thrown. The
  // pairing is the point: two places may not share a photo_ref, but one place
  // may absolutely be backfilled twice.
  it("does not throw when the place_id already has a row -- that is the ON CONFLICT target", async () => {
    db.prepare(
      "INSERT INTO placephoto (place_id, photo_ref, html_attributions, r2_key, bytes, md5) VALUES (?, 'OLD-REF', '', ?, 5, 'md5-old')",
    ).run(FOODBANK_PLACE, FOODBANK_KEY);

    await expect(backfillPlacePhoto(env, FOODBANK_KEY)).resolves.toBeUndefined();

    expect(photoRows()).toEqual([
      {
        place_id: FOODBANK_PLACE,
        photo_ref: "PHOTOREF-1",
        html_attributions: "",
        r2_key: FOODBANK_KEY,
        bytes: JPEG_BYTES.byteLength,
        md5: "etag-1",
      },
    ]);
  });
});

// ===========================================================================
// Keys this module should never have been handed
// ===========================================================================
//
// queues/jobs.ts guards every call with isPlacePhotoKey, so these cannot happen
// today. They are pinned because the guard and the function are separate
// exports that a later caller could get out of step -- and because the answer
// is the QUIET side, which is the one that leaves no evidence.

describe("backfillPlacePhoto: a key isPlacePhotoKey would have rejected", () => {
  beforeEach(() => {
    seedAll();
    reply(PLACE_DETAILS, detailsOk({ photo_reference: "PHOTOREF-1" }));
    reply(PLACE_PHOTO, { status: 200, body: JPEG_BYTES });
  });

  // resolvePlace re-runs the same three regexes and falls through to `return
  // null`, so an unmatched key is indistinguishable from a deleted food bank:
  // one log line, an ack, nothing else. Worth knowing before wiring a new
  // caller to this function.
  it.each([
    ["media/needs/at/salisbury/map.png", "a map key, which belongs to mapImage.ts"],
    ["media/needs/at/salisbury/photo.jpg?s=540", "a key that kept its query string"],
    // resolvePlace re-runs the SAME three constants, so these two also pin that
    // the anchors are honoured on the lookup side and not only in the gate --
    // the food bank pattern's are, above, but nothing else reached the location
    // and donation point patterns' `^` from here. Both name real, seeded slugs,
    // so a resolvePlace whose patterns had lost their `^` would find the
    // salisbury rows and spend two billed calls on a key from another namespace.
    ["cache/media/needs/at/salisbury/central/photo.jpg", "a location shape in another namespace"],
    ["cache/media/needs/at/salisbury/donationpoint/tesco/photo.jpg", "a donation point shape in another namespace"],
    ["", "the empty string"],
  ])("returns quietly for %s (%s), the same as for a place that does not exist", async (key) => {
    await expect(backfillPlacePhoto(env, key)).resolves.toBeUndefined();

    expect(logs).toEqual([`media-backfill: no place for ${key}`]);
    expect(fetchCalls).toEqual([]);
    expect(mediaOps).toEqual([]);
  });
});
