import type { Session } from "./types";

// WP 6.6: gfadmin/views.py:1364 foodbank_delete -- Foodbank.delete()
// (givefood/models/foodbank.py:598-623) manually cascades to every child
// table, because every FK into Foodbank uses on_delete=models.DO_NOTHING
// (PLAN.md §4.5's no-FK-constraints convention means D1 wouldn't cascade
// automatically either way, matching Django's own choice here). Orders
// are unassigned (foodbank_id -> NULL), not deleted, matching Django's
// `Order.objects.filter(foodbank=self).update(foodbank=None)`.
// WebPushSubscription/MobileSubscriber/WhatsappSubscriber are NOT
// cleaned up -- confirmed (WP 6.6 research) Django's own delete()
// doesn't touch them either, an existing orphaned-row gap this port
// matches rather than silently fixes. One D1 batch (atomic), not 11
// sequential round trips.
export async function deleteFoodbankCascade(session: Session, foodbankId: number): Promise<void> {
  await session.batch([
    session.prepare("DELETE FROM foodbankhit WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("DELETE FROM foodbankchangeline WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("DELETE FROM foodbankchange WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("DELETE FROM foodbanklocation WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("DELETE FROM foodbankarticle WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("DELETE FROM foodbanksubscriber WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("DELETE FROM foodbankdonationpoint WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("DELETE FROM foodbankdiscrepancy WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("DELETE FROM charityyear WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("DELETE FROM crawlitem WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("UPDATE orders SET foodbank_id = NULL WHERE foodbank_id = ?").bind(foodbankId),
    session.prepare("DELETE FROM foodbank WHERE id = ?").bind(foodbankId),
  ]);
}

// gfadmin/views.py:1300-1310 foodbank_touch -- bumps `edited` only
// (`do_geoupdate=False`), no other field changes.
export async function touchFoodbank(session: Session, id: number): Promise<void> {
  const now = new Date().toISOString();
  await session.prepare("UPDATE foodbank SET edited = ?, modified = ? WHERE id = ?").bind(now, now, id).run();
}

export interface FoodbankAdminTotals {
  needs: number;
  orders: number;
  donationPoints: number;
  articles: number;
  crawls: number;
  emailSubscribers: number;
  webpushSubscribers: number;
  mobileSubscribers: number;
  totalWeightGrams: number;
  totalCostPence: number;
  totalItems: number;
}

// gfadmin/views.py:553-570 foodbank_totals() -- "every tab count and order
// total, in one query" (Django's own framing, via one annotate() call
// compiling to correlated subqueries). No whatsappsubscriber D1 table
// exists yet (same gap WP 6.4/6.9 already disclosed), so that count is
// simply never added in here rather than queried against a table that
// doesn't exist. SUM()s come back NULL from SQLite when there are zero
// matching rows -- coalesced to 0 to match Django's Sum() default of 0.
export async function getFoodbankAdminTotals(session: Session, foodbankId: number): Promise<FoodbankAdminTotals> {
  const row = await session
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM foodbankchange WHERE foodbank_id = ?1) AS needs,
        (SELECT COUNT(*) FROM orders WHERE foodbank_id = ?1) AS orders,
        (SELECT COUNT(*) FROM foodbankdonationpoint WHERE foodbank_id = ?1) AS donation_points,
        (SELECT COUNT(*) FROM foodbankarticle WHERE foodbank_id = ?1) AS articles,
        (SELECT COUNT(*) FROM crawlitem WHERE foodbank_id = ?1) AS crawls,
        (SELECT COUNT(*) FROM foodbanksubscriber WHERE foodbank_id = ?1) AS email_subscribers,
        (SELECT COUNT(*) FROM webpushsubscription WHERE foodbank_id = ?1) AS webpush_subscribers,
        (SELECT COUNT(*) FROM mobilesubscriber WHERE foodbank_id = ?1) AS mobile_subscribers,
        (SELECT COALESCE(SUM(weight), 0) FROM orders WHERE foodbank_id = ?1) AS total_weight,
        (SELECT COALESCE(SUM(cost), 0) FROM orders WHERE foodbank_id = ?1) AS total_cost,
        (SELECT COALESCE(SUM(no_items), 0) FROM orders WHERE foodbank_id = ?1) AS total_items`,
    )
    .bind(foodbankId)
    .first<{
      needs: number;
      orders: number;
      donation_points: number;
      articles: number;
      crawls: number;
      email_subscribers: number;
      webpush_subscribers: number;
      mobile_subscribers: number;
      total_weight: number;
      total_cost: number;
      total_items: number;
    }>();

  return {
    needs: row?.needs ?? 0,
    orders: row?.orders ?? 0,
    donationPoints: row?.donation_points ?? 0,
    articles: row?.articles ?? 0,
    crawls: row?.crawls ?? 0,
    emailSubscribers: row?.email_subscribers ?? 0,
    webpushSubscribers: row?.webpush_subscribers ?? 0,
    mobileSubscribers: row?.mobile_subscribers ?? 0,
    totalWeightGrams: row?.total_weight ?? 0,
    totalCostPence: row?.total_cost ?? 0,
    totalItems: row?.total_items ?? 0,
  };
}

const COMBINING_MARKS_RE = new RegExp(`[${String.fromCodePoint(0x0300)}-${String.fromCodePoint(0x036f)}]`, "g");

function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .replace(/[^\x00-\x7F]/g, "");
  return ascii
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

// Same helper (and same null-when-not-finite contract) as
// locationsAdmin.ts:37-42 / donationPointsAdmin.ts -- Foodbank.save()
// (givefood/models/foodbank.py:636-638) splits `lat_lng` into
// `latitude`/`longitude` on EVERY save, create and edit alike, and those
// two columns are what every distance query actually reads
// (0001_core.sql:55's `foodbank_open_latlng_idx`, feeding
// getOpenFoodbankCoordinates -> the /needs/ postcode search and every
// "nearby" API list). Leaving them behind makes a corrected pin silently
// keep its old position and a brand-new food bank invisible to search.
function parseLatLng(latLng: string): { latitude: number | null; longitude: number | null } {
  const [latStr, lngStr] = latLng.split(",");
  const latitude = latStr ? Number.parseFloat(latStr) : NaN;
  const longitude = lngStr ? Number.parseFloat(lngStr) : NaN;
  return { latitude: Number.isFinite(latitude) ? latitude : null, longitude: Number.isFinite(longitude) ? longitude : null };
}

// gfadmin/views.py:817-858 foodbank_form's create branch (`slug=None`).
// Every FOODBANK_FIELD_ORDER field is caller-supplied (lib/
// adminFormFields.ts's FOODBANK_FIELDS already required-validates the
// non-nullable ones); the handful of columns outside that list that are
// still NOT NULL in D1 (`uuid`, `slug`, `no_locations`,
// `days_between_needs`, `created`, `modified`) get sane new-row defaults
// here, matching what Foodbank's own Django defaults/save() would give a
// freshly created row before any locations/needs exist. `slug`,
// `latitude` and `longitude` are the three DERIVED columns Foodbank.save()
// (foodbank.py:634-638) computes rather than defaults -- see parseLatLng
// above for why the latter two are not optional.
export async function insertFoodbank(session: Session, fields: Record<string, string | number | null>): Promise<{ id: number; slug: string }> {
  const name = fields.name;
  if (typeof name !== "string" || !name) throw new Error("name is required to create a food bank");
  const slug = slugify(name);
  const { latitude, longitude } = parseLatLng(typeof fields.lat_lng === "string" ? fields.lat_lng : "");
  const now = new Date().toISOString();

  const entries = Object.entries(fields);
  const columns = ["uuid", "slug", "latitude", "longitude", "no_locations", "days_between_needs", "created", "modified", ...entries.map(([k]) => k)];
  const placeholders = columns.map(() => "?").join(", ");
  const values: (string | number | null)[] = [crypto.randomUUID().replace(/-/g, ""), slug, latitude, longitude, 0, 0, now, now, ...entries.map(([, v]) => v)];

  const result = await session
    .prepare(`INSERT INTO foodbank (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`)
    .bind(...values)
    .first<{ id: number }>();
  return { id: result!.id, slug };
}

// WP 6.5: the admin's Foodbank edit forms' own write path -- separate
// from foodbank.ts (the public API read path). `fields` keys are always
// built by the caller from a fixed AdminFieldSpec list
// (lib/adminFormFields.ts), never raw request-body keys, so the column
// names interpolated into the SET clause are never attacker-controlled --
// the assertion below is a cheap backstop against a future caller
// forgetting that, not the actual safety boundary.
const COLUMN_NAME_RE = /^[a-z_]+$/;

// `stampEdited` mirrors forms.py's inconsistency exactly (WP 6.5
// research + maintainer decision): the full FoodbankForm and all 4
// collapsed partials stamp `edited`, FoodbankPoliticsForm deliberately
// does not -- preserved verbatim rather than "fixed", since the
// maintainer chose to match Django's behaviour here, not WP 6.3/6.4's
// usual "fix the defect" default. `modified` (TimestampedModel's
// auto_now) always updates regardless -- that one was never form-gated
// in Django either.
//
// Returns the row's slug when this write changed it (i.e. the name was
// The Foodbank fields every location, donation point, article, need,
// discrepancy and subscriber keeps its own copy of. Django calls this block
// "Cache foodbank details" (models/foodbank.py:948-954, :1292-1296) -- an
// artifact of the site's original no-SQL datastore, where there were no
// joins to make.
//
// Django refreshes the copy only in the CHILD's save(); Foodbank.save()
// does not cascade. So renaming a food bank there strands every child on
// the old value until each is next saved by hand -- and because
// getDonationPointBySlugs and Django's own equivalent FIND a child by its
// cached foodbank_slug, a stale copy 404s the child's real page. That is
// not theoretical: 20 donation points and 4 locations were in exactly that
// state, found via a photo URL no page could satisfy.
//
// tools/pg-to-d1/extract_core.py repairs this at load time, but there is no
// nightly ETL after cutover, so a rename in production would 404 real pages
// until someone ran it by hand. This closes it at the source instead.
//
// DERIVED BY SUBQUERY, not bound from `fields`: the admin's partial forms
// post a subset (the Address form sends lat_lng and no name), so reading
// the parent row back is the only thing that is right for every caller.
const FOODBANK_CACHE_CASCADE: readonly { table: string; columns: readonly (readonly [string, string])[] }[] = [
  { table: "foodbanklocation", columns: [
    ["foodbank_name", "name"], ["foodbank_slug", "slug"], ["foodbank_network", "network"],
    ["foodbank_phone_number", "phone_number"], ["foodbank_email", "contact_email"], ["is_closed", "is_closed"],
  ] },
  { table: "foodbankdonationpoint", columns: [
    ["foodbank_name", "name"], ["foodbank_slug", "slug"], ["foodbank_network", "network"], ["is_closed", "is_closed"],
  ] },
  { table: "foodbankarticle", columns: [["foodbank_name", "name"]] },
  { table: "foodbankchange", columns: [["foodbank_name", "name"]] },
  { table: "foodbankdiscrepancy", columns: [["foodbank_name", "name"]] },
  { table: "foodbanksubscriber", columns: [["foodbank_name", "name"]] },
];

// The parent columns above. A save that touches none of them cannot have
// invalidated any child, so it skips the cascade entirely -- `name` is in
// the list because slug is derived from it.
const CASCADING_FIELDS = ["name", "network", "phone_number", "contact_email", "is_closed"];

export async function cascadeFoodbankCache(session: Session, foodbankId: number): Promise<void> {
  await session.batch(
    FOODBANK_CACHE_CASCADE.map(({ table, columns }) =>
      session
        .prepare(
          `UPDATE ${table} SET ` +
            columns
              .map(([child, parent]) => `${child} = (SELECT p.${parent} FROM foodbank p WHERE p.id = ${table}.foodbank_id)`)
              .join(", ") +
            ` WHERE foodbank_id = ?1`,
        )
        .bind(foodbankId),
    ),
  );
}

// part of `fields`), otherwise null -- callers redirect to
// `admin:foodbank` with the slug the record now has, exactly as
// gfadmin/views.py:836 does with the post-save `foodbank.slug`.
export async function updateFoodbankFields(session: Session, id: number, fields: Record<string, string | number | null>, stampEdited: boolean): Promise<string | null> {
  const entries = Object.entries(fields);
  for (const [name] of entries) {
    if (!COLUMN_NAME_RE.test(name)) throw new Error(`refusing to update unexpected column: ${name}`);
  }
  const now = new Date().toISOString();
  const setSql = entries.map(([name]) => `${name} = ?`).join(", ");
  const values = entries.map(([, v]) => v);

  // givefood/models/foodbank.py:634-638 -- Foodbank.save() re-derives
  // `slug` from `name` and splits `lat_lng` into `latitude`/`longitude`
  // on every save, so an edit must too (PLAN.md:3414 records the same
  // rule: "Sync, in the write function"). Appended to the tail rather
  // than to `entries` so the COLUMN_NAME_RE guard and the caller
  // contract -- `fields` is only ever the form's own AdminFieldSpec
  // names -- stay untouched. The partial forms post a subset, so each
  // derivation is gated on its own source field actually being present:
  // the Address form posts lat_lng but no name, the Phone form neither.
  const derivedSql: string[] = [];
  const derivedValues: (string | number | null)[] = [];
  if (typeof fields.lat_lng === "string" && fields.lat_lng) {
    const { latitude, longitude } = parseLatLng(fields.lat_lng);
    derivedSql.push("latitude = ?", "longitude = ?");
    derivedValues.push(latitude, longitude);
  }
  let newSlug: string | null = null;
  if (typeof fields.name === "string" && fields.name) {
    newSlug = slugify(fields.name);
    derivedSql.push("slug = ?");
    derivedValues.push(newSlug);
  }

  const tailSql = stampEdited ? "modified = ?, edited = ?" : "modified = ?";
  const tailValues = stampEdited ? [now, now] : [now];
  await session
    .prepare(`UPDATE foodbank SET ${[setSql, ...derivedSql, tailSql].filter(Boolean).join(", ")} WHERE id = ?`)
    .bind(...values, ...derivedValues, ...tailValues, id)
    .run();

  // AFTER the parent UPDATE, so the subqueries read the new values.
  if (entries.some(([name]) => CASCADING_FIELDS.includes(name))) {
    await cascadeFoodbankCache(session, id);
  }

  return newSlug;
}
