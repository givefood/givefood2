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
type Candidate = { kind: "organisation" | "location"; coord: { id: number; latitude: number; longitude: number } };

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
  const [organisationFoodbanks, winningLocations] = await Promise.all([
    getFoodbanksByIds(session, organisationIds),
    getLocationsByIds(session, locationIds),
  ]);
  const locationById = new Map(winningLocations.map((loc) => [loc.id, loc]));
  const parentFoodbankIds = Array.from(new Set(winningLocations.map((loc) => loc.foodbank_id)));
  const parentFoodbanks = parentFoodbankIds.length === 0 ? [] : await getFoodbanksByIds(session, parentFoodbankIds);
  const foodbankById = new Map([...organisationFoodbanks, ...parentFoodbanks].map((fb) => [fb.id, fb]));

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
