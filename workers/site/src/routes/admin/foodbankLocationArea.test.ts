import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../types";

// The area form is the second caller of upsertLocation and hits the same
// UNIQUE(foodbank_id, name) index -- loc_fb_name_uniq -- as the postcode form
// in foodbankLocation.ts. Realistic trigger: a food bank already has a
// location called "Amesbury" from the ordinary form, and an admin opens this
// one to replace it with the MapIt boundary version, typing the same name.
//
// HONEST PARITY NOTE, asserted nowhere but worth stating where the tests
// live: Django 500s here too. FoodbankLocationAreaForm (givefood/forms.py:
// 167-170) is a plain forms.Form, not a ModelForm, so validate_unique() never
// ran and views.py:1717-1723's save() raised IntegrityError. This handler is
// therefore an IMPROVEMENT on Django rather than a restoration of it, unlike
// its sibling. The message is still Django's own unique_together wording,
// because one constraint should not speak with two voices depending on which
// form the admin happened to open.
//
// As in foodbankLocation.test.ts, the db layer is only partly mocked:
// locationNameTaken / locationSlugTaken / locationSlug run their real SQL
// against real in-memory SQLite, so the `id IS NOT ?` / `id != ?` difference
// is exercised by the engine rather than asserted about in JavaScript.

const mocks = vi.hoisted(() => ({
  render: vi.fn(async () => "<html>area form</html>"),
  getFoodbankBySlug: vi.fn(),
  // Typed to take arguments so `mock.calls[0][2]` -- the existingId, always
  // undefined on this create-only route -- is inspectable rather than a
  // zero-length tuple.
  upsertLocation: vi.fn(async (..._args: unknown[]) => "written-slug"),
}));

vi.mock("@givefood/templates", () => ({ render: mocks.render }));
vi.mock("./pageContext", () => ({ adminPageContext: async () => ({ csrf_token: "test-token" }) }));
vi.mock("../../lib/csrf", () => ({ verifyCsrf: async () => true, issueCsrfToken: async () => "test-token" }));
vi.mock("@givefood/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@givefood/db")>();
  return { ...actual, getFoodbankBySlug: mocks.getFoodbankBySlug, upsertLocation: mocks.upsertLocation };
});

const { upsertLocation: realUpsertLocation } = await vi.importActual<typeof import("@givefood/db")>("@givefood/db");
const { adminFoodbankLocationAreaForm } = await import("./foodbankLocationArea");

// See locationsAdmin.test.ts for why these columns and both indexes.
const SCHEMA = `
CREATE TABLE foodbanklocation (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT, postcode TEXT,
  country TEXT NOT NULL, lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  is_closed INTEGER NOT NULL, is_donation_point INTEGER, is_mobile INTEGER,
  boundary_geojson TEXT,
  phone_number TEXT, email TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX loc_fb_name_uniq   ON foodbanklocation(foodbank_id, name);
CREATE INDEX loc_foodbank_slug_idx     ON foodbanklocation(foodbank_id, slug);
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

const AMESBURY_MAPIT_ID = "2248";

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let env: AppEnv["Bindings"];
let app: Hono<AppEnv>;
let fetchMock: ReturnType<typeof vi.fn>;

function seedParams(name: string, latLng = "51.1725,-1.7820") {
  return {
    foodbankId: SALISBURY.id,
    foodbank: SALISBURY,
    name,
    address: null,
    postcode: null,
    isDonationPoint: 0,
    isMobile: 0,
    latLng,
    boundaryGeojson: null,
    placeId: null,
    phoneNumber: null,
    email: null,
  };
}

// The two MapIt round trips the handler makes on the happy path: /geometry
// for the centroid, then /<id>.geojson for the boundary.
function mapItOk() {
  return vi.fn(async (url: string) =>
    url.includes(".geojson")
      ? new Response(JSON.stringify({ type: "Polygon", coordinates: [] }), { headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ centre_lat: 51.1725, centre_lon: -1.782 }), { headers: { "content-type": "application/json" } }),
  );
}

function post(fields: Record<string, string>) {
  return app.request(
    "/admin/foodbank/salisbury/location/new/area/",
    { method: "POST", body: new URLSearchParams({ csrf_token: "test-token", ...fields }) },
    env,
    execCtx,
  );
}

function lastRenderContext(): Record<string, unknown> {
  const call = mocks.render.mock.calls.at(-1);
  if (!call) throw new Error("render() was never called");
  return (call as unknown as [string, Record<string, unknown>])[1];
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.render.mockResolvedValue("<html>area form</html>");
  mocks.upsertLocation.mockResolvedValue("written-slug");
  mocks.getFoodbankBySlug.mockResolvedValue(SALISBURY);

  fetchMock = mapItOk();
  vi.stubGlobal("fetch", fetchMock);

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const session = d1Session(db);
  env = { DB: { withSession: () => session }, CSRF_SECRET: "s", MAPIT_KEY: "k" } as unknown as AppEnv["Bindings"];

  await realUpsertLocation(session as never, seedParams("Amesbury"), undefined);

  app = new Hono<AppEnv>();
  app.all("/admin/foodbank/:slug/location/new/area/", adminFoodbankLocationAreaForm);
});

describe("create", () => {
  // The refusal, and the two things that make it a fix rather than a
  // different failure: nothing was written, and both typed fields came back.
  // The status stays 200 because that is what every other error on this form
  // already returns (the six hand-ported MapIt failures above it) -- changing
  // it here would leave one form answering two ways.
  it("refuses a duplicate name and re-renders the form with both fields", async () => {
    const res = await post({ name: "Amesbury", mapit_id: AMESBURY_MAPIT_ID });

    expect(res.status).toBe(200);
    expect(mocks.upsertLocation).not.toHaveBeenCalled();

    const context = lastRenderContext();
    expect(context.error).toBe('Foodbank location with this Foodbank and Name already exists: "Amesbury"');
    expect(context.name).toBe("Amesbury");
    expect(context.mapit_id).toBe(AMESBURY_MAPIT_ID);
  });

  // The check sits BEFORE fetchMapItArea deliberately: those are two
  // sequential fetches with a 20s timeout each, and burning up to 40s to
  // arrive at a refusal derivable from one indexed SELECT is most of what
  // made the old 500 expensive. If someone later moves the check below the
  // fetch "for symmetry", this is what says no.
  it("does not spend the MapIt round trips on a name it is going to refuse", async () => {
    await post({ name: "Amesbury", mapit_id: AMESBURY_MAPIT_ID });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves a name free on this food bank", async () => {
    const res = await post({ name: "Durrington", mapit_id: "2249" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/foodbank/salisbury/");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.upsertLocation).toHaveBeenCalledTimes(1);
    // This route is registered create-only, so existingId is always undefined
    // -- which is exactly the NULL-binding path the `id IS NOT ?` spelling in
    // locationNameTaken exists for. With `id != ?` the check above finds
    // nothing and the duplicate test in this file goes green-on-a-302.
    expect(mocks.upsertLocation.mock.calls[0]?.[2]).toBeUndefined();
  });

  // Separate constraint: "St Marys Hall" is free under loc_fb_name_uniq but
  // its derived slug is not. loc_foodbank_slug_idx is not unique, so this
  // would have saved and then been shadowed by getFoodbankLocationBySlugs'
  // `.first()` -- a silent loss rather than a 500.
  it("refuses a name whose derived slug is already taken", async () => {
    const session = d1Session(db);
    await realUpsertLocation(session as never, seedParams("St Mary's Hall", "51.0700,-1.8000"), undefined);

    const res = await post({ name: "St Marys Hall", mapit_id: "2250" });

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
    expect(lastRenderContext().error).toContain('already uses the URL "st-marys-hall"');
    expect(lastRenderContext().name).toBe("St Marys Hall");
  });

  // The race the pre-flight cannot close, and the one this form is most
  // exposed to: the write happens after up to 40s of MapIt fetching, so a
  // browser retry or a second click lands its INSERT long after
  // locationNameTaken's SELECT -- which lib/session.ts may have answered from
  // a lagging replica anyway ("first-unconstrained", read replication on).
  // Before the backstop the real UNIQUE violation reached app.onError and
  // rendered the 500 page over both typed fields.
  it("catches a constraint violation the pre-flight missed instead of 500ing", async () => {
    mocks.upsertLocation.mockRejectedValueOnce(
      new Error("D1_ERROR: UNIQUE constraint failed: foodbanklocation.foodbank_id, foodbanklocation.name"),
    );

    const res = await post({ name: "Durrington", mapit_id: "2249" });

    expect(res.status).toBe(200);
    const context = lastRenderContext();
    expect(context.error).toContain("nothing was saved");
    expect(String(context.error)).not.toContain("UNIQUE constraint");
    // Both fields back, and no redirect pretending the save happened.
    expect(context.name).toBe("Durrington");
    expect(context.mapit_id).toBe("2249");
  });

  // The new checks are appended to an else-if chain of six hand-ported error
  // paths, so they must not displace what was already there. A missing name
  // still reports "Name is required", not a uniqueness verdict on "".
  it("still reports a missing name before anything else", async () => {
    await post({ name: "", mapit_id: AMESBURY_MAPIT_ID });

    expect(lastRenderContext().error).toBe("Name is required");
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
  });

  // Ordering, pinned: mapit_id is validated BEFORE the name is checked for
  // uniqueness, so a submission that is wrong in both ways reports the field
  // the admin can see is empty rather than a clash on a name they have not
  // finished entering.
  it("reports a bad MapIt id before a duplicate name", async () => {
    await post({ name: "Amesbury", mapit_id: "" });

    expect(lastRenderContext().error).toBe("MapIt Area ID is required and must be a whole number");
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
  });
});
