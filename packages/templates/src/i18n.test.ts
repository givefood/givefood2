import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LOCALES, loadCatalogue, translate, type Locale } from "./i18n";
import { parsePoFile } from "./poParser";
import * as publicSurface from "./index";

// The whole of the port's i18n runtime: which languages exist, where a
// language's strings come from, and what happens to a string that has no
// translation.
//
// Everything this module gets wrong fails SILENTLY IN THE OTHER THREE
// LANGUAGES ONLY. An English-speaking maintainer loading the site sees
// nothing: `translate()` falls through to the msgid, so a catalogue that
// failed to load, a msgid whose apostrophe does not match the .po file's,
// or a locale dropped from LOCALES all render as perfectly correct English
// pages. The bug is only visible to the Welsh, Irish and Scottish Gaelic
// readers the four-language decision (i18n.ts:1-4, §2.7.1) exists to serve,
// and it is visible to them as "this site is not actually translated".
//
// Verified for this suite, not assumed:
//   - The port's locale/{cy,ga,gd}/django.po are byte-identical to the
//     Django app's locale/{cy,ga,gd}/LC_MESSAGES/django.po (`diff -q`,
//     against /Users/jasoncartwright/Sites/foodcharity). The claim in
//     precompile.ts:83 that they are "copied verbatim" holds today.
//   - Django's settings.py LANGUAGES really does list 21 languages
//     (settings.py:233-256), of which this port keeps 4. The module header's
//     "4 languages, not Django's 21" is accurate.
//   - Every CPython comparison below was run on this machine's python3
//     (3.13.0). Where a comment says Python raises, Python was asked.

const LOCALE_DIR = fileURLToPath(new URL("../locale/", import.meta.url).href);

// The three catalogues that actually ship, i.e. LOCALES minus the source
// language. Derived rather than listed so adding a fifth language to
// LOCALES makes these tests cover it rather than quietly skip it.
const TRANSLATED = LOCALES.filter((locale): locale is Exclude<Locale, "en"> => locale !== "en");

describe("LOCALES", () => {
  // workers/site/src/index.ts mounts the entire prefixed route tree with
  // `for (const locale of LOCALES)` (nine separate loops, at :205, :338,
  // :394, :410, :432, :450, :472, :487, :519). This array is therefore not
  // a list of "languages we support" -- it is the list of URL prefixes that
  // exist at all. Dropping "gd" here does not degrade Scottish Gaelic to
  // English; it 404s every /gd/ URL on the site, including ones already in
  // Google's index.
  it("is exactly the four languages the port kept, English first", () => {
    expect(LOCALES).toEqual(["en", "cy", "ga", "gd"]);
  });

  // Order is load-bearing beyond aesthetics: precompile.ts:86-92 iterates
  // LOCALES and `continue`s past "en", and resolveLanguage/pageCacheControl
  // derive their prefix sets from it. "en" being first is also what makes
  // the source language the obvious default when reading the array.
  it("puts the source language first, and it is the only untranslated one", () => {
    expect(LOCALES[0]).toBe("en");
    expect(TRANSLATED).toEqual(["cy", "ga", "gd"]);
  });

  // The exclusion half, which is the half that actually catches a mistake:
  // Django ships 21 LANGUAGES and the maintainer decision was to port 4.
  // A test that only asserts the four present would pass just as happily if
  // someone re-added "pl" -- and re-adding a locale here mounts a /pl/ route
  // tree whose catalogue does not exist, so loadCatalogue("pl") would fault
  // on LOADERS["pl"] being undefined at request time, not at build time.
  it("excludes the seventeen Django languages that were dropped", () => {
    // Verbatim from foodcharity/givefood/settings.py:233-256, minus the four
    // kept. `as readonly string[]` because these are deliberately NOT of
    // type Locale -- that is the point of the test.
    const DROPPED = [
      "pl",
      "bn",
      "ro",
      "pa",
      "ur",
      "ar",
      "gu",
      "es",
      "pt",
      "it",
      "ta",
      "fr",
      "lt",
      "zh-hans",
      "tr",
      "bg",
      "tlh",
    ];
    expect(DROPPED).toHaveLength(17);
    for (const code of DROPPED) {
      expect((LOCALES as readonly string[]).includes(code)).toBe(false);
    }
  });

  // A locale listed here but missing from LOADERS is a runtime TypeError
  // ("LOADERS[locale] is not a function") on the first request to that
  // language's prefix, in production, with no build-time warning -- the two
  // structures are separate literals in the same file and nothing ties them
  // together. This is the test that ties them together.
  it("has a working loader for every locale it lists", async () => {
    for (const locale of LOCALES) {
      await expect(loadCatalogue(locale)).resolves.toBeTypeOf("object");
    }
  });
});

describe("loadCatalogue: English", () => {
  // English is the source language: msgids ARE the English text, so an
  // empty catalogue plus translate()'s fall-through to msgid is the whole
  // implementation. Asserting {} rather than "truthy" matters because a
  // catalogue with any entry at all would mean English text is being
  // round-tripped through a translation table it should never touch.
  it("is an empty catalogue, not a loaded file", async () => {
    expect(await loadCatalogue("en")).toEqual({});
  });

  // `return {}` allocates fresh each call and is deliberately NOT put in
  // the shared `cache` Map. If it ever were cached, the mutation hazard
  // proven below for cy/ga/gd would apply to English too -- and English is
  // the fall-through every other locale depends on.
  it("hands out a fresh object each call, so a caller cannot poison English", async () => {
    const first = await loadCatalogue("en");
    (first as Record<string, string>)["Home"] = "Poisoned";
    expect(await loadCatalogue("en")).toEqual({});
  });
});

describe("loadCatalogue: the three translated catalogues", () => {
  // Real values from the real .po files, one per language for the same
  // msgid. Three distinct strings is what proves each LOADER points at its
  // own JSON: a copy-paste slip making all three entries import cy.json
  // would still return "an object with translations in it" for ga and gd,
  // and every shape-only assertion would pass while Irish readers got Welsh.
  it("returns that language's own translations, not another's", async () => {
    expect((await loadCatalogue("cy"))["Home"]).toBe("Cartref");
    expect((await loadCatalogue("ga"))["Home"]).toBe("Baile");
    expect((await loadCatalogue("gd"))["Home"]).toBe("Dachaidh");
  });

  it("carries the multi-word strings too, not just the one-word labels", async () => {
    expect((await loadCatalogue("cy"))["Email"]).toBe("E-bost");
    expect((await loadCatalogue("ga"))["Email"]).toBe("Ríomhphost");
    expect((await loadCatalogue("gd"))["Email"]).toBe("Post-d");
  });

  // src/generated/ is .gitignored (.gitignore:12) and rebuilt by
  // `pnpm precompile`. Nothing forces that to run before a test, a dev
  // server or a deploy of an unrelated worker, so the JSON on disk can be
  // older than the .po beside it -- and a stale catalogue is invisible:
  // every string that did not change still translates. This compares what
  // loadCatalogue actually serves against the source of truth, through the
  // same parser precompile.ts uses.
  it.each(TRANSLATED)("%s: the generated JSON is in sync with that locale's django.po", async (locale) => {
    const fromSource = parsePoFile(readFileSync(`${LOCALE_DIR}${locale}/django.po`, "utf-8"));
    // Floor first: a truncated or empty catalogue would deep-equal an
    // equally broken parse and pass the real assertion vacuously.
    expect(Object.keys(fromSource).length).toBeGreaterThan(250);
    expect(await loadCatalogue(locale)).toEqual(fromSource);
  });

  // The .po header block is `msgid ""` with the MIME/Plural-Forms metadata
  // as its msgstr. poParser drops it (poParser.ts:69), and it must stay
  // dropped: an entry under the empty-string key would make
  // translate(catalogue, "") return "Project-Id-Version: ...\nMIME-Version:
  // 1.0\n..." into a rendered page.
  it.each(TRANSLATED)("%s has no entry for the PO header's empty msgid", async (locale) => {
    expect(Object.hasOwn(await loadCatalogue(locale), "")).toBe(false);
  });

  // poParser only stores an entry when msgstr is non-empty, so an
  // untranslated msgid is absent rather than present-and-blank. That is
  // what makes translate()'s `msgstr.length > 0` guard defensive rather
  // than load-bearing -- and if a future parser change started storing ""
  // entries, this is the test that says so before the site starts rendering
  // blank labels.
  it.each(TRANSLATED)("%s maps no msgid to an empty string", async (locale) => {
    const catalogue = await loadCatalogue(locale);
    expect(Object.entries(catalogue).filter(([, msgstr]) => msgstr === "")).toEqual([]);
  });
});

describe("loadCatalogue: the module-scope cache", () => {
  // The point of the Map (i18n.ts:20-22): a Worker isolate serves many
  // requests and re-importing/re-parsing a 26KB JSON blob per render would
  // undo the reason the loaders are dynamic in the first place. Object
  // identity is the only way to see a cache hit from outside.
  //
  // vi.resetModules() is not decoration. Written against the shared module
  // instance this test is VACUOUS: earlier tests in this file have already
  // populated `cache` for every locale, so both calls take the cache-hit
  // branch and a miss-path that returned a fresh copy each time would still
  // pass. Confirmed by mutation -- `return { ...mod.default }` survived the
  // shared-instance version of this test and is killed by this one.
  it("returns the identical object on the second call, cold miss then hit", async () => {
    vi.resetModules();
    const fresh = await import("./i18n");
    const first = await fresh.loadCatalogue("cy");
    expect(await fresh.loadCatalogue("cy")).toBe(first);
    expect(first["Home"]).toBe("Cartref");
  });

  // Two concurrent requests for the same cold locale both miss the cache
  // and both await LOADERS[locale]() -- there is no in-flight promise map.
  // That is harmless only because the ES module registry dedupes the
  // dynamic import itself, so both awaits resolve to the same module
  // namespace and the second cache.set() overwrites with the same object.
  // If a loader were ever changed to build a fresh object (e.g. a JSON
  // string parsed per call), this test is what would catch two isolates'
  // worth of catalogue existing at once.
  it("survives a concurrent cold miss with one object, not two", async () => {
    vi.resetModules();
    const fresh = await import("./i18n");
    const [a, b] = await Promise.all([fresh.loadCatalogue("ga"), fresh.loadCatalogue("ga")]);
    expect(a).toBe(b);
    expect(a["Home"]).toBe("Baile");
  });

  // SUSPECT, pinned as-is: the cached catalogue is handed out by reference,
  // so any caller can edit every subsequent request's translations for the
  // life of the isolate. No current caller writes to it -- env.ts:108-112
  // and the four workers/site call sites only read -- so this is a latent
  // hazard, not a live bug, and freezing it is a source change this suite
  // is not allowed to make. Documented here so the next person to add a
  // "just patch one string in" call site finds out what it costs.
  it("shares one mutable object with every caller (latent hazard)", async () => {
    const catalogue = await loadCatalogue("gd");
    const original = catalogue["Home"];
    catalogue["Home"] = "Mutated";
    try {
      expect((await loadCatalogue("gd"))["Home"]).toBe("Mutated");
    } finally {
      // Restore: this module's cache is shared with every other test in
      // this file, and vitest gives no per-test module isolation.
      catalogue["Home"] = original!;
    }
    expect((await loadCatalogue("gd"))["Home"]).toBe("Dachaidh");
  });
});

describe("translate: catalogue lookup", () => {
  it("returns the translation when the msgid is in the catalogue", () => {
    expect(translate({ Home: "Cartref" }, "Home")).toBe("Cartref");
  });

  // The gettext contract, and the reason a missing translation is invisible
  // to an English reader: the msgid IS the English string, so falling
  // through renders a correct page in the wrong language.
  it("falls through to the msgid when the catalogue has no entry", () => {
    expect(translate({ Home: "Cartref" }, "Donate")).toBe("Donate");
  });

  // gettext's own behaviour for an untranslated entry, kept explicitly
  // (i18n.ts:47) even though poParser never produces one. Without the
  // `.length > 0` half of the guard this returns "" and the label vanishes
  // from the page rather than appearing in English.
  it("falls through to the msgid when the entry is an empty string", () => {
    expect(translate({ Donate: "" }, "Donate")).toBe("Donate");
  });

  // Returns a plain string, NOT a nunjucks SafeString -- unlike
  // BlocktransExtension.run(), which wraps its output
  // (blocktransExtension.ts:163) precisely because blocktrans msgstrs
  // contain markup. This is why the module header restricts translate() to
  // `{% trans %}`-style no-HTML strings: an HTML-bearing msgstr routed
  // through `_()` comes back raw and autoescape then escapes it into
  // visible &lt;a href=...&gt; on the page.
  it("returns a bare string, so autoescape will escape any HTML in it", () => {
    const withMarkup = translate({ x: 'Part of <a href="/f/">F</a>' }, "x");
    expect(typeof withMarkup).toBe("string");
    expect(withMarkup).toBe('Part of <a href="/f/">F</a>');
  });

  // SUSPECT, pinned as-is: `catalogue[msgid]` is an unguarded property read
  // on a plain object, so msgids that collide with Object.prototype resolve
  // to inherited members. Two shapes, both reached in this exact code:
  //   - a zero-arity method (toString, valueOf) has .length === 0, fails the
  //     guard, and falls through to the msgid -- accidentally correct.
  //   - a method with arguments (hasOwnProperty, .length === 1) or the
  //     constructor (Object, .length === 1) passes the guard and is then
  //     handed to interpolate(), where `template.replace` is not a function
  //     and the render throws a TypeError.
  // No .po in this repo contains such a msgid (checked: none of the three
  // catalogues has a key named constructor/hasOwnProperty/toString/valueOf/
  // __proto__), so this cannot fire today. It would fire the day someone
  // marks the literal word "constructor" translatable. A null-prototype
  // catalogue or Object.hasOwn() guard would fix it; both are source
  // changes, so this pins the current behaviour instead.
  it("falls through harmlessly for zero-arity prototype msgids", () => {
    expect(translate({}, "toString")).toBe("toString");
    expect(translate({}, "valueOf")).toBe("valueOf");
    expect(translate({}, "__proto__")).toBe("__proto__");
  });

  it("THROWS for prototype msgids that carry arguments (suspect)", () => {
    expect(() => translate({}, "constructor")).toThrow(TypeError);
    expect(() => translate({}, "hasOwnProperty")).toThrow(TypeError);
  });
});

describe("translate: %(name)s interpolation", () => {
  it("substitutes a bound variable", () => {
    expect(translate({}, "Food banks in %(location)s", { location: "Cardiff" })).toBe("Food banks in Cardiff");
  });

  // Interpolation happens on the TRANSLATED string, not the msgid, and the
  // placeholder can sit in a different position in the target language --
  // which is the entire reason gettext uses named rather than positional
  // placeholders. Real cy entry from locale/cy/django.po.
  it("substitutes into the msgstr, at the msgstr's own placeholder position", () => {
    const catalogue = { "Food banks in %(constituency_name)s": "Banciau bwyd yn %(constituency_name)s" };
    expect(translate(catalogue, "Food banks in %(constituency_name)s", { constituency_name: "Ceredigion" })).toBe(
      "Banciau bwyd yn Ceredigion",
    );
  });

  // A translator is allowed to drop a placeholder the target language does
  // not need. The extra var is simply unused -- no throw, no leftover
  // marker.
  it("ignores a var the msgstr does not use", () => {
    expect(translate({ "Hi %(n)s": "Shwmae" }, "Hi %(n)s", { n: "Sam" })).toBe("Shwmae");
  });

  it("substitutes every occurrence, not just the first", () => {
    expect(translate({}, "%(a)s and %(a)s", { a: "beans" })).toBe("beans and beans");
  });

  it("substitutes several distinct placeholders in one string", () => {
    expect(translate({}, 'Part of <a href="%(url)s">%(name)s</a>', { url: "/f/x/", name: "X" })).toBe(
      'Part of <a href="/f/x/">X</a>',
    );
  });

  // The default `vars = {}` -- every current production call site passes no
  // vars at all (manifest.ts:12, rss.ts:50, timesince.ts:141-142), so this
  // is the path that actually runs. A placeholder left in a string nobody
  // supplies vars for is blanked, not left visible as "%(x)s".
  it("blanks placeholders when vars is omitted entirely", () => {
    expect(translate({}, "Food banks in %(location)s")).toBe("Food banks in ");
  });

  // DIVERGENCE FROM DJANGO, pinned deliberately. Django's gettext output is
  // interpolated with Python's `%` operator, and CPython 3.13.0 on this
  // machine raises KeyError('name') for `"Hi %(name)s" % {}` -- run, not
  // assumed. The port silently substitutes "". Django's behaviour is a 500;
  // this is a subtly wrong sentence. Neither is good, but the port's choice
  // is the one that keeps a page up, and it is what ships.
  it("substitutes empty string for a missing key, where Python raises KeyError", () => {
    expect(translate({}, "Hi %(name)s")).toBe("Hi ");
  });

  // interpolate() uses Object.prototype.hasOwnProperty.call, not `key in
  // vars`. The difference only shows on inherited names: with `in`, the
  // msgid "%(toString)s" would render "function toString() { [native code]
  // }" into the page. This assertion is the one that kills that mutant --
  // every other interpolation test here passes with either operator.
  it("does not read inherited properties off the vars object", () => {
    expect(translate({}, "%(toString)s", {})).toBe("");
    expect(translate({}, "%(constructor)s", {})).toBe("");
  });

  // An own property explicitly set to undefined IS supplied, so it
  // stringifies rather than blanking -- the hasOwnProperty check tests for
  // presence, not for definedness. Worth pinning because "undefined" and
  // "null" appearing mid-sentence on a live page is the visible symptom of
  // a caller passing an unresolved value, and someone reading this code
  // could reasonably assume it was blanked instead.
  it("stringifies null and an explicit undefined rather than blanking them", () => {
    expect(translate({}, "%(x)s", { x: null })).toBe("null");
    expect(translate({}, "%(x)s", { x: undefined })).toBe("undefined");
  });

  // Python's `%` renders None as "None" and a list as "[1, 2]" (both run on
  // this machine's CPython 3.13.0). String() gives "null" and "1,2". Pinned
  // as a known cosmetic divergence; no current call site passes anything
  // but a string.
  it("stringifies other values with String(), not Python's repr", () => {
    expect(translate({}, "%(n)s", { n: 0 })).toBe("0");
    expect(translate({}, "%(n)s", { n: false })).toBe("false");
    expect(translate({}, "%(n)s", { n: [1, 2] })).toBe("1,2");
    expect(translate({}, "%(n)s", { n: {} })).toBe("[object Object]");
  });

  // String.prototype.replace with a FUNCTION replacer does not interpret
  // "$&", "$`" or "$'" in the returned text. With the shorter-looking
  // `.replace(re, vars[key])` string form it would, and a food bank whose
  // name or a location string contained "$&" would silently duplicate the
  // matched placeholder into the page. Real user-supplied values flow
  // through here (locations, food bank names), so this is not theoretical.
  it("does not interpret $-patterns in a substituted value", () => {
    expect(translate({}, "%(x)s", { x: "$&" })).toBe("$&");
    expect(translate({}, "a%(x)sb", { x: "$`$'" })).toBe("a$`$'b");
  });

  // Single pass: a substituted value that itself looks like a placeholder
  // is not re-scanned. Prevents a translated string being used to inject
  // another lookup.
  it("does not re-scan a substituted value for further placeholders", () => {
    expect(translate({}, "%(a)s%(b)s", { a: "%(b)s", b: "Q" })).toBe("%(b)sQ");
  });
});

describe("translate: what the placeholder syntax does NOT match", () => {
  // The key charset is [a-zA-Z0-9_]+ -- narrower than Python's, which
  // accepts any character up to the closing paren. CPython 3.13.0 returns
  // "v" for both `"%(a-b)s" % {"a-b": "v"}` and `"%(a.b)s" % {"a.b": "v"}`
  // (run, not assumed); this port leaves both untouched, so a msgid using a
  // dotted or hyphenated key would render the raw placeholder to the page.
  // No catalogue in this repo uses one -- all 18 placeholder-bearing msgids
  // use plain identifiers -- so this pins a limit, not a live break.
  it("leaves hyphenated and dotted keys literal, where Python substitutes", () => {
    expect(translate({}, "%(a-b)s", { "a-b": "v" })).toBe("%(a-b)s");
    expect(translate({}, "%(a.b)s", { "a.b": "v" })).toBe("%(a.b)s");
  });

  it("requires at least one character in the key", () => {
    expect(translate({}, "%()s", { "": "v" })).toBe("%()s");
  });

  // Lower-case "s" only. Python raises ValueError on "%(x)S"; here it is
  // inert text.
  it("matches only a lower-case s conversion", () => {
    expect(translate({}, "%(x)S", { x: "v" })).toBe("%(x)S");
  });

  it("accepts digits and underscores in a key, as the regex says", () => {
    expect(translate({}, "%(a_1B)s", { a_1B: "v" })).toBe("v");
  });

  // DIVERGENCE: Python's `%` treats "%%" as an escaped literal percent --
  // `"100%% sure" % {}` is "100% sure" on this machine's CPython 3.13.0.
  // This port has no unescaping step at all, so a msgid written for
  // Django's operator would render a doubled percent sign. None of the
  // three catalogues contains "%%" (checked across all 853 entries), so
  // nothing is currently broken by it -- but a translator adding a
  // percentage string is how it would start.
  it("leaves %% doubled, where Python unescapes it to one percent sign", () => {
    expect(translate({}, "100%% sure")).toBe("100%% sure");
  });

  // A lone percent that is not part of a placeholder is untouched, in both
  // implementations' favour -- this is the common case in real prose.
  it("leaves a bare percent sign alone", () => {
    expect(translate({}, "up 40% on last year")).toBe("up 40% on last year");
  });
});

describe("the msgids production actually asks for", () => {
  // Every string that reaches translate() from a real call site, spelled
  // exactly as that call site spells it. A msgid that does not match the
  // .po byte for byte falls through to English with no error anywhere --
  // and this repo has a live near-miss: the .po files key this manifest
  // string on a STRAIGHT apostrophe ("Give Food's"), and a curly one
  // ("Give Food’s") finds nothing. Copying the string out of a rendered
  // page or a word processor is all it takes.
  //
  // The manifest msgid was checked against Django's own
  // givefood/views.py:861, which calls gettext() on the identical literal.
  const CALL_SITES: Array<[string, string]> = [
    // workers/site/src/routes/public/manifest.ts:12
    ["manifest description", "Use Give Food's tool to find what food banks near you are requesting to have donated"],
    // workers/site/src/routes/wfbn/rss.ts:50
    ["rss item title", "items requested at"],
    // workers/site/src/lib/timesince.ts:141-142
    ["timesince, under a minute", "Under a minute ago"],
    ["timesince suffix", "ago"],
  ];

  it.each(TRANSLATED)("%s translates every msgid production passes to translate()", async (locale) => {
    const catalogue = await loadCatalogue(locale);
    for (const [where, msgid] of CALL_SITES) {
      const result = translate(catalogue, msgid);
      // Not just "defined": the failure mode is falling through to the
      // English msgid, which IS a defined, plausible-looking string.
      expect({ where, translated: result !== msgid }).toEqual({ where, translated: true });
      expect(result.length).toBeGreaterThan(0);
    }
  });

  // The curly-apostrophe near-miss, made explicit so the fall-through is
  // visible as behaviour rather than as a comment.
  it("falls through to English when an apostrophe is the wrong character", async () => {
    const catalogue = await loadCatalogue("cy");
    const straight = "Use Give Food's tool to find what food banks near you are requesting to have donated";
    const curly = "Use Give Food’s tool to find what food banks near you are requesting to have donated";
    expect(translate(catalogue, straight)).toBe(
      "Defnyddiwch offeryn Give Food i ddarganfod pa fanciau bwyd yn eich ardal chi y mae'n gofyn iddynt fod wedi'u rhoi",
    );
    expect(translate(catalogue, curly)).toBe(curly);
  });
});

describe("the package's public entry point", () => {
  // workers/site imports LOCALES, loadCatalogue and translate from
  // "@givefood/templates", i.e. through index.ts, not from this module
  // directly. index.ts dropping or re-wrapping one of these is a build
  // break in another package, which this package's own tests would
  // otherwise never see.
  it("re-exports the same three symbols this module defines", () => {
    expect(publicSurface.LOCALES).toBe(LOCALES);
    expect(publicSurface.loadCatalogue).toBe(loadCatalogue);
    expect(publicSurface.translate).toBe(translate);
  });

  // Locale is a type, so there is nothing to assert at runtime -- but a
  // typed value here means `pnpm typecheck` fails if the union ever stops
  // admitting one of the four, which is the only way a type-only export can
  // regress noticeably.
  it("exports a Locale type admitting exactly these four codes", () => {
    const each: Locale[] = ["en", "cy", "ga", "gd"];
    expect(each).toEqual(LOCALES);
  });
});
