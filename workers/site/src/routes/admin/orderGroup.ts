import type { Context } from "hono";
import { getOrderGroupsPage, getOrderGroupBySlug, getOrderGroupOrders, upsertOrderGroup, totalPages, type OrderGroupRow } from "@givefood/db";
import { djangoDate, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { parseAdminFields, type AdminFieldSpec } from "../../lib/adminFormFields";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:2767-2775 order_groups(), :2778-2807 order_group(),
// :2810-2832 order_group_form() -- the three Order Group admin pages
// (gfadmin/urls/orders.py:16-19), reached from the Settings page's own
// "Order Groups" item (settings.njk:14, matching
// gfadmin/templates/admin/settings.html:16, which is the only place Django
// links them from either). `section` is "settings" for the same reason,
// verbatim from views.py:2771/2798.
//
// All three live in ONE file, list included, rather than the list going in
// lists.ts next to the other list views: lists.ts's renderList() is
// module-private, and the whole group -- list, detail, form -- shares
// managedDonationUrl(), the key rules and the packaging constant. Splitting
// it would mean exporting those across files for no gain.
//
// KNOWN DEAD LINK, worth stating once: the "Link" anchor points at
// /donate/managed/<slug>-<key>/, which this port does not serve yet
// (routes/public/donate.ts:8-11 scopes that family out; PLAN.md puts it in
// Phase 5 G5), so it 404s until that lands. The anchor is rendered anyway,
// exactly as Django does.

const PAGE_SIZE = 100;
const PACKAGING_WEIGHT_PC = 1.18; // givefood/const/general.py:136 -- same constant as order.ts/lists.ts

// Duplicated from routes/admin/lists.ts (module-private there, and that
// file is shared with other work in flight) -- three small pure helpers,
// not worth a new shared module.
function parsePage(c: Context<AppEnv>): number {
  const raw = Number.parseInt(c.req.query("page") ?? "1", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

// Django's bare `{{ order_group.created }}` -- DATETIME_FORMAT "N j, Y, P".
function plainDateCell(value: string | null): string {
  return value ? escapeHtml(djangoDate(value, "N j, Y, P")) : "";
}

// givefood/urls.py:38 registers the public page as
// `donate/managed/<slug:slug>-<slug:key>/`. Django's greedy `slug` group
// backtracks, so that pattern is split on the LAST hyphen -- a key
// containing "-" or "_" (both legal in `<slug:...>`) therefore resolves to
// the WRONG (slug, key) pair and 404s. Nothing in Django validates the
// key's charset; this port does, below, so the split is always correct.
export function managedDonationUrl(slug: string, key: string | null): string | null {
  return key ? `/donate/managed/${encodeURIComponent(slug)}-${encodeURIComponent(key)}/` : null;
}

// 32-char unambiguous alphabet (no 0/1/l/o to be misread off a printed
// page), 8 chars = 40 bits. 256/32 is exact, so a byte modulo is unbiased.
const KEY_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
// CharField(max_length=8) on the model; letters and digits only, per the
// last-hyphen split above.
const KEY_RE = /^[A-Za-z0-9]{1,8}$/;

function generateKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join("");
}

// givefood/forms.py:225-228 OrderGroupForm -- `fields = "__all__"` on
// OrderGroup, which yields only the EDITABLE fields, i.e. exactly these
// three inputs in model-declaration order (`slug`, `created` and
// `modified` are editable=False and Django never renders them either).
//
// Kept here rather than in lib/adminFormFields.ts alongside
// FOODBANK_FIELDS/PARLCON_FIELDS purely because this is the only form that
// uses it and that file is shared; it is the same AdminFieldSpec shape and
// can be moved there wholesale if a second consumer ever appears.
const ORDER_GROUP_FIELDS: readonly AdminFieldSpec[] = [
  {
    name: "name",
    label: "Name",
    kind: "text",
    required: true,
    helpText: "The slug is derived from this. Renaming a public group CHANGES its donor-facing /donate/managed/ URL.",
  },
  { name: "public", label: "Public", kind: "checkbox", required: false, helpText: "Publish this group at /donate/managed/<slug>-<key>/" },
  {
    name: "key",
    label: "Key",
    kind: "text",
    required: false,
    helpText: "Up to 8 letters or digits. Generated automatically when the group is first made public and this is blank. Never change an existing key -- it is already in URLs shared with donors.",
  },
] as const;

// gfadmin/templates/admin/order_groups.html:27-32 -- a green tick plus a
// "Link" anchor when public, and NOTHING AT ALL when not (no red cross on
// this page, unlike the detail page's own Public row).
//
// FIXED HERE: Django reverses `managed_donation` unconditionally inside
// the `{% if public %}`, and a blank key (the form allows one -- forms.py:
// 225 makes `key` optional while the template requires it) raises
// NoReverseMatch, 500ing the ENTIRE list rather than one row. A NULL key
// instead reverses to the literal string "None" -- a silently dead donor
// link. Rendering the tick without an anchor covers both.
function orderGroupPublicCell(g: OrderGroupRow): string {
  if (!g.public) return "";
  const url = managedDonationUrl(g.slug, g.key);
  const tick = '<span style="color:green">&#10003;</span>';
  return url ? `${tick} <a href="${url}">Link</a>` : tick;
}

// gfadmin/views.py:2767-2775 order_groups() -- `.order_by("-created")`, no
// sorting, filtering or CSV in Django either. Renders the shared
// admin/list.njk directly (rather than through lists.ts's module-private
// renderList) since the page's shape is exactly what that template
// expects.
export async function adminOrderGroupsList(c: Context<AppEnv>): Promise<Response> {
  const page = await getOrderGroupsPage(dbSession(c), parsePage(c), PAGE_SIZE);

  const html = await render("admin/list.njk", {
    ...(await adminPageContext(c, "settings")),
    title: "Order Groups",
    total: page.total,
    page: page.page,
    total_pages: totalPages(page.total, page.pageSize),
    has_next: page.hasNext,
    columns: [{ label: "Name" }, { label: "Created" }, { label: "Public?" }],
    rows: page.rows.map((g) => ({
      cells: [
        `<a href="/admin/order-group/${encodeURIComponent(g.slug)}/">${escapeHtml(g.name)}</a>`,
        plainDateCell(g.created),
        orderGroupPublicCell(g),
      ],
      actions: `<a href="/admin/order-group/${encodeURIComponent(g.slug)}/edit/" class="button is-small is-light">Edit</a>`,
    })),
    row_actions: true,
    new_url: "/admin/order-groups/new/",
  });
  return c.html(html);
}

// gfadmin/views.py:2778-2807 order_group() -- the six aggregates are summed
// from the same rows the table renders, exactly as Django's own loop
// (:2790-2795) does, so there is no second aggregate query to keep in
// sync with the table.
export async function adminOrderGroupDetail(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const group = await getOrderGroupBySlug(db, c.req.param("slug")!);
  if (!group) return c.notFound();

  const rows = await getOrderGroupOrders(db, group.id);

  let items = 0;
  let weightKg = 0;
  let calories = 0;
  let costPence = 0;
  for (const o of rows) {
    items += o.no_items;
    weightKg += (o.weight / 1000) * PACKAGING_WEIGHT_PC; // Order.weight_kg_pkg(), givefood/models/orders.py:86-87
    calories += o.calories;
    costPence += o.cost;
  }

  const html = await render("admin/order_group.njk", {
    ...(await adminPageContext(c, "settings")),
    order_group: group,
    public_url: group.public ? managedDonationUrl(group.slug, group.key) : null,
    orders: rows.map((o) => ({ ...o, weight_kg_pkg: (o.weight / 1000) * PACKAGING_WEIGHT_PC, cost_gbp: o.cost / 100 })),
    no_orders: rows.length,
    items,
    weight: weightKg,
    calories,
    cost: costPence / 100,
  });
  return c.html(html);
}

// gfadmin/views.py:2810-2832 order_group_form -- create (no :slug) and edit
// (with :slug) in one handler, same shape as parlcon.ts.
//
// Django's admin has no CSRF middleware at all; this port's mutations are
// POST-only and CSRF-verified (WP 6.3).
export async function adminOrderGroupForm(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug");
  const db = dbSession(c);

  const existing = slug ? await getOrderGroupBySlug(db, slug) : null;
  if (slug && !existing) return c.notFound();

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(ORDER_GROUP_FIELDS, body as Record<string, unknown>);
    if (!parsed.ok) return c.text(parsed.error, 400);

    const isPublic = Number(parsed.values.public);
    let key = parsed.values.key === null ? null : String(parsed.values.key);
    if (key !== null && !KEY_RE.test(key)) return c.text("Key must be 1-8 letters or digits, with no hyphens or underscores", 400);
    // A BLANK key field on an existing group means "leave it alone", never
    // "clear it" and never "make me a new one". The key is a capability token
    // already circulating in donor URLs (/donate/managed/<slug>-<key>/), so
    // regenerating it silently breaks every link anyone has been given --
    // which is what happened before this line: a blank field became null,
    // and null on a public group hit the generator below.
    if (!key && existing?.key) key = existing.key;
    // Only then: a group being published for the first time with no key at
    // all gets one, rather than a public URL that cannot be built.
    if (isPublic === 1 && !key) key = generateKey();

    const result = await upsertOrderGroup(db, { name: String(parsed.values.name), public: isPublic, key }, existing?.id);
    if (!result.ok) return c.text(result.error, 400);

    return c.redirect("/admin/order-groups/", 302); // views.py:2823 redirect("admin:order_groups")
  }

  const html = await render("admin/generic_form.njk", {
    ...(await adminPageContext(c, "settings")),
    // views.py:2826 unconditionally reassigns page_title = "New Order
    // Group" in the GET branch, so Django's EDIT form is ALWAYS titled
    // "New Order Group" (only a POST that fails validation ever shows the
    // edit title). Fixed.
    title: existing ? `Edit ${existing.name}` : "New Order Group",
    fields: ORDER_GROUP_FIELDS,
    data: existing ?? {},
    back_url: "/admin/order-groups/",
    // Django has no order_group delete view at all (gfadmin/urls/orders.py:
    // 16-19), and deleting a group would orphan every orders.order_group_id
    // pointing at it -- there is no FK to cascade or restrain it.
    delete_url: null,
  });
  return c.html(html);
}
