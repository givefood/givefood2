import type { Context } from "hono";
import {
  getFoodbankBySlug,
  getLocationsByFoodbankIdFlagged,
  getLocationsAndDonationPointsByFoodbankId,
  type FoodbankLocationRowFlagged,
} from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { CHARITY_DETAIL_COUNTRIES, fullNameLocaleAware } from "@givefood/models";

// Foodbank.has_service_area()'s COUNT(*), evaluated over location rows the
// page has ALREADY fetched instead of in a D1 round trip of its own (github
// #52: that round trip's answer is false for 1,016 of the 1,023 open food
// banks, and both of this file's handlers were paying for it).
//
// WHY THIS IS THE SAME ANSWER packages/db's hasServiceArea() returns, not a
// near-enough one. Three legs, each checkable rather than assumed:
//
//   THE ROW SET. hasServiceArea counts `FROM foodbanklocation WHERE
//   foodbank_id = ?`; getLocationsByFoodbankIdFlagged (and the batched pair
//   the donation-points handler uses) selects `FROM foodbanklocation_full
//   WHERE foodbank_id = ?`. `foodbanklocation_full` is `SELECT l.*, ... FROM
//   foodbanklocation l LEFT JOIN foodbank f ON f.id = l.foodbank_id`
//   (migration 0019_drop_foodbank_cache.sql:68) -- a LEFT join to a PRIMARY
//   KEY, so exactly one output row per input row, none dropped and none
//   duplicated. Neither side filters is_closed. Same rows.
//
//   THE PREDICATE. It is now the SAME SQL TEXT on both sides, not a JS
//   translation of it: `has_boundary` is `(boundary_geojson IS NOT NULL AND
//   boundary_geojson != '')` evaluated in SQLite, which is character for
//   character the predicate hasServiceArea counts on. Both spellings of "no
//   boundary" that D1 actually holds, NULL and '', yield 0.
//
//   THE REDUCTION. `COUNT(*) > 0` and `.some()` are the same question.
//
// THE BLOB NEVER LEAVES D1 (github #52's closing observation). Nothing on
// either page prints a boundary -- locations.njk uses it only to suppress a
// place photo, donationpoints.njk never mentions it, and the map fetches its
// geometry separately from /needs/at/<slug>/geo.json -- so both queries ask
// for the flag instead of the column. Measured on canterbury, the largest of
// the seven production food banks that have a boundary at all: 2,319,826 ->
// 19,890 bytes for that statement, -99.1%.
//
// The row TYPE is what keeps the derivation honest, in both directions.
// FoodbankLocationRowFlagged is `Omit<FoodbankLocationRow, "boundary_geojson">
// & { has_boundary: 0 | 1 }`, so reverting either query to the unprojected row
// -- the tidy-up that would put 2.3 MB back on the wire for canterbury -- is a
// compile error on this line, and so is the reverse: reading
// `l.boundary_geojson` off a flagged row, which would be a silent `undefined
// !== null` reporting a service area for every food bank on the site. What the
// type CANNOT see is the SQL text alone changing back to `SELECT *` under an
// unchanged return type; that one is caught by the statement assertions in
// locations.test.ts here and in packages/db, which exist for exactly that.
function anyLocationHasBoundary(locations: readonly FoodbankLocationRowFlagged[]): boolean {
  return locations.some((l) => l.has_boundary === 1);
}

// gfwfbn `foodbank_locations` (GET /needs/at/<slug>/locations/,
// i18n-patterned). Ported from gfwfbn/views.py:558-586. Same
// per-foodbank location query/no_locations===0 guard as ./md/locations.ts's
// mdFoodbankLocations -- see that file's comment on why a strict === 0 check
// is safe (no_locations is non-nullable). That sibling now calls
// getLocationsByFoodbankIdNarrow -- the PLAIN narrow row, not the flagged one:
// its markdown template has no place photos and no service-area map, so it
// needs neither the blob nor the flag derived from it.
export async function wfbnFoodbankLocations(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  if (foodbank.no_locations === 0) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);
  const locations = await getLocationsByFoodbankIdFlagged(session, foodbank.id);
  // NO no_locations GUARD NEEDED HERE, and this is not the same omission the
  // old hasServiceArea() call made. Django's has_service_area() short-circuits
  // on `no_locations == 0` (givefood/models/foodbank.py:296) -- but the 404
  // gate above has already returned for exactly that case, so on every path
  // that reaches this line the counter is non-zero and Django would have run
  // the count. Same answer, no round trip.
  const hasServiceAreaValue = anyLocationHasBoundary(locations);

  const [latStr, lngStr] = foodbank.lat_lng.split(",");

  const mapConfig: Record<string, unknown> = {
    geojson: urlForLocale(locale, "wfbn:foodbank_geojson", foodbank.slug),
  };
  if (foodbank.bounds_north !== null) {
    mapConfig.bounds = {
      north: foodbank.bounds_north,
      south: foodbank.bounds_south,
      east: foodbank.bounds_east,
      west: foodbank.bounds_west,
    };
  }

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/foodbank/locations.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      section: "locations",
      // has_service_area also nested here (unlike foodbank.ts/nearby.ts's
      // top-level-only pass) -- includes/maplegend.njk reads
      // `foodbank.has_service_area` nested, see WIRING report finding.
      foodbank: { ...foodbank, has_service_area: hasServiceAreaValue },
      full_name: fullName,
      has_charity_details: CHARITY_DETAIL_COUNTRIES.has(foodbank.country),
      has_service_area: hasServiceAreaValue,
      locations,
      latt: Number(latStr),
      long: Number(lngStr),
      map_config: JSON.stringify(mapConfig),
    },
    locale,
  );
  return c.html(html);
}

// gfwfbn `foodbank_donationpoints` (GET /needs/at/<slug>/donationpoints/,
// i18n-patterned). Ported from gfwfbn/views.py:589-618. Same
// no_donation_points truthy-guard (nullable field) as
// ./md/donationpoints.ts's mdFoodbankDonationpoints.
export async function wfbnFoodbankDonationpoints(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  if (!foodbank.no_donation_points) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);

  // ONE ROUND TRIP FOR THREE ANSWERS (github #52). These were three sequential
  // awaits -- the locations, the donation points, then a COUNT(*) for
  // has_service_area -- and none of the three depended on another's result.
  // The first two now go out together (see
  // getLocationsAndDonationPointsByFoodbankId, same views, same sort, same
  // shapes bar the projection) and the third is read off the location rows
  // those bring back -- as a has_boundary flag, not the boundary itself.
  const { locations: allLocations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, foodbank.id);
  // Foodbank.location_donation_points() -- locations that are ALSO
  // donation points, filtered client-side (no dedicated foodbank-scoped
  // db query exists); order preserved from the batched query's own
  // name sort, matching Django's `.order_by("name")` on that method.
  const locationDonationPoints = allLocations.filter((l) => l.is_donation_point);
  // THE no_locations GUARD IS DELIBERATELY KEPT, and github #52's suggested
  // fix says to drop it. Dropping it was proposed on the grounds that Django's
  // has_service_area() is "a live query with no such guard", so a stale zero
  // hiding a real service area would be a CONVERGENCE with Django. Read at
  // givefood/models/foodbank.py:296-302, Django is the opposite of that:
  //
  //     def has_service_area(self):
  //         if self.no_locations == 0:
  //             return False
  //
  // -- the counter is checked first and the query is not issued. So the guard
  // is the parity, and removing it would DIVERGE from that on the single input
  // that tells the two spellings apart: a stale zero over a real boundary. It
  // would also split this page from the three sibling handlers that cannot
  // derive the flag from rows they never fetch, and so take it -- guard
  // included -- from packages/db's getFoodbankBySlugWithServiceArea:
  // /needs/at/<slug>/, the LOCATION detail page /needs/at/<slug>/<locslug>/ and
  // the DONATION-POINT detail page /needs/at/<slug>/donationpoint/<dpslug>/.
  // All three would go on denying it.
  //
  // THREE SIBLINGS, AND IT USED TO BE TWO. Before #52 item 3 the LOCATION
  // detail page issued this count UNGUARDED and so answered true where the
  // other two answered false -- a divergence from the Python above that the
  // port had carried from the start. Folding the count into that shared db
  // function put the guard on it too, and that is the ONE input in the whole
  // of #52 on which a rendered page moves: a food bank whose no_locations is a
  // stale 0 while owning a boundary-bearing location now renders
  // /needs/at/<slug>/<locslug>/ WITHOUT a service area, where it used to render
  // one. A convergence, not a regression, and pinned by locationDetail.test.ts's
  // "hides the service area when the parent's no_locations is 0, even though a
  // location has a boundary".
  //
  // On every other input, and on all five routes that render this flag, #52
  // moves no pixel. No production row is in that state today either: of the
  // 1,023 open food banks, 7 have a boundary at all and 0 have
  // `no_locations = 0` while owning one (read-only count against production D1,
  // 2026-09-08). So the guard costs nothing to keep and is the only spelling
  // that stays right if a counter ever goes stale again.
  const hasServiceAreaValue = foodbank.no_locations !== 0 && anyLocationHasBoundary(allLocations);

  const [latStr, lngStr] = foodbank.lat_lng.split(",");

  const mapConfig: Record<string, unknown> = {
    geojson: urlForLocale(locale, "wfbn:foodbank_geojson", foodbank.slug),
  };
  if (foodbank.bounds_north !== null) {
    mapConfig.bounds = {
      north: foodbank.bounds_north,
      south: foodbank.bounds_south,
      east: foodbank.bounds_east,
      west: foodbank.bounds_west,
    };
  }

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/foodbank/donationpoints.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      section: "donationpoints",
      foodbank: { ...foodbank, has_service_area: hasServiceAreaValue },
      full_name: fullName,
      has_charity_details: CHARITY_DETAIL_COUNTRIES.has(foodbank.country),
      has_service_area: hasServiceAreaValue,
      location_donation_points: locationDonationPoints,
      donation_points: donationPoints,
      latt: Number(latStr),
      long: Number(lngStr),
      map_config: JSON.stringify(mapConfig),
    },
    locale,
  );
  return c.html(html);
}
