import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { adminOrderGroupDetail, adminOrderGroupForm, adminOrderGroupsList, managedDonationUrl } from "./orderGroup";
import { hmacSha256Hex } from "../../lib/hmac";
import { requireAdminAuth } from "../../middleware/adminAuth";
import type { AppEnv } from "../../types";

// The three Order Group admin pages, driven end to end: real Hono router, real
// handlers, real @givefood/db queries, real nunjucks templates, real CSRF, real
// parseAdminFields. NOTHING IS MOCKED IN THIS FILE, because nothing on these
// three routes leaves the machine -- no fetch, no queue send, no R2, no Google.
// That is unusual enough to say out loud: every assertion below is about what
// the shipped code does to a real SQLite database and to the HTML a browser
// receives, not about what a stub was asked to do.
//
// WHY THIS FORM AND NOT ANOTHER. Two bugs found in this admin in the last day
// set the bar for what a route test here has to prove:
//
//   #12 -- a duplicate name reached D1, SQLite raised, and the 500 page threw
//   away everything the admin had typed. So a refusal is never asserted as
//   "status 400" alone here; each one also asserts that NO ROW CHANGED and
//   states, in the test, exactly how much of the admin's typing survived.
//   (On this form: none of it. See the "refusals" block -- that divergence is
//   pinned as current behaviour, not fixed here.)
//
//   #34 -- a field was parsed, passed down, and written by no SQL at all; the
//   redirect looked identical to a save. So every POST test below reads the
//   row back out of SQLite and asserts its columns, and the round-trip test
//   goes further: it re-opens the edit form and pulls the values out of the
//   rendered <input> tags, which is the only way to prove a value survived
//   BOTH halves of the trip.
//
// THE COLUMN MOST WORTH GUARDING on this model is `key`. It is a capability
// token that is already inside donor-facing /donate/managed/<slug>-<key>/ URLs
// people have been handed, and orderGroup.ts:225 exists because a blank key
// field once became NULL, hit the generator, and silently reissued it --
// breaking every link already in circulation with no error anywhere. There is
// a test for that line, and one for each of the ways round it.
//
// packages/db/src/orderGroupAdmin.test.ts already pins the SQL underneath
// (which rows, in which order, with which values, mutation-tested twice), so
// this file deliberately does not re-litigate the queries. It tests the things
// that only exist at the route: the aggregates the detail page computes in
// JavaScript, the key rules, the paginated list's HTML, CSRF, auth, and the
// fact that a GET never writes.

// ---------------------------------------------------------------------------
// A reduced transcription of the migrations -- the same convention as this
// directory's other route suites (donationPoint.test.ts, foodbankLocation
// .test.ts), which build the tables they need rather than loading all of
// packages/db/migrations.
//
// `ordergroup` is 0015_ordergroup.sql:41-50 VERBATIM, unique index included.
// The index is load-bearing: without it a missing collision pre-check would
// quietly write a second row with the same slug instead of being refused, and
// every "refuses the duplicate" test here would pass against code that
// refuses nothing.
//
// `orders` and `foodbank` are trimmed to the columns getOrderGroupOrders
// actually names (0005_orders_and_charity.sql:19-35 and 0001_core.sql:10-55
// respectively), because the detail page's six totals are summed from those
// rows in JavaScript and nothing else on these routes touches either table.
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE ordergroup (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  key TEXT,
  created TEXT NOT NULL,
  modified TEXT NOT NULL
);
CREATE UNIQUE INDEX ordergroup_slug_uniq ON ordergroup(slug);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL,
  delivery_datetime TEXT NOT NULL,
  weight INTEGER NOT NULL, calories INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  no_items INTEGER NOT NULL,
  foodbank_id INTEGER, order_group_id INTEGER
);
CREATE INDEX order_ordergroup_idx ON orders(order_group_id) WHERE order_group_id IS NOT NULL;

CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL
);
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The D1 Sessions surface packages/db uses, over node:sqlite. Copied from
// foodbankLocation.test.ts; D1's asynchrony is the only difference that
// matters, since the SQL text, the binding and the NULL semantics are
// SQLite's on both sides.
function d1Session(db: DatabaseSync): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "b".repeat(64);

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let env: AppEnv["Bindings"];
let app: Hono<AppEnv>;
let csrfCookie: string;

interface GroupRow {
  id: number;
  name: string;
  slug: string;
  public: number;
  key: string | null;
  created: string;
  modified: string;
}

function allGroups(): GroupRow[] {
  return db.prepare("SELECT id, name, slug, public, key, created, modified FROM ordergroup ORDER BY id").all() as never;
}

function groupBySlug(slug: string): GroupRow | undefined {
  return db.prepare("SELECT id, name, slug, public, key, created, modified FROM ordergroup WHERE slug = ?").get(slug) as never;
}

function seedGroup(row: { id: number; name: string; slug: string; public?: number; key?: string | null; created?: string; modified?: string }) {
  db.prepare("INSERT INTO ordergroup (id, name, slug, public, key, created, modified) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.name,
    row.slug,
    row.public ?? 0,
    row.key ?? null,
    row.created ?? "2024-03-05 14:30:00.000000",
    row.modified ?? "2024-03-05 14:30:00.000000",
  );
}

function seedOrder(row: {
  id: number;
  orderId: string;
  groupId: number | null;
  foodbankId: number | null;
  deliveryDatetime: string;
  weight: number;
  calories: number;
  cost: number;
  noItems: number;
  created?: string;
}) {
  db.prepare(
    `INSERT INTO orders (id, order_id, created, modified, delivery_datetime, weight, calories, cost, no_items, foodbank_id, order_group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.orderId,
    row.created ?? "2024-01-01 09:00:00.000000",
    "2024-01-01 09:00:00.000000",
    row.deliveryDatetime,
    row.weight,
    row.calories,
    row.cost,
    row.noItems,
    row.foodbankId,
    row.groupId,
  );
}

interface Result {
  res: Response;
  html: string;
}

// Every request carries the SAME signed CSRF cookie, so issueCsrfToken takes
// its reuse path (csrf.ts:82-93) and the token rendered into each form is
// CSRF_RAW -- which is what makes "open the edit form, submit exactly what it
// gave back" possible below without scraping a fresh token per request.
async function request(path: string, init?: RequestInit): Promise<Result> {
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { Cookie: csrfCookie, ...(init?.headers ?? {}) },
    }),
    env,
    execCtx,
  );
  // A redirect has no body worth reading, and a Response body can only be
  // consumed once.
  const html = res.status === 302 ? "" : await res.text();
  return { res, html };
}

function get(path: string): Promise<Result> {
  return request(path);
}

function post(path: string, fields: Record<string, string>, overrides?: { token?: string | null; origin?: string; cookie?: string }): Promise<Result> {
  const body: Record<string, string> = { ...fields };
  const token = overrides?.token === undefined ? CSRF_RAW : overrides.token;
  if (token !== null) body.csrf_token = token;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: overrides?.origin ?? ORIGIN,
    "Sec-Fetch-Site": "same-origin",
  };
  if (overrides?.cookie !== undefined) headers.Cookie = overrides.cookie;
  return request(path, { method: "POST", headers, body: new URLSearchParams(body).toString() });
}

// ---------------------------------------------------------------------------
// Reading values back OUT of the rendered form, rather than out of the render
// context. The context is what the handler intended; these tags are what the
// browser will actually re-submit, and the gap between the two is where a
// value gets lost without anyone noticing (issue #34's whole shape). The
// markup matched here is admin/includes/formfields.njk's, exactly.
// ---------------------------------------------------------------------------
function decodeEntities(value: string): string {
  return value
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&pound;/g, "£")
    .replace(/&amp;/g, "&");
}

function inputValue(html: string, name: string): string | null {
  const match = html.match(new RegExp(`<input class="input" type="[a-z]+" id="id_${name}" name="${name}" value="([^"]*)"`));
  return match ? decodeEntities(match[1]!) : null;
}

function checkboxChecked(html: string, name: string): boolean {
  const match = html.match(new RegExp(`<input type="checkbox" id="id_${name}" name="${name}" value="1"( checked)?>`));
  if (!match) throw new Error(`no checkbox rendered for ${name}`);
  return match[1] !== undefined;
}

// What a browser would POST from the form the handler just rendered: the two
// text inputs, plus `public` only when its box came back ticked (an unticked
// checkbox is ABSENT from the body, and that absence is its false state).
function browserWouldSubmit(html: string, edits: Record<string, string> = {}): Record<string, string> {
  const body: Record<string, string> = {
    name: inputValue(html, "name") ?? "",
    key: inputValue(html, "key") ?? "",
  };
  if (checkboxChecked(html, "public")) body.public = "1";
  return { ...body, ...edits };
}

// One `<dt>term</dt><dd>value</dd>` pair out of the detail page's stats list.
// Matched with \s* rather than the literal indentation so that reformatting
// order_group.njk cannot fail a test about arithmetic.
function dlValue(html: string, term: string): string | null {
  const match = html.match(new RegExp(`<dt>${term}</dt>\\s*<dd>([\\s\\S]*?)</dd>`));
  return match ? decodeEntities(match[1]!.trim()) : null;
}

function cellsOf(row: string): string[] {
  return (row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) ?? []).map((cell) => cell.replace(/^<td[^>]*>|<\/td>$/g, "").trim());
}

// The table's column headings, whitespace collapsed -- list.njk wraps each in
// a sort-link conditional, so the labels are several lines deep in the markup
// and cannot be matched literally.
function columnHeaders(html: string): string[] {
  const thead = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
  return (thead.match(/<th>([\s\S]*?)<\/th>/g) ?? []).map((th) => th.replace(/^<th>|<\/th>$/g, "").trim());
}

// Which admin nav item page.njk:43-50 drew as `is-active`. Exactly one is,
// and it is driven solely by the `section` string the handler passes to
// adminPageContext.
function activeNavItems(html: string): string[] {
  return Array.from(html.matchAll(/<a class="navbar-item is-active" href="([^"]+)"/g), (m) => m[1]!);
}

// The hidden field generic_form.njk renders from the render context's
// csrf_token, i.e. the token the browser will actually send back.
function formToken(html: string): string | null {
  return html.match(/<input type="hidden" name="csrf_token" value="([^"]*)">/)?.[1] ?? null;
}

// The <td> that orderGroupPublicCell() produced, read back out of the list
// page. The cells go through `{{ cell | safe }}`, so what the handler built is
// in the HTML verbatim -- which is also why the escaping test below matters.
function publicCells(html: string): string[] {
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  return rows.filter((row) => row.includes("/admin/order-group/")).map((row) => cellsOf(row)[2] ?? "");
}

// One order's row from the detail page's table, by its order id.
function orderRow(html: string, orderId: string): string[] {
  const row = (html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []).find((candidate) => candidate.includes(`/admin/order/${orderId}/`));
  if (!row) throw new Error(`no table row for order ${orderId}`);
  return cellsOf(row).map(decodeEntities);
}

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);

  env = {
    DB: { withSession: () => d1Session(db) },
    CSRF_SECRET,
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
  } as unknown as AppEnv["Bindings"];

  csrfCookie = `__Host-csrf=${CSRF_RAW}.${await hmacSha256Hex(CSRF_SECRET, CSRF_RAW)}`;

  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    c.set("adminUser", { email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "" });
    await next();
  });
  // The production registrations, verbatim from routes/admin/index.ts:249-254
  // (adminApp is mounted at /admin). Create and edit are the SAME handler,
  // distinguished only by whether :slug matched, so a hand-built Context would
  // let a change in how that distinction is drawn slip through unnoticed.
  app.get("/admin/order-groups/", adminOrderGroupsList);
  app.get("/admin/order-groups/new/", adminOrderGroupForm);
  app.post("/admin/order-groups/new/", adminOrderGroupForm);
  app.get("/admin/order-group/:slug/", adminOrderGroupDetail);
  app.get("/admin/order-group/:slug/edit/", adminOrderGroupForm);
  app.post("/admin/order-group/:slug/edit/", adminOrderGroupForm);
  // Labelled rather than left to become an unhandled rejection, so a
  // regression reads as "expected 400, got 500: UNIQUE constraint failed"
  // instead of a vitest crash. That 500 is issue #12's exact signature.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
});

// ---------------------------------------------------------------------------
describe("managedDonationUrl", () => {
  it("builds the donor-facing URL Django reverses as `managed_donation`", () => {
    expect(managedDonationUrl("ocado-bulk", "k7mfp2xq")).toBe("/donate/managed/ocado-bulk-k7mfp2xq/");
  });

  // THE WHOLE REASON THIS IS A FUNCTION and not an inline f-string. Django
  // reverses this URL unconditionally inside `{% if public %}`, so a public
  // group with a NULL key reverses to the literal "None" (a dead donor link
  // nobody can tell from a live one) and a blank key raises NoReverseMatch,
  // 500ing the entire list page rather than one row. Returning null lets both
  // callers render the tick with no anchor.
  it("returns null rather than a dead link when there is no key", () => {
    expect(managedDonationUrl("ocado-bulk", null)).toBeNull();
  });

  // givefood/urls.py:38's `<slug:slug>-<slug:key>` is split on the LAST
  // hyphen, so a key that could carry one would resolve to the wrong pair.
  // KEY_RE forbids that on the way in; this pins the other half -- that the
  // pieces are percent-encoded, so nothing typed into either field can inject
  // a `/` or a `?` into the path a donor is given.
  it("percent-encodes both halves", () => {
    expect(managedDonationUrl("a/b", "k")).toBe("/donate/managed/a%2Fb-k/");
    expect(managedDonationUrl("g", "x?y")).toBe("/donate/managed/g-x%3Fy/");
  });
});

// ---------------------------------------------------------------------------
describe("adminOrderGroupsList", () => {
  it("lists newest first, as Django's .order_by('-created') does", async () => {
    seedGroup({ id: 1, name: "Oldest Group", slug: "oldest-group", created: "2023-01-01 09:00:00.000000" });
    seedGroup({ id: 2, name: "Newest Group", slug: "newest-group", created: "2025-06-01 09:00:00.000000" });
    seedGroup({ id: 3, name: "Middle Group", slug: "middle-group", created: "2024-01-01 09:00:00.000000" });

    const { res, html } = await get("/admin/order-groups/");

    expect(res.status).toBe(200);
    // Positions, not presence: a list that returned every row in insertion
    // order would satisfy three `toContain`s and still be the wrong page.
    expect(html.indexOf("Newest Group")).toBeLessThan(html.indexOf("Middle Group"));
    expect(html.indexOf("Middle Group")).toBeLessThan(html.indexOf("Oldest Group"));
    expect(html).toContain("Order Groups (3)");
  });

  // PAGE_SIZE is 100 and Django paginates nothing at all here, so the only way
  // to prove the page bound is real is to seed past it and assert the row that
  // must be EXCLUDED is absent. A LIMIT that silently stopped applying would
  // pass any test that only seeded matching rows.
  it("bounds the page at 100 rows and keeps the 101st off page one", async () => {
    for (let i = 1; i <= 101; i++) {
      const n = String(i).padStart(3, "0");
      // Strictly DECREASING created, so "Group 001" is the newest and
      // "Group 101" is the one the page bound pushes onto page two. The
      // microseconds field carries the ordering because these are the shape
      // pyNow() writes and the column is compared as text.
      seedGroup({ id: i, name: `Group ${n}`, slug: `group-${n}`, created: `2024-01-01 09:00:00.${String(999000 - i * 1000).padStart(6, "0")}` });
    }

    const first = await get("/admin/order-groups/");
    expect(first.html).toContain("Order Groups (101)");
    expect(first.html).toContain("Group 001");
    expect(first.html).toContain("Group 100");
    expect(first.html).not.toContain("Group 101");

    const second = await get("/admin/order-groups/?page=2");
    expect(second.html).toContain("Group 101");
    expect(second.html).not.toContain("Group 100");
  });

  // THE PAGINATOR'S OWN CONTROLS, which the row assertions above do not touch.
  // Mutation-tested, and both mutants survived this file until this test
  // existed:
  //
  //   `has_next: false` -- list.njk:98 disables the Next anchor and renders no
  //   href, but the numbered list below it still emits `?page=2`, so a bare
  //   `toContain('href="?page=2"')` passes against a paginator whose Next
  //   button is dead. On a two-page list that is survivable; on the 11-page
  //   food bank list the same template serves, it is not.
  //
  //   `page: 1` (the current page pinned instead of passed through) -- page
  //   two would render page two's ROWS while highlighting "1" as current and
  //   pointing Previous at ?page=0, which parsePage then bounces back to page
  //   one. Every row assertion above still passes.
  it("wires the paginator's Next, Previous and current-page marker to the page it served", async () => {
    for (let i = 1; i <= 101; i++) {
      const n = String(i).padStart(3, "0");
      seedGroup({ id: i, name: `Group ${n}`, slug: `group-${n}`, created: `2024-01-01 09:00:00.${String(999000 - i * 1000).padStart(6, "0")}` });
    }

    const first = await get("/admin/order-groups/");
    expect(first.html).toContain('<a class="pagination-next" href="?page=2">Next</a>');
    expect(first.html).toContain('<a class="pagination-previous" disabled>Previous</a>');
    expect(first.html).toContain('aria-label="Page 1" aria-current="page">1</a>');

    const second = await get("/admin/order-groups/?page=2");
    // The last page: Next is disabled rather than offering a page three that
    // would render empty.
    expect(second.html).toContain('<a class="pagination-next" disabled>Next</a>');
    expect(second.html).toContain('<a class="pagination-previous" href="?page=1">Previous</a>');
    expect(second.html).toContain('aria-label="Page 2" aria-current="page">2</a>');
  });

  // order_groups.html:18-21's three headings, in Django's order. The handler
  // builds `columns` and the row cells in two separate places, so relabelling
  // or reordering one without the other is a silent mislabel: the empty-list
  // test's colspan still adds up and every cell assertion still passes,
  // because those match on cell CONTENT and never on which heading sits above
  // it. (Mutant: "Public?" -> "Public".)
  it("labels the three columns as Django's template does", async () => {
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk" });

    // The fourth is list.njk's empty <th> above the row-actions column.
    expect(columnHeaders((await get("/admin/order-groups/")).html)).toEqual(["Name", "Created", "Public?", ""]);
  });

  // parsePage's guard. A `page=0` reaching the query unmodified would bind
  // OFFSET -100, and `page=abc` would bind OFFSET NaN -- neither of which is
  // an error SQLite reports, both of which are a blank list page.
  it.each(["0", "-3", "abc", "", "1.9"])("falls back to page 1 for ?page=%s", async (raw) => {
    seedGroup({ id: 1, name: "Only Group", slug: "only-group" });

    const { res, html } = await get(`/admin/order-groups/?page=${encodeURIComponent(raw)}`);

    expect(res.status).toBe(200);
    expect(html).toContain("Only Group");
  });

  // order_groups.html:27-32 -- a tick plus a Link when public, and NOTHING at
  // all when not (this page has no red cross, unlike the detail page's own
  // Public row). The middle case is the port's fix: a tick with no anchor
  // where Django would have rendered a link to ".../None/" or 500ed the
  // entire list on NoReverseMatch.
  it("renders the three states of the Public? cell", async () => {
    seedGroup({ id: 1, name: "Public With Key", slug: "public-with-key", public: 1, key: "k7mfp2xq", created: "2025-03-03 09:00:00.000000" });
    seedGroup({ id: 2, name: "Public No Key", slug: "public-no-key", public: 1, key: null, created: "2025-02-02 09:00:00.000000" });
    seedGroup({ id: 3, name: "Private Group", slug: "private-group", public: 0, key: "unused12", created: "2025-01-01 09:00:00.000000" });

    const cells = publicCells((await get("/admin/order-groups/")).html);

    expect(cells).toEqual([
      '<span style="color:green">&#10003;</span> <a href="/donate/managed/public-with-key-k7mfp2xq/">Link</a>',
      '<span style="color:green">&#10003;</span>',
      "",
    ]);
  });

  // The list's cells are handed to the template through `{{ cell | safe }}`,
  // which turns nunjucks's autoescaping OFF for them -- so escapeHtml() in the
  // handler is the ONLY thing standing between an admin-typed group name and
  // stored XSS on a page every admin visits. Deleting that call leaves every
  // other test in this file green.
  it("escapes the group name it puts inside the anchor", async () => {
    seedGroup({ id: 1, name: 'M&S <script>alert("x")</script>', slug: "ms-scriptalertxscript" });

    const { html } = await get("/admin/order-groups/");

    expect(html).toContain("M&amp;S &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(");
  });

  it("links each row to its detail page and its edit form", async () => {
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk" });

    const { html } = await get("/admin/order-groups/");

    expect(html).toContain('<a href="/admin/order-group/ocado-bulk/">Ocado Bulk</a>');
    expect(html).toContain('<a href="/admin/order-group/ocado-bulk/edit/" class="button is-small is-light">Edit</a>');
    // order_groups.html:10 names the thing being created; list.njk falls back
    // to a bare "New" only when a caller supplies no label.
    expect(html).toContain('<a href="/admin/order-groups/new/" class="button is-link is-light">New Order Group</a>');
  });

  // The slug goes into two hrefs per row, and both are built by string
  // interpolation into markup that `{{ cell | safe }}` then renders unescaped.
  // Every slug this port WRITES comes out of slugify() and needs no encoding,
  // which is exactly why dropping encodeURIComponent() survives every other
  // test here (mutant: `${g.slug}`) -- but the column is a bare `slug TEXT`
  // (0015_ordergroup.sql:44) holding rows imported from Django, where slugify
  // was never enforced on the way in, and a space or a `?` there would break
  // the anchor out of its own attribute. Percent-encoded instead, the same
  // guarantee managedDonationUrl gives the donor-facing URL.
  it("percent-encodes the slug it interpolates into the row's links", async () => {
    seedGroup({ id: 1, name: "Legacy Import", slug: "a b?c" });

    const { html } = await get("/admin/order-groups/");

    expect(html).toContain('<a href="/admin/order-group/a%20b%3Fc/">Legacy Import</a>');
    expect(html).toContain('<a href="/admin/order-group/a%20b%3Fc/edit/"');
  });

  // Django's bare `{{ order_group.created }}`, i.e. DATETIME_FORMAT "N j, Y,
  // P" -- AP-style month ("March", not "Mar") and Django's own a.m./p.m.
  // spelling, which is what plainDateCell exists to reproduce.
  it("renders created in Django's DATETIME_FORMAT", async () => {
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk", created: "2024-03-05 14:30:00.000000" });

    expect((await get("/admin/order-groups/")).html).toContain("March 5, 2024, 2:30 p.m.");
  });

  it("renders an empty list without a paginator", async () => {
    const { res, html } = await get("/admin/order-groups/");

    expect(res.status).toBe(200);
    expect(html).toContain("Order Groups (0)");
    // Three declared columns plus the row-actions column.
    expect(html).toContain('<td colspan="4">None</td>');
    // total_pages is max(1, ...), so a single-page list renders no nav at all
    // -- as Django's `{% if page_obj.has_other_pages %}` does not.
    expect(html).not.toContain("pagination-list");
  });

  // Several handlers in this admin serve a GET and a POST from one function.
  // This one does not, but the list shares a database with two that do, and a
  // read path that writes is the kind of thing nobody looks for until a row
  // count moves on its own.
  it("writes nothing", async () => {
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk" });
    const before = allGroups();

    await get("/admin/order-groups/");

    expect(allGroups()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
describe("adminOrderGroupDetail", () => {
  // The rows the detail page is about, plus rows it must leave alone. Every
  // aggregate on the page is summed in JavaScript from exactly what
  // getOrderGroupOrders returns (matching Django's own per-row loop at
  // views.py:2790-2795), so a filter that leaked would not error -- it would
  // print a bigger number.
  function seedDetailFixture() {
    db.prepare("INSERT INTO foodbank (id, name, slug) VALUES (?, ?, ?)").run(1, "Salisbury Foodbank", "salisbury");
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk", public: 1, key: "k7mfp2xq" });
    seedGroup({ id: 2, name: "Other Group", slug: "other-group" });

    // In the group, deliberately inserted newest-delivery-first so that an
    // ORDER BY that stopped applying is visible in the rendered table.
    seedOrder({ id: 1, orderId: "later-order", groupId: 1, foodbankId: 1, deliveryDatetime: "2024-05-02 10:00:00", weight: 2500, calories: 2000, cost: 25000, noItems: 7 });
    seedOrder({ id: 2, orderId: "first-order", groupId: 1, foodbankId: 1, deliveryDatetime: "2024-05-01 10:00:00", weight: 1000, calories: 1000, cost: 100000, noItems: 3 });
    // In the group but with no food bank -- getOrderGroupOrders LEFT JOINs for
    // exactly this row, and an INNER JOIN would drop it from the table AND
    // from all six totals without any other symptom.
    seedOrder({ id: 3, orderId: "orphan-order", groupId: 1, foodbankId: null, deliveryDatetime: "2024-05-03 10:00:00", weight: 500, calories: 500, cost: 5000, noItems: 1 });
    // MUST BE EXCLUDED: another group's order, and an order in no group at
    // all (the overwhelming majority of the 1,050 production orders).
    seedOrder({ id: 4, orderId: "other-groups-order", groupId: 2, foodbankId: 1, deliveryDatetime: "2024-05-04 10:00:00", weight: 9000, calories: 9000, cost: 900000, noItems: 99 });
    seedOrder({ id: 5, orderId: "ungrouped-order", groupId: null, foodbankId: 1, deliveryDatetime: "2024-05-05 10:00:00", weight: 8000, calories: 8000, cost: 800000, noItems: 88 });
  }

  it("404s on a slug no group has, like get_object_or_404", async () => {
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk" });

    expect((await get("/admin/order-group/no-such-group/")).res.status).toBe(404);
  });

  it("shows only this group's orders, oldest delivery first", async () => {
    seedDetailFixture();

    const { res, html } = await get("/admin/order-group/ocado-bulk/");

    expect(res.status).toBe(200);
    expect(html.indexOf("first-order")).toBeLessThan(html.indexOf("later-order"));
    expect(html.indexOf("later-order")).toBeLessThan(html.indexOf("orphan-order"));
    expect(html).not.toContain("other-groups-order");
    expect(html).not.toContain("ungrouped-order");
  });

  // The six totals, against numbers chosen so that a leak of either excluded
  // order above would change every one of them.
  it("totals the rows it renders, with Django's packaging multiplier", async () => {
    seedDetailFixture();

    const { html } = await get("/admin/order-group/ocado-bulk/");

    expect(dlValue(html, "Orders")).toBe("3");
    expect(dlValue(html, "Items")).toBe("11");
    // (1000 + 2500 + 500)g -> 4kg, x1.18 for packaging
    // (givefood/const/general.py:136, Order.weight_kg_pkg()). floatformat(2)
    // BEFORE intcomma, which is what stops the raw float repr Django's own
    // template leaks here -- the sum really is 4.720000000000001 in binary
    // floating point, and Django prints that verbatim.
    expect(dlValue(html, "Weight")).toBe("4.72kg");
    expect(dlValue(html, "Calories")).toBe("3,500");
    // 130000 pence, divided by the handler and separated by the template.
    // Either excluded order leaking in (900000 or 800000 pence) would be
    // unmissable, which is the point of choosing these numbers.
    expect(dlValue(html, "Cost")).toBe("£1,300.00");
  });

  // THE PER-ROW HALF, and a #34-shaped hazard in its own right: weight_kg_pkg
  // and cost_gbp are computed in the handler under names the database does not
  // have, so dropping or renaming either leaves nunjucks rendering an empty
  // <td> (env.ts pins throwOnUndefined: false) while all six totals above stay
  // exactly right. The table would simply have two blank columns and no error
  // anywhere.
  it("renders each order's own weight and cost, not just the group totals", async () => {
    seedDetailFixture();

    const cells = orderRow((await get("/admin/order-group/ocado-bulk/")).html, "first-order");

    // ID, Foodbank, Delivery, Items, Weight (kg), Calories, Cost, Created.
    expect(cells[2]).toBe("May 1, 2024, 10 a.m.");
    expect(cells[3]).toBe("3");
    expect(cells[4]).toBe("1.18"); // 1000g x 1.18 packaging
    expect(cells[5]).toBe("1,000");
    expect(cells[6]).toBe("£1,000.00"); // 100000 pence
  });

  it("renders an order with no food bank as Unassigned rather than dropping it", async () => {
    seedDetailFixture();

    const { html } = await get("/admin/order-group/ocado-bulk/");

    expect(html).toContain("<em>Unassigned</em>");
    expect(html).toContain('<a href="/admin/foodbank/salisbury/">Salisbury Foodbank</a>');
  });

  it("links the donor URL when the group is public and has a key", async () => {
    seedDetailFixture();

    const { html } = await get("/admin/order-group/ocado-bulk/");

    expect(html).toContain('<a href="/donate/managed/ocado-bulk-k7mfp2xq/">Link</a>');
    expect(html).toContain('<span style="color:green">&#10003;</span>');
  });

  // Unlike the list page, the detail page DOES render a red cross for a
  // private group -- order_group.njk:51, matching Django's own template. The
  // two pages disagreeing about how "not public" looks is Django's behaviour,
  // kept rather than tidied.
  //
  // Note for anyone mutation-testing this handler: dropping the `group.public
  // ?` guard on `public_url` (orderGroup.ts:182) survives this test, and
  // correctly so -- order_group.njk:43-49 renders the anchor only inside its
  // own `{% if order_group.public %}`, so the handler's guard is the second of
  // two and changes no byte of output. That is an equivalent mutant, not a
  // gap: the assertion below is the one that would catch it the moment the
  // template stopped guarding.
  it("renders a red cross for a private group", async () => {
    seedGroup({ id: 1, name: "Private Group", slug: "private-group", public: 0, key: "unused12" });

    const { html } = await get("/admin/order-group/private-group/");

    expect(html).toContain('<span style="color:red">&#10007;</span>');
    expect(html).not.toContain("/donate/managed/");
  });

  // The same NoReverseMatch/"None" hazard as the list page, on the page that
  // shows one group at a time: tick, no anchor.
  it("renders no donor link for a public group with no key", async () => {
    seedGroup({ id: 1, name: "Public No Key", slug: "public-no-key", public: 1, key: null });

    const { html } = await get("/admin/order-group/public-no-key/");

    expect(html).toContain('<span style="color:green">&#10003;</span>');
    expect(html).not.toContain("/donate/managed/");
  });

  it("shows a group with no orders as zeroes rather than blanks", async () => {
    seedGroup({ id: 1, name: "Empty Group", slug: "empty-group" });

    const { res, html } = await get("/admin/order-group/empty-group/");

    expect(res.status).toBe(200);
    expect(dlValue(html, "Orders")).toBe("0");
    // "0.00kg", not "0kg" or "" -- floatformat runs on a JavaScript number, so
    // a zero total is the case where a missing filter is invisible everywhere
    // else on this page.
    expect(dlValue(html, "Weight")).toBe("0.00kg");
    expect(dlValue(html, "Cost")).toBe("£0.00");
    expect(html).toContain('<td colspan="8">None</td>');
  });

  it("writes nothing", async () => {
    seedDetailFixture();
    const before = allGroups();
    const ordersBefore = db.prepare("SELECT * FROM orders ORDER BY id").all();

    await get("/admin/order-group/ocado-bulk/");

    expect(allGroups()).toEqual(before);
    expect(db.prepare("SELECT * FROM orders ORDER BY id").all()).toEqual(ordersBefore);
  });
});

// ---------------------------------------------------------------------------
describe("adminOrderGroupForm -- GET", () => {
  it("renders the create form with the three editable fields and no delete button", async () => {
    const { res, html } = await get("/admin/order-groups/new/");

    expect(res.status).toBe(200);
    expect(html).toContain("<h2>New Order Group</h2>");
    // givefood/forms.py:225-228's `fields = "__all__"` on OrderGroup yields
    // exactly these three: slug/created/modified are editable=False and
    // Django never renders them either.
    expect(html).toContain('id="id_name"');
    expect(html).toContain('id="id_public"');
    expect(html).toContain('id="id_key"');
    expect(html).not.toContain('id="id_slug"');
    // Django has no order_group delete view at all (gfadmin/urls/orders.py:
    // 16-19), and deleting a group would orphan every orders.order_group_id
    // pointing at it -- there is no FK to cascade or restrain it.
    expect(html).not.toContain("Delete");
    expect(html).toContain(`<input type="hidden" name="csrf_token" value="${CSRF_RAW}">`);
  });

  // DELIBERATE DIVERGENCE, pinned so that "fixing" it back would be a visible
  // decision: views.py:2826 unconditionally reassigns page_title = "New Order
  // Group" inside the GET branch, so Django's EDIT form is ALWAYS titled "New
  // Order Group" and only a failed POST ever shows an edit title.
  it("titles the edit form with the group's name, where Django says 'New Order Group'", async () => {
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk" });

    const { res, html } = await get("/admin/order-group/ocado-bulk/edit/");

    expect(res.status).toBe(200);
    expect(html).toContain("<h2>Edit Ocado Bulk</h2>");
  });

  // THE STATE A NULL COLUMN HAS TO SURVIVE. nunjucks renders null into a value
  // attribute as "" (env.ts pins throwOnUndefined: false for exactly that), and
  // "" is what the key rules read as "leave it alone". If it ever rendered the
  // literal "null" instead, the admin's next Save would submit "null" -- which
  // KEY_RE happily accepts, four letters, no hyphens -- and every published
  // group would quietly acquire /donate/managed/<slug>-null/ as its donor URL.
  it("renders a NULL key as an empty box, never the string 'null'", async () => {
    seedGroup({ id: 1, name: "Private Group", slug: "private-group", public: 0, key: null });

    const { html } = await get("/admin/order-group/private-group/edit/");

    expect(inputValue(html, "key")).toBe("");
    expect(checkboxChecked(html, "public")).toBe(false);
  });

  it("404s the edit form for a slug no group has", async () => {
    expect((await get("/admin/order-group/no-such-group/edit/")).res.status).toBe(404);
  });

  it("neither the create nor the edit form writes anything", async () => {
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk" });
    const before = allGroups();

    await get("/admin/order-groups/new/");
    await get("/admin/order-group/ocado-bulk/edit/");
    await get("/admin/order-groups/new/?name=Sneaky");

    expect(allGroups()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
describe("adminOrderGroupForm -- create", () => {
  // ISSUE #34's LESSON, applied: a redirect is not evidence of a save. The
  // row is read back out of SQLite and every column asserted, including the
  // slug the handler never sees (upsertOrderGroup derives it) and the two
  // timestamps TimestampedModel sets.
  it("writes the row and redirects where Django's `redirect(\"admin:order_groups\")` goes", async () => {
    const { res } = await post("/admin/order-groups/new/", { name: "Ocado Bulk", public: "1", key: "k7mfp2xq" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/order-groups/");

    const rows = allGroups();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Ocado Bulk");
    expect(rows[0]!.slug).toBe("ocado-bulk");
    expect(rows[0]!.public).toBe(1);
    expect(rows[0]!.key).toBe("k7mfp2xq");
    // TimestampedModel (givefood/models/base.py:12-19): auto_now_add and
    // auto_now, written in Django's own `str(datetime)` shape rather than an
    // ISO string, because that is what every other row in this database holds.
    expect(rows[0]!.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(rows[0]!.modified).toBe(rows[0]!.created);
  });

  // THE TEST ISSUE #34 WOULD HAVE FAILED ON DAY ONE. Every field the form
  // declares is set, saved, and then read back out of the re-opened edit
  // form's actual <input> tags -- so a value that is parsed but never written,
  // or written but never handed back, is caught in one assertion each.
  it("round-trips every field it declares, through the database and back into the form", async () => {
    await post("/admin/order-groups/new/", { name: "Ocado Bulk", public: "1", key: "k7mfp2xq" });

    const { html } = await get("/admin/order-group/ocado-bulk/edit/");

    expect(inputValue(html, "name")).toBe("Ocado Bulk");
    expect(inputValue(html, "key")).toBe("k7mfp2xq");
    expect(checkboxChecked(html, "public")).toBe(true);
  });

  // The other half of the round trip: submitting the form back UNCHANGED must
  // be a no-op. This is what makes "the edit form re-posts everything it was
  // given" a fact rather than an assumption -- and that assumption is exactly
  // what makes an UPDATE that rewrites every column (which this one does) safe.
  //
  // `modified` is backdated first so the assertion that it moved cannot pass
  // by coincidence: pyNow() has millisecond resolution and the create above is
  // milliseconds old, so comparing the two timestamps directly would be a coin
  // toss. Without that assertion this test would also pass against a handler
  // that wrote nothing at all.
  //
  // Note what it does NOT prove: a `key` box that came back empty would be
  // preserved by orderGroup.ts:225 and leave the row identical, so the key's
  // round trip is asserted directly in the test above, not here.
  it("re-submitting the form untouched changes no column but modified", async () => {
    await post("/admin/order-groups/new/", { name: "Ocado Bulk", public: "1", key: "k7mfp2xq" });
    db.prepare("UPDATE ordergroup SET modified = ? WHERE slug = ?").run("2020-01-01 00:00:00.000000", "ocado-bulk");
    const before = groupBySlug("ocado-bulk")!;
    const { html } = await get("/admin/order-group/ocado-bulk/edit/");

    // Submitted with the token the form itself carries, not one this file
    // invented -- "the edit form can save itself" is part of what a round trip
    // has to mean, and a form rendered with a stale or empty csrf_token is a
    // page that 403s every time Save is pressed.
    expect(formToken(html)).toBe(CSRF_RAW);
    const { res } = await post("/admin/order-group/ocado-bulk/edit/", browserWouldSubmit(html), { token: formToken(html) });

    expect(res.status).toBe(302);
    const after = groupBySlug("ocado-bulk")!;
    expect(after.modified).not.toBe("2020-01-01 00:00:00.000000");
    expect({ ...after, modified: null }).toEqual({ ...before, modified: null });
  });

  // orderGroup.ts:228 -- a group being published for the first time with no
  // key gets one, rather than a public URL that cannot be built. The alphabet
  // is deliberately unambiguous (no 0/1/l/o) because these keys get read off
  // printed pages.
  it("mints a key when a group is created public with the key box empty", async () => {
    await post("/admin/order-groups/new/", { name: "Ocado Bulk", public: "1", key: "" });

    const key = groupBySlug("ocado-bulk")!.key!;
    expect(key).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{8}$/);
    // And the donor link the list page renders really does use it -- the
    // generated key is only worth anything if it reaches the URL.
    expect((await get("/admin/order-groups/")).html).toContain(`/donate/managed/ocado-bulk-${key}/`);
  });

  // ONE SAMPLE IS NOT A RANDOM SOURCE. `return "abcdefgh"` passes the test
  // above in full -- it matches the alphabet, it reaches the URL -- and it
  // hands every published group the SAME capability token, so anyone holding
  // one donor link can guess the URL of every other group by slug alone. That
  // mutant survived this file until this test existed.
  //
  // Twelve mints also make the alphabet assertion deterministic rather than
  // lucky: the ambiguous characters KEY_ALPHABET deliberately omits (0/1/l/o,
  // because these keys get read off printed pages) show up in about two of
  // every three keys once they are back in the alphabet, so a single sample
  // misses that mutant a third of the time.
  it("mints a different key for every group, from the unambiguous alphabet", async () => {
    for (let i = 1; i <= 12; i++) {
      await post("/admin/order-groups/new/", { name: `Mint ${String(i).padStart(2, "0")}`, public: "1", key: "" });
    }

    const keys = allGroups().map((g) => g.key);
    expect(keys).toHaveLength(12);
    for (const key of keys) expect(key).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{8}$/);
    // 32^8 is 1.1e12, so twelve draws colliding is a ~6e-11 event -- this is
    // an assertion about the generator, not a flaky one about luck.
    expect(new Set(keys).size).toBe(12);
  });

  // The mirror image, and the one that says the generator is gated on
  // `public`: a private group gets no key, so no capability token is minted
  // for a URL nobody can visit.
  it("stores NULL, not a minted key, when a private group is created with the box empty", async () => {
    await post("/admin/order-groups/new/", { name: "Ocado Bulk", key: "" });

    const row = groupBySlug("ocado-bulk")!;
    expect(row.public).toBe(0);
    expect(row.key).toBeNull();
  });

  // An unticked checkbox is ABSENT from the body, and that absence is its
  // false state -- so "public" arriving as nothing at all must not be read as
  // truthy by Number(). It is the difference between a private ledger and a
  // published donor page.
  it("treats an absent public checkbox as private", async () => {
    await post("/admin/order-groups/new/", { name: "Ocado Bulk" });

    expect(groupBySlug("ocado-bulk")!.public).toBe(0);
  });

  // A TRAP WORTH WRITING DOWN, pinned as current behaviour rather than fixed
  // here. parseAdminFields reads a checkbox by PRESENCE (`body[name] ? 1 : 0`,
  // adminFormFields.ts:288), because that is how HTML checkboxes work -- so
  // the string "0" is truthy and publishes the group. No browser submitting
  // formfields.njk's markup can reach this (that input posts "1" or nothing),
  // and every admin form in this port shares the rule, but a hand-built POST
  // or a future hidden-input pattern would publish a group while appearing to
  // ask for the opposite. The consequence is specific to THIS model: it also
  // mints a key and puts a live donor URL on the list page.
  it("treats public=0 as public, because a checkbox is read by presence", async () => {
    await post("/admin/order-groups/new/", { name: "Ocado Bulk", public: "0" });

    expect(groupBySlug("ocado-bulk")!.public).toBe(1);
    expect(groupBySlug("ocado-bulk")!.key).not.toBeNull();
  });

  // parseAdminFields trims every text field, so a name typed with a stray
  // space is stored trimmed -- and, more to the point, its slug is derived
  // from the trimmed value rather than picking up a trailing hyphen.
  it("trims the name before slugifying it", async () => {
    await post("/admin/order-groups/new/", { name: "  Ocado Bulk  " });

    expect(groupBySlug("ocado-bulk")!.name).toBe("Ocado Bulk");
  });

  // The key charset is not cosmetic: givefood/urls.py:38's greedy
  // `<slug:slug>-<slug:key>` is split on the LAST hyphen, and both "-" and
  // "_" are legal inside `<slug:...>`, so a key containing either resolves to
  // the WRONG (slug, key) pair and 404s for the donor. The ninth character is
  // the model's own `CharField(max_length=8)`, which nothing else in this port
  // enforces (0015_ordergroup.sql:46 is a bare `key TEXT`). Django validates
  // none of the charset; the port refuses it on the way in instead, and the
  // refusal is what keeps the URL split unambiguous for every key it stores.
  it.each(["k7-mfp2", "k7_mfp2", "k7mfp2xqz", "k7 mfp2", "k7mfp2!"])("refuses the key %s", async (key) => {
    const { res, html } = await post("/admin/order-groups/new/", { name: "Ocado Bulk", key });

    expect(res.status).toBe(400);
    expect(html).toBe("Key must be 1-8 letters or digits, with no hyphens or underscores");
    expect(allGroups()).toHaveLength(0);
  });

  it.each(["k", "K7MFP2XQ", "12345678", "k7mfp2xq"])("accepts the key %s", async (key) => {
    const { res } = await post("/admin/order-groups/new/", { name: "Ocado Bulk", key });

    expect(res.status).toBe(302);
    expect(groupBySlug("ocado-bulk")!.key).toBe(key);
  });
});

// ---------------------------------------------------------------------------
describe("adminOrderGroupForm -- edit", () => {
  beforeEach(() => {
    seedGroup({
      id: 7,
      name: "Ocado Bulk",
      slug: "ocado-bulk",
      public: 1,
      key: "k7mfp2xq",
      created: "2024-03-05 14:30:00.000000",
      modified: "2024-03-05 14:30:00.000000",
    });
  });

  it("updates the row in place rather than inserting a second one", async () => {
    const { res } = await post("/admin/order-group/ocado-bulk/edit/", { name: "Ocado Bulk Deliveries", public: "1", key: "k7mfp2xq" });

    expect(res.status).toBe(302);
    // views.py:2823 redirects to admin:order_groups from BOTH branches -- an
    // edit lands back on the list, not on the group it just changed.
    expect(res.headers.get("Location")).toBe("/admin/order-groups/");
    const rows = allGroups();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(7);
    expect(rows[0]!.name).toBe("Ocado Bulk Deliveries");
    // created is auto_now_add and must survive an edit; modified is auto_now
    // and must not. The UPDATE names five columns and `created` is not one of
    // them -- this is the assertion that says so.
    expect(rows[0]!.created).toBe("2024-03-05 14:30:00.000000");
    expect(rows[0]!.modified).not.toBe("2024-03-05 14:30:00.000000");
  });

  // THE REGRESSION orderGroup.ts:225 EXISTS FOR, and the most expensive thing
  // this file guards. A blank key field on an existing group means "leave it
  // alone", never "clear it" and never "make me a new one": the key is a
  // capability token already circulating in donor URLs, so regenerating it
  // silently breaks every link anyone has been given -- which is precisely
  // what happened before that line, because a blank field became null and null
  // on a public group hit the generator. There is no error and no visible
  // symptom; the donations simply stop arriving.
  it("keeps an existing key when the key box is submitted empty", async () => {
    const { res } = await post("/admin/order-group/ocado-bulk/edit/", { name: "Ocado Bulk", public: "1", key: "" });

    expect(res.status).toBe(302);
    expect(groupBySlug("ocado-bulk")!.key).toBe("k7mfp2xq");
  });

  // Same rule, reached with the box omitted from the body entirely rather than
  // submitted empty -- parseAdminFields loops over the SPEC LIST, not the body
  // (adminFormFields.ts:286), so the two are indistinguishable by the time the
  // key rules run. Worth pinning because a future partial form that dropped
  // the key field would otherwise be the thing that reissues every key.
  it("keeps an existing key when the POST omits the field entirely", async () => {
    const { res } = await post("/admin/order-group/ocado-bulk/edit/", { name: "Ocado Bulk", public: "1" });

    expect(res.status).toBe(302);
    expect(groupBySlug("ocado-bulk")!.key).toBe("k7mfp2xq");
  });

  // Unpublishing must not discard the token either: republishing later has to
  // resurrect the SAME donor URL, or every link handed out before the pause is
  // dead for good.
  it("keeps the key when the group is unpublished", async () => {
    await post("/admin/order-group/ocado-bulk/edit/", { name: "Ocado Bulk", key: "" });

    const row = groupBySlug("ocado-bulk")!;
    expect(row.public).toBe(0);
    expect(row.key).toBe("k7mfp2xq");
  });

  // The escape hatch: an admin who deliberately types a different key gets it.
  // The field's help text is the only thing that says not to -- nothing
  // enforces it, by design, because a leaked key has to be replaceable.
  it("overwrites the key when a different one is typed", async () => {
    await post("/admin/order-group/ocado-bulk/edit/", { name: "Ocado Bulk", public: "1", key: "newkey99" });

    expect(groupBySlug("ocado-bulk")!.key).toBe("newkey99");
  });

  // KEPT FOR PARITY, deliberately, and the help text on the Name field says so
  // out loud: OrderGroup.save() re-slugifies on every save
  // (models/orders.py:324-327), so renaming a PUBLIC group changes its
  // donor-facing URL. The old URL stops resolving -- in the admin here, and at
  // /donate/managed/ once that family is served.
  it("re-slugifies on rename, moving both the admin and the donor URL", async () => {
    await post("/admin/order-group/ocado-bulk/edit/", { name: "Ocado Bulk Deliveries", public: "1", key: "k7mfp2xq" });

    expect(groupBySlug("ocado-bulk")).toBeUndefined();
    expect(groupBySlug("ocado-bulk-deliveries")!.id).toBe(7);
    expect((await get("/admin/order-group/ocado-bulk/")).res.status).toBe(404);
    expect((await get("/admin/order-group/ocado-bulk-deliveries/")).res.status).toBe(200);
    expect((await get("/admin/order-groups/")).html).toContain("/donate/managed/ocado-bulk-deliveries-k7mfp2xq/");
  });

  // upsertOrderGroup's collision pre-check compares the clashing row's id with
  // the row being edited, so a group keeping its own name must not be refused
  // by its own existing slug. A check that skipped that comparison would make
  // every edit of every group impossible -- a worse bug than the collision it
  // guards against, and one with no workaround.
  it("lets a group keep its own name", async () => {
    const { res } = await post("/admin/order-group/ocado-bulk/edit/", { name: "Ocado Bulk", public: "1", key: "k7mfp2xq" });

    expect(res.status).toBe(302);
    expect(groupBySlug("ocado-bulk")!.id).toBe(7);
  });

  // The route reads the row before it does anything else, so a POST aimed at a
  // slug that no longer exists (a stale tab left open across a rename, which
  // the test above shows is a normal thing to happen here) 404s rather than
  // creating a second group under the new name.
  it("404s a POST to a slug no group has, and writes nothing", async () => {
    const { res } = await post("/admin/order-group/no-such-group/edit/", { name: "Invented", public: "1" });

    expect(res.status).toBe(404);
    expect(allGroups()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// `section` is the only thing every one of these three handlers passes to
// adminPageContext, and it decides which of page.njk:43-50's eight nav items
// is drawn `is-active`. Django says "settings" for the list (views.py:2771)
// and for the detail page (views.py:2798) -- these pages are reached ONLY from
// the Settings page's own "Order Groups" item (settings.html:16), never from
// the Orders section, which is about individual deliveries.
//
// Untested until now, and all three mutants ("settings" -> "orders", one
// handler at a time) survived the whole file: nothing else in the rendered
// page changes, so the only symptom is the admin's nav highlighting a section
// they are not in.
//
// The FORM's "settings" is a port addition rather than a parity claim:
// order_group_form (views.py:2810-2832) passes no section at all, so Django
// highlights nothing on it. Pinned here as what this port does.
// ---------------------------------------------------------------------------
describe("nav section", () => {
  it.each([
    ["the list", "/admin/order-groups/"],
    ["the detail page", "/admin/order-group/ocado-bulk/"],
    ["the edit form", "/admin/order-group/ocado-bulk/edit/"],
    ["the create form", "/admin/order-groups/new/"],
  ])("marks Settings, not Orders, as the active section on %s", async (_label, path) => {
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk" });

    const { res, html } = await get(path);

    expect(res.status).toBe(200);
    expect(activeNavItems(html)).toEqual(["/admin/settings/"]);
  });
});

// ---------------------------------------------------------------------------
// Every refusal, and what it costs the admin. THE HEADLINE HERE IS A
// DIVERGENCE, pinned rather than fixed (TESTING.md: tests pin current
// behaviour): this handler answers a rejected save with `c.text(...)`, a bare
// plain-text 400 that replaces the page. Django's ModelForm came back with the
// SAME BOUND FORM, every typed value still in its input, and four sibling
// handlers in this same directory already do that -- foodbankLocation.ts and
// donationPoint.ts were changed for issue #12, parlcon.ts:46 re-renders with
// `{ ...parsed.values }`, and items.ts:84-86 says in its own header that it
// re-renders "instead of the bare `c.text(error, 400)` the other ported admin
// forms return". orderGroup.ts and slugRedirect.ts are the two that still
// return it. The cost here is smaller than issue #12's (three short fields, no
// Google lookup behind them, and the key box is the only one that is painful
// to retype) but the class is identical, so each test below asserts the loss
// explicitly rather than stopping at the status code. Reported as a suspected
// bug; not fixed here.
// ---------------------------------------------------------------------------
describe("adminOrderGroupForm -- refusals", () => {
  it("refuses a missing name, and discards what was typed", async () => {
    const { res, html } = await post("/admin/order-groups/new/", { name: "", public: "1", key: "k7mfp2xq" });

    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(html).toBe("Name is required");
    // The whole of the admin's input, gone: no form to press Save from, and
    // no key box holding the token they had just pasted in.
    expect(html).not.toContain("<form");
    expect(html).not.toContain("k7mfp2xq");
    expect(allGroups()).toHaveLength(0);
  });

  // givefood/models/orders.py:316's `max_length=100`, which OrderGroupForm
  // rejects past with "Ensure this value has at most 100 characters".
  // Nothing else in this port constrains it -- parseAdminFields has no length
  // rule and 0015_ordergroup.sql is a bare `name TEXT NOT NULL` -- so without
  // this guard the row would save and Django would then refuse to edit it.
  it("refuses a name longer than the model's 100 characters", async () => {
    const { res, html } = await post("/admin/order-groups/new/", { name: "x".repeat(101) });

    expect(res.status).toBe(400);
    expect(html).toBe("Name must be 100 characters or fewer");
    expect(allGroups()).toHaveLength(0);
  });

  // The boundary itself, on the accept side: an off-by-one here would refuse
  // a name Django stores happily.
  it("accepts a name of exactly 100 characters", async () => {
    const { res } = await post("/admin/order-groups/new/", { name: "x".repeat(100) });

    expect(res.status).toBe(302);
    expect(allGroups()[0]!.name).toHaveLength(100);
  });

  // slugify("!!!") is the empty string, which Django stores happily and then
  // 404s on forever: the row exists, the list links to /admin/order-group//,
  // and there is no way back to it through the UI. Refused here instead.
  it("refuses a name that slugifies to nothing", async () => {
    const { res, html } = await post("/admin/order-groups/new/", { name: "!!!" });

    expect(res.status).toBe(400);
    expect(html).toBe("Name must contain at least one letter or number");
    expect(allGroups()).toHaveLength(0);
  });

  // migrations/0015's UNIQUE index is the backstop; this pre-check is what
  // turns the SQLITE_CONSTRAINT_UNIQUE it would otherwise raise -- issue #12's
  // exact 500 -- into a sentence. In Django there was no index and no check:
  // the second row saved, and get_object_or_404 then raised
  // MultipleObjectsReturned on the detail page AND the edit form, with no way
  // back out through the UI.
  it("refuses a second group with the same name, without touching the first", async () => {
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk", public: 1, key: "k7mfp2xq" });
    const before = allGroups();

    const { res, html } = await post("/admin/order-groups/new/", { name: "Ocado Bulk", public: "1", key: "differ12" });

    expect(res.status).toBe(400);
    expect(html).toBe('An order group with the slug "ocado-bulk" already exists');
    expect(allGroups()).toEqual(before);
  });

  // The collision that is invisible in the name column, which is why the check
  // is on the SLUG and not on the name: these three all slugify to
  // "ocado-bulk", and only the derived value collides.
  it.each(["ocado bulk", "Ocado  Bulk", "Ocado, Bulk!"])("refuses %s, which slugifies onto an existing group", async (name) => {
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk" });

    const { res, html } = await post("/admin/order-groups/new/", { name });

    expect(res.status).toBe(400);
    expect(html).toBe('An order group with the slug "ocado-bulk" already exists');
    expect(allGroups()).toHaveLength(1);
  });

  // The edit half of the same hole. The maintainer's issue said "adding", but
  // renaming one group onto another's name reaches the identical index.
  it("refuses a rename onto another group's slug, leaving both rows alone", async () => {
    seedGroup({ id: 1, name: "Ocado Bulk", slug: "ocado-bulk" });
    seedGroup({ id: 2, name: "Tesco Bulk", slug: "tesco-bulk" });
    const before = allGroups();

    const { res, html } = await post("/admin/order-group/tesco-bulk/edit/", { name: "Ocado Bulk" });

    expect(res.status).toBe(400);
    expect(html).toBe('An order group with the slug "ocado-bulk" already exists');
    expect(allGroups()).toEqual(before);
  });

  // EVERY REFUSAL ABOVE IS ON THE CREATE ROUTE -- and create and edit are the
  // SAME FUNCTION, told apart only by whether :slug matched. That was the
  // largest hole in this file: gating any one of the three guards on
  // `!existing` (the shape an edit takes while making a "only check this for
  // new groups" change: `if (!existing && name.length > NAME_MAX_LENGTH)`)
  // survived every test here. So did reading the name from the existing row
  // when parsing failed. All four mutants are killed by the three tests below.
  //
  // The key one is the expensive mutant. An unvalidated "k7-mfp2" written to
  // an EXISTING public group puts a hyphen inside a live donor URL, and
  // givefood/urls.py:38's greedy `<slug:slug>-<slug:key>` splits on the LAST
  // hyphen -- so /donate/managed/ocado-bulk-k7-mfp2/ resolves to the pair
  // ("ocado-bulk-k7", "mfp2"), which matches no group and 404s. Every donor
  // holding the link loses it, and the admin was told the save worked.
  describe("on the edit route as well as create", () => {
    beforeEach(() => {
      seedGroup({ id: 7, name: "Ocado Bulk", slug: "ocado-bulk", public: 1, key: "k7mfp2xq" });
    });

    it("refuses an empty name on an existing group, changing nothing", async () => {
      const before = allGroups();

      const { res, html } = await post("/admin/order-group/ocado-bulk/edit/", { name: "", public: "1", key: "k7mfp2xq" });

      expect(res.status).toBe(400);
      expect(html).toBe("Name is required");
      expect(allGroups()).toEqual(before);
    });

    it("refuses a name past the model's 100 characters on an existing group", async () => {
      const before = allGroups();

      const { res, html } = await post("/admin/order-group/ocado-bulk/edit/", { name: "x".repeat(101), public: "1", key: "k7mfp2xq" });

      expect(res.status).toBe(400);
      expect(html).toBe("Name must be 100 characters or fewer");
      expect(allGroups()).toEqual(before);
    });

    it("refuses a hyphenated key on an existing group, leaving the live key in place", async () => {
      const before = allGroups();

      const { res, html } = await post("/admin/order-group/ocado-bulk/edit/", { name: "Ocado Bulk", public: "1", key: "k7-mfp2" });

      expect(res.status).toBe(400);
      expect(html).toBe("Key must be 1-8 letters or digits, with no hyphens or underscores");
      expect(groupBySlug("ocado-bulk")!.key).toBe("k7mfp2xq");
      expect(allGroups()).toEqual(before);
    });
  });

  // Order of operations: the name is validated before the key, so a POST that
  // is wrong in both ways reports the name. Pinned because the reverse order
  // would have the admin fix the key, resubmit, and be told about the name --
  // two round trips through a form that (see this block's header) keeps
  // nothing between them.
  it("reports the name problem first when both name and key are wrong", async () => {
    const { html } = await post("/admin/order-groups/new/", { name: "", key: "not-a-valid-key" });

    expect(html).toBe("Name is required");
  });
});

// ---------------------------------------------------------------------------
// Django's admin has no CSRF middleware at all (settings.py:97 comments
// CsrfViewMiddleware out, so its `{% csrf_token %}` tags are decorative). This
// port's mutations are POST-only and verified, WP 6.3 -- which means these are
// the tests that say the guard is actually wired to this handler, and each one
// also asserts that no row moved, because a 403 that had already written is
// not a refusal.
// ---------------------------------------------------------------------------
describe("adminOrderGroupForm -- CSRF", () => {
  beforeEach(() => {
    seedGroup({ id: 7, name: "Ocado Bulk", slug: "ocado-bulk", public: 1, key: "k7mfp2xq" });
  });

  it("refuses a POST with no token at all", async () => {
    const { res, html } = await post("/admin/order-groups/new/", { name: "Sneaky Group" }, { token: null });

    expect(res.status).toBe(403);
    expect(html).toBe("Forbidden");
    expect(allGroups()).toHaveLength(1);
  });

  it("refuses a POST whose token does not match the cookie", async () => {
    const { res } = await post("/admin/order-groups/new/", { name: "Sneaky Group" }, { token: "c".repeat(64) });

    expect(res.status).toBe(403);
    expect(allGroups()).toHaveLength(1);
  });

  // The double-submit's other half: a valid-looking form field with no cookie
  // behind it is exactly what a cross-site form post can produce.
  it("refuses a POST with a token but no cookie", async () => {
    const { res } = await post("/admin/order-groups/new/", { name: "Sneaky Group" }, { cookie: "" });

    expect(res.status).toBe(403);
    expect(allGroups()).toHaveLength(1);
  });

  it("refuses a cross-origin POST even with a good token", async () => {
    const { res } = await post("/admin/order-groups/new/", { name: "Sneaky Group" }, { origin: "https://evil.example" });

    expect(res.status).toBe(403);
    expect(allGroups()).toHaveLength(1);
  });

  // The edit path is verified too -- an unguarded edit is worse than an
  // unguarded create, because it can silently unpublish a group or replace the
  // key in every donor URL.
  it("refuses an untokened edit, leaving the group exactly as it was", async () => {
    const before = allGroups();

    const { res } = await post("/admin/order-group/ocado-bulk/edit/", { name: "Ocado Bulk", key: "" }, { token: null });

    expect(res.status).toBe(403);
    expect(allGroups()).toEqual(before);
  });

  // ORDER MATTERS: the token is checked before the body is parsed, so a forged
  // request gets 403 rather than a 400 that tells it which field it got wrong.
  it("checks the token before it validates anything", async () => {
    const { res, html } = await post("/admin/order-groups/new/", { name: "", key: "not-a-valid-key" }, { token: null });

    expect(res.status).toBe(403);
    expect(html).toBe("Forbidden");
  });
});

// ---------------------------------------------------------------------------
describe("adminOrderGroupForm -- authentication", () => {
  // The real middleware from routes/admin/index.ts:85 (`adminApp.use("*",
  // requireAdminAuth)`), mounted the way production mounts it. Without a
  // __Host-gfsession cookie getAdminSession returns null before it ever
  // reaches KV, so this needs no SESSIONS binding -- and that is the shape a
  // drive-by request actually has.
  function signedOutApp(): Hono<AppEnv> {
    const signedOut = new Hono<AppEnv>();
    signedOut.use("*", async (c, next) => {
      c.set("requestStartTime", performance.now());
      await next();
    });
    signedOut.use("*", requireAdminAuth);
    signedOut.get("/admin/order-groups/", adminOrderGroupsList);
    signedOut.post("/admin/order-groups/new/", adminOrderGroupForm);
    signedOut.post("/admin/order-group/:slug/edit/", adminOrderGroupForm);
    return signedOut;
  }

  beforeEach(() => {
    seedGroup({ id: 7, name: "Ocado Bulk", slug: "ocado-bulk", public: 1, key: "k7mfp2xq" });
    app = signedOutApp();
  });

  // A correctly-signed CSRF token is deliberately included: the point is that
  // the request never reaches the handler, so the fact that it would otherwise
  // have passed every check downstream is what makes the assertion mean
  // something.
  it("never lets a signed-out POST reach the create handler", async () => {
    const { res } = await post("/admin/order-groups/new/", { name: "Sneaky Group", public: "1" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Forder-groups%2Fnew%2F");
    expect(allGroups()).toHaveLength(1);
  });

  it("never lets a signed-out POST reach the edit handler", async () => {
    const before = allGroups();

    const { res } = await post("/admin/order-group/ocado-bulk/edit/", { name: "Renamed", key: "stolen12" });

    expect(res.status).toBe(302);
    expect(allGroups()).toEqual(before);
  });

  // The list page is not merely dull to leak: its Public? column carries the
  // live donor URLs, key and all, for every published group.
  it("does not serve the list to a signed-out visitor", async () => {
    const { res } = await get("/admin/order-groups/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Forder-groups%2F");
  });
});
