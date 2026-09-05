// base64url and the two JWT signatures the notification channels need.
//
// Django gets both for free from libraries that do not exist on Workers:
// firebase-admin builds and signs the RS256 service-account assertion, and
// py_vapid builds and signs the ES256 VAPID assertion. Neither library
// runs here -- both are C-extension-backed Python -- so the two JWTs are
// built directly against WebCrypto, which supports exactly the primitives
// they need (RSASSA-PKCS1-v1_5/SHA-256 and ECDSA/P-256/SHA-256).
//
// This file is deliberately only the signing. What goes IN the claims is
// each channel's business, and lives with that channel.

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  // Chunked: String.fromCharCode(...arr) on a large array blows the
  // argument limit. Push payloads are small, service-account keys are not.
  for (let i = 0; i < arr.length; i += 0x8000) {
    binary += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Accepts standard base64 AND base64url, padded or not -- browsers send
// web push keys unpadded base64url (gfwfbn/views.py:35-47's
// fix_base64_padding covers the same ground on the subscribe side), while
// a VAPID key pasted from a config file may be either.
export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(utf8(JSON.stringify(value)));
}

// A PEM block's base64 body, header/footer and all whitespace removed.
// Both key formats this file imports arrive as PEM: the service account
// JSON's `private_key` always, and VAPID_PRIVATE_KEY when it was generated
// by `vapid --gen` rather than stored as a raw scalar.
export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  return base64UrlDecode(body);
}

// ===================== RS256 (Google service account) =====================

// The `private_key` field of a Google service-account JSON is PKCS#8 PEM.
export async function importRs256Key(privateKeyPem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem) as unknown as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signJwtRs256(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const signingInput = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(signingInput) as unknown as ArrayBuffer);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

// ===================== ES256 (VAPID) =====================

// VAPID_PRIVATE_KEY's format is not fixed by any spec, and Django never
// looks at it -- it hands the string straight to pywebpush, whose
// py_vapid.Vapid.from_string() accepts BOTH of the shapes below. Which one
// production actually holds cannot be read from outside a Worker secret,
// so both are supported rather than guessed at:
//
//   1. PKCS#8 PEM  -- what `vapid --gen` writes to private_key.pem.
//   2. A raw 32-byte P-256 private scalar, base64url -- what the
//      applicationServerKey-style tooling emits, and what py_vapid's
//      `from_raw()` path takes.
//
// Shape 2 has no public half in it, and WebCrypto cannot derive one (it
// exposes no EC point multiplication). VAPID_PUBLIC_KEY is what supplies
// it: Django reads that credential too (notifications.py:293) even though
// it never passes it to pywebpush, so it is known to be set, and RFC 8292
// needs it for the `k=` parameter regardless.
export async function importVapidKey(privateKey: string, publicKey: string): Promise<CryptoKey> {
  if (privateKey.includes("-----BEGIN")) {
    return crypto.subtle.importKey(
      "pkcs8",
      pemToDer(privateKey) as unknown as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  }

  const d = base64UrlDecode(privateKey.trim());
  if (d.length !== 32) {
    throw new Error(`VAPID_PRIVATE_KEY is neither PEM nor a 32-byte raw scalar (decoded to ${d.length} bytes)`);
  }
  const pub = base64UrlDecode(publicKey.trim());
  // Uncompressed point: 0x04 || X(32) || Y(32). A compressed point (33
  // bytes, 0x02/0x03) cannot be expanded without curve arithmetic, so it
  // is rejected loudly rather than producing a key that signs garbage.
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error(`VAPID_PUBLIC_KEY is not a 65-byte uncompressed P-256 point (got ${pub.length} bytes)`);
  }
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: base64UrlEncode(d),
      x: base64UrlEncode(pub.subarray(1, 33)),
      y: base64UrlEncode(pub.subarray(33, 65)),
      ext: false,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

// WebCrypto's ECDSA output is already the raw r||s pair JOSE wants (64
// bytes for P-256), not the ASN.1 DER sequence OpenSSL produces -- no
// re-encoding needed, unlike the equivalent in most server-side libraries.
export async function signJwtEs256(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const signingInput = `${encodeJson({ alg: "ES256", typ: "JWT" })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(signingInput) as unknown as ArrayBuffer,
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}
