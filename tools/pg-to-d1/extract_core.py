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


def d1_query(token_box, sql, params=None, _retried=False):
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
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code in (401, 403) and not _retried:
            token_box.refresh()
            return d1_query(token_box, sql, params, _retried=True)
        raise RuntimeError("D1 API error %s: %s" % (e.code, e.read().decode()))


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


def load_table(token_box, pg_table, d1_table, cols, cur):
    uuid_cols = UUID_COLUMNS[d1_table]
    uuid_flags = [c in uuid_cols for c in cols]
    col_list = ", ".join(cols)

    cur.execute("SELECT %s FROM %s ORDER BY id" % (col_list, pg_table))
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


def main():
    import psycopg2  # deferred: only needed for this one-off script, not a repo dependency

    token_box = TokenBox()
    env = load_env(FOODCHARITY_ENV_PATH)
    conn = psycopg2.connect(
        host=env["DB_HOST"], dbname=env["DB_NAME"],
        user=env["DB_USER"], password=env["DB_PASS"],
        port=5432, options="-c default_transaction_read_only=on -c statement_timeout=120000",
    )
    cur = conn.cursor()

    t0 = time.monotonic()
    total_loaded = 0
    for pg_table, d1_table, cols in TABLES:
        table_start = time.monotonic()
        loaded, total = load_table(token_box, pg_table, d1_table, cols, cur)
        total_loaded += loaded
        elapsed = time.monotonic() - table_start
        print("%s: loaded %d/%d rows (%.1fs)" % (d1_table, loaded, total, elapsed), flush=True)

    cur.close()
    conn.close()
    print("\nTotal rows loaded: %d (%.1fs)" % (total_loaded, time.monotonic() - t0))


if __name__ == "__main__":
    main()
