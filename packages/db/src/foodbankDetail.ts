import { sortByName, type Session } from "./types";
import { LOCATION_COLUMNS_NARROW, mapLocationRowNarrow, type FoodbankLocationRowNarrow } from "./locations";
import { mapDonationPointRow, type DonationPointRow } from "./donationpoints";
import { foodbanksByIdsStatement, mapFoodbanksByIds, type FoodbankWithLatestNeed } from "./foodbank";

// `api_foodbank`/`foodbank(slug)`'s SECOND WAVE -- everything the detail
// endpoint still needs once getFoodbankBySlugWithOpenCoordinates has come
// back and the caller has ranked the open candidate set into `nearbyIds`.
//
// THREE INDEPENDENT SELECTS, ONE ROUND TRIP. A food bank's locations and its
// donation points live in different tables, so they can't collapse into one
// `WHERE id IN (...)` query the way same-table N+1s do (see getFoodbanksByIds's
// getNeedsByIds fix); the ranked neighbours are a third table read that
// depends only on ids the caller already holds. All three are independent of
// each other, so `session.batch()` sends them together -- found via real
// timing comparisons against production (a WP 2.5 follow-up, extended for
// github #49): the detail endpoint was ~2x slower than Django's, and this
// sequence of sequential awaits was the whole of it. A D1 round trip on this
// path measured 23-28 ms against production, so the two trips folded in here
// are worth ~50 ms of the ~138-192 ms this endpoint spent.
//
// `nearbyIds` EMPTY IS NOT THE SAME AS "NO NEIGHBOURS FOUND". The
// ?format=geojson branch has no nearby_foodbanks section at all and passes an
// empty list deliberately, so the third statement is not sent and no further
// round trip is made -- exactly the pre-existing behaviour, which never asked
// for neighbours on that branch either.
//
// THE ID-ORDER RE-SORT IS LOAD-BEARING and belongs to foodbank.ts, which is
// why the neighbours go out through foodbanksByIdsStatement and come back
// through mapFoodbanksByIds rather than being re-implemented here: `WHERE id
// IN (...)` gives no ordering guarantee, and the caller's `nearbyIds` are
// ranked by distance. Re-implementing that here would reorder
// nearby_foodbanks with nothing to show for it in any row-level assertion.
//
// THE LOCATIONS ARE PROJECTED, the donation points are not. `foodbanklocation`
// carries boundary_geojson, a TEXT blob that runs to 2.30 MB on one production
// food bank's locations alone (and 637 KB on a second, and nothing at all on
// the other 1,063) and that NEITHER branch of the calling handler mentions.
// Measured against production: `SELECT *` for that food bank's locations was
// 15.5 ms of D1 SQL against 0.9 ms for the named list, and rows_read is
// unchanged -- so this is wire bytes and latency, not D1 billing. It also
// restores PLAN.md:2982's hard rule ("nothing in the codebase issues SELECT *
// on parliamentaryconstituency or foodbanklocation"), of which this function
// was the last public-route violation. foodbankdonationpoint has no such
// column, so its `SELECT *` stays.
export async function getLocationsDonationPointsAndNearbyFoodbanks(
  session: Session,
  foodbankId: number,
  nearbyIds: readonly number[],
): Promise<{
  locations: FoodbankLocationRowNarrow[];
  donationPoints: DonationPointRow[];
  nearbyFoodbanks: FoodbankWithLatestNeed[];
}> {
  const statements = [
    session.prepare(`SELECT ${LOCATION_COLUMNS_NARROW} FROM foodbanklocation_full WHERE foodbank_id = ?`).bind(foodbankId),
    session.prepare("SELECT * FROM foodbankdonationpoint_full WHERE foodbank_id = ?").bind(foodbankId),
  ];
  if (nearbyIds.length > 0) statements.push(foodbanksByIdsStatement(session, nearbyIds));

  const results = await session.batch(statements);
  // batch() always returns one result per input statement, in the same
  // order, so these indexes are never actually out of range despite
  // noUncheckedIndexedAccess flagging them as possibly so.
  const locationsResult = results[0]!;
  const donationPointsResult = results[1]!;
  return {
    locations: sortByName(locationsResult.results.map((r) => mapLocationRowNarrow(r as Record<string, unknown>))),
    donationPoints: sortByName(donationPointsResult.results.map((r) => mapDonationPointRow(r as Record<string, unknown>))),
    nearbyFoodbanks: nearbyIds.length > 0 ? await mapFoodbanksByIds(session, results[2]!.results, nearbyIds) : [],
  };
}
