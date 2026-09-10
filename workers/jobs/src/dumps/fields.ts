// gfdumps/management/commands/dump.py's four field lists, verbatim and in
// source order (github #59).
//
// THESE ARE A PUBLIC SCHEMA. Third parties download these CSVs and index by
// column position and header name, so the order is as load-bearing as the
// names. gfdumps/tests.py locks all four lists upstream -- 61 / 12 / 31 / 6
// columns -- and dumps.test.ts pins the same counts here so a dropped or
// reordered column fails rather than ships.

export const FOODBANK_FIELDS = [
  "id", "organisation_name", "organisation_alt_name", "organisation_slug", "location_name",
  "location_slug", "url", "shopping_list_url", "rss_url", "news_url", "donation_points_url",
  "locations_url", "contacts_url", "phone_number", "secondary_phone_number", "email", "address",
  "postcode", "country", "lat_lng", "place_id", "plus_code_compound", "plus_code_global", "lsoa",
  "msoa", "parliamentary_constituency", "mp_parliamentary_id", "mp", "mp_party", "ward", "district",
  "charity_number", "charity_register_url", "charity_name", "charity_type", "charity_reg_date",
  "charity_postcode", "charity_website", "charity_objectives", "charity_purpose",
  "food_standards_agency_id", "food_standards_agency_url", "network", "network_id", "is_school",
  "is_mobile", "is_area", "boundary", "bounds_north", "bounds_south", "bounds_east", "bounds_west",
  "created", "modified", "edited", "need_id", "needed_items", "excess_items", "need_found",
  "footprintsqm",
] as const;

export const ITEM_FIELDS = [
  "organisation_id", "organisation_name", "organisation_alt_name", "organisation_slug", "network",
  "country", "lat_lng", "type", "item", "category", "group", "created",
] as const;

export const DONATIONPOINT_FIELDS = [
  "id", "name", "slug", "address", "postcode", "lat_lng", "phone_number", "opening_hours",
  "wheelchair_accessible", "url", "in_store_only", "company", "store_id", "place_id",
  "plus_code_compound", "plus_code_global", "lsoa", "msoa", "parliamentary_constituency_name",
  "mp_parl_id", "mp", "mp_party", "ward", "district", "organisation_id", "organisation_name",
  "organisation_alt_name", "organisation_slug", "organisation_network", "organisation_country",
  "organisation_lat_lng",
] as const;

export const ARTICLE_FIELDS = [
  "title", "url", "published_date", "organisation_id", "organisation_name", "organisation_slug",
] as const;
