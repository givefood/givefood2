import { toDashedUuid, type FoodbankWithLatestNeed } from "@givefood/db";
import { charityRegisterUrl, fsaUrl } from "./fields";

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

// Foodbank.schema_org() -- givefood/models/foodbank.py:179-256. Tolerant
// parity, not byte-exact: this isn't a Phase 2 API surface, and Python's
// `json.dumps(..., sort_keys=True)` output can't be matched byte-for-byte
// by JSON.stringify without a custom serialiser -- not worth building for
// a field search engines read, not golden-tested.
export function buildFoodbankSchemaOrg(foodbank: FoodbankWithLatestNeed, fullName: string): Record<string, unknown> {
  const [latStr, lngStr] = foodbank.lat_lng.split(",");
  const changeText = foodbank.latestNeed?.change_text ?? "Nothing";

  const seeks =
    changeText !== "Nothing" && changeText !== "Unknown" && changeText !== "Facebook"
      ? changeText.split("\n").map((need) => ({
          "@type": "Demand",
          itemOffered: { "@type": "Product", name: need },
        }))
      : [];

  let memberOf: unknown = {};
  if (foodbank.network === "Trussell") memberOf = TRUSSELL_TRUST_SCHEMA;
  if (foodbank.network === "IFAN") memberOf = IFAN_SCHEMA;

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
    "@context": "https://schema.org",
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
    memberOf,
    sameAs,
  };
  if (foodbank.parliamentary_constituency_name) {
    schema.areaServed = { "@type": "AdministrativeArea", name: foodbank.parliamentary_constituency_name };
  }
  if (seeks.length > 0) schema.seeks = seeks;

  return schema;
}

export function schemaOrgStr(foodbank: FoodbankWithLatestNeed, fullName: string): string {
  return JSON.stringify(buildFoodbankSchemaOrg(foodbank, fullName), null, 2);
}
