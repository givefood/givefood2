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
  getFoodbanksByCountry,
  getLocationsByFoodbankIdUnsorted,
  getOpenDonationPointsByConstituencyId,
  getOpenDonationPointsByCountry,
  getOpenLocationsByConstituencyId,
  getOpenLocationsByCountry,
  type DonationPointRow,
  type FoodbankLocationRow,
  type FoodbankRow,
  type Session,
} from "@givefood/db";
import { formatFloat, pyRound, replaceBoundaryProperties, setBoundaryPropertyType, toDjangoJsonFormat } from "@givefood/serialise";
import { urlForLocale } from "@givefood/urls";
import { fullAddressNullable, fullAddressUnconditional, fullNameLocaleAware } from "@givefood/models";
import { COUNTRY_MAPPING } from "./countries";

export type GeojsonScope =
  | { kind: "all" }
  | { kind: "foodbank"; slug: string }
  | { kind: "location"; slug: string; locslug: string }
  | { kind: "constituency"; parlconSlug: string }
  // givefood `country_geojson` (givefood/views.py:285-427) -- a DIFFERENT
  // Django view from `geojson` above (not one more branch of it), but
  // structurally close enough to reuse every feature-building helper
  // below. Two things about it are genuinely NOT "just another scoped
  // feed" though (verified against a live /england/geo.json response, not
  // just read off the Python source) -- see buildGeojsonResponse's own
  // comment on decimalPlaces/includeBoundary for both:
  //   1. decimal_places is hardcoded 4 (givefood/views.py:318), not the
  //      6 every OTHER scoped feed (foodbank/location/constituency) uses.
  //   2. Its `for location in locations:` loop (givefood/views.py:367-392)
  //      has no `if location.boundary_geojson` branch at all -- every
  //      location is always a plain "l" point, never an "lb" boundary
  //      polygon, unlike the scoped feeds above.
  // "address" IS still included though (givefood/views.py:334/383/411),
  // same as the other three scoped feeds -- so this scope needs its own
  // combination, not a fifth reuse of `allItems`.
  | { kind: "country"; countrySlug: string };

// Every "url" property below is a page path, not an absolute URL (Django's
// `reverse()` never calls `build_absolute_uri()` in this view) -- but IS
// locale-prefixed, because `reverse()` inside a request being handled
// resolves i18n_patterns routes under whatever language the request is
// currently running under (see gfwfbn/urls/i18n.py: geojson and the three
// URL names used below all live in the SAME i18n-patterned urls module as
// `wfbn:index`, and all three are in @givefood/urls' I18N_SCOPED set).
//
// This file used to carry its own localePrefix()/foodbankUrl()/
// foodbankLocationUrl()/foodbankDonationPointUrl() copies of those shapes,
// because WP 3.6 said not to import a @givefood/templates module into
// plain route/lib code. @givefood/urls is now a standalone package with no
// template dependency, so that objection no longer applies and the shapes
// are read from the one table instead of a second transcription of it
// (audit finding D7; output verified byte-identical across all 4 locales
// before the switch).

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

function foodbankFeatures(foodbank: FoodbankRow, locale: string, includeAddress: boolean, decimalPlaces: number): string[] {
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale as "en" | "cy" | "ga" | "gd");
  const url = urlForLocale(locale, "wfbn:foodbank", foodbank.slug);
  const out: string[] = [];

  const mainEntries: Array<[string, string]> = [["name", fullName]];
  if (includeAddress) mainEntries.push(["address", fullAddressUnconditional(foodbank.address, foodbank.postcode)]);
  mainEntries.push(["url", url]);
  out.push(pointFeature("f", mainEntries, foodbank.lat_lng, decimalPlaces));

  // `if foodbank.delivery_address:` -- Django checks ONLY this, then
  // dereferences `delivery_lat_lng` unguarded (`.split(",")` on it would
  // raise if it were ever null while delivery_address wasn't -- that
  // pairing is an application-level invariant, not something this view
  // checks). Reproduced the same way: no extra null-guard added here.
  // (country_geojson's OWN foodbank loop -- givefood/views.py:343 -- checks
  // `foodbank.delivery_address and foodbank.delivery_lat_lng` explicitly,
  // unlike this shared view; under the same invariant the two conditions
  // are equivalent in practice, so this one helper still covers both
  // call sites without a second, near-duplicate branch.)
  if (foodbank.delivery_address) {
    const deliveryEntries: Array<[string, string]> = [["name", `${fullName} Delivery Address`]];
    if (includeAddress) deliveryEntries.push(["address", foodbank.delivery_address]);
    deliveryEntries.push(["url", url]);
    out.push(pointFeature("f", deliveryEntries, foodbank.delivery_lat_lng as string, decimalPlaces));
  }

  return out;
}

function locationFeature(
  location: FoodbankLocationRow,
  locale: string,
  includeAddress: boolean,
  includeBoundary: boolean,
  decimalPlaces: number,
): string {
  const url = urlForLocale(locale, "wfbn:foodbank_location", location.foodbank_slug, location.slug);

  // A boundary only renders as its own polygon ("lb") on a feed that opts
  // in via `includeBoundary` -- the all-items feed (gfwfbn/views.py:288:
  // `if location.boundary_geojson and not all_items`) and country_geojson
  // (givefood/views.py:367-392, which has no boundary branch AT ALL --
  // every location is always a plain point there) both pass false;
  // foodbank/location/constituency pass true.
  if (location.boundary_geojson && includeBoundary) {
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
  if (includeAddress) entries.push(["address", fullAddressNullable(location.address, location.postcode)]);
  entries.push(["url", url]);
  return pointFeature("l", entries, location.lat_lng, decimalPlaces);
}

function donationPointFeature(dp: DonationPointRow, locale: string, includeAddress: boolean, decimalPlaces: number): string {
  const entries: Array<[string, string]> = [
    ["name", dp.name],
    ["foodbank", dp.foodbank_name],
  ];
  if (includeAddress) entries.push(["address", fullAddressUnconditional(dp.address, dp.postcode)]);
  entries.push(["url", urlForLocale(locale, "wfbn:foodbank_donationpoint", dp.foodbank_slug, dp.slug)]);
  return pointFeature("d", entries, dp.lat_lng, decimalPlaces);
}

// Returns the full response body (already-serialised JSON text), or null
// for the three "not found" cases (bad food bank slug, bad
// slug/locslug pair, bad constituency slug) -- callers should 404, same
// as the three `get_object_or_404` calls in the Python source.
export async function buildGeojsonResponse(session: Session, locale: string, scope: GeojsonScope): Promise<string | null> {
  const allItems = scope.kind === "all";
  // country_geojson hardcodes 4 decimal places (givefood/views.py:318),
  // the same as the all-items feed -- everything else (foodbank/location/
  // constituency) uses 6. See the GeojsonScope "country" comment above.
  const decimalPlaces = allItems || scope.kind === "country" ? 4 : 6;
  // "address" is stripped ONLY on the all-items feed -- country_geojson
  // keeps it, same as the other three scoped feeds.
  const includeAddress = !allItems;
  // A location's boundary_geojson only ever renders as its own "lb"
  // polygon on foodbank/location/constituency -- never on all-items, and
  // never on country_geojson either (its location loop has no boundary
  // branch at all). See the GeojsonScope "country" comment above.
  const includeBoundary = !allItems && scope.kind !== "country";

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
  } else if (scope.kind === "country") {
    // Routing constrains countrySlug to the 4 real values (see
    // index.ts's `:countrySlug{scotland|england|wales|northern-ireland}`
    // route param), so this is never undefined in practice -- but this
    // function has no route-layer guarantee of its own to lean on, so it
    // still 404s (returns null) rather than querying with `country =
    // undefined`, same defensiveness as the three get_object_or_404-backed
    // branches below.
    const countryName = COUNTRY_MAPPING[scope.countrySlug];
    if (!countryName) return null;
    [foodbanks, locations, donationpoints] = await Promise.all([
      getFoodbanksByCountry(session, countryName),
      getOpenLocationsByCountry(session, countryName),
      getOpenDonationPointsByCountry(session, countryName),
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
  for (const foodbank of foodbanks) features.push(...foodbankFeatures(foodbank, locale, includeAddress, decimalPlaces));
  for (const location of locations) features.push(locationFeature(location, locale, includeAddress, includeBoundary, decimalPlaces));
  for (const dp of donationpoints) features.push(donationPointFeature(dp, locale, includeAddress, decimalPlaces));

  const body = `{"type":"FeatureCollection","features":[${features.join(",")}]}`;
  return toDjangoJsonFormat(body);
}
