import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { adminItemForm, adminItemsList } from "./items";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// routes/admin/items.ts is the OrderItem admin: a paginated, sortable list
// (gfadmin/views.py:2241-2249) and one shared new/edit form (:2252-2273). Both
// halves fail SILENTLY when they fail at all, which is why this file exists at
// the route level rather than stopping at packages/db.
//
// The two shipped bugs this tier was opened for are the pattern:
//
//   * #34 -- the location form parsed a Place ID, passed it down, and no SQL
//     wrote it. The handler redirected as though the save had worked. The only
//     assertion that would ever have caught it is one that reads the row back
//     out of storage, so every save test below does exactly that: a 302 is
//     never accepted as evidence that anything was stored.
//   * #12 -- a duplicate name reached D1, SQLite raised, and the 500 page threw
//     away everything the admin had typed. items.ts pre-checks the name
//     (getOrderItemByName) and re-renders at 400 with the values still in the
//     inputs, which is a behaviour with two halves: the refusal AND the
//     preservation. Every refusal test below asserts both, plus that the table
//     did not move.
//
// NOTHING IS MOCKED. There is no fetch, no queue, no R2 and no KV write on
// either of these paths, so there is nothing here that "leaves the machine":
//
//   * the database is a real in-memory SQLite carrying the real migration's
//     UNIQUE index, driven through the real packages/db functions;
//   * the router is a real Hono app registered at the real production paths
//     (routes/admin/index.ts:242-246), because create and edit are ONE handler
//     distinguished only by whether :slug matched;
//   * the auth middleware is the real requireAdminAuth over a fake KV, so
//     "an unauthenticated request never reaches the handler" is a claim about
//     the shipped middleware and not about a stub;
//   * CSRF is the real verifyCsrf against the real issueCsrfToken, so one test
//     below can GET the form, take the token the server actually minted, and
//     post it back -- the only shape of CSRF test that proves the check is not
//     theatre;
//   * the templates are the real Nunjucks ones, so "the admin's values came
//     back" is read out of the HTML the admin would have received rather than
//     out of a context object that a broken template could still fail to
//     render.

// ---------------------------------------------------------------------------
// packages/db/migrations/0014_orderitem.sql:31-38 verbatim -- the table AND
// both indexes, transcribed the way the neighbouring workers/site suites do
// (donationPoint.test.ts, foodbankLocation.test.ts) rather than loaded through
// packages/db's schema.testkit.ts, which is that package's own convention.
//
// orderitem_name_uniq is load-bearing, not decoration: it is the constraint the
// handler's pre-check fronts, and a fixture without it would let the duplicate
// tests below "pass" against a database that does not exist. orderitem_slug_idx
// is deliberately NON-unique for the reason 0014 spells out at length.
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE orderitem (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  calories INTEGER NOT NULL
);
CREATE UNIQUE INDEX orderitem_name_uniq ON orderitem(name);
CREATE INDEX orderitem_slug_idx ON orderitem(slug);
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db actually uses, over node:sqlite.
// Copied from donationPoint.test.ts, which copied it from
// foodbankLocation.test.ts. Nothing here interprets the SQL -- it hands the
// string straight to a real engine, which is the only reason these tests are
// worth more than ones written against a recording fake.
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
// lib/csrf.ts's cookie format is `<raw>.<hmac>`; minted here with the real
// hmac so the real verifyCsrf accepts it and, equally, so a test that tampers
// with either half is refused for the real reason.
const CSRF_COOKIE = `${CSRF_RAW}.${await hmacSha256Hex(CSRF_SECRET, CSRF_RAW)}`;

// lib/adminAuth.ts:61 SESSION_COOKIE_NAME and :250 sessionKvKey.
const SESSION_ID = "test-admin-session";
const SESSION_KEY = `admin-session:${SESSION_ID}`;
const ADMIN = { email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "" };

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let app: Hono<AppEnv>;
let env: AppEnv["Bindings"];
let sessions: Map<string, string>;

interface Seed {
  id: number;
  name: string;
  slug: string;
  calories?: number;
}

// Slugs are named explicitly rather than derived. Deriving them would mean
// reimplementing slugify() in the fixture and asserting the module against that
// reimplementation, and it would make the legacy slug collisions 0014 says
// production may contain unseedable.
function seed(...items: Seed[]): void {
  for (const item of items) {
    db.prepare("INSERT INTO orderitem (id, name, slug, calories) VALUES (?, ?, ?, ?)").run(item.id, item.name, item.slug, item.calories ?? 0);
  }
}

// Read the table back RAW. Reading through getOrderItemBySlug instead would
// make every write assertion pass or fail on the read function's bugs as well
// as the handler's -- and #34 was precisely a write that no SQL performed, so
// the storage layer is the thing that has to be inspected directly.
function rows(): Array<{ id: number; name: string; slug: string; calories: number }> {
  return db.prepare("SELECT id, name, slug, calories FROM orderitem ORDER BY id").all() as never;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);

  sessions = new Map<string, string>();
  // getAdminSession slides the expiry when more than half the 12h window has
  // gone (lib/adminAuth.ts:286-293); a freshly written expiry keeps every test
  // on the read-only path, so a stray KV put can never be mistaken for a write
  // the handler made.
  sessions.set(SESSION_KEY, JSON.stringify({ ...ADMIN, expiresAt: Date.now() + 12 * 60 * 60 * 1000 }));

  env = {
    DB: { withSession: () => d1Session(db) },
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => void sessions.set(key, value),
      delete: async (key: string) => void sessions.delete(key),
    },
    CSRF_SECRET,
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
    D1_DATABASE_NAME: "givefood-test",
  } as unknown as AppEnv["Bindings"];

  app = new Hono<AppEnv>();
  // middleware/serverTiming.ts's elapsedMs reads this; index.ts sets it for
  // every request before anything else runs.
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    await next();
  });
  // The REAL gate, mounted the way routes/admin/index.ts:85 mounts it.
  app.use("/admin/*", requireAdminAuth);
  // routes/admin/index.ts:242-246, verbatim. Create and edit are the same
  // function under two registrations, so a change in how that distinction is
  // drawn has to go through a real router to be caught.
  app.get("/admin/items/", adminItemsList);
  app.get("/admin/item/new/", adminItemForm);
  app.post("/admin/item/new/", adminItemForm);
  app.get("/admin/item/:slug/edit/", adminItemForm);
  app.post("/admin/item/:slug/edit/", adminItemForm);
  // The 500 page issue #12 is about. Labelled rather than left to become an
  // unhandled rejection, so a regression reads as "expected 400, got 500:
  // UNIQUE constraint failed" instead of a vitest crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
});

interface Opts {
  signedIn?: boolean;
  /** what goes in the POST body; null omits the field entirely */
  csrfField?: string | null;
  /** what goes in the __Host-csrf cookie; null omits the cookie */
  csrfCookie?: string | null;
  origin?: string | null;
  secFetchSite?: string | null;
}

function cookieHeader(opts: Opts): string | undefined {
  const parts: string[] = [];
  if (opts.signedIn !== false) parts.push(`__Host-gfsession=${SESSION_ID}`);
  const csrf = opts.csrfCookie === undefined ? CSRF_COOKIE : opts.csrfCookie;
  if (csrf !== null) parts.push(`__Host-csrf=${csrf}`);
  return parts.length ? parts.join("; ") : undefined;
}

interface Result {
  res: Response;
  html: string;
}

async function get(path: string, opts: Opts = {}): Promise<Result> {
  const headers = new Headers();
  const cookie = cookieHeader(opts);
  if (cookie) headers.set("Cookie", cookie);
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, execCtx);
  return { res, html: res.status === 302 ? "" : await res.text() };
}

async function post(path: string, fields: Record<string, string>, opts: Opts = {}): Promise<Result> {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  const cookie = cookieHeader(opts);
  if (cookie) headers.set("Cookie", cookie);
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.set("Origin", origin);
  const site = opts.secFetchSite === undefined ? "same-origin" : opts.secFetchSite;
  if (site !== null) headers.set("Sec-Fetch-Site", site);

  const body = new URLSearchParams(fields);
  const token = opts.csrfField === undefined ? CSRF_RAW : opts.csrfField;
  if (token !== null) body.set("csrf_token", token);

  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: body.toString() }), env, execCtx);
  // Read the body once, here: several assertions want it and a Response body
  // can only be consumed once.
  return { res, html: res.status === 302 ? "" : await res.text() };
}

// Nunjucks autoescapes, so a value round-tripping through the form comes back
// entity-encoded. Decoded here rather than asserted around, so expectations
// stay the strings a human would type into the box.
function decode(value: string): string {
  return value
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The banner item_form.njk:48 renders `error` into, read back as the admin
// reads it.
function errorBanner(html: string): string | null {
  const match = html.match(/<div class="notification is-danger is-light">([\s\S]*?)<\/div>/);
  return match ? decode(match[1]!.trim()) : null;
}

// What is actually IN the box the admin would look at, not what the handler
// passed to the template. item_form.njk:59 / :66 both put `value` before the
// remaining attributes.
function fieldValue(html: string, id: string): string | null {
  const match = html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`));
  return match ? decode(match[1]!) : null;
}

function csrfField(html: string): string | null {
  const match = html.match(/name="csrf_token" value="([^"]*)"/);
  return match ? match[1]! : null;
}

// The Edit column of items.njk:54, in render order -- which makes this the
// assertion for BOTH which rows a page holds and what order they are in.
function editLinks(html: string): string[] {
  return [...html.matchAll(/href="\/admin\/item\/([^"]*)\/edit\/"/g)].map((m) => m[1]!);
}

function pagerLabel(html: string): string | null {
  const match = html.match(/<span class="pagination-list">([^<]*)<\/span>/);
  return match ? match[1]! : null;
}

function headingCount(html: string): string | null {
  const match = html.match(/<h2>Items \(([^)]*)\)<\/h2>/);
  return match ? match[1]! : null;
}

// ===========================================================================
// adminItemsList -- gfadmin/views.py:2241-2249 items(). Django renders all
// 1,200 rows unordered and unpaginated; the sort, the pagination and the
// sortable headers are all the port's own, so everything in this block is
// behaviour nothing upstream can vouch for.
// ===========================================================================
describe("adminItemsList", () => {
  it("renders each item's name, calories and edit link", async () => {
    seed({ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 }, { id: 2, name: "Tinned Tomatoes", slug: "tinned-tomatoes", calories: 22 });

    const { res, html } = await get("/admin/items/");

    expect(res.status).toBe(200);
    expect(html).toContain("Baked Beans");
    expect(html).toContain("78");
    expect(editLinks(html)).toEqual(["baked-beans", "tinned-tomatoes"]);
    // items.njk's heading count is the WHOLE table, not the page -- see the
    // pagination block below for why the distinction has teeth.
    expect(headingCount(html)).toBe("2");
  });

  // items.ts:59 encodeURIComponent, and the reason its comment gives: `slug` is
  // whatever slugify() produced and the schema constrains it not at all, so a
  // legacy row loaded out of Django can hold anything. An un-encoded slash
  // would render a link to a path that resolves to a different route entirely;
  // an un-encoded space would render a broken href.
  it("percent-encodes a slug that a bare href could not carry", async () => {
    seed({ id: 1, name: "Legacy Row", slug: "beans/value tin", calories: 78 });

    expect(editLinks((await get("/admin/items/")).html)).toEqual(["beans%2Fvalue%20tin"]);
  });

  // ADDED UNDER REVIEW. The test above asserts the SHAPE of the href and stops
  // there, which is the same half-measure as accepting a 302 as proof of a save
  // (#34): an encoding can be correct as a string and still not resolve. So
  // this one follows the link the page actually rendered, through the real
  // router, and checks it lands on the row it was generated for. It is what
  // notices a double-encoded link (encodeURIComponent applied to an already
  // encoded slug 404s), and it is the only place the port's claim that these
  // legacy slugs stay EDITABLE is tested end to end -- Django's own /edit/ URL
  // for the first of these is malformed and the row is unreachable there.
  it("renders edit links that actually resolve to their row", async () => {
    seed({ id: 1, name: "Legacy Slash", slug: "beans/value", calories: 5 }, { id: 2, name: "Legacy Space", slug: "beans value tin", calories: 6 });

    const links = editLinks((await get("/admin/items/")).html);
    expect(links).toEqual(["beans%2Fvalue", "beans%20value%20tin"]);

    // Names in the order the links appear, so a link that resolved to the OTHER
    // row -- the failure a slug collision produces -- is not mistaken for a pass.
    const reached: Array<string | null> = [];
    for (const link of links) {
      const { res, html } = await get(`/admin/item/${link}/edit/`);
      expect(res.status).toBe(200);
      reached.push(fieldValue(html, "id_name"));
    }
    expect(reached).toEqual(["Legacy Slash", "Legacy Space"]);
  });

  // items.njk:56-58's `{% else %}` arm. A pager that divided by a zero total
  // would render "Page 1 of 0" or NaN; totalPages() clamps to 1.
  it("shows the None row and a one-page pager on an empty table", async () => {
    const { res, html } = await get("/admin/items/");

    expect(res.status).toBe(200);
    expect(html).toContain("<td colspan=\"3\">None</td>");
    expect(headingCount(html)).toBe("0");
    expect(pagerLabel(html)).toBe("Page 1 of 1");
    expect(html).not.toContain("pagination-next");
  });

  describe("sorting", () => {
    // Mixed capitalisation on purpose. SQLite's default collation is BINARY, so
    // without getOrderItemsPage's COLLATE NOCASE every capitalised name would
    // sort ahead of every lowercase one and an admin scanning 1,200 grocery
    // names would see a list that looks alphabetical twice over. Asserted
    // through the ROUTE because the route is what chooses the default sort at
    // all: items.ts:37 defaults `?sort` to "name", and this kills a default of
    // "calories" or "-name".
    //
    // A CORRECTION, run rather than reasoned: an earlier draft of this comment
    // claimed a default of "" would "land on a different column". It does not,
    // and no test here fails if items.ts:37 is changed to `?? ""` -- an empty
    // field name is not in ITEM_LIST_SORTS, so :40's allowlist falls back to
    // "name" and the leading-minus test at :38 leaves the direction ascending.
    // That mutant is EQUIVALENT, not a survivor; the allowlist test below is
    // what actually pins the fallback.
    it("defaults to name ascending, case-insensitively", async () => {
      seed(
        { id: 1, name: "cherry", slug: "cherry" },
        { id: 2, name: "Banana", slug: "banana" },
        { id: 3, name: "apple", slug: "apple" },
        { id: 4, name: "Damson", slug: "damson" },
      );

      const { html } = await get("/admin/items/");
      expect(editLinks(html)).toEqual(["apple", "banana", "cherry", "damson"]);
      // The active column carries an up arrow; the inactive one carries none.
      expect(html).toMatch(/>Name<\/a> &uarr;/);
      expect(html).not.toMatch(/>Calories<\/a> &[ud]arr;/);
    });

    // items.ts:38-39's leading-"-" convention, shared with adminPlacesList.
    it("reverses on a leading minus", async () => {
      seed({ id: 1, name: "apple", slug: "apple" }, { id: 2, name: "Banana", slug: "banana" }, { id: 3, name: "cherry", slug: "cherry" });

      const { html } = await get("/admin/items/?sort=-name");
      expect(editLinks(html)).toEqual(["cherry", "banana", "apple"]);
      expect(html).toMatch(/>Name<\/a> &darr;/);
    });

    it("sorts by calories in both directions", async () => {
      seed(
        { id: 1, name: "Aaa", slug: "aaa", calories: 300 },
        { id: 2, name: "Bbb", slug: "bbb", calories: 100 },
        { id: 3, name: "Ccc", slug: "ccc", calories: 200 },
      );

      expect(editLinks((await get("/admin/items/?sort=calories")).html)).toEqual(["bbb", "ccc", "aaa"]);
      expect(editLinks((await get("/admin/items/?sort=-calories")).html)).toEqual(["aaa", "ccc", "bbb"]);
    });

    // items.ts:55-56. The header link is what each column should switch TO, so
    // only the column you are ALREADY sorting ascending offers the descending
    // flip -- clicking the other column must start it ascending rather than
    // inheriting the current direction. Getting this backwards is invisible in
    // any test that only reads the row order, because the rows are right and
    // the links are wrong.
    it("offers the descending flip only on the column already sorted ascending", async () => {
      seed({ id: 1, name: "Aaa", slug: "aaa" });

      const ascending = (await get("/admin/items/?sort=name")).html;
      expect(ascending).toContain('<a href="?sort=-name">Name</a>');
      expect(ascending).toContain('<a href="?sort=calories">Calories</a>');

      // Already descending: clicking Name again goes back to ascending.
      const descending = (await get("/admin/items/?sort=-name")).html;
      expect(descending).toContain('<a href="?sort=name">Name</a>');
      expect(descending).toContain('<a href="?sort=calories">Calories</a>');

      const byCalories = (await get("/admin/items/?sort=calories")).html;
      expect(byCalories).toContain('<a href="?sort=name">Name</a>');
      expect(byCalories).toContain('<a href="?sort=-calories">Calories</a>');
    });

    // THE INJECTION BOUNDARY. `sort` is INTERPOLATED into the ORDER BY
    // (orderItemAdmin.ts:160), never bound, so items.ts:40's allowlist filter
    // is the only thing between a query string and the SQL text. A fallback
    // that let an unknown field through would interpolate `undefined` at best
    // and the admin's string at worst.
    it.each([
      ["id", "an existing column that is not allowlisted"],
      ["NAME", "the right field in the wrong case"],
      ["slug", "another real column"],
      ["name COLLATE BINARY", "SQL smuggled in as a field name"],
      ["name); DROP TABLE orderitem;--", "an outright injection attempt"],
    ])("falls back to name ascending for ?sort=%j (%s)", async (sortParam) => {
      seed({ id: 1, name: "Bbb", slug: "bbb" }, { id: 2, name: "Aaa", slug: "aaa" });

      const { res, html } = await get(`/admin/items/?sort=${encodeURIComponent(sortParam)}`);

      expect(res.status).toBe(200);
      expect(editLinks(html)).toEqual(["aaa", "bbb"]);
      // The table is still there -- the point of the last case, and free for
      // the rest.
      expect(rows()).toHaveLength(2);
    });

    // A bare "-" strips to an empty field name, which is not allowlisted and so
    // falls back to "name" -- but the DIRECTION was already taken from the
    // leading minus and survives the fallback. Worth pinning because it is the
    // one input where the two halves of items.ts:38-40 disagree, and because
    // the echoed `sort` has to stay a string the same handler can parse again
    // or the pagination links walk the admin somewhere else.
    //
    // ADDED UNDER REVIEW: the echo half of that sentence was a claim this test
    // did not make -- it read the row order and stopped. See the normalisation
    // test below for the three mutants that survived because of it; the second
    // assertion here is the bare-minus corner of the same property, and the
    // page=2 is what makes items.njk:62 render a link carrying `sort` at all.
    it("treats a bare minus as descending name, and echoes a sort it can re-parse", async () => {
      seed({ id: 1, name: "Aaa", slug: "aaa" }, { id: 2, name: "Bbb", slug: "bbb" }, { id: 3, name: "Ccc", slug: "ccc" });

      const { html } = await get("/admin/items/?sort=-&page=1");
      expect(editLinks(html)).toEqual(["ccc", "bbb", "aaa"]);

      const second = await get("/admin/items/?sort=-&page=2");
      expect(second.html).toContain('href="?page=1&amp;sort=-name"');
    });

    // ADDED UNDER REVIEW -- three surviving mutants, all invisible to every
    // assertion that only reads the row order, because under all three the ROWS
    // ARE STILL RIGHT and only the links and arrows lie:
    //
    //   * `sort: sortParam`  -- echo the admin's raw query string into the
    //     pagination hrefs. items.njk:62-63 interpolates `sort` into a URL that
    //     already has a `page` parameter, so a raw echo puts unencoded text
    //     inside a query string: "?sort=x%26page=9" comes back as
    //     `?page=2&sort=x&page=9`, and the duplicate `page` decides where Next
    //     actually goes. It is only safe today BECAUSE items.ts:52 rebuilds the
    //     value from the allowlisted field plus the direction, so the echo is
    //     always one of exactly four strings.
    //   * `sort: `-${field}`` -- echo the pre-allowlist field, so an unknown
    //     column survives into the link and every page-turn re-asserts a sort
    //     the handler has already refused.
    //   * `sort_field: field` -- drives items.njk:41-44's arrow. The table is
    //     name-ascending and NO header shows an arrow, so the admin cannot see
    //     which column they are looking at.
    //
    // `?page=2` on a one-row table is what renders a pagination link at all:
    // items.njk:62's Previous is gated on `page > 1`, and this way the case
    // needs one seeded row instead of a hundred and one.
    it.each([
      ["slug", "name", "&uarr;", "a real column that is not allowlisted"],
      ["-slug", "-name", "&darr;", "the same with a direction that must survive the fallback"],
      ["name); DROP TABLE orderitem;--", "name", "&uarr;", "an injection attempt that must not reach the href"],
    ])("normalises ?sort=%j to %j in the pagination link (%s)", async (raw, echoed, arrow) => {
      seed({ id: 1, name: "Aaa", slug: "aaa" });

      const { html } = await get(`/admin/items/?sort=${encodeURIComponent(raw)}&page=2`);

      expect(html).toContain(`href="?page=1&amp;sort=${echoed}"`);
      // The arrow marks the column actually sorted by, which is always an
      // allowlisted one -- never the string the admin sent.
      expect(html).toMatch(new RegExp(`>Name</a> ${arrow}`));
      // And the admin's raw string reaches the page nowhere at all: not in the
      // href, and not as text a later template change could make clickable.
      if (raw !== "slug") expect(html).not.toContain("DROP TABLE");
      expect(html).not.toContain("sort=slug");
    });
  });

  describe("pagination", () => {
    // PAGE_SIZE is 100 and is not exported, so this is the only way to cross a
    // page boundary through the route. 101 rows, zero-padded so the name sort
    // and the numeric order agree.
    //
    // THE ROW THAT MUST BE ABSENT is the whole point: a LIMIT that was never
    // applied, or an OFFSET that was ignored, passes every test that only
    // checks the rows it seeded are present. Item 101 must be on page 2 and
    // NOWHERE on page 1.
    function seedItems(count: number): void {
      for (let n = 1; n <= count; n++) {
        const padded = String(n).padStart(3, "0");
        seed({ id: n, name: `Item ${padded}`, slug: `item-${padded}`, calories: n });
      }
    }

    const seedHundredAndOne = () => seedItems(101);

    it("puts exactly one page of rows on page 1 and the overflow on page 2", async () => {
      seedHundredAndOne();

      const first = await get("/admin/items/");
      expect(editLinks(first.html)).toHaveLength(100);
      expect(editLinks(first.html)[0]).toBe("item-001");
      expect(editLinks(first.html).at(-1)).toBe("item-100");
      expect(first.html).not.toContain("Item 101");

      const second = await get("/admin/items/?page=2");
      expect(editLinks(second.html)).toEqual(["item-101"]);
      expect(second.html).not.toContain("Item 001");
    });

    // The heading count and the pager are computed from the TOTAL, not from
    // the rows returned. A COUNT that picked up the LIMIT would say "Items
    // (100)" and "Page 1 of 1", hiding a row behind a pager that renders no
    // links at all.
    it("counts the whole table in the heading and the pager, not the page", async () => {
      seedHundredAndOne();

      const first = await get("/admin/items/");
      expect(headingCount(first.html)).toBe("101");
      expect(pagerLabel(first.html)).toBe("Page 1 of 2");
      expect(first.html).toContain("pagination-next");
      expect(first.html).not.toContain("pagination-previous");

      const second = await get("/admin/items/?page=2");
      expect(headingCount(second.html)).toBe("101");
      expect(pagerLabel(second.html)).toBe("Page 2 of 2");
      expect(second.html).not.toContain("pagination-next");
      expect(second.html).toContain("pagination-previous");
    });

    // ADDED UNDER REVIEW -- the survivor was `hasNext: offset + pageSize <=
    // total` in getOrderItemsPage, which every case above passes: on a
    // 101-row fixture `100 <= 101` and `100 < 101` agree, and so do both on
    // page 2. It only diverges on a table that is EXACTLY one page long, where
    // the off-by-one renders a "Next page" link onto an empty page 2 -- an
    // admin clicking it sees the None row and reasonably concludes the list
    // has lost its rows.
    //
    // packages/db's own suite pins the same formula at pageSize 2 and 4, but
    // PAGE_SIZE here is 100 and is not exported, so this boundary is only
    // reachable through the route -- which is the point: the pair (this
    // handler's page size, that function's comparison) is what the admin sees,
    // and nothing was checking the pair.
    it("offers no next page when the table is exactly one page long", async () => {
      seedItems(100);

      const { html } = await get("/admin/items/");

      expect(editLinks(html)).toHaveLength(100);
      expect(headingCount(html)).toBe("100");
      expect(pagerLabel(html)).toBe("Page 1 of 1");
      expect(html).not.toContain("pagination-next");
      // And the page the missing link would have pointed at really is empty --
      // which is what makes its absence correct rather than merely tidy. (A
      // `hasNext` stuck at false is killed by the 101-row case above, which
      // requires the link to be there.)
      expect(editLinks((await get("/admin/items/?page=2")).html)).toEqual([]);
    });

    // items.njk:63-64 puts `sort` into both pagination hrefs, and items.ts:52
    // is what re-assembles it from the split field/direction pair. Lose that
    // and clicking Next silently drops the admin back to name-ascending on
    // page 2 of a completely different ordering -- rows they have never seen,
    // and rows they have seen twice.
    it("keeps the sort in the pagination links", async () => {
      seedHundredAndOne();

      const { html } = await get("/admin/items/?sort=-calories");
      expect(html).toContain('href="?page=2&amp;sort=-calories"');
      // And the order really is the one the link claims to be preserving.
      expect(editLinks(html)[0]).toBe("item-101");
    });

    // items.ts:24-27 parsePage. Every one of these reaches getOrderItemsPage as
    // an OFFSET, so a negative or NaN page is not a cosmetic problem: `(0 - 1)
    // * 100` is a negative OFFSET, which SQLite treats as zero but D1 need not,
    // and NaN would interpolate into the bindings.
    it.each([["0"], ["-1"], ["abc"], [""], ["1.0.0"], [" "]])("clamps ?page=%j to page 1", async (raw) => {
      seed({ id: 1, name: "Aaa", slug: "aaa" });

      const { res, html } = await get(`/admin/items/?page=${encodeURIComponent(raw)}`);
      expect(res.status).toBe(200);
      expect(pagerLabel(html)).toBe("Page 1 of 1");
      expect(editLinks(html)).toEqual(["aaa"]);
    });

    // parseInt, not Number: "2.9" truncates to 2 and passes the isInteger test,
    // and "1e3" parses as 1 rather than 1000. Both are pinned as CURRENT
    // BEHAVIOUR rather than endorsed -- they are only reachable by hand-editing
    // the query string, and Django paginated nothing at all here, so there is
    // no upstream answer to match. What matters is that neither 500s.
    it("truncates a fractional page rather than rejecting it", async () => {
      seed({ id: 1, name: "Aaa", slug: "aaa" });

      // Compared against both neighbours rather than asserted in isolation:
      // "Page 2 of 1" alone could be produced by a clamp that failed in the
      // other direction, so the claim is that 2.9 lands where 2 lands and not
      // where the fallback (1) does.
      const fractional = await get("/admin/items/?page=2.9");
      const two = await get("/admin/items/?page=2");
      const one = await get("/admin/items/?page=1");

      expect(pagerLabel(fractional.html)).toBe("Page 2 of 1");
      expect(pagerLabel(fractional.html)).toBe(pagerLabel(two.html));
      expect(editLinks(fractional.html)).toEqual([]);
      expect(editLinks(one.html)).toEqual(["aaa"]);
    });

    it("reads an exponent-shaped page as its leading digits", async () => {
      seed({ id: 1, name: "Aaa", slug: "aaa" });

      expect(pagerLabel((await get("/admin/items/?page=1e3")).html)).toBe("Page 1 of 1");
    });

    // Past the end the pager must not offer a Next link into nothing, and the
    // page number is NOT clamped back to 1 -- getOrderItemsPage echoes what it
    // was asked for, so the admin can see where they are rather than being
    // silently teleported to a page that does not match the empty table in
    // front of them.
    it("renders an empty page past the end without offering another one", async () => {
      seed({ id: 1, name: "Aaa", slug: "aaa" });

      const { res, html } = await get("/admin/items/?page=99");
      expect(res.status).toBe(200);
      expect(editLinks(html)).toEqual([]);
      expect(html).toContain("None");
      expect(headingCount(html)).toBe("1");
      expect(pagerLabel(html)).toBe("Page 99 of 1");
      expect(html).not.toContain("pagination-next");
    });
  });

  // items.ts:16-20's deliberate divergence, and the only place it is visible:
  // Django's views pass `section: "items"` (:2247), which matches no entry in
  // its own page.html nav, so nothing highlights and the admin loses their
  // place. The port passes "settings", which is where admin/settings.njk's
  // "Order Items" link lives -- so the nav item the admin clicked through is
  // the one that lights up. Asserted on both screens because they are one
  // decision made twice and a refactor could easily change only one.
  it("highlights Settings in the nav, not the nav entry Django never had", async () => {
    const list = await get("/admin/items/");
    expect(list.html).toContain('<a class="navbar-item is-active" href="/admin/settings/">Settings</a>');

    const form = await get("/admin/item/new/");
    expect(form.html).toContain('<a class="navbar-item is-active" href="/admin/settings/">Settings</a>');
    // Exactly one highlighted entry -- a `section` that matched nothing would
    // give zero, and one that matched loosely could give several.
    expect([...form.html.matchAll(/navbar-item is-active/g)]).toHaveLength(1);
  });

  // A list page is a GET, and GETs on this handler share a module with a
  // writer. Cheap to state, and the thing that would notice a "touch on view"
  // or a lazy backfill being added to the read path later.
  it("writes nothing", async () => {
    seed({ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 });
    const before = rows();

    await get("/admin/items/?sort=-calories&page=2");

    expect(rows()).toEqual(before);
  });

  // The REAL requireAdminAuth, not a stub. Django's LoginRequiredAccess
  // middleware is what this ports, and the redirect target carries the
  // originally requested path so the OAuth round trip can come back to it.
  it("redirects an unauthenticated visitor to sign-in without rendering the list", async () => {
    seed({ id: 1, name: "Commercially Sensitive Item", slug: "sensitive", calories: 1 });

    const { res, html } = await get("/admin/items/", { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fitems%2F");
    expect(html).toBe("");
  });
});

// ===========================================================================
// adminItemForm (GET) -- gfadmin/views.py:2252-2273 item_form's unbound half.
// ===========================================================================
describe("adminItemForm on GET", () => {
  it("renders an empty New Item form", async () => {
    const { res, html } = await get("/admin/item/new/");

    expect(res.status).toBe(200);
    // views.py:2259's page_title verbatim, and item_form.njk:53's
    // `form-{{ title | slugify }}` matching Django admin/form.html:14.
    expect(html).toContain("<h2>New Item</h2>");
    expect(html).toContain('class="form-new-item"');
    expect(fieldValue(html, "id_name")).toBe("");
    expect(fieldValue(html, "id_calories")).toBe("");
    expect(errorBanner(html)).toBeNull();
    // Without a token in the page the form is unsubmittable, so "the values
    // are preserved" would be preserved nowhere the admin can press Save from.
    expect(csrfField(html)).toBe(CSRF_RAW);
  });

  // DOCUMENTED DEPARTURE 1 (items.ts:75-81). Django's admin/order.html:117-134
  // pre-fills this form by POSTing a deliberately invalid body with no CSRF
  // token, relying on CSRF being switched off in settings.py:97. That cannot
  // survive this port's CSRF rule, so the Add button becomes a plain link with
  // ?name= -- the same mechanism routes/admin/foodbankLocation.ts already uses.
  // If this stops working the order screen's Add button silently becomes a
  // blank form and the admin retypes a product name by hand every time.
  it("pre-fills the name from ?name=, the port's replacement for Django's POST-as-prefill", async () => {
    const { res, html } = await get("/admin/item/new/?name=Sainsbury%27s%20Baked%20Beans%20%26%20Sausages");

    expect(res.status).toBe(200);
    expect(fieldValue(html, "id_name")).toBe("Sainsbury's Baked Beans & Sausages");
    // Pre-filling is not an error: the page must be a plain 200 with no banner,
    // or the admin is told something is wrong before they have typed anything.
    expect(errorBanner(html)).toBeNull();
    expect(fieldValue(html, "id_calories")).toBe("");
  });

  it("pre-fills the edit form from the stored row", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    const { res, html } = await get("/admin/item/baked-beans/edit/");

    expect(res.status).toBe(200);
    expect(html).toContain("<h2>Edit Item</h2>"); // views.py:2256 verbatim
    expect(html).toContain('class="form-edit-item"');
    expect(fieldValue(html, "id_name")).toBe("Baked Beans");
    // The number reaches the template as a number and renders as digits. A
    // read that stopped returning `calories` would hand the admin a blank box
    // they would then re-save as a validation error -- or, worse, as 0.
    expect(fieldValue(html, "id_calories")).toBe("78");
  });

  // views.py:2255's get_object_or_404, ported as items.ts:98's c.notFound().
  it("404s an unknown slug rather than offering a create form under an edit URL", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });

    const { res } = await get("/admin/item/no-such-item/edit/");

    expect(res.status).toBe(404);
  });

  // The GET and the POST are ONE function (items.ts:105 branches on the
  // method), which is exactly the shape in which a write leaks onto the read
  // path. Both URLs, because they take different branches through it.
  it("writes nothing on either form URL", async () => {
    seed({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });
    const before = rows();

    await get("/admin/item/new/?name=Ghost%20Item");
    await get("/admin/item/baked-beans/edit/");

    expect(rows()).toEqual(before);
  });

  it("redirects an unauthenticated visitor away from both form URLs", async () => {
    const created = await get("/admin/item/new/", { signedIn: false });
    expect(created.res.status).toBe(302);
    expect(created.res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fitem%2Fnew%2F");

    seed({ id: 4, name: "Baked Beans", slug: "baked-beans", calories: 78 });
    const edited = await get("/admin/item/baked-beans/edit/", { signedIn: false });
    expect(edited.res.status).toBe(302);
    expect(edited.res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fitem%2Fbaked-beans%2Fedit%2F");
  });
});

// ===========================================================================
// adminItemForm (POST, create). views.py:2265's `redirect("admin:items")` --
// back to the LIST, not to the edit page, unlike every other admin form here.
// ===========================================================================
describe("adminItemForm creating an item", () => {
  // ISSUE #34's CLASS, at its narrowest: a redirect is not evidence of a save.
  // The row is read straight back out of SQLite, column by column, because a
  // handler that parsed the fields, passed them down and wrote none of them
  // would produce this exact 302.
  it("actually stores the row, and redirects to the list", async () => {
    const { res } = await post("/admin/item/new/", { name: "Baked Beans", calories: "78" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/items/");
    expect(rows()).toEqual([{ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 }]);
  });

  // The CONTRACT get_calories depends on: whatever the admin typed, the column
  // reads back as a JS number, because givefood/utils/text.py:118-130's port
  // multiplies it by a weight and a string there would concatenate rather than
  // multiply.
  //
  // A CORRECTION TO THE OBVIOUS READING, run rather than reasoned: this does
  // NOT kill a dropped `Number.parseInt`. Rewriting items.ts:135 to bind the
  // raw string leaves every test in this file green (re-confirmed under
  // review, mutant `calories: rawCalories`), because SQLite's INTEGER
  // affinity is not advisory on the way IN -- a TEXT value that is a well-formed
  // integer literal is CONVERTED to an integer as it is stored, so "78", "078"
  // and "2147483648" all land as integers regardless (checked against real
  // SQLite with `typeof(calories)`, which answers "integer" in every case).
  // parseInt is still the right code -- it is what makes the value a number
  // before it reaches a database whose conversion rules are its own -- but this
  // test is not what enforces it, and no test written against this storage
  // engine could be.
  it("stores calories as a number, not the submitted string", async () => {
    await post("/admin/item/new/", { name: "Baked Beans", calories: "78" });

    expect(typeof rows()[0]!.calories).toBe("number");
    expect(db.prepare("SELECT typeof(calories) AS t FROM orderitem").get()).toEqual({ t: "integer" });
  });

  // forms.CharField's default strip=True, which items.ts:112 ports, is the only
  // normalisation Django applies to `name`. It matters beyond tidiness:
  // orderitem_name_uniq is BINARY, so an untrimmed " Baked Beans" is a second
  // legal row that get_calories (which matches on the name STRING) would never
  // find.
  it("trims the name before storing it, and derives the slug from the trimmed value", async () => {
    await post("/admin/item/new/", { name: "   Baked Beans   ", calories: " 78 " });

    expect(rows()).toEqual([{ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 }]);
  });

  // EVERY FIELD ROUND-TRIPS. This form declares exactly two, so this is the
  // whole of it: save, reload the edit form the handler's own redirect points
  // at, and read both values back out of the HTML. It is the single test that
  // would have caught #34 on day one, and it goes through the real slug the
  // real writer chose rather than one the test guessed.
  it("gives both fields back on the edit form the save produced", async () => {
    await post("/admin/item/new/", { name: "Sainsbury's Baked Beans & Sausages", calories: "94" });
    const slug = rows()[0]!.slug;
    expect(slug).toBe("sainsburys-baked-beans-sausages");

    const { res, html } = await get(`/admin/item/${slug}/edit/`);

    expect(res.status).toBe(200);
    expect(fieldValue(html, "id_name")).toBe("Sainsbury's Baked Beans & Sausages");
    expect(fieldValue(html, "id_calories")).toBe("94");
  });

  // PositiveIntegerField accepts 0, and "0" is falsy in JavaScript. The guard
  // at items.ts:120 tests the RAW STRING for emptiness, so 0 survives; a guard
  // written against the parsed number would reject every calorie-free item
  // (sparkling water, tea bags) with "Calories is required".
  it("accepts 0 calories", async () => {
    const { res } = await post("/admin/item/new/", { name: "Sparkling Water", calories: "0" });

    expect(res.status).toBe(302);
    expect(rows()[0]!.calories).toBe(0);
  });

  it("accepts a leading-zero calorie count and stores its numeric value", async () => {
    await post("/admin/item/new/", { name: "Baked Beans", calories: "078" });

    expect(rows()[0]!.calories).toBe(78);
  });

  // models/orders.py:293's max_length=100, which Django's ModelForm rejects
  // past with "Ensure this value has at most 100 characters". Both sides of
  // the boundary, because an off-by-one here either rejects a legal supermarket
  // name or lets one through to a column D1 would truncate.
  it("accepts a name of exactly 100 characters and refuses 101", async () => {
    const hundred = "B".repeat(100);
    const accepted = await post("/admin/item/new/", { name: hundred, calories: "78" });
    expect(accepted.res.status).toBe(302);
    expect(rows()[0]!.name).toHaveLength(100);

    const refused = await post("/admin/item/new/", { name: "C".repeat(101), calories: "78" });
    expect(refused.res.status).toBe(400);
    expect(errorBanner(refused.html)).toBe("Name must be 100 characters or fewer");
    expect(rows()).toHaveLength(1);
  });

  // SUSPECT, PINNED NOT FIXED. Django's PositiveIntegerField.formfield() sets
  // max_value from connection.ops.integer_field_range -- 2147483647 on the
  // source Postgres -- so Django refused this with "Ensure this value is less
  // than or equal to 2147483647." The port checks only `/^\d+$/`, so any
  // number of digits is accepted and stored. Harmless at 2147483648; past
  // 2^53 the parsed value is no longer the number the admin typed, and a value
  // large enough to leave SQLite's INTEGER range is stored as a float. Reported
  // rather than fixed, per TESTING.md.
  it("accepts a calorie count far beyond the range Django's PositiveIntegerField allowed", async () => {
    const { res } = await post("/admin/item/new/", { name: "Absurd Item", calories: "2147483648" });

    expect(res.status).toBe(302);
    expect(rows()[0]!.calories).toBe(2147483648);
  });

  // ADDED UNDER REVIEW. The edit path had this (it "redirects an
  // unauthenticated POST to sign-in and writes nothing") and the CREATE path
  // did not -- and create is the only path that can put a brand-new row in the
  // table, so it is the one where an unauthenticated write would leave no
  // "before" state to notice it against. The token is deliberately VALID: the
  // claim is that requireAdminAuth stops the request before adminItemForm runs
  // at all, not that some later check happened to catch it.
  it("redirects an unauthenticated POST to the create URL and inserts nothing", async () => {
    const { res } = await post("/admin/item/new/", { name: "Ghost Item", calories: "1" }, { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fitem%2Fnew%2F");
    expect(rows()).toEqual([]);
  });

  describe("refusals", () => {
    // Every case here asserts THREE things, because a fix that got any one of
    // them alone would still be the bug: the status, the admin's own values
    // coming back in the inputs, and the table not having moved. items.ts's
    // documented departure 2 is exactly this -- the other ported admin forms
    // return a bare text/plain 400 that throws the typed values away.
    it.each([
      ["", "78", "Name is required", "a blank name"],
      ["   ", "78", "Name is required", "a whitespace-only name"],
      ["Baked Beans", "", "Calories is required", "no calories"],
      ["Baked Beans", "   ", "Calories is required", "whitespace-only calories"],
      ["Baked Beans", "abc", "Calories must be a whole number of 0 or more", "non-numeric calories"],
      ["Baked Beans", "-5", "Calories must be a whole number of 0 or more", "negative calories"],
      ["Baked Beans", "12.5", "Calories must be a whole number of 0 or more", "fractional calories"],
      // parseInt alone would take "12abc" as 12 and store it, which is the
      // reason items.ts:122 tests the whole string with a regex.
      ["Baked Beans", "12abc", "Calories must be a whole number of 0 or more", "digits with trailing junk"],
      ["Baked Beans", "+78", "Calories must be a whole number of 0 or more", "an explicit plus sign"],
      ["Baked Beans", "1e3", "Calories must be a whole number of 0 or more", "exponent notation"],
    ])("refuses %j / %j with %j (%s)", async (name, calories, expected) => {
      const { res, html } = await post("/admin/item/new/", { name, calories });

      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
      expect(errorBanner(html)).toBe(expected);
      // The values come back TRIMMED -- items.ts:114 re-renders the normalised
      // pair, not the raw body. That is the value the admin's next save would
      // have stored anyway, and it is the current behaviour, so it is what is
      // asserted.
      expect(fieldValue(html, "id_name")).toBe(name.trim());
      expect(fieldValue(html, "id_calories")).toBe(calories.trim());
      expect(rows()).toEqual([]);
    });

    // The re-render has to still be a usable FORM, not an error page that
    // happens to contain the right strings. Without the token the admin's only
    // route forward is to retype everything somewhere else.
    it("comes back as a submittable form, not just an error", async () => {
      const { html } = await post("/admin/item/new/", { name: "Baked Beans", calories: "abc" });

      expect(html).toContain("<h2>New Item</h2>");
      expect(csrfField(html)).toBe(CSRF_RAW);
      expect(html).toContain("Submit");
    });

    // ISSUE #12, on this form. Before the pre-check the INSERT reached the
    // database, orderitem_name_uniq raised, and app.onError rendered the 500
    // page over the whole form. The message is items.ts:133's, which follows
    // Django's single-field unique_error_message() ("Order item with this Name
    // already exists.") plus the offending value -- the addition this port
    // makes consistently, and the same shape donationPoint.ts uses.
    it("refuses a duplicate name and keeps what the admin typed", async () => {
      seed({ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 });

      const { res, html } = await post("/admin/item/new/", { name: "Baked Beans", calories: "81" });

      expect(res.status).toBe(400);
      expect(errorBanner(html)).toBe('Order item with this Name already exists: "Baked Beans"');
      expect(fieldValue(html, "id_name")).toBe("Baked Beans");
      expect(fieldValue(html, "id_calories")).toBe("81");
      // Nothing inserted, and the row that was there is untouched -- a refusal
      // that had already overwritten the original would be worse than the 500.
      expect(rows()).toEqual([{ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 }]);
    });

    // The pre-check must be exactly as strict as orderitem_name_uniq and no
    // stricter. SQLite's `=` and the index are both BINARY, so these are two
    // legal, distinct rows; a check that "helpfully" case-folded would refuse a
    // save the database would have accepted, naming a duplicate the admin
    // cannot see anywhere on the list page.
    it("does not treat a name differing only in case as a duplicate", async () => {
      seed({ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 });

      const { res } = await post("/admin/item/new/", { name: "baked beans", calories: "81" });

      expect(res.status).toBe(302);
      expect(rows().map((r) => r.name)).toEqual(["Baked Beans", "baked beans"]);
      // And the slug was uniquified rather than collided: slugify() is NOT
      // case-sensitive even though the name check is, so this pair is exactly
      // the legacy collision 0014 refuses to make impossible.
      expect(rows().map((r) => r.slug)).toEqual(["baked-beans", "baked-beans-2"]);
    });

    // ORDER OF VALIDATION. items.ts checks name, then length, then calories,
    // then uniqueness, and the order is not arbitrary: reporting "already
    // exists" to someone who left the calories box empty tells them to change
    // the one field that was fine. Django reached the same order for a
    // different reason -- ModelForm._post_clean() runs field validation before
    // validate_unique() -- so this is parity as well as sense.
    it("reports a missing field ahead of the duplicate name", async () => {
      seed({ id: 1, name: "Baked Beans", slug: "baked-beans", calories: 78 });

      const { res, html } = await post("/admin/item/new/", { name: "Baked Beans", calories: "" });

      expect(res.status).toBe(400);
      expect(errorBanner(html)).toBe("Calories is required");
      expect(html).not.toContain("already exists");
    });

    // DOCUMENTED DEPARTURE 3 (items.ts:88-92). Django's `if request.POST:`
    // tests the QueryDict's TRUTHINESS, so a genuinely empty body fell through
    // to rendering an UNBOUND form at 200 -- an accident of Django's API. Here
    // a POST is always a submission. The csrf_token field is the only thing in
    // this body, and it is there because the alternative is a 403 that would
    // never reach the branch being pinned.
    it("treats a body with nothing but the CSRF token as a failed submission, not an empty form", async () => {
      const { res, html } = await post("/admin/item/new/", {});

      expect(res.status).toBe(400);
      expect(errorBanner(html)).toBe("Name is required");
      expect(rows()).toEqual([]);
    });
  });
});

// ===========================================================================
// adminItemForm (POST, edit) -- the same function with :slug matched.
// ===========================================================================
describe("adminItemForm editing an item", () => {
  beforeEach(() => {
    seed({ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 78 });
  });

  // Updated IN PLACE. The row count is the assertion that matters: an edit that
  // fell through to the INSERT branch would return the right slug, render the
  // right redirect, and quietly double the table -- and the duplicate would
  // then be refused forever by orderitem_name_uniq, so it would surface as
  // "saving this item started 500ing" days later.
  it("updates the row rather than inserting a second one, and re-derives the slug", async () => {
    const { res } = await post("/admin/item/baked-beans/edit/", { name: "Baked Beans 415g", calories: "81" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/items/");
    expect(rows()).toEqual([{ id: 7, name: "Baked Beans 415g", slug: "baked-beans-415g", calories: 81 }]);
  });

  // THE EXCLUSION items.ts:129's `clash.id !== existing?.id` EXISTS FOR. A
  // uniqueness check that matched the row being edited against its own
  // unchanged name would make correcting a calorie count impossible -- a worse
  // bug than #12, because it has no workaround at all. Twice, because a
  // self-exclusion that worked once and then walked the slug would also be a
  // defect (see orderItemAdmin.test.ts's "keeps its own slug when re-saved").
  it("lets an item keep its own name while changing the calories", async () => {
    const first = await post("/admin/item/baked-beans/edit/", { name: "Baked Beans", calories: "80" });
    expect(first.res.status).toBe(302);

    const second = await post("/admin/item/baked-beans/edit/", { name: "Baked Beans", calories: "82" });
    expect(second.res.status).toBe(302);

    expect(rows()).toEqual([{ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 82 }]);
  });

  // The maintainer's issue says "adding", but the edit path had the identical
  // hole: renaming one item onto another's name -- tidying wording, or merging
  // two near-duplicates -- hit the same index and the same 500.
  it("refuses a rename onto a sibling's name and moves nothing", async () => {
    seed({ id: 8, name: "Tinned Tomatoes", slug: "tinned-tomatoes", calories: 22 });

    const { res, html } = await post("/admin/item/tinned-tomatoes/edit/", { name: "Baked Beans", calories: "25" });

    expect(res.status).toBe(400);
    expect(errorBanner(html)).toBe('Order item with this Name already exists: "Baked Beans"');
    expect(rows()).toEqual([
      { id: 7, name: "Baked Beans", slug: "baked-beans", calories: 78 },
      { id: 8, name: "Tinned Tomatoes", slug: "tinned-tomatoes", calories: 22 },
    ]);
  });

  // A refusal on the edit path must come back as the EDIT form -- same title,
  // same URL, same values -- not as a create form that happens to be full of
  // the right strings. items.ts:145 keys the title off `existing`, which is
  // read before the POST branch and therefore survives the failure.
  it("re-renders as the edit form, carrying the attempted values", async () => {
    seed({ id: 8, name: "Tinned Tomatoes", slug: "tinned-tomatoes", calories: 22 });

    const { html } = await post("/admin/item/tinned-tomatoes/edit/", { name: "Baked Beans", calories: "25" });

    expect(html).toContain("<h2>Edit Item</h2>");
    expect(html).toContain('class="form-edit-item"');
    expect(fieldValue(html, "id_name")).toBe("Baked Beans");
    expect(fieldValue(html, "id_calories")).toBe("25");
  });

  it("refuses an invalid edit without touching the stored row", async () => {
    const { res, html } = await post("/admin/item/baked-beans/edit/", { name: "Baked Beans", calories: "-1" });

    expect(res.status).toBe(400);
    expect(errorBanner(html)).toBe("Calories must be a whole number of 0 or more");
    expect(rows()).toEqual([{ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 78 }]);
  });

  it("404s a POST to an unknown slug and writes nothing", async () => {
    const { res } = await post("/admin/item/no-such-item/edit/", { name: "Ghost Item", calories: "1" });

    expect(res.status).toBe(404);
    expect(rows()).toEqual([{ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 78 }]);
  });

  it("redirects an unauthenticated POST to sign-in and writes nothing", async () => {
    const { res } = await post("/admin/item/baked-beans/edit/", { name: "Hijacked", calories: "1" }, { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fitem%2Fbaked-beans%2Fedit%2F");
    expect(rows()).toEqual([{ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 78 }]);
  });
});

// ===========================================================================
// CSRF. Django's CsrfViewMiddleware is commented out in production
// (settings.py:97), so the `{% csrf_token %}` on these forms was decorative
// upstream -- this whole layer is the port's own, which is exactly why it needs
// tests. Every case asserts the status AND that no row moved: a check that
// returned 403 after having already written would be worse than no check.
// ===========================================================================
describe("adminItemForm CSRF", () => {
  beforeEach(() => {
    seed({ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 78 });
  });

  const UNCHANGED = [{ id: 7, name: "Baked Beans", slug: "baked-beans", calories: 78 }];

  it.each([
    ["the form field is missing", { csrfField: null } as Opts],
    ["the form field is empty", { csrfField: "" } as Opts],
    ["the form field is somebody else's token", { csrfField: "a".repeat(64) } as Opts],
    ["the cookie is missing", { csrfCookie: null } as Opts],
    // A signature that does not verify: the raw half is right, so a check that
    // only compared the field to the cookie's first segment would let this
    // through -- which is the whole difference between lib/csrf.ts's SIGNED
    // double-submit and a plain one an attacker can plant from a sibling
    // subdomain.
    ["the cookie signature does not verify", { csrfCookie: `${CSRF_RAW}.${"0".repeat(64)}` } as Opts],
    ["the cookie has no signature at all", { csrfCookie: CSRF_RAW } as Opts],
    ["the Origin is another site", { origin: "https://evil.invalid" } as Opts],
    ["Sec-Fetch-Site says cross-site", { secFetchSite: "cross-site" } as Opts],
  ])("refuses a create when %s", async (_why, opts) => {
    const { res, html } = await post("/admin/item/new/", { name: "Tinned Tomatoes", calories: "22" }, opts);

    expect(res.status).toBe(403);
    expect(html).toBe("Forbidden");
    expect(rows()).toEqual(UNCHANGED);
  });

  // ADDED UNDER REVIEW. lib/csrf.ts fails CLOSED on an unset secret -- both
  // halves: issueCsrfToken renders no token and sets no cookie, and verifyCsrf
  // refuses everything. Nothing here exercised that, and the shape of the
  // careless edit is familiar: `if (!secret)` looks like a redundant guard, and
  // deleting it hands `undefined` to hmacSha256Hex, which THROWS -- so a deploy
  // that had lost CSRF_SECRET would answer every admin save with a 500 (issue
  // #12's failure mode, losing whatever was typed) instead of a clean 403.
  //
  // HONEST LIMIT, named so nobody mistakes this for more than it is: this
  // cannot kill a mutant that substitutes a HARDCODED fallback secret
  // (`c.env.CSRF_SECRET ?? "dev-secret"`), because a black-box test cannot mint
  // a cookie signed with a constant it does not know. That one is unkillable
  // from the route level and belongs to lib/csrf.ts's own suite.
  it("fails closed when CSRF_SECRET is unset, rather than 500ing or accepting", async () => {
    env = { ...env, CSRF_SECRET: undefined } as unknown as AppEnv["Bindings"];

    // The form still renders -- an admin must be able to SEE the page and be
    // told what is wrong by the refusal, not meet a stack trace.
    const form = await get("/admin/item/new/");
    expect(form.res.status).toBe(200);
    expect(csrfField(form.html)).toBe("");
    expect(form.res.headers.get("Set-Cookie")).toBeNull();

    const { res } = await post("/admin/item/new/", { name: "Tinned Tomatoes", calories: "22" });
    expect(res.status).toBe(403);
    expect(rows()).toEqual(UNCHANGED);
  });

  it("refuses an edit with a bad token and leaves the row alone", async () => {
    const { res } = await post("/admin/item/baked-beans/edit/", { name: "Hijacked", calories: "1" }, { csrfField: "a".repeat(64) });

    expect(res.status).toBe(403);
    expect(rows()).toEqual(UNCHANGED);
  });

  // The check runs BEFORE validation (items.ts:108, ahead of every field
  // check), so a forged request never learns anything about the form's rules
  // or about which names are taken. Asserted with a body that is invalid in
  // two different ways: 403, never 400.
  it("refuses before it validates, so a forged request learns nothing", async () => {
    const { res, html } = await post("/admin/item/new/", { name: "", calories: "abc" }, { csrfField: null });

    expect(res.status).toBe(403);
    expect(html).not.toContain("Name is required");
  });

  // ORDERING PIN, and a mild surprise worth writing down: items.ts reads the
  // row (and 404s) at :97-98, BEFORE the CSRF check at :108. So a forged POST
  // to an unknown slug is answered 404, not 403 -- which does tell an
  // unauthenticated-in-CSRF-terms caller whether a slug exists, but they are
  // already past requireAdminAuth to get here, so it leaks nothing to anyone
  // who could not simply GET the page. Pinned so that reordering the two is a
  // deliberate act rather than an accident of a refactor.
  it("answers 404 rather than 403 when a bad-token POST names a slug that does not exist", async () => {
    const { res } = await post("/admin/item/no-such-item/edit/", { name: "Ghost", calories: "1" }, { csrfField: null });

    expect(res.status).toBe(404);
    expect(rows()).toEqual(UNCHANGED);
  });

  // Browsers that send neither header are still allowed through -- lib/csrf.ts
  // only enforces Origin and Sec-Fetch-Site WHEN PRESENT, because older
  // browsers omit both and the signed double-submit is the real protection.
  // Pinned so that "we also require Origin" is a decision someone makes on
  // purpose rather than a silent tightening that starts 403ing real admins.
  it("accepts a valid token from a client that sends neither Origin nor Sec-Fetch-Site", async () => {
    const { res } = await post("/admin/item/new/", { name: "Tinned Tomatoes", calories: "22" }, { origin: null, secFetchSite: null });

    expect(res.status).toBe(302);
    expect(rows()).toHaveLength(2);
  });

  // THE END-TO-END PROOF, and the only shape of CSRF test that shows the
  // mechanism actually joins up: no token is manufactured here. The form is
  // fetched with no CSRF cookie at all, the server mints one, and the raw token
  // is taken from the hidden field it rendered while the signed half is taken
  // from the Set-Cookie it sent. Posting those two back must succeed AND store
  // the row. If issueCsrfToken and verifyCsrf ever stop agreeing -- a changed
  // cookie name, a different separator, a re-minted token per render -- every
  // admin save in the port breaks, and this is the test that says so.
  it("accepts the token a fresh render actually minted", async () => {
    const form = await get("/admin/item/new/", { csrfCookie: null });
    expect(form.res.status).toBe(200);

    const setCookie = form.res.headers.get("Set-Cookie") ?? "";
    const minted = /__Host-csrf=([^;]+)/.exec(setCookie)?.[1];
    expect(minted).toBeTruthy();
    const rendered = csrfField(form.html);
    expect(rendered).toBeTruthy();
    // The hidden field is the RAW half of the cookie, never the whole thing --
    // shipping the signature to the page would defeat the point of signing it.
    expect(minted).toBe(`${rendered}.${await hmacSha256Hex(CSRF_SECRET, rendered!)}`);

    const { res } = await post("/admin/item/new/", { name: "Tinned Tomatoes", calories: "22" }, { csrfField: rendered, csrfCookie: minted });

    expect(res.status).toBe(302);
    expect(rows().map((r) => r.name)).toEqual(["Baked Beans", "Tinned Tomatoes"]);
  });
});

