import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { donationPointNameTaken, upsertDonationPoint } from "@givefood/db";
import { adminDonationPointForm } from "./donationPoint";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// GitHub issue #12, on the donation point half: "500 adding a location with
// the same name as an existing location. Check for this class of error across
// the admin - it should validate first? Django did this automatically for us."
//
// He is right, and the cost is worse than a stack trace. Django's
// FoodbankDonationPointForm ran validate_unique() inside is_valid() and came
// back with the SAME FORM, still bound, every value the admin typed still in
// the inputs. This port sent the INSERT straight to D1, SQLite raised
// SQLITE_CONSTRAINT_UNIQUE, and app.onError replaced the page with the 500 --
// taking with it the eight fields the "Lookup Donation Point" button had just
// fetched from Google Places (lat_lng, place_id, address, postcode,
// phone_number, url, opening_hours, wheelchair_accessible). The one-click path
// into it is not hypothetical: foodbank_check.njk:209 renders an "Add" button
// per AI-discovered donation point that prefills the Name, and its
// `discrepancy` flag is computed from POSTCODE ONLY, so a found shop whose
// name we already hold gets the button, prefills the colliding name, and
// (before this fix) 500s in a fresh tab.
//
// So the assertions below are about the RESPONSE, not just the absence of a
// throw: 400 with the form re-rendered and the values still in it, never a
// 302, never a 500, and no row written.
//
// REAL SQLITE UNDERNEATH, real templates on top. Only the three incidental
// reads (the parent food bank, the row being edited, the sibling locations)
// are faked; donationPointNameTaken and upsertDonationPoint are the shipped
// implementations running against a real UNIQUE index, so the exceptId wiring
// and the NULL-safe `id IS NOT ?` are exercised through the route rather than
// asserted about. Spelling the check `id != ?` fails eight tests in this file;
// dropping the `existing?.id` argument fails one more (the edit that keeps its
// own name); widening the query past `foodbank_id = ?` fails three. Counted by
// running each mutant, not estimated.
//
// This file therefore also carries the ENGINE-LEVEL tests of
// packages/db/src/donationPointsAdmin.ts's donationPointNameTaken (the last
// two describe blocks), even though the function lives in another package.
// That is a deliberate placement, not an accident of drift: node:sqlite has no
// types under packages/db's tsconfig (`"types": ["@cloudflare/workers-types"]`)
// and giving it some is a dependency change, whereas workers/site already
// resolves them. Its colocated test next to the module pins the query's SHAPE
// -- the table, the predicates, the bindings -- and says so, and points here
// for the proof that the SQL means what it claims.

// Same reduced transcription of migrations/0001_core.sql:84-102 (as amended by
// 0019_drop_foodbank_cache.sql) as packages/db/src/donationPointsAdmin.test.ts
// uses -- the columns the admin write path names, plus the index this whole
// exercise is about.
const SCHEMA = `
CREATE TABLE foodbankdonationpoint (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT NOT NULL, postcode TEXT NOT NULL, country TEXT,
  lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  place_id TEXT,
  is_closed INTEGER NOT NULL, in_store_only INTEGER NOT NULL,
  phone_number TEXT, url TEXT, opening_hours TEXT,
  wheelchair_accessible INTEGER,
  company TEXT, company_slug TEXT, store_id TEXT, notes TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX dp_fb_name_uniq ON foodbankdonationpoint(foodbank_id, name);
`;

const BRIXTON = { id: 1, name: "Brixton Food Bank", slug: "brixton", network: "Trussell" };
const SID_VALLEY = { id: 2, name: "Sid Valley Food Bank", slug: "sid-valley", network: "Trussell" };

// Shared with the mock factory, which is hoisted above every import.
const fixtures = vi.hoisted(() => ({
  db: null as InstanceType<typeof import("node:sqlite").DatabaseSync> | null,
  foodbanks: {} as Record<string, Record<string, unknown>>,
  locationLatLngs: [] as string[],
}));

vi.mock("@givefood/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@givefood/db")>();
  return {
    ...actual,
    // Faked: reads of tables this test has no reason to stand up. Everything
    // on the WRITE path -- donationPointNameTaken, upsertDonationPoint -- is
    // deliberately left as the real implementation.
    getFoodbankBySlug: async (_session: unknown, slug: string) => fixtures.foodbanks[slug] ?? null,
    getLocationLatLngsByFoodbankId: async () => fixtures.locationLatLngs,
    getDonationPointBySlugs: async (_session: unknown, foodbankSlug: string, donationPointSlug: string) => {
      const foodbank = fixtures.foodbanks[foodbankSlug];
      if (!foodbank) return null;
      const row = fixtures
        .db!.prepare("SELECT * FROM foodbankdonationpoint WHERE foodbank_id = ? AND slug = ?")
        .get(foodbank.id as number, donationPointSlug);
      return row ?? null;
    },
  };
});

type Bindable = null | number | bigint | string | Uint8Array;

// The D1PreparedStatement surface packages/db actually uses, over node:sqlite.
// D1 is async and node:sqlite is synchronous, which is the only difference
// that matters here -- the SQL text, the parameter binding and the NULL
// semantics are SQLite's in both. Cast rather than implemented in full: the
// unused half of D1DatabaseSession (batch, raw, exec) is not what these tests
// are about, and stubbing it would only add ways to be wrong.
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
const CSRF_RAW = "a".repeat(64);

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// A form submission that is valid in every way except, in some tests, its
// name. Distinctive strings so "the values came back" is an assertion about
// THESE values and not about boilerplate that would appear on an empty form.
const TYPED = {
  name: "Tesco Extra",
  address: "17 Acre Lane\nBrixton",
  postcode: "SW2 5SG",
  phone_number: "020 7274 1234",
  opening_hours: "Mon-Sat 0700-2300",
  wheelchair_accessible: "1",
  url: "https://example.invalid/stores/brixton-extra",
  in_store_only: "on",
  company: "Tesco",
  store_id: "STORE-4417",
  notes: "Trolley is by the customer service desk",
  lat_lng: "51.4650,-0.1180",
  place_id: "ChIJnotarealplaceid",
};

let db: DatabaseSync;
let purgeSend: ReturnType<typeof vi.fn>;

function rows(): { id: number; foodbank_id: number; name: string; address: string; lat_lng: string }[] {
  return db.prepare("SELECT id, foodbank_id, name, address, lat_lng FROM foodbankdonationpoint ORDER BY id").all() as never;
}

function seed(foodbankId: number, name: string, slug: string, latLng: string) {
  db.prepare(
    `INSERT INTO foodbankdonationpoint
       (uuid, foodbank_id, name, slug, address, postcode, lat_lng, is_closed, in_store_only, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
  ).run("seeduuid" + slug, foodbankId, name, slug, "1 Old Road", "SW2 1AA", latLng, "2026-01-01T00:00:00");
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  fixtures.db = db;
  fixtures.locationLatLngs = ["51.4599,-0.1145"];
  fixtures.foodbanks = {
    brixton: { ...BRIXTON, lat_lng: "51.4613,-0.1156", delivery_lat_lng: null, url: "https://example.invalid/brixton" },
    "sid-valley": { ...SID_VALLEY, lat_lng: "50.6900,-3.2400", delivery_lat_lng: null, url: null },
  };
  purgeSend = vi.fn(async () => {});
});

interface PostResult {
  res: Response;
  html: string;
}

// A real Hono app registered at the production paths (routes/admin/index.ts:
// 160-163), because create and edit are the SAME handler distinguished only by
// whether :dpSlug matched -- a hand-built Context would let a change in how
// that distinction is drawn slip through.
async function post(path: string, fields: Record<string, string>): Promise<PostResult> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    c.set("adminUser", { email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "" });
    await next();
  });
  app.post("/admin/foodbank/:slug/donationpoint/new/", adminDonationPointForm);
  app.post("/admin/foodbank/:slug/donationpoint/:dpSlug/edit/", adminDonationPointForm);
  // The 500 page issue #12 is about. Caught and labelled rather than left to
  // become an unhandled rejection, so a regression reads as "expected 400,
  // got 500: UNIQUE constraint failed" instead of a vitest crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));

  const env = {
    DB: { withSession: () => d1Session(db) },
    CSRF_SECRET,
    PURGE_Q: { send: purgeSend },
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
  } as unknown as AppEnv["Bindings"];

  const signature = await hmacSha256Hex(CSRF_SECRET, CSRF_RAW);
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-csrf=${CSRF_RAW}.${signature}`,
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
      },
      body: new URLSearchParams({ ...fields, csrf_token: CSRF_RAW }).toString(),
    }),
    env,
    execCtx,
  );
  // Read the body once, here: several assertions want it, and a Response body
  // can only be consumed once.
  const html = res.status === 302 ? "" : await res.text();
  return { res, html };
}

// Django's message verbatim, from unique_error_message()'s multi-field branch
// -- "%(model_name)s with this %(field_labels)s already exists." with
// capfirst(verbose_name) = "Foodbank donation point" (foodbank.py:1028-1030
// declares no verbose_name) and the unique_together field labels joined by
// "and". The offending value is appended, the improvement items.ts:133 already
// made to the single-field branch.
const DUPLICATE_ERROR = 'Foodbank donation point with this Foodbank and Name already exists: "Tesco Extra"';

// The banner generic_form.njk:28 renders `error` into, read back as the admin
// reads it. Nunjucks autoescapes, so the quotes around the offending name
// arrive as `&#34;` -- decoded here rather than asserted around, so the
// expectation stays the sentence a human would check against Django's, and so
// the whole banner is compared rather than a substring of it.
function errorBanner(html: string): string | null {
  const match = html.match(/<div class="notification is-danger is-light">([\s\S]*?)<\/div>/);
  if (!match) return null;
  return match[1]!
    .trim()
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("adminDonationPointForm -- the (foodbank, name) uniqueness check", () => {
  describe("create", () => {
    it("blocks a name the food bank already uses, and re-renders the form", async () => {
      seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
      const { res, html } = await post("/admin/foodbank/brixton/donationpoint/new/", TYPED);

      // Not a 500 (what issue #12 reported) and not a 302 (which would mean a
      // save silently discarded, the one outcome worse than the 500).
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
      expect(errorBanner(html)).toBe(DUPLICATE_ERROR);
    });

    // The class static/js/admin.js:106 selects on, asserted through the REAL
    // route so the title expression is exercised rather than a hardcoded
    // string. Interpolating the food bank name into page_title once produced
    // `form-new-brixton-food-bank-donation-point`, which matches neither of
    // the script's two selectors, and silently disabled both the "Lookup
    // Donation Point" button and the company auto-select (fixed 3b31087;
    // the auto-select was reported again as github #57).
    it("renders the form class admin.js selects on", async () => {
      seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
      const { html } = await post("/admin/foodbank/brixton/donationpoint/new/", TYPED);

      expect(html).toContain('class="form-new-donation-point"');
      expect(html).not.toMatch(/class="form-new-[a-z-]*-donation-point"/);
    });

    it("gives the admin back every value they typed", async () => {
      seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
      const { html } = await post("/admin/foodbank/brixton/donationpoint/new/", TYPED);

      // The whole point of the fix. Each of these is a field the Lookup
      // button fills, which the 500 used to throw away.
      expect(html).toContain("Tesco Extra");
      expect(html).toContain("17 Acre Lane");
      expect(html).toContain("SW2 5SG");
      expect(html).toContain("Mon-Sat 0700-2300");
      expect(html).toContain("51.4650,-0.1180");
      expect(html).toContain("ChIJnotarealplaceid");
      expect(html).toContain("STORE-4417");
      expect(html).toContain("Trolley is by the customer service desk");
      expect(html).toContain("https://example.invalid/stores/brixton-extra");
      // Spaces stripped by parseAdminFields' SPACE_STRIPPED_FIELDS -- the
      // normalised value is what comes back, not the raw one.
      expect(html).toContain("02072741234");
      // Still the form, not an error page: the submit button and the CSRF
      // field have to be there or "values preserved" is preserved nowhere the
      // admin can press Save from.
      expect(html).toContain('name="csrf_token"');
      expect(html).toContain("Submit");
    });

    // The three field kinds a `toContain` on the raw HTML would pass on by
    // accident, because their submitted value never appears as text: a
    // checkbox re-renders as the `checked` attribute, a tristate and a select
    // as `selected` on one <option>. Each survives only because
    // parseAdminFields' coercion and formfields.njk's test agree about the
    // type -- checkbox becomes the NUMBER 1 (adminFormFields.ts:288) and the
    // template tests `{% if value %}`; tristate becomes 1/0/null (:293) and
    // the template tests `value == 1`. Recoerce either side to a string and
    // the controls come back blank while every assertion above still passes:
    // the admin re-submits a donation point that has quietly become
    // wheelchair-accessibility-unknown, not in-store-only, and companyless --
    // which then breaks its /donationpoints/company/<slug>/ grouping and its
    // logo. wheelchair_accessible and opening_hours are two of the eight
    // fields the "Lookup Donation Point" button fills, so this is squarely
    // the loss issue #12 is about, just quieter than a 500.
    it("gives back the checkbox, tristate and select values too", async () => {
      seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
      const { html } = await post("/admin/foodbank/brixton/donationpoint/new/", TYPED);

      expect(html).toMatch(/<input type="checkbox" id="id_in_store_only"[^>]*checked/);
      expect(html).toMatch(/<option value="1" selected>Yes<\/option>/);
      expect(html).toMatch(/<option value="Tesco" selected>Tesco<\/option>/);
    });

    // The other direction, which the "on"-shaped test above cannot see: an
    // unticked checkbox and an explicit "No" have to come back unticked and
    // No, not silently flipped on by a truthy default.
    it("gives back an unticked checkbox and an explicit No", async () => {
      seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
      const { html } = await post("/admin/foodbank/brixton/donationpoint/new/", {
        ...TYPED,
        in_store_only: "",
        wheelchair_accessible: "0",
      });

      expect(html).toMatch(/<input type="checkbox" id="id_in_store_only"(?![^>]*checked)[^>]*>/);
      expect(html).toMatch(/<option value="0" selected>No<\/option>/);
    });

    it("writes nothing and purges nothing when it blocks", async () => {
      seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
      await post("/admin/foodbank/brixton/donationpoint/new/", TYPED);

      expect(rows()).toHaveLength(1);
      expect(rows()[0]!.address).toBe("1 Old Road");
      // A cache purge for a save that did not happen would evict the whole
      // food bank's pages on every rejected submission.
      expect(purgeSend).not.toHaveBeenCalled();
    });

    // The other half of the check being worth anything: it must not block
    // saves the database would have accepted.
    it("allows a name free on that food bank", async () => {
      seed(BRIXTON.id, "Co-op", "co-op", "51.4700,-0.1300");
      const { res } = await post("/admin/foodbank/brixton/donationpoint/new/", TYPED);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/foodbank/brixton/#donationpoints");
      expect(rows().map((r) => r.name)).toEqual(["Co-op", "Tesco Extra"]);
      expect(purgeSend).toHaveBeenCalledTimes(1);
    });

    // dp_fb_name_uniq is (foodbank_id, name). A check that dropped the
    // foodbank_id predicate would reject this, and there are many food banks
    // with a Tesco Extra.
    it("allows a name another food bank uses", async () => {
      seed(SID_VALLEY.id, "Tesco Extra", "tesco-extra", "50.6900,-3.2400");
      const { res } = await post("/admin/foodbank/brixton/donationpoint/new/", TYPED);

      expect(res.status).toBe(302);
      expect(rows()).toHaveLength(2);
    });

    // The check runs on the create path with no row to exclude, where
    // exceptId is undefined and binds as NULL. Spelled `id != ?` this returns
    // no row, the handler falls through to the INSERT, and the 500 is back --
    // so this is the route-level guard on that mutant. It is deliberately
    // asserted through the RESPONSE rather than through the helper: the bug
    // being fixed was never "the SQL is wrong", it was "the admin gets a 500".
    it("is not defeated by the NULL exceptId of a create", async () => {
      seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
      const { res, html } = await post("/admin/foodbank/brixton/donationpoint/new/", TYPED);

      expect(res.status).not.toBe(500);
      expect(res.status).toBe(400);
      expect(errorBanner(html)).toBe(DUPLICATE_ERROR);
      expect(rows()).toHaveLength(1);
    });
  });

  describe("edit", () => {
    // THE REGRESSION exceptId EXISTS FOR, and the reason a naive check would
    // be worse than no check: the "Lookup Donation Point" button's whole job
    // is to refresh lat_lng / place_id / address / opening_hours on an
    // existing row while leaving the Name alone, after which the admin saves.
    // A check that matched the row against its own unchanged name would make
    // that flow permanently unsavable.
    it("allows a row to keep its own name", async () => {
      seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
      const { res } = await post("/admin/foodbank/brixton/donationpoint/tesco-extra/edit/", TYPED);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/foodbank/brixton/#donationpoints");
      // Updated in place, not inserted alongside.
      expect(rows()).toHaveLength(1);
      expect(rows()[0]!.address).toBe("17 Acre Lane\nBrixton");
      expect(rows()[0]!.lat_lng).toBe("51.4650,-0.1180");
    });

    it("blocks a rename onto a sibling's name on the same food bank", async () => {
      seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
      seed(BRIXTON.id, "Tesco Express", "tesco-express", "51.4710,-0.1310");
      // Editing Tesco Express, shortening its name to the one Tesco Extra has.
      const { res, html } = await post("/admin/foodbank/brixton/donationpoint/tesco-express/edit/", TYPED);

      expect(res.status).toBe(400);
      expect(errorBanner(html)).toBe(DUPLICATE_ERROR);
      expect(html).toContain("17 Acre Lane");
      // Nothing moved: both rows still hold their original names and address.
      expect(rows().map((r) => r.name)).toEqual(["Tesco Extra", "Tesco Express"]);
      expect(rows().every((r) => r.address === "1 Old Road")).toBe(true);
      expect(purgeSend).not.toHaveBeenCalled();
    });

    it("allows a rename to a name nothing on that food bank holds", async () => {
      seed(BRIXTON.id, "Tesco Express", "tesco-express", "51.4710,-0.1310");
      const { res } = await post("/admin/foodbank/brixton/donationpoint/tesco-express/edit/", TYPED);

      expect(res.status).toBe(302);
      expect(rows().map((r) => r.name)).toEqual(["Tesco Extra"]);
    });

    // Self-exclusion must be by id. A same-named row on ANOTHER food bank
    // must not be mistaken for "this is just me", or the collision on this
    // food bank goes unreported and the 500 returns.
    it("still blocks when a same-named row exists on another food bank too", async () => {
      seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
      seed(BRIXTON.id, "Tesco Express", "tesco-express", "51.4710,-0.1310");
      seed(SID_VALLEY.id, "Tesco Extra", "tesco-extra", "50.6900,-3.2400");
      const { res, html } = await post("/admin/foodbank/brixton/donationpoint/tesco-express/edit/", TYPED);

      expect(res.status).toBe(400);
      expect(errorBanner(html)).toBe(DUPLICATE_ERROR);
      expect(rows()).toHaveLength(3);
    });

    it("offers a Delete button on the re-rendered edit form", async () => {
      seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
      seed(BRIXTON.id, "Tesco Express", "tesco-express", "51.4710,-0.1310");
      const { html } = await post("/admin/foodbank/brixton/donationpoint/tesco-express/edit/", TYPED);

      // The re-render is the EDIT form, not a create form that happens to be
      // full of the right values -- it still knows which row it is editing.
      expect(html).toContain("/admin/foodbank/brixton/donationpoint/tesco-express/delete/");
      expect(html).toContain("Edit Donation Point");
    });
  });

  // Django's ModelForm._post_clean() runs full_clean() -- and with it
  // Model.clean() -- with validate_unique=False, then calls validate_unique()
  // separately afterwards. A submission failing both therefore surfaced the
  // clean() error first, and this port's single `error` slot keeps that order.
  it("reports the co-location clean() error ahead of the uniqueness one", async () => {
    seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
    const { res, html } = await post("/admin/foodbank/brixton/donationpoint/new/", {
      ...TYPED,
      lat_lng: "51.4613,-0.1156", // the food bank's own coordinates
    });

    expect(res.status).toBe(400);
    expect(errorBanner(html)).toBe("Location can't be the same as the food bank or one of it's locations");
    expect(html).not.toContain("already exists");
  });

  // The uniqueness check must not run ahead of plain field validation either
  // -- a submission missing a required field has no name worth checking, and
  // reporting "already exists" for a blank name would be nonsense.
  it("reports a missing required field ahead of the uniqueness one", async () => {
    seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
    const { res, html } = await post("/admin/foodbank/brixton/donationpoint/new/", { ...TYPED, postcode: "" });

    expect(res.status).toBe(400);
    expect(errorBanner(html)).toBe("Postcode is required");
    expect(html).not.toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// packages/db/src/donationPointsAdmin.ts's donationPointNameTaken, against a
// real engine. See this file's header for why it is tested from here.
// ---------------------------------------------------------------------------

// Everything upsertDonationPoint needs beyond the name, so that the only
// variable in the tests below is the thing under test.
function upsertParams(foodbankId: number, name: string, latLng = "51.4650,-0.1180") {
  return {
    foodbankId,
    foodbank: { name: "Brixton Food Bank", slug: "brixton", network: "Trussell" },
    name,
    address: "17 Acre Lane",
    postcode: "SW2 5SG",
    phoneNumber: null,
    openingHours: null,
    wheelchairAccessible: null,
    url: null,
    inStoreOnly: 0,
    company: "Tesco",
    storeId: null,
    notes: null,
    latLng,
    placeId: null,
  };
}

function idOf(foodbankId: number, name: string): number {
  const row = db.prepare("SELECT id FROM foodbankdonationpoint WHERE foodbank_id = ? AND name = ?").get(foodbankId, name) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`no donation point named ${name} on food bank ${foodbankId}`);
  return row.id;
}

describe("donationPointNameTaken", () => {
  beforeEach(() => {
    seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
    seed(BRIXTON.id, "Co-op", "co-op", "51.4600,-0.1100");
    seed(SID_VALLEY.id, "Tesco Extra", "tesco-extra", "50.6900,-3.2400");
  });

  describe("create (exceptId undefined)", () => {
    it("reports a name already used on the same food bank", async () => {
      expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Tesco Extra", undefined)).toBe(true);
    });

    it("allows a name no donation point on that food bank holds", async () => {
      expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Sainsbury's", undefined)).toBe(false);
    });

    it("allows a name another FOOD BANK holds", async () => {
      expect(await donationPointNameTaken(d1Session(db), 3, "Tesco Extra", undefined)).toBe(false);
    });

    // THE MUTANT KILLER, at the level of the helper. With `id != ?` and
    // exceptId bound as NULL this returns false and the 500 comes straight
    // back, so this assertion is the difference between a fix and the
    // appearance of one.
    it("still sees existing rows when there is no row to exclude", async () => {
      expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Tesco Extra", undefined)).toBe(true);
      expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Co-op", undefined)).toBe(true);
    });

    // The engine behaviour the module's comment asserts, executed rather than
    // reasoned about -- TESTING.md's "parity claims are checked by running it,
    // not by reasoning". If SQLite ever made `!= NULL` behave like `IS NOT
    // NULL`, this is where that shows up, and the helper's justification would
    // need rewriting rather than the helper.
    it("pins the SQLite NULL semantics the `IS NOT` spelling exists for", () => {
      const naive = db.prepare("SELECT id FROM foodbankdonationpoint WHERE foodbank_id = ? AND name = ? AND id != ?");
      expect(naive.get(BRIXTON.id, "Tesco Extra", null)).toBeUndefined();

      const nullSafe = db.prepare("SELECT id FROM foodbankdonationpoint WHERE foodbank_id = ? AND name = ? AND id IS NOT ?");
      expect(nullSafe.get(BRIXTON.id, "Tesco Extra", null)).toBeDefined();
    });
  });

  describe("edit (exceptId set)", () => {
    it("allows a row to keep its own name", async () => {
      expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Tesco Extra", idOf(BRIXTON.id, "Tesco Extra"))).toBe(false);
    });

    it("blocks a rename onto a sibling's name on the same food bank", async () => {
      expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Tesco Extra", idOf(BRIXTON.id, "Co-op"))).toBe(true);
    });

    it("allows a rename to a name free on this food bank", async () => {
      expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Morrisons", idOf(BRIXTON.id, "Co-op"))).toBe(false);
    });

    // Excluding self must exclude by id, not by "some row with this name".
    it("does not let a same-named row on another food bank stand in for self", async () => {
      expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Tesco Extra", idOf(SID_VALLEY.id, "Tesco Extra"))).toBe(true);
    });
  });

  // Exactly as strict as dp_fb_name_uniq and no stricter. parseAdminFields
  // trims (adminFormFields.ts:297) but does not case-fold or collapse internal
  // whitespace, and neither does SQLite's default BINARY collation, so only a
  // byte-for-byte match collides. Pinned so that "helpfully" case-folding the
  // check later -- which would reject saves the database would have accepted,
  // and diverge from what Django reported -- is a visible decision.
  it("matches byte-for-byte, like the index it stands in for", async () => {
    expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "tesco extra", undefined)).toBe(false);
    expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Tesco  Extra", undefined)).toBe(false);
    expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Tesco Extra ", undefined)).toBe(false);
  });
});

// The check is only worth anything if it predicts what the database will do.
// These run the real writer against the real UNIQUE index, so a helper that
// drifted from the constraint -- wrong table, wrong columns, dropped predicate
// -- is caught even if every assertion above still passed.
describe("the check agrees with dp_fb_name_uniq", () => {
  beforeEach(() => {
    seed(BRIXTON.id, "Tesco Extra", "tesco-extra", "51.4700,-0.1300");
    seed(BRIXTON.id, "Co-op", "co-op", "51.4600,-0.1100");
  });

  it("permits exactly the INSERT that SQLite accepts", async () => {
    expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Morrisons", undefined)).toBe(false);
    await expect(upsertDonationPoint(d1Session(db), upsertParams(BRIXTON.id, "Morrisons"), undefined)).resolves.toBeTypeOf("string");
  });

  it("blocks exactly the INSERT that SQLite rejects", async () => {
    expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Tesco Extra", undefined)).toBe(true);
    // This is the throw that reached app.onError and rendered the 500 page.
    await expect(upsertDonationPoint(d1Session(db), upsertParams(BRIXTON.id, "Tesco Extra"), undefined)).rejects.toThrow(/UNIQUE/i);
  });

  it("blocks exactly the UPDATE that SQLite rejects, and permits the self-save", async () => {
    const coop = idOf(BRIXTON.id, "Co-op");
    expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Tesco Extra", coop)).toBe(true);
    await expect(upsertDonationPoint(d1Session(db), upsertParams(BRIXTON.id, "Tesco Extra"), coop)).rejects.toThrow(/UNIQUE/i);

    expect(await donationPointNameTaken(d1Session(db), BRIXTON.id, "Co-op", coop)).toBe(false);
    await expect(upsertDonationPoint(d1Session(db), upsertParams(BRIXTON.id, "Co-op"), coop)).resolves.toBeTypeOf("string");
  });
});
