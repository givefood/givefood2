import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNotifyNeedWebPush, type NotifyNeedWebPushMessage } from "./needWebPush";
import type { Env } from "../../worker-configuration";

// send_webpush_notification() (givefood/utils/notifications.py:388-431), the
// browser channel of gfadmin/views.py:2003's Notify button, as a self-paging
// queue consumer.
//
// THE DJANGO LINE NUMBERS BELOW WERE READ out of the reference checkout at
// ../foodcharity (rev 7387bbcba), not copied from needWebPush.ts's own
// comments -- two of those are a few lines out against that revision, which is
// exactly why they were re-read rather than repeated. Every citation in this
// file was opened again, in that same checkout at that same revision, during
// the adversarial review; one was wrong and is corrected below.
//
// WHY THIS FILE IS LONG, AND WHY IT DECRYPTS. This is unattended code with no
// page to look wrong on, sending END-TO-END ENCRYPTED messages: the push
// service relays a blob it cannot read and answers 201 Created whether or not
// the browser will be able to decrypt it. So EVERY failure this consumer can
// have is silent by construction --
//
//   * VAPID credentials missing or mis-pasted: the handler returns, logs a
//     warning nobody reads, and every subscriber stops hearing anything. This
//     is the exact shape of the Browser Rendering credential that broke for a
//     day without anyone noticing;
//   * `head` renamed to `title`: notifications arrive with no heading, and the
//     service worker is the only thing that would ever know;
//   * the wrong builder wired in (buildFirebasePayload sits in the same
//     payload.ts and differs only in its truncation budget): a different item
//     list ships, still valid, still 201;
//   * the JWT's `aud` built from the full endpoint instead of its origin:
//     services reject it, per-subscription, as an auth failure the loop
//     swallows;
//   * a 410 mishandled: either dead subscriptions accumulate forever, or --
//     far worse -- live rows get deleted on a transient 500.
//
// None of those throw. None of them reach the dead-letter queue. The only
// thing that can catch them is a test that runs the real crypto and reads the
// bytes, so this file:
//
//   * runs the REAL packages/db queries against node:sqlite loaded with the
//     REAL migrations, and reads rows back after the deletes;
//   * runs the REAL RFC 8291 encryption and RFC 8292 VAPID signing (nothing
//     under notify/ is mocked), then DECRYPTS each message with the
//     subscriber's own private key and asserts the JSON a browser would show,
//     and VERIFIES each Authorization JWT's signature against the configured
//     VAPID public key;
//   * mocks exactly two things: `fetch` (the push services) and JOBS_Q.send
//     (the queue). Both leave the machine; neither has a local double.
//
// MUTATION-TESTED TWICE, per TESTING.md's convention: once as it was written,
// then again adversarially by a reviewer. Both passes ran in a copy of the
// repo in a scratchpad OUTSIDE it -- never against a source file in the
// working tree. The second pass applied 71 mutants across needWebPush.ts,
// webPushCrypto.ts (whose bytes this file reads), payload.ts and
// packages/db/src/notifySubscribers.ts, re-running this suite against each.
//
// Among the ones that die here: `head` renamed to `title`, and head/body
// transposed; TTL raised off 0; the 404/410 test widened to `!res.ok`, which
// would empty webpushsubscription during any push-service incident; 404
// dropped from it; the cleanup removed, or moved after the enqueue, or fired
// on an empty list; only the first dead id deleted; ids collected by array
// index rather than row id; the deleted count reported from the attempt rather
// than meta.changes; buildFirebasePayload wired in instead of the web push
// one; the cursor advanced only on success, never advanced, or taken from the
// message instead of the page; the page's limit and cursor transposed, its
// foodbank_id and cursor binds swapped, its `id >` loosened to `id >=`, its
// ORDER BY reversed, or its food bank predicate dropped; the empty page
// enqueueing itself (an infinite queue loop); the enqueue moved inside the
// loop; any one of the three VAPID credentials no longer checked; PAGE_SIZE
// changed; a decode failure deleting the row; failures counted as dead
// alongside 410s; the key-import failure throwing into the DLQ; p256dh and
// auth swapped; the endpoint and `sub` arguments transposed; `mailto:`
// dropped; the icon path, the per-need tag and the SITE_DOMAIN changed;
// change_text_original sent instead of change_text; the clock read per
// subscriber rather than per page; the request timeout removed; the page
// walked in reverse or truncated to its first row; the session's consistency
// setting changed; success narrowed from any 2xx to exactly 201; the payload
// not JSON; Content-Encoding downgraded to aesgcm; the per-row "is gone" log
// reworded or its status hardcoded; and, in webPushCrypto.ts, `aud` built from
// the full endpoint, the VAPID expiry stretched to 30 days, `k=` left
// un-normalised, the record size written little-endian, the key id length
// hardcoded, the two public keys transposed in the HKDF info, the auth secret
// used where the record salt belongs, the salt left un-randomised, the
// ephemeral keypair cached at module scope, and RFC 8188's last-record padding
// delimiter changed from 0x02 to 0x01.
//
// FOUR SURVIVE, recorded rather than papered over. None is a hole in this file:
//
//   1. `res.ok` widened to `res.status < 400`. Killing it needs a push service
//      answering 3xx, which cannot happen here -- fetch follows redirects
//      itself, so the handler never sees one, and a fixture that produced one
//      would be asserting against data that does not occur.
//   2. payload.ts's `measure(candidate) > budget` loosened to `>=`. Nothing
//      here lands exactly on 200 characters. It is killed by payload.test.ts's
//      own exact-200 boundary case (run under the mutant to check); a copy of
//      that fixture here would only re-test that module.
//   3. notifySubscribers.ts's `if (ids.length === 0) return 0` guard deleted.
//      Unreachable from this consumer, which has its own `gone.length > 0`
//      guard; killed by notifySubscribers.test.ts (likewise run to check).
//   4. `need.foodbank_id` softened to `need.foodbank_id ?? 0`. Unreachable
//      behind the `!need?.foodbank_id` return three lines above it.
//
// The decrypt helper below is the receiver half of RFC 8291 §3.4. It
// necessarily mirrors the sender's HKDF chain, so it cannot prove the chain is
// the one the RFC specifies -- `pnpm run verify:webpush` does that, byte for
// byte, against RFC 8291 §5's published vector. What it does prove is that the
// bytes this CONSUMER puts on the wire decrypt to the payload it claims to be
// sending: that the encryption is fed the right subscription's keys, and that
// the plaintext is the JSON django-webpush's convention requires.

// ---------------------------------------------------------------------------
// base64url, written here rather than imported from ./jwt
// ---------------------------------------------------------------------------
// Deliberately not `import { base64UrlEncode } from "./jwt"`: these are what
// the assertions measure the module's output WITH, and sharing the encoder
// with the code under test would let one broken encoder agree with itself --
// a `k=` parameter and a p256dh that are both wrong in the same way would pass
// every assertion below.

function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// The browser's side of RFC 8291
// ---------------------------------------------------------------------------

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data as unknown as ArrayBuffer));
}

// Single-block HKDF, which is all RFC 8291 ever needs.
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmacSha256(salt, ikm);
  const okm = await hmacSha256(prk, cat(info, Uint8Array.of(1)));
  return okm.subarray(0, length);
}

interface SubscriberKeys {
  /** What goes in the webpushsubscription row. */
  p256dh: string;
  auth: string;
  /** The halves only the "browser" has, for decrypting what was sent to it. */
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  authSecret: Uint8Array;
}

// A browser's subscribe-time keypair: a real P-256 ECDH key, exactly as
// PushManager.subscribe() produces and gfwfbn/views.py:1292's
// update_or_create() stores -- after fix_base64_padding() (gfwfbn/views.py:35-47)
// has put back the `=` a browser omits, which is why every p256dh and auth in
// this file is written UNPADDED base64url.
async function generateSubscriberKeys(): Promise<SubscriberKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    p256dh: b64urlEncode(publicRaw),
    auth: b64urlEncode(authSecret),
    privateKey: pair.privateKey,
    publicRaw,
    authSecret,
  };
}

// RFC 8188 §2.1 framing, then RFC 8291 §3.4's derivation in reverse. Throws if
// the AES-GCM tag does not verify, which is what "the browser silently
// discarded it" looks like from this side.
async function decryptPush(body: Uint8Array, keys: SubscriberKeys): Promise<string> {
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16, false);
  const keyIdLength = body[20]!;
  const asPublicRaw = body.subarray(21, 21 + keyIdLength);
  const ciphertext = body.subarray(21 + keyIdLength);

  // Not incidental framing: a browser reads the sender's ephemeral key out of
  // the header and has no other way to reach it, so a header written with the
  // wrong lengths is undecryptable even with perfect key derivation.
  expect(recordSize).toBe(4096);
  expect(keyIdLength).toBe(65);

  const asPublicKey = await crypto.subtle.importKey(
    "raw",
    asPublicRaw as unknown as ArrayBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: asPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      keys.privateKey,
      256,
    ),
  );

  const keyInfo = cat(utf8("WebPush: info"), Uint8Array.of(0), keys.publicRaw, asPublicRaw);
  const ikm = await hkdf(keys.authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek as unknown as ArrayBuffer, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as unknown as ArrayBuffer, tagLength: 128 },
      aesKey,
      ciphertext as unknown as ArrayBuffer,
    ),
  );

  // RFC 8188 §2: the last record's padding delimiter is 0x02.
  expect(padded[padded.length - 1]).toBe(2);
  return new TextDecoder().decode(padded.subarray(0, padded.length - 1));
}

interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  /** Whether the signature verifies against the configured VAPID public key. */
  valid: boolean;
}

// RFC 8292 §2's assertion, checked the way a push service checks it: the
// signature is verified against the public key the browser recorded at
// subscribe time, not merely parsed.
async function decodeVapidJwt(authorization: string, publicKeyRaw: Uint8Array): Promise<DecodedJwt> {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  if (!match) throw new Error(`not a single-header vapid Authorization: ${authorization}`);
  const [headerB64, claimsB64, signatureB64] = match[1]!.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    publicKeyRaw as unknown as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64urlDecode(signatureB64!) as unknown as ArrayBuffer,
    utf8(`${headerB64}.${claimsB64}`) as unknown as ArrayBuffer,
  );
  return {
    header: JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64!))) as Record<string, unknown>,
    claims: JSON.parse(new TextDecoder().decode(b64urlDecode(claimsB64!))) as Record<string, unknown>,
    valid,
  };
}

// ---------------------------------------------------------------------------
// D1 over node:sqlite
// ---------------------------------------------------------------------------
// The slice of the D1 Sessions API this consumer's four packages/db functions
// use -- withSession(), prepare().bind(), .first() / .all() / .run(). The SQL
// text, the binding, the real UNIQUE indexes and the DELETE's changes() count
// are all SQLite's; async-vs-sync is the only thing bridged here. Interpreting
// the SQL in this adapter would mean testing a second implementation of SQLite
// rather than the queries the consumer actually sends.

type Bindable = null | number | bigint | string | Uint8Array;

interface Sent {
  sql: string;
  params: Bindable[];
}

function d1Database(db: DatabaseSync): {
  database: D1Database;
  withSessionModes: string[];
  prepared: string[];
  sent: Sent[];
} {
  const withSessionModes: string[] = [];
  const prepared: string[] = [];
  const sent: Sent[] = [];

  function statement(sql: string, params: Bindable[]) {
    const record = () => sent.push({ sql, params });
    return {
      // bind() returns a NEW statement rather than mutating the receiver,
      // matching D1's immutable prepared statements.
      bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
      first: async <T>() => {
        record();
        return (db.prepare(sql).get(...params) as T | undefined) ?? null;
      },
      all: async () => {
        record();
        return { results: db.prepare(sql).all(...params), success: true, meta: {} };
      },
      run: async () => {
        record();
        const info = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
    };
  }

  const session = {
    prepare(sql: string) {
      prepared.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  };

  const database = {
    withSession(mode: string) {
      withSessionModes.push(mode);
      return session;
    },
  };

  return { database: database as unknown as D1Database, withSessionModes, prepared, sent };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
// THE WHOLE REAL SCHEMA, not a narrow hand-built one. This consumer reaches
// four shared packages/db functions, one of which (getNeedById) reads through
// the foodbankchange_full VIEW -- and github #51 is the precedent for what a
// narrow fixture does when a shared query starts reading one more object:
// eight suites 500ed at once with "no such table". The migrations are cheap
// (DDL only, no data) and cannot drift from what D1 has.

const SALISBURY = 7;
const DEVIZES = 12;
// A food bank id with no `foodbank` row, for the need whose food bank has been
// deleted out from under a queued message.
const VANISHED_FB = 99;

const SALISBURY_UUID = "b0a1c2d3e4f5460788990a1b2c3d4e5f";
const NEED_ID = "aa11bb22cc33dd44ee55ff6677889900";

const NEED = 501;
const NEED_NO_FOODBANK = 502;
const NEED_VANISHED_FB = 503;
const NEED_NOTHING = 504;
const NEED_LONG = 505;
const NEED_BLANK_LINE = 506;

const SITE_DOMAIN = "https://www.givefood.org.uk";

// Three different push SERVICES, on three different origins with three
// different path shapes. One origin would let a JWT built from the endpoint
// instead of its origin, or an `aud` computed once for the page instead of per
// subscription, pass unnoticed.
const MOZILLA = "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABmoz";
const GOOGLE = "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bH";
const APPLE = "https://web.push.apple.com/QDQ2NDk0ODAtNTgwZC00";
const WINDOWS = "https://wns2-par02p.notify.windows.com/w/?token=AwYAAAB";

let db: DatabaseSync;
let database: D1Database;
let withSessionModes: string[];
let prepared: string[];
let sent: Sent[];

// Generated ONCE: a P-256 keypair is ~1ms of real elliptic-curve work and
// nothing in this file depends on a fresh one per test.
let vapidPrivatePem: string;
let vapidPrivateRawScalar: string;
let vapidPublicRaw: Uint8Array;
let vapidPublicB64Url: string;
let subscriberKeys: SubscriberKeys[];

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  vapidPrivatePem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n`;
  // The other shape importVapidKey() accepts, and the one nobody can read out
  // of a Worker secret to know which production holds: a raw 32-byte scalar.
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as { d?: string };
  vapidPrivateRawScalar = jwk.d!;
  vapidPublicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  vapidPublicB64Url = b64urlEncode(vapidPublicRaw);

  subscriberKeys = [];
  for (let i = 0; i < 30; i++) subscriberKeys.push(await generateSubscriberKeys());
});

// Every NOT NULL column 0001_core.sql declares on foodbank. name and slug are
// UNIQUE, so they differ per row.
function seedFoodbank(id: number, fields: { uuid: string; name: string; slug: string; altName?: string | null }): void {
  db.prepare(
    "INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng, " +
      "charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative, " +
      "is_closed, no_locations, days_between_needs, created, modified) " +
      "VALUES (?, ?, ?, ?, ?, '1 High St', 'SP1 1AA', 'England', '51.0688,-1.7945', " +
      "0, 'info@example.org', 'https://example.org/', 'https://example.org/list/', 0, " +
      "0, 0, 14, '2020-01-01 00:00:00.000000', '2026-09-05 19:28:08.853000')",
  ).run(id, fields.uuid, fields.name, fields.altName ?? null, fields.slug);
}

// change_text_original is ALWAYS seeded, and always with text that appears
// nowhere in any expected body. It is the sibling column immediately above
// change_text in FoodbankChangeRow and holds what the scraper found before an
// admin edited it -- so `need.change_text_original ?? need.change_text` is a
// one-word slip away from what the module writes, and with the column left
// NULL (as it was) every assertion in this file agreed with the mutant.
// Django's change_list() reads change_text and nothing else.
const ORIGINAL_TEXT = "Baked Beans (scraped)\nLong Grain Rice (scraped)";

function seedNeed(row: { id: number; needId: string; foodbankId: number | null; changeText: string }): void {
  db.prepare(
    "INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, change_text_original, published, " +
      "input_method, created, modified) " +
      "VALUES (?, ?, ?, ?, ?, 1, 'user', '2026-09-05 19:20:00.000000', '2026-09-05 19:28:08.853000')",
  ).run(row.id, row.needId, row.foodbankId, row.changeText, ORIGINAL_TEXT);
}

// `keys` indexes into the pre-generated pool; passing an explicit p256dh/auth
// instead is how the corrupt-row tests seed something that cannot be decoded.
function seedSubscription(row: {
  id: number;
  foodbankId: number;
  endpoint: string;
  keys?: number;
  p256dh?: string;
  auth?: string;
}): void {
  const pair = subscriberKeys[row.keys ?? row.id - 1]!;
  db.prepare(
    "INSERT INTO webpushsubscription (id, created, foodbank_id, endpoint, p256dh, auth, browser) " +
      "VALUES (?, '2026-08-01 09:00:00.000000', ?, ?, ?, ?, 'Firefox')",
  ).run(row.id, row.foodbankId, row.endpoint, row.p256dh ?? pair.p256dh, row.auth ?? pair.auth);
}

const keysFor = (subscriptionId: number): SubscriberKeys => subscriberKeys[subscriptionId - 1]!;

const remainingSubscriptionIds = (): number[] =>
  db
    .prepare("SELECT id FROM webpushsubscription ORDER BY id")
    .all()
    .map((row) => (row as { id: number }).id);

// ---------------------------------------------------------------------------
// The two things that leave the machine
// ---------------------------------------------------------------------------

interface PushRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Whether an AbortSignal was attached -- see the timeout test. */
  aborts: boolean;
}

let pushRequests: PushRequest[];
let queued: unknown[];
let queueSendFails: boolean;
let respond: (request: PushRequest, index: number) => Response;

// A fixed clock, so the VAPID `exp` claim is assertable to the second.
const NOW_MS = Date.UTC(2026, 8, 5, 19, 30, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function makeEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  return {
    DB: database,
    JOBS_Q: {
      send: async (body: unknown) => {
        if (queueSendFails) throw new Error("queue unavailable");
        queued.push(body);
      },
    },
    SITE_DOMAIN,
    VAPID_PRIVATE_KEY: vapidPrivatePem,
    VAPID_PUBLIC_KEY: vapidPublicB64Url,
    VAPID_ADMIN_EMAIL: "mail@givefood.org.uk",
    ...overrides,
  } as unknown as Env;
}

const message = (over: Partial<NotifyNeedWebPushMessage> = {}): NotifyNeedWebPushMessage => ({
  type: "notify-need-webpush",
  needId: NEED,
  afterId: 0,
  ...over,
});

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(MIGRATIONS_SQL);
  ({ database, withSessionModes, prepared, sent } = d1Database(db));

  pushRequests = [];
  queued = [];
  queueSendFails = false;
  respond = () => new Response(null, { status: 201 });

  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  vi.stubGlobal("fetch", async (input: unknown, init: unknown) => {
    const options = init as { method: string; headers: Record<string, string>; body: Uint8Array; signal?: unknown };
    const request: PushRequest = {
      url: String(input),
      method: options.method,
      headers: options.headers,
      body: options.body,
      aborts: options.signal instanceof AbortSignal,
    };
    pushRequests.push(request);
    return respond(request, pushRequests.length - 1);
  });

  seedFoodbank(SALISBURY, {
    uuid: SALISBURY_UUID,
    name: "Salisbury Foodbank",
    slug: "salisbury",
    // full_name() would append this. The title must NOT: notifications.py:313
    // uses foodbank.name where the EMAIL subject uses full_name(), and that
    // asymmetry is Django's. With alt_name NULL the two are identical and the
    // divergence would be invisible.
    altName: "Trussell Trust",
  });
  seedFoodbank(DEVIZES, { uuid: "11112222333344445555666677778888", name: "Devizes", slug: "devizes" });

  seedNeed({ id: NEED, needId: NEED_ID, foodbankId: SALISBURY, changeText: "Beans\nRice\nPasta" });
  seedNeed({ id: NEED_NO_FOODBANK, needId: "0".repeat(32), foodbankId: null, changeText: "Beans" });
  seedNeed({ id: NEED_VANISHED_FB, needId: "1".repeat(32), foodbankId: VANISHED_FB, changeText: "Beans" });
  seedNeed({ id: NEED_NOTHING, needId: "2".repeat(32), foodbankId: SALISBURY, changeText: "Nothing" });
  seedNeed({ id: NEED_BLANK_LINE, needId: "3".repeat(32), foodbankId: SALISBURY, changeText: "Beans\n\nRice" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

// ===========================================================================
// VAPID credentials
// ===========================================================================
// _get_vapid_credentials() (notifications.py:285-299) reads all three and, if
// any is falsy, returns (None, None) -- which skips the channel entirely at
// its one call site (notifications.py:399-402). A Worker secret that was
// never set reads as undefined, and a secret deleted during a rotation reads
// the same way, so this branch is the one that runs on the day someone
// re-provisions the Worker and forgets one of the three.

describe("VAPID credentials", () => {
  beforeEach(() => {
    seedSubscription({ id: 1, foodbankId: SALISBURY, endpoint: MOZILLA });
  });

  it("skips the channel entirely when the private key is unset -- no database round trip at all", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv({ VAPID_PRIVATE_KEY: "" }));

    // withSession() is the assertion that matters: the credential check runs
    // BEFORE anything else, so a missing secret costs nothing and, crucially,
    // enqueues nothing. If it enqueued the next page anyway the fan-out would
    // spin through every page of every food bank sending zero notifications.
    expect(withSessionModes).toEqual([]);
    expect(pushRequests).toEqual([]);
    expect(queued).toEqual([]);
  });

  it("skips when the public key is unset -- Django reads it too, even though pywebpush never gets it", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv({ VAPID_PUBLIC_KEY: "" }));
    expect(pushRequests).toEqual([]);
    expect(queued).toEqual([]);
  });

  it("skips when the admin email is unset", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv({ VAPID_ADMIN_EMAIL: "" }));
    expect(pushRequests).toEqual([]);
    expect(queued).toEqual([]);
  });

  it("warns rather than throws, so the message is acked and never reaches jobs-dlq", async () => {
    // queues/jobs.ts retries on a throw and wrangler.jsonc gives "jobs"
    // max_retries 3 with dead_letter_queue "jobs-dlq". Returning instead means
    // a missing credential produces ONE warning line and no DLQ entry -- the
    // failure mode is invisible by design, which is why this file exists.
    await expect(handleNotifyNeedWebPush(message(), makeEnv({ VAPID_PRIVATE_KEY: "" }))).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      "notify-need-webpush: VAPID credentials not fully set, skipping web push notifications",
    );
  });

  it("stops the whole page when the private key cannot be imported, and does NOT enqueue the next one", async () => {
    // A malformed key fails identically for every subscriber and every page,
    // so the module returns rather than throwing: a retry would re-read the
    // same secret and fail the same way three times into the DLQ. The cost of
    // that choice is asserted here -- the fan-out halts silently, mid-need.
    await expect(
      handleNotifyNeedWebPush(message(), makeEnv({ VAPID_PRIVATE_KEY: "not-a-key-at-all" })),
    ).resolves.toBeUndefined();

    expect(pushRequests).toEqual([]);
    expect(queued).toEqual([]);
    expect(remainingSubscriptionIds()).toEqual([1]);
    expect(console.error).toHaveBeenCalledWith(
      "notify-need-webpush: VAPID key could not be imported",
      expect.anything(),
    );
  });

  it("accepts the raw 32-byte scalar form of the private key, not only PEM", async () => {
    // importVapidKey() supports both because Django hands the secret straight
    // to pywebpush, which accepts both, and nobody can read a Worker secret to
    // find out which one production holds. If only the PEM path worked, the
    // first deploy against a raw-scalar secret would silently send nothing.
    await handleNotifyNeedWebPush(
      message(),
      makeEnv({ VAPID_PRIVATE_KEY: vapidPrivateRawScalar, VAPID_PUBLIC_KEY: vapidPublicB64Url }),
    );

    expect(pushRequests).toHaveLength(1);
    const jwt = await decodeVapidJwt(pushRequests[0]!.headers.Authorization!, vapidPublicRaw);
    // The signature verifies against the SAME public key the `k=` parameter
    // advertises -- which is the only thing that makes the raw-scalar import
    // (which rebuilds the key from both halves as a JWK) trustworthy.
    expect(jwt.valid).toBe(true);
  });
});

// ===========================================================================
// The need and the food bank
// ===========================================================================
// Queue messages outlive the rows they name. A need can be deleted between the
// admin pressing Notify and a later page being consumed -- a retried message
// is redelivered after a backoff, and the fan-out is many messages long.

describe("the need and the food bank", () => {
  beforeEach(() => {
    seedSubscription({ id: 1, foodbankId: SALISBURY, endpoint: MOZILLA });
  });

  it("gives up on a need that no longer exists, without throwing it into the DLQ", async () => {
    await expect(handleNotifyNeedWebPush(message({ needId: 999_999 }), makeEnv())).resolves.toBeUndefined();

    expect(pushRequests).toEqual([]);
    expect(queued).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("notify-need-webpush: need 999999 is missing or has no food bank");
  });

  it("gives up on a need whose foodbank_id is NULL -- nullable in the real schema, unlike Django's FK", async () => {
    await handleNotifyNeedWebPush(message({ needId: NEED_NO_FOODBANK }), makeEnv());

    expect(pushRequests).toEqual([]);
    expect(queued).toEqual([]);
    // One message for both cases, unlike needEmail.ts which distinguishes
    // them. Pinned because the wording is the only clue in the log.
    expect(console.error).toHaveBeenCalledWith(`notify-need-webpush: need ${NEED_NO_FOODBANK} is missing or has no food bank`);
  });

  it("gives up when the food bank row has been deleted but its subscriptions have not", async () => {
    // webpushsubscription has no foreign key to foodbank in D1, so a deleted
    // food bank leaves live subscription rows behind. The page is read BEFORE
    // the food bank, so this branch is reachable only with rows present.
    seedSubscription({ id: 2, foodbankId: VANISHED_FB, endpoint: GOOGLE });

    await handleNotifyNeedWebPush(message({ needId: NEED_VANISHED_FB }), makeEnv());

    expect(pushRequests).toEqual([]);
    expect(queued).toEqual([]);
    // Nothing deleted: an absent food bank is not a dead subscription.
    expect(remainingSubscriptionIds()).toEqual([1, 2]);
    expect(console.error).toHaveBeenCalledWith(`notify-need-webpush: food bank ${VANISHED_FB} not found`);
  });

  it("reads through a session, on the read-replica setting the other notify consumers use", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());
    // "first-unconstrained" starts the session with no bookmark, so the need
    // read can land on a lagging replica. Pinned rather than endorsed -- see
    // this suite's note on the just-published-need race.
    expect(withSessionModes).toEqual(["first-unconstrained"]);
  });
});

// ===========================================================================
// An empty page ends the fan-out
// ===========================================================================

describe("an empty page", () => {
  it("stops the fan-out rather than enqueueing itself forever", async () => {
    // THE MOST IMPORTANT NEGATIVE ASSERTION IN THIS FILE. Every page enqueues
    // the next one, so the empty page is the ONLY thing that terminates the
    // chain. An unconditional send() here is an infinite queue loop that
    // re-reads D1 forever and shows up as a bill, not as an error.
    seedSubscription({ id: 1, foodbankId: SALISBURY, endpoint: MOZILLA });

    await handleNotifyNeedWebPush(message({ afterId: 1 }), makeEnv());

    expect(queued).toEqual([]);
    expect(pushRequests).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(`notify-need-webpush: need ${NEED} done after id 1`);
  });

  it("does not even look the food bank up, or import the key, when the page is empty", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());

    // Two statements: the need, then the page. The food bank read comes after
    // the empty check, which is what makes a food bank with no web push
    // subscribers (most of them -- 49 subscriptions across the whole site)
    // cost two round trips rather than three.
    expect(prepared).toEqual([
      "SELECT * FROM foodbankchange_full WHERE id = ?",
      "SELECT id, endpoint, p256dh, auth FROM webpushsubscription WHERE foodbank_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3",
    ]);
  });

  it("asks for 25 rows at a time, after the cursor, for this food bank only", async () => {
    // PAGE_SIZE is invisible from the outside until it is wrong, and the three
    // bound values are the whole of the paging contract: [foodbank, cursor,
    // limit]. Transposing the last two -- a limit of 0 and a cursor of 25 --
    // sends nothing at all and logs "done".
    await handleNotifyNeedWebPush(message({ afterId: 40 }), makeEnv());
    expect(sent[1]!.params).toEqual([SALISBURY, 40, 25]);
  });
});

// ===========================================================================
// What actually reaches the push service
// ===========================================================================

describe("the encrypted message", () => {
  beforeEach(() => {
    seedSubscription({ id: 1, foodbankId: SALISBURY, endpoint: MOZILLA });
    seedSubscription({ id: 2, foodbankId: SALISBURY, endpoint: GOOGLE });
    seedSubscription({ id: 3, foodbankId: SALISBURY, endpoint: APPLE });
    // Another food bank's subscriber, which must NEVER be sent to: this is the
    // failure a fixture with one food bank in it cannot see, and the one whose
    // symptom is a stranger's shopping list arriving on someone's phone.
    seedSubscription({ id: 10, foodbankId: DEVIZES, endpoint: WINDOWS, keys: 9 });
  });

  it("sends to exactly this food bank's subscribers, in id order", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());

    expect(pushRequests.map((r) => r.url)).toEqual([MOZILLA, GOOGLE, APPLE]);
  });

  it("decrypts, in the browser, to _build_webpush_payload()'s exact five keys", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());

    const plaintext = await decryptPush(pushRequests[0]!.body, keysFor(1));
    const payload = JSON.parse(plaintext) as Record<string, unknown>;

    expect(payload).toEqual({
      // notifications.py:313 is `f"{need.foodbank.name} needs ..."` --
      // foodbank.name, NOT full_name(), which is what the EMAIL subject uses.
      // alt_name is "Trussell Trust" on this fixture, so a full_name() port
      // would read "Salisbury Foodbank - Trussell Trust needs 3 items" here.
      head: "Salisbury Foodbank needs 3 items",
      body: "Beans, Rice, Pasta",
      icon: "/static/img/notificationicon.svg",
      url: "https://www.givefood.org.uk/needs/at/salisbury/",
      // The dashless UUID, so a second notification about the same need
      // REPLACES the first in the shade instead of stacking.
      tag: `need-${NEED_ID}`,
    });
    // django-webpush's convention, and what the site's service worker reads.
    // Renaming it to `title` produces notifications with no heading at all,
    // and nothing upstream of the browser can tell.
    expect(payload).not.toHaveProperty("title");
  });

  it("encrypts each message to ITS OWN subscriber's keys", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());

    // Every subscriber's message decrypts with that subscriber's private key.
    // A loop that encrypted once and reused the ciphertext, or that indexed
    // the keys off by one, still 201s at every push service -- and the browser
    // silently discards it.
    for (const id of [1, 2, 3]) {
      const plaintext = await decryptPush(pushRequests[id - 1]!.body, keysFor(id));
      expect(JSON.parse(plaintext)).toMatchObject({ head: "Salisbury Foodbank needs 3 items" });
    }
    // And the ciphertexts genuinely differ.
    const bodies = pushRequests.map((r) => b64urlEncode(r.body));
    expect(new Set(bodies).size).toBe(3);
  });

  it("gives every message on the page its own salt and its own ephemeral key", async () => {
    // KILLS TWO MUTANTS the distinct-ciphertexts assertion above only LOOKED
    // like it killed. Three subscribers have three different p256dh values, so
    // three different ciphertexts come out even if the salt is a block of zeros
    // (crypto.getRandomValues deleted) or the ephemeral keypair is generated
    // once and cached at module scope. Both mutants survived this file until
    // the RFC 8188 header was read directly.
    //
    // Both matter: RFC 8291 §2.1 requires a fresh keypair per message, and a
    // reused ephemeral key lets anyone who sees two messages link them to the
    // same sender-recipient pair. Neither shows up anywhere else -- the push
    // service still answers 201 and the browser still decrypts.
    await handleNotifyNeedWebPush(message(), makeEnv());

    // RFC 8188 §2.1 header: salt(16) || rs(4) || idlen(1) || keyid.
    const salts = pushRequests.map((r) => b64urlEncode(r.body.subarray(0, 16)));
    const keyIds = pushRequests.map((r) => b64urlEncode(r.body.subarray(21, 86)));

    expect(salts).toHaveLength(3);
    expect(new Set(salts).size).toBe(3);
    expect(new Set(keyIds).size).toBe(3);
    // A zeroed salt is distinct-per-page-only in the sense that it is the SAME
    // on every page forever, so assert it is actually filled rather than merely
    // unequal to its neighbours.
    expect(salts.every((s) => s !== b64urlEncode(new Uint8Array(16)))).toBe(true);
    // Each key id is a real uncompressed P-256 point, which is what the browser
    // ECDHs against; a truncated or mis-tagged one is undecryptable.
    for (const r of pushRequests) {
      expect(r.body[21]).toBe(0x04);
    }
  });

  it("cannot be decrypted with a different subscriber's key", async () => {
    // The other half of the claim above: proves the decryption is doing real
    // work rather than accepting anything. Without this, an encryptor that
    // ignored the subscription's p256dh would pass the test above.
    await handleNotifyNeedWebPush(message(), makeEnv());
    await expect(decryptPush(pushRequests[0]!.body, keysFor(2))).rejects.toThrow();
  });

  it("sends the RFC 8188 headers pywebpush sends, with TTL 0", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());
    const request = pushRequests[0]!;

    expect(request.method).toBe("POST");
    expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(request.headers["Content-Type"]).toBe("application/octet-stream");
    // pywebpush's own default, which Django does not override. TTL 0 means
    // "deliver now or drop" -- a browser that is closed never sees it. Carried
    // over deliberately; raising it would make the port send notifications
    // Django would not, so the literal is pinned here.
    expect(request.headers.TTL).toBe("0");
  });

  it("attaches a timeout, so one hung push service cannot stall the whole page", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());
    expect(pushRequests.every((r) => r.aborts)).toBe(true);
  });

  it("signs a VAPID assertion whose audience is the endpoint's ORIGIN, per subscription", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());

    const auds = await Promise.all(
      pushRequests.map(async (r) => (await decodeVapidJwt(r.headers.Authorization!, vapidPublicRaw)).claims.aud),
    );
    // Not the full endpoint: the path identifies the subscription, and sending
    // it in a JWT would leak WHO is being pushed to (RFC 8292 §2). Services
    // reject a full-endpoint `aud` outright, per subscription, as an auth
    // failure this loop only logs.
    expect(auds).toEqual(["https://updates.push.services.mozilla.com", "https://fcm.googleapis.com", "https://web.push.apple.com"]);
  });

  it("signs claims a push service will accept, verifiably, with pywebpush's 12-hour expiry", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());
    const jwt = await decodeVapidJwt(pushRequests[0]!.headers.Authorization!, vapidPublicRaw);

    expect(jwt.header).toEqual({ alg: "ES256", typ: "JWT" });
    expect(jwt.claims.sub).toBe("mailto:mail@givefood.org.uk");
    // 12 hours is pywebpush's default, filled in because Django passes only
    // `sub` (notifications.py:374). An expiry beyond 24 hours is rejected by
    // most services; one in the past is rejected by all of them.
    expect(jwt.claims.exp).toBe(NOW_SECONDS + 12 * 60 * 60);
    // ES256 over the real key: WebCrypto's raw r||s output is what JOSE wants,
    // unlike the ASN.1 DER most server-side libraries emit. A DER signature
    // here would parse fine and fail verification at every push service.
    expect(jwt.valid).toBe(true);
  });

  it("reads the clock ONCE for the whole page, not once per subscriber", async () => {
    // This test was vacuous until the mock below started MOVING. beforeEach
    // freezes Date.now at a constant, so `nowMs` hoisted out of the loop and
    // `Date.now()` called inside sendOne() produce identical `exp` claims and
    // an "all expiries are equal" assertion passes against both. Advancing the
    // clock a minute per read is what makes the mutant die: three reads would
    // give three expiries a minute apart.
    const clockReads: number[] = [];
    vi.spyOn(Date, "now").mockImplementation(() => {
      const ms = NOW_MS + 60_000 * clockReads.length;
      clockReads.push(ms);
      return ms;
    });

    await handleNotifyNeedWebPush(message(), makeEnv());

    const exps = await Promise.all(
      pushRequests.map(async (r) => (await decodeVapidJwt(r.headers.Authorization!, vapidPublicRaw)).claims.exp),
    );
    // Three subscribers, three assertions, ONE expiry. A clock read inside
    // sendOne() would put a minute between each of them.
    expect(exps).toHaveLength(3);
    expect(new Set(exps).size).toBe(1);
    // And that one expiry is 12 hours after a reading this mock actually
    // issued -- deliberately not pinned to the FIRST reading, which would make
    // the test depend on nothing else in the process having looked at the clock
    // first. The exact 12-hour offset is pinned against a frozen clock by
    // "signs claims a push service will accept" above.
    expect(clockReads.map((ms) => Math.floor(ms / 1000) + 12 * 60 * 60)).toContain(exps[0]);
  });

  it("advertises the configured public key as `k=`, normalised to unpadded base64url", async () => {
    // A VAPID key pasted from a config file may be standard base64 with `+`,
    // `/` and `=` in it, and RFC 8292's `k=` parameter must be base64url. This
    // is the mis-pasted-secret case: the key is RIGHT, its spelling is not,
    // and the only symptom is every push rejected with 401.
    const standardBase64 = btoa(String.fromCharCode(...vapidPublicRaw));
    expect(standardBase64).toMatch(/[+/=]/);

    await handleNotifyNeedWebPush(message(), makeEnv({ VAPID_PUBLIC_KEY: standardBase64 }));

    const k = /k=(.+)$/.exec(pushRequests[0]!.headers.Authorization!)![1];
    expect(k).toBe(vapidPublicB64Url);
    expect(k).not.toMatch(/[+/=]/);
  });

  it("tolerates a trailing newline on the public key secret", async () => {
    // `wrangler secret put` from a file leaves the newline on. This is exactly
    // how a credential breaks silently a day after a rotation.
    await handleNotifyNeedWebPush(message(), makeEnv({ VAPID_PUBLIC_KEY: `${vapidPublicB64Url}\n` }));
    const k = /k=(.+)$/.exec(pushRequests[0]!.headers.Authorization!)![1];
    expect(k).toBe(vapidPublicB64Url);
  });

  it("enqueues exactly one next page, cursored on the last id it walked", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());

    expect(queued).toEqual([{ type: "notify-need-webpush", needId: NEED, afterId: 3 }]);
    expect(console.log).toHaveBeenCalledWith(`notify-need-webpush: need ${NEED} sent 3/3, next after id 3`);
  });
});

// ===========================================================================
// The payload the builder produces
// ===========================================================================

describe("the notification body", () => {
  beforeEach(() => {
    seedSubscription({ id: 1, foodbankId: SALISBURY, endpoint: MOZILLA });
  });

  async function bodyFor(needId: number): Promise<Record<string, unknown>> {
    await handleNotifyNeedWebPush(message({ needId }), makeEnv());
    return JSON.parse(await decryptPush(pushRequests[0]!.body, keysFor(1))) as Record<string, unknown>;
  }

  // 12 items of 19 CHARACTERS each, six of which are two-byte, so the same
  // list measures 25 bytes per item. Joined with ", ":
  //   characters: 21n - 2  -> 9 items = 187, 10 items = 208
  //   bytes:      27n - 2  -> 7 items = 187,  8 items = 214
  // against the 200 the web push builder allows. That gap is the whole test:
  // needFirebase.ts sits next to this consumer and calls the OTHER builder in
  // the same payload.ts, which counts UTF-8 bytes against 4,000. Wiring the
  // wrong one in ships a different, still valid-looking, item list.
  const ACCENTED_ITEMS = Array.from({ length: 12 }, (_, i) => `éééééé tomatoes ${String(i + 1).padStart(3, "0")}`);

  it("truncates the item list at 200 CHARACTERS, not 200 bytes, and only at an item boundary", async () => {
    seedNeed({ id: NEED_LONG, needId: "4".repeat(32), foodbankId: SALISBURY, changeText: ACCENTED_ITEMS.join("\n") });

    const payload = await bodyFor(NEED_LONG);

    expect(payload.body).toBe(ACCENTED_ITEMS.slice(0, 9).join(", "));
    expect(String(payload.body)).toHaveLength(187);
    // Items 8 and 9 are the ones a byte-budget implementation would have
    // dropped; item 10 is the one that overflows either way.
    expect(payload.body).toContain("tomatoes 009");
    expect(payload.body).not.toContain("tomatoes 010");
    // The COUNT is the whole list, not the truncated one -- the title says 12
    // while the body lists 9, which is what Django sends.
    expect(payload.head).toBe("Salisbury Foodbank needs 12 items");
  });

  it("sends the 'Nothing' sentinel as a zero-item notification, exactly as Django does", async () => {
    // no_items() special-cases "Nothing"/"Unknown" to 0; change_list() does
    // not, so the body is the literal word. Suspect-looking, and deliberately
    // not papered over here: the admin only offers Notify on a need a human
    // published, so this is a reviewer's decision, not this port's.
    const payload = await bodyFor(NEED_NOTHING);

    expect(payload.head).toBe("Salisbury Foodbank needs 0 items");
    expect(payload.body).toBe("Nothing");
  });

  it("keeps blank lines in the body -- change_list() is the raw split", async () => {
    const payload = await bodyFor(NEED_BLANK_LINE);

    // "Beans\n\nRice" -> three items, the middle one empty. no_items() counts
    // it too, so the title says 3. Both are Django's behaviour, pinned so a
    // "tidy-up" that filters blanks here fails loudly instead of quietly
    // disagreeing with the email and /md/ pages.
    expect(payload.body).toBe("Beans, , Rice");
    expect(payload.head).toBe("Salisbury Foodbank needs 3 items");
  });

  it("notifies the CURRENT change_text, never the scraper's change_text_original", async () => {
    // KILLS `need.change_text_original ?? need.change_text`, which survived
    // every other test in this file while the fixture left that column NULL.
    // The two columns are adjacent in FoodbankChangeRow and hold the same type;
    // the original is what a scrape or an LLM produced BEFORE an admin corrected
    // it, so sending it means notifying subscribers with text a human already
    // rejected -- and the notification would still look entirely plausible.
    // Django's change_list() (models.py) splits change_text and nothing else.
    const payload = await bodyFor(NEED);

    expect(payload.body).toBe("Beans, Rice, Pasta");
    expect(payload.head).toBe("Salisbury Foodbank needs 3 items");
    expect(String(payload.body)).not.toContain("scraped");
  });

  it("points the url at this site's domain, from the env var rather than a hardcoded host", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv({ SITE_DOMAIN: "https://staging.example.org" }));
    const payload = JSON.parse(await decryptPush(pushRequests[0]!.body, keysFor(1))) as Record<string, unknown>;
    expect(payload.url).toBe("https://staging.example.org/needs/at/salisbury/");
  });
});

// ===========================================================================
// Dead, broken and unreachable subscriptions
// ===========================================================================

describe("failed sends", () => {
  beforeEach(() => {
    seedSubscription({ id: 1, foodbankId: SALISBURY, endpoint: MOZILLA });
    seedSubscription({ id: 2, foodbankId: SALISBURY, endpoint: GOOGLE });
    seedSubscription({ id: 3, foodbankId: SALISBURY, endpoint: APPLE });
    seedSubscription({ id: 10, foodbankId: DEVIZES, endpoint: WINDOWS, keys: 9 });
  });

  it("deletes the subscriptions a push service answers 410 Gone for, and only those", async () => {
    // notifications.py:380 is the `status_code in [404, 410]` test and :427
    // the `.delete()` it feeds. A browser that revoked or replaced the
    // subscription will never accept another message on that endpoint;
    // keeping the row means re-attempting it on every future need, forever.
    respond = (_r, index) => (index === 1 ? new Response(null, { status: 410 }) : new Response(null, { status: 201 }));

    await handleNotifyNeedWebPush(message(), makeEnv());

    expect(remainingSubscriptionIds()).toEqual([1, 3, 10]);
    expect(console.log).toHaveBeenCalledWith("notify-need-webpush: deleted 1 dead subscription(s)");
    // The per-row line, pinned separately from the count: it names WHICH id was
    // condemned and on WHAT status, and it is the only record anyone ever gets
    // of a row about to be destroyed. The count above says "1" whichever row it
    // was, so a mutant that reworded or dropped this line -- or that reported
    // the wrong subscription -- left no trace in any assertion.
    expect(console.log).toHaveBeenCalledWith("notify-need-webpush: subscription 2 is gone (HTTP 410)");
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("subscription 1 is gone"));
  });

  it("counts 200 and 202 as sent, not as failures", async () => {
    // Push services answer 201 Created on success, but the module accepts any
    // 2xx rather than treating a valid-but-unexpected one as a failure -- WNS
    // answers 200 and several services answer 202 Accepted for a queued
    // message. Narrowing this to `=== 201` would log every one of those as a
    // failure and under-report `sent`, while the notifications went out fine.
    respond = (_r, index) => new Response(null, { status: [200, 202, 201][index] });

    await handleNotifyNeedWebPush(message(), makeEnv());

    expect(console.log).toHaveBeenCalledWith(`notify-need-webpush: need ${NEED} sent 3/3, next after id 3`);
    expect(console.error).not.toHaveBeenCalled();
    expect(remainingSubscriptionIds()).toEqual([1, 2, 3, 10]);
  });

  it("reports the rows the DELETE actually removed, not the number it tried to", async () => {
    // Two messages for the same need can be in flight at once (at-least-once
    // delivery), so the other one can have deleted a dead row already. The
    // count in the log has to come from meta.changes; reporting gone.length
    // would claim a cleanup that the database refused to do -- and this log
    // line is the ONLY evidence anyone ever sees that rows are being removed.
    respond = (request, index) => {
      if (index === 0) db.prepare("DELETE FROM webpushsubscription WHERE endpoint = ?").run(request.url);
      return new Response(null, { status: index === 2 ? 201 : 410 });
    };

    await handleNotifyNeedWebPush(message(), makeEnv());

    expect(console.log).toHaveBeenCalledWith("notify-need-webpush: deleted 1 dead subscription(s)");
    expect(remainingSubscriptionIds()).toEqual([3, 10]);
  });

  it("deletes on 404 as well as 410", async () => {
    respond = (_r, index) => new Response(null, { status: index === 0 ? 404 : 201 });

    await handleNotifyNeedWebPush(message(), makeEnv());

    expect(remainingSubscriptionIds()).toEqual([2, 3, 10]);
    // The status is interpolated, not hardcoded to 410: 404 and 410 mean the
    // same thing to this loop but not to whoever is reading the log afterwards.
    expect(console.log).toHaveBeenCalledWith("notify-need-webpush: subscription 1 is gone (HTTP 404)");
  });

  it("deletes the whole page's dead rows in one statement, naming only those ids", async () => {
    respond = (_r, index) => new Response(null, { status: index === 2 ? 201 : 410 });

    await handleNotifyNeedWebPush(message(), makeEnv());

    // One DELETE with two bound ids -- not one statement per dead row, and not
    // a statement built from the whole page. D1 caps a statement at 100 bound
    // parameters, which is why the cleanup is per page rather than per
    // fan-out; the arity is only visible in the bound parameter list.
    const deletes = sent.filter((s) => s.sql.startsWith("DELETE"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.params).toEqual([1, 2]);
    expect(remainingSubscriptionIds()).toEqual([3, 10]);
  });

  it("keeps going after a dead subscription, and still cursors past it", async () => {
    respond = (_r, index) => new Response(null, { status: index === 0 ? 410 : 201 });

    await handleNotifyNeedWebPush(message(), makeEnv());

    expect(pushRequests).toHaveLength(3);
    // The cursor is the last id WALKED, not the last id sent to: a deleted row
    // still advances it, so the next page starts after it rather than
    // re-reading a row that is now gone.
    expect(queued).toEqual([{ type: "notify-need-webpush", needId: NEED, afterId: 3 }]);
  });

  it("does NOT delete on a 500 -- a transient outage is not a dead subscription", async () => {
    // The single most destructive mutation available here: widening the
    // 404/410 test to `!res.ok` would empty webpushsubscription during any
    // push-service incident, permanently, with a cheerful log line.
    respond = () => new Response("upstream is having a bad day", { status: 500 });

    await handleNotifyNeedWebPush(message(), makeEnv());

    expect(remainingSubscriptionIds()).toEqual([1, 2, 3, 10]);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("dead subscription"));
  });

  it("does not delete on 429 or 401 either", async () => {
    // 429 is rate limiting and 401 is the VAPID key being wrong -- the two
    // statuses a real incident actually produces. Both must leave rows alone.
    respond = (_r, index) => new Response("nope", { status: index === 0 ? 429 : 401 });

    await handleNotifyNeedWebPush(message({ afterId: 1 }), makeEnv());

    expect(remainingSubscriptionIds()).toEqual([1, 2, 3, 10]);
  });

  it("reports a failed send's status and body, then carries on to the next subscriber", async () => {
    respond = (_r, index) => (index === 0 ? new Response("quota exceeded", { status: 503 }) : new Response(null, { status: 201 }));

    await handleNotifyNeedWebPush(message(), makeEnv());

    expect(console.error).toHaveBeenCalledWith("notify-need-webpush: subscription 1 failed (HTTP 503): quota exceeded");
    expect(pushRequests).toHaveLength(3);
    // sent 2/3: the count in the log is the only place a partial page shows up
    // at all, since the handler returns normally either way.
    expect(console.log).toHaveBeenCalledWith(`notify-need-webpush: need ${NEED} sent 2/3, next after id 3`);
  });

  it("survives fetch itself rejecting -- DNS failure, TLS failure, timeout", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (input: unknown) => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      pushRequests.push({ url: String(input), method: "POST", headers: {}, body: new Uint8Array(), aborts: true });
      return new Response(null, { status: 201 });
    });

    await expect(handleNotifyNeedWebPush(message(), makeEnv())).resolves.toBeUndefined();

    expect(calls).toBe(3);
    expect(remainingSubscriptionIds()).toEqual([1, 2, 3, 10]);
    expect(console.error).toHaveBeenCalledWith("notify-need-webpush: subscription 1 could not be reached", expect.anything());
  });

  it("skips a subscription whose stored keys cannot be decoded, WITHOUT deleting it", async () => {
    // A p256dh that is not a 65-byte uncompressed point makes encryptPayload
    // throw. That is a corrupt row or a decode bug on OUR side, not a push
    // service saying the subscription is gone -- Django only ever deletes on a
    // 404/410, so a bad deploy here must not destroy production rows.
    seedSubscription({ id: 4, foodbankId: SALISBURY, endpoint: "https://example.org/push/4", p256dh: "bm90LWEta2V5" });

    await handleNotifyNeedWebPush(message(), makeEnv());

    expect(remainingSubscriptionIds()).toEqual([1, 2, 3, 4, 10]);
    expect(pushRequests).toHaveLength(3);
    expect(console.error).toHaveBeenCalledWith(
      "notify-need-webpush: could not build message for subscription 4",
      expect.anything(),
    );
    // Still counted as walked, so the fan-out moves past it rather than
    // wedging on it: sent 3 of the 4 the page held.
    expect(queued).toEqual([{ type: "notify-need-webpush", needId: NEED, afterId: 4 }]);
  });

  it("keeps sending to the rest of the page when every send fails", async () => {
    respond = () => new Response("down", { status: 502 });

    await expect(handleNotifyNeedWebPush(message(), makeEnv())).resolves.toBeUndefined();

    // A total outage still acks, still enqueues, and still logs a cheerful
    // "next after id 3". Nothing retries these three subscribers, and nothing
    // reaches jobs-dlq. This is the behaviour, pinned; it is also the reason
    // this consumer's failures are invisible without reading logs.
    expect(pushRequests).toHaveLength(3);
    expect(queued).toEqual([{ type: "notify-need-webpush", needId: NEED, afterId: 3 }]);
    expect(console.log).toHaveBeenCalledWith(`notify-need-webpush: need ${NEED} sent 0/3, next after id 3`);
  });
});

// ===========================================================================
// Paging
// ===========================================================================

describe("paging through a large food bank", () => {
  beforeEach(() => {
    // 26 subscribers: one more than PAGE_SIZE, so the boundary is real.
    for (let id = 1; id <= 26; id++) {
      seedSubscription({ id, foodbankId: SALISBURY, endpoint: `https://push.example.org/s/${id}`, keys: (id - 1) % 30 });
    }
  });

  it("sends 25 and hands the 26th to the next message", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());

    expect(pushRequests).toHaveLength(25);
    expect(pushRequests[24]!.url).toBe("https://push.example.org/s/25");
    expect(queued).toEqual([{ type: "notify-need-webpush", needId: NEED, afterId: 25 }]);
  });

  it("walks the whole list across three messages and stops", async () => {
    // The fan-out end to end, driven by the messages the consumer itself
    // produces. A cursor written as `id >= afterId` re-sends the boundary
    // subscriber on every page forever; the only symptom is somebody's phone
    // buzzing twice, so it has to be asserted here or nowhere.
    await handleNotifyNeedWebPush(message(), makeEnv());
    await handleNotifyNeedWebPush(queued[0] as NotifyNeedWebPushMessage, makeEnv());
    await handleNotifyNeedWebPush(queued[1] as NotifyNeedWebPushMessage, makeEnv());

    const urls = pushRequests.map((r) => r.url);
    expect(urls).toHaveLength(26);
    expect(new Set(urls).size).toBe(26);
    expect(urls[25]).toBe("https://push.example.org/s/26");
    // Three messages in, two messages out: the third page was empty and
    // enqueued nothing.
    expect(queued).toHaveLength(2);
    expect(queued[1]).toEqual({ type: "notify-need-webpush", needId: NEED, afterId: 26 });
  });
});

// ===========================================================================
// Redelivery and downstream failure
// ===========================================================================
// Cloudflare Queues are AT-LEAST-ONCE: the same tick can arrive twice, and a
// consumer that throws after doing half its work has it all redone.

describe("redelivery", () => {
  beforeEach(() => {
    seedSubscription({ id: 1, foodbankId: SALISBURY, endpoint: MOZILLA });
    seedSubscription({ id: 2, foodbankId: SALISBURY, endpoint: GOOGLE });
  });

  it("re-sends the whole page when the same message is delivered twice", async () => {
    await handleNotifyNeedWebPush(message(), makeEnv());
    await handleNotifyNeedWebPush(message(), makeEnv());

    // NOT idempotent, and cannot be without a per-subscription sent marker,
    // which is a schema change. PAGE_SIZE bounds the damage to 25 duplicate
    // notifications. Same property, and the same non-answer, as needEmail.ts
    // and as Django's own per-task retry.
    expect(pushRequests.map((r) => r.url)).toEqual([MOZILLA, GOOGLE, MOZILLA, GOOGLE]);
    expect(queued).toHaveLength(2);
  });

  it("is harmless when the redelivered page's rows have already been deleted", async () => {
    respond = () => new Response(null, { status: 410 });
    await handleNotifyNeedWebPush(message(), makeEnv());
    expect(remainingSubscriptionIds()).toEqual([]);

    // The rows are gone, so the redelivery finds an empty page and terminates
    // rather than throwing on a DELETE that matches nothing.
    await expect(handleNotifyNeedWebPush(message(), makeEnv())).resolves.toBeUndefined();
    expect(pushRequests).toHaveLength(2);
    expect(queued).toHaveLength(1);
  });

  it("throws when the queue send fails, which retries a page already sent", async () => {
    queueSendFails = true;
    respond = (_r, index) => new Response(null, { status: index === 0 ? 410 : 201 });

    await expect(handleNotifyNeedWebPush(message(), makeEnv())).rejects.toThrow("queue unavailable");

    // The sends happened first, so queues/jobs.ts's catch calls retry() and
    // both subscribers get a duplicate on the next attempt. Pinned as the
    // current behaviour: the alternative -- swallowing the enqueue failure --
    // would silently truncate the fan-out instead, which is worse and harder
    // to see.
    expect(pushRequests).toHaveLength(2);
    // The dead row is gone even though the enqueue failed: the cleanup runs
    // BEFORE the send, so the retry does not re-attempt a known-dead endpoint
    // and does not depend on the queue being up to get rid of it.
    expect(remainingSubscriptionIds()).toEqual([2]);
  });

  it("throws on a message with no needId, rather than quietly sending nothing", async () => {
    // A malformed body reaches the database as an undefined bind, which
    // node:sqlite refuses outright (D1 refuses it too, with its own wording --
    // the error text is not asserted here because only node:sqlite's was
    // observed). The valuable part is that it PROPAGATES: queues/jobs.ts
    // retries, and after "jobs" max_retries 3 the message lands in jobs-dlq
    // where queues/jobsDlq.ts logs it. A handler that swallowed this would
    // ack a notification that never went out.
    const malformed = { type: "notify-need-webpush" } as unknown as NotifyNeedWebPushMessage;
    await expect(handleNotifyNeedWebPush(malformed, makeEnv())).rejects.toThrow();
    expect(pushRequests).toEqual([]);
  });

  it("throws on a message with no afterId cursor", async () => {
    // Same class, one statement later: the page query binds `id > undefined`.
    // Worth its own test because a `?? 0` default anywhere on this path would
    // turn a malformed message into a silent RE-SEND of page one.
    const malformed = { type: "notify-need-webpush", needId: NEED } as unknown as NotifyNeedWebPushMessage;
    await expect(handleNotifyNeedWebPush(malformed, makeEnv())).rejects.toThrow();
    expect(pushRequests).toEqual([]);
  });
});
