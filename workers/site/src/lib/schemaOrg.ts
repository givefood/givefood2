import { toDashedUuid, type DonationPointRow, type FoodbankLocationRow, type FoodbankLocationRowNarrow, type FoodbankWithLatestNeed } from "@givefood/db";
import { charityRegisterUrl, emailOrFoodbankEmail, fsaUrl, phoneOrFoodbankPhone } from "@givefood/models";

// givefood/const/general.py -- verbatim.
const TRUSSELL_TRUST_SCHEMA = {
  "@type": "NGO",
  name: "Trussell",
  url: "https://www.trussell.org.uk",
  email: "enquiries@trussell.org.uk",
  telephone: "01722580180",
  address: {
    "@type": "PostalAddress",
    addressLocality: "Salisbury",
    postalCode: "SP2 7HL",
    streetAddress: "Unit 9 Ashfield Trading Estate, Ashfield Road",
  },
  identifier: "1110522",
  duns: "346282481",
  sameAs: "https://www.wikidata.org/wiki/Q15621299",
};
const IFAN_SCHEMA = {
  "@type": "NGO",
  name: "IFAN",
  url: "https://www.foodaidnetwork.org.uk",
  email: "admin@foodaidnetwork.org.uk",
  telephone: "07535389775",
  address: {
    "@type": "PostalAddress",
    addressLocality: "London",
    postalCode: "WC2H 9JQ",
    streetAddress: "71-75 Shelton Street",
  },
  identifier: "1180382",
  duns: "224810933",
  sameAs: "https://www.wikidata.org/wiki/Q109638006",
};

const SITE_DOMAIN = "https://www.givefood.org.uk";

// givefood/const/general.py's TRUSSELL_TRUST_SCHEMA/IFAN_SCHEMA lookup,
// shared by Foodbank/FoodbankLocation's own memberOf (DonationPoint has no
// memberOf field at all).
function memberOfForNetwork(network: string | null): unknown {
  if (network === "Trussell") return TRUSSELL_TRUST_SCHEMA;
  if (network === "IFAN") return IFAN_SCHEMA;
  return {};
}

// FoodbankChange's `seeks` block -- identical computation duplicated
// across all three schema_org() ports below (Foodbank/FoodbankLocation/
// FoodbankDonationPoint all seek the same latest_need).
function computeSeeks(changeText: string): unknown[] {
  if (changeText === "Nothing" || changeText === "Unknown" || changeText === "Facebook") return [];
  return changeText.split("\n").map((need) => ({ "@type": "Demand", itemOffered: { "@type": "Product", name: need } }));
}

// Foodbank.schema_org() -- givefood/models/foodbank.py:179-256. Tolerant
// parity, not byte-exact: this isn't a Phase 2 API surface, and Python's
// `json.dumps(..., sort_keys=True)` output can't be matched byte-for-byte
// by JSON.stringify without a custom serialiser -- not worth building for
// a field search engines read, not golden-tested.
//
// `asSubProperty` mirrors the Python method's own `as_sub_property` arg
// (@context/seeks dropped) -- FoodbankLocation/FoodbankDonationPoint's own
// schema_org() nest a `parentOrganization` built this way.
export function buildFoodbankSchemaOrg(foodbank: FoodbankWithLatestNeed, fullName: string, asSubProperty = false): Record<string, unknown> {
  const [latStr, lngStr] = foodbank.lat_lng.split(",");
  const changeText = foodbank.latestNeed?.change_text ?? "Nothing";
  const seeks = computeSeeks(changeText);

  const address: Record<string, unknown> = {
    "@type": "PostalAddress",
    postalCode: foodbank.postcode,
    addressCountry: foodbank.country,
    streetAddress: foodbank.address,
  };
  if (foodbank.district) address.addressLocality = foodbank.district;

  const sameAs: string[] = [foodbank.url, `${SITE_DOMAIN}/${toDashedUuid(foodbank.uuid)}/`];
  if (foodbank.place_id && foodbank.plus_code_global) {
    sameAs.push(`https://www.google.co.uk/maps/place/${encodeURIComponent(foodbank.plus_code_global)}/`);
  }
  if (foodbank.charity_number) {
    const registerUrl = charityRegisterUrl(foodbank.charity_number, foodbank.country);
    if (registerUrl) sameAs.push(registerUrl);
  }
  if (foodbank.fsa_id) {
    const url = fsaUrl(foodbank.fsa_id);
    if (url) sameAs.push(url);
  }
  if (foodbank.facebook_page) sameAs.push(`https://www.facebook.com/${foodbank.facebook_page}`);

  const schema: Record<string, unknown> = {
    ...(asSubProperty ? {} : { "@context": "https://schema.org" }),
    "@type": "NGO",
    "@id": `${SITE_DOMAIN}/needs/at/${foodbank.slug}/`,
    additionalType: "https://www.wikidata.org/wiki/Q113603",
    name: fullName,
    alternateName: foodbank.alt_name,
    url: foodbank.url,
    email: foodbank.contact_email,
    telephone: foodbank.phone_number,
    address,
    location: {
      "@type": "Place",
      geo: { "@type": "GeoCoordinates", latitude: Number(latStr), longitude: Number(lngStr) },
    },
    identifier: foodbank.charity_number,
    memberOf: memberOfForNetwork(foodbank.network),
    sameAs,
  };
  if (foodbank.parliamentary_constituency_name) {
    schema.areaServed = { "@type": "AdministrativeArea", name: foodbank.parliamentary_constituency_name };
  }
  if (!asSubProperty && seeks.length > 0) schema.seeks = seeks;

  return schema;
}

export function schemaOrgStr(foodbank: FoodbankWithLatestNeed, fullName: string): string {
  return JSON.stringify(buildFoodbankSchemaOrg(foodbank, fullName), null, 2);
}

// FoodbankLocation.schema_org() -- givefood/models/foodbank.py:822-887.
// `locationFullName` is `"{location.name}, {foodbank full name}"`
// (FoodbankLocation.full_name()). `asSubProperty` mirrors the Python
// method's own `as_sub_property` arg -- unlike Foodbank.schema_org(),
// Django's own source sets `@context` unconditionally (verified directly:
// it's in the dict literal, then redundantly reassigned only when NOT a
// sub-property) so it's present here regardless of the flag; only `seeks`
// is actually gated by it, same as the Foodbank version.
export function buildLocationSchemaOrg(
  location: FoodbankLocationRowNarrow,
  foodbank: FoodbankWithLatestNeed,
  fullName: string,
  locationFullName: string,
  asSubProperty = false,
): Record<string, unknown> {
  const changeText = foodbank.latestNeed?.change_text ?? "Nothing";
  const seeks = computeSeeks(changeText);
  // location.latitude/.longitude are nullable in production (lat_lng is
  // not) -- same reasoning as buildFoodbankSchemaOrg above.
  const [locationLatStr, locationLngStr] = location.lat_lng.split(",");

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "NGO",
    "@id": `${SITE_DOMAIN}/needs/at/${location.foodbank_slug}/${location.slug}/`,
    name: locationFullName,
    url: foodbank.url,
    email: emailOrFoodbankEmail(location.email, location.foodbank_email),
    telephone: phoneOrFoodbankPhone(location.phone_number, location.foodbank_phone_number),
    location: {
      "@type": "Place",
      geo: { "@type": "GeoCoordinates", latitude: Number(locationLatStr), longitude: Number(locationLngStr) },
    },
    identifier: foodbank.charity_number,
    memberOf: memberOfForNetwork(location.foodbank_network),
    parentOrganization: buildFoodbankSchemaOrg(foodbank, fullName, true),
  };
  if (location.address || location.postcode) {
    const address: Record<string, unknown> = { "@type": "PostalAddress", addressCountry: location.country };
    if (location.postcode) address.postalCode = location.postcode;
    if (location.address) address.streetAddress = location.address;
    if (location.district) address.addressLocality = location.district;
    schema.address = address;
  }
  if (!asSubProperty && seeks.length > 0) schema.seeks = seeks;

  return schema;
}

export function locationSchemaOrgStr(location: FoodbankLocationRow, foodbank: FoodbankWithLatestNeed, fullName: string, locationFullName: string): string {
  return JSON.stringify(buildLocationSchemaOrg(location, foodbank, fullName, locationFullName), null, 2);
}

// FoodbankDonationPoint.schema_org() -- givefood/models/foodbank.py:1064-1148.
// Tolerant parity extends to `openingHoursSpecification` too: this omits
// it rather than re-parsing `opening_hours` a second time for a JSON-LD
// field, not golden-tested output either.
export function buildDonationPointSchemaOrg(donationpoint: DonationPointRow, foodbank: FoodbankWithLatestNeed, fullName: string): Record<string, unknown> {
  const changeText = foodbank.latestNeed?.change_text ?? "Nothing";
  const seeks = computeSeeks(changeText);
  // donationpoint.latitude/.longitude are nullable in production (lat_lng
  // is not) -- same reasoning as buildFoodbankSchemaOrg above.
  const [dpLatStr, dpLngStr] = donationpoint.lat_lng.split(",");

  const address: Record<string, unknown> = {
    "@type": "PostalAddress",
    postalCode: donationpoint.postcode,
    addressCountry: donationpoint.country,
    streetAddress: donationpoint.address,
  };
  if (donationpoint.district) address.addressLocality = donationpoint.district;

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Place",
    name: donationpoint.name,
    url: donationpoint.url,
    telephone: donationpoint.phone_number,
    isAccessibleForFree: donationpoint.wheelchair_accessible,
    address,
    location: {
      "@type": "Place",
      geo: { "@type": "GeoCoordinates", latitude: Number(dpLatStr), longitude: Number(dpLngStr) },
    },
    parentOrganization: buildFoodbankSchemaOrg(foodbank, fullName, true),
  };
  if (seeks.length > 0) schema.seeks = seeks;

  return schema;
}

export function donationPointSchemaOrgStr(donationpoint: DonationPointRow, foodbank: FoodbankWithLatestNeed, fullName: string): string {
  return JSON.stringify(buildDonationPointSchemaOrg(donationpoint, foodbank, fullName), null, 2);
}

// ParliamentaryConstituency.schema_org() -- givefood/models/political.py:56-72.
// `containsPlace` is every open food bank's and open location's own
// schema_org(as_sub_property=True), same call this constituency's food
// banks/locations already make on their own pages -- callers pass
// pre-computed fullName strings, matching every builder above (this file
// has no locale awareness of its own).
// Python's urllib.parse.quote_plus -- encodeURIComponent's unreserved set
// additionally leaves `! ' ( ) *` unescaped, which quote_plus does not
// (its safe set is just the RFC 3986 unreserved chars, A-Za-z0-9_.-~).
// No literal spaces reach this in practice (the one caller already
// replaces them with "_" first, mirroring quote_plus's own space->"+"
// only mattering when spaces are still present).
function quotePlus(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildConstituencySchemaOrg(
  constituency: { name: string | null },
  foodbanks: Array<{ foodbank: FoodbankWithLatestNeed; fullName: string }>,
  locations: Array<{ location: FoodbankLocationRowNarrow; foodbank: FoodbankWithLatestNeed; fullName: string; locationFullName: string }>,
): Record<string, unknown> {
  const containsPlace: unknown[] = [
    ...foodbanks.map(({ foodbank, fullName }) => buildFoodbankSchemaOrg(foodbank, fullName, true)),
    ...locations.map(({ location, foodbank, fullName, locationFullName }) =>
      buildLocationSchemaOrg(location, foodbank, fullName, locationFullName, true),
    ),
  ];
  return {
    "@context": "https://schema.org",
    "@type": "AdministrativeArea",
    name: constituency.name,
    containsPlace,
    sameAs: `https://en.wikipedia.org/wiki/${quotePlus((constituency.name ?? "").replace(/ /g, "_"))}_(UK_Parliament_constituency)`,
  };
}

export function constituencySchemaOrgStr(
  constituency: { name: string | null },
  foodbanks: Array<{ foodbank: FoodbankWithLatestNeed; fullName: string }>,
  locations: Array<{ location: FoodbankLocationRowNarrow; foodbank: FoodbankWithLatestNeed; fullName: string; locationFullName: string }>,
): string {
  return JSON.stringify(buildConstituencySchemaOrg(constituency, foodbanks, locations), null, 2);
}
