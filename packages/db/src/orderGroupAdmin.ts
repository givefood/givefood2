import type { Session } from "./types";
import type { PageResult } from "./adminLists";

// gfadmin/views.py:2767-2775 order_groups(), :2778-2807 order_group(),
// :2810-2832 order_group_form() -- OrderGroup's read AND write paths.
// WP 6.5b listed this whole group as blocked on a missing `ordergroup` D1
// table; migrations/0015_ordergroup.sql adds it (and the partial index on
// orders.order_group_id, a column that already existed).
//
// Unlike Order/OrderItem -- still deferred, because Order.save() runs two
// Gemini calls -- OrderGroup's form is a plain ModelForm over four columns
// with no save() side effects beyond re-slugifying the name
// (givefood/models/orders.py:324-327), so the write path is portable
// as-is.

export interface OrderGroupRow {
  id: number;
  name: string;
  slug: string;
  public: number; // 0/1 -- template truthiness works on this directly
  key: string | null;
  created: string;
  modified: string;
}

const ORDER_GROUP_COLUMNS = "id, name, slug, public, key, created, modified";

// gfadmin/views.py:2769 -- `OrderGroup.objects.all().order_by("-created")`.
// Django renders the whole table into one page; paginated here like every
// other list in this phase, see adminLists.ts's own top comment for why
// (D1 meters rows scanned).
export async function getOrderGroupsPage(session: Session, page: number, pageSize: number): Promise<PageResult<OrderGroupRow>> {
  const offset = (page - 1) * pageSize;
  const [countRow, result] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM ordergroup").first<{ n: number }>(),
    session
      .prepare(`SELECT ${ORDER_GROUP_COLUMNS} FROM ordergroup ORDER BY created DESC LIMIT ? OFFSET ?`)
      .bind(pageSize, offset)
      .all<OrderGroupRow>(),
  ]);
  const total = countRow?.n ?? 0;
  return { rows: result.results, total, page, pageSize, hasNext: offset + pageSize < total };
}

// gfadmin/views.py:2780/2812 -- get_object_or_404(OrderGroup, slug=slug).
// Django raises MultipleObjectsReturned (a 500) if two rows share a slug;
// here .first() would just pick one, and migrations/0015's UNIQUE index
// plus upsertOrderGroup's pre-check mean a second one cannot be created.
export async function getOrderGroupBySlug(session: Session, slug: string): Promise<OrderGroupRow | null> {
  return session.prepare(`SELECT ${ORDER_GROUP_COLUMNS} FROM ordergroup WHERE slug = ?`).bind(slug).first<OrderGroupRow>();
}

export interface OrderGroupOrderRow {
  order_id: string;
  foodbank_name: string | null;
  foodbank_slug: string | null;
  delivery_datetime: string;
  no_items: number;
  weight: number; // grams
  calories: number;
  cost: number; // pence
  created: string;
}

// givefood/models/orders.py:321-322 OrderGroup.orders() --
// select_related('foodbank'), order_by("delivery_datetime") ASCENDING, no
// limit. Deliberately unbounded, unlike the list queries above: 1,050
// orders exist in total across all 8 groups, the detail page's six
// aggregate totals are summed from exactly these rows (matching Django's
// own per-row loop at views.py:2790-2795), and a paginated table would
// silently make those totals wrong.
export async function getOrderGroupOrders(session: Session, orderGroupId: number): Promise<OrderGroupOrderRow[]> {
  const result = await session
    .prepare(
      `SELECT o.order_id, f.name AS foodbank_name, f.slug AS foodbank_slug,
              o.delivery_datetime, o.no_items, o.weight, o.calories, o.cost, o.created
       FROM orders o
       LEFT JOIN foodbank f ON f.id = o.foodbank_id
       WHERE o.order_group_id = ?
       ORDER BY o.delivery_datetime`,
    )
    .bind(orderGroupId)
    .all<OrderGroupOrderRow>();
  return result.results;
}

// django.utils.text.slugify, the same 10-line port already in
// parlconAdmin.ts:12-24 and foodbankAdmin.ts:106-118 -- duplicated rather
// than cross-imported, per this repo's existing precedent for small shared
// shapes.
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

export interface UpsertOrderGroupParams {
  name: string;
  public: number; // 0/1
  key: string | null;
}

// givefood/forms.py:225-228 OrderGroupForm (`fields = "__all__"`, a plain
// ModelForm with no save() override) + OrderGroup.save()
// (models/orders.py:324-327: slug = slugify(name) on EVERY save, no
// uniqueness check).
//
// The collision pre-check is this port's fix for that missing check --
// see migrations/0015_ordergroup.sql's own comment for the 500 it
// prevents. Returning a result object rather than throwing so the route
// can render Django's own "the form came back with an error" outcome as a
// 400 instead of a stack trace.
//
// KEPT FOR PARITY, deliberately: renaming a group still re-slugifies it,
// which changes the donor-facing /donate/managed/<slug>-<key>/ URL of a
// public group. Django does exactly this and the admin has always relied
// on it; the form's Name help text now says so out loud rather than the
// behaviour being silent.
export async function upsertOrderGroup(
  session: Session,
  params: UpsertOrderGroupParams,
  existingId: number | undefined,
): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
  const slug = slugify(params.name);
  // slugify() of e.g. "!!!" is the empty string, which would produce a row
  // no URL can ever address. Django stores it happily and 404s forever.
  if (!slug) return { ok: false, error: "Name must contain at least one letter or number" };

  const clash = await session.prepare("SELECT id FROM ordergroup WHERE slug = ?").bind(slug).first<{ id: number }>();
  if (clash && clash.id !== existingId) return { ok: false, error: `An order group with the slug "${slug}" already exists` };

  // TimestampedModel (givefood/models/base.py:12-19): `created` is
  // auto_now_add, `modified` is auto_now.
  const now = new Date().toISOString();
  if (existingId === undefined) {
    await session
      .prepare("INSERT INTO ordergroup (name, slug, public, key, created, modified) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(params.name, slug, params.public, params.key, now, now)
      .run();
  } else {
    await session
      .prepare("UPDATE ordergroup SET name = ?, slug = ?, public = ?, key = ?, modified = ? WHERE id = ?")
      .bind(params.name, slug, params.public, params.key, now, existingId)
      .run();
  }
  return { ok: true, slug };
}
