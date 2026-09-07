import { describe, expect, it } from "vitest";
import { AGGREGATE_TAG, MEDIA_TAG, constituencyTag, foodbankTag, mediaTag } from "./cacheTags";
// The specifier every real consumer actually uses. package.json's "main" is
// ./src/index.ts, so `@givefood/urls` IS this module -- see the re-export
// test at the bottom of this file for why that indirection is tested rather
// than assumed.
import * as urlsPackage from "./index";

// WHY THIS FILE ASSERTS EXACT STRINGS, WHICH USUALLY WOULD BE TAUTOLOGY.
//
// These five values are a wire format between two separately-deployed
// Workers: workers/site stamps them onto responses
// (middleware/cacheTag.ts:72-77) and workers/jobs purges by them
// (queues/cachePurge.ts:108). Cloudflare's purge_cache answers
// {"success": true} for a tag no response carries, so a renamed prefix
// fails at neither end -- no exception, no 4xx, no log line, just a food
// bank page that stays stale until its TTL. That silent failure is what the
// module header says this file exists to prevent, and pinning the literals
// is the only place it can be caught, because nothing downstream can.
//
// Two of the literals are not guesses: middleware/cacheTag.ts:26-27 records
// a live probe that mirrored Cache-Tag into a temporary X-Probe-Tag and got
// back `fb-all` on / and `fb-sid-valley` on /needs/at/sid-valley/. Those are
// observed production values, so the assertions on them below are pinning
// the edge's behaviour, not restating a constant.
//
// A third copy exists outside this module: routes/media.ts:163 and :216
// write `media, media-${slug}` by hand rather than importing mediaTag(),
// which the module header acknowledges ("already stamped by routes/media.ts
// before this module existed"). The media tests below reconstruct that exact
// header so the two copies cannot drift apart unnoticed.
//
// THE OTHER HALF OF THE FILE is about what these helpers deliberately do
// NOT do. They are four template literals with no validation, no trimming,
// no case folding and no escaping, and every caller depends on that: the
// tag stamped onto a response is built from the URL path
// (middleware/cacheTag.ts:71-75) while the tag sent to purge_cache is built
// from a D1 column (routes/admin/foodbank.ts:80-82). Those two strings have
// to be byte-identical or the purge misses in silence, so any normalisation
// added here -- however sensible-looking in a diff -- breaks the pairing on
// one side only. The tests below fail if a `.trim()`, a `.toLowerCase()`, a
// `.normalize()` or an `encodeURIComponent()` ever appears in this module.

// Slugs as they actually occur. NOTE that packages/models/src/index.ts:248's
// slugify() maps [^a-z0-9]+ to "-", so anything it mints is lowercase ASCII
// alphanumerics and hyphens -- but the slugs already in D1 were minted by
// DJANGO's slugify, which is not the same function (PLAN.md §6.9 R7: "A JS
// slugify with different Unicode handling silently 404s constituencies with
// apostrophes, accents or ampersands"). That divergence is why the
// non-ASCII tests further down are not hypothetical.
// sid-valley is the food bank the cacheTag middleware verified against with
// a temporary X-Probe-Tag header (middleware/cacheTag.ts:27).
const REAL_SLUGS = ["sid-valley", "trussell-trust-norwood-brixton", "hastings-and-rye", "york"];

// Shapes that are slugify-legal but unusual: pure digits, a long hyphen run,
// a leading digit. Used for the header-safety scan, which has to hold for
// every slug the schema permits and not just the four hand-picked ones
// above -- a scan over four friendly strings would pass against a helper
// that mangled everything else.
const SLUGIFY_SHAPED = [...REAL_SLUGS, "1", "0", "999", "a-b-c-d-e-f-g", "2-sisters-food-bank", "x".repeat(100)];

// Cloudflare's per-tag ceiling is 1024 BYTES, so the length assertions below
// have to count bytes. Hand-rolled rather than TextEncoder because this
// package compiles against plain ES2022 with no DOM or Workers lib
// (tsconfig.base.json:4), where TextEncoder is not declared -- and a test
// that only typechecks by accident is a test that stops building the day
// someone tightens the config. encodeURIComponent leaves an unreserved ASCII
// character as one character and expands every other byte to a %XX triple,
// so counting after collapsing the triples gives the UTF-8 length.
//
// CAVEAT worth knowing before reusing this: encodeURIComponent throws
// URIError on a LONE surrogate, so this counter cannot measure a malformed
// string. That is fine here -- every ceiling assertion below feeds it a
// well-formed slug, and the astral-plane test feeds it a matched pair -- but
// a future test that pipes arbitrary bytes through it will get a URIError
// rather than a number.
function utf8Bytes(value: string): number {
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}/gi, ".").length;
}

describe("foodbankTag", () => {
  it("produces fb-<slug>, the literal workers/site stamped and workers/jobs purges", () => {
    // middleware/cacheTag.ts:27 records `fb-sid-valley` coming back on
    // /needs/at/sid-valley/ from a live probe. If this changes, every food
    // bank purge queued by routes/admin/foodbank.ts:80 becomes a no-op.
    expect(foodbankTag("sid-valley")).toBe("fb-sid-valley");
    expect(foodbankTag("york")).toBe("fb-york");
  });

  it("keeps slugs that share a prefix apart, because tag purging is exact-match", () => {
    // The whole reason for the port: Django purges with URL *prefixes*
    // (utils/cache.py:169-176 posts {"prefixes": [...]}), where
    // "/needs/at/york/" would sweep up anything beneath it. Cloudflare tag
    // purging has no such semantics -- "fb-york" purges only responses
    // carrying exactly "fb-york". So the tag for a shorter slug must never
    // be mistaken for a prefix rule over a longer one.
    expect(foodbankTag("york")).not.toBe(foodbankTag("york-central"));
    // ...even though it *is* a string prefix of it, which is precisely the
    // trap: this looks like it would match and does not.
    expect(foodbankTag("york-central").startsWith(foodbankTag("york"))).toBe(true);
  });

  it("maps distinct food banks to distinct tags, including the near-collisions", () => {
    // A collision here would mean editing one food bank purges another's
    // pages, and -- worse in the other direction -- that one of them can
    // never be purged on its own. foodbank.slug is UNIQUE in D1
    // (0001_core.sql:48), so the injective mapping is the thing that carries
    // that uniqueness through to the cache.
    //
    expect(new Set(REAL_SLUGS.map(foodbankTag)).size).toBe(REAL_SLUGS.length);

    // Four dissimilar slugs stay distinct under almost any wrong helper, so
    // the assertion above proves little on its own. These PAIRS differ in
    // exactly one way each, and each one dies under a different plausible
    // "tidy-up" of this module.
    const nearCollisions: [string, string, string][] = [
      // Differ only in case: dies under `.toLowerCase()`.
      ["sid-valley", "Sid-Valley", "case folding"],
      // Differ only in a trailing hyphen: dies under a trailing-hyphen strip
      // or a `.trim()`-style tidy-up.
      ["york-", "york", "trailing-separator stripping"],
      // Differ only at the 100th character, the last one the schema allows:
      // dies under any truncate-or-hash "fix" for the tag length ceiling.
      [`${"a".repeat(99)}b`, `${"a".repeat(99)}c`, "truncation at the length ceiling"],
    ];
    for (const [left, right, wouldBreakUnder] of nearCollisions) {
      expect(foodbankTag(left), wouldBreakUnder).not.toBe(foodbankTag(right));
    }
  });

  it("does not validate or normalise: an empty slug yields the bare prefix", () => {
    // Current behaviour, pinned deliberately rather than endorsed. There is
    // no throw and no fallback, so a caller that has lost its slug queues a
    // purge of "fb-", which matches no response and reports success. Every
    // real caller reads foodbank.slug straight out of D1, so this is a
    // documented shape, not a live path.
    expect(foodbankTag("")).toBe("fb-");
  });

  it("preserves case rather than folding it", () => {
    // Retitled deliberately: this test can only observe the HELPER, not
    // Cloudflare. Whether the edge's tag matching is case-sensitive is not
    // something a node-environment unit test can assert, and a title claiming
    // it would be a claim no assertion here backs.
    //
    // What it does pin: Django slugs are always lowercase (slugify), so the
    // stamped tag and the purged tag agree today. A caller that title-cases a
    // slug on the way in gets a DIFFERENT tag -- and whether the edge then
    // matches it or not, the two sides have stopped producing one string,
    // which is the failure this module exists to prevent.
    expect(foodbankTag("Sid-Valley")).toBe("fb-Sid-Valley");
    expect(foodbankTag("Sid-Valley")).not.toBe(foodbankTag("sid-valley"));
  });

  it("does not trim, fold accents, or percent-encode: the slug is passed through verbatim", () => {
    // Each of these literals fails under a different "tidy-up" that would
    // look harmless in review, and every one of them would break the pairing
    // between the path-derived stamped tag and the D1-derived purged tag:
    //   `.trim()`             -> the first assertion
    //   accent folding / NFKD -> the second (Django's own slugify folds
    //                            accents; THIS module must not, or a legacy
    //                            accented slug stamps and purges differently)
    //   encodeURIComponent()  -> the ampersand/space one ONLY. Being precise
    //                            about this because it is easy to get wrong:
    //                            `'` is one of encodeURIComponent's
    //                            UNRESERVED characters (as are - _ . ! ~ * ( )
    //                            ), so the apostrophe assertion below passes
    //                            perfectly happily against a percent-encoding
    //                            implementation and is NOT the guard against
    //                            one. It guards a different class -- an HTML/
    //                            attribute escape turning `'` into `&#39;` --
    //                            and the ampersand line is the one that
    //                            actually kills encodeURIComponent.
    // Not a live path today, but PLAN.md §6.9 R7 is explicit that Unicode
    // handling around slugs is where this codebase has already been bitten.
    expect(foodbankTag("  york  ")).toBe("fb-  york  ");
    // Escaped rather than typed literally so the assertion cannot be
    // silently changed by an editor normalising the file itself.
    expect(foodbankTag("café")).toBe("fb-café");
    expect(foodbankTag("café")).not.toBe("fb-cafe"); // no accent folding
    expect(foodbankTag("st-mary's")).toBe("fb-st-mary's"); // no HTML-escaping
    expect(foodbankTag("food & drink")).toBe("fb-food & drink"); // no percent-encoding
    // Explicitly, so nobody has to re-derive which literal does the work:
    // this is the one and only assertion in the file that an
    // `encodeURIComponent(slug)` implementation cannot satisfy.
    expect(foodbankTag("food & drink")).not.toBe(`fb-${encodeURIComponent("food & drink")}`);

    // LOCALE-DEPENDENT case folding, which the plain `.toLowerCase()` test
    // above does not reach. `.toLocaleLowerCase()` maps "I" to a dotless "ı"
    // under a Turkish locale, and `.toUpperCase()` expands "ß" to "SS" --
    // changing the tag's LENGTH, not just its bytes. Either would make the
    // stamped tag depend on the runtime's locale, i.e. on which machine
    // built the response, which is the worst possible property for a value
    // that two separately-deployed Workers have to agree on byte for byte.
    expect(foodbankTag("ISLINGTON")).toBe("fb-ISLINGTON");
    expect(foodbankTag("ISLINGTON")).not.toBe(`fb-${"ISLINGTON".toLocaleLowerCase("tr-TR")}`);
    expect(foodbankTag("straße")).toBe("fb-straße");
    expect(foodbankTag("straße")).toHaveLength("fb-straße".length); // no SS expansion
  });

  it("passes an astral-plane character through as an intact surrogate pair", () => {
    // The boundary the accent tests do not reach: characters above U+FFFF are
    // TWO UTF-16 code units in JS but FOUR UTF-8 bytes on the wire. Any
    // "fix" for the length ceiling written with `.slice()` or `.substring()`
    // splits the pair and emits a lone surrogate, which is not valid UTF-8 --
    // the header would then carry a replacement character and stamp a tag
    // that no purge can ever name. Pinned as the shape a truncating helper
    // would have to break.
    const emoji = "\u{1F600}-food-bank"; // U+1F600, deliberately escaped
    expect(emoji).toHaveLength(12); // 2 code units for the emoji + 10
    const tag = foodbankTag(emoji);
    expect(tag).toBe(`fb-${emoji}`);
    expect(tag).not.toContain("�"); // no replacement character
    expect(tag.codePointAt(3)).toBe(0x1f600); // the pair survived intact
    expect(utf8Bytes(tag)).toBe(3 + 4 + 10); // prefix + 4-byte emoji + ASCII
  });

  it("does not enforce Django's max_length, which counts code points and not JS units", () => {
    // A REAL Django-parity divergence, and the reason the test above is not
    // just decoration. Foodbank.slug is CharField(max_length=100)
    // (foodbank.py:63) and Django counts that in Python characters, i.e.
    // CODE POINTS. JavaScript's `.length` counts UTF-16 CODE UNITS. For
    // anything on the astral plane the two disagree by a factor of two, so a
    // slug Django stored happily at exactly its limit measures 200 over here.
    //
    // That means a JS-side "enforce the schema" guard written the obvious way
    // -- `slug.slice(0, 100)` -- would silently halve such a slug, and would
    // cut it mid-surrogate-pair into the bargain. This module enforces
    // nothing, which is the behaviour being pinned: the length guard belongs
    // in D1 and in Django's own validation, both of which count the same
    // units as each other and neither of which is this file.
    const hundredCodePoints = "\u{1F600}".repeat(100);
    expect([...hundredCodePoints]).toHaveLength(100); // 100 to Django
    expect(hundredCodePoints).toHaveLength(200); // 200 to JS `.length`
    const tag = foodbankTag(hundredCodePoints);
    expect(tag).toBe(`fb-${hundredCodePoints}`);
    expect(tag).toHaveLength(203); // nothing was cut at 100 units
    expect(utf8Bytes(tag)).toBe(403); // 3 + 100 x 4 bytes
    // Still inside the 1024-byte ceiling, so no truncation is warranted even
    // at the schema's stated maximum -- the headroom argument holds for the
    // worst case, not just for ASCII.
    expect(utf8Bytes(tag)).toBeLessThan(1024);
  });

  it("treats the two Unicode forms of one accented name as two different tags", () => {
    // The sharpest version of the pairing hazard, and the reason no
    // normalisation belongs here OR upstream on one side only. "café" has
    // two byte sequences: NFC (e-acute as one code point) and NFD (e plus a
    // combining accent). They render identically, so a stale page caused by
    // this is invisible in a browser and invisible in a purge log.
    //
    // Pinned as current behaviour, NOT as a fix: if a stamped tag ever comes
    // back NFD from the URL path while D1 holds NFC, the fix is to normalise
    // at BOTH ends, and this test is the note saying this module normalises
    // at neither.
    const nfc = "café-food-bank";
    const nfd = "café-food-bank";
    // The two literals above are the same NAME in two byte sequences. If an
    // editor or formatter ever normalises this file it collapses them into
    // one, and the `not.toBe` below fails rather than passing for the wrong
    // reason -- the length check makes that failure legible.
    expect(nfd.normalize("NFC")).toBe(nfc); // same name, different bytes
    expect(nfd).toHaveLength(nfc.length + 1); // NFD carries a combining accent
    expect(foodbankTag(nfc)).not.toBe(foodbankTag(nfd));
    expect(foodbankTag(nfd)).toBe("fb-café-food-bank");
  });

  it("stringifies a non-string caller mistake rather than throwing", () => {
    // The signature says `string`, but the values come out of D1 at runtime
    // where TypeScript is a suggestion. parliamentary_constituency_slug is
    // nullable TEXT (0001_core.sql:34) and getFoodbankSlugById can miss, so
    // null/undefined genuinely reach the call sites -- the ONLY thing
    // stopping "fb-null" being queued is the truthiness guard upstream at
    // routes/admin/foodbank.ts:82 and routes/admin/needs.ts:175. Pinned so
    // that (a) removing one of those guards produces a known-shaped dud tag
    // rather than a crash in a queue producer, and (b) "fb-undefined"
    // appearing in a cache-purge log line (cachePurge.ts:110) is
    // immediately recognisable as this, not as a Cloudflare fault.
    expect(foodbankTag(null as unknown as string)).toBe("fb-null");
    expect(foodbankTag(undefined as unknown as string)).toBe("fb-undefined");
    // A numeric id passed where a slug was meant. -0 and 0 stringify to the
    // same "0", so they are not even distinguishable as dud tags; NaN is its
    // own recognisable shape.
    expect(foodbankTag(0 as unknown as string)).toBe("fb-0");
    expect(foodbankTag(-0 as unknown as string)).toBe("fb-0");
    expect(foodbankTag(Number.NaN as unknown as string)).toBe("fb-NaN");
  });
});

describe("constituencyTag", () => {
  it("produces pc-<slug>", () => {
    expect(constituencyTag("hastings-and-rye")).toBe("pc-hastings-and-rye");
  });

  it("never collides with a food bank of the same slug", () => {
    // Both slugs are slugify() of a place name (foodbank.py:634 and :679),
    // so overlaps are expected in the real data -- a food bank named after
    // the town its constituency is named after. The two-character prefix is
    // the only thing keeping them apart. routes/admin/foodbank.ts:80-82
    // pushes both into one purge message expecting two distinct tags; if the
    // namespaces merged, a constituency page could only ever be purged as a
    // side effect of the food bank that happens to share its name.
    //
    // NOTE this only covers the SAME slug on both sides, which is the
    // real-world case but the weak half of the invariant -- see the
    // "namespace disjointness" describe below for the cross-slug half, which
    // is what a nested prefix would break.
    for (const slug of [...REAL_SLUGS, "", "all"]) {
      expect(constituencyTag(slug)).not.toBe(foodbankTag(slug));
    }
  });

  it("does not validate or normalise, matching foodbankTag", () => {
    // Same shape, asserted separately rather than assumed: constituencyTag
    // is the helper fed by the NULLABLE column
    // (parliamentary_constituency_slug, 0001_core.sql:34), so it is the one
    // most likely to be "hardened" with a guard or a fallback. It has
    // neither today.
    expect(constituencyTag("")).toBe("pc-");
    expect(constituencyTag("Hastings-And-Rye")).toBe("pc-Hastings-And-Rye");
    expect(constituencyTag(" ynys-mon ")).toBe("pc- ynys-mon ");
    expect(constituencyTag("ynys-môn")).toBe("pc-ynys-môn");
    expect(constituencyTag(null as unknown as string)).toBe("pc-null");
  });
});

describe("AGGREGATE_TAG", () => {
  it("is one shared tag for every response that any food bank change invalidates", () => {
    // Not a restatement of the constant: `fb-all` is the value the live
    // probe recorded coming back on / (middleware/cacheTag.ts:26), so this
    // pins an observed edge behaviour against a rename on either side.
    //
    // Django re-lists the same set on every single save -- reverse("index"),
    // wfbn:rss, wfbn:geojson, api_foodbanks, sitemap, api2:foodbanks,
    // api2:locations, md_index (foodbank.py:719-757). This is that set given
    // a name, so cachePurge.ts can coalesce a whole batch of saves into one
    // entry (queues/cachePurge.ts:90-98).
    expect(AGGREGATE_TAG).toBe("fb-all");
    // It has to survive being unioned into a Set and JSON-serialised on the
    // way to purge_cache (cachePurge.ts:94 and :108) -- i.e. it must be a
    // plain scalar string, not a String object or a template that could
    // stringify differently across the queue boundary.
    expect(typeof AGGREGATE_TAG).toBe("string");
    expect(JSON.parse(JSON.stringify({ tags: [...new Set([AGGREGATE_TAG, AGGREGATE_TAG])] }))).toEqual({
      tags: ["fb-all"],
    });
  });

  it("shares the fb- namespace, so a food bank slugged 'all' would collide -- harmlessly", () => {
    // Pinned because the collision is real and worth knowing about rather
    // than rediscovering. A food bank named exactly "All ..." slugifying to
    // "all" would carry the aggregate tag. The consequence is over-purging
    // in both directions and never a missed purge: an aggregate purge also
    // clears that one food bank's pages, and that food bank's purge also
    // clears the aggregates -- which routes/admin/foodbank.ts:80 asks for
    // anyway, on every save.
    expect(foodbankTag("all")).toBe(AGGREGATE_TAG);
    // The collision is exactly one slug wide. "all-saints" and "All" do NOT
    // collide, so the reasoning above ("harmless, because that food bank's
    // purge is a superset") holds only for the single exact slug and does
    // not quietly extend to a whole family of them.
    expect(foodbankTag("all-saints")).not.toBe(AGGREGATE_TAG);
    expect(foodbankTag("All")).not.toBe(AGGREGATE_TAG);
    // And the constituency namespace is not affected at all.
    expect(constituencyTag("all")).not.toBe(AGGREGATE_TAG);
  });

  it("is distinct from every real food bank and constituency tag", () => {
    for (const slug of REAL_SLUGS) {
      expect(foodbankTag(slug)).not.toBe(AGGREGATE_TAG);
      expect(constituencyTag(slug)).not.toBe(AGGREGATE_TAG);
    }
  });
});

describe("mediaTag and MEDIA_TAG", () => {
  it("reconstructs the header routes/media.ts writes by hand", () => {
    // routes/media.ts:163 and :216 set `media, media-${slug}` as a literal;
    // they do not import this module. This assertion is the only thing tying
    // the two together, so if either side is renamed one of these fails.
    // The slug there is the food bank's own (media lives at
    // /needs/at/<slug>/photo.jpg -- media.ts:49).
    expect(`${MEDIA_TAG}, ${mediaTag("sid-valley")}`).toBe("media, media-sid-valley");
  });

  it("keeps the site-wide media tag separate from one object's", () => {
    // Exact-match again: purging "media" does not purge "media-sid-valley",
    // which is why media.ts sets BOTH on every media response -- one to drop
    // every photo at once, one to drop a single food bank's.
    for (const slug of [...REAL_SLUGS, ""]) {
      expect(mediaTag(slug)).not.toBe(MEDIA_TAG);
    }
  });

  it("does not collide with the food bank or constituency namespaces", () => {
    // A food bank photo carries three tags at once: media.ts sets
    // `media, media-<slug>` and middleware/cacheTag.ts:95 appends
    // `fb-<slug>` to it, because /needs/at/<slug>/photo.jpg matches
    // FOODBANK_PATH. All three have to stay separately purgeable.
    //
    // Same caveat as constituencyTag's: one slug fed to all four, which a
    // nested prefix would survive. The general form is below.
    for (const slug of REAL_SLUGS) {
      const tags = new Set([MEDIA_TAG, mediaTag(slug), foodbankTag(slug), constituencyTag(slug)]);
      expect(tags.size).toBe(4);
    }
  });

  it("is the same no-validation shape as the other helpers", () => {
    // Asserted rather than assumed, because mediaTag's real caller passes
    // c.req.param("slug") -- a value straight off the request path
    // (media.ts:163), not out of D1 -- so it is the helper most exposed to
    // whatever a client puts in a URL, and the most tempting one to "harden"
    // here instead of at the route. It normalises nothing today.
    expect(mediaTag("")).toBe("media-");
    expect(mediaTag("Sid-Valley")).toBe("media-Sid-Valley");
    expect(mediaTag("Sid-Valley")).not.toBe(mediaTag("sid-valley"));
    expect(mediaTag(undefined as unknown as string)).toBe("media-undefined");
  });
});

// The existing collision tests all feed ONE slug to two helpers and check
// the answers differ. That is the case that occurs in production, but it is
// the half of the invariant that a broken implementation survives. Consider
// a plausible, well-meaning refactor that "namespaces constituencies under
// food banks":
//
//   export function constituencyTag(slug: string) { return `fb-pc-${slug}`; }
//
// Every same-slug test still passes -- constituencyTag("york") is
// "fb-pc-york", foodbankTag("york") is "fb-york", plainly different. But
// foodbankTag("pc-york") is ALSO "fb-pc-york", so a food bank whose slug
// begins "pc-" and a constituency now share a tag: purging one purges the
// other, and neither can be purged alone. The same trap catches
// `media-${slug}` moved under the fb- prefix.
//
// What actually guarantees disjointness is that no namespace prefix is a
// prefix of another, which is a property of the prefixes themselves rather
// than of any slug pair. So assert that, and then demonstrate it survives a
// cartesian product of slugs chosen to exploit exactly this nesting.
describe("namespace disjointness", () => {
  // Recovered from the helpers rather than retyped, so this cannot drift
  // from the module the way a hand-copied literal would -- and so that a
  // changed prefix is caught by the exact-string tests above, not silently
  // absorbed here.
  const PREFIXES = {
    foodbankTag: foodbankTag(""),
    constituencyTag: constituencyTag(""),
    mediaTag: mediaTag(""),
  };

  it("uses prefixes where none is a prefix of another", () => {
    expect(PREFIXES).toEqual({ foodbankTag: "fb-", constituencyTag: "pc-", mediaTag: "media-" });
    const entries = Object.entries(PREFIXES);
    for (const [leftName, left] of entries) {
      for (const [rightName, right] of entries) {
        if (leftName === rightName) continue;
        // Not `!==`: two DISTINCT prefixes can still nest ("fb-" inside
        // "fb-pc-"), and nesting is the thing that lets a slug in one
        // namespace forge a tag in another.
        expect(left.startsWith(right), `${leftName} (${left}) nests inside ${rightName} (${right})`).toBe(false);
      }
    }
  });

  it("cannot be made to collide by any slug pair, including slugs shaped like other namespaces", () => {
    const helpers = [
      ["foodbankTag", foodbankTag],
      ["constituencyTag", constituencyTag],
      ["mediaTag", mediaTag],
    ] as const;
    // Every one of these is a slug that LOOKS like it belongs to a different
    // namespace -- the forgery attempts. "" and "all" are in for the empty
    // and the known-collision boundaries.
    const forgeries = ["york", "", "all", "fb-york", "pc-york", "media-york", "fb-all", "media", "fb-", "pc-"];
    for (const [leftName, left] of helpers) {
      for (const [rightName, right] of helpers) {
        if (leftName === rightName) continue;
        for (const a of forgeries) {
          for (const b of forgeries) {
            expect(left(a), `${leftName}(${a}) forged ${rightName}(${b})`).not.toBe(right(b));
          }
        }
      }
    }
  });

  it("keeps MEDIA_TAG outside every helper's namespace, unlike AGGREGATE_TAG", () => {
    // The two site-wide constants sit differently, and the difference is
    // load-bearing rather than incidental.
    //
    // AGGREGATE_TAG lives INSIDE the fb- namespace -- foodbankTag("all")
    // reproduces it exactly -- which is the documented, harmless,
    // one-slug-wide collision asserted above.
    expect(AGGREGATE_TAG.startsWith(PREFIXES.foodbankTag)).toBe(true);
    // MEDIA_TAG does NOT live inside mediaTag's namespace: "media" is not
    // "media-" plus anything, because the hyphen is part of the prefix. So
    // no slug whatsoever can forge the site-wide media tag -- which matters
    // because mediaTag's caller passes c.req.param("slug") straight off the
    // request path (media.ts:163), i.e. attacker-chosen. If the prefix were
    // bare "media" instead, a request for /needs/at//photo.jpg would stamp
    // the site-wide tag onto one photo and a single-object purge would drop
    // every photo on the site.
    expect(MEDIA_TAG.startsWith(PREFIXES.mediaTag)).toBe(false);
    for (const slug of [...SLUGIFY_SHAPED, "", "media", "-"]) {
      expect(mediaTag(slug)).not.toBe(MEDIA_TAG);
      expect(foodbankTag(slug)).not.toBe(MEDIA_TAG);
      expect(constituencyTag(slug)).not.toBe(MEDIA_TAG);
      expect(constituencyTag(slug)).not.toBe(AGGREGATE_TAG);
      expect(mediaTag(slug)).not.toBe(AGGREGATE_TAG);
    }
  });
});

// Nothing outside this package imports "./cacheTags". Both Workers import
// the PACKAGE -- `import { foodbankTag } from "@givefood/urls"`
// (middleware/cacheTag.ts:2, routes/admin/foodbank.ts:6, needs.ts:33,
// donationPoint.ts:4, foodbankLocation.ts:4, queues/articles.ts:1) -- and
// package.json's "main" points at ./src/index.ts, whose last line is
// `export * from "./cacheTags"`.
//
// Every other test in this file imports "./cacheTags" directly, so deleting
// that one re-export line leaves all of them green while both Workers stop
// resolving the symbols. It is a one-line deletion, it looks like tidying an
// unused export, and nothing else in the suite notices. Hence this.
describe("the @givefood/urls entry point", () => {
  it("re-exports all five tag symbols, which is the only way any consumer reaches them", () => {
    // Identity, not equality: `export *` re-exports live bindings, so these
    // must be the SAME function objects. A wrapper or a re-implementation in
    // index.ts would satisfy a behavioural check and still be a second copy
    // of the wire format, which is the exact thing this module exists to
    // prevent.
    expect(urlsPackage.foodbankTag).toBe(foodbankTag);
    expect(urlsPackage.constituencyTag).toBe(constituencyTag);
    expect(urlsPackage.mediaTag).toBe(mediaTag);
    expect(urlsPackage.AGGREGATE_TAG).toBe(AGGREGATE_TAG);
    expect(urlsPackage.MEDIA_TAG).toBe(MEDIA_TAG);
    // And that the re-export actually carries behaviour, not just a name:
    // this is the literal middleware/cacheTag.ts:72 stamps.
    expect(urlsPackage.foodbankTag("sid-valley")).toBe("fb-sid-valley");
  });
});

describe("the Cache-Tag header these build", () => {
  it("counts UTF-8 bytes correctly, since every ceiling assertion below trusts it", () => {
    // The measuring instrument, checked against known answers before it is
    // used to measure anything. This file deliberately rejected TextEncoder
    // (see utf8Bytes above), so the counter is hand-rolled -- and a
    // hand-rolled counter that were wrong would make every "inside the
    // 1024-byte ceiling" assertion below meaningless while still passing.
    // One case per UTF-8 width:
    expect(utf8Bytes("a")).toBe(1); // ASCII
    expect(utf8Bytes("é")).toBe(2); // Latin-1 supplement
    expect(utf8Bytes("☃")).toBe(3); // BMP
    expect(utf8Bytes("\u{1F600}")).toBe(4); // astral plane, one surrogate pair
    expect(utf8Bytes("")).toBe(0);
    // The characters encodeURIComponent leaves UNRESERVED are the ones a
    // naive collapse-the-triples counter would get right by luck; these are
    // the ones it has to expand and re-count.
    expect(utf8Bytes("a b")).toBe(3);
    expect(utf8Bytes("&")).toBe(1);
    expect(utf8Bytes("st-mary's")).toBe(9);
  });

  it("survives the comma-join the middleware does and the split Cloudflare does", () => {
    // middleware/cacheTag.ts:95 joins tags with ", " into one Cache-Tag
    // header and Cloudflare splits that back on commas. For slugify-shaped
    // slugs no tag contains a comma or a space, so the round trip is lossless
    // -- a tag containing either would silently become two tags, neither of
    // which anything purges.
    const header = [foodbankTag("sid-valley"), constituencyTag("hastings-and-rye"), AGGREGATE_TAG].join(", ");
    expect(header).toBe("fb-sid-valley, pc-hastings-and-rye, fb-all");
    expect(header.split(", ")).toEqual(["fb-sid-valley", "pc-hastings-and-rye", "fb-all"]);
    // Scanned over every slug SHAPE the schema permits, not just the four
    // friendly ones: the invariant is about the helpers, so a helper that
    // inserted a separator for numeric or hyphen-heavy slugs has to fail
    // here.
    //
    // The separator scan alone is a purely NEGATIVE assertion, though, and a
    // negative assertion is satisfied by a helper that returns nothing at
    // all: `foodbankTag = () => ""` contains no comma and no space and would
    // sail through it. So each scan also collects its tags and checks the
    // mapping is still injective and non-empty over the whole shaped set --
    // which is what a collapsing, truncating or constant-returning helper
    // cannot do.
    for (const [name, helper] of [
      ["foodbankTag", foodbankTag],
      ["constituencyTag", constituencyTag],
      ["mediaTag", mediaTag],
    ] as const) {
      const tags = SLUGIFY_SHAPED.map(helper);
      for (const [i, tag] of tags.entries()) {
        expect(tag, `${name}(${SLUGIFY_SHAPED[i]}) would split the header`).not.toMatch(/[,\s]/);
        expect(tag.length, `${name}(${SLUGIFY_SHAPED[i]}) produced an empty tag`).toBeGreaterThan(0);
      }
      // Distinct slugs, distinct tags -- SLUGIFY_SHAPED holds no duplicates,
      // so any shortfall here is the helper mapping two food banks onto one
      // tag, and one of them then being unpurgeable.
      expect(new Set(SLUGIFY_SHAPED)).toHaveLength(SLUGIFY_SHAPED.length);
      expect(new Set(tags), `${name} is not injective over the shaped slugs`).toHaveLength(SLUGIFY_SHAPED.length);
    }
    expect(AGGREGATE_TAG).not.toMatch(/[,\s]/);
    expect(MEDIA_TAG).not.toMatch(/[,\s]/);
  });

  it("stays far inside Cloudflare's per-tag length ceiling at the longest slug the schema allows", () => {
    // Foodbank.slug is CharField(max_length=100) (foodbank.py:63), so the
    // longest tag this can ever emit is 103 characters against Cloudflare's
    // 1024-BYTE limit for a single cache tag. Measured in bytes, not in
    // `.length`: the two only coincide for ASCII, and legacy Django slugs
    // are not guaranteed to be ASCII (PLAN.md §6.9 R7).
    const longest = "a".repeat(100);
    expect(foodbankTag(longest)).toBe(`fb-${longest}`);
    expect(utf8Bytes(foodbankTag(longest))).toBe(103);
    expect(utf8Bytes(foodbankTag(longest))).toBeLessThan(1024);
    // That headroom is why none of these helpers truncate or hash. The
    // comment is not enough on its own -- this is the assertion that a
    // truncating "fix" would have to break: two maximum-length slugs
    // differing only in their last character must stay separately
    // purgeable.
    const a = `${"a".repeat(99)}1`;
    const b = `${"a".repeat(99)}2`;
    expect(foodbankTag(a)).not.toBe(foodbankTag(b));
    expect(mediaTag(a)).not.toBe(mediaTag(b));
    expect(constituencyTag(a)).not.toBe(constituencyTag(b));
  });

  it("costs BYTES, not characters, for a non-ASCII slug", () => {
    // The ceiling is a byte budget, so a 100-character accented slug is 203
    // bytes, not 103. Still an order of magnitude inside 1024, which is why
    // nothing here counts -- but pinned so that if a length check is ever
    // added it is written against bytes. A check written against `.length`
    // would pass a slug that the API then rejects.
    const accented = "é".repeat(100); // 100 chars, 200 bytes in UTF-8
    const tag = foodbankTag(accented);
    expect(tag).toHaveLength(103);
    expect(utf8Bytes(tag)).toBe(203);
    expect(utf8Bytes(tag)).toBeLessThan(1024);
  });

  it("does not truncate, hash or throw on input far beyond the schema maximum", () => {
    // Current behaviour, documented rather than endorsed. Nothing in this
    // module knows about the 1024-byte ceiling, so a slug longer than the
    // schema permits produces an over-limit tag that Cloudflare would reject
    // -- and cachePurge.ts's purge() treats that rejection as a failed batch
    // and retries it (cachePurge.ts:74-77, :115), so it is loud rather than
    // silent. The guard is the D1 column and Django's max_length, not here.
    const absurd = "z".repeat(2000);
    expect(() => foodbankTag(absurd)).not.toThrow();
    expect(utf8Bytes(foodbankTag(absurd))).toBe(2003);
    expect(foodbankTag(absurd).endsWith("z")).toBe(true); // not truncated
  });

  it("passes a comma in a slug straight through, unescaped", () => {
    // Current behaviour, documented rather than endorsed: nothing here
    // escapes its input, so a slug containing a comma would split into two
    // tags in the header. It is not reachable from the web -- the middleware
    // takes the slug from the path but only stamps 2xx responses
    // (middleware/cacheTag.ts:85), and an invented slug 404s before it gets
    // there -- and every other caller passes a slugify()d value out of D1.
    // If a caller ever starts passing raw user input, this test is the note
    // saying the guard is upstream, not here.
    expect(foodbankTag("a,b")).toBe("fb-a,b");
    expect(foodbankTag("a,b").split(", ")).toHaveLength(1); // ", " survives; a bare "," would not
    expect(foodbankTag("a, b").split(", ")).toEqual(["fb-a", "b"]);
    // The same hole in the two helpers whose input is NOT a D1 column:
    // mediaTag's caller reads the request path (media.ts:163), and a joined
    // header would gain a third tag the purger never names.
    expect(`${MEDIA_TAG}, ${mediaTag("a, b")}`.split(", ")).toEqual(["media", "media-a", "b"]);
    expect(constituencyTag("a, b").split(", ")).toEqual(["pc-a", "b"]);
  });
});
