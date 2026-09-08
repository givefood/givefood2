import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import { wfbnDeleteMobsub, wfbnMobsub } from "./mobsub";
import type { AppEnv } from "../../types";

// routes/wfbn/mobsub.ts -- the two endpoints the SHIPPED NATIVE APPS use to
// register and cancel a device's need notifications. Django source:
// gfwfbn/views.py `mobsub` and `delete_mobsub`, read at
// /Users/jasoncartwright/Sites/foodcharity (the view bodies quoted in the
// comments below are from that file), routed at gfwfbn/urls/generic.py:25-26.
//
// WHY THIS FILE IS LONG. Every failure mode here is silent at both ends:
//
//   * The caller is an installed app, not a browser. A 400 or a 404 has no page
//     to look wrong on; it surfaces, if at all, as a support mail months later.
//   * The app's own version of the contract is FROZEN IN A SHIPPED BINARY. A
//     field name, a UUID spelling or a status code that drifts here cannot be
//     fixed by changing the caller; the old builds keep posting the old shape
//     forever. So this suite pins the wire contract field by field.
//   * Nothing downstream shouts. mobilesubscriber is NOT the push send list --
//     workers/jobs/src/notify/needFirebase.ts:5-13 is explicit that FCM
//     addresses a topic the apps subscribe themselves to and that the server
//     never holds a device list -- it is the "who is watching what" record.
//     Its only readers are admin pages (packages/db's getSubscriptionsPage,
//     getSubscriberSignupRows and the per-food-bank counts), so a row that
//     silently failed to save, or saved twice, surfaces as a slightly wrong
//     number on a page nobody diffs against anything.
//
// REAL APP, REAL SCHEMA, REAL SQL. `app` is the default export of
// workers/site/src/index.ts, so every request below goes through the real
// router -- which is where the POST-only gate actually lives (mobsub.ts:44-49
// says so explicitly: there is no internal method check, the app.post()
// registration IS the check) and where the 404 page, the language prefixes and
// APPEND_SLASH all live too. The queries are the shipped packages/db functions
// running their real SQL against Node's own SQLite, built from the real
// migrations via schemaFor(). NOTHING on the data path is faked: no D1 double
// that agrees with whatever it is told, no stubbed upsert.
//
// The narrow fixture is the three tables these two handlers touch. Deliberately
// NOT the whole of MIGRATIONS_SQL: naming them is what makes "this endpoint
// reads foodbank and foodbankdonationpoint and writes mobilesubscriber, and
// nothing else" an assertion rather than a hope -- a handler that grew a fourth
// table fails here with "no such table" instead of passing quietly.

const ORIGIN = "https://www.givefood.org.uk";
const FORM = "application/x-www-form-urlencoded";

// A fixed clock, so `created` can be asserted as an exact string rather than
// pattern-matched. The value matters: packages/models' pyNow() writes Django's
// `str(datetime)` spelling and D1 stores it as TEXT, which SQLite compares
// LEXICOGRAPHICALLY -- "2026-09-08T09:30:00.000Z" sorts after every same-day
// Django value because 'T' (0x54) beats ' ' (0x20).
//
// That is not theoretical for this column. adminStats.ts's
// getSubscriberSignupRows UNIONs mobilesubscriber.created with
// foodbanksubscriber's and webpushsubscription's and does one
// `ORDER BY created` across all three, and adminLists.ts's
// getSubscriptionsPage pages the same union `ORDER BY created DESC`. A
// toISOString() creeping in here would sort every mobile signup to the top of
// both, permanently, while each individual row still looked perfectly normal.
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

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite -- same
// shim as hit.test.ts and foodbankAddSub.test.ts, for the same reason: D1 is
// async where node:sqlite is synchronous, and that is the only difference that
// matters. The SQL text, the parameter binding, the NULL semantics of `IS ?`
// and the `changes` count are SQLite's on both sides.
//
// TWO THINGS THIS SHIM MUST GET RIGHT, because a handler bug hides behind
// either one:
//
//   * bind() returns a NEW statement rather than mutating the receiver, exactly
//     as D1's prepared statements do. A shim that mutated in place would let
//     the last bind of a request overwrite an earlier one and would make a
//     genuinely broken sequence of queries look correct.
//   * run() reports the real `meta.changes`. deleteMobileSubscriber's entire
//     return value is `result.meta.changes > 0`, which is what becomes the
//     `deleted` field of the JSON the app reads. A shim returning `meta: {}`
//     would make `deleted` `false` on every single call and every assertion
//     below would still be about a real DELETE.
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
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ===========================================================================
// SEEDS
// ===========================================================================

// STORED DASHLESS, 32 hex characters -- PLAN.md §4.4 and packages/db/src/uuid.ts:
// Postgres dumped these dashed, Django's own SQLite backend stores them
// dashless, and migration 0001 normalised to the dashless form. Writing them
// dashed here would make every lookup below pass for the wrong reason (or fail
// for one), so they are spelled the way the column actually holds them.
const SALISBURY_ID = 7;
const SALISBURY_UUID = "4f3f0d2b8c1e4a7d9b6e5c2a1f0d3e8b";
const SALISBURY_UUID_DASHED = "4f3f0d2b-8c1e-4a7d-9b6e-5c2a1f0d3e8b";

// A SECOND food bank, seeded in every test and almost never asked for. It is
// the control: `WHERE uuid = ?` with the predicate accidentally dropped returns
// the first row in the table, which against a one-row fixture is
// indistinguishable from a correct lookup. Its donation point below is the
// control for the cross-tenant check, which is the one genuinely
// security-shaped property in this file.
const DEVIZES_ID = 8;
const DEVIZES_UUID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

const SALISBURY_DP_ID = 101;
const SALISBURY_DP_UUID = "0c9e8d7b6a5f4e3d2c1b0a9f8e7d6c5b";
const DEVIZES_DP_ID = 202;
const DEVIZES_DP_UUID = "11223344556677889900aabbccddeeff";

const DEVICE = "device-abc-123";

// Only the NOT NULL columns are supplied; every column these handlers never
// read is left NULL on purpose, so a future version that started reading one
// fails here rather than silently subscribing a device against a null.
function seedFoodbank(id: number, uuid: string, slug: string): void {
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
  ).run(id, uuid, `Food bank ${id}`, slug);
}

function seedDonationPoint(id: number, uuid: string, foodbankId: number, slug: string): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint
       (id, uuid, foodbank_id, name, slug, address, postcode, lat_lng,
        is_closed, in_store_only, modified)
     VALUES (?, ?, ?, ?, ?, '2 Market Pl', 'SP1 2BB', '51.07,-1.80',
        0, 0, '2026-08-14 09:15:00.000000')`,
  ).run(id, uuid, foodbankId, `Donation point ${id}`, slug);
}

/** Every mobilesubscriber row, id order -- what the app's registration produced. */
function subscribers(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM mobilesubscriber ORDER BY id").all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  db = new DatabaseSync(":memory:");
  db.exec(schemaFor("foodbank", "foodbankdonationpoint", "mobilesubscriber"));
  prepared = [];
  sent = [];
  failOnPrefix = null;
  seedFoodbank(SALISBURY_ID, SALISBURY_UUID, "salisbury");
  seedFoodbank(DEVIZES_ID, DEVIZES_UUID, "devizes");
  seedDonationPoint(SALISBURY_DP_ID, SALISBURY_DP_UUID, SALISBURY_ID, "tesco-castle-street");
  seedDonationPoint(DEVIZES_DP_ID, DEVIZES_DP_UUID, DEVIZES_ID, "morrisons-devizes");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

/** A urlencoded POST, exactly as the native app sends one. */
async function post(path: string, fields: Record<string, string> | string, init: RequestInit = {}): Promise<Response> {
  const body = typeof fields === "string" ? fields : new URLSearchParams(fields).toString();
  // `await`ed rather than returned directly: app.request()'s declared return
  // type is `Response | Promise<Response>`, which does not satisfy a
  // `Promise<Response>` signature under tsc even though it always resolves.
  return await app.request(`${ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": FORM }, body, ...init }, env(), execCtx);
}

const SUB = "/needs/mobsub/";
const UNSUB = "/needs/mobsub/delete/";

// The minimum body Django's `if not device_id or not platform or not
// foodbank_uuid` accepts, plus nothing.
const MINIMAL = { device_id: DEVICE, platform: "ios", foodbank: SALISBURY_UUID };

// A full registration as the iOS app actually sends it -- every optional field
// populated, so that "which value landed in which column" is answerable. All
// seven optional values are DISTINCT and none is a substring of another: a
// swapped pair of binds in the INSERT is otherwise a change nothing detects
// (they are all free-text columns of the same type) until somebody tries to
// segment subscribers by app version and finds the timezone there.
const FULL = {
  ...MINIMAL,
  timezone: "Europe/London",
  locale: "en-GB",
  app_version: "2.4.1",
  os_version: "18.6",
  device_model: "iPhone17,2",
  sub_type: "needs",
};

// ===========================================================================
// mobsub -- THE ROW WRITTEN
// ===========================================================================

describe("mobsub writes the subscription", () => {
  it("stores every posted field in its own column, and stamps created in Django's format", async () => {
    const res = await post(SUB, FULL);

    expect(res.status).toBe(200);
    // The WHOLE row, not field by field: the seven optional columns are
    // interchangeable strings, so only an all-at-once comparison catches a
    // transposed bind in upsertMobileSubscriber's eleven-placeholder INSERT.
    expect(subscribers()).toEqual([
      {
        id: 1,
        created: NOW_PY,
        device_id: DEVICE,
        platform: "ios",
        timezone: "Europe/London",
        locale: "en-GB",
        app_version: "2.4.1",
        os_version: "18.6",
        device_model: "iPhone17,2",
        sub_type: "needs",
        foodbank_id: SALISBURY_ID,
        donationpoint_id: null,
      },
    ]);
  });

  it("resolves the food bank by UUID to the numeric FK, not by storing the UUID", async () => {
    // The mobile contract keys on Foodbank.uuid (gfwfbn/views.py's
    // `get_object_or_404(Foodbank, uuid=foodbank_uuid)`), but
    // mobilesubscriber.foodbank_id is an INTEGER FK. Devizes is seeded and not
    // asked for, so a lookup that had stopped filtering -- and returned the
    // first foodbank row -- would subscribe the device to the wrong food bank
    // and the app would still get a 200 with `success: true`.
    await post(SUB, { ...MINIMAL, foodbank: DEVIZES_UUID });

    expect(subscribers()[0]?.foodbank_id).toBe(DEVIZES_ID);
  });

  it("omits the optional fields as NULL rather than empty string", async () => {
    // packages/db writes exactly what mobsub.ts's optionalStringField() hands
    // it. NULL and "" are the same to a human reading the admin and completely
    // different to `WHERE timezone IS NOT NULL`, which is the shape any future
    // "send at 9am local time" job will use.
    await post(SUB, MINIMAL);

    expect(subscribers()).toEqual([
      {
        id: 1,
        created: NOW_PY,
        device_id: DEVICE,
        platform: "ios",
        timezone: null,
        locale: null,
        app_version: null,
        os_version: null,
        device_model: null,
        sub_type: null,
        foodbank_id: SALISBURY_ID,
        donationpoint_id: null,
      },
    ]);
  });

  it("collapses a present-but-empty optional field to NULL -- a DIVERGENCE from Django", async () => {
    // optionalStringField() maps "" to null. Django's
    // `request.POST.get("timezone")` returns the empty STRING for a field that
    // was sent empty (verified with Django 5.2.6 on this machine:
    // QueryDict("x=").get("x") is ''), and MobileSubscriber.timezone is a plain
    // CharField -- givefood/migrations/0001_initial.py:365, no null=True -- so
    // Django stored '' there and this port stores NULL.
    //
    // Pinned as the port's behaviour, not endorsed. It is arguably the better
    // of the two (see the suspected-bug note about Django's own NOT NULL
    // columns), but it means a `timezone = ''` query written against
    // production's data finds nothing here.
    await post(SUB, { ...MINIMAL, timezone: "", locale: "", sub_type: "" });

    const row = subscribers()[0];
    expect(row?.timezone).toBeNull();
    expect(row?.locale).toBeNull();
    expect(row?.sub_type).toBeNull();
  });

  it("keeps platform verbatim, since it is required and never normalised", async () => {
    // `platform` is the only required field with no lookup behind it, and it is
    // half of the identifier the admin's subscriptions list prints
    // (`platform || ' - ' || device_id`, adminLists.ts). Neither Django nor this
    // port lowercases it or validates it against a choice list, so "Android" and
    // "android" are two different values in the column and both are stored as
    // sent -- pinned so that adding normalisation is a decision rather than a
    // tidy-up that silently splits or merges the platform breakdown.
    await post(SUB, { ...MINIMAL, platform: "Android" });

    expect(subscribers()[0]?.platform).toBe("Android");
  });

  it("answers exactly {\"success\":true} as application/json", async () => {
    // Django returns `JsonResponse({"success": True})`, whose Content-Type is
    // the bare `application/json` (no charset) and whose body is
    // `{"success": true}` -- verified by constructing one under Django 5.2.6 on
    // this machine. Hono's c.json() matches the header exactly and differs only
    // in the space after the colon, which no JSON parser can see.
    //
    // Asserted on the raw text, not on the parsed object: the shipped apps read
    // this field, and a renamed or missing `success` cannot be fixed in the
    // builds already installed.
    const res = await post(SUB, MINIMAL);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe('{"success":true}');
  });

  it("does not report the row id or anything else about the subscription", async () => {
    // Deliberate: the response is a bare acknowledgement in Django too. Pinned
    // so that adding an id -- which would be a natural "improvement" -- is a
    // conscious change to a contract shipped binaries already depend on.
    const res = await post(SUB, FULL);

    expect(await res.json()).toEqual({ success: true });
  });
});

// ===========================================================================
// mobsub -- IDEMPOTENCE, the whole reason Django used update_or_create()
// ===========================================================================

describe("re-registering the same device", () => {
  it("updates the existing row in place instead of inserting a second one", async () => {
    // This path runs far more often than the first-registration one -- the app
    // re-registers to refresh its metadata, not just once at install. Django's
    // view says so in its own comment ("Use update_or_create to handle existing
    // subscriptions and update metadata / This prevents duplicate records if
    // the device registers again"), and there is NO unique index to catch it if
    // that regressed (migrations/0004_subscribers.sql:39-45 explains why). An
    // INSERT-every-time version of this would grow one row per registration and
    // inflate every "subscribers" figure in the admin without any error
    // anywhere.
    await post(SUB, FULL);
    await post(SUB, { ...FULL, app_version: "2.5.0", os_version: "19.0" });

    const rows = subscribers();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.app_version).toBe("2.5.0");
    expect(rows[0]?.os_version).toBe("19.0");
  });

  it("preserves the row's id and its original created timestamp", async () => {
    // subscribers.ts:248-255 chose find-then-UPDATE over INSERT OR REPLACE
    // specifically so the row keeps its identity. `created` is the column the
    // admin's subscriptions list pages on (`ORDER BY created DESC`) and the one
    // the signup graph buckets by date, so re-stamping it on every app launch
    // would move every still-installed device to today and turn "when did
    // people subscribe" into "when did they last open the app" -- a graph that
    // is wrong without ever looking broken.
    await post(SUB, FULL);
    const first = subscribers()[0];

    vi.setSystemTime(new Date("2026-09-09T11:00:00.000Z"));
    await post(SUB, { ...FULL, platform: "android" });

    expect(subscribers()).toEqual([{ ...first, platform: "android" }]);
    expect(subscribers()[0]?.created).toBe(NOW_PY);
  });

  it("blanks a previously-set optional field when the app stops sending it", async () => {
    // The UPDATE writes all seven optional columns unconditionally, so an
    // omitted field is written as NULL rather than left alone -- same as
    // Django's `defaults={...}` dict, every key of which is a `.get()`. Worth
    // pinning because the opposite (a partial update that preserves what is
    // not sent) is the more common API convention and would be a silent
    // behaviour change for an app build that trims its payload.
    await post(SUB, FULL);
    await post(SUB, MINIMAL);

    const row = subscribers()[0];
    expect(row?.timezone).toBeNull();
    expect(row?.device_model).toBeNull();
    expect(row?.app_version).toBeNull();
  });

  it("treats a different device_id as a different subscription", async () => {
    // The match is on the triple (device_id, foodbank_id, donationpoint_id).
    // Two handsets subscribed to the same food bank are two rows, and a match
    // that had dropped device_id would let the second handset overwrite the
    // first -- leaving one of the two silently unsubscribed.
    await post(SUB, MINIMAL);
    await post(SUB, { ...MINIMAL, device_id: "device-xyz-999", platform: "android" });

    expect(subscribers().map((r) => [r.device_id, r.platform])).toEqual([
      [DEVICE, "ios"],
      ["device-xyz-999", "android"],
    ]);
  });

  it("does not touch the same device's subscription to a DIFFERENT food bank", async () => {
    // A person can follow several food banks from one handset. If foodbank_id
    // fell out of the match clause, subscribing to a second food bank would
    // silently CANCEL the first by overwriting its row -- and the app would see
    // `success: true` both times.
    await post(SUB, { ...MINIMAL, foodbank: SALISBURY_UUID, sub_type: "needs" });
    await post(SUB, { ...MINIMAL, foodbank: DEVIZES_UUID, sub_type: "excess" });

    expect(subscribers().map((r) => [r.foodbank_id, r.sub_type])).toEqual([
      [SALISBURY_ID, "needs"],
      [DEVIZES_ID, "excess"],
    ]);
  });

  it("matches a NULL donationpoint on re-registration rather than duplicating it", async () => {
    // THE REASON `donationpoint_id IS ?` EXISTS (subscribers.ts:206-215). SQLite
    // treats every NULL as distinct, so a plain `donationpoint_id = ?` matches
    // NOTHING when the value is NULL -- which is the overwhelmingly common case
    // here, since most subscriptions are to a food bank rather than to one
    // donation point. With `=` this test would find TWO rows, and every device
    // in the country would gain a row per app launch.
    await post(SUB, MINIMAL);
    await post(SUB, MINIMAL);
    await post(SUB, MINIMAL);

    expect(subscribers()).toHaveLength(1);
  });

  it("keeps the food-bank-wide and the donation-point subscriptions apart", async () => {
    // Same device, same food bank, one with a donation point and one without:
    // two genuinely different subscriptions, and the NULL row must not swallow
    // the scoped one.
    await post(SUB, MINIMAL);
    await post(SUB, { ...MINIMAL, donationpoint: SALISBURY_DP_UUID });

    expect(subscribers().map((r) => r.donationpoint_id)).toEqual([null, SALISBURY_DP_ID]);
  });

  it("updates only ONE of two identical rows if duplicates already exist", async () => {
    // SUSPECT, PINNED AS-IS. There is no unique index on the triple
    // (0004_subscribers.sql:39-45), so duplicates are possible -- two concurrent
    // registrations from the same handset both find nothing and both insert.
    // findMobileSubscriber uses `.first()`, so a later registration then
    // updates the lower-id row and leaves the other stale forever -- the
    // duplicate never self-heals, and only the DELETE below clears it. Django's
    // `update_or_create` is worse in the same situation (it raises
    // MultipleObjectsReturned, a 500), so this is not a port regression; it is
    // recorded because "re-registering fixes a duplicate" is a reasonable thing
    // to assume and is not true.
    db.prepare(
      `INSERT INTO mobilesubscriber (id, created, device_id, platform, foodbank_id, donationpoint_id)
       VALUES (900, '2026-01-01 00:00:00.000000', ?, 'ios', ?, NULL),
              (901, '2026-01-02 00:00:00.000000', ?, 'ios', ?, NULL)`,
    ).run(DEVICE, SALISBURY_ID, DEVICE, SALISBURY_ID);

    await post(SUB, { ...MINIMAL, platform: "android" });

    expect(subscribers().map((r) => [r.id, r.platform])).toEqual([
      [900, "android"],
      [901, "ios"],
    ]);
  });
});

// ===========================================================================
// mobsub -- THE 400 GATE
// ===========================================================================

describe("mobsub rejects an incomplete registration", () => {
  // Django: `if not device_id or not platform or not foodbank_uuid: return
  // HttpResponseBadRequest()`. All three are required and all three are checked
  // for TRUTHINESS, so absent and empty are the same answer.
  const REQUIRED = ["device_id", "platform", "foodbank"] as const;

  for (const field of REQUIRED) {
    it(`400s when ${field} is missing entirely`, async () => {
      const fields = { ...MINIMAL };
      delete (fields as Record<string, string>)[field];

      const res = await post(SUB, fields);

      expect(res.status).toBe(400);
      expect(subscribers()).toEqual([]);
    });

    it(`400s when ${field} is present but empty`, async () => {
      const res = await post(SUB, { ...MINIMAL, [field]: "" });

      expect(res.status).toBe(400);
      expect(subscribers()).toEqual([]);
    });
  }

  it("400s before touching D1 at all", async () => {
    // `new Response("", { status: 400 })` is returned before dbSession(c) is
    // even called. Worth an assertion of its own: this endpoint is reachable
    // unauthenticated by anyone on the internet, so a malformed-body flood must
    // not become a D1 query flood.
    const res = await post(SUB, { device_id: DEVICE });

    expect(res.status).toBe(400);
    expect(prepared).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("returns an empty body on the 400, typed text/plain rather than Django's text/html", async () => {
    // The EMPTY BODY is the parity claim: Django's HttpResponseBadRequest()
    // carries `b''` too (verified by constructing one under Django 5.2.6 on
    // this machine). A future "helpful error message" here would be a contract
    // change for builds already in the field, and an app that parses the body
    // as JSON would start throwing on a different exception.
    //
    // The CONTENT TYPE diverges and is pinned as-is: the same Django check
    // reports `text/html; charset=utf-8`, while `new Response("", {status: 400})`
    // gets undici's default `text/plain;charset=UTF-8`. Nothing reads it -- the
    // body is empty either way -- but it is a real difference from the source
    // this module cites.
    const res = await post(SUB, {});

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
  });

  it("400s a JSON body, because parseBody only reads form encodings", async () => {
    // Hono's parseBody returns `{}` for any Content-Type that is not
    // multipart/form-data or application/x-www-form-urlencoded, so a JSON post
    // has no fields at all and fails the required-field gate.
    //
    // This is PARITY, not an accident: Django's `request.POST` is likewise
    // empty for a JSON body, so `mobsub` 400s there too. Pinned because it is
    // exactly the trap an app rewrite falls into -- switching the client to
    // `Content-Type: application/json` produces a 400 with an empty body and no
    // hint anywhere about why.
    const res = await app.request(
      `${ORIGIN}${SUB}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(FULL) },
      env(),
      execCtx,
    );

    expect(res.status).toBe(400);
    expect(subscribers()).toEqual([]);
  });

  it("400s when a required field arrives as a file part rather than a value", async () => {
    // stringField() returns "" for a File. Django puts uploads in request.FILES
    // and not request.POST, so `.get("device_id")` is None there and the view
    // 400s as well -- same answer by a different route. The assertion that
    // matters is that a File never reaches the INSERT and gets stringified into
    // the device_id column.
    const form = new FormData();
    form.set("device_id", new File(["abc"], "device.txt", { type: "text/plain" }));
    form.set("platform", "ios");
    form.set("foodbank", SALISBURY_UUID);

    const res = await app.request(`${ORIGIN}${SUB}`, { method: "POST", body: form }, env(), execCtx);

    expect(res.status).toBe(400);
    expect(subscribers()).toEqual([]);
  });

  it("takes the LAST value when a field is repeated, matching Django's QueryDict", async () => {
    // Hono's convertFormDataToBodyData assigns `form[key] = value` for every
    // entry, so the last write wins; Django's `QueryDict.get()` returns the last
    // value too (verified with Django 5.2.6 on this machine:
    // QueryDict("device_id=a&device_id=b").get("device_id") is 'b'). Pinned
    // because the two frameworks could easily have disagreed -- URLSearchParams'
    // own `.get()` returns the FIRST -- and a duplicated field is what an app
    // with a retry-and-append bug actually sends.
    await post(SUB, `device_id=first-device&device_id=${DEVICE}&platform=ios&foodbank=${SALISBURY_UUID}`);

    expect(subscribers().map((r) => r.device_id)).toEqual([DEVICE]);
  });
});

// ===========================================================================
// mobsub -- RESOLVING THE FOOD BANK
// ===========================================================================

describe("the foodbank UUID", () => {
  it("404s an unknown UUID and writes nothing", async () => {
    const res = await post(SUB, { ...MINIMAL, foodbank: "ffffffffffffffffffffffffffffffff" });

    expect(res.status).toBe(404);
    expect(subscribers()).toEqual([]);
  });

  it("answers the site's real 404 page rather than a bare Hono 404", async () => {
    // `c.notFound()` routes through index.ts's app.notFound(), which renders
    // 404.njk. The app itself does not care, but this is a public URL and the
    // status/body pair is what Django's Http404 produced too.
    const res = await post(SUB, { ...MINIMAL, foodbank: "ffffffffffffffffffffffffffffffff" });
    const body = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(body).toContain("404 - Not Found");
  });

  it("accepts the dashed spelling, because that is what Django's JSON emitted", async () => {
    // getFoodbankIdByUuid runs normalizeUuid() first (packages/db/src/uuid.ts).
    // The column holds the dashless form, but every UUID the old API ever
    // handed a client was Django's dashed `str(uuid.UUID(...))` -- so an app
    // build that stored the UUID it read from /api/2/ posts it back dashed.
    // Without normalizeUuid every one of those registrations 404s.
    const res = await post(SUB, { ...MINIMAL, foodbank: SALISBURY_UUID_DASHED });

    expect(res.status).toBe(200);
    expect(subscribers()[0]?.foodbank_id).toBe(SALISBURY_ID);
  });

  it("accepts an uppercase UUID, because normalizeUuid lowercases the needle", async () => {
    // SQLite's `=` is case-sensitive, so an uppercased UUID would 404 without
    // the lowercase step. Django's UUIDField parses either case into the same
    // UUID object (verified with Django 5.2.6 on this machine), so accepting it
    // is parity rather than leniency.
    const res = await post(SUB, { ...MINIMAL, foodbank: SALISBURY_UUID_DASHED.toUpperCase() });

    expect(res.status).toBe(200);
    expect(subscribers()[0]?.foodbank_id).toBe(SALISBURY_ID);
  });

  it("404s a UUID that is not a UUID at all -- a DIVERGENCE from Django's 500", async () => {
    // Foodbank.uuid is a UUIDField (givefood/migrations/0001_initial.py:59), and
    // UUIDField.to_python("not-a-uuid") raises ValidationError -- verified by
    // running it under Django 5.2.6 on this machine. get_object_or_404 catches
    // only DoesNotExist, so Django answers 500 for garbage input where this port
    // answers 404. The port's behaviour is better; it is recorded here because
    // "404 for a malformed UUID" is a real, deliberate difference from the
    // source this module cites, not because it should be changed back.
    const res = await post(SUB, { ...MINIMAL, foodbank: "not-a-uuid" });

    expect(res.status).toBe(404);
    expect(subscribers()).toEqual([]);
  });

  it("accepts food bank id 0, rather than reporting it missing", async () => {
    // resolveFoodbankAndDonationpoint tests `foodbankId === null`, and it has
    // to: `id INTEGER PRIMARY KEY` admits 0, and the tidier-looking
    // `if (!foodbankId)` would 404 a real food bank. The id is only ever used
    // as a bind afterwards, so this is the ONLY place the distinction is
    // observable -- and the mutant survives every other test in this file.
    seedFoodbank(0, "00000000000000000000000000000000", "zero-town");

    const res = await post(SUB, { ...MINIMAL, foodbank: "00000000000000000000000000000000" });

    expect(res.status).toBe(200);
    expect(subscribers()[0]?.foodbank_id).toBe(0);
  });

  it("does not fall back to a slug", async () => {
    // The food banks are seeded with slugs, and "salisbury" is a far more
    // guessable identifier than the UUID. The contract is UUID-only in Django
    // and here; a lookup that had grown an `OR slug = ?` would let anybody
    // subscribe a device without ever seeing an API response.
    const res = await post(SUB, { ...MINIMAL, foodbank: "salisbury" });

    expect(res.status).toBe(404);
    expect(subscribers()).toEqual([]);
  });
});

// ===========================================================================
// mobsub -- THE DONATION POINT, and the cross-food-bank check
// ===========================================================================

describe("the optional donationpoint UUID", () => {
  it("stores the resolved donation point id when one is given", async () => {
    const res = await post(SUB, { ...MINIMAL, donationpoint: SALISBURY_DP_UUID });

    expect(res.status).toBe(200);
    expect(subscribers()[0]?.donationpoint_id).toBe(SALISBURY_DP_ID);
  });

  it("REFUSES a donation point belonging to another food bank", async () => {
    // THE ONE SECURITY-SHAPED ASSERTION IN THIS FILE. Django's
    // `get_object_or_404(FoodbankDonationPoint, foodbank=foodbank,
    // uuid=donationpoint_uuid)` is scoped to the already-resolved food bank, and
    // getDonationPointIdByUuid carries the same `AND foodbank_id = ?` (the
    // function's own comment calls this out). Drop that clause and any caller
    // can write a row that says a Salisbury subscription is scoped to a Devizes
    // donation point -- a cross-food-bank record that no page in the admin has
    // any reason to expect, produced by a request that answers 200.
    //
    // The Devizes donation point genuinely EXISTS, which is what makes this a
    // test of scoping rather than of "unknown UUID".
    const res = await post(SUB, { ...MINIMAL, donationpoint: DEVIZES_DP_UUID });

    expect(res.status).toBe(404);
    expect(subscribers()).toEqual([]);
  });

  it("404s an unknown donation point UUID", async () => {
    const res = await post(SUB, { ...MINIMAL, donationpoint: "00000000000000000000000000000000" });

    expect(res.status).toBe(404);
    expect(subscribers()).toEqual([]);
  });

  it("treats an empty donationpoint as absent, not as a lookup that fails", async () => {
    // resolveFoodbankAndDonationpoint short-circuits on the empty string, same
    // as Django's `if donationpoint_uuid:`. This is not hypothetical: a form
    // encoder that always emits every key sends `donationpoint=`, and treating
    // that as a lookup would 404 every food-bank-wide subscription from such a
    // client.
    const res = await post(SUB, { ...MINIMAL, donationpoint: "" });

    expect(res.status).toBe(200);
    expect(subscribers()[0]?.donationpoint_id).toBeNull();
  });

  it("accepts the dashed spelling for the donation point too", async () => {
    const dashed = `${SALISBURY_DP_UUID.slice(0, 8)}-${SALISBURY_DP_UUID.slice(8, 12)}-${SALISBURY_DP_UUID.slice(12, 16)}-${SALISBURY_DP_UUID.slice(16, 20)}-${SALISBURY_DP_UUID.slice(20)}`;

    const res = await post(SUB, { ...MINIMAL, donationpoint: dashed });

    expect(res.status).toBe(200);
    expect(subscribers()[0]?.donationpoint_id).toBe(SALISBURY_DP_ID);
  });

  it("accepts donation point id 0, rather than reporting it missing", async () => {
    // Same `=== null` versus `!value` distinction as the food bank above, and
    // the same reason it needs its own test: `if (!donationpointId)` would 404
    // a real donation point AND, further down, would be indistinguishable from
    // "no donation point sent" -- which is how a device would end up subscribed
    // food-bank-wide when it asked for one collection point.
    seedDonationPoint(0, "abababababababababababababababab", SALISBURY_ID, "zero-point");

    const res = await post(SUB, { ...MINIMAL, donationpoint: "abababababababababababababababab" });

    expect(res.status).toBe(200);
    expect(subscribers()[0]?.donationpoint_id).toBe(0);
  });

  it("never looks the donation point up when none was sent", async () => {
    // One fewer D1 round trip on the common path. Asserted on the statement log
    // because a lookup returning NULL for an empty needle would be invisible in
    // the response.
    await post(SUB, MINIMAL);

    expect(sent.map((s) => s.sql)).not.toContain("SELECT id FROM foodbankdonationpoint WHERE uuid = ? AND foodbank_id = ?");
  });
});

// ===========================================================================
// delete_mobsub
// ===========================================================================

describe("delete_mobsub removes the subscription", () => {
  it("deletes the matching row and reports deleted: true", async () => {
    await post(SUB, FULL);
    expect(subscribers()).toHaveLength(1);

    const res = await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe('{"deleted":true}');
    expect(subscribers()).toEqual([]);
  });

  it("answers 200 with deleted: false when there was nothing to delete", async () => {
    // NOT a 404. Django's view reports `deleted_count > 0` straight through
    // (mobsub.ts:95-97 cites this), so an unsubscribe for a device that was
    // never subscribed is a success with a `false`. An app that treats a 404 as
    // "retry later" would otherwise loop forever on a subscription that is
    // already gone.
    const res = await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: false });
  });

  it("is safe to deliver twice -- the second call is a no-op false", async () => {
    // A phone on a flaky connection retries, and so does anything queued in
    // front of this endpoint. The second delete must not error and must not
    // report a second deletion.
    await post(SUB, FULL);

    const first = await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID });
    const second = await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID });

    expect(await first.json()).toEqual({ deleted: true });
    expect(await second.json()).toEqual({ deleted: false });
    expect(subscribers()).toEqual([]);
  });

  it("does not require platform, unlike mobsub", async () => {
    // ASYMMETRY, STRAIGHT FROM DJANGO: `mobsub` requires device_id, platform and
    // foodbank; `delete_mobsub` requires only device_id and foodbank. Pinned
    // because "harmonising" the two guards would 400 every unsubscribe the
    // shipped app sends -- it has no reason to include a platform when
    // cancelling.
    await post(SUB, FULL);

    const res = await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID });

    expect(res.status).toBe(200);
    expect(subscribers()).toEqual([]);
  });

  for (const field of ["device_id", "foodbank"] as const) {
    it(`400s when ${field} is missing`, async () => {
      await post(SUB, FULL);
      const fields: Record<string, string> = { device_id: DEVICE, foodbank: SALISBURY_UUID };
      delete fields[field];

      const res = await post(UNSUB, fields);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
      // The 400 is a refusal, not a deletion: the row is still there.
      expect(subscribers()).toHaveLength(1);
    });
  }

  it("400s before touching D1", async () => {
    const res = await post(UNSUB, { foodbank: SALISBURY_UUID });

    expect(res.status).toBe(400);
    expect(prepared).toEqual([]);
  });

  it("404s an unknown food bank without deleting anything", async () => {
    await post(SUB, FULL);
    prepared.length = 0;

    const res = await post(UNSUB, { device_id: DEVICE, foodbank: "ffffffffffffffffffffffffffffffff" });

    expect(res.status).toBe(404);
    expect(subscribers()).toHaveLength(1);
    // The DELETE was never even prepared -- the 404 happens first.
    expect(prepared.some((sql) => sql.startsWith("DELETE"))).toBe(false);
  });

  it("404s a donation point belonging to another food bank", async () => {
    // The same cross-tenant scoping as mobsub, on the destructive endpoint.
    await post(SUB, { ...MINIMAL, donationpoint: SALISBURY_DP_UUID });

    const res = await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID, donationpoint: DEVIZES_DP_UUID });

    expect(res.status).toBe(404);
    expect(subscribers()).toHaveLength(1);
  });
});

describe("what delete_mobsub is careful NOT to remove", () => {
  it("leaves the donation-point subscription alone when no donationpoint is sent", async () => {
    // The DELETE's third predicate is `donationpoint_id IS ?` bound to NULL, so
    // it matches ONLY the food-bank-wide row. A DELETE that had dropped that
    // predicate would cancel every donation-point subscription the handset has
    // for that food bank as a side effect of one unsubscribe -- and still answer
    // `deleted: true`, which is what the app expects to see.
    await post(SUB, MINIMAL);
    await post(SUB, { ...MINIMAL, donationpoint: SALISBURY_DP_UUID });

    const res = await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID });

    expect(await res.json()).toEqual({ deleted: true });
    expect(subscribers().map((r) => r.donationpoint_id)).toEqual([SALISBURY_DP_ID]);
  });

  it("leaves the food-bank-wide subscription alone when a donationpoint IS sent", async () => {
    // The mirror image, and the reason the previous test is not sufficient on
    // its own: a DELETE that ignored the bound value in the other direction
    // would pass one of the two and fail the other.
    await post(SUB, MINIMAL);
    await post(SUB, { ...MINIMAL, donationpoint: SALISBURY_DP_UUID });

    const res = await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID, donationpoint: SALISBURY_DP_UUID });

    expect(await res.json()).toEqual({ deleted: true });
    expect(subscribers().map((r) => r.donationpoint_id)).toEqual([null]);
  });

  it("leaves the same device's other food bank subscribed", async () => {
    await post(SUB, { ...MINIMAL, foodbank: SALISBURY_UUID });
    await post(SUB, { ...MINIMAL, foodbank: DEVIZES_UUID });

    await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID });

    expect(subscribers().map((r) => r.foodbank_id)).toEqual([DEVIZES_ID]);
  });

  it("leaves another device's subscription to the same food bank alone", async () => {
    // device_id is the only thing separating two handsets here. Without it in
    // the WHERE clause one person unsubscribing would silently unsubscribe
    // everybody following that food bank.
    await post(SUB, MINIMAL);
    await post(SUB, { ...MINIMAL, device_id: "device-xyz-999" });

    await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID });

    expect(subscribers().map((r) => r.device_id)).toEqual(["device-xyz-999"]);
  });

  it("removes ALL duplicates of one subscription in a single call", async () => {
    // There is no unique index (0004_subscribers.sql:39-45), so duplicates can
    // exist -- see the mobsub test above, where re-registering does NOT clear
    // them. DELETE is a set operation and clears both, which makes this the only
    // path that ever tidies them up. An unsubscribe that removed one row and
    // left the other would report `deleted: true` and leave a record saying the
    // handset is still watching.
    db.prepare(
      `INSERT INTO mobilesubscriber (id, created, device_id, platform, foodbank_id, donationpoint_id)
       VALUES (900, '2026-01-01 00:00:00.000000', ?, 'ios', ?, NULL),
              (901, '2026-01-02 00:00:00.000000', ?, 'ios', ?, NULL)`,
    ).run(DEVICE, SALISBURY_ID, DEVICE, SALISBURY_ID);

    const res = await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID });

    expect(await res.json()).toEqual({ deleted: true });
    expect(subscribers()).toEqual([]);
  });

  it("matches device_id exactly, case included", async () => {
    // No COLLATE NOCASE on the column and no normalisation in the handler, so
    // "DEVICE-ABC-123" is a different device. Pinned as behaviour: an app that
    // upper-cased its identifier between builds would find its unsubscribes
    // silently doing nothing while still answering 200.
    await post(SUB, MINIMAL);

    const res = await post(UNSUB, { device_id: DEVICE.toUpperCase(), foodbank: SALISBURY_UUID });

    expect(await res.json()).toEqual({ deleted: false });
    expect(subscribers()).toHaveLength(1);
  });
});

// ===========================================================================
// WHAT REACHES THE DATABASE -- the exact statements and binds
// ===========================================================================

describe("the statements each endpoint sends", () => {
  it("mobsub sends lookup, existence check and INSERT, in that order and no more", async () => {
    await post(SUB, { ...MINIMAL, donationpoint: SALISBURY_DP_UUID, timezone: "Europe/London" });

    expect(sent.map((s) => s.sql)).toEqual([
      "SELECT id FROM foodbank WHERE uuid = ?",
      "SELECT id FROM foodbankdonationpoint WHERE uuid = ? AND foodbank_id = ?",
      "SELECT * FROM mobilesubscriber WHERE device_id = ? AND foodbank_id = ? AND donationpoint_id IS ?",
      "INSERT INTO mobilesubscriber (created, device_id, platform, timezone, locale, app_version, os_version, " +
        "device_model, sub_type, foodbank_id, donationpoint_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ]);
  });

  it("binds the normalised UUID, not the string as posted", async () => {
    // The bind is the only place normalizeUuid's output is visible; the response
    // is identical either way for an already-dashless UUID, so a test that only
    // checked the status could not tell the two apart.
    await post(SUB, { ...MINIMAL, foodbank: SALISBURY_UUID_DASHED.toUpperCase() });

    expect(sent[0]).toEqual({ sql: "SELECT id FROM foodbank WHERE uuid = ?", params: [SALISBURY_UUID] });
  });

  it("scopes the donation point lookup to the resolved food bank id", async () => {
    // The `AND foodbank_id = ?` bind, asserted as a VALUE rather than as SQL
    // text -- binding the wrong id (say, a hardcoded 1) would leave the query
    // text looking correct while defeating the cross-tenant check entirely.
    await post(SUB, { ...MINIMAL, foodbank: DEVIZES_UUID, donationpoint: DEVIZES_DP_UUID });

    expect(sent[1]).toEqual({
      sql: "SELECT id FROM foodbankdonationpoint WHERE uuid = ? AND foodbank_id = ?",
      params: [DEVIZES_DP_UUID, DEVIZES_ID],
    });
  });

  it("re-registration sends an UPDATE keyed on the row id, never a second INSERT", async () => {
    await post(SUB, FULL);
    sent.length = 0;

    await post(SUB, { ...FULL, platform: "android" });

    expect(sent.map((s) => s.sql)).toEqual([
      "SELECT id FROM foodbank WHERE uuid = ?",
      "SELECT * FROM mobilesubscriber WHERE device_id = ? AND foodbank_id = ? AND donationpoint_id IS ?",
      "UPDATE mobilesubscriber SET platform = ?, timezone = ?, locale = ?, app_version = ?, os_version = ?, " +
        "device_model = ?, sub_type = ? WHERE id = ?",
    ]);
    expect(sent[2]?.params).toEqual(["android", "Europe/London", "en-GB", "2.4.1", "18.6", "iPhone17,2", "needs", 1]);
  });

  it("delete_mobsub sends exactly the lookup and the DELETE", async () => {
    await post(SUB, FULL);
    sent.length = 0;

    await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID });

    expect(sent).toEqual([
      { sql: "SELECT id FROM foodbank WHERE uuid = ?", params: [SALISBURY_UUID] },
      {
        sql: "DELETE FROM mobilesubscriber WHERE device_id = ? AND foodbank_id = ? AND donationpoint_id IS ?",
        params: [DEVICE, SALISBURY_ID, null],
      },
    ]);
  });

  it("binds the resolved donation point id into the DELETE, not a hardcoded NULL", async () => {
    // The mirror of the bind assertion below. A delete_mobsub that passed
    // `donationpointId: null` regardless would still answer `deleted: true` for
    // the common food-bank-wide case and would only misbehave for the scoped
    // one -- so the bind is asserted directly rather than inferred from a
    // status code.
    await post(SUB, { ...MINIMAL, donationpoint: SALISBURY_DP_UUID });
    sent.length = 0;

    await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID, donationpoint: SALISBURY_DP_UUID });

    expect(sent[2]).toEqual({
      sql: "DELETE FROM mobilesubscriber WHERE device_id = ? AND foodbank_id = ? AND donationpoint_id IS ?",
      params: [DEVICE, SALISBURY_ID, SALISBURY_DP_ID],
    });
  });

  it("binds NULL, not the empty string, for an absent donation point", async () => {
    // The column is nullable and `IS ''` would match nothing. Asserted on the
    // bind because a handler that passed "" would still 200 and would still
    // write a row -- one that no later unsubscribe could ever find again.
    await post(SUB, MINIMAL);

    const insert = sent.find((s) => s.sql.startsWith("INSERT"));
    expect(insert?.params).toEqual([NOW_PY, DEVICE, "ios", null, null, null, null, null, null, SALISBURY_ID, null]);
  });

  it("never reads the whole food bank row", async () => {
    // getFoodbankIdByUuid projects to `id` alone (foodbank.ts:390-402). A
    // `SELECT *` here would put a 60-column read on a path the apps hit on every
    // launch, and would be invisible in every other assertion in this file.
    await post(SUB, FULL);

    expect(sent.some((s) => s.sql.startsWith("SELECT * FROM foodbank"))).toBe(false);
  });
});

// ===========================================================================
// ROUTING -- none of it is in mobsub.ts, all of it decides whether it runs
// ===========================================================================

describe("where the two endpoints are and are not mounted", () => {
  it("does not answer GET, PUT, PATCH, DELETE or HEAD on either path", async () => {
    // mobsub.ts:44-49 and :78-83 are explicit that there is NO internal method
    // check -- `app.post()` in index.ts:389-390 is the entire gate. Django's
    // `mobsub` is `@require_POST` (a 405); `delete_mobsub` has no decorator at
    // all, so under Django a GET with query-string-only data would fall through
    // to the `if not device_id` guard and 400. Here both are 404 for anything
    // that is not a POST, which is a DIVERGENCE on the status code and pinned as
    // such.
    //
    // What matters far more than the number: a GET must never delete. Django's
    // undecorated `delete_mobsub` reads only `request.POST`, so a GET could not
    // reach the filter there either -- and this must stay true, because the URL
    // is otherwise a one-click unsubscribe for anything that prefetches links.
    await post(SUB, FULL);

    for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD"]) {
      for (const path of [SUB, UNSUB]) {
        const res = await app.request(
          `${ORIGIN}${path}?device_id=${DEVICE}&foodbank=${SALISBURY_UUID}&platform=ios`,
          { method },
          env(),
          execCtx,
        );
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    // The subscription seeded above is untouched by all ten requests.
    expect(subscribers()).toHaveLength(1);
  });

  it("404s the unslashed paths and does NOT redirect, so the POST is never replayed", async () => {
    // lib/appendSlash.ts restricts APPEND_SLASH to GET/HEAD -- a deliberate
    // deviation from Django, which 301s a POST too. Here the Django behaviour
    // would be worse than a 404: a client following a 301 from a POST re-issues
    // it as a GET, dropping the body, so the registration would silently vanish
    // while the app saw a 2xx.
    for (const path of ["/needs/mobsub", "/needs/mobsub/delete"]) {
      const res = await post(path, FULL);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Location"), path).toBeNull();
    }
    expect(subscribers()).toEqual([]);
  });

  it("is not mounted under any language prefix", async () => {
    // gfwfbn/urls/generic.py is included OUTSIDE i18n_patterns, so these two
    // views have exactly one URL in Django as well. The native app hardcodes
    // the unprefixed path; the assertion exists so that a future "wrap the wfbn
    // routes in the LOCALES loop" change cannot quietly create four URLs where
    // the contract has one.
    for (const prefix of ["/cy", "/ga", "/gd", "/en"]) {
      const res = await post(`${prefix}${SUB}`, FULL);
      expect(res.status, prefix).toBe(404);
    }
    expect(subscribers()).toEqual([]);
  });

  it("does not treat /needs/mobsub/delete/ as a food bank slug", async () => {
    // Registration order matters: /needs/mobsub/ and /needs/mobsub/delete/ are
    // two distinct literal routes, and the delete path must not be swallowed by
    // the register one (nor by any /needs/... param route). Asserted by the
    // observable difference -- one answers `success`, the other `deleted`.
    await post(SUB, FULL);

    expect(await (await post(SUB, FULL)).json()).toEqual({ success: true });
    expect(await (await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID })).json()).toEqual({ deleted: true });
  });

  it("requires no CSRF token, no cookie and no same-origin check", async () => {
    // Django's `mobsub` is `@csrf_exempt` and `delete_mobsub` is a plain
    // function, and this port adds no gate of its own. LOAD-BEARING: the caller
    // is a native app with no cookie jar and no page to have read a token from,
    // so any CSRF check here would reject every real registration. A hostile
    // Origin header is used deliberately -- it is the header a browser-based
    // forgery would carry.
    const res = await post(SUB, FULL, { headers: { "Content-Type": FORM, Origin: "https://attacker.example" } });

    expect(res.status).toBe(200);
    expect(subscribers()).toHaveLength(1);
  });

  it("sets no Cache-Control on either response", async () => {
    // middleware/pageCacheControl.ts only touches a GET, so neither JSON
    // response carries a header. Harmless -- nothing caches a POST response --
    // but pinned because it is a real difference from Django, whose
    // JsonResponse also sent none, and because it is what would change first if
    // either endpoint ever grew a GET form.
    const res = await post(SUB, FULL);

    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("carries the standard security headers and Content-Language", async () => {
    // securityHeaders and resolveLanguage are mounted on "*", so they stamp
    // even a machine-to-machine JSON response. Pinned because a "skip the
    // middleware for the API paths" optimisation would drop them silently.
    const res = await post(SUB, FULL);

    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("is stamped with no cache tag, because the path names no food bank", async () => {
    // middleware/cacheTag.ts derives tags from the PATH, and /needs/mobsub/ is
    // not under /needs/at/<slug>/. So a registration does not purge anything --
    // correct, since it changes no rendered page -- and this is the assertion
    // that keeps it that way if the route ever moves under a food bank's path.
    const res = await post(SUB, FULL);

    expect(res.headers.get("Cache-Tag")).toBeNull();
  });
});

// ===========================================================================
// FAILURE
// ===========================================================================

describe("when D1 fails mid-request", () => {
  it("500s on a failing INSERT rather than reporting success", async () => {
    // There is no try/catch anywhere on this path, so the error reaches
    // index.ts's onError. That is the RIGHT answer here even though nobody
    // watches it: `{"success": true}` over a write that did not happen would
    // leave the app believing it is subscribed forever, and the app has no
    // other way to find out. A 500 at least makes the client retry.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failOnPrefix = "INSERT INTO mobilesubscriber";

    const res = await post(SUB, FULL);

    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalled();
    expect(subscribers()).toEqual([]);
  });

  it("500s on a failing DELETE rather than reporting deleted", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await post(SUB, FULL);
    failOnPrefix = "DELETE FROM mobilesubscriber";

    const res = await post(UNSUB, { device_id: DEVICE, foodbank: SALISBURY_UUID });

    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalled();
    expect(subscribers()).toHaveLength(1);
  });

  it("500s on a failing food bank lookup, and does not mistake it for a 404", async () => {
    // A read failure and an unknown UUID must not look the same to the caller:
    // one is "your subscription is impossible", the other is "try again". If
    // getFoodbankIdByUuid ever grew a try/catch returning null, every device
    // would get a permanent 404 during a D1 incident and, depending on the app,
    // might delete its local subscription state in response.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failOnPrefix = "SELECT id FROM foodbank";

    const res = await post(SUB, FULL);

    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalled();
  });
});

// ===========================================================================
// THE EXPORTS THEMSELVES
// ===========================================================================

describe("the module's exports", () => {
  it("exports exactly the two handlers index.ts mounts", async () => {
    // The helpers -- stringField, optionalStringField and
    // resolveFoodbankAndDonationpoint -- are module-private on purpose and are
    // exercised through the two handlers above. This assertion is what stops
    // them being exported "for testability", which is the change that turns an
    // internal refactor into a breaking one.
    const module = await import("./mobsub");

    expect(Object.keys(module).sort()).toEqual(["wfbnDeleteMobsub", "wfbnMobsub"]);
    expect(typeof wfbnMobsub).toBe("function");
    expect(typeof wfbnDeleteMobsub).toBe("function");
  });
});
