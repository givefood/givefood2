// RFC 8291 §5's published test vector, run against the REAL encryption
// code in workers/jobs/src/notify/webPushCrypto.ts.
//
//   pnpm run verify:webpush
//
// WHY THIS EXISTS. Django sends web push through pywebpush, a library with
// its own test suite and a decade of production use. This port has no such
// library available -- Workers cannot run it -- so the RFC 8291 message
// encryption is written out by hand in webPushCrypto.ts. Hand-rolled
// crypto that is subtly wrong does not throw: it produces a well-formed
// message that every browser silently discards, and the push service
// returns 201 Created either way. There is no error to notice, and the
// only symptom is subscribers quietly never hearing anything again.
//
// So the code is checked against the bytes in the RFC itself. A round-trip
// (encrypt then decrypt with the same constants) would prove only that the
// file agrees with itself; this proves it agrees with the specification
// the browsers implement.
//
// It runs on Node's WebCrypto, which is the same API surface the Worker's
// runtime exposes -- the module under test imports nothing from Cloudflare.

import { webcrypto } from "node:crypto";
import { encryptWithMaterial } from "../../workers/jobs/src/notify/webPushCrypto";

// Node exposes WebCrypto as `crypto.webcrypto` rather than a global on
// older releases; webPushCrypto.ts reaches for the global, as Workers has.
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

function b64urlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}
function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ==================== RFC 8291 §5, verbatim ====================
const PLAINTEXT = "When I grow up, I want to be a watermelon";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";
const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";

// The complete encrypted message body, base64url. Line breaks in the RFC's
// presentation removed.
const EXPECTED =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
  "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
  "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

async function main(): Promise<void> {
  // The vector gives the application server's private key as a raw
  // 32-byte scalar. WebCrypto cannot import one without the matching
  // public point, so it is rebuilt as a JWK from both halves -- the same
  // manoeuvre importVapidKey() makes for VAPID_PRIVATE_KEY.
  const asPublicRaw = b64urlDecode(AS_PUBLIC);
  const asPrivateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: AS_PRIVATE,
      x: b64urlEncode(asPublicRaw.subarray(1, 33)),
      y: b64urlEncode(asPublicRaw.subarray(33, 65)),
      ext: false,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );

  const actual = b64urlEncode(
    await encryptWithMaterial({
      uaPublicRaw: b64urlDecode(UA_PUBLIC),
      authSecret: b64urlDecode(AUTH_SECRET),
      asPublicRaw,
      asPrivateKey,
      salt: b64urlDecode(SALT),
      plaintext: PLAINTEXT,
    }),
  );

  if (actual === EXPECTED) {
    console.log("PASS: encryptWithMaterial() reproduces RFC 8291 §5 byte for byte");
    return;
  }
  console.error("FAIL: output does not match RFC 8291 §5");
  console.error(`  expected: ${EXPECTED}`);
  console.error(`  actual:   ${actual}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
