import { describe, expect, it } from "vitest";
import { cleanFoodbankNeedText, keysEqual, needItemsKey } from "./textClean";

// HOW THE "matches Django" CLAIMS HERE WERE CHECKED, and how far they go.
// The Django tree is NOT in this repo -- only the port is. So the reference
// used for every expected value below is a python3 reconstruction of
// givefood/utils/text.py built from the six operations this module's own
// header documents (html.unescape, one .replace("  ", " "), .strip(),
// splitlines(True) blank-line drop, per-line .strip(), "Uht" -> "UHT"), run
// over the identical input. That makes the CPython halves -- html.unescape()
// and str.splitlines() -- genuinely authoritative, because those are stdlib,
// not reconstruction. It does NOT make the reconstruction's own line-splitting
// authoritative for need_items_key(), whose splitting rule this module states
// but text.py cannot be consulted to confirm; the one test that turns on it
// says so out loud rather than claiming a parity it cannot demonstrate.
//
// An earlier revision of this file asserted, twice, that Django returns
// "Tinned beans\nPasta" for a lone "\r". It does not -- splitlines(True)
// keeps the "\r" ON its piece and step 5 only ever splits on "\n", so CPython
// returns the "\r" intact, exactly as the port does. The real splitlines()
// divergence needs a BLANK \r-delimited segment; it is pinned below under its
// own name. Parity claims in comments are load-bearing here, because they are
// what tells a future reader whether a surprising output is a known gap or a
// regression -- so they are checked against CPython, not reasoned about.
//
// Why this module is worth this much test: needcheck runs unattended over
// every food bank's shopping list. cleanFoodbankNeedText() decides what text
// is stored, and needItemsKey()/keysEqual() decide whether a scrape counts as
// a CHANGE (decision.ts). A key that is too coarse silently drops a real need
// update; a key that is too fine emails volunteers a "change" on every run for
// a page that never changed.

// The 106 entity names CPython's html.unescape() decodes WITHOUT a trailing
// semicolon, written out here independently of the module's own
// LEGACY_NO_SEMICOLON so the tests below CROSS-CHECK that table rather than
// restate it. Source: `python3 -c "import html.entities as e; print(sorted(k
// for k in e.html5 if not k.endswith(';')))"`, the same command the module
// header cites. Two tests walk it: one proves every name resolves to a real
// character (the "undefined" hazard), the other proves the semicolon-less
// path agrees with the semicolon path.
const LEGACY_NO_SEMICOLON_NAMES = [
  "AElig", "AMP", "Aacute", "Acirc", "Agrave", "Aring", "Atilde", "Auml",
  "COPY", "Ccedil", "ETH", "Eacute", "Ecirc", "Egrave", "Euml", "GT",
  "Iacute", "Icirc", "Igrave", "Iuml", "LT", "Ntilde", "Oacute", "Ocirc",
  "Ograve", "Oslash", "Otilde", "Ouml", "QUOT", "REG", "THORN", "Uacute",
  "Ucirc", "Ugrave", "Uuml", "Yacute", "aacute", "acirc", "acute", "aelig",
  "agrave", "amp", "aring", "atilde", "auml", "brvbar", "ccedil", "cedil",
  "cent", "copy", "curren", "deg", "divide", "eacute", "ecirc", "egrave",
  "eth", "euml", "frac12", "frac14", "frac34", "gt", "iacute", "icirc",
  "iexcl", "igrave", "iquest", "iuml", "laquo", "lt", "macr", "micro",
  "middot", "nbsp", "not", "ntilde", "oacute", "ocirc", "ograve", "ordf",
  "ordm", "oslash", "otilde", "ouml", "para", "plusmn", "pound", "quot",
  "raquo", "reg", "sect", "shy", "sup1", "sup2", "sup3", "szlig", "thorn",
  "times", "uacute", "ucirc", "ugrave", "uml", "uuml", "yacute", "yen",
  "yuml",
];

// ---------------------------------------------------------------------------
// HTML4's entity table, reconstructed from the W3C's definition rather than
// copied out of the module.
//
// The module header makes a strong, specific claim about NAMED_ENTITIES:
// "HTML4/XHTML1's three entity sets (Latin-1, Special, Symbols) -- 252 names
// in total, the W3C's own complete, closed table for this scope ... rather
// than an arbitrarily truncated slice of the newer HTML5 table."
//
// Before this revision nothing in this file tested either half of that claim.
// The entity tests were a dozen hand-picked names plus a sweep whose only
// assertion was that the output did not contain the string "undefined" -- so a
// table in which every accented vowel mapped to the WRONG character passed the
// entire file, and a table missing most of its names passed too. Both are
// exactly the kind of damage a hand-maintained 180-line object literal takes.
//
// The three sets are therefore rebuilt below from
// https://www.w3.org/TR/html4/sgml/entities.html as NAMES plus CODE POINTS,
// and the expected characters are DERIVED from those code points. Latin-1 is
// the cleanest case of all: its published order IS its definition -- entry i
// is U+00A0 + i, nbsp (U+00A0) straight through to yuml (U+00FF) -- so its 96
// expected characters are computed, never transcribed, and cannot drift into
// accidental agreement with a wrong implementation.
const HTML4_LATIN1_ORDERED = [
  "nbsp", "iexcl", "cent", "pound", "curren", "yen", "brvbar", "sect",
  "uml", "copy", "ordf", "laquo", "not", "shy", "reg", "macr",
  "deg", "plusmn", "sup2", "sup3", "acute", "micro", "para", "middot",
  "cedil", "sup1", "ordm", "raquo", "frac14", "frac12", "frac34", "iquest",
  "Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil",
  "Egrave", "Eacute", "Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml",
  "ETH", "Ntilde", "Ograve", "Oacute", "Ocirc", "Otilde", "Ouml", "times",
  "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute", "THORN", "szlig",
  "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil",
  "egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml",
  "eth", "ntilde", "ograve", "oacute", "ocirc", "otilde", "ouml", "divide",
  "oslash", "ugrave", "uacute", "ucirc", "uuml", "yacute", "thorn", "yuml",
];

// HTML4's "Special" set (32 names). Not contiguous, so these carry their own
// code points -- still the W3C's numbers, not the module's characters.
const HTML4_SPECIAL_CP: Record<string, number> = {
  quot: 0x22, amp: 0x26, lt: 0x3c, gt: 0x3e,
  OElig: 0x152, oelig: 0x153, Scaron: 0x160, scaron: 0x161, Yuml: 0x178,
  circ: 0x2c6, tilde: 0x2dc,
  ensp: 0x2002, emsp: 0x2003, thinsp: 0x2009, zwnj: 0x200c, zwj: 0x200d,
  lrm: 0x200e, rlm: 0x200f, ndash: 0x2013, mdash: 0x2014,
  lsquo: 0x2018, rsquo: 0x2019, sbquo: 0x201a, ldquo: 0x201c, rdquo: 0x201d,
  bdquo: 0x201e, dagger: 0x2020, Dagger: 0x2021, permil: 0x2030,
  lsaquo: 0x2039, rsaquo: 0x203a, euro: 0x20ac,
};

// The 45 names from HTML4's 124-name "Symbols" set that the port's table
// actually carries. Split out from the 79 it does not (below) because the
// difference between those two lists is the finding, and a test that just
// swept "the symbols set" would hide it.
const HTML4_SYMBOLS_PRESENT_CP: Record<string, number> = {
  fnof: 0x192,
  Alpha: 0x391, Beta: 0x392, Gamma: 0x393, Delta: 0x394,
  alpha: 0x3b1, beta: 0x3b2, gamma: 0x3b3, delta: 0x3b4,
  bull: 0x2022, hellip: 0x2026, prime: 0x2032, Prime: 0x2033,
  oline: 0x203e, frasl: 0x2044, trade: 0x2122,
  larr: 0x2190, uarr: 0x2191, rarr: 0x2192, darr: 0x2193, harr: 0x2194,
  crarr: 0x21b5,
  prod: 0x220f, sum: 0x2211, minus: 0x2212, lowast: 0x2217, radic: 0x221a,
  infin: 0x221e, sim: 0x223c, cong: 0x2245, asymp: 0x2248, ne: 0x2260,
  equiv: 0x2261, le: 0x2264, ge: 0x2265,
  sub: 0x2282, sup: 0x2283, nsub: 0x2284, sube: 0x2286, supe: 0x2287,
  loz: 0x25ca, spades: 0x2660, clubs: 0x2663, hearts: 0x2665, diams: 0x2666,
};

// The other 79 HTML4 Symbols names -- every Greek letter past delta, every
// double arrow, and essentially the whole set-theory/logic block including
// notin, which the module's own prose discusses by name. Absent from
// NAMED_ENTITIES, so the port leaves them literal.
const HTML4_SYMBOLS_ABSENT = [
  "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Mu",
  "Nu", "Xi", "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon",
  "Phi", "Chi", "Psi", "Omega",
  "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu",
  "nu", "xi", "omicron", "pi", "rho", "sigmaf", "sigma", "tau",
  "upsilon", "phi", "chi", "psi", "omega",
  "thetasym", "upsih", "piv",
  "weierp", "image", "real", "alefsym",
  "lArr", "uArr", "rArr", "dArr", "hArr",
  "forall", "part", "exist", "empty", "nabla", "isin", "notin", "ni",
  "prop", "ang", "and", "or", "cap", "cup", "int", "there4",
  "oplus", "otimes", "perp", "sdot",
  "lceil", "rceil", "lfloor", "rfloor", "lang", "rang",
];

// Not part of HTML4's 252 at all: CPython's html5 table carries uppercase
// aliases for six references, and the port copies them. Kept separate so the
// 252 arithmetic below stays honest.
const UPPERCASE_ALIAS_CP: Record<string, number> = {
  QUOT: 0x22, AMP: 0x26, GT: 0x3e, LT: 0x3c, COPY: 0xa9, REG: 0xae,
};

// name -> the character the W3C says it means, for every name the port claims
// to decode. Built by derivation from the four tables above.
const EXPECTED_CHAR = new Map<string, string>();
HTML4_LATIN1_ORDERED.forEach((name, i) => EXPECTED_CHAR.set(name, String.fromCharCode(0xa0 + i)));
for (const [name, cp] of Object.entries(HTML4_SPECIAL_CP)) EXPECTED_CHAR.set(name, String.fromCharCode(cp));
for (const [name, cp] of Object.entries(HTML4_SYMBOLS_PRESENT_CP)) EXPECTED_CHAR.set(name, String.fromCharCode(cp));
for (const [name, cp] of Object.entries(UPPERCASE_ALIAS_CP)) EXPECTED_CHAR.set(name, String.fromCharCode(cp));

describe("cleanFoodbankNeedText", () => {
  // --- Operation 1: HTML entity decoding -----------------------------------

  it("decodes the entity the Django docstring names, so an item does not drift between & and &amp;", async () => {
    // text.py's own comment: entities "leak in from the rendered page, so the
    // same item doesn't drift between '&' and '&amp;' across runs". Drift here
    // means the stored need text flip-flops between two spellings of the same
    // list across scrapes.
    expect(await cleanFoodbankNeedText("Tins of beans &amp; peas")).toBe("Tins of beans & peas");
  });

  it("decodes decimal, hex and astral numeric references", async () => {
    // The module claims numeric refs need no table because "there are only two
    // forms". Astral (>BMP) is the boundary: it needs fromCodePoint, not
    // fromCharCode, or an emoji in a scraped list becomes two lone surrogates.
    expect(await cleanFoodbankNeedText("&#65;&#x41;&#x1F600;")).toBe("AA😀");
  });

  it("treats the trailing semicolon as optional for numeric references, as html.unescape() does", async () => {
    // The module comment states this outright ("&#65 x" -> "A x") and says it
    // was verified against python3. Same input, same answer.
    expect(await cleanFoodbankNeedText("&#65 x")).toBe("A x");
  });

  it("decodes a semicolon-less named reference only when it is in the legacy set", async () => {
    // Both halves come straight from the module comment and both match CPython.
    // "amp" is one of the 106 legacy names browsers special-case; "alpha" is
    // not, so it must survive untouched rather than being decoded generously.
    expect(await cleanFoodbankNeedText("&amp x")).toBe("& x");
    expect(await cleanFoodbankNeedText("&alpha x")).toBe("&alpha x");
  });

  it("backs off to a legacy PREFIX rather than requiring a whole-name match", async () => {
    // The module's own example, verified against CPython: this is NOT a failed
    // match falling through to the literal -- "not" is legacy and "in" is
    // ordinary leftover text. Delete the prefix loop and this becomes the
    // literal "&notin x".
    expect(await cleanFoodbankNeedText("&notin x")).toBe("¬in x");
    // Deliberately NOT claiming this proves "longest" prefix, which an earlier
    // revision of this comment did. The 106-name legacy set is prefix-free --
    // no name is a proper prefix of another -- so at most one prefix of any
    // body can match and the loop's direction is currently UNOBSERVABLE
    // through this function. Reversing it to shortest-first passes every test
    // in this file, and that is a property of the table, not of the tests.
    // The test below is the guard that starts biting if the table changes.
  });

  it("gives &name and &name; the same answer for every legacy name, which is what the backoff must preserve", async () => {
    // The two code paths are genuinely different: with a semicolon the decoder
    // looks up the WHOLE name in NAMED_ENTITIES, without one it walks prefixes
    // of it. They are only allowed to agree because the legacy set is
    // prefix-free. This asserts that agreement directly, so the day someone
    // adds a legacy alias that IS a prefix of another (say "sup" alongside
    // "sup1"), the shorter one starts winning for "&sup1" and this fails --
    // which is the moment the loop's longest-first direction stops being
    // cosmetic and starts being load-bearing. A pure table-ordering bug that
    // no single hand-picked example would have caught.
    for (const name of LEGACY_NO_SEMICOLON_NAMES) {
      const withSemicolon = await cleanFoodbankNeedText(`[&${name};]x`);
      const without = await cleanFoodbankNeedText(`[&${name}]x`);
      expect(without, `&${name} disagrees with &${name};`).toBe(withSemicolon);
    }
  });

  it("recognises the uppercase legacy aliases (&AMP;, &COPY) that the HTML4 table carries twice", async () => {
    expect(await cleanFoodbankNeedText("&AMP;")).toBe("&");
    expect(await cleanFoodbankNeedText("&COPY")).toBe("©");
  });

  it("decodes entity names that CONTAIN DIGITS, which the name pattern has to allow after the first char", async () => {
    // ENTITY_RE's name half is /[a-zA-Z][a-zA-Z0-9]*/, not /[a-zA-Z]+/, and
    // the difference is invisible until a digit-bearing name shows up.
    // Quantities are exactly where they show up in a shopping list: "&frac12;"
    // is how a CMS writes "half". With /[a-zA-Z]+/ the regex would match only
    // "&frac", find no legacy prefix, and leave "&frac12;" whole on the page.
    // All four match CPython.
    expect(await cleanFoodbankNeedText("&frac12;")).toBe("½");
    expect(await cleanFoodbankNeedText("&sup2;")).toBe("²");
    // Digits also have to survive the semicolon-less legacy path...
    expect(await cleanFoodbankNeedText("&frac12")).toBe("½");
    // ...including the prefix backoff, which has to settle on "frac12" and
    // hand back the trailing "3" as ordinary text rather than give up because
    // "frac123" is not a name.
    expect(await cleanFoodbankNeedText("&frac123")).toBe("½3");
  });

  it("resolves every one of the 106 semicolon-less legacy names to the RIGHT character, never \"undefined\"", async () => {
    // The sharpest failure this module can have. The backoff path does
    // `NAMED_ENTITIES[prefix] + body.slice(end)` with NO guard: any name that
    // is in LEGACY_NO_SEMICOLON but missing from NAMED_ENTITIES concatenates
    // the literal "undefined" into text that is stored in D1 and rendered on a
    // food bank's public page. The two tables are hand-maintained and only
    // overlap by convention, so this walks the whole legacy list -- written
    // out independently from CPython's own
    // `sorted(k for k in html.entities.html5 if not k.endswith(";"))`, not
    // imported from the module, so it cross-checks the port's table rather
    // than restating it.
    // The count is part of the claim: the module says 106, and a name silently
    // dropped from this list would make the sweep below pass vacuously.
    expect(LEGACY_NO_SEMICOLON_NAMES.length).toBe(106);
    expect(new Set(LEGACY_NO_SEMICOLON_NAMES).size).toBe(106);
    // 96 Latin-1 names + quot/amp/lt/gt + the six uppercase aliases. That the
    // arithmetic lands exactly on 106 is itself a check on both lists.
    expect(LEGACY_NO_SEMICOLON_NAMES.filter((n) => HTML4_LATIN1_ORDERED.includes(n)).length).toBe(96);

    for (const name of LEGACY_NO_SEMICOLON_NAMES) {
      // Brackets keep the decoded character away from the trim in step 3 --
      // several of these (nbsp especially) decode to whitespace and would
      // otherwise vanish, hiding a failure. The trailing "x" additionally
      // proves the backoff put the leftover text back rather than eating it.
      const expected = EXPECTED_CHAR.get(name);
      expect(expected, `${name} is missing from this file's W3C-derived table`).toBeDefined();
      // Asserting the EXACT character, not merely "not undefined": the earlier
      // form of this sweep passed against a table whose every mapping was
      // wrong, because "¬" and "©" are equally not the string "undefined".
      expect(await cleanFoodbankNeedText(`[&${name}]x`), `&${name}`).toBe(`[${expected}]x`);
    }
  });

  it("lets the legacy backoff eat the middle of an ordinary word, exactly as html.unescape() does", async () => {
    // The cost of the semicolon-less legacy set, and it is not hypothetical:
    // any "&" followed by letters is a candidate, so prose written into a
    // shopping list gets chewed. CPython does the same thing -- both give
    // "&ersand" here -- so this is parity, not a port defect, and a "smarter"
    // word-boundary check would be the divergence.
    expect(await cleanFoodbankNeedText("&ampersand")).toBe("&ersand");
    expect(await cleanFoodbankNeedText("&ampx")).toBe("&x");
    // The case this behaviour exists FOR, from the module comment: a real
    // scrape missing its semicolon still reads correctly.
    expect(await cleanFoodbankNeedText("Fish &amp chips")).toBe("Fish & chips");
  });

  it("decodes in a SINGLE pass, so a double-encoded entity stays half-encoded", async () => {
    // String.replace() visits each match once and never re-scans what it
    // substituted, which is html.unescape()'s behaviour too -- both return
    // "&amp;" for this. It matters in two directions: a decode-until-stable
    // loop would turn a page that legitimately displays the text "&amp;" into
    // "&", and would also be an unbounded loop over attacker-influenced text.
    expect(await cleanFoodbankNeedText("&#38;amp;")).toBe("&amp;");
    expect(await cleanFoodbankNeedText("&#38;#65;")).toBe("&#65;");
  });

  it("leaves malformed entity shapes exactly as found, matching html.unescape()", async () => {
    // Real scrapes contain bare ampersands and truncated references. None of
    // these can reach the decoder: ENTITY_RE requires at least one digit after
    // "#" and at least one hex digit after "#x", so "&#;" and "&#x;" never
    // match at all -- which is also why the Number.isNaN(codePoint) guard
    // inside decodeHtmlEntities is unreachable, the same way the body[1]==="X"
    // arm is. All four match CPython.
    expect(await cleanFoodbankNeedText("&")).toBe("&");
    expect(await cleanFoodbankNeedText("&#;")).toBe("&#;");
    expect(await cleanFoodbankNeedText("&#x;")).toBe("&#x;");
    // A numeric reference truncated at end-of-string still decodes, because
    // the semicolon is optional.
    expect(await cleanFoodbankNeedText("&#38")).toBe("&");
  });

  it("survives a numeric reference far larger than any code point without throwing", async () => {
    // Boundary above the out-of-range test: 20 digits overflows to 1e20, a
    // finite non-NaN number that fromCodePoint still rejects. The try/catch is
    // the only thing keeping a RangeError out of the needcheck queue consumer,
    // and a caller that "simplified" it away would fail exactly here.
    // DIVERGENCE, same family as the &#1114112; case: CPython gives U+FFFD.
    expect(await cleanFoodbankNeedText("&#99999999999999999999;")).toBe(
      "&#99999999999999999999;",
    );
  });

  it("treats the trailing semicolon as optional for HEX references too, not just decimal", async () => {
    // The decimal half is covered above; the hex half goes through a different
    // branch (parseInt base 16 on body.slice(2)) and is where an off-by-one in
    // the slice would show up as "&#x41 x" -> a wrong character rather than a
    // literal. CPython agrees on "A x".
    expect(await cleanFoodbankNeedText("&#x41 x")).toBe("A x");
  });

  it("does NOT escape or strip HTML -- decoding is the whole job, and the output is raw text", async () => {
    // Deliberate and worth pinning: this turns "&lt;script&gt;" INTO
    // "<script>". Django does the same, and the safety of that depends
    // entirely on every consumer escaping on output. If a template ever
    // renders need text unescaped, this test is the record that the danger
    // was known and lives at the template, not here.
    expect(await cleanFoodbankNeedText("&lt;script&gt;")).toBe("<script>");
  });

  it("lets an entity-encoded newline become a real line break, feeding steps 4 and 5", async () => {
    // Ordering consequence with teeth: "&#10;" is decoded in step 1, so by
    // step 4 it is a genuine line boundary. One CMS field written as
    // "Beans&#10;Rice" is therefore TWO items downstream, and needItemsKey()
    // scores it as two set members rather than one -- the difference between
    // an added item registering and not. Matches CPython.
    expect(await cleanFoodbankNeedText("Beans&#10;Rice")).toBe("Beans\nRice");
    expect(needItemsKey(await cleanFoodbankNeedText("Beans&#10;Rice"))).toEqual(
      new Set(["beans", "rice"]),
    );
  });

  it("leaves entity-shaped text that is not an entity completely alone", async () => {
    // The module comment's own example: this is entity decoding, not an HTML
    // parse, so a shopping-list item like "Tins <in date>" must survive
    // verbatim. "AT&T" is the same class of hazard from real scraped text --
    // "&T" matches the entity regex but resolves to nothing, and greedy
    // decoding would eat the ampersand. Both match Django.
    expect(await cleanFoodbankNeedText("Tins <in date>")).toBe("Tins <in date>");
    expect(await cleanFoodbankNeedText("AT&T")).toBe("AT&T");
  });

  it("leaves an HTML5-only name undecoded -- the disclosed 252-vs-2231 table gap", async () => {
    // The module is explicit that names outside HTML4's Latin-1/Symbols/
    // Special sets "survive undecoded -- a real, bounded gap, not a silent
    // one". "&excl;" is HTML5-only: CPython gives "!", this port gives the
    // literal. Pinned so the gap stays a documented decision; if someone
    // widens the table, this test is where they have to say so.
    expect(await cleanFoodbankNeedText("&excl;")).toBe("&excl;");
  });

  it("decodes every name it does carry to the exact character the W3C assigns it", async () => {
    // 179 names checked against derived code points, not against a second copy
    // of the module's table. This is the test that makes the rest of the entity
    // suite mean something: NAMED_ENTITIES is a hand-typed 180-entry object
    // literal of look-alike glyphs, and until this existed a single transposed
    // pair -- "Ograve" holding "Ó", "eacute" holding "è" -- would have shipped
    // silently, quietly rewriting one accented item on every food bank page
    // that uses entities and marking it as a need CHANGE on the next scrape.
    // Brackets keep whitespace-valued names (nbsp, ensp, emsp, thinsp) away
    // from step 3's trim.
    // Derived, not hard-coded: if a name were listed in two of the four
    // fixtures the Map would silently absorb the duplicate and this sweep would
    // quietly cover one name fewer than it claims.
    expect(EXPECTED_CHAR.size).toBe(
      HTML4_LATIN1_ORDERED.length
        + Object.keys(HTML4_SPECIAL_CP).length
        + Object.keys(HTML4_SYMBOLS_PRESENT_CP).length
        + Object.keys(UPPERCASE_ALIAS_CP).length,
    );
    for (const [name, char] of EXPECTED_CHAR) {
      expect(await cleanFoodbankNeedText(`[&${name};]`), `&${name};`).toBe(`[${char}]`);
    }
  });

  it("carries only 173 of HTML4's 252 names -- the missing 79 stay literal (see suspected bugs)", async () => {
    // PINS CURRENT BEHAVIOUR, and contradicts the module header, which says the
    // table is "252 names in total, the W3C's own complete, closed table for
    // this scope ... rather than an arbitrarily truncated slice". It is a
    // truncated slice: 96 Latin-1 + 32 Special are complete, but only 45 of the
    // Symbols set's 124 names are present. The arithmetic is asserted here so
    // the discrepancy is a number in a test run rather than a claim in a
    // comment.
    // The published sizes of the three sets: Latin-1 96, Special 32, Symbols
    // 124. Checking the fixtures against those totals is what keeps the sweep
    // below from passing vacuously after someone trims a name out of a list.
    expect(HTML4_LATIN1_ORDERED.length).toBe(96);
    expect(Object.keys(HTML4_SPECIAL_CP).length).toBe(32);
    expect(Object.keys(HTML4_SYMBOLS_PRESENT_CP).length + HTML4_SYMBOLS_ABSENT.length).toBe(124);
    // ...and the header's own number, reached by adding up the reconstruction
    // rather than by restating it.
    expect(
      HTML4_LATIN1_ORDERED.length
        + Object.keys(HTML4_SPECIAL_CP).length
        + Object.keys(HTML4_SYMBOLS_PRESENT_CP).length
        + HTML4_SYMBOLS_ABSENT.length,
    ).toBe(252);
    expect(HTML4_SYMBOLS_ABSENT.length).toBe(79);

    // What that costs in practice. "&frac12;" is the quantity entity a CMS
    // emits, and it works -- but Greek and the maths block do not, and the
    // failure mode is a raw "&pi;" rendered on a public page, not a crash.
    for (const name of HTML4_SYMBOLS_ABSENT) {
      expect(await cleanFoodbankNeedText(`[&${name};]`), `&${name};`).toBe(`[&${name};]`);
    }
    // Worth naming on its own: "notin" is the one absent name the module's own
    // prose discusses ("&notin x" -> "¬in x"). The semicolon-less form works
    // via the legacy "not" prefix; the semicolon-terminated form, which is what
    // a well-formed page actually contains, does not decode at all. Those two
    // spellings of the same reference therefore disagree -- and the one that
    // "works" produces the wrong character.
    expect(await cleanFoodbankNeedText("&notin x")).toBe("¬in x");
    expect(await cleanFoodbankNeedText("&notin;")).toBe("&notin;");
  });

  it("decodes NO name outside the 106 legacy set when the semicolon is missing", async () => {
    // The other side of the legacy boundary, and the half no single example
    // could pin. "&alpha x" above shows one non-legacy name staying literal;
    // this sweeps all 73 of them. It is the guard against the tempting
    // "simplification" of dropping LEGACY_NO_SEMICOLON and letting the prefix
    // walk consult NAMED_ENTITIES directly -- which passes every hand-picked
    // test in this file, and then quietly eats the "&" out of prose like
    // "soup &sup" or "tea &sim biscuits" that CPython leaves alone.
    const nonLegacy = [...EXPECTED_CHAR.keys()].filter((n) => !LEGACY_NO_SEMICOLON_NAMES.includes(n));
    // Subtracting the full 106 only works if every legacy name is also present
    // in the W3C-derived table -- so this line doubles as a cross-check that
    // the two independently-written fixtures agree about the port's coverage,
    // rather than being arithmetic on a literal.
    expect(nonLegacy.length).toBe(EXPECTED_CHAR.size - LEGACY_NO_SEMICOLON_NAMES.length);
    for (const name of nonLegacy) {
      expect(await cleanFoodbankNeedText(`[&${name}]x`), `&${name} (no semicolon)`).toBe(`[&${name}]x`);
    }
  });

  it("decodes &apos; but not &apos, because apos is XHTML-only and not a legacy name", async () => {
    // apos is the one name in the table that is NOT in HTML4's 252 (it arrived
    // with XHTML/XML), and it is deliberately absent from the 106 legacy names
    // -- CPython agrees on both halves. The asymmetry is easy to "tidy" in
    // either direction, and either tidy-up changes stored text: adding apos to
    // the legacy set would start eating the "&" from "&apostrophe", removing it
    // from NAMED_ENTITIES would leave "&apos;" rendered raw.
    expect(await cleanFoodbankNeedText("&apos;")).toBe("'");
    expect(await cleanFoodbankNeedText("&apos")).toBe("&apos");
  });

  it("leaves an unrecognised semicolon-terminated name literal, the other disclosed gap", async () => {
    // The comment inside decodeHtmlEntities() names this case exactly:
    // CPython's prefix-backoff applies to semicolon-terminated names too, so
    // it yields "¬inxyz;". This port does not, and says why.
    expect(await cleanFoodbankNeedText("&notinxyz;")).toBe("&notinxyz;");
  });

  it("does not throw on an out-of-range code point, returning the literal instead", async () => {
    // The try/catch around fromCodePoint() is the only thing standing between
    // a malformed scrape and a thrown RangeError inside an unattended queue
    // consumer (needcheckRender.ts calls this on LLM output). DIVERGENCE:
    // CPython substitutes U+FFFD for both of these.
    expect(await cleanFoodbankNeedText("&#1114112;")).toBe("&#1114112;");
    expect(await cleanFoodbankNeedText("&#x110000;")).toBe("&#x110000;");
  });

  it("documents the cp1252, NUL and uppercase-X numeric divergences from html.unescape()", async () => {
    // These pin CURRENT behaviour, they are not endorsements. An earlier
    // revision called this "three divergences" as though the list were closed.
    // It is not: the two tests immediately below add surrogates and
    // noncharacters, and the shared root cause is that this port implements
    // fromCodePoint() where CPython implements a sanitising table. Numbering a
    // list of gaps in a test title is how the fourth one goes unnoticed.
    //
    // 1. Windows-1252 payloads. CPython remaps C1 code points 0x80-0x9F to the
    //    cp1252 characters browsers actually render -- "&#151;" is an em dash
    //    in every browser and in Django. This port emits the raw C1 control.
    expect(await cleanFoodbankNeedText("&#151;")).toBe("\u0097");
    expect(await cleanFoodbankNeedText("&#151;")).not.toBe("—");
    // 2. NUL. CPython gives U+FFFD; this port writes a real \0 into text that
    //    is headed for D1 and for a rendered page.
    expect(await cleanFoodbankNeedText("&#0;")).toBe("\u0000");
    // 3. Uppercase "&#X41;". ENTITY_RE only allows a lowercase "x", so the
    //    whole reference fails to match and stays literal; CPython gives "A".
    //    (The `body[1] === "X"` arm inside decodeHtmlEntities is therefore
    //    unreachable -- the regex can never hand it an uppercase X.)
    expect(await cleanFoodbankNeedText("&#X41;")).toBe("&#X41;");
  });

  it("emits a LONE SURROGATE for &#xD800;, which is not valid UTF-8 at all (see suspected bugs)", async () => {
    // The one numeric divergence with a consequence beyond a wrong glyph, and
    // the file's earlier "three divergences" list missed it.
    //
    // CPython's _replace_charref returns U+FFFD for anything in 0xD800-0xDFFF.
    // String.fromCodePoint does NOT throw on a surrogate -- it only rejects
    // negatives, non-integers and > 0x10FFFF -- so the try/catch that saves the
    // out-of-range case never fires here, and an unpaired surrogate goes into
    // the return value. That string cannot be encoded as UTF-8: the D1 write,
    // the JSON response and TextEncoder each mangle or reject it differently,
    // so the corruption surfaces far from here and looks like a storage bug.
    expect(await cleanFoodbankNeedText("&#xD800;")).toBe("\ud800");
    expect(await cleanFoodbankNeedText("&#57343;")).toBe("\udfff"); // 0xDFFF, decimal form
    // Proof it really is unpaired rather than half of an astral character, and
    // that it cannot survive being written out as bytes: UTF-8 encoding
    // substitutes U+FFFD (EF BF BD), so the value that reaches D1 is not the
    // value this function returned.
    const out = await cleanFoodbankNeedText("&#xD800;");
    expect(out.length).toBe(1);
    expect(out.codePointAt(0)).toBe(0xd800);
    expect([...new TextEncoder().encode(out)]).toEqual([0xef, 0xbf, 0xbd]);
    // Contrast with the astral case, which round-trips through UTF-8 intact --
    // so this is specifically a surrogate problem, not a general one.
    const emoji = await cleanFoodbankNeedText("&#x1F600;");
    expect(new TextDecoder().decode(new TextEncoder().encode(emoji))).toBe(emoji);
  });

  it("keeps noncharacters and C0 controls that html.unescape() deletes outright", async () => {
    // Fourth and fifth divergences in the same family. CPython drops anything
    // in its _invalid_codepoints set -- U+FFFE/U+FFFF, the FDD0 block, and the
    // C0/C1 controls -- returning an EMPTY string for them. This port returns
    // the raw character, so a scrape carrying "&#127;" stores a DEL byte in the
    // need text where Django would have stored nothing.
    expect(await cleanFoodbankNeedText("[&#xFFFE;]")).toBe("[\ufffe]");
    expect(await cleanFoodbankNeedText("[&#127;]")).toBe("[\u007f]");
    // Escapes, not literal characters: a raw U+FFFE or DEL in a source file is
    // invisible in review and vanishes silently to a careless find-and-replace,
    // which is how an assertion like this rots into one that proves nothing.
    // U+FFFD itself is not in CPython's invalid set and passes through both
    // implementations, so the divergence is about the invalid ranges rather
    // than about fromCodePoint generally.
    expect(await cleanFoodbankNeedText("&#65533;")).toBe("\ufffd");
  });

  it("reads a zero-padded numeric reference as decimal, and the newline it yields is a real line break", async () => {
    // Leading zeros are how several CMSes pad numeric references, and CPython
    // parses them with int(s, 10) -- so "&#010;" is a newline, not a backspace
    // and not octal 8. Deliberately NOT claiming this guards the explicit
    // radix argument in parseInt(body.slice(1), 10): dropping that argument
    // changes nothing in modern JS, so a comment saying otherwise would be a
    // test that reads sharper than it is. What it does pin is the pipeline
    // consequence, which no other test covers at this point in the string: the
    // decoded newline reaches step 4 as a genuine line boundary, so a
    // zero-padded separator splits one CMS field into two items rather than
    // fusing them into a single key member.
    expect(await cleanFoodbankNeedText("&#0065;")).toBe("A");
    expect(await cleanFoodbankNeedText("A&#010;B")).toBe("A\nB");
    expect(needItemsKey(await cleanFoodbankNeedText("Beans&#010;Rice"))).toEqual(
      new Set(["beans", "rice"]),
    );
  });

  it("is deterministic across calls, which module-level mutable state is what would break", async () => {
    // ENTITY_RE lives at module scope with the global flag, so it carries a
    // mutable lastIndex shared by every call in the isolate -- and needcheck
    // makes thousands of calls inside ONE long-lived Worker isolate, where a
    // leaked lastIndex means the SECOND food bank of a run decodes differently
    // from the first. Invisible to any test that calls the function once.
    //
    // Honest about its reach: String.replace() resets lastIndex before and
    // after, and so does a complete exec() loop (exec returns null at the end
    // and resets), so this does NOT catch every rewrite of decodeHtmlEntities
    // -- verified against both. It catches the ones that leave the regex parked
    // mid-string (an early break, a retained match index) and the more general
    // class this really guards: any module-level cache or memo added later.
    const input = "Tea &amp; coffee &amp; sugar";
    const first = await cleanFoodbankNeedText(input);
    expect(first).toBe("Tea & coffee & sugar");
    expect(await cleanFoodbankNeedText(input)).toBe(first);
    // Interleaving a shorter input is the sharper ordering: a leaked index from
    // the long string would land inside the short one.
    expect(await cleanFoodbankNeedText("&amp;")).toBe("&");
    expect(await cleanFoodbankNeedText(input)).toBe(first);
  });

  // --- Operation 2: double-space removal -----------------------------------

  it("removes double spaces in ONE pass, exactly like Python's single .replace() call", async () => {
    // The module comment promises "single pass, matching Python's one
    // .replace('  ', ' ') call exactly". A run of three spaces therefore
    // becomes TWO, not one -- Django's output for this input is "Tea  &  Coffee"
    // and so is this port's. A tidy-up to / {2,}/g or / +/g would look like an
    // obvious improvement in a diff and would change every stored need text.
    expect(await cleanFoodbankNeedText("   Tea   &amp;   Coffee   ")).toBe("Tea  &  Coffee");
    expect(await cleanFoodbankNeedText("A  B    C")).toBe("A B  C");
  });

  it("is deliberately NOT idempotent, because Django is not either", async () => {
    // Consequence of the single pass above: cleaning an already-clean value can
    // still change it. Worth knowing before anyone adds a "just clean it again
    // on read" -- a second pass would rewrite stored text and register as a
    // need change. Django's second pass gives "A B C" too.
    const once = await cleanFoodbankNeedText("A  B    C");
    expect(await cleanFoodbankNeedText(once)).toBe("A B C");
    expect(await cleanFoodbankNeedText(once)).not.toBe(once);
  });

  it("collapses spaces that entity decoding produced, but not non-breaking spaces", async () => {
    // Ordering test for steps 1 and 2. Decoding runs FIRST, so "&#32;&#32;"
    // has become two real spaces by the time the double-space pass runs and is
    // collapsed. "&nbsp;&nbsp;" decodes to U+00A0 pairs, which are NOT the
    // ASCII "  " the replace looks for, so they survive -- identical to Django,
    // where replace("  ", " ") is equally ASCII-only.
    expect(await cleanFoodbankNeedText("A&#32;&#32;B")).toBe("A B");
    expect(await cleanFoodbankNeedText("Tea&nbsp;&nbsp;Coffee")).toBe("Tea\u00a0\u00a0Coffee");
  });

  // --- Operations 3-5: trim, empty lines, per-line trim --------------------

  it("strips a decoded &nbsp; at the edges, because both trim() and Python's strip() count it as space", async () => {
    // Scraped lists are full of "&nbsp;" padding. JS trim() removes Unicode Zs
    // and Python's str.strip() removes anything str.isspace() -- U+00A0 counts
    // for both, so this port and Django agree on "Beans".
    expect(await cleanFoodbankNeedText("&nbsp;Beans&nbsp;")).toBe("Beans");
  });

  it("drops blank and whitespace-only lines and trims each surviving line", async () => {
    // The realistic shape of a scraped block: padded items, a blank line and a
    // spaces-only line between them. Django gives exactly this answer.
    expect(await cleanFoodbankNeedText("  Tinned tomatoes  \n\n   \n  UHT milk\n")).toBe(
      "Tinned tomatoes\nUHT milk",
    );
  });

  it("drops a line whose only content is a decoded &nbsp;, which is what a CMS spacer row is", async () => {
    // The commonest real shape of a blank line in scraped HTML is not "\n\n" --
    // it is "<p>&nbsp;</p>", and by the time step 4 runs that line holds a
    // single U+00A0. Both sides agree it is blank: step 4's filter uses JS
    // trim(), which strips Unicode Zs, and Python's str.strip() strips anything
    // str.isspace(), which U+00A0 satisfies. A port that had reached for a
    // /^[ \t]*$/ test instead -- a very natural way to write "blank line" --
    // would keep the spacer and store a stray non-breaking space as an item,
    // which then reads as an extra member in the needItemsKey comparison.
    expect(await cleanFoodbankNeedText("Beans\n&nbsp;\nRice")).toBe("Beans\nRice");
    expect(needItemsKey(await cleanFoodbankNeedText("Beans\n&nbsp;\nRice"))).toEqual(
      new Set(["beans", "rice"]),
    );
  });

  it("handles input far larger than any real shopping list without blowing up", async () => {
    // Two bounded-cost claims, neither of which any other test exercises.
    // ENTITY_RE has no nested quantifier, so it cannot backtrack catastrophically
    // -- but that is a property of the pattern as written, and a future
    // "&(#x?[0-9a-fA-F]+|[a-zA-Z]+[a-zA-Z0-9]*)" style edit would introduce the
    // ambiguity. needcheckRender feeds this raw LLM output, whose length is not
    // bounded by anything this repo controls.
    const manyEntities = "&amp;".repeat(5000);
    expect(await cleanFoodbankNeedText(manyEntities)).toBe("&".repeat(5000));
    // And the single-pass double-space rule at scale: 10,000 spaces halve to
    // 5,000 rather than collapsing to one, and then trim() takes the lot. The
    // halving is the observable signature of the single pass -- an unbounded
    // / +/g would reach the same "" here and differ everywhere else.
    expect(await cleanFoodbankNeedText(" ".repeat(10000))).toBe("");
    expect(await cleanFoodbankNeedText(`[${" ".repeat(10000)}]`)).toBe(`[${" ".repeat(5000)}]`);
  });

  it("normalises CRLF to LF, which is what the admin form actually posts", async () => {
    // needs.ts and needNew.ts feed this straight from a <textarea> body, and
    // HTML form encoding sends CRLF. The lookbehind split keeps "\r\n" whole so
    // the blank line is dropped, then the per-line trim() removes the stray
    // "\r". If either step regressed, every admin-edited need would be stored
    // with carriage returns. Matches Django.
    expect(await cleanFoodbankNeedText("Tinned beans\r\n\r\nPasta\r\n")).toBe("Tinned beans\nPasta");
  });

  it("leaves a LONE \\r embedded -- and so does Django, contrary to the obvious reading of splitlines()", async () => {
    // NOT a divergence, despite looking like one. Python's splitlines() does
    // treat a bare "\r" as a line break, but it is called as splitlines(True),
    // which keeps the "\r" glued to its piece; the pieces are then rejoined
    // with "" and step 5 splits on "\n" only. CPython's answer for this input
    // is therefore "Tinned beans\rPasta" -- byte-identical to the port. Pinned
    // because the previous revision of this file asserted the opposite and
    // filed it as a bug: a "fix" that turned lone \r into \n would REGRESS
    // parity and rewrite the stored text of every page that uses old-Mac
    // line endings.
    expect(await cleanFoodbankNeedText("Tinned beans\rPasta")).toBe("Tinned beans\rPasta");
  });

  it("keeps a BLANK \\r-delimited segment that Django's splitlines() would drop -- the real divergence", async () => {
    // This is where splitting on "\n" only actually bites, and it took a
    // whitespace-only segment to expose it. splitlines(True) cuts
    // "Beans\r   \rRice" into ["Beans\r", "   \r", "Rice"], drops the middle
    // one for being blank, and rejoins to "Beans\rRice". The port sees no
    // "\n", so step 4 has nothing to split on and the blank run survives --
    // reduced only by the double-space pass, 3 spaces to 2.
    expect(await cleanFoodbankNeedText(`Beans\r${" ".repeat(3)}\rRice`)).toBe(
      `Beans\r${" ".repeat(2)}\rRice`,
    );
    // Same cause, no spaces needed: CPython collapses "\r\r" to a single "\r"
    // (the empty middle piece is dropped); the port keeps both.
    expect(await cleanFoodbankNeedText("Beans\r\rRice")).toBe("Beans\r\rRice");
    // The whole divergence class is bounded to lone \r and the other
    // splitlines-only separators (\v \f \x1c-\x1e \x85 U+2028 U+2029) AND a
    // blank segment. \v between two real items agrees with CPython, because
    // neither piece is blank.
    expect(await cleanFoodbankNeedText("Beans\vRice")).toBe("Beans\vRice");
  });

  it("returns an empty string for empty and whitespace-only input", async () => {
    // decision.ts's S6 rule keys off an empty need text ("never wipe a real
    // published need on an empty extraction"), so an all-whitespace scrape has
    // to reduce to "" rather than to " " or "\n".
    expect(await cleanFoodbankNeedText("")).toBe("");
    expect(await cleanFoodbankNeedText("   \n\n  \n ")).toBe("");
  });

  // --- Operation 6: UHT ----------------------------------------------------

  it("fixes the Uht miscapitalisation anywhere in the string, and only that spelling", async () => {
    // Django uses a plain str.replace, so it is case-sensitive and not
    // word-bounded: "uht" is left alone and "aUhtb" is rewritten mid-word.
    // Pinned because a "sensible" \bUht\b or case-insensitive fix would change
    // the third and fourth lines below and diverge from Django.
    expect(await cleanFoodbankNeedText("Uht milk\nUHT milk\nuht milk\naUhtb")).toBe(
      "UHT milk\nUHT milk\nuht milk\naUHTb",
    );
  });

  it("applies the UHT fix to text that only became \"Uht\" through decoding, proving step 6 runs last", async () => {
    // Ordering test for the two ends of the pipeline. "&#85;ht" is not "Uht"
    // until step 1 has run, so this only comes out right if step 6 sees the
    // DECODED string. Move the replace above the decode -- a plausible tidy-up
    // if someone groups the "cheap string ops" together -- and this silently
    // stops correcting the miscapitalisation on entity-encoded pages.
    expect(await cleanFoodbankNeedText("&#85;ht milk")).toBe("UHT milk");
  });

  // --- All six operations together ------------------------------------------

  it("runs all six operations in order over one realistic scrape, byte-identical to Django", async () => {
    // Every test above isolates one operation, which means none of them would
    // catch two operations being swapped in a way that only shows up in
    // combination. This is a single block shaped like what actually arrives
    // from a food bank's CMS: &nbsp; padding, a mis-cased "Uht", an &amp;, a
    // CRLF blank line, a tab-indented item, and two spellings of an em dash.
    // The expected value is CPython's, character for character.
    const scraped =
      "  &nbsp;&nbsp;Uht milk &amp; bread  \r\n" +
      "\r\n" +
      "   \n" +
      "\tTinned tomatoes (400g)\r\n" +
      "&#8212; sugar &mdash;\n";
    expect(await cleanFoodbankNeedText(scraped)).toBe(
      "UHT milk & bread\nTinned tomatoes (400g)\n— sugar —",
    );
    // And the thing the pipeline exists to protect: the key of that block is
    // three clean items, not four and not one.
    expect(needItemsKey(await cleanFoodbankNeedText(scraped))).toEqual(
      new Set(["uhtmilkbread", "tinnedtomatoes400g", "sugar"]),
    );
  });

  it("rejects rather than returning \"\" when handed null or undefined", async () => {
    // needcheckRender.ts feeds this the LLM's output, so a null is a live
    // possibility on a bad response. It is async, so the TypeError arrives as
    // a REJECTED PROMISE, not a synchronous throw -- a caller that wraps the
    // call site in try/catch without awaiting inside it will not catch this,
    // and the queue message fails as an unhandled rejection. Pinned so the
    // behaviour is a decision on record: this function does not defend itself,
    // its callers must.
    await expect(cleanFoodbankNeedText(null as unknown as string)).rejects.toThrow(TypeError);
    await expect(cleanFoodbankNeedText(undefined as unknown as string)).rejects.toThrow(TypeError);
    // needItemsKey(), which is called on the same data, deliberately does the
    // opposite -- see its own test.
  });
});

describe("needItemsKey", () => {
  it("returns an empty set for null, undefined and empty text", () => {
    // decision.ts calls this on `prev.excessChangeText`, typed `string | null`,
    // on every comparison. A throw here would break the whole needcheck run.
    expect(needItemsKey(null)).toEqual(new Set());
    expect(needItemsKey("")).toEqual(new Set());
    // undefined is outside the declared type but reachable from a D1 row whose
    // column is simply absent, and the `if (!text)` guard covers it. Pinned
    // because a future `text === null` tightening would look more precise and
    // would throw on exactly that row -- and, unlike cleanFoodbankNeedText(),
    // this one is documented as the forgiving half of the pair.
    expect(needItemsKey(undefined as unknown as string)).toEqual(new Set());
  });

  it("returns an empty set for whitespace-only text, not a set containing an empty string", () => {
    // The `if (token)` guard, stated as a boundary. An empty-string member
    // would give the set size 1, so keysEqual() would call a blank extraction
    // DIFFERENT from a genuinely empty one -- and decision.ts's S6 rule
    // ("never wipe a real published need on an empty extraction") keys off
    // exactly that comparison.
    expect(needItemsKey("   \n  \t \n")).toEqual(new Set());
    expect(needItemsKey("   \n  \t \n").size).toBe(0);
    expect(keysEqual(needItemsKey("   \n  \t \n"), needItemsKey(null))).toBe(true);
  });

  it("builds a fresh set per call, so a caller mutating the result cannot poison the next one", () => {
    // The `items` set is constructed inside the function. If it were ever
    // hoisted to module scope as a cache or a reused buffer, the needcheck run
    // would accumulate every food bank's items into one key and stop detecting
    // changes entirely -- silently, and only in the long-lived Worker isolate,
    // never in a single-call test.
    const first = needItemsKey("Beans");
    first.add("contaminant");
    expect(needItemsKey("Beans")).toEqual(new Set(["beans"]));
    expect(needItemsKey("Rice")).toEqual(new Set(["rice"]));
  });

  it("reduces each line to its lowercase alphanumeric characters", () => {
    // The Django docstring's definition, verbatim. Note "400g" survives: digits
    // are kept, so a size change on an item is still a change.
    expect(needItemsKey("Tinned Tomatoes (400g)")).toEqual(new Set(["tinnedtomatoes400g"]));
  });

  it("ignores item ORDER, which is the docstring's first stated purpose", () => {
    // "cosmetic reordering ... doesn't register as a change". A CMS that
    // re-sorts its list on every render would otherwise email a volunteer a
    // fake need change every single scrape.
    const a = needItemsKey("Beans\nPasta\nRice");
    const b = needItemsKey("Rice\nBeans\nPasta");
    expect(keysEqual(a, b)).toBe(true);
    // Asserting the CONTENT as well as the equality. On its own, "these two
    // keys are equal" is satisfied by an implementation that returns an empty
    // set for everything -- and an empty key would make every food bank compare
    // equal to every other, which is precisely the silent failure decision.ts
    // cannot survive. Every keysEqual-based test below pins content for the
    // same reason.
    expect(a).toEqual(new Set(["beans", "pasta", "rice"]));
    expect(a.size).toBe(3);
  });

  it("ignores separator punctuation WITHIN an item, the docstring's second purpose", () => {
    // '"/" vs "-" style difference doesn't register as a change.'
    expect(needItemsKey("Beans / Rice")).toEqual(new Set(["beansrice"]));
    expect(keysEqual(needItemsKey("Beans / Rice"), needItemsKey("Beans - Rice"))).toBe(true);
    expect(keysEqual(needItemsKey("Beans, Rice"), needItemsKey("Beans/Rice"))).toBe(true);
    // The equality above is only meaningful because both sides are this one
    // non-empty member; without that, an always-empty key passes the line.
    expect(needItemsKey("Beans - Rice")).toEqual(new Set(["beansrice"]));
  });

  it("does NOT merge items split across different lines -- the docstring's explicit exception", () => {
    // '"It deliberately does NOT merge items that are split across different
    // lines, so a genuine added/removed item still changes the set."' One line
    // becoming two is a real edit to the list and must survive as a change.
    expect(keysEqual(needItemsKey("Beans / Rice"), needItemsKey("Beans\nRice"))).toBe(false);
    expect(needItemsKey("Beans\nRice")).toEqual(new Set(["beans", "rice"]));
  });

  it("drops lines that reduce to nothing, so decorative separators are not items", () => {
    // Scraped lists routinely carry "---" or "***" rules and blank lines. If
    // these became set members, adding a horizontal rule to a page would read
    // as a need change.
    expect(needItemsKey("Beans\n---\n\n   \n***\nRice")).toEqual(new Set(["beans", "rice"]));
  });

  it("deduplicates, because it is a set (frozenset in Python)", () => {
    // A page that lists "Beans" twice must not compare unequal to one that
    // lists it once -- and must not make the size check in keysEqual() fire.
    expect(needItemsKey("Beans\nBeans\nBEANS\nbeans!")).toEqual(new Set(["beans"]));
  });

  it("strips the \\r of a CRLF line ending as ordinary non-alphanumeric punctuation", () => {
    // Same real-world source as the clean() CRLF test: admin form posts. The
    // "\r" is not a separator here, it is simply removed by the [^a-z0-9]
    // filter -- so CRLF and LF text produce identical keys and an admin edit
    // that only changes line endings is not a need change. Matches Django.
    expect(needItemsKey("Beans\r\nRice")).toEqual(new Set(["beans", "rice"]));
    expect(keysEqual(needItemsKey("Beans\r\nRice"), needItemsKey("Beans\nRice"))).toBe(true);
  });

  it("drops a line made only of characters outside [a-z0-9], including astral ones", () => {
    // The `if (token)` guard again, at the boundary that regex-without-/u makes
    // interesting: an emoji is a surrogate PAIR, so [^a-z0-9] deletes it as two
    // separate UTF-16 units and the line reduces to "". A bullet-emoji list --
    // common on the Facebook-sourced pages needcheck scrapes -- must therefore
    // contribute no members at all rather than one empty-string member, which
    // would make every such page compare unequal to an empty extraction and
    // trip decision.ts's S6 rule.
    expect(needItemsKey("\u{1F34E}")).toEqual(new Set());
    expect(needItemsKey("Beans\n\u{1F34E}\nRice")).toEqual(new Set(["beans", "rice"]));
    // Emoji WITHIN an item are stripped rather than splitting it.
    expect(needItemsKey("\u{1F34E} Tinned tomatoes 400g")).toEqual(
      new Set(["tinnedtomatoes400g"]),
    );
  });

  it("treats a lone \\r as part of the item, because it splits on \\n only", () => {
    // Pinned as the port's behaviour, with the parity question left open on
    // purpose. The previous revision claimed Django's splitlines() yields
    // {"beans", "rice"} here -- but this module documents need_items_key() as
    // splitting per LINE without saying which splitter, text.py is not in this
    // repo, and split("\n") and splitlines() disagree only on this input. So:
    // one item, not two, is what the port does; whether text.py:72-88 agrees
    // is unverified from here and must be checked against the Django source
    // before anyone "fixes" it.
    //
    // The consequence either way is worth stating: if a page ever emits \r
    // line endings, every item on it fuses into ONE key member, so any edit to
    // any item changes the whole key -- one real change, reported once, which
    // is the safe direction. Silently splitting instead would be the dangerous
    // one.
    expect(needItemsKey("Beans\rRice")).toEqual(new Set(["beansrice"]));
  });

  it("discards non-ASCII letters entirely, exactly as Django's re.sub(r'[^a-z0-9]') does", () => {
    // "Café" -> "caf" in both. Worth pinning because it looks like a bug and
    // is not: the port must not "improve" this to a Unicode-aware class, since
    // that would change the key of every accented item and make every food
    // bank with one look changed on the next run.
    expect(needItemsKey("Café")).toEqual(new Set(["caf"]));
    // The lowercasing happens before the filter, so case never reaches the key.
    expect(keysEqual(needItemsKey("CAFÉ"), needItemsKey("café"))).toBe(true);
  });

  it("gives PRECOMPOSED and DECOMPOSED accents different keys, because nothing normalises first", () => {
    // The sharp edge hiding behind the "Café" test above, which only works
    // because that literal happens to be NFC. Written with explicit escapes so
    // it cannot silently change with the file's encoding: U+00E9 is dropped
    // whole, but "e" + U+0301 keeps its "e" and drops only the combining mark.
    // Same visible word, different key.
    const precomposed = "Caf\u00e9"; // one code point for the accented e
    const decomposed = "Cafe\u0301"; // plain e plus a combining acute
    // Same word to a reader, and to any normalising comparison:
    expect(precomposed.normalize("NFC")).toBe(decomposed.normalize("NFC"));
    // ...but not to the key, which never normalises:
    expect(needItemsKey(precomposed)).toEqual(new Set(["caf"]));
    expect(needItemsKey(decomposed)).toEqual(new Set(["cafe"]));
    expect(keysEqual(needItemsKey(precomposed), needItemsKey(decomposed))).toBe(false);
    // CPython's re.sub(r"[^a-z0-9]", "", ...) behaves identically, so this is
    // parity -- but it means a CMS that switches its Unicode normalisation
    // form reports a need change for every accented item on the page. The fix
    // for that would be .normalize("NFC") in BOTH this port and text.py, never
    // in one of them.
  });

  it("lowercases without a locale, so a Turkish-locale runtime cannot change the key", () => {
    // toLowerCase() is locale-independent by spec; toLocaleLowerCase() is not,
    // and under tr-TR it maps "I" to dotless "ı", which [^a-z0-9] then
    // deletes -- turning "Rice" into "rce" and every food bank's key into a
    // different one depending on where the Worker ran. The vitest config pins
    // TZ but NOT the locale, so this is asserted rather than assumed.
    //
    // Exactly how far that reach goes, since the title promises more than one
    // process can prove: this DOES fail against a hard-coded
    // toLocaleLowerCase("tr"), because "I" would then vanish entirely and the
    // set would be empty. It does NOT fail against a bare toLocaleLowerCase(),
    // which is identical to toLowerCase() under this runner's default locale --
    // no single-process test can catch that one, so the defence is that the
    // distinction is written down here and the expected values are pinned.
    expect(needItemsKey("I")).toEqual(new Set(["i"]));
    expect(needItemsKey("RICE")).toEqual(new Set(["rice"]));
    // The reverse case: U+0130 (dotted capital I) lowercases to "i" plus a
    // combining dot, and the dot is filtered out, so it lands on "i" too.
    expect(needItemsKey("\u0130")).toEqual(new Set(["i"]));
  });

  it("still registers a genuinely added item as a change", () => {
    // The whole point of the insensitivity above is that it must not go so far
    // as to hide a real edit.
    expect(keysEqual(needItemsKey("Beans\nRice"), needItemsKey("Beans\nRice\nPasta"))).toBe(false);
  });
});

describe("keysEqual", () => {
  it("calls two empty keys equal", () => {
    // decision.ts compares an empty extraction against an empty published need
    // and must land on "no_change" rather than looping on a false change.
    expect(keysEqual(new Set(), new Set())).toBe(true);
  });

  it("ignores insertion order, which is the reason this exists instead of JSON.stringify", () => {
    // The module comment says callers must not rely on "reference equality or
    // JSON.stringify ordering" -- Set iteration is insertion-ordered, so
    // stringifying would call these two different.
    const a = new Set(["beans", "pasta", "rice"]);
    const b = new Set(["rice", "beans", "pasta"]);
    expect(keysEqual(a, b)).toBe(true);
    // The trap the comment warns about, shown failing:
    expect(JSON.stringify([...a]) === JSON.stringify([...b])).toBe(false);
  });

  it("is false when the sizes differ, in both directions", () => {
    // The size check is what stops a subset comparing equal to its superset:
    // the loop below it only proves a ⊆ b.
    const small = new Set(["beans"]);
    const big = new Set(["beans", "rice"]);
    expect(keysEqual(small, big)).toBe(false);
    expect(keysEqual(big, small)).toBe(false);
  });

  it("is false for same-size sets with different members", () => {
    expect(keysEqual(new Set(["beans", "rice"]), new Set(["beans", "pasta"]))).toBe(false);
    expect(keysEqual(new Set(["beans"]), new Set(["rice"]))).toBe(false);
  });

  it("does not mutate either argument", () => {
    // decision.ts compares one freshly-computed key against several stored
    // ones in a loop, reusing the same Set object on every call. A comparison
    // written as a destructive difference (a.delete(x) / b.delete(x) until one
    // empties) passes every equality test above and then makes the SECOND
    // comparison in that loop wrong -- so the first stored need it checks
    // against decides the answer for all of them.
    const a = new Set(["beans", "rice"]);
    const b = new Set(["beans", "pasta"]);
    keysEqual(a, b);
    keysEqual(a, a);
    expect([...a]).toEqual(["beans", "rice"]);
    expect([...b]).toEqual(["beans", "pasta"]);
  });

  it("is symmetric for every case above", () => {
    // Cheap property check: decision.ts calls it with the new key on either
    // side depending on the branch, so an asymmetric implementation would give
    // different answers for the same pair of need lists.
    // Each pair carries its EXPECTED answer, not just "the same both ways":
    // keysEqual() returning a constant false is perfectly symmetric, and would
    // report every scrape as a change, so symmetry alone is not a property
    // worth asserting on its own.
    const pairs: Array<[Set<string>, Set<string>, boolean]> = [
      [new Set(), new Set(), true],
      [new Set(["a"]), new Set(["a"]), true],
      [new Set(["a"]), new Set(["b"]), false],
      [new Set(["a"]), new Set(["a", "b"]), false],
      [new Set(["a", "b"]), new Set(["b", "a"]), true],
    ];
    for (const [a, b, expected] of pairs) {
      expect(keysEqual(a, b), `${[...a]} vs ${[...b]}`).toBe(expected);
      expect(keysEqual(b, a), `${[...b]} vs ${[...a]}`).toBe(expected);
    }
  });

});
