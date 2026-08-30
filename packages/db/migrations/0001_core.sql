-- ============================ 0001_core.sql ============================
-- givefood D1 schema -- the 5 tables gfapi1/gfapi2/gfapi3 actually read
-- (traced through every API view and the model methods it calls -- see
-- PLAN.md WP 2.2a). NO FOREIGN KEY constraints: see PLAN.md §4.5.
-- All timestamps are TEXT 'YYYY-MM-DD HH:MM:SS.ffffff', UTC, no offset.
-- All UUIDs are TEXT, 32-char dashless, lowercase.
--
-- Copied from PLAN.md §4.6, which already covers these 5 tables in full.

CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL, alt_name TEXT, slug TEXT NOT NULL,
  address TEXT NOT NULL,                  -- CRLF-separated; 1,066 of 1,071 rows contain \r\n
  postcode TEXT NOT NULL, country TEXT NOT NULL,
  lat_lng TEXT NOT NULL,                  -- "lat,lng" string; the API emits this verbatim
  latitude REAL, longitude REAL,
  delivery_address TEXT, delivery_lat_lng TEXT,
  network TEXT, network_id TEXT, notes TEXT,
  charity_number TEXT, charity_just_foodbank INTEGER NOT NULL,
  charity_id TEXT, charity_name TEXT, charity_type TEXT,
  charity_reg_date TEXT, charity_postcode TEXT, charity_website TEXT,
  charity_objectives TEXT, charity_purpose TEXT,
  facebook_page TEXT, bankuet_slug TEXT, fsa_id TEXT,
  contact_email TEXT NOT NULL, notification_email TEXT,
  phone_number TEXT, secondary_phone_number TEXT, delivery_phone_number TEXT,
  url TEXT NOT NULL, shopping_list_url TEXT NOT NULL,
  rss_url TEXT, news_url TEXT, donation_points_url TEXT,
  locations_url TEXT, contacts_url TEXT,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT,
  place_has_photo INTEGER,                -- one-time copy of the Postgres value; derived from R2 going forward, see PLAN.md §4.7
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  address_is_administrative INTEGER NOT NULL,
  is_closed INTEGER NOT NULL, is_school INTEGER,
  no_locations INTEGER NOT NULL, no_donation_points INTEGER,
  days_between_needs INTEGER NOT NULL, footprint INTEGER,
  bounds_north REAL, bounds_south REAL, bounds_east REAL, bounds_west REAL,
  latest_need_id INTEGER,                 -- circular ref to foodbankchange; fine, no FK declared
  last_order TEXT, last_need TEXT, last_rfi TEXT, last_crawl TEXT,
  last_social_media_check TEXT, last_discrepancy_check TEXT,
  last_need_check TEXT, last_charity_check TEXT,
  created TEXT NOT NULL, modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX foodbank_name_uniq   ON foodbank(name);
CREATE UNIQUE INDEX foodbank_slug_uniq   ON foodbank(slug);
CREATE INDEX foodbank_uuid_idx           ON foodbank(uuid);
CREATE INDEX foodbank_parlcon_slug_idx   ON foodbank(parliamentary_constituency_slug);
CREATE INDEX foodbank_modified_idx       ON foodbank(modified);
CREATE INDEX foodbank_edited_idx         ON foodbank(edited);
CREATE INDEX foodbank_last_need_idx      ON foodbank(last_need);
CREATE INDEX foodbank_closed_edited_idx  ON foodbank(is_closed, edited DESC);
CREATE INDEX foodbank_open_latlng_idx    ON foodbank(latitude, longitude) WHERE is_closed = 0;

CREATE TABLE foodbanklocation (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  foodbank_name TEXT NOT NULL, foodbank_slug TEXT NOT NULL,
  foodbank_network TEXT NOT NULL, foodbank_phone_number TEXT, foodbank_email TEXT NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT, postcode TEXT,
  country TEXT NOT NULL, lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT, place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  is_closed INTEGER NOT NULL,
  is_donation_point INTEGER, is_mobile INTEGER,   -- NULLABLE in production: 567/1972 and 1773/1972 NULL respectively, contrary to the model's declared NOT NULL
  boundary_geojson TEXT,
  phone_number TEXT, email TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX loc_fb_name_uniq    ON foodbanklocation(foodbank_id, name);
CREATE INDEX loc_foodbank_slug_idx      ON foodbanklocation(foodbank_id, slug);
CREATE INDEX loc_uuid_idx               ON foodbanklocation(uuid);
CREATE INDEX loc_parlcon_slug_idx       ON foodbanklocation(parliamentary_constituency_slug);
CREATE INDEX loc_open_latlng_idx        ON foodbanklocation(latitude, longitude) WHERE is_closed = 0;
CREATE INDEX loc_open_dp_latlng_idx     ON foodbanklocation(latitude, longitude)
                                        WHERE is_closed = 0 AND is_donation_point = 1;

CREATE TABLE foodbankdonationpoint (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  foodbank_name TEXT NOT NULL, foodbank_slug TEXT NOT NULL, foodbank_network TEXT NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT NOT NULL, postcode TEXT NOT NULL, country TEXT,   -- NULLABLE in production: 1/5744 NULL, contrary to the model's declared NOT NULL
  lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT, place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  is_closed INTEGER NOT NULL, in_store_only INTEGER NOT NULL,
  phone_number TEXT, url TEXT, opening_hours TEXT,
  wheelchair_accessible INTEGER,          -- TRI-STATE: NULL/0/1, do not coalesce
  company TEXT, company_slug TEXT, store_id TEXT, notes TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX dp_fb_name_uniq  ON foodbankdonationpoint(foodbank_id, name);
CREATE INDEX dp_foodbank_slug_idx    ON foodbankdonationpoint(foodbank_id, slug);
CREATE INDEX dp_uuid_idx             ON foodbankdonationpoint(uuid);
CREATE INDEX dp_parlcon_slug_idx     ON foodbankdonationpoint(parliamentary_constituency_slug);
CREATE INDEX dp_company_slug_name    ON foodbankdonationpoint(company_slug, name);
CREATE INDEX dp_open_latlng_idx      ON foodbankdonationpoint(latitude, longitude) WHERE is_closed = 0;

CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL,                  -- 32-char dashless; need_id_str dropped, computed at read time
  foodbank_id INTEGER, foodbank_name TEXT,
  distill_id TEXT, name TEXT, uri TEXT,
  change_text TEXT NOT NULL,              -- sentinels 'Nothing' / 'Unknown' / 'Facebook' are contract
  change_text_original TEXT,
  excess_change_text TEXT, excess_change_text_original TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  nonpertinent INTEGER,                   -- NULLABLE: NULL is NOT 0
  is_categorised INTEGER,                 -- NULLABLE
  notified TEXT, input_method TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE UNIQUE INDEX need_need_id_uniq      ON foodbankchange(need_id);
CREATE INDEX change_foodbank_created_idx   ON foodbankchange(foodbank_id, created DESC);
CREATE INDEX change_published_foodbank_idx ON foodbankchange(published, foodbank_id);
CREATE INDEX change_pub_created_idx        ON foodbankchange(published, created DESC) WHERE published = 1;
CREATE INDEX change_uncategorised_idx      ON foodbankchange(is_categorised) WHERE is_categorised IS NULL;

CREATE TABLE parliamentaryconstituency (
  id INTEGER PRIMARY KEY,
  name TEXT, slug TEXT NOT NULL, country TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER NOT NULL, mp_display_name TEXT, email TEXT,
  centroid TEXT NOT NULL,                 -- "lat,lng" string, split at runtime -- the ACTUAL source of latt()/long(), see PLAN.md §4.6
  latitude REAL, longitude REAL,          -- NULLABLE: 646/650 NULL in production. Vestigial -- latt()/long() read centroid, not these.
  boundary_geojson TEXT                   -- STAYS in D1. 650 rows, max 1,568 kB < 2 MB limit.
);
CREATE INDEX parlcon_slug_idx ON parliamentaryconstituency(slug);
