#!/usr/bin/env python3
"""
WP 2.2a: copy the 5 tables gfapi1/gfapi2/gfapi3 actually read (traced
through every API view and the model methods it calls -- see PLAN.md
§10.2.2's note correcting an earlier draft's guess at "the ~15-query
core") from production Postgres into the `givefood` D1 database.

Read-only against Postgres throughout -- Postgres is copied from, never
written to, and stays authoritative until Phase 8 (see PLAN.md §4, §6 D3).
Idempotent: uses INSERT OR REPLACE, so re-running this (e.g. before WP
2.7's route cutover, to pick up writes made since the last run) is safe.

Loads via the D1 REST API with bound parameters, not `wrangler d1 execute
--file` with inline SQL literals -- a handful of rows carry large TEXT
values (parliamentaryconstituency.boundary_geojson up to ~1.57 MB) that
exceed D1's parsed-SQL-statement-text limit even though the value itself
is well under the documented 2 MB per-value cap. Binding sends values
out-of-band from the SQL text, sidestepping that limit entirely -- and
because bound params don't inflate the SQL text, most rows can be batched
many-per-statement (multi-row VALUES) rather than one HTTP call per row,
which is what made the first version of this script slow: ~1.7 rows/s
one-at-a-time made the two largest tables take 15-20 minutes each. Rows
are batched up to a row/param/byte cap (whichever is hit first) and
batches are sent with a small thread pool, so the few oversized rows
(which land alone in their own batch) don't throttle the thousands of
small ones sharing a table with them.

Usage:
    uv run --with psycopg2-binary python tools/pg-to-d1/extract_core.py

Requires:
    - foodcharity/.env readable (DB_HOST, DB_NAME, DB_USER, DB_PASS)
    - `wrangler login` done on this machine (reads the OAuth token wrangler
      itself stores, rather than needing a separate Cloudflare API token)
"""
import datetime
import decimal
import json
import os
import random
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

FOODCHARITY_ENV_PATH = os.path.expanduser(
    os.environ.get("FOODCHARITY_ENV_PATH", "~/Sites/foodcharity/.env")
)
WRANGLER_CONFIG_PATH = os.path.expanduser(
    "~/Library/Preferences/.wrangler/config/default.toml"
)
ACCOUNT_ID = "211195b9bf606f797a6d2dbc0bf41791"
DATABASE_ID = "1cae445f-9719-453d-9cf6-1060f8b3ea7e"  # the `givefood` D1 database

# Batch sizing. MAX_PARAMS_PER_BATCH=100 is not a guess -- D1 rejected a
# first attempt at 400 with "too many SQL variables at offset 1458:
# SQLITE_ERROR", and counting placeholders up to that byte offset in the
# generated SQL landed on exactly 100, confirmed by testing multi-row
# INSERTs at increasing widths. That's D1's real per-statement bound-
# parameter ceiling, well under SQLite's own default. It caps batching hard
# for wide tables (foodbank at 79 columns fits only 1 row/statement), so
# the row/byte caps below mostly matter for the narrower tables; the
# flush-before-append logic handles any single row larger than the caps by
# giving it a solo batch, so correctness never depends on these numbers --
# only throughput does.
MAX_ROWS_PER_BATCH = 50
MAX_PARAMS_PER_BATCH = 100
MAX_BYTES_PER_BATCH = 200_000
CONCURRENCY = 8

# Three consecutive full-run failures, all `socket.gaierror` from
# getaddrinfo(api.cloudflare.com) -- never an HTTP-level error -- with
# ad-hoc nslookup/ping against the same host succeeding seconds later each
# time. That pattern (fails under 8-way concurrent resolution, succeeds
# solo) points at the resolver path being unable to keep up with concurrent
# lookups here, not a real outage, so retry network-layer errors with
# backoff instead of only the existing 401/403 auth-refresh retry.
MAX_NETWORK_RETRIES = 6
NETWORK_RETRY_BASE_DELAY = 1.0

# psycopg2 returns uuid columns as plain `str` (dashed) in this environment,
# not `uuid.UUID` -- confirmed by direct query, not assumed. isinstance()
# can't tell a UUID string from any other string, so UUID columns are named
# explicitly per table and stripped of dashes regardless of the Python type
# psycopg2 happens to hand back. See PLAN.md §4.4's type-mapping rules.
UUID_COLUMNS = {
    "foodbank": {"uuid"},
    "foodbanklocation": {"uuid"},
    "foodbankdonationpoint": {"uuid"},
    "foodbankchange": {"need_id"},
    "parliamentaryconstituency": set(),
    "foodbankchangeline": set(),
    "foodbankhit": set(),
    "foodbankarticle": set(),
    "orders": set(),
    "orderline": set(),
    "charityyear": set(),
    "foodbankchangetranslation": set(),
    "place": set(),
    "postcode": set(),
}

# (postgres_table, d1_table, [d1_columns_in_order])
# Column lists match packages/db/migrations/0001_core.sql exactly -- verified
# programmatically against information_schema before this was written, not
# transcribed by hand. need_id_str is the one Postgres column intentionally
# dropped (computed at read time instead, per the DDL's own comment).
TABLES = [
    ("givefood_foodbank", "foodbank", [
        'id', 'uuid', 'name', 'alt_name', 'slug', 'address', 'postcode', 'country', 'lat_lng',
        'latitude', 'longitude', 'delivery_address', 'delivery_lat_lng', 'network', 'network_id',
        'notes', 'charity_number', 'charity_just_foodbank', 'charity_id', 'charity_name',
        'charity_type', 'charity_reg_date', 'charity_postcode', 'charity_website',
        'charity_objectives', 'charity_purpose', 'facebook_page', 'bankuet_slug', 'fsa_id',
        'contact_email', 'notification_email', 'phone_number', 'secondary_phone_number',
        'delivery_phone_number', 'url', 'shopping_list_url', 'rss_url', 'news_url',
        'donation_points_url', 'locations_url', 'contacts_url', 'place_id', 'plus_code_compound',
        'plus_code_global', 'place_has_photo', 'county', 'district', 'ward', 'lsoa', 'msoa',
        'parliamentary_constituency_id', 'parliamentary_constituency_name',
        'parliamentary_constituency_slug', 'mp', 'mp_party', 'mp_parl_id',
        'address_is_administrative', 'is_closed', 'is_school', 'no_locations',
        'no_donation_points', 'days_between_needs', 'footprint', 'bounds_north', 'bounds_south',
        'bounds_east', 'bounds_west', 'latest_need_id', 'last_order', 'last_need', 'last_rfi',
        'last_crawl', 'last_social_media_check', 'last_discrepancy_check', 'last_need_check',
        'last_charity_check', 'created', 'modified', 'edited',
    ]),
    ("givefood_foodbanklocation", "foodbanklocation", [
        'id', 'uuid', 'foodbank_id', 'foodbank_name', 'foodbank_slug', 'foodbank_network',
        'foodbank_phone_number', 'foodbank_email', 'name', 'slug', 'address', 'postcode',
        'country', 'lat_lng', 'latitude', 'longitude', 'place_id', 'plus_code_compound',
        'plus_code_global', 'place_has_photo', 'county', 'district', 'ward', 'lsoa', 'msoa',
        'parliamentary_constituency_id', 'parliamentary_constituency_name',
        'parliamentary_constituency_slug', 'mp', 'mp_party', 'mp_parl_id', 'is_closed',
        'is_donation_point', 'is_mobile', 'boundary_geojson', 'phone_number', 'email',
        'modified', 'edited',
    ]),
    ("givefood_foodbankdonationpoint", "foodbankdonationpoint", [
        'id', 'uuid', 'foodbank_id', 'foodbank_name', 'foodbank_slug', 'foodbank_network', 'name',
        'slug', 'address', 'postcode', 'country', 'lat_lng', 'latitude', 'longitude', 'place_id',
        'plus_code_compound', 'plus_code_global', 'place_has_photo', 'county', 'district', 'ward',
        'lsoa', 'msoa', 'parliamentary_constituency_id', 'parliamentary_constituency_name',
        'parliamentary_constituency_slug', 'mp', 'mp_party', 'mp_parl_id', 'is_closed',
        'in_store_only', 'phone_number', 'url', 'opening_hours', 'wheelchair_accessible',
        'company', 'company_slug', 'store_id', 'notes', 'modified', 'edited',
    ]),
    ("givefood_foodbankchange", "foodbankchange", [
        'id', 'need_id', 'foodbank_id', 'foodbank_name', 'distill_id', 'name', 'uri',
        'change_text', 'change_text_original', 'excess_change_text',
        'excess_change_text_original', 'published', 'nonpertinent', 'is_categorised', 'notified',
        'input_method', 'created', 'modified',
    ]),
    ("givefood_parliamentaryconstituency", "parliamentaryconstituency", [
        'id', 'name', 'slug', 'country', 'mp', 'mp_party', 'mp_parl_id', 'mp_display_name',
        'email', 'centroid', 'latitude', 'longitude', 'boundary_geojson',
    ]),
]

# migrations/0003_homepage_data.sql -- the root homepage's extra reads
# (get_site_stats(), most-viewed, featured articles), added after WP 2.2a's
# original 5-table scope. Same (pg_table, d1_table, cols) shape as TABLES
# above, plus an optional trailing kwargs dict for load_table()'s
# where/select_cols/order_by -- kept separate from TABLES so a plain re-run
# of the original 5-table copy (main()'s original purpose) isn't silently
# widened; call load_table() on these explicitly, see main().
HOMEPAGE_TABLES = [
    ("givefood_foodbankchangeline", "foodbankchangeline", [
        'id', 'need_id', 'foodbank_id', 'item', 'type', 'category', 'group_name', 'created',
    ], {
        "select_cols": ['id', 'need_id', 'foodbank_id', 'item', 'type', 'category', '"group" AS group_name', 'created'],
    }),
    ("givefood_foodbankhit", "foodbankhit", [
        'foodbank_id', 'day', 'hits',
    ], {
        "order_by": "foodbank_id, day",
    }),
    ("givefood_foodbankarticle", "foodbankarticle", [
        'id', 'foodbank_id', 'foodbank_name', 'published_date', 'title', 'url', 'featured',
    ], {
        "where": "featured = true",
    }),
]

# WP 4.5's gfdash dashboards. `articles` widens foodbankarticle from
# HOMEPAGE_TABLES' featured-only 168 rows to the full 17k+ (a strict
# superset -- INSERT OR REPLACE makes re-running HOMEPAGE_TABLES afterwards
# harmless too). orders/orderline/charityyear are brand new tables
# (migrations/0005_orders_and_charity.sql) with no prior D1 data at all.
DASHBOARD_TABLES = [
    ("givefood_foodbankarticle", "foodbankarticle", [
        'id', 'foodbank_id', 'foodbank_name', 'published_date', 'title', 'url', 'featured',
    ]),
    ("givefood_order", "orders", [
        'id', 'order_id', 'items_text', 'country', 'created', 'modified',
        'notification_email_sent', 'source_url', 'delivery_date', 'delivery_hour',
        'delivery_datetime', 'delivery_provider', 'delivery_provider_id', 'weight', 'calories',
        'cost', 'actual_cost', 'no_lines', 'no_items', 'foodbank_id', 'need_id', 'order_group_id',
    ], {
        "select_cols": [
            'id', 'order_id', 'items_text', 'country', 'created', 'modified',
            'notification_email_sent', 'source_url', 'delivery_date', 'delivery_hour',
            'delivery_datetime', 'delivery_provider', 'delivery_provider_id', 'weight', 'calories',
            'cost', 'actual_cost', 'no_lines', 'no_items', 'foodbank_id', 'need_id',
            'order_group_id',
        ],
        # "order" is a Postgres reserved word too (see SITE_STATS_SQL above).
        "from_table": '"givefood_order"',
    }),
    ("givefood_orderline", "orderline", [
        'id', 'name', 'quantity', 'item_cost', 'line_cost', 'weight', 'calories', 'order_id',
        'delivery_date', 'category', 'group_name',
    ], {
        "select_cols": [
            'id', 'name', 'quantity', 'item_cost', 'line_cost', 'weight', 'calories', 'order_id',
            'delivery_date', 'category', '"group" AS group_name',
        ],
    }),
    ("givefood_charityyear", "charityyear", [
        'id', 'foodbank_id', 'created', 'date', 'income', 'expenditure',
    ]),
]

# Follow-up to WP 3's gfwfbn HTML build: FoodbankChangeTranslation
# (migrations/0006_need_translations.sql), filtered to the 3 non-English
# locales this app actually serves (cy/ga/gd -- see that migration's own
# comment: production carries 16 other languages, ~60k more rows, for
# Django's wider LANGUAGES list this app doesn't serve). Joined against
# foodbankchange (PLAN.md's own reference export, §5.3.3: "the JOIN
# silently drops the 863 orphans") -- needs_deleteall's queryset delete
# (gfadmin/views.py:422) bypasses FoodbankChange's own cascade, so some
# FoodbankChangeTranslation rows reference a need_id that no longer
# exists; loading those would be harmless (no FK, never looked up since
# only live latest_need_id values are queried) but is needless bytes and
# diverges from the documented approach for no reason to.
TRANSLATION_TABLES = [
    ("givefood_foodbankchangetranslation", "foodbankchangetranslation", [
        'id', 'need_id', 'foodbank_id', 'language', 'change_text', 'excess_change_text',
    ], {
        "select_cols": ['t.id', 't.need_id', 't.foodbank_id', 't.language', 't.change_text', 't.excess_change_text'],
        "from_table": "givefood_foodbankchangetranslation t JOIN givefood_foodbankchange c ON c.id = t.need_id",
        "where": "t.language IN ('cy', 'ga', 'gd')",
        "order_by": "t.id",
    }),
]


# /aac/ (PLAN.md §4.8.6-§4.8.7): the Place and Postcode gazetteers.
# name_upper is computed BY POSTGRES here, not derived from `cols` like
# every other table -- it must be Postgres's own UPPER(name) output, never
# recomputed by D1's ASCII-only upper() at query time (§4.8.6b). postcode
# loads only the three columns any production code path reads
# (postcode_normalized/lat_lng/county, §4.8.7's "Trimmed" option); the
# migration's `postcode` column is D1-generated, not selected here at all.
GEO_TABLES = [
    ("givefood_place", "place", [
        'id', 'gbpnid', 'name', 'name_upper', 'lat_lng', 'county', 'county_slug',
        'name_slug', 'population',
    ], {
        "select_cols": [
            'id', 'gbpnid', 'name', 'upper(name) AS name_upper', 'lat_lng', 'county',
            'county_slug', 'name_slug', 'population',
        ],
    }),
    ("givefood_postcode", "postcode", [
        'id', 'pcn', 'lat_lng', 'county',
    ], {
        "select_cols": ['id', 'postcode_normalized AS pcn', 'lat_lng', 'county'],
    }),
]


def load_env(path):
    env = {}
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
    return env


def load_wrangler_oauth_token():
    with open(WRANGLER_CONFIG_PATH, "rb") as f:
        config = tomllib.load(f)
    token = config.get("oauth_token")
    if not token:
        raise SystemExit(
            "No OAuth token in %s -- run `wrangler login` first." % WRANGLER_CONFIG_PATH
        )
    return token


def to_param(value, is_uuid_column=False):
    """JSON-safe bound-parameter value, per PLAN.md §4.4's type-mapping rules."""
    if value is None:
        return None
    if isinstance(value, bool):
        return 1 if value else 0
    if is_uuid_column:
        return str(value).replace("-", "").lower()
    if isinstance(value, uuid.UUID):
        return str(value).replace("-", "").lower()
    if isinstance(value, datetime.datetime):
        # Normalise to UTC, always 6 fractional digits -- the exact
        # silent-corruption trap PLAN.md §4.4 names: naive formatting trims
        # trailing fractional zeros, and a truncated .377 vs .377000
        # mismatch turns an API field wrong with no error.
        utc = value.astimezone(datetime.timezone.utc)
        return utc.strftime("%Y-%m-%d %H:%M:%S.%f")
    if isinstance(value, datetime.date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, decimal.Decimal):
        return int(value)
    return value  # int, float, str all JSON-safe as-is


class TokenBox:
    """Holds the OAuth token, reloadable from disk. wrangler refreshes its
    own token file periodically; a long run (the original one-row-per-call
    version took 15-20 minutes on the two largest tables) can outlive a
    token snapshot taken at startup, which is exactly what failed with a
    403 partway through foodbanklocation the first time this ran. Threads
    share one box and reload together on the first 401/403 any of them see,
    rather than each independently re-reading the file on every call."""

    def __init__(self):
        self._token = load_wrangler_oauth_token()
        self._lock = threading.Lock()

    def get(self):
        with self._lock:
            return self._token

    def refresh(self):
        with self._lock:
            self._token = load_wrangler_oauth_token()
            return self._token


def d1_query(token_box, sql, params=None, _retried=False, _network_retries=0):
    url = "https://api.cloudflare.com/client/v4/accounts/%s/d1/database/%s/query" % (
        ACCOUNT_ID, DATABASE_ID,
    )
    body = {"sql": sql}
    if params is not None:
        body["params"] = params
    token = token_box.get()
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": "Bearer %s" % token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code in (401, 403) and not _retried:
            token_box.refresh()
            return d1_query(token_box, sql, params, _retried=True, _network_retries=_network_retries)
        body_text = e.read().decode()
        # D1's own "internal error" (code 7500) is a documented-transient
        # platform hiccup, not a request problem -- seen here under this
        # script's 8-way concurrent load on a 17k-row table (the original
        # 168-row featured-only copy never hit it). Retry it exactly like a
        # network error rather than failing the whole run on one flaky call.
        if e.code == 500 and "7500" in body_text and _network_retries < MAX_NETWORK_RETRIES:
            delay = NETWORK_RETRY_BASE_DELAY * (2 ** _network_retries) + random.uniform(0, 1)
            time.sleep(delay)
            return d1_query(token_box, sql, params, _retried=_retried, _network_retries=_network_retries + 1)
        raise RuntimeError("D1 API error %s: %s" % (e.code, body_text))
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        if _network_retries >= MAX_NETWORK_RETRIES:
            raise
        delay = NETWORK_RETRY_BASE_DELAY * (2 ** _network_retries) + random.uniform(0, 1)
        time.sleep(delay)
        return d1_query(token_box, sql, params, _retried=_retried, _network_retries=_network_retries + 1)


def make_batches(rows, uuid_flags):
    """Group rows into (params_list, row_count) batches under the row/param/
    byte caps. A single row that alone exceeds a cap still gets its own
    batch rather than being split or dropped -- correctness never depends
    on the caps being right, only throughput does."""
    n_cols = len(uuid_flags)
    batch = []
    batch_bytes = 0

    for row in rows:
        row_params = [to_param(v, f) for v, f in zip(row, uuid_flags)]
        row_bytes = sum(len(str(p)) for p in row_params if p is not None)

        if batch and (
            len(batch) >= MAX_ROWS_PER_BATCH
            or (len(batch) + 1) * n_cols > MAX_PARAMS_PER_BATCH
            or batch_bytes + row_bytes > MAX_BYTES_PER_BATCH
        ):
            yield batch
            batch = []
            batch_bytes = 0

        batch.append(row_params)
        batch_bytes += row_bytes

    if batch:
        yield batch


def load_table(token_box, pg_table, d1_table, cols, cur, where=None, select_cols=None, order_by="id",
                from_table=None):
    uuid_cols = UUID_COLUMNS[d1_table]
    uuid_flags = [c in uuid_cols for c in cols]
    col_list = ", ".join(cols)
    # select_cols lets a column be aliased on the Postgres side (e.g.
    # foodbankchangeline's `group` -- a SQL reserved word there too, so the
    # D1 schema calls it group_name; `SELECT group AS group_name` is what
    # bridges the two names) without cols (the D1-side INSERT column list)
    # needing to match Postgres's own naming. from_table overrides pg_table
    # in the FROM clause for "order" -- also a Postgres reserved word,
    # needing to stay quoted there even though pg_table itself (used for
    # logging) doesn't.
    select_col_list = ", ".join(select_cols) if select_cols else col_list

    query = "SELECT %s FROM %s" % (select_col_list, from_table or pg_table)
    if where:
        query += " WHERE %s" % where
    query += " ORDER BY %s" % order_by
    cur.execute(query)
    rows = cur.fetchall()

    batches = list(make_batches(rows, uuid_flags))
    row_placeholders = "(" + ", ".join(["?"] * len(cols)) + ")"

    def send(batch):
        values_sql = ", ".join([row_placeholders] * len(batch))
        sql = "INSERT OR REPLACE INTO %s (%s) VALUES %s" % (d1_table, col_list, values_sql)
        flat_params = [p for row_params in batch for p in row_params]
        result = d1_query(token_box, sql, flat_params)
        if not result.get("success"):
            raise RuntimeError("batch failed on %s: %s" % (d1_table, result))
        return len(batch)

    loaded = 0
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = [pool.submit(send, b) for b in batches]
        for future in as_completed(futures):
            loaded += future.result()  # raises immediately if any batch failed

    return loaded, len(rows)


# get_site_stats() (givefood/utils/cache.py:81-133) reproduced as one
# aggregate query rather than copying Foodbank/FoodbankLocation a second
# time (already fully mirrored by TABLES above) or modelling Order/
# OrderLine/OrderItem/OrderGroup just for one SUM. `"order"` is Postgres's
# own reserved word too, hence the quoting.
SITE_STATS_SQL = """
SELECT
  (SELECT COUNT(*) FROM givefood_foodbank) +
  (SELECT COUNT(*) FROM givefood_foodbank WHERE delivery_address IS NOT NULL AND delivery_address != '') +
  (SELECT COUNT(*) FROM givefood_foodbanklocation) AS foodbanks,
  (SELECT COUNT(*) FROM givefood_foodbankdonationpoint) +
  (SELECT COUNT(*) FROM givefood_foodbank WHERE address_is_administrative = false) +
  (SELECT COUNT(*) FROM givefood_foodbank WHERE delivery_address IS NOT NULL AND delivery_address != '') +
  (SELECT COUNT(*) FROM givefood_foodbanklocation WHERE is_donation_point = true) AS donationpoints,
  (SELECT COUNT(*) FROM givefood_foodbankchangeline) AS items,
  (SELECT COALESCE(SUM(calories), 0) FROM "givefood_order") AS calories
"""


def load_site_stats(token_box, cur):
    cur.execute(SITE_STATS_SQL)
    foodbanks, donationpoints, items, calories = cur.fetchone()
    meals = int(calories / 500)
    computed_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")
    sql = (
        "INSERT OR REPLACE INTO site_stats (id, foodbanks, donationpoints, items, meals, computed_at) "
        "VALUES (1, ?, ?, ?, ?, ?)"
    )
    result = d1_query(token_box, sql, [foodbanks, donationpoints, items, meals, computed_at])
    if not result.get("success"):
        raise RuntimeError("site_stats load failed: %s" % result)
    return foodbanks, donationpoints, items, meals


# place_fts is an external-content FTS5 table (content='place'), so it is
# never written directly by the INSERT OR REPLACE loop above -- it must be
# told to resync against `place` explicitly. The 'rebuild' special command
# does that in one statement (SQLite FTS5 docs, "The rebuild command").
def rebuild_place_fts(token_box):
    result = d1_query(token_box, "INSERT INTO place_fts(place_fts) VALUES('rebuild')")
    if not result.get("success"):
        raise RuntimeError("place_fts rebuild failed: %s" % result)


def run_table_list(token_box, table_list, cur):
    total_loaded = 0
    for entry in table_list:
        pg_table, d1_table, cols = entry[0], entry[1], entry[2]
        kwargs = entry[3] if len(entry) > 3 else {}
        table_start = time.monotonic()
        loaded, total = load_table(token_box, pg_table, d1_table, cols, cur, **kwargs)
        total_loaded += loaded
        elapsed = time.monotonic() - table_start
        print("%s: loaded %d/%d rows (%.1fs)" % (d1_table, loaded, total, elapsed), flush=True)
    return total_loaded


def main():
    import psycopg2  # deferred: only needed for this one-off script, not a repo dependency

    # `dashboards`/`translations`/`geo`: one-time snapshots (DASHBOARD_TABLES /
    # TRANSLATION_TABLES / GEO_TABLES) only -- skip the slow original
    # 5-table + homepage copy, which none of them needs re-run for.
    mode = sys.argv[1] if len(sys.argv) > 1 else None

    token_box = TokenBox()
    env = load_env(FOODCHARITY_ENV_PATH)
    conn = psycopg2.connect(
        host=env["DB_HOST"], dbname=env["DB_NAME"],
        user=env["DB_USER"], password=env["DB_PASS"],
        port=5432, options="-c default_transaction_read_only=on -c statement_timeout=120000",
    )
    cur = conn.cursor()

    t0 = time.monotonic()

    if mode == "dashboards":
        total_loaded = run_table_list(token_box, DASHBOARD_TABLES, cur)
    elif mode == "translations":
        total_loaded = run_table_list(token_box, TRANSLATION_TABLES, cur)
    elif mode == "geo":
        total_loaded = run_table_list(token_box, GEO_TABLES, cur)
        print("place_fts: rebuilding...", flush=True)
        rebuild_place_fts(token_box)
    else:
        total_loaded = run_table_list(token_box, TABLES, cur)
        total_loaded += run_table_list(token_box, HOMEPAGE_TABLES, cur)
        stats = load_site_stats(token_box, cur)
        print("site_stats: foodbanks=%d donationpoints=%d items=%d meals=%d" % stats, flush=True)

    cur.close()
    conn.close()
    print("\nTotal rows loaded: %d (%.1fs)" % (total_loaded, time.monotonic() - t0))


if __name__ == "__main__":
    main()
