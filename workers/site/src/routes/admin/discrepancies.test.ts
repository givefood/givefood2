import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../types";
import { FOODBANK_FIELDS } from "../../lib/adminFormFields";
import { hmacSha256Hex } from "../../lib/hmac";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { serverTiming } from "../../middleware/serverTiming";

// The discrepancy review page and its one action, driven end to end: real
// Hono routes at the paths routes/admin/index.ts:116-117 registers, real
// requireAdminAuth, real issueCsrfToken/verifyCsrf, real getDiscrepancyById /
// setDiscrepancyStatus / getFoodbankSlugAndUrlById / getFoodbankBySlug, and a
// real in-memory SQLite carrying the migrations' own foodbank and
// foodbankdiscrepancy tables plus the foodbankdiscrepancy_full VIEW the read
// goes through.
//
// TWO CLASSES OF FAILURE THIS FILE EXISTS FOR, both drawn from bugs this admin
// has actually shipped:
//
//   * github #34's class -- "the redirect said it saved". adminDiscrepancyAction
//     redirects to /admin/ unconditionally, so the ONLY evidence a status
//     change happened is the row. Every action test below reads the row back
//     out of SQLite after the response, and every refusal test asserts the row
//     is byte-for-byte what it was. A test that stopped at `expect(res.status)
//     .toBe(302)` would have passed against the version of this handler that
//     wrote nothing at all.
//
//   * github #12's class -- "the page threw away what the admin was given".
//     This page has no form state of its own, but it embeds a FULL, editable
//     FoodbankForm (discrepancy.njk:48-59) whose POST goes to foodbank_edit and
//     rewrites all 30 Foodbank columns. Every value that form is NOT given
//     comes back empty and BLANKS its column on save. So "hands the embedded
//     FoodbankForm a value for every field it renders" below walks
//     FOODBANK_FIELDS itself, not a hand-picked few: dropping one column from
//     getFoodbankBySlug's projection would silently erase it from any food
//     bank an admin resolved a discrepancy on.
//
// WHAT IS FAKED, AND WHY ONLY THIS. `render` is stubbed because the templates
// are precompiled into packages/templates/src/generated/, a gitignored build
// artefact -- importing the real one makes this suite fail on a fresh checkout
// for reasons that have nothing to do with discrepancies. Asserting on the
// CONTEXT handed to the template is also the more direct claim: "the embedded
// form was given the food bank's notes" is a statement about `foodbank`, not
// about markup. `buildPageContext` comes through the same module and is
// stubbed with it; nothing here is about the footer's version string. SESSIONS
// is a Map-backed KV so the REAL requireAdminAuth runs rather than being
// mocked away -- the auth assertions below are about that middleware actually
// refusing, not about a stub.

const mocks = vi.hoisted(() => ({
  render: vi.fn(async (_template: string, _context: Record<string, unknown>) => "<html>discrepancy</html>"),
}));

vi.mock("@givefood/templates", () => ({
  render: mocks.render,
  // adminPageContext spreads this in; the real one reads per-isolate runtime
  // identity that has nothing to do with this page.
  buildPageContext: (opts: { path: string }) => ({ canonical_path: opts.path }),
}));

const { adminDiscrepancyDetail, adminDiscrepancyAction } = await import("./discrepancies");

// migrations/0001_core.sql:10-46 verbatim for `foodbank` -- the whole table,
// not a reduction, because getFoodbankBySlug is a `SELECT *` and the field
// round-trip test below is precisely the claim that every column the admin
// form declares survives it. A trimmed fixture would make that test agree with
// whatever it happened to include.
//
// `foodbankdiscrepancy` is 0008_needcheck.sql:57-69 as amended by
// 0019_drop_foodbank_cache.sql:58 (foodbank_name dropped from the table), and
// foodbankdiscrepancy_full is 0019's own view definition -- which is where
// foodbank_name and foodbank_slug come from now. The view matters: the read
// path selects from it, and the write path updates the base table, so a test
// that used one for both would not notice them diverging.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL, alt_name TEXT, slug TEXT NOT NULL,
  address TEXT NOT NULL,
  postcode TEXT NOT NULL, country TEXT NOT NULL,
  lat_lng TEXT NOT NULL,
  latitude REAL, longitude REAL,
  delivery_address TEXT, delivery_lat_lng TEXT,
  network TEXT, network_id TEXT, notes TEXT,
  charity_number TEXT, charity_just_foodbank INTEGER NOT NULL,
  charity_id TEXT, charity_name TEXT, charity_type TEXT,
  charity_reg_date TEXT, charity_postcode TEXT, charity_website TEXT,
  charity_objectives TEXT, charity_purpose TEXT,
  facebook_page TEXT, bankuet_slug TEXT, fsa_id TEXT,
  contact_email TEXT NOT NULL, notification_email TEXT,
  phone_number TEXT, secondary_phone_number TEXT, delivery_phone_number TEXT,
  url TEXT NOT NULL, shopping_list_url TEXT NOT NULL,
  rss_url TEXT, news_url TEXT, donation_points_url TEXT,
  locations_url TEXT, contacts_url TEXT,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT,
  place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  address_is_administrative INTEGER NOT NULL,
  is_closed INTEGER NOT NULL, is_school INTEGER,
  no_locations INTEGER NOT NULL, no_donation_points INTEGER,
  days_between_needs INTEGER NOT NULL, footprint INTEGER,
  bounds_north REAL, bounds_south REAL, bounds_east REAL, bounds_west REAL,
  latest_need_id INTEGER,
  last_order TEXT, last_need TEXT, last_rfi TEXT, last_crawl TEXT,
  last_social_media_check TEXT, last_discrepancy_check TEXT,
  last_need_check TEXT, last_charity_check TEXT,
  created TEXT NOT NULL, modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);

CREATE TABLE foodbankdiscrepancy (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER,
  need_id INTEGER,
  url TEXT,
  discrepancy_type TEXT NOT NULL,
  discrepancy_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'New',
  created TEXT NOT NULL,
  modified TEXT NOT NULL
);
CREATE INDEX discrepancy_status_created_idx ON foodbankdiscrepancy(status, created DESC);

CREATE VIEW foodbankdiscrepancy_full AS
  SELECT d.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankdiscrepancy d
    LEFT JOIN foodbank f ON f.id = d.foodbank_id;

-- 0001_core.sql:109-122 as amended by 0019_drop_foodbank_cache.sql:57
-- (foodbank_name dropped), plus 0019's foodbankchange_full view. Here for
-- ONE reason: getFoodbankBySlug reads this view for the food bank's latest
-- need. It used to do so only when latest_need_id was non-null, and every
-- other test in this file leaves that column NULL, so the branch went
-- untested even though production sets it for nearly every food bank -- a
-- break in it would have 500ed this page for real data while the suite
-- stayed green. Since github #51 the read is batched with the food bank row
-- and sent unconditionally, so the table is now load-bearing for EVERY test
-- here. See "renders a food bank that has a latest need".
CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL,
  foodbank_id INTEGER,
  distill_id TEXT, name TEXT, uri TEXT,
  change_text TEXT NOT NULL,
  change_text_original TEXT,
  excess_change_text TEXT, excess_change_text_original TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  nonpertinent INTEGER,
  is_categorised INTEGER,
  notified TEXT, input_method TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE UNIQUE INDEX need_need_id_uniq ON foodbankchange(need_id);

CREATE VIEW foodbankchange_full AS
  SELECT c.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankchange c
    LEFT JOIN foodbank f ON f.id = c.foodbank_id;
`;

type Bindable = null | number | bigint | string | Uint8Array;

// Statements the handlers actually ran, so "a GET wrote nothing" can be
// asserted at the statement level as well as by re-reading the row -- a write
// that happened and was then overwritten by a seed would otherwise be
// invisible.
const reads: { sql: string; params: Bindable[] }[] = [];
const writes: { sql: string; params: Bindable[] }[] = [];

// The D1DatabaseSession surface packages/db uses, over node:sqlite -- same
// shape as the one in donationPoint.test.ts / foodbankLocation.test.ts. D1 is
// async and node:sqlite is synchronous; the SQL text, the parameter binding
// and the NULL semantics are SQLite's in both.
function d1Session(db: DatabaseSync) {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      reads.push({ sql, params });
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      reads.push({ sql, params });
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      // DEFERRED PAST A MACROTASK ON PURPOSE. D1's run() is a network round
      // trip; node:sqlite's is a function call, and a fake that ran the write
      // synchronously would make `await` optional. Mutation-tested: with a
      // synchronous fake, changing the handler's
      // `await setDiscrepancyStatus(...)` to `void setDiscrepancyStatus(...)`
      // (mutant `status_write_not_awaited`) passed all 39 tests -- the write
      // still landed before the assertions because nothing ever yielded. In a
      // Worker that same edit returns the redirect with the UPDATE still in
      // flight and no waitUntil holding the isolate open, which is github
      // #34's shape again: the admin is told it saved and nothing did. With
      // the yield below, the row is still unchanged when the response
      // resolves and every action test fails.
      await new Promise((resolve) => setTimeout(resolve, 0));
      writes.push({ sql, params });
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    // getFoodbankBySlug sends its food bank row and its latest-need row as ONE
    // batch() rather than two sequential awaits (packages/db/src/foodbank.ts).
    // The same adapter as packages/db/src/foodbankDetail.test.ts: statements
    // run in order and there is one result per input statement, in that order,
    // because the caller indexes straight into the array -- a batch that
    // reordered or coalesced results would hand back the wrong row without
    // erroring anywhere.
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
      const out: unknown[] = [];
      for (const each of statements) out.push(await each.all());
      return out;
    },
    getBookmark: () => null,
  };
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "b".repeat(64);
const SESSION_ID = "test-session-id";

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

// Every column FOODBANK_FIELDS names, each with a value distinct from every
// other, so "the embedded form got the right value" cannot pass by two columns
// happening to hold the same string. The four checkbox fields are stored as
// the INTEGER 1/0 D1 holds and read back through mapFoodbankRow's boolean
// coercion, which is why the round-trip test compares against `true`/`false`
// for those and the raw string for the rest.
const FOODBANK_FIELD_VALUES: Record<string, string | number> = {
  name: "Salisbury Foodbank",
  alt_name: "Banc Bwyd Caersallog",
  address: "Unit 3\r\nBemerton Heath",
  postcode: "SP2 9DY",
  country: "England",
  lat_lng: "51.0812,-1.8231",
  place_id: "ChIJVXealLU_xkcRja_At0z9AGY",
  delivery_address: "Rear yard, Unit 3",
  network: "Trussell",
  network_id: "TRU-4417",
  notes: "Private scratch notes, expensive to retype",
  charity_number: "1104521",
  charity_just_foodbank: 1,
  facebook_page: "salisburyfoodbank",
  bankuet_slug: "salisbury",
  fsa_id: "FSA-991",
  contact_email: "info@salisburyfoodbank.org.uk",
  notification_email: "needs@salisburyfoodbank.org.uk",
  phone_number: "01722349556",
  secondary_phone_number: "01722349557",
  delivery_phone_number: "01722349558",
  url: "https://salisburyfoodbank.org.uk/",
  shopping_list_url: "https://salisburyfoodbank.org.uk/give-help/food/",
  rss_url: "https://salisburyfoodbank.org.uk/feed/",
  news_url: "https://salisburyfoodbank.org.uk/news/",
  donation_points_url: "https://salisburyfoodbank.org.uk/donate/",
  locations_url: "https://salisburyfoodbank.org.uk/locations/",
  contacts_url: "https://salisburyfoodbank.org.uk/contact/",
  address_is_administrative: 1,
  is_closed: 0,
  is_school: 0,
};

// The columns FOODBANK_FIELDS does not name but the table declares NOT NULL,
// plus the identity columns the handler navigates by.
const FOODBANK_REQUIRED_EXTRAS: Record<string, string | number> = {
  uuid: "6f4c9d9a1b2c4d3e8f0a1b2c3d4e5f60",
  slug: "salisbury",
  no_locations: 0,
  days_between_needs: 7,
  created: "2019-04-01 09:00:00.000000",
  modified: "2026-09-01 09:00:00.000000",
};

const DISCREPANCY_URL = "https://salisburyfoodbank.org.uk/give-help/food/";

let db: DatabaseSync;
let sessions: Map<string, string>;
let env: AppEnv["Bindings"];
let app: Hono<AppEnv>;

function seedFoodbank(overrides: Record<string, string | number | null> = {}): number {
  const row = { id: 1, ...FOODBANK_FIELD_VALUES, ...FOODBANK_REQUIRED_EXTRAS, ...overrides };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO foodbank (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...(columns.map((c) => row[c as keyof typeof row]) as Bindable[]),
  );
  return row.id as number;
}

// A SECOND food bank, seeded at a LOWER id than the discrepancy's own so it
// is the row any query that lost its WHERE clause would return first. Every
// value that the page is asserted on differs from the subject's. Mutation
// tested: with only one food bank in the table, rewriting
// getFoodbankSlugAndUrlById's `WHERE id = ?` or getFoodbankBySlug's `WHERE
// slug = ?` into a no-op (mutants `slug_url_drops_where`, `by_slug_drops_where`)
// passed every test in this file -- the one row it returned was the right one
// by luck. On a real database with 3,000 food banks that mutant fills the
// embedded edit form with SOMEONE ELSE'S data, and the admin's next Save
// writes it over this food bank's row.
const DECOY_FOODBANK: Record<string, string | number | null> = {
  id: 1,
  uuid: "0000aaaa1111bbbb2222cccc3333dddd",
  name: "Aberdeen Foodbank",
  slug: "aberdeen",
  notes: "Aberdeen's own private notes",
  phone_number: "01224000000",
  url: "https://aberdeenfoodbank.org.uk/",
  shopping_list_url: "https://aberdeenfoodbank.org.uk/give-help/food/",
};

interface DiscrepancySeed {
  id: number;
  foodbankId?: number | null;
  needId?: number | null;
  url?: string | null;
  type?: string;
  text?: string;
  status?: string;
  created?: string;
  modified?: string;
}

function seedDiscrepancy(seed: DiscrepancySeed): number {
  db.prepare(
    `INSERT INTO foodbankdiscrepancy (id, foodbank_id, need_id, url, discrepancy_type, discrepancy_text, status, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.id,
    seed.foodbankId ?? null,
    seed.needId ?? null,
    seed.url ?? null,
    seed.type ?? "Shopping list URL",
    seed.text ?? "The shopping list page 404s",
    seed.status ?? "New",
    seed.created ?? "2026-08-30 11:15:00.000000",
    seed.modified ?? "2026-08-30 11:15:00.000000",
  );
  return seed.id;
}

// One row of the table getFoodbankBySlug's second query reads through
// foodbankchange_full, so a food bank can be seeded with a latest_need_id
// that resolves the way production's do.
function seedNeed(id: number, foodbankId: number, changeText: string): number {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, input_method, created, modified)
     VALUES (?, ?, ?, ?, 1, 'scrape', '2026-08-29 09:00:00.000000', '2026-08-29 09:00:00.000000')`,
  ).run(id, `${id}`.padStart(32, "0"), foodbankId, changeText);
  return id;
}

interface StoredDiscrepancy {
  id: number;
  foodbank_id: number | null;
  need_id: number | null;
  url: string | null;
  discrepancy_type: string;
  discrepancy_text: string;
  status: string;
  created: string;
  modified: string;
}

function stored(id: number): StoredDiscrepancy {
  return db.prepare("SELECT * FROM foodbankdiscrepancy WHERE id = ?").get(id) as unknown as StoredDiscrepancy;
}

function lastRender(): { template: string; context: Record<string, unknown> } {
  const call = mocks.render.mock.calls.at(-1);
  if (!call) throw new Error("the handler rendered nothing");
  return { template: call[0], context: call[1] };
}

async function csrfCookie(): Promise<string> {
  return `__Host-csrf=${CSRF_RAW}.${await hmacSha256Hex(CSRF_SECRET, CSRF_RAW)}`;
}

interface RequestOptions {
  cookies?: string[]; // replaces the default session + csrf pair entirely
  headers?: Record<string, string>;
  form?: Record<string, string>;
  method?: "GET" | "POST";
}

// One helper for both routes. The default cookie jar carries a valid admin
// session AND a valid CSRF cookie, so a test that wants to prove a refusal has
// to take one away explicitly -- the opposite arrangement (opt in to auth)
// makes it far too easy to write a passing test against a handler that is not
// actually reachable.
async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
  const method = opts.method ?? (opts.form ? "POST" : "GET");
  const cookies = opts.cookies ?? [`__Host-gfsession=${SESSION_ID}`, await csrfCookie()];
  const headers: Record<string, string> = {
    Cookie: cookies.join("; "),
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    ...opts.headers,
  };
  let body: string | undefined;
  if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  return app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, execCtx);
}

// The shape a browser actually posts from discrepancy.njk:38-43 -- the Invalid
// button's hidden csrf_token plus its hidden action.
function actionForm(action: string, token: string = CSRF_RAW): Record<string, string> {
  return { csrf_token: token, action };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.render.mockResolvedValue("<html>discrepancy</html>");
  reads.length = 0;
  writes.length = 0;

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);

  // A real admin session in a Map-backed KV, so requireAdminAuth's own
  // getAdminSession lookup succeeds for the reasons it does in production
  // rather than because the middleware was replaced. expiresAt is a full TTL
  // away, which keeps getAdminSession off its sliding-refresh write path.
  sessions = new Map([
    [
      `admin-session:${SESSION_ID}`,
      JSON.stringify({
        email: "someone@givefood.org.uk",
        name: "Some One",
        givenName: "Some",
        picture: "",
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      }),
    ],
  ]);

  env = {
    DB: { withSession: () => d1Session(db) },
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => void sessions.set(key, value),
      delete: async (key: string) => void sessions.delete(key),
    },
    CSRF_SECRET,
    GMAP_STATIC_KEY: "static-key",
    GMAP_GEOCODE_KEY: "geocode-key",
    D1_DATABASE_NAME: "givefood-test",
  } as unknown as AppEnv["Bindings"];

  // The production registration, verbatim from routes/admin/index.ts:116-117,
  // behind the same auth middleware adminApp applies -- so "GET on the action
  // URL is not routed" and "an unauthenticated request never reaches the
  // handler" are claims about the real wiring, not about this file's.
  app = new Hono<AppEnv>();
  app.use("*", serverTiming);
  app.use("/admin/*", requireAdminAuth);
  app.get("/admin/discrepancy/:id/", adminDiscrepancyDetail);
  app.post("/admin/discrepancy/:id/action/", adminDiscrepancyAction);
  // The 500 page github #12 was actually about. Labelled rather than left to
  // surface as an unhandled rejection, so a regression reads as "expected 200,
  // got 500: Invalid URL" instead of a vitest crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
});

describe("adminDiscrepancyDetail", () => {
  it("renders the review page for a real discrepancy", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1, url: DISCREPANCY_URL, type: "Shopping list URL", text: "The shopping list page 404s" });

    const res = await request("/admin/discrepancy/42/");

    expect(res.status).toBe(200);
    // Served as HTML, not as text -- `c.text(html)` (mutant
    // `html_becomes_text`) returns the same 200 with the same body and shows
    // the admin the template's markup as plain text.
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(lastRender().template).toBe("admin/discrepancy.njk");
    const discrepancy = lastRender().context.discrepancy as Record<string, unknown>;
    expect(discrepancy.id).toBe(42);
    expect(discrepancy.discrepancy_type).toBe("Shopping list URL");
    expect(discrepancy.discrepancy_text).toBe("The shopping list page 404s");
    expect(discrepancy.status).toBe("New");
    expect(discrepancy.url).toBe(DISCREPANCY_URL);
    // adminPageContext's `section`, which drives admin/page.njk's nav
    // highlight -- discrepancies live under Needs, not under their own tab.
    expect(lastRender().context.section).toBe("needs");
    // The session requireAdminAuth resolved, handed on through c.set
    // ("adminUser") -- admin/page.njk's "signed in as" and its Sign Out link
    // read it, and both vanish silently if the middleware stops setting it
    // (mutant `adminuser_not_set`, which survived until this line existed).
    expect(lastRender().context.admin_user).toEqual({
      email: "someone@givefood.org.uk",
      name: "Some One",
      givenName: "Some",
      picture: "",
    });
  });

  // Kills `slug_url_drops_where` and `by_slug_drops_where`: both of this
  // page's food bank reads are keyed lookups, and with a single row in the
  // table a lookup that matched EVERYTHING returned the right answer anyway.
  // The decoy sits at the lower id, so a WHERE-less query finds it first. The
  // consequence on production data is not a cosmetic mix-up: the food bank
  // shown here is loaded into a full, editable FoodbankForm, so resolving the
  // discrepancy would save Aberdeen's 30 columns over Salisbury's row.
  it("loads the food bank the discrepancy names, not simply the first row in the table", async () => {
    seedFoodbank(DECOY_FOODBANK);
    const subject = seedFoodbank({ id: 2, url: "https://salisburyfoodbank.org.uk/" });
    seedDiscrepancy({ id: 42, foodbankId: subject, url: DISCREPANCY_URL });

    await request("/admin/discrepancy/42/");

    const foodbank = lastRender().context.foodbank as Record<string, unknown>;
    expect(foodbank.id).toBe(2);
    expect(foodbank.slug).toBe("salisbury");
    expect(foodbank.name).toBe("Salisbury Foodbank");
    expect(foodbank.notes).toBe("Private scratch notes, expensive to retype");
    // The preview is built from the slug/url pair of the SAME food bank, so
    // it names salisbury -- the decoy's origin would not have matched the
    // discrepancy URL at all and the preview would have silently disappeared.
    expect(lastRender().context.proxy_src).toBe(
      "/admin/proxy/?foodbank=salisbury&field=url&target=https%3A%2F%2Fsalisburyfoodbank.org.uk%2Fgive-help%2Ffood%2F",
    );
  });

  // getFoodbankBySlug does not stop at the food bank row: it resolves
  // `latest_need_id` through foodbankchange_full in a second statement,
  // batched with the first. Nearly every food bank in production has a need;
  // every other test in this file leaves the column NULL, so this is the only
  // one where that statement returns a ROW rather than an empty result.
  // Without it a change that broke the mapping -- a renamed view, a column the
  // mapper needs going missing -- would 500 the review page for every real
  // food bank while the suite stayed green.
  it("renders a food bank that has a latest need, following the second statement that resolves it", async () => {
    const subject = seedFoodbank({ latest_need_id: 501 });
    // An OLDER need for the same food bank, at the lower id, so "the latest
    // need" is a claim about the key and not about the only row present
    // (mutant `need_by_id_drops_where` on getNeedById's own lookup) -- the
    // page would otherwise happily show a superseded need list.
    seedNeed(500, subject, "Nothing");
    seedNeed(501, subject, "Tinned tomatoes, UHT milk");
    seedDiscrepancy({ id: 42, foodbankId: subject });

    const res = await request("/admin/discrepancy/42/");

    expect(res.status).toBe(200);
    const foodbank = lastRender().context.foodbank as Record<string, unknown>;
    const latestNeed = foodbank.latestNeed as Record<string, unknown>;
    expect(latestNeed.change_text).toBe("Tinned tomatoes, UHT milk");
    // coerceBooleans ran on the joined row too, not just on the food bank.
    expect(latestNeed.published).toBe(true);
  });

  // foodbankdiscrepancy.foodbank_name was a denormalised column until
  // 0019_drop_foodbank_cache.sql dropped it in favour of the view's join. The
  // template still renders `discrepancy.foodbank_name` (discrepancy.njk:14), so
  // this asserts the name arrives from the JOIN and is therefore the food
  // bank's CURRENT name -- a read that went to the base table instead would
  // hand the template undefined and print an empty link label.
  it("takes the food bank's name and slug from the view's join, not from the discrepancy row", async () => {
    seedFoodbank({ name: "Salisbury Foodbank (renamed today)" });
    seedDiscrepancy({ id: 7, foodbankId: 1 });

    await request("/admin/discrepancy/7/");

    const discrepancy = lastRender().context.discrepancy as Record<string, unknown>;
    expect(discrepancy.foodbank_name).toBe("Salisbury Foodbank (renamed today)");
    expect(discrepancy.foodbank_slug).toBe("salisbury");
  });

  it("404s an id no discrepancy has", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1 });

    const res = await request("/admin/discrepancy/43/");

    expect(res.status).toBe(404);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // Django's own URL is `<slug:id>` (gfadmin/urls/needs.py:21), which happily
  // hands "banana" to get_object_or_404(id="banana") -- an unhandled ValueError
  // and a 500. The port answers 404 instead, and does it before it opens a D1
  // session at all, which is the assertion that would notice the guard being
  // moved below the query.
  it("404s a non-numeric id without touching the database", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1 });

    const res = await request("/admin/discrepancy/banana/");

    expect(res.status).toBe(404);
    expect(reads).toHaveLength(0);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // SUSPECT, pinned rather than fixed. `Number()` is not a decimal parser: it
  // accepts JavaScript's whole numeric-literal grammar, so /discrepancy/0x2a/
  // and /discrepancy/4.2e1/ both resolve to discrepancy 42 and render its
  // review page. Harmless on this route (it is a read of a row the admin can
  // already reach at its ordinary URL), but see the action route's equivalent
  // test, where the same aliasing reaches a write.
  it("resolves a hexadecimal or exponent-notation id to the same row", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1 });

    expect((await request("/admin/discrepancy/0x2a/")).status).toBe(200);
    expect((lastRender().context.discrepancy as Record<string, unknown>).id).toBe(42);

    expect((await request("/admin/discrepancy/4.2e1/")).status).toBe(200);
    expect((lastRender().context.discrepancy as Record<string, unknown>).id).toBe(42);
  });

  // The GET and the POST are separate exported functions here, but they share
  // a URL prefix and a maintainer's muscle memory. Django's discrepancy() is a
  // pure read; a GET that stamped `modified`, or "helpfully" marked a viewed
  // discrepancy Done, would be invisible in the response and visible only in
  // the row.
  it("writes nothing", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1, status: "New", modified: "2026-08-30 11:15:00.000000" });

    await request("/admin/discrepancy/42/");

    // The harness records what the handler ran, so this pair says "statements
    // were seen, and none of them was a write" rather than "the recorder is
    // empty" -- without the first line, every `writes`/`reads` assertion in
    // this file would also pass against a d1Session that recorded nothing.
    expect(reads.length).toBeGreaterThan(0);
    expect(writes).toHaveLength(0);
    expect(stored(42).status).toBe("New");
    expect(stored(42).modified).toBe("2026-08-30 11:15:00.000000");
  });

  // THE EXPENSIVE ONE. discrepancy.njk:50 renders `fieldset(foodbank_fields,
  // foodbank)`, i.e. an input per FOODBANK_FIELDS spec filled from this object,
  // and that form POSTs to foodbank_edit, whose parseAdminFields loops the same
  // spec list and writes every one of them. So any field this context does not
  // carry is posted back empty and BLANKS its column the moment an admin
  // resolves a discrepancy -- github #34's failure mode (a value silently lost
  // between the form and the row) pointed the other way. Walking
  // FOODBANK_FIELDS itself rather than a chosen handful is the point: a new
  // spec added to that list with no matching column would fail here on the day
  // it was added, not on the day it erased someone's phone number.
  //
  // The decoy is seeded FIRST, at the lower id, so this is simultaneously the
  // strongest place to catch a food bank read that lost its key: every one of
  // the 30 assertions below then compares Salisbury's expected value against
  // Aberdeen's stored one.
  it("hands the embedded FoodbankForm a value for every field it renders", async () => {
    seedFoodbank(DECOY_FOODBANK);
    seedFoodbank({ id: 2 });
    seedDiscrepancy({ id: 42, foodbankId: 2 });

    await request("/admin/discrepancy/42/");

    const foodbank = lastRender().context.foodbank as Record<string, unknown>;
    for (const spec of FOODBANK_FIELDS) {
      const seeded = FOODBANK_FIELD_VALUES[spec.name];
      // mapFoodbankRow coerces the five BOOLEAN_COLUMNS (four of which are on
      // this form) from D1's 1/0 to real booleans, so those compare against
      // true/false and everything else against the stored string.
      const expected = spec.kind === "checkbox" ? seeded === 1 : seeded;
      expect({ field: spec.name, value: foodbank[spec.name] }).toEqual({ field: spec.name, value: expected });
    }
  });

  // The spec list is passed by reference, not rebuilt -- so the form the
  // discrepancy page embeds is the same form definition
  // /admin/foodbank/<slug>/edit/ renders, and cannot drift from it.
  it("passes FOODBANK_FIELDS itself as the embedded form's field list", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1 });

    await request("/admin/discrepancy/42/");

    expect(lastRender().context.foodbank_fields).toBe(FOODBANK_FIELDS);
  });

  // needcheck raises discrepancies against a food bank it could not match, and
  // the template's `{% if foodbank %}` drops the whole edit column for those
  // (falling back to "Unknown" as the label). The handler must therefore render
  // at 200 with foodbank null, not 404 and not throw on a null foodbank_id.
  it("renders without a food bank column when the discrepancy has no food bank", async () => {
    seedDiscrepancy({ id: 9, foodbankId: null, url: DISCREPANCY_URL });

    const res = await request("/admin/discrepancy/9/");

    expect(res.status).toBe(200);
    expect(lastRender().context.foodbank).toBeNull();
    expect((lastRender().context.discrepancy as Record<string, unknown>).foodbank_name).toBeNull();
    expect(lastRender().context.show_proxy).toBe(false);
    expect(lastRender().context.proxy_src).toBeNull();
  });

  // There are no FK constraints in this schema (PLAN.md §4.5), so a deleted
  // food bank leaves its discrepancies pointing at nothing. The page must
  // still open -- this is exactly the discrepancy someone needs to dismiss.
  it("renders when the foodbank_id points at a row that no longer exists", async () => {
    seedDiscrepancy({ id: 9, foodbankId: 999, url: DISCREPANCY_URL });

    const res = await request("/admin/discrepancy/9/");

    expect(res.status).toBe(200);
    expect(lastRender().context.foodbank).toBeNull();
    expect(lastRender().context.show_proxy).toBe(false);
  });

  describe("the preview iframe", () => {
    // The whole point of WP 6.3's proxy rewrite: the iframe never carries an
    // arbitrary stored URL, it names a food bank and one of five known fields
    // and lets the proxy re-resolve the value from D1. `target` rides along
    // only so in-iframe navigation works, and routes/admin/proxy.ts checks its
    // origin again on the way in.
    it("offers a preview when the discrepancy URL is a page on the food bank's own site", async () => {
      seedFoodbank({ url: "https://salisburyfoodbank.org.uk/" });
      seedDiscrepancy({ id: 42, foodbankId: 1, url: "https://salisburyfoodbank.org.uk/give-help/food/?utm=needcheck" });

      await request("/admin/discrepancy/42/");

      expect(lastRender().context.show_proxy).toBe(true);
      expect(lastRender().context.proxy_src).toBe(
        "/admin/proxy/?foodbank=salisbury&field=url&target=https%3A%2F%2Fsalisburyfoodbank.org.uk%2Fgive-help%2Ffood%2F%3Futm%3Dneedcheck",
      );
    });

    // A discrepancy is often raised precisely BECAUSE the URL moved. `www.` is
    // a different origin, so the preview is withheld -- quietly, and without
    // taking the editable food bank form down with it, because that form is
    // how the admin fixes the URL the preview could not show.
    it("withholds the preview when the URL has drifted to another host, but keeps the edit form", async () => {
      seedFoodbank({ url: "https://salisburyfoodbank.org.uk/" });
      seedDiscrepancy({ id: 42, foodbankId: 1, url: "https://www.salisburyfoodbank.org.uk/give-help/food/" });

      await request("/admin/discrepancy/42/");

      expect(lastRender().context.show_proxy).toBe(false);
      expect(lastRender().context.proxy_src).toBeNull();
      expect((lastRender().context.foodbank as Record<string, unknown>).slug).toBe("salisbury");
    });

    // An origin is scheme + host + port, so an http:// discrepancy against an
    // https:// stored URL is NOT same-origin. Pinned because "same site" is the
    // looser rule someone might reach for, and it would let the proxy preview a
    // downgraded URL.
    it("withholds the preview across a scheme change", async () => {
      seedFoodbank({ url: "https://salisburyfoodbank.org.uk/" });
      seedDiscrepancy({ id: 42, foodbankId: 1, url: "http://salisburyfoodbank.org.uk/give-help/food/" });

      await request("/admin/discrepancy/42/");

      expect(lastRender().context.show_proxy).toBe(false);
    });

    // sameOrigin()'s try/catch, exercised rather than reasoned about. A
    // discrepancy's url is whatever the crawler stored; `new URL("not a url")`
    // throws, and an uncaught throw here would replace the review page with
    // app.onError's 500 -- on precisely the malformed-URL discrepancy someone
    // opened the page to deal with.
    it("does not 500 when the stored discrepancy URL is not a URL at all", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, url: "salisburyfoodbank.org.uk/give-help/food/" });

      const res = await request("/admin/discrepancy/42/");

      expect(res.status).toBe(200);
      expect(lastRender().context.show_proxy).toBe(false);
    });

    // BOTH query parameters are percent-encoded, not just `target`. No
    // slugify Django or this port ever ran produces the slug below -- Django's
    // slug charset is [-a-zA-Z0-9_] -- but `slug` is a plain TEXT column with
    // no CHECK behind it, and the encoding is the only thing standing between
    // a stored value and a SECOND `field=` parameter smuggled into the proxy's
    // query string. routes/admin/proxy.ts resolves `field` against the food
    // bank's five proxyable URL columns, so an unencoded slug (mutant
    // `proxy_slug_unencoded`, which survived until this test) would let the
    // stored text choose which of them the iframe fetches.
    it("percent-encodes the slug into the preview URL, not just the target", async () => {
      seedFoodbank({ slug: "salisbury&field=shopping_list_url", url: "https://salisburyfoodbank.org.uk/" });
      seedDiscrepancy({ id: 42, foodbankId: 1, url: DISCREPANCY_URL });

      await request("/admin/discrepancy/42/");

      expect(lastRender().context.proxy_src).toBe(
        "/admin/proxy/?foodbank=salisbury%26field%3Dshopping_list_url&field=url&target=https%3A%2F%2Fsalisburyfoodbank.org.uk%2Fgive-help%2Ffood%2F",
      );
    });

    it("offers no preview when the discrepancy carries no URL", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, url: null });

      await request("/admin/discrepancy/42/");

      expect(lastRender().context.show_proxy).toBe(false);
      expect(lastRender().context.proxy_src).toBeNull();
    });
  });

  // The page's two forms both post a csrf_token, and this is where they get
  // it. A page rendered with an empty token (which is what issueCsrfToken
  // returns when CSRF_SECRET is unset) would look completely normal and 403 on
  // every submission, so the token's presence is asserted here rather than
  // being left as an implication of the round-trip test at the bottom.
  it("issues a CSRF token and its cookie into the page", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1 });

    const res = await request("/admin/discrepancy/42/", { cookies: [`__Host-gfsession=${SESSION_ID}`] });

    expect(lastRender().context.csrf_token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers.get("set-cookie")).toContain("__Host-csrf=");
  });

  // The other half of that: a visitor who ALREADY holds a valid signed cookie
  // is handed back the token that cookie carries, and no new cookie is set.
  // This is the two-tab bug lib/csrf.ts's own comment describes, seen from the
  // page that suffers it: minting on every render replaces the cookie, and
  // verifyCsrf compares the submitted field against the cookie's raw token, so
  // the Invalid button on a discrepancy left open in another tab starts
  // answering 403. Mutation tested -- removing the reuse branch's early return
  // (mutant `csrf_issue_mints_every_time`) passed all 39 tests before this
  // one, because every test that submitted a token had rendered the page
  // immediately beforehand.
  it("reuses the CSRF token the visitor already holds instead of rotating it", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1 });

    const res = await request("/admin/discrepancy/42/");

    expect(lastRender().context.csrf_token).toBe(CSRF_RAW);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("redirects an unauthenticated visitor to sign in instead of rendering", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1 });

    const res = await request("/admin/discrepancy/42/", { cookies: [] });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/?next=%2Fadmin%2Fdiscrepancy%2F42%2F");
    expect(mocks.render).not.toHaveBeenCalled();
    expect(reads).toHaveLength(0);
  });
});

describe("adminDiscrepancyAction", () => {
  // gfadmin/views.py:2206-2217: "done" resolves, "invalid" dismisses, and both
  // end at redirect("admin:index"). The status lands in the base table while
  // every read comes through foodbankdiscrepancy_full, so the row is re-read
  // here to prove the write reached storage -- the redirect is identical
  // whether or not it did, which is exactly how github #34 stayed hidden.
  it("marks a discrepancy Done and redirects to the dashboard", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1, status: "New", modified: "2026-08-30 11:15:00.000000" });

    const res = await request("/admin/discrepancy/42/action/", { form: actionForm("done") });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/");
    expect(stored(42).status).toBe("Done");
  });

  // The only button discrepancy.njk actually renders (its comment explains
  // why): Done is reached by saving the embedded food bank form, Invalid by
  // this POST.
  it("marks a discrepancy Invalid and redirects to the dashboard", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

    const res = await request("/admin/discrepancy/42/action/", { form: actionForm("invalid") });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/");
    expect(stored(42).status).toBe("Invalid");
  });

  // `modified` is stamped by setDiscrepancyStatus, not by SQLite, so it is a
  // real part of the write contract -- and `created` is not in the SET list, so
  // dismissing a discrepancy must not renumber the dashboard's ordering
  // (getOpenDiscrepancies sorts by created DESC).
  it("stamps modified in Django's own timestamp format and leaves created alone", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1, created: "2026-08-30 11:15:00.000000", modified: "2026-08-30 11:15:00.000000" });

    await request("/admin/discrepancy/42/action/", { form: actionForm("done") });

    // pyDatetime's `YYYY-MM-DD HH:MM:SS.ffffff`, naive UTC, no offset -- the
    // format every other timestamp in this database is stored in.
    expect(stored(42).modified).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(stored(42).modified).not.toBe("2026-08-30 11:15:00.000000");
    expect(stored(42).created).toBe("2026-08-30 11:15:00.000000");
  });

  // The UPDATE names status and modified and nothing else. Asserted column by
  // column because a widened SET list -- say one that "tidied up" the url or
  // re-denormalised foodbank_name -- would be invisible in the response and
  // would quietly destroy the evidence the discrepancy was raised about.
  it("changes only the status, never the discrepancy's own evidence", async () => {
    seedFoodbank();
    seedDiscrepancy({
      id: 42,
      foodbankId: 1,
      needId: 88,
      url: DISCREPANCY_URL,
      type: "Shopping list URL",
      text: "The shopping list page 404s",
    });

    await request("/admin/discrepancy/42/action/", { form: actionForm("done") });

    const row = stored(42);
    expect(row.foodbank_id).toBe(1);
    expect(row.need_id).toBe(88);
    expect(row.url).toBe(DISCREPANCY_URL);
    expect(row.discrepancy_type).toBe("Shopping list URL");
    expect(row.discrepancy_text).toBe("The shopping list page 404s");
  });

  // The mutant killer for a dropped `WHERE id = ?`: without it every open
  // discrepancy in the queue would be resolved by one click, and the response
  // would look exactly the same.
  it("touches only the discrepancy named in the URL", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });
    seedDiscrepancy({ id: 43, foodbankId: 1, status: "New", modified: "2026-08-30 11:15:00.000000" });

    await request("/admin/discrepancy/42/action/", { form: actionForm("invalid") });

    expect(stored(43).status).toBe("New");
    expect(stored(43).modified).toBe("2026-08-30 11:15:00.000000");
  });

  // No guard on the current status, in Django or here -- an admin who dismissed
  // the wrong one fixes it by pressing the other action, and the queue query
  // (`status = 'New'`) means neither state is a dead end for the dashboard.
  it("lets a second action overwrite the first", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1, status: "Invalid" });

    await request("/admin/discrepancy/42/action/", { form: actionForm("done") });

    expect(stored(42).status).toBe("Done");
  });

  describe("refusals", () => {
    // WP 4.6's whole reason for existing: Django's CsrfViewMiddleware is
    // commented out in production (settings.py:97), so `{% csrf_token %}` on
    // the original's forms validated nothing. Every case below asserts the row
    // as well as the status -- a 403 that had already written would be worse
    // than no check at all, because it would look like the check worked.
    it("refuses a POST carrying no CSRF field", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/", { form: { action: "done" } });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
      expect(stored(42).status).toBe("New");
      expect(writes).toHaveLength(0);
    });

    it("refuses a POST whose token does not match the cookie", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/", { form: actionForm("done", "c".repeat(64)) });

      expect(res.status).toBe(403);
      expect(stored(42).status).toBe("New");
      expect(writes).toHaveLength(0);
    });

    // The half that makes this a SIGNED double-submit rather than a plain one:
    // an attacker who can set a cookie from a sibling subdomain can plant both
    // halves of a matching pair, and only the HMAC stops them.
    it("refuses a POST whose cookie signature does not verify", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/", {
        cookies: [`__Host-gfsession=${SESSION_ID}`, `__Host-csrf=${CSRF_RAW}.${"0".repeat(64)}`],
        form: actionForm("done"),
      });

      expect(res.status).toBe(403);
      expect(stored(42).status).toBe("New");
      expect(writes).toHaveLength(0);
    });

    it("refuses a POST with no CSRF cookie at all", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/", {
        cookies: [`__Host-gfsession=${SESSION_ID}`],
        form: actionForm("done"),
      });

      expect(res.status).toBe(403);
      expect(stored(42).status).toBe("New");
    });

    it("refuses a cross-origin POST even when both halves of the token are right", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/", {
        headers: { Origin: "https://evil.example" },
        form: actionForm("done"),
      });

      expect(res.status).toBe(403);
      expect(stored(42).status).toBe("New");
    });

    it("refuses a cross-site POST the browser labelled as such", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/", {
        headers: { "Sec-Fetch-Site": "cross-site" },
        form: actionForm("done"),
      });

      expect(res.status).toBe(403);
      expect(stored(42).status).toBe("New");
    });

    // DELIBERATE DIVERGENCE from gfadmin/views.py:2206-2217, pinned so it is a
    // decision rather than a drift. Django sets neither status for an unknown
    // action, calls discrepancy.save() anyway (bumping `modified` and nothing
    // else) and redirects to the dashboard as though something happened. The
    // port refuses with a 400 and writes nothing at all.
    it("rejects an unrecognised action without writing, where Django saved and redirected", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New", modified: "2026-08-30 11:15:00.000000" });

      const res = await request("/admin/discrepancy/42/action/", { form: actionForm("delete") });

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Bad request");
      expect(stored(42).status).toBe("New");
      expect(stored(42).modified).toBe("2026-08-30 11:15:00.000000");
      expect(writes).toHaveLength(0);
    });

    it("rejects a POST with no action field", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/", { form: { csrf_token: CSRF_RAW } });

      expect(res.status).toBe(400);
      expect(stored(42).status).toBe("New");
    });

    // The action names are compared case-sensitively, matching Django's own
    // `action == "done"`. Pinned because a hand-built POST is the only way to
    // send "Done", and it must fail the same way any other unknown string does
    // rather than falling through to some looser branch.
    it("rejects a differently-cased action", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/", { form: actionForm("Done") });

      expect(res.status).toBe(400);
      expect(stored(42).status).toBe("New");
    });

    // Ordering, asserted because it is security-relevant: CSRF is checked
    // BEFORE the action is looked at, so a forged cross-origin POST is told 403
    // (nothing about this endpoint) rather than 400 (a hint that "done" and
    // "invalid" are the words it wanted).
    it("answers 403, not 400, when the token is wrong and the action is too", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/", { form: actionForm("nonsense", "c".repeat(64)) });

      expect(res.status).toBe(403);
    });

    // The action is read from the POSTED BODY and from nowhere else. Pinned
    // because `body.action ?? c.req.query("action")` (mutant
    // `action_from_query_string`) is the sort of "be liberal in what you
    // accept" edit that survives every other test here, and it would make the
    // dismissal reachable from a URL -- so the whole action would travel in
    // Referer headers, browser history and the admin's own bookmarks, and any
    // future relaxation of the CSRF check would turn it straight into a
    // one-click forgery.
    it("takes the action from the body, never from the query string", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/?action=done", { form: { csrf_token: CSRF_RAW } });

      expect(res.status).toBe(400);
      expect(stored(42).status).toBe("New");
      expect(writes).toHaveLength(0);
    });

    it("404s a non-numeric id before it reads the body or checks CSRF", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/banana/action/", { form: actionForm("done") });

      expect(res.status).toBe(404);
      expect(writes).toHaveLength(0);
    });

    it("never reaches the handler for an unauthenticated POST", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/", { cookies: [], form: actionForm("done") });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/?next=%2Fadmin%2Fdiscrepancy%2F42%2Faction%2F");
      expect(stored(42).status).toBe("New");
      expect(writes).toHaveLength(0);
    });

    // WP 6.3's carried-forward requirement, and a real difference from Django,
    // whose discrepancy_action carries no @require_POST: there, following a
    // link (or a prefetching browser) could dismiss a discrepancy with a GET.
    // routes/admin/index.ts:117 registers POST only, so the URL simply does not
    // exist for a GET.
    it("does not route a GET to the action URL", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const res = await request("/admin/discrepancy/42/action/", { method: "GET" });

      expect(res.status).toBe(404);
      expect(stored(42).status).toBe("New");
      expect(writes).toHaveLength(0);
    });

    // ...and the same claim WITHOUT the routing table's help. The test above
    // only proves that this file registered `app.post`; it would go on passing
    // if someone added `adminApp.get("/discrepancy/:id/action/", ...)` to
    // routes/admin/index.ts next to the eight other routes there that are
    // registered for both verbs (`/need/new/`, `/foodbank/new/` and friends).
    // So the handler is mounted on GET deliberately here to pin what it does
    // when reached that way: a GET carries no form body, so there is no
    // csrf_token, so it refuses before it looks at anything else -- a
    // prefetching browser or a crawler following the URL cannot dismiss a
    // discrepancy even if the route is registered wrongly.
    it("refuses even if the handler is reached by a GET, because a GET carries no CSRF field", async () => {
      seedFoodbank();
      seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

      const mounted = new Hono<AppEnv>();
      mounted.use("/admin/*", requireAdminAuth);
      mounted.get("/admin/discrepancy/:id/action/", adminDiscrepancyAction);
      const res = await mounted.fetch(
        new Request(`${ORIGIN}/admin/discrepancy/42/action/`, {
          headers: { Cookie: [`__Host-gfsession=${SESSION_ID}`, await csrfCookie()].join("; ") },
        }),
        env,
        execCtx,
      );

      expect(res.status).toBe(403);
      expect(stored(42).status).toBe("New");
      expect(writes).toHaveLength(0);
    });
  });

  // SUSPECT, pinned as-is. Django's discrepancy_action opens with
  // get_object_or_404(FoodbankDiscrepancy, id=id), so an id that matches
  // nothing is a 404. This handler never looks the row up: it goes straight to
  // an UPDATE, which matches zero rows, and then redirects to /admin/ exactly
  // as it does on a real save. The admin is told the discrepancy was dismissed
  // and no discrepancy was dismissed -- github #34's shape (a redirect standing
  // in for a write that did not happen), here reached through a stale or
  // mistyped id rather than through missing SQL. Asserted, not fixed.
  it("redirects as though it worked when the discrepancy does not exist", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

    const res = await request("/admin/discrepancy/999/action/", { form: actionForm("done") });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/");
    // The UPDATE really did run, and really did change nothing.
    expect(writes).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankdiscrepancy").get() as { n: number }).toEqual({ n: 1 });
    expect(stored(42).status).toBe("New");
  });

  // SUSPECT, the write-reaching half of the detail route's `Number()` note.
  // Django's `<slug:id>` accepts "0x2a" and then dies on int("0x2a"); here the
  // URL segment is coerced by JavaScript's numeric-literal rules, so a POST to
  // /admin/discrepancy/0x2a/action/ resolves to id 42 and dismisses it. Nothing
  // in today's admin produces such a URL -- the template builds it from
  // `discrepancy.id` -- so this is pinned as the aliasing it is, not reported
  // as an exploit.
  it("accepts a hexadecimal id on the write path too", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

    const res = await request("/admin/discrepancy/0x2a/action/", { form: actionForm("invalid") });

    expect(res.status).toBe(302);
    expect(stored(42).status).toBe("Invalid");
  });
});

// The two halves joined up, because each is only worth what the other makes of
// it: the token the review page mints has to be the token the action route
// accepts. Both sides are the real lib/csrf.ts here, so a change to the cookie
// name, the `raw.signature` encoding or the HMAC input breaks this test even
// though it would leave every hand-built-token test above perfectly green --
// and in production it would silently 403 every Invalid button on the site.
describe("the page's own token, submitted back", () => {
  it("mints a token on the review page that the action route accepts", async () => {
    seedFoodbank();
    seedDiscrepancy({ id: 42, foodbankId: 1, status: "New" });

    const page = await request("/admin/discrepancy/42/", { cookies: [`__Host-gfsession=${SESSION_ID}`] });
    const token = lastRender().context.csrf_token as string;
    const setCookie = page.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0]!;

    const res = await request("/admin/discrepancy/42/action/", {
      cookies: [`__Host-gfsession=${SESSION_ID}`, cookie],
      form: actionForm("invalid", token),
    });

    expect(res.status).toBe(302);
    expect(stored(42).status).toBe("Invalid");
  });
});
