import type { Context } from "hono";
import {
  getFoodbanksPage,
  getAllFoodbanksForCsv,
  FOODBANK_LIST_SORTS,
  type FoodbankListSort,
  getLocationsPage,
  LOCATION_LIST_SORTS,
  type LocationListSort,
  getDonationPointsPage,
  DONATION_POINT_LIST_SORTS,
  type DonationPointListSort,
  getParlconsPage,
  getParlconCsvRows,
  getOrdersPage,
  getAllOrdersForCsv,
  getAllNeedsForCsv,
  getPlacesPage,
  PLACE_LIST_SORTS,
  type PlaceListSort,
  getSubscriptionsPage,
  deleteSubscription,
  type SubscriptionType,
  getFoodbanksWithoutNeedPage,
  totalPages,
  type PageResult,
} from "@givefood/db";
import { formatCsvRow } from "@givefood/serialise";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";

const PAGE_SIZE = 100;

function parsePage(c: Context<AppEnv>): number {
  const raw = Number.parseInt(c.req.query("page") ?? "1", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

function csvResponse(filename: string, header: readonly string[], rows: unknown[][]): Response {
  let body = formatCsvRow(header as unknown[]);
  for (const row of rows) body += formatCsvRow(row);
  return new Response(body, { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${filename}"` } });
}

interface ListColumn {
  label: string;
  sort?: string;
}

async function renderList<T>(
  c: Context<AppEnv>,
  opts: {
    title: string;
    section: string;
    page: PageResult<T>;
    sort?: string;
    columns: ListColumn[];
    rowCells: (row: T) => string[];
    // Takes the same CSRF token the page itself renders with -- built
    // once below, not re-derived, so a row-action button's embedded
    // token always matches the __Host-csrf cookie actually set on this
    // response (issueCsrfToken mints a fresh token+cookie pair on every
    // call; calling it twice for one response would mint two different
    // tokens and only one of them would match the cookie the browser
    // keeps).
    rowActions?: (row: T, csrfToken: string) => string;
    newUrl?: string;
    csvUrl?: string;
    extra?: Record<string, unknown>;
  },
): Promise<Response> {
  const pageContext = await adminPageContext(c, opts.section);
  const csrfToken = pageContext.csrf_token as string;
  const html = await render("admin/list.njk", {
    ...pageContext,
    ...(opts.extra ?? {}),
    title: opts.title,
    total: opts.page.total,
    page: opts.page.page,
    total_pages: totalPages(opts.page.total, opts.page.pageSize),
    has_next: opts.page.hasNext,
    sort: opts.sort,
    columns: opts.columns,
    rows: opts.page.rows.map((row) => ({ cells: opts.rowCells(row), actions: opts.rowActions ? opts.rowActions(row, csrfToken) : "" })),
    row_actions: !!opts.rowActions,
    new_url: opts.newUrl,
    csv_url: opts.csvUrl,
  });
  return c.html(html);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

// gfadmin/views.py:234-314 foodbanks() -- excludes closed food banks,
// matching Django. Links each row to the edit form (WP 6.5) -- there's no
// standalone "foodbank detail" admin page yet (WP 6.7's tabbed htmx
// surface), same reasoning as every WP 6.5 redirect target.
export async function adminFoodbanksList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const sortParam = c.req.query("sort");
  const sort: FoodbankListSort = (FOODBANK_LIST_SORTS as readonly string[]).includes(sortParam ?? "") ? (sortParam as FoodbankListSort) : "edited";
  const page = await getFoodbanksPage(db, sort, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Foodbanks",
    section: "foodbanks",
    page,
    sort,
    columns: [
      { label: "Name", sort: "name" },
      { label: "Postcode", sort: "postcode" },
      { label: "Country", sort: "country" },
      { label: "Network", sort: "network" },
      { label: "Edited", sort: "edited" },
    ],
    rowCells: (fb) => [
      `<a href="/admin/foodbank/${fb.slug}/edit/">${escapeHtml(fb.name)}</a>`,
      escapeHtml(fb.postcode),
      escapeHtml(fb.country),
      fb.network ? escapeHtml(fb.network) : "",
      fb.edited ?? "",
    ],
    newUrl: "/admin/foodbank/new/",
    csvUrl: "/admin/foodbanks/csv/",
  });
}

// gfadmin/views.py:326-337 foodbanks_csv() -- frozen column order: name,
// postcode, charity_number, country, last_order, last_need, no_locations,
// network, closed, url, created, modified. ALL food banks (closed
// included), unlike the list view above.
export async function adminFoodbanksCsv(c: Context<AppEnv>): Promise<Response> {
  const rows = await getAllFoodbanksForCsv(dbSession(c));
  return csvResponse(
    "foodbanks.csv",
    ["name", "postcode", "charity_number", "country", "last_order", "last_need", "no_locations", "network", "closed", "url", "created", "modified"],
    rows.map((fb) => [fb.name, fb.postcode, fb.charity_number, fb.country, fb.last_order, fb.last_need, fb.no_locations, fb.network, fb.is_closed, fb.url, fb.created, fb.modified]),
  );
}

// gfadmin/views.py:2138-2220 locations()/donationpoints() -- both
// unbounded in Django (WP 6.6 research); paginated here, see
// adminLists.ts's own comment for why.
export async function adminLocationsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const sortParam = c.req.query("sort");
  const sort: LocationListSort = (LOCATION_LIST_SORTS as readonly string[]).includes(sortParam ?? "") ? (sortParam as LocationListSort) : "foodbank_name";
  const page = await getLocationsPage(db, sort, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Locations",
    section: "foodbanks",
    page,
    sort,
    columns: [
      { label: "Foodbank", sort: "foodbank_name" },
      { label: "Name", sort: "name" },
      { label: "Postcode", sort: "postcode" },
      { label: "Modified", sort: "modified" },
    ],
    rowCells: (loc) => [
      escapeHtml(loc.foodbank_name),
      `<a href="/admin/foodbank/${loc.foodbank_slug}/location/${loc.slug}/edit/">${escapeHtml(loc.name)}</a>`,
      loc.postcode ? escapeHtml(loc.postcode) : "",
      loc.modified,
    ],
  });
}

export async function adminDonationPointsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const sortParam = c.req.query("sort");
  const sort: DonationPointListSort = (DONATION_POINT_LIST_SORTS as readonly string[]).includes(sortParam ?? "") ? (sortParam as DonationPointListSort) : "foodbank_name";
  const page = await getDonationPointsPage(db, sort, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Donation Points",
    section: "foodbanks",
    page,
    sort,
    columns: [
      { label: "Foodbank", sort: "foodbank_name" },
      { label: "Name", sort: "name" },
      { label: "Company", sort: "company" },
    ],
    rowCells: (dp) => [
      escapeHtml(dp.foodbank_name),
      `<a href="/admin/foodbank/${dp.foodbank_slug}/donationpoint/${dp.slug}/edit/">${escapeHtml(dp.name)}</a>`,
      dp.company ? escapeHtml(dp.company) : "",
    ],
  });
}

// gfadmin/views.py:2311-2321 politics().
export async function adminParlconsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const page = await getParlconsPage(db, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Parliamentary Constituencies",
    section: "geography",
    page,
    columns: [{ label: "Name" }, { label: "MP" }, { label: "Party" }],
    rowCells: (pc) => [`<a href="/admin/parlcon/${pc.slug}/edit/">${escapeHtml(pc.name ?? "")}</a>`, pc.mp ? escapeHtml(pc.mp) : "", pc.mp_party ? escapeHtml(pc.mp_party) : ""],
    newUrl: "/admin/parlcon/new/",
    csvUrl: "/admin/politics/csv/",
  });
}

// gfadmin/views.py:2322-2336 politics_csv() -- see adminLists.ts's own
// comment on getParlconCsvRows for why this exports Foodbank/
// FoodbankLocation rows, not ParliamentaryConstituency rows.
export async function adminParlconsCsv(c: Context<AppEnv>): Promise<Response> {
  const rows = await getParlconCsvRows(dbSession(c));
  return csvResponse(
    "politics.csv",
    ["constituency", "mp", "mp_party", "mp_parl_id"],
    rows.map((r) => [r.constituency, r.mp, r.mp_party, r.mp_parl_id]),
  );
}

// gfadmin/views.py:369-408 orders()/orders_csv() -- CREATE/EDIT deferred
// (WP 6.5b), read-only here (see adminLists.ts's own comment on why
// that's safe to build independently).
export async function adminOrdersList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const page = await getOrdersPage(db, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Orders",
    section: "orders",
    page,
    columns: [{ label: "Order" }, { label: "Foodbank" }, { label: "Delivery" }, { label: "Provider" }, { label: "Cost" }],
    rowCells: (o) => [
      escapeHtml(o.order_id),
      o.foodbank_name ? escapeHtml(o.foodbank_name) : "Unassigned",
      o.delivery_datetime,
      o.delivery_provider ? escapeHtml(o.delivery_provider) : "",
      `${(o.actual_cost ?? o.cost) / 100}`,
    ],
    csvUrl: "/admin/orders/csv/",
  });
}

export async function adminOrdersCsv(c: Context<AppEnv>): Promise<Response> {
  const rows = await getAllOrdersForCsv(dbSession(c));
  return csvResponse(
    "orders.csv",
    ["id", "created", "delivery", "delivery_provider", "foodbank", "country", "weight", "calories", "items", "cost", "delivered_cost"],
    rows.map((o) => [o.order_id, o.created, o.delivery_datetime, o.delivery_provider, o.foodbank_name ?? "Unassigned", o.country, o.weight, o.calories, o.no_items, o.cost, o.actual_cost]),
  );
}

// gfadmin/views.py:431-442 needs_csv() -- see needAdmin.ts's own comment
// on getAllNeedsForCsv for why this is unbounded/unfiltered.
export async function adminNeedsCsv(c: Context<AppEnv>): Promise<Response> {
  const rows = await getAllNeedsForCsv(dbSession(c));
  return csvResponse(
    "needs.csv",
    ["id", "created", "foodbank", "needs", "excess", "input_method"],
    rows.map((n) => [n.need_id, n.created, n.foodbank_name, n.change_text, n.excess_change_text, n.input_method]),
  );
}

// WP 6.9: gfadmin/views.py:3028-3062 places() -- real LIMIT/OFFSET instead
// of Django's 20,000-row "page".
export async function adminPlacesList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const sortParam = c.req.query("sort") ?? "name";
  const direction = sortParam.startsWith("-") ? "desc" : "asc";
  const field = (sortParam.startsWith("-") ? sortParam.slice(1) : sortParam) as PlaceListSort;
  const sort: PlaceListSort = (PLACE_LIST_SORTS as readonly string[]).includes(field) ? field : "name";
  const page = await getPlacesPage(db, sort, direction, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Places",
    section: "geography",
    page,
    sort: sortParam,
    columns: [
      { label: "Name", sort: direction === "asc" && sort === "name" ? "-name" : "name" },
      { label: "County", sort: direction === "asc" && sort === "county" ? "-county" : "county" },
      { label: "Population", sort: direction === "asc" && sort === "population" ? "-population" : "population" },
    ],
    rowCells: (p) => [p.name ? escapeHtml(p.name) : "", p.county ? escapeHtml(p.county) : "", p.population !== null ? String(p.population) : ""],
  });
}

// WP 6.9: gfadmin/views.py:2890-2980 subscriptions() -- see adminLists.ts's
// own comment on getSubscriptionsPage for why this is a UNION ALL, not an
// in-memory sort+paginate. "whatsapp" isn't a selectable `?type=` value --
// no whatsappsubscriber D1 table exists yet (same gap WP 6.4 disclosed).
const SUBSCRIPTION_TYPES: readonly SubscriptionType[] = ["all", "email", "mobile", "webpush"];

export async function adminSubscriptionsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const typeParam = c.req.query("type") ?? "all";
  const subType: SubscriptionType = (SUBSCRIPTION_TYPES as readonly string[]).includes(typeParam) ? (typeParam as SubscriptionType) : "all";
  const page = await getSubscriptionsPage(db, subType, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Subscriptions",
    section: "settings",
    page,
    columns: [{ label: "Type" }, { label: "Foodbank" }, { label: "Subscriber" }, { label: "Created" }],
    rowCells: (s) => [s.type, escapeHtml(s.foodbank_name), escapeHtml(s.identifier), s.created],
    rowActions: (s, csrfToken) =>
      `<form method="post" action="/admin/subscriptions/delete/" onsubmit="return confirm('Delete this subscription?')">` +
      `<input type="hidden" name="csrf_token" value="${csrfToken}">` +
      `<input type="hidden" name="type" value="${s.type}">` +
      `<input type="hidden" name="row_id" value="${escapeHtml(s.row_id)}">` +
      `<button type="submit" class="button is-small is-danger is-light">Delete</button></form>`,
    extra: { extra_query: `&type=${subType}` },
  });
}

export async function adminDeleteSubscription(c: Context<AppEnv>): Promise<Response> {
  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  const type = body.type;
  const rowId = body.row_id;
  if ((type !== "email" && type !== "mobile" && type !== "webpush") || typeof rowId !== "string") return c.text("Bad request", 400);

  await deleteSubscription(dbSession(c), type, rowId);
  return c.redirect("/admin/subscriptions/", 302);
}

// WP 6.9: gfadmin/views.py:3090-3111 foodbanks_without_need -- see
// adminLists.ts's own comment on getFoodbanksWithoutNeedPage for the
// DISTINCT ON -> ROW_NUMBER() rewrite this WP is named for.
export async function adminFoodbanksWithoutNeedList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const page = await getFoodbanksWithoutNeedPage(db, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Foodbanks without a need",
    section: "settings",
    page,
    columns: [{ label: "Foodbank" }, { label: "Latest published need" }],
    rowCells: (f) => [
      `<a href="/admin/foodbank/${f.slug}/">${escapeHtml(f.name)}</a>`,
      f.latest_need_id ? `<a href="/admin/need/${f.latest_need_id}/">${f.latest_need_created}</a>` : "Never",
    ],
  });
}
