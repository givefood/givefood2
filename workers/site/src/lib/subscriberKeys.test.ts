import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSubUnsubKeys, sha256Hex } from "./subscriberKeys";

// These keys are the only thing standing between a subscriber and their
// confirm/unsubscribe links: confirm() and unsubscribe() each do a bare
// `WHERE sub_key = ?` / `WHERE unsub_key = ?` lookup (0004_subscribers.sql
// :13-15). Both columns carry a UNIQUE index (0004_subscribers.sql:27-28),
// and Django declares them max_length=16 (givefood/models/subscribers.py
// :25-26), so this module has two hard obligations:
//
//   1. SHAPE -- exactly 16 lowercase hex chars, so a key minted here is
//      indistinguishable from a Django-minted one and fits the column.
//   2. UNIQUENESS -- distinct across every mint in a single request, or the
//      admin's bulk-add INSERT fails as a batch and nobody gets added.
//
// Every expected digest below was computed with Python's `hashlib` -- the
// library Django itself hashes with -- so these tests cross-check the
// TypeScript against the ancestor implementation instead of restating it.

// A frozen instant to hash against. Only Date is faked: crypto.subtle.digest
// resolves on the microtask queue, which fake timers must not be holding.
const FROZEN = new Date("2026-09-05T19:28:08.853Z");
const NONCE = "11111111-2222-3333-4444-555555555555";
const SALT = "test-salt";

function freezeClock(at: Date = FROZEN) {
  vi.useFakeTimers({ toFake: ["Date"], now: at });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sha256Hex", () => {
  it("produces the published SHA-256 vectors, lowercase and unprefixed", async () => {
    // The FIPS-180 vectors, byte-identical to hashlib.sha256(b"").hexdigest()
    // -- which is what Django computed. If this ever disagrees, every key
    // minted from that moment on is unreachable by the confirm and
    // unsubscribe links already sitting in subscribers' inboxes.
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("zero-pads a byte below 0x10, so the 16-char slice does not shift left", async () => {
    // The entire reason for `.padStart(2, "0")`, and the failure it prevents
    // is invisible in a diff. "givefood-2" digests to a value whose EIGHTH
    // byte is 0x07: unpadded it renders as "7" rather than "07", the string
    // shortens to 63 chars, and every character from position 14 onward
    // slides one place left -- so the key silently becomes a DIFFERENT key
    // that still looks like perfectly plausible hex. The slice is asserted
    // as well as the whole digest because only the slice reaches the column.
    const digest = await sha256Hex("givefood-2");
    expect(digest).toBe("816b82aadeb7f207d987f0cfeb8da9abe203635ca6cdee5a52531419b2802fa9");
    expect(digest).toHaveLength(64);
    expect(digest.slice(0, 16)).toBe("816b82aadeb7f207");
  });

  it("encodes its input as UTF-8, matching Django's .encode('utf-8')", async () => {
    // subscribers.py:49-53 encodes explicitly as UTF-8 before hashing. The
    // salt is operator-supplied credential data and could hold any
    // character; if TextEncoder were swapped for a naive byte loop, ASCII
    // salts would keep working and only a non-ASCII one would break, long
    // after deploy. The second value is what latin-1 would have produced.
    expect(await sha256Hex("sub-caf\u00e9-\u00a35")).toBe(
      "f326a34e1791db30c5774e67a1cfc37931cddf250564c96ce5bbba1f2886c073",
    );
    expect(await sha256Hex("sub-caf\u00e9-\u00a35")).not.toBe(
      "b54a9cf8f5983db47f491934bf7f33bb59f9629c03df79f404836b51aed528c5",
    );
  });

  it("does not Unicode-normalize: composed and decomposed salts are different keys", async () => {
    // There is no .normalize() call, and there must not be one added
    // "defensively" later. A salt pasted from macOS arrives NFD (e + U+0301);
    // the same salt typed on Linux arrives NFC (U+00E9). Django hashed
    // whatever bytes the credential row held, with no normalisation either,
    // so the port matches it by doing nothing -- but it means the two forms
    // are genuinely different secrets. Written as \u escapes on purpose: a
    // literal "café" in this file would be silently renormalised by an
    // editor and quietly turn this test into a comparison of two identicals.
    const nfc = await sha256Hex("caf\u00e9");
    const nfd = await sha256Hex("cafe\u0301");
    expect(nfc).toBe("850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e");
    expect(nfd).toBe("81ef060bcd98adc7824eb5c1ada83c32491b16018e11e79f00ab9d09e04b015a");
    expect(nfc).not.toBe(nfd);
  });

  it("substitutes U+FFFD for a lone surrogate instead of throwing", async () => {
    // The malformed-input boundary. A lone surrogate is not encodable as
    // UTF-8 and is the one string value that could plausibly make an encoder
    // throw -- and a throw here is not a logged error, it is a 500 on the
    // public subscribe form (updates.ts) mid-POST, after the address has
    // already been typed. TextEncoder follows WHATWG and swaps in U+FFFD,
    // so the digest is exactly hashlib.sha256("\ufffd".encode()) -- which is
    // what the second assertion pins. Also documents the consequence: every
    // unpaired surrogate collapses onto the same digest.
    const REPLACEMENT = "83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097";
    await expect(sha256Hex("\ud800")).resolves.toBe(REPLACEMENT);
    expect(await sha256Hex("\udfff")).toBe(REPLACEMENT);
    expect(await sha256Hex("\ufffd")).toBe(REPLACEMENT);
    // A well-formed surrogate PAIR must survive as the astral character it
    // encodes, not get mangled into two replacements.
    expect(await sha256Hex("\u{10000}")).toBe(
      "31237b174ba6047a15db0d343ad9550da611b7b7bce867a23522f81a05df3eda",
    );
  });

  it("always returns 64 lowercase hex characters, whatever the input", async () => {
    // The fixed-width invariant the [:16] slice depends on. An empty string,
    // a 10k-char input and astral-plane text are all here because the byte
    // count of the INPUT must never leak into the length of the OUTPUT.
    const inputs = ["", " ", "a", "x".repeat(10_000), "\u{1f600}\u{1f600}", "sub--"];
    const digests = await Promise.all(inputs.map(sha256Hex));
    for (const digest of digests) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    // Distinct inputs must not collapse onto one digest: a helper that
    // ignored its argument entirely would pass every length check above.
    expect(new Set(digests).size).toBe(inputs.length);
  });
});

describe("generateSubUnsubKeys", () => {
  it("hashes exactly `sub-<iso>-<nonce>-<salt>`, field order included", async () => {
    // Pins the hash input template character for character, against digests
    // computed in Python. A refactor that reordered the fields to
    // `sub-<iso>-<salt>-<nonce>` or dropped one of the hyphens would still
    // return well-formed, unique, 16-char hex keys and would sail through
    // every other test in this file -- so the template is recorded here in
    // values rather than only in a comment. The third assertion is that
    // reordered variant, computed the same way.
    freezeClock();
    const keys = await generateSubUnsubKeys(SALT, NONCE);
    expect(keys.subKey).toBe("df8aef719f71a3c8");
    expect(keys.unsubKey).toBe("dfff15f365043a52");
    expect(keys.subKey).not.toBe("a4ca17718c2d5d87");
    // ...and the key is the HEAD of that digest, not some other 16 chars of
    // it. `slice(16, 32)` and `slice(-16)` both yield well-formed hex of the
    // right length; only a positive prefix check rules them out. The full
    // 64-char value is the Python digest of the same template.
    const FULL_SUB = "df8aef719f71a3c83e900e520ef9d24a43ef0867b887b825a57f095b6ca90543";
    expect(FULL_SUB.startsWith(keys.subKey)).toBe(true);
    expect(keys.subKey).not.toBe(FULL_SUB.slice(-16));
    expect(keys.subKey).not.toBe(FULL_SUB.slice(16, 32));
  });

  it("diverges from Django's digest by exactly the nonce, but not in shape", async () => {
    // Django hashes "sub-<now>-<salt>" with no nonce at all
    // (subscribers.py:49-53). This port inserts one, so the same instant and
    // salt deliberately do NOT reproduce Django's key. That divergence is
    // safe precisely because keys are only ever looked up, never recomputed
    // -- what must match is the shape, so the column, the URLs and the
    // legacy rows cannot tell a ported key from a Django one.
    //
    // The Django-side values are Python-computed constants rather than a
    // re-run of sha256Hex on a locally rebuilt template: comparing the
    // module against a string this test just built with the module's own
    // helper proves only that two hyphens differ, and would still "pass" if
    // BOTH implementations were wrong in the same way. These two constants
    // are also, exactly, what the nonce-free helper that used to live at
    // routes/wfbn/updates.ts:39-42 minted for this instant and salt -- that
    // duplicate is gone (github #27) and both call sites reach this module.
    freezeClock();
    const keys = await generateSubUnsubKeys(SALT, NONCE);
    const DJANGO_SUB = "c65cac693261b827";
    const DJANGO_UNSUB = "14f550288fa3c814";
    expect(keys.subKey).not.toBe(DJANGO_SUB);
    expect(keys.unsubKey).not.toBe(DJANGO_UNSUB);
    // Shape parity is the part that DOES have to hold, on both keys.
    expect(keys.subKey).toMatch(/^[0-9a-f]{16}$/);
    expect(keys.unsubKey).toMatch(/^[0-9a-f]{16}$/);
    expect(DJANGO_SUB).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns 16 lowercase hex chars for both keys, fitting max_length=16", async () => {
    // Django's CharField(max_length=16): a longer value is truncated or
    // rejected depending on backend, and a non-hex value means the key was
    // not built by slicing a digest at all.
    const { subKey, unsubKey } = await generateSubUnsubKeys(SALT);
    expect(subKey).toMatch(/^[0-9a-f]{16}$/);
    expect(unsubKey).toMatch(/^[0-9a-f]{16}$/);
  });

  it("never returns the same value for subKey and unsubKey", async () => {
    // The "sub-"/"unsub-" prefixes are the only thing separating the two. If
    // a refactor lost a prefix, confirming a subscription and unsubscribing
    // from it would become the same link -- and the confirmation email would
    // carry a working unsubscribe URL as its confirm URL.
    freezeClock();
    const { subKey, unsubKey } = await generateSubUnsubKeys(SALT, NONCE);
    expect(subKey).not.toBe(unsubKey);
  });

  it("mints twenty distinct pairs inside a single frozen millisecond", async () => {
    // THE reason this module exists. Date#toISOString() is millisecond
    // resolution, so pasting twenty addresses into the admin's bulk-add
    // textarea -- foodbankAddSub.ts:107-108 mints them all in one
    // Promise.all -- routinely lands several rows on the same timestamp.
    // sub_key and unsub_key are both UNIQUE (0004_subscribers.sql:27-28), so
    // a repeat is not a subtle collision: the whole batch INSERT fails and
    // none of the twenty are added.
    //
    // The clock is frozen deliberately, to strip out the "the millisecond
    // happened to tick" luck that would otherwise let this pass for the
    // wrong reason. With Date stopped, the per-call nonce is the only
    // source of variation left in the hash input.
    freezeClock();
    const pairs = await Promise.all(Array.from({ length: 20 }, () => generateSubUnsubKeys(SALT)));
    const subKeys = pairs.map((p) => p.subKey);
    const unsubKeys = pairs.map((p) => p.unsubKey);
    expect(new Set(subKeys).size).toBe(20);
    expect(new Set(unsubKeys).size).toBe(20);
    // Distinct across both columns too, so no subscriber's unsubscribe key
    // is some other subscriber's confirm key.
    expect(new Set([...subKeys, ...unsubKeys]).size).toBe(40);
  });

  it("evaluates the default nonce per call, not once per module load", async () => {
    // A default parameter is re-evaluated on every call that omits it. Were
    // it hoisted to a module-level `const NONCE = crypto.randomUUID()` -- a
    // very plausible "stop recomputing this" tidy-up -- the twenty-row test
    // above would fail too, but this one says why in a single assertion:
    // two mints at the same instant must not agree.
    freezeClock();
    const [a, b] = await Promise.all([generateSubUnsubKeys(SALT), generateSubUnsubKeys(SALT)]);
    expect(a.subKey).not.toBe(b.subKey);
    expect(a.unsubKey).not.toBe(b.unsubKey);
  });

  it("fires the default nonce for an explicitly-passed undefined", async () => {
    // `nonce: string = crypto.randomUUID()` is a DEFAULT PARAMETER, so it
    // fires on undefined, not merely on a missing argument. That matters
    // because the natural way to write an optional pass-through at a call
    // site is `generateSubUnsubKeys(salt, opts?.nonce)`, which hands over
    // undefined rather than omitting the argument. If the default were ever
    // rewritten as an inside-the-body `if (arguments.length < 2)`, this
    // spelling would start minting keys from the literal string "undefined"
    // -- identical for every row, and the batch INSERT dies on the UNIQUE
    // index. Two mints at one frozen instant must still disagree.
    freezeClock();
    const [a, b] = await Promise.all([
      generateSubUnsubKeys(SALT, undefined),
      generateSubUnsubKeys(SALT, undefined),
    ]);
    expect(a.subKey).not.toBe(b.subKey);
    expect(a.unsubKey).not.toBe(b.unsubKey);
    // Specifically NOT the digest of the template with "undefined" in the
    // nonce slot, which is what a stringifying implementation would produce.
    expect(a.subKey).not.toBe("ec005d6c9bbe86c9");
  });

  it("treats an empty-string nonce as a real nonce, NOT as missing", async () => {
    // The boundary between "" and undefined, and the one place a caller can
    // silently switch the collision protection off. A default parameter does
    // not fire for "", so `generateSubUnsubKeys(salt, row.token ?? "")` --
    // the same `?? ""` idiom foodbankAddSub.ts:108 already uses for the salt
    // -- hashes an EMPTY nonce and, at one millisecond, mints byte-identical
    // keys for every row. That is precisely the bulk-add failure this module
    // was written to prevent, reachable through an innocent-looking call.
    //
    // Pinned rather than merely described, because a rewrite to
    // `nonce || crypto.randomUUID()` would change this behaviour into
    // something arguably better while quietly breaking the determinism the
    // pinned digests elsewhere rely on. The digests are Python-computed for
    // the template with an empty nonce slot -- note the DOUBLE hyphen.
    freezeClock();
    const [a, b] = await Promise.all([
      generateSubUnsubKeys(SALT, ""),
      generateSubUnsubKeys(SALT, ""),
    ]);
    expect(a.subKey).toBe("fa17d37919247df0");
    expect(a.unsubKey).toBe("01512f0bb197d588");
    // The collision, spelled out: same instant, empty nonce, same keys.
    expect(b).toEqual(a);
  });

  it("does not escape the template delimiter, so nonce/salt can alias", async () => {
    // Documented here because it is invisible from the signature: the
    // template joins fields with a bare "-" and neither field is escaped or
    // length-checked, so any two (nonce, salt) pairs that concatenate to the
    // same string mint the SAME key. ("a", "b-c") and ("a-b", "c") both
    // build `sub-<iso>-a-b-c`. Harmless in production -- the nonce is a
    // fixed-shape UUID and the salt is a secret -- but it is the reason the
    // uniqueness guarantee rests on the nonce being unpredictable rather
    // than on the template being unambiguous, and anyone tempted to let a
    // caller supply a human-chosen nonce should have to change this test.
    freezeClock();
    const [a, b] = await Promise.all([
      generateSubUnsubKeys("b-c", "a"),
      generateSubUnsubKeys("c", "a-b"),
    ]);
    expect(a.subKey).toBe("1be0e38ecf50ec90");
    expect(b.subKey).toBe(a.subKey);
  });

  it("is fully deterministic once a nonce is supplied", async () => {
    // Documents the current contract of the optional parameter: an explicit
    // nonce removes the only randomness, so at a frozen instant the same
    // (salt, nonce) reproduces the same pair exactly. That is what makes the
    // pinned digests above meaningful -- and it is also the caller's
    // warning, since passing a CONSTANT nonce would reinstate the very
    // collision the default exists to prevent.
    freezeClock();
    const [a, b] = await Promise.all([
      generateSubUnsubKeys(SALT, NONCE),
      generateSubUnsubKeys(SALT, NONCE),
    ]);
    expect(a).toEqual(b);
  });

  it("degrades to a valid key when the salt is missing, rather than throwing", async () => {
    // PLAN.md risk register N1: the salt only affects newly-minted keys'
    // format-consistency, never lookups, so an unset secret must not take
    // out the subscribe form. The one call site that reaches THIS module
    // passes `c.env.SUBSCRIBER_SALT ?? ""` (foodbankAddSub.ts:108), so "" is
    // the exact value that arrives in production when the secret is absent.
    // (updates.ts's subscribe handler uses the same `?? ""` idiom and now
    // reaches this module too, since github #27 deleted its private copy.
    // Note it passes the salt only -- never a nonce, so the default fires;
    // the empty-nonce test below is why that matters.)
    // The template is not conditionally trimmed, so the trailing hyphen
    // survives -- which these Python-computed digests pin.
    freezeClock();
    const keys = await generateSubUnsubKeys("", NONCE);
    expect(keys.subKey).toBe("0141eada32ad1ff9");
    expect(keys.unsubKey).toBe("5c4a525edae906be");
  });

  it("actually mixes the salt into the digest", async () => {
    // Guards the salt against being dropped from the template. Removing it
    // leaves a helper that still returns well-formed, unique, Django-shaped
    // keys -- every other test here would stay green -- while making the
    // keys derivable from nothing but a timestamp and a UUID.
    freezeClock();
    const [a, b] = await Promise.all([
      generateSubUnsubKeys("salt-one", NONCE),
      generateSubUnsubKeys("salt-two", NONCE),
    ]);
    expect(a.subKey).not.toBe(b.subKey);
    expect(a.unsubKey).not.toBe(b.unsubKey);
  });

  it("actually mixes the clock into the digest", async () => {
    // Same salt, same nonce, one millisecond apart. If the timestamp ever
    // stopped being part of the input, the nonce alone would still carry
    // uniqueness -- true today, so nothing else here would catch it -- but
    // the port would have quietly lost its last structural resemblance to
    // Django's "sub-<now>-<salt>".
    freezeClock(new Date("2026-09-05T19:28:08.853Z"));
    const first = await generateSubUnsubKeys(SALT, NONCE);
    vi.setSystemTime(new Date("2026-09-05T19:28:08.854Z"));
    const second = await generateSubUnsubKeys(SALT, NONCE);
    expect(first.subKey).not.toBe(second.subKey);
    expect(first.unsubKey).not.toBe(second.unsubKey);
  });

  it("survives salts that are empty, punctuation, non-ASCII or very long", async () => {
    // Django read the salt from a credential row via get_cred("salt"), so
    // nothing constrains its content. Whatever arrives, the output shape
    // must not move: a key that is not 16 hex chars is a broken confirm
    // link in someone's inbox, not a logged error.
    freezeClock();
    const salts = ["", " ", "-", "é£\u{1f600}", "x".repeat(5_000), "sub-"];
    const pairs = await Promise.all(salts.map((salt) => generateSubUnsubKeys(salt, NONCE)));
    for (const { subKey, unsubKey } of pairs) {
      expect(subKey).toMatch(/^[0-9a-f]{16}$/);
      expect(unsubKey).toMatch(/^[0-9a-f]{16}$/);
    }
    // A salt of "-" or "sub-" must not alias another salt's key by
    // colliding somewhere in the template's delimiters.
    expect(new Set(pairs.map((p) => p.subKey)).size).toBe(salts.length);
  });

  it("reads the clock through toISOString(), once per digest", async () => {
    // Two things nothing else here can see, both pinned against Python.
    //
    // FIRST: the timestamp is formatted with toISOString(), which is always
    // UTC and always the same width. Swapping in toString() or
    // toLocaleString() -- the sort of thing a "make the logs readable"
    // change does -- would still produce unique, well-formed, 16-hex keys
    // and would pass every other test in this file, while making the hash
    // input depend on the machine's TZ and locale. The harness pins TZ=UTC,
    // so no digest comparison could ever catch that; a call count can.
    //
    // SECOND: `new Date()` is evaluated TWICE, once per hash, with an await
    // in between -- so the unsub digest is taken from a LATER clock read
    // than the sub digest. That is invisible at a frozen instant, which is
    // why every other test misses it. Documented, not required: the keys
    // only ever need to be unique, so a tidy-up that hoisted a single `iso`
    // const would be harmless -- but it would change these digests, and
    // whoever makes that change should see that and confirm it deliberately.
    //
    // One surgical spy, not a mocked hasher: the digests below are real
    // SHA-256 values from hashlib, so the assertions still cross-check the
    // crypto rather than restating the mock.
    let reads = 0;
    const iso = vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
      reads += 1;
      return reads === 1 ? "2026-09-05T19:28:08.853Z" : "2026-09-05T19:28:08.854Z";
    });
    try {
      const keys = await generateSubUnsubKeys(SALT, NONCE);
      expect(iso).toHaveBeenCalledTimes(2);
      // sub- from the FIRST read (.853), unsub- from the SECOND (.854).
      expect(keys.subKey).toBe("df8aef719f71a3c8");
      expect(keys.unsubKey).toBe("e518ae39678872dd");
      // And not the value unsub- would have had at the first read, which is
      // what a single hoisted timestamp would produce.
      expect(keys.unsubKey).not.toBe("dfff15f365043a52");
    } finally {
      iso.mockRestore();
    }
  });

  it("returns exactly {subKey, unsubKey}, leaking neither salt nor full digest", async () => {
    // foodbankAddSub.ts:108 spreads this straight into the insert row:
    // `{ email, ...(await generateSubUnsubKeys(...)) }`, typed as
    // AdminSubscriberInsert. So any extra property added here -- a debug
    // `hash`, the `salt`, the `nonce` -- becomes an unexpected column in a
    // D1 INSERT and, in the salt's case, writes the secret to a table that
    // gets dumped and copied around. The spread is why the shape is a
    // contract and not just an implementation detail.
    freezeClock();
    const keys = await generateSubUnsubKeys(SALT, NONCE);
    expect(Object.keys(keys).sort()).toEqual(["subKey", "unsubKey"]);
    const values = Object.values(keys);
    expect(values.some((v) => v.includes(SALT))).toBe(false);
    expect(values.some((v) => v.includes(NONCE))).toBe(false);
    // 16 chars each, so neither value is a whole 64-char digest.
    expect(values.every((v) => v.length === 16)).toBe(true);
  });
});
