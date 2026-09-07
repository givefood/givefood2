import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getPhotosForFoodbankTab,
  getOwnedPhoto,
  deletePlacePhoto,
  clearPlaceHasPhoto,
  getFoodbankPhotoCount,
  upsertPlacePhoto,
} from "./placePhotos";
import type { Session } from "./types";

// gfadmin/views.py:730-775 foodbank_photos_tab, :1877-1913 photo_delete,
// :596-603's photos_count and the metadata write the media-backfill queue
// consumer makes -- the whole of this port's photo feature, which is six
// statements and almost no JavaScript.
//
// WHY A REAL DATABASE, NOT A MOCK. Every export here is one SQL statement.
// A session handing back canned rows agrees with ANY statement -- including
// one that lost its `place_has_photo = 1` filter, joined the wrong way,
// ordered by the wrong key, or leaked another food bank's photos into this
// food bank's tab. Nothing in that list throws, logs or 500s: the tab renders
// a full, plausible grid of the wrong photographs, and the delete button
// cheerfully deletes a stranger's. This package carries the scar already --
// migration 0019 dropped six tables' cached parent columns and four queries
// went on naming them until /dashboard/beautybanks/ was measured and found to
// be a live 500 nobody had noticed. So the statements below are run, by
// SQLite, against the real schema.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order (the same
// approach as foodbankTabs.test.ts and crawlSets.test.ts): a CREATE TABLE
// transcribed into a test file is a second copy of the truth and drifts from
// the first. Three facts it supplies that a hand-written schema would very
// likely have got wrong, and that tests below depend on:
//   * `place_has_photo` is INTEGER and NULLABLE on all three place tables
//     (0001_core.sql:31, :65, :91), so `= 1` and "is truthy" are different
//     predicates -- see the NULL cases below.
//   * `placephoto.place_id` carries a UNIQUE index and `placephoto.photo_ref`
//     carries a second one (0018_placephoto.sql:50-51). upsertPlacePhoto's
//     ON CONFLICT target is the first; a collision on the second is a throw,
//     deliberately.
//   * NEITHER foodbanklocation NOR foodbankdonationpoint has any index on
//     `place_id`, unique or otherwise. clearPlaceHasPhoto's WHERE therefore
//     matches by value alone and can hit more than one row -- pinned below.
//
// NOT COVERED, deliberately: D1's 100-bound-parameter statement limit. No
// function here builds a variable-length IN list -- the three-way ownership
// union is a SUBQUERY, so the widest statement in the module binds two
// parameters no matter how many locations a food bank has. If one ever grows
// a JS-side `IN (${ids.map(() => "?")})`, that is the test to add.
//
// MUTANTS RUN AND FOUND EQUIVALENT, recorded so nobody spends the afternoon
// twice trying to write a test that catches one. Each was applied to a copy
// of the module and the whole file re-run; each passed, and in each case the
// schema is the reason it must:
//   * `UNION ALL` -> `UNION` in the tab query. Dedupe can only bite if two
//     rows agree in all eight selected columns. `ord` and place_type differ
//     between the three branches, and WITHIN a branch loc_fb_name_uniq /
//     dp_fb_name_uniq (0001_core.sql:76, :102) forbid two rows of one food
//     bank sharing a name -- so identical rows cannot exist.
//   * `pp.place_id` -> `l.place_id` (and `f.place_id`) in the tab's SELECT
//     list, and `COUNT(*)` -> `COUNT(DISTINCT pp.place_id)` in the count.
//     The first two are equal by the equijoin they are selected across; the
//     third by placephoto_place_id_uniq.
//   * `SET place_has_photo = 0` -> `= '0'`, and `WHERE place_id = ?` ->
//     `IS ?`, both in clearPlaceHasPhoto. place_has_photo has INTEGER
//     affinity, so SQLite converts the text on the way in and the column
//     still reads back as the number 0; and `=` and `IS` differ only on a
//     NULL bind, which the signature (`placeId: string`) and getOwnedPhoto's
//     own refusal of NULL place_ids both rule out.
//   * `created, modified` swapped in upsertPlacePhoto's column list. Both are
//     bound to the same `datetime('now')` call on insert, and only `modified`
//     appears in the DO UPDATE SET list, so the swap is invisible.
//   * `return row ?? null` -> `return row`, and `row?.n ?? 0` -> anything
//     else. D1's `.first()` returns null rather than undefined, and a
//     COUNT(*) always returns exactly one row, so neither fallback is
//     reachable through the real API.

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API this package is handed, backed by
// node:sqlite. Copied verbatim from foodbankTabs.test.ts (itself from
// crawlSets.test.ts, itself from
// workers/site/src/routes/admin/foodbankLocation.test.ts) so every tier drives
// the real code through one adapter. Deliberately dumb -- it forwards the SQL
// untouched and interprets nothing, so the engine decides which rows come
// back, not this file. That matters more here than usual: the statements in
// this module use NUMBERED placeholders (`?1`, `?2`), because `?1` appears
// three times in one statement, and node:sqlite binds those positionally by
// index exactly as D1 does.
function d1Session(db: DatabaseSync): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

// Django's timestamp spelling, "YYYY-MM-DD HH:MM:SS.ffffff", which is what
// pyNow() writes, what tools/pg-to-r2/load_photos.py wrote for the 7,122
// imported rows (isoformat(sep=" ")), and what migration 0022 rewrote the
// rest of the database into. These columns are TEXT and every comparison over
// them is byte-wise, so seeding ISO ("...T...Z") here would be testing a
// database this app does not have.
const DJANGO_EPOCH = "2020-01-01 00:00:00.000000";

const SALISBURY = 7;
const AMESBURY = 12;

// Place ids are opaque to every statement here -- they are only ever compared
// for equality -- so these are readable rather than realistic. A real one
// looks like "ChIJVXealLU_xkcRja_At0z9AGY"; upsertPlacePhoto's tests use that
// shape, since that is the value production actually holds.
//
// THE NUMBERING IS DELIBERATE AND ANTI-ALPHABETICAL. Every place id sorts in
// the OPPOSITE order to the name of the place holding it (Wilton is 01 and
// Bemerton Heath is 02; Waitrose is 11 and Co-op is 12), and the seed order
// matches the numbers. That is the only thing making `ORDER BY place_name`
// falsifiable: placephoto.place_id carries a UNIQUE index, so SQLite's chosen
// plan for the tab query scans it in place_id order, and with ids that happen
// to agree with the names the whole ORDER BY can be deleted and every
// assertion still passes. Measured, not assumed -- an earlier draft of this
// fixture used the ids "place-wilton" and "place-bemerton", and the
// `ORDER BY ord, place_name` -> `ORDER BY ord` mutant survived it.
const PLACE = {
  foodbank: "place-00-salisbury",
  wilton: "place-01-wilton",
  bemerton: "place-02-bemerton",
  downton: "place-03-downton",
  laverstock: "place-04-laverstock",
  tisbury: "place-06-tisbury",
  waitrose: "place-11-waitrose",
  coop: "place-12-coop",
  tesco: "place-13-tesco",
  amesbury: "place-20-amesbury-foodbank",
  amesburyCentral: "place-21-amesbury-central",
  boots: "place-22-boots",
} as const;
const FB_PLACE = PLACE.foodbank;

// `number | null`, not `0 | 1 | null`. The column really is a bare INTEGER
// with no CHECK constraint (0001_core.sql:31, :65, :91), and one test below
// stores a 2 in it deliberately to tell `place_has_photo = 1` apart from
// `place_has_photo != 0`. Narrowing this type would make that test
// unwritable without a cast, which would be the type system hiding the very
// thing the test is about.
type PlaceHasPhoto = number | null;

function seedFoodbank(
  db: DatabaseSync,
  { id, name, slug, placeId, hasPhoto }: { id: number; name: string; slug: string; placeId: string | null; hasPhoto: PlaceHasPhoto },
): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       place_id, place_has_photo,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       created, modified
     ) VALUES (?, ?, ?, ?, 'Address', 'SP2 9DY', 'England', '51.06,-1.79',
       ?, ?,
       0, 'info@example.org', 'https://example.org/', 'https://example.org/list/',
       0, 0, 0, 7, ?, ?)`,
  ).run(id, `uuid-fb-${id}`, name, slug, placeId, hasPhoto, DJANGO_EPOCH, DJANGO_EPOCH);
}

interface PlaceSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  placeId: string | null;
  hasPhoto: PlaceHasPhoto;
}

function seedLocation(db: DatabaseSync, { id, foodbankId, name, slug, placeId, hasPhoto }: PlaceSeed): void {
  db.prepare(
    `INSERT INTO foodbanklocation (
       id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng,
       place_id, place_has_photo, is_closed, modified
     ) VALUES (?, ?, ?, ?, ?, 'Address', 'SP2 9DY', 'England', '51.06,-1.79', ?, ?, 0, ?)`,
  ).run(id, `uuid-loc-${id}`, foodbankId, name, slug, placeId, hasPhoto, DJANGO_EPOCH);
}

function seedDonationPoint(db: DatabaseSync, { id, foodbankId, name, slug, placeId, hasPhoto }: PlaceSeed): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (
       id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng,
       place_id, place_has_photo, is_closed, in_store_only, modified
     ) VALUES (?, ?, ?, ?, ?, 'Address', 'SP2 9DY', 'England', '51.06,-1.79', ?, ?, 0, 0, ?)`,
  ).run(id, `uuid-dp-${id}`, foodbankId, name, slug, placeId, hasPhoto, DJANGO_EPOCH);
}

// photo ids are seeded FAR away from the place ids they belong to (9xxx vs
// 1xx/2xx) so that a statement returning `l.id` where it means `pp.id` --
// which would hand the delete route the wrong primary key, in a different
// table -- cannot accidentally produce a plausible-looking number.
function seedPhoto(db: DatabaseSync, id: number, placeId: string | null, r2Key = `media/needs/at/x/${id}/photo.jpg`): void {
  db.prepare(
    `INSERT INTO placephoto (id, place_id, photo_ref, html_attributions, r2_key, bytes, md5, created, modified)
     VALUES (?, ?, ?, '', ?, 1024, 'd41d8cd98f00b204e9800998ecf8427e', ?, ?)`,
  ).run(id, placeId, `ref-${id}`, r2Key, DJANGO_EPOCH, DJANGO_EPOCH);
}

let db: DatabaseSync;
let session: Session;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  session = d1Session(db);
});

// THE STANDARD FIXTURE. Salisbury owns:
//   * itself, with a photo
//   * two locations with photos, seeded (and numbered) in REVERSE alphabetical
//     order, so that neither insertion order nor place_id order can stand in
//     for `ORDER BY place_name`
//   * four locations that must NOT appear, one per exclusion the statement
//     makes: place_has_photo 0, place_has_photo NULL, place_id NULL, and a
//     perfectly good place with no placephoto row behind it
//   * two donation points with photos, likewise backwards, and one excluded by
//     the flag
// Amesbury is the OTHER food bank, fully populated with photos of its own.
// Without it every "scoped to this food bank" test would be vacuous: a
// statement that dropped its `foodbank_id = ?1` predicate would pass a suite
// that only ever seeded one food bank's rows.
function seedStandardFixture(): void {
  seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury", placeId: PLACE.foodbank, hasPhoto: 1 });
  seedFoodbank(db, { id: AMESBURY, name: "Amesbury", slug: "amesbury", placeId: PLACE.amesbury, hasPhoto: 1 });

  seedLocation(db, { id: 101, foodbankId: SALISBURY, name: "Wilton", slug: "wilton", placeId: PLACE.wilton, hasPhoto: 1 });
  seedLocation(db, { id: 102, foodbankId: SALISBURY, name: "Bemerton Heath", slug: "bemerton-heath", placeId: PLACE.bemerton, hasPhoto: 1 });
  seedLocation(db, { id: 103, foodbankId: SALISBURY, name: "Downton", slug: "downton", placeId: PLACE.downton, hasPhoto: 0 });
  seedLocation(db, { id: 104, foodbankId: SALISBURY, name: "Laverstock", slug: "laverstock", placeId: PLACE.laverstock, hasPhoto: null });
  seedLocation(db, { id: 105, foodbankId: SALISBURY, name: "Odstock", slug: "odstock", placeId: null, hasPhoto: 1 });
  seedLocation(db, { id: 106, foodbankId: SALISBURY, name: "Tisbury", slug: "tisbury", placeId: PLACE.tisbury, hasPhoto: 1 });

  seedDonationPoint(db, { id: 201, foodbankId: SALISBURY, name: "Waitrose Salisbury", slug: "waitrose", placeId: PLACE.waitrose, hasPhoto: 1 });
  seedDonationPoint(db, { id: 202, foodbankId: SALISBURY, name: "Co-op Castle Street", slug: "co-op", placeId: PLACE.coop, hasPhoto: 1 });
  seedDonationPoint(db, { id: 203, foodbankId: SALISBURY, name: "Tesco Southampton Road", slug: "tesco", placeId: PLACE.tesco, hasPhoto: 0 });

  seedLocation(db, { id: 150, foodbankId: AMESBURY, name: "Amesbury Central", slug: "central", placeId: PLACE.amesburyCentral, hasPhoto: 1 });
  seedDonationPoint(db, { id: 250, foodbankId: AMESBURY, name: "Boots Amesbury", slug: "boots", placeId: PLACE.boots, hasPhoto: 1 });

  seedPhoto(db, 9001, PLACE.foodbank, "media/needs/at/salisbury/photo.jpg");
  seedPhoto(db, 9002, PLACE.wilton, "media/needs/at/salisbury/wilton/photo.jpg");
  seedPhoto(db, 9003, PLACE.bemerton, "media/needs/at/salisbury/bemerton-heath/photo.jpg");
  seedPhoto(db, 9004, PLACE.downton, "media/needs/at/salisbury/downton/photo.jpg");
  seedPhoto(db, 9005, PLACE.laverstock, "media/needs/at/salisbury/laverstock/photo.jpg");
  seedPhoto(db, 9006, PLACE.waitrose, "media/needs/at/salisbury/donationpoint/waitrose/photo.jpg");
  seedPhoto(db, 9007, PLACE.coop, "media/needs/at/salisbury/donationpoint/co-op/photo.jpg");
  seedPhoto(db, 9008, PLACE.tesco, "media/needs/at/salisbury/donationpoint/tesco/photo.jpg");
  // Amesbury's three, which must never appear in a Salisbury answer.
  seedPhoto(db, 9101, PLACE.amesbury, "media/needs/at/amesbury/photo.jpg");
  seedPhoto(db, 9102, PLACE.amesburyCentral, "media/needs/at/amesbury/central/photo.jpg");
  seedPhoto(db, 9103, PLACE.boots, "media/needs/at/amesbury/donationpoint/boots/photo.jpg");
  // NOTE: no row for Tisbury's place id, and Odstock has none to have a row
  // for -- see the inner-join and NULL cases below.
}

describe("getPhotosForFoodbankTab", () => {
  beforeEach(seedStandardFixture);

  // views.py:744-771's three appends, in order: the food bank itself, then
  // `FoodbankLocation.objects.filter(foodbank=foodbank).order_by("name")`,
  // then foodbank_donation_points() (views.py:778-788), which is also
  // .order_by("name"). The port collapses that into `ORDER BY ord, place_name`
  // over a UNION ALL, and BOTH keys have to be falsifiable here:
  //   * drop `ord` and the list reorders to Bemerton Heath, Co-op, Salisbury,
  //     Waitrose, Wilton, iCentre -- one alphabetical run with the food bank
  //     buried among its own donation points.
  //   * drop `place_name` and SQLite returns each group in whatever order its
  //     chosen plan produces, which is NOT insertion order: EXPLAIN QUERY PLAN
  //     shows it driving the locations through loc_foodbank_slug_idx, so the
  //     natural order is by SLUG. Since production slugs are slugify()'d from
  //     the names, slug order usually agrees with name order and the missing
  //     key would be invisible -- which is exactly what happened to an earlier
  //     draft of this test. "iCentre Salisbury" is here to break that
  //     agreement, and it is realistic rather than contrived: a lowercase
  //     initial sorts AFTER every uppercase name under SQLite's BINARY
  //     collation ("i" is 0x69) while its slug sorts between bemerton-heath
  //     and wilton.
  // Asserted as the whole array in one comparison rather than as six
  // individual lookups, because "these rows, in this order, and no others" is
  // the actual claim.
  it("returns the food bank first, then its locations by name, then its donation points by name", async () => {
    seedLocation(db, { id: 113, foodbankId: SALISBURY, name: "iCentre Salisbury", slug: "icentre-salisbury", placeId: "place-33-icentre", hasPhoto: 1 });
    seedPhoto(db, 9113, "place-33-icentre");

    const photos = await getPhotosForFoodbankTab(session, SALISBURY);

    expect(photos.map((p) => [p.place_type, p.place_name])).toEqual([
      ["foodbank", "Salisbury"],
      ["location", "Bemerton Heath"],
      ["location", "Wilton"],
      ["location", "iCentre Salisbury"],
      ["donationpoint", "Co-op Castle Street"],
      ["donationpoint", "Waitrose Salisbury"],
    ]);
  });

  // views.py:750, :760 and :770 verbatim. Three different URL shapes, all
  // built from the PARENT food bank's slug -- note that the location and
  // donation point rows take their first segment from the joined foodbank
  // row, not from anything on the place itself, and that a donation point
  // gets an extra "/donationpoint/" segment. These are the src of the <img>
  // tags on the tab: get one wrong and the grid renders five broken images,
  // or worse, five copies of the food bank's own photo.
  it("derives each photo_url exactly as views.py:750, :760 and :770 do", async () => {
    const photos = await getPhotosForFoodbankTab(session, SALISBURY);

    expect(photos.map((p) => p.photo_url)).toEqual([
      "/needs/at/salisbury/photo.jpg",
      "/needs/at/salisbury/bemerton-heath/photo.jpg",
      "/needs/at/salisbury/wilton/photo.jpg",
      "/needs/at/salisbury/donationpoint/co-op/photo.jpg",
      "/needs/at/salisbury/donationpoint/waitrose/photo.jpg",
    ]);
  });

  // photo_id is placephoto.id, and it is the value the tab renders into the
  // delete form's action (routes/admin/photoDelete.ts takes :photoId and
  // hands it straight to getOwnedPhoto). Returning the PLACE's id instead
  // would still be an integer, still render, still POST -- and would delete
  // some unrelated photograph, or nothing at all. r2_key is the other value
  // that must be the photo row's own, because photoDelete.ts:54 passes it to
  // MEDIA.delete().
  it("returns placephoto's own id and r2_key, not the place row's", async () => {
    const photos = await getPhotosForFoodbankTab(session, SALISBURY);

    expect(photos.map((p) => p.photo_id)).toEqual([9001, 9003, 9002, 9007, 9006]);
    expect(photos.map((p) => p.place_id)).toEqual([FB_PLACE, PLACE.bemerton, PLACE.wilton, PLACE.coop, PLACE.waitrose]);
    expect(photos[1]?.r2_key).toBe("media/needs/at/salisbury/bemerton-heath/photo.jpg");
  });

  // views.py:573-576 place_ids_with_photos(): `place.place_id and
  // place.place_has_photo`. The port spells that `place_has_photo = 1`, and
  // the two halves of this test are why the module's comment bothers to
  // explain the spelling: the column is INTEGER 0/1/NULL, and under SQLite's
  // three-valued logic `NULL = 1` is UNKNOWN, so the row drops -- which is
  // what Python's truthiness test on None does too. Both rows below HAVE a
  // placephoto row waiting for them (9004, 9005); the flag is the only thing
  // keeping them off the tab, so a dropped predicate shows up here as two
  // extra photographs rather than as an error.
  // BOTH VALUES ON BOTH KINDS OF CHILD. The 0 case and the NULL case fall to
  // different mutants -- `place_has_photo != 0` still drops a NULL row, only
  // `place_has_photo IS NOT 0` lets it through -- so a branch tested with 0
  // alone is only half tested. The fixture supplies the NULL case for
  // locations (Laverstock) and, via upsertPlacePhoto's last test, for the
  // food bank itself; the donation point branch had no NULL row at all until
  // this one, and the `d.place_has_photo IS NOT 0` mutant survived the whole
  // file because of it.
  it("excludes a place whose place_has_photo is 0 or NULL, even though the photo row exists", async () => {
    seedDonationPoint(db, { id: 205, foodbankId: SALISBURY, name: "Morrisons Salisbury", slug: "morrisons", placeId: "place-15-morrisons", hasPhoto: null });
    seedPhoto(db, 9205, "place-15-morrisons");

    const photos = await getPhotosForFoodbankTab(session, SALISBURY);
    const names = photos.map((p) => p.place_name);

    expect(names).not.toContain("Downton"); // location, place_has_photo = 0
    expect(names).not.toContain("Laverstock"); // location, place_has_photo IS NULL
    expect(names).not.toContain("Tesco Southampton Road"); // donation point, place_has_photo = 0
    expect(names).not.toContain("Morrisons Salisbury"); // donation point, place_has_photo IS NULL
    // The photo rows really are there, so this is a filter test and not an
    // empty-database test.
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM placephoto WHERE place_id IN (?, ?, ?, ?)")
        .get(PLACE.downton, PLACE.laverstock, PLACE.tesco, "place-15-morrisons"),
    ).toEqual({ n: 4 });
  });

  // A DIVERGENCE FROM DJANGO, and the test that separates `= 1` from `!= 0`.
  // views.py:576's place_ids_with_photos is a Python truthiness test --
  // `place.place_id and place.place_has_photo` -- so 2, or any other non-zero
  // integer, passes it. The port spells the same filter `place_has_photo = 1`
  // and admits only the literal. Nothing constrains the column to 0/1/NULL:
  // it is a bare INTEGER with no CHECK on any of the three tables
  // (0001_core.sql:31, :65, :91), and the only thing keeping the domain
  // narrow is the one-time ETL that filled it.
  //
  // Pinned rather than fixed, because the port's reading is the safer one and
  // matching Python exactly would mean `!= 0`, which under SQLite's
  // three-valued logic is a different predicate again. Its real job here is
  // mutation coverage: with a fixture holding only 0, 1 and NULL, `= 1`,
  // `!= 0` and (on the branches with no NULL row) `IS NOT 0` are
  // indistinguishable, and both the `!= 0` mutants survived until this test.
  it("admits only the literal 1, where Django's Python truthiness test would accept any non-zero value", async () => {
    seedFoodbank(db, { id: 31, name: "Ludgershall", slug: "ludgershall", placeId: "place-43-ludgershall", hasPhoto: 2 });
    seedLocation(db, { id: 130, foodbankId: SALISBURY, name: "Britford", slug: "britford", placeId: "place-44-britford", hasPhoto: 2 });
    seedDonationPoint(db, { id: 230, foodbankId: SALISBURY, name: "Aldi Salisbury", slug: "aldi", placeId: "place-45-aldi", hasPhoto: 2 });
    seedPhoto(db, 9131, "place-43-ludgershall");
    seedPhoto(db, 9130, "place-44-britford");
    seedPhoto(db, 9230, "place-45-aldi");

    const names = (await getPhotosForFoodbankTab(session, SALISBURY)).map((p) => p.place_name);

    expect(names).not.toContain("Britford"); // location branch
    expect(names).not.toContain("Aldi Salisbury"); // donation point branch
    expect(await getPhotosForFoodbankTab(session, 31)).toEqual([]); // foodbank branch
  });

  // THE JOIN TO placephoto IS INNER ON ALL THREE BRANCHES, and all three have
  // to be shown separately. An earlier draft asserted only the location case
  // (Tisbury), and the mutants turning the FOOD BANK branch's and the
  // DONATION POINT branch's `JOIN placephoto` into `LEFT JOIN` both survived
  // the entire file.
  //
  // Each of the three places below is fully valid -- place_id set,
  // place_has_photo = 1 -- and simply has no photo row yet. That is an
  // ordinary state rather than corruption: place_has_photo is a one-time copy
  // of the Postgres value (0001_core.sql:31), so it is what every place looks
  // like between the flag arriving in the import and the media-backfill
  // consumer getting round to fetching the photograph. Under a LEFT JOIN each
  // arrives with photo_id and r2_key NULL -- a broken image above a delete
  // button posting to /photo/null/delete.
  it("excludes a place with no placephoto row behind it, on all three branches", async () => {
    seedDonationPoint(db, { id: 204, foodbankId: SALISBURY, name: "Sainsbury's Wilton Road", slug: "sainsburys", placeId: "place-14-sainsburys", hasPhoto: 1 });
    seedFoodbank(db, { id: 30, name: "Tidworth", slug: "tidworth", placeId: "place-40-tidworth", hasPhoto: 1 });

    const names = (await getPhotosForFoodbankTab(session, SALISBURY)).map((p) => p.place_name);

    expect(names).not.toContain("Tisbury"); // location branch
    expect(names).not.toContain("Sainsbury's Wilton Road"); // donation point branch
    expect(await getPhotosForFoodbankTab(session, 30)).toEqual([]); // foodbank branch
  });

  // THE TWO JOINS BACK TO foodbank (`lf` and `df`) ARE ALSO INNER, and this
  // is the only thing that makes them falsifiable. They exist solely to
  // supply the first segment of photo_url, so a LEFT JOIN changes nothing
  // whenever the parent row is present -- and both mutants survived until
  // this test, because every child in the fixture had a parent.
  //
  // PLAN.md §4.5 declares no foreign keys anywhere in this schema
  // (0018_placephoto.sql repeats it), so a child row naming a food bank that
  // is not there is a shape the database permits rather than one it forbids.
  // Under INNER JOIN it is simply absent; under LEFT JOIN the tab renders it
  // with a NULL slug, i.e. <img src="/needs/at/null/orphan-hall/photo.jpg">.
  it("drops a location or donation point whose food bank row is missing", async () => {
    const GHOST = 777;
    seedLocation(db, { id: 170, foodbankId: GHOST, name: "Orphan Hall", slug: "orphan-hall", placeId: "place-41-orphan-loc", hasPhoto: 1 });
    seedDonationPoint(db, { id: 270, foodbankId: GHOST, name: "Orphan Store", slug: "orphan-store", placeId: "place-42-orphan-dp", hasPhoto: 1 });
    seedPhoto(db, 9170, "place-41-orphan-loc");
    seedPhoto(db, 9270, "place-42-orphan-dp");

    expect(await getPhotosForFoodbankTab(session, GHOST)).toEqual([]);
    // Both rows and both photographs really are there, so this is the join
    // refusing them rather than an empty table.
    expect(db.prepare("SELECT COUNT(*) AS n FROM placephoto WHERE id IN (9170, 9270)").get()).toEqual({ n: 2 });
  });

  // Odstock has place_has_photo = 1 and no place_id at all, which is the
  // shape locationsAdmin.ts is careful to store as NULL rather than "".
  // TWO independent things keep it off the tab -- the `place_id IS NOT NULL`
  // predicate and SQLite's own `NULL = NULL` being UNKNOWN -- so this test
  // survives deleting the predicate. It is here for the third thing: a
  // placephoto row with a NULL place_id (0018 allows them; 0 exist in
  // production) must not attach itself to every place that lacks one.
  it("excludes a place with no place_id, and never matches NULL place_id against NULL", async () => {
    seedPhoto(db, 9999, null, "media/orphan/photo.jpg");

    const photos = await getPhotosForFoodbankTab(session, SALISBURY);

    expect(photos.map((p) => p.place_name)).not.toContain("Odstock");
    expect(photos.map((p) => p.photo_id)).not.toContain(9999);
  });

  // The predicate that makes this an admin page for ONE food bank. Amesbury
  // is seeded with a photo on each of the three kinds of place, so a
  // statement that lost `f.id = ?1` / `l.foodbank_id = ?1` /
  // `d.foodbank_id = ?1` -- or kept two of the three -- puts a stranger's
  // photographs on Salisbury's tab, next to a delete button. getOwnedPhoto
  // would refuse the delete, so the visible symptom is only ever "photos I
  // do not recognise", which is exactly the sort of thing nobody reports.
  it("shows nothing belonging to another food bank", async () => {
    const photos = await getPhotosForFoodbankTab(session, SALISBURY);

    expect(photos.map((p) => p.place_id).filter((id) => id.includes("amesbury") || id === PLACE.boots)).toEqual([]);
    // And the other direction, so this is a scoping test rather than an
    // ordering accident: Amesbury sees its own three and only those.
    expect((await getPhotosForFoodbankTab(session, AMESBURY)).map((p) => [p.place_type, p.place_name])).toEqual([
      ["foodbank", "Amesbury"],
      ["location", "Amesbury Central"],
      ["donationpoint", "Boots Amesbury"],
    ]);
  });

  it("returns an empty list for a food bank id that owns nothing, and for one that does not exist", async () => {
    seedFoodbank(db, { id: 99, name: "Andover", slug: "andover", placeId: null, hasPhoto: null });

    expect(await getPhotosForFoodbankTab(session, 99)).toEqual([]);
    expect(await getPhotosForFoodbankTab(session, 12345)).toEqual([]);
  });

  // A DIVERGENCE FROM DJANGO, pinned rather than fixed (TESTING.md's rule).
  // `ORDER BY place_name` runs under SQLite's default BINARY collation, so
  // every uppercase letter sorts before every lowercase one and accented
  // letters sort after all of ASCII. Django ordered the same list in Postgres
  // under en_US.utf8, which is case- and accent-insensitive at the primary
  // level, so it would have returned these two the other way round.
  // types.ts's own sortByName() exists for exactly this problem and is used
  // by the public-facing queries; this statement does not use it, because the
  // ordering is interleaved with `ord` and cannot be reproduced by a single
  // JS sort on name alone. The consequence is cosmetic -- a photo grid on an
  // admin tab -- which is why it is recorded here instead of changed.
  it("orders by SQLite's byte-wise collation, not Postgres's linguistic one", async () => {
    // These two also carry the `ORDER BY place_name` mutant, for free and
    // realistically: slugify() lowercases, so the slug order (apple, zebra)
    // is the opposite of the BINARY name order (Zebra, apple) -- and the slug
    // is what SQLite's chosen plan walks. The place ids are numbered to agree
    // with the slugs rather than the names for the same reason.
    seedLocation(db, { id: 111, foodbankId: SALISBURY, name: "apple Court", slug: "apple", placeId: "place-31-apple", hasPhoto: 1 });
    seedLocation(db, { id: 112, foodbankId: SALISBURY, name: "Zebra Court", slug: "zebra", placeId: "place-32-zebra", hasPhoto: 1 });
    seedPhoto(db, 9111, "place-31-apple");
    seedPhoto(db, 9112, "place-32-zebra");

    const locations = (await getPhotosForFoodbankTab(session, SALISBURY)).filter((p) => p.place_type === "location").map((p) => p.place_name);

    // "Z" is 0x5A and "a" is 0x61. Postgres would have said apple, Bemerton,
    // Wilton, Zebra.
    expect(locations).toEqual(["Bemerton Heath", "Wilton", "Zebra Court", "apple Court"]);
  });

  // CARDINALITY, and a faithful port of a Django quirk. views.py:735-740
  // builds `place_photos` as a dict keyed by place_id and then asks
  // `if <place>.place_id in place_photos` once per place, so one photograph
  // shown against two places is exactly what Django did when a food bank and
  // one of its locations shared a Place ID (the same building, entered
  // twice). The UNION ALL reproduces it. Pinned because the obvious "fix" --
  // a DISTINCT or a GROUP BY on pp.id -- would silently drop the second row
  // and change behaviour the public API's Place-ID-keyed photo URLs still
  // depend on. Note the delete button under both copies carries the SAME
  // photo_id, so deleting either removes both.
  it("lists one photo twice when a food bank and its own location share a Place ID", async () => {
    seedLocation(db, { id: 120, foodbankId: SALISBURY, name: "Main Office", slug: "main-office", placeId: FB_PLACE, hasPhoto: 1 });

    const shared = (await getPhotosForFoodbankTab(session, SALISBURY)).filter((p) => p.place_id === FB_PLACE);

    expect(shared.map((p) => [p.place_type, p.photo_id, p.photo_url])).toEqual([
      ["foodbank", 9001, "/needs/at/salisbury/photo.jpg"],
      ["location", 9001, "/needs/at/salisbury/main-office/photo.jpg"],
    ]);
  });

  // A REAL DIVERGENCE FROM DJANGO, found by reading views.py:735-771 rather
  // than by reasoning from the port, and pinned as the port behaves.
  //
  // Django builds ONE set of place_ids (place_ids_with_photos over the food
  // bank plus its locations plus its donation points), turns it into the
  // `place_photos` dict, and then asks only `if <place>.place_id in
  // place_photos` -- it never re-checks THAT place's own place_has_photo. So
  // when two of a food bank's places share a Place ID and only one of them
  // has the flag set, the flagged one puts the id into the dict and the
  // unflagged one is shown as well. The port asks the question per branch
  // (`f.place_has_photo = 1` AND `l.place_has_photo = 1`), so it shows only
  // the flagged place: five rows here where Django rendered six.
  //
  // Low severity -- it needs one building entered twice with mismatched flags
  // -- and the port's answer is the more defensible one, which is why this
  // records the difference instead of reproducing Django's. Deleting the test
  // would lose the only place this asymmetry is written down.
  it("applies place_has_photo per place, where Django applied it to the shared id set", async () => {
    seedLocation(db, { id: 121, foodbankId: SALISBURY, name: "Annex", slug: "annex", placeId: FB_PLACE, hasPhoto: 1 });
    db.prepare("UPDATE foodbank SET place_has_photo = 0 WHERE id = ?").run(SALISBURY);

    const shared = (await getPhotosForFoodbankTab(session, SALISBURY)).filter((p) => p.place_id === FB_PLACE);

    // Django would have returned the food bank's row here too, because
    // FB_PLACE is in its place_photos dict by way of the Annex.
    expect(shared.map((p) => [p.place_type, p.place_name])).toEqual([["location", "Annex"]]);
  });
});

describe("getOwnedPhoto", () => {
  beforeEach(seedStandardFixture);

  // views.py:1883-1906. The owner_table is not decoration: photoDelete.ts:56
  // feeds it straight back as a table name in clearPlaceHasPhoto's UPDATE,
  // so a CASE that answered "foodbank" for a location's photo would clear the
  // flag on the wrong row -- leaving the location's at 1, which is precisely
  // the state in which mediaBackfill/placePhoto.ts:147 buys the photo back
  // from Google on the next request. A wrong answer here is a delete that
  // undoes itself, plus two billed API calls.
  it("names the table each photo's place actually lives in", async () => {
    expect(await getOwnedPhoto(session, SALISBURY, 9001)).toEqual({
      id: 9001,
      place_id: FB_PLACE,
      r2_key: "media/needs/at/salisbury/photo.jpg",
      owner_table: "foodbank",
    });
    expect((await getOwnedPhoto(session, SALISBURY, 9002))?.owner_table).toBe("foodbanklocation");
    expect((await getOwnedPhoto(session, SALISBURY, 9006))?.owner_table).toBe("foodbankdonationpoint");
  });

  // THE WHOLE POINT OF THE VIEW, in views.py's own words. Amesbury's three
  // photos exist and their ids are perfectly guessable from Salisbury's tab
  // (they are sequential integers in one table), so without the ownership
  // predicate any admin could delete any photograph on the site by URL.
  it("refuses another food bank's photo, whichever kind of place holds it", async () => {
    expect(await getOwnedPhoto(session, SALISBURY, 9101)).toBeNull(); // Amesbury itself
    expect(await getOwnedPhoto(session, SALISBURY, 9102)).toBeNull(); // its location
    expect(await getOwnedPhoto(session, SALISBURY, 9103)).toBeNull(); // its donation point
    // The rows are there; it is the ownership check refusing them, not an
    // empty table.
    expect(await getOwnedPhoto(session, AMESBURY, 9102)).toMatchObject({ id: 9102, owner_table: "foodbanklocation" });
  });

  // The module's documented divergence, asserted so it stays deliberate:
  // Django's get_object_or_404 (views.py:1881) runs BEFORE the ownership
  // check, so a nonexistent id gave 404 and a stranger's photo gave 403 --
  // an existence oracle. Both collapse to null here, and photoDelete.ts:46
  // turns both into a 404.
  it("returns null for a photo that does not exist, exactly as for one it may not touch", async () => {
    expect(await getOwnedPhoto(session, SALISBURY, 999999)).toBeNull();
  });

  // place_has_photo is NOT part of the ownership check, and must not become
  // part of it. A photo whose flag has already been cleared is invisible on
  // the tab (see the filter test above) but still exists in R2 and in
  // placephoto; the delete route is the only thing that can finish removing
  // it. Copying the tab query's `= 1` predicate into here would make that
  // row permanently undeletable.
  it("ignores place_has_photo, so an already-hidden photo can still be deleted", async () => {
    expect(await getOwnedPhoto(session, SALISBURY, 9004)).toMatchObject({ id: 9004, owner_table: "foodbanklocation" });
    expect(await getOwnedPhoto(session, SALISBURY, 9005)).toMatchObject({ id: 9005, owner_table: "foodbanklocation" });
  });

  // The CASE is a WHEN/WHEN/ELSE chain, so when one place_id is held by more
  // than one kind of place the first branch wins: foodbank, then location,
  // then -- by exhaustion, not by test -- donation point. Pinned because the
  // consequence is asymmetric. Clearing the flag on the foodbank row leaves
  // the location's at 1, and the backfill consumer keys on the LOCATION's
  // flag when the request is for the location's photo URL, so the photograph
  // comes back for that URL and not for the other. That is a hazard rather
  // than a bug -- one photo genuinely belongs to two places here -- but the
  // precedence should not change by accident.
  it("resolves a shared Place ID to foodbank before location, and location before donation point", async () => {
    seedLocation(db, { id: 120, foodbankId: SALISBURY, name: "Main Office", slug: "main-office", placeId: FB_PLACE, hasPhoto: 1 });
    seedDonationPoint(db, { id: 220, foodbankId: SALISBURY, name: "Front Desk", slug: "front-desk", placeId: FB_PLACE, hasPhoto: 1 });
    expect((await getOwnedPhoto(session, SALISBURY, 9001))?.owner_table).toBe("foodbank");

    // Same place id on a location and a donation point, with the food bank
    // itself out of the picture.
    seedDonationPoint(db, { id: 221, foodbankId: SALISBURY, name: "Wilton Desk", slug: "wilton-desk", placeId: PLACE.wilton, hasPhoto: 1 });
    expect((await getOwnedPhoto(session, SALISBURY, 9002))?.owner_table).toBe("foodbanklocation");
  });

  // EACH CASE BRANCH IS SCOPED TO THIS FOOD BANK, and until this test neither
  // scope was falsifiable: the `WHERE id = ?1` and `WHERE foodbank_id = ?1`
  // inside the two EXISTS subqueries could both be deleted and the whole file
  // still passed, because no OTHER food bank in the fixture shared a Place ID
  // with one of Salisbury's places.
  //
  // Sharing across food banks is the ordinary case, not the exotic one: two
  // food banks that both collect at the same supermarket record the same
  // Google Place ID, which is exactly why clearPlaceHasPhoto's own test
  // pins them clearing each other's flag. The damage an unscoped branch does
  // is quiet and specific -- getOwnedPhoto still returns a row (ownership is
  // decided by the IN, not the CASE), but names the wrong TABLE, so
  // photoDelete.ts:56 clears place_has_photo on a table the photograph's
  // place is not in. The admin's own place keeps its flag at 1,
  // mediaBackfill/placePhoto.ts:147 re-buys the photo from Google on the next
  // request, and a stranger's place quietly loses its photograph instead.
  it("decides owner_table from THIS food bank's places, not from anyone else's", async () => {
    // Another food bank's own place_id equals one of Salisbury's LOCATIONS'.
    seedFoodbank(db, { id: 30, name: "Tidworth", slug: "tidworth", placeId: PLACE.wilton, hasPhoto: 1 });
    // Another food bank's LOCATION shares one of Salisbury's DONATION POINTS'.
    seedLocation(db, { id: 180, foodbankId: AMESBURY, name: "Waitrose Hall", slug: "waitrose-hall", placeId: PLACE.waitrose, hasPhoto: 1 });

    expect((await getOwnedPhoto(session, SALISBURY, 9002))?.owner_table).toBe("foodbanklocation");
    expect((await getOwnedPhoto(session, SALISBURY, 9006))?.owner_table).toBe("foodbankdonationpoint");
    // And from the other side, so the CASE is answering per food bank rather
    // than just preferring the earliest branch: the same two photographs
    // resolve differently for Tidworth and Amesbury.
    expect((await getOwnedPhoto(session, 30, 9002))?.owner_table).toBe("foodbank");
    expect((await getOwnedPhoto(session, AMESBURY, 9006))?.owner_table).toBe("foodbanklocation");
  });

  // `pp.place_id IN (subquery)` where pp.place_id is NULL evaluates to NULL,
  // never true, so an orphan photo row is unownable by anybody -- including
  // the food bank whose places all have NULL place_ids. Worth pinning: the
  // subquery's own `place_id IS NOT NULL` filters are what stop the list
  // containing NULLs, and a reader who removed them as redundant would be
  // relying on this second, less obvious rule instead.
  it("returns null for a photo whose place_id is NULL", async () => {
    seedPhoto(db, 9999, null, "media/orphan/photo.jpg");

    expect(await getOwnedPhoto(session, SALISBURY, 9999)).toBeNull();
  });
});

describe("deletePlacePhoto", () => {
  beforeEach(seedStandardFixture);

  function photoIds(): number[] {
    return (db.prepare("SELECT id FROM placephoto ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  }

  it("deletes exactly the row it is given and nothing beside it", async () => {
    const before = photoIds();

    await deletePlacePhoto(session, 9002);

    expect(photoIds()).toEqual(before.filter((id) => id !== 9002));
  });

  // views.py:1908 photo.delete() has the same property: by the time it runs,
  // the ownership check has already passed. This function is deliberately
  // unguarded -- it deletes by primary key alone -- which is safe only
  // because photoDelete.ts:45-55 refuses to reach it without a getOwnedPhoto
  // answer first. Pinned so that anyone tempted to call it from a second
  // route knows the check is not in here.
  it("performs no ownership check of its own", async () => {
    await deletePlacePhoto(session, 9101); // Amesbury's, called with no session context at all

    expect(photoIds()).not.toContain(9101);
  });

  it("is a silent no-op for an id that is not there", async () => {
    const before = photoIds();

    await expect(deletePlacePhoto(session, 999999)).resolves.toBeUndefined();

    expect(photoIds()).toEqual(before);
  });

  // The other half of the delete lives in clearPlaceHasPhoto, and the reason
  // it has to is that this statement leaves the owning row untouched. Django
  // stopped here, which is why its "Delete" was a cache bust: place_has_photo
  // stayed 1 and geo.py:107-141 re-bought the photograph on the next request.
  it("leaves place_has_photo alone, which is why the route calls clearPlaceHasPhoto too", async () => {
    await deletePlacePhoto(session, 9002);

    expect(db.prepare("SELECT place_has_photo FROM foodbanklocation WHERE id = 101").get()).toEqual({ place_has_photo: 1 });
  });
});

describe("clearPlaceHasPhoto", () => {
  beforeEach(seedStandardFixture);

  const flag = (table: string, id: number): unknown =>
    (db.prepare(`SELECT place_has_photo FROM ${table} WHERE id = ?`).get(id) as { place_has_photo: unknown }).place_has_photo;

  it("clears the flag on each of the three place tables", async () => {
    await clearPlaceHasPhoto(session, "foodbank", FB_PLACE);
    await clearPlaceHasPhoto(session, "foodbanklocation", PLACE.wilton);
    await clearPlaceHasPhoto(session, "foodbankdonationpoint", PLACE.waitrose);

    expect(flag("foodbank", SALISBURY)).toBe(0);
    expect(flag("foodbanklocation", 101)).toBe(0);
    expect(flag("foodbankdonationpoint", 201)).toBe(0);
  });

  // 0, NEVER NULL. mediaBackfill/placePhoto.ts:147 declines to re-buy the
  // photograph only when `place.hasPhoto === false`, and types.ts's
  // coerceBooleans maps 0 to false and NULL to null -- so a statement that
  // wrote NULL here would look like it had cleared the flag while leaving the
  // backfill consumer free to fetch the photo again from Google. That is
  // Django's cache-bust behaviour re-created by accident, at two billed calls
  // a time.
  it("writes 0, not NULL, because the backfill consumer tests for exactly false", async () => {
    await clearPlaceHasPhoto(session, "foodbanklocation", PLACE.wilton);

    expect(flag("foodbanklocation", 101)).toBe(0);
    expect(flag("foodbanklocation", 101)).not.toBeNull();
  });

  // The `table` argument is the whole reason getOwnedPhoto computes an
  // owner_table: the same Place ID can legitimately sit on a food bank, a
  // location and a donation point at once (one building, three rows), and a
  // delete of the food bank's photo must not silently hide the other two.
  it("touches only the table it is told to, when all three hold the same Place ID", async () => {
    seedLocation(db, { id: 120, foodbankId: SALISBURY, name: "Main Office", slug: "main-office", placeId: FB_PLACE, hasPhoto: 1 });
    seedDonationPoint(db, { id: 220, foodbankId: SALISBURY, name: "Front Desk", slug: "front-desk", placeId: FB_PLACE, hasPhoto: 1 });

    await clearPlaceHasPhoto(session, "foodbanklocation", FB_PLACE);

    expect(flag("foodbanklocation", 120)).toBe(0);
    expect(flag("foodbank", SALISBURY)).toBe(1);
    expect(flag("foodbankdonationpoint", 220)).toBe(1);
  });

  it("leaves every other Place ID in that table alone", async () => {
    await clearPlaceHasPhoto(session, "foodbanklocation", PLACE.wilton);

    expect(flag("foodbanklocation", 102)).toBe(1); // Bemerton Heath
    expect(flag("foodbanklocation", 106)).toBe(1); // Tisbury
  });

  // A HAZARD, pinned rather than fixed. The WHERE is `place_id = ?` and
  // nothing else -- no food bank id, no row id -- and neither
  // foodbanklocation nor foodbankdonationpoint has any index on place_id, let
  // alone a unique one (0001_core.sql:76-81, :102-107). So two food banks
  // that have each recorded the same shared building clear each other's flag:
  // Amesbury's admin deletes a photo and a location of Salisbury's silently
  // stops showing one. The alternative -- passing the owning ROW's id, which
  // getOwnedPhoto does not currently return -- would be a wider change than
  // this test, and the case may well be desirable (one place, one photo, one
  // delete). Recorded so the decision is visible either way.
  it("clears EVERY row in the table with that Place ID, including another food bank's", async () => {
    seedLocation(db, { id: 160, foodbankId: AMESBURY, name: "Shared Hall", slug: "shared-hall", placeId: PLACE.wilton, hasPhoto: 1 });

    await clearPlaceHasPhoto(session, "foodbanklocation", PLACE.wilton);

    expect(flag("foodbanklocation", 101)).toBe(0); // Salisbury's Wilton, the intended target
    expect(flag("foodbanklocation", 160)).toBe(0); // Amesbury's, collateral
  });
});

describe("getFoodbankPhotoCount", () => {
  beforeEach(seedStandardFixture);

  // The gate on the tab existing at all (foodbank_detail.njk, mirroring
  // gfadmin/templates/admin/foodbank.html:51's `{% if counts.photos %}`).
  // The fixture holds eight photo rows against Salisbury's places and three
  // against Amesbury's, so this is a scoping assertion as much as a counting
  // one: the ownership subquery is the only thing keeping the other food
  // bank's three out.
  it("counts every photo behind this food bank's places, and none behind anyone else's", async () => {
    expect(await getFoodbankPhotoCount(session, SALISBURY)).toBe(8);
    expect(await getFoodbankPhotoCount(session, AMESBURY)).toBe(3);
  });

  // COUNT(*), not COUNT(<some column>), and the difference is production
  // data rather than pedantry: 0018_placephoto.sql records 26 rows whose
  // photo_ref is NULL (PLAN.md:945), because Google has no photo_reference
  // for some places. COUNT ignores NULLs in its argument, so the mutant
  // `COUNT(pp.photo_ref)` -- which survived an earlier draft of this file --
  // undercounts by exactly those rows, and a food bank whose only photograph
  // is one of the 26 loses its Photos tab entirely: the trigger is gated on a
  // non-zero count (foodbank_detail.njk, mirroring
  // gfadmin/templates/admin/foodbank.html:51) and the photo becomes
  // undeletable through the admin.
  it("counts a photo whose photo_ref is NULL, which COUNT of any column would not", async () => {
    db.prepare("UPDATE placephoto SET photo_ref = NULL WHERE id = ?").run(9002);

    expect(await getFoodbankPhotoCount(session, SALISBURY)).toBe(8);
    expect((await getPhotosForFoodbankTab(session, SALISBURY)).map((p) => p.photo_id)).toContain(9002);
  });

  it("returns 0 for a food bank with no photos and for an id that does not exist", async () => {
    seedFoodbank(db, { id: 99, name: "Andover", slug: "andover", placeId: null, hasPhoto: null });

    expect(await getFoodbankPhotoCount(session, 99)).toBe(0);
    expect(await getFoodbankPhotoCount(session, 12345)).toBe(0);
  });

  // SUSPECT, PINNED AS-IS. Django's photos_count (views.py:600-603) filters
  // through place_ids_with_photos() for the food bank and its locations and
  // through `place_has_photo=True` for the donation points -- i.e. the SAME
  // predicate the tab uses. This statement has no place_has_photo predicate
  // at all, so it counts photo rows the tab will then refuse to show. The
  // fixture already contains that state: 8 counted, 5 displayed.
  //
  // It is reachable in production, not just in a fixture. The media-backfill
  // consumer inserts a placephoto row without ever setting place_has_photo
  // (mediaBackfill/placePhoto.ts:172, and see upsertPlacePhoto's tests
  // below), and it proceeds whenever the flag is NULL rather than 0 -- so any
  // place imported with a NULL flag that later gets a photo lands in exactly
  // this gap. The visible symptom is a Photos tab that opens onto an empty
  // grid. Not fixed here: this file pins behaviour, and the one-line fix is
  // the maintainer's call to make in the source.
  it("does NOT filter on place_has_photo, so it can exceed what the tab will show", async () => {
    const counted = await getFoodbankPhotoCount(session, SALISBURY);
    const shown = (await getPhotosForFoodbankTab(session, SALISBURY)).length;

    expect(counted).toBe(8);
    expect(shown).toBe(5);
    expect(counted).toBeGreaterThan(shown);
  });

  // The narrowest form of the same gap, and the one that would make a
  // reviewer look twice: every flag cleared, every photo row still present,
  // tab empty, trigger still rendered.
  it("still reports a photo whose place_has_photo has been cleared", async () => {
    await clearPlaceHasPhoto(session, "foodbank", FB_PLACE);
    await clearPlaceHasPhoto(session, "foodbanklocation", PLACE.wilton);
    await clearPlaceHasPhoto(session, "foodbanklocation", PLACE.bemerton);
    await clearPlaceHasPhoto(session, "foodbankdonationpoint", PLACE.waitrose);
    await clearPlaceHasPhoto(session, "foodbankdonationpoint", PLACE.coop);

    expect(await getPhotosForFoodbankTab(session, SALISBURY)).toEqual([]);
    expect(await getFoodbankPhotoCount(session, SALISBURY)).toBe(8);
  });

  // The UNION ALL yields the shared place_id twice, but `place_id IN (...)`
  // is a membership test, so the photo is counted once -- while the tab lists
  // it twice. Django's count behaves the same way (it counts PlacePhoto rows,
  // not places), so this asymmetry is faithful, and it is the reason the
  // count must not be "fixed" by counting the tab's rows instead.
  it("counts a photo once even when two of the food bank's places share its Place ID", async () => {
    seedLocation(db, { id: 120, foodbankId: SALISBURY, name: "Main Office", slug: "main-office", placeId: FB_PLACE, hasPhoto: 1 });

    expect(await getFoodbankPhotoCount(session, SALISBURY)).toBe(8);
    expect((await getPhotosForFoodbankTab(session, SALISBURY)).filter((p) => p.place_id === FB_PLACE)).toHaveLength(2);
  });

  // An orphan photo row belongs to nobody: `NULL IN (...)` is UNKNOWN, never
  // true, so it is counted for no food bank at all rather than for every one
  // of them. That is SQLite's doing rather than the statement's -- removing
  // the subquery's `place_id IS NOT NULL` guards changes nothing here, which
  // was run as a mutant and confirmed -- so this pins the OUTCOME, which is
  // the part that would show up as an empty Photos tab on all 1,071 food
  // banks if a future rewrite lost it.
  it("ignores a photo row with a NULL place_id", async () => {
    seedPhoto(db, 9999, null, "media/orphan/photo.jpg");

    expect(await getFoodbankPhotoCount(session, SALISBURY)).toBe(8);
  });
});

// The one write in this module, called by mediaBackfill/placePhoto.ts:172
// after it has fetched a photograph from Google Places and PUT it into R2.
const REAL_PLACE_ID = "ChIJVXealLU_xkcRja_At0z9AGY";
const REAL_PHOTO_REF = "AeeoHcK9rN2vQ8xJ_lm3sYd7pW1fT0gHbC5uZaXe";

function newPhoto(overrides: Partial<Parameters<typeof upsertPlacePhoto>[1]> = {}) {
  return {
    placeId: REAL_PLACE_ID,
    photoRef: REAL_PHOTO_REF,
    htmlAttributions: '<a href="https://maps.google.com/maps/contrib/1">A Photographer</a>',
    r2Key: "media/needs/at/salisbury/photo.jpg",
    bytes: 148_233,
    md5: "9bb58f26192e4ba00f01e2e7b136bbd8",
    ...overrides,
  };
}

function storedPhoto(placeId: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM placephoto WHERE place_id = ?").get(placeId) as Record<string, unknown>;
}

describe("upsertPlacePhoto", () => {
  // Every value read back by name, because the failure this catches is a
  // column list and a VALUES tuple that disagree by one: bind r2Key where
  // html_attributions is named and the whole tail shifts, storing a URL in
  // the attributions column and the byte count in the key. SQLite accepts all
  // of it -- the columns are TEXT and INTEGER in an order that happens to
  // tolerate the shift -- and the first sign of trouble is a 404 on a photo
  // whose r2_key is "148233".
  it("writes each value into the column it belongs in", async () => {
    await upsertPlacePhoto(session, newPhoto());

    const row = storedPhoto(REAL_PLACE_ID);
    expect(row.photo_ref).toBe(REAL_PHOTO_REF);
    expect(row.html_attributions).toBe('<a href="https://maps.google.com/maps/contrib/1">A Photographer</a>');
    expect(row.r2_key).toBe("media/needs/at/salisbury/photo.jpg");
    expect(row.bytes).toBe(148_233);
    expect(row.md5).toBe("9bb58f26192e4ba00f01e2e7b136bbd8");
  });

  // A DIVERGENCE, pinned. Every other write site in this package stamps
  // timestamps with pyNow() -- Django's "YYYY-MM-DD HH:MM:SS.ffffff", which
  // migration 0022 normalised the whole database into and which ticket #9
  // exists because of. This statement uses SQLite's own datetime('now'),
  // which is UTC (good) but has NO fractional part, so placephoto.created
  // holds two spellings at once: the ETL's six-digit form for the 7,122
  // imported rows, and this second-resolution form for everything the
  // backfill has written since.
  //
  // It is currently harmless, and the second assertion is why: these columns
  // are TEXT and compared byte-wise, and a shorter string that is a prefix of
  // a longer one sorts BEFORE it -- the same direction Python's own
  // fraction-omitting str(datetime) already produced. So a row written in the
  // same second as an ETL row sorts first rather than, as an ISO "T" would,
  // jumping to the top of the whole day. Nothing orders or thresholds on
  // these two columns today; if anything ever does, this is the test that
  // says the format is not what the rest of the database uses.
  it("stamps created and modified with SQLite's datetime('now'), which omits the microseconds pyNow() writes", async () => {
    await upsertPlacePhoto(session, newPhoto());

    const row = storedPhoto(REAL_PLACE_ID);
    expect(row.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.modified).toBe(row.created);
    // Not Django's format, and not toISOString()'s either.
    expect(row.created).not.toMatch(/\.\d{6}$/);
    expect(row.created).not.toContain("T");
    // The ordering consequence, executed rather than reasoned about.
    const sameSecond = `${String(row.created)}.500000`;
    expect(db.prepare("SELECT ? < ? AS earlier").get(String(row.created), sameSecond)).toEqual({ earlier: 1 });
  });

  // THE REASON THE STATEMENT IS ON CONFLICT AND NOT INSERT OR REPLACE, in the
  // module's own words: `id` is the row's identity for the admin's delete
  // route, and REPLACE deletes and reinserts, handing the same photograph a
  // new id every time a backfill re-ran. A delete form rendered before that
  // and submitted after would then 404 -- or, once ids were reused, delete
  // something else. `created` staying put is the other half: it is absent
  // from the DO UPDATE SET list on purpose, so the row remembers when the
  // photograph first arrived.
  //
  // EVERY VALUE HERE DIFFERS FROM THE SEEDED ROW, and each difference kills a
  // mutant that a lazier fixture let through (both were run, not imagined):
  //   * a NEW photo_ref, because Google hands out a different photo_reference
  //     for the same place over time -- which is why the SET list refreshes it
  //     at all. Re-upserting with the SAME ref makes `ON CONFLICT(place_id)`
  //     and `ON CONFLICT(photo_ref)` indistinguishable; with a new one the
  //     wrong target stops matching, and the write dies on
  //     placephoto_place_id_uniq instead of updating.
  //   * a NEW r2_key, because media.ts derives the key from the URL path and
  //     the path contains the place's slug -- rename a location and the
  //     backfill stores the photo under a new key. Drop `r2_key` from the SET
  //     list and the row goes on pointing at the old object, so the admin's
  //     delete removes a file nothing serves and leaves the live one in R2
  //     for ever.
  it("keeps the row's id and its created date when the same place is re-fetched", async () => {
    seedPhoto(db, 4242, REAL_PLACE_ID, "media/needs/at/salisbury/photo.jpg"); // photo_ref "ref-4242"

    await upsertPlacePhoto(
      session,
      newPhoto({ r2Key: "media/needs/at/salisbury-central/photo.jpg", md5: "0000000000000000ffffffffffffffff", bytes: 999 }),
    );

    const row = storedPhoto(REAL_PLACE_ID);
    expect(row.id).toBe(4242);
    expect(row.created).toBe(DJANGO_EPOCH);
    expect(row.modified).not.toBe(DJANGO_EPOCH);
    expect(row.md5).toBe("0000000000000000ffffffffffffffff");
    expect(row.bytes).toBe(999);
    expect(row.photo_ref).toBe(REAL_PHOTO_REF);
    expect(row.r2_key).toBe("media/needs/at/salisbury-central/photo.jpg");
    expect(row.html_attributions).toBe('<a href="https://maps.google.com/maps/contrib/1">A Photographer</a>');
    expect(db.prepare("SELECT COUNT(*) AS n FROM placephoto").get()).toEqual({ n: 1 });
  });

  it("inserts a second row for a different place rather than overwriting the first", async () => {
    await upsertPlacePhoto(session, newPhoto());
    await upsertPlacePhoto(session, newPhoto({ placeId: "ChIJ68J3tUsbdkgRDVK5UPlkX4A", photoRef: "different-ref", r2Key: "media/needs/at/x/photo.jpg" }));

    expect(db.prepare("SELECT COUNT(*) AS n FROM placephoto").get()).toEqual({ n: 2 });
    expect(storedPhoto(REAL_PLACE_ID).r2_key).toBe("media/needs/at/salisbury/photo.jpg");
  });

  // Deliberately NOT swallowed, and the module says why: a photo_ref
  // collision means two places claim one Google photo reference, which is
  // worth seeing in the DLQ rather than silently resolving. ON CONFLICT names
  // place_id only, so the second unique index is left to raise -- and this
  // test is what stops someone "tidying" it into ON CONFLICT DO NOTHING or a
  // second conflict target, either of which would make the queue consumer
  // report success on a photo it never stored.
  it("lets a photo_ref collision throw instead of resolving it", async () => {
    await upsertPlacePhoto(session, newPhoto());

    await expect(upsertPlacePhoto(session, newPhoto({ placeId: "ChIJ68J3tUsbdkgRDVK5UPlkX4A" }))).rejects.toThrow(/UNIQUE/i);
  });

  // 0018_placephoto.sql's own note: photo_ref has 26 NULLs in production and
  // SQLite treats every NULL as distinct from every other, so the UNIQUE
  // index accepts all of them -- matching Postgres. If that were not true the
  // import would have failed, and a backfill of a place Google has no
  // reference for would fail too.
  it("accepts a NULL photo_ref more than once, because the unique index is NULL-distinct", async () => {
    await upsertPlacePhoto(session, newPhoto({ photoRef: null }));
    await upsertPlacePhoto(session, newPhoto({ placeId: "ChIJ68J3tUsbdkgRDVK5UPlkX4A", photoRef: null, r2Key: "media/needs/at/x/photo.jpg" }));

    expect(db.prepare("SELECT COUNT(*) AS n FROM placephoto WHERE photo_ref IS NULL").get()).toEqual({ n: 2 });
  });

  // It writes to placephoto and to nothing else. That is what makes
  // getFoodbankPhotoCount's missing place_has_photo predicate reachable in
  // production rather than only in a fixture: the backfill can add a photo
  // row for a place whose flag is NULL (mediaBackfill/placePhoto.ts:147 only
  // declines when the flag is exactly 0), after which the Photos tab is
  // offered and opens empty. Pinned here, at the write site, because this is
  // where a fix would most naturally be mistaken for the right one -- setting
  // the flag here would change what the delete button means.
  it("does not set place_has_photo on the place it just photographed", async () => {
    seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury", placeId: REAL_PLACE_ID, hasPhoto: null });

    await upsertPlacePhoto(session, newPhoto());

    expect(db.prepare("SELECT place_has_photo FROM foodbank WHERE id = ?").get(SALISBURY)).toEqual({ place_has_photo: null });
    expect(await getFoodbankPhotoCount(session, SALISBURY)).toBe(1);
    expect(await getPhotosForFoodbankTab(session, SALISBURY)).toEqual([]);
  });
});
