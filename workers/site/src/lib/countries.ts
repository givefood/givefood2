// givefood/views.py:35-73 -- COUNTRY_MAPPING/COUNTRY_MAP_CONFIG/
// COUNTRY_PLACEHOLDERS, shared by the `country` page handler
// (routes/public/country.ts) and `country_geojson`'s D1 queries
// (buildGeojson.ts's "country" GeojsonScope), so both read the same
// slug -> display-name mapping rather than each keeping its own copy.

// COUNTRY_MAPPING (givefood/views.py:35-40) -- the 4 real country_slug
// values (routing itself constrains a request to exactly these -- see
// index.ts's `:countrySlug{scotland|england|wales|northern-ireland}`
// route param) mapped to the display name stored verbatim in every
// foodbank/foodbanklocation/foodbankdonationpoint row's `country` column.
export const COUNTRY_MAPPING: Record<string, string> = {
  scotland: "Scotland",
  england: "England",
  wales: "Wales",
  "northern-ireland": "Northern Ireland",
};

// COUNTRY_MAP_CONFIG (givefood/views.py:44-65) -- map centre/zoom per
// country, keyed by the SAME display name COUNTRY_MAPPING resolves to
// (not by slug), matching the Python source's own keying.
export interface CountryMapSettings {
  lat: number;
  lng: number;
  zoom: number;
}

export const COUNTRY_MAP_CONFIG: Record<string, CountryMapSettings> = {
  Scotland: { lat: 57.7, lng: -4, zoom: 6 },
  England: { lat: 53, lng: -1.8, zoom: 6 },
  Wales: { lat: 52.3, lng: -3.7, zoom: 7 },
  "Northern Ireland": { lat: 54.6, lng: -6.5, zoom: 7 },
};

// COUNTRY_PLACEHOLDERS (givefood/views.py:68-73) -- each value is the
// literal English msgid `public/country.njk` passes to `_()` at render
// time (the `{{ _(cat_label) }}`-style dynamic-msgid pattern already used
// by wfbn/index.njk's category dropdown -- see i18n.ts's translate()).
// NOT translated here: this file has no access to the current request's
// locale/catalogue, only env.ts's render() does.
export const COUNTRY_PLACEHOLDERS: Record<string, string> = {
  Scotland: "e.g. EH12 5PJ or Glasgow",
  England: "e.g. HA9 0WS or Manchester",
  Wales: "e.g. CF10 1NS or Cardiff",
  "Northern Ireland": "e.g. BT12 6LW or Belfast",
};
