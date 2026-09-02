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

// gfadmin/views.py:817-858 foodbank_form's create branch (`slug=None`).
// Every FOODBANK_FIELD_ORDER field is caller-supplied (lib/
// adminFormFields.ts's FOODBANK_FIELDS already required-validates the
// non-nullable ones); the handful of columns outside that list that are
// still NOT NULL in D1 (`uuid`, `slug`, `no_locations`,
// `days_between_needs`, `created`, `modified`) get sane new-row defaults
// here, matching what Foodbank's own Django defaults/save() would give a
// freshly created row before any locations/needs exist.
export async function insertFoodbank(session: Session, fields: Record<string, string | number | null>): Promise<{ id: number; slug: string }> {
  const name = fields.name;
  if (typeof name !== "string" || !name) throw new Error("name is required to create a food bank");
  const slug = slugify(name);
  const now = new Date().toISOString();

  const entries = Object.entries(fields);
  const columns = ["uuid", "slug", "no_locations", "days_between_needs", "created", "modified", ...entries.map(([k]) => k)];
  const placeholders = columns.map(() => "?").join(", ");
  const values: (string | number | null)[] = [crypto.randomUUID().replace(/-/g, ""), slug, 0, 0, now, now, ...entries.map(([, v]) => v)];

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
export async function updateFoodbankFields(session: Session, id: number, fields: Record<string, string | number | null>, stampEdited: boolean): Promise<void> {
  const entries = Object.entries(fields);
  for (const [name] of entries) {
    if (!COLUMN_NAME_RE.test(name)) throw new Error(`refusing to update unexpected column: ${name}`);
  }
  const now = new Date().toISOString();
  const setSql = entries.map(([name]) => `${name} = ?`).join(", ");
  const values = entries.map(([, v]) => v);
  const tailSql = stampEdited ? "modified = ?, edited = ?" : "modified = ?";
  const tailValues = stampEdited ? [now, now] : [now];
  await session
    .prepare(`UPDATE foodbank SET ${setSql}, ${tailSql} WHERE id = ?`)
    .bind(...values, ...tailValues, id)
    .run();
}
