import { sortByName, type Session } from "./types";
import { mapLocationRow, type FoodbankLocationRow } from "./locations";
import { mapDonationPointRow, type DonationPointRow } from "./donationpoints";

// `api_foodbank`/`foodbank(slug)` need a food bank's locations AND its
// donation points -- two different tables, so they can't collapse into
// one `WHERE id IN (...)` query the way same-table N+1s do (see
// getFoodbanksByIds's getNeedsByIds fix). They're independent of each
// other though, so `session.batch()` sends both SELECTs in a single D1
// round trip instead of two sequential ones -- found via real timing
// comparisons against production (a WP 2.5 follow-up): the detail
// endpoint was ~2x slower than Django's, and this sequential pair was
// the biggest piece of it.
export async function getLocationsAndDonationPointsByFoodbankId(
  session: Session,
  foodbankId: number,
): Promise<{ locations: FoodbankLocationRow[]; donationPoints: DonationPointRow[] }> {
  const results = await session.batch([
    session.prepare("SELECT * FROM foodbanklocation_full WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("SELECT * FROM foodbankdonationpoint_full WHERE foodbank_id = ?").bind(foodbankId),
  ]);
  // batch() always returns one result per input statement, in the same
  // order -- exactly 2 here, so these indexes are never actually out of
  // range despite noUncheckedIndexedAccess flagging them as possibly so.
  const locationsResult = results[0]!;
  const donationPointsResult = results[1]!;
  return {
    locations: sortByName(locationsResult.results.map((r) => mapLocationRow(r as Record<string, unknown>))),
    donationPoints: sortByName(donationPointsResult.results.map((r) => mapDonationPointRow(r as Record<string, unknown>))),
  };
}
