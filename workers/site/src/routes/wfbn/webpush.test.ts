import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import { wfbnWebpushConfig, wfbnWebpushSubscribe, wfbnWebpushUnsubscribe } from "./webpush";
import type { AppEnv } from "../../types";

// routes/wfbn/webpush.ts -- the three endpoints behind the "Get browser
// notifications" button on every food bank page. Django source, read at
// /Users/jasoncartwright/Sites/foodcharity: gfwfbn/views.py's
// `fix_base64_padding` (:35-47), `webpush_config`, `webpush_subscribe` and
// `webpush_unsubscribe` (:1230-1345); the browser half is
// givefood/static/js/webpush.js:129-205; the model is
// givefood/models/subscribers.py:85-109.
//
// WHY THIS FILE IS LONG. Web push is the channel where EVERY failure is
// silent, at both ends and for months:
//
//   * The three fields this endpoint stores are not display data, they are
//     CRYPTOGRAPHIC KEY MATERIAL. workers/jobs/src/notify/webPushCrypto.ts
//     reads p256dh back as a 65-byte P-256 point and `auth` as the RFC 8291
//     auth secret, and derives a per-message key from them. A p256dh stored
//     one character short, or with the wrong padding, or truncated, does not
//     produce a wrong notification -- it produces a subscription that can
//     never be decrypted by the browser that made it, for as long as the row
//     exists. needWebPush.ts:135 catches exactly that and moves on.
//   * The browser never sees the failure either. webpush.js only checks
//     `response.ok`, then tells the visitor "Successfully subscribed to
//     notifications" and writes the food bank into localStorage. A row that
//     saved wrongly and a row that saved correctly look identical from the
//     page.
//   * There is no second copy. Unlike the email list, a push subscription
//     cannot be re-derived from anything -- the private half lives in the
//     visitor's browser. A row lost or overwritten is a person who has to
//     notice they stopped getting notifications and click the button again.
//
// So the assertions below are on the exact bytes of the stored row and on
// the exact bytes of the JSON, not on status codes.
//
// REAL APP, REAL SCHEMA, REAL SQL. `app` is the default export of
// workers/site/src/index.ts, so every request goes through the real router --
// which is where half the behaviour of this module actually lives: the
// `app.all()` registrations (index.ts:387-388) are what let a non-POST request
// REACH webpush.ts's own 400 instead of Hono's 404, and index.ts:386 is what
// makes the config endpoint GET-only where Django's has no method restriction
// at all. The queries are the shipped packages/db functions running their real
// SQL against Node's own SQLite, built from the real migrations via
// schemaFor(). Nothing on the data path is faked.
//
// The narrow fixture is the two tables these handlers touch. Deliberately NOT
// the whole of MIGRATIONS_SQL: naming them is what makes "this endpoint reads
// foodbank and writes webpushsubscription, and nothing else" an assertion
// rather than a hope -- a handler that grew a third table fails here with
// "no such table" instead of passing quietly.
//
// PARITY CLAIMS IN THE COMMENTS BELOW WERE RUN, NOT REASONED. Every "Django
// does X" note was produced by executing it under the Django 5.2.6 checkout at
// /Users/jasoncartwright/Sites/foodcharity on this machine (`django.get_version()`
// prints 5.2.6) -- in particular the URLValidator verdicts, which are the one
// place this port and Django genuinely disagree about which endpoints are
// acceptable.

const ORIGIN = "https://www.givefood.org.uk";
const JSON_TYPE = "application/json";

// A fixed clock, so `created` can be asserted as an exact string rather than
// pattern-matched. The value matters: packages/models' pyNow() writes Django's
// `str(datetime)` spelling and D1 stores it as TEXT, which SQLite compares
// LEXICOGRAPHICALLY -- "2026-09-08T09:30:00.000Z" sorts after every same-day
// Django value because 'T' (0x54) beats ' ' (0x20).
//
// Not theoretical for THIS column. adminStats.ts's getSubscriberSignupRows
// UNIONs webpushsubscription.created with foodbanksubscriber's and
// mobilesubscriber's under one `ORDER BY created`, and adminLists.ts's
// getSubscriptionsPage pages the same union `ORDER BY created DESC`. A
// toISOString() creeping in here would sort every web push signup to the top
// of both, permanently, while each individual row still looked normal.
const NOW = new Date("2026-09-08T09:30:00.000Z");
const NOW_PY = "2026-09-08 09:30:00.000000";

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
/** What c.env.VAPID_PUBLIC_KEY holds for the next request. */
let vapidPublicKey: string;

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite -- the
// same shim as mobsub.test.ts and hit.test.ts, for the same reason: D1 is async
// where node:sqlite is synchronous, and that is the only difference that
// matters. The SQL text, the parameter binding and the `changes`/`last_row_id`
// counts are SQLite's on both sides.
//
// TWO THINGS THIS SHIM MUST GET RIGHT, because a handler bug hides behind
// either one:
//
//   * bind() returns a NEW statement rather than mutating the receiver, exactly
//     as D1's prepared statements do. A shim that mutated in place would let
//     the last bind of a request overwrite an earlier one and make a genuinely
//     broken sequence of queries look correct.
//   * run() reports the real meta.last_row_id AND meta.changes.
//     upsertWebpushSubscription returns `result.meta.last_row_id` as the
//     `subscription_id` the browser is handed, and deleteWebpushSubscription's
//     whole return value is `result.meta.changes > 0` -- the `deleted` field of
//     the unsubscribe JSON. A shim returning `meta: {}` would make one
//     undefined and the other permanently false while every assertion below
//     still ran against a real INSERT and a real DELETE.
function d1Session(): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    sql,
    params,
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
      statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} })),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

function record(sql: string, params: Bindable[]): void {
  sent.push({ sql, params });
  if (failOnPrefix !== null && sql.startsWith(failOnPrefix)) {
    throw new Error("D1_ERROR: network connection lost");
  }
}

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session() },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
    VAPID_PUBLIC_KEY: vapidPublicKey,
  } as unknown as AppEnv["Bindings"];
}

// ===========================================================================
// SEEDS AND FIXTURES
// ===========================================================================

const SALISBURY_ID = 7;
const SALISBURY = "salisbury";
// A SECOND food bank, seeded in every test and almost never asked for. It is
// the control: `WHERE slug = ?` with the predicate accidentally dropped returns
// the first row in the table, which against a one-row fixture is
// indistinguishable from a correct lookup -- and would silently subscribe every
// visitor to whichever food bank happens to sort first.
const DEVIZES_ID = 8;
const DEVIZES = "devizes";

// REAL-SHAPED KEY MATERIAL, not "p256dh"/"auth" placeholders, because the exact
// LENGTHS are what fix_base64_padding keys off and therefore what every padding
// assertion below depends on. A PushSubscription's p256dh is the 65-byte
// uncompressed P-256 point (0x04 || X || Y) that webPushCrypto.ts:77 checks
// for, which is 87 base64url characters unpadded, and `auth` is the 16-byte
// RFC 8291 auth secret, 22 characters unpadded. 87 % 4 == 3 and 22 % 4 == 2, so
// the real world always needs exactly one '=' and exactly two.
//
// Both round-trip: Buffer.from(P256DH + "=", "base64") is the original 65 bytes
// and Buffer.from(AUTH + "==", "base64") the original 16 (checked in node
// before they were pasted here).
const P256DH = "BAoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4_wYNFBsiKTA3PkVMU1phaG92fYSLkpmgp661vMM";
const AUTH = "BRIfLDlGU2BteoeUoa67yA";
const P256DH_PADDED = `${P256DH}=`;
const AUTH_PADDED = `${AUTH}==`;

// A Mozilla autopush endpoint, the shape webpush.js actually posts back. Long,
// opaque, and the only thing that identifies the subscription for the DELETE.
const ENDPOINT = "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABm9Xk3QF7tPz1nQwLmY2t";
const ENDPOINT_2 = "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bF-9pQ0kZ2xY";

// A real user agent SHORT ENOUGH TO SURVIVE the column, used wherever the
// stored row is asserted whole. 68 characters.
const UA = "Mozilla/5.0 (Android 15; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0";

// And a real DESKTOP one, which is 117 characters and therefore does not
// survive -- see "truncates a real desktop Chrome user agent mid-token" below.
const UA_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

// A VAPID public key of the real shape and length -- the uncompressed P-256
// point again, 87 base64url characters -- and deliberately one CONTAINING BOTH
// '-' AND '_'. Those two characters are the entire difference between base64url
// and base64, and a key that happened to contain neither would let a
// re-encoding bug through unnoticed (see the first config test).
const VAPID = "BA0PERMVFxkbHR8hIyUnKSstLzEzNTc5Oz0_QUNFR0lLTU9RU1VXWVtdX2FjZWdpa21vcXN1d3l7fX-Bg4WHiYs";

function seedFoodbank(id: number, slug: string): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, uuid, name, slug, address, postcode, country, lat_lng,
        charity_just_foodbank, contact_email, url, shopping_list_url,
        address_is_administrative, is_closed, no_locations, days_between_needs,
        created, modified)
     VALUES (?, ?, ?, ?, '1 High St', 'SP1 1AA', 'England', '51.06,-1.79',
        0, 'mail@example.org', 'https://example.org/', 'https://example.org/list/',
        0, 0, 0, 14,
        '2019-06-01 09:00:00.000000', '2026-08-14 09:15:00.000000')`,
  ).run(id, `uuid-${id}`.padEnd(32, "0"), `Food bank ${id}`, slug);
}

/** Every webpushsubscription row, id order -- what the browser's click produced. */
function subs(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM webpushsubscription ORDER BY id").all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  db = new DatabaseSync(":memory:");
  db.exec(schemaFor("foodbank", "webpushsubscription"));
  prepared = [];
  sent = [];
  failOnPrefix = null;
  vapidPublicKey = VAPID;
  seedFoodbank(SALISBURY_ID, SALISBURY);
  seedFoodbank(DEVIZES_ID, DEVIZES);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

const SUB = `/needs/webpush/subscribe/${SALISBURY}/`;
const UNSUB = `/needs/webpush/unsubscribe/${SALISBURY}/`;
const CONFIG = "/needs/webpush/config/";

/** A JSON POST, exactly as webpush.js sends one. */
async function post(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  // `await`ed rather than returned directly: app.request()'s declared return
  // type is `Response | Promise<Response>`, which does not satisfy a
  // `Promise<Response>` signature under tsc even though it always resolves.
  return await app.request(
    `${ORIGIN}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": JSON_TYPE },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    },
    env(),
    execCtx,
  );
}

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  return await app.request(`${ORIGIN}${path}`, { method: "GET", ...init }, env(), execCtx);
}

/** The body webpush.js builds after pushManager.subscribe() resolves. */
const FULL = { endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH, browser: UA };

// ===========================================================================
// wfbnWebpushConfig -- twelve lines, and the site's entire push feature
// depends on the value being right
// ===========================================================================

describe("wfbnWebpushConfig", () => {
  it("answers the VAPID public key verbatim, byte for byte", async () => {
    // webpush.js:117 feeds this straight into urlBase64ToUint8Array() and then
    // into pushManager.subscribe({applicationServerKey}). The browser signs the
    // subscription to THIS key, and workers/jobs' VAPID JWT is verified against
    // its private half by the push service -- so a key that has been trimmed,
    // re-encoded, or had its base64url '-'/'_' turned into '+'/'/' produces
    // subscriptions that every later send is rejected for. Nothing about that
    // is visible here: subscribe() still succeeds, the row still saves, and the
    // notification simply never arrives.
    //
    // Asserted on the raw text, not the parsed object, so a renamed key or an
    // added wrapper object is a failure too -- webpush.js reads
    // `config.vapidPublicKey` and nothing else.
    const res = await get(CONFIG);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`{"vapidPublicKey":"${VAPID}"}`);
    expect(VAPID).toContain("-"); // the base64url characters really are in the fixture
    expect(VAPID).toContain("_");
  });

  it("sends bare application/json, matching Django's JsonResponse", async () => {
    // Django's JsonResponse Content-Type is `application/json` with NO charset
    // (constructed under Django 5.2.6 on this machine and printed). Hono's
    // c.json() matches exactly.
    const res = await get(CONFIG);

    expect(res.headers.get("Content-Type")).toBe(JSON_TYPE);
  });

  it("500s with Django's own error body when no key is configured", async () => {
    // `if not vapid_public_key: return JsonResponse({'error': ...}, status=500)`
    // -- the port's fallback branch is a transcription of Django's, and the
    // body was compared against a real JsonResponse under Django 5.2.6 on this
    // machine, which prints b'{"error": "VAPID not configured"}'. Only the
    // space after the colon differs, which no JSON parser can see.
    //
    // A 500 rather than a 200-with-no-key is the load-bearing half: webpush.js
    // checks `response.ok` before touching the body, so a 200 carrying an
    // absent key would send `undefined` into urlBase64ToUint8Array and fail
    // deep inside the browser instead of at the fetch.
    vapidPublicKey = "";

    const res = await get(CONFIG);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"VAPID not configured"}');
  });

  it("treats a missing binding the same as an empty one", async () => {
    // worker-configuration.d.ts declares VAPID_PUBLIC_KEY as a plain `string`,
    // so TypeScript believes it is always present -- but it is a wrangler
    // SECRET, and a secret that was never uploaded to an environment is simply
    // absent at runtime. `if (!vapidPublicKey)` covers both; a `=== undefined`
    // or a `=== ""` would cover only one, and the one it missed would be a 200
    // carrying no key.
    vapidPublicKey = undefined as unknown as string;

    const res = await get(CONFIG);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"VAPID not configured"}');
  });

  it("never touches D1", async () => {
    // The config endpoint reads one environment variable. It sits on every food
    // bank page's notification button, so a D1 query creeping in here would be
    // a query on a very wide path -- and would be invisible in the response.
    await get(CONFIG);

    expect(prepared).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("sets no Cache-Control, where Django's @cache_page(SECONDS_IN_HOUR) sent max-age=3600", async () => {
    // A DELIBERATE DIVERGENCE, documented in webpush.ts:46-50: the Workers Cache
    // sits in front of every request, so there is no explicit caching layer
    // here. middleware/pageCacheControl.ts does not fill the gap either -- its
    // CACHEABLE_TYPES list is HTML, RSS and Markdown only, so a JSON response
    // gets nothing.
    //
    // Pinned rather than endorsed. It means every visitor's browser re-fetches
    // the VAPID key on every food bank page, where Django's copy was reused for
    // an hour. Harmless in size, but it is a real difference from the source
    // this module cites and the first thing to check if the endpoint ever shows
    // up in a request-count report.
    const res = await get(CONFIG);

    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("is GET-only here, where Django's view has no method restriction -- a DIVERGENCE", async () => {
    // index.ts:386 registers this at app.get(), unlike the two app.all() routes
    // below. `webpush_config` carries only @cache_page in Django, no
    // @require_POST and no method check of its own, so a POST to it there
    // returns the key with a 200. Here it is a 404.
    //
    // Nothing calls it with a POST -- webpush.js:87 uses a plain fetch() -- so
    // this is recorded as a difference rather than a defect, and pinned so that
    // a change in either direction is deliberate.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app.request(`${ORIGIN}${CONFIG}`, { method }, env(), execCtx);
      expect(res.status, method).toBe(404);
    }
  });

  it("answers a HEAD with the same status and no body", async () => {
    // Hono answers HEAD from the GET handler. Worth pinning only because the
    // append-slash probe below issues a HEAD internally, so a route that
    // stopped answering it would break the redirect for a reason nobody would
    // connect to this endpoint.
    const res = await app.request(`${ORIGIN}${CONFIG}`, { method: "HEAD" }, env(), execCtx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("301s the unslashed path, reproducing Django's APPEND_SLASH", async () => {
    const res = await get("/needs/webpush/config");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${CONFIG}`);
  });

  it("is not mounted under any language prefix", async () => {
    // gfwfbn/urls/generic.py is included OUTSIDE i18n_patterns
    // (givefood/urls.py), so all three of these views have exactly one URL in
    // Django too. webpush.js hardcodes the unprefixed path, so a future "wrap
    // the wfbn routes in the LOCALES loop" change must not quietly create four.
    for (const prefix of ["/cy", "/ga", "/gd", "/en"]) {
      const res = await get(`${prefix}${CONFIG}`);
      expect(res.status, prefix).toBe(404);
    }
  });
});

// ===========================================================================
// wfbnWebpushSubscribe -- THE ROW WRITTEN
// ===========================================================================

describe("wfbnWebpushSubscribe writes the subscription", () => {
  it("stores every field in its own column, padded, and stamps created in Django's format", async () => {
    const res = await post(SUB, FULL);

    expect(res.status).toBe(200);
    // The WHOLE row at once, not field by field: endpoint, p256dh and auth are
    // three interchangeable opaque strings in three TEXT columns, so only an
    // all-at-once comparison catches a transposed bind in
    // upsertWebpushSubscription's six-placeholder INSERT -- which would store a
    // 65-byte point where the 16-byte auth secret belongs and produce
    // subscriptions that can never be decrypted.
    expect(subs()).toEqual([
      {
        id: 1,
        created: NOW_PY,
        foodbank_id: SALISBURY_ID,
        endpoint: ENDPOINT,
        p256dh: P256DH_PADDED,
        auth: AUTH_PADDED,
        browser: UA,
      },
    ]);
  });

  it("answers success, created and the new row id, in Django's field names", async () => {
    // `JsonResponse({'success': True, 'created': created, 'subscription_id':
    // subscription.id})`. Asserted on the raw text so a renamed field is a
    // failure: webpush.js resolves this object to its caller, and any future
    // client that starts reading `subscription_id` is reading a name that has
    // to keep meaning the primary key.
    const res = await post(SUB, FULL);

    expect(res.headers.get("Content-Type")).toBe(JSON_TYPE);
    expect(await res.text()).toBe('{"success":true,"created":true,"subscription_id":1}');
  });

  it("reports the actual row id, not a constant", async () => {
    // upsertWebpushSubscription returns `result.meta.last_row_id` for an INSERT
    // and `existing.id` for an UPDATE. Seeding a high id first is what tells
    // "the real last_row_id" apart from "1" -- with an empty table the two are
    // the same number and the mutant survives.
    db.prepare(
      "INSERT INTO webpushsubscription (id, created, foodbank_id, endpoint, p256dh, auth, browser) VALUES (500, ?, ?, 'https://other.example/x', 'p', 'a', NULL)",
    ).run("2026-01-01 00:00:00.000000", DEVIZES_ID);

    const res = await post(SUB, FULL);

    expect(await res.json()).toEqual({ success: true, created: true, subscription_id: 501 });
  });

  it("truncates browser to the model's 100 characters", async () => {
    // `browser[:browser_max_length]`, where Django reads max_length off the
    // model field at runtime (givefood/models/subscribers.py:99 declares
    // max_length=100 -- read, not assumed). D1's column is plain TEXT with no
    // limit, so nothing but this slice stops a 400-character user agent going
    // in whole; production is Postgres, where the same value would have raised
    // a DataError instead. Pinned at the exact boundary because an off-by-one
    // here is invisible until someone diffs the two databases.
    const long = "U".repeat(150);

    await post(SUB, { ...FULL, browser: long });

    expect(subs()[0]?.browser).toBe("U".repeat(100));
  });

  it("truncates a real desktop Chrome user agent mid-token", async () => {
    // NOT A SYNTHETIC CASE. The value webpush.js sends is
    // `navigator.userAgent` verbatim, and a current desktop Chrome one is 117
    // characters -- so the 100-character column loses the Chrome version's last
    // digits and the whole "Safari/537.36" token on EVERY desktop Chrome
    // subscription. The stored value ends "Chrome/141.0." with a trailing dot.
    //
    // Django did exactly the same (its slice is the same 100), so this is
    // faithful, and nothing downstream parses the column -- the admin prints it
    // as a label. Pinned because a truncated-mid-version string looks like data
    // corruption to anyone who later tries to chart browser share from it, and
    // this is the test that says it is expected.
    await post(SUB, { ...FULL, browser: UA_CHROME });

    expect(UA_CHROME.length).toBe(117);
    expect(subs()[0]?.browser).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.");
  });

  it("leaves a 100-character browser untouched", async () => {
    // The other side of the boundary: slice(0, 100) on a 100-character string
    // must be a no-op, and a `< 100` mutant loses the last character of every
    // real user agent without changing anything else.
    const exact = "C".repeat(100);

    await post(SUB, { ...FULL, browser: exact });

    expect(subs()[0]?.browser).toBe(exact);
  });

  it("stores NULL, not empty string, when browser is absent or empty", async () => {
    // `browser[:max] if browser else None` -- Django's own ternary, and the
    // column is `null=True, blank=True`. NULL and "" read the same to a human
    // looking at the admin's subscriptions list and completely differently to
    // `WHERE browser IS NOT NULL`, which is the shape of any future "which
    // browsers do our subscribers use" breakdown.
    await post(SUB, { endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH });
    await post(SUB, { endpoint: ENDPOINT_2, p256dh: P256DH, auth: AUTH, browser: "" });

    expect(subs().map((r) => r.browser)).toEqual([null, null]);
  });

  it("stores NULL for a non-string browser, where Django 500s -- a DIVERGENCE", async () => {
    // The port coerces any non-string to "" and then to NULL. Django does
    // `browser = data.get('browser', '')` with no type check, so a JSON number
    // reaches `browser[:100]` and raises TypeError, which the view's blanket
    // `except Exception as e` turns into a 500 carrying the exception text.
    //
    // The port's behaviour is better -- a malformed field from a browser
    // extension should not cost the visitor their subscription -- and it is
    // recorded here because it is a real difference from the source this module
    // cites, not because it should be changed back.
    await post(SUB, { ...FULL, browser: 42 });

    expect(subs()[0]?.browser).toBeNull();
  });

  it("stores the endpoint EXACTLY as posted, not the URL parser's normalisation", async () => {
    // The endpoint is the DELETE's only key and the URL every send POSTs to, so
    // it has to come back out identical. `new URL(endpoint)` is used purely as
    // a validity probe -- its result is discarded and the original string is
    // bound. That matters: the WHATWG parser rewrites what it is given (it
    // turns "https:///x" into "https://x/", lower-cases the host, adds a
    // trailing slash to a bare origin), and a handler that stored
    // `new URL(endpoint).href` would silently rewrite Mozilla and Google
    // endpoints that later have to match byte for byte on unsubscribe.
    const odd = "https://Push.Example.COM/wpush/v2/AbC?x=1&x=2";

    await post(SUB, { ...FULL, endpoint: odd });

    expect(subs()[0]?.endpoint).toBe(odd);
  });

  it("applies no length limit of its own to endpoint, p256dh or auth", async () => {
    // Django's model declares max_length 2000/200/50 on the three, and Postgres
    // enforces them (a longer value raises DataError, which the view's blanket
    // except turns into a 500). D1's columns are plain TEXT and this handler
    // checks only `browser`, so oversized values are stored in full here.
    //
    // Pinned as behaviour, not endorsed -- see the suspected-bug note. Nothing
    // real sends these lengths (a PushSubscription's keys are fixed-size), but
    // it is the one place the port is more permissive than the column it was
    // ported from.
    const huge = `https://push.example/${"z".repeat(2500)}`;

    await post(SUB, { endpoint: huge, p256dh: "x".repeat(400), auth: "y".repeat(80) });

    const row = subs()[0];
    expect((row?.endpoint as string).length).toBe(2521);
    expect((row?.p256dh as string).length).toBe(400);
    expect((row?.auth as string).length).toBe(80);
  });
});

// ===========================================================================
// fix_base64_padding -- module-private, and the single most damaging thing
// in this file to get wrong
// ===========================================================================

describe("base64 padding", () => {
  it("adds one '=' to a real 87-character p256dh and two to a 22-character auth", async () => {
    // gfwfbn/views.py:35-47, ported verbatim. A browser's
    // PushSubscription.toJSON() returns base64url with the padding STRIPPED, so
    // this runs on every single real subscription -- these are not edge cases,
    // they are the only case.
    await post(SUB, FULL);

    const row = subs()[0];
    expect(row?.p256dh).toBe(`${P256DH}=`);
    expect(row?.auth).toBe(`${AUTH}==`);
    expect((row?.p256dh as string).length).toBe(88);
    expect((row?.auth as string).length).toBe(24);
  });

  it("leaves an already-padded value alone rather than double-padding it", async () => {
    // `if padding != 4` is the whole of that guard. Without it a value whose
    // length is already a multiple of four gains four more '=' characters,
    // which atob() rejects outright -- so EVERY subscription from any client
    // that pads its own keys would be stored undecryptable. Firefox and Chrome
    // both strip the padding today; nothing guarantees they always will.
    await post(SUB, { ...FULL, p256dh: P256DH_PADDED, auth: AUTH_PADDED });

    expect(subs()[0]?.p256dh).toBe(P256DH_PADDED);
    expect(subs()[0]?.auth).toBe(AUTH_PADDED);
  });

  it("pads a length%4==2 value with two and a length%4==3 value with one", async () => {
    // The two arithmetic cases spelled out, because `4 - (len % 4)` is the kind
    // of expression that survives being written backwards. "abcdef" is 6
    // characters (6 % 4 == 2 -> "=="), "abcdefg" is 7 (7 % 4 == 3 -> "=").
    await post(SUB, { endpoint: ENDPOINT, p256dh: "abcdef", auth: "abcdefg" });

    expect(subs()[0]?.p256dh).toBe("abcdef==");
    expect(subs()[0]?.auth).toBe("abcdefg=");
  });

  it("appends THREE '=' to a length%4==1 value, which is not valid base64 -- SUSPECT, and Django's bug too", async () => {
    // 4 - (1 % 4) == 3, so a single stray character produces "x===". No base64
    // decoder accepts three padding characters, so the stored row is
    // permanently undecryptable rather than obviously invalid, and
    // needWebPush.ts:135 will quietly drop it on every send forever.
    //
    // This is NOT a port defect: fix_base64_padding does exactly the same
    // arithmetic (gfwfbn/views.py:44-46), so Django stored the same string. It
    // is pinned as the behaviour the port faithfully reproduces and reported as
    // suspect, not corrected here. A base64url value can never legitimately
    // have length % 4 == 1, so this only arises for input that was already
    // junk -- but "already junk" is stored as a live subscription either way.
    await post(SUB, { endpoint: ENDPOINT, p256dh: "abcde", auth: AUTH });

    expect(subs()[0]?.p256dh).toBe("abcde===");
  });

  it("is applied to p256dh and auth but NEVER to endpoint", async () => {
    // Django pads exactly two of the three fields. Padding the endpoint would
    // append '=' characters to a URL, and since the DELETE matches the endpoint
    // exactly, that subscription could never be unsubscribed again -- and the
    // send would POST to a URL the push service does not recognise. The
    // endpoint chosen here has length % 4 == 3, so a stray call to the padder
    // would be visible.
    const e = "https://push.example/ab";
    expect(e.length % 4).toBe(3);

    await post(SUB, { endpoint: e, p256dh: P256DH, auth: AUTH });

    expect(subs()[0]?.endpoint).toBe(e);
  });

  it("keeps padded keys decodable back to the exact bytes webPushCrypto needs", async () => {
    // The point of all of the above, asserted end to end rather than as string
    // shapes: what comes out of the column has to decode to a 65-byte
    // uncompressed P-256 point (leading 0x04) and a 16-byte auth secret, which
    // is precisely what webPushCrypto.ts:75-79 requires before it will encrypt
    // anything. This is the assertion that would fail if the padding logic were
    // "improved" in any direction at all.
    await post(SUB, FULL);

    const row = subs()[0];
    const point = Buffer.from(row?.p256dh as string, "base64");
    const secret = Buffer.from(row?.auth as string, "base64");

    expect(point.length).toBe(65);
    expect(point[0]).toBe(0x04);
    expect(secret.length).toBe(16);
  });
});

// ===========================================================================
// wfbnWebpushSubscribe -- IDEMPOTENCE, the reason Django used
// update_or_create()
// ===========================================================================

describe("re-subscribing the same browser", () => {
  it("updates the existing row in place and reports created: false", async () => {
    // webpush.js calls subscribe() every time the visitor clicks the button,
    // and pushManager.subscribe() returns the SAME endpoint for a registration
    // that already exists. Django's update_or_create keys on (foodbank,
    // endpoint) -- the model's own unique_together -- and the port's SELECT
    // uses the identical pair against the `webpush_fb_endpoint_uniq` index.
    //
    // An INSERT-every-time version would not merely inflate the count: the
    // unique index would reject the second insert outright, so the visitor's
    // second click would 500. There is a real constraint behind this one,
    // unlike mobilesubscriber.
    await post(SUB, FULL);
    const second = await post(SUB, { ...FULL, browser: "Firefox/145.0" });

    expect(await second.json()).toEqual({ success: true, created: false, subscription_id: 1 });
    expect(subs()).toHaveLength(1);
    expect(subs()[0]?.browser).toBe("Firefox/145.0");
  });

  it("refreshes the key material, because the browser may have rotated it", async () => {
    // The UPDATE writes p256dh and auth unconditionally, which is the whole
    // point: a browser that re-subscribes after clearing site data keeps the
    // endpoint but generates NEW keys. An upsert that only touched `browser`
    // would leave the old keys against the live endpoint and every subsequent
    // notification would arrive undecryptable.
    await post(SUB, FULL);

    await post(SUB, { endpoint: ENDPOINT, p256dh: "abcdef", auth: "abcdefg", browser: UA });

    expect(subs()[0]?.p256dh).toBe("abcdef==");
    expect(subs()[0]?.auth).toBe("abcdefg=");
  });

  it("preserves the row's id and its original created timestamp", async () => {
    // subscribers.ts:147-158 chose find-then-UPDATE over INSERT OR REPLACE so
    // the row keeps its identity. `created` is what adminLists.ts's
    // getSubscriptionsPage orders by and what adminStats.ts's signup graph
    // buckets by date, so re-stamping it on every click would move every
    // still-subscribed browser to today and turn "when did people subscribe"
    // into "when did they last click the button" -- a graph that is wrong
    // without ever looking broken.
    await post(SUB, FULL);
    const first = subs()[0];

    vi.setSystemTime(new Date("2026-09-09T11:00:00.000Z"));
    await post(SUB, { ...FULL, browser: "Safari/26.0" });

    expect(subs()).toEqual([{ ...first, browser: "Safari/26.0" }]);
    expect(subs()[0]?.created).toBe(NOW_PY);
  });

  it("blanks a previously-set browser when the client stops sending it", async () => {
    // The UPDATE writes `browser` unconditionally, same as Django's `defaults`
    // dict. Worth pinning because the opposite -- a partial update that
    // preserves what is not sent -- is the more common API convention.
    await post(SUB, FULL);
    await post(SUB, { endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH });

    expect(subs()[0]?.browser).toBeNull();
  });

  it("treats a different endpoint as a different subscription", async () => {
    // One browser profile can hold several push registrations, and the endpoint
    // is what tells them apart. A match that had dropped `endpoint = ?` would
    // let a re-subscribe overwrite an unrelated live subscription.
    await post(SUB, FULL);
    await post(SUB, { ...FULL, endpoint: ENDPOINT_2 });

    expect(subs().map((r) => r.endpoint)).toEqual([ENDPOINT, ENDPOINT_2]);
  });

  it("keeps the SAME endpoint subscribed to two different food banks as two rows", async () => {
    // THE MOST LIKELY REAL-WORLD SHAPE, and the one a dropped `foodbank_id = ?`
    // would break. A visitor who follows two food banks from one browser has
    // ONE push endpoint (it is per-browser-profile, not per-site-section) and
    // two rows. If the lookup matched on endpoint alone, subscribing to the
    // second food bank would silently move the first subscription across --
    // 200, `created: false`, and one food bank quietly lost a subscriber.
    await post(SUB, FULL);
    await post(`/needs/webpush/subscribe/${DEVIZES}/`, FULL);

    expect(subs().map((r) => [r.foodbank_id, r.endpoint])).toEqual([
      [SALISBURY_ID, ENDPOINT],
      [DEVIZES_ID, ENDPOINT],
    ]);
  });

  it("matches the endpoint exactly, case and trailing slash included", async () => {
    // No normalisation anywhere on this path, and the unique index is over the
    // raw text. A client that changed the case of its endpoint between visits
    // would accumulate a second row rather than update the first -- pinned so
    // that adding normalisation is a decision, since it would also have to be
    // applied to every row already stored.
    await post(SUB, FULL);
    await post(SUB, { ...FULL, endpoint: `${ENDPOINT}/` });

    expect(subs()).toHaveLength(2);
  });
});

// ===========================================================================
// wfbnWebpushSubscribe -- THE 400 GATE
// ===========================================================================

describe("wfbnWebpushSubscribe rejects a bad request", () => {
  // Django: `if not endpoint or not p256dh or not auth: return
  // HttpResponseBadRequest()`. All three are checked for TRUTHINESS, so absent,
  // empty and (in the port) non-string are the same answer.
  const REQUIRED = ["endpoint", "p256dh", "auth"] as const;

  for (const field of REQUIRED) {
    it(`400s when ${field} is missing entirely`, async () => {
      const body: Record<string, unknown> = { ...FULL };
      delete body[field];

      const res = await post(SUB, body);

      expect(res.status).toBe(400);
      expect(subs()).toEqual([]);
    });

    it(`400s when ${field} is present but empty`, async () => {
      const res = await post(SUB, { ...FULL, [field]: "" });

      expect(res.status).toBe(400);
      expect(subs()).toEqual([]);
    });

    it(`400s when ${field} is not a string`, async () => {
      // The port coerces a non-string to "" and then fails the truthiness gate.
      // Django has no type check: `if not endpoint` passes for the number 42,
      // and `endpoint.startswith` then raises AttributeError, which the blanket
      // `except Exception` turns into a 500. A DIVERGENCE (400 vs 500), pinned
      // in the port's direction because the important half is shared -- nothing
      // reaches the INSERT and gets stringified into a key column.
      const res = await post(SUB, { ...FULL, [field]: 42 });

      expect(res.status).toBe(400);
      expect(subs()).toEqual([]);
    });
  }

  it("returns an empty body on the 400, typed text/plain rather than Django's text/html", async () => {
    // The EMPTY BODY is the parity claim: Django's HttpResponseBadRequest()
    // carries b'' too (constructed under Django 5.2.6 on this machine). The
    // CONTENT TYPE diverges and is pinned as-is -- Django reports
    // `text/html; charset=utf-8` where `new Response("", {status: 400})` gets
    // undici's default `text/plain;charset=UTF-8`. Nothing reads it, the body
    // being empty either way, but it is a real difference.
    //
    // webpush.js turns any non-ok response into "Failed to subscribe: Server
    // subscription failed", so the visitor is told something went wrong and
    // nothing anywhere records what.
    const res = await post(SUB, {});

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
  });

  it("400s a malformed JSON body instead of throwing a 500", async () => {
    // parseJsonBody's try/catch, matching Django's `except json.JSONDecodeError:
    // return HttpResponseBadRequest()`. Without it a truncated body -- which is
    // what a connection dropped mid-POST looks like -- would be an uncaught
    // exception reaching app.onError, i.e. a 500 and a logged error for
    // something that is entirely the client's business.
    const res = await post(SUB, '{"endpoint": "https://push.example/x", "p256dh"');

    expect(res.status).toBe(400);
    expect(subs()).toEqual([]);
  });

  it("400s an empty body", async () => {
    const res = await app.request(
      `${ORIGIN}${SUB}`,
      { method: "POST", headers: { "Content-Type": JSON_TYPE } },
      env(),
      execCtx,
    );

    expect(res.status).toBe(400);
    expect(subs()).toEqual([]);
  });

  it("400s a JSON body that is a literal null, an array or a scalar", async () => {
    // `JSON.parse("null")` is null, which parseJsonBody's caller cannot tell
    // apart from a parse failure -- both are 400, so the conflation is
    // harmless here and is pinned so it stays that way. An array and a number
    // survive the parse and then have no `endpoint` property, so they fail the
    // required-field gate instead. All four routes lead to the same answer,
    // which is what a client sending the wrong shape should get.
    for (const body of ["null", "[]", "42", '"endpoint"']) {
      const res = await post(SUB, body);
      expect(res.status, body).toBe(400);
    }
    expect(subs()).toEqual([]);
  });

  it("parses the body regardless of Content-Type, unlike the form-encoded endpoints", async () => {
    // c.req.json() reads the raw body and does not consult the header, so a
    // client sending text/plain still succeeds. Django's `json.loads(request.body)`
    // ignores the header too -- this is PARITY, and it is the opposite of
    // mobsub.ts, where `parseBody` returns {} for anything that is not a form
    // encoding and a JSON post therefore 400s. Two endpoints on the same site
    // with opposite Content-Type behaviour is exactly the sort of thing a
    // client rewrite gets wrong, so both are pinned.
    const res = await post(SUB, FULL, { headers: { "Content-Type": "text/plain" } });

    expect(res.status).toBe(200);
    expect(subs()).toHaveLength(1);
  });
});

// ===========================================================================
// wfbnWebpushSubscribe -- THE ENDPOINT VALIDATION, where the port and Django
// genuinely disagree
// ===========================================================================

describe("the endpoint must be an https URL", () => {
  it("400s a plaintext http endpoint", async () => {
    // `if not endpoint.startswith('https://')`. Push services are https-only,
    // and an http endpoint would mean posting an encrypted payload plus its
    // VAPID authorization header over the wire in clear.
    const res = await post(SUB, { ...FULL, endpoint: "http://push.example/wpush/v2/abc" });

    expect(res.status).toBe(400);
    expect(subs()).toEqual([]);
  });

  it("400s an uppercase HTTPS:// scheme, because startsWith is case-sensitive", async () => {
    // Python's str.startswith is case-sensitive too, so this is parity rather
    // than an oversight -- and it matters that it stays that way: the check is
    // a prefix test on the RAW string, not on the parsed URL, so relaxing it
    // would let "HTTPS://" through to a `new URL()` that happily accepts it.
    const res = await post(SUB, { ...FULL, endpoint: "HTTPS://push.example/wpush/v2/abc" });

    expect(res.status).toBe(400);
  });

  it("400s other schemes and relative paths", async () => {
    for (const endpoint of ["ftp://push.example/x", "//push.example/x", "/wpush/v2/abc", "javascript:alert(1)", "data:text/plain,x"]) {
      const res = await post(SUB, { ...FULL, endpoint });
      expect(res.status, endpoint).toBe(400);
    }
    expect(subs()).toEqual([]);
  });

  it("400s a bare 'https://' with no host at all", async () => {
    // Passes the startsWith check and fails `new URL()`, which is the entire
    // reason the second check exists -- the prefix test alone would store an
    // endpoint that can never be POSTed to.
    const res = await post(SUB, { ...FULL, endpoint: "https://" });

    expect(res.status).toBe(400);
    expect(subs()).toEqual([]);
  });

  it("accepts the real Mozilla and Google endpoint shapes", async () => {
    // The two push services this site actually reaches. Both are valid under
    // Django's URLValidator as well (run under Django 5.2.6 on this machine).
    for (const endpoint of [ENDPOINT, ENDPOINT_2]) {
      const res = await post(SUB, { ...FULL, endpoint });
      expect(res.status, endpoint).toBe(200);
    }
    expect(subs()).toHaveLength(2);
  });

  it("accepts endpoints Django's URLValidator REJECTS -- a real DIVERGENCE", async () => {
    // `new URL()` is the WHATWG parser; Django uses a regex-based URLValidator
    // that demands a hostname with a TLD (or localhost, or an IP literal) and
    // forbids spaces. Run under Django 5.2.6 on this machine, the validator
    // calls all three of these INVALID, so Django answers 400 where this port
    // answers 200 and stores the row:
    //
    //   https://a               -- single-label host, no TLD
    //   https:///x              -- no host; WHATWG collapses it to https://x/
    //   https://push.example/a b -- a literal space in the path
    //
    // Recorded rather than corrected. None is reachable from a browser --
    // PushSubscription.endpoint is minted by the push service, not by the page
    // -- so the practical consequence is only that a hand-crafted POST can
    // store an unusable row. The row is harmless: needWebPush.ts's fetch to it
    // fails, and a 404/410 from a push service is what prunes dead rows anyway.
    for (const endpoint of ["https://a", "https:///x", "https://push.example/a b"]) {
      const res = await post(SUB, { ...FULL, endpoint });
      expect(res.status, endpoint).toBe(200);
    }
    // Stored verbatim, NOT as the parser's rewritten form: "https:///x" stays
    // three slashes here where new URL() would have made it "https://x/".
    expect(subs().map((r) => r.endpoint)).toEqual(["https://a", "https:///x", "https://push.example/a b"]);
  });

  it("validates the endpoint AFTER resolving the food bank, so an unknown slug 404s first", async () => {
    // Django's order is method -> get_object_or_404 -> json.loads -> field
    // checks, and the port reproduces it. Worth pinning because the tidier
    // arrangement (validate the cheap body first, hit D1 second) would change
    // the answer for exactly this request from 404 to 400, and a client cannot
    // tell "wrong food bank" from "bad payload" once they are merged.
    const res = await post("/needs/webpush/subscribe/no-such-foodbank/", { ...FULL, endpoint: "not-a-url" });

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// wfbnWebpushSubscribe -- RESOLVING THE FOOD BANK
// ===========================================================================

describe("the food bank slug", () => {
  it("404s an unknown slug and writes nothing", async () => {
    const res = await post("/needs/webpush/subscribe/no-such-foodbank/", FULL);

    expect(res.status).toBe(404);
    expect(subs()).toEqual([]);
  });

  it("answers the site's real 404 page rather than a bare Hono 404", async () => {
    // `c.notFound()` routes through index.ts's app.notFound(), which renders
    // 404.njk. webpush.js does not care -- it only reads response.ok -- but this
    // is a public URL and Django's Http404 rendered a page here too.
    const res = await post("/needs/webpush/subscribe/no-such-foodbank/", FULL);

    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("404 - Not Found");
  });

  it("resolves the slug to the right food bank, not just the first row", async () => {
    // Devizes is seeded in every test and almost never asked for. A lookup that
    // had lost its `WHERE slug = ?` would return Salisbury's id for every
    // request, subscribe every visitor to Salisbury, and still answer 200 with
    // `created: true`.
    await post(`/needs/webpush/subscribe/${DEVIZES}/`, FULL);

    expect(subs()[0]?.foodbank_id).toBe(DEVIZES_ID);
  });

  it("matches the slug case-sensitively", async () => {
    // SQLite's `=` is case-sensitive and the column has no COLLATE NOCASE, so
    // /needs/webpush/subscribe/Salisbury/ is a 404. Django's
    // `get_object_or_404(Foodbank, slug=slug)` on Postgres is case-sensitive
    // too. Pinned because "lowercase the slug first" looks equivalent -- every
    // stored slug is already lowercase -- and is not: it would turn this 404
    // into a subscription.
    const res = await post("/needs/webpush/subscribe/Salisbury/", FULL);

    expect(res.status).toBe(404);
    expect(subs()).toEqual([]);
  });

  it("accepts food bank id 0, rather than reporting it missing", async () => {
    // requirePostAndFoodbank tests `foodbankId === null`, and it has to:
    // `id INTEGER PRIMARY KEY` admits 0, and the tidier-looking
    // `if (!foodbankId)` would 404 a real food bank. The id is only ever used
    // as a bind afterwards, so this is the ONLY place the distinction is
    // observable -- the mutant survives every other test in this file.
    seedFoodbank(0, "zero-town");

    const res = await post("/needs/webpush/subscribe/zero-town/", FULL);

    expect(res.status).toBe(200);
    expect(subs()[0]?.foodbank_id).toBe(0);
  });

  it("does not fall back to a uuid", async () => {
    // The mirror of mobsub, which is uuid-keyed and must NOT accept a slug.
    // These two endpoints are slug-keyed (webpush.js builds the URL from the
    // page's slug), and a lookup that had grown an `OR uuid = ?` would quietly
    // create a second address for every food bank.
    const uuid = `uuid-${SALISBURY_ID}`.padEnd(32, "0");

    const res = await post(`/needs/webpush/subscribe/${uuid}/`, FULL);

    expect(res.status).toBe(404);
  });

  it("never reads the whole food bank row", async () => {
    // getFoodbankIdBySlug projects to `id` alone (foodbank.ts:408-411). A
    // `SELECT *` here would put a 60-column read on the subscribe path and
    // would be invisible in every other assertion in this file.
    await post(SUB, FULL);

    expect(sent.some((s) => s.sql.startsWith("SELECT * FROM foodbank"))).toBe(false);
  });
});

// ===========================================================================
// wfbnWebpushUnsubscribe
// ===========================================================================

describe("wfbnWebpushUnsubscribe removes the subscription", () => {
  it("deletes the matching row and reports success and deleted", async () => {
    // `JsonResponse({'success': True, 'deleted': deleted_count > 0})` -- note
    // the response carries BOTH fields where subscribe carries three. Asserted
    // on the raw text so a dropped `success` is a failure: webpush.js reads the
    // parsed object, and a future client checking `result.success` must keep
    // finding it.
    await post(SUB, FULL);

    const res = await post(UNSUB, { endpoint: ENDPOINT });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(JSON_TYPE);
    expect(await res.text()).toBe('{"success":true,"deleted":true}');
    expect(subs()).toEqual([]);
  });

  it("answers 200 with deleted: false when there was nothing to delete", async () => {
    // NOT a 404. Django reports `deleted_count > 0` straight through, so
    // unsubscribing something that was never subscribed is a success with a
    // `false`. webpush.js treats any non-ok response as an error and leaves the
    // button in its old state, so a 404 here would strand a visitor who had
    // already unsubscribed in another tab.
    const res = await post(UNSUB, { endpoint: ENDPOINT });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deleted: false });
  });

  it("is safe to deliver twice -- the second call is a no-op false", async () => {
    await post(SUB, FULL);

    const first = await post(UNSUB, { endpoint: ENDPOINT });
    const second = await post(UNSUB, { endpoint: ENDPOINT });

    expect(await first.json()).toEqual({ success: true, deleted: true });
    expect(await second.json()).toEqual({ success: true, deleted: false });
    expect(subs()).toEqual([]);
  });

  it("does not require p256dh, auth or browser, unlike subscribe", async () => {
    // ASYMMETRY, STRAIGHT FROM DJANGO: subscribe requires three fields,
    // unsubscribe requires only `endpoint`. Pinned because "harmonising" the
    // two guards would 400 every unsubscribe webpush.js sends -- it posts the
    // endpoint alone (static/js/webpush.js:199-205), and it has already called
    // subscription.unsubscribe() by then, so the keys no longer exist to send.
    await post(SUB, FULL);

    const res = await post(UNSUB, { endpoint: ENDPOINT });

    expect(res.status).toBe(200);
    expect(subs()).toEqual([]);
  });

  it("ignores extra fields rather than rejecting them", async () => {
    // `data.get('endpoint')` and nothing else in Django; the port destructures
    // one property off the parsed object. A client that posted its whole
    // subscription object back must still unsubscribe.
    await post(SUB, FULL);

    const res = await post(UNSUB, { ...FULL, extra: "ignored" });

    expect(await res.json()).toEqual({ success: true, deleted: true });
  });

  it("400s a missing, empty or non-string endpoint without deleting anything", async () => {
    for (const body of [{}, { endpoint: "" }, { endpoint: null }, { endpoint: 42 }, { endpoint: ["a"] }]) {
      await post(SUB, FULL);
      const res = await post(UNSUB, body);

      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.text()).toBe("");
      // The 400 is a refusal, not a deletion: the row is still there.
      expect(subs(), JSON.stringify(body)).toHaveLength(1);
      db.prepare("DELETE FROM webpushsubscription").run();
    }
  });

  it("400s a malformed JSON body", async () => {
    await post(SUB, FULL);

    const res = await post(UNSUB, "{");

    expect(res.status).toBe(400);
    expect(subs()).toHaveLength(1);
  });

  it("does NOT pad the endpoint, so an unsubscribe matches what subscribe stored", async () => {
    // fix_base64_padding is applied to p256dh and auth only, on both sides. The
    // endpoint round-trips untouched through subscribe and unsubscribe, which
    // is what makes the exact-match DELETE work at all -- if either side padded
    // it, unsubscribe would silently answer `deleted: false` forever and the
    // visitor would keep receiving notifications after turning them off.
    const e = "https://push.example/ab"; // length % 4 == 3, i.e. would gain a '='
    await post(SUB, { ...FULL, endpoint: e });

    const res = await post(UNSUB, { endpoint: e });

    expect(await res.json()).toEqual({ success: true, deleted: true });
    expect(subs()).toEqual([]);
  });

  it("404s an unknown food bank without deleting anything", async () => {
    await post(SUB, FULL);
    prepared.length = 0;

    const res = await post("/needs/webpush/unsubscribe/no-such-foodbank/", { endpoint: ENDPOINT });

    expect(res.status).toBe(404);
    expect(subs()).toHaveLength(1);
    // The DELETE was never even prepared -- the 404 happens first.
    expect(prepared.some((sql) => sql.startsWith("DELETE"))).toBe(false);
  });
});

describe("what wfbnWebpushUnsubscribe is careful NOT to remove", () => {
  it("leaves the SAME endpoint's subscription to another food bank alone", async () => {
    // THE ONE ASSERTION IN THIS FILE THAT PROTECTS OTHER PEOPLE'S DATA. One
    // browser has one push endpoint across the whole site, so a visitor who
    // follows two food banks has two rows sharing an endpoint. The DELETE's
    // `foodbank_id = ?` is the only thing keeping "stop notifying me about
    // Salisbury" from meaning "stop notifying me about everything" -- and it
    // would still answer `deleted: true`, so neither the page nor the visitor
    // would learn anything had happened.
    await post(SUB, FULL);
    await post(`/needs/webpush/subscribe/${DEVIZES}/`, FULL);

    const res = await post(UNSUB, { endpoint: ENDPOINT });

    expect(await res.json()).toEqual({ success: true, deleted: true });
    expect(subs().map((r) => r.foodbank_id)).toEqual([DEVIZES_ID]);
  });

  it("leaves another browser's subscription to the same food bank alone", async () => {
    // The endpoint is the only thing separating two visitors here. Without it
    // in the WHERE clause, one person unsubscribing would unsubscribe everybody
    // following that food bank -- the single worst outcome available on this
    // path, and one nothing downstream would report.
    await post(SUB, FULL);
    await post(SUB, { ...FULL, endpoint: ENDPOINT_2 });

    await post(UNSUB, { endpoint: ENDPOINT });

    expect(subs().map((r) => r.endpoint)).toEqual([ENDPOINT_2]);
  });

  it("does not match on a prefix of the endpoint", async () => {
    // `endpoint = ?`, never a LIKE. Push endpoints share long common prefixes
    // (every Mozilla one starts /wpush/v2/), so a prefix match would delete
    // whole cohorts of subscribers at a time.
    await post(SUB, FULL);

    const res = await post(UNSUB, { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/" });

    expect(await res.json()).toEqual({ success: true, deleted: false });
    expect(subs()).toHaveLength(1);
  });
});

// ===========================================================================
// THE METHOD CHECK -- in the handler, not the router, and the reason both
// routes are app.all()
// ===========================================================================

describe("the hand-rolled method check", () => {
  it("400s every non-POST method on subscribe and unsubscribe", async () => {
    // webpush.ts:24-34 and index.ts:370-374 are explicit: Django's two views
    // carry NO @require_POST (unlike `mobsub`), they check request.method by
    // hand and return HttpResponseBadRequest. Reproducing that means
    // registering with app.all() -- with app.post() Hono itself would 404 and
    // the check inside the handler would be dead code.
    //
    // So the 400 IS the parity assertion. Both statuses matter to nobody in
    // practice; what matters is that the answer comes from this module rather
    // than from the router, because that is what the next person editing
    // index.ts has to preserve.
    await post(SUB, FULL);

    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      for (const path of [SUB, UNSUB]) {
        const res = await app.request(`${ORIGIN}${path}`, { method }, env(), execCtx);
        expect(res.status, `${method} ${path}`).toBe(400);
      }
    }
    // Eight requests, none of which touched the subscription.
    expect(subs()).toHaveLength(1);
  });

  it("A GET NEVER DELETES", async () => {
    // The whole reason the previous test's DELETE case is not enough on its
    // own. /needs/webpush/unsubscribe/<slug>/ is a plain URL: a link checker,
    // a prefetching browser, an email scanner or a chat client's preview
    // fetcher will GET it. Under Django `request.body` would be empty and the
    // view would 400 as well, so this is parity -- but it is the assertion
    // worth having regardless of parity, because a route registered app.all()
    // is one deleted `if` away from answering a GET with a mutation.
    await post(SUB, FULL);
    sent.length = 0;

    await app.request(`${ORIGIN}${UNSUB}?endpoint=${encodeURIComponent(ENDPOINT)}`, { method: "GET" }, env(), execCtx);

    expect(subs()).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("400s before touching D1 at all, and before looking at the slug", async () => {
    // `if (c.req.method !== "POST") return new Response("", {status: 400})` is
    // the first line of requirePostAndFoodbank, ahead of getFoodbankIdBySlug.
    // Both halves are worth an assertion: these URLs are reachable
    // unauthenticated by anyone on the internet, so a wrong-method flood must
    // not become a D1 query flood -- and an unknown slug with a wrong method
    // answers 400, not 404, which is the observable proof of the ordering.
    const res = await app.request(`${ORIGIN}/needs/webpush/subscribe/no-such-foodbank/`, { method: "GET" }, env(), execCtx);

    expect(res.status).toBe(400);
    expect(prepared).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("returns the same empty text/plain body as the field-validation 400", async () => {
    const res = await app.request(`${ORIGIN}${SUB}`, { method: "GET" }, env(), execCtx);

    expect(await res.text()).toBe("");
    expect(res.headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
  });
});

// ===========================================================================
// WHAT REACHES THE DATABASE -- the exact statements and binds
// ===========================================================================

describe("the statements each endpoint sends", () => {
  it("subscribe sends the slug lookup, the existence check and the INSERT, in that order and no more", async () => {
    await post(SUB, FULL);

    expect(sent.map((s) => s.sql)).toEqual([
      "SELECT id FROM foodbank WHERE slug = ?",
      "SELECT id FROM webpushsubscription WHERE foodbank_id = ? AND endpoint = ?",
      "INSERT INTO webpushsubscription (created, foodbank_id, endpoint, p256dh, auth, browser) VALUES (?, ?, ?, ?, ?, ?)",
    ]);
  });

  it("binds the PADDED keys and the raw endpoint into the INSERT, in column order", async () => {
    // The bind list is where a transposition actually happens, and the response
    // is identical whichever way round the three strings go. Asserted as values
    // rather than inferred from the stored row so that a failure names the
    // statement rather than the table.
    await post(SUB, FULL);

    const insert = sent.find((s) => s.sql.startsWith("INSERT"));
    expect(insert?.params).toEqual([NOW_PY, SALISBURY_ID, ENDPOINT, P256DH_PADDED, AUTH_PADDED, UA]);
  });

  it("scopes the existence check to the resolved food bank id", async () => {
    // The `foodbank_id = ?` bind asserted as a VALUE -- binding the wrong id
    // (say, a hardcoded 1) would leave the SQL text looking correct while
    // making one browser's subscription to one food bank overwrite another's.
    await post(`/needs/webpush/subscribe/${DEVIZES}/`, FULL);

    expect(sent[1]).toEqual({
      sql: "SELECT id FROM webpushsubscription WHERE foodbank_id = ? AND endpoint = ?",
      params: [DEVIZES_ID, ENDPOINT],
    });
  });

  it("re-subscription sends an UPDATE keyed on the row id, never a second INSERT", async () => {
    await post(SUB, FULL);
    sent.length = 0;

    await post(SUB, { ...FULL, browser: "Firefox/145.0" });

    expect(sent.map((s) => s.sql)).toEqual([
      "SELECT id FROM foodbank WHERE slug = ?",
      "SELECT id FROM webpushsubscription WHERE foodbank_id = ? AND endpoint = ?",
      "UPDATE webpushsubscription SET p256dh = ?, auth = ?, browser = ? WHERE id = ?",
    ]);
    expect(sent[2]?.params).toEqual([P256DH_PADDED, AUTH_PADDED, "Firefox/145.0", 1]);
  });

  it("the UPDATE never rewrites created, foodbank_id or endpoint", async () => {
    // Asserted on the SQL text as well as on the row, because "SET created = ?"
    // creeping into that statement is the exact edit that would silently reset
    // every subscriber's signup date -- and the row-level assertion above would
    // still pass on a fixture where the clock had not moved.
    await post(SUB, FULL);
    await post(SUB, FULL);

    const update = sent.find((s) => s.sql.startsWith("UPDATE"));
    expect(update?.sql).not.toContain("created");
    expect(update?.sql).not.toContain("foodbank_id");
    expect(update?.sql).not.toContain("endpoint");
  });

  it("unsubscribe sends exactly the slug lookup and the DELETE", async () => {
    await post(SUB, FULL);
    sent.length = 0;

    await post(UNSUB, { endpoint: ENDPOINT });

    expect(sent).toEqual([
      { sql: "SELECT id FROM foodbank WHERE slug = ?", params: [SALISBURY] },
      {
        sql: "DELETE FROM webpushsubscription WHERE foodbank_id = ? AND endpoint = ?",
        params: [SALISBURY_ID, ENDPOINT],
      },
    ]);
  });

  it("opens one D1 session per request and reuses it for both statements", async () => {
    // dbSession(c) is called once at the top of each handler and threaded
    // through, which is what gives the lookup and the write a consistent read
    // view (lib/session.ts, PLAN.md §3.3 -- this database has read replication
    // enabled). A second withSession() for the write could read a replica that
    // has not yet seen the row the first statement just found.
    const sessions: unknown[] = [];
    const trackingEnv = { ...env(), DB: { withSession: () => { const s = d1Session(); sessions.push(s); return s; } } };

    await app.request(
      `${ORIGIN}${SUB}`,
      { method: "POST", headers: { "Content-Type": JSON_TYPE }, body: JSON.stringify(FULL) },
      trackingEnv as unknown as AppEnv["Bindings"],
      execCtx,
    );

    expect(sessions).toHaveLength(1);
    expect(sent).toHaveLength(3);
  });
});

// ===========================================================================
// ROUTING -- none of it is in webpush.ts, all of it decides whether it runs
// ===========================================================================

describe("where the three endpoints are and are not mounted", () => {
  it("404s the unslashed subscribe/unsubscribe paths on a POST, so the body is never replayed", async () => {
    // lib/appendSlash.ts restricts APPEND_SLASH to GET/HEAD -- a deliberate
    // deviation from Django, which 301s a POST too. Django's behaviour would be
    // worse than a 404 here: a client following a 301 from a POST re-issues it
    // as a GET, dropping the body, so the subscription would vanish while
    // webpush.js saw a 2xx and told the visitor it had worked.
    for (const path of [`/needs/webpush/subscribe/${SALISBURY}`, `/needs/webpush/unsubscribe/${SALISBURY}`]) {
      const res = await post(path, FULL);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Location"), path).toBeNull();
    }
    expect(subs()).toEqual([]);
  });

  it("is not mounted under any language prefix", async () => {
    // The wfbn-generic URLs are registered before i18n_patterns in
    // givefood/urls.py, so each has exactly one address in Django too, and
    // webpush.js hardcodes the unprefixed path from whatever language page the
    // visitor is on.
    for (const prefix of ["/cy", "/ga", "/gd", "/en"]) {
      const res = await post(`${prefix}${SUB}`, FULL);
      expect(res.status, prefix).toBe(404);
    }
    expect(subs()).toEqual([]);
  });

  it("keeps subscribe and unsubscribe as distinct routes", async () => {
    // Both are /needs/webpush/<verb>/:slug/, one path segment apart. If either
    // were ever swallowed by the other -- or by a :slug route registered
    // earlier -- the observable symptom would be an unsubscribe that answers
    // `{"success":true,"created":...}` and leaves the row in place. Asserted by
    // the difference in the two bodies.
    expect(await (await post(SUB, FULL)).json()).toEqual({ success: true, created: true, subscription_id: 1 });
    expect(await (await post(UNSUB, { endpoint: ENDPOINT })).json()).toEqual({ success: true, deleted: true });
  });

  it("404s a slug-less path rather than treating the verb as the slug", async () => {
    // `:slug` matches a whole segment, so /needs/webpush/subscribe/ has nothing
    // to bind and never reaches the handler -- which matters because
    // `c.req.param("slug")!` is a non-null assertion, and an empty slug would
    // reach getFoodbankIdBySlug as undefined.
    for (const path of ["/needs/webpush/subscribe/", "/needs/webpush/unsubscribe/"]) {
      const res = await post(path, FULL);
      expect(res.status, path).toBe(404);
    }
  });

  it("requires no CSRF token, no cookie and no same-origin check", async () => {
    // Both Django views are @csrf_exempt (their docstrings say why), and this
    // port adds no gate of its own. LOAD-BEARING: webpush.js posts JSON with no
    // token, so any CSRF check here would reject every real subscription. The
    // hostile Origin is deliberate -- it is the header a browser-based forgery
    // would carry, and this endpoint accepts it by design.
    //
    // The exposure that buys is bounded and worth naming: a forged request can
    // subscribe an endpoint it already possesses, or unsubscribe one, for a
    // food bank of its choosing. It cannot read anything back.
    const res = await post(SUB, FULL, {
      headers: { "Content-Type": JSON_TYPE, Origin: "https://attacker.example" },
    });

    expect(res.status).toBe(200);
    expect(subs()).toHaveLength(1);
  });

  it("carries the standard security headers and Content-Language on the JSON responses", async () => {
    // securityHeaders and resolveLanguage are mounted on "*", so they stamp
    // even a machine-to-machine JSON response. Pinned because a "skip the
    // middleware for the API paths" optimisation would drop them silently.
    const res = await post(SUB, FULL);

    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("sets no Cache-Control and no Cache-Tag on subscribe or unsubscribe", async () => {
    // middleware/pageCacheControl.ts only touches a GET, and
    // middleware/cacheTag.ts derives tags from the path -- /needs/webpush/... is
    // not under /needs/at/<slug>/, so a subscription purges nothing. Correct,
    // since it changes no rendered page, and this is the assertion that keeps
    // it that way if the routes ever move under a food bank's own path.
    const res = await post(SUB, FULL);

    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });
});

// ===========================================================================
// FAILURE
// ===========================================================================

describe("when D1 fails mid-request", () => {
  it("500s on a failing INSERT rather than reporting success", async () => {
    // There is no try/catch on this path, so the error reaches index.ts's
    // onError. That is the right answer even though nobody watches it:
    // `{"success":true}` over a write that did not happen would leave
    // webpush.js writing the food bank into localStorage and telling the
    // visitor they are subscribed, permanently, with no notification ever
    // arriving and no way for either side to find out.
    //
    // A DIVERGENCE in the status body: Django's blanket `except Exception as e`
    // returns `JsonResponse({'error': str(e)}, status=500)`, i.e. a 500 with the
    // database error text in it. The port returns the site's 500 page. Same
    // status, and the port's is the better of the two -- Django's leaks
    // exception text to the caller.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failOnPrefix = "INSERT INTO webpushsubscription";

    const res = await post(SUB, FULL);

    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalled();
    expect(subs()).toEqual([]);
  });

  it("500s on a failing DELETE rather than reporting deleted", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await post(SUB, FULL);
    failOnPrefix = "DELETE FROM webpushsubscription";

    const res = await post(UNSUB, { endpoint: ENDPOINT });

    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalled();
    expect(subs()).toHaveLength(1);
  });

  it("500s on a failing slug lookup, and does not mistake it for a 404", async () => {
    // A read failure and an unknown slug must not look the same to the caller:
    // one is "try again", the other is "this food bank does not exist". If
    // getFoodbankIdBySlug ever grew a try/catch returning null, every visitor
    // would get a 404 during a D1 incident, and webpush.js would report
    // "Failed to subscribe" for a food bank that is perfectly fine.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failOnPrefix = "SELECT id FROM foodbank";

    const res = await post(SUB, FULL);

    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalled();
  });

  it("500s on a failing existence check, before anything is written", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failOnPrefix = "SELECT id FROM webpushsubscription";

    const res = await post(SUB, FULL);

    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalled();
    expect(subs()).toEqual([]);
  });
});

// ===========================================================================
// THE EXPORTS THEMSELVES
// ===========================================================================

describe("the module's exports", () => {
  it("exports exactly the three handlers index.ts mounts", async () => {
    // The helpers -- fixBase64Padding, requirePostAndFoodbank and parseJsonBody
    // -- are module-private on purpose and are exercised through the handlers
    // above. This assertion is what stops them being exported "for
    // testability", which is the change that turns an internal refactor into a
    // breaking one. fixBase64Padding in particular has a standalone verifier
    // elsewhere in the repo (`pnpm verify:webpush`, RFC 8291 §5) that would be
    // the place for a byte-level test if one were ever wanted.
    const module = await import("./webpush");

    expect(Object.keys(module).sort()).toEqual(["wfbnWebpushConfig", "wfbnWebpushSubscribe", "wfbnWebpushUnsubscribe"]);
    expect(typeof wfbnWebpushConfig).toBe("function");
    expect(typeof wfbnWebpushSubscribe).toBe("function");
    expect(typeof wfbnWebpushUnsubscribe).toBe("function");
  });
});
