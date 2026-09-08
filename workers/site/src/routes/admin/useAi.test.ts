import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminFoodbankUseAiDetail } from "./useAi";
import { adminApp } from "./index";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// routes/admin/useAi.ts -- the "Use" button beside every AI-found value on
// admin/foodbank_check.njk:120-124. One press, one column, no page: the whole
// visible outcome is either a swapped-in disabled button (htmx) or a 302 back
// to the check page. That is precisely the shape GitHub issue #34 had -- a
// handler that parsed a value, passed it down, wrote no SQL, and redirected as
// though it had worked -- so every test here that expects a save READS THE ROW
// BACK OUT OF SQLITE, and every test that expects a refusal asserts the stored
// row is byte-identical to what it was before.
//
// `modified` is the tell in both directions. The handler always passes
// stampEdited=true, so a real write moves `modified` and `edited` even when the
// posted value happens to equal what was already stored; a refusal moves
// neither. That makes "nothing was written" a direct assertion rather than an
// inference from a status code.
//
// NOTHING IS MOCKED THAT DOES NOT LEAVE THE MACHINE. Real Hono app at the
// production path (routes/admin/index.ts:150), real requireAdminAuth, real
// verifyCsrf over a real HMAC-signed __Host-csrf cookie, and the shipped
// getFoodbankBySlug / updateFoodbankFields running their real SQL against a
// real in-memory SQLite. This handler renders no template and makes no fetch:
// despite the name it calls no AI, it commits a value workers/jobs' check job
// already found (the module's own header says so). The stubs are PURGE_Q.send
// -- the one thing in reach that leaves the Worker, and stubbing it turns "the
// public page was never purged" into a direct assertion -- and SESSIONS, a KV
// namespace faked as a Map for the real-router block at the end.
//
// TWO ROUTERS, on purpose. Most tests go through the mirror built in
// beforeEach, which registers this one handler with `app.all` so the GET tests
// can reach it at all. The block at the very end goes through `adminApp`
// ITSELF, because a mirror cannot fail when the thing it mirrors changes: four
// separate edits to routes/admin/index.ts -- including registering a GET
// alongside the POST and deleting the admin auth gate outright -- broke
// production and left the mirror entirely green.
//
// PARITY IS CHECKED BY RUNNING PYTHON, not by reading the view
// (TESTING.md's convention). Every claim below about what Django's
// URLValidator or validate_email would have done was produced by running
// Django 5.2.6 -- the version in /Users/jasoncartwright/Sites/foodcharity --
// against the exact strings in the tests.
//
// MUTATION-TESTED TWICE (TESTING.md's "several suites were mutation-tested").
// Both passes broke the shipped modules on disk, ran this file against the
// break, and restored them; nothing was reasoned about and then written down as
// though it had been executed.
//
// FIRST PASS -- the module's own logic. Each was run, and the number is how
// many tests went red: dropping the updateFoodbankFields call and redirecting
// anyway -- issue #34 reproduced exactly -- 33; writing every press into
// phone_number 25; dropping the field allow-list 21; stampEdited=false 15;
// dropping the URL check 9; skipping verifyCsrf 9; dropping the email check 5;
// dropping bankuet_slug from ALLOWED_FIELDS 4; letting isValidUrl accept any
// scheme 4; adding facebook_page to URL_FIELDS 3; dropping the phone strip 2;
// stripping only the first space rather than /\s+/g 2; validating the e-mail
// even when the value is empty 2; redirecting to the detail page instead of the
// check page 3; a 303 instead of a 302 33; tightening the HX-Request test to
// === "true" 1; returning the Used button as text/plain 1; dropping a class
// from that button 1; dropping contacts_url from URL_FIELDS 1; replacing the
// `typeof body.value === "string"` guard with String(...) 1; verifying the CSRF
// token against body.value instead of body.csrf_token 50; checking the token
// AFTER the write 9; writing only on the non-htmx branch 1; swapping the :slug
// and :field params 62; trimming the stored value 1; and ADDING the missing
// cache purge 1 -- that last one is the reported defect, and the single test it
// fails is the one that says so.
//
// SECOND PASS -- adversarial review, 2026-09-07. Seven mutants SURVIVED the 84
// tests this file had at the time. Six are now killed and the tests that kill
// them say so at the point of assertion; the seventh is proved equivalent:
//
//   * dropping the `await` in front of updateFoodbankFields  -> now 33 red.
//     Survived because the D1 shim wrote synchronously; the shim now defers by
//     a macrotask, which is what D1 actually does.
//   * relaxing updateFoodbankFields' `WHERE id = ?` to `WHERE id = ? OR 1 = 1`
//     -> now 11 red. Survived because the fixture held ONE food bank. It now
//     holds two.
//   * replacing `c.notFound()` with a hand-built `c.text(..., 404)` -> now 1
//     red. Survived a status-only assertion; the body is asserted.
//   * registering the route for GET as well as POST in index.ts -> now 1 red.
//   * deleting `adminApp.use("*", requireAdminAuth)` -> now 2 red.
//   * renaming the path, and separately the `:field` param, in index.ts -> 1
//     red each. Those four all needed the real router; see the last block.
//   * EQUIVALENT, not killed: `${foodbank.slug}` -> `${slug}` in the redirect.
//     See the test that pins it for why no input can separate the two.

// migrations/0001_core.sql:10-48, transcribed whole rather than reduced to the
// ten columns this route can write. That is the point of it: the round-trip
// test below diffs EVERY column across a save, so a SET clause that widened
// (the mirror image of #34's SET clause that was too narrow) has somewhere to
// show up -- and updateFoodbankFields really does append derived columns of its
// own, `slug` when `name` is in the fields and `latitude`/`longitude` when
// `lat_lng` is. Neither is on this route's allow-list, and the diff is what
// proves it. No later migration touches this table (checked: `ALTER TABLE
// foodbank ` appears in none of 0002-0023).
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
CREATE UNIQUE INDEX foodbank_name_uniq ON foodbank(name);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);
-- github #51: getFoodbankBySlug reads the food bank row and its latest need in
-- ONE batch(), so the need side is sent even when latest_need_id is NULL: the
-- scalar subquery yields NULL and the comparison matches nothing. Every route
-- below reaches that function, so this narrow fixture now needs the table and
-- the view.
--
-- TAKEN FROM THE MIGRATIONS, NOT TRANSCRIBED. 0019 drops a column off
-- foodbankchange long after 0001 creates it and recreates the view around it,
-- so a hand-copied CREATE TABLE here would have been wrong on the day it was
-- pasted -- which is the drift schema.testkit.ts exists to stop.
${schemaFor("foodbankchange", "foodbankchange_full")}
`;

type Bindable = null | number | bigint | string | Uint8Array;

// GENUINELY ASYNCHRONOUS, not merely `async`-shaped. Every statement yields to
// the MACROTASK queue before it touches SQLite, which is the one behavioural
// difference between D1 and node:sqlite that a route test can actually observe.
//
// This is not decoration. The plain `async () => { db.prepare(sql).run(...) }`
// shim the sibling suites use runs the write before it returns its first
// promise, so `updateFoodbankFields(...)` WITHOUT an `await` in front of it
// still lands the row before the test can look -- and dropping that one `await`
// SURVIVED all 84 tests when it was tried (adversarial pass, 2026-09-07). On
// Workers it would not survive contact with production: the handler returns its
// Response, the request context is torn down, and a D1 write still in flight is
// cancelled. That is issue #34's outcome -- a redirect, a green button and no
// row -- reached by a one-token edit. Deferring by a macrotask (a microtask is
// not enough: the test's own `await app.fetch(...)` continuation is itself a
// microtask and would queue behind the write) makes the missing `await`
// visible as a stale column.
//
// Everything else about the shim is the house pattern from
// foodbankUrls.test.ts / donationPoint.test.ts: the SQL text, the parameter
// binding and the NULL semantics are SQLite's on both sides.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function d1Session(db: DatabaseSync): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      await tick();
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      await tick();
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      await tick();
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
  } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "b".repeat(64);
const SLUG = "salisbury";
const SESSION_ID = "test-session-id";
const NOT_FOUND_BODY = "the app's own 404 page";

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// gfadmin/views.py:1321-1326's ALLOWED_FIELDS, transcribed verbatim and in
// Django's own order. The constant in useAi.ts is not exported, so this list is
// the parity fixture AND the probe: every name here must be accepted, and the
// rejected-field block below proves nothing outside it is. Same ten names as
// workers/jobs' checkPrompt.ts CHECK_USE_AI_FIELDS and foodbankCheck.ts's
// CHECK_USE_AI_FIELDS -- three hand-maintained copies, which is exactly why a
// behavioural check on this one is worth having.
const DJANGO_ALLOWED_FIELDS = [
  "phone_number",
  "contact_email",
  "charity_number",
  "facebook_page",
  "bankuet_slug",
  "rss_url",
  "news_url",
  "donation_points_url",
  "locations_url",
  "contacts_url",
] as const;
type AllowedField = (typeof DJANGO_ALLOWED_FIELDS)[number];

// views.py:1346's `url_fields` list, verbatim. Only these five get URLValidator
// in Django and isValidUrl here; the other five must not, which is what the
// "a non-URL field takes anything" test proves.
const DJANGO_URL_FIELDS: string[] = ["rss_url", "news_url", "donation_points_url", "locations_url", "contacts_url"];

// Ten distinguishable values, one per field, in the shape the check job's
// aiResponse.details actually carries. Distinguishable so that "the value
// arrived" cannot be satisfied by one value written into ten columns -- which
// is how a SET clause binding the same parameter twice would present. All ten
// differ from the seeded values below, so a write always shows in the diff, and
// none contains a space (phone stripping gets its own test).
const FOUND: Record<AllowedField, string> = {
  phone_number: "01722417001",
  contact_email: "hello@salisburyfoodbank.org.uk",
  charity_number: "1130190",
  facebook_page: "salisburydistrictfoodbank",
  bankuet_slug: "salisbury-district",
  rss_url: "https://salisburyfoodbank.org.uk/feed/",
  news_url: "https://salisburyfoodbank.org.uk/news/",
  donation_points_url: "https://salisburyfoodbank.org.uk/donate/where/",
  locations_url: "https://salisburyfoodbank.org.uk/centres/",
  contacts_url: "https://salisburyfoodbank.org.uk/contact-us/",
};

// What the row already holds -- every one of the ten populated, so that a
// handler which wrote nothing at all still leaves a plausible-looking row
// behind and only the diff catches it.
const STORED: Record<AllowedField, string> = {
  phone_number: "01722349556",
  contact_email: "info@salisburyfoodbank.org.uk",
  charity_number: "1000000",
  facebook_page: "oldsalisburypage",
  bankuet_slug: "salisbury",
  rss_url: "https://old.salisburyfoodbank.org.uk/rss/",
  news_url: "https://old.salisburyfoodbank.org.uk/latest/",
  donation_points_url: "https://old.salisburyfoodbank.org.uk/drop-off/",
  locations_url: "https://old.salisburyfoodbank.org.uk/where/",
  contacts_url: "https://old.salisburyfoodbank.org.uk/contact/",
};

// A SECOND FOOD BANK, SEEDED FOR EVERY TEST. Not scenery: a fixture holding one
// row cannot tell "UPDATE this food bank" from "UPDATE every food bank", and
// that gap was measured -- relaxing updateFoodbankFields' `WHERE id = ?` to
// `WHERE id = ? OR 1 = 1` survived all 84 tests (adversarial pass, 2026-09-07).
// Production has ~2,900 rows in this table, so that mutant is not a lost value,
// it is every food bank on the site given Salisbury's phone number, e-mail and
// charity number in one press, silently, from a button whose only feedback is
// "Used". Every one of the ten columns differs from Salisbury's so a cross-row
// write shows up wherever it lands.
const NEIGHBOUR_SLUG = "andover";
const NEIGHBOUR_STORED: Record<AllowedField, string> = {
  phone_number: "01264366366",
  contact_email: "info@andoverfoodbank.org.uk",
  charity_number: "2000000",
  facebook_page: "andoverfoodbankpage",
  bankuet_slug: "andover",
  rss_url: "https://andoverfoodbank.org.uk/rss/",
  news_url: "https://andoverfoodbank.org.uk/latest/",
  donation_points_url: "https://andoverfoodbank.org.uk/drop-off/",
  locations_url: "https://andoverfoodbank.org.uk/where/",
  contacts_url: "https://andoverfoodbank.org.uk/contact/",
};

const SEEDED_TIMESTAMP = "2020-01-01 00:00:00.000000";

let db: DatabaseSync;
let app: Hono<AppEnv>;
let env: AppEnv["Bindings"];
let purgeSend: ReturnType<typeof vi.fn>;
let sessions: Map<string, string>;

type FoodbankRowShape = Record<string, unknown> & { id: number; slug: string; name: string; modified: string; edited: string | null };

function row(slug = SLUG): FoodbankRowShape {
  return db.prepare("SELECT * FROM foodbank WHERE slug = ?").get(slug) as unknown as FoodbankRowShape;
}

function seed(id: number, slug: string, name: string, stored: Record<AllowedField, string>): void {
  const columns: Record<string, string | number | null> = {
    id,
    uuid: String(id).padStart(32, "a"),
    name,
    slug,
    address: `Unit ${id}\r\nBemerton Heath`,
    postcode: "SP2 9DY",
    country: "England",
    lat_lng: "51.0688,-1.7945",
    latitude: 51.0688,
    longitude: -1.7945,
    notes: `Private scratch notes for ${name} -- a Use press must not touch these`,
    place_id: "ChIJVXealLU_xkcRja_At0z9AGY",
    charity_just_foodbank: 0,
    url: `https://${slug}foodbank.org.uk/`,
    shopping_list_url: `https://${slug}foodbank.org.uk/shopping-list/`,
    secondary_phone_number: "01722000000",
    address_is_administrative: 0,
    is_closed: 0,
    no_locations: 3,
    days_between_needs: 14,
    parliamentary_constituency_slug: slug,
    // latest_need_id stays NULL: this route never reads the need, and NULL is
    // the shape production has for a food bank with none on file. It no longer
    // spares the fixture a foodbankchange table -- since github #51
    // getFoodbankBySlug batches that lookup and sends it either way -- so the
    // table and its view are in SCHEMA above.
    latest_need_id: null,
    created: SEEDED_TIMESTAMP,
    modified: SEEDED_TIMESTAMP,
    edited: SEEDED_TIMESTAMP,
    ...stored,
  };
  const names = Object.keys(columns);
  db.prepare(`INSERT INTO foodbank (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(
    ...(names.map((n) => columns[n]) as Bindable[]),
  );
}

// The signed double-submit pair lib/csrf.ts mints and then validates: the raw
// token in the hidden field (foodbank_check.njk:121 renders it), `raw.hmac` in
// the __Host- cookie. Built with the real hmacSha256Hex so verifyCsrf runs for
// real rather than being mocked into agreement with itself.
async function csrfCookie(raw = CSRF_RAW): Promise<string> {
  return `__Host-csrf=${raw}.${await hmacSha256Hex(CSRF_SECRET, raw)}`;
}

interface CallOptions {
  method?: "GET" | "POST";
  slug?: string;
  field?: string;
  /** The `value` form field. null omits it entirely, which is what Django's `request.POST.get('value','')` default exists for. */
  value?: string | null;
  /** The `csrf_token` form field. null omits it entirely. */
  formToken?: string | null;
  cookie?: string | null;
  origin?: string | null;
  secFetchSite?: string | null;
  hxRequest?: string | null;
  authenticated?: boolean;
  contentType?: string;
  /** Raw request body, bypassing URLSearchParams -- for the repeated-field case. */
  rawBody?: string;
  env?: AppEnv["Bindings"];
}

function pathFor(slug: string, field: string): string {
  return `/admin/foodbank/${slug}/use-ai/${field}/`;
}

async function call(opts: CallOptions = {}): Promise<Response> {
  const { method = "POST", slug = SLUG, field = "phone_number", formToken = CSRF_RAW } = opts;

  const headers: Record<string, string> = {};
  const cookie = opts.cookie === undefined ? await csrfCookie() : opts.cookie;
  if (cookie) headers.Cookie = cookie;
  if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  if (opts.secFetchSite !== null) headers["Sec-Fetch-Site"] = opts.secFetchSite ?? "same-origin";
  if (opts.hxRequest != null) headers["HX-Request"] = opts.hxRequest;

  let body: string | undefined;
  if (method === "POST") {
    headers["Content-Type"] = opts.contentType ?? "application/x-www-form-urlencoded";
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
    } else {
      const fields: Record<string, string> = {};
      if (formToken !== null) fields.csrf_token = formToken;
      if (opts.value !== null) fields.value = opts.value ?? FOUND.phone_number;
      body = new URLSearchParams(fields).toString();
    }
  }

  return app.fetch(
    new Request(`${ORIGIN}${pathFor(slug, field)}`, { method, headers, body }),
    { ...(opts.env ?? env), __authenticated: opts.authenticated !== false } as unknown as AppEnv["Bindings"],
    execCtx,
  );
}

/**
 * Press Use for one field with everything valid -- the happy path every refusal
 * is measured against. `field` and `value` are the arguments, so an opts.field
 * or opts.value passed here is ignored; use call() directly to omit either.
 */
function press(field: AllowedField, value: string = FOUND[field], opts: CallOptions = {}) {
  return call({ ...opts, field, value });
}

/** The columns whose stored value changed across an operation. The whole point of the wide fixture schema. */
function movedColumns(before: FoodbankRowShape, after: FoodbankRowShape): string[] {
  return Object.keys(after)
    .filter((column) => after[column] !== before[column])
    .sort();
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seed(1, SLUG, "Salisbury", STORED);
  seed(2, NEIGHBOUR_SLUG, "Andover", NEIGHBOUR_STORED);
  purgeSend = vi.fn(async () => {});
  // Keyed exactly as lib/adminAuth.ts:250's sessionKvKey() spells it -- a test
  // that invented its own key would "prove" the gate rejects everything. Only
  // the real-router block below reads this; the mirror app short-circuits the
  // gate. expiresAt a full TTL ahead so getAdminSession()'s sliding refresh
  // never fires and no test depends on the stub's put().
  sessions = new Map([
    [
      `admin-session:${SESSION_ID}`,
      JSON.stringify({ email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "", expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
    ],
  ]);

  env = {
    DB: { withSession: () => d1Session(db) },
    CSRF_SECRET,
    PURGE_Q: { send: purgeSend },
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => void sessions.set(key, value),
    },
  } as unknown as AppEnv["Bindings"];

  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    await next();
  });
  // The real gate, mounted where routes/admin/index.ts:85 mounts it
  // (`adminApp.use("*", requireAdminAuth)`). Signed-in requests are handed the
  // session the middleware would have resolved from KV; the auth block below
  // routes through requireAdminAuth itself instead, which is the only way to
  // prove an anonymous POST never reaches the handler.
  app.use("*", async (c, next) => {
    if ((c.env as unknown as { __authenticated: boolean }).__authenticated) {
      c.set("adminUser", { email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "" });
      return next();
    }
    return requireAdminAuth(c, next);
  });
  // `all`, where routes/admin/index.ts:150 registers POST-only. That is what
  // lets the GET block below reach the handler at all and assert what it does
  // with a request carrying no form body -- defence in depth behind the router,
  // which is the half that survives someone adding a GET registration later.
  app.all("/admin/foodbank/:slug/use-ai/:field/", adminFoodbankUseAiDetail);
  // A throw from the handler reaches app.onError in production and renders the
  // 500 page -- issue #12's loss. Labelled so a regression reads as "expected
  // 302, got 500: <sqlite message>" rather than as a vitest crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  // The app's OWN not-found renderer, standing in for the branded 404 page
  // index.ts installs. Given a body of its own so that `c.notFound()` --
  // handing the miss to the app -- is distinguishable from a handler that
  // builds its own `c.text("...", 404)`. Both are 404s, so status alone cannot
  // tell them apart, and the difference in production is the whole admin
  // chrome: a hand-rolled 404 drops the reviewer onto a bare text page with no
  // way back into the check queue.
  app.notFound((c) => c.text(NOT_FOUND_BODY, 404));
});

describe("the write actually happens", () => {
  // THE #34 TEST, ten times over. A press must move exactly its own column plus
  // the two timestamps: not a different column (the ten names differ only by
  // spelling, and a SET clause that lost one would look exactly like a SET
  // clause that lost none), not extra columns, and not nothing at all. The
  // "and nothing else" half is not decoration -- updateFoodbankFields appends
  // `slug` to its SET clause whenever `name` is among the fields and
  // `latitude`/`longitude` whenever `lat_lng` is, so a handler that let a
  // wrong field name through would not merely write a column, it would move the
  // food bank's public URL out from under every link to it.
  it.each([...DJANGO_ALLOWED_FIELDS])("stores the %s the check job found, and moves nothing else", async (field) => {
    const before = row();

    const res = await press(field);

    expect(res.status).toBe(302);
    const after = row();
    expect(after[field]).toBe(FOUND[field]);
    expect(movedColumns(before, after)).toEqual([field, "edited", "modified"].sort());
  });

  // gfadmin/views.py:1360 `redirect("admin:foodbank_check", slug=foodbank.slug)`
  // -- gfadmin/urls/foodbanks.py:16 under the "admin/" include, i.e. the check
  // page the button was pressed on. The non-htmx branch is what a browser with
  // JavaScript off (or an htmx that failed to load) takes, and it is the only
  // branch that tells the admin anything at all: landing anywhere else would
  // lose their place in a page of twenty AI suggestions.
  it("redirects back to the check page the button was pressed on", async () => {
    const res = await press("charity_number");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/foodbank/${SLUG}/check/`);
  });

  // The redirect is built from the STORED slug, not from the URL param. The two
  // are equal on every path that can reach here today (getFoodbankBySlug looks
  // the row up by that very slug), so this is a pin rather than a distinction:
  // it is the line that would matter if a slug redirect or a case-insensitive
  // lookup were ever added in front of this route.
  //
  // EQUIVALENT MUTANT, recorded so nobody spends the afternoon it cost:
  // rewriting `${foodbank.slug}` as `${slug}` survives, and NO test can kill it
  // today. getFoodbankBySlug matches `WHERE slug = ?` under SQLite's default
  // BINARY collation, so a row is only ever found when the two strings are
  // byte-identical, and Hono has already percent-decoded the param by the time
  // either is interpolated. The two expressions are indistinguishable until
  // something in front of this route makes them differ -- which is exactly the
  // change this test is waiting for.
  it("builds the redirect from the row's own slug", async () => {
    const res = await press("bankuet_slug");

    expect(res.headers.get("Location")).toContain(`/${row().slug}/`);
  });

  // gfadmin/views.py:1354 `foodbank.edited = timezone.now()` plus
  // TimestampedModel's auto_now `modified`. `edited` is not decorative: it
  // drives the admin's "next food bank to review" queue and the
  // foodbank_edited_idx ordering, so a press that saved without stamping it
  // would quietly leave the reviewed row at the front of the queue for ever.
  it("stamps edited and modified, the way Django's save() does", async () => {
    await press("facebook_page");

    const after = row();
    // pyNow()'s Django `str(datetime)` shape -- 'YYYY-MM-DD HH:MM:SS.ffffff',
    // naive UTC, no offset (packages/models/src/pyDatetime.ts). A space sorts
    // before "T", so a row written with an ISO "T" here would reorder every
    // admin list that sorts on these columns.
    expect(after.edited).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(after.modified).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(after.edited).not.toBe(SEEDED_TIMESTAMP);
    // updateFoodbankFields computes `now` once and binds it to both.
    expect(after.edited).toBe(after.modified);
  });

  // A press that changes nothing still counts as a review. The admin looked at
  // the AI's suggestion and accepted it; if `edited` only moved when the value
  // differed, re-confirming a value would leave the food bank in the review
  // queue and it would be served up again tomorrow.
  it("stamps the timestamps even when the found value equals what is already stored", async () => {
    const before = row();

    const res = await press("phone_number", STORED.phone_number);

    expect(res.status).toBe(302);
    const after = row();
    expect(after.phone_number).toBe(STORED.phone_number);
    // The two timestamps and NOTHING else -- this is the one press where the
    // diff cannot see the column itself move, so it is also the strictest
    // check that the write touched only what it meant to.
    expect(movedColumns(before, after)).toEqual(["edited", "modified"]);
    expect(after.edited).not.toBe(SEEDED_TIMESTAMP);
  });

  // The value is BOUND, never interpolated. updateFoodbankFields builds its SET
  // clause by string concatenation from the caller's keys (guarded by its own
  // COLUMN_NAME_RE), and only the keys -- the values go through .bind(). A
  // charity register scrape or an LLM can put anything in this box.
  it("binds the value rather than interpolating it", async () => {
    const nasty = "1130190'); DROP TABLE foodbank;--";

    const res = await press("charity_number", nasty);

    expect(res.status).toBe(302);
    expect(row().charity_number).toBe(nasty);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbank").get()).toEqual({ n: 2 });
  });

  // Hono's parseBody keeps the LAST value for a repeated key unless it is
  // called with { all: true } (hono/dist/utils/body.js's
  // convertFormDataToBodyData). Pinned because of what the OTHER branch would
  // do here: an array reaching `typeof body.value === "string"` reads as false,
  // value becomes "", and the press would blank the column instead of setting
  // it. htmx's hx-include="closest form" posts whatever is in the form, so the
  // day a second input shares the name this is the behaviour that decides
  // between "wrong value" and "silent data loss".
  it("takes the last value when the field is posted twice", async () => {
    const res = await call({
      field: "bankuet_slug",
      rawBody: new URLSearchParams([
        ["csrf_token", CSRF_RAW],
        ["value", "first"],
        ["value", "second"],
      ]).toString(),
    });

    expect(res.status).toBe(302);
    expect(row().bankuet_slug).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// One press, ONE food bank
// ---------------------------------------------------------------------------

// The block this suite was missing. Everything above reads back a single row,
// and a single-row fixture is blind by construction to the difference between
// "UPDATE the food bank in the path" and "UPDATE the table". Measured, not
// assumed: relaxing updateFoodbankFields' `WHERE id = ?` to `WHERE id = ? OR
// 1 = 1` left all 84 of the original tests green.
//
// The brief's list-page rule -- seed the rows that must be EXCLUDED, or a
// filter that does nothing passes -- applies with more force to a write than to
// a query. A list page with a dead filter shows too much; an UPDATE with a dead
// predicate overwrites every food bank on the site, from a button whose entire
// feedback is the word "Used".
describe("the write is scoped to the food bank in the path", () => {
  it.each([...DJANGO_ALLOWED_FIELDS])("leaves every other food bank untouched when %s is pressed", async (field) => {
    const before = row(NEIGHBOUR_SLUG);

    await press(field);

    // Whole-row equality, timestamps included: `modified` moving on a row
    // nobody pressed is the visible half of a missing predicate, and it is what
    // the admin's "least recently edited" queue would be reordered by.
    expect(row(NEIGHBOUR_SLUG)).toEqual(before);
  });

  // The other direction. The first test proves the write does not spill; this
  // one proves it lands on the row NAMED IN THE PATH rather than on whichever
  // row the query happens to reach first -- the mutant being `foodbank.id`
  // replaced by a constant, or a lookup that falls back to the head of the
  // table. Andover is id 2, so "the first row" and "the right row" differ.
  it("writes the food bank named in the path, not the first row in the table", async () => {
    const salisburyBefore = row();

    const res = await call({ slug: NEIGHBOUR_SLUG, field: "contact_email", value: FOUND.contact_email });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/foodbank/${NEIGHBOUR_SLUG}/check/`);
    expect(row(NEIGHBOUR_SLUG).contact_email).toBe(FOUND.contact_email);
    expect(row()).toEqual(salisburyBefore);
  });

  // A refusal must not spill either. A CSRF failure that had already written
  // would show up here as a second row moving, which no status-code assertion
  // anywhere in this file could see.
  it("touches neither food bank when the token is refused", async () => {
    const before = [row(), row(NEIGHBOUR_SLUG)];

    const res = await call({ formToken: "c".repeat(64) });

    expect(res.status).toBe(403);
    expect([row(), row(NEIGHBOUR_SLUG)]).toEqual(before);
  });
});

describe("the htmx branch", () => {
  // views.py:1358-1359. Byte-for-byte the string Django returned, because
  // foodbank_check.njk:123's button carries hx-swap="outerHTML": this markup
  // REPLACES the Use button in the page, and a class dropped from it leaves a
  // live-looking button that has already been used.
  const USED_BUTTON = '<button type="button" class="button is-small is-success is-light" disabled>Used</button>';

  it("swaps in the disabled Used button instead of redirecting", async () => {
    const res = await press("news_url", FOUND.news_url, { hxRequest: "true" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(USED_BUTTON);
  });

  // The branch that matters: the button swap is the ONLY evidence the admin
  // gets, so a handler that returned it without writing would be issue #34 with
  // a green tick on top.
  it("writes the column on the htmx path too", async () => {
    await press("locations_url", FOUND.locations_url, { hxRequest: "true" });

    expect(row().locations_url).toBe(FOUND.locations_url);
    expect(row().edited).not.toBe(SEEDED_TIMESTAMP);
  });

  // TRUTHINESS, not equality -- `request.headers.get('HX-Request')` in Django
  // and `c.req.header("HX-Request")` here are both bare truthiness tests, so a
  // literal "false" takes the htmx branch on both sides. Pinned as parity: htmx
  // only ever sends "true", so tightening this to === "true" would look like a
  // safe cleanup and would silently change what a proxy or a hand-rolled client
  // sending anything else receives.
  it("takes the htmx branch for any non-empty header value, exactly as Django did", async () => {
    const res = await press("contacts_url", FOUND.contacts_url, { hxRequest: "false" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(USED_BUTTON);
  });

  it("redirects when the header is absent", async () => {
    const res = await press("contacts_url");

    expect(res.status).toBe(302);
  });

  // THE REFUSAL THE ADMIN NEVER SEES -- pinned, and reported as suspect rather
  // than fixed. Every validation branch answers with bare `c.text(..., 400)`,
  // which is fine for the non-htmx path (the browser shows the message) and is
  // a dead end on the htmx one: htmx does not swap a non-2xx response by
  // default, and foodbank_check.njk sets no hx-target-error and no
  // htmx:responseError handler. So a press on an AI-found value the validators
  // reject leaves the Use button exactly as it was, with no message anywhere on
  // the page -- indistinguishable from a mis-click. That is the same family of
  // failure as issue #12 (a rejected save that told the admin nothing), reached
  // from the other side: nothing is lost here, but nothing is said either.
  //
  // Asserted rather than corrected, per TESTING.md: if the handler ever grows
  // an htmx-shaped error fragment, THIS is the test that should fail.
  it("answers a rejected htmx press with bare text htmx will not swap", async () => {
    const before = row();

    const res = await press("contact_email", "not-an-email", { hxRequest: "true" });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("Invalid email format");
    // No HX- response header that could retarget, reswap or reselect it into
    // the page either -- htmx is given nothing at all to act on.
    expect(res.headers.get("HX-Retarget")).toBeNull();
    expect(res.headers.get("HX-Reswap")).toBeNull();
    expect(row()).toEqual(before);
  });

  // Validation runs BEFORE the branch, so the htmx path is refused on exactly
  // the same inputs as the redirect path. Pinned because the mutant is
  // plausible in the other direction: moving the write and the checks below the
  // `if (HX-Request)` branch would leave the swap working and silently stop
  // validating anything the check page posts, which is every press in practice.
  it("refuses an unparseable URL on the htmx path too", async () => {
    const before = row();

    const res = await press("rss_url", "salisburyfoodbank.org.uk/feed/", { hxRequest: "true" });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid URL format");
    expect(row()).toEqual(before);
  });
});

describe("the field allow-list", () => {
  // views.py:1328-1329 `return HttpResponse('Invalid field', status=400)`.
  // The names below are the dangerous half of the rejection: every one is a
  // real, writable column on this table, so the allow-list is the only thing
  // between a crafted URL and an arbitrary single-column UPDATE. `name` and
  // `lat_lng` are the worst two, and they are worse than they look --
  // updateFoodbankFields re-derives `slug` from `name` and
  // `latitude`/`longitude` from `lat_lng`, so letting either through would move
  // the food bank's public URL or its position on the map, not merely dirty one
  // field.
  const REJECTED = [
    "name",
    "slug",
    "url",
    "shopping_list_url",
    "lat_lng",
    "postcode",
    "address",
    "is_closed",
    "notes",
    "place_id",
    "fsa_id",
    "secondary_phone_number",
    "notification_email",
  ];

  it.each(REJECTED)("refuses %s, a real column that is not on Django's list", async (field) => {
    const before = row();

    const res = await call({ field, value: "anything at all" });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid field");
    expect(row()).toEqual(before);
  });

  // Exact-match, not a prefix or a case-fold. `Array.includes` gives that for
  // free today; the test is here so a future "be helpful about spelling"
  // rewrite has to be a deliberate decision rather than an accident.
  it.each(["PHONE_NUMBER", "phone_number ", " phone_number", "phone", "phone_numbers", "rss_url;--"])(
    "refuses %s rather than matching it loosely",
    async (field) => {
      const before = row();

      const res = await call({ field, value: "anything at all" });

      expect(res.status).toBe(400);
      expect(row()).toEqual(before);
    },
  );

  // ORDER OF THE GUARDS, pinned because it is observable. The field check runs
  // before the food bank is looked up and before the token is verified
  // (useAi.ts:30 vs :33 and :38), so an unknown field on an unknown slug with
  // no token at all comes back 400 rather than 404 or 403. Cheapest check
  // first is the right order; this test exists so that reordering it -- and
  // thereby changing what every bad request reports -- is visible.
  it("reports the bad field before the missing food bank or the missing token", async () => {
    const res = await call({ field: "not_a_column", slug: "no-such-foodbank", formToken: null, cookie: null });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid field");
  });
});

describe("validation", () => {
  // views.py:1338-1343. isValidEmail is imported from lib/adminFormFields
  // rather than re-implemented precisely so the check page and the edit form
  // agree; adminFormFields.test.ts pins the predicate itself, and this is the
  // route-level half -- that the refusal is a 400 with Django's own message and
  // that NOTHING was written, not even the timestamps.
  it.each(["not-an-email", "a b@c.com", "missing-at.example.org", "two@@example.org"])(
    "refuses %s as a contact_email and writes nothing",
    async (value) => {
      const before = row();

      const res = await press("contact_email", value);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Invalid email format");
      expect(row()).toEqual(before);
    },
  );

  // views.py:1346-1351, the five URL fields only.
  it.each(DJANGO_URL_FIELDS)("refuses an unparseable %s and writes nothing", async (field) => {
    const before = row();

    const res = await call({ field, value: "salisburyfoodbank.org.uk/feed/" });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid URL format");
    expect(row()).toEqual(before);
  });

  // isValidUrl's protocol allow-list, which is the half `new URL()` alone does
  // not give: a javascript: or data: URL parses perfectly well and would be
  // rendered into an href on the public food bank page.
  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"])(
    "refuses the non-http(s) scheme %s",
    async (value) => {
      const before = row();

      const res = await press("news_url", value);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Invalid URL format");
      expect(row()).toEqual(before);
    },
  );

  // THE MUTANT KILLER FOR THE URL_FIELDS SET. Five of the ten fields get URL
  // validation and five do not; a Set that gained `facebook_page` would start
  // refusing the bare page slugs the check job actually finds
  // (foodbank_check.njk shows "salisburydistrictfoodbank", not a URL), and
  // every one of those refusals would look like the AI having found nothing.
  // phone_number is deliberately not in this list: it is the fifth non-URL
  // field but the only one that rewrites its value, so it gets its own tests
  // below rather than an expectation with the spaces already taken out.
  it.each(["facebook_page", "bankuet_slug", "charity_number"])("accepts a non-URL value in %s", async (field) => {
    // `new URL()` throws on this, so it would be a 400 in any of the five URL
    // fields -- which is what makes it evidence that isValidUrl was never
    // consulted for these three.
    const value = "definitely not a url";

    const res = await call({ field, value });

    expect(res.status).toBe(302);
    expect(row()[field]).toBe(value);
  });

  // givefood/models/foodbank.py:648-652 strips spaces in save(), and this
  // handler does its own strip first (views.py:1334-1336). Not cosmetic:
  // friendly_phone/full_phone re-space the number BY CHARACTER POSITION
  // (packages/templates/src/filters.ts:7-15), so an unstripped value renders
  // back mangled on every public and admin page with a broken tel: href -- and
  // the AI returns numbers exactly as the food bank writes them, spaced.
  it("strips the spaces out of a found phone number", async () => {
    const res = await press("phone_number", "01722 417 001");

    expect(res.status).toBe(302);
    expect(row().phone_number).toBe("01722417001");
  });

  // A DIVERGENCE, pinned in both places. This handler strips /\s+/g while
  // parseAdminFields (the edit form's path) does Python's literal
  // `.split(" ").join("")` -- adminFormFields.test.ts's "strips literal single
  // spaces only" says so from the other side. So a tab-containing number is
  // cleaned by pressing Use and NOT cleaned by typing the same string into the
  // form, and Django cleaned neither. Nothing here is broken; it is written
  // down so that "make the two agree" is a decision about which one wins.
  it("strips tabs and newlines too, which Django's single-space replace did not", async () => {
    const res = await press("phone_number", "01722\t417\n001");

    expect(res.status).toBe(302);
    expect(row().phone_number).toBe("01722417001");
  });

  // Every validation branch in the handler is gated on a non-empty value, so an
  // empty press skips all three and goes straight to the write -- exactly as
  // Django's `if field == '...' and value:` guards did.
  it("skips validation entirely when the value is empty", async () => {
    const res = await press("contact_email", "");

    expect(res.status).toBe(302);
    expect(row().contact_email).toBe("");
  });
});

describe("an empty value blanks the column", () => {
  // WHAT AN EMPTY PRESS STORES: "", not NULL. That matches Django exactly
  // (`value = request.POST.get('value','')` then setattr, on columns declared
  // null=True blank=True), and it is the opposite of what every FORM on this
  // site does -- parseAdminFields turns an empty box into NULL, and
  // foodbankUrls.test.ts pins that. Two write paths, two different empties in
  // the same column.
  //
  // It is currently harmless because the two consumers that filter on these
  // columns spell the guard both ways: packages/db/src/articles.ts:22 is
  // `rss_url IS NOT NULL AND rss_url != ''` and charity.ts:25 is the same for
  // charity_number. The second assertion is the one that matters -- it says out
  // loud that a plain `IS NOT NULL` filter written anywhere else would pick
  // this row up and hand an empty string to a fetcher.
  it("stores an empty string rather than NULL", async () => {
    const res = await press("rss_url", "");

    expect(res.status).toBe(302);
    expect(row().rss_url).toBe("");
    // The emptied row is STILL RETURNED by a plain `IS NOT NULL` filter -- the
    // point of the assertion, and the reason it names the row's id rather than
    // counting: Andover is seeded with a real feed URL and would satisfy the
    // filter on its own, so a bare `toHaveLength` would pass whether or not
    // Salisbury survived the blanking.
    const withFeeds = (db.prepare("SELECT id FROM foodbank WHERE rss_url IS NOT NULL").all() as { id: number }[]).map((r) => r.id);
    expect(withFeeds).toContain(1);
  });

  // The same blanking reached by omitting the field rather than emptying it.
  // Django's `.get('value','')` default and this port's `typeof body.value ===
  // "string" ? ... : ""` agree, so there is no "leave this column alone" state:
  // any accepted POST writes the column. Unreachable from today's admin --
  // foodbank_check.njk:120-124 only renders the form when
  // `result.aiResponse.details[field]` is non-empty, and the hidden input
  // always carries it -- but a replayed or hand-built POST blanks the column,
  // and this is the test that says so instead of leaving it to be discovered.
  it("blanks the column when the POST omits the value field entirely", async () => {
    const res = await call({ field: "charity_number", value: null });

    expect(res.status).toBe(302);
    expect(row().charity_number).toBe("");
    expect(row().edited).not.toBe(SEEDED_TIMESTAMP);
  });

  // The `typeof body.value === "string"` guard is not only for the type
  // checker. parseBody hands back a File for a multipart part with a filename,
  // and a File is not a string -- so it reads as an absent value and blanks the
  // column, rather than being stringified into a stored "[object File]". Both
  // outcomes are wrong for the admin, but one of them is recoverable by
  // pressing Use again and the other writes nonsense into a column the public
  // page renders.
  it("treats a value posted as a multipart file part as absent", async () => {
    const boundary = "----useaitestboundary";
    const res = await call({
      field: "news_url",
      contentType: `multipart/form-data; boundary=${boundary}`,
      rawBody: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="csrf_token"',
        "",
        CSRF_RAW,
        `--${boundary}`,
        'Content-Disposition: form-data; name="value"; filename="found.txt"',
        "Content-Type: text/plain",
        "",
        "https://example.org/from-a-file/",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    });

    expect(res.status).toBe(302);
    expect(row().news_url).toBe("");
  });

  // contact_email is NOT NULL in the schema (0001_core.sql:25) and the public
  // page renders a mailto: from it. "" satisfies the constraint, so the write
  // succeeds and no error appears anywhere -- pinned because the failure it
  // would otherwise be mistaken for is a database refusal, which this is not.
  it("blanks even the NOT NULL contact_email without an error", async () => {
    const res = await press("contact_email", "");

    expect(res.status).toBe(302);
    expect(row().contact_email).toBe("");
  });
});

// The port's validators are NOT Django's, in both directions. Django ran
// URLValidator (a regex demanding a hostname with a TLD, and permitting ftp)
// and validate_email (which demands a 2+ character TLD but allow-lists
// "localhost"); the port runs `new URL()` with an http/https protocol check and
// a coarse `[^\s@]+@[^\s@]+\.[^\s@]+` shape. Every expectation below was
// produced by running Django 5.2.6, not transcribed from memory. None of these
// is a bug on its own -- they are the edges of a deliberate simplification --
// but they are the inputs where a "port matches Django" claim is false, and
// they should fail loudly if someone swaps one validator for the other.
describe("where this port's validation differs from Django's", () => {
  it("refuses an ftp:// feed URL that Django's URLValidator accepted", async () => {
    // URLValidator.schemes is ['http', 'https', 'ftp', 'ftps'].
    const res = await press("rss_url", "ftp://example.com/feed.xml");

    expect(res.status).toBe(400);
    expect(row().rss_url).toBe(STORED.rss_url);
  });

  it("accepts a host with no dot in it, which Django refused", async () => {
    // Django's host_re requires a domain plus a TLD (or literal "localhost").
    const res = await press("news_url", "http://intranet/news/");

    expect(res.status).toBe(302);
    expect(row().news_url).toBe("http://intranet/news/");
  });

  it("refuses user@localhost, which Django's allow-list accepted", async () => {
    const res = await press("contact_email", "user@localhost");

    expect(res.status).toBe(400);
    expect(row().contact_email).toBe(STORED.contact_email);
  });

  it("accepts a one-character TLD, which Django refused", async () => {
    const res = await press("contact_email", "a@b.c");

    expect(res.status).toBe(302);
    expect(row().contact_email).toBe("a@b.c");
  });

  // SUSPECT, reported rather than fixed. `new URL()` tolerates surrounding
  // whitespace and an unencoded space in the path -- it strips or percent-
  // encodes them while parsing -- but the handler stores the RAW string it was
  // given, not url.href. So a URL that only validated because the parser
  // cleaned it up is stored dirty: Django refused both of these outright, and
  // every other admin write path trims (parseAdminFields' `.trim()`). What
  // lands in the column is a value no fetch of ours will handle the way the
  // reviewer expects.
  it("accepts a whitespace-padded URL and stores the padding", async () => {
    const res = await press("locations_url", "  https://example.org/centres/  ");

    expect(res.status).toBe(302);
    expect(row().locations_url).toBe("  https://example.org/centres/  ");
  });

  it("accepts a URL with an unencoded space and stores it unencoded", async () => {
    const res = await press("contacts_url", "https://example.org/contact us/");

    expect(res.status).toBe(302);
    expect(row().contacts_url).toBe("https://example.org/contact us/");
  });
});

describe("CSRF", () => {
  // The control. Without it every 403 below could be passing for the wrong
  // reason -- a mis-signed fixture cookie would make the whole block green
  // while proving nothing.
  it("accepts the token foodbank_check.njk rendered into the form", async () => {
    const res = await press("phone_number");

    expect(res.status).toBe(302);
    expect(row().phone_number).toBe(FOUND.phone_number);
  });

  // Django's CsrfViewMiddleware is commented out in production
  // (settings.py:97), so the `{% csrf_token %}` on this form was decorative
  // there and is load-bearing here (lib/csrf.ts's header). Each refusal asserts
  // the row is untouched as well as the status: a check that 403s AFTER writing
  // would be no check at all.
  it("refuses a POST with no token", async () => {
    const before = row();

    const res = await call({ formToken: null });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(row()).toEqual(before);
  });

  it("refuses a token that does not match the cookie", async () => {
    const before = row();

    const res = await call({ formToken: "c".repeat(64) });

    expect(res.status).toBe(403);
    expect(row()).toEqual(before);
  });

  it("refuses a request with no CSRF cookie at all", async () => {
    const before = row();

    const res = await call({ cookie: null });

    expect(res.status).toBe(403);
    expect(row()).toEqual(before);
  });

  // A cookie the server never signed -- what an attacker with a sibling
  // subdomain can set. The double-submit halves agree with each other here and
  // only the HMAC catches it.
  it("refuses a cookie whose signature does not verify", async () => {
    const before = row();

    const res = await call({ cookie: `__Host-csrf=${CSRF_RAW}.${"0".repeat(64)}` });

    expect(res.status).toBe(403);
    expect(row()).toEqual(before);
  });

  // The cross-site press this whole mechanism exists for.
  it("refuses a cross-origin submission", async () => {
    const before = row();

    const res = await call({ origin: "https://evil.example", secFetchSite: "cross-site" });

    expect(res.status).toBe(403);
    expect(row()).toEqual(before);
  });

  // verifyCsrf fails closed on a missing secret (its own comment: an unset
  // secret must never be indistinguishable from "working"). Proof that the
  // failure is a refusal and not an exception reaching the 500 page.
  it("refuses everything when CSRF_SECRET is unset", async () => {
    const before = row();

    const res = await call({ env: { ...env, CSRF_SECRET: undefined } as unknown as AppEnv["Bindings"] });

    expect(res.status).toBe(403);
    expect(row()).toEqual(before);
  });

  // Hono's parseBody returns {} for any content type that is not
  // multipart/form-data or x-www-form-urlencoded, so a JSON body carries no
  // token however well-formed it is. Worth pinning because this is an htmx
  // endpoint and a future hx-ext="json-enc" on the check page would turn every
  // Use press into a silent 403.
  it("refuses a JSON body, which carries no readable token", async () => {
    const before = row();

    const res = await call({
      contentType: "application/json",
      rawBody: JSON.stringify({ csrf_token: CSRF_RAW, value: FOUND.phone_number }),
    });

    expect(res.status).toBe(403);
    expect(row()).toEqual(before);
  });

  // ORDER AGAIN, and the one place it is arguably wrong: the food bank is
  // looked up BEFORE the token is checked (useAi.ts:33 vs :38), so an
  // unauthenticated-in-spirit request to an unknown slug is told 404 rather
  // than 403 -- a slug oracle, albeit one behind the admin auth gate, and one
  // D1 read done on behalf of a request that was never going to be honoured.
  // Pinned, not fixed.
  it("answers 404 rather than 403 for an unknown slug with no token", async () => {
    const res = await call({ slug: "no-such-foodbank", formToken: null });

    expect(res.status).toBe(404);
  });
});

describe("auth", () => {
  const PATH = pathFor(SLUG, "phone_number");

  // requireAdminAuth redirects rather than 403s, and it redirects with a 302 --
  // the SAME status a successful press returns. Only the Location tells them
  // apart, so both are asserted: a regression that let an anonymous POST
  // through would otherwise look identical to a success in a status-only test.
  it("sends an unauthenticated press to sign-in without reaching the handler", async () => {
    const before = row();

    const res = await call({ authenticated: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/auth/?next=${encodeURIComponent(PATH)}`);
    expect(row()).toEqual(before);
  });

  // A valid CSRF token is not a substitute for a session. Both gates, in the
  // order production mounts them.
  it("refuses an anonymous press even when it carries a valid token", async () => {
    const before = row();

    const res = await call({ authenticated: false, formToken: CSRF_RAW });

    expect(res.headers.get("Location")).toBe(`/auth/?next=${encodeURIComponent(PATH)}`);
    expect(row()).toEqual(before);
  });
});

describe("a GET does not mutate", () => {
  // routes/admin/index.ts:150 registers this POST-only and Django guards it
  // with @require_POST, so a GET normally never gets this far. This asserts the
  // handler itself is safe when it does: parseBody returns {} for a request
  // with no form content type, the token is therefore missing, and the request
  // is refused before anything is written. A prefetcher, a browser's link
  // preview or a crawler following the URL out of a log must not be able to
  // commit an AI suggestion.
  it("refuses a GET and writes nothing", async () => {
    const before = row();

    const res = await call({ method: "GET" });

    expect(res.status).toBe(403);
    expect(row()).toEqual(before);
  });

  // The same GET with an invalid field takes the earlier branch, and still
  // writes nothing. Both exits from a GET are covered so that "a GET is inert"
  // is a statement about the handler rather than about one code path.
  it("refuses a GET for an unknown field at the earlier guard", async () => {
    const before = row();

    const res = await call({ method: "GET", field: "name" });

    expect(res.status).toBe(400);
    expect(row()).toEqual(before);
  });
});

describe("an unknown food bank", () => {
  // views.py:1331 `get_object_or_404(Foodbank, slug=slug)`. c.notFound() DELEGATES
  // -- the body is whatever the app's own notFound renderer produces, which in
  // production is index.ts's branded 404 with the admin chrome on it.
  //
  // MUTANT KILLED: `return c.notFound()` rewritten as `return c.text("nope",
  // 404)`. It survived the status-only assertion this test used to make, and it
  // is not a hypothetical edit -- every other exit from this handler is a
  // hand-built c.text(), so making the fourth one match is the obvious tidy-up.
  // What it costs is the 404 page: the reviewer following a stale check-page
  // link lands on bare text with no navigation back into the queue.
  it("404s through the app's own not-found page and writes nothing anywhere", async () => {
    const before = row();

    const res = await call({ slug: "no-such-foodbank" });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_BODY);
    expect(row()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbank").get()).toEqual({ n: 2 });
  });

  // The slug is bound, not interpolated (getFoodbankBySlug's
  // `WHERE slug = ?`), so a slug shaped like SQL is simply a slug that matches
  // nothing.
  it("404s on a slug shaped like SQL rather than executing it", async () => {
    const res = await call({ slug: "x' OR '1'='1" });

    expect(res.status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbank").get()).toEqual({ n: 2 });
  });
});

describe("the cache", () => {
  // SUSPECT, pinned as-is and reported rather than fixed.
  //
  // Django reached this write through `foodbank.save(do_geoupdate=False)`,
  // which leaves do_decache=True -- givefood/models/foodbank.py:717-758 then
  // enqueued a purge of the food bank's pages, the API responses and the
  // constituency page. This port's other Foodbank write paths kept that:
  // routes/admin/foodbank.ts:160-165 and foodbankUrls.ts both send
  // { tags: [foodbankTag(slug), AGGREGATE_TAG, ...] } to PURGE_Q on the way
  // out. useAi.ts sends nothing.
  //
  // The columns it writes are all rendered on the public page
  // (wfbn/foodbank/index.njk and charity.njk show the phone number, the email,
  // the Facebook page and the charity number), and middleware/
  // pageCacheControl.ts gives that page s-maxage=86400, so the corrected value
  // is in D1 immediately and can stay invisible at the edge for a day. The
  // admin sees the button turn green and has no way to tell.
  //
  // If a purge is ever added, THIS TEST IS THE ONE THAT SHOULD FAIL -- it is
  // asserting the defect, not the design.
  it("does not purge the public page it just changed", async () => {
    const res = await press("phone_number");

    expect(res.status).toBe(302);
    expect(row().phone_number).toBe(FOUND.phone_number);
    expect(purgeSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The production route registration
// ---------------------------------------------------------------------------

// Everything above this line goes through the app built in beforeEach: a
// hand-written mirror of two lines of routes/admin/index.ts. A mirror cannot
// fail when the thing it mirrors changes, and here is what that cost, measured
// by editing index.ts on disk and re-running -- ALL FOUR of these SURVIVED the
// mirror while breaking production (adversarial pass, 2026-09-07):
//
//   * adding `adminApp.get("/foodbank/:slug/use-ai/:field/", ...)` alongside
//     the POST. This is the brief's "let a GET fall through into the POST
//     branch" mutant, and the mirror is structurally incapable of noticing it:
//     it registers the handler with `app.all` on purpose, so a GET already
//     reaches the handler there by design.
//   * deleting `adminApp.use("*", requireAdminAuth)` -- the whole admin area
//     opens to the internet. The mirror mounts its own gate, so it stays green.
//   * renaming the path (`/foodbank/:slug/useai/:field/`) -- every Use button
//     on foodbank_check.njk 404s, because the template hardcodes the old one.
//   * renaming the `:field` param (`:aiField`) -- `c.req.param("field")` goes
//     undefined, it matches nothing on the allow-list, and EVERY press on every
//     food bank answers 400 "Invalid field". The AI check page stops working
//     entirely and the suite does not blink.
//
// Four cases, deliberately: this block pins the wiring, not the handler's
// behaviour, which the mirror covers at less cost. Mounted at "/admin" exactly
// as workers/site/src/index.ts mounts it, the same way articles.test.ts and
// seven sibling suites import `adminApp` -- the house pattern, not a new one.
function makeRealApp(): Hono<AppEnv> {
  const real = new Hono<AppEnv>();
  real.route("/admin", adminApp);
  real.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  real.notFound((c) => c.text(NOT_FOUND_BODY, 404));
  return real;
}

/** A press through the real router, carrying a real KV-backed session rather than the mirror's short-circuit. */
async function sendReal(path: string, opts: { method?: "GET" | "POST"; signedIn?: boolean } = {}): Promise<Response> {
  const { method = "POST", signedIn = true } = opts;

  const cookies = [await csrfCookie()];
  if (signedIn) cookies.push(`__Host-gfsession=${SESSION_ID}`);
  const headers: Record<string, string> = {
    Cookie: cookies.join("; "),
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
  };
  let body: string | undefined;
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams({ csrf_token: CSRF_RAW, value: FOUND.phone_number }).toString();
  }

  return makeRealApp().fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, execCtx);
}

describe("the production route registration", () => {
  const REAL_PATH = pathFor(SLUG, "phone_number");

  // Path, method and BOTH param names at once, verified by the column rather
  // than by the status: a 302 is what this route returns when it works and also
  // what requireAdminAuth returns when it does not, and a 400 is what a renamed
  // `:field` produces. Only the stored value separates all three.
  it("answers a POST at the path foodbank_check.njk posts to, and stores the value", async () => {
    const res = await sendReal(REAL_PATH);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/foodbank/${SLUG}/check/`);
    expect(row().phone_number).toBe(FOUND.phone_number);
    expect(row().edited).not.toBe(SEEDED_TIMESTAMP);
  });

  // GET MUST NOT REACH THE HANDLER. Registration is the only thing enforcing
  // that -- useAi.ts contains no method check of its own, because Django's
  // @require_POST (views.py:1313) has no ported equivalent inside the handler.
  //
  // Pinned divergence, same as articles.test.ts records: Django answered 405
  // (the URL matches, the method does not); Hono finds no route and answers
  // 404. Same protection, different status.
  //
  // A prefetch, a link preview or a crawler replaying a URL out of an admin's
  // history must not commit an AI suggestion -- and note that the CSRF check
  // would refuse such a GET anyway (the mirror's own GET tests prove that, and
  // they are what makes this defence in depth rather than the only line). What
  // this test adds is that the request never gets that far.
  it("answers no GET at all, and writes nothing", async () => {
    const before = row();

    const res = await sendReal(REAL_PATH, { method: "GET" });

    expect(res.status).toBe(404);
    expect(row()).toEqual(before);
  });

  // THE GATE, on the real sub-app rather than on a copy of it. The token here
  // is perfectly valid, so the only thing that can stop the write is the
  // session -- which makes this a test of `adminApp.use("*", requireAdminAuth)`
  // and not of verifyCsrf. Deleting that one line is a plausible edit (it looks
  // redundant next to the per-route checks) and it silently publishes every
  // write route in the admin.
  it("never reaches the handler without a session, even with a valid token", async () => {
    const before = row();

    const res = await sendReal(REAL_PATH, { signedIn: false });

    expect(res.status).toBe(302);
    // The full /admin/... path has to survive the sub-app's rebasing, or the
    // admin comes back from Google to the wrong page.
    expect(res.headers.get("Location")).toBe(`/auth/?next=${encodeURIComponent(REAL_PATH)}`);
    expect(row()).toEqual(before);
  });

  // A cookie is not a session: an expired or revoked id is simply absent from
  // KV, which getAdminSession treats exactly as it treats no cookie at all.
  it("never reaches the handler for a session id KV does not know", async () => {
    const before = row();
    sessions.clear();

    const res = await sendReal(REAL_PATH);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/auth/?next=${encodeURIComponent(REAL_PATH)}`);
    expect(row()).toEqual(before);
  });
});
