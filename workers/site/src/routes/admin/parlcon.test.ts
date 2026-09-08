import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConstituencyBySlug, upsertParliamentaryConstituency } from "@givefood/db";
import { adminParlconForm } from "./parlcon";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { PARLCON_FIELDS } from "../../lib/adminFormFields";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// /admin/parlcon/new/ and /admin/parlcon/<slug>/edit/ -- gfadmin/views.py:
// 2555-2576's `parlcon_form`, both URL patterns pointing at one handler.
//
// WHY THIS ROUTE IS WORTH A FILE OF ITS OWN. It is the ONLY write path onto
// `parliamentaryconstituency` in the whole admin: no delete, no partial form,
// no bulk editor. 650 rows, each one the thing /needs/in/<constituency>/, the
// MP-photo redirect and every "write to your MP" page hang off. And it is
// exactly the shape both of the bugs found in this tier had:
//
//   * #12 (duplicate name -> SQLITE_CONSTRAINT -> the 500 page eats the form)
//     -- except here there IS no unique index to raise, so the same mistake
//     produces a silently shadowed row instead of a stack trace. Pinned in
//     "the collisions nothing here refuses" below, and reported rather than
//     fixed;
//   * #34 (a field parsed, threaded through the handler, and then written by
//     no SQL at all, redirecting as though it had worked). The only defence
//     against that is reading the row back out of storage, so every save test
//     here queries SQLite afterwards and the round-trip block walks all eight
//     of PARLCON_FIELDS one at a time. A redirect proves nothing.
//
// REAL DATABASE, REAL ROUTER, REAL EVERYTHING ON THE WRITE PATH.
// upsertParliamentaryConstituency, getConstituencyBySlug, parseAdminFields,
// verifyCsrf, dbSession and requireAdminAuth are all the shipped code, running
// against an in-memory SQLite built from the real DDL and mounted behind a
// real Hono app at the production paths (routes/admin/index.ts:169-172). Only
// two things are replaced, and neither is on the write path:
//
//   * `render`, because packages/templates/src/generated/ is a gitignored
//     build artefact -- importing the real one makes this suite depend on a
//     precompile step for reasons that have nothing to do with constituencies
//     (same call, and same reasoning, as foodbankLocation.test.ts). Asserting
//     on the CONTEXT handed to the template is also the more direct claim:
//     "the form came back with the admin's values in it" is a statement about
//     `data`, not about markup;
//   * `adminPageContext`, which is a per-page furniture builder (nav section,
//     Google keys, D1 name) shared by every admin route and tested nowhere
//     near this one.
//
// The KV that backs the admin session is a Map rather than a mock, so
// requireAdminAuth and getAdminSession run for real -- the auth block below
// is then a statement about the shipped middleware, not about a stub.

const mocks = vi.hoisted(() => ({
  render: vi.fn(async (_template: string, _context: Record<string, unknown>) => "<html>form</html>"),
}));

vi.mock("@givefood/templates", () => ({ render: mocks.render }));
vi.mock("./pageContext", () => ({
  adminPageContext: async (_c: unknown, section: string) => ({ section, csrf_token: "issued-elsewhere" }),
}));

// ===========================================================================
// HARNESS
// ===========================================================================

// migrations/0001_core.sql:129-137 as extended by
// 0011_constituency_pcon24cd.sql:12-13, transcribed rather than loaded off
// disk because workers/site suites build their own fixture schema (see
// donationPoint.test.ts and foodbankLocation.test.ts, which do the same for
// their tables; packages/db has schema.testkit.ts for the other direction).
//
// EVERY column is here, including the five the handler never writes --
// `mp_display_name`, `latitude`, `longitude`, `pcon24cd`, and `id`. That is
// deliberate: the tests that matter most in the edit block are the ones
// asserting those columns still hold what they held before, and a fixture
// that omitted them could not fail. `parlcon_slug_idx` is NOT unique, in the
// migration and in Django's own Meta.indexes -- which is the whole reason the
// duplicate-name block below reads the way it does.
const SCHEMA = `
CREATE TABLE parliamentaryconstituency (
  id INTEGER PRIMARY KEY,
  name TEXT, slug TEXT NOT NULL, country TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER NOT NULL, mp_display_name TEXT, email TEXT,
  centroid TEXT NOT NULL,
  latitude REAL, longitude REAL,
  boundary_geojson TEXT,
  pcon24cd TEXT
);
CREATE INDEX parlcon_slug_idx ON parliamentaryconstituency(slug);
CREATE UNIQUE INDEX parlcon_pcon24cd_uniq ON parliamentaryconstituency(pcon24cd) WHERE pcon24cd IS NOT NULL;
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The D1DatabaseSession surface packages/db actually uses, over node:sqlite.
// D1 is async and node:sqlite is synchronous; the SQL text, the parameter
// binding, the type affinities and the NULL semantics are SQLite's in both,
// which is everything these tests turn on. Cast rather than implemented in
// full -- stubbing batch/raw/exec would only add ways to be wrong.
//
// EVERY METHOD YIELDS TO THE MACROTASK QUEUE FIRST, which is the one place
// this fake deliberately imitates D1's asynchrony rather than SQLite's
// synchrony. A real D1 statement is a network round trip: a write the
// handler forgets to `await` returns its redirect with the save still in
// flight, and the Worker can be torn down before it lands. Against a
// synchronous fake that bug is INVISIBLE -- `void upsertParliamentary
// Constituency(...)`, a single dropped keyword, passed all 80 tests here
// because the row was already written by the time the promise was dropped.
// With the gap, the 302 arrives before the write does, and the row-count
// assertions catch it.
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
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "b".repeat(64);
const SESSION_ID = "test-admin-session-id";

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let sessionKv: Map<string, string>;
let app: Hono<AppEnv>;
let env: AppEnv["Bindings"];

// A full, valid submission. Every value is distinctive so that "it came back"
// and "it was stored" are claims about THESE values rather than about
// boilerplate that would appear on an empty form. The GeoJSON is deliberately
// a multi-line blob: re-pasting a constituency boundary is the loss that made
// issue #12 expensive, and this form has one too.
const TYPED = {
  name: "Salisbury",
  country: "England",
  mp: "John Glen",
  mp_party: "Conservative",
  mp_parl_id: "4051",
  email: "john.glen.mp@parliament.uk",
  centroid: "51.0688,-1.7945",
  boundary_geojson: '{"type":"Polygon","coordinates":[[[-1.9,51.0],[-1.7,51.0],[-1.7,51.2],[-1.9,51.0]]]}',
};

interface ParlconRow {
  id: number;
  name: string | null;
  slug: string;
  country: string | null;
  mp: string | null;
  mp_party: string | null;
  mp_parl_id: number;
  mp_display_name: string | null;
  email: string | null;
  centroid: string;
  latitude: number | null;
  longitude: number | null;
  boundary_geojson: string | null;
  pcon24cd: string | null;
}

function rows(): ParlconRow[] {
  return db.prepare("SELECT * FROM parliamentaryconstituency ORDER BY id").all() as unknown as ParlconRow[];
}

function rowById(id: number): ParlconRow {
  const row = db.prepare("SELECT * FROM parliamentaryconstituency WHERE id = ?").get(id) as ParlconRow | undefined;
  if (!row) throw new Error(`no constituency with id ${id}`);
  return row;
}

// Seeded with a RAW INSERT, not through upsertParliamentaryConstituency,
// because four of these columns (mp_display_name, latitude, longitude,
// pcon24cd) are ones the writer deliberately never names -- the fixture could
// not otherwise contain them, and "the edit left them alone" is one of the
// claims this file exists to make.
function seed(overrides: Partial<ParlconRow> = {}): ParlconRow {
  const row = {
    name: "Salisbury",
    slug: "salisbury",
    country: "England",
    mp: "John Glen",
    mp_party: "Conservative",
    mp_parl_id: 4051,
    mp_display_name: "Rt Hon John Glen MP",
    email: "john.glen.mp@parliament.uk",
    centroid: "51.0688,-1.7945",
    latitude: 51.0688,
    longitude: -1.7945,
    boundary_geojson: '{"type":"Polygon","coordinates":[[[-1.9,51.0]]]}',
    pcon24cd: "E14001434",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO parliamentaryconstituency
       (name, slug, country, mp, mp_party, mp_parl_id, mp_display_name, email, centroid, latitude, longitude, boundary_geojson, pcon24cd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.name,
    row.slug,
    row.country,
    row.mp,
    row.mp_party,
    row.mp_parl_id,
    row.mp_display_name,
    row.email,
    row.centroid,
    row.latitude,
    row.longitude,
    row.boundary_geojson,
    row.pcon24cd,
  );
  const inserted = db.prepare("SELECT * FROM parliamentaryconstituency WHERE slug = ? ORDER BY id DESC").get(row.slug) as
    | ParlconRow
    | undefined;
  if (!inserted) throw new Error(`seed failed for ${row.slug}`);
  return inserted;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.render.mockResolvedValue("<html>form</html>");

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);

  // lib/adminAuth.ts's sessionKvKey() is `admin-session:<id>`, and
  // getAdminSession only re-puts once a session is past half its 12h life --
  // so an expiry a full TTL away keeps this read-only and the Map honest.
  sessionKv = new Map<string, string>();
  sessionKv.set(
    `admin-session:${SESSION_ID}`,
    JSON.stringify({
      email: "someone@givefood.org.uk",
      name: "Some One",
      givenName: "Some",
      picture: "",
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    }),
  );

  env = {
    DB: { withSession: () => d1Session(db) },
    SESSIONS: {
      get: async (key: string) => sessionKv.get(key) ?? null,
      put: async (key: string, value: string) => void sessionKv.set(key, value),
    },
    CSRF_SECRET,
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
  } as unknown as AppEnv["Bindings"];

  // The production registrations, verbatim (routes/admin/index.ts:169-172):
  // create and edit are the SAME handler distinguished only by whether :slug
  // matched, so a hand-built Context would let a change in how that
  // distinction is drawn slip through unnoticed.
  app = new Hono<AppEnv>();
  app.use("/admin/*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    await next();
  });
  app.use("/admin/*", requireAdminAuth);
  app.get("/admin/parlcon/new/", adminParlconForm);
  app.post("/admin/parlcon/new/", adminParlconForm);
  app.get("/admin/parlcon/:slug/edit/", adminParlconForm);
  app.post("/admin/parlcon/:slug/edit/", adminParlconForm);
  // Named rather than left to become an unhandled rejection, so a regression
  // reads as "expected 400, got 500: <message>" instead of a vitest crash.
  // This is also the page issue #12 was about: reaching it at all is a failure.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  // The site's shared 404, standing in for index.ts:650 (which renders
  // 404.njk through it). Registered with a recognisable body so the
  // missing-row tests can assert the handler DELEGATES to it rather than
  // inventing its own 404 -- kills the mutant `return c.text("gone", 404)`,
  // which no status-only assertion can see, and which would replace the
  // site's 404 page with a bare string for every mistyped constituency URL.
  // Django's get_object_or_404 raises Http404 for the project's own handler
  // in exactly the same way.
  app.notFound((c) => c.text("site 404 page", 404));
});

interface RequestOptions {
  authenticated?: boolean;
  csrfCookie?: boolean;
  // The cookie's value verbatim, for the one case that needs a token the
  // server never minted -- see "a cookie the server never signed" below.
  csrfCookieValue?: string;
  csrfField?: string | null;
  // `null` on either of these means "send no such header at all".
  // verifyCsrf applies Sec-Fetch-Site and Origin as two INDEPENDENT guards,
  // each skipped when its header is absent (older browsers send neither), so
  // holding one back is the only way to prove the other is doing any work.
  origin?: string | null;
  secFetchSite?: string | null;
}

async function cookieHeader(options: RequestOptions): Promise<string> {
  const parts: string[] = [];
  if (options.authenticated !== false) parts.push(`__Host-gfsession=${SESSION_ID}`);
  if (options.csrfCookie !== false) parts.push(`__Host-csrf=${options.csrfCookieValue ?? (await signedCsrfCookie())}`);
  return parts.join("; ");
}

async function signedCsrfCookie(): Promise<string> {
  return `${CSRF_RAW}.${await hmacSha256Hex(CSRF_SECRET, CSRF_RAW)}`;
}

async function get(path: string, options: RequestOptions = {}): Promise<Response> {
  const cookie = await cookieHeader(options);
  return app.fetch(new Request(`${ORIGIN}${path}`, { headers: cookie ? { Cookie: cookie } : {} }), env, execCtx);
}

async function post(path: string, fields: Record<string, string>, options: RequestOptions = {}): Promise<Response> {
  const cookie = await cookieHeader(options);
  const body: Record<string, string> = { ...fields };
  const token = options.csrfField === undefined ? CSRF_RAW : options.csrfField;
  if (token !== null) body.csrf_token = token;
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const secFetchSite = options.secFetchSite === undefined ? "same-origin" : options.secFetchSite;
  if (secFetchSite !== null) headers["Sec-Fetch-Site"] = secFetchSite;
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  return app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: new URLSearchParams(body).toString() }), env, execCtx);
}

// The context the handler handed the template on its most recent render --
// which is the form the admin is looking at.
function lastRender(): { template: string; context: Record<string, unknown> } {
  const call = mocks.render.mock.calls.at(-1);
  if (!call) throw new Error("render() was never called");
  return { template: call[0], context: call[1] };
}

function formData(): Record<string, unknown> {
  return lastRender().context.data as Record<string, unknown>;
}

// ===========================================================================
// GET -- the two ways the form is opened
// ===========================================================================

describe("GET /admin/parlcon/new/", () => {
  it("renders the shared generic form at 200 with no error banner", async () => {
    const res = await get("/admin/parlcon/new/");

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/generic_form.njk");
    expect(lastRender().context.error).toBeNull();
    // views.py:2562's page_title, which Django spells "New Parlimentary
    // Constituency". The typo is not carried over; the rest is Django's.
    expect(lastRender().context.title).toBe("New Parliamentary Constituency");
  });

  // THE RESPONSE IS THE RENDERED PAGE, SERVED AS HTML. Every other assertion
  // in this file reads the context handed to the template, which is blind to
  // what the handler does with the string that comes back: `c.text(html, ...)`
  // (the browser shows the markup as source) and `c.html("", ...)` (a blank
  // page -- form, values and all, gone) each left all 72 of the tests that
  // preceded this one passing. Both are one-word edits to line 37.
  it("returns the rendered page itself, as text/html", async () => {
    const res = await get("/admin/parlcon/new/");

    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toBe("<html>form</html>");
  });

  // `section` is the admin nav's active-item key: admin/page.njk:43-50 puts
  // `is-active` on whichever link matches it, and "settings" is the group
  // this form lives under (shared with 18 other admin pages). Nothing else
  // in the context would change if this handler were copy-pasted from a food
  // bank route with its "foodbanks" left in place, so nothing else can catch
  // it -- the mutant `adminPageContext(c, "foodbanks")` survived until here.
  it("marks the page as belonging to the Settings nav section", async () => {
    await get("/admin/parlcon/new/");

    expect(lastRender().context.section).toBe("settings");
  });

  // #34 IN ITS PUREST FORM IS A MISSING FIELD, and the field list is the first
  // place one can go missing: generic_form.njk hands `fields` straight to
  // formfields.njk, so a spec dropped from this array is a column the admin
  // can never fill and -- because parseAdminFields loops over the SPEC LIST,
  // not the body -- a column every subsequent save NULLs out. Identity, not
  // length: a re-ordered or re-sliced copy would pass a count.
  it("hands the template PARLCON_FIELDS itself, not a copy or a subset", () => {
    expect(PARLCON_FIELDS.map((f) => f.name)).toEqual([
      "name",
      "country",
      "mp",
      "mp_party",
      "mp_parl_id",
      "email",
      "centroid",
      "boundary_geojson",
    ]);
  });

  it("passes that same array through to the template", async () => {
    await get("/admin/parlcon/new/");

    expect(lastRender().context.fields).toBe(PARLCON_FIELDS);
  });

  it("opens with an empty form", async () => {
    await get("/admin/parlcon/new/");

    expect(formData()).toEqual({});
  });

  // DELIBERATE DIVERGENCE FROM ITS SIBLING, pinned so nobody "fixes" one to
  // match the other by accident. foodbankLocation.ts reads `?name=` and
  // prefills it (the food bank check page's Add button depends on that); this
  // handler renders `existing ?? {}` and reads no query string at all, so a
  // link that tried the same trick here would open a blank form. Django's
  // parlcon_form does not read request.GET either, so the port matches it.
  it("ignores a ?name= prefill, unlike the location form", async () => {
    await get("/admin/parlcon/new/?name=Salisbury&mp=John%20Glen");

    expect(formData()).toEqual({});
  });

  // GET IS A READ. Registered on the same function as the POST, one
  // `c.req.method === "POST"` away from the writer -- so a refactor that got
  // that test backwards would create a row on every page open.
  it("writes nothing", async () => {
    await get("/admin/parlcon/new/");

    expect(rows()).toHaveLength(0);
  });
});

describe("GET /admin/parlcon/:slug/edit/", () => {
  it("404s for a slug nothing holds, rather than opening a create form", async () => {
    const res = await get("/admin/parlcon/nowhere-at-all/edit/");

    expect(res.status).toBe(404);
    // Through the app's own notFound handler -- i.e. the site's 404 page, not
    // a bare string this route made up (see the registration in beforeEach).
    expect(await res.text()).toBe("site 404 page");
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("titles the page with the constituency's own name", async () => {
    seed();

    const res = await get("/admin/parlcon/salisbury/edit/");

    expect(res.status).toBe(200);
    // Django titles BOTH edits "Edit Parlimentary Constituency"
    // (views.py:2559); this port names the row instead. A deliberate change,
    // pinned because generic_form.njk slugifies the title into the form's
    // class name and admin.js selects on those -- so the title is not purely
    // cosmetic on every form this template serves.
    expect(lastRender().context.title).toBe("Edit Salisbury");
  });

  // THE READ HALF OF THE ROUND TRIP, asserted on its own so that a break in it
  // is reported as "the form was never given the value" rather than only as a
  // mysterious blanking on the next save. Every one of the eight editable
  // columns has to arrive, boundary_geojson included -- that one is the
  // expensive one to retype and, being a textarea, the easiest to drop from a
  // narrowed SELECT without anybody noticing.
  it("hands the edit form every stored value, including the boundary GeoJSON", async () => {
    const row = seed();

    await get("/admin/parlcon/salisbury/edit/");

    const data = formData();
    expect(data.name).toBe("Salisbury");
    expect(data.country).toBe("England");
    expect(data.mp).toBe("John Glen");
    expect(data.mp_party).toBe("Conservative");
    expect(data.mp_parl_id).toBe(4051);
    expect(data.email).toBe("john.glen.mp@parliament.uk");
    expect(data.centroid).toBe("51.0688,-1.7945");
    expect(data.boundary_geojson).toBe(row.boundary_geojson);
  });

  it("opens at 200 with no error banner and writes nothing", async () => {
    const before = seed();

    const res = await get("/admin/parlcon/salisbury/edit/?name=Overwritten&mp_parl_id=9999");

    expect(res.status).toBe(200);
    expect(lastRender().context.error).toBeNull();
    // The heading comes from the STORED row, never from the URL. Not a purely
    // cosmetic claim: generic_form.njk:35 slugifies the title into the form's
    // class name and admin.js selects on exactly those names, so a title a
    // link could steer is a control an attacker-supplied URL could steer.
    expect(lastRender().context.title).toBe("Edit Salisbury");
    // Query parameters shaped like a submission must not reach the writer:
    // the row is byte-identical to the one seeded.
    expect(rowById(before.id)).toEqual(before);
    expect(rows()).toHaveLength(1);
  });

  // A ROW WHOSE NAME IS NULL, which political.py:16 (`null=True,
  // blank=True`) allowed and this schema still permits -- so any row Django
  // wrote that way is here, and PARLCON_FIELDS' `required: true` only stops
  // NEW ones. The heading interpolates the column unguarded, so the page is
  // titled with the literal string "null", and generic_form.njk:35 slugifies
  // that into the form's class name. SUSPECT, pinned rather than fixed (see
  // the suspected-bugs note); the rest holds up -- the name box comes back
  // empty, so the admin cannot save the row without naming it.
  it("titles a nameless row 'Edit null' and hands back an empty name box", async () => {
    seed({ name: null, slug: "nameless" });

    const res = await get("/admin/parlcon/nameless/edit/");

    expect(res.status).toBe(200);
    expect(lastRender().context.title).toBe("Edit null");
    expect(formData().name).toBeNull();
  });

  // Django's admin/form.html has no delete control of any kind, and
  // parlcon_form passes only `form` and `page_title`, so generic_form.njk's
  // optional Delete button must stay unrendered here. There is deliberately no
  // /admin/parlcon/<slug>/delete/ route to point it at.
  it("offers no Delete button, matching Django's form.html", async () => {
    seed();

    await get("/admin/parlcon/salisbury/edit/");

    expect(lastRender().context.delete_url).toBeUndefined();
  });
});

// ===========================================================================
// CREATE -- and the row it is supposed to leave behind
// ===========================================================================

describe("POST /admin/parlcon/new/", () => {
  // views.py:2568 `redirect("admin:politics")`, whose URL is
  // gfadmin/urls/geography.py:20's `politics/` under givefood/urls.py:97's
  // `admin/` include -- so /admin/politics/, and Django's redirect() is a 302.
  it("redirects to the constituency list, as Django does", async () => {
    const res = await post("/admin/parlcon/new/", TYPED);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/politics/");
  });

  // ISSUE #34's LESSON, APPLIED: the redirect above is not evidence of
  // anything. This is. Every column the form can set, read back out of SQLite
  // after the request -- a bind list that drifted out of step with its column
  // list would put the MP's name in mp_party and raise nothing at all, because
  // SQLite only objects when the COUNTS differ.
  it("actually writes the row, every column of it", async () => {
    await post("/admin/parlcon/new/", TYPED);

    const stored = rows();
    expect(stored).toHaveLength(1);
    const row = stored[0]!;
    expect(row.name).toBe("Salisbury");
    expect(row.slug).toBe("salisbury");
    expect(row.country).toBe("England");
    expect(row.mp).toBe("John Glen");
    expect(row.mp_party).toBe("Conservative");
    expect(row.mp_parl_id).toBe(4051);
    expect(row.email).toBe("john.glen.mp@parliament.uk");
    expect(row.centroid).toBe("51.0688,-1.7945");
    expect(row.boundary_geojson).toBe(TYPED.boundary_geojson);
  });

  // The slug is never typed -- it is derived from the name and is what the
  // whole site addresses this row by. Accents matter because they are the
  // realistic case: "Ynys Môn" and "Montgomeryshire and Glyndŵr" are both live
  // constituencies, and parlconAdmin.ts's slugify NFKD-folds then strips
  // non-ASCII precisely for them.
  it("derives the slug from the name", async () => {
    await post("/admin/parlcon/new/", { ...TYPED, name: "Ynys Môn" });

    expect(rows()[0]!.slug).toBe("ynys-mon");
  });

  // Every optional field left blank must land as NULL, not "". The columns are
  // read back by `mp ? ... : ...`-shaped template logic all over the public
  // site, where an empty string is truthy and a blank MP name would render as
  // a blank MP name rather than as no MP at all.
  it("stores NULL, not an empty string, for the optional fields left blank", async () => {
    await post("/admin/parlcon/new/", {
      name: "Salisbury",
      country: "",
      mp: "",
      mp_party: "",
      mp_parl_id: "4051",
      email: "",
      centroid: "51.0688,-1.7945",
      boundary_geojson: "",
    });

    const row = rows()[0]!;
    expect(row.country).toBeNull();
    expect(row.mp).toBeNull();
    expect(row.mp_party).toBeNull();
    expect(row.email).toBeNull();
    expect(row.boundary_geojson).toBeNull();
  });

  it("trims what the admin typed before storing it", async () => {
    await post("/admin/parlcon/new/", { ...TYPED, name: "  Salisbury  ", mp: "  John Glen  ", centroid: " 51.0688,-1.7945 " });

    const row = rows()[0]!;
    expect(row.name).toBe("Salisbury");
    expect(row.mp).toBe("John Glen");
    expect(row.centroid).toBe("51.0688,-1.7945");
  });

  // DIVERGENCE FROM DJANGO, EXECUTED RATHER THAN ASSUMED.
  // political.py:156-164's save() sets `self.latitude`/`self.longitude` from
  // centroid on every save; this port does not, on the strength of
  // 0001_core.sql:134's comment that the columns are vestigial (646/650 NULL
  // in production) and that latt()/long() parse `centroid` directly. Pinned
  // here so the decision is visible: if anything ever starts reading those
  // columns, this test is where the divergence surfaces.
  it("does not derive latitude/longitude from the centroid, unlike Django's save()", async () => {
    await post("/admin/parlcon/new/", TYPED);

    expect(rows()[0]!.latitude).toBeNull();
    expect(rows()[0]!.longitude).toBeNull();
  });

  // The consequence of the above for the ONS code, which is a different
  // matter: pcon24cd is the key /write/'s map looks constituencies up by
  // (getConstituencySlugByPcon24cd, migration 0011). There is no form field
  // for it and the INSERT does not name it, so a constituency created here is
  // invisible to the map until something backfills the code. Recorded as the
  // known gap it is, not as a passing feature.
  it("leaves pcon24cd NULL on a create, so the /write/ map cannot find the new row", async () => {
    await post("/admin/parlcon/new/", TYPED);

    expect(rows()[0]!.pcon24cd).toBeNull();
  });

  it("leaves mp_display_name NULL -- it is editable=False and nothing here sets it", async () => {
    await post("/admin/parlcon/new/", TYPED);

    expect(rows()[0]!.mp_display_name).toBeNull();
  });

  // THE ROW IS CHOSEN BY THE PATH, NEVER BY THE QUERY STRING. `const slug =
  // c.req.param("slug")` is one `?? c.req.query("slug")` away from turning
  // every create into a silent edit of whatever row the link names -- the
  // shape of a "let the new-constituency link preselect one" change -- and
  // that mutant survived this entire file, because nothing else ever sends a
  // ?slug=. The GET half of the same claim is "ignores a ?name= prefill".
  it("creates a new row even when the URL carries a ?slug= naming an existing one", async () => {
    const before = seed();

    const res = await post("/admin/parlcon/new/?slug=salisbury", { ...TYPED, name: "Amesbury", mp: "Jane Doe" });

    expect(res.status).toBe(302);
    expect(rows()).toHaveLength(2);
    expect(rowById(before.id)).toEqual(before);
    expect(rows()[1]!.slug).toBe("amesbury");
  });
});

// ===========================================================================
// EDIT -- an UPDATE, in place, of exactly one row
// ===========================================================================

describe("POST /admin/parlcon/:slug/edit/", () => {
  it("404s for a slug nothing holds and writes nothing", async () => {
    seed();

    const res = await post("/admin/parlcon/nowhere-at-all/edit/", TYPED);

    expect(res.status).toBe(404);
    expect(rows()).toHaveLength(1);
  });

  // UPDATE, not INSERT: the row count is the assertion that separates an edit
  // from a create that happened to be pointed at an existing slug. The
  // handler's whole edit/create distinction is `existing?.id`, one optional
  // chain away from always being undefined.
  it("updates the row in place rather than inserting a second one", async () => {
    const before = seed();

    const res = await post("/admin/parlcon/salisbury/edit/", { ...TYPED, mp: "Jane Doe" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/politics/");
    expect(rows()).toHaveLength(1);
    expect(rowById(before.id).mp).toBe("Jane Doe");
  });

  // The nine columns the UPDATE names, all moved at once. Nine separate
  // assertions rather than one object comparison so that a bind-list swap
  // (country/email is the pair that looks alike) names the columns it moved.
  it("rewrites all nine columns it names", async () => {
    const before = seed();

    await post("/admin/parlcon/salisbury/edit/", {
      name: "Salisbury and Wilton",
      country: "Wales",
      mp: "Jane Doe",
      mp_party: "Green",
      mp_parl_id: "9876",
      email: "jane.doe.mp@parliament.uk",
      centroid: "51.1000,-1.8000",
      boundary_geojson: '{"type":"Polygon","coordinates":[[[0,0]]]}',
    });

    const after = rowById(before.id);
    expect(after.name).toBe("Salisbury and Wilton");
    expect(after.slug).toBe("salisbury-and-wilton");
    expect(after.country).toBe("Wales");
    expect(after.mp).toBe("Jane Doe");
    expect(after.mp_party).toBe("Green");
    expect(after.mp_parl_id).toBe(9876);
    expect(after.email).toBe("jane.doe.mp@parliament.uk");
    expect(after.centroid).toBe("51.1000,-1.8000");
    expect(after.boundary_geojson).toBe('{"type":"Polygon","coordinates":[[[0,0]]]}');
  });

  // THE OTHER HALF OF THAT CLAIM, and the more dangerous one. The UPDATE names
  // nine columns and must name no more: `pcon24cd` breaks the /write/ map for
  // that constituency if it is wiped, `mp_display_name` is what the MP's name
  // renders as, and neither has any other writer in the codebase to restore
  // it. Nothing raises if they go -- exactly the silence #34 hid in.
  it("leaves the four columns it does not name exactly as they were", async () => {
    const before = seed();

    await post("/admin/parlcon/salisbury/edit/", { ...TYPED, mp: "Jane Doe" });

    const after = rowById(before.id);
    expect(after.pcon24cd).toBe("E14001434");
    expect(after.mp_display_name).toBe("Rt Hon John Glen MP");
    expect(after.latitude).toBe(51.0688);
    expect(after.longitude).toBe(-1.7945);
  });

  // THE COLUMNS THE FORM DOES NOT DECLARE CANNOT BE STEERED FROM THE BODY.
  // parseAdminFields loops over PARLCON_FIELDS, never over what arrived, so a
  // field nobody declared is dropped on the floor -- Django's editable=False
  // guarantee (slug, mp_display_name, latitude, longitude) reproduced by
  // construction rather than by a deny-list. Worth stating because `slug` is
  // the one an admin would plausibly be handed a box for one day ("let me fix
  // a bad slug"), and the two-line change that does it -- a slug threaded out
  // of the body and into upsertParliamentaryConstituency ahead of slugify --
  // passed every other test in this file, since nothing else ever submits a
  // slug for the derived one to have to beat.
  it("ignores editable=False columns submitted in the body", async () => {
    const before = seed();

    const res = await post("/admin/parlcon/salisbury/edit/", {
      ...TYPED,
      slug: "hijacked",
      pcon24cd: "E99999999",
      mp_display_name: "Not The MP",
      latitude: "0",
      longitude: "0",
      id: "999",
    });

    expect(res.status).toBe(302);
    // The whole row in one claim: boundary_geojson is the only column TYPED
    // moves off the seeded values, and `slug` still comes from `name`.
    expect(rowById(before.id)).toEqual({ ...before, boundary_geojson: TYPED.boundary_geojson });
    expect(rows()).toHaveLength(1);
  });

  // `WHERE id = ?` losing its predicate would rewrite all 650 rows, and with a
  // single-row fixture that is invisible. Two rows, one edited.
  it("touches only the row being edited", async () => {
    const salisbury = seed();
    const amesbury = seed({ name: "Amesbury", slug: "amesbury", mp_parl_id: 4052, pcon24cd: "E14001435" });

    await post("/admin/parlcon/salisbury/edit/", { ...TYPED, mp: "Jane Doe" });

    expect(rowById(salisbury.id).mp).toBe("Jane Doe");
    expect(rowById(amesbury.id)).toEqual(amesbury);
  });

  // A rename re-derives the slug, which is the URL the constituency is served
  // at. Pinned because nothing writes a slug redirect for the old one: the
  // page simply 404s from that moment, and the admin's only clue is the
  // redirect to /admin/politics/ that looks identical to any other save.
  it("re-derives the slug on a rename, leaving the old URL dead", async () => {
    const before = seed();

    await post("/admin/parlcon/salisbury/edit/", { ...TYPED, name: "Salisbury and Wilton" });

    expect(rowById(before.id).slug).toBe("salisbury-and-wilton");
    expect(await getConstituencyBySlug(d1Session(db), "salisbury")).toBeNull();
    expect((await getConstituencyBySlug(d1Session(db), "salisbury-and-wilton"))?.id).toBe(before.id);
  });
});

// ===========================================================================
// THE ROUND TRIP -- the test that would have caught #34 on day one
// ===========================================================================

// Rebuilds what a browser would actually submit from the rendered page: the
// SAME field list the template iterates (generic_form.njk hands `fields` to
// formfields.njk's `fieldset(fields, data)`) over the SAME `data` object the
// handler gave it. Deliberately NOT built from the database row -- a value
// only returns on a POST if a field exists for it AND the form was given it,
// and that pair of links is precisely what #34 broke.
function browserWouldSubmit(data: Record<string, unknown>, edits: Record<string, string> = {}): Record<string, string> {
  const body: Record<string, string> = {};
  for (const spec of PARLCON_FIELDS) {
    const value = data[spec.name];
    // nunjucks renders null/undefined into a value attribute as "" (env.ts
    // pins throwOnUndefined: false for exactly that), so a NULL column comes
    // back from the browser as an empty field.
    body[spec.name] = value === null || value === undefined ? "" : String(value);
  }
  return { ...body, ...edits };
}

async function openEditForm(slug: string): Promise<Record<string, unknown>> {
  const res = await get(`/admin/parlcon/${slug}/edit/`);
  expect(res.status).toBe(200);
  return formData();
}

describe("every field round-trips through the edit form", () => {
  // The whole form, saved back unchanged. This is the shape of the ordinary
  // admin action -- open a constituency, correct one thing, press Submit --
  // and it must be a no-op for everything else. A field that the form does not
  // render, or that the writer does not store, shows up here as a column that
  // silently emptied itself on an unrelated edit.
  it("saves the form back unchanged without altering a single column", async () => {
    const before = seed();

    const res = await post("/admin/parlcon/salisbury/edit/", browserWouldSubmit(await openEditForm("salisbury")));

    expect(res.status).toBe(302);
    expect(rowById(before.id)).toEqual(before);
  });

  // Then one field at a time, which is the version that names the culprit.
  // #34 was `place_id` parsed, passed to the writer and stored by no SQL: the
  // create-and-check tests above would still have passed for the seven fields
  // that did work, and only a per-field walk says WHICH one vanished.
  const EDITS: Record<string, { submitted: string; stored: unknown }> = {
    name: { submitted: "Salisbury and Wilton", stored: "Salisbury and Wilton" },
    country: { submitted: "Wales", stored: "Wales" },
    mp: { submitted: "Jane Doe", stored: "Jane Doe" },
    mp_party: { submitted: "Green", stored: "Green" },
    // A string on the way in, an INTEGER column on the way out.
    mp_parl_id: { submitted: "9876", stored: 9876 },
    email: { submitted: "jane.doe.mp@parliament.uk", stored: "jane.doe.mp@parliament.uk" },
    centroid: { submitted: "51.1000,-1.8000", stored: "51.1000,-1.8000" },
    boundary_geojson: { submitted: '{"type":"Polygon","coordinates":[[[1,1]]]}', stored: '{"type":"Polygon","coordinates":[[[1,1]]]}' },
  };

  for (const spec of PARLCON_FIELDS) {
    const edit = EDITS[spec.name]!;

    it(`stores a changed ${spec.name} and disturbs nothing else`, async () => {
      const before = seed();

      const res = await post(
        "/admin/parlcon/salisbury/edit/",
        browserWouldSubmit(await openEditForm("salisbury"), { [spec.name]: edit.submitted }),
      );

      expect(res.status).toBe(302);
      const after = rowById(before.id);
      expect(after[spec.name as keyof ParlconRow]).toEqual(edit.stored);

      // Everything else, column by column. `slug` is expected to follow `name`
      // and is the only derived column on this table.
      const expected: ParlconRow = { ...before, [spec.name]: edit.stored };
      if (spec.name === "name") expected.slug = "salisbury-and-wilton";
      expect(after).toEqual(expected);
    });

    // The other direction for every optional field: emptying a box must
    // actually empty the column. Without this, "the value came back" is
    // satisfied just as well by an UPDATE that never touches the column at all
    // -- which is the exact mutant (#34's UPDATE, minus one assignment) this
    // block exists to kill.
    if (!spec.required) {
      it(`clears ${spec.name} to NULL when the admin empties the box`, async () => {
        const before = seed();

        const res = await post("/admin/parlcon/salisbury/edit/", browserWouldSubmit(await openEditForm("salisbury"), { [spec.name]: "" }));

        expect(res.status).toBe(302);
        expect(rowById(before.id)[spec.name as keyof ParlconRow]).toBeNull();
      });
    }
  }
});

// ===========================================================================
// VALIDATION -- a refusal must not cost the admin their typing
// ===========================================================================

describe("a rejected save re-renders the form with the admin's values", () => {
  // Django's ModelForm re-rendered the BOUND form on failure (views.py:2565's
  // `if request.POST:` has no else, so an invalid form falls straight through
  // to the same render()), and this port copies that: a 400 carrying the
  // values, never a plain-text body and never the 500 page issue #12 was
  // about. Each case below therefore asserts three things -- the status, the
  // message, and that the expensive fields survived.
  const CASES: { label: string; body: Record<string, string>; error: string }[] = [
    { label: "a missing name", body: { ...TYPED, name: "" }, error: "Name is required" },
    { label: "a missing MP ID", body: { ...TYPED, mp_parl_id: "" }, error: "MP's ID is required" },
    { label: "a missing centroid", body: { ...TYPED, centroid: "" }, error: "Centroid (lat,lng) is required" },
    { label: "an email that is not one", body: { ...TYPED, email: "john.glen.mp" }, error: "Email is not a valid email address" },
    { label: "an MP ID that is not a number", body: { ...TYPED, mp_parl_id: "not-a-number" }, error: "MP's ID must be a whole number" },
  ];

  for (const testCase of CASES) {
    it(`refuses ${testCase.label} at 400 without redirecting`, async () => {
      const res = await post("/admin/parlcon/new/", testCase.body);

      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
      expect(lastRender().context.error).toBe(testCase.error);
      expect(rows()).toHaveLength(0);
    });

    it(`gives back what the admin typed after ${testCase.label}`, async () => {
      await post("/admin/parlcon/new/", testCase.body);

      const data = formData();
      // The boundary polygon is the field this is really about: it can run to
      // a megabyte and a half, and retyping it is not a thing a human does.
      expect(data.boundary_geojson).toBe(TYPED.boundary_geojson);
      expect(data.mp).toBe(TYPED.mp);
      expect(data.mp_party).toBe(TYPED.mp_party);
      // ...including the field that was rejected, so the admin can see and
      // correct the thing complained about rather than guess at it.
      for (const [name, value] of Object.entries(testCase.body)) {
        expect(data[name]).toBe(value === "" ? null : value);
      }
    });
  }

  // AND IT COMES BACK AS A PAGE. The context assertions above are satisfied
  // just as well by a handler that renders the form and then throws the
  // markup away -- `c.text(html, 400)` (markup shown as source) and
  // `c.html("", 400)` (a blank page where the admin's boundary polygon was)
  // both survived every one of them. This is the assertion that says the
  // admin gets their form back, which is the entire point of the 400.
  it("re-renders the refused form as an HTML page, not a plain-text 400", async () => {
    const res = await post("/admin/parlcon/new/", { ...TYPED, name: "" });

    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toBe("<html>form</html>");
  });

  // parseAdminFields reports the FIRST failure in spec order, matching
  // Django's habit of surfacing one error per field top-down. `name` precedes
  // `email` in PARLCON_FIELDS, so a submission broken in both ways complains
  // about the name.
  it("reports the first failure in field order when several are wrong", async () => {
    await post("/admin/parlcon/new/", { ...TYPED, name: "", email: "nope" });

    expect(lastRender().context.error).toBe("Name is required");
  });

  // The whole-number check runs AFTER parseAdminFields, so a blank ID is
  // "required", never "must be a whole number" -- reporting the latter for an
  // empty box would send the admin looking for a typo that is not there.
  it("calls a blank MP ID missing rather than malformed", async () => {
    await post("/admin/parlcon/new/", { ...TYPED, mp_parl_id: "  " });

    expect(lastRender().context.error).toBe("MP's ID is required");
  });

  it("keeps the edit form an edit form when it refuses a save", async () => {
    const before = seed();

    const res = await post("/admin/parlcon/salisbury/edit/", { ...TYPED, name: "", mp: "Jane Doe" });

    expect(res.status).toBe(400);
    // The heading still names the row being edited -- computed from the STORED
    // name, not the submitted one, so a rejected rename does not also rename
    // the page it was rejected on.
    expect(lastRender().context.title).toBe("Edit Salisbury");
    expect(formData().mp).toBe("Jane Doe");
    // And nothing moved.
    expect(rowById(before.id)).toEqual(before);
  });
});

// ===========================================================================
// mp_parl_id -- the one field this handler parses by hand
// ===========================================================================

// Number.parseInt(x, 10) is not "is this a whole number", it is "read as many
// leading digits as you can". Number.isInteger then only ever rejects the NaN
// case, because parseInt cannot return a fraction. So the guard's message
// promises more than the guard delivers, and the values below are stored
// silently truncated. THESE TESTS PIN WHAT IT DOES, NOT WHAT IT SHOULD DO --
// see the suspected-bugs note. The cost is real but bounded: mp_parl_id is the
// key photos.givefood.org.uk/2024-mp/<id>.jpg is built from
// (political.py:46), so a truncated id is a broken MP photograph on the
// constituency page and in every "write to your MP" flow, with no error
// anywhere.
describe("mp_parl_id, and what its whole-number check actually accepts", () => {
  it("stores a plain integer as an integer", async () => {
    await post("/admin/parlcon/new/", { ...TYPED, mp_parl_id: "4051" });

    expect(rows()[0]!.mp_parl_id).toBe(4051);
  });

  it("accepts a negative id, which no MP has", async () => {
    await post("/admin/parlcon/new/", { ...TYPED, mp_parl_id: "-4051" });

    expect(rows()[0]!.mp_parl_id).toBe(-4051);
  });

  // SUSPECT: a trailing typo is swallowed rather than reported.
  it("stores the leading digits of a value with trailing junk", async () => {
    const res = await post("/admin/parlcon/new/", { ...TYPED, mp_parl_id: "4051x" });

    expect(res.status).toBe(302);
    expect(rows()[0]!.mp_parl_id).toBe(4051);
  });

  // SUSPECT: "must be a whole number" is exactly what this is not, and it is
  // accepted anyway.
  it("truncates a decimal instead of refusing it", async () => {
    const res = await post("/admin/parlcon/new/", { ...TYPED, mp_parl_id: "4051.9" });

    expect(res.status).toBe(302);
    expect(rows()[0]!.mp_parl_id).toBe(4051);
  });

  // SUSPECT, and the worst of the three: radix 10 makes "0x..." read as a
  // single leading zero, so a pasted hex-looking id becomes MP number 0.
  it("turns a 0x-prefixed value into 0", async () => {
    const res = await post("/admin/parlcon/new/", { ...TYPED, mp_parl_id: "0x1F" });

    expect(res.status).toBe(302);
    expect(rows()[0]!.mp_parl_id).toBe(0);
  });

  // The one input the guard genuinely catches: no leading digits at all.
  it("refuses a value with no leading digits", async () => {
    const res = await post("/admin/parlcon/new/", { ...TYPED, mp_parl_id: "x4051" });

    expect(res.status).toBe(400);
    expect(lastRender().context.error).toBe("MP's ID must be a whole number");
    expect(rows()).toHaveLength(0);
  });
});

// ===========================================================================
// THE COLLISIONS NOTHING HERE REFUSES
// ===========================================================================

// ISSUE #12's CLASS, ON A TABLE WITH NO UNIQUE INDEX TO RAISE. `foodbank`,
// `foodbanklocation` and `foodbankdonationpoint` all gained pre-flight
// uniqueness checks (foodbankAdmin.ts, locationsAdmin.ts,
// donationPointsAdmin.ts) after that report; `parliamentaryconstituency` did
// not, and parlcon_slug_idx has never been unique -- in this schema or in
// Django's Meta.indexes. So the failure mode is not a 500 that loses the form,
// it is a 302 that looks exactly like a successful save.
//
// PINNING CURRENT BEHAVIOUR, NOT ENDORSING IT: these are reported as suspected
// bugs rather than fixed here.
describe("duplicate names and empty slugs are accepted silently", () => {
  it("creates a second row under a slug that already exists", async () => {
    const first = seed();

    const res = await post("/admin/parlcon/new/", TYPED);

    expect(res.status).toBe(302);
    expect(rows()).toHaveLength(2);
    expect(rows().map((r) => r.slug)).toEqual(["salisbury", "salisbury"]);
    // And from that moment the second row is unreachable: every read of this
    // table is `WHERE slug = ?` + .first(), so the admin can never open the
    // row they just created, and the public page keeps showing the old one.
    expect((await getConstituencyBySlug(d1Session(db), "salisbury"))?.id).toBe(first.id);
    expect(rows()[1]!.id).not.toBe(first.id);
  });

  // The same hole reached by renaming instead of creating: an edit can move a
  // row onto a sibling's slug just as easily.
  it("lets an edit rename a row onto another row's slug", async () => {
    const salisbury = seed();
    const amesbury = seed({ name: "Amesbury", slug: "amesbury", mp_parl_id: 4052, pcon24cd: "E14001435" });

    const res = await post("/admin/parlcon/amesbury/edit/", { ...TYPED, name: "Salisbury" });

    expect(res.status).toBe(302);
    expect(rowById(amesbury.id).slug).toBe("salisbury");
    expect((await getConstituencyBySlug(d1Session(db), "salisbury"))?.id).toBe(salisbury.id);
    // Amesbury now exists at no URL at all.
    expect(await getConstituencyBySlug(d1Session(db), "amesbury")).toBeNull();
  });

  // PARLCON_FIELDS' own comment says `name` is required *because* "a blank
  // name yields a blank slug that collides with every other blank one". A
  // name made entirely of punctuation, or entirely of non-Latin script, gets
  // through the required check and slugifies to exactly that blank slug --
  // and /admin/parlcon//edit/ matches no route, so the row cannot be reopened
  // even to correct the name.
  it("accepts a name that slugifies to nothing, storing an empty slug", async () => {
    const res = await post("/admin/parlcon/new/", { ...TYPED, name: "!!!" });

    expect(res.status).toBe(302);
    expect(rows()[0]!.name).toBe("!!!");
    expect(rows()[0]!.slug).toBe("");
  });

  // `country` is a <select> whose options come from
  // givefood/const/general.py:4-13, but parseAdminFields validates only
  // required-ness, postcodes and emails -- never a select's option list. A
  // hand-built POST therefore stores anything. Django's ModelForm would have
  // rejected this with "Select a valid choice", so it is a genuine divergence;
  // pinned because the constituency index page groups by exactly this column.
  it("stores a country that is not one of the select's options", async () => {
    const res = await post("/admin/parlcon/new/", { ...TYPED, country: "Narnia" });

    expect(res.status).toBe(302);
    expect(rows()[0]!.country).toBe("Narnia");
  });
});

// ===========================================================================
// CSRF -- and the ordering around it
// ===========================================================================

describe("CSRF", () => {
  it("refuses a POST with no token field, and writes nothing", async () => {
    const res = await post("/admin/parlcon/new/", TYPED, { csrfField: null });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(rows()).toHaveLength(0);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("refuses a token that does not match the cookie", async () => {
    const res = await post("/admin/parlcon/new/", TYPED, { csrfField: "c".repeat(64) });

    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it("refuses a POST with no CSRF cookie at all", async () => {
    const res = await post("/admin/parlcon/new/", TYPED, { csrfCookie: false });

    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  // THE ATTACK THE SIGNATURE EXISTS FOR, and the one the three tests above
  // cannot reach. verifyCsrf checks the cookie's HMAC *and* that the cookie's
  // raw half equals the submitted field; the tests above only ever break the
  // second. An attacker who can set a cookie on the parent domain (any
  // sibling subdomain can, which is exactly why csrf.ts's own comment cites
  // it) plants a cookie and puts its raw half in the form -- both halves then
  // agree, and only the HMAC says no. Deleting that one line left all 72
  // earlier tests passing while opening the whole admin to a cross-site POST.
  it("refuses a cookie the server never signed, even when the form field matches it", async () => {
    const res = await post("/admin/parlcon/new/", TYPED, { csrfCookieValue: `${CSRF_RAW}.${"0".repeat(64)}` });

    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it("refuses a cross-origin submission even with both halves of the token", async () => {
    const res = await post("/admin/parlcon/new/", TYPED, { origin: "https://evil.example" });

    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  // Sec-Fetch-Site and Origin are two SEPARATE guards, and the cross-origin
  // test above only exercises Origin: a forged POST from a page that omits
  // Origin (a form navigation from an attacker's site can) still announces
  // itself as `Sec-Fetch-Site: cross-site`. With Origin held back, deleting
  // the Sec-Fetch-Site line saved the row -- the mutant survived every other
  // test in this block.
  it("refuses a cross-site fetch that sends no Origin header at all", async () => {
    const res = await post("/admin/parlcon/new/", TYPED, { origin: null, secFetchSite: "cross-site" });

    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  // The pair a browser that sends neither header produces, kept beside the
  // one above so the difference is deliberate rather than accidental: both
  // guards skip an absent header, so an old browser can still submit and the
  // signed double-submit alone carries the request.
  it("still accepts a submission from a browser that sends neither header", async () => {
    const res = await post("/admin/parlcon/new/", TYPED, { origin: null, secFetchSite: null });

    expect(res.status).toBe(302);
    expect(rows()).toHaveLength(1);
  });

  // FAIL CLOSED WITH NO SECRET. csrf.ts's own convention -- "an unset secret
  // must never be silently indistinguishable from working" -- and the only
  // configuration in which every admin write is refused, so it wants to be
  // refused loudly rather than waved through. A missing binding is a
  // deployment away (the secrets-file script in this repo's own history is
  // how it is set), and `if (!secret) return true` is the shape of the
  // "temporary" edit that makes an unconfigured Worker world-writable.
  it("refuses every write when CSRF_SECRET is not configured", async () => {
    delete (env as unknown as Record<string, unknown>).CSRF_SECRET;

    const res = await post("/admin/parlcon/new/", TYPED);

    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  // An edit refused on CSRF must leave the row byte-identical: this is the
  // shape a forged cross-site POST would take against a logged-in admin, and
  // "403" alone would be satisfied by a handler that refused after writing.
  it("leaves the edited row untouched when it refuses", async () => {
    const before = seed();

    const res = await post("/admin/parlcon/salisbury/edit/", { ...TYPED, mp: "Jane Doe" }, { csrfField: null });

    expect(res.status).toBe(403);
    expect(rowById(before.id)).toEqual(before);
  });

  // ORDERING, pinned because it is easy to reverse by accident: the row lookup
  // (and its 404) happens BEFORE the token is checked, so an unknown slug is a
  // 404 whether or not the token was valid. Harmless -- the lookup is a read
  // and the write is still behind the check -- but worth stating, because the
  // moment anything with a side effect moves above line 43 it stops being
  // harmless.
  it("404s an unknown slug before it ever checks the token", async () => {
    const res = await post("/admin/parlcon/nowhere-at-all/edit/", TYPED, { csrfField: null });

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// AUTH -- requireAdminAuth, running for real
// ===========================================================================

describe("authentication", () => {
  it("bounces an unauthenticated GET to the sign-in page without rendering", async () => {
    const res = await get("/admin/parlcon/new/", { authenticated: false });

    expect(res.status).toBe(302);
    // Django stashed next_url in the session; there is no session yet here, so
    // it travels as a query param (middleware/adminAuth.ts's own note).
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fparlcon%2Fnew%2F");
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // THE ONE THAT MATTERS: a POST carrying a perfectly valid CSRF pair must
  // still never reach the writer without a session. The token proves the
  // request came from our own form, not that anyone is signed in.
  it("does not let an unauthenticated POST reach the handler or the database", async () => {
    const before = seed();

    const res = await post("/admin/parlcon/salisbury/edit/", { ...TYPED, mp: "Jane Doe" }, { authenticated: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fparlcon%2Fsalisbury%2Fedit%2F");
    expect(rowById(before.id)).toEqual(before);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("refuses a session id the KV store has never heard of", async () => {
    sessionKv.clear();

    const res = await get("/admin/parlcon/new/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fparlcon%2Fnew%2F");
  });
});

// ===========================================================================
// The writer's own contract, seen from the route
// ===========================================================================

// upsertParliamentaryConstituency returns the slug it derived, and this
// handler throws that away in favour of a fixed redirect to the list -- a
// deliberate choice (the handler's closing comment: re-opening the form gave
// the admin no signal anything had happened, and the batch-MP-update workflow
// wants the list back). Asserted through the writer directly so the discarded
// value is on the record: if a future change wants to land the admin back on
// the row it just saved, this is the value it needs.
describe("upsertParliamentaryConstituency's return value, which the route discards", () => {
  it("hands back the derived slug the route does not use", async () => {
    const slug = await upsertParliamentaryConstituency(
      d1Session(db),
      {
        name: "Ynys Môn",
        country: "Wales",
        mp: null,
        mpParty: null,
        mpParlId: 4051,
        email: null,
        centroid: "53.28,-4.35",
        boundaryGeojson: null,
      },
      undefined,
    );

    expect(slug).toBe("ynys-mon");
    expect(rows()[0]!.slug).toBe("ynys-mon");
  });
});
