import { describe, expect, it } from "vitest";
import {
  type EncryptionMaterial,
  encryptPayload,
  encryptWithMaterial,
  type PushSubscriptionKeys,
  vapidAuthorizationHeader,
} from "./webPushCrypto";

// WHY THIS FILE EXISTS.
//
// Every other notification channel fails loudly: Postmark returns an error
// body, Firebase returns a 4xx, WhatsApp returns a JSON error. Web push does
// not. If any byte of RFC 8291 is wrong here the push service still answers
// 201 Created, the queue consumer still logs "sent 25/25", and every browser
// silently discards the message. There is no error anywhere in the system.
// The only symptom is subscribers never hearing anything again -- which is
// exactly the shape of the Browser Rendering credential outage that ran for a
// day before anyone noticed, and this code path is even quieter than that one.
//
// So the tests below are not "does it return bytes". They are:
//
//   1. the RFC 8291 §5 published vector, byte for byte -- proof this agrees
//      with the specification browsers implement, not merely with itself;
//   2. an INDEPENDENT decryptor (written out below, sharing no code with the
//      module) driven by the RFC's receiver private key, so the randomised
//      encryptPayload() path is proved decryptable too -- the vector alone
//      cannot reach it, because it fixes the salt and ephemeral key that
//      encryptPayload() is the sole generator of;
//   3. the RFC 8188 §2.1 header framing field by field, because a wrong
//      record size or key-id length is invisible until a browser rejects it;
//   4. the VAPID assertion's claims and signature, checked against the
//      pywebpush 2.4.0 and py_vapid 1.9.4 actually installed in
//      ../foodcharity/.venv (`ls site-packages`), which is what Django
//      sends: givefood/utils/notifications.py:370-375 hands `webpush()`
//      only `sub`, so `aud` and `exp` are pywebpush's own defaults.
//
// tools/webpush-vector/verify.ts runs the same §5 vector as a standalone
// script under `pnpm test`. It is deliberately duplicated here rather than
// imported: `vitest run` on its own must catch a break in this file, and
// before this suite existed it did not.

// ===================== RFC 8291 §5, verbatim =====================
//
// Copied from the RFC, not from the module. The receiver's private key
// (`ua_private`) is the one field tools/webpush-vector/verify.ts has no use
// for and therefore never carried; it is what makes the decrypt direction
// testable. Its correctness is not assumed -- "the RFC's two keypairs agree
// on the ECDH secret" below re-derives §5's published `ecdh_secret` from both
// sides, so a mistyped scalar fails there rather than quietly weakening every
// round-trip test in this file.
const PLAINTEXT = "When I grow up, I want to be a watermelon";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";
const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const ECDH_SECRET = "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs";

// The complete encrypted message body, base64url, line breaks in the RFC's
// presentation removed.
const EXPECTED_BODY =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
  "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
  "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

// ===================== plumbing =====================

// Written out rather than imported from ./jwt so that a base64 bug in jwt.ts
// cannot cancel itself out against the same bug in the code under test.
function b64urlDecode(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

/** A raw uncompressed P-256 point, imported as an ECDH peer key. */
function importPublic(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as unknown as ArrayBuffer, ECDH_P256, false, []);
}

/**
 * A raw 32-byte scalar plus its public point, as a deriveBits-capable key.
 * WebCrypto cannot import a bare scalar (it exposes no point multiplication),
 * which is the same manoeuvre importVapidKey() makes for VAPID_PRIVATE_KEY.
 */
function importPrivate(dBase64Url: string, publicRaw: Uint8Array, usage: "ECDH" | "ECDSA"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: dBase64Url,
      x: b64urlEncode(publicRaw.subarray(1, 33)),
      y: b64urlEncode(publicRaw.subarray(33, 65)),
      ext: false,
    },
    { name: usage, namedCurve: "P-256" },
    false,
    usage === "ECDH" ? ["deriveBits"] : ["sign"],
  );
}

function ecdh(privateKey: CryptoKey, peerPublic: CryptoKey): Promise<ArrayBuffer> {
  // The runtime property is `public`; @cloudflare/workers-types spells it
  // `$public` because `public` is a TypeScript modifier keyword, so the type
  // is asserted over here exactly as the module under test does.
  return crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublic } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    privateKey,
    256,
  );
}

// A second, independent HKDF. Single output block, which is all RFC 8291
// needs. If this and the module's copy were the same code the round-trip
// tests would prove nothing; they are separate so agreement is evidence.
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const sign = async (keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> => {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes as unknown as ArrayBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data as unknown as ArrayBuffer));
  };
  const prk = await sign(salt, ikm);
  return (await sign(prk, concat(info, new Uint8Array([1])))).subarray(0, length);
}

interface ParsedBody {
  salt: Uint8Array;
  /** RFC 8188 §2.1 record size, big-endian. */
  recordSize: number;
  /** The single `idlen` byte. */
  keyIdLength: number;
  /** The sender's ephemeral public key, as the browser reads it out. */
  keyId: Uint8Array;
  ciphertext: Uint8Array;
}

/** RFC 8188 §2.1: salt(16) || rs(4, big-endian) || idlen(1) || keyid || body. */
function parseBody(body: Uint8Array): ParsedBody {
  const keyIdLength = body[20] as number;
  return {
    salt: body.slice(0, 16),
    recordSize: new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16, false),
    keyIdLength,
    keyId: body.slice(21, 21 + keyIdLength),
    ciphertext: body.slice(21 + keyIdLength),
  };
}

/**
 * What a browser does with the blob the push service relays: parse the RFC
 * 8188 header, ECDH against the key id, re-derive the CEK and nonce, and
 * open the record. Returns the plaintext WITH its padding delimiter still
 * attached, so tests can assert the 0x02 the module appends.
 *
 * This is a real receiver, not a mirror of the encryptor: it reads the salt
 * and ephemeral key out of the message rather than being handed them, so a
 * message whose header disagrees with the key material it was actually
 * encrypted under fails here -- which is precisely the bug a round trip that
 * shared the sender's variables would miss.
 */
async function receive(body: Uint8Array, uaPrivateKey: CryptoKey, uaPublicRaw: Uint8Array, authSecret: Uint8Array) {
  const parsed = parseBody(body);
  const shared = new Uint8Array(await ecdh(uaPrivateKey, await importPublic(parsed.keyId)));
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublicRaw, parsed.keyId);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(parsed.salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(parsed.salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek as unknown as ArrayBuffer, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as unknown as ArrayBuffer, tagLength: 128 },
      key,
      parsed.ciphertext as unknown as ArrayBuffer,
    ),
  );
  return {
    parsed,
    delimiter: padded[padded.length - 1],
    text: new TextDecoder().decode(padded.subarray(0, padded.length - 1)),
  };
}

/** The RFC's material, with any field overridable for the negative cases. */
async function rfcMaterial(overrides: Partial<EncryptionMaterial> = {}): Promise<EncryptionMaterial> {
  const asPublicRaw = b64urlDecode(AS_PUBLIC);
  return {
    uaPublicRaw: b64urlDecode(UA_PUBLIC),
    authSecret: b64urlDecode(AUTH_SECRET),
    asPublicRaw,
    asPrivateKey: await importPrivate(AS_PRIVATE, asPublicRaw, "ECDH"),
    salt: b64urlDecode(SALT),
    plaintext: PLAINTEXT,
    ...overrides,
  };
}

// A subscription in the shape the WebPushSubscription rows hold it: the two
// keys as the browser's PushSubscription.getKey() base64url, plus an endpoint.
const subscription: PushSubscriptionKeys = {
  endpoint: "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABm",
  p256dh: UA_PUBLIC,
  auth: AUTH_SECRET,
};

async function uaPrivateKey(): Promise<CryptoKey> {
  return importPrivate(UA_PRIVATE, b64urlDecode(UA_PUBLIC), "ECDH");
}

// ===================== the vector =====================

describe("encryptWithMaterial -- RFC 8291 §5", () => {
  it("reproduces the RFC's published message body byte for byte", async () => {
    // The whole reason encryptPayload() is split in two. Anything less than
    // an exact byte match here means a message that every push service
    // accepts with a 201 and every browser throws away without a word.
    expect(b64urlEncode(await encryptWithMaterial(await rfcMaterial()))).toBe(EXPECTED_BODY);
  });

  it("agrees with the RFC's own ecdh_secret from both sides of the exchange", async () => {
    // Not a test of the module -- a test of THIS FILE's fixtures. UA_PRIVATE
    // appears nowhere in the repo outside this suite, so if it were mistyped
    // every round-trip below would fail for a reason that has nothing to do
    // with webPushCrypto.ts. Checking it against §5's published ecdh_secret,
    // derived independently from each keypair, localises that.
    const uaPub = b64urlDecode(UA_PUBLIC);
    const asPub = b64urlDecode(AS_PUBLIC);
    const fromReceiver = await ecdh(await importPrivate(UA_PRIVATE, uaPub, "ECDH"), await importPublic(asPub));
    const fromSender = await ecdh(await importPrivate(AS_PRIVATE, asPub, "ECDH"), await importPublic(uaPub));
    expect(b64urlEncode(new Uint8Array(fromReceiver))).toBe(ECDH_SECRET);
    expect(b64urlEncode(new Uint8Array(fromSender))).toBe(ECDH_SECRET);
  });

  it("produces a body the RFC's receiver key can actually open", async () => {
    // The vector proves the bytes; this proves they mean something. A
    // decryptor that shares no code with the module recovers the plaintext,
    // so a matched pair of errors (say, both sides swapping the two public
    // keys in keyInfo) would still have to survive the byte comparison above.
    const opened = await receive(
      await encryptWithMaterial(await rfcMaterial()),
      await uaPrivateKey(),
      b64urlDecode(UA_PUBLIC),
      b64urlDecode(AUTH_SECRET),
    );
    expect(opened.text).toBe(PLAINTEXT);
  });

  it("is a pure function of its material -- the same inputs give the same bytes twice", async () => {
    // What makes the vector runnable at all. If any randomness leaked back
    // into encryptWithMaterial() (a salt generated here rather than passed
    // in, say) the RFC comparison would fail intermittently rather than
    // never, which is far worse than failing outright.
    const first = await encryptWithMaterial(await rfcMaterial());
    const second = await encryptWithMaterial(await rfcMaterial());
    expect(b64urlEncode(first)).toBe(b64urlEncode(second));
  });
});

// ===================== the RFC 8188 header =====================

describe("encryptWithMaterial -- the RFC 8188 §2.1 header", () => {
  it("puts the record salt in the first 16 bytes, verbatim", async () => {
    // The browser derives the CEK from the salt it reads HERE. A header
    // carrying a different salt from the one the HKDF used produces a
    // message that decrypts to garbage and fails its GCM tag.
    const salt = new Uint8Array(16).fill(0xab);
    const body = await encryptWithMaterial(await rfcMaterial({ salt }));
    expect(body.slice(0, 16)).toEqual(salt);
  });

  it("writes rs=4096 BIG-endian, which is 00 00 10 00 and not 00 10 00 00", async () => {
    // setUint32(..., false) is the whole of this. Little-endian would put
    // 0x1000 in the wrong pair of bytes and declare a record size of
    // 4,096 * 65,536; browsers reject the header outright.
    const body = await encryptWithMaterial(await rfcMaterial());
    expect(Array.from(body.slice(16, 20))).toEqual([0x00, 0x00, 0x10, 0x00]);
    expect(parseBody(body).recordSize).toBe(4096);
  });

  it("sets idlen from the key's own length rather than a hardcoded 65", async () => {
    // Not a realistic input -- an exported P-256 point is always 65 bytes.
    // It is here because `header[20] = 65` would pass every other test in
    // this file, and idlen is what tells the browser where the ciphertext
    // starts: one byte wrong and it ECDHs against a truncated point.
    const body = await encryptWithMaterial(await rfcMaterial({ asPublicRaw: new Uint8Array(33).fill(0x02) }));
    expect(body[20]).toBe(33);
    expect(body.slice(21, 54)).toEqual(new Uint8Array(33).fill(0x02));
  });

  it("carries the sender's ephemeral public key as the key id", async () => {
    const body = await encryptWithMaterial(await rfcMaterial());
    expect(body[20]).toBe(65);
    expect(b64urlEncode(parseBody(body).keyId)).toBe(AS_PUBLIC);
  });

  it("is exactly 21 bytes before the key id", async () => {
    // 16 + 4 + 1. Stated as a length arithmetic check so an extra or missing
    // field shifts everything and is caught here rather than at a browser.
    const body = await encryptWithMaterial(await rfcMaterial());
    expect(body.length).toBe(21 + 65 + utf8(PLAINTEXT).length + 1 + 16);
    // The RFC's own total, for the same sum arrived at from the other end.
    expect(body.length).toBe(144);
  });

  it("measures the payload in UTF-8 bytes, not UTF-16 code units", async () => {
    // "café 🍉" is 7 JS string units and 10 UTF-8 bytes. A `plaintext.length`
    // anywhere in the length arithmetic would go unnoticed until the first
    // food bank with an accent in its name -- of which there are several.
    expect("café 🍉".length).toBe(7);
    expect(utf8("café 🍉").length).toBe(10);
    const body = await encryptWithMaterial(await rfcMaterial({ plaintext: "café 🍉" }));
    expect(body.length).toBe(21 + 65 + 10 + 1 + 16);
    // ...and it survives the trip, so the mismatch is not merely arithmetic.
    const opened = await receive(body, await uaPrivateKey(), b64urlDecode(UA_PUBLIC), b64urlDecode(AUTH_SECRET));
    expect(opened.text).toBe("café 🍉");
  });

  it("appends 0x02, the LAST-record delimiter, not 0x01", async () => {
    // RFC 8188 §2: 0x01 means "another record follows". A browser given 0x01
    // on the only record waits for a continuation that never comes and drops
    // the message. Read back through the decryptor because the delimiter is
    // inside the ciphertext -- it cannot be checked any other way.
    const opened = await receive(
      await encryptWithMaterial(await rfcMaterial()),
      await uaPrivateKey(),
      b64urlDecode(UA_PUBLIC),
      b64urlDecode(AUTH_SECRET),
    );
    expect(opened.delimiter).toBe(0x02);
  });
});

// ===================== the key schedule =====================

describe("encryptWithMaterial -- every input actually reaches the key schedule", () => {
  // Each of these changes ONE field and asserts the ciphertext moves. A field
  // that is accepted and then ignored is the failure this class of test
  // exists for: it produces a perfectly well-formed message encrypted under
  // the wrong key, which is indistinguishable from success at every layer
  // above except the browser's.
  const ciphertextOf = async (overrides: Partial<EncryptionMaterial>) =>
    b64urlEncode(parseBody(await encryptWithMaterial(await rfcMaterial(overrides))).ciphertext);

  it("re-derives the CEK from the salt -- it is not merely copied into the header", async () => {
    // The salt feeds two HKDF expansions (CEK and nonce) as well as the
    // header. If it only reached the header, every message to a subscriber
    // would share a key and nonce, which is a catastrophic AES-GCM misuse
    // on top of being wrong.
    expect(await ciphertextOf({ salt: new Uint8Array(16).fill(0x11) })).not.toBe(
      await ciphertextOf({ salt: new Uint8Array(16).fill(0x22) }),
    );
  });

  it("mixes the subscription's auth secret in", async () => {
    // RFC 8291 §3.3. The auth secret is the shared value the push service
    // never sees; dropping it from the derivation would leave messages that
    // anyone able to substitute a public key could read.
    const other = b64urlDecode(AUTH_SECRET).slice();
    other[0] = (other[0] as number) ^ 0xff;
    expect(await ciphertextOf({ authSecret: other })).not.toBe(await ciphertextOf({}));
  });

  it("binds the sender's public key into keyInfo, not just into the header", async () => {
    // The second half of `WebPush: info\0 || ua_public || as_public`. With
    // as_public omitted from the info string the message still encrypts and
    // still carries the right key id, and the browser -- which does include
    // it -- derives a different key and discards the message.
    const decoy = b64urlDecode(AS_PUBLIC).slice();
    decoy[64] = (decoy[64] as number) ^ 0x01;
    expect(await ciphertextOf({ asPublicRaw: decoy })).not.toBe(await ciphertextOf({}));
  });

  it("binds the subscriber's public key into keyInfo as well as ECDHing against it", async () => {
    // Changing uaPublicRaw changes both the ECDH peer and the info string;
    // the point of the assertion is that a subscription's identity cannot
    // be swapped without the ciphertext changing.
    const different = await crypto.subtle.generateKey(ECDH_P256, true, ["deriveBits"]);
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", (different as CryptoKeyPair).publicKey)) as ArrayBuffer,
    );
    expect(await ciphertextOf({ uaPublicRaw: raw })).not.toBe(await ciphertextOf({}));
  });

  it("encrypts the plaintext rather than a fixed record", async () => {
    expect(await ciphertextOf({ plaintext: "one" })).not.toBe(await ciphertextOf({ plaintext: "two" }));
  });

  it("rejects a uaPublicRaw that is not a point on P-256", async () => {
    // encryptWithMaterial() does no validation of its own -- unlike
    // encryptPayload(), which checks the length. 65 bytes of 0x04-prefixed
    // nonsense is not on the curve, and WebCrypto's importKey is what
    // refuses it. Pinned so a future "helpful" try/catch that swallows this
    // and returns a message encrypted under nothing is caught.
    const notOnCurve = new Uint8Array(65).fill(0x07);
    notOnCurve[0] = 0x04;
    await expect(encryptWithMaterial(await rfcMaterial({ uaPublicRaw: notOnCurve }))).rejects.toThrow();
  });
});

// ===================== the payload-size divergence =====================

describe("encryptWithMaterial -- record size (a documented divergence from pywebpush)", () => {
  it("emits ONE record whatever the payload size, even past the 4096 it declares", async () => {
    // SUSPECT, pinned as-is. http_ece (which pywebpush calls, and which is
    // installed in the Django venv at ../foodcharity) splits content into
    // records of rs - 17 = 4079 bytes; measured there, a 5,000-byte payload
    // comes out as 5,034 bytes of ciphertext in two records, while 4,079
    // comes out as exactly one 4,096-byte record. This module always writes
    // a single record and always declares rs = 4096, so any payload over
    // 4,079 bytes produces a record LONGER than the record size in its own
    // header, which RFC 8188 §2 forbids and browsers reject.
    //
    // Harmless today: the payload is JSON with a body capped at 200
    // characters by buildWebPushPayload(), so real messages are ~300 bytes.
    // It is a cliff, not a live bug, and the test says where the edge is.
    const big = "x".repeat(5000);
    const body = await encryptWithMaterial(await rfcMaterial({ plaintext: big }));
    expect(parseBody(body).recordSize).toBe(4096);
    expect(parseBody(body).ciphertext.length).toBe(5000 + 1 + 16);
    // Still self-consistent, and still decryptable by a receiver that
    // ignores rs -- which is why nothing here throws.
    const opened = await receive(body, await uaPrivateKey(), b64urlDecode(UA_PUBLIC), b64urlDecode(AUTH_SECRET));
    expect(opened.text).toBe(big);
  });

  it("encrypts an empty payload rather than refusing it", async () => {
    // The padding delimiter alone. Not something the caller sends today, but
    // an off-by-one in the padding would show up here first.
    const body = await encryptWithMaterial(await rfcMaterial({ plaintext: "" }));
    expect(body.length).toBe(21 + 65 + 0 + 1 + 16);
    const opened = await receive(body, await uaPrivateKey(), b64urlDecode(UA_PUBLIC), b64urlDecode(AUTH_SECRET));
    expect(opened.text).toBe("");
    expect(opened.delimiter).toBe(0x02);
  });
});

// ===================== encryptPayload =====================

describe("encryptPayload", () => {
  it("produces a message the subscriber's browser can decrypt", async () => {
    // The end-to-end case the RFC vector cannot reach, because the vector
    // fixes the two things this function alone generates. Everything is read
    // back out of the message: the salt from the header, the ephemeral key
    // from the key id. If the exported public key did not match the private
    // key used for the ECDH -- the obvious way to break this while keeping
    // every length assertion green -- the GCM tag fails here.
    const payload = JSON.stringify({ head: "Trussell Trust needs 4 items", body: "Beans, Rice", tag: "need-abc" });
    const body = await encryptPayload(subscription, payload);
    const opened = await receive(body, await uaPrivateKey(), b64urlDecode(UA_PUBLIC), b64urlDecode(AUTH_SECRET));
    expect(opened.text).toBe(payload);
    expect(opened.delimiter).toBe(0x02);
    expect(opened.parsed.recordSize).toBe(4096);
    expect(opened.parsed.keyIdLength).toBe(65);
  });

  it("uses a fresh ephemeral keypair and a fresh salt for every message", async () => {
    // RFC 8291 §2.1 requires it, and reusing either would let anyone who saw
    // two messages to the same subscriber link them. Both are asserted
    // together because a cached module-level keypair and a cached salt are
    // the same mistake and would be made at the same time.
    const first = parseBody(await encryptPayload(subscription, "hello"));
    const second = parseBody(await encryptPayload(subscription, "hello"));
    expect(b64urlEncode(first.keyId)).not.toBe(b64urlEncode(second.keyId));
    expect(b64urlEncode(first.salt)).not.toBe(b64urlEncode(second.salt));
    // ...and the same plaintext therefore does not produce the same body,
    // which is the observable consequence a push service would otherwise see.
    expect(b64urlEncode(first.ciphertext)).not.toBe(b64urlEncode(second.ciphertext));
  });

  it("generates a 16-byte salt and a real uncompressed point, both filled", async () => {
    // A `new Uint8Array(16)` whose getRandomValues() call was dropped is
    // sixteen zero bytes and encrypts perfectly happily.
    const parsed = parseBody(await encryptPayload(subscription, "hello"));
    expect(parsed.salt.every((b) => b === 0)).toBe(false);
    expect(parsed.keyId.length).toBe(65);
    expect(parsed.keyId[0]).toBe(0x04);
  });

  it("fills all SIXTEEN salt bytes, not just the leading few", async () => {
    // MUTANTS THIS KILLS: `const salt = new Uint8Array(12)` (also 8, also
    // 15), and `crypto.getRandomValues(salt.subarray(0, 8))`. Every one of
    // those survived the entire rest of this file, including the round trip
    // through the independent decryptor, and the reason is worth stating:
    //
    // HKDF-extract is HMAC keyed by the salt, and HMAC ZERO-PADS a key
    // shorter than its 64-byte block. So a 12-byte salt and the sixteen
    // bytes the header ends up carrying -- those twelve plus four zeros left
    // over from `new Uint8Array(21)` -- hash to the SAME PRK. The message
    // decrypts, the GCM tag verifies, the browser is happy. All that is lost
    // is 32 bits of salt entropy, silently, against an RFC 8188 §2.1 field
    // fixed at 16 octets.
    //
    // parseBody() cannot see it either -- it slices bytes 0..16 whatever is
    // there, so the `salt.length === 16` this test used to assert was true
    // by construction and proved nothing. The only evidence that reaches the
    // defect is that every one of the sixteen positions actually varies
    // between messages.
    const salts = await Promise.all(
      Array.from({ length: 8 }, async () => parseBody(await encryptPayload(subscription, "hello")).salt),
    );
    for (let i = 0; i < 16; i++) {
      // Eight draws of a uniform byte all landing on the same value is a
      // 256^-7 event, so this is not a flaky assertion; a byte that never
      // moves is a byte nothing ever wrote to.
      const distinct = new Set(salts.map((s) => s[i] as number));
      expect(distinct.size, `salt byte ${i} was identical across 8 messages`).toBeGreaterThan(1);
    }
    // The other half of the same claim, from the opposite direction: sixteen
    // salt bytes means rs starts at byte 16 and idlen at byte 20, so a salt
    // that GREW rather than shrank shifts the fields it overwrites and is
    // caught here rather than at a browser.
    const body = await encryptPayload(subscription, "hello");
    expect(Array.from(body.slice(16, 21))).toEqual([0x00, 0x00, 0x10, 0x00, 65]);
  });

  it("accepts standard base64 with padding as well as the browsers' base64url", async () => {
    // gfwfbn/views.py:35-47's fix_base64_padding covers the same ground on
    // the subscribe side, so rows written before it existed may hold either
    // spelling. Both must reach the same key or those subscribers silently
    // stop receiving anything.
    const standard: PushSubscriptionKeys = {
      endpoint: subscription.endpoint,
      p256dh: UA_PUBLIC.replace(/-/g, "+").replace(/_/g, "/") + "=",
      auth: `${AUTH_SECRET.replace(/-/g, "+").replace(/_/g, "/")}==`,
    };
    // Sanity: the fixture really is a different string from the base64url one.
    expect(standard.p256dh).not.toBe(UA_PUBLIC);
    expect(standard.p256dh).toContain("/");
    const opened = await receive(
      await encryptPayload(standard, "padded"),
      await uaPrivateKey(),
      b64urlDecode(UA_PUBLIC),
      b64urlDecode(AUTH_SECRET),
    );
    expect(opened.text).toBe("padded");
  });

  it("rejects a p256dh of the wrong length, naming the length it got", async () => {
    // sendOne() (needWebPush.ts:129-141) catches this, logs the subscription
    // id and moves on WITHOUT deleting the row -- so the message text is the
    // only diagnostic anyone gets for a corrupt subscription. It has to say
    // what was actually stored.
    const truncated = b64urlEncode(b64urlDecode(UA_PUBLIC).subarray(0, 64));
    await expect(encryptPayload({ ...subscription, p256dh: truncated }, "x")).rejects.toThrow(
      "p256dh is not a 65-byte uncompressed point (got 64 bytes)",
    );
  });

  it("rejects a 65-byte key that is not an uncompressed point", async () => {
    // The 0x04 prefix check. A compressed point (0x02/0x03) padded to 65
    // bytes would otherwise reach WebCrypto and fail with an opaque
    // DOMException instead of naming the field.
    const wrongPrefix = b64urlDecode(UA_PUBLIC).slice();
    wrongPrefix[0] = 0x03;
    await expect(encryptPayload({ ...subscription, p256dh: b64urlEncode(wrongPrefix) }, "x")).rejects.toThrow(
      "p256dh is not a 65-byte uncompressed point (got 65 bytes)",
    );
  });

  it("does NOT validate the auth secret's length", async () => {
    // Pinned, not endorsed. RFC 8291 §3.2 fixes auth at 16 bytes and every
    // browser sends exactly that, but a truncated `auth` column sails
    // through here and produces a message no browser can open -- the silent
    // failure this whole file is about, with the one guard that would catch
    // it sitting right next to the p256dh check that does.
    const body = await encryptPayload({ ...subscription, auth: b64urlEncode(new Uint8Array(4)) }, "x");
    expect(body.length).toBe(21 + 65 + 1 + 1 + 16);
    // And it is genuinely undecryptable by the real subscriber, which is the
    // point: nothing throws, nothing logs, the push service returns 201.
    await expect(
      receive(body, await uaPrivateKey(), b64urlDecode(UA_PUBLIC), b64urlDecode(AUTH_SECRET)),
    ).rejects.toThrow();
  });

  it("passes the whole payload through, however long -- it caps nothing", async () => {
    // MUTANT THIS KILLS: `plaintext: plaintext.slice(0, 200)` in the call to
    // encryptWithMaterial(), and the 300- and 1000-character variants of the
    // same idea. Every other encryptPayload test here sends a string shorter
    // than any of those caps, so all three survived.
    //
    // It is a plausible edit precisely because a 200 DOES exist next door:
    // payload.ts's WEBPUSH_BODY_CHARS caps the notification BODY at 200
    // characters, mirroring `max_body_chars = 200` at
    // givefood/utils/notifications.py:319 (payload.ts's own comment says
    // 317; the line has moved). Applying that cap a second time, here, would
    // truncate the JSON ENVELOPE rather than the body -- producing a payload
    // the service worker cannot JSON.parse, dropped without a word on the
    // subscriber's machine.
    const long = JSON.stringify({
      head: "Trussell Trust needs 41 items",
      body: "Beans, Rice, Pasta, Tinned Tomatoes, Tinned Fish, Coffee, Tea Bags, Long Life Milk, ".repeat(15),
      url: "/needs/at/some-very-long-food-bank-slug/",
      tag: "need-abcdef",
    });
    // Comfortably past 200, 300 AND 1000, so every round-number cap someone
    // might reach for is on the wrong side of this fixture.
    expect(long.length).toBeGreaterThan(1200);
    const body = await encryptPayload(subscription, long);
    const opened = await receive(body, await uaPrivateKey(), b64urlDecode(UA_PUBLIC), b64urlDecode(AUTH_SECRET));
    expect(opened.text).toBe(long);
    // Asserted on the byte count too, so a truncation that happened to leave
    // parseable JSON behind is still visible.
    expect(body.length).toBe(21 + 65 + utf8(long).length + 1 + 16);
    expect(JSON.parse(opened.text)).toEqual(JSON.parse(long));
  });

  it("never looks at the endpoint", async () => {
    // The endpoint is the VAPID assertion's business (`aud`), not the
    // encryption's. Pinned so that a refactor which starts folding the
    // endpoint into the key schedule -- and thereby breaks every message
    // when a push service changes its host -- is visible.
    const nonsense: PushSubscriptionKeys = { ...subscription, endpoint: "not a url at all" };
    const opened = await receive(
      await encryptPayload(nonsense, "still works"),
      await uaPrivateKey(),
      b64urlDecode(UA_PUBLIC),
      b64urlDecode(AUTH_SECRET),
    );
    expect(opened.text).toBe("still works");
  });
});

// ===================== VAPID =====================

// The VAPID signing key. The RFC 8291 sender keypair is reused for it simply
// because it is a known-good P-256 pair with a published private scalar; the
// two uses are unrelated, and reusing it makes `k=` deterministic so the
// header can be asserted as a literal string.
const VAPID_PUBLIC = AS_PUBLIC;
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bF_long_token?ver=2";
const SUBJECT = "mailto:mail@givefood.org.uk";
// 2026-01-01T00:00:00Z, chosen so the exp arithmetic is checkable by eye.
const NOW_MS = 1_767_225_600_000;

function vapidKey(): Promise<CryptoKey> {
  return importPrivate(AS_PRIVATE, b64urlDecode(AS_PUBLIC), "ECDSA");
}

interface ParsedHeader {
  scheme: string;
  jwt: string;
  k: string;
  jwtHeader: Record<string, unknown>;
  claims: Record<string, unknown>;
  signature: Uint8Array;
  signingInput: string;
}

/**
 * Reads the header the way a push service does: split on the RFC 8292 §3.1
 * parameters, then split the JWT. Deliberately strict about the separators
 * so a change to them shows up as a parse failure rather than a silent pass.
 */
function parseVapidHeader(header: string): ParsedHeader {
  const [scheme, params] = [header.slice(0, header.indexOf(" ")), header.slice(header.indexOf(" ") + 1)];
  const fields = new Map(params.split(",").map((part) => part.trim().split(/=(.*)/s) as [string, string]));
  const jwt = fields.get("t") as string;
  const [h, p, s] = jwt.split(".") as [string, string, string];
  return {
    scheme,
    jwt,
    k: fields.get("k") as string,
    jwtHeader: JSON.parse(new TextDecoder().decode(b64urlDecode(h))) as Record<string, unknown>,
    claims: JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as Record<string, unknown>,
    signature: b64urlDecode(s),
    signingInput: `${h}.${p}`,
  };
}

describe("vapidAuthorizationHeader", () => {
  it("emits the single-header vapid scheme with t and k", async () => {
    // RFC 8292 §3.1. The older Crypto-Key/Authorization split is still
    // accepted by most services, so getting this wrong would work for some
    // subscribers and not others -- the worst possible failure shape.
    const header = await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, ENDPOINT, SUBJECT, NOW_MS);
    const parsed = parseVapidHeader(header);
    expect(parsed.scheme).toBe("vapid");
    expect(header).toBe(`vapid t=${parsed.jwt}, k=${VAPID_PUBLIC}`);
    // The separator is ", " here and "," in the py_vapid 1.9.4 in
    // ../foodcharity/.venv (py_vapid/__init__.py:340, read there:
    // `"Authorization": "{schema} t={t},k={k}".format(`). RFC 7235's
    // auth-param list permits the optional whitespace, so both are legal and
    // every service accepts both; pinned because the difference is real and
    // someone comparing the two implementations will find it.
    expect(header).toContain(", k=");
  });

  it("signs a JOSE ES256 header", async () => {
    const parsed = parseVapidHeader(
      await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, ENDPOINT, SUBJECT, NOW_MS),
    );
    expect(parsed.jwtHeader).toEqual({ alg: "ES256", typ: "JWT" });
  });

  it("addresses the assertion to the push service's ORIGIN, never the full endpoint", async () => {
    // RFC 8292 §2, and the reason it matters here: the endpoint path IS the
    // subscription identifier. Signing it into an `aud` would hand every
    // push service a record of exactly which subscriber was being messaged,
    // and FCM rejects the token outright.
    const parsed = parseVapidHeader(
      await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, ENDPOINT, SUBJECT, NOW_MS),
    );
    expect(parsed.claims["aud"]).toBe("https://fcm.googleapis.com");
    expect(String(parsed.claims["aud"])).not.toContain("APA91bF");
  });

  it("expires the assertion 12 hours out, from the caller's clock and not Date.now()", async () => {
    // pywebpush's default, verified by reading the copy Django imports
    // (../foodcharity/.venv/.../pywebpush/__init__.py:466, "vapid_claims
    // ['exp'] = int(time.time()) + (12 * 60 * 60)"). needWebPush.ts takes
    // Date.now() ONCE per page of subscriptions and passes it in, so every
    // message in a page shares an exp; a Date.now() call in here instead
    // would still pass a loose "roughly now" assertion, which is why nowMs
    // is pinned to a fixed instant.
    const parsed = parseVapidHeader(
      await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, ENDPOINT, SUBJECT, NOW_MS),
    );
    expect(parsed.claims["exp"]).toBe(1_767_225_600 + 43_200);
    expect(parsed.claims["exp"]).toBe(1_767_268_800);
  });

  it("takes nowMs literally, including zero", async () => {
    // The mutation this kills is `Math.floor(Date.now() / 1000)`, which
    // passes anything phrased as "about twelve hours from now".
    const parsed = parseVapidHeader(await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, ENDPOINT, SUBJECT, 0));
    expect(parsed.claims["exp"]).toBe(43_200);
  });

  it("floors sub-second milliseconds rather than rounding or keeping them", async () => {
    // `exp` is NumericDate: a JSON number of SECONDS. A fractional exp is
    // rejected by strict verifiers, and Django's route through
    // int(time.time()) truncates too.
    const parsed = parseVapidHeader(
      await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, ENDPOINT, SUBJECT, NOW_MS + 999),
    );
    expect(parsed.claims["exp"]).toBe(1_767_268_800);
    expect(Number.isInteger(parsed.claims["exp"])).toBe(true);
  });

  it("passes the subject through untouched", async () => {
    // notifications.py:374 builds `mailto:{VAPID_ADMIN_EMAIL}`; RFC 8292 §2.1
    // also permits an https: URL, and nothing here validates which it is.
    const claims = parseVapidHeader(
      await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, ENDPOINT, "https://givefood.org.uk", NOW_MS),
    ).claims;
    expect(claims["sub"]).toBe("https://givefood.org.uk");
  });

  it("really means untouched -- case and surrounding whitespace both survive", async () => {
    // MUTANTS THIS KILLS: `sub: subject.toLowerCase()` and
    // `sub: subject.trim()`, both of which SURVIVED the test above, because
    // every subject fixture in this file is already lowercase and already
    // trimmed. VAPID_ADMIN_EMAIL is a hand-typed credential row, so neither
    // is guaranteed; and `sub` is inside the signature, so normalising it
    // here would put a different string on the wire from the one the
    // operator recorded -- FCM will not tell you which it dislikes, it just
    // 401s the whole batch.
    const messy = "  MailTo:Mail@GiveFood.org.uk  ";
    const parsed = parseVapidHeader(
      await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, ENDPOINT, messy, NOW_MS),
    );
    expect(parsed.claims["sub"]).toBe(messy);
    // Asserted on the signed bytes too, so a claim that is corrected on its
    // way out of the JSON rather than on its way in is caught as well.
    expect(new TextDecoder().decode(b64urlDecode(parsed.jwt.split(".")[1] as string))).toContain(
      '"sub":"  MailTo:Mail@GiveFood.org.uk  "',
    );
  });

  it("sends exactly three claims -- aud, exp, sub, in that order", async () => {
    // Order is asserted because the JWT payload is JSON.stringify of an
    // object literal, so the wire bytes are stable and can be pinned; an
    // extra claim (an `iss`, say, or a nonce) changes what gets signed and
    // is worth having to acknowledge in a test.
    const parsed = parseVapidHeader(
      await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, ENDPOINT, SUBJECT, NOW_MS),
    );
    expect(Object.keys(parsed.claims)).toEqual(["aud", "exp", "sub"]);
    expect(new TextDecoder().decode(b64urlDecode(parsed.jwt.split(".")[1] as string))).toBe(
      '{"aud":"https://fcm.googleapis.com","exp":1767268800,"sub":"mailto:mail@givefood.org.uk"}',
    );
  });

  it("signs with the key whose public half it advertises in k=", async () => {
    // The assertion the push service performs. If the signature did not
    // verify against `k`, FCM returns 401 and needWebPush.ts logs a failure
    // for every subscriber -- noisy, at least, unlike a bad encryption.
    const parsed = parseVapidHeader(
      await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, ENDPOINT, SUBJECT, NOW_MS),
    );
    const publicKey = await crypto.subtle.importKey(
      "raw",
      b64urlDecode(parsed.k) as unknown as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      parsed.signature as unknown as ArrayBuffer,
      utf8(parsed.signingInput) as unknown as ArrayBuffer,
    );
    expect(ok).toBe(true);
  });

  it("emits a raw 64-byte r||s signature, not an ASN.1 DER sequence", async () => {
    // JOSE requires the raw pair. Most server-side libraries have to
    // re-encode OpenSSL's DER; WebCrypto does not, and this pins that nobody
    // "helpfully" adds a conversion. DER for P-256 is 70-72 bytes and starts
    // with 0x30, so the length alone is the check.
    const parsed = parseVapidHeader(
      await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, ENDPOINT, SUBJECT, NOW_MS),
    );
    expect(parsed.signature.length).toBe(64);
  });

  it("re-encodes the public key, so a padded standard-base64 credential still works", async () => {
    // VAPID_PUBLIC_KEY is a Worker secret typed in by hand; it may arrive as
    // standard base64, padded, with a trailing newline from a copy-paste.
    // All three normalise to the same unpadded base64url in `k=`, because a
    // `+` or `=` in an HTTP auth-param is what a 401 looks like.
    const messy = ` ${AS_PUBLIC.replace(/-/g, "+").replace(/_/g, "/")}=\n`;
    // The fixture really is the other alphabet, padded, with whitespace.
    expect(messy).toContain("/");
    expect(messy.trim()).not.toBe(AS_PUBLIC);
    const header = await vapidAuthorizationHeader(await vapidKey(), messy, ENDPOINT, SUBJECT, NOW_MS);
    expect(parseVapidHeader(header).k).toBe(AS_PUBLIC);
    // Nothing outside the base64url alphabet reaches the wire, and no stray
    // newline splits the header in two.
    expect(parseVapidHeader(header).k).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(header).not.toContain("/");
    expect(header).not.toContain("\n");
  });

  it("keeps a non-default port in aud but drops :443, unlike pywebpush", async () => {
    // A DIVERGENCE, pinned deliberately. pywebpush builds aud as
    // f"{url.scheme}://{url.netloc}" (pywebpush/__init__.py:458), and
    // urlparse keeps an explicit :443 -- run in ../foodcharity/.venv on
    // Python 3.12.3, "https://push.example.com:443/w" gives
    // "https://push.example.com:443", where Node 24's URL().origin gives
    // "https://push.example.com". No real push endpoint spells out :443, so
    // this has never mattered; it is recorded so that if one ever does, the
    // 401 has an explanation waiting for it.
    const explicit443 = await vapidAuthorizationHeader(
      await vapidKey(),
      VAPID_PUBLIC,
      "https://push.example.com:443/wpush/v2/abc",
      SUBJECT,
      NOW_MS,
    );
    expect(parseVapidHeader(explicit443).claims["aud"]).toBe("https://push.example.com");

    const nonDefault = await vapidAuthorizationHeader(
      await vapidKey(),
      VAPID_PUBLIC,
      "https://push.example.com:8443/wpush/v2/abc",
      SUBJECT,
      NOW_MS,
    );
    expect(parseVapidHeader(nonDefault).claims["aud"]).toBe("https://push.example.com:8443");
  });

  it("computes aud for the real Mozilla and Apple endpoint shapes", async () => {
    // The two other push services subscribers actually use. Worth naming
    // explicitly: an `aud` derived by, say, splitting on the third slash
    // would still pass the FCM case above.
    for (const [endpoint, aud] of [
      ["https://updates.push.services.mozilla.com/wpush/v2/gAAAAABm-long", "https://updates.push.services.mozilla.com"],
      ["https://web.push.apple.com/QK1lz5ZQ8Rr", "https://web.push.apple.com"],
    ] as const) {
      const parsed = parseVapidHeader(
        await vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, endpoint, SUBJECT, NOW_MS),
      );
      expect(parsed.claims["aud"]).toBe(aud);
    }
  });

  it("throws on an endpoint that is not a URL", async () => {
    // needWebPush.ts:131-141 catches this alongside the encryption errors and
    // skips the subscription without deleting it -- correct, because a
    // malformed endpoint column is corruption on our side, not a revoked
    // subscription. Pinned so it stays a throw rather than becoming a header
    // with an empty aud that every service rejects with a bare 401.
    await expect(
      vapidAuthorizationHeader(await vapidKey(), VAPID_PUBLIC, "fcm.googleapis.com/fcm/send/x", SUBJECT, NOW_MS),
    ).rejects.toThrow();
  });
});
