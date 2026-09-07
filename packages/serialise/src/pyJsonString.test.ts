import { describe, expect, it } from "vitest";
import { pyJsonString } from "./pyJsonString";

// Why this module exists: /needs/geo.json has to come out BYTE-identical to
// what Django's JsonResponse emitted, and the two runtimes disagree by
// default -- Python's json.dumps() is ensure_ascii=True, JS's JSON.stringify
// emits raw UTF-8. Nothing about that difference is visible in a diff or in a
// browser, so this file is the only place it gets caught.
//
// Every expected string below came from the real oracle --
// `python3 -c "import json; print(json.dumps(s))"` -- not from reading this
// implementation back to itself. That distinction matters: these tests fail
// when the port drifts from CPython, which is the actual requirement, rather
// than merely when it drifts from its own previous output.
//
// Three independent oracles are used, so that the sweeps below are not a
// second copy of the encoder wearing a disguise:
//   - a transcribed table of CPython's actual json.dumps output (CORPUS_ORACLE
//     below), which is the requirement itself rather than a proxy for it;
//   - JSON.stringify, which agrees with CPython over 0x20-0x7E exactly (same
//     seven short escapes, same pass-through) and disagrees everywhere else;
//   - JSON.parse, which knows only the RFC 8259 string grammar and nothing
//     about which of several legal encodings this module chose.
//
// The last two are deliberately weaker than the first, and knowing HOW they
// are weak is what stops them being read as more than they are: both are blind
// to the choice of hex case, so `ô` satisfies every structural check in
// this file while being the wrong bytes. Hex case is therefore pinned
// explicitly -- on the corpus by the oracle table, and on all 65,536 code
// units by the shape assertion inside the sweep.

// The shapes that genuinely reach this function on the live site: food bank
// names with curly apostrophes, Welsh and French place names, postal
// addresses, urls, and -- via geojsonBoundary.ts decoding and re-encoding a
// stored `boundary_geojson` column -- arbitrary text out of ONS boundary
// properties, which is where the stranger codepoints come from.
//
// Each entry carries the exact bytes CPython emits for it, so that no corpus
// string is exercised ONLY by the structural sweeps further down. That
// distinction has teeth: structural checks (pure ASCII, round-trips, escapes
// are well formed) are satisfied by several encodings that are not Django's --
// upper-case hex being the obvious one -- so a corpus entry with no byte-level
// expectation is a string this file cannot actually tell you is correct.
// Right-hand sides are the literal stdout of
//   python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" <input>
// on CPython 3.13, transcribed, never derived from this module's own output.
const CORPUS_ORACLE: Array<[input: string, cpython: string]> = [
  ["", `""`],
  ["Trussell Trust", `"Trussell Trust"`],
  ["St John\u2019s Church Hall", String.raw`"St John\u2019s Church Hall"`],
  ["Ynys M\u00f4n", String.raw`"Ynys M\u00f4n"`],
  [
    "1 Rue de l'\u00c9glise, Ynys M\u00f4n, LL77 7AA",
    String.raw`"1 Rue de l'\u00c9glise, Ynys M\u00f4n, LL77 7AA"`,
  ],
  // A url: the query-string ampersand and the slashes are all passed through,
  // which is worth having an oracle for because several JSON encoders in the
  // wild escape one or both, and Django's does not.
  ["https://www.example.org/a/b?c=d&e=f", `"https://www.example.org/a/b?c=d&e=f"`],
  ['The "Old" Barn \\ Store', String.raw`"The \"Old\" Barn \\ Store"`],
  ["line\nbreak\ttab", String.raw`"line\nbreak\ttab"`],
  // U+00A0 NO-BREAK SPACE, which reads as an ordinary space in every editor
  // and diff viewer but is escaped. Pasted addresses are full of them.
  ["caf\u00e9\u00a0bar", String.raw`"caf\u00e9\u00a0bar"`],
  ["Feeding \ud83d\ude00 Britain", String.raw`"Feeding \ud83d\ude00 Britain"`],
  // CJK: two code units that are both non-ASCII, so the whole output is
  // escapes with no raw characters at all to anchor it.
  ["\u98df\u54c1", String.raw`"\u98df\u54c1"`],
  ["Bwyd Cymru \u2013 Ll\u0177n", String.raw`"Bwyd Cymru \u2013 Ll\u0177n"`],
  ["a\u2028b\u2029c", String.raw`"a\u2028b\u2029c"`],
  ["\ud800", String.raw`"\ud800"`],
  ["ctrl \u0000\u001f\u007f end", String.raw`"ctrl \u0000\u001f\u007f end"`],
  // An escape immediately followed by upper-case letters. This is the shape
  // of a real ONS boundary property ("MON" style area codes after an accented
  // name), and it is here because a naive "no upper-case hex anywhere"
  // scan -- /\\u[0-9a-f]*[A-F]/ -- reports it as a violation even though the
  // output is perfectly correct. Any future purity check has to distinguish
  // hex digits INSIDE an escape from ordinary letters after one.
  ["M\u00f4nABCDEF", String.raw`"M\u00f4nABCDEF"`],
  // Literal backslash-u text that is NOT an escape, immediately followed by
  // non-hex. Same trap in the other direction: a scan that hunts for the two
  // characters \u anywhere in the OUTPUT finds one here, inside the doubled
  // backslash, and would demand four hex digits that correctly are not there.
  [String.raw`\uZZ top`, String.raw`"\\uZZ top"`],
  // A RUN of backslashes, plus literal backslash-n text that is not a
  // newline. Consecutive identical escapables are the classic place an
  // encoder goes context-sensitive by accident ("do not double a backslash
  // that is already doubled"), and a single lone backslash -- which was all
  // this corpus had -- cannot tell the two apart.
  [String.raw`C:\\share\needs`, String.raw`"C:\\\\share\\needs"`],
  // macOS hands over decomposed text: "e" + COMBINING ACUTE rather than
  // U+00E9. Both are legitimate contents of an address column.
  ["caf\u0065\u0301 bar", String.raw`"cafe\u0301 bar"`],
  // Escape widths: one, three and four significant hex digits, so the
  // zero-padding is exercised at every width and not just the common two.
  ["\u000b\u0100\u07ff\uffff", String.raw`"\u000b\u0100\u07ff\uffff"`],
];

const CORPUS = CORPUS_ORACLE.map(([input]) => input);

// An independent reader for the RFC 8259 string grammar. It knows only what a
// JSON parser knows -- which escapes exist and how long each one is -- and
// nothing about which characters this module chooses to escape, so it can be
// used to police the OUTPUT without restating the implementation.
//
// It exists because the obvious shortcut, searching the output for the two
// characters `\u`, is wrong in both directions: it flags ordinary upper-case
// letters that happen to follow an escape, and it mistakes the second half of
// a doubled backslash (`\\` + `u...`, which is literal text, not an escape)
// for an escape that must be followed by hex. Both shapes are in CORPUS.
function escapesIn(literal: string): string[] {
  expect(literal.startsWith('"')).toBe(true);
  expect(literal.endsWith('"')).toBe(true);
  expect(literal.length).toBeGreaterThanOrEqual(2);

  const problems: string[] = [];
  const escapes: string[] = [];
  const end = literal.length - 1;
  let i = 1;
  while (i < end) {
    const ch = literal[i] as string;
    if (ch !== "\\") {
      // An unescaped quote would have terminated the literal early, so a
      // parser would read a different (shorter) string than we encoded.
      if (ch === '"') problems.push(`unescaped quote at ${i}`);
      i += 1;
      continue;
    }
    const next = literal[i + 1];
    if (next === "u") {
      // Python formats with '{0:04x}': always four digits, always lowercase.
      const hex = literal.slice(i + 2, i + 6);
      if (!/^[0-9a-f]{4}$/.test(hex)) {
        problems.push(`malformed \\u escape at ${i}: ${JSON.stringify(literal.slice(i, i + 6))}`);
      }
      escapes.push(literal.slice(i, i + 6));
      i += 6;
      continue;
    }
    if (next === undefined || !'"\\/bfnrt'.includes(next)) {
      problems.push(`illegal escape at ${i}: ${JSON.stringify(literal.slice(i, i + 2))}`);
    }
    escapes.push(literal.slice(i, i + 2));
    i += 2;
  }
  expect(problems).toEqual([]);
  return escapes;
}

describe("pyJsonString", () => {
  it("reproduces the two live-site examples from the module header", () => {
    // Both were verified against production responses before the port was
    // written, and are quoted in the module's own comment. A curly apostrophe
    // in a food bank name and the circumflex in Ynys Mon are the most common
    // non-ASCII characters in the whole dataset, so if the escaping ever
    // regresses these are the bytes that change first.
    expect(pyJsonString("St John\u2019s Church Hall")).toBe(String.raw`"St John\u2019s Church Hall"`);
    expect(pyJsonString("Ynys M\u00f4n")).toBe(String.raw`"Ynys M\u00f4n"`);
  });

  it.each(CORPUS_ORACLE)("matches CPython json.dumps byte for byte on %j", (input, cpython) => {
    // The requirement stated directly, once per corpus string, instead of only
    // as the structural properties asserted over the corpus further down.
    // Those properties are necessary but not sufficient: upper-case hex, a
    // six-character escape where a printable character belongs, or a long-form
    // escape where a short one belongs all satisfy "pure ASCII, well-formed
    // escapes, round-trips" while shipping bytes Django never sent -- and a
    // byte-equality endpoint has no other way to notice.
    //
    // Before this existed, seven corpus strings -- the url, the CJK pair, the
    // no-break space, "Bwyd Cymru", "Trussell Trust" and both backslash
    // traps -- had no byte-level expectation anywhere in the file.
    expect(pyJsonString(input)).toBe(cpython);
  });

  it("diverges from JSON.stringify exactly where the header says it must", () => {
    // The entire reason the module exists, stated as the failure it prevents:
    // swapping a call site over to JSON.stringify -- an entirely
    // reasonable-looking simplification -- silently breaks byte-equality
    // parity with Django, because JSON.stringify emits the raw UTF-8
    // character. Both encodings MEAN the same string; assert that too, so it
    // is clear the divergence is only ever about the bytes on the wire.
    const name = "Ynys M\u00f4n";
    expect(pyJsonString(name)).not.toBe(JSON.stringify(name));
    expect(JSON.stringify(name)).toBe(`"${name}"`); // raw UTF-8: the bug
    expect(JSON.parse(pyJsonString(name))).toBe(name);
  });

  it("leaves the whole printable-ASCII range untouched", () => {
    // The header defines printable ASCII as 0x20-0x7E inclusive. Over exactly
    // that range Python and JS agree (same seven short escapes, same
    // pass-through), which makes the platform encoder a free independent
    // oracle: any mistake inside the ASCII range shows up as a divergence.
    let printable = "";
    for (let code = 0x20; code <= 0x7e; code++) printable += String.fromCharCode(code);
    expect(pyJsonString(printable)).toBe(JSON.stringify(printable));
    // Characters other JSON encoders like to escape but neither Python nor
    // this one does: a forward slash (some encoders write \/ so the body is
    // safe inside a <script>) and a straight apostrophe.
    expect(pyJsonString("https://example.org/a/b")).toBe('"https://example.org/a/b"');
    expect(pyJsonString("St John's Hall")).toBe(`"St John's Hall"`);
  });

  it("escapes DEL but not tilde, and 0x1F but not space", () => {
    // The exact edges of the 0x20-0x7E window, including the one that is easy
    // to get wrong: CPython's escape class is `[^\ -~]`, so 0x7F (DEL) is NOT
    // printable and IS escaped. Writing `code > 0x7f` instead of
    // `code > 0x7e` would emit a raw DEL byte and break parity invisibly.
    expect(pyJsonString("~")).toBe('"~"'); // 0x7E, last printable
    expect(pyJsonString("\u007f")).toBe(String.raw`"\u007f"`); // 0x7F, escaped
    expect(pyJsonString(" ")).toBe('" "'); // 0x20, first printable
    expect(pyJsonString("\u001f")).toBe(String.raw`"\u001f"`); // 0x1F, escaped
    expect(pyJsonString("\u0080")).toBe(String.raw`"\u0080"`); // first non-ASCII
  });

  it("prefers Python's seven short escapes over the long form", () => {
    // CPython's ESCAPE_DCT names exactly these seven and then fills the rest
    // of range(0x20) with setdefault, so the short forms win for these and
    // only these. Emitting the six-character long form for a newline would
    // still be valid JSON but would not be Django's bytes.
    expect(pyJsonString('back\\slash "quote" \b\f\n\r\t')).toBe(
      String.raw`"back\\slash \"quote\" \b\f\n\r\t"`,
    );
    // A RUN of them, which a single lone backslash cannot distinguish: two
    // backslashes in must be four out, and two quotes in must be four out.
    // json.dumps has no notion of an "already escaped" backslash -- it
    // doubles every one it is given, independently. An encoder that grew a
    // look-behind to avoid "double-doubling" would still round-trip through
    // JSON.parse for a single backslash and only corrupt runs.
    expect(pyJsonString("\\\\")).toBe(String.raw`"\\\\"`);
    expect(pyJsonString('""')).toBe(String.raw`"\"\""`);
    expect(pyJsonString("\\\\\\")).toBe(String.raw`"\\\\\\"`);
    expect(JSON.parse(pyJsonString("\\\\"))).toBe("\\\\"); // still two, not one
  });

  it("uses the long form for control characters that have no short escape", () => {
    // \v is the trap here: Python's repr() shows it as \x0b and C shows it as
    // \v, but JSON defines no short escape for it, so json.dumps writes the
    // six-character form. 0x00, 0x01, 0x0E and 0x1F are ordinary members of
    // the same no-short-escape group.
    expect(pyJsonString("\u0000\u0001\u000b\u000e\u001f")).toBe(
      String.raw`"\u0000\u0001\u000b\u000e\u001f"`,
    );
  });

  it("returns a bare pair of quotes for the empty string", () => {
    // Real input: a food bank location row with a blank `address` column. The
    // loop body never runs, so this is the one case that exercises nothing
    // but the opening and closing quotes.
    expect(pyJsonString("")).toBe('""');
  });

  it("emits a non-BMP character as the two surrogate escapes Python writes", () => {
    // The header's claim about walking UTF-16 code UNITS rather than
    // codepoints. An emoji is already two code units in a JS string, and
    // CPython's py_encode_basestring_ascii does its own manual surrogate-pair
    // encoding, so the two agree without any codepoint arithmetic here.
    // "Improving" the loop into a for..of (which iterates codepoints) would
    // produce a single five-digit escape, which is not even valid JSON.
    expect(pyJsonString("Feeding \ud83d\ude00 Britain")).toBe(
      String.raw`"Feeding \ud83d\ude00 Britain"`,
    );
    // Stated as the structural claim rather than as "the string 'u1f600' is
    // absent", which a five-digit escape spelled any other way would satisfy:
    // there must be exactly TWO escapes, each exactly six characters, and the
    // pair must decode back to the single astral codepoint.
    const emoji = String.fromCodePoint(0x1f600);
    const out = pyJsonString(emoji);
    expect(escapesIn(out)).toEqual([String.raw`\ud83d`, String.raw`\ude00`]);
    expect(out).toHaveLength(14); // two quotes + two six-character escapes
    expect(JSON.parse(out)).toBe(emoji);
    expect((JSON.parse(out) as string).codePointAt(0)).toBe(0x1f600);
  });

  it("passes a lone surrogate through instead of throwing or dropping it", () => {
    // Text truncated by byte length upstream can leave an unpaired surrogate
    // in the middle of a stored string. json.dumps does not object -- it
    // writes the escape as-is -- and neither does this. The failure prevented
    // here is a whole geo.json response 500ing over one malformed row.
    expect(() => pyJsonString("\ud800")).not.toThrow();
    expect(pyJsonString("\ud800")).toBe(String.raw`"\ud800"`);
    expect(pyJsonString("x\udfffy")).toBe(String.raw`"x\udfffy"`);
    // ...and the surrounding characters survive, which "does not throw" alone
    // would not tell us: a defensive implementation that dropped the bad unit
    // would still pass the two assertions above if they stood alone.
    expect(JSON.parse(pyJsonString("x\udfffy"))).toHaveLength(3);
  });

  it("escapes U+2028 and U+2029, which JSON.stringify leaves raw", () => {
    // A second real divergence from the platform encoder. These two are legal
    // raw inside a JSON string, so JSON.stringify passes them through, but
    // they are line terminators to a JS parser and break any body inlined
    // into a <script> -- the map_config pattern all over gfwfbn/views.py.
    // Python escapes them, so this must too.
    const seps = "a\u2028b\u2029c";
    expect(pyJsonString(seps)).toBe(String.raw`"a\u2028b\u2029c"`);
    expect(JSON.stringify(seps)).toBe(`"${seps}"`); // left raw: the difference
  });

  it("does not re-interpret a backslash-u sequence that is literal text", () => {
    // geojsonBoundary.ts JSON.parses a stored string and hands the DECODED
    // value here, so a value that genuinely contains the six characters
    // backslash-u-0-0-f-4 must come back with its backslash doubled, not
    // collapsed into an o-circumflex. Confirmed against json.dumps.
    const literal = String.raw`\u00f4`;
    expect(literal).toHaveLength(6); // guard: six characters, not one
    expect(pyJsonString(literal)).toBe(String.raw`"\\u00f4"`);
    expect(JSON.parse(pyJsonString(literal))).toBe(literal);
    // The same text where the following characters are NOT hex, so a reader
    // that mistook the doubled backslash for the start of an escape would be
    // looking at "\uZZ t" and demanding hex digits that must not be there.
    expect(pyJsonString(String.raw`\uZZ`)).toBe(String.raw`"\\uZZ"`);
    expect(JSON.parse(pyJsonString(String.raw`\uZZ`))).toBe(String.raw`\uZZ`);
  });

  it("does not normalise a decomposed accent away", () => {
    // A real hazard for byte-parity: "cafe" + COMBINING ACUTE (macOS filename
    // and clipboard form) and "caf" + U+00E9 are the same text to a human and
    // to a browser, but json.dumps escapes whatever code units it is actually
    // given. An encoder that helpfully called .normalize("NFC") would emit
    // seven bytes where Django emitted twelve, and no rendered page would
    // look any different.
    expect(pyJsonString("caf\u0065\u0301")).toBe(String.raw`"cafe\u0301"`);
    expect(pyJsonString("caf\u00e9")).toBe(String.raw`"caf\u00e9"`);
    expect(pyJsonString("caf\u0065\u0301")).not.toBe(pyJsonString("caf\u00e9"));
  });

  it("writes four lowercase hex digits for every escape, at every digit width", () => {
    // Python formats with '{0:04x}'. Two ways to break that: dropping the
    // padStart, which turns U+000B into an invalid two-character escape, and
    // upper-casing the hex, which stays valid JSON but stops matching Django
    // byte for byte -- the exact class of silent drift this file exists for.
    // All four significant-digit widths, because padStart(4) is only load
    // bearing for the first three.
    expect(pyJsonString("\u000b")).toBe(String.raw`"\u000b"`); // 1 digit, padded
    expect(pyJsonString("\u00d4")).toBe(String.raw`"\u00d4"`); // 2 digits, lowercase d4
    expect(pyJsonString("\u0100")).toBe(String.raw`"\u0100"`); // 3 digits
    expect(pyJsonString("\u07ff")).toBe(String.raw`"\u07ff"`); // 3 digits, lowercase ff
    expect(pyJsonString("\uffff")).toBe(String.raw`"\uffff"`); // 4 digits, top of the BMP
    // And across the corpus, via the grammar reader rather than a substring
    // search: every escape present is a legal one, six characters wide with
    // four lowercase hex digits, or one of the seven two-character forms.
    for (const s of CORPUS) {
      for (const escape of escapesIn(pyJsonString(s))) {
        expect(escape).toMatch(/^\\(?:u[0-9a-f]{4}|["\\bfnrt])$/);
      }
    }
  });

  it("always produces a quoted, pure-ASCII, re-parseable JSON string", () => {
    // The three invariants every caller leans on, asserted over the whole
    // corpus at once rather than case by case:
    //   - the result is a COMPLETE JSON string literal, quotes included --
    //     buildGeojson.ts splices it straight into a response body;
    //   - nothing outside 0x20-0x7E survives, which is what ensure_ascii
    //     means and what makes a byte comparison against Django meaningful;
    //   - it round-trips, so no amount of escaping ever loses a character.
    for (const s of CORPUS) {
      const out = pyJsonString(s);
      escapesIn(out); // quoted, and every escape inside it is well formed
      for (let i = 0; i < out.length; i++) {
        const code = out.charCodeAt(i);
        expect(code).toBeGreaterThanOrEqual(0x20);
        expect(code).toBeLessThanOrEqual(0x7e);
      }
      expect(JSON.parse(out)).toBe(s);
    }
  });

  it("encodes each code unit independently of the ones around it", () => {
    // This is the property that lets the 65,536-unit sweep below stand in for
    // every string that will ever reach the encoder: if a code unit's output
    // never depends on its neighbours, then checking all of them one at a
    // time really does check all inputs. Without it the sweep proves something
    // much narrower than it appears to -- that the encoder is right on strings
    // of length one.
    //
    // Worth stating plainly, because it is easy to over-read: a batching
    // optimisation that emits the SAME bytes (copying a run of printable
    // characters verbatim rather than one at a time) passes this test, and
    // should, because it is not a bug. What this catches is a batch whose
    // boundaries disagree with the per-unit rule -- a character class that
    // reaches one past the printable window, or a run that swallows a quote --
    // and a surrogate pair recombined into a single codepoint before escaping.
    for (const s of CORPUS) {
      const oneAtATime = Array.from({ length: s.length }, (_, i) =>
        pyJsonString(s[i] as string).slice(1, -1),
      ).join("");
      expect(pyJsonString(s)).toBe(`"${oneAtATime}"`);
    }
  });

  it("emits exactly one token per input code unit, and escapesIn can prove it", () => {
    // Two jobs, both about trusting the rest of this file.
    //
    // First, the module header's "walking UTF-16 code UNITS" claim, counted
    // rather than assumed: the loop appends exactly one thing per code unit,
    // so tokens in the output -- escapes plus raw characters -- must equal the
    // input's .length. An encoder that silently dropped an unpaired surrogate,
    // or folded a surrogate pair into one escape, changes that count.
    //
    // Second, and the reason this is a test of its own: escapesIn is a
    // hand-written oracle that most corpus assertions in this file lean on,
    // and nothing else checks it. If its while loop mis-stepped -- consuming
    // six characters for a two-character escape, say -- it would report FEWER
    // escapes than are there and the corpus checks would quietly stop policing
    // anything, with every test still green. Reconstructing the input length
    // from its output is a cross-check it cannot pass by accident.
    for (const s of CORPUS) {
      const out = pyJsonString(s);
      const escapes = escapesIn(out);
      const escapedChars = escapes.reduce((n, e) => n + e.length, 0);
      const rawChars = out.length - 2 - escapedChars;
      expect(escapes.length + rawChars).toBe(s.length);
    }

    // And the other half of trusting a policeman: show it actually arrests
    // someone. These are the violations it claims to detect, hand-built rather
    // than produced by the encoder, because an oracle that has never rejected
    // anything is indistinguishable from one that cannot. The first is the
    // load-bearing one: it is the check that makes escapesIn a hex-case
    // oracle, which is the one thing JSON.parse can never tell us.
    expect(() => escapesIn('"\\u00F4"')).toThrow(); // upper-case hex
    expect(() => escapesIn(String.raw`"\u00f"`)).toThrow(); // too few hex digits
    expect(() => escapesIn(String.raw`"\x41"`)).toThrow(); // escape JSON lacks
    expect(() => escapesIn('"a"b"')).toThrow(); // unescaped quote
    expect(() => escapesIn("no quotes")).toThrow(); // not a string literal
  });

  it("agrees with an independent oracle on every one of the 65,536 BMP code units", () => {
    // The net under all the named cases above. Every plausible wrong version
    // of the boundary test (>= 0x7f, > 0x7f, <= 0x20, a forgotten DEL, an
    // extra character escaped "to be safe") differs from the real rule on at
    // least one code unit, and this sweep finds it. Neither oracle is a copy
    // of the encoder:
    //   - inside 0x20-0x7E, JSON.stringify is a second implementation that
    //     happens to agree with CPython over exactly that window;
    //   - outside it, the claim is structural -- exactly ONE escape, nothing
    //     raw, and JSON.parse (which knows only the grammar) gets the
    //     original code unit back.
    // Failures are collected rather than asserted in the loop so that a real
    // regression reports the first few offending code points instead of
    // 65,000 identical vitest diffs.
    const wrong: string[] = [];
    const shortFormOutsideAscii: number[] = [];
    const note = (msg: string) => {
      if (wrong.length < 12) wrong.push(msg);
    };
    for (let code = 0; code <= 0xffff; code++) {
      const ch = String.fromCharCode(code);
      const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
      const out = pyJsonString(ch);
      if (code >= 0x20 && code <= 0x7e) {
        const expected = JSON.stringify(ch);
        if (out !== expected) note(`${hex}: got ${out}, JSON.stringify says ${expected}`);
        continue;
      }
      // A two-character short escape renders as 4 with the quotes, a \uXXXX
      // as 8. Anything else means the code unit was passed through raw, or
      // dropped, or turned into a five-digit codepoint escape.
      //
      // The long form is matched against its exact shape, not just its length,
      // because the other two oracles in this loop are both blind to hex case:
      // `\u00F4` is pure ASCII and JSON.parse hands back the same code unit,
      // so upper-casing the hex -- `toString(16).toUpperCase()`, a one-word
      // "tidy-up" that makes escapes easier to read -- would sail through a
      // length-and-round-trip check on all 65,536 units while breaking byte
      // parity with Django on every non-ASCII character the site emits.
      // Python formats with '{0:04x}', so: lower case, always four digits.
      if (out.length === 4) shortFormOutsideAscii.push(code);
      else if (out.length !== 8) note(`${hex}: expected one escape, got ${JSON.stringify(out)}`);
      else if (!/^"\\u[0-9a-f]{4}"$/.test(out)) note(`${hex}: not '{0:04x}' shaped: ${out}`);
      for (let i = 0; i < out.length; i++) {
        const c = out.charCodeAt(i);
        if (c < 0x20 || c > 0x7e) {
          note(`${hex}: output is not pure ASCII: ${JSON.stringify(out)}`);
          break;
        }
      }
      try {
        if (JSON.parse(out) !== ch) note(`${hex}: does not round-trip, got ${JSON.stringify(out)}`);
      } catch {
        note(`${hex}: output is not parseable JSON: ${JSON.stringify(out)}`);
      }
    }
    expect(wrong).toEqual([]);
    // CPython's ESCAPE_DCT has seven entries. Two of them (" and \) live
    // inside printable ASCII and are covered by the JSON.stringify branch
    // above, so exactly these five are the ones that take the short form from
    // outside the window. If a sixth ever appeared here -- \v as \\v, say,
    // which is what a C programmer writes by reflex -- it would still be
    // valid JSON and would still round-trip, and only this line would notice.
    expect(shortFormOutsideAscii).toEqual([0x08, 0x09, 0x0a, 0x0c, 0x0d]);
  });

  it("is deliberately NOT idempotent, which is why toDjangoJsonFormat applies it exactly once", () => {
    // geojsonBoundary.ts's header calls out that the formatting pass runs
    // "EXACTLY ONCE" over an assembled body. This is what the second pass
    // would cost: the quotes from the first pass become content, so the value
    // on the wire gains a layer of escaping and every consumer reads a
    // quoted, backslash-laden string instead of the name. Pinning it here
    // means a caller that starts double-encoding breaks a test in the module
    // that documents the rule, not just a byte-diff nobody runs.
    const once = pyJsonString("Ynys M\u00f4n");
    const twice = pyJsonString(once);
    expect(twice).not.toBe(once);
    expect(twice).toBe(String.raw`"\"Ynys M\\u00f4n\""`);
    expect(JSON.parse(twice)).toBe(once); // one layer off, not two
    expect(JSON.parse(JSON.parse(twice) as string)).toBe("Ynys M\u00f4n");
  });

  it("silently encodes a non-string as the empty string rather than its value", () => {
    // Pinned as CURRENT behaviour, not endorsed -- see the suspected-bug note
    // in this task's report. The loop is `i < s.length`, and a number's
    // `.length` is undefined, so the comparison is false and the function
    // returns a bare pair of quotes. TypeScript stops this at every call site
    // that exists today (the only caller, toDjangoJsonFormat, hands over the
    // result of JSON.parse on a string literal), but pyJsonString is exported
    // from @givefood/serialise's index, so a future caller passing a numeric
    // column would ship `""` into geo.json with no error anywhere.
    expect(pyJsonString(42 as unknown as string)).toBe('""');
    expect(pyJsonString(0 as unknown as string)).toBe('""');
    expect(pyJsonString(-0 as unknown as string)).toBe('""');
    expect(pyJsonString(Number.NaN as unknown as string)).toBe('""');
    // The two numbers most likely to arrive from a real column -- a latitude
    // and a large integer id -- blanked just as silently as 42. Worth naming
    // because "someone passes a number" sounds hypothetical until it is the
    // `lat` column of a food bank location.
    expect(pyJsonString(53.2194 as unknown as string)).toBe('""');
    expect(pyJsonString(Number.MAX_SAFE_INTEGER as unknown as string)).toBe('""');
    expect(pyJsonString(true as unknown as string)).toBe('""');
    expect(pyJsonString({} as unknown as string)).toBe('""');
    expect(pyJsonString([] as unknown as string)).toBe('""');
    // null and undefined -- the shape a nullable D1 TEXT column arrives in --
    // do throw, because `.length` is read off them directly. So the failure
    // mode is not even consistent: a null address 500s the response, a
    // numeric one is silently blanked.
    expect(() => pyJsonString(null as unknown as string)).toThrow(TypeError);
    expect(() => pyJsonString(undefined as unknown as string)).toThrow(TypeError);
    // An array of characters gets far enough to index but not to charCodeAt.
    expect(() => pyJsonString(["a"] as unknown as string)).toThrow(TypeError);
  });

  it("handles a boundary-sized value without throwing or losing a character", () => {
    // toDjangoJsonFormat runs this over every string literal in an assembled
    // geo.json body, including the re-embedded contents of a stored
    // `boundary_geojson` column, which for a large local authority is
    // hundreds of kilobytes. The concern is not speed but the refactors that
    // look equivalent at 20 characters and are not at 200,000: spreading the
    // string into String.fromCharCode(...units) blows the argument limit, and
    // any recursive formulation blows the stack. Both would pass every other
    // test in this file.
    const big = "St John\u2019s Church Hall, Ynys M\u00f4n \ud83d\ude00\n".repeat(6000);
    expect(big.length).toBeGreaterThan(200_000);
    let out = "";
    expect(() => {
      out = pyJsonString(big);
    }).not.toThrow();
    expect(JSON.parse(out)).toBe(big); // nothing dropped, nothing doubled
    expect(/^"[\x20-\x7e]*"$/.test(out)).toBe(true); // still pure ASCII throughout
    expect(escapesIn(out)).toHaveLength(6000 * 5); // curly quote, o-circ, 2 surrogates, \n
  });

  it("encodes a whole geo.json feature property the way the endpoint needs", () => {
    // End-to-end shape of a real property value: an address carrying both an
    // accented capital and a straight apostrophe, which is the combination
    // that exposed the JSON.stringify divergence in the first place.
    expect(pyJsonString("1 Rue de l'\u00c9glise, Ynys M\u00f4n, LL77 7AA")).toBe(
      String.raw`"1 Rue de l'\u00c9glise, Ynys M\u00f4n, LL77 7AA"`,
    );
  });
});
