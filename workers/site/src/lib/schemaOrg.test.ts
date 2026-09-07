import { describe, expect, it } from "vitest";
import type { DonationPointRow, FoodbankLocationRow, FoodbankWithLatestNeed } from "@givefood/db";
import {
  buildConstituencySchemaOrg,
  buildDonationPointSchemaOrg,
  buildFoodbankSchemaOrg,
  buildLocationSchemaOrg,
  constituencySchemaOrgStr,
  donationPointSchemaOrgStr,
  locationSchemaOrgStr,
  schemaOrgStr,
} from "./schemaOrg";

// These four builders emit the JSON-LD that Google, Bing and every other
// crawler reads off /needs/at/... -- the block that decides whether a food
// bank shows up as an organisation with an address, a charity number and a
// live list of what it needs, or as nothing at all. Nothing renders visibly
// from it, so a regression here is invisible on the page and only shows up
// weeks later in Search Console. That is what these tests are for.
//
// Ported from Foodbank/FoodbankLocation/FoodbankDonationPoint.schema_org()
// (givefood/models/foodbank.py) and ParliamentaryConstituency.schema_org()
// (givefood/models/political.py). The module's own header calls this
// "tolerant parity, not byte-exact" -- so where the port deliberately
// differs from Django the tests below say so in a comment and pin the
// TypeScript behaviour, rather than pretending the two are identical.

// A complete, realistic FoodbankRow + latestNeed. Every schema-relevant
// field is populated so that each test can null ONE of them out and see
// exactly which key disappears -- the omission rules are the whole
// contract here, and a fixture full of nulls would hide them.
function foodbankFixture(overrides: Partial<FoodbankWithLatestNeed> = {}): FoodbankWithLatestNeed {
  return {
    id: 42,
    uuid: "a1b2c3d4e5f6478090ab12cd34ef5678", // stored 32-char dashless, see db/uuid.ts
    name: "Salisbury",
    alt_name: "Salisbury Foodbank",
    slug: "salisbury",
    address: "Unit 9 Ashfield Trading Estate, Ashfield Road",
    postcode: "SP2 7HL",
    country: "England",
    lat_lng: "51.0688,-1.7945",
    latitude: 51.0688,
    longitude: -1.7945,
    delivery_address: null,
    delivery_lat_lng: null,
    network: "Trussell",
    network_id: null,
    notes: null,
    charity_number: "1110522",
    charity_just_foodbank: true,
    charity_id: null,
    charity_name: null,
    charity_type: null,
    charity_reg_date: null,
    charity_postcode: null,
    charity_website: null,
    charity_objectives: null,
    charity_purpose: null,
    facebook_page: "salisburyfoodbank",
    bankuet_slug: null,
    fsa_id: "123456",
    contact_email: "info@salisbury.foodbank.org.uk",
    notification_email: null,
    phone_number: "01722 580180",
    secondary_phone_number: null,
    delivery_phone_number: null,
    url: "https://salisbury.foodbank.org.uk/",
    shopping_list_url: "https://salisbury.foodbank.org.uk/give-help/donate-food/",
    rss_url: null,
    news_url: null,
    donation_points_url: null,
    locations_url: null,
    contacts_url: null,
    place_id: "ChIJQ1Yn6Vt6c0gRPWfLuNzP1Ss",
    plus_code_compound: "3JR7+2M Salisbury",
    plus_code_global: "9C3W3JR7+2M",
    place_has_photo: null,
    county: "Wiltshire",
    district: "Wiltshire",
    ward: null,
    lsoa: null,
    msoa: null,
    parliamentary_constituency_id: 7,
    parliamentary_constituency_name: "Salisbury",
    parliamentary_constituency_slug: "salisbury",
    mp: null,
    mp_party: null,
    mp_parl_id: null,
    address_is_administrative: false,
    is_closed: false,
    is_school: null,
    no_locations: 3,
    no_donation_points: 2,
    days_between_needs: 7,
    footprint: null,
    bounds_north: null,
    bounds_south: null,
    bounds_east: null,
    bounds_west: null,
    latest_need_id: 900,
    last_order: null,
    last_need: "2026-09-01 09:00:00.000000",
    last_rfi: null,
    last_crawl: null,
    last_social_media_check: null,
    last_discrepancy_check: null,
    last_need_check: null,
    last_charity_check: null,
    created: "2020-01-01 00:00:00.000000",
    modified: "2026-09-01 09:00:00.000000",
    edited: null,
    latestNeed: needFixture("Tinned Tomatoes\nPasta\nUHT Milk"),
    ...overrides,
  };
}

// Only change_text is read by this module; the rest is filled in so the
// fixture is a real FoodbankChangeRow rather than a cast.
function needFixture(changeText: string): NonNullable<FoodbankWithLatestNeed["latestNeed"]> {
  return {
    id: 900,
    need_id: "ffffffffffffffffffffffffffffffff",
    foodbank_id: 42,
    foodbank_name: "Salisbury",
    distill_id: null,
    name: null,
    uri: null,
    change_text: changeText,
    change_text_original: null,
    excess_change_text: null,
    excess_change_text_original: null,
    published: true,
    nonpertinent: null,
    is_categorised: null,
    notified: null,
    input_method: "scrape",
    created: "2026-09-01 09:00:00.000000",
    modified: "2026-09-01 09:00:00.000000",
  };
}

function locationFixture(overrides: Partial<FoodbankLocationRow> = {}): FoodbankLocationRow {
  return {
    id: 501,
    uuid: "b2c3d4e5f6a7489012ab34cd56ef7890",
    foodbank_id: 42,
    foodbank_name: "Salisbury",
    foodbank_slug: "salisbury",
    foodbank_network: "Trussell",
    foodbank_phone_number: "01722 580180",
    foodbank_email: "info@salisbury.foodbank.org.uk",
    name: "St Thomas Church",
    slug: "st-thomas-church",
    address: "St Thomas's Square",
    postcode: "SP1 1BA",
    country: "England",
    lat_lng: "51.0693,-1.7970",
    latitude: 51.0693,
    longitude: -1.797,
    place_id: null,
    plus_code_compound: null,
    plus_code_global: null,
    place_has_photo: null,
    county: "Wiltshire",
    district: "Wiltshire",
    ward: null,
    lsoa: null,
    msoa: null,
    parliamentary_constituency_id: 7,
    parliamentary_constituency_name: "Salisbury",
    parliamentary_constituency_slug: "salisbury",
    mp: null,
    mp_party: null,
    mp_parl_id: null,
    is_closed: false,
    is_donation_point: null,
    is_mobile: null,
    boundary_geojson: null,
    phone_number: "01722 111222",
    email: "stthomas@salisbury.foodbank.org.uk",
    modified: "2026-09-01 09:00:00.000000",
    edited: null,
    ...overrides,
  };
}

function donationPointFixture(overrides: Partial<DonationPointRow> = {}): DonationPointRow {
  return {
    id: 701,
    uuid: "c3d4e5f6a7b8490123ab45cd67ef8901",
    foodbank_id: 42,
    foodbank_name: "Salisbury",
    foodbank_slug: "salisbury",
    foodbank_network: "Trussell",
    name: "Tesco Extra Salisbury",
    slug: "tesco-extra-salisbury",
    address: "Southampton Road",
    postcode: "SP1 2LB",
    country: "England",
    lat_lng: "51.0620,-1.7830",
    latitude: 51.062,
    longitude: -1.783,
    place_id: null,
    plus_code_compound: null,
    plus_code_global: null,
    place_has_photo: null,
    county: "Wiltshire",
    district: "Wiltshire",
    ward: null,
    lsoa: null,
    msoa: null,
    parliamentary_constituency_id: 7,
    parliamentary_constituency_name: "Salisbury",
    parliamentary_constituency_slug: "salisbury",
    mp: null,
    mp_party: null,
    mp_parl_id: null,
    is_closed: false,
    in_store_only: true,
    phone_number: "0345 677 9038",
    url: "https://www.tesco.com/store-locator/salisbury",
    opening_hours: "Monday: 6:00 AM – 12:00 AM\nTuesday: 6:00 AM – 12:00 AM",
    wheelchair_accessible: true,
    company: "Tesco",
    company_slug: "tesco",
    store_id: "3021",
    notes: null,
    modified: "2026-09-01 09:00:00.000000",
    edited: null,
    ...overrides,
  };
}

const FULL_NAME = "Salisbury Foodbank";

describe("buildFoodbankSchemaOrg", () => {
  it("emits the whole Foodbank.schema_org() document for a fully-populated food bank", () => {
    // One exhaustive assertion rather than a key at a time: this IS the
    // contract, and a field silently dropped from the object literal would
    // slip past a set of narrower per-key tests.
    expect(buildFoodbankSchemaOrg(foodbankFixture(), FULL_NAME)).toEqual({
      "@context": "https://schema.org",
      "@type": "NGO",
      // reverse("wfbn:foodbank", slug) -- gfwfbn/urls/i18n.py mounts
      // "at/<slug>/" under "needs/", so /needs/at/<slug>/.
      "@id": "https://www.givefood.org.uk/needs/at/salisbury/",
      additionalType: "https://www.wikidata.org/wiki/Q113603",
      name: FULL_NAME,
      alternateName: "Salisbury Foodbank",
      url: "https://salisbury.foodbank.org.uk/",
      email: "info@salisbury.foodbank.org.uk",
      telephone: "01722 580180",
      address: {
        "@type": "PostalAddress",
        postalCode: "SP2 7HL",
        addressCountry: "England",
        streetAddress: "Unit 9 Ashfield Trading Estate, Ashfield Road",
        addressLocality: "Wiltshire",
      },
      location: {
        "@type": "Place",
        // Foodbank.latt()/long() split lat_lng, they never read the
        // latitude/longitude columns -- those are nullable in production.
        geo: { "@type": "GeoCoordinates", latitude: 51.0688, longitude: -1.7945 },
      },
      identifier: "1110522",
      memberOf: {
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
      },
      sameAs: [
        "https://salisbury.foodbank.org.uk/",
        // uuid_redir takes Django's dashed str(UUID), not the dashless
        // form the column stores -- givefood/urls.py's <uuid:pk> route.
        "https://www.givefood.org.uk/a1b2c3d4-e5f6-4780-90ab-12cd34ef5678/",
        // quote_plus escapes the "+" in a Plus Code; a raw "+" in the path
        // would be a different Google Maps place.
        "https://www.google.co.uk/maps/place/9C3W3JR7%2B2M/",
        "https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=1110522&subid=0",
        "https://ratings.food.gov.uk/business/123456",
        "https://www.facebook.com/salisburyfoodbank",
      ],
      areaServed: { "@type": "AdministrativeArea", name: "Salisbury" },
      seeks: [
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Tinned Tomatoes" } },
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Pasta" } },
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "UHT Milk" } },
      ],
    });
  });

  it("takes `name` from the caller's fullName, not from foodbank.name", () => {
    // full_name() is locale-aware in Django (alt_name wins in Welsh etc.);
    // this file has no locale of its own, so the route computes the string
    // and passes it in. If the builder ever "helpfully" used foodbank.name
    // the Welsh pages would emit English organisation names to crawlers.
    const schema = buildFoodbankSchemaOrg(foodbankFixture(), "Banc Bwyd Salisbury");
    expect(schema.name).toBe("Banc Bwyd Salisbury");
    expect(schema.alternateName).toBe("Salisbury Foodbank");
  });

  it("drops @context and seeks when nested as a sub-property", () => {
    // Django's `if not as_sub_property:` guards BOTH -- a nested
    // @context inside parentOrganization/containsPlace is invalid JSON-LD.
    const sub = buildFoodbankSchemaOrg(foodbankFixture(), FULL_NAME, true);
    expect(sub).not.toHaveProperty("@context");
    expect(sub).not.toHaveProperty("seeks");
    // Everything else survives -- the flag drops two keys, not a whole branch.
    expect(sub["@id"]).toBe("https://www.givefood.org.uk/needs/at/salisbury/");
    expect(sub.sameAs).toHaveLength(6);
    expect(sub.areaServed).toEqual({ "@type": "AdministrativeArea", name: "Salisbury" });
  });

  it("defaults asSubProperty to false, so a direct call keeps @context", () => {
    expect(buildFoodbankSchemaOrg(foodbankFixture(), FULL_NAME)["@context"]).toBe("https://schema.org");
  });

  describe("memberOf", () => {
    // givefood/const/general.py's two network schemas, looked up by name.
    it("returns the IFAN schema for an IFAN member", () => {
      const memberOf = buildFoodbankSchemaOrg(foodbankFixture({ network: "IFAN" }), FULL_NAME).memberOf as Record<string, unknown>;
      expect(memberOf.name).toBe("IFAN");
      expect(memberOf.identifier).toBe("1180382");
      expect(memberOf.sameAs).toBe("https://www.wikidata.org/wiki/Q109638006");
    });

    it("returns an empty object -- not null, not a missing key -- for Independent", () => {
      // Django initialises `member_of = {}` and only replaces it for the two
      // known networks, so "memberOf": {} is emitted for everyone else.
      // Emitting null instead would be a schema.org type error.
      expect(buildFoodbankSchemaOrg(foodbankFixture({ network: "Independent" }), FULL_NAME).memberOf).toEqual({});
    });

    it("falls back to an empty object for a null or unrecognised network", () => {
      expect(buildFoodbankSchemaOrg(foodbankFixture({ network: null }), FULL_NAME).memberOf).toEqual({});
      expect(buildFoodbankSchemaOrg(foodbankFixture({ network: "Trussel" }), FULL_NAME).memberOf).toEqual({});
      // Case-sensitive, matching Python's `==` -- the column holds exactly
      // "Trussell" or "IFAN".
      expect(buildFoodbankSchemaOrg(foodbankFixture({ network: "trussell" }), FULL_NAME).memberOf).toEqual({});
    });
  });

  describe("address", () => {
    it("omits addressLocality when the food bank has no district", () => {
      const address = buildFoodbankSchemaOrg(foodbankFixture({ district: null }), FULL_NAME).address as Record<string, unknown>;
      expect(address).toEqual({
        "@type": "PostalAddress",
        postalCode: "SP2 7HL",
        addressCountry: "England",
        streetAddress: "Unit 9 Ashfield Trading Estate, Ashfield Road",
      });
      expect(address).not.toHaveProperty("addressLocality");
    });

    it("treats an empty-string district as absent", () => {
      // Truthiness, mirroring Python's `if self.district:` -- "" is falsey in
      // both languages, so an empty column must not produce an empty
      // addressLocality.
      const address = buildFoodbankSchemaOrg(foodbankFixture({ district: "" }), FULL_NAME).address as Record<string, unknown>;
      expect(address).not.toHaveProperty("addressLocality");
    });

    it("always emits an address block, unlike the location builder", () => {
      // Foodbank.address/postcode are non-null columns, so Django builds the
      // dict unconditionally. FoodbankLocation's are nullable and it guards
      // -- the asymmetry is real, not an oversight.
      expect(buildFoodbankSchemaOrg(foodbankFixture({ address: "", postcode: "" }), FULL_NAME)).toHaveProperty("address");
    });
  });

  describe("areaServed", () => {
    it("omits areaServed entirely when the constituency is unknown", () => {
      // A missing key, not `"areaServed": null` -- crawlers treat a null
      // AdministrativeArea as malformed.
      expect(buildFoodbankSchemaOrg(foodbankFixture({ parliamentary_constituency_name: null }), FULL_NAME)).not.toHaveProperty("areaServed");
    });
  });

  describe("sameAs", () => {
    it("lists only the URL and the uuid redirect for a food bank with no external ids", () => {
      const schema = buildFoodbankSchemaOrg(
        foodbankFixture({ place_id: null, plus_code_global: null, charity_number: null, fsa_id: null, facebook_page: null }),
        FULL_NAME,
      );
      expect(schema.sameAs).toEqual([
        "https://salisbury.foodbank.org.uk/",
        "https://www.givefood.org.uk/a1b2c3d4-e5f6-4780-90ab-12cd34ef5678/",
      ]);
      // identifier follows charity_number straight through, nulls included.
      expect(schema.identifier).toBeNull();
    });

    it("accepts a uuid that is already dashed", () => {
      // toDashedUuid normalises first, so a row read from a pre-migration
      // dump (dashed) produces the same canonical redirect URL as the
      // dashless form the column now holds.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ uuid: "A1B2C3D4-E5F6-4780-90AB-12CD34EF5678" }), FULL_NAME);
      expect((schema.sameAs as string[])[1]).toBe("https://www.givefood.org.uk/a1b2c3d4-e5f6-4780-90ab-12cd34ef5678/");
    });

    it("skips the Google Maps link when there is a place_id but no Plus Code", () => {
      // DIVERGENCE, defensive: Django guards on place_id alone and then
      // calls quote_plus(self.plus_code_global), which raises TypeError on
      // None. The extra `&& plus_code_global` here means the link is simply
      // absent rather than 500ing the whole food bank page.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ plus_code_global: null }), FULL_NAME);
      // Asserted as the whole array, not a `not.toContain`: a negative
      // membership check also passes when the entry is present but
      // misspelled, so it cannot tell "link absent" from "link mangled".
      expect(schema.sameAs).toEqual([
        "https://salisbury.foodbank.org.uk/",
        "https://www.givefood.org.uk/a1b2c3d4-e5f6-4780-90ab-12cd34ef5678/",
        "https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=1110522&subid=0",
        "https://ratings.food.gov.uk/business/123456",
        "https://www.facebook.com/salisburyfoodbank",
      ]);
    });

    it("skips the Google Maps link when there is a Plus Code but no place_id", () => {
      // The other half of the `place_id && plus_code_global` guard. Without
      // this case an implementation that dropped the `place_id &&` half
      // entirely still passes every other test in this file: the fixture
      // carries both, and the test above only ever removes the Plus Code.
      // A Plus Code without a resolved place_id means Google never matched
      // the address, so the /maps/place/ URL is not known to resolve.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ place_id: null }), FULL_NAME);
      expect(schema.sameAs).not.toContainEqual(expect.stringContaining("google.co.uk/maps"));
      expect(schema.sameAs).toHaveLength(5);
    });

    it("treats empty-string external ids as absent, not as ids worth linking", () => {
      // Every guard in the sameAs block is a truthiness test, mirroring
      // Python's `if self.fsa_id:`. D1 hands back "" for a cleared admin
      // field far more often than NULL, and a `!= null` rewrite would emit
      // https://ratings.food.gov.uk/business/ and https://www.facebook.com/
      // -- links to the wrong page rather than to nothing.
      const schema = buildFoodbankSchemaOrg(
        foodbankFixture({ place_id: "", plus_code_global: "", charity_number: "", fsa_id: "", facebook_page: "" }),
        FULL_NAME,
      );
      expect(schema.sameAs).toEqual([
        "https://salisbury.foodbank.org.uk/",
        "https://www.givefood.org.uk/a1b2c3d4-e5f6-4780-90ab-12cd34ef5678/",
      ]);
      // identifier is not guarded at all -- it takes charity_number raw.
      expect(schema.identifier).toBe("");
    });

    it("does not URL-encode the Facebook page name", () => {
      // Django interpolates facebook_page into the URL with no quoting
      // either. Pinned because it is the one sameAs entry built by raw
      // interpolation of an admin-entered value: if that column ever holds
      // a full URL or a path segment with a space, the emitted sameAs is
      // wrong in exactly the way this test shows, and the fix belongs in
      // the admin field, not in a silent encodeURIComponent here.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ facebook_page: "Salisbury Foodbank" }), FULL_NAME);
      expect(schema.sameAs).toContain("https://www.facebook.com/Salisbury Foodbank");
    });

    it("uses the Scottish and Northern Irish charity registers by country", () => {
      const scottish = buildFoodbankSchemaOrg(foodbankFixture({ country: "Scotland", charity_number: "SC012345" }), FULL_NAME);
      expect(scottish.sameAs).toContain(
        "https://www.oscr.org.uk/about-charities/search-the-register/charity-details?number=SC012345",
      );
      const ni = buildFoodbankSchemaOrg(foodbankFixture({ country: "Northern Ireland", charity_number: "NIC101234" }), FULL_NAME);
      // charityRegisterUrl strips the "NIC" prefix for the CCNI register.
      expect(ni.sameAs).toContain("https://www.charitycommissionni.org.uk/charity-details/?regId=101234");
    });

    it("omits the register link when the country has no register URL, rather than pushing null", () => {
      // DIVERGENCE: Django appends self.charity_register_url() whenever
      // charity_number is set, so an unmapped country yields a literal
      // `null` entry in sameAs. Here the falsey URL is dropped. Pinned
      // because a "tidy-up" that removed the `if (registerUrl)` guard would
      // put a null into a string array that templates iterate.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ country: "Ireland", charity_number: "20012345" }), FULL_NAME);
      expect(schema.sameAs).not.toContain(null);
      expect(schema.sameAs).toEqual([
        "https://salisbury.foodbank.org.uk/",
        "https://www.givefood.org.uk/a1b2c3d4-e5f6-4780-90ab-12cd34ef5678/",
        "https://www.google.co.uk/maps/place/9C3W3JR7%2B2M/",
        "https://ratings.food.gov.uk/business/123456",
        "https://www.facebook.com/salisburyfoodbank",
      ]);
      // The register URL is dropped from sameAs, but identifier still
      // carries the number -- the two are independent.
      expect(schema.identifier).toBe("20012345");
    });

    it("keeps the documented ordering: url, uuid, maps, register, FSA, Facebook", () => {
      // Order is not semantically meaningful to schema.org, but it is the
      // diffable output of a field nobody eyeballs; pinning it makes an
      // accidental reshuffle show up in review.
      const sameAs = buildFoodbankSchemaOrg(foodbankFixture(), FULL_NAME).sameAs as string[];
      expect(sameAs.map((entry) => new URL(entry).hostname)).toEqual([
        "salisbury.foodbank.org.uk",
        "www.givefood.org.uk",
        "www.google.co.uk",
        "register-of-charities.charitycommission.gov.uk",
        "ratings.food.gov.uk",
        "www.facebook.com",
      ]);
    });
  });

  describe("seeks", () => {
    it("emits one Demand per line of the latest need", () => {
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ latestNeed: needFixture("Rice\nSugar") }), FULL_NAME);
      expect(schema.seeks).toEqual([
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Rice" } },
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Sugar" } },
      ]);
    });

    it.each(["Nothing", "Unknown", "Facebook"])("omits seeks for the %s sentinel", (sentinel) => {
      // PLAN.md §7's three change_text sentinels. They are not item names:
      // emitting `seeks: [{name: "Facebook"}]` would advertise every one of
      // those food banks as needing a donation of Facebook.
      expect(buildFoodbankSchemaOrg(foodbankFixture({ latestNeed: needFixture(sentinel) }), FULL_NAME)).not.toHaveProperty("seeks");
    });

    it("treats a food bank with no need at all as 'Nothing'", () => {
      // Foodbank.latest_need_text() returns the literal "Nothing" when
      // latest_need is unset; the `?? "Nothing"` here is that fallback, and
      // it must land on the sentinel path rather than producing a Demand
      // named "null".
      expect(buildFoodbankSchemaOrg(foodbankFixture({ latestNeed: null }), FULL_NAME)).not.toHaveProperty("seeks");
    });

    it("matches the sentinels on the WHOLE change_text, never on a substring", () => {
      // The guard is `changeText === "Nothing"`, not `.includes(...)` or a
      // per-line check. Without this test a substring-matching rewrite
      // passes every other seeks test here, and every food bank whose need
      // list happens to mention one of the three words would silently stop
      // advertising ALL of its items to crawlers.
      const prefixed = buildFoodbankSchemaOrg(foodbankFixture({ latestNeed: needFixture("Nothing tinned please") }), FULL_NAME);
      expect(prefixed.seeks).toEqual([{ "@type": "Demand", itemOffered: { "@type": "Product", name: "Nothing tinned please" } }]);

      const embeddedLine = buildFoodbankSchemaOrg(foodbankFixture({ latestNeed: needFixture("Rice\nNothing\nPasta") }), FULL_NAME);
      expect(embeddedLine.seeks).toEqual([
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Rice" } },
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Nothing" } },
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Pasta" } },
      ]);
    });

    it("does not trim, so a padded sentinel is not a sentinel", () => {
      // Python's `==` does not strip either. A scraper that leaves a
      // trailing space on "Unknown " produces a one-item Demand, which is
      // wrong-but-faithful; pinned so the two ports stay wrong together
      // rather than drifting apart.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ latestNeed: needFixture("Unknown ") }), FULL_NAME);
      expect(schema.seeks).toEqual([{ "@type": "Demand", itemOffered: { "@type": "Product", name: "Unknown " } }]);
    });

    it("is case-sensitive about the sentinels", () => {
      // "nothing" is not the sentinel, so it is a (nonsense) item name.
      // Pinned so nobody adds a .toLowerCase() and quietly hides a real
      // one-item need whose text happens to be lowercase.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ latestNeed: needFixture("nothing") }), FULL_NAME);
      expect(schema.seeks).toEqual([{ "@type": "Demand", itemOffered: { "@type": "Product", name: "nothing" } }]);
    });

    it("produces a blank-named Demand for a trailing newline", () => {
      // DIVERGENCE from Django, pinned not endorsed: Python's
      // splitlines() discards the empty final piece, JS's split("\n") keeps
      // it, so a change_text ending in a newline gains a Demand with an
      // empty product name. Harmless-but-wrong JSON-LD; the rest of this
      // repo splits change_text the same way (models/index.ts changeList),
      // so this is consistent rather than isolated.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ latestNeed: needFixture("Rice\n") }), FULL_NAME);
      expect(schema.seeks).toEqual([
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Rice" } },
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "" } },
      ]);
    });

    it("leaves a carriage return on the item name for CRLF text", () => {
      // Same root cause as above: splitlines() would split on \r\n, split("\n")
      // leaves the \r glued to the item. Documented here so the behaviour is
      // known rather than discovered in a search result.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ latestNeed: needFixture("Rice\r\nSugar") }), FULL_NAME);
      expect(schema.seeks).toEqual([
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Rice\r" } },
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Sugar" } },
      ]);
    });

    it("emits a single empty Demand for empty change_text", () => {
      // "".split("\n") is [""] in JS, so seeks is non-empty and the key IS
      // written -- the same JS quirk needDiff.test.ts calls out.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ latestNeed: needFixture("") }), FULL_NAME);
      expect(schema.seeks).toEqual([{ "@type": "Demand", itemOffered: { "@type": "Product", name: "" } }]);
    });

    it("falls back to 'Nothing' when the joined need row has a null change_text", () => {
      // `latestNeed?.change_text ?? "Nothing"` -- the ?? applies to the
      // whole left-hand expression, so it catches a null change_text as
      // well as an absent need. The column is typed non-null but D1 hands
      // back NULL for a need row written before the column was populated,
      // which is why the cast below is deliberate rather than lazy: without
      // the ??, this would be `null.split("\n")` and a 500 on the food bank
      // page.
      const schema = buildFoodbankSchemaOrg(
        foodbankFixture({ latestNeed: needFixture(null as unknown as string) }),
        FULL_NAME,
      );
      expect(schema).not.toHaveProperty("seeks");
    });

    it("does not escape HTML in an item name, so change_text is trusted markup", () => {
      // The four *Str wrappers are injected into a
      // <script type="application/ld+json"> block with Nunjucks' |safe
      // (packages/templates/.../foodbank/index.njk). JSON.stringify escapes
      // quotes and backslashes but NOT "<" or "/", so a scraped item name
      // containing a closing script tag ends the JSON-LD block early. Django
      // does the same thing, so this is faithful, not a port regression --
      // pinned here so the exposure is written down and any future
      // escaping is a deliberate, reviewed divergence rather than a silent
      // behaviour change. See the suspected-bug note for this module.
      const json = schemaOrgStr(foodbankFixture({ latestNeed: needFixture("</script><b>x</b>") }), FULL_NAME);
      expect(json).toContain('"name": "</script><b>x</b>"');
    });
  });

  describe("geo", () => {
    it("parses latitude and longitude out of lat_lng, not the numeric columns", () => {
      // latitude/longitude are nullable in production; lat_lng is not, which
      // is why Django's latt()/long() -- and this -- parse the string.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ lat_lng: "53.4808,-2.2426", latitude: null, longitude: null }), FULL_NAME);
      expect(schema.location).toEqual({
        "@type": "Place",
        geo: { "@type": "GeoCoordinates", latitude: 53.4808, longitude: -2.2426 },
      });
    });

    it("tolerates whitespace around the comma", () => {
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ lat_lng: "53.4808, -2.2426" }), FULL_NAME) as {
        location: { geo: { longitude: number } };
      };
      expect(schema.location.geo.longitude).toBe(-2.2426);
    });

    it("yields NaN rather than throwing on a malformed lat_lng", () => {
      // A comma-less lat_lng is corrupt data, but a food bank page that
      // 500s is worse than one with a bad geo block -- pin the
      // no-throw behaviour, and see schemaOrgStr for what NaN serialises to.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ lat_lng: "53.4808" }), FULL_NAME) as {
        location: { geo: { latitude: number; longitude: number } };
      };
      expect(schema.location.geo.latitude).toBe(53.4808);
      expect(schema.location.geo.longitude).toBeNaN();
    });

    it("silently reports Null Island for an empty or comma-only lat_lng", () => {
      // The sharp edge the "malformed lat_lng" test above misses, because
      // it only covers a value Number() rejects. Number("") is 0, not NaN,
      // so an empty coordinate string does NOT degrade to a null geo the
      // way "bad" does -- it publishes a real, valid, wrong coordinate in
      // the Gulf of Guinea. That is worse than NaN: NaN serialises to null
      // and crawlers ignore it, whereas 0,0 is indexed as a location.
      // Pinned so the difference between the two failure modes is a known
      // fact about this module rather than a surprise in Search Console.
      const empty = buildFoodbankSchemaOrg(foodbankFixture({ lat_lng: "" }), FULL_NAME) as {
        location: { geo: { latitude: number; longitude: number } };
      };
      expect(empty.location.geo.latitude).toBe(0);
      // ...only the missing second half is NaN, because it is `undefined`.
      expect(empty.location.geo.longitude).toBeNaN();

      const commaOnly = buildFoodbankSchemaOrg(foodbankFixture({ lat_lng: "," }), FULL_NAME) as {
        location: { geo: { latitude: number; longitude: number } };
      };
      expect(commaOnly.location.geo).toEqual({ "@type": "GeoCoordinates", latitude: 0, longitude: 0 });
      // And it survives JSON as a genuine coordinate, not as null.
      expect(JSON.parse(schemaOrgStr(foodbankFixture({ lat_lng: "," }), FULL_NAME)).location.geo).toEqual({
        "@type": "GeoCoordinates",
        latitude: 0,
        longitude: 0,
      });
    });

    it("ignores anything after the second comma", () => {
      // Destructuring takes the first two pieces; a third field (a stray
      // altitude, or a double-comma typo) is dropped rather than throwing.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ lat_lng: "51.5,-0.12,999" }), FULL_NAME) as {
        location: { geo: { latitude: number; longitude: number } };
      };
      expect(schema.location.geo).toEqual({ "@type": "GeoCoordinates", latitude: 51.5, longitude: -0.12 });
    });

    it("keeps negative zero in the object but writes it as 0 in JSON", () => {
      // Greenwich sits on longitude -0 in some of the geocoder's output.
      // Number("-0") is -0, which toEqual distinguishes from 0, but
      // JSON.stringify does not -- so the object and the emitted document
      // legitimately disagree. Written down because a future equality check
      // over these builders would otherwise look inexplicably flaky.
      const schema = buildFoodbankSchemaOrg(foodbankFixture({ lat_lng: "51.4779,-0" }), FULL_NAME) as {
        location: { geo: { longitude: number } };
      };
      expect(Object.is(schema.location.geo.longitude, -0)).toBe(true);
      expect(schemaOrgStr(foodbankFixture({ lat_lng: "51.4779,-0" }), FULL_NAME)).toContain('"longitude": 0');
    });
  });

  describe("memberOf object identity", () => {
    it("hands out the module-level network constant itself, not a copy", () => {
      // memberOfForNetwork returns TRUSSELL_TRUST_SCHEMA by reference, so
      // every food bank schema in the isolate shares one object. Worker
      // isolates outlive a request, so a caller that mutated
      // schema.memberOf would corrupt the constant for every later request
      // on that isolate. Nothing mutates it today; this test is here so
      // that if someone introduces a defensive clone (or, worse, a
      // mutation) the change is visible rather than silent.
      const first = buildFoodbankSchemaOrg(foodbankFixture(), FULL_NAME).memberOf;
      const second = buildFoodbankSchemaOrg(foodbankFixture(), FULL_NAME).memberOf;
      expect(first).toBe(second);
      // The nested address is shared too -- it is the same literal.
      expect((first as { address: unknown }).address).toBe((second as { address: unknown }).address);
    });

    it("builds a fresh empty object for every non-member food bank", () => {
      // The `return {}` branch is a new literal each call, unlike the two
      // named-network branches above. The asymmetry is harmless but real,
      // and toEqual-based tests cannot see it.
      const first = buildFoodbankSchemaOrg(foodbankFixture({ network: null }), FULL_NAME).memberOf;
      const second = buildFoodbankSchemaOrg(foodbankFixture({ network: null }), FULL_NAME).memberOf;
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });
  });
});

describe("schemaOrgStr", () => {
  it("serialises exactly what the builder returns", () => {
    const foodbank = foodbankFixture();
    expect(JSON.parse(schemaOrgStr(foodbank, FULL_NAME))).toEqual(buildFoodbankSchemaOrg(foodbank, FULL_NAME));
  });

  it("pretty-prints with two spaces and keeps insertion order", () => {
    // DIVERGENCE, deliberate per the module header: Django uses
    // json.dumps(indent=4, sort_keys=True). Matching that byte-for-byte
    // isn't worth a custom serialiser for a field only crawlers read, so
    // the port emits 2-space, insertion-ordered JSON. Pinned so the
    // divergence stays a decision rather than a surprise.
    const json = schemaOrgStr(foodbankFixture(), FULL_NAME);
    expect(json.startsWith('{\n  "@context": "https://schema.org",\n  "@type": "NGO",')).toBe(true);
    expect(Object.keys(JSON.parse(json))).toEqual([
      "@context",
      "@type",
      "@id",
      "additionalType",
      "name",
      "alternateName",
      "url",
      "email",
      "telephone",
      "address",
      "location",
      "identifier",
      "memberOf",
      "sameAs",
      "areaServed",
      "seeks",
    ]);
  });

  it("writes a NaN coordinate as null, and stays valid JSON", () => {
    // The template injects this straight into a <script type="application/ld+json">
    // block. JSON.stringify turns NaN into null rather than the bare token
    // `NaN`, so corrupt coordinates degrade to an unparseable-by-crawlers
    // geo value, not an unparseable-by-anyone document.
    const json = schemaOrgStr(foodbankFixture({ lat_lng: "bad" }), FULL_NAME);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).location.geo).toEqual({ "@type": "GeoCoordinates", latitude: null, longitude: null });
  });

  it("keeps an explicit null for alternateName rather than dropping the key", () => {
    // JSON.stringify only drops `undefined`; alt_name is null, so the key
    // survives. Worth knowing before anyone "cleans up" the empty fields.
    expect(JSON.parse(schemaOrgStr(foodbankFixture({ alt_name: null }), FULL_NAME))).toHaveProperty("alternateName", null);
  });
});

describe("buildLocationSchemaOrg", () => {
  const LOCATION_FULL_NAME = "St Thomas Church, Salisbury Foodbank";

  it("emits the whole FoodbankLocation.schema_org() document", () => {
    const schema = buildLocationSchemaOrg(locationFixture(), foodbankFixture(), FULL_NAME, LOCATION_FULL_NAME);
    expect(schema).toEqual({
      "@context": "https://schema.org",
      "@type": "NGO",
      // reverse("wfbn:foodbank_location", slug, locslug) -- note this uses
      // the location's denormalised foodbank_slug, not foodbank.slug.
      "@id": "https://www.givefood.org.uk/needs/at/salisbury/st-thomas-church/",
      name: LOCATION_FULL_NAME,
      url: "https://salisbury.foodbank.org.uk/",
      email: "stthomas@salisbury.foodbank.org.uk",
      telephone: "01722 111222",
      location: {
        "@type": "Place",
        geo: { "@type": "GeoCoordinates", latitude: 51.0693, longitude: -1.797 },
      },
      // The location has no charity number of its own -- Django reads the
      // parent's.
      identifier: "1110522",
      memberOf: expect.objectContaining({ name: "Trussell" }),
      parentOrganization: buildFoodbankSchemaOrg(foodbankFixture(), FULL_NAME, true),
      address: {
        "@type": "PostalAddress",
        addressCountry: "England",
        postalCode: "SP1 1BA",
        streetAddress: "St Thomas's Square",
        addressLocality: "Wiltshire",
      },
      seeks: [
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Tinned Tomatoes" } },
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Pasta" } },
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "UHT Milk" } },
      ],
    });
  });

  it("keeps @context even as a sub-property -- the documented Django quirk", () => {
    // Unlike Foodbank.schema_org(), Django puts "@context" in the dict
    // LITERAL and then redundantly reassigns it inside `if not
    // as_sub_property`. So a nested location keeps its @context, which is
    // technically invalid JSON-LD nesting. The module header says this was
    // verified against the Django source directly; this test is what stops
    // someone "fixing" it into a divergence.
    const sub = buildLocationSchemaOrg(locationFixture(), foodbankFixture(), FULL_NAME, LOCATION_FULL_NAME, true);
    expect(sub["@context"]).toBe("https://schema.org");
    // Only seeks is actually gated by the flag.
    expect(sub).not.toHaveProperty("seeks");
  });

  it("builds @id from the location row's denormalised foodbank_slug", () => {
    // The default fixtures give the location and the food bank the SAME
    // slug, so every other test in this block passes just as happily
    // against `foodbank.slug`. They only diverge in the window between an
    // admin renaming a food bank and the denormalised columns being
    // rewritten -- exactly when a wrong @id would point crawlers at a 404.
    // Django reads self.foodbank_slug, so this pins which one wins.
    const schema = buildLocationSchemaOrg(
      locationFixture({ foodbank_slug: "salisbury-old" }),
      foodbankFixture({ slug: "salisbury-new" }),
      FULL_NAME,
      LOCATION_FULL_NAME,
    );
    expect(schema["@id"]).toBe("https://www.givefood.org.uk/needs/at/salisbury-old/st-thomas-church/");
    // ...while the nested parent uses its own slug, from the food bank row.
    expect((schema.parentOrganization as Record<string, unknown>)["@id"]).toBe(
      "https://www.givefood.org.uk/needs/at/salisbury-new/",
    );
  });

  it("takes addressCountry from the location's own country column", () => {
    // Same fixture-collision problem as the slug above: both rows say
    // "England" by default, so `foodbank.country` would pass unnoticed.
    // Locations genuinely cross the border -- a Chester food bank runs
    // sites in Wales -- and the country drives which charity register a
    // crawler is told about elsewhere on the page.
    const schema = buildLocationSchemaOrg(
      locationFixture({ country: "Wales" }),
      foodbankFixture({ country: "England" }),
      FULL_NAME,
      LOCATION_FULL_NAME,
    );
    expect((schema.address as Record<string, unknown>).addressCountry).toBe("Wales");
  });

  it("takes addressLocality from the location's own district", () => {
    // Third instance of the same collision. Asserted with an explicit
    // divergence rather than relying on the null-district case below.
    const schema = buildLocationSchemaOrg(
      locationFixture({ district: "Cheshire West and Chester" }),
      foodbankFixture({ district: "Wiltshire" }),
      FULL_NAME,
      LOCATION_FULL_NAME,
    );
    expect((schema.address as Record<string, unknown>).addressLocality).toBe("Cheshire West and Chester");
  });

  it("reads geo from the location's own lat_lng, not the food bank's", () => {
    // A location miles from its parent must not be plotted at the parent's
    // coordinates -- that would put every satellite site on top of the
    // warehouse in search results.
    const schema = buildLocationSchemaOrg(
      locationFixture({ lat_lng: "51.4545,-2.5879" }),
      foodbankFixture({ lat_lng: "51.0688,-1.7945" }),
      FULL_NAME,
      LOCATION_FULL_NAME,
    ) as { location: { geo: { latitude: number; longitude: number } } };
    expect(schema.location.geo).toEqual({ "@type": "GeoCoordinates", latitude: 51.4545, longitude: -2.5879 });
  });

  it("falls back to the food bank's email and phone when the location has none", () => {
    // email_or_foodbank_email() / phone_or_foodbank_phone(): a location
    // without its own contact details must still show a way to get in
    // touch, not an empty telephone field.
    const schema = buildLocationSchemaOrg(
      locationFixture({ email: null, phone_number: null }),
      foodbankFixture(),
      FULL_NAME,
      LOCATION_FULL_NAME,
    );
    expect(schema.email).toBe("info@salisbury.foodbank.org.uk");
    expect(schema.telephone).toBe("01722 580180");
  });

  it("falls back on empty strings too, not just nulls", () => {
    // Both helpers use `||`, matching Python's `if self.phone_number:` --
    // an empty column is as good as absent.
    const schema = buildLocationSchemaOrg(
      locationFixture({ email: "", phone_number: "" }),
      foodbankFixture(),
      FULL_NAME,
      LOCATION_FULL_NAME,
    );
    expect(schema.email).toBe("info@salisbury.foodbank.org.uk");
    expect(schema.telephone).toBe("01722 580180");
  });

  it("falls back to the LOCATION row's denormalised parent contact columns", () => {
    // The two tests above cannot tell `location.foodbank_email` from
    // `foodbank.contact_email`, because the fixtures give both the same
    // value -- so an implementation reading the parent object instead of
    // the location row passes them. Django reads the location's own
    // denormalised columns (the same choice the memberOf test below pins),
    // and it matters for the same reason: these columns are what the
    // location list query actually selects.
    const schema = buildLocationSchemaOrg(
      locationFixture({
        email: null,
        phone_number: null,
        foodbank_email: "denormalised@example.org",
        foodbank_phone_number: "01111 222333",
      }),
      foodbankFixture({ contact_email: "parent-object@example.org", phone_number: "09999 888777" }),
      FULL_NAME,
      LOCATION_FULL_NAME,
    );
    expect(schema.email).toBe("denormalised@example.org");
    expect(schema.telephone).toBe("01111 222333");
  });

  it("emits a null telephone when neither the location nor its parent has one", () => {
    // phoneOrFoodbankPhone returns `ownPhone || foodbankPhone`, so two
    // nulls give null rather than "" or an omitted key -- the JSON-LD
    // carries an explicit null telephone. emailOrFoodbankEmail cannot hit
    // the same case: foodbank_email is non-null in the row type.
    const schema = buildLocationSchemaOrg(
      locationFixture({ phone_number: null, foodbank_phone_number: null }),
      foodbankFixture(),
      FULL_NAME,
      LOCATION_FULL_NAME,
    );
    expect(schema.telephone).toBeNull();
    expect(JSON.parse(locationSchemaOrgStr(
      locationFixture({ phone_number: null, foodbank_phone_number: null }),
      foodbankFixture(),
      FULL_NAME,
      LOCATION_FULL_NAME,
    ))).toHaveProperty("telephone", null);
  });

  it("takes memberOf from the location's denormalised foodbank_network", () => {
    // Django reads self.foodbank_network on the LOCATION row, not
    // self.foodbank.network. The two are normally equal; this test proves
    // which one actually wins, so a future refactor to
    // `foodbank.network` is caught rather than silently assumed harmless.
    const schema = buildLocationSchemaOrg(
      locationFixture({ foodbank_network: "IFAN" }),
      foodbankFixture({ network: "Trussell" }),
      FULL_NAME,
      LOCATION_FULL_NAME,
    );
    expect((schema.memberOf as Record<string, unknown>).name).toBe("IFAN");
    // ...while the nested parent still reports its own network.
    expect(((schema.parentOrganization as Record<string, unknown>).memberOf as Record<string, unknown>).name).toBe("Trussell");
  });

  it("nests the parent food bank as a sub-property, without its own @context or seeks", () => {
    const parent = buildLocationSchemaOrg(locationFixture(), foodbankFixture(), FULL_NAME, LOCATION_FULL_NAME)
      .parentOrganization as Record<string, unknown>;
    expect(parent).not.toHaveProperty("@context");
    expect(parent).not.toHaveProperty("seeks");
    expect(parent["@type"]).toBe("NGO");
    // Spot-checked against literals, not against another call to
    // buildFoodbankSchemaOrg: the exhaustive test above computes its
    // expected parentOrganization by invoking the builder, which means a
    // bug INSIDE the builder would change both sides of that comparison
    // and pass. These four keys are the ones a crawler actually joins on.
    expect(parent["@id"]).toBe("https://www.givefood.org.uk/needs/at/salisbury/");
    expect(parent.name).toBe("Salisbury Foodbank");
    expect(parent.identifier).toBe("1110522");
    expect((parent.memberOf as Record<string, unknown>).name).toBe("Trussell");
  });

  it("passes the caller's foodbank fullName to the parent, not the location's", () => {
    // parentOrganization is built with `fullName`, the 3rd argument, while
    // the location's own `name` uses the 4th. Swapping them would name the
    // parent organisation "St Thomas Church, Salisbury Foodbank" -- a food
    // bank that does not exist -- in every location page's JSON-LD.
    const schema = buildLocationSchemaOrg(locationFixture(), foodbankFixture(), "Parent Name", "Location Name");
    expect(schema.name).toBe("Location Name");
    expect((schema.parentOrganization as Record<string, unknown>).name).toBe("Parent Name");
  });

  describe("address", () => {
    it("omits the address block entirely when there is no address and no postcode", () => {
      // Django's "Only add address if we have address or postcode" comment.
      // A PostalAddress carrying nothing but a country is noise.
      const schema = buildLocationSchemaOrg(
        locationFixture({ address: null, postcode: null }),
        foodbankFixture(),
        FULL_NAME,
        LOCATION_FULL_NAME,
      );
      expect(schema).not.toHaveProperty("address");
    });

    it("drops addressLocality with the block, even when the district is known", () => {
      // district is only ever read INSIDE the address guard, so a location
      // with a district but no address/postcode loses it. Matches Django.
      // Asserted on the location's OWN keys, not the serialised document --
      // the nested parentOrganization/memberOf legitimately carry their own
      // addressLocality, so a whole-JSON search would pass for the wrong
      // reason.
      const schema = buildLocationSchemaOrg(
        locationFixture({ address: null, postcode: null, district: "Wiltshire" }),
        foodbankFixture(),
        FULL_NAME,
        LOCATION_FULL_NAME,
      );
      expect(schema).not.toHaveProperty("address");
      expect(schema).not.toHaveProperty("addressLocality");
    });

    it("emits a postcode-only address", () => {
      const schema = buildLocationSchemaOrg(
        locationFixture({ address: null, district: null }),
        foodbankFixture(),
        FULL_NAME,
        LOCATION_FULL_NAME,
      );
      expect(schema.address).toEqual({ "@type": "PostalAddress", addressCountry: "England", postalCode: "SP1 1BA" });
    });

    it("emits a streetAddress-only address", () => {
      const schema = buildLocationSchemaOrg(
        locationFixture({ postcode: null, district: null }),
        foodbankFixture(),
        FULL_NAME,
        LOCATION_FULL_NAME,
      );
      expect(schema.address).toEqual({ "@type": "PostalAddress", addressCountry: "England", streetAddress: "St Thomas's Square" });
    });

    it("omits the block for empty strings too, not just nulls", () => {
      // `if (location.address || location.postcode)` is truthiness, matching
      // Python. Only the null case is covered above, so a `!== null`
      // rewrite would survive -- and then emit a PostalAddress whose only
      // real field is the country, which is precisely what Django's
      // "Only add address if we have address or postcode" comment exists
      // to prevent.
      const schema = buildLocationSchemaOrg(
        locationFixture({ address: "", postcode: "" }),
        foodbankFixture(),
        FULL_NAME,
        LOCATION_FULL_NAME,
      );
      expect(schema).not.toHaveProperty("address");
    });

    it("keeps the block when only one of the two is an empty string", () => {
      // The guard is an OR: a location with a postcode but a blank street
      // still gets an address, and the blank street is simply left out by
      // its own inner truthiness check.
      const schema = buildLocationSchemaOrg(
        locationFixture({ address: "", district: null }),
        foodbankFixture(),
        FULL_NAME,
        LOCATION_FULL_NAME,
      );
      expect(schema.address).toEqual({ "@type": "PostalAddress", addressCountry: "England", postalCode: "SP1 1BA" });
    });

    it("orders the address keys country, postcode, street, locality", () => {
      // The location builder seeds the object with addressCountry and then
      // conditionally appends -- the opposite order to the food bank and
      // donation point builders, which put postalCode first. Both are
      // faithful to their Python dict literals; pinned so the difference
      // reads as intentional in a diff.
      const schema = buildLocationSchemaOrg(locationFixture(), foodbankFixture(), FULL_NAME, LOCATION_FULL_NAME);
      expect(Object.keys(schema.address as Record<string, unknown>)).toEqual([
        "@type",
        "addressCountry",
        "postalCode",
        "streetAddress",
        "addressLocality",
      ]);
      expect(Object.keys(buildFoodbankSchemaOrg(foodbankFixture(), FULL_NAME).address as Record<string, unknown>)).toEqual([
        "@type",
        "postalCode",
        "addressCountry",
        "streetAddress",
        "addressLocality",
      ]);
    });
  });

  it("takes seeks from the parent food bank's need, since locations have none", () => {
    // FoodbankLocation has no needs of its own -- Django reads
    // self.foodbank.latest_need_text(). All of a food bank's locations
    // therefore advertise the same items.
    const schema = buildLocationSchemaOrg(
      locationFixture(),
      foodbankFixture({ latestNeed: needFixture("Nappies") }),
      FULL_NAME,
      LOCATION_FULL_NAME,
    );
    expect(schema.seeks).toEqual([{ "@type": "Demand", itemOffered: { "@type": "Product", name: "Nappies" } }]);
  });

  it("omits seeks when the parent food bank needs nothing", () => {
    const schema = buildLocationSchemaOrg(
      locationFixture(),
      foodbankFixture({ latestNeed: null }),
      FULL_NAME,
      LOCATION_FULL_NAME,
    );
    expect(schema).not.toHaveProperty("seeks");
  });
});

describe("locationSchemaOrgStr", () => {
  it("serialises exactly what the builder returns, 2-space indented", () => {
    const location = locationFixture();
    const foodbank = foodbankFixture();
    const json = locationSchemaOrgStr(location, foodbank, FULL_NAME, "St Thomas Church, Salisbury Foodbank");
    expect(JSON.parse(json)).toEqual(buildLocationSchemaOrg(location, foodbank, FULL_NAME, "St Thomas Church, Salisbury Foodbank"));
    expect(json).toContain('\n  "@type": "NGO"');
  });

  it("never passes asSubProperty, so the page-level document keeps its seeks", () => {
    // The Str wrapper is the page-render entry point; if it ever forwarded
    // a sub-property flag, every location page would silently stop
    // advertising what its food bank needs.
    const json = locationSchemaOrgStr(locationFixture(), foodbankFixture(), FULL_NAME, "St Thomas Church, Salisbury Foodbank");
    expect(JSON.parse(json).seeks).toHaveLength(3);
  });
});

describe("buildDonationPointSchemaOrg", () => {
  it("emits the whole FoodbankDonationPoint.schema_org() document", () => {
    const schema = buildDonationPointSchemaOrg(donationPointFixture(), foodbankFixture(), FULL_NAME);
    expect(schema).toEqual({
      "@context": "https://schema.org",
      // A donation point is a Place, not an NGO -- it is a supermarket
      // collection bin, not an organisation.
      "@type": "Place",
      name: "Tesco Extra Salisbury",
      url: "https://www.tesco.com/store-locator/salisbury",
      telephone: "0345 677 9038",
      isAccessibleForFree: true,
      address: {
        "@type": "PostalAddress",
        postalCode: "SP1 2LB",
        addressCountry: "England",
        streetAddress: "Southampton Road",
        addressLocality: "Wiltshire",
      },
      location: {
        "@type": "Place",
        geo: { "@type": "GeoCoordinates", latitude: 51.062, longitude: -1.783 },
      },
      parentOrganization: buildFoodbankSchemaOrg(foodbankFixture(), FULL_NAME, true),
      seeks: [
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Tinned Tomatoes" } },
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "Pasta" } },
        { "@type": "Demand", itemOffered: { "@type": "Product", name: "UHT Milk" } },
      ],
    });
  });

  it("has no @id -- Django's donation point schema omits it", () => {
    // Not an oversight in the port: the Python dict literal has no "@id"
    // key either. Pinned so nobody adds one "for consistency" and changes
    // what crawlers have already indexed.
    expect(buildDonationPointSchemaOrg(donationPointFixture(), foodbankFixture(), FULL_NAME)).not.toHaveProperty("@id");
  });

  it("preserves the tri-state wheelchair flag, including unknown", () => {
    // wheelchair_accessible is null when nobody has checked. Coalescing
    // that to false would publish "not accessible" about a shop that may
    // well be -- the DB type comment calls this out explicitly.
    expect(buildDonationPointSchemaOrg(donationPointFixture({ wheelchair_accessible: null }), foodbankFixture(), FULL_NAME)).toHaveProperty(
      "isAccessibleForFree",
      null,
    );
    expect(buildDonationPointSchemaOrg(donationPointFixture({ wheelchair_accessible: false }), foodbankFixture(), FULL_NAME)).toHaveProperty(
      "isAccessibleForFree",
      false,
    );
  });

  it("omits openingHoursSpecification even when opening hours are known", () => {
    // DIVERGENCE, deliberate per the module header: Django parses
    // opening_hours a second time into OpeningHoursSpecification entries.
    // The port skips it rather than duplicating the parser for a
    // non-golden-tested field. The fixture HAS parseable opening hours, so
    // this test would fail the moment the omission stopped being true --
    // which is the point: adding it back should be a conscious change.
    const schema = buildDonationPointSchemaOrg(donationPointFixture(), foodbankFixture(), FULL_NAME);
    expect(schema).not.toHaveProperty("openingHoursSpecification");
  });

  it("still builds an address when country is null", () => {
    // country is nullable in production despite the model declaring it NOT
    // NULL (0001_core.sql) -- the address block must survive it.
    const address = buildDonationPointSchemaOrg(donationPointFixture({ country: null }), foodbankFixture(), FULL_NAME)
      .address as Record<string, unknown>;
    expect(address).toEqual({
      "@type": "PostalAddress",
      postalCode: "SP1 2LB",
      addressCountry: null,
      streetAddress: "Southampton Road",
      addressLocality: "Wiltshire",
    });
  });

  it("omits addressLocality without a district", () => {
    const address = buildDonationPointSchemaOrg(donationPointFixture({ district: null }), foodbankFixture(), FULL_NAME)
      .address as Record<string, unknown>;
    expect(address).not.toHaveProperty("addressLocality");
    // Empty string as well as null -- the guard is truthiness, and a
    // cleared admin field arrives as "" far more often than as NULL.
    const blank = buildDonationPointSchemaOrg(donationPointFixture({ district: "" }), foodbankFixture(), FULL_NAME)
      .address as Record<string, unknown>;
    expect(blank).not.toHaveProperty("addressLocality");
  });

  it("nests the parent food bank with concrete, checkable values", () => {
    // The exhaustive test above builds its expected parentOrganization by
    // calling buildFoodbankSchemaOrg, so it proves the two calls agree, not
    // that either is right. These literals do not move if the builder
    // breaks.
    const parent = buildDonationPointSchemaOrg(donationPointFixture(), foodbankFixture(), FULL_NAME)
      .parentOrganization as Record<string, unknown>;
    expect(parent["@type"]).toBe("NGO");
    expect(parent["@id"]).toBe("https://www.givefood.org.uk/needs/at/salisbury/");
    expect(parent.name).toBe("Salisbury Foodbank");
    expect(parent).not.toHaveProperty("@context");
    expect(parent).not.toHaveProperty("seeks");
  });

  it("keeps the donation point's own fields separate from the parent's", () => {
    // name/url/telephone all exist on both rows. The fixtures differ, so
    // the exhaustive test does catch a swap -- but only for the three keys
    // it happens to cover. This states the rule outright: nothing at the
    // top level of a donation point document comes from the food bank
    // except parentOrganization and seeks.
    const schema = buildDonationPointSchemaOrg(
      donationPointFixture({ name: "Co-op Castle Street", url: "https://coop.example/store" }),
      foodbankFixture({ name: "Salisbury", url: "https://salisbury.foodbank.org.uk/" }),
      FULL_NAME,
    );
    expect(schema.name).toBe("Co-op Castle Street");
    expect(schema.url).toBe("https://coop.example/store");
    expect(schema).not.toHaveProperty("alternateName");
    expect(schema).not.toHaveProperty("identifier");
    expect(schema).not.toHaveProperty("additionalType");
    expect(schema).not.toHaveProperty("areaServed");
  });

  it("has no memberOf, unlike the food bank and location schemas", () => {
    // The module comment states DonationPoint has no memberOf field at
    // all: a Tesco is not a member of Trussell.
    expect(buildDonationPointSchemaOrg(donationPointFixture(), foodbankFixture(), FULL_NAME)).not.toHaveProperty("memberOf");
  });

  it("takes seeks from the parent food bank, and drops them for the sentinels", () => {
    expect(
      buildDonationPointSchemaOrg(donationPointFixture(), foodbankFixture({ latestNeed: needFixture("Unknown") }), FULL_NAME),
    ).not.toHaveProperty("seeks");
    expect(
      buildDonationPointSchemaOrg(donationPointFixture(), foodbankFixture({ latestNeed: needFixture("Rice") }), FULL_NAME).seeks,
    ).toEqual([{ "@type": "Demand", itemOffered: { "@type": "Product", name: "Rice" } }]);
  });

  it("reads geo from the donation point's lat_lng", () => {
    const schema = buildDonationPointSchemaOrg(
      donationPointFixture({ lat_lng: "55.9533,-3.1883", latitude: null, longitude: null }),
      foodbankFixture(),
      FULL_NAME,
    ) as { location: { geo: { latitude: number; longitude: number } } };
    expect(schema.location.geo).toEqual({ "@type": "GeoCoordinates", latitude: 55.9533, longitude: -3.1883 });
  });
});

describe("donationPointSchemaOrgStr", () => {
  it("serialises exactly what the builder returns", () => {
    const donationpoint = donationPointFixture();
    const foodbank = foodbankFixture();
    expect(JSON.parse(donationPointSchemaOrgStr(donationpoint, foodbank, FULL_NAME))).toEqual(
      buildDonationPointSchemaOrg(donationpoint, foodbank, FULL_NAME),
    );
  });

  it("pretty-prints with two spaces, like the other three wrappers", () => {
    // A round-trip through JSON.parse cannot see indentation at all, so
    // without this the `null, 2` argument could be dropped from this one
    // wrapper and every test above would still pass. The four wrappers all
    // feed the same <script type="application/ld+json"> block, and a
    // single-line one would be the odd one out in page source.
    const json = donationPointSchemaOrgStr(donationPointFixture(), foodbankFixture(), FULL_NAME);
    expect(json.startsWith('{\n  "@context": "https://schema.org",\n  "@type": "Place",')).toBe(true);
    // Nested objects step by two as well.
    expect(json).toContain('\n    "@type": "PostalAddress"');
  });

  it("emits a null url for a donation point without one, staying valid JSON", () => {
    // DonationPointRow.url is nullable; the page still has to render.
    const json = donationPointSchemaOrgStr(donationPointFixture({ url: null }), foodbankFixture(), FULL_NAME);
    expect(JSON.parse(json)).toHaveProperty("url", null);
  });
});

describe("buildConstituencySchemaOrg", () => {
  const CONSTITUENCY = { name: "Salisbury" };

  it("wraps every food bank and location in the area as containsPlace", () => {
    const foodbank = foodbankFixture();
    const location = locationFixture();
    const schema = buildConstituencySchemaOrg(
      CONSTITUENCY,
      [{ foodbank, fullName: FULL_NAME }],
      [{ location, foodbank, fullName: FULL_NAME, locationFullName: "St Thomas Church, Salisbury Foodbank" }],
    );
    expect(schema).toEqual({
      "@context": "https://schema.org",
      "@type": "AdministrativeArea",
      name: "Salisbury",
      containsPlace: [
        buildFoodbankSchemaOrg(foodbank, FULL_NAME, true),
        buildLocationSchemaOrg(location, foodbank, FULL_NAME, "St Thomas Church, Salisbury Foodbank", true),
      ],
      sameAs: "https://en.wikipedia.org/wiki/Salisbury_(UK_Parliament_constituency)",
    });
  });

  it("orders containsPlace food banks first, then locations", () => {
    // Django appends in two sequential loops (foodbank_obj() then
    // location_obj()); the spread order here is that loop order.
    const foodbank = foodbankFixture();
    const schema = buildConstituencySchemaOrg(
      CONSTITUENCY,
      [{ foodbank, fullName: "A Foodbank" }],
      [
        { location: locationFixture({ name: "First Loc" }), foodbank, fullName: FULL_NAME, locationFullName: "First Loc, Salisbury Foodbank" },
        { location: locationFixture({ name: "Second Loc", slug: "second-loc" }), foodbank, fullName: FULL_NAME, locationFullName: "Second Loc, Salisbury Foodbank" },
      ],
    );
    expect((schema.containsPlace as Array<Record<string, unknown>>).map((entry) => entry.name)).toEqual([
      "A Foodbank",
      "First Loc, Salisbury Foodbank",
      "Second Loc, Salisbury Foodbank",
    ]);
  });

  it("nests every entry as a sub-property, so no food bank carries seeks", () => {
    // Each contained food bank already publishes its own seeks on its own
    // page; repeating them here would duplicate a Demand for every item
    // across a constituency page with a dozen food banks.
    const foodbank = foodbankFixture();
    const entries = buildConstituencySchemaOrg(
      CONSTITUENCY,
      [{ foodbank, fullName: FULL_NAME }],
      [{ location: locationFixture(), foodbank, fullName: FULL_NAME, locationFullName: "St Thomas Church, Salisbury Foodbank" }],
    ).containsPlace as Array<Record<string, unknown>>;
    expect(entries[0]).not.toHaveProperty("seeks");
    expect(entries[1]).not.toHaveProperty("seeks");
    // The food bank sheds its @context; the LOCATION keeps its own, because
    // Django's FoodbankLocation.schema_org() puts @context in the literal.
    // Odd, but faithful -- see buildLocationSchemaOrg's tests above.
    expect(entries[0]).not.toHaveProperty("@context");
    expect(entries[1]).toHaveProperty("@context", "https://schema.org");
  });

  it("builds each containsPlace entry with values checkable without the builders", () => {
    // The first test in this block compares containsPlace against fresh
    // calls to buildFoodbankSchemaOrg/buildLocationSchemaOrg. That proves
    // consistency, not correctness: a bug inside either builder appears on
    // both sides of the assertion and the test stays green. These literals
    // are the joinable identity of each entry, and they do not move.
    const foodbank = foodbankFixture();
    const [foodbankEntry, locationEntry] = buildConstituencySchemaOrg(
      CONSTITUENCY,
      [{ foodbank, fullName: FULL_NAME }],
      [{ location: locationFixture(), foodbank, fullName: FULL_NAME, locationFullName: "St Thomas Church, Salisbury Foodbank" }],
    ).containsPlace as [Record<string, unknown>, Record<string, unknown>];
    expect(foodbankEntry["@type"]).toBe("NGO");
    expect(foodbankEntry["@id"]).toBe("https://www.givefood.org.uk/needs/at/salisbury/");
    expect(foodbankEntry.name).toBe("Salisbury Foodbank");
    expect(locationEntry["@id"]).toBe("https://www.givefood.org.uk/needs/at/salisbury/st-thomas-church/");
    expect(locationEntry.name).toBe("St Thomas Church, Salisbury Foodbank");
    // The location entry carries its own nested parent, two levels deep.
    expect((locationEntry.parentOrganization as Record<string, unknown>)["@id"]).toBe(
      "https://www.givefood.org.uk/needs/at/salisbury/",
    );
  });

  it("handles a constituency with locations but no food bank of its own", () => {
    // Real shape: a constituency can contain a satellite location whose
    // parent food bank sits in the neighbouring seat. The two spreads are
    // independent, so an empty first array must not shift or drop the
    // second.
    const foodbank = foodbankFixture();
    const schema = buildConstituencySchemaOrg(
      CONSTITUENCY,
      [],
      [{ location: locationFixture(), foodbank, fullName: FULL_NAME, locationFullName: "St Thomas Church, Salisbury Foodbank" }],
    );
    const entries = schema.containsPlace as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries.map((entry) => entry.name)).toEqual(["St Thomas Church, Salisbury Foodbank"]);
  });

  it("emits duplicate entries rather than de-duplicating", () => {
    // Django appends inside two loops with no set/uniqueness check either.
    // Pinned because the obvious "tidy-up" is a dedupe, and that would be a
    // silent divergence in a document nobody reads by eye.
    const foodbank = foodbankFixture();
    const schema = buildConstituencySchemaOrg(
      CONSTITUENCY,
      [
        { foodbank, fullName: FULL_NAME },
        { foodbank, fullName: FULL_NAME },
      ],
      [],
    );
    expect(schema.containsPlace).toHaveLength(2);
  });

  it("returns an empty containsPlace for a constituency with no food banks", () => {
    // ~650 constituencies exist and not all of them have a food bank; an
    // empty array is a valid AdministrativeArea, an exception is not.
    const schema = buildConstituencySchemaOrg({ name: "Orkney and Shetland" }, [], []);
    expect(schema.containsPlace).toEqual([]);
    expect(schema.sameAs).toBe("https://en.wikipedia.org/wiki/Orkney_and_Shetland_(UK_Parliament_constituency)");
  });

  describe("the Wikipedia sameAs URL", () => {
    it("replaces spaces with underscores before encoding", () => {
      // Wikipedia article titles use underscores; quote_plus would
      // otherwise turn the spaces into "+", which is not the same article.
      expect(buildConstituencySchemaOrg({ name: "North West Norfolk" }, [], []).sameAs).toBe(
        "https://en.wikipedia.org/wiki/North_West_Norfolk_(UK_Parliament_constituency)",
      );
    });

    it("percent-encodes brackets the way Python's quote_plus does", () => {
      // This is the exact case the module's quotePlus() exists for:
      // encodeURIComponent leaves ! ' ( ) * alone, quote_plus does not.
      // Real constituency names contain brackets ("Richmond (Yorks)"), so
      // without the extra replace the URL would differ from Django's.
      expect(buildConstituencySchemaOrg({ name: "Richmond (Yorks)" }, [], []).sameAs).toBe(
        "https://en.wikipedia.org/wiki/Richmond_%28Yorks%29_(UK_Parliament_constituency)",
      );
    });

    it("percent-encodes the rest of quote_plus's unsafe set", () => {
      // The other four characters encodeURIComponent leaves bare. Checked
      // together because the regex is a single character class -- losing
      // one of them is the plausible regression.
      expect(buildConstituencySchemaOrg({ name: "a!b'c*d" }, [], []).sameAs).toContain("a%21b%27c%2Ad");
    });

    it("leaves quote_plus's safe characters alone", () => {
      // Python's quote_plus safe set is A-Za-z0-9_.-~; those must survive
      // untouched or the article title changes.
      expect(buildConstituencySchemaOrg({ name: "St. Ives-on-Sea~1" }, [], []).sameAs).toContain("St._Ives-on-Sea~1");
    });

    it("UTF-8 percent-encodes accented names", () => {
      // "Ynys Môn" is a real constituency; quote_plus encodes the ô as its
      // two UTF-8 bytes, and so does encodeURIComponent.
      expect(buildConstituencySchemaOrg({ name: "Ynys Môn" }, [], []).sameAs).toBe(
        "https://en.wikipedia.org/wiki/Ynys_M%C3%B4n_(UK_Parliament_constituency)",
      );
    });

    it("survives a null constituency name instead of throwing", () => {
      // DIVERGENCE, defensive: ParliamentaryConstituency.name is nullable
      // and Django would raise AttributeError on None.replace(). Here the
      // `?? ""` yields a nonsense-but-harmless URL and a null name, so one
      // bad row cannot 500 the page.
      const schema = buildConstituencySchemaOrg({ name: null }, [], []);
      expect(schema.name).toBeNull();
      expect(schema.sameAs).toBe("https://en.wikipedia.org/wiki/_(UK_Parliament_constituency)");
    });

    it("treats an empty name the same as a null one, but keeps it as a string", () => {
      // `?? ""` only catches null/undefined, so "" travels the same path
      // and produces the same URL -- while `name` stays "" rather than
      // becoming null. Two different inputs, one URL, two different name
      // values: worth stating so the null test above is not read as
      // covering both.
      const schema = buildConstituencySchemaOrg({ name: "" }, [], []);
      expect(schema.name).toBe("");
      expect(schema.sameAs).toBe("https://en.wikipedia.org/wiki/_(UK_Parliament_constituency)");
    });

    it("collapses each space to exactly one underscore, including runs", () => {
      // The replace is /  /g on single spaces, so a double space becomes
      // two underscores rather than one. Wikipedia would not resolve that,
      // but it IS what quote_plus-plus-underscores does in Django, and a
      // "helpful" \s+ rewrite would be a silent divergence. Tabs are not
      // spaces to this regex and survive into the encoder as %09.
      expect(buildConstituencySchemaOrg({ name: "North  West" }, [], []).sameAs).toBe(
        "https://en.wikipedia.org/wiki/North__West_(UK_Parliament_constituency)",
      );
      expect(buildConstituencySchemaOrg({ name: "North\tWest" }, [], []).sameAs).toBe(
        "https://en.wikipedia.org/wiki/North%09West_(UK_Parliament_constituency)",
      );
    });

    it("leaves the literal suffix outside the encoded portion", () => {
      // Only the name goes through quotePlus; "_(UK_Parliament_constituency)"
      // is appended raw, so its own brackets stay unencoded. If the whole
      // string were encoded instead, every constituency URL on the site
      // would change at once -- which is why the two halves are asserted
      // together here rather than trusting the brackets test above.
      const sameAs = buildConstituencySchemaOrg({ name: "Richmond (Yorks)" }, [], []).sameAs as string;
      expect(sameAs.endsWith("_(UK_Parliament_constituency)")).toBe(true);
      expect(sameAs).toContain("%28Yorks%29");
    });

    it("encodes a slash so it cannot escape the /wiki/ path segment", () => {
      // encodeURIComponent turns "/" into %2F. A constituency name with a
      // slash that passed through raw would point at a different Wikipedia
      // path entirely, which is the class of bug quotePlus exists to avoid.
      expect(buildConstituencySchemaOrg({ name: "Cities of London and Westminster/Holborn" }, [], []).sameAs).toContain(
        "Westminster%2FHolborn",
      );
    });
  });
});

describe("constituencySchemaOrgStr", () => {
  it("serialises exactly what the builder returns", () => {
    const foodbank = foodbankFixture();
    const foodbanks = [{ foodbank, fullName: FULL_NAME }];
    const locations = [
      { location: locationFixture(), foodbank, fullName: FULL_NAME, locationFullName: "St Thomas Church, Salisbury Foodbank" },
    ];
    const constituency = { name: "Salisbury" };
    expect(JSON.parse(constituencySchemaOrgStr(constituency, foodbanks, locations))).toEqual(
      buildConstituencySchemaOrg(constituency, foodbanks, locations),
    );
  });

  it("pretty-prints with two spaces", () => {
    // Same gap as the donation point wrapper: the round-trip test above is
    // blind to indentation.
    const json = constituencySchemaOrgStr({ name: "Salisbury" }, [], []);
    expect(json.startsWith('{\n  "@context": "https://schema.org",\n  "@type": "AdministrativeArea",')).toBe(true);
  });

  it("stays valid JSON with an empty constituency", () => {
    const json = constituencySchemaOrgStr({ name: "Salisbury" }, [], []);
    expect(JSON.parse(json)).toEqual({
      "@context": "https://schema.org",
      "@type": "AdministrativeArea",
      name: "Salisbury",
      containsPlace: [],
      sameAs: "https://en.wikipedia.org/wiki/Salisbury_(UK_Parliament_constituency)",
    });
  });
});
