import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverTiming } from "../../middleware/serverTiming";
import type { AppEnv } from "../../types";

// /admin/foodbanks/dupe_postcodes/ -- gfadmin/views.py:340-358
// foodbanks_dupe_postcodes, registered gfadmin/urls/foodbanks.py:8.
//
// WHY THIS FILE EXISTS AT ALL, given packages/db/src/dupePostcodes.test.ts
// already puts the SQL through a real engine row by row: everything that can
// go wrong in dupePostcodes.ts is a WIRING failure, and not one of them
// throws. The handler is eight lines with no branches -- so the only things
// it can get wrong are the things no assertion inside packages/db can see:
//
//   - the route not being REACHABLE. This page's own header comment records
//     that packages/templates/templates/admin/settings.njk:50 shipped a link
//     to /admin/foodbanks/dupe_postcodes/ that 404ed, because no route was
//     registered for it. A test that mounts its own ad-hoc Hono route would
//     pass with the real registration deleted, which is exactly the bug that
//     was live. So this file imports the REAL adminApp from ./index and asks
//     it for the real path, exactly as settings.njk's anchor does.
//   - the query's answer not reaching the template, or reaching it under a
//     name the template does not read. `truncated` renders the "there are
//     more" banner and `limit` renders the number inside it; a rename to
//     `isTruncated` produces a page that silently tells an operator there is
//     nothing further to fix. Nothing goes red -- nunjucks renders a missing
//     variable as "" (env.ts sets throwOnUndefined: false, deliberately).
//   - auth. requireAdminAuth is applied once, by adminApp, so this handler
//     has no auth code of its own to inspect: the only way to know the page
//     is gated is to drive the real middleware chain.
//
// Sibling issues #12 and #34 are the register this file is written in: both
// were writes that reported success, and both went unnoticed because a
// redirect (or a rendered page) was mistaken for evidence. The equivalent
// here is a rendered page mistaken for evidence that the data reached it.
//
// REAL EVERYTHING except the one thing that would import a 1.2MB build
// artifact: real SQLite (node:sqlite, seeded from the migrations), the real
// getDuplicatePostcodes, the real dbSession, the real requireAdminAuth over a
// real KV-shaped store, the real issueCsrfToken, the real adminPageContext,
// and the real adminApp router with its real route table. Only
// @givefood/templates is stubbed -- `render` so the context handed to the
// template is inspectable, and because loading it for real would pull in
// packages/templates/src/generated/precompiled.js, a gitignored build
// artifact that `vitest run` alone never generates (both neighbouring route
// suites stub it for the same reason).
//
// MUTATION-TESTED in a throwaway copy of the repo, outside it (TESTING.md's
// no-scratch-files rule). 42 mutants applied and re-run; all 42 died. The ones
// worth naming, because each is a plausible edit rather than a contrived one:
// the route path retyped with a hyphen, the registration deleted, registered
// as .post, registered as BOTH get and post, adminApp's requireAdminAuth line
// removed, the /auth/ redirect losing its ?next=, `groups` renamed to Django's
// own `dupes`, `truncated` hard-coded false, `limit` hard-coded, an explicit
// limit passed, the section changed to "foodbanks", the page context no longer
// spread in, the template name changed, c.html("") instead of the rendered
// page, a redirect instead of a render, the query run twice, a DELETE added
// alongside it, a try/catch that renders an empty page when D1 fails, the D1
// session mode changed to "first-primary", the CSRF cookie not set and its
// per-visitor flag not set, and -- reaching down into
// packages/db -- HAVING > 1 relaxed, the default limit changed, the CTE's
// ORDER BY reversed, the outer ORDER BY reversed, either UNION branch dropped,
// the location branch's foodbank_name/foodbank_slug transposed, is_closed
// replaced by a literal 0, `WHERE is_closed = 0` added, the view swapped for
// the bare table, the probe fetching `limit` instead of `limit + 1`, and the
// grouping loop reading groups[0].
//
// One mutant survived an earlier draft and is the reason the truncation test
// seeds 502 duplicated postcodes rather than 501 -- see its own comment.
//
// RE-MUTATED ON REVIEW with 46 further mutants, every one named above re-run
// alongside them. Two notes from that round, both worth keeping:
//
//   - the packages/db half of the list only means anything if the throwaway
//     copy's `node_modules/@givefood/db` resolves INTO the copy. Point it at
//     the real checkout -- the obvious way to skip a second pnpm install --
//     and every packages/db mutant "passes" without ever having been applied,
//     which reads exactly like a strong suite. Wired correctly they all die.
//   - nine survived. Seven are closed by the tests below, each naming the
//     mutant it now kills: an unvalidated `?limit` reaching the query,
//     `truncated` computed with >= instead of >, the postcode WHERE clause
//     deleted from either UNION branch (and TRIM relaxed within it),
//     `render_time_ms` left unwired, the per-visitor flag moved onto the CSRF
//     mint path, the CSRF cookie reuse branch dropped, and lib/adminAuth.ts's
//     JSON.parse try/catch removed.
//
// The two left standing are EQUIVALENT mutants, not gaps: moving this route's
// registration to the end of index.ts (nothing on /foodbanks/ shadows it, and
// "answers the link" would catch it the day something did), and dropping
// `postcode IS NOT NULL` from a branch that keeps `TRIM(postcode) <> ''` --
// TRIM(NULL) is NULL and NULL <> '' is NULL, so the row is excluded by the
// half that remains. No test can kill either; they are recorded here so the
// next person does not spend the afternoon trying.
//
// WHAT IS DELIBERATELY NOT RE-TESTED HERE: which rows count as duplicates.
// The HAVING clause, the closed rows, the donation-point exclusion, the
// collation and the truncation arithmetic all belong to
// packages/db/src/dupePostcodes.test.ts and are asserted there against the
// same engine -- a `GROUP BY postcode COLLATE NOCASE` mutant, for instance,
// lives green through this file and dies there. The seeds below are the
// smallest that let a route-level claim be made, with two exceptions kept
// because a mutation run showed them load-bearing HERE: the excluded
// singleton (without it a handler that ignored the query's answer and
// rendered every row passes this whole file) and the blank-postcode rows
// (without them the WHERE clause can be deleted outright and nothing here
// notices -- the "seed only rows that should match" trap).

const mocks = vi.hoisted(() => ({
  renderCalls: [] as { template: string; context: Record<string, unknown> }[],
  pageContextCalls: [] as { path: string }[],
}));

vi.mock("@givefood/templates", () => ({
  render: async (template: string, context: Record<string, unknown>) => {
    mocks.renderCalls.push({ template, context });
    return `<html data-template="${template}"></html>`;
  },
  // Stubbed rather than dropped: adminPageContext spreads this into every
  // admin render and admin/page.njk reads canonical_path, language_code and
  // the rest out of it. Returning a marker is what makes "the page context
  // is still in there" assertable without loading the real templates.
  buildPageContext: (options: { path: string }) => {
    mocks.pageContextCalls.push(options);
    return { canonical_path: options.path, page_context_present: true };
  },
}));

// Imported after the mock factory, following foodbankLocation.test.ts. This
// is the REAL admin route table -- every registration in ./index -- so the
// path, the method and the auth middleware under test are the shipped ones.
const { adminApp } = await import("./index");

// ---------------------------------------------------------------------------
// Schema: the two tables and the one view this page's statement touches,
// transcribed from packages/db/migrations rather than inferred from the
// TypeScript interfaces, so a disagreement between the two shows up as a
// SQLite error instead of as a passing test. Reduced to the columns the
// query names plus the NOT NULLs that are load-bearing, following the
// workers/site convention (foodbankLocationArea.test.ts) rather than
// packages/db's full transcription.
//
// The two NOT NULL decisions that matter: `foodbank.postcode` is NOT NULL
// (0001_core.sql:15) and `foodbanklocation.postcode` is not (0001_core.sql
// :63) -- the asymmetry the module's NULL divergence is built on.
//
// foodbanklocation_full is the REAL view (0019_drop_foodbank_cache.sql:68-76),
// LEFT JOIN included. A hand-flattened table with foodbank_name already in it
// would quietly make the join direction untestable.
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT NOT NULL, postcode TEXT NOT NULL, country TEXT NOT NULL,
  lat_lng TEXT NOT NULL,
  charity_just_foodbank INTEGER NOT NULL,
  contact_email TEXT NOT NULL,
  url TEXT NOT NULL, shopping_list_url TEXT NOT NULL,
  address_is_administrative INTEGER NOT NULL,
  is_closed INTEGER NOT NULL,
  no_locations INTEGER NOT NULL, days_between_needs INTEGER NOT NULL,
  network TEXT, phone_number TEXT,
  created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE UNIQUE INDEX foodbank_name_uniq ON foodbank(name);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);

CREATE TABLE foodbanklocation (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT, postcode TEXT,
  country TEXT NOT NULL, lat_lng TEXT NOT NULL,
  is_closed INTEGER NOT NULL,
  modified TEXT NOT NULL
);
CREATE UNIQUE INDEX loc_fb_name_uniq ON foodbanklocation(foodbank_id, name);

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

// Every statement the request issues, in order. This page's whole design
// rationale (dupePostcodes.ts:16-27: two unindexed scans, ~6k rows, no index
// added on purpose) rests on it being ONE statement per page view, and the
// "an unauthenticated request never reaches the handler" test below is a
// claim about this log being EMPTY rather than about a status code.
let statements: { sql: string; params: Bindable[] }[];

// The slice of the D1 Sessions API packages/db uses, over node:sqlite. Same
// shape as the neighbouring suites'; `run` is present only so that a mutation
// would actually execute rather than throwing -- a test that proves this GET
// writes nothing must not be relying on writes being impossible.
function d1Session(db: DatabaseSync) {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      statements.push({ sql, params });
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      statements.push({ sql, params });
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      statements.push({ sql, params });
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null };
}

// KV, in memory. Not a mock of logic: getAdminSession's contract is "the
// session id from the __Host-gfsession cookie names a JSON blob in SESSIONS",
// and this is that store, so lib/adminAuth.ts's cookie parsing, key naming,
// JSON handling and expiry maths all run for real.
function kvStore(entries: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(entries));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

// lib/adminAuth.ts:61,250 -- the cookie name and key prefix, spelled out here
// so a change to either shows up as this file failing rather than as an admin
// page that silently stops authenticating.
const SESSION_COOKIE = "__Host-gfsession";
const SESSION_ID = "test-session-id";
const ADMIN = {
  email: "me@jasoncartwright.com",
  name: "Jason Cartwright",
  givenName: "Jason",
  picture: "https://example.org/avatar.png",
};

const DUPE_PATH = "/admin/foodbanks/dupe_postcodes/";
const STAMP = "2026-09-05 19:28:08.853000";

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let env: AppEnv["Bindings"];
let app: Hono<AppEnv>;
let sessionModes: string[];
let csrfIssued: boolean | undefined;
let nextId: number;

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function insert(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  const values = columns.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  db.exec(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")})`);
}

function seedFoodbank({ name, postcode, isClosed = 0 }: { name: string; postcode: string; isClosed?: number }): number {
  const id = nextId++;
  insert("foodbank", {
    id,
    uuid: `fb${String(id).padStart(30, "0")}`,
    name,
    slug: slugify(name),
    address: "1 Test Street\r\nTestville",
    postcode,
    country: "England",
    lat_lng: "51.5,-0.1",
    charity_just_foodbank: 0,
    contact_email: "test@example.org",
    url: "https://example.org/",
    shopping_list_url: "https://example.org/list/",
    address_is_administrative: 0,
    is_closed: isClosed,
    no_locations: 0,
    days_between_needs: 7,
    created: STAMP,
    modified: STAMP,
  });
  return id;
}

function seedLocation({
  foodbankId,
  name,
  postcode,
  isClosed = 0,
}: {
  foodbankId: number;
  name: string;
  postcode: string | null;
  isClosed?: number;
}): number {
  const id = nextId++;
  insert("foodbanklocation", {
    id,
    uuid: `lo${String(id).padStart(30, "0")}`,
    foodbank_id: foodbankId,
    name,
    slug: slugify(name),
    address: "2 Test Street",
    postcode,
    country: "England",
    lat_lng: "51.5,-0.1",
    is_closed: isClosed,
    modified: STAMP,
  });
  return id;
}

// `count` postcodes, each held by two food banks, named AA000 1AA upwards.
// Fixed-width so that lexicographic order is numeric order, and so the ones
// that survive a truncation are identifiable by eye. In one transaction
// because the truncation tests seed ~1,000 rows each and a per-row commit
// turns a 13ms test into a slow one.
function seedDuplicatedPostcodes(count: number): void {
  db.exec("BEGIN");
  for (let i = 0; i < count; i++) {
    const postcode = `AA${String(i).padStart(3, "0")} 1AA`;
    seedFoodbank({ name: `Bulk ${i} A`, postcode });
    seedFoodbank({ name: `Bulk ${i} B`, postcode });
  }
  db.exec("COMMIT");
}

// A signed-in GET, i.e. what the maintainer's browser sends after following
// the settings.njk link. `async` rather than a bare `return` because Hono
// types app.request() as `Response | Promise<Response>`, which is not
// assignable to Promise<Response> on its own.
async function get(path = DUPE_PATH, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { headers: { Cookie: `${SESSION_COOKIE}=${SESSION_ID}`, ...headers } }, env, execCtx);
}

// The context the handler handed the template -- what the admin's browser is
// about to be shown.
function lastRender(): { template: string; context: Record<string, unknown> } {
  const call = mocks.renderCalls.at(-1);
  if (!call) throw new Error("the handler rendered nothing");
  return call;
}

interface RenderedPlace {
  postcode: string;
  kind: string;
  name: string;
  foodbank_name: string | null;
  foodbank_slug: string | null;
  loc_slug: string | null;
  is_closed: number;
}

function renderedGroups(): { postcode: string; places: RenderedPlace[] }[] {
  return lastRender().context.groups as { postcode: string; places: RenderedPlace[] }[];
}

const rowCount = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  mocks.renderCalls.length = 0;
  mocks.pageContextCalls.length = 0;
  statements = [];
  sessionModes = [];
  csrfIssued = undefined;
  nextId = 1;

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const session = d1Session(db);

  env = {
    // Recorded rather than ignored: dbSession(c) asks for
    // "first-unconstrained" (lib/session.ts), which is what makes the read
    // replication-eligible. One call per request is also how this test knows
    // the handler opened exactly one session.
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return session;
      },
    },
    SESSIONS: kvStore({
      [`admin-session:${SESSION_ID}`]: JSON.stringify({ ...ADMIN, expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
    }),
    CSRF_SECRET: "test-secret",
    GMAP_STATIC_KEY: "static-key",
    GMAP_GEOCODE_KEY: "geocode-key",
    D1_DATABASE_NAME: "givefood-test",
  } as unknown as AppEnv["Bindings"];

  // The production mount, minus the middleware this route does not touch:
  // index.ts:637 routes /admin at adminApp, and index.ts:112 puts serverTiming
  // in front of everything. serverTiming is here rather than omitted because
  // adminPageContext reads the request-start time it records -- without it
  // `render_time_ms` would be the string "NaN" on every page, and a test
  // fixture should not be the reason a claim about the page is untrue.
  app = new Hono<AppEnv>();
  app.use("*", serverTiming);
  // Reads back the context variable lib/csrf.ts sets, which is otherwise
  // invisible from outside the request -- middleware/pageCacheControl.ts is
  // the only production reader, and it is what keeps a page carrying a CSRF
  // token out of a shared cache. Runs as middleware because a context
  // variable dies with the response.
  app.use("*", async (c, next) => {
    await next();
    csrfIssued = c.get("csrfIssued");
  });
  app.route("/admin", adminApp);
});

describe("the route registration", () => {
  // THE BUG THE ROUTE WAS WRITTEN TO FIX, asserted against the real router:
  // settings.njk:50 has been shipping this exact href, and it 404ed because
  // ./index registered nothing for it. Hard-coded rather than built from a
  // constant so that the string in this file and the string in the template
  // are two independent copies -- a rename that updated only one of them is
  // the failure being guarded against.
  it("answers the /admin/foodbanks/dupe_postcodes/ link settings.njk ships", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(lastRender().template).toBe("admin/foodbanks_dupe_postcodes.njk");
    // The rendered HTML is what is returned, not discarded and re-derived:
    // c.html(html), not c.html("").
    expect(await res.text()).toBe('<html data-template="admin/foodbanks_dupe_postcodes.njk"></html>');
  });

  // GET ONLY. ./index:270 registers `adminApp.get(...)` and nothing else, so
  // Hono answers a POST to the same path with a 404.
  //
  // A DIVERGENCE FROM DJANGO, and a deliberate one: Django's view is a plain
  // function with no method guard (views.py:340-358), so a POST there renders
  // the same page with a 200. Both are harmless because neither writes
  // anything -- what matters, and what is asserted, is that the port's answer
  // to a POST is a refusal rather than a write. No CSRF token is involved
  // because there is no accepted mutating method to protect.
  it("refuses a POST, and runs no query on the way to refusing it", async () => {
    const res = await app.request(DUPE_PATH, { method: "POST", headers: { Cookie: `${SESSION_COOKIE}=${SESSION_ID}` } }, env, execCtx);

    expect(res.status).toBe(404);
    expect(mocks.renderCalls).toEqual([]);
    expect(statements).toEqual([]);
  });
});

describe("auth", () => {
  // The middleware chain, driven for real: adminApp.use("*", requireAdminAuth)
  // is the only thing gating this page, and the handler contains no auth code
  // of its own to inspect.
  //
  // The assertion that matters is the LAST one -- the empty statement log. A
  // signed-out request must cost nothing, and this page is expensive by
  // design: dupePostcodes.ts deliberately runs two unindexed full scans over
  // ~6k rows (its comment refuses an index on the grounds that the page is
  // reached rarely), so a handler that ran before the auth check would let
  // anyone on the internet spend that scan at will.
  it("redirects a request with no session cookie, and never touches the database", async () => {
    const res = await app.request(DUPE_PATH, {}, env, execCtx);

    expect(res.status).toBe(302);
    // Django stashed next_url in its session; the port carries it as a query
    // param (middleware/adminAuth.ts:21-22), so the maintainer lands back on
    // this page after signing in rather than on the admin index.
    expect(res.headers.get("location")).toBe("/auth/?next=%2Fadmin%2Ffoodbanks%2Fdupe_postcodes%2F");
    expect(mocks.renderCalls).toEqual([]);
    expect(statements).toEqual([]);
  });

  // The other half: a cookie is not a session. An expired or evicted KV entry
  // (or a forged cookie value) must fail the same way, not fall through to a
  // rendered page -- getAdminSession returns null on a KV miss and the
  // middleware cannot tell the two cases apart, which is the intended shape.
  it("redirects a cookie whose session is not in KV", async () => {
    const res = await app.request(DUPE_PATH, { headers: { Cookie: `${SESSION_COOKIE}=not-a-real-session` } }, env, execCtx);

    expect(res.status).toBe(302);
    expect(mocks.renderCalls).toEqual([]);
    expect(statements).toEqual([]);
  });

  // A session record KV holds but cannot be read: a truncated write, a
  // half-migrated blob, anything that makes JSON.parse throw. It has to read
  // as signed out, not as a 500 -- MUTANT lib/adminAuth.ts's try/catch
  // removed survived the two tests above, since neither of them ever gets as
  // far as parsing. routes/admin/auth.test.ts:459 owns the general claim;
  // the reason to also make it here is the D1 one: an exception thrown after
  // the auth gate but before the handler is the one failure mode that could
  // still cost this page's two full scans, so the empty statement log is the
  // assertion that matters again.
  it("redirects a session record KV cannot parse, rather than 500ing", async () => {
    env.SESSIONS = kvStore({ [`admin-session:${SESSION_ID}`]: "{not-json" }) as unknown as AppEnv["Bindings"]["SESSIONS"];

    const res = await get();

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/?next=%2Fadmin%2Ffoodbanks%2Fdupe_postcodes%2F");
    expect(mocks.renderCalls).toEqual([]);
    expect(statements).toEqual([]);
  });
});

describe("what reaches the template", () => {
  // The load-bearing seed is "Exeter": a postcode held by exactly ONE row,
  // which must NOT appear. Without it every assertion in this file would pass
  // against a handler that ignored getDuplicatePostcodes and rendered every
  // place in the database -- the "a filter that does nothing passes every test
  // that only seeds matching rows" trap.
  //
  // The location is CLOSED and the food bank is not, so the pair is
  // asymmetric in is_closed. That asymmetry is what makes the field-by-field
  // assertion below able to tell a real column from a constant (a `0` literal
  // in place of is_closed survives a fixture where everything is open), and it
  // is also the Django parity point: get_all_locations() is the UNFILTERED
  // queryset, so a closed location still occupies its postcode and still
  // belongs on this screen.
  beforeEach(() => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: salisbury, name: "Bemerton Heath Centre", postcode: "SP2 9DY", isClosed: 1 });
    seedFoodbank({ name: "Exeter", postcode: "EX10 8LZ" });
  });

  it("passes the duplicated postcodes, and not the unduplicated one", async () => {
    await get();

    expect(renderedGroups().map((g) => g.postcode)).toEqual(["SP2 9DY"]);
  });

  // FIELD BY FIELD, on both branches of the UNION, because this is the page's
  // entire payload and every one of these columns is consumed by
  // foodbanks_dupe_postcodes.njk:87-92: foodbank_slug builds the food bank
  // link and the /edit/address/ button, loc_slug builds the
  // /location/<slug>/edit/ button, is_closed renders the "Closed" tag, and
  // kind chooses between the two button shapes. A row that arrived with
  // foodbank_name and foodbank_slug transposed -- one edit away in the SQL,
  // and invisible to any assertion on group counts -- renders a food bank
  // named "salisbury" linking to /admin/foodbank/Salisbury/.
  it("hands each place through whole, with the slugs the edit links are built from", async () => {
    await get();

    expect(renderedGroups()[0]!.places).toEqual([
      {
        postcode: "SP2 9DY",
        kind: "foodbank",
        name: "Salisbury",
        foodbank_name: "Salisbury",
        foodbank_slug: "salisbury",
        loc_slug: null,
        is_closed: 0,
      },
      {
        postcode: "SP2 9DY",
        kind: "location",
        name: "Bemerton Heath Centre",
        foodbank_name: "Salisbury",
        foodbank_slug: "salisbury",
        loc_slug: "bemerton-heath-centre",
        // The closed half of the pair: foodbanks_dupe_postcodes.njk:84 turns
        // this into the "Closed" tag, which is how an operator decides which
        // of two clashing records is the one to edit.
        is_closed: 1,
      },
    ]);
  });

  // The template reads exactly three variables of its own -- groups,
  // truncated, limit (foodbanks_dupe_postcodes.njk:39,51-55,61) -- on top of
  // the shared admin page context. `limit` is user-visible text ("Showing the
  // first 500 duplicated postcodes only"), so the route passing no limit and
  // getting the module's default is a fact about the page, not an internal
  // detail.
  it("passes truncated and limit under the names the template reads", async () => {
    await get();

    expect(lastRender().context.truncated).toBe(false);
    expect(lastRender().context.limit).toBe(500);
  });

  // MORE ROWS THAT MUST BE EXCLUDED, seeded next to the ones that must
  // appear. Every other fixture in this file holds a well-formed postcode,
  // which is why MUTANT `WHERE postcode IS NOT NULL AND TRIM(postcode) <> ''`
  // deleted from EITHER UNION branch (packages/db/src/dupePostcodes.ts:92
  // and :97) left this whole file green on review -- the "a filter that does
  // nothing passes every test that only seeds matching rows" trap, in the one
  // place where the rows a real admin database actually holds are the blank
  // ones. Django's own view has this defect: `postcodes.count("") > 1` is
  // true there, so two records with the box left empty put a group on the
  // page whose heading is nothing and whose links go to `?q=`.
  //
  // The BLANK pairs are what kill the mutant; the NULL pair cannot. The outer
  // join is `d.postcode = p.postcode`, and NULL = NULL is NULL, so a NULL
  // group that got past the WHERE would still join to no rows. It is seeded
  // anyway, because that second guard is accidental (packages/db's suite
  // spells out that it takes both mutations together to put Django's "None"
  // row back), and because a location with no postcode at all -- a mobile
  // van, a rotating venue -- is the ordinary real row of the two.
  // BOTH SHAPES ON BOTH BRANCHES, which is not padding: the predicate is
  // written twice, once per branch, and it has two halves. Seeding only ""
  // on food banks and only " " on locations left `TRIM(postcode)` relaxed to
  // a bare `postcode <> ''` alive on review -- an admin who types a space
  // into the box is the commoner of the two, and that mutant would put their
  // record on the page as a duplicate of everyone else's stray space.
  it("keeps blank and missing postcodes off the page, however many rows share them", async () => {
    const parent = seedFoodbank({ name: "Blank Parent", postcode: "PL1 1AA" });
    seedFoodbank({ name: "Blank One", postcode: "" });
    seedFoodbank({ name: "Blank Two", postcode: "" });
    // The two space-only food banks hold the SAME string, and the two
    // space-only locations do too. Give them different run-lengths -- "  "
    // against "   " -- and they stop being duplicates of each other the
    // moment TRIM is gone, so the relaxed predicate has nothing to put on the
    // page and survives. The comparison is a raw string match by design (the
    // module's header comment: "SW1A 1AA" and "SW1A1AA" stay two different
    // postcodes), which is exactly why the blank fixtures have to match too.
    seedFoodbank({ name: "Spacey One", postcode: "  " });
    seedFoodbank({ name: "Spacey Two", postcode: "  " });
    seedLocation({ foodbankId: parent, name: "Blank Hall", postcode: "" });
    seedLocation({ foodbankId: parent, name: "Blanker Hall", postcode: "" });
    seedLocation({ foodbankId: parent, name: "Spacey Hall", postcode: " " });
    seedLocation({ foodbankId: parent, name: "Spacier Hall", postcode: " " });
    seedLocation({ foodbankId: parent, name: "Mobile Tuesday", postcode: null });
    seedLocation({ foodbankId: parent, name: "Mobile Thursday", postcode: null });

    await get();

    expect(renderedGroups().map((g) => g.postcode)).toEqual(["SP2 9DY"]);
  });

  // An empty database is a 200 with an empty list -- the template's "No
  // duplicate postcodes." state (an addition over Django, which renders an
  // empty <ul> and no message). Not a 404: the page exists whether or not the
  // data is currently clean, and an operator checking their work needs to see
  // it say so.
  it("renders the empty state rather than 404ing when nothing is duplicated", async () => {
    db.exec("DELETE FROM foodbanklocation");
    db.exec("DELETE FROM foodbank");

    const res = await get();

    expect(res.status).toBe(200);
    expect(lastRender().context.groups).toEqual([]);
    expect(lastRender().context.truncated).toBe(false);
  });

  // section = "settings" is the one judgement call the handler makes, and its
  // header comment argues for it at length: Django's own view passes no
  // section at all, and this page is reached only from settings.njk's "Geo"
  // block, so the nav has to highlight Settings while the operator is here.
  // Pinned because it is invisible in every other assertion -- the page looks
  // identical with the wrong section, apart from which nav item is lit.
  it("marks the page as the settings section, as its header comment commits to", async () => {
    await get();

    expect(lastRender().context.section).toBe("settings");
  });

  // The shared admin page context has to be SPREAD IN, not replaced: without
  // it admin/page.njk has no signed-in user for the "signed out" nav, no
  // canonical path and no Google keys, and admin.js throws ReferenceError on
  // the first button click (pageContext.ts:30-37 documents that failure).
  //
  // admin_user in particular travels from the KV session through
  // requireAdminAuth's c.set("adminUser") into the render context -- three
  // hops that only a request driven through the real middleware can exercise.
  it("spreads the shared admin page context in, including the signed-in user", async () => {
    await get();

    const context = lastRender().context;
    expect(context.admin_user).toEqual(ADMIN);
    expect(context.page_context_present).toBe(true);
    expect(context.canonical_path).toBe(DUPE_PATH);
    expect(mocks.pageContextCalls).toEqual([{ path: DUPE_PATH }]);
    expect(context.d1_database).toBe("givefood-test");
    // pageContext.ts:55-57: `places` and the Maps JS key are deliberately
    // blanked, the static and geocode keys are published. Asserted here
    // because this is a page an unauthenticated visitor must never reach, and
    // a regression that leaked keys would do it through this same context.
    expect(context.gmap_key).toBe("");
    expect(context.gmap_places_key).toBe("");
    expect(context.gmap_static_key).toBe("static-key");
    // Whole milliseconds, not the string "NaN". This file's own preamble
    // gives that as the reason serverTiming is mounted in the fixture at all,
    // and until this line nothing checked it: MUTANT `render_time_ms` reading
    // an unset requestStartTime survived on review, which would have printed
    // "Took NaNms" in every admin page's debug comment while the fixture's
    // justification for mounting the middleware went on reading as verified.
    expect(String(context.render_time_ms)).toMatch(/^\d+$/);
  });

  // A CSRF token is issued even though this page has no form -- pageContext
  // .ts:12-16 chose that deliberately ("issuing one unconditionally is cheaper
  // than threading a 'does this page need one' flag through every call site").
  // The consequence is what is asserted: the response carries a __Host-csrf
  // cookie and is flagged per-visitor, which is what keeps
  // middleware/pageCacheControl.ts from letting this page into a shared cache.
  // That flag being missed on a token-bearing response is a bug this repo has
  // already had in production (see lib/csrf.ts's own account of it).
  it("still issues a CSRF cookie on a page with no form, and flags it per-visitor", async () => {
    const res = await get();

    expect(res.headers.get("set-cookie")).toContain("__Host-csrf=");
    expect(String(lastRender().context.csrf_token)).toMatch(/^[0-9a-f]{64}$/);
    // The flag, not the Set-Cookie header, is what pageCacheControl.ts keys
    // on -- precisely because a returning visitor's token is REUSED and sends
    // no cookie, which is how a token-bearing page reached the shared cache
    // in production once already.
    expect(csrfIssued).toBe(true);
  });

  // THE SECOND VISIT, which is how this page is actually used -- fix a
  // postcode, come back, reload. Two mutants survived the test above and are
  // killed here, both of them shapes this repo has already been bitten by:
  //
  //   - `c.set("csrfIssued", true)` moved down onto the mint path. A first
  //     visit still sets it, so the test above stays green, while a RELOAD
  //     carries the admin's token in the HTML with no per-visitor flag on the
  //     response -- exactly the incident lib/csrf.ts records, where such a
  //     page was stamped `public, s-maxage=86400` and served to everyone.
  //   - the cookie REUSE branch dropped, so every reload mints a fresh token
  //     and replaces the cookie. That is the two-tab 403 the same file
  //     records: a formless read-only screen quietly invalidating the token
  //     of the food bank edit form left open in the other tab.
  //
  // Both live in lib/csrf.ts and its own suite pins them in isolation. The
  // claim being made HERE is about this page: it has no form, so it is the
  // one nobody thinks of as a token holder, and it is the one an operator
  // reloads over and over while working the list.
  it("reuses the token from an earlier visit rather than replacing it, and stays flagged", async () => {
    const first = await get();
    const firstToken = lastRender().context.csrf_token;
    const csrfCookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(csrfCookie).toMatch(/^__Host-csrf=/);
    csrfIssued = undefined;

    const second = await get(DUPE_PATH, { Cookie: `${SESSION_COOKIE}=${SESSION_ID}; ${csrfCookie}` });

    expect(second.status).toBe(200);
    expect(second.headers.get("set-cookie") ?? "").not.toContain("__Host-csrf=");
    expect(lastRender().context.csrf_token).toBe(firstToken);
    expect(csrfIssued).toBe(true);
  });
});

describe("a GET must not mutate", () => {
  // Django's view "has no POST branch and mutates nothing" -- the port's own
  // header comment. Asserted from several directions, because the interesting
  // failure is not a visible write but an accidental one: a future "mark this
  // postcode as reviewed" feature, or a cache-warming UPDATE bolted onto the
  // page.
  //
  // The statement log is the strongest of them: it proves not only that
  // no write ran but that ONE statement ran in total, which is the premise the
  // module's refusal to add an index rests on (dupePostcodes.ts:24-27 -- two
  // full scans, done once, on a rarely-visited page).
  it("issues exactly one statement, a read, over exactly one D1 session", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: salisbury, name: "Bemerton Heath Centre", postcode: "SP2 9DY" });
    const before = { foodbank: rowCount("foodbank"), location: rowCount("foodbanklocation") };

    await get();

    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
    expect(statements[0]!.sql.trimStart()).toMatch(/^WITH\b/);
    expect({ foodbank: rowCount("foodbank"), location: rowCount("foodbanklocation") }).toEqual(before);
    // lib/session.ts's mode, and one session per request -- a second
    // withSession() call would mean a second, separately-consistent read.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // Two views in a row must be identical and must still be one statement
  // each. This is the assertion a "let me just cache the answer in a table"
  // change trips over, and it is also what says the page is safe to reload --
  // the maintainer's actual workflow here is fix a postcode, come back, reload.
  it("is idempotent across repeated views", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: salisbury, name: "Bemerton Heath Centre", postcode: "SP2 9DY" });

    await get();
    const first = renderedGroups();
    statements = [];
    await get();

    expect(renderedGroups()).toEqual(first);
    expect(statements).toHaveLength(1);
  });
});

describe("the truncation warning", () => {
  // The ONLY route-level route to `truncated: true`: the handler calls
  // getDuplicatePostcodes with no limit, so the ceiling is the module's own
  // 500 and the page cannot be pushed over it by a query parameter. Every
  // other test in this file sees `truncated: false`, which a hard-coded
  // `truncated: false` in the handler would satisfy just as well.
  //
  // What that hard-coding would cost is the worst outcome this page has: an
  // operator is shown 500 duplicates, told nothing about the rest, and stops
  // when the list runs out. So the duplicates past the ceiling are seeded for
  // real. 1,004 food banks is roughly the size of the live table, which is
  // the other reason to run it once here -- the page's cost is stated in the
  // module's comments and never otherwise exercised through a request.
  //
  // 502 duplicated postcodes, not 501, and the extra pair is load-bearing.
  // The statement asks for limit + 1 = 501, so at 501 duplicates it fetches
  // every one of them and the direction it would have discarded in is
  // unobservable -- `ORDER BY postcode DESC` inside the dupes CTE survives
  // that seed untouched, verified by running it. At 502 the CTE genuinely
  // throws one away, and the "first 500 by postcode" assertion below is
  // finally a statement about which duplicates the maintainer is shown.
  it("tells the operator there are more, and shows the first 500 by postcode", async () => {
    seedDuplicatedPostcodes(502);

    await get();

    const context = lastRender().context;
    expect(context.truncated).toBe(true);
    expect(context.limit).toBe(500);
    expect(renderedGroups()).toHaveLength(500);
    // The first 500 by postcode, not an arbitrary 500 -- the banner says
    // "the first 500", and an operator working the list in order has to be
    // able to trust that the ones below the cut are the ones after these.
    expect(renderedGroups()[0]!.postcode).toBe("AA000 1AA");
    expect(renderedGroups()[499]!.postcode).toBe("AA499 1AA");
  });

  // THE OTHER SIDE OF THE BANNER, and the only seed that can assert it.
  // `truncated` is `groups.length > limit` (packages/db/src/dupePostcodes.ts
  // :117), and MUTANT `>=` survived every other test in this file on review:
  // at 502 duplicates the banner is true either way, and at two duplicates it
  // is false either way. Only a list landing exactly ON the ceiling separates
  // them.
  //
  // Worth 500 rows of seed because the wrong answer here is the mirror of the
  // failure the test above exists for: an operator who really is looking at
  // every duplicate in the database is told there are more, and goes hunting
  // for rows that do not exist. On a data-quality screen the banner is the
  // only thing that says whether the work is finished.
  it("shows no 'there are more' banner when the list lands exactly on 500", async () => {
    seedDuplicatedPostcodes(500);

    await get();

    expect(renderedGroups()).toHaveLength(500);
    expect(lastRender().context.truncated).toBe(false);
  });
});

describe("the ceiling is the module's, not the caller's", () => {
  // NOTHING IN THE URL MAY RAISE IT. The handler passes no limit at all
  // (dupePostcodes.ts:22), so the 500 is packages/db's default and the query
  // always asks SQLite for the same 501 rows. MUTANT
  // `getDuplicatePostcodes(dbSession(c), Number(c.req.query("limit") ?? 500))`
  // -- two lines, the shape of an obliging "let me make this page
  // configurable" change -- survived every other test in this file, because
  // every other request here is made without a query string.
  //
  // What it would cost is the page's entire cost argument. The module
  // deliberately adds no index on either postcode column (dupePostcodes.ts
  // :24-27) on the grounds that this is a rarely-visited page doing two scans
  // over ~6k rows; a limit anyone can set turns that into a scan-and-render
  // of unbounded size behind nothing but a session cookie, and D1 meters rows
  // scanned.
  //
  // The bind parameter is asserted, not just the rendered `limit`: those are
  // two different numbers (501 and 500) and only the first one is what the
  // database was actually asked for. It is also the assertion that catches a
  // probe bound as a STRING, which SQLite coerces silently.
  it("ignores a ?limit in the query string, and still asks the database for 501", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: salisbury, name: "Bemerton Heath Centre", postcode: "SP2 9DY" });

    const res = await get(`${DUPE_PATH}?limit=100000&page=3`);

    expect(res.status).toBe(200);
    expect(lastRender().context.limit).toBe(500);
    expect(renderedGroups().map((g) => g.postcode)).toEqual(["SP2 9DY"]);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.params).toEqual([501]);
  });

  // The same claim from the other end: a query string must not shrink the
  // page either. A `?limit=1` that reached the module would drop duplicates
  // off the list AND raise the truncation banner over them, which reads as
  // real data rather than as a URL the operator half-typed.
  it("ignores a ?limit small enough to hide duplicates", async () => {
    seedDuplicatedPostcodes(3);

    await get(`${DUPE_PATH}?limit=1`);

    expect(renderedGroups()).toHaveLength(3);
    expect(lastRender().context.truncated).toBe(false);
    expect(statements[0]!.params).toEqual([501]);
  });
});

describe("when the query fails", () => {
  // The handler has no try/catch, which is the right call and is worth
  // pinning as such: the alternative that looks defensive -- catching and
  // rendering with `groups: []` -- would show the maintainer "No duplicate
  // postcodes." when what actually happened is that D1 was unavailable. On a
  // data-quality screen a false clean bill of health is worse than an error
  // page.
  //
  // In production index.ts:659-662 turns this into the rendered 500 page;
  // this fixture has no onError, so Hono's default 500 is what comes back.
  // Either way the page is not rendered, which is the assertion.
  it("lets the error surface instead of rendering an empty page", async () => {
    env = {
      ...env,
      DB: {
        withSession: () => ({
          prepare: () => {
            throw new Error("D1_ERROR: no such table: foodbanklocation_full");
          },
        }),
      },
    } as unknown as AppEnv["Bindings"];

    const res = await get();

    expect(res.status).toBe(500);
    expect(mocks.renderCalls).toEqual([]);
  });
});
