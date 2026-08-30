import {
  getFoodbanksByIds,
  getLocationsByIds,
  getOpenFoodbankCoordinates,
  getOpenLocationCoordinates,
  type CoordinateRow,
  type Session,
} from "@givefood/db";
import { R_EARTHDISTANCE, miles, nearest, type Ranked } from "@givefood/geo";
import { phoneOrFoodbankPhone, emailOrFoodbankEmail } from "./fields";

// Ported from givefood/utils/geo.py's find_locations() -- the query behind
// both gfwfbn's index page and gfapi2's location_search (already built,
// api2/locations.ts). Same candidate-fetch/rank/hydrate shape as that
// route (WP 2.5's proven pattern: thin coordinate rows ranked in memory,
// full rows fetched only for the survivors), decorated for template
// consumption instead of JSON-API output -- the two shapes diverge enough
// (this needs latest_need.change_text and facebook_page inline per item;
// the API needs a nested politics/urls/foodbank object) that duplicating
// the small amount of decoration logic was clearer than forcing one
// shared return shape through two very different consumers.
//
// PLAN.md §7.5.2: a single global nearest() call over the combined
// food-bank+location candidate set is contract-exact for every
// skip_first=False search (this one is) -- not the two-independently-
// capped-then-merged queries the Python source issues.
export interface LocationSearchResult {
  type: "organisation" | "location";
  name: string;
  slug: string;
  foodbank_slug: string;
  foodbank_name: string;
  distance_mi: number;
  phone_number: string | null;
  contact_email: string;
  facebook_page: string | null;
  latest_need_change_text: string;
}

type Candidate = { kind: "organisation" | "location"; coord: CoordinateRow };

export async function findLocations(
  session: Session,
  lat: number,
  lng: number,
  quantity: number,
): Promise<LocationSearchResult[]> {
  const [foodbankCoords, locationCoords] = await Promise.all([
    getOpenFoodbankCoordinates(session),
    getOpenLocationCoordinates(session),
  ]);

  const candidates: Candidate[] = [
    ...foodbankCoords.map((coord): Candidate => ({ kind: "organisation", coord })),
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

  const organisationIds = ranked.filter((r) => r.item.kind === "organisation").map((r) => r.item.coord.id);
  const locationIds = ranked.filter((r) => r.item.kind === "location").map((r) => r.item.coord.id);
  const [organisationFoodbanks, winningLocations] = await Promise.all([
    getFoodbanksByIds(session, organisationIds),
    getLocationsByIds(session, locationIds),
  ]);
  const locationById = new Map(winningLocations.map((loc) => [loc.id, loc]));
  const parentFoodbankIds = Array.from(new Set(winningLocations.map((loc) => loc.foodbank_id)));
  const parentFoodbanks = parentFoodbankIds.length === 0 ? [] : await getFoodbanksByIds(session, parentFoodbankIds);
  const foodbankById = new Map([...organisationFoodbanks, ...parentFoodbanks].map((fb) => [fb.id, fb]));

  return ranked.map(({ item, distanceM }) => {
    if (item.kind === "organisation") {
      const row = foodbankById.get(item.coord.id)!;
      // Frozen bug B12 (already reproduced in api2/locations.ts): a null
      // latest_need throws here exactly as it 500s in Django.
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
      };
    }
    const row = locationById.get(item.coord.id)!;
    const parentFoodbank = foodbankById.get(row.foodbank_id)!;
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
    };
  });
}
