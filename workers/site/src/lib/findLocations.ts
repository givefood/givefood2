import {
  getFoodbanksByIds,
  getLocationsByIds,
  getOpenFoodbankCoordinates,
  getOpenLocationCoordinates,
  type CoordinateRow,
  type Session,
} from "@givefood/db";
import { R_EARTHDISTANCE, miles, nearest, type Ranked } from "@givefood/geo";
import { phoneOrFoodbankPhone, emailOrFoodbankEmail } from "@givefood/models";

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
//
// `skipFirst` (default false, matching every existing caller -- the
// /needs/ index page) threads straight through to nearest()'s own
// skipFirst param, for gfwfbn/foodbank_nearby's find_locations(lat_lng,
// 20, True) call (routes/wfbn/nearby.ts): a global scan, not the
// two-leg-then-merge Python does, per @givefood/geo/nearest.ts's own
// documented divergence note and PLAN.md's "Documented divergence"
// writeup -- see routes/wfbn/nearby.ts for the resulting known-divergence
// food bank ids.
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
  // NULLABLE (github #13). An open food bank with no published need is an
  // ordinary state the admin creates -- adding a food bank before its first
  // need, or unpublishing its only one -- and it is a candidate for these
  // searches like any other, because getOpenFoodbankCoordinates filters on
  // is_closed alone.
  latest_need_id: number | null;
}

type Candidate = { kind: "organisation" | "location"; coord: CoordinateRow };

export async function findLocations(
  session: Session,
  lat: number,
  lng: number,
  quantity: number,
  skipFirst = false,
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
    skipFirst,
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

  // flatMap, NOT map, AND THE DIFFERENCE IS A 500 (github #48). Ranking and
  // hydration are separate D1 reads, so a row deleted between them is ranked
  // and then not found. These lookups used to assert `!` on that, which is a
  // compile-time claim the runtime does not honour: the miss returned
  // undefined and the next property access threw a TypeError, i.e. a 500 on
  // /needs/, /needs/at/<slug>/nearby/ and the /md/ twin.
  //
  // Dropping the entry is not a lenient choice, it is the DJANGO one. Django
  // ranks and hydrates in a single query, so a row that has just been deleted
  // is simply not among the results and the list comes back one shorter. The
  // two-phase port is what opened the window; degrading to Django's own
  // outcome closes it.
  //
  // B12 DOES NOT REACH THIS FILE, and the comment that used to stand here
  // said it did (github #13). The claim was that `row.latestNeed!`
  // reproduced Django dereferencing a null latest_need and 500ing. That is
  // true of the FIVE API views PLAN.md:7305 names -- gfapi1/views.py:143 and
  // gfapi2/views.py:401,588 really do attribute-access None in Python and
  // raise -- and it is false of every consumer of THIS function, all of which
  // are HTML or markdown:
  //
  //   * givefood/utils/geo.py's find_locations() never dereferences it. The
  //     location leg is a plain assignment, `location.latest_need =
  //     location.foodbank.latest_need`, which stores None happily.
  //   * wfbn/index.html resolves `location.latest_need.get_change_text`
  //     through a TEMPLATE lookup, and Django templates swallow attribute
  //     errors on None into string_if_invalid. Rendered against the real
  //     template shape with latest_need=None it produces the empty branch,
  //     not an exception -- run, not reasoned about.
  //   * wfbn/foodbank/nearby.html does not mention latest_need at all, so
  //     Django cannot fail there under any circumstance. The port computed
  //     the field eagerly and 500d.
  //
  // So the port turned a blank cell into a 500 that took out the whole page:
  // all twenty results, the donation-points tab and the by-item tab, on the
  // site's primary function. `?? ""` and `?? null` below reproduce what
  // Django's template actually renders.
  //
  // The `flatMap` guards above are a DIFFERENT rule and still stand: a row
  // that is NOT FOUND is a window the two-phase port opened, and it is
  // dropped. A row that is found with a null need is ordinary data, and it
  // renders.
  return ranked.flatMap(({ item, distanceM }) => {
    if (item.kind === "organisation") {
      const row = foodbankById.get(item.coord.id);
      if (row === undefined) return [];
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
        latest_need_change_text: row.latestNeed?.change_text ?? "",
        latest_need_id: row.latestNeed?.id ?? null,
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
      latest_need_change_text: parentFoodbank.latestNeed?.change_text ?? "",
      latest_need_id: parentFoodbank.latestNeed?.id ?? null,
    };
  });
}
