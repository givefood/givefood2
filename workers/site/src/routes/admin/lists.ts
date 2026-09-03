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
  getNeedsPage,
  getOldestEditedFoodbankSlug,
  totalPages,
  type PageResult,
} from "@givefood/db";
import { formatCsvRow } from "@givefood/serialise";
import { djangoDate, intcomma, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";
import { timesince } from "../../lib/timesince";
import { inputMethodEmoji } from "../../lib/needAdminDisplay";

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
  // The `?sort=` value this header links to -- the NEXT sort, not the
  // current one (clicking the column the list is already sorted by flips
  // its direction), so it must not be compared against `sort` to decide
  // whether the column is the active one. `active`/`desc` say that.
  sort?: string;
  active?: boolean;
  desc?: boolean;
}

// One option of the sort <select> every sortable Django list page carries
// top-right (foodbanks.html:16-26, orders.html:14-27, locations.html:14-25,
// donationpoints.html:14-24, places.html:14-24). `value` is the raw
// `?sort=` key, signed with a leading "-" for descending on the pages
// whose Django view applies the key raw.
interface ListSortOption {
  value: string;
  label: string;
}

// gfadmin/views.py:236-257 / :3030-3037 -- Django's sort keys on foodbanks
// and places are signed strings ("name" ascending, "-name" descending),
// applied raw by `.order_by(sort)`, so every field is reachable both ways.
// Split one back into field + direction here. Django 403s an unrecognised
// key (views.py:259-260); this falls back to the page's own default
// instead, matching the allowlist comments in adminLists.ts.
function parseSort<T extends string>(c: Context<AppEnv>, allowed: readonly T[], fallback: T): { sort: T; direction: "asc" | "desc"; signed: string } {
  const raw = c.req.query("sort") ?? "";
  const wantsDesc = raw.startsWith("-");
  const field = wantsDesc ? raw.slice(1) : raw;
  const sort: T = (allowed as readonly string[]).includes(field) ? (field as T) : fallback;
  const direction: "asc" | "desc" = field === sort && wantsDesc ? "desc" : "asc";
  return { sort, direction, signed: direction === "desc" ? `-${sort}` : sort };
}

// A sortable column header on one of those pages: the link target is the
// next sort (the active column flips, a fresh one starts ascending -- the
// two halves of Django's "Name" / "Name (Desc)" select options), while
// active/desc drive the arrow showing the order the list is actually in.
function sortableColumn(label: string, field: string, current: { sort: string; direction: "asc" | "desc" }): ListColumn {
  const active = field === current.sort;
  const desc = active && current.direction === "desc";
  return { label, sort: active && !desc ? `-${field}` : field, active, desc };
}

// A sortable header on the one list Django always sorts descending
// (orders(), views.py:382-383 `sort = "-%s" % (sort)`): the link carries
// the bare field name, the same value orders.html's own <select> offers,
// and the arrow is always down because there is no ascending order to
// reach.
function descOnlyColumn(label: string, field: string, currentSort: string): ListColumn {
  return { label, sort: field, active: field === currentSort, desc: true };
}

// gfadmin/views.py:261-270's display_sort_options rule: "_" -> " ", Python
// str.title(), and a " (Desc)" suffix on the "-" half of each pair.
function djangoSortLabel(option: string): string {
  const desc = option.startsWith("-");
  const words = (desc ? option.slice(1) : option).replace(/_/g, " ").replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  return desc ? `${words} (Desc)` : words;
}

// Django builds both directions of every field into the select
// (views.py:236-257 for foodbanks, :3030-3037 for places); same here, from
// the port's own allowlist.
function bothDirectionSortOptions(fields: readonly string[]): ListSortOption[] {
  return fields.flatMap((field) => [
    { value: field, label: djangoSortLabel(field) },
    { value: `-${field}`, label: djangoSortLabel(`-${field}`) },
  ]);
}

async function renderList<T>(
  c: Context<AppEnv>,
  opts: {
    title: string;
    section: string;
    page: PageResult<T>;
    sort?: string;
    sortOptions?: ListSortOption[];
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
    // Django names the thing being created on every list page's button
    // ("New Foodbank", foodbanks.html:14; "New ParlCon", politics.html:14;
    // "New Order Group", order_groups.html:10); the template falls back to
    // a bare "New" only when a caller supplies none.
    newLabel?: string;
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
    sort_options: opts.sortOptions?.map((opt) => ({ ...opt, selected: opt.value === opts.sort })),
    columns: opts.columns,
    rows: opts.page.rows.map((row) => ({ cells: opts.rowCells(row), actions: opts.rowActions ? opts.rowActions(row, csrfToken) : "" })),
    row_actions: !!opts.rowActions,
    new_url: opts.newUrl,
    new_label: opts.newLabel,
    csv_url: opts.csvUrl,
  });
  return c.html(html);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

// Timesince-formatted date cell, matching every Django list template's own
// "{{ value }}<br><span class=is-size-7>{{ value|timesince }} ago</span>"
// pattern -- Django's default DATETIME_FORMAT ("N j, Y, P", e.g. "Sept. 2,
// 2026, 3:34 p.m." -- what `{{ value }}` itself renders as for a datetime,
// USE_L10N/en locale, see packages/templates/src/filters.ts's djangoDate)
// on the first line, relative time (small) beneath.
function dateCell(value: string | null, now: Date): string {
  if (!value) return "";
  return `${escapeHtml(djangoDate(value, "N j, Y, P"))}<br><span class="is-size-7">${timesince(value, now)} ago</span>`;
}

// Plain Django-formatted date, no timesince line -- locations.html/
// donationpoints.html's own `{{ location.modified }}`/`{{ location.edited }}`
// columns (unlike foodbanks.html's dateCell()-style columns above).
function plainDateCell(value: string | null): string {
  return value ? escapeHtml(djangoDate(value, "N j, Y, P")) : "";
}

// gfadmin/views.py:234-314 foodbanks() -- excludes closed food banks,
// matching Django. Links each row to the foodbank's own admin detail page
// (WP 6.7), matching Django exactly -- this used to point at the edit
// form because the detail page didn't exist yet when this list was built
// (WP 6.5), a now-stale reason since WP 6.7 shipped it.
export async function adminFoodbanksList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const now = new Date();
  // views.py:258 `sort = request.GET.get("sort", "edited")` + :303
  // `.order_by(sort)` -- the raw key, so the default is `edited`
  // ASCENDING. See getFoodbanksPage's own comment: this page is the triage
  // queue, opened least-recently-edited first.
  const current = parseSort(c, FOODBANK_LIST_SORTS, "edited" as FoodbankListSort);
  const page = await getFoodbanksPage(db, current.sort, current.direction, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Foodbanks",
    section: "foodbanks",
    page,
    sort: current.signed,
    sortOptions: bothDirectionSortOptions(FOODBANK_LIST_SORTS),
    columns: [
      sortableColumn("Name", "name", current),
      sortableColumn("Postcode", "postcode", current),
      sortableColumn("Country", "country", current),
      { label: "Closed" },
      sortableColumn("Locations", "no_locations", current),
      sortableColumn("Donation Points", "no_donation_points", current),
      sortableColumn("Network", "network", current),
      sortableColumn("28d Hits", "hits_last_28_days", current),
      sortableColumn("Last Order", "last_order", current),
      sortableColumn("Last Need", "last_need", current),
      sortableColumn("Last Need Check", "last_need_check", current),
      sortableColumn("Created", "created", current),
      sortableColumn("Modified", "modified", current),
      sortableColumn("Edited", "edited", current),
    ],
    rowCells: (fb) => [
      `<a href="/admin/foodbank/${fb.slug}/">${escapeHtml(fb.name)}</a>`,
      escapeHtml(fb.postcode),
      escapeHtml(fb.country),
      fb.is_closed ? '<span style="color:red">X</span>' : "",
      String(fb.no_locations),
      String(fb.no_donation_points ?? 0),
      fb.network ? escapeHtml(fb.network) : "",
      intcomma(fb.hits_last_28_days), // foodbanks.html:56 `{{ foodbank.hits_last_28_days|intcomma }}`
      dateCell(fb.last_order, now),
      dateCell(fb.last_need, now),
      dateCell(fb.last_need_check, now),
      dateCell(fb.created, now),
      dateCell(fb.modified, now),
      dateCell(fb.edited, now),
    ],
    newUrl: "/admin/foodbank/new/",
    newLabel: "New Foodbank", // foodbanks.html:14
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

// gfadmin/views.py:361-366 foodbanks_next -- the check page's "Next"
// button, redirecting to the open foodbank with the oldest edited date
// (falling back to the foodbanks list itself, matching Django, if none
// exist at all -- an empty D1 table, not a realistic production state).
export async function adminFoodbanksNext(c: Context<AppEnv>): Promise<Response> {
  const slug = await getOldestEditedFoodbankSlug(dbSession(c));
  return c.redirect(slug ? `/admin/foodbank/${slug}/` : "/admin/foodbanks/", 302);
}

// gfadmin/views.py:2138-2220 locations()/donationpoints() -- both
// unbounded in Django (WP 6.6 research); paginated here, see
// adminLists.ts's own comment for why.
export async function adminLocationsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  // views.py:2146-2150 -- default `foodbank_name`, applied raw, so the page
  // opens A->Z by food bank name.
  const current = parseSort(c, LOCATION_LIST_SORTS, "foodbank_name" as LocationListSort);
  const page = await getLocationsPage(db, current.sort, current.direction, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Locations",
    section: "locations",
    page,
    sort: current.signed,
    // locations.html:18-21's own hardcoded option labels, plus the
    // descending half the column headers now reach.
    sortOptions: [
      { value: "foodbank_name", label: "Food Bank" },
      { value: "-foodbank_name", label: "Food Bank (Desc)" },
      { value: "name", label: "Name" },
      { value: "-name", label: "Name (Desc)" },
      { value: "parliamentary_constituency", label: "Parliamentary Constituency" },
      { value: "-parliamentary_constituency", label: "Parliamentary Constituency (Desc)" },
      { value: "edited", label: "Edited" },
      { value: "-edited", label: "Edited (Desc)" },
    ],
    columns: [
      sortableColumn("Foodbank", "foodbank_name", current),
      sortableColumn("Location", "name", current),
      { label: "Address" },
      sortableColumn("Parliamentary Constituency", "parliamentary_constituency", current),
      { label: "MP" },
      { label: "MP ID" },
      { label: "Network" },
      { label: "Country" },
      { label: "Closed" },
      { label: "Modified" },
      sortableColumn("Edited", "edited", current),
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
      // locations.html:51's bare `{{ location.is_closed }}` on a
      // BooleanField (givefood/models/foodbank.py:769) -- Django
      // stringifies the Python bool, so this column reads True/False.
      loc.is_closed ? "True" : "False",
      plainDateCell(loc.modified),
      plainDateCell(loc.edited),
    ],
  });
}

export async function adminDonationPointsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  // views.py:2227-2231 -- default `name`, applied raw, so the page opens
  // A->Z by donation point name.
  const current = parseSort(c, DONATION_POINT_LIST_SORTS, "name" as DonationPointListSort);
  const page = await getDonationPointsPage(db, current.sort, current.direction, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Donation Points",
    section: "donationpoints",
    page,
    sort: current.signed,
    // donationpoints.html:18-20's own hardcoded option labels, plus the
    // descending half the column headers now reach.
    sortOptions: [
      { value: "name", label: "Name" },
      { value: "-name", label: "Name (Desc)" },
      { value: "foodbank_name", label: "Food Bank" },
      { value: "-foodbank_name", label: "Food Bank (Desc)" },
      { value: "edited", label: "Edited" },
      { value: "-edited", label: "Edited (Desc)" },
    ],
    columns: [
      sortableColumn("Foodbank", "foodbank_name", current),
      sortableColumn("Location", "name", current),
      { label: "Address" },
      { label: "Company" },
      { label: "Store ID" },
      { label: "Network" },
      { label: "Country" },
      { label: "Closed" },
      { label: "Modified" },
      sortableColumn("Edited", "edited", current),
    ],
    rowCells: (dp) => [
      `<a href="/admin/foodbank/${dp.foodbank_slug}/">${escapeHtml(dp.foodbank_name)}</a>`,
      `<a href="/admin/foodbank/${dp.foodbank_slug}/donationpoint/${dp.slug}/edit/">${escapeHtml(dp.name)}</a>`,
      [dp.address, dp.postcode].filter((v): v is string => !!v).map(escapeHtml).join(" "),
      dp.company ? `<img src="/static/img/co/${dp.company_slug}.png" alt="${escapeHtml(dp.company)}" class="companyicon"> ${escapeHtml(dp.company)}` : "",
      dp.store_id ? escapeHtml(dp.store_id) : "",
      escapeHtml(dp.foodbank_network),
      dp.country ? escapeHtml(dp.country) : "",
      // donationpoints.html:56's bare `{{ donation_point.is_closed }}` on a
      // BooleanField (givefood/models/foodbank.py:1011) -- True/False, as
      // Django renders it.
      dp.is_closed ? "True" : "False",
      plainDateCell(dp.modified),
      plainDateCell(dp.edited),
    ],
  });
}

// gfadmin/views.py:2311-2321 politics().
export async function adminParlconsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const page = await getParlconsPage(db, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Parliamentary Constituencies",
    section: "settings",
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
    newLabel: "New ParlCon", // politics.html:14
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
    // orders.html:18-23's own hardcoded option labels. One direction only:
    // views.py:382-383 prepends "-" to whichever key is picked, so every
    // option on this page is descending and the headers below say so.
    sortOptions: [
      { value: "delivery_datetime", label: "Delivery Date" },
      { value: "created", label: "Created" },
      { value: "no_items", label: "Items" },
      { value: "weight", label: "Weight" },
      { value: "calories", label: "Calories" },
      { value: "cost", label: "Cost" },
    ],
    columns: [
      { label: "ID" },
      { label: "Foodbank" },
      { label: "Del. Prov. ID" },
      { label: "Country" },
      descOnlyColumn("Delivery", "delivery_datetime", sort),
      descOnlyColumn("Items", "no_items", sort),
      descOnlyColumn("Weight (kg)", "weight", sort),
      descOnlyColumn("Calories", "calories", sort),
      descOnlyColumn("Cost", "cost", sort),
      { label: "Delivered Cost" },
      descOnlyColumn("Created", "created", sort),
    ],
    rowCells: (o) => [
      `<a href="/admin/order/${encodeURIComponent(o.order_id)}/">${escapeHtml(o.order_id)}</a>`,
      o.foodbank_name && o.foodbank_slug ? `<a href="/admin/foodbank/${o.foodbank_slug}/">${escapeHtml(o.foodbank_name)}</a>` : "<em>Unassigned</em>",
      o.delivery_provider_id ? escapeHtml(o.delivery_provider_id) : "",
      escapeHtml(o.country),
      plainDateCell(o.delivery_datetime),
      String(o.no_items),
      // orders.html:57 chains `|intcomma|floatformat:2`; once intcomma has
      // inserted a separator floatformat can parse neither
      // Decimal("1,180.00") nor float("1,180.00") and returns "", so Django
      // blanks the Weight cell of any order of 1000 kg or more. toFixed(2)
      // then intcomma -- the order order_group.njk:8-15 already blessed for
      // this exact value, so the same order reads the same on both pages.
      intcomma(((o.weight / 1000) * ORDER_PACKAGING_WEIGHT_PC).toFixed(2)),
      intcomma(o.calories), // orders.html:58 `{{ order.calories|intcomma }}`
      `£${(o.cost / 100).toFixed(2)}`,
      o.actual_cost ? `£${(o.actual_cost / 100).toFixed(2)}` : "",
      plainDateCell(o.created),
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
//
// Two deliberate differences from places.html:28-33/37-44's six columns,
// so neither reads as an accident: Django's "Type" cell (`Place.type`,
// givefood/models/geo.py:27) has no D1 column after the §4.8.7 trim, and
// there is no per-row Edit button because PlaceForm is deferred (PLAN.md
// WP 6.5b) -- the /admin/place/<pk>/edit/ route it pointed at does not
// exist. The other four cells are Django's.
export async function adminPlacesList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const current = parseSort(c, PLACE_LIST_SORTS, "name" as PlaceListSort);
  const page = await getPlacesPage(db, current.sort, current.direction, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Places",
    section: "settings",
    page,
    sort: current.signed,
    sortOptions: bothDirectionSortOptions(PLACE_LIST_SORTS), // views.py:3030-3037's own six options
    columns: [
      sortableColumn("Name", "name", current),
      { label: "Lat,Lng" }, // places.html:30 -- not one of the view's sort_options
      sortableColumn("County", "county", current),
      sortableColumn("Population", "population", current),
    ],
    rowCells: (p) => [
      p.name ? escapeHtml(p.name) : "",
      p.lat_lng ? escapeHtml(p.lat_lng) : "",
      p.county ? escapeHtml(p.county) : "",
      p.population !== null ? intcomma(p.population) : "", // places.html:41 `{{ place.population|intcomma }}`
    ],
  });
}

// WP 6.9: gfadmin/views.py:2890-2980 subscriptions() -- see adminLists.ts's
// own comment on getSubscriptionsPage for why this is a UNION ALL, not an
// in-memory sort+paginate. "whatsapp" isn't a selectable `?type=` value --
// no whatsappsubscriber D1 table exists yet (same gap WP 6.4 disclosed).
const SUBSCRIPTION_TYPES: readonly SubscriptionType[] = ["all", "email", "mobile", "webpush"];

// gfadmin/views.py:2904/2943/2963 set 'type_emoji' to an mdi span --
// '<span class="mdi mdi-email"></span>', mdi-cellphone, mdi-bell -- and
// subscriptions.html:37 renders it with |safe, so the Type cell shows the
// same monochrome glyphs as every other admin surface (and as the port's
// own foodbankTabs.ts:126-135). The emoji in that template are only the
// filter <select> labels at :18-21, which SUBSCRIPTION_FILTER_OPTIONS
// below matches. mdi CSS is already loaded by admin/page.njk:7.
const SUBSCRIPTION_TYPE_ICON: Record<string, string> = {
  email: '<span class="mdi mdi-email"></span>',
  mobile: '<span class="mdi mdi-cellphone"></span>',
  webpush: '<span class="mdi mdi-bell"></span>',
};
const SUBSCRIPTION_FILTER_OPTIONS: { value: SubscriptionType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "email", label: "\u{1F4E7} Email" },
  { value: "mobile", label: "\u{1F4F1} Mobile" },
  { value: "webpush", label: "\u{1F514} WebPush" },
];

export async function adminSubscriptionsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const typeParam = c.req.query("type") ?? "all";
  const subType: SubscriptionType = (SUBSCRIPTION_TYPES as readonly string[]).includes(typeParam) ? (typeParam as SubscriptionType) : "all";
  const page = await getSubscriptionsPage(db, subType, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Subscriptions",
    section: "settings",
    page,
    // subscriptions.html:29-34's own header row and cell order -- the
    // identifier sits immediately beside the type, which is what an admin
    // is on this page to read.
    columns: [{ label: "Type" }, { label: "Identifier" }, { label: "Foodbank" }, { label: "Created" }],
    rowCells: (s) => [
      `${SUBSCRIPTION_TYPE_ICON[s.type] ?? ""} ${s.type.charAt(0).toUpperCase()}${s.type.slice(1)}`,
      escapeHtml(s.identifier),
      `<a href="/admin/foodbank/${s.foodbank_slug}/">${escapeHtml(s.foodbank_name)}</a>`,
      plainDateCell(s.created),
    ],
    // subscriptions.html:50 names the row in the confirm ("Delete
    // {{ subscription.identifier }}?"), the only thing distinguishing one
    // identical-looking Delete button from another. data-identifier +
    // this.dataset.identifier, never the value interpolated into the JS
    // string literal -- an identifier containing an apostrophe would
    // otherwise terminate it.
    rowActions: (s, csrfToken) =>
      `<form method="post" action="/admin/subscriptions/delete/" data-identifier="${escapeHtml(s.identifier)}"` +
      ` onsubmit="return confirm('Delete ' + this.dataset.identifier + '?')">` +
      `<input type="hidden" name="csrf_token" value="${csrfToken}">` +
      `<input type="hidden" name="type" value="${s.type}">` +
      `<input type="hidden" name="row_id" value="${escapeHtml(s.row_id)}">` +
      `<button type="submit" class="button is-small is-danger is-light">Delete</button></form>`,
    extra: {
      extra_query: `&type=${subType}`,
      filter_options: SUBSCRIPTION_FILTER_OPTIONS.map((opt) => ({ value: `?type=${opt.value}`, label: opt.label, selected: opt.value === subType })),
    },
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
    columns: [{ label: "Foodbank" }, { label: "Need" }],
    rowCells: (f) => [
      `<a href="/admin/foodbank/${f.slug}/">${escapeHtml(f.name)}</a>`,
      // foodbanks_without_need.html:17,22 -- header "Need", cell
      // `{{ foodbank.need.need_id_short }}` (needs.py:81-82,
      // `str(self.need_id)[:7]`), which is what an admin scans this column
      // for and what /admin/needs/ shows in its own ID column. Empty for a
      // food bank with no published need, because `None.need_id_short`
      // falls through to Django's unset string_if_invalid of "".
      f.latest_need_id ? `<a href="/admin/need/${f.latest_need_id}/">${escapeHtml(f.latest_need_id.slice(0, 7))}</a>` : "",
    ],
  });
}

// django's `|linebreaksbr` on an autoescaped value: escape first, then turn
// the newlines into <br>. Inline here rather than imported because list rows
// are assembled as raw HTML strings in this file, not rendered by nunjucks.
function linebreaksbrCell(value: string | null): string {
  return value ? escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>") : "";
}

// gfadmin/views.py:411-419 needs() + admin/needs.html -- the "Needs" navbar
// item's own page, which had no port at all (the navbar link pointed at the
// dashboard instead). Nine columns, matching Django exactly; paginated rather
// than Django's hard [:200] slice, see getNeedsPage's own comment.
export async function adminNeedsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const page = await getNeedsPage(db, parsePage(c), PAGE_SIZE);

  return renderList(c, {
    title: "Needs",
    section: "needs",
    page,
    columns: [
      { label: "Published?" },
      { label: "Input" },
      { label: "Cat?" },
      { label: "ID" },
      { label: "Foodbank" },
      { label: "Need" },
      { label: "Excess" },
      { label: "Created" },
      { label: "Modified" },
    ],
    rowCells: (n) => [
      n.published ? '<span style="color:green">&#10003;</span>' : '<span style="color:red">x</span>',
      inputMethodEmoji(n.input_method),
      n.is_categorised ? "\u{1FAA3}" : "", // bucket, matching needs.html's literal 🪣
      `<a href="/admin/need/${n.need_id}/">${escapeHtml(n.need_id.slice(0, 7))}</a>`,
      n.foodbank_slug && n.foodbank_name
        ? `<a href="/admin/foodbank/${n.foodbank_slug}/">${escapeHtml(n.foodbank_name)}</a>`
        : escapeHtml(n.foodbank_name ?? "Unknown"),
      `<span class="is-size-7">${linebreaksbrCell(n.change_text)}</span>`,
      `<span class="is-size-7">${linebreaksbrCell(n.excess_change_text)}</span>`,
      plainDateCell(n.created),
      plainDateCell(n.modified),
    ],
    csvUrl: "/admin/needs/csv/",
  });
}
