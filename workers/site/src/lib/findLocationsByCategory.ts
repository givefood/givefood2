import {
  getFoodbankIdsByCategory,
  getFoodbanksByIds,
  getLocationsByIds,
  getOpenFoodbankCoordinates,
  getOpenLocationCoordinatesWithFoodbankId,
  type Session,
} from "@givefood/db";
import { R_EARTHDISTANCE, miles, nearest, type Ranked } from "@givefood/geo";
import { phoneOrFoodbankPhone, emailOrFoodbankEmail } from "@givefood/models";
import type { LocationSearchResult } from "./findLocations";

// Ported from givefood/utils/geo.py's find_locations_by_category() (:304-404)
// -- the query behind gfwfbn's index page "by item" tab
// (gfwfbn/views.py:93, `/needs/?item=`). Same candidate-fetch/rank/hydrate
// shape as findLocations.ts (this file's structural template), decorated
// into the same LocationSearchResult shape that template already consumes
// (wfbn/index.njk's `locations_by_category` loop is byte-identical to its
// `locations` loop).
//
// PLAN.md §4.8.5 flags a real problem with a mechanical port: Django
// builds `foodbank_ids_with_category` as a plain id list, then filters
// `FoodbankLocation.objects.filter(foodbank_id__in=foodbank_ids_with_category)`
// -- unbounded, hitting D1's 100-bound-parameter cap for any common
// category. PLAN.md sketches precomputing a category -> food-bank-id index
// into a second R2 object to route around it; this port takes a simpler
// path instead (the decision this file follows, not the R2 precompute):
// getFoodbankIdsByCategory() runs ONE query with 2 bound params total
// (category, the literal 'need') and returns the matching ids as a normal
// query RESULT, not a bound-parameter list. That result becomes a JS Set,
// tested against the existing full open-candidate coordinate sets (the
// same getOpenFoodbankCoordinates/getOpenLocationCoordinatesWithFoodbankId
// pattern findLocations.ts already uses) before ranking -- no unbounded
// IN(), no second R2 object to keep in sync.
//
// The 20 km ceiling (`max_distance_meters=20000` in the Python signature)
// is applied AFTER nearest() ranks and truncates to `quantity`, not
// before: nearest() sorts candidates by distance ascending and keeps only
// the closest `quantity`, so filtering that already-sorted, already-capped
// list by `distanceM <= 20000` afterward yields exactly the same rows
// Django's `.filter(distance__lte=max_distance_meters)[:quantity]` does
// (a threshold filter over a distance-ascending list commutes with taking
// its head) -- just without a second DB round trip to apply it.
// A DISCRIMINATED union since github #53, not one shape with a `kind` label
// beside it. The location branch's scan is
// getOpenLocationCoordinatesWithFoodbankId, so its rows really do carry a
// foodbank_id -- and the parent read now uses it. Typing both branches the
// same way hid that: `coord.foodbank_id` would not compile, which is what
// made deriving the parents from the hydrated rows look like the only
// option.
type Candidate =
  | { kind: "organisation"; coord: { id: number; latitude: number; longitude: number } }
  | { kind: "location"; coord: { id: number; latitude: number; longitude: number; foodbank_id: number } };

export async function findLocationsByCategory(
  session: Session,
  lat: number,
  lng: number,
  category: string,
  quantity: number,
): Promise<LocationSearchResult[]> {
  const [categoryFoodbankIds, foodbankCoords, locationCoords] = await Promise.all([
    getFoodbankIdsByCategory(session, category),
    getOpenFoodbankCoordinates(session),
    getOpenLocationCoordinatesWithFoodbankId(session),
  ]);
  const categoryIds = new Set(categoryFoodbankIds);

  const candidates: Candidate[] = [
    ...foodbankCoords
      .filter((coord) => categoryIds.has(coord.id))
      .map((coord): Candidate => ({ kind: "organisation", coord })),
    ...locationCoords
      .filter((coord) => categoryIds.has(coord.foodbank_id))
      .map((coord): Candidate => ({ kind: "location", coord })),
  ];

  const ranked: Ranked<Candidate>[] = nearest(
    candidates,
    lat,
    lng,
    (candidate) => [candidate.coord.latitude, candidate.coord.longitude],
    quantity,
    R_EARTHDISTANCE,
    false,
  );
  // The 20 km ceiling -- see this file's header comment on why applying it
  // here, after ranking/truncating, is equivalent to Django's DB-side
  // `distance__lte` filter.
  const withinRadius = ranked.filter((r) => r.distanceM <= 20000);

  const organisationIds = withinRadius.filter((r) => r.item.kind === "organisation").map((r) => r.item.coord.id);
  const locationIds = withinRadius.filter((r) => r.item.kind === "location").map((r) => r.item.coord.id);

  // ONE WAVE AND ONE FOOD BANK READ, NOT TWO OF EACH (github #53).
  //
  // The parent ids used to be derived from `winningLocations` -- the HYDRATED
  // rows -- which made the parent fetch wait for a read it did not actually
  // depend on. This function's candidate scan is
  // getOpenLocationCoordinatesWithFoodbankId, so every ranked location
  // already carries its foodbank_id: the ids are in hand before either read
  // is issued. That is why the merge is free HERE and is not free in
  // findLocations.ts, whose scan projects three columns and would need a
  // wider (non-covering) index to do the same.
  //
  // The two reads also collapse into one statement, since both wanted the
  // same table by id. `foodbankById` is a Map, so the union's order does not
  // matter, and getFoodbanksByIds deduplicates nothing it does not need to --
  // the Set does that first. A location whose parent is also a winning
  // organisation is counted once, which is the common case in a city centre.
  const parentFoodbankIds = withinRadius.flatMap((r) => (r.item.kind === "location" ? [r.item.coord.foodbank_id] : []));
  const allFoodbankIds = Array.from(new Set([...organisationIds, ...parentFoodbankIds]));
  const [foodbanks, winningLocations] = await Promise.all([
    getFoodbanksByIds(session, allFoodbankIds),
    getLocationsByIds(session, locationIds),
  ]);
  const locationById = new Map(winningLocations.map((loc) => [loc.id, loc]));
  const foodbankById = new Map(foodbanks.map((fb) => [fb.id, fb]));

  // flatMap and explicit misses, not `!` -- github #48; findLocations.ts
  // carries the full reasoning. Short version: ranking and hydration are
  // separate D1 reads, a row deleted between them is ranked and then not
  // found, and `!` turned that into a TypeError and a 500. Dropping the entry
  // is what Django's single ranking query already does. The `latestNeed!`s
  // below are frozen bug B12 and must keep throwing.
  return withinRadius.flatMap(({ item, distanceM }) => {
    if (item.kind === "organisation") {
      const row = foodbankById.get(item.coord.id);
      if (row === undefined) return [];
      // Frozen bug B12 (already reproduced in findLocations.ts/
      // api2/locations.ts): a null latest_need throws here exactly as it
      // 500s in Django. getFoodbankIdsByCategory() only ever returns ids
      // whose latest_need_id is non-null (its JOIN requires a matching
      // foodbankchangeline row), so this is unreachable in practice, not
      // a live gap.
      return {
        type: "organisation",
        name: row.name,
        slug: row.slug,
        foodbank_slug: row.slug,
        foodbank_name: row.name,
        distance_mi: miles(distanceM),
        phone_number: row.phone_number,
        contact_email: row.contact_email,
        facebook_page: row.facebook_page,
        latest_need_change_text: row.latestNeed!.change_text,
        latest_need_id: row.latestNeed!.id,
      };
    }
    const row = locationById.get(item.coord.id);
    if (row === undefined) return [];
    const parentFoodbank = foodbankById.get(row.foodbank_id);
    if (parentFoodbank === undefined) return [];
    return {
      type: "location",
      name: row.name,
      slug: row.slug,
      foodbank_slug: row.foodbank_slug,
      foodbank_name: row.foodbank_name,
      distance_mi: miles(distanceM),
      phone_number: phoneOrFoodbankPhone(row.phone_number, row.foodbank_phone_number),
      contact_email: emailOrFoodbankEmail(row.email, row.foodbank_email),
      facebook_page: parentFoodbank.facebook_page,
      latest_need_change_text: parentFoodbank.latestNeed!.change_text,
      latest_need_id: parentFoodbank.latestNeed!.id,
    };
  });
}
