import type { Session } from "./types";
import type { PageResult } from "./adminLists";

// WP 6.x: givefood/models/orders.py:291-311 OrderItem +
// givefood/forms.py:213-216 OrderItemForm's write path -- a plain ModelForm
// (`fields = "__all__"`, no clean(), no widgets) whose model save()
// (orders.py:305-308) does nothing but `self.slug = slugify(self.name)`.
// Three fields, no timestamps: OrderItem inherits plain models.Model, not
// TimestampedModel, so nothing here ever renders through a date filter.
//
// Both the read (list) and write (form) paths live in this one file rather
// than the list half going in adminLists.ts, because this whole model is
// two screens and ~100 lines -- splitting it across two modules to satisfy
// a filing convention would cost more than it buys.
//
// The local slugify below is copied verbatim from parlconAdmin.ts:12-25 --
// the established convention in this package (foodbankAdmin.ts,
// locationsAdmin.ts, donationPointsAdmin.ts and parlconAdmin.ts each carry
// their own copy). Deliberately NOT imported from @givefood/templates:
// packages/db does not depend on it, and a fifth abstraction for a
// 10-line pure function is not worth a new package edge.
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

export interface OrderItemRow {
  id: number;
  name: string;
  slug: string;
  calories: number;
}

// Django's get_object_or_404(OrderItem, slug=slug) (views.py:2255). `slug`
// is NOT unique on the model (orders.py:294 has no unique=True and save()
// does no uniquifying), so Django 500s with MultipleObjectsReturned if a
// legacy pair collides and one of the two rows becomes permanently
// uneditable. ORDER BY id LIMIT 1 makes the port pick the older row
// deterministically instead. See 0014_orderitem.sql's own comment for why
// the index behind this is non-unique.
export async function getOrderItemBySlug(session: Session, slug: string): Promise<OrderItemRow | null> {
  return await session.prepare("SELECT id, name, slug, calories FROM orderitem WHERE slug = ? ORDER BY id LIMIT 1").bind(slug).first<OrderItemRow>();
}

// Backs ModelForm.validate_unique()'s "Order item with this Name already
// exists." (models/orders.py:293 unique=True). The port pre-checks rather
// than letting D1's UNIQUE index throw, so a duplicate name gives the admin
// a message on a re-rendered form instead of a 500.
export async function getOrderItemByName(session: Session, name: string): Promise<OrderItemRow | null> {
  return await session.prepare("SELECT id, name, slug, calories FROM orderitem WHERE name = ?").bind(name).first<OrderItemRow>();
}

// givefood/utils/text.py:118-130 get_calories -- exact-name lookup (`name`,
// never `slug`), falling back to 0 when absent, which is Django's own
// `except OrderItem.DoesNotExist: calories = 0`. Nothing calls this yet;
// WP 6.5b's Order.save() port (orders.py:177, the model's only non-admin
// consumer) is its intended caller, and it lives here so that WP doesn't
// reinvent the lookup against a table it doesn't otherwise own.
export async function getItemCaloriesPer100g(session: Session, name: string): Promise<number> {
  const row = await session.prepare("SELECT calories FROM orderitem WHERE name = ?").bind(name).first<{ calories: number }>();
  return row?.calories ?? 0;
}

// Django's slug is a bare slugify(name) with no collision handling, so a
// second legal name that slugifies the same makes one row permanently
// uneditable (its /edit/ URL resolves to the other -- or 500s, see
// getOrderItemBySlug). Fixed here by suffixing -2, -3...: nothing outside
// the admin ever reads `slug` (get_calories, the only non-admin consumer,
// matches on `name`), so a disambiguated slug changes no read path and
// costs nothing. An empty base -- slugify("!!!") === "", which in Django
// yields a broken /admin/item//edit/ URL -- falls back to "item" for the
// same reason.
//
// substr() rather than LIKE for the prefix match, for two reasons. D1 caps a
// LIKE/GLOB pattern at 50 BYTES and errors above it, and real item names
// blow straight through that -- "Sainsbury's Naturally Sweet Sweetcorn In
// Water 198g (157g*)" slugifies to 52 characters, so `slug LIKE ?1 || '-%'`
// would have 500'd the save for exactly the long names most likely to need
// disambiguating. It also removes the old over-matching caveat: "_" and "%"
// are wildcards to LIKE but ordinary characters to substr, and slugify's \w
// keeps underscores.
async function uniqueSlug(session: Session, base: string, existingId: number | undefined): Promise<string> {
  const root = base || "item";
  const taken = await session
    .prepare("SELECT slug FROM orderitem WHERE (slug = ?1 OR substr(slug, 1, length(?1) + 1) = ?1 || '-') AND (?2 IS NULL OR id <> ?2)")
    .bind(root, existingId ?? null)
    .all<{ slug: string }>();
  const used = new Set(taken.results.map((r) => r.slug));
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export interface UpsertOrderItemParams {
  name: string;
  calories: number;
}

// OrderItem.save() (orders.py:305-308) in full: slugify the name, write the
// row. No timestamping, no cache invalidation, no denormalisation --
// PLAN.md:1004's "Pure CPU (slugify)" classification for this model.
export async function upsertOrderItem(session: Session, params: UpsertOrderItemParams, existingId: number | undefined): Promise<string> {
  const slug = await uniqueSlug(session, slugify(params.name), existingId);
  if (existingId === undefined) {
    await session.prepare("INSERT INTO orderitem (name, slug, calories) VALUES (?, ?, ?)").bind(params.name, slug, params.calories).run();
  } else {
    await session.prepare("UPDATE orderitem SET name = ?, slug = ?, calories = ? WHERE id = ?").bind(params.name, slug, params.calories, existingId).run();
  }
  return slug;
}

// gfadmin/views.py:2241-2249 items() -- `OrderItem.objects.all()` with no
// order_by at all, so Django's row order is whatever Postgres hands back,
// and all 1,200 rows render into one table on every page view.
//
// An unordered query cannot be paginated correctly, so this fixes it to an
// explicit sort (default name ASC, which is what an admin scanning 1,200
// food-item names wants) with `id` as the tiebreak -- calories has heavy
// ties, and without a tiebreak a row could appear on two pages or none.
// Pagination itself is the same defect fix adminLists.ts's header comment
// already documents for every other admin list: D1 meters rows scanned.
// Sortable headers are new too -- Django's items.html has plain <th>s with
// no links, but the list is 12 pages long once paginated.
export const ITEM_LIST_SORTS = ["name", "calories"] as const;
export type ItemListSort = (typeof ITEM_LIST_SORTS)[number];

// `name COLLATE NOCASE`, unlike getPlacesPage's bare `ORDER BY name`:
// SQLite's default text collation is byte-wise, so every capitalised item
// name would sort ahead of every lowercase one, which the source Postgres
// (en_US.utf8) never did. See types.ts's NAME_COLLATOR comment for the
// same problem stated in full. NOCASE is ASCII-only -- not a full
// linguistic collation -- but it is the whole of the difference for a table
// of English grocery names, and `id ASC` keeps the order total either way.
const ITEM_SORT_SQL: Record<ItemListSort, string> = {
  name: "name COLLATE NOCASE",
  calories: "calories",
};

export type OrderItemListRow = OrderItemRow;

export async function getOrderItemsPage(session: Session, sort: ItemListSort, direction: "asc" | "desc", page: number, pageSize: number): Promise<PageResult<OrderItemListRow>> {
  const offset = (page - 1) * pageSize;
  const [countRow, result] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM orderitem").first<{ n: number }>(),
    session
      // `sort`/`direction` are interpolated, never bound -- both come from
      // the allowlist above via the route, same as getPlacesPage
      // (adminLists.ts:307-318).
      .prepare(`SELECT id, name, slug, calories FROM orderitem ORDER BY ${ITEM_SORT_SQL[sort]} ${direction === "desc" ? "DESC" : "ASC"}, id ASC LIMIT ? OFFSET ?`)
      .bind(pageSize, offset)
      .all<OrderItemListRow>(),
  ]);
  const total = countRow?.n ?? 0;
  return { rows: result.results, total, page, pageSize, hasNext: offset + pageSize < total };
}
