import {
  getDonationPointsByIds,
  getFoodbanksByIds,
  getLocationsByIds,
  getOpenDonationPointCoordinates,
  getOpenDonationPointLocationCoordinates,
  type CoordinateRow,
  type Session,
} from "@givefood/db";
import { R_EARTHDISTANCE, miles, nearest, type Ranked } from "@givefood/geo";

// Ported from givefood/utils/geo.py's find_donationpoints() -- same
// candidate-fetch/rank/hydrate shape as gfapi2's donationpoint_search
// (already built, api2/donationpoints.ts), decorated for template
// consumption. See findLocations.ts's module comment for why this
// doesn't share a return shape with the API route despite the shared
// query pattern.
// No pre-built page/photo URL here (unlike Django's find_donationpoints(),
// which calls reverse() -- itself locale-aware, since it runs mid-request
// with the active language already set): this query function has no
// locale context, and building a `wfbn:*` URL without one would always
// come out unprefixed, wrong on every non-English page. slug/foodbank_slug
// are enough for the template to build the right URL itself via
// {{ url(...) }}, which *is* locale-aware (env.ts).
export interface DonationpointSearchResult {
  type: "donationpoint" | "location";
  name: string;
  slug: string;
  place_has_photo: boolean;
  foodbank_slug: string;
  foodbank_name: string;
  facebook_page: string | null;
  distance_mi: number;
  latest_need_change_text: string;
  latest_need_id: number;
}

type Candidate = { kind: "donationpoint" | "location"; coord: CoordinateRow };

export async function findDonationpoints(
  session: Session,
  lat: number,
  lng: number,
  quantity: number,
): Promise<DonationpointSearchResult[]> {
  const [donationPointCoords, locationCoords] = await Promise.all([
    getOpenDonationPointCoordinates(session),
    getOpenDonationPointLocationCoordinates(session),
  ]);

  const candidates: Candidate[] = [
    ...donationPointCoords.map((coord): Candidate => ({ kind: "donationpoint", coord })),
    ...locationCoords.map((coord): Candidate => ({ kind: "location", coord })),
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

  const donationPointIds = ranked.filter((r) => r.item.kind === "donationpoint").map((r) => r.item.coord.id);
  const locationIds = ranked.filter((r) => r.item.kind === "location").map((r) => r.item.coord.id);
  const [donationPoints, locations] = await Promise.all([
    getDonationPointsByIds(session, donationPointIds),
    getLocationsByIds(session, locationIds),
  ]);
  const donationPointById = new Map(donationPoints.map((dp) => [dp.id, dp]));
  const locationById = new Map(locations.map((loc) => [loc.id, loc]));

  const foodbankIds = Array.from(
    new Set([...donationPoints.map((dp) => dp.foodbank_id), ...locations.map((loc) => loc.foodbank_id)]),
  );
  const foodbanksWithNeed = await getFoodbanksByIds(session, foodbankIds);
  const foodbankById = new Map(foodbanksWithNeed.map((fb) => [fb.id, fb]));

  // flatMap and explicit misses, not `!` -- github #48; findLocations.ts
  // carries the full reasoning. Short version: ranking and hydration are
  // separate D1 reads, a row deleted between them is ranked and then not
  // found, and `!` turned that into a TypeError and a 500. Dropping the entry
  // is what Django's single ranking query already does. The `latestNeed!`s
  // below are frozen bug B12 and must keep throwing.
  return ranked.flatMap(({ item, distanceM }) => {
    if (item.kind === "donationpoint") {
      const row = donationPointById.get(item.coord.id);
      if (row === undefined) return [];
      const parentFoodbank = foodbankById.get(row.foodbank_id);
      if (parentFoodbank === undefined) return [];
      return {
        type: "donationpoint",
        name: row.name,
        slug: row.slug,
        place_has_photo: row.place_has_photo ?? false,
        foodbank_slug: row.foodbank_slug,
        foodbank_name: row.foodbank_name,
        facebook_page: parentFoodbank.facebook_page,
        distance_mi: miles(distanceM),
        // Frozen bug B12 (see findLocations.ts): unguarded, matches Django.
        latest_need_change_text: parentFoodbank.latestNeed!.change_text,
      latest_need_id: parentFoodbank.latestNeed!.id,
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
      place_has_photo: row.place_has_photo ?? false,
      foodbank_slug: row.foodbank_slug,
      foodbank_name: row.foodbank_name,
      facebook_page: parentFoodbank.facebook_page,
      distance_mi: miles(distanceM),
      latest_need_change_text: parentFoodbank.latestNeed!.change_text,
      latest_need_id: parentFoodbank.latestNeed!.id,
    };
  });
}
