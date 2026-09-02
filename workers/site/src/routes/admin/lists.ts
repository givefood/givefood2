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
  ORDER_LIST_SORTS,
  type OrderListSort,
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
import { timesince } from "../../lib/timesince";

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

// Timesince-formatted date cell, matching every Django list template's own
// "{{ value }}<br><span class=is-size-7>{{ value|timesince }} ago</span>"
// pattern -- raw value on the first line, relative time (small) beneath.
function dateCell(value: string | null, now: Date): string {
  if (!value) return "";
  return `${escapeHtml(value)}<br><span class="is-size-7">${timesince(value, now)} ago</span>`;
}

// gfadmin/views.py:234-314 foodbanks() -- excludes closed food banks,
// matching Django. Links each row to the foodbank's own admin detail page
// (WP 6.7), matching Django exactly -- this used to point at the edit
// form because the detail page didn't exist yet when this list was built
// (WP 6.5), a now-stale reason since WP 6.7 shipped it.
export async function adminFoodbanksList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const now = new Date();
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
      { label: "Closed" },
      { label: "Locations", sort: "no_locations" },
      { label: "Donation Points", sort: "no_donation_points" },
      { label: "Network", sort: "network" },
      { label: "28d Hits", sort: "hits_last_28_days" },
      { label: "Last Order", sort: "last_order" },
      { label: "Last Need", sort: "last_need" },
      { label: "Last Need Check", sort: "last_need_check" },
      { label: "Created", sort: "created" },
      { label: "Modified", sort: "modified" },
      { label: "Edited", sort: "edited" },
    ],
    rowCells: (fb) => [
      `<a href="/admin/foodbank/${fb.slug}/">${escapeHtml(fb.name)}</a>`,
      escapeHtml(fb.postcode),
      escapeHtml(fb.country),
      fb.is_closed ? '<span style="color:red">X</span>' : "",
      String(fb.no_locations),
      String(fb.no_donation_points ?? 0),
      fb.network ? escapeHtml(fb.network) : "",
      String(fb.hits_last_28_days),
      dateCell(fb.last_order, now),
      dateCell(fb.last_need, now),
      dateCell(fb.last_need_check, now),
      dateCell(fb.created, now),
      dateCell(fb.modified, now),
      dateCell(fb.edited, now),
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
      { label: "Location", sort: "name" },
      { label: "Address" },
      { label: "Parliamentary Constituency", sort: "parliamentary_constituency" },
      { label: "MP" },
      { label: "MP ID" },
      { label: "Network" },
      { label: "Country" },
      { label: "Closed" },
      { label: "Modified" },
      { label: "Edited", sort: "edited" },
    ],
    rowCells: (loc) => [
      `<a href="/admin/foodbank/${loc.foodbank_slug}/">${escapeHtml(loc.foodbank_name)}</a>`,
      `<a href="/admin/foodbank/${loc.foodbank_slug}/location/${loc.slug}/edit/">${escapeHtml(loc.name)}</a>`,
      [loc.address, loc.postcode].filter((v): v is string => !!v).map(escapeHtml).join(" "),
      loc.parliamentary_constituency_name ? escapeHtml(loc.parliamentary_constituency_name) : "",
      loc.mp ? escapeHtml(loc.mp) : "",
      loc.mp_parl_id !== null ? String(loc.mp_parl_id) : "",
      escapeHtml(loc.foodbank_network),
      loc.country ? escapeHtml(loc.country) : "",
      loc.is_closed ? "Yes" : "No",
      loc.modified,
      loc.edited ?? "",
    ],
  });
}

export async function adminDonationPointsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const sortParam = c.req.query("sort");
  const sort: DonationPointListSort = (DONATION_POINT_LIST_SORTS as readonly string[]).includes(sortParam ?? "") ? (sortParam as DonationPointListSort) : "name";
  const page = await getDonationPointsPage(db, sort, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Donation Points",
    section: "foodbanks",
    page,
    sort,
    columns: [
      { label: "Foodbank", sort: "foodbank_name" },
      { label: "Location", sort: "name" },
      { label: "Address" },
      { label: "Company" },
      { label: "Store ID" },
      { label: "Network" },
      { label: "Country" },
      { label: "Closed" },
      { label: "Modified" },
      { label: "Edited", sort: "edited" },
    ],
    rowCells: (dp) => [
      `<a href="/admin/foodbank/${dp.foodbank_slug}/">${escapeHtml(dp.foodbank_name)}</a>`,
      `<a href="/admin/foodbank/${dp.foodbank_slug}/donationpoint/${dp.slug}/edit/">${escapeHtml(dp.name)}</a>`,
      [dp.address, dp.postcode].filter((v): v is string => !!v).map(escapeHtml).join(" "),
      dp.company ? `<img src="/static/img/co/${dp.company_slug}.png" alt="${escapeHtml(dp.company)}" class="companyicon"> ${escapeHtml(dp.company)}` : "",
      dp.store_id ? escapeHtml(dp.store_id) : "",
      escapeHtml(dp.foodbank_network),
      dp.country ? escapeHtml(dp.country) : "",
      dp.is_closed ? "Yes" : "No",
      dp.modified,
      dp.edited ?? "",
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
    columns: [
      { label: "Name" },
      { label: "Country" },
      { label: "MP" },
      { label: "MP Party" },
      { label: "MP Parliament ID" },
      { label: "MP Photo" },
      { label: "Email" },
      { label: "GeoJSON?" },
    ],
    rowCells: (pc) => [
      escapeHtml(pc.name ?? ""),
      pc.country ? escapeHtml(pc.country) : "",
      pc.mp ? escapeHtml(pc.mp) : "",
      pc.mp_party ? escapeHtml(pc.mp_party) : "",
      String(pc.mp_parl_id),
      `<img src="https://photos.givefood.org.uk/2024-mp/${pc.mp_parl_id}.jpg" alt="${escapeHtml(pc.mp ?? "")}" width="50" loading="lazy">`,
      pc.email ? escapeHtml(pc.email) : "",
      pc.has_geojson ? "\u{1F5FA}\u{FE0F}" : "",
    ],
    rowActions: (pc) => `<a href="/admin/parlcon/${pc.slug}/edit/" class="button is-small is-light">Edit</a>`,
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
const ORDER_PACKAGING_WEIGHT_PC = 1.18; // givefood/const/general.py:136 -- same constant as foodbank_detail.njk's Stats panel

export async function adminOrdersList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const sortParam = c.req.query("sort");
  const sort: OrderListSort = (ORDER_LIST_SORTS as readonly string[]).includes(sortParam ?? "") ? (sortParam as OrderListSort) : "delivery_datetime";
  const page = await getOrdersPage(db, sort, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Orders",
    section: "orders",
    page,
    sort,
    columns: [
      { label: "ID" },
      { label: "Foodbank" },
      { label: "Del. Prov. ID" },
      { label: "Country" },
      { label: "Delivery", sort: "delivery_datetime" },
      { label: "Items", sort: "no_items" },
      { label: "Weight (kg)", sort: "weight" },
      { label: "Calories", sort: "calories" },
      { label: "Cost", sort: "cost" },
      { label: "Delivered Cost" },
      { label: "Created", sort: "created" },
    ],
    rowCells: (o) => [
      `<a href="/admin/order/${encodeURIComponent(o.order_id)}/">${escapeHtml(o.order_id)}</a>`,
      o.foodbank_name && o.foodbank_slug ? `<a href="/admin/foodbank/${o.foodbank_slug}/">${escapeHtml(o.foodbank_name)}</a>` : "<em>Unassigned</em>",
      o.delivery_provider_id ? escapeHtml(o.delivery_provider_id) : "",
      escapeHtml(o.country),
      o.delivery_datetime,
      String(o.no_items),
      ((o.weight / 1000) * ORDER_PACKAGING_WEIGHT_PC).toFixed(2),
      String(o.calories),
      `£${(o.cost / 100).toFixed(2)}`,
      o.actual_cost ? `£${(o.actual_cost / 100).toFixed(2)}` : "",
      o.created,
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
