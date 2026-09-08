import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  importRs256Key,
  importVapidKey,
  pemToDer,
  signJwtEs256,
  signJwtRs256,
  utf8,
} from "./jwt";
// The REAL consumer of signJwtEs256, used in the last test rather than a
// copy of it. It imports nothing but ./jwt, so pulling it in costs no
// bindings and no fixtures -- and a reassembled imitation of it would pass
// even if the shipped function were deleted, which is the failure this file
// exists to make impossible.
import { vapidAuthorizationHeader } from "./webPushCrypto";

// The credential layer for two of the four notification channels, and the
// one place in workers/jobs where being wrong is COMPLETELY SILENT.
//
// Neither caller propagates a failure. needFirebase.ts wraps
// importRs256Key/signJwtRs256 in a try/catch that logs and returns null
// (lines 84-87), so a broken assertion is a token exchange that never
// happens and a notification that is never sent -- the queue message is
// still acked. needWebPush.ts does the same with importVapidKey (lines
// 69-77): "a malformed key fails identically for every subscriber and every
// page, so this returns rather than throwing". And a JWT that is merely
// WRONG rather than unbuildable is worse still: Google answers 401 and
// Mozilla answers 403, both of which this code logs and moves on from.
// Nothing here can fail in a way anyone would see, so the tests below assert
// EXACT VALUES -- a pinned JWT string, a pinned DER blob, a signature
// verified against a public key -- rather than round-tripping the module
// against itself. A round trip stays
// green when RS256 silently becomes RS512, when the ECDSA signature starts
// coming out DER-wrapped, or when the base64 stops being URL-safe; every
// one of those breaks the wire format and nothing here would say so.
//
// PROVENANCE OF THE FIXTURES, stated because it is the whole value of the
// known-answer tests:
//
//   * The RSA-2048 and P-256 keys below were generated once with Node's
//     OpenSSL-backed `crypto.generateKeyPairSync` in a scratchpad outside
//     this repo and pasted here. They are throwaway test keys and appear in
//     no deployment.
//   * The exact RS256 JWT pinned in `signJwtRs256` was cross-checked against
//     `crypto.sign("sha256", ..., pkcs8Pem)` from node:crypto -- a different
//     API surface from the `crypto.subtle` path this module takes -- and the
//     two agreed byte for byte. RSASSA-PKCS1-v1_5 is deterministic, which is
//     what makes pinning a whole JWT possible at all; ECDSA is not, so the
//     ES256 tests verify a signature instead of pinning one.
//   * The base64url vectors are RFC 4648 §10's published "foobar" ladder.
//   * The py_vapid claims in the importVapidKey block were checked by RUNNING
//     py-vapid 1.9.4 (with pywebpush 2.4.0 and cryptography 50.0.1) out of
//     the Django repo's own .venv on this machine, on CPython 3.12.3. Where
//     that run contradicted this module's header comment, the test says so.
//   * Every one of those claims was RE-EXECUTED during the adversarial review
//     rather than taken on trust, because a fabricated citation is worse than
//     no citation: node:crypto's `crypto.sign("sha256", ...)` reproduces the
//     pinned RS256 JWT character for character; `createPublicKey(...).export`
//     confirms RSA_PUBLIC_SPKI_B64 is that key's own public half;
//     `Vapid.from_string(VAPID_PRIVATE_KEY_RAW)` derives exactly
//     VAPID_PUBLIC_KEY_B64URL and `Vapid.from_string(<the PEM>)` raises the
//     ValueError quoted below; and the Django base64 matrix further down
//     matches `fix_base64_padding` + `base64.urlsafe_b64decode` row for row.
//
// The Django ancestor has no counterpart to this file at all: firebase-admin
// built and signed the service-account assertion, and pywebpush/py_vapid
// built and signed the VAPID one. So there is no ported behaviour to match
// here -- the external contract is RFC 7515 (JWS), RFC 7518 (RS256/ES256),
// RFC 8292 (VAPID) and Google's own token endpoint. The one place Django IS
// checkable, py_vapid's accepted key shapes, is checked in importVapidKey's
// block below.
//
// MUTATION-TESTED, then mutation-tested again in an adversarial review. Both
// rounds copied jwt.ts into a scratch directory OUTSIDE the repo, broke the
// copy, and re-ran this file against it; no source file was ever edited in
// place. The counts quoted below are from the review round, which applied 90
// mutants and is the run whose numbers can be reproduced from this file as it
// now stands.
//
// Several mutants are caught by exactly ONE test, which is the evidence those
// tests are load-bearing rather than decoration:
//   - a greedy `.+` in pemToDer's label regex -> only the hyphenated-label
//     test noticed;
//   - `extractable: true` on the RSA import -> only the algorithm-parameters
//     test;
//   - dropping the `pub[0] !== 0x04` check, dropping either `.trim()`, and
//     `startsWith` in place of `includes` -> one test each, all in the
//     importVapidKey block.
// The ones caught broadly are worth naming too, because they are the changes
// that look harmless in review: standard-alphabet base64 (10 failures),
// keeping the "=" padding (12), swapping the two alphabet substitutions (18),
// and truncating or DER-wrapping the ECDSA signature (7 each).
//
// The review round found SIX survivors, all now killed, each named in the
// comment of the test that kills it so a future reader knows what that test
// is for:
//   1. deleting `pub.length !== 65 ||` and keeping only the 0x04 prefix check
//      -- every wrong-shape fixture happened to start with a non-0x04 byte,
//      so the length half of the guard was never the thing that fired;
//   2. flipping the raw branch's JWK `ext` and its `extractable` argument
//      TOGETHER, which yields an EXPORTABLE VAPID private key -- flipping
//      either alone throws, so only the pair survived;
//   3. loosening the PEM marker from `-----BEGIN` to `BEGIN` or `-----`,
//      which misroutes a raw scalar containing either substring;
//   4. reordering pemToDer's two replaces so whitespace is stripped first,
//      which silently starts accepting armour with spaces inside the dashes;
//   5. `[^-]*` for `[^-]+` in the same regex, which makes an empty PEM label
//      strippable armour;
//   6. checking VAPID_PUBLIC_KEY before VAPID_PRIVATE_KEY, which changes
//      which secret is named when a fresh environment has neither.
//
// THREE mutants survive and are EQUIVALENT rather than uncaught, recorded so
// nobody wastes an afternoon proving otherwise:
//   - `.replace(/=+$/, "")` widened to `/=+/g` -- btoa never emits "="
//     anywhere but the end;
//   - `ext: false` on the JWK alone -- WebCrypto only rejects `ext: false`
//     when `extractable` is true, so with `extractable: false` the field is
//     unobservable (which is why mutant 2 above had to flip both);
//   - computing base64UrlDecode's padEnd BEFORE the two substitutions --
//     both replacements are length-preserving and neither touches "=".

// ===================== fixtures =====================

// PKCS#8, exactly the shape a Google service-account JSON's `private_key`
// field holds once JSON.parse has turned its "\n" escapes into newlines.
const RSA_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCn9ZxBoMtK/2Zl
Hf5eQzKXLU+15siqtQMnZuLZ/aHMH60B2lgZ9aOqZDvdtRKYecuZUSeBI89vA62Q
PbnbeHoKzWm+cDRdyXxfoQy+IBGPjhDTS74DrH3dhVZahh5hw8jtS7jnljtXzeYa
/oh81pJwdnrPZkU56P7HE1jRj3EHwUQSj41jeIQxLJTa64aHVLCNG3LXiTAUoqXb
My6FOILiVavCs4/A0iBpeiK3YqBc1Zubn6rNx5mBx8+5UNejube8750y35FX2nuw
C1LTGn5p1Kn/7nmnsQeKaAEgmbj4DUpFhaH3RiD+xsgQ3tmO1J/hYUr+PjYGDgIw
kFdQCvwPAgMBAAECggEAJ0kSmGMkydD9QU+HrMKo9aVajKCDdTJLn464JublTlpm
XBWXH9NNydASFKSCyflK/vx1cgZPQZcppKBbdZMzcI1lW27hQMKc/b0svte/Y8WF
9/YyZqeU9Rh3/0p5lsJ1n9NjV3/TN5Fobg31HMYPkJCV3yb7sDToSuYikzmq5XYU
cx3pc9C7QKOYcJNBN799Ek0kPdTG8Xwd07XWVnZoRmr6TihNXl7P6OwSBgUMf/NF
XN5v9HR7SLSw4FQBRq24pzkgrEGp0aaYIugH8xXoJRYgGj9ZctlhUFYwxp7xM5YX
w1gaW3Ziym5saAaUE4GlRTjZ1GIYxvxKZjHO3ekWkQKBgQDohk07yTBwKUwcjng9
UqtSt9TgRdLNGbf6GKgUCBJRnUApI++ToemUfnM4iVwHyd8HyYE3p3U+HxpywJNF
0BgQcuY7mY7nydAdbocwcLsC9r/ILg5CGEJOrAxAtu6sRY9NaF1I9PUlzPyuwiqk
cL7Jy1rXt/fdoqrnYOLLzgpq5wKBgQC46pfqVQWkncxx4gHcSSyvQDztZyja0VCn
p4+pcGT083cPzYh9RSp5leOLVj0ykXbH7HErcKoa5vYVZL5pSJFIFNDz0ihUZPem
j2dlN5sQt7LqIWD3HDgxVUX48llFVgix+N2inWZ4arvwjRA5jvN4e4+5+t+zvOZl
iYyxvVsomQKBgBjzECZyF/hw9fG6d7xcunVNtFG8LDpFoC/9pUtA8nY/YTsI2BQH
M4DzcHmIg49yYbP8Mxk9pp7bx4K4lxTOl0ZsjbenamYEiYge6/KOpgJTZ5CbIHyH
DdZTL51iA4oIjK/JmvjRD9zWeeZmfxzV3CLa5wxuePIXGi9pfexQV13RAoGBAJge
XLSoFslSCrKQwwkNpVXSGY0O9Rv1X01cWaGA1XxwoLx+T08GTCfTd2nTmupzoexb
hMnAmB8jasM0qjOAQAu1HCPH+edbXCNICz3H3aeGBwf2R4dhTpS+2p4t9+RDH0oR
OXqh038yBsOft/4xq/asZxMO32JD/qD+45//7vLZAoGAJypL/6ndr/9PNf53tXZ3
mb7rL/QSuMfu4lBbepEYp07jxC/3r25hgXl6fGhrqzmtfB4eF/l6hFMaQKutsARS
auiYPudX5h42uOn5vCWKE3RwBxPdS65ASdbV9FInczSsU6PkGHg/NhcDf1reKb+z
Otyl4SDs3qoFlbOz9EIqhdU=
-----END PRIVATE KEY-----
`;

// The matching SPKI public key, as raw standard base64 rather than PEM, so
// the verification key is built without going through pemToDer -- otherwise
// a mutated pemToDer would corrupt the fixture and the module under test in
// the same direction and the verification would still pass.
const RSA_PUBLIC_SPKI_B64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAp/WcQaDLSv9mZR3+XkMy" +
  "ly1PtebIqrUDJ2bi2f2hzB+tAdpYGfWjqmQ73bUSmHnLmVEngSPPbwOtkD2523h6" +
  "Cs1pvnA0Xcl8X6EMviARj44Q00u+A6x93YVWWoYeYcPI7Uu455Y7V83mGv6IfNaS" +
  "cHZ6z2ZFOej+xxNY0Y9xB8FEEo+NY3iEMSyU2uuGh1SwjRty14kwFKKl2zMuhTiC" +
  "4lWrwrOPwNIgaXoit2KgXNWbm5+qzceZgcfPuVDXo7m3vO+dMt+RV9p7sAtS0xp+" +
  "adSp/+55p7EHimgBIJm4+A1KRYWh90Yg/sbIEN7ZjtSf4WFK/j42Bg4CMJBXUAr8" +
  "DwIDAQAB";

// P-256 PKCS#8 -- what `vapid --gen` writes to private_key.pem. That claim
// is checked, not assumed: py_vapid 1.9.4's `Vapid.generate_keys()` followed
// by its own PKCS#8 export was run out of the Django repo's .venv on this
// machine and produced a block headed exactly "-----BEGIN PRIVATE KEY-----".
const VAPID_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgjh+Ngnqk8LUE0nLz
Bcz16ktovdFKMzMZn6IbxgNcvZWhRANCAARMTFefjX/6H2cDRKVe4tRcQkarUXfD
f2GE3ZNp48Q0edPjMTm/Ap3HofuwCn/tFRT/Zrbq0fMWAsnAQidWF7a1
-----END PRIVATE KEY-----
`;

// The SAME key in the other shape importVapidKey supports: the bare 32-byte
// private scalar, base64url. py_vapid's from_raw() path, and what
// `Vapid.from_string()` accepts. Verified to be the same keypair as the PEM
// above by running py_vapid 1.9.4's from_string() on this scalar and asking
// it for the derived public point -- it returned VAPID_PUBLIC_KEY_B64URL
// below exactly.
const VAPID_PRIVATE_KEY_RAW = "jh-Ngnqk8LUE0nLzBcz16ktovdFKMzMZn6IbxgNcvZU";

// The 65-byte uncompressed P-256 point, base64url -- what a browser's
// applicationServerKey is and what RFC 8292's `k=` parameter carries.
const VAPID_PUBLIC_KEY_B64URL =
  "BExMV5-Nf_ofZwNEpV7i1FxCRqtRd8N_YYTdk2njxDR50-MxOb8Cnceh-7AKf-0VFP9mturR8xYCycBCJ1YXtrU";

// The same point written in STANDARD base64 with padding, for the test that
// both alphabets are accepted.
const VAPID_PUBLIC_KEY_STD_B64 =
  "BExMV5+Nf/ofZwNEpV7i1FxCRqtRd8N/YYTdk2njxDR50+MxOb8Cnceh+7AKf+0VFP9mturR8xYCycBCJ1YXtrU=";

// An UNRELATED P-256 keypair's public point. Used for the operator mistake
// that matters most: VAPID_PUBLIC_KEY left over from a key rotation while
// VAPID_PRIVATE_KEY was replaced.
const OTHER_PUBLIC_KEY_B64URL =
  "BNARywCpYQCUzSIor50O_zjwxoMXoGLXKw5p-AVtFswsywwc1ezPV2cik8H_DrZCxAu87hbckZqwdCtm0b-unRM";

// ===================== local helpers =====================

// Decode base64 (either alphabet) WITHOUT calling base64UrlDecode. It is a
// near-copy of that function, deliberately: the point is not that the
// algorithm differs but that mutating the module cannot silently move the
// fixtures too. Everything fed to it here is a padded, well-formed constant
// written into this file, so its lack of validation costs nothing.
function fixtureBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Split a JWT into its three JWS parts, asserting there are exactly three on
// the way past. `noUncheckedIndexedAccess` is on, hence the defaults.
function segments(jwt: string): { header: string; payload: string; signature: string; signingInput: string } {
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const [header = "", payload = "", signature = ""] = parts;
  return { header, payload, signature, signingInput: `${header}.${payload}` };
}

function decodeSegment(segment: string): string {
  return new TextDecoder().decode(fixtureBytes(segment));
}

async function rsaVerifyKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    fixtureBytes(RSA_PUBLIC_SPKI_B64),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function ecVerifyKey(): Promise<CryptoKey> {
  // "raw" import of the uncompressed point -- the same 65 bytes RFC 8292's
  // `k=` carries, so this is the key a push service would verify with.
  return crypto.subtle.importKey(
    "raw",
    fixtureBytes(VAPID_PUBLIC_KEY_B64URL),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

// The two claim sets the real callers build, reproduced literally so the
// pinned JWTs below are production-shaped rather than toy input.
// needFirebase.ts:76-83.
const FCM_CLAIMS = {
  iss: "givefood@givefood-uk.iam.gserviceaccount.com",
  scope: "https://www.googleapis.com/auth/firebase.messaging",
  aud: "https://oauth2.googleapis.com/token",
  iat: 1788723600,
  exp: 1788727200,
};
// webPushCrypto.ts:189-193.
const VAPID_CLAIMS = {
  aud: "https://updates.push.services.mozilla.com",
  exp: 1788766800,
  sub: "mailto:hello@givefood.org.uk",
};

// ===================== base64UrlEncode =====================

describe("base64UrlEncode", () => {
  it("produces RFC 4648 §10's published vectors, unpadded", () => {
    // The ladder exists because it walks all three input residues mod 3, and
    // each one strips a different amount of padding: 0, 1 and 2 "=" signs.
    // A single fixture can only ever exercise one of them, and the residue
    // that breaks is the one nobody happened to pick.
    expect(base64UrlEncode(utf8(""))).toBe("");
    expect(base64UrlEncode(utf8("f"))).toBe("Zg");
    expect(base64UrlEncode(utf8("fo"))).toBe("Zm8");
    expect(base64UrlEncode(utf8("foo"))).toBe("Zm9v");
    expect(base64UrlEncode(utf8("foob"))).toBe("Zm9vYg");
    expect(base64UrlEncode(utf8("fooba"))).toBe("Zm9vYmE");
    expect(base64UrlEncode(utf8("foobar"))).toBe("Zm9vYmFy");
  });

  it("emits the URL-SAFE alphabet, never + or /", () => {
    // Not cosmetic. A JWT segment containing "+" or "/" is not a valid JWS
    // (RFC 7515 §2 is base64url), Google's token endpoint rejects the
    // assertion outright, and a "/" in the VAPID `t=` parameter breaks the
    // Authorization header's own grammar. The failure is a 400/401 that
    // needFirebase.ts logs and swallows.
    //
    // 0xfb 0xff 0xbf is the one three-byte input that produces BOTH
    // substituted characters and nothing else -- standard base64 gives
    // "+/+/", so a half-done replace shows up immediately.
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");

    // And every byte value at once, so no sextet anywhere in the table is
    // left un-substituted. This string is also the single best guard on the
    // whole encoder: the alphabet, the ordering, the high-byte handling and
    // the final padding strip are all in it.
    const everyByte = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
    expect(base64UrlEncode(everyByte)).toBe(
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v" +
        "MDEyMzQ1Njc4OTo7PD0-P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5f" +
        "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn-AgYKDhIWGh4iJiouMjY6P" +
        "kJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq-wsbKztLW2t7i5uru8vb6_" +
        "wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t_g4eLj5OXm5-jp6uvs7e7v" +
        "8PHy8_T19vf4-fr7_P3-_w",
    );
  });

  it("handles bytes at and above 0x80, which is where a naive encoder breaks", () => {
    // String.fromCharCode is being used to build a BINARY string for btoa,
    // so every byte must land as a code unit in 0x00-0xFF. Anything that
    // decoded the bytes as UTF-8 on the way (a TextDecoder creeping in) would
    // turn 0x80-0xFF into U+FFFD and btoa would then throw
    // InvalidCharacterError -- loud, but only for keys and signatures that
    // happen to contain a high byte, which is all of them in practice and
    // none of the ASCII fixtures a casual test uses.
    expect(base64UrlEncode(new Uint8Array([0x00, 0x7f, 0x80, 0xff]))).toBe("AH-A_w");
    expect(base64UrlEncode(new Uint8Array([0xff, 0xff, 0xff]))).toBe("____");
    expect(base64UrlEncode(new Uint8Array([0x00, 0x00, 0x00]))).toBe("AAAA");
  });

  it("accepts an ArrayBuffer as well as a Uint8Array -- crypto.subtle.sign returns the former", () => {
    // Both signing functions pass `await crypto.subtle.sign(...)` straight in,
    // and that resolves to an ArrayBuffer, not a view. If the ArrayBuffer
    // branch were lost the signature segment would silently become "" (see
    // the DataView case below), producing a syntactically valid JWT with an
    // empty signature.
    const buffer = new Uint8Array([0xfb, 0xff, 0xbf]).buffer;
    expect(base64UrlEncode(buffer)).toBe("-_-_");
    expect(base64UrlEncode(new ArrayBuffer(0))).toBe("");
  });

  it("encodes a typed-array VIEW's own bytes, not its whole backing allocation", () => {
    // `bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)` keeps a
    // subarray as-is, so its byteOffset and byteLength are respected. That is
    // what makes `pub.subarray(1, 33)` in importVapidKey correct -- were the
    // view widened to its buffer, the JWK's `x` would be the whole 65-byte
    // point and the import would fail. Both sides are pinned so the
    // difference between the two is visible rather than implied.
    const view = new Uint8Array([0xde, 0xad, 0x61, 0x62, 0x63]).subarray(2);
    expect(base64UrlEncode(view)).toBe("YWJj");
    expect(base64UrlEncode(view.buffer as ArrayBuffer)).toBe("3q1hYmM");
  });

  it("crosses the 0x8000 chunk boundary without dropping or duplicating a byte", () => {
    // THE reason the loop exists, quoted from the module: spreading a large
    // array into String.fromCharCode "blows the argument limit ... service
    // account keys are not [small]". A 2048-bit PKCS#8 key is ~1.2 KB so it
    // never reaches the boundary; the ~1.2 KB VAPID material does not either.
    // Nothing in production exercises this loop past its first iteration
    // today, which is exactly why it needs a test -- an off-by-one in the
    // subarray bounds would sit undetected until someone encoded something
    // big, and would then corrupt it silently rather than throwing.
    //
    // The known answer is hand-checkable: 0x00 0x10 0x83 is the byte triple
    // whose sextets are 0, 1, 2, 3, i.e. exactly "ABCD". Repeat it and the
    // whole 120,000-character expectation is a constant anyone can verify by
    // eye, with no reference implementation involved. 90,000 bytes crosses
    // the 32,768-byte boundary twice.
    const pattern = new Uint8Array(90_000);
    for (let i = 0; i < pattern.length; i += 3) {
      pattern[i] = 0x00;
      pattern[i + 1] = 0x10;
      pattern[i + 2] = 0x83;
    }
    expect(base64UrlEncode(pattern)).toBe("ABCD".repeat(30_000));
  });

  it("agrees with itself split into sub-chunk pieces, for a non-repeating input", () => {
    // The pattern above is uniform, so a loop that encoded the same chunk
    // twice would still produce the right string. This one is not: base64 of
    // a 3-aligned run is position-independent, so encoding 99,999 varied
    // bytes in one go must equal the concatenation of three 33,333-byte
    // pieces -- each of which is under 0x8000 and therefore takes the
    // single-iteration path. Any mis-stepped chunk shows up as a mismatch.
    const big = new Uint8Array(99_999);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const inPieces =
      base64UrlEncode(big.subarray(0, 33_333)) +
      base64UrlEncode(big.subarray(33_333, 66_666)) +
      base64UrlEncode(big.subarray(66_666));
    expect(base64UrlEncode(big)).toBe(inPieces);
    // Unpadded base64 is ceil(n * 4 / 3) characters. Asserted separately
    // because it is the one property a mis-chunked encoder cannot fake.
    expect(base64UrlEncode(big)).toHaveLength(Math.ceil((99_999 * 4) / 3));
  });

  it("produces the exactly-right length either side of the chunk boundary", () => {
    // 32,767 / 32,768 / 32,769 bracket `i += 0x8000`, and 32,768 is not a
    // multiple of 3, so the boundary falls INSIDE a base64 group. That is the
    // case a per-chunk btoa() would get wrong (it would pad mid-string); this
    // implementation concatenates the binary string first and calls btoa
    // once, so it does not -- and these lengths are what says so.
    for (const n of [32_767, 32_768, 32_769, 65_535, 65_536, 65_537, 100_000]) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 7 + 13) & 0xff;
      const encoded = base64UrlEncode(bytes);
      expect(encoded).toHaveLength(Math.ceil((n * 4) / 3));
      // No "=" survives anywhere, not merely at the end.
      expect(encoded).not.toContain("=");
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  });

  it("SILENTLY ENCODES NOTHING for a DataView or a null -- documented, not endorsed", () => {
    // The signature says `ArrayBuffer | Uint8Array`, and both of the values
    // here are outside it, so TypeScript is the only thing preventing them.
    // Worth pinning because the failure is not an exception: a DataView has
    // no `length`, so `new Uint8Array(dataView)` builds an EMPTY array and
    // the caller gets "" back. In a JWT that is an empty signature segment --
    // a token that looks structurally fine and is rejected by every verifier.
    // If a future caller reaches for a DataView (webPushCrypto.ts already
    // uses one, at line 164), this is what it would get.
    expect(base64UrlEncode(new DataView(new Uint8Array([1, 2, 3]).buffer) as unknown as ArrayBuffer)).toBe("");
    expect(base64UrlEncode(null as unknown as ArrayBuffer)).toBe("");
    // A Uint16Array is worse still: it is not a Uint8Array, so each ELEMENT
    // is truncated to a byte rather than the underlying bytes being read.
    // [0x0102, 0x0304] encodes as [0x02, 0x04], losing half the data with no
    // error at all.
    expect(base64UrlEncode(new Uint16Array([0x0102, 0x0304]) as unknown as ArrayBuffer)).toBe("AgQ");
  });
});

// ===================== base64UrlDecode =====================

describe("base64UrlDecode", () => {
  it("accepts BOTH alphabets, which is the whole reason it exists", () => {
    // The module comment: browsers send web push keys as unpadded base64url,
    // a VAPID key pasted from a config file may be either. Both must land on
    // the same bytes or a subscription's p256dh decodes to nonsense and the
    // encrypted push is undecryptable -- which the browser reports to nobody.
    expect(hex(base64UrlDecode("-_8"))).toBe("fbff");
    expect(hex(base64UrlDecode("+/8"))).toBe("fbff");
    expect(hex(base64UrlDecode("-_8="))).toBe("fbff");
    expect(hex(base64UrlDecode("+/8="))).toBe("fbff");
  });

  it("pads an unpadded value, and leaves an already-padded one alone", () => {
    // `padEnd(ceil(len / 4) * 4, "=")`. All three residues, and the padded
    // spelling of each, because a single fixture only proves one of them.
    expect(hex(base64UrlDecode("YQ"))).toBe("61");
    expect(hex(base64UrlDecode("YQ="))).toBe("61");
    expect(hex(base64UrlDecode("YQ=="))).toBe("61");
    expect(hex(base64UrlDecode("YWI"))).toBe("6162");
    expect(hex(base64UrlDecode("YWI="))).toBe("6162");
    expect(hex(base64UrlDecode("YWJj"))).toBe("616263");
    expect(hex(base64UrlDecode("YWJjZA"))).toBe("61626364");
    expect(hex(base64UrlDecode("YWJjZA=="))).toBe("61626364");
    expect(hex(base64UrlDecode(""))).toBe("");
  });

  it("round-trips every byte value through base64UrlEncode", () => {
    // The pair has to be exact inverses over binary, not merely over ASCII:
    // the values that go through them are a 32-byte EC scalar, a 65-byte
    // curve point and a 16-byte auth secret, all uniformly random bytes.
    const everyByte = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
    const back = base64UrlDecode(base64UrlEncode(everyByte));
    expect(back).toHaveLength(256);
    expect(Array.from(back)).toEqual(Array.from(everyByte));
  });

  it("tolerates surrounding whitespace ONLY BY LUCK, depending on the total length mod 4", () => {
    // The most surprising behaviour in this file, and the reason
    // importVapidKey trims both of its arguments (jwt.ts:101 and :105) and
    // vapidAuthorizationHeader trims again (webPushCrypto.ts:197).
    //
    // Two mechanisms fight here. The padEnd is computed on the length
    // INCLUDING the whitespace; atob then follows WHATWG "forgiving base64",
    // which STRIPS the whitespace and accepts an unpadded remainder of 2 or
    // 3. So whether a stray newline is survivable turns entirely on whether
    // the whitespace happens to bring the total to a multiple of 4 -- if it
    // does, no "=" is appended and the stripped value decodes; if it does
    // not, the appended "=" characters land after a value whose real length
    // no longer matches them, and atob rejects the lot.
    //
    // "aGVsbG8" is 7 characters, so one trailing byte of whitespace makes 8
    // and squeaks through, while two make 9 and do not:
    expect(hex(base64UrlDecode("aGVsbG8"))).toBe("68656c6c6f");
    expect(hex(base64UrlDecode("aGVsbG8\n"))).toBe("68656c6c6f");
    expect(hex(base64UrlDecode("\naGVsbG8"))).toBe("68656c6c6f");
    expect(hex(base64UrlDecode(" aGVsbG8"))).toBe("68656c6c6f");
    const invalidCharacter = expect.objectContaining({ name: "InvalidCharacterError" });
    expect(() => base64UrlDecode("aGVsbG8\r\n")).toThrow(invalidCharacter);
    expect(() => base64UrlDecode(" aGVsbG8 ")).toThrow(invalidCharacter);
    expect(() => base64UrlDecode("aGVsbG8\n\n")).toThrow(invalidCharacter);
    // ...and a 4-character value is the other way round: clean already, so
    // ANY single whitespace character breaks it, while four spaces do not.
    expect(hex(base64UrlDecode("YWJj"))).toBe("616263");
    expect(() => base64UrlDecode("YWJj\n")).toThrow(invalidCharacter);
    expect(hex(base64UrlDecode("YWJj    "))).toBe("616263");

    // Why this is not academic: the REAL VAPID secrets are 43 and 87
    // characters, both ≡ 3 (mod 4). A Unix trailing newline therefore lands
    // on 44 and 88 and gets away with it; a Windows CRLF lands on 45 and 89
    // and does not. Without the trims, web push would work or not work
    // depending on which editor last touched the secret, and the failure is
    // one console.error at needWebPush.ts:75 for the whole fan-out.
    expect(base64UrlDecode(`${VAPID_PRIVATE_KEY_RAW}\n`)).toHaveLength(32);
    expect(() => base64UrlDecode(`${VAPID_PRIVATE_KEY_RAW}\r\n`)).toThrow(invalidCharacter);
    expect(base64UrlDecode(`${VAPID_PUBLIC_KEY_B64URL}\n`)).toHaveLength(65);
    expect(() => base64UrlDecode(`${VAPID_PUBLIC_KEY_B64URL}\r\n`)).toThrow(invalidCharacter);
  });

  it("tolerates a DIFFERENT, almost disjoint set of whitespace from Django's fix_base64_padding", () => {
    // gfwfbn/views.py:35-47 is the ancestor the module comment names, and the
    // padding arithmetic is identical -- `padding = 4 - (len(s) % 4)`,
    // appended when it is not 4. What differs is the decoder underneath:
    // Python's base64.urlsafe_b64decode discards non-alphabet characters and
    // then INSISTS the remainder is a multiple of 4, where atob strips and
    // then accepts a remainder of 2 or 3. The two therefore tolerate almost
    // opposite sets of inputs.
    //
    // Measured, not reasoned: this matrix came out of running
    // fix_base64_padding followed by base64.urlsafe_b64decode on CPython
    // 3.12.3 from the Django repo's own .venv on this machine.
    //
    //   value            Django            here
    //   "aGVsbG8"        b"hello"          hello
    //   "aGVsbG8\n"      binascii.Error    hello
    //   "aGVsbG8\r\n"    b"hello"          InvalidCharacterError
    //   " aGVsbG8 "      b"hello"          InvalidCharacterError
    //   "YWJj\n"         b"abc"            InvalidCharacterError
    //   43-char scalar   32 bytes          32 bytes
    //   scalar + "\n"    binascii.Error    32 bytes
    //
    // Recorded rather than fixed. It is unreachable at this module's call
    // sites (all of which trim first) and the two implementations are on
    // opposite sides of the port anyway -- Django's copy guards the SUBSCRIBE
    // endpoint, this one guards the SEND path. What matters is that nobody
    // reads "same arithmetic" as "same behaviour" and drops a trim.
    expect(hex(base64UrlDecode("aGVsbG8\n"))).toBe("68656c6c6f"); // Django raises
    expect(() => base64UrlDecode("aGVsbG8\r\n")).toThrow(); // Django decodes
    expect(() => base64UrlDecode("YWJj\n")).toThrow(); // Django decodes

    // The shapes both DO accept, from the same Python run -- the ones that
    // actually travel between the two systems.
    expect(hex(base64UrlDecode("aGVsbG8"))).toBe("68656c6c6f");
    expect(hex(base64UrlDecode("-_8"))).toBe("fbff");
    expect(hex(base64UrlDecode("+/8"))).toBe("fbff");
    // ...and the shapes both reject: a length that is 1 more than a multiple
    // of 4 can never be base64, in either language.
    expect(() => base64UrlDecode("a")).toThrow();
    expect(() => base64UrlDecode("YWJjZ")).toThrow();
  });

  it("throws rather than silently truncating on a malformed value", () => {
    // No validation of its own, so everything below comes out of atob. It
    // matters that these THROW: encryptPayload() feeds it a subscription's
    // stored p256dh and auth straight from D1 (webPushCrypto.ts:75-76), and
    // needWebPush.ts:131-141 catches the throw, logs, and skips that
    // subscriber WITHOUT deleting the row. A decoder that returned a short
    // buffer instead would sail past the 65-byte length check with a
    // different error, or worse, encrypt to a key nobody holds.
    const invalidCharacter = expect.objectContaining({ name: "InvalidCharacterError" });
    expect(() => base64UrlDecode("a")).toThrow(invalidCharacter);
    expect(() => base64UrlDecode("YWJjZ")).toThrow(invalidCharacter);
    // Over-padding: 9 characters padded up to 12 leaves three "=" in a row.
    expect(() => base64UrlDecode("aGVsbG8==")).toThrow(invalidCharacter);
    // "=" in the middle, and characters outside both alphabets.
    expect(() => base64UrlDecode("AA=A")).toThrow(invalidCharacter);
    expect(() => base64UrlDecode("aGVsbG8~")).toThrow(invalidCharacter);
    expect(() => base64UrlDecode("....")).toThrow(invalidCharacter);
  });

  it("throws a TypeError, not a DOMException, on null or undefined", () => {
    // Different failure mode from every other bad input, and worth knowing
    // apart: an unset Worker secret arrives as `undefined`, and although
    // needWebPush.ts:44 guards all three VAPID credentials for falsiness
    // before calling in, encryptPayload has no such guard on the columns it
    // reads. `.replace` on undefined is where it would land.
    expect(() => base64UrlDecode(undefined as unknown as string)).toThrow(TypeError);
    expect(() => base64UrlDecode(null as unknown as string)).toThrow(TypeError);
  });
});

// ===================== utf8 =====================

describe("utf8", () => {
  it("encodes UTF-8 bytes, not UTF-16 code units", () => {
    // Both signing functions hash `utf8(signingInput)`, and webPushCrypto.ts
    // encrypts `utf8(plaintext)` where the plaintext is a JSON payload
    // carrying a food bank's name -- and food bank names on this site carry
    // accents, dashes and the odd emoji. A latin1 or UTF-16 encoder would
    // change the bytes signed and the bytes encrypted at once.
    expect(hex(utf8("abc"))).toBe("616263");
    expect(hex(utf8("café"))).toBe("636166c3a9");
    expect(hex(utf8("£"))).toBe("c2a3");
    expect(hex(utf8("🍞"))).toBe("f09f8d9e");
    expect(hex(utf8(""))).toBe("");
  });

  it("substitutes U+FFFD for a lone surrogate instead of throwing", () => {
    // A throw here would escape signJwtEs256 into needWebPush.ts's per-
    // subscriber catch and skip that subscriber. TextEncoder follows WHATWG
    // and substitutes instead, so a mangled string is signed rather than
    // rejected -- and every unpaired surrogate collapses onto the same three
    // bytes. Unreachable through the JWT path (the signing input is ASCII
    // base64url by construction) but reachable through the push payload,
    // which is built from database text.
    expect(hex(utf8("\ud83c"))).toBe("efbfbd");
    expect(hex(utf8("\udf5e"))).toBe("efbfbd");
    expect(hex(utf8("�"))).toBe("efbfbd");
    // A properly paired surrogate keeps its real four bytes.
    expect(hex(utf8("🍞"))).toBe("f09f8d9e");
  });

  it("returns a view starting at byteOffset 0 that spans its whole buffer", () => {
    // Not decoration. webPushCrypto.ts hands these arrays to
    // crypto.subtle.encrypt and to concat(); anything that handed over a
    // `.buffer` of a shorter view would silently include neighbouring bytes,
    // the way base64UrlEncode(view.buffer) does above. TextEncoder always
    // allocates exactly, and this pins that so a future "reuse one scratch
    // buffer" optimisation has to change a test.
    const bytes = utf8("hello");
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.byteLength).toBe(5);
    expect(bytes.buffer.byteLength).toBe(5);
  });

  it("treats undefined as the empty string but null as the four letters n-u-l-l", () => {
    // TextEncoder.encode's parameter is an OPTIONAL USVString defaulting to
    // "", so `undefined` encodes to zero bytes while `null` is stringified.
    // The consequence in this module is asymmetric and quiet: an undefined
    // signing input would sign the empty string, and a null one would sign
    // the literal text "null". Neither throws. Unreachable today -- every
    // caller passes a template literal -- and pinned because "the value is
    // falsy so we are fine" is not a safe way to reason about this function.
    expect(hex(utf8(undefined as unknown as string))).toBe("");
    expect(hex(utf8(null as unknown as string))).toBe("6e756c6c");
    expect(hex(utf8(12 as unknown as string))).toBe("3132");
  });
});

// ===================== pemToDer =====================

describe("pemToDer", () => {
  it("extracts the real DER body of a PKCS#8 EC PEM", () => {
    // A structural known answer rather than a round trip. 0x30 0x81 0x87 is
    // an ASN.1 SEQUENCE of 0x87 = 135 bytes, plus the 3 header bytes = 138,
    // which is what a P-256 PKCS#8 PrivateKeyInfo weighs. Getting this wrong
    // -- by leaving a stray character in, say -- shifts every subsequent byte
    // and importKey answers "Invalid keyData" with no hint where.
    const der = pemToDer(VAPID_PRIVATE_KEY_PEM);
    expect(der).toHaveLength(138);
    expect(Array.from(der.subarray(0, 3))).toEqual([0x30, 0x81, 0x87]);
    // The last 65 bytes of a P-256 PrivateKeyInfo are the uncompressed public
    // point. Checking them against VAPID_PUBLIC_KEY_B64URL proves the DER is
    // genuinely this keypair's and not merely well-formed -- and it ties the
    // PEM fixture and the raw fixture together, which the importVapidKey
    // block below relies on.
    expect(hex(der.subarray(der.length - 65))).toBe(hex(fixtureBytes(VAPID_PUBLIC_KEY_B64URL)));
  });

  it("strips CRLF, missing trailing newlines, blank lines and indentation alike", () => {
    // `.replace(/\s+/g, "")` rather than a line-based parse, and it needs to
    // be: a service-account `private_key` arrives from JSON.parse with real
    // \n, a secret pasted through a Windows terminal arrives with \r\n, and a
    // PEM copied out of a YAML block arrives indented. All four must give
    // byte-identical DER or the Firebase channel works on one machine's
    // secret and not another's.
    const canonical = hex(pemToDer(VAPID_PRIVATE_KEY_PEM));
    expect(hex(pemToDer(VAPID_PRIVATE_KEY_PEM.replace(/\n/g, "\r\n")))).toBe(canonical);
    expect(hex(pemToDer(VAPID_PRIVATE_KEY_PEM.trim()))).toBe(canonical);
    expect(hex(pemToDer(`\n\n${VAPID_PRIVATE_KEY_PEM}\n\n`))).toBe(canonical);
    expect(hex(pemToDer(VAPID_PRIVATE_KEY_PEM.replace(/\n/g, "\n    ")))).toBe(canonical);
    // Every whitespace character, not just newlines and spaces.
    expect(hex(pemToDer(VAPID_PRIVATE_KEY_PEM.replace(/\n/g, "\t\n")))).toBe(canonical);
  });

  it("accepts a bare base64 body with no header or footer at all", () => {
    // The regex simply finds nothing to strip, so a DER blob that arrived
    // without its armour still decodes. Documented because it is what makes
    // importVapidKey's `includes("-----BEGIN")` test the only thing choosing
    // between the two branches: a header-less base64 body is NOT treated as
    // PEM there, it falls through to the raw-scalar path and is rejected on
    // its length.
    expect(hex(pemToDer("YWJj"))).toBe("616263");
    expect(hex(pemToDer("-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----"))).toBe("616263");
    // It delegates to base64UrlDecode, so a base64URL body works too -- not
    // a thing any PEM writer emits, but it means a "-" inside the body is
    // data rather than an error.
    expect(hex(pemToDer("-----BEGIN PRIVATE KEY-----\n-_8\n-----END PRIVATE KEY-----"))).toBe("fbff");
  });

  it("returns nothing for an empty string or an empty PEM block", () => {
    // Both reach crypto.subtle.importKey as a zero-length buffer, which
    // rejects with DataError -- see importRs256Key below. Pinned so that
    // "the secret was set to an empty string" is understood to surface as an
    // import failure rather than as a key that signs nothing.
    expect(pemToDer("")).toHaveLength(0);
    expect(pemToDer("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----")).toHaveLength(0);
  });

  it("concatenates the bodies of two PEM blocks rather than taking the first", () => {
    // A file holding both the private and public halves -- which is what
    // `vapid --gen` leaves behind if both are catted together -- decodes as
    // one run-on blob. It then fails at importKey rather than quietly using
    // the first key, which is the safer of the two behaviours and is pinned
    // as such.
    expect(hex(pemToDer("-----BEGIN A-----\nYWJj\n-----END A-----\n-----BEGIN B-----\nZGVm\n-----END B-----"))).toBe(
      "616263646566",
    );
  });

  it("SILENTLY DECODES THE ARMOUR ITSELF when the PEM label contains a hyphen", () => {
    // The sharp edge in `/-----(BEGIN|END)[^-]+-----/g`: the label is matched
    // as "one or more NON-HYPHEN characters", so a label containing a hyphen
    // does not match and the header and footer are never stripped. They are
    // then base64-DECODED as if they were data -- and they decode cleanly,
    // because "-" maps to "+" and every remaining character is in the
    // alphabet. No exception, no warning, just 45 bytes of garbage handed to
    // importKey, which answers "Invalid keyData" and gives no hint that the
    // problem is the label.
    //
    // The most legible way to say this: re-encoding the result reproduces the
    // input with its whitespace removed, because nothing was stripped.
    const der = pemToDer("-----BEGIN RSA-PRIVATE KEY-----\nYWJj\n-----END RSA-PRIVATE KEY-----");
    expect(base64UrlEncode(der)).toBe("-----BEGINRSA-PRIVATEKEY-----YWJj-----ENDRSA-PRIVATEKEY-----");
    expect(der).toHaveLength(45);
    // The SAME failure from the other direction, and the mutant it kills:
    // swapping the two replaces so `/\s+/g` runs FIRST would join
    // "----- BEGIN PRIVATE KEY -----" into "-----BEGINPRIVATEKEY-----",
    // which the label regex then matches and strips. The real order does not,
    // because after the opening dashes comes a space rather than "BEGIN" --
    // so armour with spaces inside its dashes is decoded as data today. The
    // reordering looks like a pure tidy-up in review and quietly changes what
    // this function accepts; asserting the current (stricter) behaviour is
    // what makes it show up.
    const spaced = pemToDer("----- BEGIN PRIVATE KEY -----\nYWJj\n----- END PRIVATE KEY -----");
    expect(base64UrlEncode(spaced)).toBe("-----BEGINPRIVATEKEY-----YWJj-----ENDPRIVATEKEY-----");
    expect(spaced).toHaveLength(39);

    // `[^-]+`, not `[^-]*`: the label is REQUIRED, so armour with no label
    // between the dashes is data too. Loosening the quantifier to `*` is the
    // kind of edit that gets made while fixing the hyphen bug above, and
    // nothing else here would notice it.
    expect(base64UrlEncode(pemToDer("-----BEGIN-----\nYWJj\n-----END-----"))).toBe("-----BEGIN-----YWJj-----END-----");

    // Unreachable today: no PEM label this code meets has a hyphen in it.
    // The two that matter are "PRIVATE KEY" (PKCS#8, what a Google service
    // account and `vapid --gen` both write) and "EC PRIVATE KEY" (SEC1),
    // and both strip correctly.
    expect(hex(pemToDer("-----BEGIN EC PRIVATE KEY-----\nYWJj\n-----END EC PRIVATE KEY-----"))).toBe("616263");
    expect(hex(pemToDer("-----BEGIN ENCRYPTED PRIVATE KEY-----\nYWJj\n-----END ENCRYPTED PRIVATE KEY-----"))).toBe(
      "616263",
    );
  });
});

// ===================== importRs256Key =====================

describe("importRs256Key", () => {
  it("imports a service account's PKCS#8 private key as a sign-only, non-extractable RSA key", () => {
    // The algorithm parameters ARE the security property: RSASSA-PKCS1-v1_5
    // with SHA-256 is what "RS256" means in the header signJwtRs256 writes,
    // and if the two ever disagreed Google would reject every assertion with
    // a 400 that needFirebase.ts:99 logs and returns from -- no notifications,
    // no alarm. `extractable: false` matters too: the service-account private
    // key can never be exported back out of the isolate and into a log line.
    return importRs256Key(RSA_PRIVATE_KEY_PEM).then((key) => {
      expect(key.type).toBe("private");
      expect(key.extractable).toBe(false);
      expect(key.usages).toEqual(["sign"]);
      const algorithm = key.algorithm as { name: string; hash: { name: string }; modulusLength: number };
      expect(algorithm.name).toBe("RSASSA-PKCS1-v1_5");
      expect(algorithm.hash.name).toBe("SHA-256");
      expect(algorithm.modulusLength).toBe(2048);
    });
  });

  it("imports the same key however the PEM's newlines arrived", async () => {
    // JSON.parse turns the service-account file's "\n" escapes into real
    // newlines, but a key re-pasted through `wrangler secret put` can arrive
    // CRLF or with no trailing newline. All three must import, because the
    // symptom of one that does not is a channel that is silently off.
    for (const pem of [
      RSA_PRIVATE_KEY_PEM,
      RSA_PRIVATE_KEY_PEM.replace(/\n/g, "\r\n"),
      RSA_PRIVATE_KEY_PEM.trim(),
      `  ${RSA_PRIVATE_KEY_PEM}  `,
    ]) {
      const key = await importRs256Key(pem);
      expect(key.usages).toEqual(["sign"]);
    }
  });

  it("rejects an EC key with DataError -- the credential mix-up that is otherwise silent", async () => {
    // Pasting VAPID_PRIVATE_KEY into FIREBASE_SERVICE_ACCOUNT (or the
    // reverse) is the one operator error both channels are exposed to, and
    // neither validates its secret beyond "is it set". This rejects loudly,
    // which is what turns the mistake into needFirebase.ts:85's "could not
    // sign the service-account assertion" log line rather than a mystery 401.
    //
    // Pinned by the WebCrypto-specified error NAME. A bare `rejects.toThrow()`
    // would stay green if this started failing for an unrelated reason -- a
    // TypeError from a wrong argument shape, say -- which would break every
    // GOOD key too and still look satisfied here.
    await expect(importRs256Key(VAPID_PRIVATE_KEY_PEM)).rejects.toThrow(
      expect.objectContaining({ name: "DataError" }),
    );
  });

  it("rejects an empty or garbage PEM with DataError rather than returning a dud key", async () => {
    // needFirebase.ts checks that FIREBASE_SERVICE_ACCOUNT parses as JSON and
    // has a non-empty private_key (lines 60-63), but nothing checks that the
    // value is a KEY. Everything past that guard lands here.
    const dataError = expect.objectContaining({ name: "DataError" });
    await expect(importRs256Key("")).rejects.toThrow(dataError);
    await expect(importRs256Key("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----")).rejects.toThrow(dataError);
    await expect(importRs256Key("-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----")).rejects.toThrow(
      dataError,
    );
    await expect(importRs256Key("not a pem at all")).rejects.toThrow();
  });
});

// ===================== signJwtRs256 =====================

describe("signJwtRs256", () => {
  it("produces one exact, byte-for-byte JWT for the FCM assertion", async () => {
    // The strongest assertion in this file, and the one only RS256 makes
    // possible: RSASSA-PKCS1-v1_5 is deterministic, so the whole token is a
    // constant. Cross-checked against node:crypto's OpenSSL-backed
    // `crypto.sign("sha256", ...)` over the same signing input, which agreed
    // character for character -- so this pins agreement with an
    // implementation outside WebCrypto, not agreement with itself.
    //
    // Everything the wire format depends on is inside this one string: the
    // header's field order, the RS256 algorithm name, the claim order, the
    // "." separators, the URL-safe alphabet and the stripped padding.
    const key = await importRs256Key(RSA_PRIVATE_KEY_PEM);
    expect(await signJwtRs256(key, FCM_CLAIMS)).toBe(
      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." +
        "eyJpc3MiOiJnaXZlZm9vZEBnaXZlZm9vZC11ay5pYW0uZ3NlcnZpY2VhY2NvdW50LmNvbSIsInNjb3BlIjoiaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vYXV0aC9maXJlYmFzZS5tZXNzYWdpbmciLCJhdWQiOiJodHRwczovL29hdXRoMi5nb29nbGVhcGlzLmNvbS90b2tlbiIsImlhdCI6MTc4ODcyMzYwMCwiZXhwIjoxNzg4NzI3MjAwfQ." +
        "F1OC9Ur8svfxdHAYV8M_-deL1Ipc_mQ5p9jJfk9VkXiVuFIS2PLqy7LVxi2iD35QuykTTBh6tT6nbYshgwsP7t4GgePZmJpQbbN6s1F-NoB8xM86O5Ko9vp87tVqs9PnlZcx90EledaIl9XuLGQKkMgXRH_GrECK24hLs86XMe6lnjNq6TqqyLbmCvqB0Wuo1swl4ds1JwhFfOpGlrrz1dmKYAhAmJbSXsuRq8wM8TmiFfJ2jztqPtjJyg_TRzugW_pf844TreBhWSalzK5D1Zfkvh-rI_Tig2pkNFPPhm7Szbrg2U05vikV0Vyq69t7dAqi0K--Bgq1vwarkGdQog",
    );
  });

  it("writes exactly {\"alg\":\"RS256\",\"typ\":\"JWT\"} as the header, in that order", async () => {
    // Called out separately from the whole-JWT pin because it is the segment
    // Google actually dispatches on. "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9"
    // is the fixed header every RS256 JWS library emits -- if the algorithm
    // name changed to RS512, or `typ` were dropped, or the two fields were
    // written the other way round, this constant moves and the token is
    // rejected at the token endpoint with an error nobody reads.
    const key = await importRs256Key(RSA_PRIVATE_KEY_PEM);
    const { header } = segments(await signJwtRs256(key, FCM_CLAIMS));
    expect(header).toBe("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(decodeSegment(header)).toBe('{"alg":"RS256","typ":"JWT"}');
  });

  it("signs the header AND the payload, not the payload alone", async () => {
    // The alg-confusion door. A signature computed over only the claims would
    // still verify a token whose header had been rewritten to a weaker
    // algorithm, and every round-trip test in the world would stay green.
    // Verified against the real public key: true over "<header>.<payload>",
    // false over the payload by itself, false over the header by itself.
    const key = await importRs256Key(RSA_PRIVATE_KEY_PEM);
    const publicKey = await rsaVerifyKey();
    const { header, payload, signature, signingInput } = segments(await signJwtRs256(key, FCM_CLAIMS));
    const sig = base64UrlDecode(signature);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, sig, utf8(signingInput))).toBe(true);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, sig, utf8(payload))).toBe(false);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, sig, utf8(header))).toBe(false);
    // And a single character changed anywhere in the signing input breaks it.
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, sig, utf8(`${signingInput}x`))).toBe(false);
  });

  it("is deterministic, and a one-second change to exp moves nearly the whole signature", async () => {
    // Determinism is what makes the pinned JWT above a legitimate test, so it
    // is asserted rather than assumed -- if signJwtRs256 ever grew a random
    // element (PSS padding, say) the pin would become flaky rather than
    // wrong, which is the worst possible outcome for a test in a suite that
    // runs on every save.
    //
    // The avalanche half is the tamper check: "differs" alone would also be
    // satisfied by an implementation that signed a truncated prefix of the
    // input, so the two signatures are required to differ in nearly every
    // character rather than merely somewhere.
    const key = await importRs256Key(RSA_PRIVATE_KEY_PEM);
    const first = await signJwtRs256(key, FCM_CLAIMS);
    expect(await signJwtRs256(key, FCM_CLAIMS)).toBe(first);
    // A second import of the same PEM must produce the same token too -- the
    // key object is rebuilt per call in needFirebase.ts's getAccessToken.
    expect(await signJwtRs256(await importRs256Key(RSA_PRIVATE_KEY_PEM), FCM_CLAIMS)).toBe(first);

    const nudged = await signJwtRs256(key, { ...FCM_CLAIMS, exp: FCM_CLAIMS.exp + 1 });
    const a = segments(first).signature;
    const b = segments(nudged).signature;
    expect(b).not.toBe(a);
    const shared = [...a].filter((ch, i) => ch === b[i]).length;
    expect(shared).toBeLessThan(a.length / 4); // ~5 expected by chance out of 342
  });

  it("emits a 2048-bit signature as 342 unpadded base64url characters", async () => {
    // 256 bytes of RSA signature, ceil(256 * 4 / 3) = 342 characters. Pinned
    // because a signature that is even slightly the wrong length is not a
    // near-miss to a verifier, it is a parse failure -- and because the
    // whole token must stay inside the base64url alphabet to be a legal JWS.
    const key = await importRs256Key(RSA_PRIVATE_KEY_PEM);
    const jwt = await signJwtRs256(key, FCM_CLAIMS);
    const { signature } = segments(jwt);
    expect(signature).toHaveLength(342);
    expect(base64UrlDecode(signature)).toHaveLength(256);
    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("keeps claims in INSERTION order and drops undefined values", async () => {
    // JSON.stringify semantics, and both halves are load-bearing.
    //
    // Order: the pinned JWT above is only reproducible because the claims are
    // serialised in the order the caller wrote them. A "tidy" refactor that
    // sorted the keys would change every signature this module has ever
    // produced -- harmless to Google, fatal to this file's known answers, and
    // the sort of change that should have to update a test deliberately.
    //
    // Dropped undefined: `{ iat: undefined }` does not become `"iat":null`,
    // the claim vanishes. Google's token endpoint rejects an assertion with
    // no `iat`, so a caller that passed an optional-but-absent claim would
    // get a 400 rather than a null-valued one.
    const key = await importRs256Key(RSA_PRIVATE_KEY_PEM);
    const forwards = segments(await signJwtRs256(key, { a: 1, b: 2 })).payload;
    const backwards = segments(await signJwtRs256(key, { b: 2, a: 1 })).payload;
    expect(decodeSegment(forwards)).toBe('{"a":1,"b":2}');
    expect(decodeSegment(backwards)).toBe('{"b":2,"a":1}');
    expect(backwards).not.toBe(forwards);

    expect(decodeSegment(segments(await signJwtRs256(key, { a: undefined, b: 1 })).payload)).toBe('{"b":1}');
    expect(decodeSegment(segments(await signJwtRs256(key, {})).payload)).toBe("{}");
    // A null claim is NOT dropped -- only undefined is.
    expect(decodeSegment(segments(await signJwtRs256(key, { a: null, b: 1 })).payload)).toBe('{"a":null,"b":1}');
  });

  it("URL-encodes a payload that standard base64 would spell with + and /", async () => {
    // The claims that reach this in production are ASCII URLs and integers,
    // whose base64 happens never to need the two substituted characters --
    // so the FCM fixture above would pass with the substitutions removed
    // from the payload path entirely. This claim set forces both, which is
    // what makes the alphabet genuinely covered end to end rather than only
    // in base64UrlEncode's own unit tests.
    const key = await importRs256Key(RSA_PRIVATE_KEY_PEM);
    const { payload } = segments(await signJwtRs256(key, { s: "ÿþý~~~???" }));
    expect(payload).toBe("eyJzIjoiw7_DvsO9fn5-Pz8_In0");
    expect(payload).toContain("-");
    expect(payload).toContain("_");
    expect(decodeSegment(payload)).toBe('{"s":"ÿþý~~~???"}');
  });

  it("encodes non-ASCII claims as UTF-8", async () => {
    // VAPID_ADMIN_EMAIL becomes a `sub` claim on the other signer, and a
    // food bank's name can reach a claim through nothing today -- but the
    // encoder is shared, so the property is pinned here where the payload can
    // be read back exactly.
    const key = await importRs256Key(RSA_PRIVATE_KEY_PEM);
    const { payload } = segments(await signJwtRs256(key, { sub: "mailto:café@givefood.org.uk" }));
    expect(decodeSegment(payload)).toBe('{"sub":"mailto:café@givefood.org.uk"}');
  });

  it("throws a TypeError on claims JSON.stringify cannot serialise", async () => {
    // A BigInt or a circular object throws BEFORE any signing happens. It is
    // caught by needFirebase.ts:84-87, logged as "could not sign the
    // service-account assertion", and the notification is skipped -- so the
    // consequence of a caller building bad claims is a missing notification,
    // not a crashed consumer or a poisoned dead-letter queue.
    const key = await importRs256Key(RSA_PRIVATE_KEY_PEM);
    await expect(signJwtRs256(key, { n: 1n as unknown as number })).rejects.toThrow(TypeError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(signJwtRs256(key, circular)).rejects.toThrow(TypeError);
  });

  it("refuses to sign with an ECDSA key", async () => {
    // The other half of the credential mix-up: a P-256 key that imported
    // fine through importVapidKey cannot be used here. WebCrypto raises
    // InvalidAccessError rather than producing a signature Google would
    // reject, so the failure is at least logged at the right line.
    const ecKey = await importVapidKey(VAPID_PRIVATE_KEY_PEM, VAPID_PUBLIC_KEY_B64URL);
    await expect(signJwtRs256(ecKey, FCM_CLAIMS)).rejects.toThrow(
      expect.objectContaining({ name: "InvalidAccessError" }),
    );
  });
});

// ===================== importVapidKey =====================

describe("importVapidKey", () => {
  it("imports the PKCS#8 PEM shape that `vapid --gen` writes", async () => {
    const key = await importVapidKey(VAPID_PRIVATE_KEY_PEM, VAPID_PUBLIC_KEY_B64URL);
    expect(key.type).toBe("private");
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(["sign"]);
    const algorithm = key.algorithm as { name: string; namedCurve: string };
    expect(algorithm.name).toBe("ECDSA");
    expect(algorithm.namedCurve).toBe("P-256");
  });

  it("imports the raw 32-byte scalar shape, reconstructing the same key as the PEM", async () => {
    // THE test for this function, and the one that makes the JWK
    // reconstruction meaningful: x = pub[1..33] and y = pub[33..65], which is
    // pure convention and impossible to check by reading. Both keys sign, and
    // BOTH signatures verify against the one public point a push service
    // holds -- so the raw path really did rebuild the same private key rather
    // than merely producing something importKey accepted.
    //
    // Slicing x and y anywhere else (swapped, or including the 0x04 prefix)
    // yields a point that is not on the curve and WebCrypto rejects the
    // import outright, so this test also kills those mutants.
    const fromPem = await importVapidKey(VAPID_PRIVATE_KEY_PEM, VAPID_PUBLIC_KEY_B64URL);
    const fromRaw = await importVapidKey(VAPID_PRIVATE_KEY_RAW, VAPID_PUBLIC_KEY_B64URL);
    const publicKey = await ecVerifyKey();

    // The raw branch's own key PROPERTIES, and the mutant that made this
    // necessary: setting the JWK's `ext: true` AND the importKey
    // `extractable` argument to true TOGETHER left all sixty tests green,
    // because nothing here had ever looked at the raw-branch key beyond
    // "does it sign". Flipping either one alone throws (WebCrypto rejects
    // `ext: false` with `extractable: true`), so only the pair survived --
    // exactly the shape a careless "make the key exportable so I can log it"
    // edit takes. An extractable VAPID private key can be exported back out
    // of the isolate in one line, which is the whole reason `false` is there.
    expect(fromRaw.extractable).toBe(false);
    expect(fromRaw.type).toBe("private");
    expect(fromRaw.usages).toEqual(["sign"]);
    // The consequence, demonstrated rather than asserted about: the key
    // cannot be got back out. Only the REJECTION is pinned, not the error
    // type -- this suite runs on node's WebCrypto, not workerd's, and the two
    // runtimes' exception classes for this are not something a test running
    // in one of them can honestly claim about the other. `extractable` above
    // is the portable half.
    await expect(crypto.subtle.exportKey("jwk", fromRaw)).rejects.toThrow(/not extractable/i);

    for (const key of [fromPem, fromRaw]) {
      const { signature, signingInput } = segments(await signJwtEs256(key, VAPID_CLAIMS));
      const verified = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        base64UrlDecode(signature),
        utf8(signingInput),
      );
      expect(verified).toBe(true);
    }
  });

  it("IGNORES the public key entirely on the PEM branch", async () => {
    // Reading the function, the second argument looks required. On the PEM
    // branch it is never touched -- a PKCS#8 blob already carries the public
    // half, so nothing needs supplying. The consequence is worth pinning:
    // with a PEM private key, a VAPID_PUBLIC_KEY that is stale, truncated or
    // outright not base64 imports perfectly happily here, and only shows up
    // later in vapidAuthorizationHeader (webPushCrypto.ts:197), which puts
    // that same string in the `k=` parameter the push service checks the
    // signature against. That is a 403 from Mozilla per subscriber, logged
    // once each by needWebPush.ts:164 and never surfaced anywhere.
    //
    // "It imported" is too weak an assertion to carry that claim on its own:
    // it would also hold if the PEM branch had started FOLDING the second
    // argument into the key somehow. So each key is made to sign, and the
    // signature is verified against the PEM's OWN public point -- proving the
    // ignored argument is genuinely ignored rather than merely tolerated.
    const truth = await ecVerifyKey();
    for (const bogus of ["", "not base64 at all!!!", OTHER_PUBLIC_KEY_B64URL, "AAAA"]) {
      const key = await importVapidKey(VAPID_PRIVATE_KEY_PEM, bogus);
      expect(key.usages).toEqual(["sign"]);
      const { signature, signingInput } = segments(await signJwtEs256(key, VAPID_CLAIMS));
      expect(
        await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          truth,
          base64UrlDecode(signature),
          utf8(signingInput),
        ),
      ).toBe(true);
    }
  });

  it("REJECTS a mismatched public key on the raw branch, where it is load-bearing", async () => {
    // The counterpart, and the good news: on the raw-scalar branch the point
    // IS used, and WebCrypto checks that (x, y) is the public half of d. A
    // VAPID_PUBLIC_KEY left behind by a half-finished key rotation therefore
    // fails at import with DataError -- loudly, once, at needWebPush.ts:75 --
    // rather than signing with one key while advertising another.
    await expect(importVapidKey(VAPID_PRIVATE_KEY_RAW, OTHER_PUBLIC_KEY_B64URL)).rejects.toThrow(
      expect.objectContaining({ name: "DataError" }),
    );
  });

  it("names the byte count when the private scalar is not 32 bytes", async () => {
    // The error message is the only diagnostic anyone gets: needWebPush.ts
    // logs it and returns, so "decoded to 31 bytes" versus "decoded to 0
    // bytes" is the difference between "the secret is truncated" and "the
    // secret is empty" for whoever reads the tail. Pinned as text because
    // that is what the log line contains.
    await expect(importVapidKey(base64UrlEncode(new Uint8Array(31)), VAPID_PUBLIC_KEY_B64URL)).rejects.toThrow(
      "VAPID_PRIVATE_KEY is neither PEM nor a 32-byte raw scalar (decoded to 31 bytes)",
    );
    await expect(importVapidKey(base64UrlEncode(new Uint8Array(33)), VAPID_PUBLIC_KEY_B64URL)).rejects.toThrow(
      "VAPID_PRIVATE_KEY is neither PEM nor a 32-byte raw scalar (decoded to 33 bytes)",
    );
    await expect(importVapidKey("", VAPID_PUBLIC_KEY_B64URL)).rejects.toThrow(
      "VAPID_PRIVATE_KEY is neither PEM nor a 32-byte raw scalar (decoded to 0 bytes)",
    );

    // When BOTH secrets are wrong the PRIVATE key is the one named, because
    // its guard runs first. This is the only assertion in the file that pins
    // the ORDER of the two checks -- moving the public-point guard above the
    // scalar guard leaves every other test in this file green while changing
    // which secret the single log line at needWebPush.ts:75 accuses. "Both
    // unset" is the state a fresh environment is in, so this is the message
    // whoever is setting the channel up for the first time actually reads.
    await expect(importVapidKey("", "")).rejects.toThrow(
      "VAPID_PRIVATE_KEY is neither PEM nor a 32-byte raw scalar (decoded to 0 bytes)",
    );
    await expect(importVapidKey("AAAA", "AAAA")).rejects.toThrow(
      "VAPID_PRIVATE_KEY is neither PEM nor a 32-byte raw scalar (decoded to 3 bytes)",
    );
  });

  it("rejects a compressed or wrong-length public point, naming its length", async () => {
    // The module comment's reasoning: "a compressed point (33 bytes,
    // 0x02/0x03) cannot be expanded without curve arithmetic, so it is
    // rejected loudly rather than producing a key that signs garbage". Six
    // rejected shapes are pinned, covering BOTH halves of the guard: the
    // first four are the wrong PREFIX (including one that is the right
    // LENGTH but announces itself compressed, which a length-only check would
    // let through), and the last two are the right prefix at the wrong
    // LENGTH, which is the half nothing used to reach.
    await expect(importVapidKey(VAPID_PRIVATE_KEY_RAW, base64UrlEncode(new Uint8Array(64)))).rejects.toThrow(
      "VAPID_PUBLIC_KEY is not a 65-byte uncompressed P-256 point (got 64 bytes)",
    );
    await expect(
      importVapidKey(VAPID_PRIVATE_KEY_RAW, base64UrlEncode(new Uint8Array([0x02, ...new Array(32).fill(1)]))),
    ).rejects.toThrow("VAPID_PUBLIC_KEY is not a 65-byte uncompressed P-256 point (got 33 bytes)");
    await expect(importVapidKey(VAPID_PRIVATE_KEY_RAW, "")).rejects.toThrow(
      "VAPID_PUBLIC_KEY is not a 65-byte uncompressed P-256 point (got 0 bytes)",
    );
    // 65 bytes, but announcing itself as a compressed point. Same message,
    // and the length in it is deliberately the real one so the reader is not
    // sent looking for a truncation that is not there.
    await expect(
      importVapidKey(VAPID_PRIVATE_KEY_RAW, base64UrlEncode(new Uint8Array([0x03, ...new Array(64).fill(1)]))),
    ).rejects.toThrow("VAPID_PUBLIC_KEY is not a 65-byte uncompressed P-256 point (got 65 bytes)");

    // ...and the OTHER half of the same guard, which the four cases above do
    // not exercise at all. Deleting `pub.length !== 65 ||` and keeping only
    // the 0x04 prefix check left every test green, because every fixture
    // above happens to begin with a byte that is not 0x04 -- the prefix half
    // fired each time and the length half was never load-bearing.
    //
    // These two start with a CORRECT 0x04, so only the length check can
    // reject them, and the 66-byte one is the case that matters: it is this
    // module's real public point with one junk byte appended, which is what
    // a mis-transcribed secret looks like. Without the length check its
    // x = pub[1..33] and y = pub[33..65] are still the true coordinates, so
    // the import SUCCEEDS and a corrupt VAPID_PUBLIC_KEY silently becomes a
    // working key -- while the same corrupt string goes into the `k=`
    // parameter (webPushCrypto.ts:197) and every push is 403'd by a service
    // that cannot match it to the signature.
    const realPoint = base64UrlDecode(VAPID_PUBLIC_KEY_B64URL);
    const oneByteLong = new Uint8Array(66);
    oneByteLong.set(realPoint);
    oneByteLong[65] = 0x99;
    expect(oneByteLong[0]).toBe(0x04);
    await expect(importVapidKey(VAPID_PRIVATE_KEY_RAW, base64UrlEncode(oneByteLong))).rejects.toThrow(
      "VAPID_PUBLIC_KEY is not a 65-byte uncompressed P-256 point (got 66 bytes)",
    );
    // Truncated, and still 0x04-prefixed: a secret cut short by a copy-paste.
    await expect(
      importVapidKey(VAPID_PRIVATE_KEY_RAW, base64UrlEncode(realPoint.subarray(0, 40))),
    ).rejects.toThrow("VAPID_PUBLIC_KEY is not a 65-byte uncompressed P-256 point (got 40 bytes)");
  });

  it("trims both secrets, turning base64UrlDecode's length-dependent luck into a guarantee", async () => {
    // The `.trim()` calls at jwt.ts:101 and :105 exist for one reason:
    // `wrangler secret put < key.txt` keeps the file's trailing newline. What
    // makes them load-bearing rather than tidy is base64UrlDecode's own
    // whitespace behaviour (see its test above), which survives or throws
    // depending on whether the whitespace happens to make the length a
    // multiple of 4. For these two secrets a lone "\n" gets through and a
    // CRLF does not -- so without the trims, whether web push works at all
    // would depend on which editor last saved the key file.
    //
    // The CRLF and the space-wrapped cases below are the ones that would
    // FAIL without the trim, so they are what this test is really for.
    for (const [priv, pub] of [
      [`${VAPID_PRIVATE_KEY_RAW}\n`, VAPID_PUBLIC_KEY_B64URL],
      [`${VAPID_PRIVATE_KEY_RAW}\r\n`, `${VAPID_PUBLIC_KEY_B64URL}\r\n`],
      [VAPID_PRIVATE_KEY_RAW, `${VAPID_PUBLIC_KEY_B64URL}\n`],
      [` ${VAPID_PRIVATE_KEY_RAW} `, `\t${VAPID_PUBLIC_KEY_B64URL}\r\n`],
    ] as const) {
      const key = await importVapidKey(priv, pub);
      expect(key.usages).toEqual(["sign"]);
    }
  });

  it("accepts a public key written in standard base64 with padding", async () => {
    // The module comment: "a VAPID key pasted from a config file may be
    // either". py_vapid writes base64url, browsers send base64url, but the
    // value is transcribed by a human at some point and standard base64 with
    // its "=" is what most tools print. Same key, so the same signature
    // verifies.
    const key = await importVapidKey(VAPID_PRIVATE_KEY_RAW, VAPID_PUBLIC_KEY_STD_B64);
    const { signature, signingInput } = segments(await signJwtEs256(key, VAPID_CLAIMS));
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await ecVerifyKey(), base64UrlDecode(signature), utf8(signingInput)),
    ).toBe(true);
  });

  it("chooses its branch on `includes(\"-----BEGIN\")` anywhere in the string, not a prefix test", async () => {
    // Untrimmed and unanchored, so leading whitespace or a stray comment line
    // above the armour still takes the PEM branch -- which is the forgiving
    // behaviour, since pemToDer strips all whitespace anyway. Pinned in both
    // directions: a leading-newline PEM imports, and a raw-looking string
    // that merely CONTAINS the marker is sent down the PEM branch and fails
    // at importKey rather than being tried as a scalar.
    const key = await importVapidKey(`\n  ${VAPID_PRIVATE_KEY_PEM}`, "");
    expect(key.usages).toEqual(["sign"]);
    await expect(importVapidKey("x-----BEGIN", "")).rejects.toThrow(expect.objectContaining({ name: "DataError" }));
    // ...and the error is NOT the raw-scalar message, which is what proves
    // the branch was taken rather than the length check happening to fire.
    await expect(importVapidKey("x-----BEGIN", "")).rejects.not.toThrow("32-byte raw scalar");

    // The negative direction, and the mutant it kills: loosening the marker
    // to `includes("BEGIN")` or `includes("-----")` left all sixty tests
    // green, because nothing asserted that a NON-PEM string containing part
    // of the marker still takes the raw branch. Both substrings are made
    // entirely of characters that are legal inside base64url -- "-" is in
    // the alphabet and "BEGIN" is five ordinary letters -- so either
    // loosening would send a perfectly good raw scalar down the PKCS#8 path
    // and turn it into "Invalid keyData". Pinned by the ERROR MESSAGE, which
    // is the only way to tell the two branches apart from outside: the
    // raw-scalar text can only come from the branch that decoded the value
    // as a scalar.
    for (const looksPemish of ["BEGINAAA", "-----AAA"]) {
      await expect(importVapidKey(looksPemish, VAPID_PUBLIC_KEY_B64URL)).rejects.toThrow(
        "VAPID_PRIVATE_KEY is neither PEM nor a 32-byte raw scalar (decoded to 6 bytes)",
      );
    }
  });

  it("rejects an RSA PEM with DataError", async () => {
    // The mirror of importRs256Key's EC test: the service-account key pasted
    // into VAPID_PRIVATE_KEY. It is a valid PKCS#8 blob, so it gets past
    // pemToDer and is caught by the curve check inside importKey.
    await expect(importVapidKey(RSA_PRIVATE_KEY_PEM, VAPID_PUBLIC_KEY_B64URL)).rejects.toThrow(
      expect.objectContaining({ name: "DataError" }),
    );
  });

  it("supports a PEM shape that Django's own pywebpush path would have REJECTED", async () => {
    // A parity note, checked by running py-vapid 1.9.4 out of the Django
    // repo's .venv on this machine rather than by reading its docs.
    //
    // This module's header says py_vapid's `Vapid.from_string()` "accepts
    // BOTH of the shapes below". It does not. from_string() strips newlines
    // and base64url-decodes the WHOLE string, headers included, then branches
    // on whether the result is 32 bytes; handed a PKCS#8 PEM it falls through
    // to from_der() and raises ValueError ("Could not deserialize key data").
    // Only Vapid.from_file() handles PEM, and pywebpush only reaches
    // from_file() when vapid_private_key is a path that os.path.isfile()
    // accepts. Django passes get_cred("VAPID_PRIVATE_KEY")
    // (notifications.py:293-298), a credential string, so from_string() is
    // the path production took.
    //
    // The behavioural consequence, which is why this is a test and not just a
    // comment: whatever VAPID_PRIVATE_KEY holds today, it must be the RAW
    // SCALAR shape, because the PEM shape never worked in Django. The PEM
    // branch here is therefore extra tolerance rather than parity -- harmless,
    // but it means a PEM pasted into that secret would start working after
    // the port when it silently did nothing before, and nobody should read a
    // green suite as evidence the two agree.
    const key = await importVapidKey(VAPID_PRIVATE_KEY_PEM, VAPID_PUBLIC_KEY_B64URL);
    expect(key.usages).toEqual(["sign"]);
    // The shape Django COULD load, still working, so the tolerance is
    // additive rather than a swap.
    const raw = await importVapidKey(VAPID_PRIVATE_KEY_RAW, VAPID_PUBLIC_KEY_B64URL);
    expect(raw.usages).toEqual(["sign"]);
  });
});

// ===================== signJwtEs256 =====================

describe("signJwtEs256", () => {
  it("writes exactly {\"alg\":\"ES256\",\"typ\":\"JWT\"} as the header", async () => {
    // RFC 8292 §2 requires ES256, and push services check the header before
    // they check anything else. The constant differs from the RS256 one in
    // four characters, which is precisely how a copy-paste between the two
    // signers would go unnoticed.
    const key = await importVapidKey(VAPID_PRIVATE_KEY_PEM, VAPID_PUBLIC_KEY_B64URL);
    const { header } = segments(await signJwtEs256(key, VAPID_CLAIMS));
    expect(header).toBe("eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(decodeSegment(header)).toBe('{"alg":"ES256","typ":"JWT"}');
    expect(header).not.toBe("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("emits the RAW 64-byte r||s pair JOSE wants, never an ASN.1 DER sequence", async () => {
    // The module's central claim, and the single most likely thing to break
    // if anyone ever ports this signing to a library: "WebCrypto's ECDSA
    // output is already the raw r||s pair JOSE wants ... not the ASN.1 DER
    // sequence OpenSSL produces". A DER signature is 70-72 bytes and begins
    // 0x30, so it can never be 64 -- and a push service handed one answers
    // 401 for every subscriber while the send loop logs and carries on.
    //
    // Sixteen signings rather than one, because r and s occasionally have a
    // leading zero byte: a DER encoder's output length VARIES with the
    // values, so a single sample could not distinguish "always 64" from
    // "64 this time". The raw form is fixed-width by definition, and that
    // fixed width is the assertion.
    const key = await importVapidKey(VAPID_PRIVATE_KEY_PEM, VAPID_PUBLIC_KEY_B64URL);
    for (let i = 0; i < 16; i++) {
      const { signature } = segments(await signJwtEs256(key, { ...VAPID_CLAIMS, exp: VAPID_CLAIMS.exp + i }));
      expect(signature).toHaveLength(86); // ceil(64 * 4 / 3)
      const bytes = base64UrlDecode(signature);
      expect(bytes).toHaveLength(64);
      // A DER SEQUENCE would start 0x30; 64 raw bytes may legitimately start
      // with anything, so this is a corroborating check on top of the length
      // rather than the load-bearing one.
      expect(bytes.length).not.toBe(70);
      expect(bytes.length).not.toBe(71);
      expect(bytes.length).not.toBe(72);
    }
  });

  it("produces a signature the subscription's own public key verifies", async () => {
    // The interop assertion. The push service verifies the `t=` token against
    // the key the browser recorded at subscribe time, i.e. against exactly
    // the 65-byte point in `k=`. Importing that point as a "raw" ECDSA key
    // and verifying with it reproduces what Mozilla does; nothing in a round
    // trip against this module's own signer would.
    const key = await importVapidKey(VAPID_PRIVATE_KEY_PEM, VAPID_PUBLIC_KEY_B64URL);
    const publicKey = await ecVerifyKey();
    const { header, payload, signature, signingInput } = segments(await signJwtEs256(key, VAPID_CLAIMS));
    const sig = base64UrlDecode(signature);
    const verify = (data: Uint8Array) =>
      crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sig, data);
    expect(await verify(utf8(signingInput))).toBe(true);
    // Same alg-confusion check as RS256: the header is inside the signature.
    expect(await verify(utf8(payload))).toBe(false);
    expect(await verify(utf8(header))).toBe(false);
    expect(await verify(utf8(`${signingInput} `))).toBe(false);
  });

  it("is NOT deterministic -- the same claims sign differently every time", async () => {
    // ECDSA picks a random k per signature, so unlike RS256 there is no JWT
    // constant to pin here, and this test says so explicitly rather than
    // leaving a reader to wonder why the two signers are tested differently.
    // It also rules out a cached-signature "optimisation": the first two
    // segments MUST be stable (they are a pure function of the claims) while
    // the third MUST move, and both halves have to verify.
    const key = await importVapidKey(VAPID_PRIVATE_KEY_PEM, VAPID_PUBLIC_KEY_B64URL);
    const publicKey = await ecVerifyKey();
    const first = segments(await signJwtEs256(key, VAPID_CLAIMS));
    const second = segments(await signJwtEs256(key, VAPID_CLAIMS));
    expect(second.signingInput).toBe(first.signingInput);
    expect(second.signature).not.toBe(first.signature);
    for (const part of [first, second]) {
      expect(
        await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          publicKey,
          base64UrlDecode(part.signature),
          utf8(part.signingInput),
        ),
      ).toBe(true);
    }
  });

  it("carries the VAPID claims through unchanged, in order", async () => {
    // RFC 8292 §2 names all three: `aud` is the push service's ORIGIN (the
    // full endpoint would leak which subscription is being pushed to and is
    // rejected), `exp` is a Unix second, `sub` is a mailto:. The exact JSON
    // is pinned because a renamed or reordered claim still signs fine and
    // fails only at the push service.
    const key = await importVapidKey(VAPID_PRIVATE_KEY_PEM, VAPID_PUBLIC_KEY_B64URL);
    const { payload } = segments(await signJwtEs256(key, VAPID_CLAIMS));
    expect(decodeSegment(payload)).toBe(
      '{"aud":"https://updates.push.services.mozilla.com","exp":1788766800,"sub":"mailto:hello@givefood.org.uk"}',
    );
  });

  it("refuses to sign with an RSA key", async () => {
    // The mix-up in the other direction from signJwtRs256's test: an
    // InvalidAccessError rather than a signature no push service accepts.
    // Caught by needWebPush.ts:134-141, which logs and skips that
    // subscriber -- notably WITHOUT deleting the row, so nothing is lost.
    const rsaKey = await importRs256Key(RSA_PRIVATE_KEY_PEM);
    await expect(signJwtEs256(rsaKey, VAPID_CLAIMS)).rejects.toThrow(
      expect.objectContaining({ name: "InvalidAccessError" }),
    );
  });

  it("stays inside the base64url alphabet across many signings", async () => {
    // ECDSA signatures are effectively random bytes, so roughly one in every
    // few contains a sextet that standard base64 would spell "+" or "/". A
    // JWS with either in it is malformed, and the VAPID header's grammar
    // ("vapid t=<jwt>, k=<key>") breaks outright on a "/". One sample is not
    // enough to notice a half-done substitution; thirty-two is.
    const key = await importVapidKey(VAPID_PRIVATE_KEY_RAW, VAPID_PUBLIC_KEY_B64URL);
    for (let i = 0; i < 32; i++) {
      const jwt = await signJwtEs256(key, { ...VAPID_CLAIMS, exp: VAPID_CLAIMS.exp + i });
      expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    }
  });
});

// ===================== the two assertions these primitives build =====================

describe("the two credentials these primitives are wired into", () => {
  it("needFirebase.ts: a service-account assertion addressed to the TOKEN endpoint", async () => {
    // getAccessToken() (needFirebase.ts:67-112) builds these five claims and
    // POSTs the result to oauth2.googleapis.com with
    // grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer. Unlike
    // vapidAuthorizationHeader below, that function is NOT exported and
    // cannot be reached without a fetch double and an Env, so the claim set
    // is reconstructed here rather than called -- stated plainly because a
    // reconstruction only pins what these primitives do with those claims,
    // not that needFirebase.ts still passes them. Its own suite owns that.
    // Reproduced anyway so the claim set and the signature are pinned as one
    // unit:
    // `aud` in particular must be the token endpoint being POSTed to and NOT
    // the FCM API being called, which is the mistake that produces an
    // "invalid_grant" nobody sees.
    const nowSec = 1788723600;
    const key = await importRs256Key(RSA_PRIVATE_KEY_PEM);
    const jwt = await signJwtRs256(key, {
      iss: "givefood@givefood-uk.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600,
    });
    const { payload, signature, signingInput } = segments(jwt);
    const claims = JSON.parse(decodeSegment(payload)) as Record<string, unknown>;
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.aud).not.toBe("https://fcm.googleapis.com/");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(claims.iss).toBe("givefood@givefood-uk.iam.gserviceaccount.com");
    // One hour of validity, which is also what needFirebase.ts caches the
    // resulting access token for (minus 60 seconds of slack, line 110).
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600);
    expect(
      await crypto.subtle.verify("RSASSA-PKCS1-v1_5", await rsaVerifyKey(), base64UrlDecode(signature), utf8(signingInput)),
    ).toBe(true);
  });

  it("webPushCrypto.ts: a VAPID header whose t= verifies and whose k= is canonical base64url", async () => {
    // The REAL vapidAuthorizationHeader() (webPushCrypto.ts:182-199), called
    // rather than reassembled. An earlier version of this test rebuilt the
    // header from its parts here, which meant it asserted the correctness of
    // a copy living in this file: it would have stayed green if the shipped
    // function had been deleted, or had started advertising a different key
    // in `k=` from the one that signed `t=`. Since webPushCrypto.ts imports
    // nothing but ./jwt, calling the real thing costs nothing and the two
    // halves of the header are checked as the push service checks them.
    //
    // Those halves have to agree: `t=` is signed by the private key and `k=`
    // advertises the public one, and a service that cannot match them answers
    // 403 per subscriber -- logged once each by needWebPush.ts:164 and
    // surfaced nowhere.
    //
    // The `k=` round trip through base64UrlDecode/base64UrlEncode inside that
    // function is not a no-op: it CANONICALISES the operator's secret. The
    // padded standard-base64 spelling is passed in for exactly that reason --
    // stored verbatim it would break the "vapid t=..., k=..." grammar on its
    // "/" and "=" characters.
    const nowMs = 1788723600_000;
    const endpoint = "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABsecret-token";
    const key = await importVapidKey(VAPID_PRIVATE_KEY_RAW, VAPID_PUBLIC_KEY_B64URL);
    const header = await vapidAuthorizationHeader(
      key,
      VAPID_PUBLIC_KEY_STD_B64,
      endpoint,
      "mailto:hello@givefood.org.uk",
      nowMs,
    );
    // Parsed back out of the header rather than kept from before it, so the
    // assertions below are about what actually goes on the wire.
    const [, jwt = "", k = ""] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];

    // The audience is the ORIGIN only: no path, so the subscription's secret
    // token never appears in the assertion.
    const { payload, signature, signingInput } = segments(jwt);
    const claims = JSON.parse(decodeSegment(payload)) as Record<string, unknown>;
    expect(claims.aud).toBe("https://updates.push.services.mozilla.com");
    expect(claims.aud).not.toContain("gAAAAAB");
    // pywebpush's own 12-hour default, which Django never overrides.
    expect(claims.exp).toBe(1788723600 + 43200);
    expect(claims.sub).toBe("mailto:hello@givefood.org.uk");

    expect(k).toBe(VAPID_PUBLIC_KEY_B64URL);
    expect(k).not.toContain("=");
    expect(k).not.toContain("+");
    expect(k).not.toContain("/");
    expect(header).toMatch(/^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]+$/);

    // ...and the two halves genuinely belong together: the key in `k=`
    // verifies the token in `t=`.
    const advertised = await crypto.subtle.importKey(
      "raw",
      base64UrlDecode(k),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, advertised, base64UrlDecode(signature), utf8(signingInput)),
    ).toBe(true);
  });
});
