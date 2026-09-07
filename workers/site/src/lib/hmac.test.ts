import { describe, expect, it } from "vitest";
import { hmacSha256Hex, hmacSha256HexBytes, timingSafeEqual } from "./hmac";

// This is the only cryptographic primitive in workers/site, and all three of
// the site's authentication boundaries are built directly on top of it:
//
//   lib/csrf.ts        signs the __Host-csrf double-submit token
//   lib/adminAuth.ts   signs the __Host-oauth state/PKCE cookie
//   routes/whatsappHook.ts  verifies Meta's X-Hub-Signature-256
//
// Every one of those FAILS CLOSED AND SILENTLY when this module is wrong:
// verifyCsrf() returns false (a 403 on Save with nothing logged),
// verifyOAuthCookie() returns null (the sign-in bounces back to /auth/), and
// whatsappHook still answers Meta with a 200 by design. There is no crash and
// no stack trace anywhere to point at the cause -- which is exactly why the
// tests below assert EXACT known-answer digests rather than round-tripping
// the implementation against itself. A round-trip test stays green if the
// hash silently becomes SHA-1, or if the hex encoding stops zero-padding;
// Meta's signature would then never match again and the suite would not say
// so.
//
// Ancestry: unlike most of workers/site/src/lib, this has NO Django original.
// Nothing in /Users/jasoncartwright/Sites/foodcharity computes an HMAC at all
// -- CsrfViewMiddleware is commented out in production (settings.py:97), and
// whatsapp_hook (givefood/views.py:1331, decorated @csrf_exempt) has no
// X-Hub-Signature-256 check whatsoever. Both hmac.ts and its callers are
// hardening added during the port, so there is no Django behaviour to match
// here; the external contract is instead RFC 2104 / RFC 4231 (so that Meta's
// own HMAC agrees with ours), and the two vectors named "RFC 4231" below are
// taken straight from that RFC.
//
// Provenance of the OTHER hard-coded digests -- the ones for this site's own
// secrets and bodies, which no RFC publishes: every one was computed with an
// INDEPENDENT HMAC implementation (Node's OpenSSL-backed
// `crypto.createHmac("sha256", ...)`, which shares no code with the
// WebCrypto path hmac.ts uses) and only then pasted here. That distinction is
// the whole point: a digest captured by running hmac.ts and pasting whatever
// it printed is a round trip wearing a known-answer costume, and it would
// bless a broken implementation forever. Anyone adding a vector here must
// generate it the same way, from something that is not this module.
//
// The one place Django DID have an equivalent, whatsapp_hook's
// `token == verify_token`, is a plain Python string compare -- an early-exit
// comparison. timingSafeEqual() is the deliberate upgrade over that, and its
// tests below pin the properties that make it one.

// Real ArrayBuffer of the UTF-8 bytes of `s`. TextEncoder returns a view,
// and handing crypto.subtle a view's `.buffer` would sign the whole
// underlying allocation rather than just these bytes -- so slice to exactly
// the string's own bytes, the way c.req.arrayBuffer() hands over exactly the
// request body.
function utf8Buffer(s: string): ArrayBuffer {
  const view = new TextEncoder().encode(s);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function rawBuffer(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe("hmacSha256Hex", () => {
  it("matches RFC 4231's published HMAC-SHA-256 test vectors", () => {
    // The interop test, and the reason it is a hard-coded constant rather
    // than a round trip: Meta computes X-Hub-Signature-256 with its own
    // library, so ours must agree with the standard, not merely with itself.
    // Test Case 2 -- key "Jefe", data "what do ya want for nothing?".
    return expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).resolves.toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("handles a key made of non-printable bytes (RFC 4231 Test Case 1)", async () => {
    // Test Case 1's key is twenty 0x0b bytes. Secrets here arrive as Worker
    // secret strings, so the key path is `new TextEncoder().encode(secret)`;
    // U+000B encodes to a single 0x0b byte, so this exercises the standard
    // vector through the real string-keyed API. It also proves the secret is
    // never trimmed, upper/lower-cased or otherwise "cleaned" on the way in.
    await expect(hmacSha256Hex("\x0b".repeat(20), "Hi There")).resolves.toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("always returns exactly 64 lowercase hex characters, over a wide sweep of inputs", async () => {
    // 32 bytes of SHA-256, two hex digits each. csrf.ts stores this after a
    // "." in a cookie and adminAuth.ts does the same, and both compare it
    // with timingSafeEqual -- which returns false on ANY length difference.
    // So a digest that is even one character short is a permanent 403.
    //
    // "Always" is the claim, so this sweeps 256 different messages rather
    // than sampling four. That matters because the way this invariant breaks
    // -- dropping toHex()'s `.padStart(2, "0")` -- is INPUT-DEPENDENT: a
    // digest is only short if it happens to contain a byte below 0x10, so a
    // handful of hand-picked messages can miss it entirely and ship.
    const sweep = await Promise.all(Array.from({ length: 256 }, (_, i) => hmacSha256Hex("CSRF_SECRET", `sweep-${i}`)));
    const fixtures = await Promise.all([
      hmacSha256Hex("CSRF_SECRET", "token-14"),
      hmacSha256Hex("CSRF_SECRET", "pad-30"),
      hmacSha256Hex("s3cret", ""),
      hmacSha256Hex("k", "a".repeat(10_000)),
      hmacSha256HexBytes("s3cret", rawBuffer(0x00, 0xff)),
    ]);
    for (const digest of [...sweep, ...fixtures]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }

    // ...and prove the sweep genuinely exercises the pad rather than passing
    // by luck: count the digests that contain at least one byte below 0x10
    // (a "0" at an even index). Those are exactly the digests an unpadded
    // toHex() would return short. 216 of the 256 qualify today; the loose
    // bound keeps this honest without pinning SHA-256's output distribution.
    const wouldBeShortUnpadded = sweep.filter((d) => [...d].some((ch, i) => i % 2 === 0 && ch === "0")).length;
    expect(wouldBeShortUnpadded).toBeGreaterThan(150);
  });

  it("signs a message far larger than SHA-256's block size", async () => {
    // 10,000 bytes is ~157 SHA-256 blocks, so this pins the whole multi-block
    // path rather than the single-block one every short fixture above takes.
    // Pinned as a known answer, not just a length check: a wrong chunking or
    // a message silently truncated to the first block would still return 64
    // valid-looking hex characters and pass a shape assertion.
    await expect(hmacSha256Hex("k", "a".repeat(10_000))).resolves.toBe(
      "fb00cf150df001302509bdde3f7484e386438e5e5967686ba44fc37ee3e85c23",
    );
  });

  it("crosses SHA-256's length-padding boundary, where one extra byte costs a whole extra block", async () => {
    // Message-side companion to the key-side block test below, and the gap
    // between this file's other fixtures: they jump from ~10 bytes straight to
    // 10,000, so nothing pins the one message length where the block count
    // actually changes.
    //
    // HMAC hashes ipad(64 bytes) || message, and SHA-256 appends a 1 byte plus
    // an 8-byte length field. So 64+55+9 = 128 lands exactly on two blocks,
    // and 56 bytes forces a third. That off-by-one is the classic place a hash
    // implementation breaks while every other length keeps working, and 55/56
    // are the exact inputs that catch it. Known answers, because a wrong block
    // count still returns 64 well-formed hex characters.
    await expect(hmacSha256Hex("s3cret", "a".repeat(55))).resolves.toBe(
      "8f8e98b0486915740d92ed0406b03760b24b5c42187083c9c3675f17c6fedd06",
    );
    await expect(hmacSha256Hex("s3cret", "a".repeat(56))).resolves.toBe(
      "43ba763a16d9b18ab9b367540ff1190be5bc51852b0435815db495488ba2378a",
    );
    // And either side of a plain block multiple, for good measure.
    await expect(hmacSha256Hex("s3cret", "a".repeat(64))).resolves.toBe(
      "d774b85efbec57b2c5ebdc540c03e8177349fbcafe929b3574ddf72d739679e5",
    );
    await expect(hmacSha256Hex("s3cret", "a".repeat(65))).resolves.toBe(
      "344b52c9bd77d070691a9bb7c0b01ede0d42e8cc29fa665290d9ea7dd838d7fa",
    );
  });

  it("hashes a secret longer than the 64-byte HMAC block, per RFC 2104", async () => {
    // RFC 2104 requires a key longer than the block size to be hashed down to
    // 32 bytes first, and WebCrypto does that for us. Worth pinning because
    // Worker secrets are free-form strings -- SESSION_HMAC_KEY and
    // CSRF_SECRET are whatever `wrangler secret put` was fed, easily over 64
    // characters -- and if this step ever diverged from what Meta's library
    // does, only the long-secret deployments would break.
    await expect(
      hmacSha256Hex("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567", "Test Using Larger Than Block-Size Key"),
    ).resolves.toBe("41a4d9276a8883ae72a220d7cfdc4032113860a286409665d87b04278bfbb201");

    // The block boundary itself: 64 bytes is used as-is, 65 is hashed first,
    // so the two must not collide (they would if a truncating key path ever
    // crept in, which would make every 65+-character secret equivalent to its
    // first 64 characters -- a silent loss of entropy nothing else detects).
    const key64 = await hmacSha256Hex("k".repeat(64), "boundary");
    const key65 = await hmacSha256Hex("k".repeat(65), "boundary");
    expect(key64).toBe("5a1af747e37d07140ec0b58fa01f85d1b3f0aeef2f6719091e9517e8b474a978");
    expect(key65).toBe("ef3f1f0b6c378507c6cd325246f1e48412bbceab9e755d485dc639946cfe3785");
    expect(key65).not.toBe(key64);
  });

  it("zero-pads bytes below 0x10 instead of emitting a single hex digit", async () => {
    // The specific bug the `.padStart(2, "0")` in toHex() exists to prevent,
    // and the reason it needs a test of its own: dropping the pad still
    // produces a plausible-looking hex string, just a shorter one, and only
    // for the ~1-in-8 secrets whose digest happens to contain a low byte.
    // It would pass a casual round-trip test (both sides drop the same pad)
    // and then fail against Meta's signature in production, intermittently.
    //
    // `pad-30` was chosen because its digest STARTS 0x00: an unpadded
    // implementation would return a 62-character string beginning "bdc9".
    await expect(hmacSha256Hex("CSRF_SECRET", "pad-30")).resolves.toBe(
      "00bdc9914338f81e3ed86b6284890bd28bacde882bdfdb5fdf1c47298dda30a5",
    );
    // And a leading 0x0f, so the very first digit alone is the padding.
    await expect(hmacSha256Hex("CSRF_SECRET", "token-14")).resolves.toBe(
      "0fa4af28321c16d2aff139070aa0d55db15e1d4272bce59f30ead2e0bfd27272",
    );
  });

  it("is deterministic -- the same secret and message always sign the same", async () => {
    // csrf.ts's issueCsrfToken() re-derives the signature of a cookie it
    // minted on an earlier request, possibly on a different Worker isolate in
    // a different colo, and compares it to what the browser sent back. Any
    // per-call randomness or per-isolate state would make a token minted on
    // one request unverifiable on the next, which is a 403 on Save that
    // reproduces only sometimes.
    const first = await hmacSha256Hex("CSRF_SECRET", "1a2b3c4d5e6f");
    const second = await hmacSha256Hex("CSRF_SECRET", "1a2b3c4d5e6f");
    expect(second).toBe(first);
    expect(await hmacSha256Hex("CSRF_SECRET", "1a2b3c4d5e6f")).toBe(first);
  });

  it("imports a fresh key per call, so CONCURRENT signings under different secrets cannot cross-contaminate", async () => {
    // The hole every other test in this file leaves open, and the reason it
    // is worth its own test: a single Worker isolate serves many requests at
    // once, so an admin Save signing with CSRF_SECRET and a Meta webhook
    // verifying with WHATSAPP_APP_SECRET genuinely are in flight together, on
    // one isolate, through the SAME importHmacKey(). Today that is safe
    // because importHmacKey() re-imports per call and holds no module state.
    //
    // The plausible wrong version is not a typo, it is a performance "fix":
    // memoising the CryptoKey in a module-level variable, or caching the
    // in-flight importKey() promise. Every sequential test here would stay
    // green -- the different-secret test below signs one AFTER the other, so
    // a single-slot cache is refilled in between and never observed stale --
    // while under Promise.all the later secret would silently borrow the
    // earlier one's key. The result is a digest computed under the wrong
    // secret: CSRF tokens that verify against the WhatsApp secret and vice
    // versa, intermittently, under load only, on production traffic patterns
    // no sequential test reproduces.
    //
    // Deliberately interleaved (no two adjacent entries share a secret) and
    // checked against the known answers rather than merely asserting "they
    // all differ" -- a cross-contaminated digest is a WRONG known value, and
    // "all different from each other" would happily accept it. Both doors are
    // in the mix because both share importHmacKey(), which is the one piece of
    // surface a cache would be added to.
    const [jefe, pad30, empty, token14, cle, waBody, abc] = await Promise.all([
      hmacSha256Hex("Jefe", "what do ya want for nothing?"),
      hmacSha256Hex("CSRF_SECRET", "pad-30"),
      hmacSha256Hex("s3cret", ""),
      hmacSha256Hex("CSRF_SECRET", "token-14"),
      hmacSha256Hex("clé-secrète", "message"),
      hmacSha256HexBytes("appsecret", utf8Buffer('{"object":"whatsapp_business_account","entry":[{"id":"123"}]}')),
      hmacSha256HexBytes("s3cret", rawBuffer(0x61, 0x62, 0x63)),
    ]);
    expect(jefe).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    expect(pad30).toBe("00bdc9914338f81e3ed86b6284890bd28bacde882bdfdb5fdf1c47298dda30a5");
    expect(empty).toBe("91dfac70c5348b04e1babb8b421ac92cec08b565b49ca16130dccb72503647b7");
    expect(token14).toBe("0fa4af28321c16d2aff139070aa0d55db15e1d4272bce59f30ead2e0bfd27272");
    expect(cle).toBe("cf36de18e0592fdd27b8ab2d9fb259b933f8d372ceab0d2fa695bc7c5be52e55");
    expect(waBody).toBe("677ff225957f3673a4b9d5fea8fa4d148e4489267c4ce457271e60be7256b44e");
    expect(abc).toBe("4f2f30aaf4a57bd60ab473c8e9c2cdfefc186723d4727ed6f31f04353c91389a");

    // And the same values again when each is computed alone, so the assertion
    // above is about concurrency rather than about these vectors being right.
    expect(await hmacSha256Hex("CSRF_SECRET", "pad-30")).toBe(pad30);
    expect(await hmacSha256Hex("clé-secrète", "message")).toBe(cle);
  });

  it("produces a completely different digest for a different secret", async () => {
    // The whole security claim of the signed double-submit token in csrf.ts:
    // "even if an attacker tosses an arbitrary cookie via a sibling
    // subdomain, they can't produce one that verifies without CSRF_SECRET".
    // If the secret were ignored -- e.g. importHmacKey() built the key from a
    // constant after a refactor -- every call site would still round-trip
    // happily and every forged cookie would verify.
    const withSecret = await hmacSha256Hex("CSRF_SECRET", "same-message");
    const withOther = await hmacSha256Hex("csrf_secret", "same-message");
    expect(withOther).not.toBe(withSecret);
    expect(await hmacSha256Hex("CSRF_SECRE", "same-message")).not.toBe(withSecret);
    // Secrets are compared byte-for-byte, so case matters and a stray
    // trailing space in a `wrangler secret put` is a total mismatch, not a
    // near-miss.
    expect(await hmacSha256Hex("CSRF_SECRET ", "same-message")).not.toBe(withSecret);

    // "Completely different", not merely "different" -- the same avalanche
    // check the message-tamper test below applies, but on the KEY side. A
    // truncating or prefix-only key path (say a refactor that fed
    // importHmacKey only the first n bytes) would still change the digest
    // somewhere, so `not.toBe` alone is too weak to notice it.
    const sharedWithOther = [...withSecret].filter((ch, i) => ch === withOther[i]).length;
    expect(sharedWithOther).toBeLessThan(32); // ~4 expected by chance out of 64

    // And the secret is never falsy-tested, trimmed or normalised on the way
    // in: a one-character NUL is a perfectly good one-byte key, distinct from
    // a one-character space. (Only a ZERO-length secret is special -- see the
    // rejection test below. If importHmacKey() ever grew a `secret.trim()`,
    // this pair would collapse into one digest.)
    await expect(hmacSha256Hex("\u0000", "message")).resolves.toBe("eb08c1f56d5ddee07f7bdf80468083da06b64cf4fac64fe3a90883df5feacae4");
    await expect(hmacSha256Hex(" ", "message")).resolves.toBe("a82560074f8f1acc5258257652ff434bec48019c9a95c515cf48390e50b2d249");
  });

  it("produces a completely different digest for a one-character message change", async () => {
    // Tamper detection: an attacker who edits the raw token in the cookie but
    // keeps the signature must not verify. Asserted as "differs in most of
    // its digits" rather than merely "differs", because a truncating or
    // prefix-only implementation would still differ somewhere.
    const original = await hmacSha256Hex("CSRF_SECRET", "1a2b3c4d5e6f");
    const tampered = await hmacSha256Hex("CSRF_SECRET", "1a2b3c4d5e6e");
    expect(tampered).not.toBe(original);
    const shared = [...original].filter((ch, i) => ch === tampered[i]).length;
    expect(shared).toBeLessThan(32); // ~4 expected by chance out of 64
  });

  it("signs an empty MESSAGE happily -- only the empty secret is special", async () => {
    // A zero-length message is ordinary input (an empty POST body reaches
    // hmacSha256HexBytes on every `curl -X POST` at the public webhook), and
    // must produce a normal digest rather than an error or a sentinel.
    await expect(hmacSha256Hex("s3cret", "")).resolves.toBe("91dfac70c5348b04e1babb8b421ac92cec08b565b49ca16130dccb72503647b7");
  });

  it("REJECTS a zero-length secret instead of signing with an empty key", async () => {
    // Surprising, load-bearing, and not obvious from reading hmac.ts: this
    // does NOT return a digest for an empty secret, it returns a rejected
    // promise. WebCrypto's HMAC importKey step is specified to throw a
    // DataError when the key data is zero-length, so `crypto.subtle
    // .importKey(...)` inside importHmacKey() rejects before any signing
    // happens. (Spec behaviour, so workerd rejects here exactly as node does
    // -- this is not an artefact of the test environment's crypto.)
    //
    // Nothing in this module catches it, and neither issueCsrfToken() nor
    // verifyCsrf() nor handleGoogleOAuthCallback() wraps its call in a
    // try/catch -- so if an empty secret ever reached here, an admin page
    // would 500 rather than fail closed. It cannot today: all three call
    // sites test the secret for falsiness first (csrf.ts lines 41 and 85,
    // adminAuth.ts lines 317 and 345, whatsappHook.ts verifySignature), and
    // "" is falsy. This test pins the reject so those guards are understood
    // as the thing preventing a 500, not merely as tidy logging.
    // Pinned by the spec's error NAME, not just "it threw something": a bare
    // `rejects.toThrow()` would stay green if a future refactor made this
    // reject for an entirely unrelated reason (a TypeError from passing the
    // wrong shape to importKey, say), which would ALSO break every non-empty
    // secret and yet leave this test looking satisfied. The message text is
    // deliberately not asserted -- it is engine wording, and workerd's need
    // not match node's; `name === "DataError"` is the part WebCrypto specifies.
    await expect(hmacSha256Hex("", "any message")).rejects.toThrow(expect.objectContaining({ name: "DataError" }));
    await expect(hmacSha256HexBytes("", utf8Buffer("any message"))).rejects.toThrow(expect.objectContaining({ name: "DataError" }));
    // A one-character secret is fine, so it really is only zero length -- and
    // it is a real digest, so the rejection above is about the key length
    // rather than about this module being broken for every input.
    await expect(hmacSha256Hex("k", "any message")).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats an UNDEFINED secret as zero-length, but a NULL one as the literal four-byte key \"null\"", async () => {
    // The sharp edge hiding behind the test above. Its safety argument is
    // "all three call sites test the secret for falsiness first, and '' is
    // falsy" -- true, but it quietly assumes every falsy secret behaves like
    // "". They do not, and the difference is the difference between a 500 and
    // a silent forgery.
    //
    // TextEncoder.encode()'s parameter is an optional USVString defaulting to
    // "", so `undefined` encodes to ZERO bytes and importKey rejects exactly
    // as the empty string does -- loud, and impossible to miss.
    await expect(hmacSha256Hex(undefined as unknown as string, "message")).rejects.toThrow(
      expect.objectContaining({ name: "DataError" }),
    );

    // `null` is NOT an omitted argument, so it is stringified by the ordinary
    // USVString conversion into the four characters n-u-l-l. That is a
    // perfectly valid HMAC key, so this SIGNS, silently, under a key that is
    // written down in this comment and known to the whole world. Every token
    // it produces is forgeable by anyone.
    //
    // Unreachable today (nothing passes null; `c.env.*` is string | undefined
    // and every call site short-circuits on falsy first), and pinned so it
    // stays that way: the failure it guards against is a future call site
    // written as `hmacSha256Hex(secret ?? null, ...)` or a secret sourced from
    // JSON, which would fail CLOSED-looking while actually failing WIDE OPEN.
    await expect(hmacSha256Hex(null as unknown as string, "message")).resolves.toBe(
      "5db798fa4e9482b8dad629c52b37d8522a325239bb8cdba9ddcb7266dd8ffef5",
    );
    // Identical to spelling that key out -- which is the whole point.
    expect(await hmacSha256Hex(null as unknown as string, "message")).toBe(await hmacSha256Hex("null", "message"));
  });

  it("signs the UTF-8 bytes of the message, not its UTF-16 code units", async () => {
    // The string-in API is documented as being for "a freshly-minted hex
    // token ... always valid UTF-8 by construction", but adminAuth.ts also
    // feeds it a base64url JSON blob whose `next` path can carry a food bank
    // name, and food bank names on this site contain accents and dashes. If
    // the encoding ever became UTF-16 or latin1 these vectors change, and
    // Meta -- which signs UTF-8 bytes -- would disagree with us forever.
    await expect(hmacSha256Hex("s3cret", "caffè £5 — 🍞")).resolves.toBe(
      "1c4858cc370bc132812c7325c51fbf63978daafc0d41deaf121d67de8e314344",
    );
    // Same on the key side: a non-ASCII secret is UTF-8 encoded too.
    await expect(hmacSha256Hex("clé-secrète", "message")).resolves.toBe(
      "cf36de18e0592fdd27b8ab2d9fb259b933f8d372ceab0d2fa695bc7c5be52e55",
    );
  });

  it("is LOSSY for a lone surrogate -- the string door's own U+FFFD trap", async () => {
    // The mirror image of the invalid-UTF-8 hazard hmacSha256HexBytes was
    // written for, and the case this module's comment does NOT mention: an
    // unpaired surrogate has no UTF-8 encoding, so TextEncoder substitutes
    // U+FFFD before signing. A lone high surrogate, a lone low surrogate and
    // a literal U+FFFD therefore all collapse to the same digest.
    //
    // Harmless at today's call sites -- csrf.ts signs its own hex token and
    // adminAuth.ts signs base64url, both ASCII by construction -- and pinned
    // exactly so that stays a deliberate fact rather than an accident. The
    // day anything signs a user-supplied string through this door, three
    // different inputs collide and a signature over one verifies another.
    const loneHigh = await hmacSha256Hex("s3cret", "\ud83c");
    const loneLow = await hmacSha256Hex("s3cret", "\udf5e");
    const replacement = await hmacSha256Hex("s3cret", "\ufffd");
    expect(loneHigh).toBe("0c689757846c5e622cff830f0ed2bf60960aee682fc3e6734b39ccd93a120685");
    expect(loneLow).toBe(loneHigh);
    expect(replacement).toBe(loneHigh);
    // A properly PAIRED surrogate is not lossy -- it encodes to its real four
    // UTF-8 bytes -- so the loss above is specifically about unpaired halves.
    await expect(hmacSha256Hex("s3cret", "\ud83c\udf5e")).resolves.toBe(
      "bdaa356ab2a9f0d538a0df87a8792995385e8ef7a1753558f9d7fb1510ca4977",
    );
  });

  it("is LOSSY for a lone surrogate in the SECRET too -- three different secrets, one key", async () => {
    // The mirror of the test above, on the side that matters more. A message
    // collision means two inputs share a signature; a KEY collision means two
    // different secrets are the same secret -- anyone holding either can forge
    // for the other. Same mechanism (TextEncoder substitutes U+FFFD for an
    // unpaired surrogate before importHmacKey sees the bytes), and untested
    // until now purely because the message door is the one the module comment
    // talks about.
    //
    // Reachable the day a secret is ever round-tripped through something that
    // can truncate UTF-16 -- a `wrangler secret put` fed a sliced string, or a
    // secret copied out of a JSON blob cut to a length limit. Every such
    // mangled secret collapses onto the SAME key as every other one, and as
    // the literal replacement character. Pinned as an exact digest, not just
    // "they are equal", so the shared value is named: equality alone would
    // also hold if the key were being ignored entirely.
    const loneHighKey = await hmacSha256Hex("\ud83c", "message");
    expect(loneHighKey).toBe("e9fe8ff4290be56da44a556269c0967083fed4c4f28ac96bf87f60183141e9ec");
    expect(await hmacSha256Hex("\udf5e", "message")).toBe(loneHighKey);
    expect(await hmacSha256Hex("\ufffd", "message")).toBe(loneHighKey);
    // A properly paired surrogate is a real four-byte key, distinct from the
    // collapsed one -- so this is specifically about unpaired halves, not
    // about non-ASCII secrets being broken in general.
    await expect(hmacSha256Hex("🍞", "message")).resolves.toBe(
      "49f24843f82eceee7348fe86ffbdcd1112e230efc9bba44321ba333d6fb739ab",
    );
  });

  it("does not Unicode-normalise the message -- NFC and NFD sign differently", async () => {
    // Two spellings of "café" that render identically on screen: precomposed
    // U+00E9, and "e" + combining acute. They are different bytes, so they
    // must be different signatures. Asserted rather than assumed because a
    // `.normalize("NFC")` is precisely the sort of tidy-up a later
    // contributor adds to a string path -- and if the two ever collided, a
    // signed value could be respelled in transit without detection.
    // (It also matches the Python side of the port: `==` on str normalises
    // nothing either, so no parity was lost here.)
    const nfc = await hmacSha256Hex("s3cret", "caf\u00e9");
    const nfd = await hmacSha256Hex("s3cret", "cafe\u0301");
    expect(nfc).toBe("45e4f32b64a8c64e6719323c8822113f38aa8832302761fbb64b85aa0d956e4f");
    expect(nfd).toBe("f21cdbc6caa7aa7b2ee4adbca4dd5b9a54969267795c6ed971d4fb40e9fc8ae6");
    expect(nfd).not.toBe(nfc);
  });

  it("agrees with hmacSha256HexBytes for any message that is valid UTF-8", async () => {
    // The two exports must be one primitive with two front doors. The bytes
    // variant exists only to avoid a lossy decode (see its own tests below),
    // NOT to be a different algorithm -- so wherever the round trip is
    // lossless they must be indistinguishable, and a future change to one
    // must move the other.
    for (const message of ["", "abc", "Hi There", '{"object":"whatsapp_business_account"}', "caffè 🍞"]) {
      expect(await hmacSha256Hex("s3cret", message)).toBe(await hmacSha256HexBytes("s3cret", utf8Buffer(message)));
    }
  });
});

describe("hmacSha256HexBytes", () => {
  it("matches the same RFC 4231 vector when given the message as bytes", async () => {
    // Anchored to the standard independently of the string variant, so that
    // "they agree with each other" above cannot be satisfied by both being
    // wrong in the same way.
    await expect(hmacSha256HexBytes("Jefe", utf8Buffer("what do ya want for nothing?"))).resolves.toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("verifies over the exact bytes even when they are not valid UTF-8", async () => {
    // THE reason this export exists, quoted from the module comment:
    // decoding an attacker-reachable body to a string and re-encoding it
    // "would lose fidelity if the raw bytes ever contained an invalid UTF-8
    // sequence (decode replaces it with U+FFFD, so the re-encoded bytes fed
    // to HMAC would differ from what was actually signed)".
    //
    // This test makes that concrete. 0xff and 0xfe cannot appear in valid
    // UTF-8; TextDecoder turns each into U+FFFD, which re-encodes to three
    // bytes (ef bf bd), so the lossy path signs 13 bytes where Meta signed 9.
    const rawBytes = rawBuffer(0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0xfe, 0x22, 0x7d);
    const overRawBytes = await hmacSha256HexBytes("appsecret", rawBytes);
    expect(overRawBytes).toBe("dc1014af95311d076d090680e0fe03f636829be110782125f5f40c531c3fdf6a");

    // What whatsappHook.ts would have computed had it used c.req.text():
    // a different digest, so every such request would be rejected as a
    // signature mismatch -- answered 200, logged once, and invisible.
    const lossy = new TextDecoder().decode(rawBytes);
    expect(lossy).toContain("\ufffd");
    const overLossyRoundTrip = await hmacSha256Hex("appsecret", lossy);
    expect(overLossyRoundTrip).toBe("e55554e44ba33f482b1c0210ce3f82ca22017f658ec5b5515b6bd452e609e2a7");
    expect(overLossyRoundTrip).not.toBe(overRawBytes);
  });

  it("is binary-safe: a NUL byte neither terminates nor is stripped from the message", async () => {
    // A request body is arbitrary bytes. If anything on the path to
    // crypto.subtle ever went through a C-style string, a body would be
    // signed only up to its first NUL -- an attacker could then append
    // whatever they liked after one and keep a valid signature.
    const abc = await hmacSha256HexBytes("s3cret", rawBuffer(0x61, 0x62, 0x63));
    expect(abc).toBe("4f2f30aaf4a57bd60ab473c8e9c2cdfefc186723d4727ed6f31f04353c91389a");
    // Trailing NUL must change the digest...
    await expect(hmacSha256HexBytes("s3cret", rawBuffer(0x61, 0x62, 0x63, 0x00))).resolves.toBe(
      "d08b6fa972db3c38ce2b25250090c8251df707b060d959f34ee6caf9c6cf9040",
    );
    // ...and an embedded NUL must not truncate to "a".
    const embedded = await hmacSha256HexBytes("s3cret", rawBuffer(0x61, 0x00, 0x62));
    expect(embedded).toBe("0995cfa8400d1400579d7d28729161190856258450ced83ffa80683be0287638");
    expect(embedded).not.toBe(await hmacSha256HexBytes("s3cret", rawBuffer(0x61)));
  });

  it("signs a zero-length body without throwing", async () => {
    // A POST with no body at all is trivially reachable on this public,
    // unauthenticated endpoint (`curl -X POST` with a made-up signature
    // header). handleInbound() has no guard for it -- it reads
    // c.req.arrayBuffer() and signs whatever comes back -- so an empty buffer
    // must produce a normal digest that simply fails to match, not an
    // exception that escapes to the global error handler and breaks the
    // always-200 contract PLAN.md requires.
    await expect(hmacSha256HexBytes("s3cret", new ArrayBuffer(0))).resolves.toBe(
      "91dfac70c5348b04e1babb8b421ac92cec08b565b49ca16130dccb72503647b7",
    );
    // Identical to signing the empty string through the other door.
    expect(await hmacSha256HexBytes("s3cret", new ArrayBuffer(0))).toBe(await hmacSha256Hex("s3cret", ""));
  });

  it("produces a different digest for a different app secret", async () => {
    // The WHATSAPP_APP_SECRET / WHATSAPP_TOKEN mix-up the whatsappHook.ts
    // comment warns about at length ("getting it wrong FAILS CLOSED AND
    // SILENTLY"). Nothing in this module can detect the mix-up -- this test
    // just pins that the secret genuinely participates, which is what makes
    // the mismatch detectable at all.
    const body = utf8Buffer('{"object":"whatsapp_business_account","entry":[{"id":"123"}]}');
    expect(await hmacSha256HexBytes("appsecret", body)).toBe("677ff225957f3673a4b9d5fea8fa4d148e4489267c4ce457271e60be7256b44e");
    expect(await hmacSha256HexBytes("an-access-token", body)).not.toBe(
      "677ff225957f3673a4b9d5fea8fa4d148e4489267c4ce457271e60be7256b44e",
    );
  });

  it("also accepts a typed-array view at runtime, despite the ArrayBuffer type", async () => {
    // Documenting, not endorsing. crypto.subtle.sign takes any BufferSource,
    // so a future caller passing a Uint8Array would compile-error but work.
    // Recorded because the failure mode of the OTHER mistake -- passing a
    // view's `.buffer` when the view does not span the whole allocation --
    // is silent and severe: it signs the surrounding bytes too. Nothing here
    // normalises a view for you.
    const view = new Uint8Array([0x61, 0x62, 0x63]);
    await expect(hmacSha256HexBytes("s3cret", view as unknown as ArrayBuffer)).resolves.toBe(
      "4f2f30aaf4a57bd60ab473c8e9c2cdfefc186723d4727ed6f31f04353c91389a",
    );
    const offset = new Uint8Array([0xde, 0xad, 0x61, 0x62, 0x63]).subarray(2);
    expect(await hmacSha256HexBytes("s3cret", offset as unknown as ArrayBuffer)).toBe(
      // The view itself is "abc"...
      "4f2f30aaf4a57bd60ab473c8e9c2cdfefc186723d4727ed6f31f04353c91389a",
    );
    // ...but its .buffer is the whole five-byte allocation, and it is signed
    // as such. Pinned as the EXACT digest of all five bytes rather than a
    // bare `not.toBe`: "differs from abc" would also be satisfied by an
    // implementation that signed nothing at all, or that threw and was caught
    // somewhere -- whereas this says precisely which bytes went in, which is
    // the whole content of the warning above.
    expect(await hmacSha256HexBytes("s3cret", offset.buffer as ArrayBuffer)).toBe(
      "2b6bb67c38550776363df98888114b74218b8ec148596230a771cae6b0516c17",
    );
    expect(await hmacSha256HexBytes("s3cret", rawBuffer(0xde, 0xad, 0x61, 0x62, 0x63))).toBe(
      "2b6bb67c38550776363df98888114b74218b8ec148596230a771cae6b0516c17",
    );
  });

  it("signs a body far larger than one WebCrypto call typically sees", async () => {
    // 64 KiB of body -- Meta batches webhook entries, and a status-update
    // burst is comfortably kilobytes, so this is production-shaped rather
    // than a stress test. It matters because the digest is computed over a
    // buffer that arrives whole from c.req.arrayBuffer(): anything that
    // chunked, truncated at a fixed limit, or copied only the first page
    // would still return 64 plausible hex characters and fail only against
    // Meta. A known answer is the only assertion that notices.
    await expect(hmacSha256HexBytes("s3cret", new Uint8Array(65536).fill(0x61).buffer)).resolves.toBe(
      "342dc6a7e6af04b17231aa093edca81eb994183c0bd25647e092c5ac038d2d21",
    );
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings and false for anything else", () => {
    // The semantic contract, stated as the property callers rely on: it is
    // `a === b`, computed without an early exit. Nothing more permissive
    // (verifyCsrf would accept a forged cookie) and nothing less (every
    // legitimate Save would 403).
    const samples = ["", "a", "abc", "abd", "ABC", "0f", "0f0", "é", "🍞", "deadbeef".repeat(8)];
    for (const a of samples) {
      for (const b of samples) {
        expect(timingSafeEqual(a, b)).toBe(a === b);
      }
    }
  });

  it("compares the FULL string, including its very last character", () => {
    // An off-by-one loop bound (`i < a.length - 1`) is the classic way to
    // break this while every ordinary test stays green -- mismatches usually
    // show up early. It would accept any signature that is correct except in
    // its final hex digit, i.e. 1/16 of forgeries by trial.
    const expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
    const lastCharWrong = `${expected.slice(0, 63)}4`;
    expect(lastCharWrong).toHaveLength(expected.length);
    expect(timingSafeEqual(lastCharWrong, expected)).toBe(false);

    // Repeated at 8 KiB, the scale of a long cookie value rather than a
    // 64-character digest, because an off-by-one is not the only way to lose
    // the tail: a bound capped at some constant (or a loop over a slice)
    // would still get every short fixture in this file right. Equal at that
    // length must be true, differing only in the final code unit must not.
    const long = "x".repeat(8 * 1024);
    expect(timingSafeEqual(long, "x".repeat(8 * 1024))).toBe(true);
    expect(timingSafeEqual(`${long.slice(0, -1)}y`, long)).toBe(false);
  });

  it("accumulates differences, so an early mismatch is not forgotten", () => {
    // Guards the `|=` in `diff |= ...`. Written as a plain `=`, diff would
    // hold only the LAST character's XOR, so any pair differing anywhere
    // except the final position would compare equal -- which is nearly every
    // forged signature.
    const expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
    const firstCharWrong = `4${expected.slice(1)}`;
    expect(timingSafeEqual(firstCharWrong, expected)).toBe(false);
    // Middle-only difference, same reasoning.
    expect(timingSafeEqual(`${expected.slice(0, 32)}f${expected.slice(33)}`, expected)).toBe(false);
    // The honest limit of this block, stated so nobody mistakes it for proof
    // of the module comment's "constant-time" claim: an implementation that
    // early-returned inside the loop (`if (a[i] !== b[i]) return false`) is
    // behaviourally IDENTICAL to this one and no functional assertion can
    // separate them -- only a timing measurement could, and that is too flaky
    // to belong in a unit suite. What these tests do pin is the accumulation
    // itself, which is the part that changes the ANSWER when it breaks; the
    // constant-time property rests on reading the code.
    //
    // And several differences at once still read as a mismatch (a bug that
    // XORed rather than OR-accumulated could cancel two differences out).
    expect(timingSafeEqual("ab", "ba")).toBe(false);
    expect(timingSafeEqual("abcd", "badc")).toBe(false);
  });

  it("returns false for any length difference without comparing further", () => {
    // Deliberate and safe here: the fast path leaks only the LENGTH of the
    // value, and every secret compared through this function has a publicly
    // known fixed length -- a 64-char hex HMAC in csrf.ts/adminAuth.ts, a
    // 64-char raw token, and the "sha256=" -stripped hex in whatsappHook.ts.
    // It also means a truncated or padded signature can never verify.
    const expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
    expect(timingSafeEqual(expected.slice(0, 63), expected)).toBe(false);
    expect(timingSafeEqual(`${expected}0`, expected)).toBe(false);
    expect(timingSafeEqual(` ${expected}`, expected)).toBe(false);
    expect(timingSafeEqual("", expected)).toBe(false);
    // No whitespace tolerance either: nothing is trimmed before comparing.
    expect(timingSafeEqual(`${expected} `, expected)).toBe(false);
    // And no Unicode normalisation: the two spellings of "café" render the
    // same but are 4 and 5 code units, so they take the length fast path and
    // are unequal -- matching hmacSha256Hex(), which signs them differently
    // (see its own NFC/NFD test). A `.normalize()` added to either side
    // alone would silently desynchronise signing from comparing.
    expect(timingSafeEqual("café", "café")).toBe(false);
  });

  it("is case-sensitive, so an uppercase hex signature does not verify", () => {
    // toHex() always emits lowercase, and this compares characters, not hex
    // VALUES. A client that uppercased its signature would be rejected even
    // though the bytes are identical. Meta sends lowercase, so this is
    // correct today -- pinned so that if a future integration sends
    // uppercase, the fix is a deliberate normalisation at the call site
    // rather than a surprise here.
    expect(timingSafeEqual("5BDCC146", "5bdcc146")).toBe(false);
    expect(timingSafeEqual("0f", "0F")).toBe(false);
  });

  it("returns true for two empty strings -- every call site must guard first", () => {
    // Zero length passes the length check, the loop never runs, and diff
    // stays 0. This is the one genuinely dangerous edge, and each caller
    // does guard it: verifyCsrf() rejects a falsy formToken and a cookie
    // with no ".", issueCsrfToken()/verifyOAuthCookie() only reach here with
    // a 64-char computed digest, and handleVerification() checks
    // WHATSAPP_WEBHOOKVERIFYTOKEN is set before comparing it against a
    // `?? ""` query value. Pinned here so the guards are understood as
    // load-bearing rather than defensive noise.
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("never throws, whatever two strings it is handed", () => {
    // Both operands are attacker-controlled at their call sites (a cookie
    // value, a header value, a form field), and no call site wraps this in a
    // try/catch. A throw would be a 500 on the admin pages and would break
    // whatsappHook's always-200 contract to Meta.
    const nasty = [
      "",
      "\u0000",
      "\u0000\u0000",
      "🍞",
      "\ud83c", // a lone high surrogate, as a truncated header could produce
      "\udf5e", // a lone low surrogate
      "\uffff",
      "x".repeat(8 * 1024),
      "sha256=",
    ];
    // Each pair is checked for BOTH survival and the right answer. "It did
    // not throw" on its own is nearly vacuous -- a function that returned
    // `true` unconditionally would sail through a throw-only matrix, and that
    // is the single worst way this could break.
    for (const a of nasty) {
      for (const b of nasty) {
        let result: unknown = "never assigned";
        expect(() => {
          result = timingSafeEqual(a, b);
        }).not.toThrow();
        expect(result).toBe(a === b);
      }
    }
    // Lone surrogates still compare sanely -- equal to themselves, and not to
    // each other (charCodeAt reads code units, so no pair is ever conflated).
    expect(timingSafeEqual("\ud83c", "\ud83c")).toBe(true);
    expect(timingSafeEqual("\ud83c", "\udf5e")).toBe(false);
    // NUL is compared, not treated as a terminator.
    expect(timingSafeEqual("a\u0000b", "a\u0000c")).toBe(false);
    expect(timingSafeEqual("a\u0000b", "a\u0000b")).toBe(true);
  });
  it("has NO type guard: two values with no .length compare EQUAL, and null/undefined throw", () => {
    // The most dangerous property of this implementation, and the one the
    // "never throws, whatever two STRINGS it is handed" test above is careful
    // to scope itself away from. timingSafeEqual never checks that it was
    // given strings. It reads `.length`, and on anything lacking one that is
    // `undefined`:
    //
    //   undefined !== undefined  is false, so the length guard does not fire
    //   i < undefined            is false, so the loop body never runs
    //   diff                     is still 0, so it returns TRUE
    //
    // Two arbitrary, unequal values therefore verify against each other.
    // That is the single worst way this function can be called, and nothing in
    // the module prevents it -- only TypeScript's `(a: string, b: string)` and
    // the guards at each call site do. Pinned to make those guards legible as
    // load-bearing security code rather than defensive noise: whatsappHook.ts's
    // `?? ""` on hub.verify_token (line 88) and adminAuth.ts's `!state` early
    // return (line 354) are the reason an absent query parameter cannot reach
    // here. Delete either and a MISSING parameter becomes a SUCCESSFUL
    // verification -- webhook takeover, or an accepted OAuth callback.
    expect(timingSafeEqual(12 as unknown as string, 99 as unknown as string)).toBe(true);
    expect(timingSafeEqual({} as unknown as string, { forged: true } as unknown as string)).toBe(true);
    expect(timingSafeEqual(true as unknown as string, false as unknown as string)).toBe(true);

    // Including the numeric edges, where it also diverges from the `a === b`
    // contract the first test in this block asserts across its string matrix:
    // NaN is never equal to itself under ===, but is "equal" here.
    expect(timingSafeEqual(0 as unknown as string, -0 as unknown as string)).toBe(true);
    expect(Number.NaN === Number.NaN).toBe(false);
    expect(timingSafeEqual(Number.NaN as unknown as string, Number.NaN as unknown as string)).toBe(true);

    // null and undefined are the one non-string pair that fails LOUDLY rather
    // than silently: `.length` on either throws, so a call site that let one
    // through would 500 (or, at whatsappHook, be swallowed by its try/catch
    // and answered 200) instead of forging. Documented, not endorsed -- the
    // point is that the failure mode differs by type, so "the value is falsy,
    // we're fine" is not a safe way to reason about this function's inputs.
    expect(() => timingSafeEqual(undefined as unknown as string, "x")).toThrow(TypeError);
    expect(() => timingSafeEqual(null as unknown as string, "x")).toThrow(TypeError);
    expect(() => timingSafeEqual("x", undefined as unknown as string)).toThrow(TypeError);

    // An array HAS a .length, so it clears the guard and then dies on
    // charCodeAt -- but only when the lengths match. Mismatched lengths take
    // the fast path and return false without ever touching an element.
    expect(() => timingSafeEqual(["a"] as unknown as string, ["b"] as unknown as string)).toThrow(TypeError);
    expect(timingSafeEqual(["a"] as unknown as string, [] as unknown as string)).toBe(false);
  });
});

describe("the two flows these primitives are wired into", () => {
  it("csrf.ts: a minted signature verifies, and a tampered token does not", async () => {
    // The exact shape of the __Host-csrf cookie, `<raw>.<signature>`, and the
    // exact sequence issueCsrfToken()/verifyCsrf() run. This is the one place
    // sign-then-compare is asserted end to end, on top of (not instead of)
    // the known-answer vectors above.
    const secret = "CSRF_SECRET";
    const raw = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809";
    const cookie = `${raw}.${await hmacSha256Hex(secret, raw)}`;

    const dot = cookie.indexOf(".");
    const cookieRaw = cookie.slice(0, dot);
    const cookieSignature = cookie.slice(dot + 1);
    expect(timingSafeEqual(cookieSignature, await hmacSha256Hex(secret, cookieRaw))).toBe(true);

    // An attacker who plants a cookie from a sibling subdomain has no secret,
    // so their signature cannot verify...
    const forged = await hmacSha256Hex("guessed-secret", cookieRaw);
    expect(timingSafeEqual(forged, await hmacSha256Hex(secret, cookieRaw))).toBe(false);
    // ...and swapping the raw token while keeping the genuine signature
    // fails too, which is what binds the signature to that specific token.
    const swappedRaw = `f${cookieRaw.slice(1)}`;
    expect(timingSafeEqual(cookieSignature, await hmacSha256Hex(secret, swappedRaw))).toBe(false);
  });

  it("whatsappHook.ts: an X-Hub-Signature-256 header verifies over the raw body", async () => {
    // Meta's documented header format is "sha256=<lowercase hex>", and
    // verifySignature() strips that prefix before comparing. Reproduced here
    // so the prefix, the casing and the 64-character width are pinned as one
    // unit -- get any of them wrong and every webhook is silently dropped
    // while still returning 200.
    const appSecret = "appsecret";
    const body = utf8Buffer('{"object":"whatsapp_business_account","entry":[{"id":"123"}]}');
    const header = `sha256=${await hmacSha256HexBytes(appSecret, body)}`;
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(timingSafeEqual(header.slice("sha256=".length), await hmacSha256HexBytes(appSecret, body))).toBe(true);

    // A body edited in transit -- one byte changed inside the JSON -- fails.
    const tampered = utf8Buffer('{"object":"whatsapp_business_account","entry":[{"id":"124"}]}');
    expect(timingSafeEqual(header.slice("sha256=".length), await hmacSha256HexBytes(appSecret, tampered))).toBe(false);
    // Forgetting to strip the prefix would compare 71 characters against 64
    // and reject everything -- a length mismatch, not a subtle one.
    expect(timingSafeEqual(header, await hmacSha256HexBytes(appSecret, body))).toBe(false);
  });
});
