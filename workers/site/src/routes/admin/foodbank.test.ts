import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@givefood/db";
import type { AppEnv } from "../../types";

// github #12: a duplicate name used to reach D1, throw
// SQLITE_CONSTRAINT_UNIQUE, and land the admin on the 500 page with all 30
// typed fields gone -- including whatever the Lookup buttons had just pulled
// out of Google Places. Django's ModelForm ran validate_unique() inside
// is_valid() and re-rendered the BOUND form instead (gfadmin/views.py:817-858
// has no else branch, so an invalid POST falls through to the same render()).
// This file asserts the user-visible half of that contract: WHICH response
// comes back, at WHAT status, carrying WHICH values, and whether anything was
// written.
//
// The uniqueness check itself is NOT mocked. foodbankNameTaken,
// foodbankSlugTaken and foodbankSlugForName run for real against a tiny
// in-memory table (below), so these tests exercise handler -> real check ->
// real SQL semantics: replacing `IS NOT` with `!=` in
// packages/db/src/foodbankAdmin.ts fails two of the tests here as well as
// one in that module's own suite. Only the three row-level writers are
// stubbed, because storage is not what this file is about -- and a stub
// makes "nothing was written" a direct assertion rather than an inference.

interface SeedRow {
  id: number;
  name: string;
  slug: string;
}

// The rows the check queries see. Kept module-level because vi.mock factories
// are hoisted above everything else in the file.
const rows: SeedRow[] = [];
const renderCalls: { template: string; context: Record<string, unknown> }[] = [];
const insertCalls: Record<string, unknown>[] = [];
const updateCalls: { id: number; fields: Record<string, unknown> }[] = [];
const queries: { sql: string; params: unknown[] }[] = [];
// Statements the handler ran through the session rather than through a
// mocked writer -- setDiscrepancyStatus is the only one, and a rejected save
// must not have run it.
const runCalls: { sql: string; params: unknown[] }[] = [];

// Set by the two backstop tests to make the row write fail the way D1 does
// when a second admin took the name between the check and the write.
let writeError: Error | null = null;

// SQLite's three-valued logic, applied to whichever operator the module
// under test actually wrote. See packages/db/src/foodbankAdmin.test.ts for
// the real-SQLite transcript these rules were taken from -- the short
// version is that `id != NULL` is UNKNOWN, so a WHERE built on it matches no
// rows and the check silently always passes.
const SELECT_CHECK = /^SELECT id FROM foodbank WHERE (name|slug) = \? AND id (IS NOT|IS|!=|<>|=) \?$/;

function selectCheck(sql: string, params: unknown[]): { id: number } | null {
  const match = SELECT_CHECK.exec(sql);
  if (!match) throw new Error(`fake session: unrecognised SQL: ${sql}`);
  const [, column, operator] = match;
  const [wanted, exceptId] = params;
  for (const row of rows) {
    if (row[column as "name" | "slug"] !== wanted) continue;
    const notExcluded =
      operator === "IS NOT"
        ? row.id !== exceptId // null-safe: NULL is only equal to NULL
        : exceptId === null || exceptId === undefined
          ? false // `id != NULL` is UNKNOWN, and UNKNOWN drops the row
          : row.id !== exceptId;
    if (notExcluded) return { id: row.id };
  }
  return null;
}

const session = {
  prepare(sql: string) {
    let bound: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        bound = values;
        return statement;
      },
      async first<T>(): Promise<T | null> {
        queries.push({ sql, params: bound });
        return selectCheck(sql, bound) as T | null;
      },
      async run() {
        runCalls.push({ sql, params: bound });
        return { success: true };
      },
    };
    return statement;
  },
} as unknown as Session;

vi.mock("@givefood/templates", () => ({
  render: async (template: string, context: Record<string, unknown>) => {
    renderCalls.push({ template, context });
    return `<html data-template="${template}"></html>`;
  },
}));

vi.mock("../../lib/session", () => ({ dbSession: () => session }));
vi.mock("../../lib/csrf", () => ({ verifyCsrf: async () => true }));
vi.mock("./pageContext", () => ({ adminPageContext: async () => ({ csrf_token: "test-token" }) }));

vi.mock("@givefood/db", async (importOriginal) => {
  // The checks and the slug derivation stay REAL -- they are what is on
  // trial. Only the three functions that would touch actual storage are
  // replaced, and updateFoodbankFields keeps its real return contract (the
  // post-save slug, or null when the form posted no name) by deriving it
  // through the real slugifier.
  const actual = await importOriginal<typeof import("@givefood/db")>();
  return {
    ...actual,
    getFoodbankBySlug: async (_session: Session, slug: string) => {
      const row = rows.find((r) => r.slug === slug);
      return row ? { ...row, parliamentary_constituency_slug: null } : null;
    },
    insertFoodbank: async (_session: Session, values: Record<string, unknown>) => {
      insertCalls.push(values);
      if (writeError) throw writeError;
      const slug = actual.foodbankSlugForName(String(values.name));
      const created = { id: rows.length + 1, name: String(values.name), slug };
      rows.push(created);
      return { id: created.id, slug };
    },
    updateFoodbankFields: async (_session: Session, id: number, values: Record<string, unknown>) => {
      updateCalls.push({ id, fields: values });
      if (writeError) throw writeError;
      if (typeof values.name !== "string" || !values.name) return null;
      const slug = actual.foodbankSlugForName(values.name);
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, { name: values.name, slug });
      return slug;
    },
  };
});

const { adminFoodbankEdit, adminFoodbankNew, adminFoodbankPartialEdit } = await import("./foodbank");

// A complete, valid FOODBANK_FIELDS POST: every required field present and
// passing parseAdminFields' own format checks (postcode regex, email), plus
// a few optional ones that exist purely so the tests can prove they survive
// a rejected save. `place_id` in particular is what the Google Places
// "Lookup" button writes into the form -- the most expensive single thing to
// lose to a 500.
function body(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    csrf_token: "test-token",
    name: "Camden Food Bank",
    address: "1 Test Street\r\nTestville",
    postcode: "SW1A 1AA",
    country: "England",
    lat_lng: "51.5,-0.1",
    place_id: "ChIJ-lookup-result",
    phone_number: "020 7946 0000",
    notes: "Typed by hand, and expensive to retype",
    contact_email: "test@example.org",
    url: "https://example.org/",
    shopping_list_url: "https://example.org/list/",
    ...overrides,
  };
}

interface ContextOptions {
  method: "GET" | "POST";
  form?: Record<string, string>;
  params?: Record<string, string>;
  query?: Record<string, string>;
}

function makeContext(opts: ContextOptions): Context<AppEnv> {
  return {
    req: {
      method: opts.method,
      path: "/admin/foodbank/",
      parseBody: async () => opts.form ?? {},
      param: (name: string) => opts.params?.[name],
      query: (name: string) => opts.query?.[name],
    },
    env: { CSRF_SECRET: "secret", PURGE_Q: { send: async () => {} } },
    executionCtx: { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) },
    html: (content: string, status = 200) => new Response(content, { status, headers: { "content-type": "text/html" } }),
    redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
    text: (content: string, status = 200) => new Response(content, { status }),
    notFound: () => new Response("Not Found", { status: 404 }),
    get: () => undefined,
  } as unknown as Context<AppEnv>;
}

// The context the handler handed the template, i.e. what the admin's browser
// is about to be sent.
function lastRender(): { error: string | null; foodbank: Record<string, unknown> } {
  const call = renderCalls.at(-1);
  if (!call) throw new Error("the handler rendered nothing");
  return call.context as unknown as { error: string | null; foodbank: Record<string, unknown> };
}

function seed(...names: string[]): void {
  for (const name of names) rows.push({ id: rows.length + 1, name, slug: name.toLowerCase().replace(/[^\w\s-]/g, "").replace(/[-\s]+/g, "-") });
}

beforeEach(() => {
  rows.length = 0;
  renderCalls.length = 0;
  insertCalls.length = 0;
  updateCalls.length = 0;
  queries.length = 0;
  runCalls.length = 0;
  writeError = null;
});

describe("adminFoodbankNew", () => {
  it("blocks a duplicate name and re-renders the bound form", async () => {
    seed("Brixton Food Bank");

    const res = await adminFoodbankNew(makeContext({ method: "POST", form: body({ name: "Brixton Food Bank" }) }));

    // Not the 500 the issue reports, and not a redirect either -- a 302 here
    // would look like a successful save that silently created nothing, which
    // is worse than the crash because it lies.
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();

    // ModelForm's single-field branch, "%(model_name)s with this
    // %(field_label)s already exists." resolved against capfirst(verbose_name)
    // "Foodbank" and capfirst(name.verbose_name) "Name"
    // (givefood/models/foodbank.py:61 `unique=True`), plus the offending
    // value the way routes/admin/items.ts:133 appends it.
    expect(lastRender().error).toBe('Foodbank with this Name already exists: "Brixton Food Bank"');

    // The whole point of re-rendering instead of 500ing: every typed value is
    // still on the page, including the Places lookup result.
    expect(lastRender().foodbank).toMatchObject({
      name: "Brixton Food Bank",
      place_id: "ChIJ-lookup-result",
      notes: "Typed by hand, and expensive to retype",
      phone_number: "02079460000",
    });

    // And nothing was written.
    expect(insertCalls).toHaveLength(0);
  });

  it("blocks a distinct name whose SLUG collides, and says so", async () => {
    // A name check alone passes this: "St Marys Foodbank" duplicates no
    // name, but slugify() eats the full stop and the apostrophe so both rows
    // want /needs/at/st-marys-foodbank/. Django had no such constraint and
    // wrote the row; the port constrains it (0001_core.sql:48) and so has to
    // validate it -- with wording that points at the real problem rather than
    // claiming a name duplicate the admin can see is not there.
    seed("St. Mary's Foodbank");

    const res = await adminFoodbankNew(makeContext({ method: "POST", form: body({ name: "St Marys Foodbank" }) }));

    expect(res.status).toBe(400);
    expect(lastRender().error).toBe(
      'Another food bank already uses the web address /needs/at/st-marys-foodbank/ -- choose a name more distinct than "St Marys Foodbank"',
    );
    expect(insertCalls).toHaveLength(0);
  });

  it("creates and redirects when the name is free", async () => {
    seed("Brixton Food Bank");

    const res = await adminFoodbankNew(makeContext({ method: "POST", form: body({ name: "Camden Food Bank" }) }));

    // gfadmin/views.py:817-858 redirects to the detail page on success, at
    // the post-save slug.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/foodbank/camden-food-bank/");
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ name: "Camden Food Bank" });
  });

  it("re-renders rather than 500ing when the INSERT fails anyway", async () => {
    // The check is the guard; this is the backstop behind it. Two admins can
    // still take the same name between the SELECT and the INSERT, and D1 has
    // its own ways to refuse a write -- neither may reach app.onError, or the
    // admin loses all 30 fields to the 500 page, which is what github #12 is
    // actually about. Deliberately NOT worded as a duplicate: this catch no
    // longer knows what went wrong, and telling someone to hunt for a
    // duplicate that a NOT NULL violation caused wastes their afternoon.
    writeError = new Error("D1_ERROR: UNIQUE constraint failed: foodbank.name");

    const res = await adminFoodbankNew(makeContext({ method: "POST", form: body({ name: "Camden Food Bank" }) }));

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(lastRender().error).toBe(
      "Could not create food bank -- the database refused the save, so nothing was created. Check the name is not already in use and try again.",
    );
    expect(lastRender().foodbank).toMatchObject({ name: "Camden Food Bank", place_id: "ChIJ-lookup-result" });
    // The raw SQLite text is logged, never rendered.
    expect(String(lastRender().error)).not.toContain("D1_ERROR");
  });

  it("still reports the ordinary required-field error", async () => {
    // The uniqueness lookups run after the cheap local validation, so an
    // incomplete form is answered without touching D1 -- and, more to the
    // point, the new check did not displace the old error.
    const res = await adminFoodbankNew(makeContext({ method: "POST", form: body({ name: "" }) }));

    expect(res.status).toBe(400);
    expect(lastRender().error).toBe("Name is required");
    expect(queries).toHaveLength(0);
  });
});

describe("adminFoodbankEdit", () => {
  it("allows a save that keeps the row's own name", async () => {
    // THE regression exceptId exists for. The full form posts all 30 fields
    // including the unchanged name, so a check that did not exclude the row
    // being edited would reject every ordinary save -- fixing a 500-on-rename
    // by breaking every other edit instead.
    seed("Brixton Food Bank");

    const res = await adminFoodbankEdit(
      makeContext({
        method: "POST",
        params: { slug: "brixton-food-bank" },
        form: body({ name: "Brixton Food Bank", phone_number: "020 7946 1111" }),
      }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/foodbank/brixton-food-bank/");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ id: 1, fields: { phone_number: "02079461111" } });

    // The row being edited was passed as the exclusion, on both lookups.
    expect(queries.map((q) => q.params[1])).toEqual([1, 1]);
  });

  it("allows a genuine rename", async () => {
    seed("Brixton Food Bank");

    const res = await adminFoodbankEdit(
      makeContext({ method: "POST", params: { slug: "brixton-food-bank" }, form: body({ name: "Brixton & Herne Hill Food Bank" }) }),
    );

    // Foodbank.save() re-slugifies the name, so the redirect must use the
    // POST-SAVE slug (gfadmin/views.py:836) -- the slug read before the write
    // is already stale.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/foodbank/brixton-herne-hill-food-bank/");
  });

  it("blocks a rename onto another row's name and keeps the typed values", async () => {
    seed("Brixton Food Bank", "Camden Food Bank");

    const res = await adminFoodbankEdit(
      makeContext({
        method: "POST",
        params: { slug: "camden-food-bank" },
        form: body({ name: "Brixton Food Bank", notes: "Merged with Brixton" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(lastRender().error).toBe('Foodbank with this Name already exists: "Brixton Food Bank"');
    expect(lastRender().foodbank).toMatchObject({ name: "Brixton Food Bank", notes: "Merged with Brixton" });

    // Rejected means rejected: Camden is untouched, not half-saved.
    expect(updateCalls).toHaveLength(0);
    expect(rows.map((r) => r.name)).toEqual(["Brixton Food Bank", "Camden Food Bank"]);
  });

  it("re-renders rather than 500ing when the UPDATE fails anyway", async () => {
    // The create path has had a backstop around its write since before the
    // uniqueness checks existed; the edit path had none, so the race the
    // check cannot close -- another admin taking the name between the SELECT
    // and the UPDATE -- still threw the admin at the 500 page with 30 typed
    // fields on it. Same outcome as the create path now: the bound form back,
    // at the same 400 every other validation failure uses.
    seed("Brixton Food Bank");
    writeError = new Error("D1_ERROR: UNIQUE constraint failed: foodbank.name");

    const res = await adminFoodbankEdit(
      makeContext({
        method: "POST",
        params: { slug: "brixton-food-bank" },
        form: body({ name: "Brixton Food Bank", notes: "Typed by hand, and expensive to retype" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(lastRender().error).toBe(
      "Could not save this food bank -- the database refused the change, so nothing was saved. Check the name is not already in use and try again.",
    );
    expect(lastRender().foodbank).toMatchObject({ name: "Brixton Food Bank", notes: "Typed by hand, and expensive to retype" });
    expect(String(lastRender().error)).not.toContain("D1_ERROR");
  });

  it("does not resolve the discrepancy that sent the admin here when the save is rejected", async () => {
    // The second entry point into this handler: the dashboard's discrepancy
    // list posts the same form back with ?discrepancy=<id> attached, and a
    // successful save both writes the row and marks the discrepancy Done
    // (gfadmin/views.py:830-834). A REJECTED save must do neither -- marking
    // it Done would retire the flag while the data it complained about is
    // still wrong, and 302 to /admin/ would look like the save worked.
    seed("Brixton Food Bank", "Camden Food Bank");

    const res = await adminFoodbankEdit(
      makeContext({
        method: "POST",
        params: { slug: "camden-food-bank" },
        query: { discrepancy: "7" },
        form: body({ name: "Brixton Food Bank" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(updateCalls).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
  });

  it("blocks a rename whose slug collides with another row's", async () => {
    seed("St. Mary's Foodbank", "Camden Food Bank");

    const res = await adminFoodbankEdit(
      makeContext({ method: "POST", params: { slug: "camden-food-bank" }, form: body({ name: "St Marys Foodbank" }) }),
    );

    expect(res.status).toBe(400);
    expect(lastRender().error).toContain("/needs/at/st-marys-foodbank/");
    expect(updateCalls).toHaveLength(0);
  });
});

describe("adminFoodbankPartialEdit", () => {
  it("saves a partial form that posts no name at all", async () => {
    // The 4 collapsed partial forms (address/phone/email/fsa-id) can touch
    // neither index, because parseAdminFields only ever reads the spec list's
    // own field names -- a hand-crafted POST carrying someone else's `name`
    // is dropped before it reaches the SET clause. The check must not fire
    // for them: a version keyed off the food bank's STORED name rather than
    // the posted one would reject every phone-number edit ever made.
    seed("Brixton Food Bank");

    const res = await adminFoodbankPartialEdit(
      makeContext({
        method: "POST",
        params: { slug: "brixton-food-bank", form: "phone" },
        form: { csrf_token: "test-token", phone_number: "020 7946 2222", secondary_phone_number: "020 7946 3333" },
      }),
    );

    expect(res.status).toBe(302);
    expect(updateCalls).toHaveLength(1);
    expect(queries).toHaveLength(0);
  });
});
