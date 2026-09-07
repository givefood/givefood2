import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminFoodbankAddSub } from "./foodbankAddSub";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// gfadmin/views.py:1594-1612 foodbank_addsub, ported. The admin pastes a list
// of email addresses into a textarea and every one of them becomes a
// CONFIRMED subscriber -- a row that will be emailed, with no double opt-in.
// So the only interesting question this page raises is "what actually reached
// the table", and every assertion below that claims a save reads the row back
// out of SQLite rather than believing the response.
//
// WHY A REAL DATABASE AND NOT A STUBBED WRITER. Issue #34 (the location form
// parsing a Place ID, passing it down and writing it with no SQL at all, then
// redirecting as though it had worked) is the shape of failure this page is
// most exposed to: it has no validation the admin can see failing, no unique
// name to collide, and -- unlike every other admin form -- it does not
// re-render what was typed, so a write that silently does nothing looks
// exactly like a write that worked. getFoodbankBySlug and
// insertConfirmedSubscribers are therefore the SHIPPED implementations running
// their real SQL against Node's own SQLite, with the real UNIQUE indexes from
// migration 0004 in place. Nothing on the data path is faked.
//
// WHAT IS FAKED, AND ONLY THIS:
//   - render(), because packages/templates/src/generated/ is a gitignored
//     build artefact and importing the real one would make this suite fail on
//     a fresh checkout for reasons that have nothing to do with subscribers.
//     Asserting on the CONTEXT handed to admin/addsub.njk is also the more
//     direct claim -- "the page reports 3 added, 1 already, 2 rejected" is a
//     statement about `results`, not about markup. Same reasoning, same
//     spelling, as foodbankLocation.test.ts and foodbankLocationArea.test.ts.
//   - adminPageContext(), which imports @givefood/templates and so cannot
//     survive that mock. Its one argument IS asserted (the nav section).
//   - the SESSIONS KV namespace, which is a network service.
// The CSRF check is NOT faked: verifyCsrf runs for real against a real signed
// cookie built with the real HMAC, so the refusal tests below are refusals the
// shipped code performs rather than refusals a stub agreed to.

const mocks = vi.hoisted(() => ({
  render: vi.fn(async (_template: string, _context: Record<string, unknown>) => "<html>addsub</html>"),
  adminPageContext: vi.fn(async (_c: unknown, _section: string) => ({ csrf_token: "irrelevant-here" }) as Record<string, unknown>),
}));

vi.mock("@givefood/templates", () => ({ render: mocks.render }));
vi.mock("./pageContext", () => ({ adminPageContext: mocks.adminPageContext }));

// migrations/0004_subscribers.sql:19-29 verbatim, minus the `foodbank_name`
// column that 0019_drop_foodbank_cache.sql:59 dropped -- so this fixture is
// the table production actually has, not the one the Django model describes.
// All four indexes are here and all four earn their place:
//   - sub_email_fb_uniq is what `ON CONFLICT(email, foodbank_id) DO NOTHING`
//     targets; without it the conflict clause does not even compile.
//   - sub_key_idx and unsub_key_idx are UNIQUE, which is what makes the
//     sixty-address paste below a real test of subscriberKeys.ts's per-row
//     nonce rather than decoration: identical keys are not a subtle
//     collision here, they abort the whole transaction.
//
// The `foodbank` table is trimmed to the columns this path reads, following
// donationPoint.test.ts's precedent for workers/site fixtures. `latest_need_id`
// is NOT optional dressing: getFoodbankBySlug -> attachLatestNeed
// (packages/db/src/foodbank.ts:104) skips its second query only when that
// value is exactly `null`, and a missing column reads as `undefined`, which
// would send it looking for a foodbankchange table that is not here.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 0,
  latest_need_id INTEGER
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);
CREATE TABLE foodbanksubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL, last_contacted TEXT,
  foodbank_id INTEGER NOT NULL,
  email TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
  sub_key TEXT NOT NULL, unsub_key TEXT NOT NULL
);
CREATE UNIQUE INDEX sub_email_fb_uniq ON foodbanksubscriber(email, foodbank_id);
CREATE INDEX sub_fb_confirmed_idx ON foodbanksubscriber(foodbank_id, confirmed);
CREATE UNIQUE INDEX sub_key_idx ON foodbanksubscriber(sub_key);
CREATE UNIQUE INDEX unsub_key_idx ON foodbanksubscriber(unsub_key);
`;

const SALISBURY = { id: 1, name: "Salisbury", slug: "salisbury" };
const DEVIZES = { id: 2, name: "Devizes", slug: "devizes" };

type Bindable = null | number | bigint | string | Uint8Array;

interface Sent {
  sql: string;
  params: Bindable[];
}

// node:sqlite behind the slice of the D1 Sessions API this path uses:
// prepare().bind().first() for getFoodbankBySlug, and batch() for
// insertConfirmedSubscribers. The SQL text, the parameter binding, the UNIQUE
// indexes and the conflict resolution are SQLite's in both; async-vs-sync is
// the only difference that matters, and it is the one this adapter exists to
// bridge.
//
// bind() returns a NEW statement rather than mutating the receiver, matching
// D1's immutable prepared statements -- an adapter that mutated in place would
// let the last address in a paste overwrite every earlier one's bindings and
// quietly turn a sixty-address add into sixty copies of the last address,
// which every count assertion in this file would still accept.
//
// batch() runs inside a TRANSACTION because D1's does, and that is the whole
// reason packages/db builds one instead of awaiting N inserts. Django's loop
// (views.py:1602-1608) had no transaction: a duplicate halfway down a pasted
// list committed everything above it, 500ed, and never attempted anything
// below. Modelling the transaction is what makes "nothing at all was written"
// assertable here rather than asserted about somewhere else.
function d1Session(db: DatabaseSync, log: { batches: Sent[][] }) {
  function statement(sql: string, params: Bindable[]) {
    return {
      sql,
      params,
      bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
      first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
      run: async () => {
        const { changes } = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(changes) } };
      },
    };
  }
  return {
    prepare: (sql: string) => statement(sql, []),
    getBookmark: () => null,
    async batch(statements: ReturnType<typeof statement>[]) {
      log.batches.push(statements.map((s) => ({ sql: s.sql, params: s.params })));
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => {
          const { changes, lastInsertRowid } = db.prepare(s.sql).run(...s.params);
          return { success: true, results: [], meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) } };
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "a".repeat(64);
const SUBSCRIBER_SALT = "test-salt";

// lib/adminAuth.ts:61 and :250-252. Spelled out rather than imported because
// neither the cookie name nor the key prefix is exported -- and pinning them
// here means a rename that broke every admin's session would fail a test
// instead of failing a login.
const SESSION_COOKIE = "__Host-gfsession";
const SESSION_ID = "test-admin-session-id";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let log: { batches: Sent[][] };
let env: AppEnv["Bindings"];
let app: Hono<AppEnv>;
let kvPuts: number;

interface SubscriberRow {
  id: number;
  created: string;
  last_contacted: string | null;
  foodbank_id: number;
  email: string;
  confirmed: number;
  sub_key: string;
  unsub_key: string;
}

// Spread into plain objects: node:sqlite hands back null-prototype rows, which
// toEqual reports unhelpfully.
function subscribers(): SubscriberRow[] {
  return db
    .prepare("SELECT * FROM foodbanksubscriber ORDER BY id")
    .all()
    .map((row) => ({ ...row }) as unknown as SubscriberRow);
}

function emails(): string[] {
  return subscribers().map((row) => row.email);
}

// An existing row that reached the table by some route OTHER than this page --
// the one-off Postgres copy, or the public double opt-in flow in
// routes/wfbn/updates.ts. Its keys are deliberately unlike anything this page
// mints, so "the existing row was left alone" is checkable byte for byte.
function seedSubscriber(row: { foodbankId: number; email: string; confirmed: number; subKey: string; unsubKey: string }): void {
  db.prepare("INSERT INTO foodbanksubscriber (created, foodbank_id, email, confirmed, sub_key, unsub_key) VALUES (?, ?, ?, ?, ?, ?)").run(
    "2026-09-05 19:28:08.853000",
    row.foodbankId,
    row.email,
    row.confirmed,
    row.subKey,
    row.unsubKey,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.render.mockResolvedValue("<html>addsub</html>");
  mocks.adminPageContext.mockResolvedValue({ csrf_token: "irrelevant-here" });

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  for (const fb of [SALISBURY, DEVIZES]) {
    db.prepare("INSERT INTO foodbank (id, name, slug, is_closed, latest_need_id) VALUES (?, ?, ?, 0, NULL)").run(fb.id, fb.name, fb.slug);
  }

  log = { batches: [] };
  kvPuts = 0;
  const stored = JSON.stringify({
    email: "someone@givefood.org.uk",
    name: "Some One",
    givenName: "Some",
    picture: "",
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  env = {
    DB: { withSession: () => d1Session(db, log) },
    SESSIONS: {
      get: async (key: string) => (key === `admin-session:${SESSION_ID}` ? stored : null),
      put: async () => {
        kvPuts++;
      },
    },
    CSRF_SECRET,
    SUBSCRIBER_SALT,
  } as unknown as AppEnv["Bindings"];

  // The production wiring: routes/admin/index.ts:85 gates the whole sub-app
  // with requireAdminAuth, and :271-272 registers GET and POST on the same
  // path against the same function. Both matter -- the GET/POST split inside
  // one handler is where "a GET must not write" lives, and mounting the real
  // gate is what makes the unauthenticated test below a test of the shipped
  // middleware rather than of a stub that agreed with it.
  app = new Hono<AppEnv>();
  app.use("*", requireAdminAuth);
  app.get("/admin/foodbank/:slug/addsub/", adminFoodbankAddSub);
  app.post("/admin/foodbank/:slug/addsub/", adminFoodbankAddSub);
  // A 500 caught and labelled rather than left to surface as a vitest crash,
  // so a regression reads as "expected 200, got 500: <message>".
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
});

// Only the key tests at the bottom freeze the clock and pin the nonce, but the
// restore lives here rather than inside them: a stopped Date leaking into the
// next test would make its keys collide on the UNIQUE index and fail it for a
// reason that has nothing to do with what it is testing.
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface RequestOptions {
  /** Omit the hidden csrf_token field entirely, as a cross-site form would. */
  omitToken?: boolean;
  /** Send a token that is not the cookie's raw value. */
  token?: string;
  /** Send no __Host-csrf cookie at all. */
  omitCsrfCookie?: boolean;
  /** Sign the cookie with the wrong secret, as a subdomain-planted one would be. */
  forgeCookieSignature?: boolean;
  /** Send no admin session cookie -- an unauthenticated request. */
  signedOut?: boolean;
  origin?: string;
}

async function cookieHeader(options: RequestOptions): Promise<string> {
  const signature = await hmacSha256Hex(options.forgeCookieSignature ? "not-the-secret" : CSRF_SECRET, CSRF_RAW);
  const parts: string[] = [];
  if (!options.signedOut) parts.push(`${SESSION_COOKIE}=${SESSION_ID}`);
  if (!options.omitCsrfCookie) parts.push(`__Host-csrf=${CSRF_RAW}.${signature}`);
  return parts.join("; ");
}

async function post(path: string, fields: Record<string, string>, options: RequestOptions = {}): Promise<Response> {
  const body = new URLSearchParams(fields);
  if (!options.omitToken) body.set("csrf_token", options.token ?? CSRF_RAW);
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: await cookieHeader(options),
        Origin: options.origin ?? ORIGIN,
        "Sec-Fetch-Site": options.origin && options.origin !== ORIGIN ? "cross-site" : "same-origin",
      },
      body: body.toString(),
    }),
    env,
    execCtx,
  );
}

async function get(path: string, options: RequestOptions = {}): Promise<Response> {
  return app.fetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: await cookieHeader(options) } }), env, execCtx);
}

const ADDSUB = "/admin/foodbank/salisbury/addsub/";

function lastRender(): { template: string; context: Record<string, unknown> } {
  const call = mocks.render.mock.calls.at(-1);
  if (!call) throw new Error("render() was never called");
  return { template: call[0], context: call[1] };
}

interface Results {
  added: number;
  already: number;
  duplicates: number;
  invalid: string[];
  invalid_total: number;
}

function results(): Results {
  const value = lastRender().context.results;
  if (!value) throw new Error("the page rendered no results block");
  return value as unknown as Results;
}

// ============================ the page itself ============================

describe("GET", () => {
  it("renders the paste form with no report and writes nothing", async () => {
    const res = await get(ADDSUB);

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/addsub.njk");
    // `results` is null, not absent: admin/addsub.njk:37 gates the whole
    // report block on it, so a first visit must not show "0 added, 0 already
    // subscribed, 0 rejected" as though a submission had just happened.
    expect(lastRender().context.results).toBeNull();
    expect(subscribers()).toEqual([]);
  });

  // views.py:1597 computes this exact string and then throws it away
  // (`template_vars = {}` at :1611), so Django's own page never names the food
  // bank. The port passes it through, wording and all -- pinned here so that
  // "Add Subscriber" (singular, matching Django) does not drift into "Add
  // Subscribers" (which is what the page's <title> block says) by accident.
  it("names the food bank in the title Django computed and discarded", async () => {
    await get(ADDSUB);

    expect(lastRender().context.title).toBe("Add Subscriber to Salisbury Food Bank");
    expect((lastRender().context.foodbank as { slug: string }).slug).toBe("salisbury");
  });

  it("highlights the foodbanks section in the admin nav", async () => {
    await get(ADDSUB);

    expect(mocks.adminPageContext.mock.calls[0]?.[1]).toBe("foodbanks");
  });

  // views.py:1596's get_object_or_404. Asserted with a POST as well as a GET
  // because the 404 is the only thing standing between a mistyped slug and a
  // batch of confirmed subscribers attached to a food bank id of `undefined`.
  it("404s on an unknown slug without rendering or writing", async () => {
    expect((await get("/admin/foodbank/not-a-foodbank/addsub/")).status).toBe(404);
    expect((await post("/admin/foodbank/not-a-foodbank/addsub/", { emails: "ada@example.org" })).status).toBe(404);

    expect(mocks.render).not.toHaveBeenCalled();
    expect(subscribers()).toEqual([]);
  });

  // THE GET/POST SPLIT, which is a real correction rather than a formality.
  // Django's mutation branch is a bare `if request.POST:` (views.py:1599) with
  // no @require_POST, so its behaviour depended entirely on the request having
  // a POST body; this port keys off the METHOD instead. A GET carrying the
  // same field names -- which is exactly what a search-engine crawler,
  // a prefetching browser or a pasted URL produces -- must write nothing.
  it("does not write, whatever a GET puts in the query string", async () => {
    const res = await get(`${ADDSUB}?emails=ada%40example.org%0Agrace%40example.org&csrf_token=${CSRF_RAW}`);

    expect(res.status).toBe(200);
    expect(lastRender().context.results).toBeNull();
    expect(subscribers()).toEqual([]);
    // Not merely "no rows": no batch was even sent, so this cannot pass by
    // way of a write that happened and rolled back.
    expect(log.batches).toEqual([]);
  });

  // KILLS THE MUTANT `return c.html("")` -- the rendered page thrown away and
  // an empty 200 returned instead. Every other assertion in this file reads
  // the CONTEXT handed to render(), which proves what the page was asked to
  // say and nothing about what the browser received; without this one test
  // the whole file passes against a handler that renders the report perfectly
  // and then serves a blank body. Both exits are checked because they are the
  // same `return` reached two ways, and a future "redirect on POST" would
  // otherwise only be caught by its status.
  it("returns the rendered page as the body, on the GET and on the POST", async () => {
    mocks.render.mockResolvedValue("<html>the addsub page</html>");

    const got = await get(ADDSUB);
    expect(await got.text()).toBe("<html>the addsub page</html>");
    expect(got.headers.get("Content-Type")).toMatch(/text\/html/);

    const posted = await post(ADDSUB, { emails: "ada@example.org" });
    expect(await posted.text()).toBe("<html>the addsub page</html>");
    expect(posted.headers.get("Content-Type")).toMatch(/text\/html/);
  });
});

// ============================== the gates ==============================

describe("authentication", () => {
  // routes/admin/index.ts:85 gates the sub-app, and this page is one of the
  // few in the admin whose side effect is EMAILABLE: every row it writes is
  // confirmed=1, so an unauthenticated POST that got through would let anyone
  // subscribe anyone to a food bank's newsletter. The assertion is that the
  // handler was never reached, not just that the response was a redirect.
  it("bounces an unauthenticated POST to the sign-in page and writes nothing", async () => {
    const res = await post(ADDSUB, { emails: "ada@example.org" }, { signedOut: true });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2Faddsub%2F");
    expect(mocks.render).not.toHaveBeenCalled();
    expect(subscribers()).toEqual([]);
  });

  it("bounces an unauthenticated GET too", async () => {
    expect((await get(ADDSUB, { signedOut: true })).status).toBe(302);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // The read path must not extend the session on every page view -- KV allows
  // roughly one write per second per key, and lib/adminAuth.ts:287 only
  // re-puts past the halfway point. Cheap to assert here, and it is the kind
  // of regression nothing else would notice until the KV bill arrived.
  it("does not re-write the session on an ordinary request", async () => {
    await get(ADDSUB);

    expect(kvPuts).toBe(0);
  });
});

describe("CSRF", () => {
  // Django's CsrfViewMiddleware is commented out in production
  // (settings.py:97), so the {% csrf_token %} in addsub.html is decorative and
  // this whole block has no Django counterpart to match -- it is PLAN.md
  // §6.9 R3's correction. Each case asserts the 403 AND that the table is
  // untouched, because a refusal that still wrote would be the worse bug and
  // a status check alone cannot tell them apart.
  const REFUSALS: [string, RequestOptions][] = [
    ["no csrf_token field", { omitToken: true }],
    ["a csrf_token that does not match the cookie", { token: "b".repeat(64) }],
    ["an empty csrf_token", { token: "" }],
    ["no __Host-csrf cookie", { omitCsrfCookie: true }],
    ["a cookie signed with the wrong secret", { forgeCookieSignature: true }],
    ["a cross-site origin", { origin: "https://evil.example" }],
  ];

  for (const [description, options] of REFUSALS) {
    it(`refuses a POST with ${description}`, async () => {
      const res = await post(ADDSUB, { emails: "ada@example.org\ngrace@example.org" }, options);

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
      expect(subscribers()).toEqual([]);
      expect(log.batches).toEqual([]);
      // Not the form re-rendered with an error banner -- a plain text 403.
      // Pinned because it is a genuine divergence from how this admin handles
      // every other rejected save, and because the paste is lost with it.
      expect(mocks.render).not.toHaveBeenCalled();
    });
  }

  // The check has to let the real thing through, or the tests above would
  // pass against a handler that refused everything.
  it("accepts a POST whose token matches the signed cookie", async () => {
    const res = await post(ADDSUB, { emails: "ada@example.org" });

    expect(res.status).toBe(200);
    expect(emails()).toEqual(["ada@example.org"]);
  });

  // A missing CSRF_SECRET fails closed (lib/csrf.ts:107). On this page that
  // means a misconfigured deploy silently refuses every bulk add rather than
  // silently accepting anyone's.
  it("refuses everything when CSRF_SECRET is unset", async () => {
    env = { ...env, CSRF_SECRET: undefined } as unknown as AppEnv["Bindings"];

    const res = await post(ADDSUB, { emails: "ada@example.org" });

    expect(res.status).toBe(403);
    expect(subscribers()).toEqual([]);
  });
});

// ========================= the write actually happens =========================

describe("what reaches the table", () => {
  // ISSUE #34's QUESTION, ASKED OF THIS PAGE. The response is a 200 with a
  // report either way, so nothing about it distinguishes a save from a no-op:
  // only the row does. Every column is asserted, not just the address --
  // sub_key and unsub_key are adjacent TEXT columns of indistinguishable
  // hashes, so a transposed pair is invisible in the data and visible only in
  // what the emails then do (the confirm link unsubscribes, the unsubscribe
  // link 404s).
  it("stores one row per address, in the food bank named by the URL slug", async () => {
    const res = await post(ADDSUB, { emails: "ada@example.org\ngrace@example.org\nhedy@example.org" });

    expect(res.status).toBe(200);
    const rows = subscribers();
    expect(rows.map((row) => row.email)).toEqual(["ada@example.org", "grace@example.org", "hedy@example.org"]);
    expect(rows.every((row) => row.foodbank_id === SALISBURY.id)).toBe(true);
    expect(rows.every((row) => row.last_contacted === null)).toBe(true);
    // 16 lowercase hex characters, the shape Django's own
    // hashlib.sha256(...).hexdigest()[:16] produced
    // (models/subscribers.py:55-56) -- so a key minted here is
    // indistinguishable from a key minted before the port.
    expect(rows.every((row) => /^[0-9a-f]{16}$/.test(row.sub_key))).toBe(true);
    expect(rows.every((row) => /^[0-9a-f]{16}$/.test(row.unsub_key))).toBe(true);
    // Every key distinct, and no address's sub_key reused as its unsub_key.
    expect(new Set(rows.flatMap((row) => [row.sub_key, row.unsub_key])).size).toBe(6);
  });

  // THE ONE LITERAL THAT MAKES THIS PAGE DIFFERENT FROM THE PUBLIC SIGN-UP,
  // and the reason the template carries a consent warning. views.py:1606 sets
  // confirmed=True; subscribers.ts's public insertSubscriber hardcodes 0.
  // Flip this and the page still reports "3 added", the rows are still there,
  // and not one of them is ever listed (foodbankTabs.ts filters
  // `confirmed = 1`) or ever emailed. Nothing raises, nothing logs.
  it("marks every row confirmed, the documented escape hatch out of double opt-in", async () => {
    await post(ADDSUB, { emails: "ada@example.org" });

    expect(subscribers()[0]!.confirmed).toBe(1);
    // Not merely truthy: the column is INTEGER and the queries downstream
    // compare it to the literal 1, so a stored `true` or "1" would fail them.
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbanksubscriber WHERE foodbank_id = ? AND confirmed = 1").get(SALISBURY.id)).toMatchObject(
      { n: 1 },
    );
  });

  // The slug in the URL is the only thing that decides which food bank these
  // people are subscribed to, and getting it wrong is not recoverable by the
  // admin -- they would have to know it happened. Devizes is used here while
  // the pre-existing row belongs to Salisbury, so a handler that bound a
  // constant, or lost the id between the lookup and the insert, cannot pass.
  it("subscribes to the food bank in the URL, treating the same address elsewhere as separate", async () => {
    seedSubscriber({ foodbankId: SALISBURY.id, email: "ada@example.org", confirmed: 1, subKey: "salisbury-sub-1", unsubKey: "salisbury-uns-1" });

    await post("/admin/foodbank/devizes/addsub/", { emails: "ada@example.org" });

    expect(results().added).toBe(1);
    expect(subscribers().map((row) => [row.foodbank_id, row.email])).toEqual([
      [SALISBURY.id, "ada@example.org"],
      [DEVIZES.id, "ada@example.org"],
    ]);
    // The other food bank's row untouched -- same keys, same confirmed flag,
    // same created. A statement that thought it owned the address rather than
    // the (address, food bank) pair would have rewritten it.
    expect(subscribers()[0]).toEqual({
      id: 1,
      created: "2026-09-05 19:28:08.853000",
      last_contacted: null,
      foodbank_id: SALISBURY.id,
      email: "ada@example.org",
      confirmed: 1,
      sub_key: "salisbury-sub-1",
      unsub_key: "salisbury-uns-1",
    });
  });

  // SIXTY ADDRESSES IN ONE PASTE, which is an ordinary size for this page and
  // the reason subscriberKeys.ts takes a per-row nonce. Django's helper was
  // safe in a loop only because timezone.now() is microsecond-resolution and
  // each .save() was its own round trip; Date#toISOString() is
  // MILLISECOND-resolution, so minting sixty pairs inside one request very
  // often produced identical sub_key values. sub_key_idx and unsub_key_idx are
  // UNIQUE and the ON CONFLICT clause names only (email, foodbank_id), so such
  // a collision is not swallowed -- it aborts the transaction, 500s the page,
  // and (because nothing here re-renders the textarea) loses the paste.
  //
  // Delete the nonce from generateSubUnsubKeys and this test fails; no other
  // test in this file does, because every other paste is small enough that the
  // clock usually ticks between rows.
  it("mints a distinct key pair for every address in a large paste", async () => {
    const sixty = Array.from({ length: 60 }, (_, i) => `bulk${i}@example.org`);

    const res = await post(ADDSUB, { emails: sixty.join("\n") });

    expect(res.status).toBe(200);
    expect(results().added).toBe(60);
    expect(emails()).toEqual(sixty);
    const rows = subscribers();
    expect(new Set(rows.map((row) => row.sub_key)).size).toBe(60);
    expect(new Set(rows.map((row) => row.unsub_key)).size).toBe(60);
  });

  // One D1 round trip, not sixty -- and, more to the point, one TRANSACTION.
  // Django's bare save() loop is what made a mid-list failure commit half a
  // paste; asserting the batch is asserting that half-application is
  // structurally impossible here.
  it("sends one batch holding one statement per address", async () => {
    await post(ADDSUB, { emails: "ada@example.org\ngrace@example.org\nhedy@example.org" });

    expect(log.batches).toHaveLength(1);
    expect(log.batches[0]).toHaveLength(3);
  });

  // PLAN.md's risk register N1: the salt only affects newly minted keys'
  // format-consistency, never lookups, so a missing SUBSCRIBER_SALT must
  // degrade to "" rather than take the page out. The exact keys that fallback
  // produces are pinned below in "which key goes in which column", where the
  // clock is frozen and they can be stated as values.
  it("still mints keys when SUBSCRIBER_SALT is unset", async () => {
    env = { ...env, SUBSCRIBER_SALT: undefined } as unknown as AppEnv["Bindings"];

    const res = await post(ADDSUB, { emails: "ada@example.org" });

    expect(res.status).toBe(200);
    expect(/^[0-9a-f]{16}$/.test(subscribers()[0]!.sub_key)).toBe(true);
  });
});

// ===================== which key goes in which column =====================

// THE ONE HOLE THE FIRST DRAFT OF THIS FILE LEFT OPEN, found by mutation:
// swapping the two keys -- `subKey: k.unsubKey, unsubKey: k.subKey` in the
// handler, or the two same-typed bind parameters transposed one layer down in
// packages/db's `.bind(created, foodbankId, r.email, r.subKey, r.unsubKey)` --
// broke NOTHING. Every existing assertion about them is a shape check
// (/^[0-9a-f]{16}$/) or a distinctness check (six distinct values across three
// rows), and a transposed pair satisfies both perfectly. The rows look right,
// the report is right, the tests are green, and the damage only shows up in
// somebody's inbox: the "confirm your subscription" link now carries the
// unsubscribe key (so confirming 404s, or silently unsubscribes them) and
// every newsletter footer's unsubscribe link carries the confirm key. Both
// mutants were run; both survived; these tests are what kill them.
//
// The only way to tell the two columns apart from outside is to make the mint
// deterministic and state the digests. FROZEN, NONCE and the digests below are
// the SAME constants lib/subscriberKeys.test.ts:22-23,138-139,326-327 pins from
// the other side -- they were computed with Python's hashlib, the library
// Django itself hashed with. That file proves generateSubUnsubKeys produces
// them; this file is the only place that can prove which COLUMN each one
// reaches, which is the half a unit test of the helper cannot see.
const FROZEN = new Date("2026-09-05T19:28:08.853Z");
const NONCE = "11111111-2222-3333-4444-555555555555";

// Date only -- crypto.subtle.digest resolves on the microtask queue and must
// not be held by fake timers (same note as subscriberKeys.test.ts:20-21). The
// nonce is generateSubUnsubKeys's default parameter, `crypto.randomUUID()`, so
// pinning it means stubbing the global; subtle and getRandomValues are handed
// straight through because the CSRF check on the way in needs both.
function freezeClockAndNonce(): void {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN });
  // Captured through the bare global, not `globalThis.crypto`: this package
  // types its globals with @cloudflare/workers-types, which declares `crypto`
  // as an ambient const rather than a property of typeof globalThis, so the
  // dotted spelling is a tsc error even though it runs fine under vitest --
  // exactly the kind of break a green test run does not show.
  const real = crypto;
  vi.stubGlobal("crypto", {
    randomUUID: () => NONCE,
    subtle: real.subtle,
    getRandomValues: (array: Uint8Array) => real.getRandomValues(array),
  });
}

describe("which key goes in which column", () => {
  it("writes the sub- digest to sub_key and the unsub- digest to unsub_key", async () => {
    freezeClockAndNonce();

    await post(ADDSUB, { emails: "ada@example.org" });

    // Every column of the row this page wrote, as values. `created` is in
    // here too and is not decoration: it pins the Django-shaped
    // `2026-09-05 19:28:08.853000` that pyNow() produces rather than
    // toISOString()'s `...T19:28:08.853Z`, and D1 stores it as TEXT that
    // SQLite compares lexicographically -- a 'T' sorts after every space, so
    // one ISO-shaped row makes `ORDER BY created DESC` return it forever.
    expect(subscribers()).toEqual([
      {
        id: 1,
        created: "2026-09-05 19:28:08.853000",
        last_contacted: null,
        foodbank_id: SALISBURY.id,
        email: "ada@example.org",
        confirmed: 1,
        sub_key: "df8aef719f71a3c8",
        unsub_key: "dfff15f365043a52",
      },
    ]);
  });

  // The salt fallback, stated as values. `c.env.SUBSCRIBER_SALT ?? ""` is
  // NOT protection against a throw -- `${undefined}` interpolates as the
  // string "undefined" quite happily -- so dropping the `?? ""` produces
  // well-formed, unique, 16-char keys from a DIFFERENT template and every
  // shape-based assertion in this file stays green. That mutant was run and
  // survived the shape check this replaces. It matters little in production
  // (keys are looked up, never recomputed -- PLAN.md's risk register N1) and
  // is pinned anyway, because "the secret is missing" is exactly the state in
  // which nobody is checking, and these are the digests of the empty salt
  // that subscriberKeys.test.ts:326-327 pins from the helper's side.
  it("hashes an EMPTY salt, not the string 'undefined', when SUBSCRIBER_SALT is unset", async () => {
    env = { ...env, SUBSCRIBER_SALT: undefined } as unknown as AppEnv["Bindings"];
    freezeClockAndNonce();

    const res = await post(ADDSUB, { emails: "ada@example.org" });

    expect(res.status).toBe(200);
    expect(subscribers()[0]!.sub_key).toBe("0141eada32ad1ff9");
    expect(subscribers()[0]!.unsub_key).toBe("5c4a525edae906be");
  });

  // WHAT A KEY COLLISION ACTUALLY COSTS, pinned from the route's side. With
  // the clock stopped and the nonce fixed, two addresses mint the same pair --
  // which is precisely the state the port would be in if the nonce were ever
  // removed as redundant (Django had none) -- and sub_key_idx is UNIQUE, so
  // the second INSERT in the batch raises.
  //
  // Three facts, none of them assertable anywhere else:
  //   - it is fatal, not swallowed: a 500, not a cheerful "2 added".
  //   - NOTHING is written. Not even ada's row, which the first statement in
  //     the batch inserted successfully before the second one raised. The
  //     rollback itself is D1's contract, modelled by this file's d1Session
  //     adapter; what is being asserted HERE is that the handler puts every
  //     address in ONE batch and so gets that contract at all. A row-at-a-time
  //     loop -- which is what Django did (views.py:1602-1608) -- would leave
  //     ada committed, grace missing, and no record of which.
  //   - SUSPECT, PINNED AS-IS: the handler does not catch this. The admin
  //     gets a bare 500 and, because the page never echoes the textarea back
  //     (see "does not give the admin's paste back to the form"), the paste
  //     is gone -- issue #12's failure exactly. foodbankLocation.ts learned
  //     to catch its D1 errors; this handler has not.
  it("500s and writes nothing at all when two rows in one batch mint the same key", async () => {
    freezeClockAndNonce();

    const res = await post(ADDSUB, { emails: "ada@example.org\ngrace@example.org" });

    expect(res.status).toBe(500);
    expect(subscribers()).toEqual([]);
    // No report was rendered either: the throw escaped the handler before the
    // render call, so nothing told the operator which half of the paste, if
    // any, had landed.
    expect(mocks.render).not.toHaveBeenCalled();
  });
});

// ============================== parsing the paste ==============================

describe("splitting and normalising the paste", () => {
  // Python's str.splitlines() splits on all three, and a textarea submitted
  // from Windows sends \r\n -- so this is the ordinary case, not an exotic
  // one. The trim() that follows the split is what hides a wrong separator
  // set: split on /\n/ alone and each address arrives with a trailing \r
  // which trim() then removes, so CRLF survives by luck. A bare \r-separated
  // paste (old Mac line endings, and what some spreadsheet exports still
  // produce) does not: the whole paste becomes ONE line, fails EMAIL_RE, and
  // is reported back to the operator as a single invalid address. That is the
  // failure this case pins.
  it("splits on \\n, \\r\\n and \\r alike", async () => {
    await post(ADDSUB, { emails: "ada@example.org\r\ngrace@example.org\rhedy@example.org\nlynn@example.org" });

    expect(emails()).toEqual(["ada@example.org", "grace@example.org", "hedy@example.org", "lynn@example.org"]);
    expect(results().invalid_total).toBe(0);
  });

  // Django never stripped, so "  ada@example.org " was stored WITH its spaces
  // -- and since EmailField validation only runs through a ModelForm and this
  // view builds the model directly, nothing complained. A stored address with
  // a leading space is not deliverable and does not match the same address
  // pasted cleanly next time, so it also defeats the duplicate check forever.
  it("trims each line, the way Django did not", async () => {
    await post(ADDSUB, { emails: "  ada@example.org  \n\tgrace@example.org\t" });

    expect(emails()).toEqual(["ada@example.org", "grace@example.org"]);
  });

  // models/subscribers.py:42-43 lowercases in save(), BEFORE unique_together
  // ever sees the value. The port does it in the handler instead
  // (packages/db does not lowercase -- see adminSubscribers.test.ts), so this
  // assertion is the whole of that guarantee for the admin path.
  it("lowercases each address, as Django's save() did", async () => {
    await post(ADDSUB, { emails: "Ada@Example.ORG" });

    expect(emails()).toEqual(["ada@example.org"]);
  });

  // A blank line in Django became email="" on a model built directly, which a
  // bare .save() wrote happily: a subscriber row with no address, unique
  // against every other food bank's blank row and impossible to unsubscribe.
  // Trailing newlines are what every paste ends with, so this is the common
  // case, not an edge one.
  it("ignores blank and whitespace-only lines instead of storing empty addresses", async () => {
    await post(ADDSUB, { emails: "\n\nada@example.org\n   \n\t\ngrace@example.org\n\n" });

    expect(emails()).toEqual(["ada@example.org", "grace@example.org"]);
    // Not counted as rejections either -- the page's help text promises
    // "blank lines are ignored", and reporting them as rejected would make
    // every ordinary paste look partly broken.
    expect(results()).toMatchObject({ added: 2, already: 0, duplicates: 0, invalid_total: 0 });
  });

  // A paste of nothing but blank lines must not reach the database at all.
  // The early return in insertConfirmedSubscribers is what makes this true;
  // asserting the batch log rather than the row count is what distinguishes
  // "no round trip" from "a round trip that inserted nothing".
  it("makes no database round trip for an empty textarea", async () => {
    const res = await post(ADDSUB, { emails: "\n   \n\n" });

    expect(res.status).toBe(200);
    expect(log.batches).toEqual([]);
    expect(results()).toMatchObject({ added: 0, already: 0, duplicates: 0, invalid_total: 0 });
  });

  // views.py:1600-1601 is `request.POST.get("emails").splitlines()`, so a POST
  // without the field made that None.splitlines() -- an unhandled
  // AttributeError and a 500. Reachable from any form change that renamed the
  // textarea, and from anything posting to this URL by hand. Defaulting to ""
  // removes it; this is the test that says the 500 is gone rather than moved.
  it("reports an empty result instead of 500ing when the emails field is missing entirely", async () => {
    const res = await post(ADDSUB, {});

    expect(res.status).toBe(200);
    expect(results()).toMatchObject({ added: 0, already: 0, duplicates: 0, invalid_total: 0 });
    expect(subscribers()).toEqual([]);
  });

  // KILLS THE MUTANT that falls back to the QUERY STRING when the form field
  // is absent (`c.req.query("emails") ?? ""`) -- the obvious-looking repair
  // for the missing-field case above, and the one the GET test further up
  // cannot catch because a GET never enters this branch at all. It matters
  // because the query string is the half of a URL that gets logged, cached,
  // shared in a bug report and prefetched: a POST target that honours it
  // turns "somebody opened a link" into "somebody subscribed a stranger",
  // and every one of those addresses is written confirmed=1.
  it("ignores an emails value in the POST's own query string", async () => {
    const res = await post(`${ADDSUB}?emails=${encodeURIComponent("mallory@example.org")}`, {});

    expect(res.status).toBe(200);
    expect(results()).toMatchObject({ added: 0, already: 0, duplicates: 0, invalid_total: 0 });
    expect(subscribers()).toEqual([]);
    expect(log.batches).toEqual([]);
  });
});

// ============================== validation ==============================

describe("validating addresses", () => {
  // Django validated nothing here at all: "not an email" was accepted and
  // stored (PLAN.md:9724 prescribes the fix). EMAIL_RE is
  // /^[^\s@]+@[^\s@]+\.[^\s@]+$/ -- @givefood/models:70, the same validator the
  // public subscribe path uses, so an address the admin can add is exactly an
  // address a member of the public could have added themselves.
  it("rejects what EMAIL_RE rejects and accepts what it accepts", async () => {
    const paste = [
      "ada@example.org", // ordinary
      "a@b.c", // minimal, and accepted -- the regex checks shape, not TLDs
      "o'brien--@example.org", // apostrophes and comment markers are data, not SQL
      "notanemail", // no @
      "missing@tld", // no dot after the @
      "two@@example.org", // a second @ in the domain half
      "spaced out@example.org", // whitespace anywhere fails the character class
      "@example.org", // nothing before the @
    ].join("\n");

    await post(ADDSUB, { emails: paste });

    expect(emails()).toEqual(["ada@example.org", "a@b.c", "o'brien--@example.org"]);
    expect(results().invalid).toEqual(["notanemail", "missing@tld", "two@@example.org", "spaced out@example.org", "@example.org"]);
  });

  // Rejected lines come back in the case they were TYPED, not the lowercased
  // form the validator tested -- the operator has to be able to find the line
  // in whatever they pasted from, and "ADA@EXAMPLE" is not searchable as
  // "ada@example". The handler tests `email` (lowercased) but pushes `line`,
  // which is the distinction being pinned.
  it("reports a rejected line in the case the admin typed it", async () => {
    await post(ADDSUB, { emails: "  NotAnEmail  \nAda@Example.org" });

    expect(results().invalid).toEqual(["NotAnEmail"]);
    // Trimmed, though: the leading spaces are the page's doing, not theirs.
    expect(emails()).toEqual(["ada@example.org"]);
  });

  // The whole rejected list is a paste of the admin's own text rendered back
  // into the page, so it is the one place on this page an injection could
  // land. Nunjucks autoescapes, but that is the template's guarantee, not
  // this handler's -- what IS this handler's is that the raw line survives
  // unmangled, so the operator can recognise it. Pinned so that a future
  // "sanitising" pass here is a visible decision rather than a silent one.
  it("passes a rejected line through verbatim rather than mangling it", async () => {
    await post(ADDSUB, { emails: '<script>alert("x")</script>' });

    expect(results().invalid).toEqual(['<script>alert("x")</script>']);
  });
});

// ============================== the report ==============================

describe("the report the page shows", () => {
  // Django CANNOT report any of this: views.py:1609 redirects on success, so a
  // bare 302 is all it has to say "3 added, 1 already subscribed, 2 rejected"
  // with. Rendering the report instead is PLAN.md:9724's "report per-line
  // results", and this is the divergence in its most checkable form -- a 200
  // carrying numbers, not a redirect.
  it("re-renders the page with a report instead of Django's redirect", async () => {
    const res = await post(ADDSUB, { emails: "ada@example.org" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(lastRender().template).toBe("admin/addsub.njk");
  });

  it("counts new rows, existing subscriptions, in-paste repeats and rejections separately", async () => {
    seedSubscriber({ foodbankId: SALISBURY.id, email: "grace@example.org", confirmed: 1, subKey: "existing-sub-01", unsubKey: "existing-uns-01" });

    await post(ADDSUB, {
      emails: [
        "ada@example.org", // new
        "grace@example.org", // already subscribed
        "ada@example.org", // repeated within this paste
        "hedy@example.org", // new
        "notanemail", // rejected
        "also bad", // rejected
      ].join("\n"),
    });

    expect(results()).toMatchObject({ added: 2, already: 1, duplicates: 1, invalid_total: 2 });
    expect(results().invalid).toEqual(["notanemail", "also bad"]);
    expect(emails()).toEqual(["grace@example.org", "ada@example.org", "hedy@example.org"]);
  });

  // THE INVARIANT admin/addsub.njk:19-21 states in prose: the four numbers
  // account for every non-blank line submitted, so an operator can check the
  // total against what they pasted. It is also what the `duplicates` bucket
  // exists for -- those lines reach no insert, so without their own number
  // they would belong to none of the other three and simply vanish from the
  // report. Asserted arithmetically, over a paste that exercises all four
  // buckets at once, because any future rearrangement of the counting is
  // going to look locally reasonable and break exactly this.
  it("accounts for every non-blank line submitted", async () => {
    seedSubscriber({ foodbankId: SALISBURY.id, email: "grace@example.org", confirmed: 1, subKey: "existing-sub-01", unsubKey: "existing-uns-01" });
    const paste = [
      "",
      "ada@example.org",
      "GRACE@example.org",
      "  ada@example.org  ",
      "   ",
      "hedy@example.org",
      "nope",
      "grace@example.org",
      "still nope",
      "",
    ].join("\r\n");
    const nonBlankLines = paste.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;

    await post(ADDSUB, { emails: paste });

    const { added, already, duplicates, invalid_total } = results();
    expect(added + already + duplicates + invalid_total).toBe(nonBlankLines);
    // And the individual numbers, so this cannot pass by four errors
    // cancelling out. Seven non-blank lines: 2 added (ada, hedy), 1 already
    // subscribed (grace, seeded above), 2 repeated in the paste (ada a second
    // time with spaces round it, and grace a second time in another case --
    // both only visible as repeats because trimming and lowercasing happen
    // first), 2 rejected.
    expect(results()).toMatchObject({ added: 2, already: 1, duplicates: 2, invalid_total: 2 });
  });

  // Case-folding happens BEFORE the in-paste dedupe, matching what Django's
  // save() did before unique_together ever saw the value. If it did not, both
  // spellings would reach the insert, sub_email_fb_uniq uses SQLite's default
  // BINARY collation, and both would be stored -- one person, two
  // subscriptions, two different unsubscribe links, and a report saying "2
  // added" that is technically accurate and entirely wrong.
  it("treats differently-cased repeats in one paste as the same address", async () => {
    await post(ADDSUB, { emails: "Ada@Example.org\nada@example.org\nADA@EXAMPLE.ORG" });

    expect(results()).toMatchObject({ added: 1, already: 0, duplicates: 2, invalid_total: 0 });
    expect(emails()).toEqual(["ada@example.org"]);
  });

  // An address already subscribed is reported, not written -- and the
  // existing row is left byte-for-byte alone, because it may carry a sub_key
  // that has already been emailed to that person and an unsub_key printed in
  // every newsletter footer they have ever received.
  it("leaves an existing subscription completely untouched", async () => {
    seedSubscriber({ foodbankId: SALISBURY.id, email: "ada@example.org", confirmed: 1, subKey: "existing-sub-01", unsubKey: "existing-uns-01" });

    await post(ADDSUB, { emails: "ada@example.org" });

    expect(results()).toMatchObject({ added: 0, already: 1 });
    expect(subscribers()).toEqual([
      {
        id: 1,
        created: "2026-09-05 19:28:08.853000",
        last_contacted: null,
        foodbank_id: SALISBURY.id,
        email: "ada@example.org",
        confirmed: 1,
        sub_key: "existing-sub-01",
        unsub_key: "existing-uns-01",
      },
    ]);
  });

  // SUSPECT, PINNED AS-IS -- and it is worse at this layer than at the one
  // below it. packages/db's ON CONFLICT DO NOTHING leaves an UNCONFIRMED row
  // unconfirmed, which adminSubscribers.test.ts already flags. What this test
  // adds is what the operator is TOLD: the page says "already subscribed",
  // which on this page of all pages reads as "they are on the list", while the
  // person is still pending, still absent from foodbankTabs.ts's
  // `confirmed = 1` listing, and still receiving nothing. The one documented
  // manual escape hatch out of double opt-in silently does not apply to the
  // exact case an operator would reach for it -- somebody who signed up and
  // never clicked the link. Django's behaviour here was a 500, so there is no
  // parity answer to copy, and no fix is attempted here.
  it("reports 'already subscribed' for a pending sign-up that stays unconfirmed", async () => {
    seedSubscriber({ foodbankId: SALISBURY.id, email: "ada@example.org", confirmed: 0, subKey: "pending-sub-001", unsubKey: "pending-uns-001" });

    await post(ADDSUB, { emails: "ada@example.org" });

    expect(results()).toMatchObject({ added: 0, already: 1 });
    expect(subscribers()[0]!.confirmed).toBe(0);
  });

  // The display cap. `invalid` is sliced to 50 while `invalid_total` keeps the
  // real number, which admin/addsub.njk:50-52 renders as "... and N more".
  it("lists at most fifty rejected lines while still counting them all", async () => {
    const paste = Array.from({ length: 63 }, (_, i) => `rejected-line-${i}`).join("\n");

    await post(ADDSUB, { emails: paste });

    expect(results().invalid).toHaveLength(50);
    expect(results().invalid_total).toBe(63);
    // The FIRST fifty, in paste order -- an operator works down their list
    // from the top, and a slice from the wrong end would silently hide the
    // ones they are about to look for.
    expect(results().invalid[0]).toBe("rejected-line-0");
    expect(results().invalid[49]).toBe("rejected-line-49");
    expect(subscribers()).toEqual([]);
  });

  // SUSPECT, AND THE ONE PLACE THIS PAGE CAN LOSE THE ADMIN'S WORK.
  // admin/addsub.njk:62 renders `<textarea name="emails">` with no value, and
  // the handler passes nothing back for it -- so the paste is gone the moment
  // the page re-renders. That is normally harmless, because everything valid
  // was saved and everything rejected is listed; it stops being harmless past
  // the fiftieth rejection, where the addresses beyond the cap are named
  // nowhere and no longer in the box either. The same is true of a CSRF
  // refusal (403 plain text, above) and of any D1 failure, which this handler
  // does not catch at all -- unlike foodbankLocation.ts, which learned to.
  //
  // Pinned rather than fixed: the context keys are exactly what the page is
  // given, so a future change that starts echoing the paste back will fail
  // here and be a deliberate decision.
  it("does not give the admin's paste back to the form", async () => {
    await post(ADDSUB, { emails: "ada@example.org\nnotanemail" });

    const context = lastRender().context;
    expect(context.emails).toBeUndefined();
    expect(context.data).toBeUndefined();
    // Everything the handler puts in the context on top of adminPageContext's
    // own keys (stubbed here down to csrf_token) -- three, none of them the
    // paste. Every other admin form in this directory carries a `data` object
    // for exactly this purpose.
    expect(Object.keys(context).sort()).toEqual(["csrf_token", "foodbank", "results", "title"]);
  });
});

// ===================== a paste submitted twice =====================

// The double-submit case the template's own comment says the ON CONFLICT
// replaced a JS hack for: addsub.html carried
// onclick="this.form.submit();this.disabled = true;" as a crude guard, and it
// was dropped here. So a double-click, a refresh-on-POST, or an impatient
// second press must be harmless -- in Django it was an IntegrityError 500
// with the first press's rows already committed.
describe("submitting the same paste twice", () => {
  it("adds nothing the second time and says so, without touching the first pass's rows", async () => {
    const paste = "ada@example.org\ngrace@example.org";

    await post(ADDSUB, { emails: paste });
    const first = subscribers();
    expect(results()).toMatchObject({ added: 2, already: 0 });

    const res = await post(ADDSUB, { emails: paste });

    expect(res.status).toBe(200);
    expect(results()).toMatchObject({ added: 0, already: 2, duplicates: 0, invalid_total: 0 });
    // Identical rows, keys included: a DO UPDATE in place of DO NOTHING would
    // remint the keys here and break every confirm and unsubscribe link
    // already in someone's inbox, while reporting exactly the same numbers.
    expect(subscribers()).toEqual(first);
  });
});
