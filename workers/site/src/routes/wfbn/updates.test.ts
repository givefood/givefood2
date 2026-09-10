import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import { wfbnFoodbankUpdates } from "./updates";
import type { AppEnv } from "../../types";

// routes/wfbn/updates.ts -- the email subscription lifecycle for one food
// bank: subscribe, confirm, unsubscribe. ONE exported handler serving all
// three, exactly as Django's single `updates` view does
// (gfwfbn/views.py:1100-1200, read in full at
// /Users/jasoncartwright/Sites/foodcharity, along with
// givefood/models/subscribers.py's FoodbankSubscriber.save() and the four
// wfbn/emails/confirm{,ed}.{txt,html} templates).
//
// WHY THIS FILE IS AS LONG AS IT IS. Nothing on these three paths tells
// anybody when it goes wrong:
//
//   * A subscriber who never arrives is invisible. The page says "we've sent
//     an email to you" whether or not Postmark accepted it -- sendEmail()'s
//     boolean return is DISCARDED here -- so a broken POSTMARK_TOKEN looks
//     exactly like a working one from the visitor's side, and the only
//     symptom is a subscriber list that stops growing.
//   * The two keys are the entire security model. sub_key and unsub_key are
//     16 hex characters derived from a timestamp and a salt; get the
//     derivation wrong and every confirmation link in every mail already sent
//     stops working, silently, because the link 404s on a page nobody
//     monitors.
//   * Unsubscribe is a DELETE reachable by GET. It has to keep working (RFC
//     8058 one-click, whose exact bare-200 shape mail clients depend on) and
//     it must delete exactly one row.
//   * The turnstile-fail branch is a redirect that carries the visitor's own
//     email address back in a query string, which is the one piece of
//     personal data this route handles.
//
// REAL APP, REAL SCHEMA, REAL SQL, REAL TEMPLATES. `app` is the default
// export of workers/site/src/index.ts, so the method gates, the :action regex
// constraint, the locale registrations, the noStore mount and the 404 page
// are the shipped ones rather than a hand-built copy. The queries are the
// shipped packages/db functions running their real SQL against Node's own
// SQLite, with DDL from schemaFor() -- i.e. from the migrations, including
// the `foodbanksubscriber_full` VIEW all three lookups actually read through.
// The pages and the two emails come out of the real Nunjucks environment.
// Only what leaves the machine is stubbed: Turnstile's siteverify and
// Postmark's REST API.
//
// PARITY CLAIMS ARE RUN, NOT REASONED. Every "Django does X" below that
// concerns validate_email, HttpResponseForbidden, HttpResponse(status=200) or
// the `!= 0` in confirmed.html was executed under the reference repo's own
// virtualenv (Django 5.2.6, /Users/jasoncartwright/Sites/foodcharity/.venv)
// while writing this file. Where a claim was NOT run -- the ORM's treatment
// of `sub_key=None`, for instance -- the comment says so explicitly rather
// than inventing a citation.
//
// SIX TESTS BELOW PIN BEHAVIOUR THAT LOOKS WRONG. They assert what the code
// does today, are marked "SUSPECT, PINNED AS-IS", and each says why it was not
// "fixed" here. In rough order of how much they would cost somebody:
//
//   * a slashless GET of an unsubscribe link deletes the row inside
//     app.notFound()'s "does the slashed URL resolve?" HEAD probe, then
//     redirects the visitor to a URL that now 404s;
//   * a bare HEAD of an unsubscribe link deletes the row (Django's view has no
//     method decorator either, so this is faithful rather than new);
//   * two subscriptions minted in the SAME MILLISECOND collide on sub_key --
//     the keys have millisecond resolution here against Django's microseconds
//     -- and the loser is told "already subscribed to that food bank", which
//     is false, and can never subscribe;
//   * /updates/subscribeXYZ/ and /updates/confirmXYZ/ run the real action
//     despite the route's {subscribe|confirm|unsubscribe} constraint;
//   * confirming with a key belonging to another food bank sends a
//     confirmation email describing the food bank in the URL instead;
//   * a NULL no_donation_points hides the donation-points link that Django's
//     `!= 0` shows.

const ORIGIN = "https://www.givefood.org.uk";
const FORM = "application/x-www-form-urlencoded";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const POSTMARK = "https://api.postmarkapp.com/email";

// A FROZEN CLOCK, because the two keys are a pure function of it.
// generateSubUnsubKeys() hashes `new Date().toISOString()`, so pinning the
// clock turns "sub_key is 16 hex characters" -- which any wrong
// implementation also satisfies -- into an exact expected string, computed
// below by an INDEPENDENT implementation (node:crypto's OpenSSL SHA-256
// against the handler's Web Crypto one).
const NOW = new Date("2026-09-08T09:30:00.000Z");
const NOW_ISO = "2026-09-08T09:30:00.000Z";
// packages/db's pyNow() spelling of the same instant: Django's
// `str(datetime)`, space-separated, six fraction digits. This column is TEXT
// and compares LEXICOGRAPHICALLY against rows the Postgres extract wrote in
// that format, so a toISOString() creeping into insertSubscriber would sort
// every new subscriber after every migrated one ('T' 0x54 > ' ' 0x20) while
// looking perfectly normal in the admin.
const NOW_PY = "2026-09-08 09:30:00.000000";

const SALT = "test-subscriber-salt";

/** The keys FoodbankSubscriber.save()'s port must mint at NOW with `salt`. */
// The nonce lib/subscriberKeys.ts mints per call. Stubbed to a constant in
// beforeEach so these keys stay predictable; the point of the real one is
// that it is NOT, which is exactly what stops two same-millisecond
// subscribers minting the same key (github #27).
const NONCE = "00000000-0000-4000-8000-000000000000";

function expectedKeys(salt: string, iso: string = NOW_ISO): { subKey: string; unsubKey: string } {
  const hash = (input: string) => createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
  return { subKey: hash(`sub-${iso}-${NONCE}-${salt}`), unsubKey: hash(`unsub-${iso}-${NONCE}-${salt}`) };
}

type Bindable = null | number | bigint | string | Uint8Array;

interface Sent {
  sql: string;
  params: Bindable[];
}

let db: DatabaseSync;
/** Every statement PREPARED, in order -- including any never executed. */
let prepared: string[];
/** Every statement actually EXECUTED, with the values bound to it. */
let sent: Sent[];
/** When set, any statement whose SQL starts with this throws instead of running. */
let failOnPrefix: string | null;
/** Runs just before a statement starting with its key executes -- used to stage a genuine write race. */
let raceBefore: { prefix: string; run: () => void } | null;
/** Every outbound HTTP request the handler made, in order. */
let outbound: Array<{ url: string; body: string; headers: Record<string, string> }>;

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite -- the
// same shim mobsub.test.ts and locations.test.ts use, for the same reason: D1
// is async where node:sqlite is synchronous and that is the only difference
// that matters here. The SQL text, the binds, the UNIQUE constraint and its
// error message are SQLite's on both sides -- which is the point, because
// this handler's duplicate-subscriber path is written around catching that
// exact message.
//
// batch() is not optional: getFoodbankBySlug sends the food bank row and its
// latest need as ONE batch and indexes straight into the result array.
function d1Session(): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    sql,
    params,
    // Returns a NEW statement rather than mutating the receiver, exactly as
    // D1's prepared statements do; a shim that mutated in place would let one
    // bind of a request overwrite an earlier one and make a broken sequence
    // of queries look correct.
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      record(sql, params);
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      record(sql, params);
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      record(sql, params);
      const result = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql: string) => {
      prepared.push(sql);
      return statement(sql, []);
    },
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) =>
      statements.map((s) => {
        record(s.sql, s.params);
        return { results: db.prepare(s.sql).all(...s.params), success: true, meta: {} };
      }),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

function record(sql: string, params: Bindable[]): void {
  sent.push({ sql, params });
  if (raceBefore && sql.startsWith(raceBefore.prefix)) {
    const staged = raceBefore;
    raceBefore = null;
    staged.run();
  }
  if (failOnPrefix !== null && sql.startsWith(failOnPrefix)) {
    throw new Error("D1_ERROR: network connection lost");
  }
}

interface EnvOverrides {
  SUBSCRIBER_SALT?: string;
  TURNSTILE_SECRET?: string;
  POSTMARK_TOKEN?: string;
  SITE_DOMAIN?: string;
}

function env(overrides: EnvOverrides = {}): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session() },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
    SUBSCRIBER_SALT: SALT,
    TURNSTILE_SECRET: "test-turnstile-secret",
    POSTMARK_TOKEN: "test-postmark-token",
    ...overrides,
  } as unknown as AppEnv["Bindings"];
}

/**
 * Stubs the two real network calls and records them, so a test can assert on
 * what was SENT rather than only on what came back.
 *
 * An EMPTY turnstile token is always rejected regardless of `turnstile`,
 * because that is what the real endpoint does (`missing-input-response`) and a
 * stub that waved it through would let "the Turnstile check was deleted" pass
 * as a green run.
 */
function stubFetch({ turnstile = true, postmark = 200 }: { turnstile?: boolean | "throw"; postmark?: number } = {}): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    outbound.push({ url, body, headers: (init?.headers as Record<string, string>) ?? {} });
    if (url === SITEVERIFY) {
      if (turnstile === "throw") throw new TypeError("fetch failed");
      const submitted = new URLSearchParams(body).get("response") ?? "";
      return new Response(JSON.stringify({ success: turnstile === true && submitted.length > 0 }), { status: 200 });
    }
    if (url === POSTMARK) return new Response("{}", { status: postmark });
    throw new Error(`unexpected fetch to ${url}`);
  });
}

// ===========================================================================
// SEEDS
// ===========================================================================

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  altName?: string | null;
  country?: string;
  latLng?: string;
  noDonationPoints?: number | null;
  charityName?: string | null;
}

// Only the columns this page and the two emails read are parameterised; every
// other NOT NULL column gets a value the real migration accepts, so a seeded
// row is one production could have held.
function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
        network, charity_number, charity_just_foodbank, charity_name, contact_email,
        url, shopping_list_url, address_is_administrative, is_closed,
        no_locations, no_donation_points, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, ?, '12 High Street', 'SP2 8LZ', ?, ?,
        'Trussell', '1130237', 0, ?, ?,
        'https://example.org/', 'https://example.org/list/', 0, 0,
        2, ?, 14, '2019-06-01 09:00:00.000000', '2026-08-14 09:15:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.altName ?? null,
    s.slug,
    s.country ?? "England",
    s.latLng ?? "51.0688,-1.7945",
    s.charityName ?? null,
    `info@${s.slug}.invalid`,
    s.noDonationPoints === undefined ? 3 : s.noDonationPoints,
  );
}

interface SubscriberSeed {
  id: number;
  foodbankId: number;
  email: string;
  confirmed?: 0 | 1;
  subKey: string;
  unsubKey: string;
  created?: string;
}

function seedSubscriber(s: SubscriberSeed): void {
  db.prepare(
    `INSERT INTO foodbanksubscriber (id, created, last_contacted, foodbank_id, email, confirmed, sub_key, unsub_key)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(s.id, s.created ?? "2026-01-05 08:00:00.000000", s.foodbankId, s.email, s.confirmed ?? 0, s.subKey, s.unsubKey);
}

const SALISBURY = 1;
const CAERDYDD = 2;
const JERSEY = 3;

// The id a newly inserted subscriber gets. The seeds below claim 50-52 and
// SQLite hands an INTEGER PRIMARY KEY the current maximum plus one, so the
// row this handler writes is 53 -- spelled as a constant because every
// "what did subscribe() actually store" assertion reads it back by id.
const NEW_ID = 53;

// THE FIXTURE IS THE TEST. Each food bank turns exactly one branch on or off
// relative to its neighbour, and each seeded subscriber exists to be EXCLUDED
// by some lookup below -- a filter that stopped filtering passes every test
// that only seeds the row it expects to find.
//
//   1 salisbury     the ordinary case: England, three donation points
//   2 caerdydd      alt_name (full_name's Welsh branch) and NO donation
//                   points, which is the branch that removes a link from the
//                   confirmed email
//   3 jersey-town   country outside CHARITY_DETAIL_COUNTRIES, and a NULL
//                   no_donation_points -- the nullable half of that gate
//
//  50 pat@ salisbury, unconfirmed  -- the confirm path's happy row
//  51 alex@ salisbury, CONFIRMED   -- the "already confirmed, do nothing" row
//  52 pat@ caerdydd, unconfirmed   -- SAME EMAIL, different food bank: the
//                                     control for every dupe check, and the
//                                     row a cross-food-bank key must not hit
function seed(): void {
  seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury", charityName: "Salisbury Foodbank Trust" });
  seedFoodbank({ id: CAERDYDD, slug: "caerdydd", name: "Caerdydd", altName: "Banc Bwyd Caerdydd", country: "Wales", noDonationPoints: 0 });
  // Its lat_lng is PADDED and space-separated on purpose -- see the meta-tag
  // test at the bottom of this file. Production holds coordinates in both
  // shapes, and it is the only fixture that can tell Number() apart from the
  // raw substring.
  seedFoodbank({
    id: JERSEY,
    slug: "jersey-town",
    name: "Jersey Town",
    country: "Jersey",
    latLng: "49.18630, -2.10500",
    noDonationPoints: null,
    charityName: "Jersey Trust",
  });

  seedSubscriber({ id: 50, foodbankId: SALISBURY, email: "pat@example.org", subKey: "subkeypat0000001", unsubKey: "unsubkeypat00001" });
  seedSubscriber({ id: 51, foodbankId: SALISBURY, email: "alex@example.org", confirmed: 1, subKey: "subkeyalex000001", unsubKey: "unsubkeyalex0001" });
  seedSubscriber({ id: 52, foodbankId: CAERDYDD, email: "pat@example.org", subKey: "subkeypatcy00001", unsubKey: "unsubkeypatcy001" });
}

// Seeded per-test rather than in seed(), so that the three rows above stay the
// whole population for every "nothing else was touched" assertion in this file.
// Its id is above NEW_ID on purpose: it must not become the row a subscribe
// INSERT lands on.
function seedJerseySubscriber(): void {
  seedSubscriber({ id: 60, foodbankId: JERSEY, email: "chris@example.org", subKey: "subkeypatjy00001", unsubKey: "unsubkeypatjy001" });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.spyOn(crypto, "randomUUID").mockReturnValue(NONCE);
  db = new DatabaseSync(":memory:");
  // schemaFor, never hand-written DDL. All three subscriber lookups read
  // through the `foodbanksubscriber_full` VIEW and getFoodbankBySlug reads
  // `foodbankchange_full` unconditionally (github #51 -- eight suites 500'd at
  // once when it started doing so), so the fixture has to contain both views
  // and the tables underneath them.
  db.exec(schemaFor("foodbank", "foodbankchange", "foodbankchange_full", "foodbanksubscriber", "foodbanksubscriber_full"));
  prepared = [];
  sent = [];
  outbound = [];
  failOnPrefix = null;
  raceBefore = null;
  seed();
  stubFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

// ===========================================================================
// REQUEST AND READ-BACK HELPERS
// ===========================================================================

// `async`, not a bare arrow returning the call: app.request is typed
// `Response | Promise<Response>`, and awaiting inside is what narrows it.
const get = async (path: string, overrides?: EnvOverrides): Promise<Response> => app.request(`${ORIGIN}${path}`, {}, env(overrides), execCtx);

const post = async (path: string, fields: Record<string, string> | string, overrides?: EnvOverrides): Promise<Response> =>
  app.request(
    `${ORIGIN}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": FORM },
      body: typeof fields === "string" ? fields : new URLSearchParams(fields).toString(),
    },
    env(overrides),
    execCtx,
  );

/** A subscribe POST that passes Turnstile, for the food bank named. */
const subscribe = (slug: string, fields: Record<string, string>, overrides?: EnvOverrides): Promise<Response> =>
  post(`/needs/at/${slug}/updates/subscribe/`, { "cf-turnstile-response": "a-valid-token", ...fields }, overrides);

/** Every subscriber row, id order -- the source of truth for what was written. */
function subscribers(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM foodbanksubscriber ORDER BY id").all() as Array<Record<string, unknown>>;
}

function subscriber(id: number): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM foodbanksubscriber WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

/** The parsed body of each Postmark send, in order. */
function mails(): Array<Record<string, string | null>> {
  return outbound.filter((o) => o.url === POSTMARK).map((o) => JSON.parse(o.body) as Record<string, string | null>);
}

function siteverifies(): URLSearchParams[] {
  return outbound.filter((o) => o.url === SITEVERIFY).map((o) => new URLSearchParams(o.body));
}

// updates.njk renders the message, and ONLY the message, into the one
// `<div class="column is-6">` on the page. Sliced out rather than searched for
// across the whole document, so an assertion about what the visitor is told
// cannot be satisfied by the menu, the breadcrumb or the footer.
function messageOf(html: string): string {
  const match = /<div class="column is-6">\s*<p>([\s\S]*?)<\/p>/.exec(html);
  if (!match) throw new Error("no message block in the rendered page");
  return match[1] as string;
}

const ALREADY = "Sorry! That email address is already subscribed to that food bank.";

// ===========================================================================
// ROUTING -- none of it lives in updates.ts, all of it decides whether it runs
// ===========================================================================

describe("where the handler is mounted", () => {
  it("answers GET and POST, and refuses PUT, PATCH, DELETE and OPTIONS", async () => {
    // index.ts:336-337 registers app.get() AND app.post() for the same path,
    // because Django's `updates` carries only @csrf_exempt -- no
    // @require_POST, no @require_GET -- so both verbs reach the same view
    // there. The four below 404 here and would have RUN the view in Django
    // (which reads request.GET for the key regardless of method): a DIVERGENCE
    // on the status code, pinned because the half that matters -- a DELETE
    // request cannot reach the code that deletes rows -- is stricter here than
    // in the original.
    for (const action of ["subscribe", "confirm", "unsubscribe"]) {
      const path = `/needs/at/salisbury/updates/${action}/`;
      for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const res = await app.request(`${ORIGIN}${path}?key=unsubkeypat00001`, { method }, env(), execCtx);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    // Twelve requests, four of them naming a real unsub_key: nothing was
    // deleted, nothing was confirmed.
    expect(subscribers().map((r) => [r.id, r.confirmed])).toEqual([
      [50, 0],
      [51, 1],
      [52, 0],
    ]);
  });

  it("runs the whole GET handler for a HEAD, so a link checker can unsubscribe somebody", async () => {
    // SUSPECT, PINNED AS-IS. Hono routes HEAD to the GET handler, so a HEAD of
    // an unsubscribe link DELETES the row and answers 200 with an empty body.
    // Mail scanners, corporate link-rewriters and preview generators all issue
    // HEAD, and the unsub_key sits in the footer of every notification this
    // site sends.
    //
    // NOT a port regression: Django's `updates` has no method decorator
    // either, so a HEAD there runs the same view and deletes the same row --
    // and in both, a plain GET deletes by design. It is recorded because
    // "unsubscribed by a request nobody made" deserves to be someone's
    // decision rather than someone's discovery.
    const res = await app.request(`${ORIGIN}/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypat00001`, { method: "HEAD" }, env(), execCtx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(subscriber(50)).toBeUndefined();
  });

  it("does NOT fully constrain :action -- a suffix after subscribe/confirm still runs the action", async () => {
    // SUSPECT, PINNED AS-IS. index.ts constrains the segment
    // ({subscribe|confirm|unsubscribe}) rather than validating it in the
    // handler, and the constraint leaks: /updates/subscribeXYZ/ and
    // /updates/confirmXYZ/ both reach the handler with `action` equal to the
    // BARE action name, so those two branches really run.
    // /updates/unsubscribeXYZ/ does not, and neither does any other spelling
    // (see the next test).
    //
    // The condition was reproduced in isolation -- a scratch script outside
    // this repo, against the same Hono build: a two-route app consisting of
    // this route plus a plain `/needs/at/:slug/:locslug/` sibling is enough to
    // trigger it, and this app has that sibling (index.ts registers it
    // deliberately, last, for the food bank location pages). The mechanism is
    // inside Hono's RegExpRouter, not in anything this repo wrote.
    //
    // Consequence: an unbounded family of URLs that mutate state and render a
    // page. Not an authorisation hole -- confirming still needs a valid
    // sub_key -- but every one of them is a separate crawlable URL for a form
    // that should have exactly three.
    const suffixed = await get("/needs/at/salisbury/updates/confirmXYZ/?key=subkeypat0000001");

    expect(suffixed.status).toBe(200);
    expect(messageOf(await suffixed.text())).toBe("Great! Thank you for confirming your subscription.");
    expect(subscriber(50)?.confirmed).toBe(1);

    // The subscribe branch too: a GET carries no body, so it 403s exactly as
    // /updates/subscribe/ does rather than rendering a page.
    expect((await get("/needs/at/salisbury/updates/subscribeXYZ/")).status).toBe(403);
  });

  it("404s every other spelling, including the unsubscribe suffix and a capitalised action", async () => {
    // The other half of the leak, and the reason the test above is written as
    // a known shape rather than "the constraint does nothing": these all reach
    // the site's 404 page, and the live unsub_key in the query string changes
    // nothing on any of them.
    for (const action of ["", "resubscribe", "unsubscribeXYZ", "SUBSCRIBE", "delete", "sub"]) {
      const res = await get(`/needs/at/salisbury/updates/${action}/?key=unsubkeypat00001`);
      expect(res.status, action || "(empty)").toBe(404);
    }
    expect(subscribers().map((r) => r.id)).toEqual([50, 51, 52]);
  });

  it("serves the three prefixed locales and NOT /en/", async () => {
    // gfwfbn/urls/i18n.py:26 puts `updates` inside i18n_patterns, so Django
    // has a prefixed URL per language and an unprefixed default. index.ts's
    // LOCALES loop skips "en" for exactly that reason: English is the
    // unprefixed form, and /en/... has never been a URL on this site.
    for (const [prefix, expected] of [
      ["", 200],
      ["/cy", 200],
      ["/ga", 200],
      ["/gd", 200],
      ["/en", 404],
    ] as const) {
      const res = await get(`${prefix}/needs/at/salisbury/updates/confirm/?key=subkeypat0000001`);
      expect(res.status, prefix || "(unprefixed)").toBe(expected);
    }
  });

  it("404s an unknown food bank before doing anything else", async () => {
    // `if (!foodbank) return c.notFound()` is the FIRST thing after the
    // lookup, ahead of every action. Asserted with a real unsub_key in the
    // query string: a handler that ran the action before resolving the food
    // bank would delete a live subscription for a URL that does not exist.
    const res = await post("/needs/at/no-such-town/updates/unsubscribe/?key=unsubkeypat00001", "List-Unsubscribe=One-Click");

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("404 - Not Found");
    expect(subscribers()).toHaveLength(3);
    // Two statements only: getFoodbankBySlug's batch, and then nothing.
    expect(sent.map((s) => s.sql)).toEqual([
      "SELECT * FROM foodbank WHERE slug = ?",
      "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)",
    ]);
  });

  it("is marked uncacheable in every locale, and therefore carries no purge tag", async () => {
    // index.ts mounts middleware/noStore.ts on /needs/at/*/updates/* AND on a
    // per-locale copy of the same pattern (issue #32): Hono matches app.use()
    // against the path AS IT ARRIVES, and without the prefixed mounts
    // pageCacheControl filled the gap and stamped a MUTATING GET
    // `public, s-maxage=86400` -- the exact opposite of what this mount says,
    // on the same handler, differing by three characters of URL.
    //
    // CDN-Cache-Control is the load-bearing one: the zone gives HTML an edge
    // TTL of its own, so removing Cache-Control alone would not have stopped
    // the edge caching an unsubscribe confirmation and replaying it.
    for (const prefix of ["", "/cy", "/ga", "/gd"]) {
      const res = await get(`${prefix}/needs/at/salisbury/updates/confirm/?key=subkeyalex000001`);
      expect(res.headers.get("Cache-Control"), prefix).toBe("private, no-store, max-age=0, must-revalidate");
      expect(res.headers.get("CDN-Cache-Control"), prefix).toBe("no-store");
      expect(res.headers.get("Vary"), prefix).toBe("Cookie");
      // middleware/cacheTag.ts deliberately skips a private/no-store response:
      // there is nothing in any cache for a purge to remove. The food bank's
      // other pages DO carry `fb-salisbury`; this one must not, or a purge
      // would be reporting work it did not do.
      expect(res.headers.get("Cache-Tag"), prefix).toBeNull();
    }
  });

  it("UNSUBSCRIBES on a slashless GET and then redirects to a URL that 404s -- suspect, pinned as-is", async () => {
    // SUSPECT, AND THE SHARPEST THING IN THIS FILE. lib/appendSlash.ts answers
    // "does the slashed URL resolve?" by ISSUING THAT REQUEST -- a real HEAD
    // through the whole app -- and, as the HEAD test above establishes, a HEAD
    // runs the GET handler. So a request for the unsubscribe link WITHOUT its
    // trailing slash:
    //
    //   1. reaches app.notFound(),
    //   2. probes /needs/at/<slug>/updates/unsubscribe/?key=... with a HEAD,
    //      which DELETES the row,
    //   3. sees a 200 and 301s the visitor to that URL,
    //   4. where the key no longer matches anything, so the visitor lands on a
    //      404 page -- while actually having been unsubscribed.
    //
    // Slashless copies of these links are routine: mail clients, link
    // shorteners and anything that "tidies" a URL produce them. The visitor is
    // told the page does not exist and the subscription is gone; the operator
    // sees a 404 in the logs and a subscriber count that dropped.
    //
    // The probe is only meant to answer a routing question, which is why it
    // uses HEAD rather than GET -- the assumption being that HEAD is safe. It
    // is not here, and the same reasoning applies to every other mutating GET
    // on this site.
    const redirected = await get("/needs/at/salisbury/updates/unsubscribe?key=unsubkeypat00001");

    expect(redirected.status).toBe(301);
    // Absolute, and the query string survives -- a redirect that dropped ?key
    // would land the visitor on the 403 branch instead.
    expect(redirected.headers.get("Location")).toBe(`${ORIGIN}/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypat00001`);
    // The row is ALREADY gone, before the visitor has followed anything.
    expect(subscriber(50)).toBeUndefined();
    // And following the redirect gives them a 404.
    expect((await get("/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypat00001")).status).toBe(404);
  });

  it("404s a slashless POST rather than replaying it, so no one-click unsubscribe is re-issued as a GET", async () => {
    // lib/appendSlash.ts restricts APPEND_SLASH to GET/HEAD, a deliberate
    // deviation from Django (which 301s a POST too). Django's behaviour would
    // be worse here: a client following a 301 from a POST re-issues it as a
    // GET, so an RFC 8058 one-click unsubscribe would silently become the HTML
    // page instead of the bare 200 the client is waiting for -- and, with the
    // probe above in the picture, would delete the row on the way past.
    const posted = await post("/needs/at/salisbury/updates/unsubscribe?key=unsubkeypat00001", "List-Unsubscribe=One-Click");

    expect(posted.status).toBe(404);
    expect(posted.headers.get("Location")).toBeNull();
    expect(subscriber(50)).toBeDefined();
  });

  it("opens exactly one D1 session per request", async () => {
    // lib/session.ts's withSession("first-unconstrained") gives every query in
    // a request one snapshot of a replicated database. It matters MORE here
    // than on a read-only page: subscribe writes a row and confirm reads one
    // it may have just written, and a second session could be served by a
    // replica that has not caught up -- which would look like a subscription
    // that vanished the instant it was made.
    let sessions = 0;
    const counting = {
      ...env(),
      DB: {
        withSession: () => {
          sessions += 1;
          return d1Session();
        },
      },
    } as unknown as AppEnv["Bindings"];

    await app.request(`${ORIGIN}/needs/at/salisbury/updates/confirm/?key=subkeypat0000001`, {}, counting, execCtx);

    expect(sessions).toBe(1);
  });
});

// ===========================================================================
// SUBSCRIBE -- the email gate
// ===========================================================================

describe("subscribe refuses an address it cannot use", () => {
  // packages/models' EMAIL_RE stands in for Django's validate_email(), and
  // both answer 403 for everything in this list -- each value below was run
  // through validate_email under Django 5.2.6 in the reference repo's venv
  // while writing this test, and each raised ValidationError.
  const REJECTED = [
    ["empty", ""],
    ["no at-sign", "not-an-email"],
    ["no dot in the domain", "pat@localhost"],
    ["a space", "pat smith@example.org"],
    ["two at-signs", "pat@@example.org"],
    ["nothing before the at", "@example.org"],
    ["nothing after the dot", "pat@example."],
  ] as const;

  for (const [why, email] of REJECTED) {
    it(`403s ${why}`, async () => {
      const res = await subscribe("salisbury", { email });

      expect(res.status).toBe(403);
      expect(subscribers()).toHaveLength(3);
      // The refusal happens BEFORE Turnstile: no point spending a siteverify
      // round trip on a submission that cannot succeed, and Django's own
      // ordering is the same (validate_email, then validate_turnstile).
      expect(siteverifies()).toEqual([]);
      expect(mails()).toEqual([]);
    });
  }

  it("403s a bodyless GET, which is how the URL behaves when someone just visits it", async () => {
    // Django reads `request.POST.get("email")` regardless of method -- None on
    // a GET, which validate_email rejects (run under Django 5.2.6: both None
    // and "" raise). parseBody() is skipped entirely on a GET here and the
    // empty string fails EMAIL_RE identically. So /updates/subscribe/ typed
    // into a browser is a 403, not a form.
    const res = await get("/needs/at/salisbury/updates/subscribe/");

    expect(res.status).toBe(403);
    expect(subscribers()).toHaveLength(3);
  });

  it("403s with an EMPTY body -- the parity claim -- typed text/plain rather than Django's text/html", async () => {
    // The empty body is genuine parity: HttpResponseForbidden() carries b''
    // (constructed under Django 5.2.6 in the reference venv). The CONTENT TYPE
    // is not: Django reports `text/html; charset=utf-8` and
    // `new Response("", {status: 403})` gets undici's `text/plain;charset=UTF-8`.
    // Nothing reads either -- the body is empty both ways -- but it is a real
    // difference from the source this module cites, and it is pinned so that
    // "helpfully" adding an error message becomes a deliberate act.
    const res = await subscribe("salisbury", { email: "" });

    expect(await res.text()).toBe("");
    expect(res.headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
  });

  it("403s an email sent as a file part rather than a value", async () => {
    // `typeof body.email === "string"` is false for a File, so it degrades to
    // "" and 403s. Django puts uploads in request.FILES, never request.POST,
    // so validate_email(None) rejects there too -- the same answer by a
    // different route. What matters is that a File never reaches the INSERT
    // and gets stringified into the email column.
    const form = new FormData();
    form.set("email", new File(["pat@example.org"], "email.txt", { type: "text/plain" }));
    form.set("cf-turnstile-response", "a-valid-token");

    const res = await app.request(`${ORIGIN}/needs/at/salisbury/updates/subscribe/`, { method: "POST", body: form }, env(), execCtx);

    expect(res.status).toBe(403);
    expect(subscribers()).toHaveLength(3);
  });

  it("ACCEPTS an address Django rejects, because EMAIL_RE is deliberately not Django's validator", async () => {
    // SUSPECT, PINNED AS-IS. EMAIL_RE is `^[^\s@]+@[^\s@]+\.[^\s@]+$` and
    // packages/models says outright it is "not Django's exact
    // EmailValidator". It therefore admits characters Django's user-part regex
    // does not: validate_email("pat<script>@example.org") raises
    // ValidationError under Django 5.2.6 (run in the reference venv), and this
    // port stores the row and reflects the address back into the page.
    //
    // The reflection itself is SAFE -- updates.njk pipes the message through
    // `linebreaksbr`, which HTML-escapes first (packages/templates/src/filters.ts),
    // and the assertion below is what keeps it safe. The divergence is
    // recorded because the address also goes into a Postmark `To` header,
    // where the port is relying on Postmark to reject what it accepted.
    const res = await subscribe("salisbury", { email: "pat<script>@example.org" });

    expect(res.status).toBe(200);
    expect(subscriber(NEW_ID)?.email).toBe("pat<script>@example.org");
    // Escaped, not interpolated: the raw "<script>" never reaches the browser.
    expect(messageOf(await res.text())).toContain("pat&lt;script&gt;@example.org");
  });
});

// ===========================================================================
// SUBSCRIBE -- Turnstile
// ===========================================================================

describe("subscribe and the Turnstile gate", () => {
  it("sends the secret and the submitted token to siteverify, and nothing else", async () => {
    await subscribe("salisbury", { email: "new@example.org" });

    expect(siteverifies()).toHaveLength(1);
    const submitted = siteverifies()[0] as URLSearchParams;
    expect(submitted.get("secret")).toBe("test-turnstile-secret");
    expect(submitted.get("response")).toBe("a-valid-token");
    // The visitor's address is NOT sent to Cloudflare: the only personal data
    // on this path stays on this site.
    expect(submitted.get("email")).toBeNull();
  });

  it("redirects a failed challenge back to the food bank page, carrying the address typed", async () => {
    // Django: `HttpResponseRedirect("%s?turnstilefail=true&email=%s" % (reverse(...), email))`.
    // The food bank page reads both back to re-populate its form, so losing
    // either would make a failed challenge silently discard what the visitor
    // typed -- the exact failure middleware/pageCacheControl.ts records
    // happening on production on 2026-09-07 for /flag/.
    stubFetch({ turnstile: false });

    const res = await subscribe("salisbury", { email: "Sam@Example.org" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/needs/at/salisbury/?turnstilefail=true&email=Sam%40Example.org");
    // No row, no mail: a failed challenge subscribes nobody.
    expect(subscribers()).toHaveLength(3);
    expect(mails()).toEqual([]);
  });

  it("percent-encodes the address into the redirect, plus signs included", async () => {
    // encodeURIComponent(), not string concatenation: a "+" in a query string
    // decodes to a SPACE, so `sam+foodbank@example.org` would come back as
    // `sam foodbank@example.org` in the food bank page's form field and fail
    // EMAIL_RE on the retry. Django's own `%s` interpolation does NOT encode
    // it -- a divergence in this port's favour, and the reason this is
    // asserted as an exact string rather than a `toContain`.
    stubFetch({ turnstile: false });

    const res = await subscribe("salisbury", { email: "sam+foodbank@example.org" });

    expect(res.headers.get("Location")).toBe("/needs/at/salisbury/?turnstilefail=true&email=sam%2Bfoodbank%40example.org");
  });

  it("keeps the visitor in their own language on the way back", async () => {
    // urlForLocale(), not url(): Django's reverse() resolves against the
    // ACTIVE language inside i18n_patterns, so a Welsh visitor who fails the
    // challenge lands back on the Welsh page. A plain url() here would bounce
    // every non-English visitor into English at the one moment they are being
    // asked to try again.
    stubFetch({ turnstile: false });

    const res = await post("/cy/needs/at/caerdydd/updates/subscribe/", {
      email: "sam@example.org",
      "cf-turnstile-response": "a-valid-token",
    });

    expect(res.headers.get("Location")).toBe("/cy/needs/at/caerdydd/?turnstilefail=true&email=sam%40example.org");
  });

  it("treats a missing token as a failed challenge without asking Cloudflare", async () => {
    // The stub rejects an empty token the way the real endpoint does
    // (`missing-input-response`), so this exercises the real answer rather
    // than a shortcut. A form posted without the widget -- a bot, or a
    // visitor whose JavaScript never loaded -- gets the redirect, not a row.
    const res = await post("/needs/at/salisbury/updates/subscribe/", { email: "new@example.org" });

    expect(res.status).toBe(302);
    expect(subscribers()).toHaveLength(3);
  });

  it("fails CLOSED and says so in the log when TURNSTILE_SECRET is unset", async () => {
    // lib/turnstile.ts returns false without a secret -- correct, since
    // validation cannot pass without one -- and logs, because an unset secret
    // is otherwise indistinguishable in the Workers logs from a real visitor
    // submitting a bad token. This is the shape of the incident this tier
    // exists for: every submission silently fails until somebody thinks to
    // check that one binding.
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await subscribe("salisbury", { email: "new@example.org" }, { TURNSTILE_SECRET: undefined });

    expect(res.status).toBe(302);
    expect(logs).toHaveBeenCalledWith("TURNSTILE_SECRET not set -- failing validation closed");
    expect(subscribers()).toHaveLength(3);
  });

  it("fails closed when siteverify itself is unreachable", async () => {
    // validateTurnstile catches and returns false. A Cloudflare-side outage
    // therefore stops new subscriptions rather than letting them all through
    // -- pinned because the opposite (fail open) is a defensible design that
    // this code does NOT implement, and the difference is invisible until a
    // bot finds it.
    stubFetch({ turnstile: "throw" });

    const res = await subscribe("salisbury", { email: "new@example.org" });

    expect(res.status).toBe(302);
    expect(subscribers()).toHaveLength(3);
  });
});

// ===========================================================================
// SUBSCRIBE -- the row, and the two keys
// ===========================================================================

describe("subscribe writes the subscriber", () => {
  it("stores the whole row: lowercased address, unconfirmed, and Django's timestamp spelling", async () => {
    const res = await subscribe("salisbury", { email: "Sam@Example.ORG" });
    const keys = expectedKeys(SALT);

    expect(res.status).toBe(200);
    // The WHOLE row at once. sub_key and unsub_key are interchangeable
    // 16-character strings in the same column type, so only an all-at-once
    // comparison catches them being minted in the wrong order or bound the
    // wrong way round -- which would make every confirmation link an
    // unsubscribe link.
    expect(subscriber(NEW_ID)).toEqual({
      id: NEW_ID,
      created: NOW_PY,
      last_contacted: null,
      foodbank_id: SALISBURY,
      email: "sam@example.org",
      confirmed: 0,
      sub_key: keys.subKey,
      unsub_key: keys.unsubKey,
    });
  });

  it("derives both keys exactly as FoodbankSubscriber.save() does, salt included", async () => {
    // givefood/models/subscribers.py:44-57 -- sha256("sub-<now>-<salt>") and
    // sha256("unsub-<now>-<salt>"), each truncated to 16 hex characters. The
    // expectation is computed by node:crypto (OpenSSL) against the handler's
    // Web Crypto implementation, so this is a genuine cross-check of the
    // derivation and not a restatement of it.
    //
    // The SALT is the half that no other assertion in this file can see: a
    // build that dropped it would produce keys of exactly the right shape,
    // valid links, and a scheme anyone could compute offline from a
    // millisecond timestamp.
    await subscribe("salisbury", { email: "new@example.org" });

    const withSalt = expectedKeys(SALT);
    expect(subscriber(NEW_ID)?.sub_key).toBe(withSalt.subKey);
    expect(subscriber(NEW_ID)?.unsub_key).toBe(withSalt.unsubKey);
    // Different salt, different keys -- so the assertion above is really
    // reading the salt and not just the timestamp.
    expect(expectedKeys("a-different-salt").subKey).not.toBe(withSalt.subKey);
  });

  it("degrades a missing SUBSCRIBER_SALT to the empty string rather than throwing", async () => {
    // PLAN.md's risk register (N1), quoted in the module: the salt affects
    // only newly-minted keys' format-consistency, never lookups. An unset
    // binding must not 500 the subscribe form -- but it must also not be
    // silent about which keys it produced, hence the exact expectation.
    await subscribe("salisbury", { email: "new@example.org" }, { SUBSCRIBER_SALT: undefined });

    expect(subscriber(NEW_ID)?.sub_key).toBe(expectedKeys("").subKey);
  });

  it("mints two DIFFERENT 16-character hex keys", async () => {
    // The prefixes ("sub-" / "unsub-") are the only thing separating them.
    // Hashing the same string twice would give one value in both columns, and
    // then every confirmation link would also be a working unsubscribe link
    // -- one click, subscribed and immediately deleted.
    await subscribe("salisbury", { email: "new@example.org" });

    const row = subscriber(NEW_ID);
    expect(row?.sub_key).toMatch(/^[0-9a-f]{16}$/);
    expect(row?.unsub_key).toMatch(/^[0-9a-f]{16}$/);
    expect(row?.sub_key).not.toBe(row?.unsub_key);
  });

  it("lowercases for the STORED row while telling the visitor what they typed", async () => {
    // FoodbankSubscriber.save() lowercases before unique_together ever sees
    // the address; the Django VIEW's local `email` is never reassigned, so the
    // confirmation mail and the on-page message both keep the original case.
    // Reproduced verbatim rather than tidied -- and asserted in both
    // directions at once, because "lowercase everywhere" and "lowercase
    // nowhere" each satisfy half of it.
    const res = await subscribe("salisbury", { email: "Sam@Example.ORG" });

    expect(subscriber(NEW_ID)?.email).toBe("sam@example.org");
    expect(messageOf(await res.text())).toContain("Sam@Example.ORG");
    expect(mails()[0]?.To).toBe("Sam@Example.ORG");
  });

  it("subscribes against the food bank in the URL, not the first one in the table", async () => {
    // Three food banks are seeded and Salisbury is id 1, so a lookup that had
    // stopped filtering would still produce a working-looking subscription --
    // to the wrong food bank, whose needs the subscriber would then receive
    // forever.
    await subscribe("jersey-town", { email: "new@example.org" });

    expect(subscriber(NEW_ID)?.foodbank_id).toBe(JERSEY);
  });

  it("sends exactly four statements: the food bank batch, the dupe check, the INSERT", async () => {
    await subscribe("salisbury", { email: "New@Example.org" });

    expect(sent.map((s) => s.sql)).toEqual([
      "SELECT * FROM foodbank WHERE slug = ?",
      "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)",
      "SELECT * FROM foodbanksubscriber_full WHERE email = ? AND foodbank_id = ?",
      "INSERT INTO foodbanksubscriber (created, foodbank_id, email, confirmed, sub_key, unsub_key) VALUES (?, ?, ?, 0, ?, ?)",
    ]);
    // The dupe check is bound with the LOWERCASED address and the resolved
    // numeric id. Binding the raw one would miss a real duplicate, since
    // sub_email_fb_uniq only ever contains lowercase.
    expect(sent[2]?.params).toEqual(["new@example.org", SALISBURY]);
  });
});

// ===========================================================================
// SUBSCRIBE -- the confirmation email
// ===========================================================================

describe("the confirmation email", () => {
  it("carries the text body from wfbn/emails/confirm.txt, verbatim", async () => {
    // Ported word for word from the Django template, including "Please link
    // the button below" -- which reads as a typo for "click" (the .html
    // sibling says "click") and is preserved rather than fixed, because a
    // divergence in an email body is invisible to every test that only checks
    // that mail was sent.
    await subscribe("salisbury", { email: "new@example.org" });
    const keys = expectedKeys(SALT);

    expect(mails()[0]?.TextBody).toBe(
      "Please link the button below to confirm your email address and get updates from Salisbury food bank.\n\n" +
        `${ORIGIN}/needs/at/salisbury/updates/confirm/?key=${keys.subKey}\n\n` +
        "If you're not expecting this email then please ignore it.",
    );
  });

  it("uses the food bank's bare name, not its full_name", async () => {
    // confirm.txt interpolates `{{ foodbank.name }}` -- so the sentence reads
    // "updates from Caerdydd food bank", with the word "food bank" supplied by
    // the template. Passing full_name here would produce "Banc Bwyd Caerdydd
    // food bank". The confirmED email one describe block down uses full_name
    // instead; the asymmetry is Django's, and this is the assertion that keeps
    // the two from being "harmonised".
    await subscribe("caerdydd", { email: "new@example.org" });

    expect(mails()[0]?.TextBody).toContain("get updates from Caerdydd food bank.");
  });

  it("builds an absolute confirm link from SITE_DOMAIN with the new row's sub_key", async () => {
    // Django hardcodes https://www.givefood.org.uk into confirm.txt; the port
    // takes the domain from the binding so a preview deployment mails links to
    // itself. The KEY is what makes the link work at all -- a mail carrying
    // the unsub_key would delete the subscription the moment the recipient
    // tried to confirm it.
    await subscribe("salisbury", { email: "new@example.org" }, { SITE_DOMAIN: "https://staging.example.org" });

    const keys = expectedKeys(SALT);
    expect(mails()[0]?.TextBody).toContain(`https://staging.example.org/needs/at/salisbury/updates/confirm/?key=${keys.subKey}`);
    expect(subscriber(NEW_ID)?.sub_key).toBe(keys.subKey);
    expect(mails()[0]?.TextBody).not.toContain(keys.unsubKey);
  });

  it("keeps the confirm link UNPREFIXED even for a Welsh subscriber", async () => {
    // confirmEmailText() calls url(), not urlForLocale() -- so the link in the
    // mail is always the English path, even though the visitor subscribed from
    // /cy/. Django's own confirm.txt hardcodes the unprefixed URL, so this is
    // parity, and the /needs/at/<slug>/updates/confirm/ route exists
    // unprefixed too, so the link works. Pinned because the turnstile-fail
    // redirect two blocks up deliberately does the OPPOSITE, and only one of
    // the two can be right by accident.
    await post("/cy/needs/at/caerdydd/updates/subscribe/", { email: "new@example.org", "cf-turnstile-response": "a-valid-token" });

    expect(mails()[0]?.TextBody).toContain(`${ORIGIN}/needs/at/caerdydd/updates/confirm/?key=`);
    expect(mails()[0]?.TextBody).not.toContain("/cy/needs/at/");
  });

  it("sends an HTML part that is a real HTML email, not a copy of the text part", async () => {
    // THE NAMED REGRESSION. These two mails used to be assembled as bare <p>
    // strings on the reasoning that emails/page.njk was not ported; it has
    // been since, and a multipart mail whose HTML part is indistinguishable
    // from its text part looks, in an inbox, exactly like a mail that sent no
    // HTML at all -- which is how it was reported.
    await subscribe("salisbury", { email: "new@example.org" });
    const html = mails()[0]?.HtmlBody ?? "";

    expect(html).toContain("<!doctype html>");
    // The shell: logo, footer, and the button table Django keeps for Outlook.
    expect(html).toContain("https://www.givefood.org.uk/static/img/logo_full.png");
    expect(html).toContain("Give Food, 61 Bridge Street, Kington, HR5 3DJ");
    expect(html).toContain('class="btn btn-primary"');
    expect(html).toContain(`<a href="${ORIGIN}/needs/at/salisbury/updates/confirm/?key=${expectedKeys(SALT).subKey}" target="_blank">Confirm my email address</a>`);
    // "click", where the text part says "link" -- both preserved as Django has
    // them, which is why the text body is asserted verbatim above.
    expect(html).toContain("Please click the button below");
  });

  it("posts to Postmark with the token, the subject, and the outbound stream", async () => {
    await subscribe("salisbury", { email: "new@example.org" });

    expect(outbound.filter((o) => o.url === POSTMARK)).toHaveLength(1);
    expect(outbound.find((o) => o.url === POSTMARK)?.headers["X-Postmark-Server-Token"]).toBe("test-postmark-token");
    expect(mails()[0]?.Subject).toBe("Confirm your Give Food subscription");
    expect(mails()[0]?.From).toBe("mail@givefood.org.uk");
    expect(mails()[0]?.MessageStream).toBe("outbound");
  });

  it("still promises the email when POSTMARK_TOKEN is unset and nothing was sent", async () => {
    // SUSPECT, PINNED AS-IS. sendEmail() returns false without a token and
    // logs; this handler DISCARDS that boolean and tells the visitor an email
    // is on its way regardless. The row is written, so the person is stuck
    // permanently unconfirmed, waiting for a mail that was never sent, and the
    // only trace is one console.log line. Django's view ignores send_email()'s
    // return value in exactly the same way, so this is faithful -- but it is
    // the failure mode this whole tier exists to make visible.
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await subscribe("salisbury", { email: "new@example.org" }, { POSTMARK_TOKEN: undefined });

    expect(res.status).toBe(200);
    expect(mails()).toEqual([]);
    expect(logs).toHaveBeenCalledWith("POSTMARK_TOKEN not set -- skipping email to new@example.org: Confirm your Give Food subscription");
    expect(subscriber(NEW_ID)).toBeDefined();
    expect(messageOf(await res.text())).toContain("We&#39;ve sent an email to new@example.org");
  });

  it("still promises the email when Postmark REJECTS the send", async () => {
    // Same discarded boolean, one layer out: a 422 (bad address, blocked
    // recipient, over quota) is logged as an error and then ignored. Pinned
    // for the same reason -- and it is the more likely of the two, since the
    // address came from a text field this port validates more loosely than
    // Django does.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ postmark: 422 });

    const res = await subscribe("salisbury", { email: "new@example.org" });

    expect(res.status).toBe(200);
    expect(errors).toHaveBeenCalled();
    expect(subscriber(NEW_ID)).toBeDefined();
  });

  it("tells the visitor an email is coming, in Django's exact wording", async () => {
    // The message is a two-paragraph string with a literal \n\n that
    // updates.njk turns into <br><br>. Asserted as the whole rendered block:
    // the spam-folder sentence is the only thing standing between this and a
    // support email, and it has been lost in a template refactor before.
    const res = await subscribe("salisbury", { email: "new@example.org" });

    expect(messageOf(await res.text())).toBe(
      "Thanks, but we&#39;re not quite done yet.<br><br>" +
        "We&#39;ve sent an email to new@example.org with a link to click to confirm your subscription. " +
        "You might have to look in your spam folder though.",
    );
  });
});

// ===========================================================================
// SUBSCRIBE -- duplicates, and the race the pre-check does not close
// ===========================================================================

describe("subscribing an address that is already subscribed", () => {
  it("reports it, writes nothing and sends nothing", async () => {
    const res = await subscribe("salisbury", { email: "pat@example.org" });

    expect(res.status).toBe(200);
    expect(messageOf(await res.text())).toBe(ALREADY);
    expect(subscribers()).toHaveLength(3);
    expect(mails()).toEqual([]);
    // The INSERT is never even prepared -- the pre-check is what Django's
    // TODO ("check subscriber dupe here, rather than inside the try") asked
    // for, and this is the assertion that it actually runs first.
    expect(prepared.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  });

  it("catches a duplicate typed in a different case", async () => {
    // The stored row is lowercase and the submitted address is not, so this
    // only works because the pre-check lowercases too. Without it the second
    // subscription would fall through to the INSERT and be rejected by
    // sub_email_fb_uniq instead -- reaching the same message by an exception,
    // which is precisely the path Django's own TODO wanted removed.
    const res = await subscribe("salisbury", { email: "PAT@Example.Org" });

    expect(messageOf(await res.text())).toBe(ALREADY);
    expect(subscribers()).toHaveLength(3);
  });

  it("scopes the duplicate check to ONE food bank", async () => {
    // pat@example.org is already subscribed to Salisbury (row 50) and to
    // Caerdydd (row 52). Subscribing the same address to a THIRD food bank has
    // to work: unique_together is ('email', 'foodbank'), and a check that had
    // dropped the food bank would tell half the country they were already
    // subscribed to a food bank they had never heard of.
    const res = await subscribe("jersey-town", { email: "pat@example.org" });

    expect(res.status).toBe(200);
    expect(subscriber(NEW_ID)?.foodbank_id).toBe(JERSEY);
    expect(mails()).toHaveLength(1);
  });

  it("survives a genuine write race and reports it as a duplicate", async () => {
    // THE WINDOW THE PRE-CHECK DOES NOT CLOSE, exercised for real rather than
    // simulated: a competing INSERT lands between this request's dupe check
    // and its own INSERT, so the real sub_email_fb_uniq index raises the real
    // SQLite error and the handler's catch reads the real message. Django
    // caught the equivalent IntegrityError; without this catch the visitor
    // would get a 500 for a race they cannot see, on a form they filled in
    // correctly.
    raceBefore = {
      prefix: "INSERT INTO foodbanksubscriber",
      run: () =>
        db
          .prepare(
            `INSERT INTO foodbanksubscriber (id, created, foodbank_id, email, confirmed, sub_key, unsub_key)
             VALUES (900, ?, ?, 'new@example.org', 0, 'racedsubkey00001', 'racedunsubkey001')`,
          )
          .run(NOW_PY, SALISBURY),
    };

    const res = await subscribe("salisbury", { email: "new@example.org" });

    expect(res.status).toBe(200);
    expect(messageOf(await res.text())).toBe(ALREADY);
    // The competitor's row survives; nothing was written twice.
    expect(subscribers().map((r) => r.id)).toEqual([50, 51, 52, 900]);
    // And the loser sends no mail -- two confirmation emails for one
    // subscription is the outcome an unguarded INSERT would have produced.
    expect(mails()).toEqual([]);
  });

  // WAS "MISREPORTS a sub_key collision as a duplicate address -- suspect,
  // pinned as-is". Fixed in github #27, in two halves.
  //
  // The cause: this route minted keys with its own un-extracted copy of
  // generateSubUnsubKeys, hashing `sub-<toISOString()>-<salt>` with NO
  // nonce. toISOString() is MILLISECOND resolution and the salt is global,
  // so two different people subscribing in the same millisecond -- to any
  // two food banks -- minted byte-identical sub_keys. Django cannot do this:
  // timezone.now() interpolates at microsecond resolution, and Django has no
  // uniqueness on sub_key at all (subscribers.py:27-32 declares only
  // unique_together('email','foodbank')). The port was a thousand times more
  // likely to repeat the hash input while being the only one of the two that
  // constrained it.
  //
  // The route now calls lib/subscriberKeys.ts, whose per-call
  // crypto.randomUUID() nonce makes the input distinct regardless of clock
  // resolution -- see "mints different keys for two subscribers in the same
  // millisecond" below, which is the guard that matters.
  //
  // This test survives to pin the FAILURE MODE if a key collision ever
  // happens anyway: a 500 the maintainer can see, not a false "you are
  // already subscribed" the visitor believes and acts on by giving up.
  it("500s on a sub_key collision rather than calling it a duplicate address", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const keys = expectedKeys(SALT);
    seedSubscriber({ id: 900, foodbankId: JERSEY, email: "someone-else@example.org", subKey: keys.subKey, unsubKey: "unsubkeyother001" });

    const res = await subscribe("salisbury", { email: "new@example.org" });

    expect(res.status).toBe(500);
    // Not written, and -- the point -- not told a comforting lie either.
    expect(subscribers().map((r) => r.email)).toEqual(["pat@example.org", "alex@example.org", "pat@example.org", "someone-else@example.org"]);
    expect(mails()).toEqual([]);
    errors.mockRestore();
  });

  // THE FIX ITSELF. Un-stubs the nonce so the real crypto.randomUUID() runs,
  // freezes the clock so both subscribers share a millisecond, and shows the
  // keys still differ. Under the old nonce-free helper these two inserts
  // minted the same sub_key and the second one failed.
  it("mints different keys for two subscribers in the same millisecond", async () => {
    vi.mocked(crypto.randomUUID).mockRestore();

    const first = await subscribe("salisbury", { email: "one@example.org" });
    const second = await subscribe("salisbury", { email: "two@example.org" });

    expect([first.status, second.status]).toEqual([200, 200]);
    const added = subscribers().filter((r) => r.email === "one@example.org" || r.email === "two@example.org");
    expect(added).toHaveLength(2);
    expect(added[0]!.sub_key).not.toBe(added[1]!.sub_key);
    expect(added[0]!.unsub_key).not.toBe(added[1]!.unsub_key);
    // Both were told the truth, and both got their confirmation mail.
    expect(messageOf(await second.text())).toContain("not quite done yet");
    expect(mails()).toHaveLength(2);
  });

  it("re-throws any OTHER D1 failure instead of calling it a duplicate", async () => {
    // The `else { throw err }` half of the catch. A connection failure
    // reported as "you are already subscribed" would be a lie the visitor
    // acts on -- they would stop trying -- so it has to reach index.ts's
    // onError and 500 instead.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failOnPrefix = "INSERT INTO foodbanksubscriber";

    const res = await subscribe("salisbury", { email: "new@example.org" });

    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalled();
    expect(subscribers()).toHaveLength(3);
    expect(mails()).toEqual([]);
  });
});

// ===========================================================================
// CONFIRM
// ===========================================================================

describe("confirm", () => {
  const CONFIRM_MESSAGE = "Great! Thank you for confirming your subscription.";

  it("marks the subscriber confirmed and says so", async () => {
    const res = await get("/needs/at/salisbury/updates/confirm/?key=subkeypat0000001");

    expect(res.status).toBe(200);
    expect(messageOf(await res.text())).toBe(CONFIRM_MESSAGE);
    expect(subscriber(50)?.confirmed).toBe(1);
  });

  it("confirms ONLY that subscriber", async () => {
    // A `UPDATE ... SET confirmed = 1` that lost its WHERE would confirm every
    // address in the table, which is how a mailing list starts sending to
    // people who never verified -- and it would look identical from the page.
    await get("/needs/at/salisbury/updates/confirm/?key=subkeypat0000001");

    expect(subscribers().map((r) => [r.id, r.confirmed])).toEqual([
      [50, 1],
      [51, 1],
      [52, 0],
    ]);
    expect(sent.find((s) => s.sql.startsWith("UPDATE"))).toEqual({
      sql: "UPDATE foodbanksubscriber SET confirmed = 1 WHERE id = ?",
      params: [50],
    });
  });

  it("404s a key that matches nothing, and one that is merely the wrong case", async () => {
    // SQLite's `=` is case-sensitive and nothing normalises the key, so a mail
    // client that upper-cased the URL breaks the link. Pinned as behaviour:
    // the keys are lowercase hex everywhere they are minted, so this costs
    // nothing today, but it is the kind of thing a "helpful" trim/lowercase
    // would change without anyone noticing the security implication of a
    // widened keyspace.
    for (const key of ["nosuchkey0000001", "SUBKEYPAT0000001", "subkeypat000000", "subkeypat0000001 "]) {
      const res = await get(`/needs/at/salisbury/updates/confirm/?key=${encodeURIComponent(key)}`);
      expect(res.status, key).toBe(404);
    }
    expect(subscriber(50)?.confirmed).toBe(0);
  });

  it("404s with no key at all, without querying for one", async () => {
    // `key ? await getSubscriberBySubKey(...) : null` -- the guard saves a
    // round trip AND avoids binding an empty string, which would match nothing
    // anyway. Django reaches the same 404 differently: `sub_key=None` becomes
    // `sub_key IS NULL` in the ORM, which cannot match a NOT NULL column. That
    // last claim is reasoned from the ORM's behaviour, NOT run here.
    const res = await get("/needs/at/salisbury/updates/confirm/");

    expect(res.status).toBe(404);
    expect(sent.some((s) => s.sql.includes("sub_key"))).toBe(false);
  });

  it("does not accept an unsub_key as a confirmation key", async () => {
    // Two columns, two indexes, and the lookup names one of them. A handler
    // reading the wrong column would confirm subscriptions from unsubscribe
    // links -- and, because the unsub_key is in the footer of every
    // notification, would do it on every prefetch.
    const res = await get("/needs/at/salisbury/updates/confirm/?key=unsubkeypat00001");

    expect(res.status).toBe(404);
    expect(subscriber(50)?.confirmed).toBe(0);
  });

  it("is idempotent: a second click changes nothing and sends nothing", async () => {
    // AT-LEAST-ONCE IS THE NORM HERE. Mail clients and corporate link-scanners
    // fetch the confirm URL before the recipient ever sees it, and then the
    // recipient clicks it too. The `if (!sub.confirmed)` guard is what stops
    // the second visit re-sending the welcome mail -- the visitor still sees
    // the success message, which is the right answer for a link that was
    // already used.
    const first = await get("/needs/at/salisbury/updates/confirm/?key=subkeypat0000001");
    void (await first.text());
    outbound = [];
    sent = [];
    prepared = [];

    const second = await get("/needs/at/salisbury/updates/confirm/?key=subkeypat0000001");

    expect(second.status).toBe(200);
    expect(messageOf(await second.text())).toBe(CONFIRM_MESSAGE);
    expect(mails()).toEqual([]);
    expect(prepared.some((sql) => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("sends nothing for an already-confirmed subscriber", async () => {
    // Row 51 was seeded confirmed, so this is the same guard reached without a
    // prior request in this test -- worth its own case because the idempotence
    // test above could pass on a handler that merely cached something.
    const res = await get("/needs/at/salisbury/updates/confirm/?key=subkeyalex000001");

    expect(res.status).toBe(200);
    expect(mails()).toEqual([]);
    expect(sent.some((s) => s.sql.startsWith("UPDATE"))).toBe(false);
  });

  it("ignores a POSTed body and confirms from the query string", async () => {
    // Django reads `key` off request.GET only, in every method. The port does
    // the same via c.req.query(), so an unsubscribe-style POST to the confirm
    // URL behaves exactly like the GET.
    const res = await post("/needs/at/salisbury/updates/confirm/?key=subkeypat0000001", { key: "nonsense", email: "attacker@example.org" });

    expect(res.status).toBe(200);
    expect(subscriber(50)?.confirmed).toBe(1);
  });
});

describe("the confirmation-received email", () => {
  it("carries wfbn/emails/confirmed.txt verbatim, doubled words and all", async () => {
    // "updates them updates them." is a real typo in the Django template
    // (confirmed.txt; its .html sibling says it once) and is preserved. So is
    // the DOUBLE SPACE before "In the meantime". Asserted as the whole body
    // because a template port is exactly where wording drifts silently.
    await get("/needs/at/salisbury/updates/confirm/?key=subkeypat0000001");

    expect(mails()[0]?.TextBody).toBe(
      "Thanks for confirming your email address.\n\n" +
        "We'll send you a list of items being requested whenever Salisbury Foodbank updates them updates them.  " +
        "In the meantime, here are some useful links...\n\n" +
        `🔗 You can find more details about the food bank ${ORIGIN}/needs/at/salisbury/\n` +
        `🗺️ See other nearby food banks ${ORIGIN}/needs/at/salisbury/nearby/\n` +
        `🗳️ Explain to your MP that food banks shouldn't exist by taking political action ${ORIGIN}/write/`,
    );
  });

  it("addresses the subject with the bare name and the body with the full name", async () => {
    // Django: `"Thank you for confirming your subscription to %s Food Bank" %
    // foodbank.name` in the view, `{{ foodbank.full_name }}` in the template.
    // So the subject reads "... to Salisbury Food Bank" while the body says
    // "Salisbury Foodbank". Both are ported as-is; the awkwardness is the
    // source's.
    await get("/needs/at/salisbury/updates/confirm/?key=subkeypat0000001");

    expect(mails()[0]?.Subject).toBe("Thank you for confirming your subscription to Salisbury Food Bank");
    expect(mails()[0]?.TextBody).toContain("whenever Salisbury Foodbank updates them");
    expect(mails()[0]?.To).toBe("pat@example.org");
  });

  it("uses the Welsh trading name and the Welsh page when the visitor is on /cy/", async () => {
    // fullNameLocaleAware() returns alt_name for cy. The links stay
    // unprefixed, as Django's hardcoded ones are.
    await get("/cy/needs/at/caerdydd/updates/confirm/?key=subkeypatcy00001");

    expect(mails()[0]?.TextBody).toContain("whenever Banc Bwyd Caerdydd updates them");
    expect(mails()[0]?.Subject).toBe("Thank you for confirming your subscription to Caerdydd Food Bank");
  });

  it("shows the donation-points link only when the counter is above zero", async () => {
    // Salisbury has three donation points, so the 🛒 line is in the HTML part
    // (the TEXT part never had it -- confirmed.txt has no such line in Django
    // either, which is why the text body above is complete without it).
    await get("/needs/at/salisbury/updates/confirm/?key=subkeypat0000001");

    expect(mails()[0]?.HtmlBody).toContain(`<a href="${ORIGIN}/needs/at/salisbury/donationpoints/">donation points</a>`);
  });

  it("hides it for a food bank with none", async () => {
    await get("/needs/at/caerdydd/updates/confirm/?key=subkeypatcy00001");

    expect(mails()[0]?.HtmlBody).not.toContain("/donationpoints/");
    // The other three links are unconditional and must survive the branch.
    expect(mails()[0]?.HtmlBody).toContain(`<a href="${ORIGIN}/needs/at/caerdydd/">about the food bank</a>`);
    expect(mails()[0]?.HtmlBody).toContain(`<a href="${ORIGIN}/needs/at/caerdydd/nearby/">nearby food banks</a>`);
    expect(mails()[0]?.HtmlBody).toContain(`<a href="${ORIGIN}/write/">taking political action</a>`);
  });

  it("hides it for a NULL counter, where Django SHOWS it -- a real divergence", async () => {
    // SUSPECT, PINNED AS-IS. no_donation_points is nullable in production, and
    // the two implementations disagree about what NULL means:
    //
    //   Django's confirmed.html:  {% if foodbank.no_donation_points != 0 %}
    //   this port:                has_donation_points: Boolean(no_donation_points)
    //
    // Rendered under Django 5.2.6 in the reference venv, that template emits
    // the link for None and for 1, and hides it only for 0. `Boolean(null)` is
    // false, so the port hides it for an unknown count. The port's answer is
    // arguably the better one -- a NULL is "we don't know", and linking to a
    // page that may list nothing is worse than not linking -- but the module's
    // own comment cites `if foodbank.no_donation_points:` as the Django
    // source, and the template it renders says `!= 0`.
    seedJerseySubscriber();

    await get("/needs/at/jersey-town/updates/confirm/?key=subkeypatjy00001");

    expect(mails()[0]?.HtmlBody).not.toContain("/donationpoints/");
  });

  it("sends the HTML shell, not a copy of the text part", async () => {
    await get("/needs/at/salisbury/updates/confirm/?key=subkeypat0000001");

    expect(mails()[0]?.HtmlBody).toContain("<!doctype html>");
    expect(mails()[0]?.HtmlBody).toContain("Give Food, 61 Bridge Street, Kington, HR5 3DJ");
  });

  it("describes the food bank in the URL, not the one the subscription belongs to", async () => {
    // SUSPECT, PINNED AS-IS. getSubscriberBySubKey is a bare `WHERE sub_key = ?`
    // with no food bank predicate (Django's get_object_or_404 is the same), so
    // a Caerdydd subscriber's key presented on Salisbury's URL confirms that
    // subscription -- and this port then builds the whole confirmation email
    // out of the URL's food bank. Django is inconsistent in the same place but
    // in the opposite direction: its view passes `sub.foodbank` to the
    // templates (so the BODY is right) while interpolating `foodbank.name`
    // into the SUBJECT (so the subject is wrong). The port makes both wrong.
    //
    // The row updated is still the right one, which is why this is a wrong
    // EMAIL rather than a wrong subscription: the recipient is told they have
    // subscribed to a food bank 150 miles away.
    const res = await get("/needs/at/salisbury/updates/confirm/?key=subkeypatcy00001");

    expect(res.status).toBe(200);
    expect(subscriber(52)?.confirmed).toBe(1);
    expect(mails()[0]?.To).toBe("pat@example.org");
    expect(mails()[0]?.Subject).toBe("Thank you for confirming your subscription to Salisbury Food Bank");
    expect(mails()[0]?.TextBody).toContain("whenever Salisbury Foodbank updates them");
    expect(mails()[0]?.TextBody).toContain(`${ORIGIN}/needs/at/salisbury/nearby/`);
  });

  it("500s rather than confirming when the UPDATE fails", async () => {
    // No try/catch on this path, so a write failure reaches onError. Correct:
    // "Great! Thank you for confirming" over an UPDATE that did not happen
    // would leave the person permanently unconfirmed and certain they were
    // done.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failOnPrefix = "UPDATE foodbanksubscriber";

    const res = await get("/needs/at/salisbury/updates/confirm/?key=subkeypat0000001");

    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalled();
    expect(subscriber(50)?.confirmed).toBe(0);
    expect(mails()).toEqual([]);
  });
});

// ===========================================================================
// UNSUBSCRIBE
// ===========================================================================

describe("unsubscribe", () => {
  it("deletes the subscription and tells the visitor, on a GET", async () => {
    const res = await get("/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypat00001");

    expect(res.status).toBe(200);
    expect(messageOf(await res.text())).toBe("You have been unsubscribed.");
    expect(subscriber(50)).toBeUndefined();
  });

  it("deletes exactly one row", async () => {
    // `DELETE ... WHERE id = ?` bound to the row the key resolved to. A DELETE
    // that lost its predicate would empty the subscriber table on one click of
    // one footer link, and the page would still say "You have been
    // unsubscribed."
    await get("/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypat00001");

    expect(subscribers().map((r) => r.id)).toEqual([51, 52]);
    expect(sent.find((s) => s.sql.startsWith("DELETE"))).toEqual({
      sql: "DELETE FROM foodbanksubscriber WHERE id = ?",
      params: [50],
    });
  });

  it("answers a bare, bodyless 200 to a POST -- the RFC 8058 one-click shape", async () => {
    // Mail clients POST `List-Unsubscribe=One-Click` here and read only the
    // status. `new Response(null, {status: 200})` means NO template render at
    // all -- no Content-Type, no body -- and this exact shape is a named WP 3.7
    // acceptance criterion. Django's `HttpResponse(status=200)` also carries
    // b'' (constructed under Django 5.2.6 in the reference venv) but does set
    // `text/html; charset=utf-8`; the missing header is a divergence no client
    // can observe on an empty body.
    const res = await post("/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypat00001", "List-Unsubscribe=One-Click");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Content-Type")).toBeNull();
    expect(subscriber(50)).toBeUndefined();
  });

  it("403s without a key and deletes nothing", async () => {
    // Django: `if not key: return HttpResponseForbidden()`. This guard exists
    // BEFORE the lookup, so the bare URL cannot be probed at all -- and 403,
    // not 404, is what distinguishes "you did not bring a key" from "that key
    // is not ours".
    const res = await get("/needs/at/salisbury/updates/unsubscribe/");

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    expect(subscribers()).toHaveLength(3);
    expect(sent.some((s) => s.sql.includes("unsub_key"))).toBe(false);
  });

  it("403s an empty key, since the guard is on truthiness", async () => {
    const res = await get("/needs/at/salisbury/updates/unsubscribe/?key=");

    expect(res.status).toBe(403);
    expect(subscribers()).toHaveLength(3);
  });

  it("404s an unknown key, and a sub_key used as an unsub_key", async () => {
    // The second half is the one that matters: sub_key is in the CONFIRMATION
    // link, which is the more widely forwarded of the two mails. A lookup
    // reading the wrong column would let a forwarded confirmation link delete
    // the subscription it was supposed to create.
    for (const key of ["nosuchkey0000001", "subkeypat0000001"]) {
      const res = await get(`/needs/at/salisbury/updates/unsubscribe/?key=${key}`);
      expect(res.status, key).toBe(404);
    }
    expect(subscribers()).toHaveLength(3);
  });

  it("404s the second delivery of the same one-click unsubscribe", async () => {
    // NOT graceful, and pinned deliberately. The row is gone, so the second
    // POST 404s -- a mail client that retries a timed-out one-click request
    // sees a failure for an unsubscribe that actually succeeded, and some will
    // surface that to the reader as "unsubscribe failed". Django behaves
    // identically (get_object_or_404 on a deleted row), so it is faithful
    // rather than a port regression, but it is the classic at-least-once
    // delivery trap and it is here so the behaviour is a decision.
    const first = await post("/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypat00001", "List-Unsubscribe=One-Click");
    const second = await post("/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypat00001", "List-Unsubscribe=One-Click");

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
    expect(subscribers().map((r) => r.id)).toEqual([51, 52]);
  });

  it("honours a key for a DIFFERENT food bank than the URL names", async () => {
    // Parity, and pinned as such: neither Django's lookup nor this one scopes
    // the key to the food bank in the path, so row 52's Caerdydd key works on
    // Salisbury's URL. The key is a secret, so this is not an access-control
    // hole -- but it does mean a mistyped path in a mail footer still
    // unsubscribes the right person, and any future "verify the slug matches"
    // change would break links already in inboxes.
    const res = await get("/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypatcy001");

    expect(res.status).toBe(200);
    expect(subscribers().map((r) => r.id)).toEqual([50, 51]);
  });

  it("sends no email at all", async () => {
    // Django sends none here either. Worth an assertion because "sorry to see
    // you go" mail to someone who just unsubscribed is both a natural addition
    // and, in several jurisdictions, exactly the thing they asked to stop.
    await get("/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypat00001");

    expect(outbound).toEqual([]);
  });

  it("500s rather than reporting success when the DELETE fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failOnPrefix = "DELETE FROM foodbanksubscriber";

    const res = await get("/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypat00001");

    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalled();
    expect(subscriber(50)).toBeDefined();
  });

  it("sends exactly the food bank batch, the key lookup and the DELETE", async () => {
    await get("/needs/at/salisbury/updates/unsubscribe/?key=unsubkeypat00001");

    expect(sent).toEqual([
      { sql: "SELECT * FROM foodbank WHERE slug = ?", params: ["salisbury"] },
      { sql: "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", params: ["salisbury"] },
      { sql: "SELECT * FROM foodbanksubscriber_full WHERE unsub_key = ?", params: ["unsubkeypat00001"] },
      { sql: "DELETE FROM foodbanksubscriber WHERE id = ?", params: [50] },
    ]);
  });
});

// ===========================================================================
// THE PAGE THE THREE ACTIONS FALL THROUGH TO
// ===========================================================================

describe("the rendered page", () => {
  const OK = "/needs/at/salisbury/updates/confirm/?key=subkeypat0000001";

  it("is the food bank's own page, titled and described with its full name", async () => {
    const html = await (await get(OK)).text();

    expect(html).toContain("<title>Salisbury Foodbank - Give Food</title>");
    expect(html).toContain('<meta property="og:title" content="Salisbury Foodbank">');
    expect(html).toContain('<li><a href="/needs/at/salisbury/">Salisbury Foodbank</a></li>');
    expect(html).toContain('<li class="is-active"><a href="#" aria-current="page">Subscription</a></li>');
  });

  it("splits lat_lng into the two numeric meta tags", async () => {
    // Foodbank.latt()/long() in Django are `float(self.lat_lng.split(",")[N])`
    // and this is Number() over the same split -- so both render the number,
    // not the substring. The geo.position tag keeps the raw pair.
    const html = await (await get(OK)).text();

    expect(html).toContain('<meta name="geo.position" content="51.0688,-1.7945">');
    expect(html).toContain('<meta property="place:location:latitude" content="51.0688">');
    expect(html).toContain('<meta property="place:location:longitude" content="-1.7945">');
  });

  it("normalises a padded lat_lng through Number(), exactly as Django's float() does", async () => {
    // The one fixture where the substring and the number differ: Jersey Town's
    // lat_lng is "49.18630, -2.10500", so the raw halves are "49.18630" and
    // " -2.10500" (leading space included) while Number() gives 49.1863 and
    // -2.105. Django's Foodbank.latt()/long() are `float(...)` over the same
    // split and render the same two numbers, so this is parity -- and it is
    // the assertion that fails if the Number() calls are ever dropped, which
    // the tidier-looking `latt: latStr` would do while the Salisbury fixture
    // above went on passing.
    //
    // geo.position keeps the RAW column, padding and all, in both
    // implementations.
    seedJerseySubscriber();

    const html = await (await get("/needs/at/jersey-town/updates/confirm/?key=subkeypatjy00001")).text();

    expect(html).toContain('<meta name="geo.position" content="49.18630, -2.10500">');
    expect(html).toContain('<meta property="place:location:latitude" content="49.1863">');
    expect(html).toContain('<meta property="place:location:longitude" content="-2.105">');
  });

  it("renders the Welsh trading name and stamps Content-Language", async () => {
    const res = await get("/cy/needs/at/caerdydd/updates/confirm/?key=subkeypatcy00001");
    const html = await res.text();

    expect(res.headers.get("Content-Language")).toBe("cy");
    expect(html).toContain("<title>Banc Bwyd Caerdydd - Give Food</title>");
  });

  it("declares itself translatable, and builds the alternates off the UNPREFIXED path", async () => {
    // `pageTranslatable: true` is what emits the hreflang alternates and the
    // language switcher; `unprefixedPath: c.get("pathAfterPrefix")` is what
    // stops the Welsh page's alternates being built from "/cy/needs/..." and
    // coming out as "/cy/cy/needs/...". Both are one word in the call to
    // buildPageContext, both are invisible in every other assertion in this
    // file, and between them they are the whole of this page's multilingual
    // behaviour -- gfwfbn/urls/i18n.py:26 has `updates` inside i18n_patterns,
    // so all four languages are real URLs.
    //
    // The query string is deliberately absent from the alternates: they are
    // built from the path alone, so a confirmation key never appears in an
    // hreflang link (which crawlers follow).
    const html = await (await get("/cy/needs/at/caerdydd/updates/confirm/?key=subkeypatcy00001")).text();

    for (const [code, href] of [
      ["en", "https://www.givefood.org.uk/needs/at/caerdydd/updates/confirm/"],
      ["cy", "https://www.givefood.org.uk/cy/needs/at/caerdydd/updates/confirm/"],
      ["ga", "https://www.givefood.org.uk/ga/needs/at/caerdydd/updates/confirm/"],
      ["gd", "https://www.givefood.org.uk/gd/needs/at/caerdydd/updates/confirm/"],
    ]) {
      expect(html, code).toContain(`<link rel="alternate" hreflang="${code}" href="${href}">`);
    }
    expect(html).not.toContain("key=subkeypatcy00001");
    expect(html).toContain('<div class="langswitcher');
  });

  it("shows the Charity menu item only where charity details exist", async () => {
    // CHARITY_DETAIL_COUNTRIES is {England, Wales, Scotland, Northern Ireland}
    // -- the four registers this site can link to. Jersey Town has a
    // charity_name but is outside them, and the menu include needs BOTH, so
    // this is the assertion that `has_charity_details` is actually passed
    // through rather than defaulting truthy.
    seedJerseySubscriber();
    const salisbury = await (await get(OK)).text();
    const jersey = await (await get("/needs/at/jersey-town/updates/confirm/?key=subkeypatjy00001")).text();

    expect(salisbury).toContain('href="/needs/at/salisbury/charity/"');
    expect(jersey).not.toContain("/charity/");
  });

  it("highlights no menu item, because 'subscribe' is not one of them", async () => {
    // `section: "subscribe"` matches none of the menu's six names, in Django
    // as here, so this page has no active item. Pinned so a future rename of
    // the section string is a visible change rather than a silent one.
    const html = await (await get(OK)).text();
    const menu = html.slice(html.indexOf('<aside class="menu foodbank-menu">'), html.indexOf("</aside>"));

    expect(menu).toContain('href="/needs/at/salisbury/"');
    expect(menu).not.toContain("is-active");
  });

  it("prints no prefix in the page title heading", async () => {
    // `prefix: null` -- pagetitle.njk prepends "<prefix> - " when it is set
    // (the locations and news pages use it). This page passes null explicitly,
    // so the h1 is the bare name.
    const html = await (await get(OK)).text();
    const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";

    expect(h1.trim()).toBe("Salisbury Foodbank");
  });

  it("reports its own render time in the debug comment", async () => {
    // elapsedMs(c) -> render_time_ms, the same number Server-Timing carries.
    // Its presence is what makes a slow page diagnosable from a saved copy of
    // the HTML, which is how the D1 round-trip costs in packages/db were
    // measured in the first place.
    const html = await (await get(OK)).text();

    expect(html).toMatch(/⏱️ Took \d+ms/);
    expect((await get(OK)).headers.get("Server-Timing")).toMatch(/^render;dur=\d/);
  });
});

// ===========================================================================
// THE EXPORT ITSELF
// ===========================================================================

describe("the module's exports", () => {
  it("exports exactly the one handler index.ts mounts", async () => {
    // sha256Hex, generateSubUnsubKeys, confirmEmailText and confirmedEmailText
    // are module-private on purpose and are exercised through the handler
    // above -- generateSubUnsubKeys byte for byte, via the frozen clock. This
    // assertion is what stops them being exported "for testability", which is
    // the change that turns an internal refactor into a breaking one.
    const module = await import("./updates");

    expect(Object.keys(module)).toEqual(["wfbnFoodbankUpdates"]);
    expect(typeof wfbnFoodbankUpdates).toBe("function");
  });
});
