import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { adminPhotoDelete } from "./photoDelete";
import { adminApp } from "./index";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// gfadmin/views.py:1877-1913 photo_delete, as ported. One button on the
// photos tab, and it is the only destructive control on that tab -- it takes
// away an R2 object AND a placephoto row AND a flag on a third table, in three
// separate statements, with nothing tying them together and nothing rendered
// back to say what happened. htmx swaps the table row out on ANY 200
// (foodbank_tabs/photos.njk:60-63 is hx-swap="delete"), so the admin's entire
// feedback is "the row vanished" -- which it does whether all three writes
// landed, one landed, or none did.
//
// THREE WAYS THIS GOES QUIETLY WRONG, which is what the blocks below are
// organised around:
//
//   1. NOTHING WAS WRITTEN. github #34's shape exactly -- the location form
//      parsed a Place ID, threaded it through the handler and then wrote it
//      with no SQL at all, redirecting as though it had worked. Here the
//      equivalent is a handler that answers 200, htmx deletes the row from
//      the admin's screen, and the photo is still in placephoto and still in
//      R2: the tab looks right until the next reload. So every test below
//      that claims a delete reads placephoto, the owning table's
//      place_has_photo AND the recorded R2 deletes back out; not one of them
//      treats the 200 or the 302 as evidence.
//   2. TOO MUCH WAS WRITTEN. clearPlaceHasPhoto's UPDATE is
//      `WHERE place_id = ?` with no food-bank predicate and no index behind
//      it (packages/db/src/placePhotos.ts:157-159), and deletePlacePhoto is a
//      bare `DELETE ... WHERE id = ?`. A lost predicate in either would be
//      invisible from this end, so the fixture seeds a SECOND food bank with
//      its own photos and flags and every delete test asserts they are
//      untouched.
//   3. THE REFUSALS DON'T REFUSE. A 403, a 404 or a sign-in redirect that
//      still deleted the R2 object would be strictly worse than no check at
//      all, because the photo is gone and the metadata says it is not. Every
//      rejection test therefore asserts the surviving row and the empty R2
//      delete log as well as the status.
//
// REAL ROUTER, REAL MIDDLEWARE, REAL DATABASE. Wired exactly as
// routes/admin/index.ts:83-85,273 wires it -- inside a sub-app, behind the
// genuine requireAdminAuth, grafted onto a parent with app.route("/admin",
// ...) -- because the auth gate, the path rebasing and both route params are
// things a hand-built Context would paper over. TWO routers, though, and the
// difference was measured rather than assumed: makeApp() below is a
// hand-written MIRROR of two lines of index.ts, and a mirror cannot fail when
// the thing it mirrors changes. Every one of these edits to index.ts was
// applied to a scratch copy and the suite re-run, and all six SURVIVED the
// mirror while breaking production -- adding a `get` registration beside the
// `post`, changing `post` to `all`, renaming the path, renaming `:photoId`,
// deleting the registration outright, and deleting
// `adminApp.use("*", requireAdminAuth)` (which opens the entire admin area to
// the internet). The `production route registration` block at the end sends
// through `adminApp` itself and is what kills them. getFoodbankBySlug,
// getOwnedPhoto, deletePlacePhoto, clearPlaceHasPhoto and verifyCsrf are all
// the shipped implementations running their real SQL and real HMAC. The only
// stubs are the three bindings that would otherwise leave the machine:
// SESSIONS (a KV namespace, a Map), DB (SQLite behind D1's async statement
// surface) and MEDIA (an R2 bucket, a list of the keys it was asked to
// delete).
//
// WHAT THIS BUTTON MEANS is documented at photoDelete.ts:13-27 and not
// re-argued here: in Django it is a cache bust, because photo.delete() leaves
// place_has_photo = 1 and geo.py:107-141 re-buys the photo from Google on the
// next page view. This port clears the flag and
// workers/jobs/src/mediaBackfill/placePhoto.ts:140-143 honours it, so it is a
// real delete -- which is precisely why "the flag was cleared, on the right
// row" is asserted everywhere below rather than taken as decoration.

// A reduced transcription of the four tables this path touches -- the columns
// the handler and packages/db name, plus the indexes that change behaviour --
// following donationPoint.test.ts's precedent for workers/site fixtures
// (packages/db's own placePhotos.test.ts applies the migration files instead).
// Three details are load-bearing and are copied deliberately:
//
//   * placephoto.place_id is NULLABLE (0018_placephoto.sql:41). getOwnedPhoto
//     matches with `pp.place_id IN (...)`, and `NULL IN (...)` is never true
//     in SQL, so a NULL-place_id row is unreachable through this route -- see
//     the orphan test.
//   * placephoto_place_id_uniq is UNIQUE (0018:50), so a place has at most one
//     photo row and therefore exactly one r2_key. That is what makes "delete
//     one R2 object, not a family of derivatives" the correct behaviour today
//     rather than an oversight.
//   * place_has_photo is a NULLABLE INTEGER on all three place tables
//     (0001_core.sql:31, :65, :91) with no CHECK, and NEITHER foodbanklocation
//     NOR foodbankdonationpoint has any index on place_id. Both facts are why
//     the shared-place_id block at the end of this file can exist at all.
//
// foodbank keeps `latest_need_id` even though nothing here reads it:
// getFoodbankBySlug -> attachLatestNeed (packages/db/src/foodbank.ts:100-103)
// skips its second query only when that value is exactly `null`, and a missing
// column reads as `undefined`, which would send it looking for a foodbankchange
// table that is not in this fixture.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  place_id TEXT, place_has_photo INTEGER,
  is_closed INTEGER NOT NULL DEFAULT 0,
  latest_need_id INTEGER
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);

CREATE TABLE foodbanklocation (
  id INTEGER PRIMARY KEY, foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  place_id TEXT, place_has_photo INTEGER,
  is_closed INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX loc_fb_name_uniq ON foodbanklocation(foodbank_id, name);

CREATE TABLE foodbankdonationpoint (
  id INTEGER PRIMARY KEY, foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  place_id TEXT, place_has_photo INTEGER,
  is_closed INTEGER NOT NULL DEFAULT 0, in_store_only INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX dp_fb_name_uniq ON foodbankdonationpoint(foodbank_id, name);

CREATE TABLE placephoto (
  id INTEGER PRIMARY KEY,
  place_id TEXT, photo_ref TEXT, html_attributions TEXT,
  r2_key TEXT NOT NULL, bytes INTEGER NOT NULL, md5 TEXT NOT NULL,
  created TEXT, modified TEXT
);
CREATE UNIQUE INDEX placephoto_place_id_uniq ON placephoto(place_id);
CREATE UNIQUE INDEX placephoto_photo_ref_uniq ON placephoto(photo_ref);
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The D1PreparedStatement surface packages/db uses, over node:sqlite. Lifted
// from articles.test.ts / donationPoint.test.ts so every suite in this
// directory drives the real code through one adapter. Deliberately dumb: it
// forwards the SQL untouched and interprets nothing, so the ENGINE decides
// which rows come back. That matters here because getOwnedPhoto's statement
// uses NUMBERED placeholders (`?1` appears three times inside its ownership
// union) -- node:sqlite binds those positionally by index exactly as D1 does,
// and a hand-rolled fake that "helpfully" re-ordered arguments would make the
// ownership check look like it worked while matching the wrong food bank.
function d1Session(db: DatabaseSync): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "d".repeat(64);
// Keyed exactly as lib/adminAuth.ts:250 sessionKvKey() spells it, and read
// from the cookie lib/adminAuth.ts:61 names. A test that invented either would
// "prove" the auth gate rejects everything.
const SESSION_ID = "test-session-id";
const SESSION_COOKIE = "__Host-gfsession";

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let sessions: Map<string, string>;
// Every key MEDIA.delete() was called with, in order. The R2 object is the
// half of this delete that cannot be undone -- placephoto can be re-inserted
// from Google, an admin's mistaken press cannot un-bill it -- so "which keys,
// how many times" is asserted directly rather than inferred.
let r2Deletes: string[];

// Two food banks. Salisbury is the one every request below names; Amesbury
// exists solely so that a lost `foodbank_id` predicate, a lost `id` predicate
// or a place_id collision has somewhere visible to land.
const SALISBURY = { id: 7, slug: "salisbury", placeId: "place-00-salisbury" };
const AMESBURY = { id: 12, slug: "amesbury", placeId: "place-20-amesbury" };

// Salisbury's places, and their Google place ids.
const WILTON = { id: 101, placeId: "place-01-wilton" }; // location
const BEMERTON = { id: 102, placeId: "place-02-bemerton" }; // location
const WAITROSE = { id: 201, placeId: "place-11-waitrose" }; // donation point
// Amesbury's, for the cross-food-bank assertions. One of each KIND, not just
// one of each food bank: the ownership union at placePhotos.ts:42-48 is three
// separate arms, each carrying its own `foodbank_id = ?1`, and an arm is only
// pinned by a row that the OTHER food bank owns in that same table. Measured:
// with no Amesbury donation point here, deleting
// `WHERE foodbank_id = ?1 AND` from the donationpoint arm alone -- which lets
// Salisbury's admin delete any donation point photo on the site -- survived
// the entire suite. That mutant is the reason AMESBURY_DEPOT exists.
const AMESBURY_CENTRAL = { id: 111, placeId: "place-21-central" }; // location
const AMESBURY_DEPOT = { id: 211, placeId: "place-23-depot" }; // donation point

// Photo ids sit far away from the place-row ids they describe (9xxx vs 1xx),
// because the delete form's action carries the PHOTO's id and passing a place
// row's id instead would still find "a" row in a fixture where the two ranges
// overlapped -- and would then delete a photograph of somewhere else entirely.
const PHOTO = {
  salisbury: 9001,
  wilton: 9002,
  bemerton: 9003,
  waitrose: 9004,
  amesbury: 9101,
  amesburyCentral: 9102,
  amesburyDepot: 9103,
  // A row whose place_id belongs to nobody at all: the shape left behind when
  // a location is deleted and its photo is not.
  orphan: 9900,
  // A row with a NULL place_id. 0 of the 7,122 production rows look like this
  // (PLAN.md:945 counts NULLs in photo_ref, not place_id), but the column
  // permits it and the ownership check's behaviour for it is not obvious.
  nullPlace: 9901,
};

type PlaceTable = "foodbank" | "foodbanklocation" | "foodbankdonationpoint";

function seedPlaces(): void {
  db.prepare("INSERT INTO foodbank (id, name, slug, place_id, place_has_photo, latest_need_id) VALUES (?, ?, ?, ?, 1, NULL)").run(
    SALISBURY.id,
    "Salisbury Food Bank",
    SALISBURY.slug,
    SALISBURY.placeId,
  );
  db.prepare("INSERT INTO foodbank (id, name, slug, place_id, place_has_photo, latest_need_id) VALUES (?, ?, ?, ?, 1, NULL)").run(
    AMESBURY.id,
    "Amesbury Food Bank",
    AMESBURY.slug,
    AMESBURY.placeId,
  );

  seedLocation(WILTON.id, SALISBURY.id, "Wilton", "wilton", WILTON.placeId);
  seedLocation(BEMERTON.id, SALISBURY.id, "Bemerton Heath", "bemerton-heath", BEMERTON.placeId);
  seedLocation(AMESBURY_CENTRAL.id, AMESBURY.id, "Amesbury Central", "amesbury-central", AMESBURY_CENTRAL.placeId);
  seedDonationPoint(WAITROSE.id, SALISBURY.id, "Waitrose", "waitrose", WAITROSE.placeId);
  seedDonationPoint(AMESBURY_DEPOT.id, AMESBURY.id, "Amesbury Depot", "amesbury-depot", AMESBURY_DEPOT.placeId);
}

function seedLocation(id: number, foodbankId: number, name: string, slug: string, placeId: string | null, hasPhoto: number | null = 1): void {
  db.prepare("INSERT INTO foodbanklocation (id, foodbank_id, name, slug, place_id, place_has_photo) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    foodbankId,
    name,
    slug,
    placeId,
    hasPhoto,
  );
}

function seedDonationPoint(
  id: number,
  foodbankId: number,
  name: string,
  slug: string,
  placeId: string | null,
  hasPhoto: number | null = 1,
): void {
  db.prepare("INSERT INTO foodbankdonationpoint (id, foodbank_id, name, slug, place_id, place_has_photo) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    foodbankId,
    name,
    slug,
    placeId,
    hasPhoto,
  );
}

// The r2_key is stored, not derived (0018_placephoto.sql:16-19: "r2_key
// records exactly that key so a delete can remove the object without
// re-deriving it"). These are the canonical shapes serveMedia would derive for
// each place type (`"media" + url.pathname`, routes/media.ts:137 -- the ":44"
// in photoDelete.ts's own comment has drifted), so a handler that rebuilt the
// key from the URL would agree with them. One test below deliberately seeds a
// NON-canonical key to break that tie.
function seedPhoto(id: number, placeId: string | null, r2Key: string): void {
  db.prepare(
    "INSERT INTO placephoto (id, place_id, photo_ref, html_attributions, r2_key, bytes, md5, created, modified) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)",
  ).run(id, placeId, `photoref-${id}`, r2Key, 12345, `md5-${id}`, "2026-09-05 12:00:00.000000", "2026-09-05 12:00:00.000000");
}

function seedPhotos(): void {
  seedPhoto(PHOTO.salisbury, SALISBURY.placeId, "media/needs/at/salisbury/photo.jpg");
  seedPhoto(PHOTO.wilton, WILTON.placeId, "media/needs/at/salisbury/wilton/photo.jpg");
  seedPhoto(PHOTO.bemerton, BEMERTON.placeId, "media/needs/at/salisbury/bemerton-heath/photo.jpg");
  seedPhoto(PHOTO.waitrose, WAITROSE.placeId, "media/needs/at/salisbury/donationpoint/waitrose/photo.jpg");
  seedPhoto(PHOTO.amesbury, AMESBURY.placeId, "media/needs/at/amesbury/photo.jpg");
  seedPhoto(PHOTO.amesburyCentral, AMESBURY_CENTRAL.placeId, "media/needs/at/amesbury/amesbury-central/photo.jpg");
  seedPhoto(PHOTO.amesburyDepot, AMESBURY_DEPOT.placeId, "media/needs/at/amesbury/donationpoint/amesbury-depot/photo.jpg");
  seedPhoto(PHOTO.orphan, "place-99-nobody-owns-this", "media/needs/at/gone/photo.jpg");
  seedPhoto(PHOTO.nullPlace, null, "media/needs/at/nowhere/photo.jpg");
}

// The single source of truth for "did the DELETE happen, and only where it
// should have".
function photoIds(): number[] {
  return (db.prepare("SELECT id FROM placephoto ORDER BY id").all() as { id: number }[]).map((row) => row.id);
}

const ALL_PHOTOS = [PHOTO.wilton, PHOTO.bemerton, PHOTO.waitrose, PHOTO.salisbury, PHOTO.orphan, PHOTO.nullPlace].concat([
  PHOTO.amesbury,
  PHOTO.amesburyCentral,
  PHOTO.amesburyDepot,
]);
const EVERY_PHOTO_ID = [...ALL_PHOTOS].sort((a, b) => a - b);

// Raw stored INTEGER, not a boolean: the column has no CHECK constraint, and
// what downstream reads compare against is the literal 0 or 1
// (packages/db/src/placePhotos.ts:67,:73,:79 all spell it
// `place_has_photo = 1`). A boolean cast here would hide a stored "0" string
// or a stored NULL, both of which read as "no photo" in some places and "a
// photo" in others.
function hasPhoto(table: PlaceTable, id: number): number | null {
  const row = db.prepare(`SELECT place_has_photo FROM ${table} WHERE id = ?`).get(id) as { place_has_photo: number | null } | undefined;
  if (!row) throw new Error(`no ${table} row with id ${id}`);
  return row.place_has_photo;
}

// Every flag in the database, so "nothing else moved" is one assertion rather
// than a handful that a future fixture row could quietly escape.
function everyFlag(): [PlaceTable, number, number | null][] {
  const out: [PlaceTable, number, number | null][] = [];
  for (const table of ["foodbank", "foodbanklocation", "foodbankdonationpoint"] as const) {
    for (const row of db.prepare(`SELECT id, place_has_photo FROM ${table} ORDER BY id`).all() as { id: number; place_has_photo: number | null }[]) {
      out.push([table, row.id, row.place_has_photo]);
    }
  }
  return out;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seedPlaces();
  seedPhotos();
  r2Deletes = [];
  sessions = new Map([
    [
      `admin-session:${SESSION_ID}`,
      // expiresAt a full TTL ahead keeps getAdminSession()'s sliding-window
      // refresh from firing, so nothing here depends on the KV stub's put().
      JSON.stringify({ email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "", expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
    ],
  ]);
});

interface RequestOptions {
  method?: string;
  /** The `csrf_token` form field. `null` omits the field entirely. */
  csrfField?: string | null;
  /** The raw half of the `__Host-csrf` cookie. `null` omits the cookie. */
  csrfCookieRaw?: string | null;
  /** Overrides the cookie's signature, to forge one that will not verify. */
  csrfCookieSignature?: string;
  /** `null` omits `__Host-gfsession`, i.e. an anonymous visitor. */
  sessionId?: string | null;
  origin?: string | null;
  secFetchSite?: string | null;
  /** `true` sends the `HX-Request: true` htmx sends; a string sends that value. */
  hx?: boolean | string;
  /**
   * `null` leaves CSRF_SECRET unset in the environment. Spelled as null rather
   * than undefined on purpose: a default parameter treats an explicitly passed
   * `undefined` as "not passed", so `{ secret: undefined }` would silently get
   * the real secret and the fail-closed test would assert nothing.
   */
  secret?: string | null;
  /** Makes MEDIA.delete() reject, the way an R2 outage does. */
  r2Fails?: boolean;
  /**
   * Which router to send through. "mirror" (the default) is the hand-built
   * one, kept for the behaviour tests because it isolates this handler from
   * seventy-odd unrelated registrations. "real" is `adminApp` itself, and is
   * the only one that can notice a change to routes/admin/index.ts.
   */
  router?: "mirror" | "real";
}

// Mounted the way routes/admin/index.ts does it: the route registered on
// `adminApp` at the path index.ts:273 registers it at, behind the real
// requireAdminAuth from index.ts:85, and the sub-app grafted onto a parent
// under /admin. POST ONLY, exactly as production has it -- see the GET test
// for why that registration is the whole of the protection.
function makeApp(): Hono<AppEnv> {
  const adminApp = new Hono<AppEnv>();
  adminApp.use("*", requireAdminAuth);
  adminApp.post("/foodbank/:slug/photo/:photoId/delete/", adminPhotoDelete);

  const app = new Hono<AppEnv>();
  app.route("/admin", adminApp);
  // Caught and labelled rather than left to become an unhandled rejection, so
  // a regression reads as "expected 302, got 500: <message>" instead of a
  // vitest crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

// THE PRODUCTION ROUTER ITSELF. makeApp() above copies two lines of
// routes/admin/index.ts by hand, and a copy is by construction incapable of
// failing when the original changes -- see the header comment for the six
// index.ts edits that were applied to a scratch tree and survived it. Mounted
// at "/admin" exactly as workers/site/src/index.ts mounts it, and imported the
// way ten sibling suites in this directory import it, so this is the house
// pattern rather than a new one.
function makeRealApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route("/admin", adminApp);
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

async function send(path: string, options: RequestOptions = {}): Promise<Response> {
  const {
    method = "POST",
    csrfField = CSRF_RAW,
    csrfCookieRaw = CSRF_RAW,
    csrfCookieSignature,
    sessionId = SESSION_ID,
    origin = ORIGIN,
    secFetchSite = "same-origin",
    hx = false,
    secret = CSRF_SECRET,
    r2Fails = false,
    router = "mirror",
  } = options;

  const cookies: string[] = [];
  if (sessionId !== null) cookies.push(`${SESSION_COOKIE}=${sessionId}`);
  if (csrfCookieRaw !== null) {
    const signature = csrfCookieSignature ?? (await hmacSha256Hex(CSRF_SECRET, csrfCookieRaw));
    cookies.push(`__Host-csrf=${csrfCookieRaw}.${signature}`);
  }

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (cookies.length) headers.Cookie = cookies.join("; ");
  if (origin !== null) headers.Origin = origin;
  if (secFetchSite !== null) headers["Sec-Fetch-Site"] = secFetchSite;
  if (hx !== false) headers["HX-Request"] = typeof hx === "string" ? hx : "true";

  const body = csrfField === null ? "" : new URLSearchParams({ csrf_token: csrfField }).toString();

  const env = {
    DB: { withSession: () => d1Session(db) },
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => void sessions.set(key, value),
    },
    MEDIA: {
      delete: async (key: string) => {
        if (r2Fails) throw new Error("R2 unavailable");
        r2Deletes.push(key);
      },
    },
    CSRF_SECRET: secret ?? undefined,
  } as unknown as AppEnv["Bindings"];

  const app = router === "real" ? makeRealApp() : makeApp();
  return app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, ...(method === "POST" ? { body } : {}) }), env, execCtx);
}

function deleteUrl(photoId: number | string, slug = SALISBURY.slug): string {
  return `/admin/foodbank/${slug}/photo/${photoId}/delete/`;
}

// ---------------------------------------------------------------------------
// The delete actually happens -- all three halves of it
// ---------------------------------------------------------------------------

describe("adminPhotoDelete -- what reaches the database and R2", () => {
  // ISSUE #34's QUESTION, ASKED OF THIS BUTTON. Three writes, asserted
  // individually because they land in three different places and any one of
  // them going missing leaves a state nothing complains about: no row and a
  // set flag means the photos tab loses the row while the public photo route
  // still advertises one; a row and a cleared flag means the tab keeps showing
  // a photo the site will not serve; and the R2 object outliving both is a
  // paid-for byte nobody can reach.
  it("deletes the food bank's own photo, clears its flag and drops the R2 object", async () => {
    const res = await send(deleteUrl(PHOTO.salisbury));

    expect(res.status).toBe(302);
    expect(photoIds()).not.toContain(PHOTO.salisbury);
    expect(hasPhoto("foodbank", SALISBURY.id)).toBe(0);
    expect(r2Deletes).toEqual(["media/needs/at/salisbury/photo.jpg"]);
  });

  // The same three writes for a LOCATION's photo, which is the common case:
  // 1,972 locations against 1,071 food banks. getOwnedPhoto's CASE expression
  // is what picks the table name clearPlaceHasPhoto then interpolates
  // (placePhotos.ts:124-128); pin it to 'foodbank' and this test still deletes
  // the row and the object but clears the wrong flag, on a food bank that has
  // its own perfectly good photograph.
  it("deletes a location's photo and clears the flag on foodbanklocation, not on foodbank", async () => {
    const res = await send(deleteUrl(PHOTO.wilton));

    expect(res.status).toBe(302);
    expect(photoIds()).not.toContain(PHOTO.wilton);
    expect(hasPhoto("foodbanklocation", WILTON.id)).toBe(0);
    expect(hasPhoto("foodbank", SALISBURY.id)).toBe(1);
    expect(r2Deletes).toEqual(["media/needs/at/salisbury/wilton/photo.jpg"]);
  });

  // And for a donation point, which reaches the CASE's ELSE branch rather than
  // either EXISTS -- the one arm of the three that is chosen by exhaustion
  // rather than by a positive match, and so the one that would silently absorb
  // a fourth kind of place if one were ever added.
  it("deletes a donation point's photo and clears the flag on foodbankdonationpoint", async () => {
    const res = await send(deleteUrl(PHOTO.waitrose));

    expect(res.status).toBe(302);
    expect(photoIds()).not.toContain(PHOTO.waitrose);
    expect(hasPhoto("foodbankdonationpoint", WAITROSE.id)).toBe(0);
    expect(hasPhoto("foodbanklocation", WILTON.id)).toBe(1);
    expect(hasPhoto("foodbank", SALISBURY.id)).toBe(1);
    expect(r2Deletes).toEqual(["media/needs/at/salisbury/donationpoint/waitrose/photo.jpg"]);
  });

  // THE LOST-PREDICATE TEST. deletePlacePhoto is `DELETE FROM placephoto WHERE
  // id = ?` -- drop the WHERE and every one of the 7,122 photo rows goes, from
  // a button press that still answers 200 and still looks like it removed one
  // row from one table. The fixture holds nine photos across two food banks
  // precisely so that is visible here rather than in production.
  //
  // One mutant deliberately NOT chased: passing the URL's `photoId` to
  // deletePlacePhoto instead of the row's `photo.id`. It survives, and it is
  // equivalent -- getOwnedPhoto matched on `pp.id = ?2` bound to that same
  // `photoId`, so the two are the same number on every reachable path,
  // including the odd Number() spellings pinned further down. Recorded so the
  // survivor is a known equivalence rather than an untested line.
  it("removes exactly one row and leaves the other eight alone", async () => {
    await send(deleteUrl(PHOTO.wilton));

    expect(photoIds()).toEqual(EVERY_PHOTO_ID.filter((id) => id !== PHOTO.wilton));
  });

  // The same question of clearPlaceHasPhoto, whose UPDATE names no food bank
  // and is covered by no index -- so a widened or dropped predicate silently
  // switches off every photo on the site. Asserted over every flag in the
  // database at once.
  it("clears exactly one flag and leaves every other place set", async () => {
    await send(deleteUrl(PHOTO.wilton));

    expect(everyFlag()).toEqual([
      ["foodbank", SALISBURY.id, 1],
      ["foodbank", AMESBURY.id, 1],
      ["foodbanklocation", WILTON.id, 0],
      ["foodbanklocation", BEMERTON.id, 1],
      ["foodbanklocation", AMESBURY_CENTRAL.id, 1],
      ["foodbankdonationpoint", WAITROSE.id, 1],
      ["foodbankdonationpoint", AMESBURY_DEPOT.id, 1],
    ]);
  });

  // The stored INTEGER 0, not a string, not NULL, not `false`. Every read of
  // this column downstream is `place_has_photo = 1` (placePhotos.ts:67 etc.),
  // and SQLite's comparison rules make NULL fail that -- so a NULL here would
  // LOOK like a working delete on the tab while the media-backfill consumer's
  // own check (`place.hasPhoto === false`, placePhoto.ts:140) reads NULL as
  // "unknown" and re-buys the photograph from Google. Two billed calls per
  // page view, forever, from a delete that appeared to work.
  it("stores the integer 0, which is the only value the backfill consumer treats as a delete", async () => {
    await send(deleteUrl(PHOTO.wilton));

    const raw = db.prepare("SELECT place_has_photo FROM foodbanklocation WHERE id = ?").get(WILTON.id) as { place_has_photo: unknown };
    expect(raw.place_has_photo).toBe(0);
    expect(typeof raw.place_has_photo).toBe("number");
  });

  // THE KEY COMES FROM THE ROW, NOT FROM THE URL. 0018_placephoto.sql:16-19
  // says r2_key exists so a delete need not re-derive it, and this is the test
  // that holds that true: the seeded key here is deliberately not the
  // `"media" + url.pathname` shape the slugs would produce, so a handler that rebuilt
  // "media/needs/at/salisbury/wilton/photo.jpg" from the path deletes an
  // object that is not this photo's -- and leaves this photo's bytes in R2 for
  // the lifetime of the bucket.
  it("deletes the key the row records, even when it is not the canonical path", async () => {
    db.prepare("UPDATE placephoto SET r2_key = ? WHERE id = ?").run("media/legacy/imported/wilton-1080.jpg", PHOTO.wilton);

    await send(deleteUrl(PHOTO.wilton));

    expect(r2Deletes).toEqual(["media/legacy/imported/wilton-1080.jpg"]);
  });

  // ONE OBJECT, NOT A GUESSED FAMILY OF THEM. photoDelete.ts:48-53 spells out
  // why: serveMedia keys on the PATH alone (`"media" + url.pathname`,
  // routes/media.ts:137), leaving the `?s=` resize parameter out of the key, so
  // there is exactly one object per photo today, and PLAN.md:10586's future
  // 320/640/1080 derivatives must publish their key shape before anything here
  // starts deleting by pattern. Pinned so that inventing a naming scheme is a
  // failing test rather than a plausible-looking commit.
  it("makes exactly one R2 delete call, guessing no derivatives", async () => {
    await send(deleteUrl(PHOTO.wilton));

    expect(r2Deletes).toHaveLength(1);
  });

  // Django's `redirect("admin:foodbank", slug=foodbank.slug)` (views.py:1913),
  // which is the food bank detail page. Note the bare path with NO fragment --
  // the donation point and location deletes in this directory redirect to
  // `#donationpoints` / `#generallocations`, so the photos tab is the one that
  // sends the admin back to the top of the page rather than to the tab they
  // were working in. Pinned as the port's behaviour, matching Django's.
  it("redirects a non-htmx submission to the food bank page, with no fragment", async () => {
    const res = await send(deleteUrl(PHOTO.wilton));

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/foodbank/salisbury/");
  });

  // views.py:1911-1912's empty 200. foodbank_tabs/photos.njk:62 is
  // hx-swap="delete", which needs a successful response and nothing to swap
  // in; anything with a body would be discarded, and a 302 would make htmx
  // follow the redirect and swap a whole admin page into a <tr>.
  it("answers an htmx submission with an empty 200 and no redirect", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { hx: true });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Location")).toBeNull();
    // The write is NOT conditional on the header: an admin with JavaScript
    // off must get the same three writes, or their delete does nothing and
    // the page they are redirected to still shows the photo.
    expect(photoIds()).not.toContain(PHOTO.wilton);
    expect(hasPhoto("foodbanklocation", WILTON.id)).toBe(0);
    expect(r2Deletes).toHaveLength(1);
  });

  // Django tests `request.headers.get('HX-Request')` for TRUTHINESS, not for
  // the string "true", and photoDelete.ts:60 keeps that. htmx only ever sends
  // "true", so the two agree in practice; pinned because tightening it to
  // `=== "true"` looks like a harmless cleanup and would turn any other
  // caller's swap into a full-page redirect.
  it("takes any non-empty HX-Request value as htmx, as Django does", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { hx: "false" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  // The other side of that truthiness: an empty header value is falsy in both
  // languages, so it redirects. This is the case that tells "reads the header"
  // apart from "checks the header is present".
  it("treats an empty HX-Request value as not-htmx and redirects", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { hx: "" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/foodbank/salisbury/");
  });

  // A DOUBLE PRESS, which htmx makes easy: hx-swap="delete" removes the row
  // only after the response arrives, so an impatient second click on a slow
  // request is an ordinary occurrence. The second one must be a clean 404, not
  // a 500 and not a second R2 delete of a key that now belongs to nothing.
  it("404s the second press and does not touch R2 again", async () => {
    expect((await send(deleteUrl(PHOTO.wilton))).status).toBe(302);

    const second = await send(deleteUrl(PHOTO.wilton));

    expect(second.status).toBe(404);
    expect(r2Deletes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Ownership -- the whole point of the Django view
// ---------------------------------------------------------------------------

describe("adminPhotoDelete -- whose photo it is", () => {
  // views.py:1883-1906 collects every place_id the food bank owns and refuses
  // anything outside it. This is the test that says the refusal is real: the
  // photo id is valid, the row exists, the CSRF token is good and the admin is
  // signed in -- only the slug is somebody else's. A handler that dropped the
  // ownership union would answer 302 and delete Amesbury's photograph from a
  // URL under Salisbury.
  it("refuses another food bank's photo and deletes nothing anywhere", async () => {
    const res = await send(deleteUrl(PHOTO.amesbury));

    expect(res.status).toBe(404);
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(hasPhoto("foodbank", AMESBURY.id)).toBe(1);
    expect(r2Deletes).toEqual([]);
  });

  // The same refusal for another food bank's LOCATION photo, which is the arm
  // of the union that actually carries a foodbank_id predicate
  // (placePhotos.ts:46). Widen that to "every location" and this passes as a
  // delete.
  it("refuses another food bank's location photo", async () => {
    const res = await send(deleteUrl(PHOTO.amesburyCentral));

    expect(res.status).toBe(404);
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(hasPhoto("foodbanklocation", AMESBURY_CENTRAL.id)).toBe(1);
    expect(r2Deletes).toEqual([]);
  });

  // AND THE THIRD ARM. The union at placePhotos.ts:42-48 carries
  // `foodbank_id = ?1` three times -- once per place table -- and each copy has
  // to be pinned by a row the OTHER food bank owns in that same table, or a
  // lost predicate hides in the one arm nothing exercises. Measured, not
  // assumed: before AMESBURY_DEPOT was seeded, deleting `foodbank_id = ?1 AND`
  // from the donationpoint arm alone left the whole suite green, and that edit
  // lets any admin URL delete any donation point photograph on the site.
  it("refuses another food bank's donation point photo", async () => {
    const res = await send(deleteUrl(PHOTO.amesburyDepot));

    expect(res.status).toBe(404);
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(hasPhoto("foodbankdonationpoint", AMESBURY_DEPOT.id)).toBe(1);
    expect(r2Deletes).toEqual([]);
  });

  // A PINNED DIVERGENCE FROM DJANGO, deliberate and documented at
  // placePhotos.ts:116-120. Django's get_object_or_404 on the photo
  // (views.py:1881) runs BEFORE the ownership check, so a nonexistent id gave
  // 404 and somebody else's gave 403 -- an existence oracle over the whole
  // photo table. Collapsing both to 404 removes it. Asserted as one statement
  // so that a future "restore parity" change has to argue with the reason
  // rather than only with the status code.
  it("answers 404 for someone else's photo where Django answered 403", async () => {
    const someoneElses = await send(deleteUrl(PHOTO.amesbury));
    const nonexistent = await send(deleteUrl(999999));

    expect(someoneElses.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    // The LITERAL body, not merely "the two agree". Comparing them to each
    // other is self-referential: both refusals leave the handler through the
    // same `if (!photo) return c.notFound()`, so replacing that line with any
    // custom response changes both sides at once and the comparison stays
    // true. Measured -- swapping it for `c.text("no such photo", 404)`
    // survived the whole suite. Hono's own notFound() body is what the rest of
    // the admin area answers with, and an ownership refusal that announced
    // itself in different words would hand back exactly the existence oracle
    // the collapse above was written to remove.
    expect(await someoneElses.text()).toBe("404 Not Found");
    expect(await nonexistent.text()).toBe("404 Not Found");
  });

  // A photo whose place_id nothing owns any more -- what is left after a
  // location is deleted and its photograph is not. It is unreachable through
  // this route from ANY food bank's URL, so the row and its R2 object are
  // permanent: there is no admin path to either. Pinned as current behaviour,
  // not as a wish; cleaning up orphans is a job, not a button.
  it("cannot delete an orphaned photo from any food bank's URL", async () => {
    expect((await send(deleteUrl(PHOTO.orphan))).status).toBe(404);
    expect((await send(deleteUrl(PHOTO.orphan, AMESBURY.slug))).status).toBe(404);

    expect(photoIds()).toContain(PHOTO.orphan);
    expect(r2Deletes).toEqual([]);
  });

  // And the SQL reason a NULL-place_id row is unreachable, which is worth its
  // own case because it is not the same reason as the orphan's: getOwnedPhoto
  // matches with `pp.place_id IN (...)`, and `NULL IN (...)` is NULL -- never
  // true -- so the row is invisible even if a place with a NULL place_id
  // existed to "match" it.
  it("cannot delete a photo whose place_id is NULL", async () => {
    const res = await send(deleteUrl(PHOTO.nullPlace));

    expect(res.status).toBe(404);
    expect(photoIds()).toContain(PHOTO.nullPlace);
    expect(r2Deletes).toEqual([]);
  });

  // views.py:1880's get_object_or_404 on the food bank. The 404 is the only
  // thing standing between a mistyped slug and getOwnedPhoto being handed an
  // undefined food bank id.
  it("404s an unknown food bank slug and deletes nothing", async () => {
    const res = await send(deleteUrl(PHOTO.wilton, "not-a-foodbank"));

    expect(res.status).toBe(404);
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(r2Deletes).toEqual([]);
  });

  // THE ORDER OF THE GUARDS, which is only observable from outside like this.
  // photoDelete.ts looks the food bank up (line 34) BEFORE reading the body
  // and checking CSRF (lines 37-39), so a bad token on a real slug is 403
  // while the same bad token on an unknown slug is 404 -- i.e. the response
  // distinguishes food banks that exist from those that do not, without a
  // valid token. Harmless in practice because requireAdminAuth has already
  // run and every admin can list every food bank at /admin/foodbanks/, but
  // pinned so the ordering is a decision on the record rather than an
  // accident, and so a reshuffle that changed it is visible.
  it("reports the unknown slug ahead of the CSRF failure", async () => {
    const unknownSlug = await send(deleteUrl(PHOTO.wilton, "not-a-foodbank"), { csrfField: null });
    const knownSlug = await send(deleteUrl(PHOTO.wilton), { csrfField: null });

    expect(unknownSlug.status).toBe(404);
    expect(knownSlug.status).toBe(403);
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
  });
});

// ---------------------------------------------------------------------------
// Photo ids that are not ids
// ---------------------------------------------------------------------------

describe("adminPhotoDelete -- the photoId parameter", () => {
  // The user-visible outcome for an id that is not a whole number: a 404, and
  // in particular NOT a 500 -- a NaN or an Infinity must not reach the driver
  // and become the admin's error page.
  //
  // Stated plainly because it was checked rather than assumed: this case does
  // NOT pin `Number.isInteger` itself. Delete the guard and these still 404,
  // because SQLite binds NaN as NULL and matches no row, so the handler
  // arrives at the same c.notFound() by way of getOwnedPhoto instead. The
  // ordering test below is the one that proves the guard runs at all.
  it("404s ids that are not whole numbers, with no 500", async () => {
    for (const spelling of ["abc", "1.5", "Infinity", "NaN", "-"]) {
      const res = await send(deleteUrl(spelling));

      expect(res.status, `photoId spelling ${JSON.stringify(spelling)}`).toBe(404);
    }
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(r2Deletes).toEqual([]);
  });

  // THE GUARD'S ONLY ROUTE-VISIBLE TRACE. photoDelete.ts:30-31 parses and 404s
  // before it reads the body or checks CSRF, so a malformed id beats a missing
  // token; remove the guard and this exact request comes back 403 instead.
  it("404s a malformed photoId ahead of the CSRF check, not 403", async () => {
    const res = await send(deleteUrl("abc"), { csrfField: null, csrfCookieRaw: null });

    expect(res.status).toBe(404);
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
  });

  // SUSPECT, PINNED AS-IS rather than fixed -- the same laxness articles.ts
  // carries, recorded here because this route's action is destructive and that
  // one's is a toggle. Django's URL is
  // `foodbank/<slug:slug>/photo/<int:photo_id>/delete/`
  // (gfadmin/urls/foodbanks.py:24) and IntConverter's regex is [0-9]+, so
  // every spelling below is a 404 in Django: the URL simply does not match.
  // Here Hono's `:photoId` matches any segment and Number() is JavaScript's,
  // which takes a decimal point, an exponent, a leading plus, surrounding
  // whitespace and leading zeroes -- all of which Number.isInteger then waves
  // through. The result is a set of alternative URLs for the same delete.
  // Bounded by admin auth and CSRF, so not a hole; recorded because "/photo/
  // 9.001e3/delete/" deleting photo 9001 is not something anyone would predict
  // from reading either the route table or the Django original.
  it("accepts photoId spellings Django's <int:> converter would have 404ed", async () => {
    // "0x2329" is 9001 in hexadecimal, which Number() reads and Django's
    // [0-9]+ does not -- included because it is the one spelling that does not
    // even LOOK like the id it deletes.
    for (const spelling of ["9001.0", "9.001e3", "+9001", "%209001%20", "09001", "0x2329"]) {
      db.exec("DELETE FROM placephoto");
      db.prepare("UPDATE foodbank SET place_has_photo = 1 WHERE id = ?").run(SALISBURY.id);
      seedPhoto(PHOTO.salisbury, SALISBURY.placeId, "media/needs/at/salisbury/photo.jpg");
      r2Deletes = [];

      const res = await send(deleteUrl(spelling));

      expect(res.status, `photoId spelling ${spelling}`).toBe(302);
      expect(photoIds(), `photoId spelling ${spelling}`).toEqual([]);
      expect(hasPhoto("foodbank", SALISBURY.id), `photoId spelling ${spelling}`).toBe(0);
      expect(r2Deletes, `photoId spelling ${spelling}`).toEqual(["media/needs/at/salisbury/photo.jpg"]);
    }
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

// Django has no CSRF protection here at all -- CsrfViewMiddleware is commented
// out in production (settings.py:97) and photos.njk's hidden field is this
// port's addition (foodbank_tabs/photos.njk:9-13). So this block has no Django
// counterpart to match; it is PLAN.md §6.9 R3's correction, and the thing it
// prevents is a page on another site quietly deleting a food bank's
// photographs out of a signed-in admin's browser.
//
// Every case asserts the untouched row, the untouched flag AND the empty R2
// log as well as the status: a 403 that had already deleted the object would
// pass a status-only test while the bytes were gone.
describe("adminPhotoDelete -- CSRF", () => {
  function expectNothingHappened(): void {
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(hasPhoto("foodbanklocation", WILTON.id)).toBe(1);
    expect(r2Deletes).toEqual([]);
  }

  it("refuses a POST with no csrf_token field", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { csrfField: null });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expectNothingHappened();
  });

  it("refuses a POST whose token does not match the cookie", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { csrfField: "e".repeat(64) });

    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  it("refuses an empty csrf_token", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { csrfField: "" });

    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  // THE `if (!formToken) return false` GUARD ITSELF, which the case above does
  // NOT reach: there the submitted field is empty but the cookie's raw half is
  // 64 characters, so the double-submit comparison rejects it a few lines
  // later and the guard is never what refused. Measured -- relaxing the guard
  // to `formToken === undefined` survived every other test in this file.
  // Empty on BOTH sides is the request that tells them apart: the signature
  // over "" verifies, the two empty strings compare equal, and only the
  // emptiness check stands between that and a delete. Not reachable by an
  // attacker (signing "" still needs CSRF_SECRET), which is exactly why it
  // needs a test -- an unreachable guard is the kind a cleanup removes.
  it("refuses an empty token even when the cookie's raw half is empty too", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { csrfField: "", csrfCookieRaw: "" });

    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  it("refuses a POST with no __Host-csrf cookie at all", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { csrfCookieRaw: null });

    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  // The "signed" half of the signed double-submit. A sibling subdomain can set
  // a cookie value in some browsers' threat models; what it cannot do is sign
  // one. Forging the signature must not be enough even when the submitted
  // field agrees with the cookie, which it does here.
  it("refuses a cookie whose signature does not verify", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { csrfCookieSignature: "0".repeat(64) });

    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  it("refuses a cross-site request even with a matching token", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { secFetchSite: "cross-site" });

    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  it("refuses a request whose Origin is another site", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { origin: "https://evil.invalid", secFetchSite: null });

    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  // Older browsers send neither header, and verifyCsrf only checks each when
  // present -- so this is the case proving the signed double-submit, not the
  // Origin check, is what is actually holding the door.
  it("allows a request with neither Origin nor Sec-Fetch-Site, on the token alone", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { origin: null, secFetchSite: null });

    expect(res.status).toBe(302);
    expect(photoIds()).not.toContain(PHOTO.wilton);
  });

  // lib/csrf.ts:107-110 fails closed on a missing secret, deliberately, so a
  // misconfigured deployment cannot be mistaken for a working one. Pinned at
  // the route so nobody "fixes" the resulting 403s by making an absent secret
  // mean "skip the check".
  it("refuses everything when CSRF_SECRET is unset", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { secret: null });

    expect(res.status).toBe(403);
    expectNothingHappened();
  });
});

// ---------------------------------------------------------------------------
// Auth, and the method
// ---------------------------------------------------------------------------

describe("adminPhotoDelete -- the gate in front of it", () => {
  // requireAdminAuth is the real middleware, mounted as index.ts:85 mounts it.
  // The CSRF token here is perfectly valid, so the auth gate is the only thing
  // that can stop the delete -- which makes this a test of the gate rather
  // than of the token.
  it("never reaches the handler without a session", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { sessionId: null });

    expect(res.status).toBe(302);
    // The full /admin/... path has to survive the sub-app's rebasing, or the
    // admin is sent to the wrong page after signing in.
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2Fphoto%2F9002%2Fdelete%2F");
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(r2Deletes).toEqual([]);
  });

  // A cookie is not a session. An expired or revoked session id is simply
  // absent from KV and getAdminSession returns null for it -- the same outcome
  // as no cookie, asserted separately because "we found a cookie" is exactly
  // the shortcut a future refactor might take.
  it("never reaches the handler for a session id KV does not know", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { sessionId: "not-a-real-session" });

    expect(res.status).toBe(302);
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(r2Deletes).toEqual([]);
  });

  // GET MUST NOT DELETE. The route is registered POST-only (index.ts:273),
  // mirroring Django's @require_POST -- which photoDelete.ts:8-11 notes is the
  // one delete in gfadmin that was ALREADY POST-only, unlike its
  // donationpoint_delete sibling. So a link, a prefetch, a crawler or an
  // <img src> pointed at this URL cannot destroy a photograph.
  //
  // Where the protection lives is worth being precise about: it is the ROUTE
  // TABLE, not the handler. adminPhotoDelete never inspects c.req.method, so
  // registering it on a GET would delete on GET -- what stops that today is
  // the single `adminApp.post(...)` line and, behind it, the fact that
  // verifyCsrf reads its token from parseBody() only, which a GET has no way
  // to populate.
  //
  // Pinned divergence: Django's decorator answers 405 Method Not Allowed (the
  // URL matches, the method does not) whereas Hono's router finds no route and
  // answers 404. Same protection, different status; on the record here rather
  // than discovered from a log.
  //
  // This case goes through the MIRROR, so it proves the shape of the
  // protection and not that production has it -- the mirror's POST-only
  // registration is one this file wrote. The real one is checked at the end of
  // the file; both are kept because this one localises a regression to the
  // handler and that one to the route table.
  it("does not answer GET at all, and deletes nothing", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { method: "GET" });

    expect(res.status).toBe(404);
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(hasPhoto("foodbanklocation", WILTON.id)).toBe(1);
    expect(r2Deletes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// When R2 fails
// ---------------------------------------------------------------------------

describe("adminPhotoDelete -- an R2 failure", () => {
  // photoDelete.ts:54-56 deletes the object FIRST and the metadata second,
  // with no try/catch and no compensation. So an R2 outage aborts the whole
  // thing: the admin gets the 500 page, and -- the part worth pinning -- the
  // row and the flag are both still there, which is the recoverable direction.
  // Pressing the button again once R2 is back completes the delete.
  //
  // The other order would not be recoverable in the same way: metadata gone
  // and object still present leaves a paid-for byte with nothing pointing at
  // it. Pinned as current behaviour, and as the reason not to "tidy" the two
  // lines into a different order.
  it("leaves the row and the flag intact when the object cannot be deleted", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { r2Fails: true });

    expect(res.status).toBe(500);
    // The R2 rejection itself, not some other failure that happens to 500 --
    // otherwise a handler that threw before it ever reached MEDIA.delete would
    // pass this test while leaving the row intact for entirely the wrong
    // reason.
    expect(await res.text()).toBe("five hundred: R2 unavailable");
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(hasPhoto("foodbanklocation", WILTON.id)).toBe(1);
  });

  // And the retry after R2 comes back completes it -- so the 500 above really
  // is a clean abort and not a half-delete the admin has to unpick.
  it("completes on a retry once R2 is available again", async () => {
    await send(deleteUrl(PHOTO.wilton), { r2Fails: true });

    const res = await send(deleteUrl(PHOTO.wilton));

    expect(res.status).toBe(302);
    expect(photoIds()).not.toContain(PHOTO.wilton);
    expect(hasPhoto("foodbanklocation", WILTON.id)).toBe(0);
    expect(r2Deletes).toEqual(["media/needs/at/salisbury/wilton/photo.jpg"]);
  });
});

// ---------------------------------------------------------------------------
// Two places, one Google place id
// ---------------------------------------------------------------------------

// SUSPECT, PINNED AS-IS. Nothing stops two place rows holding the same
// place_id: neither foodbanklocation nor foodbankdonationpoint has any index
// on the column (0001_core.sql, and packages/db/src/placePhotos.test.ts:43-45
// records the same fact), and it is not a far-fetched shape -- a church that
// is both a distribution centre and a donation point is one Google place, and
// a location duplicated across two neighbouring food banks is an ordinary
// data-entry outcome. placephoto, by contrast, is UNIQUE on place_id: ONE
// photo row, ONE r2_key, for however many places share the id.
//
// The two tests below record what the delete does with that, in both
// directions. Neither is fixed here: a fix means either scoping
// clearPlaceHasPhoto by food bank (which does not help the same-food-bank
// case) or having getOwnedPhoto return every owning place rather than one --
// both changes to another package's SQL, and both needing the maintainer's
// view on whether shared place ids are legitimate data or a bug in their own
// right.
describe("adminPhotoDelete -- places that share one place_id", () => {
  // SAME FOOD BANK. getOwnedPhoto's CASE returns the FIRST matching table in a
  // fixed order (foodbank, then foodbanklocation, then donationpoint), so only
  // one of the two places has its flag cleared. The photo row and the R2
  // object are gone, but the donation point still says place_has_photo = 1 --
  // and the media-backfill consumer resolves the place from the R2 KEY, not
  // from the photo row (mediaBackfill/placePhoto.ts:57-77), so the first view
  // of the donation point's own /photo.jpg finds its flag set, buys the
  // photograph back from Google (two billed calls) and re-inserts the row the
  // admin just deleted. That is precisely the Django cache-bust behaviour this
  // port set out to end, surviving in the one case nobody would look for.
  it("clears only the first-matching table's flag, leaving the other place able to re-buy the photo", async () => {
    const shared = "place-77-shared";
    seedLocation(301, SALISBURY.id, "St Mary's Hall", "st-marys-hall", shared);
    seedDonationPoint(302, SALISBURY.id, "St Mary's Collection", "st-marys-collection", shared);
    seedPhoto(9500, shared, "media/needs/at/salisbury/st-marys-hall/photo.jpg");

    const res = await send(deleteUrl(9500));

    expect(res.status).toBe(302);
    expect(photoIds()).not.toContain(9500);
    expect(hasPhoto("foodbanklocation", 301)).toBe(0);
    // Still 1. Suspect, pinned, not fixed.
    expect(hasPhoto("foodbankdonationpoint", 302)).toBe(1);
  });

  // THE ORDER THE CASE RESOLVES IN, which the test above cannot see. It shares
  // a place_id between a location and a donation point, and those are the
  // second and third arms -- so swapping the FIRST two (foodbank and
  // foodbanklocation) leaves it green, measured. Only a food bank sharing a
  // place_id with one of its own locations distinguishes them, and it is not a
  // hypothetical shape: a food bank whose single site is also its registered
  // address is one Google place, entered twice. `foodbank` wins, so the food
  // bank's flag is the one cleared and the location keeps a flag pointing at a
  // photo row that no longer exists -- the same half-cleared state as the
  // sibling test, arrived at down a different arm.
  it("resolves a food bank ahead of its own location when they share a place_id", async () => {
    seedLocation(303, SALISBURY.id, "Head Office", "head-office", SALISBURY.placeId);

    const res = await send(deleteUrl(PHOTO.salisbury));

    expect(res.status).toBe(302);
    expect(photoIds()).not.toContain(PHOTO.salisbury);
    expect(hasPhoto("foodbank", SALISBURY.id)).toBe(0);
    // Still 1. Suspect, pinned, not fixed.
    expect(hasPhoto("foodbanklocation", 303)).toBe(1);
  });

  // DIFFERENT FOOD BANKS, and the opposite failure. clearPlaceHasPhoto's
  // UPDATE is `WHERE place_id = ?` with no food-bank predicate
  // (placePhotos.ts:157-158), so Salisbury's admin pressing delete also
  // switches off the flag on AMESBURY's location -- a food bank they were not
  // looking at, whose photograph then stops being served and, because the
  // backfill consumer honours the cleared flag, is not re-fetched either.
  // Nothing in either admin page reports it.
  it("clears the flag on another food bank's place that happens to share the id", async () => {
    const shared = "place-88-shared-across-foodbanks";
    seedLocation(401, SALISBURY.id, "Shared Hall", "shared-hall", shared);
    seedLocation(402, AMESBURY.id, "Shared Hall", "shared-hall", shared);
    seedPhoto(9600, shared, "media/needs/at/salisbury/shared-hall/photo.jpg");

    await send(deleteUrl(9600));

    expect(hasPhoto("foodbanklocation", 401)).toBe(0);
    // Amesbury's, cleared from a URL under Salisbury. Suspect, pinned, not
    // fixed.
    expect(hasPhoto("foodbanklocation", 402)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The production route registration
// ---------------------------------------------------------------------------

// Everything above this line goes through makeApp(), a hand-written copy of
// routes/admin/index.ts:85 and :273. These four go through `adminApp` itself,
// and the distinction was measured rather than argued: each of the following
// edits was applied to index.ts in a scratch tree and the suite re-run, and
// every one SURVIVED the mirror while breaking production.
//
//   * adding `adminApp.get("/foodbank/:slug/photo/:photoId/delete/", ...)`
//     beside the POST, or changing `post` to `all` -- a photograph is then
//     destroyed by a link, a prefetch, a crawler or an <img src>, and
//     photoDelete.ts never inspects c.req.method, so nothing downstream
//     objects. This is the "let a GET fall through into the POST branch"
//     mutant, and a suite that registers its own POST-only route cannot see
//     it. The whole of photoDelete.ts:8-11's @require_POST parity lives in
//     that one word.
//   * renaming the path, or renaming `:photoId` -- foodbank_tabs/photos.njk:60
//     hardcodes `/admin/foodbank/{{ foodbank_slug }}/photo/{{ p.photo_id
//     }}/delete/` into the hx-post, so every Delete button on the tab 404s
//     (or, for the param rename, Number(undefined) is NaN and every press
//     404s from inside the handler).
//   * deleting the registration outright -- the button 404s site-wide, and
//     every behaviour test above still passes because they never asked
//     production whether the route exists.
//   * deleting `adminApp.use("*", requireAdminAuth)` -- the entire admin area
//     opens to the internet, which the auth block above cannot notice because
//     it declares its own copy of that middleware.
//
// Four cases on purpose: this block pins the wiring, it does not re-run the
// handler's behaviour through a second router.
describe("adminPhotoDelete -- the production route registration", () => {
  // Path, method and param name, all three at once. Reads all three writes
  // back rather than trusting the 302, because a 302 from some OTHER
  // registration that happened to match would be just as green and just as
  // wrong -- and because a route that resolves but no longer reaches this
  // handler is exactly what a path rename produces.
  it("is reachable at the URL the photos tab posts to, and really writes", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { router: "real" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/foodbank/salisbury/");
    expect(photoIds()).not.toContain(PHOTO.wilton);
    expect(hasPhoto("foodbanklocation", WILTON.id)).toBe(0);
    expect(r2Deletes).toEqual(["media/needs/at/salisbury/wilton/photo.jpg"]);
  });

  // THE ONE THAT MATTERS MOST, and the only place in this file that can fail
  // when it stops being true. The handler has no method check of its own, so
  // the single word `post` in index.ts:273 is the whole of Django's
  // @require_POST -- and the R2 delete it guards is the one write here that
  // cannot be undone.
  it("answers no GET on the real router, so nothing can delete a photo by fetching a URL", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { method: "GET", router: "real" });

    expect(res.status).toBe(404);
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(hasPhoto("foodbanklocation", WILTON.id)).toBe(1);
    expect(r2Deletes).toEqual([]);
  });

  // The real `use("*", requireAdminAuth)`, not a re-declared one. The CSRF
  // token is entirely valid here, so the gate is the only thing that can stop
  // the delete, and the row is read back because a 302 that had already
  // dropped the R2 object is precisely the failure this exists to catch.
  it("puts the real admin gate in front of it", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { sessionId: null, router: "real" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2Fphoto%2F9002%2Fdelete%2F");
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(r2Deletes).toEqual([]);
  });

  // And CSRF survives the trip through the real mount. Cheap, and it rules out
  // "the mirror validated but production has a middleware ahead of it that
  // consumes the body first", which would leave parseBody() returning nothing
  // and every genuine submission failing instead.
  it("still refuses a bad token on the real router", async () => {
    const res = await send(deleteUrl(PHOTO.wilton), { csrfField: "c".repeat(64), router: "real" });

    expect(res.status).toBe(403);
    expect(photoIds()).toEqual(EVERY_PHOTO_ID);
    expect(hasPhoto("foodbanklocation", WILTON.id)).toBe(1);
    expect(r2Deletes).toEqual([]);
  });
});
