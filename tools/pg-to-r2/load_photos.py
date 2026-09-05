"""Copy Django's PlacePhoto blobs from Postgres into R2, and their metadata
into D1's `placephoto` table.

    uv run --with psycopg2-binary python tools/pg-to-r2/load_photos.py [--limit N] [--dry-run]

WHY THIS EXISTS. Django stores every food bank / location / donation point
photo as a `bytea` in `givefood_placephoto.blob` -- 7,122 rows, 1.70 GB,
avg 245 kB, no empty blobs. It fetched each one from Google Places exactly
once (givefood/utils/geo.py:107 photo_from_place_id, which is a
`.get(place_id=...)` first and an API call only on a miss) and has served
it from Postgres ever since.

The port serves photos from R2, keyed by URL path, and nothing had ever put
one there: workers/jobs/src/queues/jobs.ts's handleMediaBackfill() only
implements the Static Maps family, so every photo.jpg on beta 404'd. The
alternative to this script was letting that consumer fill R2 lazily from
Google -- which would re-buy 7,122 photos we already own, one paid pair of
Place Details + Place Photo calls at a time. Both are being done: this
script for the 7,122 that exist, the consumer for places that appear later.

R2 UPLOADS GO THROUGH THE CLOUDFLARE REST API, not S3. R2's object API is
`PUT /accounts/<id>/r2/buckets/<bucket>/objects/<key>` and it accepts the
same wrangler OAuth token extract_core.py already uses for D1, so this
needs no new credentials and no R2 access key. (`wrangler r2 object put`
would also work and needs no token handling at all, but it is one node
process per object -- hours for 7,122.)

310 PHOTOS ARE ORPHANS. Their place_id matches no current food bank,
location or donation point, so no URL resolves to them and there is no key
to store them under. They are counted and skipped, not an error.
"""

import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pg-to-d1"))

from extract_core import (  # noqa: E402
    ACCOUNT_ID,
    FOODCHARITY_ENV_PATH,
    MAX_NETWORK_RETRIES,
    NETWORK_RETRY_BASE_DELAY,
    TokenBox,
    d1_query,
    load_env,
)

BUCKET = "givefood-media"


class WranglerTokenBox(TokenBox):
    """extract_core's TokenBox re-reads wrangler's token file on a 401. That
    only helps if wrangler has since rewritten the file -- and it rewrites it
    when wrangler runs, not on a timer. A 401 mid-run therefore re-reads the
    same expired token and fails again.

    Found the hard way: an expired token turned every upload into a 401, and
    the burst of failed auth attempts then earned a stretch of R2 API 429s
    ("Rate limited. Please wait and consider throttling your request speed")
    that looked like a throughput problem and was not. With a live token,
    12 threads sustain ~11 uploads/s with no 429 at all.

    So refresh by actually running wrangler, which performs the OAuth refresh
    and rewrites the file, then re-read it."""

    def refresh(self):
        subprocess.run(
            ["npx", "wrangler", "whoami"],
            cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "workers", "site"),
            capture_output=True, check=False, timeout=120,
        )
        return super().refresh()

# Threads for the R2 PUTs. extract_core.py settled on 8 for D1 and hit D1's
# own transient 7500s above that; R2 object writes are independent of each
# other and of D1, so this is bounded by upstream bandwidth rather than by
# anything server-side. 12 moves ~1.7 GB in a few minutes.
UPLOAD_THREADS = 12

# Rows per D1 INSERT. NOT tuned for throughput -- D1 caps a statement at 100
# bound parameters (extract_core.py:63-75 learned that the same way this did,
# with "too many SQL variables at offset ...: SQLITE_ERROR" on the first
# flush of a 200-row batch). 9 columns per row, so 11 rows is 99 parameters.
D1_BATCH_ROWS = 11

# api.cloudflare.com rate-limits per account across every endpoint, so the
# R2 uploads and the D1 inserts share one budget -- see Throttle below for
# how that was discovered. 6,812 photos plus ~620 metadata inserts is ~7,400
# requests, so this is roughly a 15-minute run.
RATE_LIMIT_PER_SEC = 8.0
RATE_LIMIT_RETRIES = 6
RATE_LIMIT_BACKOFF = 20.0  # seconds, multiplied by the attempt number

# The three URL shapes gfwfbn/urls/generic.py:12-17 registers, and therefore
# the three R2 keys routes/media.ts derives ("media" + url.pathname). Both
# child tables carry a denormalised foodbank_slug, so none of these needs to
# join back to givefood_foodbank.
QUERIES = [
    (
        "foodbank",
        """
        SELECT pp.id, pp.place_id, pp.photo_ref, pp.html_attributions,
               pp.created, pp.modified, pp.blob,
               'media/needs/at/' || f.slug || '/photo.jpg'
          FROM givefood_placephoto pp
          JOIN givefood_foodbank f ON f.place_id = pp.place_id
         ORDER BY pp.id
        """,
    ),
    (
        "location",
        """
        SELECT pp.id, pp.place_id, pp.photo_ref, pp.html_attributions,
               pp.created, pp.modified, pp.blob,
               'media/needs/at/' || l.foodbank_slug || '/' || l.slug || '/photo.jpg'
          FROM givefood_placephoto pp
          JOIN givefood_foodbanklocation l ON l.place_id = pp.place_id
         ORDER BY pp.id
        """,
    ),
    (
        "donationpoint",
        """
        SELECT pp.id, pp.place_id, pp.photo_ref, pp.html_attributions,
               pp.created, pp.modified, pp.blob,
               'media/needs/at/' || d.foodbank_slug || '/donationpoint/' || d.slug || '/photo.jpg'
          FROM givefood_placephoto pp
          JOIN givefood_foodbankdonationpoint d ON d.place_id = pp.place_id
         ORDER BY pp.id
        """,
    ),
]


class Throttle:
    """One token bucket across BOTH the R2 uploads and the D1 inserts.

    They are not separate budgets: R2 objects and D1 queries are the same
    api.cloudflare.com, and its per-account rate limit counts them together.
    Running 12 upload threads flat out plus a D1 insert every 11 photos
    sailed past it and the run died on
    `429 {"code":971,"message":"Please wait and consider throttling your
    request speed"}` -- from D1, though R2 had been answering the same way
    earlier for the same reason.

    RATE is deliberately below what a burst achieves (36 uploads went
    through at 11/s quite happily). Bursts are not the constraint; the
    5-minute window is."""

    def __init__(self, rate):
        self.min_interval = 1.0 / rate
        self.next_at = 0.0
        self.lock = threading.Lock()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            if now < self.next_at:
                delay = self.next_at - now
            else:
                delay = 0.0
                self.next_at = now
            self.next_at += self.min_interval
        if delay:
            time.sleep(delay)


THROTTLE = Throttle(RATE_LIMIT_PER_SEC)


def d1_insert(token_box, sql, params, _retries=0):
    """d1_query with the throttle and 429 handling extract_core's own
    version does not have -- it retries 500/7500 and network errors but
    treats 429 as fatal, which is what ended the first full run."""
    THROTTLE.wait()
    try:
        return d1_query(token_box, sql, params)
    except RuntimeError as exc:
        if "429" in str(exc) and _retries < RATE_LIMIT_RETRIES:
            time.sleep(RATE_LIMIT_BACKOFF * (_retries + 1))
            return d1_insert(token_box, sql, params, _retries + 1)
        raise


def already_loaded_ids(token_box):
    """placephoto.id is Django's own givefood_placephoto.id, so a re-run can
    skip every photo already in D1 without a HEAD per object -- which would
    double the request count this script is trying to stay under."""
    loaded = set()
    offset = 0
    while True:
        THROTTLE.wait()
        resp = d1_query(
            token_box, "SELECT id FROM placephoto ORDER BY id LIMIT 5000 OFFSET ?", [offset]
        )
        rows = resp["result"][0]["results"]
        loaded.update(r["id"] for r in rows)
        if len(rows) < 5000:
            return loaded
        offset += 5000


def r2_put(token_box, key, body, content_type, _retried=False, _network_retries=0):
    """PUT one object. Mirrors d1_query's retry policy: one token refresh on
    401/403 (wrangler rotates its token and a long run outlives a snapshot),
    exponential backoff on network errors and 5xx."""
    url = "https://api.cloudflare.com/client/v4/accounts/%s/r2/buckets/%s/objects/%s" % (
        ACCOUNT_ID, BUCKET, urllib.parse.quote(key),
    )
    req = urllib.request.Request(
        url, data=body, method="PUT",
        headers={"Authorization": "Bearer %s" % token_box.get(), "Content-Type": content_type},
    )
    THROTTLE.wait()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = json.loads(resp.read())
        if not payload.get("success"):
            raise RuntimeError("R2 API rejected %s: %s" % (key, payload.get("errors")))
        return payload["result"]
    except urllib.error.HTTPError as e:
        if e.code in (401, 403) and not _retried:
            token_box.refresh()
            return r2_put(token_box, key, body, content_type, True, _network_retries)
        if e.code == 429 and _network_retries < RATE_LIMIT_RETRIES:
            time.sleep(RATE_LIMIT_BACKOFF * (_network_retries + 1))
            return r2_put(token_box, key, body, content_type, _retried, _network_retries + 1)
        if e.code >= 500 and _network_retries < MAX_NETWORK_RETRIES:
            time.sleep(NETWORK_RETRY_BASE_DELAY * (2 ** _network_retries))
            return r2_put(token_box, key, body, content_type, _retried, _network_retries + 1)
        raise RuntimeError("R2 API error %s on %s: %s" % (e.code, key, e.read().decode()[:400]))
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        if _network_retries >= MAX_NETWORK_RETRIES:
            raise
        time.sleep(NETWORK_RETRY_BASE_DELAY * (2 ** _network_retries))
        return r2_put(token_box, key, body, content_type, _retried, _network_retries + 1)


def insert_d1_rows(token_box, rows):
    """One multi-row INSERT. `INSERT OR REPLACE` because a re-run must be
    idempotent -- the R2 PUT already is (same key, same bytes) and the D1
    side has to match, or the second run dies on placephoto_place_id_uniq."""
    if not rows:
        return
    placeholders = ", ".join(["(?, ?, ?, ?, ?, ?, ?, ?, ?)"] * len(rows))
    sql = (
        "INSERT OR REPLACE INTO placephoto "
        "(id, place_id, photo_ref, html_attributions, r2_key, bytes, md5, created, modified) "
        "VALUES " + placeholders
    )
    params = []
    for r in rows:
        params.extend(r)
    resp = d1_insert(token_box, sql, params)
    if not resp.get("success"):
        raise RuntimeError("D1 insert failed: %s" % resp.get("errors"))


def main():
    import psycopg2

    limit = None
    dry_run = "--dry-run" in sys.argv
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    # Force a refresh up front: a run takes ~10 minutes and starting it on a
    # token that is about to expire wastes the whole thing.
    token_box = WranglerTokenBox()
    token_box.refresh()
    env = load_env(FOODCHARITY_ENV_PATH)
    conn = psycopg2.connect(
        host=env["DB_HOST"], dbname=env["DB_NAME"], user=env["DB_USER"], password=env["DB_PASS"],
        port=5432, options="-c default_transaction_read_only=on -c statement_timeout=600000",
    )

    skip_ids = set()
    if not dry_run:
        skip_ids = already_loaded_ids(token_box)
        if skip_ids:
            print("resuming: %d photos already loaded, skipping those" % len(skip_ids), flush=True)

    counts = {"uploaded": 0, "bytes": 0, "failed": 0, "skipped": 0}
    lock = threading.Lock()
    t0 = time.monotonic()

    for kind, sql in QUERIES:
        # A NAMED cursor, so psycopg2 streams from a server-side portal
        # instead of materialising the whole result. The blob column makes
        # this table 1.7 GB; a client-side cursor would pull all of it into
        # memory before the first row came back.
        cur = conn.cursor(name="photos_%s" % kind)
        cur.itersize = 50
        cur.execute(sql + (" LIMIT %d" % limit if limit else ""))

        pending = []
        d1_rows = []

        def upload(row):
            pid, place_id, photo_ref, attribs, created, modified, blob, key = row
            if pid in skip_ids:
                with lock:
                    counts["skipped"] += 1
                return None
            data = bytes(blob)
            if dry_run:
                with lock:
                    counts["uploaded"] += 1
                    counts["bytes"] += len(data)
                return (pid, place_id, photo_ref, attribs or "", key, len(data),
                        hashlib.md5(data).hexdigest(),
                        created.isoformat(sep=" ") if created else None,
                        modified.isoformat(sep=" ") if modified else None)
            try:
                r2_put(token_box, key, data, "image/jpeg")
            except Exception as exc:  # noqa: BLE001 -- one bad object must not end the run
                with lock:
                    counts["failed"] += 1
                print("FAILED %s: %s" % (key, exc), flush=True)
                return None
            with lock:
                counts["uploaded"] += 1
                counts["bytes"] += len(data)
                if counts["uploaded"] % 250 == 0:
                    print("  %d uploaded, %.1f GB, %.0fs"
                          % (counts["uploaded"], counts["bytes"] / 1e9, time.monotonic() - t0),
                          flush=True)
            return (pid, place_id, photo_ref, attribs or "", key, len(data),
                    hashlib.md5(data).hexdigest(),
                    created.isoformat(sep=" ") if created else None,
                    modified.isoformat(sep=" ") if modified else None)

        print("%s photos..." % kind, flush=True)
        with ThreadPoolExecutor(max_workers=UPLOAD_THREADS) as pool:
            # Fed in chunks rather than handed the whole cursor: pool.map on
            # a generator would race ahead and buffer thousands of 245 kB
            # blobs in the executor's work queue, which is the memory problem
            # the server-side cursor exists to avoid.
            while True:
                chunk = cur.fetchmany(UPLOAD_THREADS * 4)
                if not chunk:
                    break
                for result in pool.map(upload, chunk):
                    if result:
                        d1_rows.append(result)
                if len(d1_rows) >= D1_BATCH_ROWS and not dry_run:
                    insert_d1_rows(token_box, d1_rows[:D1_BATCH_ROWS])
                    d1_rows = d1_rows[D1_BATCH_ROWS:]

        if not dry_run:
            while d1_rows:
                insert_d1_rows(token_box, d1_rows[:D1_BATCH_ROWS])
                d1_rows = d1_rows[D1_BATCH_ROWS:]
        cur.close()

    elapsed = time.monotonic() - t0
    print("\n%s: %d photos, %.2f GB, %d skipped (already loaded), %d failed, %.0fs"
          % ("DRY RUN" if dry_run else "DONE", counts["uploaded"], counts["bytes"] / 1e9,
             counts["skipped"], counts["failed"], elapsed), flush=True)

    if not dry_run:
        resp = d1_query(token_box, "SELECT COUNT(*) AS n, SUM(bytes) AS b FROM placephoto")
        row = resp["result"][0]["results"][0]
        print("D1 placephoto: %s rows, %s bytes" % (row["n"], row["b"]))


if __name__ == "__main__":
    main()
