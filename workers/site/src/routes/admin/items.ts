import type { Context } from "hono";
import { getOrderItemBySlug, getOrderItemByName, getOrderItemsPage, upsertOrderItem, totalPages, ITEM_LIST_SORTS, type ItemListSort } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";

// gfadmin/urls/items.py -- the OrderItem admin: a list (views.py:2241-2249)
// and one shared new/edit form (views.py:2252-2273). Both live here rather
// than the list half going in routes/admin/lists.ts, because this page does
// not fit that file's renderList() helper (Django's "New Item" button label,
// no row-count title, no CSV, no filter) and bending the shared list template
// for a single caller costs more than a 60-line template of its own.
//
// section "settings" throughout: Django's views pass `section: "items"`
// (:2247), which matches no entry in its own page.html nav, so nothing
// highlights there. The port's only inbound link is admin/settings.njk's
// "Order Items" (Django settings.html:14), so "settings" is the section that
// actually lights up.

const PAGE_SIZE = 100; // same as routes/admin/lists.ts -- 1,200 items = 12 pages

function parsePage(c: Context<AppEnv>): number {
  const raw = Number.parseInt(c.req.query("page") ?? "1", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

// gfadmin/views.py:2241-2249 items() -- Django renders all 1,200 rows,
// unordered and unpaginated. See getOrderItemsPage's own comment in
// packages/db/src/orderItemAdmin.ts for why the port sorts and paginates.
export async function adminItemsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);

  // "?sort=name" / "?sort=-name" -- a leading "-" means descending, the same
  // convention adminPlacesList uses (routes/admin/lists.ts:395-401).
  const sortParam = c.req.query("sort") ?? "name";
  const direction: "asc" | "desc" = sortParam.startsWith("-") ? "desc" : "asc";
  const field = sortParam.startsWith("-") ? sortParam.slice(1) : sortParam;
  const sort: ItemListSort = (ITEM_LIST_SORTS as readonly string[]).includes(field) ? (field as ItemListSort) : "name";
  const page = await getOrderItemsPage(db, sort, direction, parsePage(c), PAGE_SIZE);

  const html = await render("admin/items.njk", {
    ...(await adminPageContext(c, "settings")),
    total: page.total,
    page: page.page,
    total_pages: totalPages(page.total, page.pageSize),
    has_next: page.hasNext,
    // Echoed back into the pagination links so paging keeps the sort; the
    // per-column values below are what each header link should switch TO
    // (click the already-ascending column to flip it to descending).
    sort: direction === "desc" ? `-${sort}` : sort,
    sort_field: sort,
    direction,
    name_sort: direction === "asc" && sort === "name" ? "-name" : "name",
    calories_sort: direction === "asc" && sort === "calories" ? "-calories" : "calories",
    // items.html:26's Edit link. encodeURIComponent because `slug` is
    // whatever slugify() produced and is not constrained by the schema.
    items: page.rows.map((item) => ({ ...item, edit_url: `/admin/item/${encodeURIComponent(item.slug)}/edit/` })),
  });
  return c.html(html);
}

// models/orders.py:293 max_length=100 -- the length Django's ModelForm
// rejects past with "Ensure this value has at most 100 characters".
const NAME_MAX_LENGTH = 100;

// gfadmin/views.py:2252-2273 item_form -- create (/admin/item/new/) and edit
// (/admin/item/:slug/edit/) in one handler, two registrations, the same shape
// as adminParlconForm.
//
// Three documented departures from Django:
//
// 1. GET accepts ?name= to pre-fill. Django's admin/order.html:117-134 gets
//    the same pre-fill by POSTing a DELIBERATELY INVALID form (name only, no
//    calories) with no csrf_token, relying on CSRF being switched off
//    (settings.py:97) and on item_form re-rendering the bound form after a
//    failed is_valid(). A POST-as-GET-prefill cannot survive this port's CSRF
//    rule and should not -- ?name= is the same mechanism
//    routes/admin/foodbankLocation.ts already uses for the check page's "Add"
//    links, so order.njk's Add button becomes a plain link too.
//
// 2. An invalid POST re-renders the form with the submitted values and an
//    error banner (HTTP 400) instead of the bare `c.text(error, 400)` the
//    other ported admin forms return. Django shows inline field errors here;
//    a text/plain 400 would throw away everything the admin typed.
//
// 3. Django's `if request.POST:` (:2261) tests the QueryDict's TRUTHINESS, so
//    a genuinely empty POST body silently falls through to rendering an
//    unbound form -- an accident of Django's API, not a behaviour worth
//    keeping. Here a POST is always treated as a submission and an empty one
//    fails validation like any other.
export async function adminItemForm(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug");
  const db = dbSession(c);

  const existing = slug ? await getOrderItemBySlug(db, slug) : null;
  if (slug && !existing) return c.notFound(); // get_object_or_404 (:2255)

  let error: string | null = null;
  // Spread rather than assigned: an interface has no index signature, so
  // `existing` on its own is not assignable to Record<string, unknown>.
  let data: Record<string, unknown> = existing ? { ...existing } : { name: c.req.query("name") ?? "", calories: "" };

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    // forms.CharField's default strip=True is the only normalisation Django
    // applies to `name`.
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    const rawCalories = typeof body.calories === "string" ? body.calories.trim() : "";
    data = { name: rawName, calories: rawCalories };

    if (!rawName) {
      error = "Name is required";
    } else if (rawName.length > NAME_MAX_LENGTH) {
      error = `Name must be ${NAME_MAX_LENGTH} characters or fewer`;
    } else if (!rawCalories) {
      error = "Calories is required";
    } else if (!/^\d+$/.test(rawCalories)) {
      // PositiveIntegerField: whole numbers >= 0 only. The regex rejects
      // "-5", "12.5" and "abc" in one test, which Number.parseInt alone would
      // not ("12abc" parses to 12).
      error = "Calories must be a whole number of 0 or more";
    } else {
      const clash = await getOrderItemByName(db, rawName);
      if (clash && clash.id !== existing?.id) {
        // ModelForm.validate_unique() against models/orders.py:293's
        // unique=True. The check excludes the row being edited, so re-saving
        // an item without renaming it is fine -- matching Django.
        error = `Order item with this Name already exists: "${rawName}"`;
      } else {
        await upsertOrderItem(db, { name: rawName, calories: Number.parseInt(rawCalories, 10) }, existing?.id);
        // views.py:2265 redirect("admin:items") -- back to the list, NOT to
        // the edit page (unlike every other admin form in this port).
        return c.redirect("/admin/items/", 302);
      }
    }
  }

  const html = await render("admin/item_form.njk", {
    ...(await adminPageContext(c, "settings")),
    title: existing ? "Edit Item" : "New Item", // views.py:2256 / :2259 verbatim
    data,
    error,
  });
  return c.html(html, error ? 400 : 200);
}
