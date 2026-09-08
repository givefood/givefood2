import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePoFile } from "./poParser";

// poParser.ts is the only thing standing between locale/{cy,ga,gd}/django.po
// and what the site says in Welsh, Irish and Scottish Gaelic. It runs ONCE,
// at build time, inside scripts/precompile.ts -- not per request -- so every
// failure mode it has is a silent one:
//
//   * drop an entry and that string renders in English on a Welsh page. No
//     error, no log line, and nobody on the team reads Welsh.
//   * concatenate multi-line strings with a separator and you get
//     "mobile apps</\na>" in the middle of a paragraph -- broken markup that
//     the browser silently swallows.
//   * store an untranslated ("" msgstr) entry and i18n.ts's fall-through to
//     the msgid never fires, so the page shows an empty string where a word
//     should be.
//   * loop forever on a malformed line and the BUILD hangs rather than fails.
//
// So this suite is built in three layers: the three REAL catalogues parsed as
// the build parses them (values asserted, not shapes); synthetic .po fragments
// for the structure the real files never exercise; and a termination sweep,
// because a build-time parser that hangs is worse than one that throws.
//
// PARITY, ACTUALLY MEASURED. On 2026-09-08 all three catalogues were compiled
// with `msgfmt` (which reports itself as "msgfmt (GNU gettext-tools) 1.0",
// homebrew, /opt/homebrew/bin/msgfmt) and the resulting .mo files read with
// Python 3.13.0's `gettext.GNUTranslations`. Excluding the "" header key, the
// catalogue GNU produces is byte-identical to parsePoFile's output for cy, ga
// and gd -- same 284/285/284 keys, same values. The counts and values below
// are that measurement written down. Where this file claims GNU gettext does
// X, that claim came from running the above, not from reading a spec.
//
// The .po files themselves were diffed against the Django original on the
// same day: locale/{cy,ga,gd}/django.po here are byte-identical to
// /Users/jasoncartwright/Sites/foodcharity/locale/{cy,ga,gd}/LC_MESSAGES/
// django.po, so "copied verbatim" in poParser.ts's header comment is true.

// `.href`, not the URL object -- @cloudflare/workers-types and @types/node
// each declare a global URL and they differ, so node:url's signature rejects
// the one `new URL(...)` produces here. Same clash, and same one-word fix, as
// templateBalance.test.ts and packages/db/src/schema.testkit.ts.
function readCatalogue(locale: string): string {
  return readFileSync(fileURLToPath(new URL(`../locale/${locale}/django.po`, import.meta.url).href), "utf-8");
}

const CY_SOURCE = readCatalogue("cy");
const GA_SOURCE = readCatalogue("ga");
const GD_SOURCE = readCatalogue("gd");

const cy = parsePoFile(CY_SOURCE);
const ga = parsePoFile(GA_SOURCE);
const gd = parsePoFile(GD_SOURCE);

const REAL: ReadonlyArray<[string, Record<string, string>, string]> = [
  ["cy", cy, CY_SOURCE],
  ["ga", ga, GA_SOURCE],
  ["gd", gd, GD_SOURCE],
];

// The msgid of the About-us block at cy/django.po:907 -- the longest entry in
// any catalogue, 50 lines of `"..."` continuations carrying both of the escape
// sequences the real files use (\n and \"). Reused by several tests below, so
// it is found by prefix rather than pasted three times.
const ABOUT_US_MSGID = Object.keys(cy).find((k) => k.startsWith("\n                <p>Give Food"))!;

describe("parsePoFile: the three real catalogues", () => {
  // The exact number GNU msgfmt + Python gettext produce for the same files
  // (see the header comment). Two mutations these kill: dropping the
  // `msgid.length > 0` guard admits the PO header as a "" key (285/286/285),
  // and dropping `msgstr.length > 0` admits the untranslated entries.
  it.each([
    ["cy", cy, 284],
    ["ga", ga, 285],
    ["gd", gd, 284],
  ] as const)("%s parses to exactly %i entries, matching GNU gettext", (_locale, catalogue, expected) => {
    expect(Object.keys(catalogue).length).toBe(expected);
  });

  it.each(REAL)("%s drops the PO header rather than storing its metadata", (_locale, catalogue) => {
    // The header is `msgid ""` with the Project-Id-Version/Language/
    // Plural-Forms block as its msgstr. It is not a translatable string, and
    // if it leaked through, `{{ _("") }}` would resolve to a wall of
    // RFC-822-ish metadata. The msgid.length check is what stops it.
    expect(Object.hasOwn(catalogue, "")).toBe(false);
    // Belt and braces: the metadata must not have been mis-attached to some
    // other key either, which is what a broken continuation loop would do.
    const metadata = Object.entries(catalogue).filter(
      ([k, v]) => k.includes("MIME-Version") || v.includes("MIME-Version") || v.includes("Plural-Forms"),
    );
    expect(metadata).toEqual([]);
  });

  it("translates the strings the whole site depends on", () => {
    // Spot values, not counts. A parser that returned 284 entries of garbage
    // passes every count assertion above; these are the actual words on the
    // page. Each triple was read out of the .mo GNU built, so they are also
    // the parity check.
    expect(cy["Home"]).toBe("Cartref");
    expect(ga["Home"]).toBe("Baile");
    expect(gd["Home"]).toBe("Dachaidh");

    expect(cy["Constituencies"]).toBe("Etholaethau");
    expect(ga["Constituencies"]).toBe("Dáilcheantair");
    expect(gd["Constituencies"]).toBe("Sgìrean-taghaidh");

    expect(cy["About us"]).toBe("Amdanom ni");
    expect(ga["About us"]).toBe("Fúinn");
    expect(gd["About us"]).toBe("Mu ar deidhinn");

    expect(cy["Dumps"]).toBe("Dympiau");
    expect(ga["Dumps"]).toBe("Dumpálacha");
    expect(gd["Dumps"]).toBe("Dumpaichean");
  });

  it("keeps %(name)s placeholders intact for i18n.ts to interpolate", () => {
    // translate() in i18n.ts substitutes /%\(([a-zA-Z0-9_]+)\)s/. If the
    // parser mangled the parentheses -- which the naive slice(1, -1) in
    // unescapePoString could plausibly do to a string it mis-bounded -- the
    // placeholder would render literally as "%(constituency_name)s" on the
    // page instead of the constituency's name.
    expect(cy["Food banks in %(constituency_name)s"]).toBe("Banciau bwyd yn %(constituency_name)s");
    expect(ga["Food banks in %(constituency_name)s"]).toBe("Bainceanna bia i %(constituency_name)s");
    expect(gd["Food banks in %(constituency_name)s"]).toBe("Bancaichean bìdh ann an %(constituency_name)s");
  });
});

describe("parsePoFile: entries the real catalogues must NOT produce", () => {
  // The single most valuable test here. "WhatsApp" is a msgid in all three
  // files, but only ga actually translates it:
  //
  //   cy/django.po:378  msgid "WhatsApp" / msgstr ""       -> must be ABSENT
  //   gd/django.po:380  msgid "WhatsApp" / msgstr ""       -> must be ABSENT
  //   ga/django.po:378  msgid "WhatsApp" / msgstr "WhatsApp" -> must be PRESENT
  //
  // A catalogue that stores the empty msgstr breaks i18n.ts's fall-through
  // (`msgstr && msgstr.length > 0 ? msgstr : msgid`), so the Welsh and Gaelic
  // pages would render an EMPTY STRING where the word "WhatsApp" belongs --
  // an invisible defect on a live page. And a filter that over-corrected by
  // dropping msgstr === msgid would silently break ga, where the identical
  // translation is the correct one. Only asserting all three directions
  // catches both mistakes.
  it("excludes the untranslated msgid but keeps the identically-translated one", () => {
    expect(CY_SOURCE).toContain('msgid "WhatsApp"\nmsgstr ""\n');
    expect(GD_SOURCE).toContain('msgid "WhatsApp"\nmsgstr ""\n');
    expect(GA_SOURCE).toContain('msgid "WhatsApp"\nmsgstr "WhatsApp"\n');

    expect(Object.hasOwn(cy, "WhatsApp")).toBe(false);
    expect(Object.hasOwn(gd, "WhatsApp")).toBe(false);
    expect(ga["WhatsApp"]).toBe("WhatsApp");
  });

  it("differs between ga and cy/gd by exactly that one key", () => {
    // Follows from the above, but stated as a set so a future catalogue that
    // gains or loses an untranslated entry fails here with a readable diff
    // rather than as an off-by-one in the count assertions.
    const cyKeys = Object.keys(cy).sort();
    const gdKeys = Object.keys(gd).sort();
    const gaKeys = Object.keys(ga).sort();
    expect(cyKeys).toEqual(gdKeys);
    expect(gaKeys.filter((k) => k !== "WhatsApp")).toEqual(cyKeys);
  });

  it.each(REAL)("%s stores no empty key and no empty value", (_locale, catalogue) => {
    // The two halves of the `msgid.length > 0 && msgstr.length > 0` guard,
    // asserted over the whole catalogue rather than one example.
    expect(Object.entries(catalogue).filter(([k, v]) => k.length === 0 || v.length === 0)).toEqual([]);
  });

  it.each(REAL)("%s leaves no reference/flag comment lines in the catalogue", (_locale, catalogue) => {
    // `#: gfwfbn/templates/...:42` and `#, python-format` lines outnumber the
    // entries roughly two to one. They are skipped by the outer loop falling
    // through to `i++`; if the msgid detection ever loosened, they would come
    // through as keys.
    expect(Object.keys(catalogue).filter((k) => k.startsWith("#"))).toEqual([]);
  });

  it.each(REAL)("%s uses no plural forms and no message contexts", (_locale, _c, source) => {
    // poParser.ts's header says it skips msgid_plural/msgstr[n] and msgctxt
    // because none of the three catalogues use them -- "verified by grep
    // before writing this". This re-runs that grep on every test run, so the
    // day someone drops a plural form into a .po the suite says so instead of
    // the entry vanishing from the site. (What the parser would DO with one
    // is pinned separately, below.)
    expect(source).not.toContain("msgid_plural");
    expect(source).not.toContain("msgctxt");
    expect(source).not.toContain("msgstr[");
  });
});

describe("parsePoFile: multi-line strings from the real catalogues", () => {
  // gettext's line continuation is bare concatenation -- adjacent "..."
  // literals join with NOTHING between them, exactly like C string literals.
  // Inserting "\n" or " " is the obvious wrong implementation, and these two
  // entries make it impossible to miss, because both split a token in half.

  it("rejoins an HTML tag split across a line boundary", () => {
    // cy/django.po:393-394 breaks the closing tag itself:
    //     "Get updates ... <a href=\"%(apps_url)s\">mobile apps</"
    //     "a>"
    // Join with a newline and the rendered page gets `</\na>`, which browsers
    // parse as text, so the anchor never closes. Nothing errors.
    expect(cy["Get updates on what is needed with our <a href=\"%(apps_url)s\">mobile apps</a>"]).toBe(
      "Cael y wybodaeth ddiweddaraf am yr hyn sydd ei angen gyda'n <a href=\"%(apps_url)s\">apiau symudol</a>",
    );
    // The msgstr of that same entry splits the OPENING tag between the
    // element name and its attribute (`"<a "` + `"href=\"..."`), so the join
    // has to be seamless in both directions.
    expect(cy["Get updates on what is needed with our <a href=\"%(apps_url)s\">mobile apps</a>"]).toContain(
      '<a href="%(apps_url)s">',
    );
  });

  it("rejoins a URL split across a line boundary", () => {
    // Inside ABOUT_US_MSGID the Charity Commission link is broken mid-domain
    // (cy/django.po:922-923): "https://register-of-" + "charities.charity...".
    // Any separator at all produces a dead link on the About page.
    expect(ABOUT_US_MSGID).toContain(
      "https://register-of-charities.charitycommission.gov.uk/en/charity-search/-/charity-details/5147019",
    );
  });

  it("appends continuations to an empty first line, not just to a non-empty one", () => {
    // The shape Poedit emits for any msgid too long for one line:
    // `msgid ""` on its own, with the text following as continuations
    // (cy/django.po:1139). The length checks that drop the PO header run
    // AFTER concatenation -- if they ran on the first line's value instead,
    // or if the continuation loop were skipped, this entry and the 35 others
    // shaped like it in cy would all be discarded as "empty msgid", because
    // their first line is indistinguishable from the header's.
    expect(CY_SOURCE).toContain(
      'msgid ""\n"Give Food is a UK charity that uses data to highlight local and structural "\n',
    );
    expect(
      cy[
        "Give Food is a UK charity that uses data to highlight local and structural food insecurity then provides tools to help alleviate it."
      ],
    ).toBe(
      "Elusen yn y DU yw Give Food sy’n defnyddio data i amlygu ansicrwydd bwyd lleol a strwythurol ac yna’n darparu offer i helpu i’w liniaru.",
    );
  });

  it("concatenates the 50-line About-us block into one string with real newlines", () => {
    // cy/django.po:907 -- 50 continuation lines, and the only entry in any
    // catalogue whose msgid contains newlines (its \n escapes are the
    // paragraph breaks in the About page's HTML block). Exact lengths and
    // newline counts, because this is the one place where an off-by-one in
    // either the escape decoder or the continuation loop would still produce
    // plausible-looking prose.
    expect(ABOUT_US_MSGID.length).toBe(2247);
    expect(ABOUT_US_MSGID.split("\n").length - 1).toBe(24);
    expect(ABOUT_US_MSGID.startsWith("\n                <p>Give Food is a UK charity that uses data to highlight ")).toBe(true);
    expect(ABOUT_US_MSGID.endsWith('<a href="mailto:mail@givefood.org.uk">mail@givefood.org.uk</a>\n                </p>\n\n            ')).toBe(
      true,
    );

    const welsh = cy[ABOUT_US_MSGID]!;
    expect(welsh.length).toBe(2140);
    // The Welsh translator collapsed most of the source's whitespace, so the
    // msgstr has 3 newlines where the msgid has 24. Asserted because it is a
    // real difference between the two sides of one entry -- a parser that
    // reused the msgid's decoded value for the msgstr would pass a laxer test.
    expect(welsh.split("\n").length - 1).toBe(3);
    expect(welsh.startsWith("\n                <p>Mae Give Food yn elusen yn y DU")).toBe(true);
  });

  it.each(REAL)("%s has exactly one newline-bearing msgid", (_locale, catalogue) => {
    // Guards the opposite mistake from the joining tests: 36 msgids in cy are
    // spread over continuation lines, so a parser that inserted "\n" between
    // them would give 36 keys newlines instead of one -- and every one of
    // those keys would then miss its template lookup.
    expect(Object.keys(catalogue).filter((k) => k.includes("\n")).length).toBe(1);
  });
});

describe("parsePoFile: escape decoding in the real catalogues", () => {
  // A grep of all three files finds exactly two escape sequences in use:
  // 312 x \" and 117 x \n. Nothing else. So the \t, \r, \\ and unknown-escape
  // branches of unescapePoString are unreachable from real data and are
  // covered synthetically further down.

  it('decodes \\" into a real quote inside HTML attributes', () => {
    // The literal source line is:
    //   msgid "Part of <a href=\"/needs/at/%(foodbank_slug)s/\">%(foo...
    // If the backslashes survived into the output, every translated page with
    // a link in it would emit href=\"...\" and the link would not work.
    expect(CY_SOURCE).toContain('msgid "Part of <a href=\\"/needs/at/%(foodbank_slug)s/\\">%(foodbank_name)s</a>"');
    expect(cy['Part of <a href="/needs/at/%(foodbank_slug)s/">%(foodbank_name)s</a>']).toBe(
      'Rhan o <a href="/needs/at/%(foodbank_slug)s/">%(foodbank_name)s</a>',
    );
  });

  it.each(REAL)("%s leaves no undecoded backslash anywhere", (_locale, catalogue) => {
    // The strongest single statement available about escape handling on real
    // input: none of the three catalogues legitimately contains a backslash,
    // so ANY backslash in the output means an escape was not processed. This
    // kills the "unescapePoString returns its input unchanged" mutant on all
    // 429 escape sequences at once, not just the two spot-checked above.
    expect(Object.entries(catalogue).filter(([k, v]) => k.includes("\\") || v.includes("\\"))).toEqual([]);
  });

  it.each(REAL)("%s leaves no stray delimiter quote at the ends of a string", (_locale, catalogue) => {
    // unescapePoString does `quoted.slice(1, -1)` blindly -- it does not check
    // that the first and last characters actually ARE quotes. If the caller
    // ever handed it a value with the quotes already stripped (or with one
    // missing), the damage shows up as a leading or trailing `"` on the key.
    // No real msgid or msgstr begins or ends with a quote character.
    const damaged = Object.entries(catalogue).filter(
      ([k, v]) => k.startsWith('"') || k.endsWith('"') || v.startsWith('"') || v.endsWith('"'),
    );
    expect(damaged).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Synthetic fragments. Everything above is real production input; everything
// below is the structure the three catalogues happen not to contain, which is
// precisely the structure that will arrive unannounced the day a translator
// opens the file in a different editor.
// ---------------------------------------------------------------------------

// Every synthetic file starts with the standard PO header so the fragments
// are the shape msgfmt would accept, and so each test doubles as a check that
// the header is still discarded.
const HEADER = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n';

describe("parsePoFile: structure", () => {
  it("returns an empty catalogue for empty and whitespace-only input", () => {
    expect(parsePoFile("")).toEqual({});
    expect(parsePoFile("\n\n\n")).toEqual({});
    expect(parsePoFile("   \n\t\n")).toEqual({});
  });

  it("returns an empty catalogue for a header-only file", () => {
    expect(parsePoFile(HEADER)).toEqual({});
  });

  it("skips every kind of PO comment line", () => {
    // #  translator comment, #. extracted, #: reference, #, flag,
    // #| previous-msgid. All five are just "not a msgid line" to the outer
    // loop, but listing them makes the intent explicit.
    const po = `${HEADER}#  translator note
#. extracted from the template
#: givefood/templates/public/index.html:12
#, python-format
#| msgid "Older text"
msgid "Go"
msgstr "Ewch"
`;
    expect(parsePoFile(po)).toEqual({ Go: "Ewch" });
  });

  it("accepts indented keywords and indented continuation lines", () => {
    // The continuation test is `/^\s*"/` against the RAW line, and the value
    // is taken from `.trim()`. Nothing in the real catalogues is indented, so
    // without this test the `\s*` could be deleted and every assertion above
    // would still pass -- until a translation tool that indents wrapped lines
    // dropped half of every long string.
    const po = `${HEADER}    msgid "Food "
      "banks"
    msgstr "Banciau "
      "bwyd"
`;
    expect(parsePoFile(po)).toEqual({ "Food banks": "Banciau bwyd" });
  });

  it("handles CRLF line endings", () => {
    // split("\n") leaves a trailing \r on every line. The keyword match and
    // the value both come from `.trim()`, which removes it -- but the
    // continuation regex tests the raw line, where a leading quote is still
    // at index 0, so CRLF survives that too. A .po round-tripped through a
    // Windows editor must not silently produce keys ending in \r.
    const po = 'msgid "Home"\r\nmsgstr "Cartref"\r\n\r\nmsgid "Date"\r\n"s"\r\nmsgstr "Dyddiad"\r\n"au"\r\n';
    expect(parsePoFile(po)).toEqual({ Home: "Cartref", Dates: "Dyddiadau" });
  });

  it("takes the last of two entries with the same msgid", () => {
    // Plain object assignment, so last write wins. GNU msgfmt rejects this
    // file outright ("duplicate message definition", a fatal error -- run on
    // this exact fragment on 2026-09-08); this parser accepts it and quietly
    // prefers the later definition. Pinned so the choice is visible rather
    // than incidental, since a duplicate is the shape a bad merge produces.
    expect(parsePoFile(`${HEADER}msgid "Home"\nmsgstr "First"\n\nmsgid "Home"\nmsgstr "Second"\n`)).toEqual({
      Home: "Second",
    });
  });

  it("is deterministic and returns a fresh object each call", () => {
    // The precompile script calls this once per locale in a loop and writes
    // each result straight to JSON. If any state leaked between calls, cy's
    // catalogue would contaminate ga's.
    const a = parsePoFile(CY_SOURCE);
    const b = parsePoFile(CY_SOURCE);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a["Home"] = "mutated";
    expect(b["Home"]).toBe("Cartref");
    expect(cy["Home"]).toBe("Cartref");
  });
});

describe("parsePoFile: gettext features it deliberately does not implement", () => {
  // poParser.ts's header names these as out of scope. Pinning what actually
  // happens matters more than pinning that "nothing happens": the difference
  // between "the entry is dropped" and "the entry is stored under the wrong
  // key" is the difference between an English fallback and a wrong string.

  it("drops a plural entry entirely rather than storing either form", () => {
    // `msgid_plural` does not match startsWith("msgid ") (underscore, not
    // space) and `msgstr[0]` does not match startsWith("msgstr "), so the
    // singular msgid finds no msgstr and the whole entry falls out.
    const po = `${HEADER}msgid "%(count)s food bank"
msgid_plural "%(count)s food banks"
msgstr[0] "%(count)s banc bwyd"
msgstr[1] "%(count)s banc bwyd"

msgid "Home"
msgstr "Cartref"
`;
    // The entry after the plural one still parses -- the defensive skip does
    // not desynchronise the loop, which is the failure that would turn one
    // unsupported entry into a lost tail of the file.
    expect(parsePoFile(po)).toEqual({ Home: "Cartref" });

    // And a `msgstr[0]` sitting directly after the msgid must not be taken
    // for a msgstr either. The trailing space in startsWith("msgstr ") is the
    // only thing preventing it: drop the space and the value becomes
    // slice(7) of `msgstr[0] "un"`, i.e. `0] "un"`, which unescapePoString
    // then trims to the garbage string `] "un`. Storing a half-parsed plural
    // is far worse than dropping it -- the site would print `] "un` where a
    // count belongs.
    expect(parsePoFile('msgid "one"\nmsgstr[0] "un"\n')).toEqual({});
  });

  it("ignores msgctxt and keys the entry on the bare msgid", () => {
    // DIVERGENCE from GNU gettext, measured on 2026-09-08: msgfmt keys a
    // contextual entry as "menu\x04Home" (EOT separator) so it cannot collide
    // with the context-free "Home". This parser drops the context, so a
    // contextual entry would OVERWRITE the plain one -- the wrong translation
    // rendered, not a missing one. Harmless today (all three catalogues have
    // zero msgctxt, asserted above); recorded here so it is a known quantity
    // if a context is ever added.
    const po = `${HEADER}msgid "Home"
msgstr "Cartref"

msgctxt "menu"
msgid "Home"
msgstr "Cartref (dewislen)"
`;
    expect(parsePoFile(po)).toEqual({ Home: "Cartref (dewislen)" });
  });

  it("includes a fuzzy entry that msgfmt would exclude", () => {
    // DIVERGENCE from GNU gettext, measured on 2026-09-08 by compiling this
    // exact fragment: msgfmt omits `#, fuzzy` entries from the .mo, so Django
    // would render the English msgid; this parser stores the unreviewed
    // translation and the site shows it. poParser.ts's header states the
    // omission ("no per-entry #, fuzzy handling"), and no non-header entry in
    // any of the three catalogues carries the flag, so it costs nothing
    // today. The `#, fuzzy` on the header entry is standard and irrelevant --
    // that entry is dropped for having an empty msgid regardless.
    const po = `${HEADER}#, fuzzy
msgid "Home"
msgstr "Cartref-ish"
`;
    expect(parsePoFile(po)).toEqual({ Home: "Cartref-ish" });
  });

  it("does not resurrect an obsolete #~ entry", () => {
    // Commented-out entries are written `#~ msgid "..."`. Trimmed, that line
    // starts with "#~", not "msgid ", so it is skipped like any comment --
    // which is correct, and worth pinning because a msgid detector written
    // with .includes() instead of .startsWith() would resurrect deleted
    // translations.
    const po = `${HEADER}#~ msgid "Removed string"
#~ msgstr "Llinyn wedi'i dynnu"

msgid "Home"
msgstr "Cartref"
`;
    expect(parsePoFile(po)).toEqual({ Home: "Cartref" });
  });
});

describe("parsePoFile: escape sequences", () => {
  // MUTATION-TESTED on 2026-09-08 (a copy of the module plus this file in a
  // scratch directory outside the repo, never the module in place). 32
  // mutants were applied to poParser.ts and 30 were killed. Both survivors
  // are EQUIVALENT mutants, not gaps in this suite: deleting either
  // `else if (next === "\\") out += "\\";` or `else if (next === '"') out +=
  // '"';` makes that character fall through to `else out += next`, where
  // `next` is already exactly that character. The output is byte-identical,
  // so no test can distinguish them -- and none here pretends to.
  const value = (msgstr: string): string | undefined => parsePoFile(`msgid "K"\nmsgstr ${msgstr}\n`)["K"];

  it("decodes the five sequences it handles by name", () => {
    expect(value('"a\\nb"')).toBe("a\nb");
    expect(value('"a\\tb"')).toBe("a\tb");
    expect(value('"a\\rb"')).toBe("a\rb");
    expect(value('"a\\"b"')).toBe('a"b');
    expect(value('"a\\\\b"')).toBe("a\\b");
  });

  it("does not re-interpret the character after an escaped backslash", () => {
    // `\\n` in the file is backslash-then-n as TEXT, not a newline. Getting
    // this wrong is the classic escape-decoder bug: a naive
    // .replace(/\\n/g, "\n") pass turns a Windows path in a translation into
    // a line break.
    expect(value('"a\\\\nb"')).toBe("a\\nb");
    expect(value('"a\\\\nb"')).not.toContain("\n");
  });

  it("passes an unrecognised escape through as the bare character", () => {
    // DIVERGENCE from GNU gettext, measured on 2026-09-08: msgfmt decodes
    // \a to U+0007 (BEL) and rejects \' outright as "invalid control
    // sequence". This parser's else-branch just drops the backslash, so \a
    // becomes "a" and \' becomes "'". Both are unreachable from the real
    // catalogues (which contain only \" and \n) and both are the benign
    // direction of wrong -- text, not a control character -- so this pins the
    // behaviour rather than calling it a defect.
    expect(value('"ping\\aping"')).toBe("pingaping");
    expect(value('"it\\\'s"')).toBe("it's");
    expect(value('"a\\zb"')).toBe("azb");
  });

  it("does not decode octal or hex escapes", () => {
    // SUSPECT, and the widest divergence in the module. Compiling these two
    // exact fragments with msgfmt on 2026-09-08 gave: "A\101B" -> "AAB" (the
    // octal escape becomes U+0041) and "A\x41B" -> "A\x1b" (GNU's hex escape
    // is greedy, so it eats "41B" as one hex number and emits the low byte).
    // This parser decodes neither: the digit after the backslash is treated
    // as an unknown escape, the backslash is dropped, and the rest survives
    // as text. Only reachable from a .po nobody has written yet -- the three
    // catalogues contain only \" and \n -- so it is pinned, not fixed.
    expect(value('"A\\101B"')).toBe("A101B");
    expect(value('"A\\x41B"')).toBe("Ax41B");
  });

  it("keeps a trailing lone backslash rather than dropping it", () => {
    // The decoder's guard is `ch === "\\" && i + 1 < inner.length`, so a
    // backslash as the final character has nothing to escape and is emitted
    // literally. A parser that dropped it would silently corrupt a
    // translation ending in a path separator.
    expect(value('"a\\"')).toBe("a\\");
  });

  it("decodes escapes in the msgid as well as the msgstr", () => {
    // Both sides go through the same readPoString/unescapePoString pair, but
    // the msgid is the LOOKUP KEY -- if only the msgstr were decoded, every
    // entry with a quoted HTML attribute would be filed under a key
    // containing backslashes that no template would ever ask for, and 100+
    // strings would silently fall back to English.
    expect(parsePoFile('msgid "say \\"hi\\""\nmsgstr "dywedwch \\"helo\\""\n')).toEqual({
      'say "hi"': 'dywedwch "helo"',
    });
  });

  it("decodes escapes on continuation lines, not just the first line", () => {
    expect(parsePoFile('msgid "a\\n"\n"b\\tc"\nmsgstr "d\\n"\n"e"\n')).toEqual({ "a\nb\tc": "d\ne" });
  });
});

describe("parsePoFile: malformed input", () => {
  // The build has no operator watching it. Every case here must terminate and
  // must not throw; what it produces is secondary, but is pinned so a change
  // in the recovery strategy is visible.

  it("drops a msgid whose msgstr is missing at end of file", () => {
    expect(parsePoFile(`${HEADER}msgid "Truncated"\n`)).toEqual({});
    expect(parsePoFile(`${HEADER}msgid "Truncated"`)).toEqual({});
  });

  it("recovers and parses the next entry after a msgid with no msgstr", () => {
    // The defensive branch `continue`s WITHOUT advancing i, deliberately: the
    // line it stopped on has not been examined yet and may itself be the next
    // msgid. Two msgids in a row therefore lose the first and keep the
    // second. Deleting the `continue` (or writing `i++; continue;`) would
    // swallow the second entry too, which is the mutant this kills.
    expect(parsePoFile(`${HEADER}msgid "First"\nmsgid "Second"\nmsgstr "Ail"\n`)).toEqual({ Second: "Ail" });
  });

  it("SUSPECT: silently drops an entry with a blank line between msgid and msgstr", () => {
    // DIVERGENCE from GNU gettext, measured on 2026-09-08: msgfmt accepts a
    // blank line there and compiles the entry to {"X": "Y"}. This parser's
    // continuation loop stops at the blank line, finds a non-msgstr line, and
    // discards the entry with no warning -- so a .po that GNU considers valid
    // would lose that string to an English fallback with nothing in the build
    // log. Reported as a suspected bug; asserted as-is because a red test
    // helps nobody.
    expect(parsePoFile(`${HEADER}msgid "X"\n\nmsgstr "Y"\n`)).toEqual({});
    // By contrast a COMMENT between msgid and msgstr is also dropped here,
    // and that one is fine: msgfmt rejects it as a syntax error (verified the
    // same day -- "missing 'msgstr' section"), so no valid file has it.
    expect(parsePoFile(`${HEADER}msgid "X"\n# note\nmsgstr "Y"\n`)).toEqual({});
  });

  it("SUSPECT: mangles the key when the keyword is followed by extra spaces", () => {
    // `line.slice("msgid ".length)` assumes exactly one space. With two, the
    // sliced value is ` "X"`, and unescapePoString's unconditional
    // slice(1, -1) then removes the SPACE and the closing quote, leaving the
    // opening quote attached: the key becomes `"X` rather than `X`. Nothing
    // errors; the string just never matches a template lookup.
    //
    // This is the one mangling case that matters, because msgfmt ACCEPTS the
    // file -- compiling this exact fragment on 2026-09-08 produced
    // {"X": "Y"}. So a translator whose editor pads the keyword loses that
    // string with no signal from either tool.
    expect(parsePoFile('msgid  "X"\nmsgstr "Y"\n')).toEqual({ '"X': "Y" });
  });

  it("mangles the value when anything follows the closing quote", () => {
    // Same unconditional slice(1, -1): it trims one character off each end
    // regardless of what they are, so a trailing token loses its last
    // character and the string keeps its opening quote. Unlike the extra-
    // space case above this one is benign, because msgfmt rejects the file
    // outright (`keyword "oops" unknown`, syntax error -- run on this exact
    // fragment on 2026-09-08), so no .po that a translation tool would emit
    // can reach it. Pinned only so the two cases are told apart.
    expect(parsePoFile('msgid "X" oops\nmsgstr "Y"\n')).toEqual({ 'X" oop': "Y" });
  });

  it("survives an unterminated string literal", () => {
    // A single `"` slices to the empty string rather than throwing on a
    // negative-length slice, so the entry is dropped as "empty msgid".
    expect(parsePoFile('msgid "\nmsgstr "Y"\n')).toEqual({});
    expect(parsePoFile('msgid "X"\nmsgstr "\n')).toEqual({});
    expect(parsePoFile('msgid ""\nmsgstr ""\n')).toEqual({});
  });

  it("ignores a keyword with no space after it", () => {
    expect(parsePoFile('msgid"X"\nmsgstr"Y"\n')).toEqual({});
    expect(parsePoFile('msgidx "X"\nmsgstr "Y"\n')).toEqual({});
  });

  it("terminates on every truncation of a real catalogue", () => {
    // The outer loop's only unconditional advance is the `i++` on the
    // fall-through path; the msgid path relies on readPoString always
    // returning an index strictly greater than the one it started at. Any
    // change that lets it return the same index hangs the BUILD -- not a
    // request, the build -- with no output at all. All 1,595 prefixes of
    // cy/django.po's 1,594 lines exercise that invariant against half-read
    // entries, a header cut mid-continuation, and a msgid whose msgstr is
    // over the cliff. vitest's per-test timeout is the assertion of last
    // resort here; the explicit one is that nothing throws.
    const lines = CY_SOURCE.split("\n");
    for (let n = 0; n <= lines.length; n++) {
      expect(() => parsePoFile(lines.slice(0, n).join("\n"))).not.toThrow();
    }
    // Sanity: the sweep really did reach the whole file, so a bad slice()
    // cannot make this pass vacuously over 1,595 empty strings.
    expect(parsePoFile(lines.join("\n"))["Home"]).toBe("Cartref");
  });

  it("terminates on adversarial repetition of the shapes that skip forward", () => {
    // The defensive `continue` is the one path that does not advance i by
    // itself. A file of nothing but bare msgids drives it on every iteration.
    expect(parsePoFile('msgid "a"\n'.repeat(500))).toEqual({});
    expect(parsePoFile('msgid ""\n'.repeat(500))).toEqual({});
    expect(parsePoFile('"orphan continuation"\n'.repeat(500))).toEqual({});
    expect(parsePoFile('msgstr "orphan"\n'.repeat(500))).toEqual({});
  });
});

describe("parsePoFile: the returned object", () => {
  it("cannot be used to pollute Object.prototype", () => {
    // A .po file is not attacker-controlled here (it ships in the repo), but
    // the catalogue is built by assigning msgid-keyed properties onto a plain
    // `{}`, which is the textbook prototype-pollution shape. Assigning a
    // STRING to "__proto__" is a silent no-op in JS -- the setter ignores
    // non-objects -- so the entry simply vanishes and nothing is polluted.
    // Asserted so that a future rewrite (a Map, a spread, Object.assign from
    // parsed pairs) has to keep that property.
    const catalogue = parsePoFile('msgid "__proto__"\nmsgstr "polluted"\n');
    expect(Object.hasOwn(catalogue, "__proto__")).toBe(false);
    expect(catalogue).toEqual({});
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("SUSPECT: inherits Object.prototype, so some msgids resolve without an entry", () => {
    // The catalogue is a `{}` literal, not Object.create(null). A msgid that
    // collides with an Object.prototype member therefore resolves to the
    // inherited value on lookup even when the catalogue has no such entry.
    // i18n.ts's translate() does `catalogue[msgid]` and then
    // `msgstr.length > 0 ? msgstr : msgid` -- for "constructor" that is the
    // Object function, whose .length is 1, so translate() proceeds to call
    // .replace() on it and THROWS "template.replace is not a function"
    // (confirmed by running it on 2026-09-08). No template uses `_(
    // "constructor")`, so this is latent rather than live.
    const catalogue = parsePoFile('msgid "Home"\nmsgstr "Cartref"\n');
    expect(Object.getPrototypeOf(catalogue)).toBe(Object.prototype);
    expect(Object.hasOwn(catalogue, "constructor")).toBe(false);
    expect(typeof catalogue["constructor"]).toBe("function");
    expect(typeof catalogue["toString"]).toBe("function");
  });

  it("lets a msgid shadow an inherited member when the catalogue does define it", () => {
    const catalogue = parsePoFile('msgid "toString"\nmsgstr "Llinyn"\n');
    expect(catalogue["toString"]).toBe("Llinyn");
    // JSON.stringify is how precompile.ts writes the catalogue out, so the
    // shadowed member still has to serialise -- it does, because stringify
    // uses toJSON, not toString.
    expect(JSON.stringify(catalogue)).toBe('{"toString":"Llinyn"}');
  });

  it("serialises the real catalogues to the JSON i18n.ts imports", () => {
    // precompile.ts does JSON.stringify(catalogue) into
    // src/generated/locales/<locale>.json, which i18n.ts dynamically imports
    // as a Record<string, string>. Round-tripping proves nothing in the
    // parsed output (control characters from \n, the smart quotes in the
    // Welsh text) survives that trip changed.
    for (const [, catalogue] of REAL) {
      expect(JSON.parse(JSON.stringify(catalogue))).toEqual(catalogue);
    }
    expect(JSON.parse(JSON.stringify(cy))["Home"]).toBe("Cartref");
  });
});
