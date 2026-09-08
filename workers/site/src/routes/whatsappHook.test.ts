import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { ExecutionContext } from "hono";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import type { AppEnv } from "../types";
import type { Env } from "../../worker-configuration";
import { whatsappHook } from "./whatsappHook";

// routes/whatsappHook.ts -- Meta's WhatsApp webhook. GET is the verification
// handshake; POST is an inbound message, signature-checked and handed to the
// whatsapp-hook queue.
//
// WHY THIS FILE IS WORTH ITS LENGTH. Every single failure mode of this
// endpoint is INVISIBLE, by design:
//
//   * Every POST answers 200 whatever happens -- verified, rejected,
//     unparseable, or an exception. That is deliberate (Meta de-registers a
//     webhook that stops returning 200) and it means the status code carries
//     no information at all. A wrong WHATSAPP_APP_SECRET produces a 200; a
//     tampered payload produces a 200; a queue send that never happens
//     produces a 200. The module's own header says so in capitals: getting
//     the secret wrong "FAILS CLOSED AND SILENTLY -- ... the only evidence
//     would be a log line". So the assertions below are on what was
//     ENQUEUED and what was LOGGED, never on the status alone.
//   * The queue's consumer is workers/jobs/src/queues/whatsappHook.ts, which
//     walks `payload.entry[].changes[].value.messages[]`. It went unbuilt
//     from WP 4.8 until 2026-09-05, during which every inbound message was
//     verified, enqueued, 200'd and dropped (that file's own header). It now
//     carries STOP/unsubscribe for 51 real people, so an enqueue that stops
//     happening -- or that enqueues the raw JSON string instead of the
//     parsed object, which extractMessages() would silently read as "no
//     messages" -- is an opt-out nobody can exercise, reported by nothing.
//
// REAL APP. Everything below drives `app`, the default export of
// workers/site/src/index.ts, so each request unwinds through the real
// middleware chain (serverTiming, securityHeaders, cacheTag, runtimeIdentity,
// slugRedirect, resolveLanguage, geoJsonPreload, pageCacheControl) and the
// real `app.all("/whatsapp_hook/", whatsappHook)` registration at
// index.ts:511. Three of the properties asserted here are properties of that
// combination and are invisible to a handler tested on its own: that the GET
// echo is never given a Cache-Control header (pageCacheControl.ts:104 names
// this route explicitly), that it carries nosniff, and that a slashless POST
// does NOT reach the handler at all.
//
// The exported symbol is `whatsappHook` and only that. It is exercised through
// the real router almost throughout -- the log strings asserted below
// ("whatsapp_hook: ...") appear nowhere else in the codebase, so they are also
// the evidence that index.ts's route really is this function -- and directly,
// in a bare Hono with no middleware, in the last describe, which says why.
//
// DJANGO SOURCE, read at /Users/jasoncartwright/Sites/foodcharity:
// givefood/views.py:1330-1396 (`@csrf_exempt def whatsapp_hook`) and
// givefood/urls.py:70 (untranslated, outside i18n_patterns). Two parity
// claims below were checked by RUNNING Django 5.2.6 on this machine (the
// version `python3 -c "import django; print(django.get_version())"` prints
// here); each quotes its program and output at the test that depends on it.

const ORIGIN = "https://www.givefood.org.uk";
const PATH = "/whatsapp_hook/";
const VERIFY_TOKEN = "hub-verify-token-under-test";
const APP_SECRET = "meta-app-secret-under-test";

// ---------------------------------------------------------------------------
// An INDEPENDENT HMAC-SHA256, over BYTES
// ---------------------------------------------------------------------------

// Built from the RFC 2104 construction over WebCrypto's SHA-256 digest rather
// than by importing lib/hmac.ts's hmacSha256HexBytes -- which is the function
// under test here, one layer down. Signing the fixtures with the module's own
// helper would only ever prove the code agrees with itself: if hmac.ts changed
// its key derivation or its hex encoding, both sides would move together, the
// suite would stay green, and every request Meta actually signs would start
// being rejected (silently, with a 200).
async function rfc2104HmacSha256Hex(secret: string, message: Uint8Array): Promise<string> {
  const blockSize = 64; // SHA-256's block size, in bytes
  let keyBytes: Uint8Array = new TextEncoder().encode(secret);
  if (keyBytes.length > blockSize) keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", keyBytes));
  const paddedKey = new Uint8Array(blockSize);
  paddedKey.set(keyBytes);

  const innerPad = new Uint8Array(blockSize);
  const outerPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    innerPad[i] = (paddedKey[i] ?? 0) ^ 0x36;
    outerPad[i] = (paddedKey[i] ?? 0) ^ 0x5c;
  }

  const innerInput = new Uint8Array(blockSize + message.length);
  innerInput.set(innerPad);
  innerInput.set(message, blockSize);
  const innerHash = new Uint8Array(await crypto.subtle.digest("SHA-256", innerInput));

  const outerInput = new Uint8Array(blockSize + innerHash.length);
  outerInput.set(outerPad);
  outerInput.set(innerHash, blockSize);
  const mac = new Uint8Array(await crypto.subtle.digest("SHA-256", outerInput));
  return Array.from(mac)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The oracle is only worth anything if it is itself right, so it is pinned to
// a published known-answer vector before being used to judge the module.
// Without this, a bug in the helper would surface as a confusing "signature
// rejected" failure below rather than here. Same vector csrf.test.ts uses.
it("the test's own HMAC oracle matches RFC 4231 test case 2", async () => {
  const message = new TextEncoder().encode("what do ya want for nothing?");
  expect(await rfc2104HmacSha256Hex("Jefe", message)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
});

/** The `X-Hub-Signature-256` header value Meta would send for these bytes. */
async function sign(body: Uint8Array, secret = APP_SECRET): Promise<string> {
  return `sha256=${await rfc2104HmacSha256Hex(secret, body)}`;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

type Bindable = null | number | bigint | string | Uint8Array;

// The D1 surface packages/db uses, over a real in-memory SQLite built from the
// real migrations. It exists here to be NOT USED: this endpoint is public,
// unauthenticated and hit by whoever finds it, and "costs no database read" is
// a property worth holding rather than assuming. Real, rather than a thrower,
// so an unexpected query would run and be recorded instead of turning into a
// 500 that some other assertion would blame.
function countingD1(db: DatabaseSync, prepares: string[]): D1Database {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  const prepare = (sql: string) => {
    prepares.push(sql);
    return statement(sql, []);
  };
  return { prepare, withSession: () => ({ prepare, getBookmark: () => null }) } as unknown as D1Database;
}

// schemaFor() rather than hand-written DDL: a shared query that started
// reading a view a hand-built fixture lacked is what broke eight suites at
// once. Nothing here should touch the database at all -- see above.
const SCHEMA = schemaFor("foodbank");

let db: DatabaseSync;
let prepares: string[];
/** Every payload handed to WHATSAPP_Q.send(), in order. */
let sent: unknown[];
/** Every promise passed to executionCtx.waitUntil(), so tests can settle them. */
let tasks: Promise<unknown>[];
let errors: unknown[][];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepares = [];
  sent = [];
  tasks = [];
  errors = [];
  // The log line IS the alerting for this endpoint, so it is captured rather
  // than silenced-and-forgotten: several tests assert its exact text.
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

/** The flattened first argument of every console.error the request made. */
const logged = (): string[] => errors.map((args) => String(args[0]));

const execCtx = (): ExecutionContext =>
  ({
    waitUntil: (p: Promise<unknown>) => {
      tasks.push(p);
    },
    passThroughOnException: () => {},
  }) as unknown as ExecutionContext;

/** Awaits everything the handler deferred, and reports whether any rejected. */
async function settle(): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(tasks);
}

type QueueOverride = { send: (body: unknown) => Promise<void> };

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    WHATSAPP_WEBHOOKVERIFYTOKEN: VERIFY_TOKEN,
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_Q: {
      send: (body: unknown) => {
        sent.push(body);
        return Promise.resolve();
      },
    },
    DB: countingD1(db, prepares),
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    SITE_DOMAIN: ORIGIN,
    ...overrides,
  } as unknown as Env;
}

// `async`, not a bare arrow, throughout: app.fetch is typed
// `Response | Promise<Response>`, so returning it directly does not typecheck.
async function get(query: string, bindings: Env = env()): Promise<Response> {
  return app.fetch(new Request(`${ORIGIN}${PATH}${query}`), bindings, execCtx());
}

/** A POST exactly as Meta sends one: raw bytes plus the signature header. */
async function post(body: BodyInit | null, headers: Record<string, string> = {}, bindings: Env = env(), path = PATH): Promise<Response> {
  return app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", body, headers }), bindings, execCtx());
}

/** app.fetch for a Request a test built itself (a streaming or exotic body). */
async function send(request: Request, bindings: Env = env()): Promise<Response> {
  return app.fetch(request, bindings, execCtx());
}

/** A signed POST of `bytes`, which is the only kind that should ever enqueue. */
async function signedPost(bytes: Uint8Array, bindings: Env = env()): Promise<Response> {
  return post(bytes, { "X-Hub-Signature-256": await sign(bytes), "Content-Type": "application/json" }, bindings);
}

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

// The shape Meta actually delivers for an inbound text message, trimmed to the
// fields the queue's consumer reads (workers/jobs/src/queues/whatsappHook.ts's
// extractMessages walks entry[].changes[].value.messages[]). Used as "normal
// traffic" throughout, so the enqueue assertions are about a real payload
// rather than about `{"a":1}`.
const META_PAYLOAD = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "0",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "442039206758", phone_number_id: "890504590819478" },
            contacts: [{ profile: { name: "A Person" }, wa_id: "447700900123" }],
            messages: [{ from: "447700900123", id: "wamid.TEST", timestamp: "1757088000", type: "text", text: { body: "unsubscribe sid-valley" } }],
          },
        },
      ],
    },
  ],
};
const META_BODY = encode(JSON.stringify(META_PAYLOAD));

/** Fails a test that hangs, instead of letting it die by suite timeout. */
async function within<T>(ms: number, work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// GET -- Meta's verification handshake (views.py:1344-1355)
// ---------------------------------------------------------------------------

describe("GET verification", () => {
  it("echoes hub.challenge back verbatim as text/plain", async () => {
    // The whole handshake. Meta issues this on subscribe and periodically
    // afterwards; anything but the exact challenge bytes back and the webhook
    // is not registered, which is indistinguishable from "no one is messaging
    // us". The challenge is a random number-ish string of Meta's choosing --
    // 1158201444 is the form their docs use.
    const res = await get(`?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
    // Exactly "text/plain", no charset -- which is what Django sends too.
    // Verified by running Django 5.2.6 here:
    //   HttpResponse(None, content_type='text/plain')['Content-Type']
    //   -> 'text/plain'
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("rejects a wrong verify token with 403 and no echo", async () => {
    // The failure that matters: if any token were accepted, anyone could
    // register their own callback URL against this app and start receiving
    // (or racing for) the subscribers' inbound messages.
    const res = await get("?hub.mode=subscribe&hub.verify_token=not-the-token&hub.challenge=1158201444");

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Verification failed");
  });

  it("rejects a token that is merely a prefix of the real one", async () => {
    // timingSafeEqual compares lengths first and then every character; a
    // startsWith()-shaped mistake would accept this. Also the case a naive
    // "constant time" loop over the shorter string gets wrong.
    const res = await get(`?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN.slice(0, 5)}&hub.challenge=x`);

    expect(res.status).toBe(403);
  });

  it("requires hub.mode=subscribe exactly, case included", async () => {
    // views.py:1352 is `if mode == 'subscribe' and token == verify_token`, an
    // exact string comparison. Every other mode -- the capitalised forms, a
    // trailing space, and Meta's own "unsubscribe" -- must 403 rather than
    // echo, or the endpoint becomes a plain reflector of arbitrary text for
    // anyone who learns the verify token.
    for (const mode of ["Subscribe", "SUBSCRIBE", "unsubscribe", "", "subscribe "]) {
      const res = await get(`?hub.mode=${encodeURIComponent(mode)}&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`);
      expect(res.status, `hub.mode=${JSON.stringify(mode)}`).toBe(403);
    }
  });

  it("403s when hub.mode is absent even though the token is right", async () => {
    const res = await get(`?hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`);
    expect(res.status).toBe(403);
  });

  it("FAILS CLOSED when WHATSAPP_WEBHOOKVERIFYTOKEN is unset, where Django failed OPEN", async () => {
    // THE DIVERGENCE THIS BRANCH EXISTS FOR. Django reads the token with
    // get_cred("whatsapp_webhookverifytoken"), which returns None when the
    // GfCredential row is missing (givefood/utils/cache.py:200-216, read --
    // not run, there is no database here to remove a row from). A GET with no
    // hub.verify_token then compares None == None at views.py:1352 and
    // Django echoes the challenge: an unprovisioned deployment verifies
    // ANYONE's webhook subscription. The port treats an unset secret as an
    // immediate 403, so the request below -- which is the exact fail-open
    // shape, mode=subscribe and no token at all -- is refused.
    const res = await get("?hub.mode=subscribe&hub.challenge=1158201444", env({ WHATSAPP_WEBHOOKVERIFYTOKEN: undefined }));

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Verification failed");
    // Logged DISTINCTLY, per the module comment: an unprovisioned secret must
    // not read as ordinary failed traffic in the Workers logs, because the two
    // have completely different fixes.
    expect(logged()).toContain("whatsapp_hook: WHATSAPP_WEBHOOKVERIFYTOKEN not set -- failing verification closed");
  });

  it("never treats an empty-string secret as a wildcard", async () => {
    // A secret that was deleted rather than unset (`wrangler secret put` with
    // an empty value, or a var set to "") arrives as "" -- falsy, so the same
    // fail-closed branch takes it. Without the falsy check, timingSafeEqual("",
    // "") would be TRUE and an empty hub.verify_token would verify.
    const res = await get("?hub.mode=subscribe&hub.verify_token=&hub.challenge=x", env({ WHATSAPP_WEBHOOKVERIFYTOKEN: "" }));

    expect(res.status).toBe(403);
    expect(logged()).toContain("whatsapp_hook: WHATSAPP_WEBHOOKVERIFYTOKEN not set -- failing verification closed");
  });

  it("returns an EMPTY body when hub.challenge is missing, where Django returns the string \"None\"", async () => {
    // A real divergence, pinned rather than wished away. Verified by running
    // Django 5.2.6 on this machine:
    //   >>> HttpResponse(None, content_type='text/plain').content
    //   b'None'
    // because make_bytes() falls through to str(value).encode(). So Django
    // echoes the four characters "None" and this port echoes nothing. Neither
    // satisfies Meta (which only ever sends a challenge), and the port's is the
    // less absurd of the two -- but if anyone ever diffs the two servers, this
    // is one of the differences.
    const res = await get(`?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("takes the FIRST value of a duplicated hub.verify_token, where Django takes the last", async () => {
    // Django's QueryDict is a MultiValueDict whose .get() returns the LAST
    // occurrence. Verified by running Django 5.2.6 here:
    //   >>> QueryDict('hub.mode=subscribe&hub.verify_token=wrong'
    //   ...           '&hub.verify_token=right').get('hub.verify_token')
    //   'right'
    // Hono's c.req.query() returns the first. So a URL carrying a decoy
    // followed by the real token verifies on Django and is refused here. That
    // is the safer direction (a request-smuggling-flavoured trick stops
    // working), and it is CURRENT behaviour, not desired behaviour -- pinned
    // because it is exactly the kind of thing a "use the last value like
    // Django" tidy-up would reverse without knowing it was a security choice.
    const res = await get(`?hub.mode=subscribe&hub.verify_token=wrong&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`);

    expect(res.status).toBe(403);
  });

  it("echoes the challenge unescaped, and relies on text/plain + nosniff to make that safe", async () => {
    // This endpoint reflects attacker-supplied text to the caller, so the two
    // things stopping it being a stored-XSS-shaped gadget are the content type
    // and securityHeaders.ts's nosniff. Both are asserted together because
    // either one alone is insufficient: text/html here, or a browser sniffing
    // past text/plain, and the reflection becomes script. (The challenge is not
    // escaped -- deliberately; Meta compares the echo byte for byte.)
    const res = await get(`?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${encodeURIComponent("<script>alert(1)</script>")}`);

    expect(await res.text()).toBe("<script>alert(1)</script>");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("is never given a Cache-Control header, so the echo cannot be shared-cached", async () => {
    // pageCacheControl.ts:98-105 took text/plain OFF its cacheable list and
    // names THIS route in the comment for doing so. The precedent was
    // /frag/ip-address/, observed on production 2026-09-07 as a cache HIT with
    // age 1427 carrying a stranger's IPv6 address. Here the shared value would
    // be one caller's challenge served to the next caller -- and a cached 200
    // would keep answering after the secret changed. Asserted from the route's
    // end as well as the middleware's, because the middleware could stay
    // correct while this response acquired a Content-Type that matched it.
    const res = await get(`?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);

    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("costs no database query and enqueues nothing", async () => {
    await get(`?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`);
    await get("?hub.mode=subscribe&hub.verify_token=wrong");

    expect(prepares).toEqual([]);
    expect(sent).toEqual([]);
    expect(tasks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST -- the signature check (added by the port; Django has none)
// ---------------------------------------------------------------------------

describe("POST signature verification", () => {
  it("accepts a correctly signed delivery and enqueues the PARSED payload", async () => {
    // The one path that does anything. Two assertions, both load-bearing:
    //
    //   * exactly one send, deep-equal to the parsed envelope. If the raw JSON
    //     *string* were enqueued instead, the consumer's extractMessages()
    //     would read `payload.entry` off a string, get undefined, return [] and
    //     ignore the message -- with no error anywhere. That is the failure
    //     this deep-equal exists for, not "an object was sent".
    //   * the message the consumer will act on survives intact, spelled out
    //     rather than implied, because "unsubscribe sid-valley" arriving as
    //     anything else is somebody who cannot stop the messages.
    const res = await signedPost(META_BODY);
    await settle();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(sent).toEqual([META_PAYLOAD]);
    const message = (sent[0] as typeof META_PAYLOAD).entry[0]?.changes[0]?.value.messages[0];
    expect(message?.text.body).toBe("unsubscribe sid-valley");
    expect(logged()).toEqual([]);
  });

  it("rejects a body that was tampered with after signing", async () => {
    // The attack the whole check exists to stop, and the only test here that
    // fails if the HMAC is computed over anything other than the body: sign a
    // legitimate payload, deliver a different one under that signature. Django
    // has no check at all (views.py:1330-1396, confirmed), so on the old site
    // this POST would have been processed -- "anyone who can POST to it can
    // subscribe or unsubscribe an arbitrary phone number" (PLAN.md §9228).
    const tampered = encode(JSON.stringify({ ...META_PAYLOAD, object: "tampered" }));
    const res = await post(tampered, { "X-Hub-Signature-256": await sign(META_BODY) });
    await settle();

    expect(res.status).toBe(200); // always 200, which is why `sent` is the assertion
    expect(sent).toEqual([]);
    expect(logged()).toContain("whatsapp_hook: rejected POST -- signature mismatch");
  });

  it("rejects a signature made with the wrong secret", async () => {
    // The WHATSAPP_TOKEN-instead-of-WHATSAPP_APP_SECRET mix-up the module
    // header spends a paragraph on, seen from the attacker's side: knowing the
    // payload is not enough, and neither is holding some other Meta credential.
    const res = await post(META_BODY, { "X-Hub-Signature-256": await sign(META_BODY, "the-access-token-not-the-app-secret") });
    await settle();

    expect(sent).toEqual([]);
    expect(res.status).toBe(200);
    expect(logged()).toContain("whatsapp_hook: rejected POST -- signature mismatch");
  });

  it("verifies over the RAW BYTES, so a body containing invalid UTF-8 still passes", async () => {
    // hmac.ts's reason for existing in two flavours, made observable. The body
    // is `{"t":"caf<0xE9>"}` -- 0xE9 is a lone Latin-1 byte, invalid UTF-8 --
    // signed over those exact bytes, as Meta would.
    //
    // THIS TEST KILLS THE c.req.text() MUTANT. Decoding to a string first
    // replaces 0xE9 with U+FFFD (three bytes), so re-encoding for the HMAC
    // would hash different bytes than were signed, the signature would mismatch
    // and the message would be dropped -- silently, with a 200. The port reads
    // c.req.arrayBuffer() instead, so it verifies and enqueues; the U+FFFD only
    // appears afterwards, in the JSON.parse step, which is where it belongs.
    const raw = new Uint8Array([...encode('{"t":"caf'), 0xe9, ...encode('"}')]);
    const res = await signedPost(raw);
    await settle();

    expect(res.status).toBe(200);
    expect(sent).toEqual([{ t: "caf\uFFFD" }]); // U+FFFD, the decoder's replacement character
  });

  it("rejects a POST with no X-Hub-Signature-256 at all, without ever reading the body", async () => {
    // Both halves matter. The rejection is the security property; not reading
    // the body is the availability one -- this is a public, unauthenticated
    // URL, and buffering a POST body before deciding to reject it is how an
    // endpoint like this gets used to burn someone else's CPU time. The
    // module's comment says the cheap checks come "first ... reject before
    // ever buffering the request body", and this is that claim under test.
    //
    // MEASURED BY HANGING, not by counting pulls: undici pulls the first chunk
    // of a stream body on its own a tick after the Request is constructed,
    // whether or not anyone reads it (checked directly), so a pull counter says
    // nothing. A body that never produces data does: if the handler awaited
    // c.req.arrayBuffer() here it could never answer, and `within` turns that
    // into a named failure rather than a suite timeout. request.bodyUsed is
    // asserted alongside as the direct statement of the same fact.
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {}); // a client that opened the request and then went quiet
      },
    });
    const request = new Request(`${ORIGIN}${PATH}`, { method: "POST", body, duplex: "half" } as RequestInit);

    const res = await within(2000, send(request), "the handler buffered the body before checking for a signature header");
    await settle();

    expect(res.status).toBe(200);
    expect(request.bodyUsed).toBe(false);
    expect(sent).toEqual([]);
    expect(logged()).toContain("whatsapp_hook: rejected POST -- missing or malformed X-Hub-Signature-256");
  });

  it("rejects every malformed signature header shape", async () => {
    // The prefix check is a startsWith("sha256="), so each of these fails it a
    // different way on the road to the same 200-and-drop: a bare digest with no
    // prefix, the value Meta's older X-Hub-Signature (sha1) header carries, a
    // plausible separator that is not "=", the prefix with nothing after it,
    // the prefix uppercased, and the prefix with a space before the "=". Every
    // one of them is a correct digest of the body -- what is wrong is only the
    // envelope, which is the half a lenient parser would forgive.
    const digest = await rfc2104HmacSha256Hex(APP_SECRET, META_BODY);
    const headers = [digest, `sha1=${digest}`, `sha256:${digest}`, "sha256=", `SHA256=${digest}`, `sha256 =${digest}`];

    for (const value of headers) {
      sent = [];
      const res = await post(META_BODY, { "X-Hub-Signature-256": value });
      await settle();
      expect(res.status, value).toBe(200);
      expect(sent, value).toEqual([]);
    }
  });

  it("still accepts a signature header padded with leading whitespace", async () => {
    // Not the module's doing, and the reason the case above does NOT include a
    // leading space: HTTP field values are stripped of surrounding whitespace
    // before a handler ever sees them, so the header the handler reads here is
    // already `sha256=...` (measured -- this passes, and it only passes because
    // the Headers object trimmed it; the Workers runtime does the same).
    // Pinned so nobody "hardens" the startsWith() check by trimming first and
    // believes they have closed a hole: none was open, and a trim added there
    // would instead START accepting "  sha256=..." should the platform ever
    // stop normalising.
    const res = await post(META_BODY, { "X-Hub-Signature-256": `  ${await sign(META_BODY)}  ` });
    await settle();

    expect(sent).toEqual([META_PAYLOAD]);
  });

  it("rejects a hex digest of the wrong length, and one that is right but uppercased", async () => {
    // Length first (timingSafeEqual returns false before comparing anything),
    // then case. hmac.ts emits lowercase hex and Meta sends lowercase hex, so
    // the uppercase form is a correct MAC in the wrong presentation and is
    // refused. Pinned as CURRENT behaviour and flagged as mildly suspect: if
    // Meta ever changed the case, every message would drop silently and the
    // only evidence would be the "signature mismatch" line.
    const digest = await rfc2104HmacSha256Hex(APP_SECRET, META_BODY);

    for (const value of [digest.slice(0, 63), `${digest}00`, digest.toUpperCase()]) {
      sent = [];
      const res = await post(META_BODY, { "X-Hub-Signature-256": `sha256=${value}` });
      await settle();
      expect(res.status, value).toBe(200);
      expect(sent, value).toEqual([]);
    }
  });

  it("reads the signature header case-insensitively, as HTTP/2 requires", async () => {
    // Meta delivers over HTTP/2, where header names are lowercase on the wire.
    // A handler that only matched the documented mixed-case spelling would
    // reject every real delivery while passing any test that used the
    // documented spelling -- so both spellings are exercised.
    const res = await post(META_BODY, { "x-hub-signature-256": await sign(META_BODY) });
    await settle();

    expect(res.status).toBe(200);
    expect(sent).toEqual([META_PAYLOAD]);
  });

  it("FAILS CLOSED when WHATSAPP_APP_SECRET is unset, and says so distinctly in the log", async () => {
    // The scenario the module header calls out in capitals. An unprovisioned
    // (or renamed, or typo'd) secret rejects every message while still
    // answering Meta 200, so the webhook stays registered, the dashboard shows
    // healthy delivery, and nothing is processed. The distinct log line is the
    // ENTIRE difference between "misconfigured" and "someone is probing us",
    // which is why its exact text is asserted.
    const res = await post(META_BODY, { "X-Hub-Signature-256": await sign(META_BODY) }, env({ WHATSAPP_APP_SECRET: undefined }));
    await settle();

    expect(res.status).toBe(200);
    expect(sent).toEqual([]);
    expect(logged()).toEqual(["whatsapp_hook: WHATSAPP_APP_SECRET not set -- rejecting POST closed"]);
  });

  it("still refuses when the secret is an empty string", async () => {
    // Same falsy guard as the verify token. An empty secret is a real
    // deployment state (a cleared value) and must never mean "sign with
    // nothing"; without the guard, an attacker who knew the secret was blank
    // could produce valid MACs.
    const body = encode("{}");
    const res = await post(body, { "X-Hub-Signature-256": await sign(body, "") }, env({ WHATSAPP_APP_SECRET: "" }));
    await settle();

    expect(sent).toEqual([]);
    expect(logged()).toEqual(["whatsapp_hook: WHATSAPP_APP_SECRET not set -- rejecting POST closed"]);
  });

  it("checks the signature BEFORE parsing, so unparseable-but-unsigned bodies never reach JSON.parse", async () => {
    // Order of operations, made visible through the log. An unsigned request
    // carrying garbage must be refused for its signature, not for its JSON --
    // parse-then-verify would mean attacker-controlled bytes reaching the
    // parser on every request from anyone.
    const res = await post(encode("not json at all"), { "X-Hub-Signature-256": "sha256=deadbeef" });
    await settle();

    expect(res.status).toBe(200);
    expect(logged()).toEqual(["whatsapp_hook: rejected POST -- signature mismatch"]);
  });
});

// ---------------------------------------------------------------------------
// POST -- the always-200 contract and the enqueue
// ---------------------------------------------------------------------------

describe("POST payload handling and enqueue", () => {
  it("drops a correctly signed body that is not valid JSON, and logs it as the anomaly it is", async () => {
    // A DELIBERATE DEPARTURE FROM DJANGO, which 400s here -- `except
    // json.JSONDecodeError: return HttpResponse(status=400)`, views.py:1361-1362
    // in the checkout read 2026-09-08 (the module's own header cites 1358-1359,
    // which is where the enclosing `if request.method == 'POST':` sits).
    // PLAN.md's requirement wins: Meta de-registers a webhook that stops
    // returning 200. The log line is worded to say the quiet part -- a valid
    // signature over invalid JSON means Meta sent us something we do not
    // understand, which is a genuinely different event from a forged request.
    const body = encode("{ this is not json");
    const res = await signedPost(body);
    await settle();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(sent).toEqual([]);
    expect(logged()).toEqual(["whatsapp_hook: rejected POST -- body is not valid JSON despite a valid signature"]);
  });

  it("drops a correctly signed EMPTY body", async () => {
    // Meta sends no such thing, but a health checker or a proxy retry might.
    // JSON.parse("") throws, so this lands in the same branch -- worth its own
    // case because an empty ArrayBuffer is the input most likely to slip past a
    // hand-rolled "is there a body" check further up.
    const res = await signedPost(new Uint8Array(0));
    await settle();

    expect(res.status).toBe(200);
    expect(sent).toEqual([]);
    expect(logged()).toEqual(["whatsapp_hook: rejected POST -- body is not valid JSON despite a valid signature"]);
  });

  it("enqueues JSON that is valid but is not an object at all", async () => {
    // CURRENT BEHAVIOUR, pinned rather than endorsed: the route does no shape
    // validation, so a signed `null` or `42` is forwarded to the queue exactly
    // as a real envelope would be. That is defensible here (the consumer's
    // extractMessages() is defensive at every level and returns [] for both),
    // but it means the queue is not a source of well-formed messages and
    // anything downstream that assumes an object must keep its own guard.
    for (const [text, expected] of [
      ["null", null],
      ["42", 42],
      ['"just a string"', "just a string"],
      ["[]", []],
    ] as const) {
      sent = [];
      const body = encode(text);
      const res = await signedPost(body);
      await settle();
      expect(res.status, text).toBe(200);
      expect(sent, text).toEqual([expected]);
    }
  });

  it("answers 200 without waiting for the enqueue to complete", async () => {
    // waitUntil, not await -- the module's own stated design ("the response to
    // Meta is always exactly 200 regardless of whether the send succeeds, so
    // waiting for it first only adds latency"). Measured by a send that never
    // settles: if the handler awaited it, the response would never arrive and
    // this test would hang, which `within` turns into a readable failure
    // instead of a suite timeout. Meta's webhook delivery has a hard timeout,
    // so this is a real availability property, not a micro-optimisation.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue: QueueOverride = {
      send: (body: unknown) => {
        sent.push(body);
        return gate;
      },
    };

    const res = await within(2000, signedPost(META_BODY, env({ WHATSAPP_Q: queue })), "the handler awaited the enqueue instead of deferring it");

    expect(res.status).toBe(200);
    expect(sent).toEqual([META_PAYLOAD]); // the send was STARTED, just not awaited
    expect(tasks).toHaveLength(1);
    release();
    await settle();
  });

  it("swallows a queue send that rejects: 200 to Meta, an error in the log, no unhandled rejection", async () => {
    // A downstream failure (queue quota, a transient Cloudflare error) must not
    // become an unhandled rejection inside waitUntil -- on Workers that shows
    // up as an invocation error on a request that already returned 200,
    // i.e. noise on the exact dashboard that would otherwise be trusted.
    // Promise.allSettled below is the assertion: the deferred promise must be
    // FULFILLED even though the send rejected, which is what the .catch() in
    // the handler buys.
    const queue: QueueOverride = {
      send: (body: unknown) => {
        sent.push(body);
        return Promise.reject(new Error("Queue send failed: over quota"));
      },
    };
    const res = await signedPost(META_BODY, env({ WHATSAPP_Q: queue }));
    const settled = await settle();

    expect(res.status).toBe(200);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled"]);
    expect(logged()).toContain("whatsapp_hook: failed to enqueue a verified message");
    // THE MESSAGE IS LOST HERE. There is no retry and no dead-letter path on
    // the producer side -- whatsapp-hook's max_retries/DLQ (jobs
    // wrangler.jsonc:163-166) only cover a message that was accepted by the
    // queue. Meta has already been told 200, so it will not redeliver. Pinned
    // so the cost is written down: a failed enqueue is a dropped opt-out.
  });

  it("survives a queue binding that throws synchronously", async () => {
    // Not the same branch as a rejected promise: a synchronous throw happens
    // before .catch() is attached, so it escapes handleInbound entirely and is
    // caught by the outer try/catch in whatsappHook. That is the difference
    // between a 200 and index.ts's global onError turning this into an HTML
    // 500 -- which would break the always-200 contract and, eventually, the
    // webhook registration.
    const queue = {
      send: () => {
        throw new TypeError("WHATSAPP_Q is not a queue");
      },
    };
    const res = await signedPost(META_BODY, env({ WHATSAPP_Q: queue }));
    await settle();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(logged()).toContain("whatsapp_hook: unexpected error handling POST");
  });

  it("answers 200 when the request body stream errors mid-read", async () => {
    // The exact scenario the module header names for wrapping the whole
    // handler in a try/catch: "a request body stream erroring mid-read".
    // Without the catch this reaches app.onError and comes back as an HTML
    // 500 -- a page, from a webhook, to Meta.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection reset by peer"));
      },
    });
    const request = new Request(`${ORIGIN}${PATH}`, {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": await sign(META_BODY) },
      duplex: "half",
    } as RequestInit);

    const res = await send(request);
    await settle();

    expect(res.status).toBe(200);
    // No Content-Type at all -- a bodiless 200, not render500.ts's HTML page,
    // which is what app.onError would have produced had the throw escaped.
    expect(res.headers.get("Content-Type")).toBeNull();
    expect(sent).toEqual([]);
    expect(logged()).toContain("whatsapp_hook: unexpected error handling POST");
  });

  it("enqueues both copies of a redelivered message -- it does not deduplicate", async () => {
    // Cloudflare Queues and Meta's webhook are BOTH at-least-once, and Meta
    // retries anything it does not see a 200 for quickly enough. This route
    // holds no state, so the same wamid delivered twice is enqueued twice.
    // CURRENT behaviour, pinned because it is load-bearing for the consumer:
    // idempotency has to live there (subscribe/unsubscribe are naturally
    // idempotent, but the outbound confirmation reply is not -- a redelivery
    // means a real person gets two WhatsApp messages).
    await signedPost(META_BODY);
    await signedPost(META_BODY);
    await settle();

    expect(sent).toEqual([META_PAYLOAD, META_PAYLOAD]);
  });

  it("costs no database query, however the POST turns out", async () => {
    // Public, unauthenticated, and hit by anyone who finds it in a URL list.
    // A D1 read on this path would be paid for by traffic nobody is watching.
    await signedPost(META_BODY);
    await post(META_BODY, { "X-Hub-Signature-256": "sha256=00" });
    await post(META_BODY);
    await settle();

    expect(prepares).toEqual([]);
  });

  it("returns a bodiless 200 on every POST outcome", async () => {
    // The contract, stated once over all five branches rather than inferred
    // from five separate tests: verified, unsigned, mis-signed, unparseable,
    // and secret-missing all look IDENTICAL on the wire. It is stated here so
    // that the reason none of the tests above assert on the status alone is
    // written down next to the proof.
    const cases: Array<[string, () => Promise<Response>]> = [
      ["verified", () => signedPost(META_BODY)],
      ["unsigned", () => post(META_BODY)],
      ["mis-signed", async () => post(META_BODY, { "X-Hub-Signature-256": await sign(META_BODY, "wrong") })],
      ["unparseable", () => signedPost(encode("<xml/>"))],
      ["no secret", async () => post(META_BODY, { "X-Hub-Signature-256": await sign(META_BODY) }, env({ WHATSAPP_APP_SECRET: undefined }))],
    ];

    for (const [name, run] of cases) {
      const res = await run();
      expect(res.status, name).toBe(200);
      expect(await res.text(), name).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Routing: the method gate and the URL Meta is configured with
// ---------------------------------------------------------------------------

describe("the route as index.ts mounts it", () => {
  it("405s every method that is neither GET nor POST", async () => {
    // index.ts:506-511 uses app.all specifically so these reach the handler's
    // own 405 branch rather than a bare Hono 404, mirroring Django's final
    // `return HttpResponse(status=405)` at views.py:1396.
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await send(new Request(`${ORIGIN}${PATH}`, { method }));
      expect(res.status, method).toBe(405);
      expect(await res.text(), method).toBe("");
    }
  });

  it("405s a HEAD request", async () => {
    // CURRENT behaviour, and worth knowing rather than desirable: HEAD is not
    // GET as far as this handler is concerned, so the crawlers and uptime
    // checkers that HEAD every URL they find get a 405. It also has a
    // consequence one test below depends on -- lib/appendSlash.ts probes with
    // HEAD, and 405 is not 404, so the slashless URL redirects.
    const res = await send(new Request(`${ORIGIN}${PATH}`, { method: "HEAD" }));

    expect(res.status).toBe(405);
  });

  it("301s a slashless GET to the canonical /whatsapp_hook/", async () => {
    // Django's APPEND_SLASH, reproduced by index.ts's notFound via
    // lib/appendSlash.ts. Its HEAD probe of the slashed twin gets the 405
    // above, which is neither 404 nor 501, so the redirect is issued.
    const res = await send(new Request(`${ORIGIN}/whatsapp_hook`));

    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/whatsapp_hook/`);
  });

  it("404s a slashless POST instead of redirecting it -- a misconfigured webhook URL fails LOUDLY here", async () => {
    // lib/appendSlash.ts:23 restricts the redirect to GET/HEAD, deliberately
    // diverging from Django (which 301s a POST and loses the body). The
    // consequence for this endpoint is worth writing down: if the Meta App
    // Dashboard's callback URL is ever set without the trailing slash, every
    // delivery gets an HTML 404 rather than the always-200 the rest of this
    // file is about, and Meta de-registers the webhook. That is the one
    // failure mode of this endpoint that is NOT silent, and it is silent on
    // Django, where the 301 would have swallowed the body instead.
    const res = await post(META_BODY, { "X-Hub-Signature-256": await sign(META_BODY) }, env(), "/whatsapp_hook");
    await settle();

    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("<h1>404 - Not Found</h1>");
    expect(sent).toEqual([]);
  });

  it("is untranslated: no locale-prefixed form of the URL exists", async () => {
    // givefood/urls.py:70 puts whatsapp_hook in the untranslated block, OUTSIDE
    // i18n_patterns, and index.ts registers it with no LOCALES loop. A prefixed
    // copy would be a second, equally powerful entry point to the same webhook
    // -- and, being unlisted, the one nobody would think to check.
    for (const locale of ["cy", "ga", "gd"]) {
      const res = await send(new Request(`${ORIGIN}/${locale}${PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`));
      expect(res.status, locale).toBe(404);
    }
  });

  it("a GET with no query string at all is a 403, not a crash", async () => {
    // What a human visiting the URL in a browser gets, and what every scanner
    // that finds it gets. Nothing here may throw: an exception on the GET path
    // is NOT covered by the POST try/catch and would surface as a 500.
    const res = await get("");

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Verification failed");
  });
});

// ---------------------------------------------------------------------------
// The exported handler, mounted bare
// ---------------------------------------------------------------------------

describe("whatsappHook mounted with no middleware at all", () => {
  // Everything above rides the real app, which is the right default. These two
  // ask a different question: does the CONTRACT belong to the handler, or to
  // the app around it? It has to be the handler's, because the contract is
  // "Meta always sees 200" and the thing most likely to break it -- an
  // exception -- is precisely what a host app's onError would otherwise turn
  // into an HTML 500. A bare Hono has no onError of its own to hide behind, so
  // if the try/catch inside whatsappHook ever went away this is where it shows.
  const bare = () => {
    const h = new Hono<AppEnv>();
    h.all("/hook", whatsappHook);
    return h;
  };

  it("answers a bodiless 200 for a request whose body errors, with nothing else in the chain", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection reset by peer"));
      },
    });
    const request = new Request(`${ORIGIN}/hook`, {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": await sign(META_BODY) },
      duplex: "half",
    } as RequestInit);

    const res = await bare().fetch(request, env(), execCtx());
    await settle();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("makes the 405 itself rather than inheriting it from the router", async () => {
    // index.ts:506-510's comment: the handler "branches on method itself
    // (matching Django's own GET/POST/405 shape in one view)", which is why
    // index.ts can register it with app.all and be sure an exotic method still
    // gets 405 rather than the site's 404 page. That is only true while the
    // branch lives here.
    const res = await bare().fetch(new Request(`${ORIGIN}/hook`, { method: "DELETE" }), env(), execCtx());

    expect(res.status).toBe(405);
  });
});
