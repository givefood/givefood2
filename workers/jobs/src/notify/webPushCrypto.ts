import { base64UrlDecode, base64UrlEncode, signJwtEs256, utf8 } from "./jwt";

// RFC 8291 (Message Encryption for Web Push) and RFC 8292 (VAPID), which
// pywebpush does for Django and which nothing does for us.
//
// This is the reason web push was the channel deferred longest: unlike
// Firebase and WhatsApp, which are "POST some JSON with a bearer token",
// a web push message is END-TO-END ENCRYPTED to a key the browser
// generated. The push service (Mozilla, Google, Apple, Microsoft) relays
// an opaque blob it cannot read. Every step below is required for the
// browser to be able to decrypt it at all -- there is no unencrypted mode
// for a payload-carrying push.
//
// Content-Encoding is aes128gcm (RFC 8188), the modern one and
// pywebpush's own default. The older aesgcm/aes128gcmwithdh encodings
// carried the salt and key in headers instead of the body; they are not
// implemented, because pywebpush is not asked for them either.
//
// WebCrypto has every primitive this needs: ECDH over P-256 for the
// shared secret, HMAC-SHA-256 for HKDF, AES-GCM for the payload. No
// third-party crypto, and no hand-written field arithmetic.

const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

async function hmac(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data as unknown as ArrayBuffer));
}

// HKDF with a single output block, which is all RFC 8291 ever needs (the
// longest output is 32 bytes). Written out rather than using WebCrypto's
// deriveBits("HKDF") because the extract step's salt and the expand step's
// info are supplied separately at four different points below, and the
// one-block form makes each of those readable line by line.
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.subarray(0, length);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// RFC 8291 §3.4, and RFC 8188 §2.1 for the framing.
//
// SPLIT IN TWO on purpose. Everything random -- the ephemeral keypair and
// the salt -- is generated here and nowhere else; encryptWithMaterial()
// below is a pure function of its inputs. That is what makes RFC 8291 §5's
// published test vector runnable against this exact code rather than
// against a re-implementation of it: tools/webpush-vector/ feeds the RFC's
// fixed keys and salt straight into encryptWithMaterial() and compares the
// bytes. A round-trip test would only prove this file agrees with itself;
// the vector proves it agrees with the browsers.
export async function encryptPayload(subscription: PushSubscriptionKeys, plaintext: string): Promise<Uint8Array> {
  const uaPublicRaw = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);
  if (uaPublicRaw.length !== 65 || uaPublicRaw[0] !== 0x04) {
    throw new Error(`p256dh is not a 65-byte uncompressed point (got ${uaPublicRaw.length} bytes)`);
  }

  // An ephemeral keypair PER MESSAGE. Reusing one across sends would let
  // anyone who saw two messages to the same subscriber link them, and
  // RFC 8291 §2.1 requires a fresh one regardless.
  const ephemeral = (await crypto.subtle.generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer);

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  return encryptWithMaterial({
    uaPublicRaw,
    authSecret,
    asPublicRaw,
    asPrivateKey: ephemeral.privateKey,
    salt,
    plaintext,
  });
}

export interface EncryptionMaterial {
  /** The subscription's p256dh, decoded: 65-byte uncompressed P-256 point. */
  uaPublicRaw: Uint8Array;
  /** The subscription's auth, decoded: 16 bytes. */
  authSecret: Uint8Array;
  /** This message's ephemeral public key, raw. */
  asPublicRaw: Uint8Array;
  /** This message's ephemeral private key, as a deriveBits-capable CryptoKey. */
  asPrivateKey: CryptoKey;
  /** This message's 16-byte record salt. */
  salt: Uint8Array;
  plaintext: string;
}

export async function encryptWithMaterial(material: EncryptionMaterial): Promise<Uint8Array> {
  const { uaPublicRaw, authSecret, asPublicRaw, asPrivateKey, salt, plaintext } = material;

  const uaPublicKey = await crypto.subtle.importKey("raw", uaPublicRaw as unknown as ArrayBuffer, P256, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // The RUNTIME property is `public`; @cloudflare/workers-types spells
      // it `$public` because `public` is a TypeScript modifier keyword and
      // their generator escapes it. Writing `$public` here would typecheck
      // and then derive nothing at all, so the literal is written correctly
      // and the type is asserted over.
      { name: "ECDH", public: uaPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      asPrivateKey,
      256,
    ),
  );

  // RFC 8291 §3.3: the auth secret salts a first HKDF whose info binds the
  // two public keys together. This is what stops a push service that
  // substitutes its own key from producing a decryptable message -- the
  // UA's key is inside the derivation, not merely used for it.
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // RFC 8188 §2.2/§2.3. The trailing 0x00 is part of the info string, not
  // a separator: both labels are NUL-terminated.
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  // RFC 8188 §2: each record ends with a padding delimiter -- 0x02 for the
  // last record, 0x01 otherwise. One record here, so always 0x02. Omitting
  // it makes the browser reject the message with no useful error.
  const padded = concat(utf8(plaintext), new Uint8Array([2]));

  const aesKey = await crypto.subtle.importKey("raw", cek as unknown as ArrayBuffer, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as unknown as ArrayBuffer, tagLength: 128 },
      aesKey,
      padded as unknown as ArrayBuffer,
    ),
  );

  // RFC 8188 §2.1 header: salt(16) || rs(4, big-endian) || idlen(1) || keyid.
  // `rs` is the record size; 4096 is what every implementation uses and is
  // comfortably above any payload this sends. `keyid` is the sender's
  // ephemeral public key, which is how the browser knows what to ECDH
  // against.
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = asPublicRaw.length;

  return concat(header, asPublicRaw, ciphertext);
}

// RFC 8292 §2: a JWT addressed to the push service's ORIGIN (not the full
// endpoint -- including the path would leak which subscription is being
// pushed to, and services reject it), plus the raw public key so the
// service can verify the signature against the key the browser recorded
// at subscribe time.
//
// pywebpush fills `aud` and `exp` itself when the caller supplies only
// `sub`, which is exactly what Django does (notifications.py:377) -- so
// those two defaults are pywebpush's, reproduced here: the endpoint's
// origin, and 12 hours.
const VAPID_TTL_SECONDS = 12 * 60 * 60;

export async function vapidAuthorizationHeader(
  privateKey: CryptoKey,
  publicKeyBase64Url: string,
  endpoint: string,
  subject: string,
  nowMs: number,
): Promise<string> {
  const jwt = await signJwtEs256(privateKey, {
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + VAPID_TTL_SECONDS,
    sub: subject,
  });
  // The single-header "vapid" scheme (RFC 8292 §3.1). The older
  // Crypto-Key/Authorization split it replaced is still accepted by most
  // services but is not what a current pywebpush sends either.
  const k = base64UrlEncode(base64UrlDecode(publicKeyBase64Url.trim()));
  return `vapid t=${jwt}, k=${k}`;
}
