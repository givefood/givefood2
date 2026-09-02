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
  totalPages,
  type PageResult,
} from "@givefood/db";
import { formatCsvRow } from "@givefood/serialise";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
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
  opts: { title: string; section: string; page: PageResult<T>; sort?: string; columns: ListColumn[]; rowCells: (row: T) => string[]; newUrl?: string; csvUrl?: string },
): Promise<Response> {
  const html = await render("admin/list.njk", {
    ...(await adminPageContext(c, opts.section)),
    title: opts.title,
    total: opts.page.total,
    page: opts.page.page,
    total_pages: totalPages(opts.page.total, opts.page.pageSize),
    has_next: opts.page.hasNext,
    sort: opts.sort,
    columns: opts.columns,
    rows: opts.page.rows.map((row) => ({ cells: opts.rowCells(row) })),
    row_actions: false,
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
