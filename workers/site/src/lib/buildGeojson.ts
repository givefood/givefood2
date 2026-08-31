// WP 3.6, PLAN.md §6.6 "geo.json ×4" (all-items, per-foodbank,
// per-location, per-constituency). Ported from gfwfbn/views.py:207-339
// (the single `geojson` view, branching on which of `slug`/`locslug`/
// `parlcon_slug` is present) -- read that function in full before editing
// this one, it's the source of truth for every rule below.
//
// The response body is built as raw, already-serialised JSON TEXT, not a
// JS object handed to JSON.stringify -- see float.ts's header and
// geojsonBoundary.ts's header for why. Two things matter for STRICT
// byte-equality parity here, both verified directly against the live
// site, not just inferred from the Python source:
//   1. Coordinates. `round(51.0, 4)` is the Python float 51.0; JS's
//      `Number((51.0).toFixed(4))` is 51, and JSON.stringify renders that
//      as "51", not "51.0". `pyRound` + `formatFloat` reproduce Python's
//      value AND its `repr()`-based text -- the UK straddles the 0
//      meridian, so this isn't a rare edge case (a live example: a
//      Sheffield-area donation point at exactly lat 53.0).
//   2. Punctuation spacing and string escaping. Django's `JsonResponse`
//      is a bare `json.dumps(response_dict)` -- default separators
//      `(', ', ': ')` (a space after every comma/colon) and default
//      `ensure_ascii=True` (every non-ASCII character escaped as
//      `\uXXXX`). `toDjangoJsonFormat` (geojsonBoundary.ts) is the one
//      pass that applies both, run ONCE over the fully assembled body at
//      the end of this function -- so every feature below is built as
//      plain, compact JSON via straightforward string concatenation;
//      don't hand-add spaces or worry about escaping while building.
import {
  getAllOpenDonationPoints,
  getAllOpenFoodbanks,
  getAllOpenLocations,
  getConstituencyBySlug,
  getDonationPointsByFoodbankId,
  getFoodbankBySlug,
  getFoodbankLocationBySlugs,
  getFoodbanksByConstituencyId,
  getLocationsByFoodbankIdUnsorted,
  getOpenDonationPointsByConstituencyId,
  getOpenLocationsByConstituencyId,
  type DonationPointRow,
  type FoodbankLocationRow,
  type FoodbankRow,
  type Session,
} from "@givefood/db";
import { formatFloat, pyRound, replaceBoundaryProperties, setBoundaryPropertyType, toDjangoJsonFormat } from "@givefood/serialise";
import { fullAddressNullable, fullAddressUnconditional, fullNameLocaleAware } from "./fields";

export type GeojsonScope =
  | { kind: "all" }
  | { kind: "foodbank"; slug: string }
  | { kind: "location"; slug: string; locslug: string }
  | { kind: "constituency"; parlconSlug: string };

// Every "url" property below is a page path, not an absolute URL (Django's
// `reverse()` never calls `build_absolute_uri()` in this view) -- but IS
// locale-prefixed, because `reverse()` inside a request being handled
// resolves i18n_patterns routes under whatever language the request is
// currently running under (see gfwfbn/urls/i18n.py: geojson and the three
// URL names below all live in the SAME i18n-patterned urls module as
// `wfbn:index`). Shapes copied verbatim from
// packages/templates/src/urls.ts's PARAMETERISED table -- not imported
// from there, per WP 3.6's instructions (this is plain route/lib code,
// not a template).
function localePrefix(locale: string): string {
  return locale === "en" ? "" : `/${locale}`;
}
function foodbankUrl(locale: string, slug: string): string {
  return `${localePrefix(locale)}/needs/at/${slug}/`;
}
function foodbankLocationUrl(locale: string, slug: string, locslug: string): string {
  return `${localePrefix(locale)}/needs/at/${slug}/${locslug}/`;
}
function foodbankDonationPointUrl(locale: string, slug: string, dpslug: string): string {
  return `${localePrefix(locale)}/needs/at/${slug}/donationpoint/${dpslug}/`;
}

// One Point Feature, built as compact JSON text -- `entries` is the
// property list AFTER "type" (which every feature has first, verbatim
// from the view's dict literals: "f"/"l"/"d" all lead with "type").
function pointFeature(typeCode: string, entries: ReadonlyArray<[string, string]>, latLng: string, decimalPlaces: number): string {
  const parts = latLng.split(",");
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  const coords = `[${formatFloat(pyRound(lng, decimalPlaces))},${formatFloat(pyRound(lat, decimalPlaces))}]`;
  const props = [["type", typeCode] as [string, string], ...entries].map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",");
  return `{"type":"Feature","geometry":{"type":"Point","coordinates":${coords}},"properties":{${props}}}`;
}

function foodbankFeatures(foodbank: FoodbankRow, locale: string, allItems: boolean, decimalPlaces: number): string[] {
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale as "en" | "cy" | "ga" | "gd");
  const url = foodbankUrl(locale, foodbank.slug);
  const out: string[] = [];

  const mainEntries: Array<[string, string]> = [["name", fullName]];
  if (!allItems) mainEntries.push(["address", fullAddressUnconditional(foodbank.address, foodbank.postcode)]);
  mainEntries.push(["url", url]);
  out.push(pointFeature("f", mainEntries, foodbank.lat_lng, decimalPlaces));

  // `if foodbank.delivery_address:` -- Django checks ONLY this, then
  // dereferences `delivery_lat_lng` unguarded (`.split(",")` on it would
  // raise if it were ever null while delivery_address wasn't -- that
  // pairing is an application-level invariant, not something this view
  // checks). Reproduced the same way: no extra null-guard added here.
  if (foodbank.delivery_address) {
    const deliveryEntries: Array<[string, string]> = [["name", `${fullName} Delivery Address`]];
    if (!allItems) deliveryEntries.push(["address", foodbank.delivery_address]);
    deliveryEntries.push(["url", url]);
    out.push(pointFeature("f", deliveryEntries, foodbank.delivery_lat_lng as string, decimalPlaces));
  }

  return out;
}

function locationFeature(location: FoodbankLocationRow, locale: string, allItems: boolean, decimalPlaces: number): string {
  const url = foodbankLocationUrl(locale, location.foodbank_slug, location.slug);

  // A boundary only renders as its own polygon ("lb") on a SCOPED feed --
  // the all-items feed always uses the plain point, even for a location
  // that has a boundary (gfwfbn/views.py:288: `if location.boundary_geojson
  // and not all_items`).
  if (location.boundary_geojson && !allItems) {
    return replaceBoundaryProperties(location.boundary_geojson, [
      ["type", "lb"],
      ["name", location.name],
      ["foodbank", location.foodbank_name],
      ["url", url],
    ]);
  }

  const entries: Array<[string, string]> = [
    ["name", location.name],
    ["foodbank", location.foodbank_name],
  ];
  if (!allItems) entries.push(["address", fullAddressNullable(location.address, location.postcode)]);
  entries.push(["url", url]);
  return pointFeature("l", entries, location.lat_lng, decimalPlaces);
}

function donationPointFeature(dp: DonationPointRow, locale: string, allItems: boolean, decimalPlaces: number): string {
  const entries: Array<[string, string]> = [
    ["name", dp.name],
    ["foodbank", dp.foodbank_name],
  ];
  if (!allItems) entries.push(["address", fullAddressUnconditional(dp.address, dp.postcode)]);
  entries.push(["url", foodbankDonationPointUrl(locale, dp.foodbank_slug, dp.slug)]);
  return pointFeature("d", entries, dp.lat_lng, decimalPlaces);
}

// Returns the full response body (already-serialised JSON text), or null
// for the three "not found" cases (bad food bank slug, bad
// slug/locslug pair, bad constituency slug) -- callers should 404, same
// as the three `get_object_or_404` calls in the Python source.
export async function buildGeojsonResponse(session: Session, locale: string, scope: GeojsonScope): Promise<string | null> {
  const allItems = scope.kind === "all";
  const decimalPlaces = allItems ? 4 : 6;

  let foodbanks: FoodbankRow[] = [];
  let locations: FoodbankLocationRow[] = [];
  let donationpoints: DonationPointRow[] = [];
  let boundaryFeature: string | null = null;

  if (scope.kind === "all") {
    [foodbanks, locations, donationpoints] = await Promise.all([
      getAllOpenFoodbanks(session),
      getAllOpenLocations(session),
      getAllOpenDonationPoints(session),
    ]);
  } else if (scope.kind === "foodbank") {
    const foodbank = await getFoodbankBySlug(session, scope.slug);
    if (!foodbank) return null;
    foodbanks = [foodbank];
    // Locations: NOT getLocationsByFoodbankId -- that reproduces
    // Foodbank.locations()'s explicit `.order_by("name")`, but this view
    // builds its own queryset directly with no such ordering (see
    // getLocationsByFoodbankIdUnsorted's own comment). Donation points:
    // getDonationPointsByFoodbankId (the SORTED one) IS still the right
    // call here despite this view building its own unordered queryset too
    // -- see that function's own comment for the live-endpoint evidence.
    [locations, donationpoints] = await Promise.all([
      getLocationsByFoodbankIdUnsorted(session, foodbank.id),
      getDonationPointsByFoodbankId(session, foodbank.id),
    ]);
  } else if (scope.kind === "location") {
    const location = await getFoodbankLocationBySlugs(session, scope.slug, scope.locslug);
    if (!location) return null;
    locations = [location];
  } else {
    const constituency = await getConstituencyBySlug(session, scope.parlconSlug);
    if (!constituency) return null;
    [foodbanks, locations, donationpoints] = await Promise.all([
      getFoodbanksByConstituencyId(session, constituency.id),
      getOpenLocationsByConstituencyId(session, constituency.id),
      getOpenDonationPointsByConstituencyId(session, constituency.id),
    ]);
    // Every constituency in production has a populated boundary_geojson
    // (650/650) -- unlike locations (257/1972), there's no documented
    // "closed"/frozen-bug case for a missing one here. If it were ever
    // null, Django's `parlcon.boundary_geojson_dict()` would crash
    // (`None.strip()`); skip the feature instead of 500ing, since nothing
    // in this WP's scope calls for reproducing that as a deliberate bug.
    if (constituency.boundary_geojson) {
      boundaryFeature = setBoundaryPropertyType(constituency.boundary_geojson, "b");
    }
  }

  const features: string[] = [];
  // The constituency boundary is pushed FIRST, matching the view's code
  // order (the `if parlcon_slug:` block runs before the food bank loop).
  if (boundaryFeature) features.push(boundaryFeature);
  for (const foodbank of foodbanks) features.push(...foodbankFeatures(foodbank, locale, allItems, decimalPlaces));
  for (const location of locations) features.push(locationFeature(location, locale, allItems, decimalPlaces));
  for (const dp of donationpoints) features.push(donationPointFeature(dp, locale, allItems, decimalPlaces));

  const body = `{"type":"FeatureCollection","features":[${features.join(",")}]}`;
  return toDjangoJsonFormat(body);
}
