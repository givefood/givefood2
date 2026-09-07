import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../types";
import { FOODBANK_LOCATION_FIELDS } from "../../lib/adminFormFields";

// GitHub issue #12: "500 adding a location with the same name as an existing
// location." packages/db/src/locationsAdmin.test.ts proves the two pre-flight
// queries answer correctly. This file proves the HANDLER does the thing the
// issue was actually about: refusing the save without losing the form.
//
// A duplicate used to reach D1, raise SQLITE_CONSTRAINT_UNIQUE and fall
// through to app.onError's 500 page, taking ten fields with it -- including a
// boundary GeoJSON textarea and whatever the Lookup button had just pulled out
// of Google Places. So "it returns 400" is not the assertion that matters:
// every test below that expects a refusal also asserts that upsertLocation was
// never called AND that the admin's own values came back in the re-rendered
// form's `data`. A fix that 400s with an empty form would pass a status check
// and still be the bug.
//
// The db layer is only PARTLY mocked, on purpose. getFoodbankBySlug /
// getFoodbankLocationBySlugs / upsertLocation are stubs, but
// locationNameTaken, locationSlugTaken and locationSlug are the real
// implementations running their real SQL against a real in-memory SQLite
// (same reasoning as locationsAdmin.test.ts's header: the `id IS NOT ?` /
// `id != ?` difference lives in the engine, not in JavaScript). Changing
// `IS NOT` to `!=` in locationsAdmin.ts makes the two create-path refusals
// here go green-lit and fail; that mutant was run, not imagined.

const mocks = vi.hoisted(() => ({
  render: vi.fn(async () => "<html>form</html>"),
  getFoodbankBySlug: vi.fn(),
  getFoodbankLocationBySlugs: vi.fn(),
  // Typed to take arguments so `mock.calls[0][2]` -- the existingId the
  // handler passes, which is the whole edit/create distinction -- is
  // inspectable rather than a zero-length tuple.
  upsertLocation: vi.fn(async (..._args: unknown[]) => "written-slug"),
}));

vi.mock("@givefood/templates", () => ({ render: mocks.render }));
// The template is precompiled into packages/templates/src/generated/, which
// is a build artefact and gitignored -- importing the real render() would
// make this suite fail on a fresh checkout for reasons that have nothing to
// do with locations. Asserting on the CONTEXT handed to the template is also
// the more direct claim: "the form is re-rendered with the admin's values"
// is a statement about `data`, not about markup.
vi.mock("./pageContext", () => ({ adminPageContext: async () => ({ csrf_token: "test-token" }) }));
vi.mock("../../lib/csrf", () => ({ verifyCsrf: async () => true, issueCsrfToken: async () => "test-token" }));
vi.mock("@givefood/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@givefood/db")>();
  return {
    ...actual,
    getFoodbankBySlug: mocks.getFoodbankBySlug,
    getFoodbankLocationBySlugs: mocks.getFoodbankLocationBySlugs,
    upsertLocation: mocks.upsertLocation,
  };
});

// importActual, not a plain import: the vi.mock above replaces
// upsertLocation, and seeding the fixture rows through the mock would seed
// nothing. The seeds go in through the REAL writer so that the rows the real
// checks read back are exactly the rows the real writer produces -- slug
// derivation included.
const {
  locationSlug,
  locationNameTaken,
  locationSlugTaken,
  upsertLocation: realUpsertLocation,
  getFoodbankLocationBySlugs: realGetFoodbankLocationBySlugs,
} = await vi.importActual<typeof import("@givefood/db")>("@givefood/db");
const { adminFoodbankLocationForm } = await import("./foodbankLocation");

// Mirrors migrations/0001_core.sql:57-77 as amended by
// 0019_drop_foodbank_cache.sql -- see locationsAdmin.test.ts for the full
// reasoning about which columns are here and why both indexes matter.
//
// `place_id` is here because upsertLocation writes it (issue #34), and the
// `foodbank` table and `foodbanklocation_full` view are here so that the
// REAL getFoodbankLocationBySlugs -- which selects * from the view, not from
// the table -- can run against this database in the place_id block below.
// Nothing else in this file needs either, but a hand-built row standing in
// for the read half would have made the round-trip proof circular: the whole
// question is whether the value survives the trip out of storage and back,
// and the view is one of the steps it has to survive.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  network TEXT, phone_number TEXT, contact_email TEXT
);
CREATE TABLE foodbanklocation (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT, postcode TEXT,
  country TEXT NOT NULL, lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  place_id TEXT,
  is_closed INTEGER NOT NULL, is_donation_point INTEGER, is_mobile INTEGER,
  boundary_geojson TEXT,
  phone_number TEXT, email TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX loc_fb_name_uniq   ON foodbanklocation(foodbank_id, name);
CREATE INDEX loc_foodbank_slug_idx     ON foodbanklocation(foodbank_id, slug);
CREATE VIEW foodbanklocation_full AS
  SELECT l.*,
         f.name          AS foodbank_name,
         f.slug          AS foodbank_slug,
         f.network       AS foodbank_network,
         f.phone_number  AS foodbank_phone_number,
         f.contact_email AS foodbank_email
    FROM foodbanklocation l
    LEFT JOIN foodbank f ON f.id = l.foodbank_id;
`;

type Bindable = null | number | bigint | string | Uint8Array;

function d1Session(db: DatabaseSync) {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null };
}

const SALISBURY = {
  id: 1,
  name: "Salisbury",
  slug: "salisbury",
  network: "Trussell",
  phone_number: "01722 349556",
  contact_email: "info@salisbury.foodbank.org.uk",
  country: "England",
  url: "https://salisbury.foodbank.org.uk/",
};

// Hono's fetch() wants an ExecutionContext; the handler uses waitUntil for the
// cache purge, which is fire-and-forget and irrelevant to every assertion here.
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let env: AppEnv["Bindings"];
let app: Hono<AppEnv>;

function seedParams(name: string, latLng = "51.0688,-1.7945") {
  return {
    foodbankId: SALISBURY.id,
    foodbank: SALISBURY,
    name,
    address: "Bemerton Heath",
    postcode: "SP2 9DY",
    isDonationPoint: 0,
    isMobile: 0,
    latLng,
    boundaryGeojson: null,
    placeId: null,
    phoneNumber: null,
    email: null,
  };
}

function rowFor(name: string) {
  const row = db.prepare("SELECT id, name, slug FROM foodbanklocation WHERE foodbank_id = ? AND name = ?").get(SALISBURY.id, name) as
    | { id: number; name: string; slug: string }
    | undefined;
  if (!row) throw new Error(`no seeded location named ${name}`);
  return row;
}

// The fields FOODBANK_LOCATION_FIELDS declares required (name, lat_lng) plus
// enough optional ones that "the admin's values survived" is a claim about
// more than one box -- boundary_geojson especially, since re-pasting a
// multi-kilobyte polygon is the loss the 500 actually cost someone.
const TYPED = {
  address: "Pembroke Road, Bemerton Heath",
  postcode: "SP2 9DY",
  lat_lng: "51.0812,-1.8231",
  boundary_geojson: '{"type":"Feature","geometry":{"type":"Point","coordinates":[-1.8231,51.0812]}}',
  phone_number: "01722 349556",
};

function post(url: string, fields: Record<string, string>) {
  return app.request(url, { method: "POST", body: new URLSearchParams({ csrf_token: "test-token", ...fields }) }, env, execCtx);
}

function lastRenderContext(): Record<string, unknown> {
  const call = mocks.render.mock.calls.at(-1);
  if (!call) throw new Error("render() was never called");
  return (call as unknown as [string, Record<string, unknown>])[1];
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.render.mockResolvedValue("<html>form</html>");
  mocks.upsertLocation.mockResolvedValue("written-slug");
  mocks.getFoodbankBySlug.mockResolvedValue(SALISBURY);
  mocks.getFoodbankLocationBySlugs.mockResolvedValue(null);

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  // The parent row the foodbanklocation_full view joins to. Only the place_id
  // block reads through the view; every other test here talks to the base
  // table, where this row is simply unreferenced.
  db.prepare("INSERT INTO foodbank (id, name, slug, network, phone_number, contact_email) VALUES (?, ?, ?, ?, ?, ?)").run(
    SALISBURY.id,
    SALISBURY.name,
    SALISBURY.slug,
    SALISBURY.network,
    SALISBURY.phone_number,
    SALISBURY.contact_email,
  );
  const session = d1Session(db);
  env = { DB: { withSession: () => session }, CSRF_SECRET: "s", PURGE_Q: { send: async () => {} } } as unknown as AppEnv["Bindings"];

  // Seeded through the real writer so the rows the real checks read are the
  // rows the real writer would have produced -- slug derivation included.
  await realUpsertLocation(session as never, seedParams("Bemerton Heath Centre"), undefined);
  await realUpsertLocation(session as never, seedParams("Amesbury", "51.1725,-1.7820"), undefined);

  app = new Hono<AppEnv>();
  app.all("/admin/foodbank/:slug/location/new/", adminFoodbankLocationForm);
  app.all("/admin/foodbank/:slug/location/:locSlug/edit/", adminFoodbankLocationForm);
});

describe("create", () => {
  // Issue #12's literal repro, and the create half is where exceptId is
  // undefined -- so this is also the route-level mutant killer: with
  // `id != ?` the pre-flight would find nothing, the save would proceed, and
  // this test would see a 302 instead of a 400.
  it("refuses a duplicate name and re-renders the form with everything typed", async () => {
    const res = await post("/admin/foodbank/salisbury/location/new/", { name: "Bemerton Heath Centre", ...TYPED });

    expect(res.status).toBe(400);
    expect(mocks.upsertLocation).not.toHaveBeenCalled();

    const context = lastRenderContext();
    // Django's own unique_together message for this model, confirmed by
    // running Django 5.2's Model.unique_error_message() against a mirror of
    // givefood/models/foodbank.py:794-795's Meta rather than transcribed from
    // memory. The trailing value is this port's addition (items.ts:133 does
    // the same) and is deliberately kept.
    expect(context.error).toBe('Foodbank location with this Foodbank and Name already exists: "Bemerton Heath Centre"');

    // THE POINT OF THE WHOLE FIX. Not "it was refused" but "it was refused
    // and the admin did not have to retype a boundary polygon".
    const data = context.data as Record<string, unknown>;
    expect(data.name).toBe("Bemerton Heath Centre");
    expect(data.address).toBe(TYPED.address);
    expect(data.lat_lng).toBe(TYPED.lat_lng);
    expect(data.boundary_geojson).toBe(TYPED.boundary_geojson);
    // What comes back is parseAdminFields' NORMALISED value, not the raw
    // body -- phone_number is in SPACE_STRIPPED_FIELDS, so "01722 349556"
    // returns as "01722349556". Django's bound form re-rendered the raw
    // input instead. Pinned rather than papered over: the divergence is
    // shared with donationPoint.ts, which re-renders `{ ...parsed.values }`
    // too, and it is what the admin's next save would have stored anyway.
    expect(data.phone_number).toBe("01722349556");
  });

  it("saves a name free on this food bank", async () => {
    const res = await post("/admin/foodbank/salisbury/location/new/", { name: "Wilton", ...TYPED });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/foodbank/salisbury/");
    expect(mocks.upsertLocation).toHaveBeenCalledTimes(1);
    // Third argument is existingId: undefined on a create, which is what
    // makes this the NULL-binding path.
    expect(mocks.upsertLocation.mock.calls[0]?.[2]).toBeUndefined();
  });

  // The slug is derived from the name and never typed, so it is a separate
  // constraint that can clash when the name does not. "St Marys Hall" is free
  // under loc_fb_name_uniq; its slug is not. loc_foodbank_slug_idx is NOT
  // unique, so nothing would have thrown -- the row would have saved and then
  // been shadowed by getFoodbankLocationBySlugs' `.first()`, invisible on the
  // public site and overwriting its twin from its own edit URL.
  it("refuses a name whose derived slug is already taken, even though the name is free", async () => {
    const session = d1Session(db);
    await realUpsertLocation(session as never, seedParams("St Mary's Hall", "51.0700,-1.8000"), undefined);

    const res = await post("/admin/foodbank/salisbury/location/new/", { name: "St Marys Hall", ...TYPED });

    expect(res.status).toBe(400);
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
    expect(lastRenderContext().error).toContain(`already uses the URL "${locationSlug("St Marys Hall")}"`);
    expect((lastRenderContext().data as Record<string, unknown>).boundary_geojson).toBe(TYPED.boundary_geojson);
  });

  // Behaviour CHANGE, recorded deliberately: this path used to be
  // `c.text(parsed.error, 400)`, a plain-text body that discarded the form
  // exactly as the 500 did. Same status, same error string, but now on the
  // re-rendered page -- there is no reason for one form to lose an admin's
  // work for a missing postcode and keep it for a duplicate name.
  // THE RACE THE PRE-FLIGHT CANNOT CLOSE, and the reason a pre-flight alone
  // does not finish issue #12. lib/session.ts opens every request
  // "first-unconstrained" against a database with read replication enabled
  // (packages/db/src/types.ts:1-7), so locationNameTaken's SELECT can run on
  // a replica that has not yet seen an insert the primary already holds --
  // exactly what a double-submitted POST produces. The write then raises
  // SQLITE_CONSTRAINT_UNIQUE for real. Before the backstop that reached
  // app.onError and rendered the 500 page over the whole form, which is the
  // loss the issue is about; the class is only closed if the rare path lands
  // in the same place as the common one.
  it("catches a constraint violation the pre-flight missed instead of 500ing", async () => {
    mocks.upsertLocation.mockRejectedValueOnce(
      new Error("D1_ERROR: UNIQUE constraint failed: foodbanklocation.foodbank_id, foodbanklocation.name"),
    );

    const res = await post("/admin/foodbank/salisbury/location/new/", { name: "Wilton", ...TYPED });

    expect(res.status).toBe(400);
    const context = lastRenderContext();
    expect(context.error).toContain("nothing was saved");
    // The raw SQLite text is logged, never shown -- and the form comes back
    // whole, which is the only assertion that distinguishes this from the
    // 500 it replaces.
    expect(String(context.error)).not.toContain("UNIQUE constraint");
    expect((context.data as Record<string, unknown>).boundary_geojson).toBe(TYPED.boundary_geojson);
    expect((context.data as Record<string, unknown>).name).toBe("Wilton");
  });

  it("re-renders rather than replying in plain text when a required field is missing", async () => {
    const res = await post("/admin/foodbank/salisbury/location/new/", { name: "", ...TYPED });

    expect(res.status).toBe(400);
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
    expect(lastRenderContext().error).toBe("Name is required");
    expect((lastRenderContext().data as Record<string, unknown>).lat_lng).toBe(TYPED.lat_lng);
  });
});

describe("edit", () => {
  // THE REGRESSION exceptId EXISTS FOR. admin.js injects a Lookup button onto
  // this form whose whole job is to refill lat_lng / address / postcode on an
  // existing row while leaving Name alone. A check that matched the row being
  // edited against itself would make every such save impossible -- a worse
  // bug than issue #12, because it would have no workaround.
  it("lets a location keep its own name", async () => {
    const row = rowFor("Bemerton Heath Centre");
    mocks.getFoodbankLocationBySlugs.mockResolvedValue(row);

    const res = await post(`/admin/foodbank/salisbury/location/${row.slug}/edit/`, { name: row.name, ...TYPED });

    expect(res.status).toBe(302);
    expect(mocks.upsertLocation).toHaveBeenCalledTimes(1);
    expect(mocks.upsertLocation.mock.calls[0]?.[2]).toBe(row.id);
  });

  // The maintainer's issue says "adding", but the edit path had the identical
  // hole: renaming one location onto a sibling's name (tidying wording, or
  // merging two near-duplicate rows) hit the same index and the same 500.
  it("refuses a rename onto a sibling's name and keeps the edits", async () => {
    const row = rowFor("Amesbury");
    mocks.getFoodbankLocationBySlugs.mockResolvedValue(row);

    const res = await post(`/admin/foodbank/salisbury/location/${row.slug}/edit/`, { name: "Bemerton Heath Centre", ...TYPED });

    expect(res.status).toBe(400);
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
    expect(lastRenderContext().error).toBe('Foodbank location with this Foodbank and Name already exists: "Bemerton Heath Centre"');
    expect((lastRenderContext().data as Record<string, unknown>).boundary_geojson).toBe(TYPED.boundary_geojson);
  });

  it("allows a rename to a name free on this food bank", async () => {
    const row = rowFor("Amesbury");
    mocks.getFoodbankLocationBySlugs.mockResolvedValue(row);

    const res = await post(`/admin/foodbank/salisbury/location/${row.slug}/edit/`, { name: "Durrington", ...TYPED });

    expect(res.status).toBe(302);
    expect(mocks.upsertLocation).toHaveBeenCalledTimes(1);
  });

  // The slug check is skipped when the slug is unchanged, and this is why.
  // loc_foodbank_slug_idx has never been unique, so production may already
  // hold a pair of rows sharing a slug; without the `slug !== existing.slug`
  // guard the reachable one of that pair would become permanently unsavable,
  // punishing an admin for a collision that predates the check.
  it("lets a location save when a sibling already shares its slug", async () => {
    const session = d1Session(db);
    await realUpsertLocation(session as never, seedParams("St Mary's Hall", "51.0700,-1.8000"), undefined);
    await realUpsertLocation(session as never, seedParams("St Marys Hall", "51.0701,-1.8001"), undefined);
    const row = rowFor("St Mary's Hall");
    mocks.getFoodbankLocationBySlugs.mockResolvedValue(row);

    const res = await post(`/admin/foodbank/salisbury/location/${row.slug}/edit/`, { name: row.name, ...TYPED });

    expect(res.status).toBe(302);
    expect(mocks.upsertLocation).toHaveBeenCalledTimes(1);
  });

  it("refuses a rename whose derived slug lands on a sibling's", async () => {
    const session = d1Session(db);
    await realUpsertLocation(session as never, seedParams("St Mary's Hall", "51.0700,-1.8000"), undefined);
    const row = rowFor("Amesbury");
    mocks.getFoodbankLocationBySlugs.mockResolvedValue(row);

    const res = await post(`/admin/foodbank/salisbury/location/${row.slug}/edit/`, { name: "St Marys Hall", ...TYPED });

    expect(res.status).toBe(400);
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
    expect(lastRenderContext().error).toContain("already uses the URL");
  });
});

// THE ENGINE-LEVEL HALF of locationNameTaken / locationSlugTaken's coverage.
// packages/db/src/locationsAdmin.test.ts pins the queries' SHAPE (table,
// predicates, bindings, the `IS NOT` spelling) but cannot run them: node:sqlite
// has no types under that package's tsconfig. So the behaviour is proved here,
// where the same real SQLite database the tests above use is already set up --
// same split, and same reason, as donationPointsAdmin.test.ts and
// donationPoint.test.ts.
describe("the checks against the real indexes", () => {
  const SALISBURY_ID = SALISBURY.id;
  const OTHER_FOODBANK = 2;

  function session() {
    return d1Session(db) as never;
  }

  it("reports a name already used on the same food bank, with no row to exclude", async () => {
    expect(await locationNameTaken(session(), SALISBURY_ID, "Bemerton Heath Centre", undefined)).toBe(true);
    expect(await locationNameTaken(session(), SALISBURY_ID, "Wilton", undefined)).toBe(false);
  });

  // loc_fb_name_uniq is (foodbank_id, name), not (name). Two food banks are
  // each allowed their own Amesbury; a check that forgot the foodbank_id
  // predicate would start rejecting legal saves site-wide.
  it("scopes to the food bank", async () => {
    expect(await locationNameTaken(session(), OTHER_FOODBANK, "Amesbury", undefined)).toBe(false);
  });

  it("lets a row keep its own name, and blocks a rename onto a sibling's", async () => {
    const bemerton = rowFor("Bemerton Heath Centre");
    const amesbury = rowFor("Amesbury");
    expect(await locationNameTaken(session(), SALISBURY_ID, "Bemerton Heath Centre", bemerton.id)).toBe(false);
    expect(await locationNameTaken(session(), SALISBURY_ID, "Bemerton Heath Centre", amesbury.id)).toBe(true);
  });

  // Exactly as strict as the index it stands in for. parseAdminFields trims
  // but does not case-fold or collapse internal whitespace, and neither does
  // SQLite's default BINARY collation. Pinned so that "helpfully" case-folding
  // the check later -- rejecting saves the database would have accepted, and
  // diverging from what Django reported -- is a visible decision.
  it("matches byte-for-byte, like the index it stands in for", async () => {
    expect(await locationNameTaken(session(), SALISBURY_ID, "bemerton heath centre", undefined)).toBe(false);
    expect(await locationNameTaken(session(), SALISBURY_ID, "Bemerton  Heath Centre", undefined)).toBe(false);
  });

  // The engine behaviour locationsAdmin.ts's comment asserts, executed rather
  // than reasoned about (TESTING.md's "parity claims are checked by running
  // it"). If a future SQLite ever made `!= NULL` behave like `IS NOT NULL`,
  // this is where that shows up -- and the helper's justification would need
  // rewriting rather than the helper.
  it("pins the SQLite NULL semantics the `IS NOT` spelling exists for", () => {
    const naive = db.prepare("SELECT id FROM foodbanklocation WHERE foodbank_id = ? AND name = ? AND id != ?");
    expect(naive.get(SALISBURY_ID, "Bemerton Heath Centre", null)).toBeUndefined();

    const nullSafe = db.prepare("SELECT id FROM foodbanklocation WHERE foodbank_id = ? AND name = ? AND id IS NOT ?");
    expect(nullSafe.get(SALISBURY_ID, "Bemerton Heath Centre", null)).toBeDefined();
  });

  // The check is only worth anything if it predicts what the database will do.
  // This runs the real writer against the real UNIQUE index, so a check that
  // drifted from the constraint -- wrong table, wrong columns, dropped
  // predicate -- is caught even if every assertion above still passed.
  it("permits exactly the INSERT SQLite accepts and blocks exactly the one it rejects", async () => {
    expect(await locationNameTaken(session(), SALISBURY_ID, "Wilton", undefined)).toBe(false);
    await expect(realUpsertLocation(session(), seedParams("Wilton", "51.0800,-1.8600"), undefined)).resolves.toBeTypeOf("string");

    expect(await locationNameTaken(session(), SALISBURY_ID, "Amesbury", undefined)).toBe(true);
    // This is the throw that reached app.onError and rendered the 500 page.
    await expect(realUpsertLocation(session(), seedParams("Amesbury"), undefined)).rejects.toThrow(/UNIQUE/i);
  });

  // The asymmetry that makes locationSlugTaken a different KIND of check.
  // loc_foodbank_slug_idx is not unique -- in D1 or in Django -- so the
  // database happily writes the second row: no 500, no error, and from that
  // moment getFoodbankLocationBySlugs' `.first()` can only ever return one of
  // them. If a future migration makes this index UNIQUE, this test fails and
  // locationSlugTaken's comment (which says it prevents a silent loss, not a
  // 500) needs rewriting rather than the code.
  it("shows why the slug collision cannot be left to the database", async () => {
    await realUpsertLocation(session(), seedParams("St Mary's Hall", "51.0700,-1.8000"), undefined);

    expect(await locationNameTaken(session(), SALISBURY_ID, "St Marys Hall", undefined)).toBe(false);
    expect(await locationSlugTaken(session(), SALISBURY_ID, locationSlug("St Marys Hall"), undefined)).toBe(true);
    await expect(realUpsertLocation(session(), seedParams("St Marys Hall", "51.0701,-1.8001"), undefined)).resolves.toBeTypeOf("string");

    expect(db.prepare("SELECT id FROM foodbanklocation WHERE foodbank_id = ? AND slug = ?").all(SALISBURY_ID, "st-marys-hall")).toHaveLength(
      2,
    );
  });
});

describe("GET", () => {
  it("renders at 200 with no error", async () => {
    const res = await app.request("/admin/foodbank/salisbury/location/new/", {}, env, execCtx);

    expect(res.status).toBe(200);
    expect(lastRenderContext().error).toBeNull();
  });

  // admin/foodbank_check.njk:167's Add button, which prefills the name of a
  // location the check job flagged -- flagged on postcode alone
  // (adminJobs/foodbankCheck.ts:243), so the name it hands over may well be
  // one we already hold. The prefill is preserved; the refusal happens on
  // POST, where the admin can see and change it.
  it("keeps the ?name= prefill the food bank check page sends", async () => {
    const res = await app.request("/admin/foodbank/salisbury/location/new/?name=Bemerton%20Heath%20Centre", {}, env, execCtx);

    expect(res.status).toBe(200);
    expect((lastRenderContext().data as Record<string, unknown>).name).toBe("Bemerton Heath Centre");
  });
});

// GITHUB ISSUE #34: "Location admin form silently discards the Place ID it just
// looked up." upsertLocation accepted `placeId` and named the column in neither
// of its two statements, so admin.js's "Lookup Location" button could fetch a
// Place ID out of Google Places, put it in the box, and have it vanish on save.
// packages/db/src/locationsAdmin.test.ts pins the two statements' SHAPE. This
// block runs the whole path against the real SQLite above and then reads the
// stored row, because the shape of an UPDATE is not the interesting claim here.
//
// WHAT THE PRESERVE TEST IS REALLY GUARDING. Writing `place_id = ?` on every
// update is only safe while the edit form round-trips the value it was given:
// the same statement that finally stores a Place ID would otherwise BLANK one
// on every unrelated edit -- a rename, a postcode fix -- across the 1,938
// production rows that hold one. So the round trip is executed rather than
// reasoned about, and every link is real: the row is read back through the
// actual getFoodbankLocationBySlugs (and therefore through
// foodbanklocation_full, which is where a dropped column would hide), the POST
// body is built from the context the handler hands the template using the same
// field list the template iterates, and the write is the actual upsertLocation.
// If any link breaks, "preserves an existing Place ID" fails and this fix is
// correctly reported as the data-loss bug it would then be.
const PLACE_ID = "ChIJVXealLU_xkcRja_At0z9AGY";
const RELOOKED_UP_PLACE_ID = "ChIJ68J3tUsbdkgRDVK5UPlkX4A";

describe("place_id", () => {
  // The db layer is stubbed everywhere else in this file because those tests
  // are about REFUSALS, where the interesting fact is that no row was written.
  // Here the row is the assertion, so both functions are the real ones.
  beforeEach(() => {
    mocks.getFoodbankLocationBySlugs.mockImplementation(async (...args: unknown[]) =>
      realGetFoodbankLocationBySlugs(args[0] as never, args[1] as never, args[2] as never),
    );
    mocks.upsertLocation.mockImplementation(async (...args: unknown[]) =>
      realUpsertLocation(args[0] as never, args[1] as never, args[2] as never),
    );
  });

  async function seedWithPlaceId(name: string, placeId: string | null) {
    await realUpsertLocation(d1Session(db) as never, { ...seedParams(name), placeId }, undefined);
    return rowFor(name);
  }

  function stored(id: number) {
    return db.prepare("SELECT name, place_id FROM foodbanklocation WHERE id = ?").get(id) as {
      name: string;
      place_id: string | null;
    };
  }

  // What a browser would actually submit from the rendered page: the SAME
  // field list the template iterates (generic_form.njk hands
  // FOODBANK_LOCATION_FIELDS to formfields.njk's `fieldset(fields, data)`)
  // over the SAME `data` object the handler gave it. Deliberately NOT built
  // from the database row -- a value only returns on a POST if a field exists
  // for it and the form was given it, which is the link being tested.
  function browserWouldSubmit(data: Record<string, unknown>, edits: Record<string, string> = {}): Record<string, string> {
    const body: Record<string, string> = {};
    for (const spec of FOODBANK_LOCATION_FIELDS) {
      const value = data[spec.name];
      // An unchecked checkbox is ABSENT from the body, and that absence is
      // its false state -- parseAdminFields' own comment says so.
      if (spec.kind === "checkbox") {
        if (value) body[spec.name] = "1";
        continue;
      }
      // nunjucks renders null and undefined into a value attribute as ""
      // (env.ts pins throwOnUndefined: false for exactly that), so a column
      // holding NULL comes back as an empty field.
      body[spec.name] = value === null || value === undefined ? "" : String(value);
    }
    return { ...body, ...edits };
  }

  async function openEditForm(locSlug: string): Promise<Record<string, unknown>> {
    const res = await app.request(`/admin/foodbank/salisbury/location/${locSlug}/edit/`, {}, env, execCtx);
    expect(res.status).toBe(200);
    return lastRenderContext().data as Record<string, unknown>;
  }

  // The reported bug, at its narrowest. Before the fix this row saved with
  // place_id NULL and nothing anywhere said so -- the admin's next clue was
  // that the location never grew a photograph, because
  // mediaBackfill/placePhoto.ts:136 keys the Google Places photo fetch on
  // exactly this column and returns quietly when it is empty.
  it("stores the Place ID the Lookup button found, on create", async () => {
    const res = await post("/admin/foodbank/salisbury/location/new/", { name: "Wilton", ...TYPED, place_id: PLACE_ID });

    expect(res.status).toBe(302);
    expect(stored(rowFor("Wilton").id).place_id).toBe(PLACE_ID);
  });

  // The read half on its own, so that a break in it is reported as "the form
  // was never given the value" rather than only as a mysterious blanking.
  it("hands the stored Place ID back to the edit form", async () => {
    const row = await seedWithPlaceId("Downton", PLACE_ID);

    expect((await openEditForm(row.slug)).place_id).toBe(PLACE_ID);
  });

  // THE TEST THIS CHANGE IS NOT SAFE WITHOUT. Nothing here mentions a Place
  // ID: the admin renames a location, and every other field goes back exactly
  // as the form served it. Adding `place_id = ?` to the UPDATE means that POST
  // now rewrites the column, so if the value had NOT come back in the body
  // this ordinary edit would erase it -- turning a missing write into a
  // deletion, on 1,938 rows nothing else could restore.
  it("preserves an existing Place ID through an edit that only changes the name", async () => {
    const row = await seedWithPlaceId("Downton", PLACE_ID);
    const data = await openEditForm(row.slug);

    const res = await post(
      `/admin/foodbank/salisbury/location/${row.slug}/edit/`,
      browserWouldSubmit(data, { name: "Downton Memorial Hall" }),
    );

    expect(res.status).toBe(302);
    expect(stored(row.id).name).toBe("Downton Memorial Hall");
    expect(stored(row.id).place_id).toBe(PLACE_ID);
  });

  // The other direction, and the mutant killer for the UPDATE: drop
  // `place_id = ?` from the SET list and the column simply keeps its old
  // value, which the preserve test above would happily accept. This one is
  // what fails.
  it("stores a re-looked-up Place ID over the old one", async () => {
    const row = await seedWithPlaceId("Downton", PLACE_ID);
    const data = await openEditForm(row.slug);

    const res = await post(
      `/admin/foodbank/salisbury/location/${row.slug}/edit/`,
      browserWouldSubmit(data, { place_id: RELOOKED_UP_PLACE_ID }),
    );

    expect(res.status).toBe(302);
    expect(stored(row.id).place_id).toBe(RELOOKED_UP_PLACE_ID);
  });

  // THE EMPTY-FIELD DECISION, recorded where it can fail. NULL, never "": it
  // is what parseAdminFields already does to every other text field on this
  // form, it is what Django's own form did for this field (CharField(null=True)
  // is given empty_value=None, unlike the TextFields beside it -- run against
  // Django 5.2.6), and it is what the 1,973 production rows hold (1,938
  // populated, 35 NULL, 0 empty). The second assertion is why it matters
  // rather than merely being tidy: placePhotos.ts:44-48 collects a food bank's
  // place ids with `place_id IS NOT NULL`, so an empty string would pass that
  // filter and be handed to Google as a place id.
  it("stores NULL, not an empty string, when the Place ID is cleared", async () => {
    const row = await seedWithPlaceId("Downton", PLACE_ID);
    const data = await openEditForm(row.slug);

    const res = await post(`/admin/foodbank/salisbury/location/${row.slug}/edit/`, browserWouldSubmit(data, { place_id: "" }));

    expect(res.status).toBe(302);
    expect(stored(row.id).place_id).toBeNull();
    expect(db.prepare("SELECT id FROM foodbanklocation WHERE place_id IS NOT NULL").all()).toHaveLength(0);
  });

  // Same decision, reached through parseAdminFields' trim rather than an empty
  // box -- a pasted Place ID that was only whitespace must not become a stored
  // space, which would be neither a place id nor absent.
  it("treats a whitespace-only Place ID as cleared", async () => {
    const row = await seedWithPlaceId("Downton", PLACE_ID);
    const data = await openEditForm(row.slug);

    const res = await post(`/admin/foodbank/salisbury/location/${row.slug}/edit/`, browserWouldSubmit(data, { place_id: "   " }));

    expect(res.status).toBe(302);
    expect(stored(row.id).place_id).toBeNull();
  });

  // THE ONE SHAPE IN WHICH `place_id = ?` CAN STILL DESTROY A PLACE ID, pinned
  // here because it is a hazard rather than a bug and the difference should be
  // written down. parseAdminFields loops over the SPEC LIST, not over the POST
  // body (adminFormFields.ts:286), so a field the body omits entirely reads as
  // undefined, trims to "" and arrives as null -- identical to an emptied box,
  // and there is no third state in which "leave this column alone" could be
  // expressed. Every other nullable field on this form behaves the same way; a
  // POST missing `address` blanks the address. So this is consistency, not an
  // oversight, and special-casing this one column would be the surprise.
  //
  // It is unreachable from today's admin: generic_form.njk hands the whole of
  // FOODBANK_LOCATION_FIELDS to formfields.njk, which renders an input for
  // every spec, so a browser always posts all ten names. The two routes that
  // reach upsertLocation are this handler and the area form, and the area form
  // is registered create-only (routes/admin/index.ts:154-155), so its
  // `placeId: null` only ever reaches the INSERT.
  //
  // What this test is for is the day someone slices this form the way
  // FOODBANK_PARTIAL_FORMS (adminFormFields.ts:225-231) slices the food bank
  // one. Note that the food bank's own "address" partial already carries
  // `place_id` in its field list for exactly this reason. A location partial
  // that dropped it would silently blank the column on 1,938 rows, and this is
  // the test that says so out loud instead of leaving it to be discovered.
  it("clears the Place ID when the POST omits the field entirely -- the hazard a partial form would hit", async () => {
    const row = await seedWithPlaceId("Downton", PLACE_ID);
    const data = await openEditForm(row.slug);
    const body = browserWouldSubmit(data);
    expect(body.place_id).toBe(PLACE_ID); // the full form really does post it back
    delete body.place_id;

    const res = await post(`/admin/foodbank/salisbury/location/${row.slug}/edit/`, body);

    expect(res.status).toBe(302);
    expect(stored(row.id).place_id).toBeNull();
  });

  // A create with the box left alone, against the real column: the INSERT's
  // null path is the one every seed in this file already takes, pinned here so
  // that "empty means NULL" is asserted on both statements, not just the
  // UPDATE.
  it("stores NULL on a create with no Place ID", async () => {
    const res = await post("/admin/foodbank/salisbury/location/new/", { name: "Wilton", ...TYPED });

    expect(res.status).toBe(302);
    expect(stored(rowFor("Wilton").id).place_id).toBeNull();
  });
});
