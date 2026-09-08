import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminFoodbankUrlsEdit } from "./foodbankUrls";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// routes/admin/foodbankUrls.ts -- the 5th Foodbank form, the one WP 6.5 kept
// out of the 4 collapsed partials (routes/admin/foodbank.ts) because Django's
// GET branch (gfadmin/views.py:1395-1500) fetches the food bank's live
// homepage, scrapes it and asks Gemini to fill the empty boxes. That half is
// deliberately not ported. What IS ported is the plain edit/save path, and
// this file is about whether that path actually saves.
//
// THE TWO BUGS THIS TIER KEEPS FINDING, applied here:
//
//   #34 -- the location form parsed a Place ID, passed it down, and no SQL
//   wrote it; the handler redirected as though it had worked. A 302 is not
//   evidence of a save, so every write assertion below reads the row back out
//   of SQLite and looks at the columns. All seven URL fields are checked
//   individually, in both directions (set, and cleared), because six of them
//   differ only by name and a SET clause that lost one would look exactly
//   like a SET clause that lost none.
//
//   #12 -- a refused write reached app.onError and the 500 page took every
//   typed field with it. The refusal tests below therefore assert WHAT comes
//   back, not just the status, and assert the stored row is untouched.
//
// NOTHING IS MOCKED THAT DOES NOT LEAVE THE MACHINE. Real Hono app at the
// production paths (routes/admin/index.ts:142-143), real requireAdminAuth,
// real verifyCsrf against a real signed cookie, real nunjucks templates, and
// a real SQLite database behind the real getFoodbankBySlug /
// updateFoodbankFields. The one stub is PURGE_Q.send -- a queue is the only
// thing in this handler's reach that leaves the Worker, and stubbing it turns
// "the cache was never purged" into a direct assertion rather than an
// inference. This handler makes no fetch of any kind: the Gemini/BeautifulSoup
// half of the Django view is what was left out.
//
// MUTATION-TESTED, in a copy of the tree outside the repo (TESTING.md's
// "several suites were mutation-tested"). 51 mutants run across the handler,
// lib/csrf.ts, lib/adminFormFields.ts, packages/db and the two templates; 50
// are killed. A sample, each run rather than imagined:
//   - dropping `await updateFoodbankFields(...)` and redirecting anyway --
//     issue #34 reproduced exactly -- fails 20 tests
//   - filtering ONE column out of updateFoodbankFields' SET clause -- fails 7
//   - reversing updateFoodbankFields' bind values -- fails 16
//   - dropping `contacts_url` from URL_FIELD_NAMES -- fails 11
//   - deleting the verifyCsrf call, or `return true` inside it -- fails 5
//   - removing the `if (!foodbank) return c.notFound()` guard -- fails 3
//   - `stampEdited: false` (FoodbankPoliticsForm's behaviour) -- fails 2
//   - `if (!parsed.ok)` redirecting instead of 400ing -- fails 2
//   - redirecting back to this form instead of the detail page -- fails 1
//   - `show_proxy: false` -- fails 1
//
// THE ADVERSARIAL PASS ADDED SIX TESTS, closing TEN mutants that survived the
// file's first 39. Eight of the ten fall into two families, and both are worth
// knowing about because neither is specific to this handler:
//
//   THE WHERE CLAUSE WAS NEVER TESTED. Reading Salisbury's row back proves the
//   right values were written; it says nothing about which rows got them. With
//   a one-food-bank fixture, `WHERE id = ?` -> `WHERE id = ? OR 1=1` (a
//   mass-overwrite of production) and `updateFoodbankFields(db, 1, ...)` both
//   survived all 39. Fixed by seeding a bystander food bank at id 1 and moving
//   the row under test to id 7 -- see DECOY_URLS.
//
//   THE PAGE THE ADMIN IS ACTUALLY SERVED WAS NEVER SUBMITTED. Every save test
//   here builds its POST by hand, with a token it minted itself, so the form
//   in the rendered HTML was only ever read, never used. SIX mutants of
//   foodbank_form.njk / formfields.njk / pageContext.ts survived while leaving
//   the admin unable to save anything: an empty `csrf_token` value, no hidden
//   token field at all, `method="get"`, an `action` pointing elsewhere, no
//   submit button, and -- the worst of them -- inputs rendered without a
//   `name` attribute, which a browser silently omits from the submission.
//   Fixed by posting the token pair harvested from a real GET, and by
//   asserting the form tag and the boxes' `name`s.
//
// (The remaining two were a mislabelled box and the wrong nav tab; both are
// pinned below where they belong. Note that mutating a template only bites
// after packages/templates' precompile step is re-run -- render() loads
// src/generated/precompiled.js, not the .njk. A mutation run that skips it
// reports every template mutant as killed-by-nothing, which is how these six
// stayed hidden.)
//
// The one surviving mutant is deliberate: deleting COLUMN_NAME_RE's guard in
// updateFoodbankFields (foodbankAdmin.ts:245) changes nothing reachable from
// here, because parseAdminFields only ever emits the fixed AdminFieldSpec
// names. It belongs to packages/db/src/foodbankAdmin.test.ts, not to a route
// test that would have to fake an impossible call to reach it.

// migrations/0001_core.sql:10-56, transcribed whole rather than reduced to the
// seven columns under test. That is the point of it: the "nothing else moved"
// test below diffs every column of the row across a save, so a SET clause that
// widened -- the mirror image of #34's SET clause that was too narrow -- has
// somewhere to show up. No later migration touches this table (checked:
// `ALTER TABLE foodbank ` appears in none of 0002-0023), so this is the shape
// production holds today.
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

// The D1DatabaseSession surface packages/db uses, over node:sqlite. Same shim
// as donationPoint.test.ts / foodbankLocation.test.ts, and same reasoning: D1
// is async where node:sqlite is synchronous, and that is the only difference
// that matters -- the SQL text, the parameter binding and the NULL semantics
// are SQLite's on both sides.
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
const PATH = "/admin/foodbank/salisbury/edit/urls/";

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// lib/adminFormFields.ts's URL_FIELD_NAMES order is load-bearing twice over:
// it is the order the boxes are drawn in, and parseAdminFields reports the
// FIRST required-field failure, so `url` is the error an empty form gets.
// Duplicated here rather than imported from the handler (which does not export
// it) so a silent reordering or a dropped field shows up as a test failure
// instead of a test that quietly checks six fields.
const URL_FIELDS = ["url", "shopping_list_url", "rss_url", "news_url", "donation_points_url", "locations_url", "contacts_url"] as const;

// givefood/forms.py:73-84 FoodbankUrlsForm's `fields` list, verbatim, as the
// parity check for the constant above.
const DJANGO_URL_FIELDS = ["url", "shopping_list_url", "rss_url", "news_url", "donation_points_url", "locations_url", "contacts_url"];

// givefood/models/foodbank.py:106-112, each field's explicit `verbose_name`,
// which is what Django's ModelForm drew as the <label> and what
// parseAdminFields reformats into "<label> is required". Written out here
// rather than imported from FOODBANK_FIELDS so that a label edited on one side
// only shows up as a failure: the two required ones are already load-bearing
// in the 400-message tests below, and these are the other five.
const DJANGO_LABELS: Record<(typeof URL_FIELDS)[number], string> = {
  url: "URL",
  shopping_list_url: "Shopping list URL",
  rss_url: "RSS feed URL",
  news_url: "News URL",
  donation_points_url: "Donation points URL",
  locations_url: "Locations URL",
  contacts_url: "Contacts URL",
};

// Seven distinguishable values, one per field, so "the values came back"
// cannot be satisfied by one value echoed into seven boxes -- which is exactly
// how a SET clause that bound the same parameter twice would present.
const TYPED: Record<(typeof URL_FIELDS)[number], string> = {
  url: "https://salisburyfoodbank.org.uk/",
  shopping_list_url: "https://salisburyfoodbank.org.uk/shopping-list/",
  rss_url: "https://salisburyfoodbank.org.uk/feed/",
  news_url: "https://salisburyfoodbank.org.uk/news/",
  donation_points_url: "https://salisburyfoodbank.org.uk/donate/where/",
  locations_url: "https://salisburyfoodbank.org.uk/centres/",
  contacts_url: "https://salisburyfoodbank.org.uk/contact-us/",
};

// The row as it stands before any test touches it: `url` and
// `shopping_list_url` populated (both are NOT NULL in the schema and required
// on the form), the five optional ones already holding values so that
// "clearing a box stores NULL" is a change and not a no-op.
const STORED: Record<(typeof URL_FIELDS)[number], string> = {
  url: "https://old.salisburyfoodbank.org.uk/",
  shopping_list_url: "https://old.salisburyfoodbank.org.uk/list/",
  rss_url: "https://old.salisburyfoodbank.org.uk/rss/",
  news_url: "https://old.salisburyfoodbank.org.uk/latest/",
  donation_points_url: "https://old.salisburyfoodbank.org.uk/drop-off/",
  locations_url: "https://old.salisburyfoodbank.org.uk/where/",
  contacts_url: "https://old.salisburyfoodbank.org.uk/contact/",
};

// A SECOND FOOD BANK, seeded before every test, never posted to, and asserted
// byte-for-byte unchanged after every save.
//
// THIS IS NOT DECORATION -- it is what makes the WHERE clause testable at all.
// Every write assertion in this file reads Salisbury's row back, and every one
// of them passes just as happily if the UPDATE hit EVERY row in the table.
// Two mutants proved it against the one-row fixture this file used to have,
// and BOTH survived the whole 39-test suite:
//   - `WHERE id = ?` -> `WHERE id = ? OR 1=1` in updateFoodbankFields
//     (foodbankAdmin.ts:277): every food bank in the database gets Salisbury's
//     URLs. In production that is the single most destructive edit anyone
//     could make to this path, and nothing here noticed.
//   - `updateFoodbankFields(db, foodbank.id, ...)` -> `(db, 1, ...)`: the
//     write lands on whichever row happens to be id 1. It survived because
//     Salisbury WAS id 1.
// Hence both halves of the fix: the food bank under test is deliberately NOT
// id 1 (so a hardcoded id misses it), and a bystander row exists at id 1 (so a
// hardcoded id, or a widened WHERE, hits something that is checked).
const SALISBURY_ID = 7;
const DECOY_ID = 1;

const DECOY_URLS: Record<(typeof URL_FIELDS)[number], string> = {
  url: "https://bathfoodbank.invalid/",
  shopping_list_url: "https://bathfoodbank.invalid/list/",
  rss_url: "https://bathfoodbank.invalid/rss/",
  news_url: "https://bathfoodbank.invalid/latest/",
  donation_points_url: "https://bathfoodbank.invalid/drop-off/",
  locations_url: "https://bathfoodbank.invalid/where/",
  contacts_url: "https://bathfoodbank.invalid/contact/",
};

let db: DatabaseSync;
let app: Hono<AppEnv>;
let env: AppEnv["Bindings"];
let purgeSend: ReturnType<typeof vi.fn>;

interface FoodbankRowShape {
  id: number;
  slug: string;
  name: string;
  modified: string;
  edited: string | null;
  url: string;
  shopping_list_url: string;
  rss_url: string | null;
  news_url: string | null;
  donation_points_url: string | null;
  locations_url: string | null;
  contacts_url: string | null;
  [column: string]: unknown;
}

function row(): FoodbankRowShape {
  return db.prepare("SELECT * FROM foodbank WHERE slug = 'salisbury'").get() as unknown as FoodbankRowShape;
}

// The bystander. Read by slug, like `row()`, so that a mutant which broke the
// lookup rather than the write cannot make both functions return the same row.
function decoyRow(): FoodbankRowShape {
  return db.prepare("SELECT * FROM foodbank WHERE slug = 'bath'").get() as unknown as FoodbankRowShape;
}

function seed(overrides: Record<string, string | number | null> = {}): void {
  const columns: Record<string, string | number | null> = {
    id: SALISBURY_ID,
    uuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "Salisbury",
    slug: "salisbury",
    address: "Unit 1\r\nBemerton Heath",
    postcode: "SP2 9DY",
    country: "England",
    lat_lng: "51.0688,-1.7945",
    latitude: 51.0688,
    longitude: -1.7945,
    notes: "Private scratch notes -- must survive a URLs save untouched",
    place_id: "ChIJVXealLU_xkcRja_At0z9AGY",
    charity_just_foodbank: 0,
    contact_email: "info@salisburyfoodbank.org.uk",
    phone_number: "01722349556",
    address_is_administrative: 0,
    is_closed: 0,
    no_locations: 3,
    days_between_needs: 14,
    parliamentary_constituency_slug: "salisbury",
    // latest_need_id stays NULL: this route never reads the need, and NULL is
    // the shape production has for a food bank with none on file. It no longer
    // spares the fixture a foodbankchange table -- since github #51
    // getFoodbankBySlug batches that lookup and sends it either way -- so the
    // table and its view are in SCHEMA above.
    latest_need_id: null,
    created: "2020-01-01 00:00:00.000000",
    modified: "2020-01-01 00:00:00.000000",
    edited: "2020-01-01 00:00:00.000000",
    ...STORED,
    ...overrides,
  };
  const names = Object.keys(columns);
  db.prepare(`INSERT INTO foodbank (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(
    ...(names.map((n) => columns[n]) as Bindable[]),
  );
}

// Inserted BEFORE Salisbury so it takes the low rowid as well as id 1 -- a
// mutant that reaches for "the first row" rather than the matching one lands
// here either way.
function seedDecoy(): void {
  seed({
    id: DECOY_ID,
    uuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    name: "Bath",
    slug: "bath",
    postcode: "BA1 1AA",
    contact_email: "info@bathfoodbank.invalid",
    parliamentary_constituency_slug: "bath",
    ...DECOY_URLS,
  });
}

// The signed double-submit pair lib/csrf.ts mints and then validates: the raw
// token in the hidden field, `raw.hmac` in the __Host- cookie. Built with the
// real hmacSha256Hex so verifyCsrf runs for real rather than being mocked into
// agreement with itself.
async function csrfCookie(raw = CSRF_RAW): Promise<string> {
  return `__Host-csrf=${raw}.${await hmacSha256Hex(CSRF_SECRET, raw)}`;
}

interface RequestOptions {
  path?: string;
  form?: Record<string, string>;
  cookie?: string | null;
  origin?: string | null;
  secFetchSite?: string | null;
  authenticated?: boolean;
}

async function request(method: "GET" | "POST", opts: RequestOptions = {}): Promise<{ res: Response; html: string }> {
  const headers: Record<string, string> = {};
  const cookie = opts.cookie === undefined ? await csrfCookie() : opts.cookie;
  if (cookie) headers.Cookie = cookie;
  if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  if (opts.secFetchSite !== null) headers["Sec-Fetch-Site"] = opts.secFetchSite ?? "same-origin";
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";

  const res = await app.fetch(
    new Request(`${ORIGIN}${opts.path ?? PATH}`, {
      method,
      headers,
      body: method === "POST" ? new URLSearchParams(opts.form ?? {}).toString() : undefined,
    }),
    { ...env, __authenticated: opts.authenticated !== false } as unknown as AppEnv["Bindings"],
    execCtx,
  );
  // Read the body once, here: a Response body can only be consumed once and
  // several assertions want it.
  const html = res.status === 302 ? "" : await res.text();
  return { res, html };
}

// A browser's submission of the rendered form, with a valid token attached.
function post(fields: Record<string, string>, opts: RequestOptions = {}) {
  return request("POST", { ...opts, form: { csrf_token: CSRF_RAW, ...fields } });
}

// includes/formfields.njk renders every text-ish control as
// `id="id_<name>" name="<name>" value="<value>"`, autoescaped. Read back the
// way the admin's browser would, so the round-trip assertions are about what
// is actually in the page rather than about a context object the template
// might not use.
// The whole <input> tag for a field, for the assertions that are about the tag
// rather than about its value -- `name` in particular, which inputValue()
// below deliberately never looks at (it keys on `id`) and which is the single
// attribute that decides whether the box is submitted at all.
function inputTag(html: string, name: string): string {
  return new RegExp(`<input[^>]*id="id_${name}"[^>]*>`).exec(html)?.[0] ?? "";
}

function inputValue(html: string, name: string): string | null {
  const match = new RegExp(`id="id_${name}"[^>]*\\svalue="([^"]*)"`).exec(html);
  if (!match) return null;
  return match[1]!
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seedDecoy();
  seed();
  purgeSend = vi.fn(async () => {});

  env = {
    DB: { withSession: () => d1Session(db) },
    CSRF_SECRET,
    PURGE_Q: { send: purgeSend },
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
  } as unknown as AppEnv["Bindings"];

  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    await next();
  });
  // The real gate, mounted where routes/admin/index.ts:85 mounts it
  // (`adminApp.use("*", requireAdminAuth)`). Signed-in requests are given the
  // session the middleware would have resolved from KV; the auth test below
  // routes through requireAdminAuth itself instead, which is the only way to
  // prove an anonymous POST never reaches the handler.
  app.use("*", async (c, next) => {
    if ((c.env as unknown as { __authenticated: boolean }).__authenticated) {
      c.set("adminUser", { email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "" });
      return next();
    }
    return requireAdminAuth(c, next);
  });
  app.get("/admin/foodbank/:slug/edit/urls/", adminFoodbankUrlsEdit);
  app.post("/admin/foodbank/:slug/edit/urls/", adminFoodbankUrlsEdit);
  // The 500 page issue #12 is about. Caught and labelled so a regression reads
  // as "expected 302, got 500: <sqlite message>" rather than as a vitest crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
});

describe("GET", () => {
  it("renders the form with the stored URLs in the boxes", async () => {
    const { res, html } = await request("GET");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    for (const field of URL_FIELDS) expect(inputValue(html, field)).toBe(STORED[field]);
  });

  // THE FIELD LIST IS THE FORM'S WHOLE CONTRACT. parseAdminFields loops over
  // the spec list, never over the POST body, so a field rendered here that is
  // not in URL_FIELD_NAMES would be typed into and silently dropped, and a
  // field in URL_FIELD_NAMES that is not rendered would be blanked on every
  // save (foodbankLocation.test.ts pins the same hazard on `place_id`). Both
  // halves are checked: exactly these seven inputs exist, and no other
  // Foodbank field the shared FOODBANK_FIELDS list could have leaked in does.
  it("renders exactly the seven URL fields and nothing else", async () => {
    const { html } = await request("GET");

    for (const field of URL_FIELDS) expect(html).toContain(`id="id_${field}"`);
    for (const other of ["name", "address", "postcode", "notes", "place_id", "contact_email", "phone_number", "is_closed"]) {
      expect(html).not.toContain(`id="id_${other}"`);
    }
  });

  // givefood/forms.py:73-84's `fields = [...]`, in its source order. If Django
  // ever gains an eighth URL field this is the test that says the port has
  // seven.
  it("matches FoodbankUrlsForm's field list, in order", () => {
    expect([...URL_FIELDS]).toEqual(DJANGO_URL_FIELDS);
  });

  // THE DIVERGENCE THIS HANDLER EXISTS TO RECORD. Django's GET branch
  // (views.py:1408-1497) opens a CrawlItem row, saves it, fetches the food
  // bank's live homepage, calls Gemini and saves the CrawlItem again -- a GET
  // that writes twice and makes two network calls. WP 6.5 deferred all of it
  // to the Queue+polling work, so the ported GET is a pure read. Asserted
  // rather than assumed, because "a GET must not mutate" is the rule the
  // deferral has to keep: not one column of the row moves, `modified` and
  // `edited` included, and nothing is enqueued.
  it("writes nothing at all -- no crawl, no suggestion, no timestamp bump", async () => {
    const before = row();
    const otherBefore = decoyRow();

    await request("GET");
    const seeded = await request("GET", { path: "/admin/foodbank/salisbury/edit/urls/?name=Anything&url=https://injected.invalid/" });

    expect(row()).toEqual(before);
    expect(decoyRow()).toEqual(otherBefore);
    expect(purgeSend).not.toHaveBeenCalled();
    // And no prefill either. adminFoodbankNew DOES seed `initial` from
    // ?name/address/postcode (foodbank.ts:260-264); this form does not, so the
    // boxes hold the stored row and a query string cannot put a value in front
    // of an admin who is about to press Submit.
    expect(inputValue(seeded.html, "url")).toBe(STORED.url);
  });

  // THE SUBMIT BUTTON HAS TO REACH THE POST BRANCH, and every assertion in
  // this file about saving bypasses the rendered page to get there -- they
  // build a POST by hand. So the one thing standing between a working handler
  // and an admin whose edits vanish is the form tag itself, which nothing
  // looked at. Two mutants of foodbank_form.njk:31 survived the whole suite:
  //   - `method="post"` -> `method="get"`: pressing Submit re-runs the GET
  //     branch, which re-renders the form from the unchanged row. The admin
  //     sees their own typed values echoed back in a 200 and no error, and
  //     nothing was written. That is issue #34's symptom exactly -- "it looked
  //     like it worked" -- reached through the template instead of the SQL.
  //   - adding `action="/admin/foodbank/{{ foodbank.slug }}/"`: the POST goes
  //     to the detail route instead of here.
  // The absence of an `action` is the assertion for the second: the form must
  // post back to the URL it was served from, which is what makes the
  // `:slug`-scoped route pick up the right food bank.
  it("renders a form that posts back to this same URL", async () => {
    const { html } = await request("GET");

    // The LAST <form> opened before the first URL box is the one wrapping it.
    // Matching the first `<form` on the page instead would pick up the admin
    // nav's search form (admin/page.njk), which is a GET by design.
    expect(html).toContain('id="id_url"');
    const enclosing = html.slice(0, html.indexOf('id="id_url"')).match(/<form[^>]*>/g) ?? [];
    const form = enclosing.at(-1) ?? "";

    expect(form).toContain('method="post"');
    expect(form).not.toContain("action=");
    // And something to press. Deleting foodbank_form.njk:38's submit button
    // leaves a page that renders the seven boxes, accepts typing into them and
    // cannot be saved at all -- and every save test here builds its POST by
    // hand, so that mutant survived the suite untouched.
    expect(form).not.toBe("");
    expect(html).toContain('type="submit"');
  });

  // EVERY BOX MUST CARRY THE NAME THE HANDLER READS IT BACK BY. This is the
  // single nastiest mutant found reviewing this file, because it is invisible
  // to every other assertion here: strip `name="{{ spec.name }}"` from
  // formfields.njk:52 and the page still renders seven boxes, still fills them
  // with the stored URLs, and still round-trips through inputValue() -- which
  // keys on `id`, as the whole file does. A browser does not submit a nameless
  // input, so what the admin gets is: open the form, see their URLs, press
  // Submit, and the POST arrives with no `url` in it. parseAdminFields reads
  // the missing name as "" (see "blanks an optional URL the POST omits
  // entirely"), so `url` is required-and-empty and the save 400s -- every
  // save, for every food bank, with the plain-text page that discards the
  // form. Had `url` been optional it would instead have silently NULLed all
  // seven columns, which is issue #34 with the sign flipped.
  //
  // `id` and `name` are asserted on the SAME tag, not merely both present
  // somewhere in the page, so that a name landing on the wrong input fails.
  it("gives every box the name attribute the POST is keyed on", async () => {
    const { html } = await request("GET");

    for (const field of URL_FIELDS) {
      expect(inputTag(html, field)).toContain(`name="${field}"`);
    }
  });

  // The labels Django's ModelForm drew from foodbank.py:106-112's
  // verbose_name. They are how an admin tells "Locations URL" from "Donation
  // points URL" -- six of the seven boxes are otherwise identical -- and
  // rendering `spec.name` instead of `spec.label` (a one-word edit in
  // formfields.njk:17) turns them into raw column names without failing
  // anything else.
  it("labels each box with Django's verbose_name", async () => {
    const { html } = await request("GET");

    for (const field of URL_FIELDS) {
      expect(html).toContain(`for="id_${field}"`);
      expect(html).toContain(`${DJANGO_LABELS[field]}`);
    }
    expect(html).not.toContain(">donation_points_url");
  });

  // The nav's active item, cosmetic but pinned: adminPageContext's `section`
  // argument is a bare string with no compile-time check on it, so
  // `adminPageContext(c, "needs")` type-checks, renders and highlights the
  // wrong tab. admin/page.njk:43 is where it lands.
  it("marks Food Banks as the active nav section", async () => {
    const { html } = await request("GET");

    expect(html).toContain('class="navbar-item is-active" href="/admin/foodbanks/"');
  });

  // show_proxy: true, unconditionally -- foodbank_form.njk:59-63 draws the
  // live-site preview iframe from it, pointed at THIS food bank's `url`
  // field. It is the only reason an admin can see whether the URL they are
  // about to save resolves, so a silently dropped flag would cost the feature
  // the form is for.
  it("draws the live preview pane against this food bank's url field", async () => {
    const { html } = await request("GET");

    expect(html).toContain('src="/admin/proxy/?foodbank=salisbury&amp;field=url"');
  });

  // SUSPECT (reported, not fixed). Django's page_title here is
  // `"Edit %s Food Bank URLs" % foodbank.name` (views.py:1396); the port
  // passes the bare string "URLs". That is not only the <h2>: foodbank_form
  // .njk:30 renders `class="form-{{ title | slugify }}"`, and static/js/
  // admin.js keys its form initialisers off exactly those class names (see
  // adminFoodbankNew's own comment about "New Food Bank" vs "New Foodbank"
  // slugifying differently and killing the duplicate-name checker). Nothing
  // in admin.js currently selects either spelling, so this is inert today --
  // pinned so that it is a visible decision rather than a silent drift.
  it("titles the page 'URLs', not Django's 'Edit <name> Food Bank URLs'", async () => {
    const { html } = await request("GET");

    expect(html).toContain('class="form-urls"');
    expect(html).toContain("<h2>URLs</h2>");
    expect(html).not.toContain("Edit Salisbury Food Bank URLs");
  });

  it("404s an unknown slug without rendering a form", async () => {
    const { res, html } = await request("GET", { path: "/admin/foodbank/no-such-foodbank/edit/urls/" });

    expect(res.status).toBe(404);
    expect(html).not.toContain('id="id_url"');
  });
});

describe("POST -- the write", () => {
  // ISSUE #34's LESSON, stated as a test. The redirect is checked, and then
  // ignored: what makes this pass is the seven columns read back out of
  // SQLite. #34 shipped because a handler that parsed a value, passed it down
  // and wrote no SQL at all still redirected exactly like this one.
  it("stores every one of the seven URLs", async () => {
    const { res } = await post({ ...TYPED });

    expect(res.status).toBe(302);
    // gfadmin/views.py:1402 `redirect("admin:foodbank", slug=foodbank.slug)`
    // -- the detail page, not back to this form.
    expect(res.headers.get("location")).toBe("/admin/foodbank/salisbury/");

    const saved = row();
    for (const field of URL_FIELDS) expect(saved[field]).toBe(TYPED[field]);
  });

  // EVERY FIELD ROUND-TRIPS, through the real write and the real read. Saved,
  // then the edit form is reopened and the values are read back out of the
  // rendered HTML -- so a field that is written but never re-rendered (the
  // admin's next save would blank it) and a field that is rendered but never
  // written (#34 exactly) both fail here, and only here.
  it("hands all seven back when the form is reopened", async () => {
    await post({ ...TYPED });

    const { res, html } = await request("GET");

    expect(res.status).toBe(200);
    for (const field of URL_FIELDS) expect(inputValue(html, field)).toBe(TYPED[field]);
  });

  // One field at a time, each starting from a fully-populated row. Seven
  // separate saves, because a SET clause that writes `rss_url = ?` into
  // `news_url` passes any test that sets all seven to seven values at once
  // only if the values differ AND the assertion is per-column -- and passes
  // trivially if a shared implementation writes them in a loop. This is the
  // cheap insurance against exactly that.
  for (const field of URL_FIELDS) {
    it(`changes ${field} and leaves the other six alone`, async () => {
      const changed = `https://example.invalid/${field}/changed/`;
      const { res } = await post({ ...STORED, [field]: changed });

      expect(res.status).toBe(302);
      const saved = row();
      expect(saved[field]).toBe(changed);
      for (const other of URL_FIELDS) {
        if (other !== field) expect(saved[other]).toBe(STORED[other]);
      }
    });
  }

  // THE MIRROR OF #34: a SET clause too WIDE rather than too narrow.
  // updateFoodbankFields builds its own SQL from the caller's keys and appends
  // derived columns of its own (`slug` when `name` is posted, `latitude`/
  // `longitude` when `lat_lng` is), so this form -- which posts neither -- must
  // leave both derivations alone. `notes` and `place_id` are in the fixture
  // for the same reason: they are the expensive columns on the neighbouring
  // forms, and a URLs save must not be able to touch them.
  it("moves the seven URL columns, modified and edited -- and nothing else", async () => {
    const before = row();

    await post({ ...TYPED });

    const after = row();
    const moved = Object.keys(after).filter((column) => after[column] !== before[column]);
    expect(moved.sort()).toEqual([...URL_FIELDS, "edited", "modified"].sort());
    expect(after.slug).toBe("salisbury");
    expect(after.latitude).toBe(51.0688);
    expect(after.notes).toBe(before.notes);
    expect(after.place_id).toBe(before.place_id);
  });

  // THE ROW SELECTOR, WHICH NOTHING ABOVE ACTUALLY TESTS. Every other write
  // assertion in this file reads Salisbury back and finds what it expects --
  // and would find exactly the same thing if the UPDATE had rewritten every
  // food bank in the country. Two mutants confirmed that against the one-row
  // fixture, and both survived all 39 tests:
  //   - `WHERE id = ?` -> `WHERE id = ? OR 1=1` (foodbankAdmin.ts:277)
  //   - `updateFoodbankFields(db, foodbank.id, ...)` -> `(db, 1, ...)`
  // The first is a mass-overwrite of production; the second silently edits
  // whichever food bank owns id 1. Both are now caught here, and only here,
  // because Salisbury is id 7 and the bystander is id 1.
  //
  // The whole row is diffed, not just the seven URLs: `modified`/`edited`
  // moving on a food bank nobody edited would falsify the review queue that
  // orders by them, and is the shape a stray UPDATE takes even when the SET
  // clause is right.
  it("writes to this food bank's row only, leaving other food banks untouched", async () => {
    const otherBefore = decoyRow();

    const { res } = await post({ ...TYPED });

    expect(res.status).toBe(302);
    expect(row().url).toBe(TYPED.url);
    expect(decoyRow()).toEqual(otherBefore);
    for (const field of URL_FIELDS) expect(decoyRow()[field]).toBe(DECOY_URLS[field]);
  });

  // givefood/forms.py:78-84 -- FoodbankUrlsForm overrides save() to set
  // `foodbank.edited = timezone.now()`, exactly like the 4 partial forms and
  // unlike FoodbankPoliticsForm. `edited` is not decorative: it drives the
  // admin's "next food bank to review" queue and the foodbank_edited_idx
  // ordering, so a form that saved without stamping it would quietly stop the
  // reviewed row from leaving the queue.
  it("stamps edited and modified, the way FoodbankUrlsForm.save() does", async () => {
    const before = row();

    await post({ ...TYPED });

    const after = row();
    expect(after.edited).not.toBe(before.edited);
    expect(after.modified).not.toBe(before.modified);
    // pyNow()'s Django `str(datetime)` shape -- 'YYYY-MM-DD HH:MM:SS.ffffff',
    // naive UTC, no offset (packages/models/src/pyDatetime.ts).
    expect(after.edited).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(after.edited).toBe(after.modified);
  });

  // NULL, never "". It is what parseAdminFields does to every empty text
  // field, it is what Django's URLField(null=True, blank=True) stored
  // (foodbank.py:108-112), and it is what the rest of the codebase reads:
  // a query filtering `rss_url IS NOT NULL` to decide whether to crawl a feed
  // would hand an empty string to the fetcher instead of skipping the row.
  it("stores NULL, not an empty string, when an optional URL is cleared", async () => {
    const { res } = await post({ ...TYPED, rss_url: "", news_url: "" });

    expect(res.status).toBe(302);
    expect(row().rss_url).toBeNull();
    expect(row().news_url).toBeNull();
    expect(db.prepare("SELECT id FROM foodbank WHERE rss_url = ''").all()).toHaveLength(0);
  });

  it("treats a whitespace-only URL as cleared, and trims the rest", async () => {
    const { res } = await post({ ...TYPED, contacts_url: "   ", news_url: "  https://trimmed.invalid/news/  " });

    expect(res.status).toBe(302);
    expect(row().contacts_url).toBeNull();
    expect(row().news_url).toBe("https://trimmed.invalid/news/");
  });

  // THE HAZARD A SLICED-UP VERSION OF THIS FORM WOULD HIT, pinned because it
  // is a property of parseAdminFields rather than a bug in this handler:
  // the loop is over the SPEC LIST, so a name the body omits reads as
  // undefined, trims to "" and arrives as null -- indistinguishable from a box
  // the admin emptied. There is no third state meaning "leave this column
  // alone". Unreachable from today's admin (the template renders all seven, so
  // a browser posts all seven) and identical to the behaviour
  // foodbankLocation.test.ts records for `place_id`, but it is what would
  // happen the day someone splits this form the way FOODBANK_PARTIAL_FORMS
  // splits the main one.
  it("blanks an optional URL the POST omits entirely", async () => {
    const { res } = await post({ url: TYPED.url, shopping_list_url: TYPED.shopping_list_url });

    expect(res.status).toBe(302);
    const saved = row();
    expect(saved.rss_url).toBeNull();
    expect(saved.news_url).toBeNull();
    expect(saved.donation_points_url).toBeNull();
    expect(saved.locations_url).toBeNull();
    expect(saved.contacts_url).toBeNull();
  });

  // SUSPECT (reported, not fixed). Django's ModelForm ran URLValidator on
  // every one of these seven -- they are URLField, and an unparseable value
  // came back as a field error on the bound form. parseAdminFields validates
  // only `postcode` and `kind: "email"` (adminFormFields.ts:312-313); nothing
  // looks at `kind: "url"`, so this saves. The rendered `type="url"` input
  // stops a browser, which is why nobody has noticed, but the public food
  // bank page renders `url` as a link and needcheck fetches it.
  it("stores a value that is not a URL at all -- nothing validates the format", async () => {
    const { res } = await post({ ...TYPED, news_url: "not a url at all" });

    expect(res.status).toBe(302);
    expect(row().news_url).toBe("not a url at all");
  });

  // SUSPECT, same family. Django's URLField declares max_length=200
  // (foodbank.py:106-112) and enforced it in the form; D1's TEXT column has no
  // limit and neither does parseAdminFields, so an over-length paste lands in
  // a column the Postgres original would have refused.
  it("stores a URL far longer than Django's max_length=200", async () => {
    const long = `https://example.invalid/${"x".repeat(400)}`;

    const { res } = await post({ ...TYPED, locations_url: long });

    expect(res.status).toBe(302);
    expect(String(row().locations_url)).toHaveLength(long.length);
  });

  // SUSPECT (reported, not fixed). Every other Foodbank save path purges the
  // cache: routes/admin/foodbank.ts:160-165 enqueues foodbankTag(slug),
  // AGGREGATE_TAG and the constituency tag on the full form, the Politics form
  // and all 4 partials, and donationPoint.ts does the same. This handler
  // enqueues nothing, so a corrected `url` -- the field the public food bank
  // page renders as the "Visit website" link, and the one needcheck crawls --
  // keeps being served from the edge cache with the old value. The fixture row
  // carries a parliamentary_constituency_slug precisely so that the tag set
  // this handler WOULD send is non-trivial, making the empty call list a
  // statement rather than an accident.
  it("purges no cache after a successful save, unlike every sibling form", async () => {
    const { res } = await post({ ...TYPED });

    expect(res.status).toBe(302);
    expect(purgeSend).not.toHaveBeenCalled();
  });

  it("404s a POST to an unknown slug and writes nothing", async () => {
    const before = row();

    const { res } = await post({ ...TYPED }, { path: "/admin/foodbank/no-such-foodbank/edit/urls/" });

    expect(res.status).toBe(404);
    expect(row()).toEqual(before);
  });
});

describe("POST -- a rejected save", () => {
  // SUSPECT (reported, not fixed), and the single most valuable line in this
  // file. Django's view has no else branch: an invalid FoodbankUrlsForm falls
  // through to the same render() with the BOUND form, every typed value still
  // in its box. This handler answers `c.text(parsed.error, 400)` -- a
  // text/plain page with no form on it, so the admin's back button is the only
  // way back to what they typed. It is the same loss github #12 is about and
  // the same code the location form used to have, fixed there
  // (foodbankLocation.test.ts's "re-renders rather than replying in plain
  // text") and not here. Pinned as it behaves, with the failure spelled out.
  it("replies in plain text and throws the typed URLs away", async () => {
    const { res, html } = await post({ ...TYPED, url: "" });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(html).toBe("URL is required");

    // What "throws it away" means, asserted rather than asserted about: none
    // of the six URLs the admin had typed are anywhere in the response, and
    // there is no form to put them back into.
    expect(html).not.toContain("<form");
    for (const field of URL_FIELDS) {
      if (field !== "url") expect(html).not.toContain(TYPED[field]);
    }
  });

  it("writes nothing when a required field is empty", async () => {
    const before = row();

    await post({ ...TYPED, shopping_list_url: "" });

    expect(row()).toEqual(before);
    expect(purgeSend).not.toHaveBeenCalled();
  });

  // Both NOT NULL columns are required on the form, and parseAdminFields
  // reports the FIRST failure in spec order -- so an admin who clears both
  // sees the URL error, fixes it, and only then learns about the second. Pinned
  // because it is the behaviour Django had too (the first error on the first
  // field) and because it fixes which of the two labels is load-bearing.
  it("reports the first missing field in spec order, using Django's own label", async () => {
    const { html } = await post({ ...TYPED, url: "", shopping_list_url: "" });

    // foodbank.py:106's explicit verbose_name="URL", not capfirst("url").
    expect(html).toBe("URL is required");

    const second = await post({ ...TYPED, shopping_list_url: "" });
    expect(second.html).toBe("Shopping list URL is required");
  });

  // The five optional fields really are optional -- Django's
  // `null=True, blank=True` (foodbank.py:108-112). A required-flag that had
  // drifted onto one of them would make every save of a food bank with no RSS
  // feed impossible, which is most of them.
  it("saves happily with all five optional URLs empty", async () => {
    const { res } = await post({ url: TYPED.url, shopping_list_url: TYPED.shopping_list_url, rss_url: "", news_url: "" });

    expect(res.status).toBe(302);
    expect(row().url).toBe(TYPED.url);
    expect(row().rss_url).toBeNull();
  });

  // SUSPECT (reported, not fixed). There is no try/catch around
  // updateFoodbankFields here, so a write D1 refuses propagates to
  // app.onError and the 500 page -- precisely the #12 outcome that
  // routes/admin/foodbank.ts:137-147 and foodbankLocation.ts both grew a
  // backstop for, and this handler did not.
  //
  // The refusal is produced by a real SQLite trigger rather than a mocked
  // database, because the claim under test is "the handler has nowhere to
  // catch this", not "SQLite raises for reason X" -- the reachable reasons in
  // production are a D1 outage or a replica error, neither of which a fixture
  // can stage. What matters is that the response is a 500 with no form on it
  // and the row is untouched.
  it("500s and loses the form when the database refuses the write", async () => {
    db.exec(`
      CREATE TRIGGER refuse_url_update BEFORE UPDATE ON foodbank
      BEGIN SELECT RAISE(ABORT, 'D1_ERROR: the database said no'); END;
    `);
    const before = row();

    const { res, html } = await post({ ...TYPED });

    expect(res.status).toBe(500);
    expect(html).not.toContain('id="id_url"');
    for (const field of URL_FIELDS) expect(html).not.toContain(TYPED[field]);
    expect(row()).toEqual(before);
  });
});

describe("CSRF", () => {
  // WP 4.6's signed double-submit. Django's own CsrfViewMiddleware is
  // commented out in production (settings.py:97), so this is a port addition
  // -- which makes it exactly the kind of protection that can be quietly
  // dropped from one handler out of forty without anything failing. Every
  // refusal below also reads the row back: a 403 that had already written is
  // not a refusal.
  // THE POSITIVE PATH, END TO END, WHICH NOTHING ELSE IN THIS FILE COVERS.
  // Every other test here mints its own token pair with `csrfCookie()` and
  // posts CSRF_RAW -- a valid pair, but not the pair the admin's browser is
  // actually handed. That gap let three mutants through the whole suite, and
  // all three break saving for every admin on every form:
  //   - pageContext.ts:30 `csrf_token: csrfToken` -> `csrf_token: ""`: the
  //     hidden field renders empty, verifyCsrf's `if (!formToken) return
  //     false` fires, and every Submit is a 403 that discards the form.
  //   - foodbank_form.njk:32 losing its `<input type="hidden"
  //     name="csrf_token">` entirely: same 403, same loss.
  //   - a token rendered that the cookie does not match.
  // So this test does what the browser does: open the page, take the token out
  // of the HTML and the cookie out of Set-Cookie, and post exactly those.
  //
  // The GET deliberately carries NO cookie, which is also the only place the
  // suite exercises issueCsrfToken's MINT branch rather than its reuse branch
  // (csrf.ts:95-99) -- the path a first-time admin takes.
  it("accepts the token pair the rendered page actually hands the browser", async () => {
    const opened = await request("GET", { cookie: null, origin: null, secFetchSite: null });

    const token = /name="csrf_token"[^>]*\svalue="([^"]*)"/.exec(opened.html)?.[1];
    const setCookie = opened.res.headers.get("set-cookie") ?? "";
    // 32 random bytes as hex (csrf.ts's RAW_TOKEN_BYTES), so an empty or
    // placeholder value fails here rather than further down.
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(setCookie).toContain("__Host-csrf=");

    const { res } = await request("POST", {
      cookie: setCookie.split(";")[0]!,
      form: { csrf_token: token!, ...TYPED },
    });

    expect(res.status).toBe(302);
    // Read back, not inferred from the 302 -- the point of the test is that a
    // real browser round trip stores the URLs, not that it gets past the gate.
    const saved = row();
    for (const field of URL_FIELDS) expect(saved[field]).toBe(TYPED[field]);
  });

  it("refuses a POST with no token and writes nothing", async () => {
    const before = row();

    // Identical body to the saving tests above, minus `csrf_token`. That is
    // what makes the 403 attributable to the token rather than to anything
    // else about the request: the same seven fields, sent WITH a token, are
    // asserted to redirect and store in "stores every one of the seven URLs".
    const { res, html } = await request("POST", { form: { ...TYPED } });

    expect(res.status).toBe(403);
    expect(html).toBe("Forbidden");
    expect(row()).toEqual(before);
  });

  it("refuses a token that does not match the cookie", async () => {
    const before = row();

    const { res, html } = await post({ ...TYPED }, { cookie: await csrfCookie("c".repeat(64)) });

    expect(res.status).toBe(403);
    expect(html).toBe("Forbidden");
    expect(row()).toEqual(before);
  });

  // A cookie an attacker planted from a sibling subdomain: the raw token
  // matches the submitted field, but the signature was not minted with
  // CSRF_SECRET, so it must not be adopted.
  it("refuses a cookie whose signature does not verify", async () => {
    const before = row();

    const { res } = await post({ ...TYPED }, { cookie: `__Host-csrf=${CSRF_RAW}.${"0".repeat(64)}` });

    expect(res.status).toBe(403);
    expect(row()).toEqual(before);
  });

  it("refuses a cross-origin POST even with a valid token pair", async () => {
    const before = row();

    const offSite = await post({ ...TYPED }, { origin: "https://evil.invalid", secFetchSite: null });
    expect(offSite.res.status).toBe(403);
    expect(row()).toEqual(before);

    const crossSite = await post({ ...TYPED }, { secFetchSite: "cross-site" });
    expect(crossSite.res.status).toBe(403);
    expect(row()).toEqual(before);
  });

  // ORDER MATTERS. The token is checked before parseAdminFields, so a
  // token-less request never learns which field the form considers required --
  // a 400 saying "URL is required" would be a (small) oracle handed to an
  // unauthenticated origin, and would also mean the parse ran on a body nobody
  // vouched for.
  it("checks the token before validating the body", async () => {
    const { res, html } = await request("POST", { form: { url: "", shopping_list_url: "" } });

    expect(res.status).toBe(403);
    expect(html).toBe("Forbidden");
    expect(html).not.toContain("required");
  });

  // The food bank is looked up BEFORE the token is checked, so a bad-token
  // POST at a slug that does not exist answers 404 rather than 403. Harmless
  // -- the slug is public on every /needs/at/ page -- but pinned so that the
  // ordering is a decision rather than a surprise, and because reversing it
  // would change two of the statuses this file asserts.
  it("404s before it 403s, when the slug is also wrong", async () => {
    const { res } = await request("POST", { path: "/admin/foodbank/no-such-foodbank/edit/urls/", form: { ...TYPED } });

    expect(res.status).toBe(404);
  });

  // GET is not a mutating request and carries no token, so the gate must not
  // be on the shared code path. If it were, the form could never be opened.
  it("does not demand a token on GET", async () => {
    const { res } = await request("GET", { cookie: null, origin: null, secFetchSite: null });

    expect(res.status).toBe(200);
  });
});

describe("auth", () => {
  // routes/admin/index.ts:85 gates every /admin/* route with requireAdminAuth,
  // and this handler is registered under it (index.ts:142-143). The middleware
  // is the real one here: with no __Host session cookie, getAdminSession
  // returns null before it ever reaches KV, so the anonymous request is
  // redirected and the handler is never entered.
  it("redirects an anonymous POST to sign-in and writes nothing", async () => {
    const before = row();

    const { res } = await post({ ...TYPED }, { authenticated: false });

    expect(res.status).toBe(302);
    // Django stashed next_url in the session; the port carries it as a query
    // param instead (middleware/adminAuth.ts:21-22).
    expect(res.headers.get("location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2Fedit%2Furls%2F");
    expect(row()).toEqual(before);
    expect(purgeSend).not.toHaveBeenCalled();
  });

  it("redirects an anonymous GET rather than rendering the form", async () => {
    const { res, html } = await request("GET", { authenticated: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/?next=");
    expect(html).not.toContain('id="id_url"');
  });
});
