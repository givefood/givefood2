import { YAML11_SCHEMA, dump, load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { formatYaml } from "./yaml";

// The Django ancestor is one line -- gfapi2/func.py:59:
//
//   yaml.dump(data, encoding='utf-8', allow_unicode=True, default_flow_style=False)
//
// and YAML is the ONE format the port does not hold to byte parity
// (maintainer decision 2026-08-30, PLAN.md §7.10.1 S1 and §7.4.4). That
// makes "what exactly did we give up?" the question these tests exist to
// answer, because a descope nobody wrote down becomes a regression nobody
// can spot.
//
// So every expected string below was diffed against REAL PyYAML output for
// the same input (PyYAML 6.0.2 locally; production's uv.lock pins 6.0.3),
// not guessed from the plan's property table. The great majority come out
// byte-identical, and those tests say so; the handful that do not are
// labelled DIVERGENCE, with PyYAML's actual bytes quoted next to them and
// an assertion that both forms still LOAD to the same value -- which is
// the whole of what structural parity promises a consumer.
//
// formatYaml itself is ten lines: unwrap the value tree (exactly as json.ts
// does) and hand it to js-yaml with sortKeys. What it genuinely owns, and
// what can therefore break invisibly, is:
//
//   1. datetimes staying TIMESTAMPS on the wire rather than becoming
//      strings -- the PyTimestamp class and custom tag exist for that one
//      purpose, and a quoted datetime looks completely fine in a diff;
//   2. the unwrapping of __float/__datetime wrappers wherever they are
//      nested;
//   3. sorted keys.
//
// Everything else is js-yaml's behaviour, asserted here only where the
// module's header comment makes a claim about it ("sorted keys and a `|-`
// block literal ... checked directly, not assumed") -- if a js-yaml upgrade
// changes one of those, this file fails instead of the comment quietly
// becoming a lie.

describe("formatYaml -- key order", () => {
  it("sorts every mapping alphabetically, which no other format here does", () => {
    // PyYAML's sort_keys defaults to True and gfapi2 does not override it,
    // so YAML is the only one of the four formats where the wire order is
    // not the dict literal's order (PLAN.md §7.4.4). Byte-identical to
    // PyYAML for this input, ordering included: for BMP keys Python's
    // sorted() and JS's default Array#sort agree, so "Mid" < "_u" <
    // "alpha" < "zebra" in both languages. (They do NOT agree above the
    // BMP -- see the astral-key test at the end of this block, which is why
    // that claim is narrowed to BMP here rather than stated generally.)
    expect(formatYaml({ zebra: 1, alpha: 2, Mid: 3, _u: 4, "2": 5 })).toBe("'2': 5\nMid: 3\n_u: 4\nalpha: 2\nzebra: 1\n");

    // Object.keys() would have handed js-yaml this input in insertion order
    // with the integer-like key hoisted to the front ("2", zebra, alpha,
    // Mid, _u) -- a shape close enough to the sorted answer at the ends to
    // hide a dropped sortKeys, so assert the middle moves too. Accented
    // keys are byte-identical to PyYAML as well: "é" (U+00E9) sorts after
    // every ASCII letter in both languages.
    expect(formatYaml({ "é": 1, z: 2, a: 3 })).toBe("a: 3\nz: 2\né: 1\n");
    // Case matters, and matters the same way: capitals sort before
    // lower-case in both, so `closed` never lands next to `Closed`.
    expect(formatYaml({ b: 1, A: 2, a: 3, B: 4 })).toBe("A: 2\nB: 4\na: 3\nb: 1\n");
  });

  it("sorts nested mappings too, not just the top level", () => {
    // A real response is two or three levels deep (`urls`, `charity`,
    // `politics` in /api/2/foodbanks/), so sorting only the root would
    // still be wrong on most of the document.
    expect(formatYaml({ b: 1, a: { z: 1, y: 2 } })).toBe("a:\n  'y': 2\n  z: 1\nb: 1\n");
  });

  it("quotes a key that would otherwise be read back as another type", () => {
    // Key type matters as much as value type to anyone doing response["2"].
    // The numeric key is byte-identical to PyYAML, which quotes it for the
    // same reason: bare, it loads as the integer 2.
    expect(formatYaml({ "2": 5, name: "X" })).toBe("'2': 5\nname: X\n");

    // DIVERGENCE, in the safe direction: js-yaml also quotes the single
    // letters y and n (YAML 1.1 booleans), where PyYAML 6 leaves them bare
    // because its own bool resolver dropped the one-letter forms. Both
    // load back as the strings "y"/"n" under PyYAML; the port's extra
    // quoting additionally survives a stricter YAML 1.1 reader.
    expect(formatYaml({ y: 1, n: 2 })).toBe("'n': 2\n'y': 1\n"); // PyYAML: "n: 2\ny: 1\n"
  });

  it("quotes an empty key where PyYAML switches to explicit-key syntax", () => {
    // DIVERGENCE. PyYAML cannot write an empty key inline and falls back to
    // the explicit form -- "? ''\n: 1\n" -- while js-yaml quotes it in
    // place. Both load to { "": 1 }, verified against PyYAML 6.0.2. An
    // empty key is not a shape any current endpoint produces, but it is one
    // `row[col]` away in anything that keys a mapping by a data value, and
    // an empty body or a crash would be a far worse outcome than either
    // spelling.
    expect(formatYaml({ "": 1 })).toBe("'': 1\n"); // PyYAML: "? ''\n: 1\n"
    expect(load(formatYaml({ "": 1 }))).toEqual({ "": 1 });
  });

  it("DIVERGENCE: sorts astral-plane keys by UTF-16 code unit, not code point", () => {
    // CURRENT BEHAVIOUR, pinned rather than fixed (reported instead).
    //
    // The sorted-keys claim above holds only up to U+FFFF. JS compares
    // strings by UTF-16 CODE UNIT, so an emoji (U+1F96B, stored as the
    // surrogate pair D83E DD6B) compares as 0xD83E and sorts BEFORE
    // U+FFFD; Python's sorted() compares by CODE POINT and puts U+FFFD
    // first. Verified both ways against PyYAML 6.0.2, which emits
    // "�: 2\n\u{1F96B}: 1\n" for this input.
    //
    // Harmless for today's endpoints, whose keys are all ASCII column
    // names -- pinned because it is the kind of ordering assumption that
    // looks proven by the ASCII test above and is not, and because the day
    // a mapping is keyed by food bank name is the day it starts mattering.
    expect(formatYaml({ "\u{1F96B}": 1, "�": 2 })).toBe("\u{1F96B}: 1\n�: 2\n");
  });
});

describe("formatYaml -- the scalar table in PLAN.md §7.4.4", () => {
  it("renders null, empty string, booleans and integers exactly as PyYAML does", () => {
    // Straight off the plan's property table: None -> null, "" -> '',
    // booleans lower-case. Byte-identical to PyYAML for this input.
    expect(formatYaml({ a: null, b: "", c: true, d: false, e: 0 })).toBe("a: null\nb: ''\nc: true\nd: false\ne: 0\n");
  });

  it("keeps null and empty string distinguishable, which XML and CSV cannot", () => {
    // PLAN.md §7.4.7: the null/'' distinction survives in JSON and YAML and
    // is already lost in XML and CSV. It is live data -- alt_name is NULL
    // for most food banks while delivery_address is an empty string -- so
    // assert it on the loaded value, not just on the bytes.
    expect(load(formatYaml({ alt_name: null, delivery_address: "" }))).toEqual({ alt_name: null, delivery_address: "" });
  });

  it("writes non-ASCII as raw UTF-8, never \\u escapes (allow_unicode=True)", () => {
    // gfapi2 passes allow_unicode=True. Welsh and Gaelic food bank names,
    // and the en-dashes editors paste into addresses, all go through here;
    // escaping them would still parse but would make the response
    // unreadable and change its byte length. Byte-identical to PyYAML.
    expect(formatYaml({ name: "Café Köln — 日本語" })).toBe("name: Café Köln — 日本語\n");
    expect(formatYaml({ item: "🥫" })).toBe("item: 🥫\n");
  });

  it("quotes strings a YAML 1.1 reader would turn into booleans", () => {
    // PyYAML is a YAML 1.1 implementation, so an unquoted `no` loads as
    // False -- and js-yaml (YAML 1.2 core) keeps quoting these for exactly
    // that reason. Byte-identical to PyYAML for all seven. The realistic
    // casualty is a one-word free-text field ("no", "on") arriving as a
    // boolean in someone's client.
    expect(formatYaml({ a: "yes", b: "no", c: "on", d: "off", e: "true", f: "null", g: "~" })).toBe(
      "a: 'yes'\nb: 'no'\nc: 'on'\nd: 'off'\ne: 'true'\nf: 'null'\ng: '~'\n",
    );
  });

  it("quotes number-like strings but leaves a phone number plain", () => {
    // Byte-identical to PyYAML, including the asymmetry: '0123' would load
    // as the integer 123 and so is quoted, while "01234 567890" contains a
    // space and cannot be read as a number, so it stays bare. Phone numbers
    // and postcodes are the two fields where this shows up in real data.
    expect(formatYaml({ a: "01234 567890", b: "0123", c: "1.5", d: "12" })).toBe(
      "a: 01234 567890\nb: '0123'\nc: '1.5'\nd: '12'\n",
    );
  });

  it("quotes the number spellings only a YAML 1.1 reader resolves", () => {
    // js-yaml is a YAML 1.2 writer and PyYAML a YAML 1.1 one, so the set of
    // strings that MUST be quoted is strictly larger for the CONSUMER than
    // for the writer -- octal `017`, hex `0x1F` and the underscore-separated
    // `1_000` are numbers in 1.1 and plain strings in 1.2, so a writer that
    // quoted only what its own version requires would still be correct 1.2
    // and would still hand a Python client an integer where a stock code or
    // an item quantity belongs.
    //
    // js-yaml quotes them anyway -- byte-identical to PyYAML for all six --
    // and that is worth an assertion precisely because nothing in yaml.ts
    // asks for it: it is inherited from the library, so it is a js-yaml
    // major version away from changing, with no local code to review when
    // it does.
    expect(formatYaml({ a: "0x1F", b: "017", c: "+1", d: ".5", e: ".inf", f: "1_000" })).toBe(
      "a: '0x1F'\nb: '017'\nc: '+1'\nd: '.5'\ne: '.inf'\nf: '1_000'\n",
    );

    // DIVERGENCE, in the safe direction: "1e5" is NOT a float in YAML 1.1
    // (PyYAML's float resolver requires a dot), so PyYAML leaves it bare and
    // js-yaml quotes it. Both read back as the string.
    expect(formatYaml({ a: "1e5" })).toBe("a: '1e5'\n"); // PyYAML: a: 1e5
    expect(load(formatYaml({ a: "1e5" }), { schema: YAML11_SCHEMA })).toEqual({ a: "1e5" });
  });

  it("quotes a clock time, which YAML 1.1 would otherwise read as base-60", () => {
    // Opening hours are the single most common colon-bearing string on this
    // site, and YAML 1.1 has a sexagesimal integer type: bare, `9:30` loads
    // as 9*60+30 = 570. Verified against PyYAML 6.0.2 both ways -- it emits
    // the same quoted form, and it loads the UNQUOTED form as the integer
    // 570 -- so the quoting is the only thing standing between an opening
    // time and a meaningless number in a Python client.
    expect(formatYaml({ open: "9:30", closes: "1:30:15" })).toBe("closes: '1:30:15'\nopen: '9:30'\n");
    expect(load(formatYaml({ open: "9:30" }), { schema: YAML11_SCHEMA })).toEqual({ open: "9:30" });
    // The counterfactual, so the assertion above is not just describing
    // whatever came out: the same characters unquoted really do change type.
    expect(load("open: 9:30\n", { schema: YAML11_SCHEMA })).toEqual({ open: 570 });
  });

  it("quotes a value that starts with a YAML indicator, and one containing ' #'", () => {
    // Need text is scraped from food bank pages and is frequently a bullet
    // ("- Beans"), a note with a hash ("Beans # 2 tins") or a label with a
    // colon-space ("Opening: 9am"). Each of those, emitted plainly, changes
    // the DOCUMENT rather than just the value: a leading "- " starts a
    // sequence, " #" starts a comment that swallows the rest of the line,
    // ": " splits the scalar into a nested mapping. Byte-identical to
    // PyYAML for every case here, which is the strongest statement
    // available -- a whole class of scraped strings survives the port
    // unchanged.
    expect(formatYaml({ a: "- Beans", b: "Beans # 2 tins", c: "Opening: 9am" })).toBe(
      "a: '- Beans'\nb: 'Beans # 2 tins'\nc: 'Opening: 9am'\n",
    );
    expect(load(formatYaml({ a: "- Beans", b: "Beans # 2 tins", c: "Opening: 9am" }))).toEqual({
      a: "- Beans",
      b: "Beans # 2 tins",
      c: "Opening: 9am",
    });

    // The asymmetry is the part a hand-rolled quoting rule gets wrong: it is
    // ": " that is dangerous, not ":", so a bare colon stays plain. Also
    // byte-identical to PyYAML -- both implementations implement the spec
    // rule rather than "contains a colon".
    expect(formatYaml({ a: "Opening:9am" })).toBe("a: Opening:9am\n");

    // The remaining leading indicators, in one line. All byte-identical to
    // PyYAML. `&`, `*` and `!` are the sharp ones: unquoted they would be
    // read as an anchor, an alias and a tag, so a need item that happens to
    // start with "*" would either vanish or fail the parse outright.
    expect(
      formatYaml({ a: "[1,2]", b: "&anchor", c: "*ref", d: "!secret", e: "%YAML", f: "@handle", g: "`cmd`", h: "? what" }),
    ).toBe("a: '[1,2]'\nb: '&anchor'\nc: '*ref'\nd: '!secret'\ne: '%YAML'\nf: '@handle'\ng: '`cmd`'\nh: '? what'\n");
  });

  it("DIVERGENCE: escapes a non-breaking space where PyYAML prints it raw", () => {
    // U+00A0 arrives here constantly -- it is what `&nbsp;` in a scraped
    // food bank page decodes to. PyYAML with allow_unicode=True treats it as
    // an ordinary printable character and emits it raw (`a: x\xa0y`);
    // js-yaml treats it as non-printable and double-quotes with YAML's `\_`
    // escape. Cosmetic only, and verified in the direction that matters:
    // PyYAML 6.0.2 reads js-yaml's `"x\_y"` back as U+00A0, so a Python
    // client sees the same string either way.
    expect(formatYaml({ a: "x\u00a0y" })).toBe('a: "x\\_y"\n'); // PyYAML: a: x<U+00A0>y
    expect(load(formatYaml({ a: "x\u00a0y" }))).toEqual({ a: "x\u00a0y" });

    // And the same treatment for U+0085 (NEL), where the port is the one
    // that is CORRECT: both call it a line break, but PyYAML single-quotes
    // it and its own output is lossy -- PyYAML 6.0.2 reads its own
    // `'x\x85  y'` back as "x y", losing the character. js-yaml's `\N`
    // survives a PyYAML round-trip intact. Pinned so a future "match PyYAML
    // exactly here" change is recognised as a regression, not a fix.
    expect(formatYaml({ a: "x\u0085y" })).toBe('a: "x\\Ny"\n');
    expect(load(formatYaml({ a: "x\u0085y" }))).toEqual({ a: "x\u0085y" });
  });
});

describe("formatYaml -- datetimes", () => {
  it("emits str(datetime): space separator, six digits, unquoted", () => {
    // PLAN.md §7.4.6's YAML column, and byte-identical to what PyYAML's
    // represent_datetime produces for the same value. The space separator
    // and six digits are what distinguish this rendering from the JSON one
    // (three digits, 'T') on the very same database column.
    expect(formatYaml({ created: { __datetime: "2020-01-24 16:30:23.173268" } })).toBe(
      "created: 2020-01-24 16:30:23.173268\n",
    );
  });

  it("stays a TIMESTAMP on the wire, not a string -- the reason PyTimestamp exists", () => {
    // This is the module's whole point, and the one thing about it that a
    // reviewer cannot see by reading the output: both forms look plausible,
    // but only the unquoted one carries the type. Load the emitted document
    // with a YAML 1.1 loader -- which is what PyYAML consumers are -- and
    // the value has to come back as a Date.
    const asDatetime = formatYaml({ created: { __datetime: "2020-01-24 16:30:23.173268" } });
    expect(load(asDatetime, { schema: YAML11_SCHEMA })).toEqual({ created: new Date("2020-01-24T16:30:23.173Z") });

    // And the counterpart the module comment warns about: hand the very
    // same text through as a plain string and js-yaml quotes it, because a
    // reader would otherwise resolve it as a timestamp. Same characters,
    // different type -- so a refactor that "simplifies" PyTimestamp away
    // into a string silently changes every created/found field's type.
    const asString = formatYaml({ created: "2020-01-24 16:30:23.173268" });
    expect(asString).toBe("created: '2020-01-24 16:30:23.173268'\n");
    expect(load(asString, { schema: YAML11_SCHEMA })).toEqual({ created: "2020-01-24 16:30:23.173268" });
  });

  it("gives the two D1 datetime shapes one identical rendering", () => {
    // pyDatetime.ts's headline bug: rows copied from Postgres carry
    // Python's str(datetime) and rows this port writes carry
    // toISOString(), so before the fix the same endpoint answered with a
    // different shape for a need found last year than for one found
    // yesterday. Assert the two shapes converge, not merely that each
    // parses.
    const fromEtl = formatYaml({ found: { __datetime: "2026-09-05 15:21:42.853000" } });
    const fromWorker = formatYaml({ found: { __datetime: "2026-09-05T15:21:42.853Z" } });
    expect(fromWorker).toBe(fromEtl);
    expect(fromWorker).toBe("found: 2026-09-05 15:21:42.853000\n");
  });

  it("omits the fraction entirely when the microsecond is zero", () => {
    // Python's rule, reproduced in pyDatetime.ts and confirmed against
    // PyYAML: `datetime(...,0)` renders as `2020-01-24 16:30:23` with no
    // `.000000`. Note this is the opposite of packages/models' pyDatetime,
    // which pads on purpose for D1 sort keys -- the two must not be
    // "harmonised" into each other.
    expect(formatYaml({ created: { __datetime: "2020-01-24 16:30:23" } })).toBe("created: 2020-01-24 16:30:23\n");
    expect(formatYaml({ created: { __datetime: "2020-01-24 16:30:23.000000" } })).toBe("created: 2020-01-24 16:30:23\n");
  });

  it("pads a short fraction on the RIGHT -- .05 is 50ms, not 50 microseconds", () => {
    // parsePyDatetime pads with padEnd because the fraction is a decimal
    // fraction of a second, not a microsecond count. Pad the wrong end and
    // "…23.05" becomes 2020-01-24 16:30:23.000050 -- a value that still
    // looks like a plausible timestamp in a diff and is wrong by 50ms.
    // The three-digit case is the one that actually occurs: JS
    // toISOString() writes milliseconds, so every row this port has written
    // since 2026-09 arrives here with exactly three digits.
    // Byte-identical to PyYAML for both (str(datetime(...,50000)) is
    // "2020-01-24 16:30:23.050000").
    expect(formatYaml({ a: { __datetime: "2020-01-24 16:30:23.05" }, b: { __datetime: "2020-01-24 16:30:23.853" } })).toBe(
      "a: 2020-01-24 16:30:23.050000\nb: 2020-01-24 16:30:23.853000\n",
    );
  });

  it("treats __float as winning over __datetime on the same object", () => {
    // toPlainJs tests isFloatValue FIRST, and both predicates are a bare
    // `"__x" in v` -- so a wrapper is recognised by the presence of its key,
    // not by being the object's only key. Two consequences worth pinning
    // because neither is visible at the call site: a malformed object
    // carrying both keys renders as the float, and any sibling data on a
    // wrapper object is silently discarded rather than merged. A future
    // "tidy-up" that reorders those two checks, or tightens them to an
    // exact-shape test, changes both outcomes.
    expect(formatYaml({ a: { __float: 1.5, __datetime: "2020-01-24 16:30:23" } as unknown as { __float: number } })).toBe(
      "a: 1.5\n",
    );
    expect(formatYaml({ a: { __datetime: "2020-01-24 16:30:23", note: "x" } as unknown as { __datetime: string } })).toBe(
      "a: 2020-01-24 16:30:23\n",
    );
  });

  it("drops a trailing Z or offset rather than converting the clock time", () => {
    // Django ran USE_TZ=False with TZ pinned to UTC, so every stored
    // datetime is naive UTC and an offset in the raw column is noise, not
    // information (pyDatetime.ts). Converting +05:00 would move the
    // timestamp five hours and quietly change published data.
    expect(formatYaml({ created: { __datetime: "2020-01-24 16:30:23.173268+05:00" } })).toBe(
      "created: 2020-01-24 16:30:23.173268\n",
    );
    expect(formatYaml({ created: { __datetime: " 2020-01-24 16:30:23.173268 " } })).toBe(
      "created: 2020-01-24 16:30:23.173268\n",
    );
  });

  it("unwraps a datetime wherever it is nested, not only at the root", () => {
    // /api/2/foodbank/<slug>/ carries `created` at the root and `found`
    // inside each item of a nested `needs` list; a top-level-only unwrap
    // would leave the nested ones as `__datetime: <raw>` mappings, which is
    // both the wrong shape and a leak of an internal wrapper name.
    expect(formatYaml([{ __datetime: "2020-01-24 16:30:23.173268" }])).toBe("- 2020-01-24 16:30:23.173268\n");
    expect(formatYaml({ needs: [{ found: { __datetime: "2020-01-24 16:30:23.173268" } }] })).toBe(
      "needs:\n  - found: 2020-01-24 16:30:23.173268\n",
    );
    // Array-inside-array as well: `v.map(toPlainJs)` is the one recursion
    // step with no test above it, and passing a function straight to map()
    // is the classic place an arity bug hides (map calls it with the index
    // as a second argument). Both wrappers must survive two levels of list.
    expect(formatYaml([[{ __datetime: "2020-01-24 16:30:23.173268" }], [{ __float: 1.5 }]])).toBe(
      "- - 2020-01-24 16:30:23.173268\n- - 1.5\n",
    );
  });

  it("DIVERGENCE/BUG: an unparseable datetime emits !!timestamp '<raw>', which no loader accepts", () => {
    // CURRENT BEHAVIOUR, pinned rather than fixed (reported instead).
    //
    // pyDatetime.ts deliberately returns an unparseable value unchanged --
    // "one odd row must not 500 a 1,000-row list". In JSON and XML that
    // degrades to a raw string and only that one field looks odd. Here the
    // raw string is still wrapped in PyTimestamp, js-yaml cannot print it
    // plainly (it does not resolve as a timestamp), so it prints the tag
    // explicitly -- and the resulting document is unloadable IN ITS
    // ENTIRETY, by js-yaml and by PyYAML alike (PyYAML 6 raises inside its
    // timestamp constructor). One bad row therefore breaks the whole
    // response for every consumer, which is the opposite of the graceful
    // degradation pyDatetime.ts was written for.
    const out = formatYaml({ created: { __datetime: "not a date" } });
    expect(out).toBe("created: !!timestamp 'not a date'\n");
    expect(() => load(out)).toThrow();
    expect(() => load(out, { schema: YAML11_SCHEMA })).toThrow();

    // Same for the empty string and for a date with no time part, which
    // parsePyDatetime's regex requires.
    expect(formatYaml({ created: { __datetime: "" } })).toBe("created: !!timestamp ''\n");
    expect(formatYaml({ created: { __datetime: "2020-01-24" } })).toBe("created: !!timestamp '2020-01-24'\n");

    // And -- the realistic trigger, rather than a hand-typed bad value --
    // a fraction of MORE than six digits, which RAW_RE's {1,6} rejects. Any
    // upstream that hands over nanoseconds (a Postgres timestamp column
    // dumped by a different tool, a JS engine with sub-ms precision) takes
    // down the whole document rather than that one field.
    expect(formatYaml({ created: { __datetime: "2020-01-24 16:30:23.1234567" } })).toBe(
      "created: !!timestamp '2020-01-24 16:30:23.1234567'\n",
    );
    expect(() => load(formatYaml({ created: { __datetime: "2020-01-24 16:30:23.1234567" } }))).toThrow();

    // The blast radius, stated as an assertion rather than left to the
    // prose above: it is not the bad field that becomes unreadable, it is
    // every good field beside it.
    const mixed = formatYaml({ created: { __datetime: "not a date" }, name: "Bradford Foodbank", slug: "bradford" });
    expect(mixed).toContain("name: Bradford Foodbank");
    expect(() => load(mixed)).toThrow();
  });

  it("BUG: a calendar-impossible datetime becomes a bare timestamp PyYAML cannot load", () => {
    // CURRENT BEHAVIOUR, pinned rather than fixed (reported instead).
    //
    // RAW_RE validates the SHAPE of a datetime -- digit counts and
    // separators -- and nothing else, so "2020-02-30 16:30:23" (a leap-year
    // or end-of-month arithmetic slip, or an ETL that wrote a text column
    // by hand) parses happily and is emitted as an UNQUOTED timestamp
    // scalar. That makes it strictly worse than the !!timestamp case above,
    // in two ways.
    //
    // First it is invisible: there is no explicit tag in the output and the
    // line looks like every other `created:` in the document, so nothing in
    // a body diff or a JS-side load() -- the check this file leans on
    // everywhere else -- looks wrong at all.
    //
    // Second, the two YAML implementations disagree about what to DO with
    // an impossible timestamp, and they disagree in the worst possible
    // direction. js-yaml's YAML 1.1 resolver checks the calendar and, when
    // it fails, quietly declines the scalar and leaves it a string. PyYAML's
    // matches on shape and then raises ValueError inside datetime
    // construction, taking down the whole document exactly as the
    // !!timestamp case above does. So the port's own library says the
    // document is fine and the Python clients gfapi2 was written for cannot
    // read it at all.
    const impossible = ["2020-02-30 16:30:23", "2020-01-24 25:30:23", "2020-13-45 25:99:99"];
    for (const raw of impossible) {
      // Emitted bare -- no quotes, no tag, indistinguishable from a good row.
      expect(formatYaml({ created: { __datetime: raw } })).toBe(`created: ${raw}\n`);
      // js-yaml hands it back as a string rather than erroring, which is
      // why this had to be checked against PyYAML instead of in JS alone.
      expect(load(formatYaml({ created: { __datetime: raw } }), { schema: YAML11_SCHEMA })).toEqual({ created: raw });
    }
    // PyYAML 6.0.2, for the three documents above, in order:
    //   ValueError: day is out of range for month
    //   ValueError: hour must be in 0..23
    //   ValueError: month must be in 1..12

    // The contrast that shows the degradation above is silent rather than
    // merely unusual: 2020 IS a leap year, so the neighbouring real date
    // resolves to an actual timestamp under the very same loader. A
    // consumer therefore cannot tell the two apart by type-checking the
    // field -- one is a datetime, the other is a string that looks exactly
    // like one, and only the calendar distinguishes them.
    expect(formatYaml({ created: { __datetime: "2020-02-29 16:30:23" } })).toBe("created: 2020-02-29 16:30:23\n");
    expect(load(formatYaml({ created: { __datetime: "2020-02-29 16:30:23" } }), { schema: YAML11_SCHEMA })).toEqual({
      created: new Date(Date.UTC(2020, 1, 29, 16, 30, 23)),
    });

    // The boundary RAW_RE does enforce, beside the one it does not, so the
    // line between "shape" and "validity" is on the record. A lower-case
    // 't' separator is rejected by RAW_RE's [ T] and so becomes the
    // unloadable tagged form -- even though PyYAML 6.0.2 reads
    // `2020-01-24t16:30:23` back as a perfectly good datetime. RAW_RE is
    // therefore both too strict (rejects what PyYAML accepts) and too loose
    // (accepts a date that does not exist).
    expect(formatYaml({ created: { __datetime: "2020-01-24t16:30:23" } })).toBe(
      "created: !!timestamp '2020-01-24t16:30:23'\n",
    );
  });

  it("DIVERGENCE: a date-shaped STRING loses the quotes PyYAML gives it", () => {
    // CURRENT BEHAVIOUR, pinned rather than fixed (reported instead).
    //
    // The custom tag is registered under YAML's own timestamp tag name, so
    // it REPLACES js-yaml's built-in timestamp resolver with a narrower one
    // (parsePyDatetime demands a padded date AND a time). Strings that a
    // YAML 1.1 reader still resolves as timestamps therefore stop being
    // quoted, and a string field arrives at the consumer as a date.
    // PyYAML quotes every one of these; js-yaml's own DUMP_SCHEMA does too.
    expect(formatYaml({ a: "2020-01-24" })).toBe("a: 2020-01-24\n"); // PyYAML: a: '2020-01-24'
    expect(formatYaml({ a: "2020-1-2 16:30:23" })).toBe("a: 2020-1-2 16:30:23\n"); // PyYAML quotes it
    expect(formatYaml({ a: "2001-12-14t21:59:43.10-05:00" })).toBe("a: 2001-12-14t21:59:43.10-05:00\n"); // PyYAML quotes it
    // Proof that it is a type change and not just cosmetics:
    expect(load(formatYaml({ a: "2020-01-24" }), { schema: YAML11_SCHEMA })).toEqual({ a: new Date("2020-01-24T00:00:00Z") });
  });
});

describe("formatYaml -- floats", () => {
  it("renders a fractional __float as a plain number", () => {
    // Byte-identical to PyYAML for these. The wrapper exists because a JS
    // number cannot say whether it is a float (types.ts); for YAML the
    // unwrap is the same one json.ts performs.
    expect(formatYaml({ latt: { __float: 51.507351 }, long: { __float: -0.1 } })).toBe("latt: 51.507351\nlong: -0.1\n");
  });

  it("DIVERGENCE: an integral __float loses its float-ness (1.0 -> 1)", () => {
    // CURRENT BEHAVIOUR, pinned rather than fixed (reported instead).
    // json.ts documents this as an accepted tradeoff for JSON, and yaml.ts
    // inherits it by unwrapping "the same way json.ts does". It bites
    // harder here: PyYAML writes `a: 1.0`, YAML has distinct int and float
    // types, so the value's TYPE changes on the wire -- the exact thing the
    // datetime handling above goes to great lengths to preserve.
    expect(formatYaml({ a: { __float: 1 } })).toBe("a: 1\n"); // PyYAML: a: 1.0
    expect(formatYaml({ a: { __float: 100 } })).toBe("a: 100\n"); // PyYAML: a: 100.0
    expect(formatYaml({ a: { __float: 0 } })).toBe("a: 0\n"); // PyYAML: a: 0.0
    // Negative zero does keep a float rendering, so the loss is specific to
    // integral magnitudes rather than to the wrapper as a whole. It is NOT
    // evidence that the wrapper reaches js-yaml, though -- a plain,
    // unwrapped -0 prints the same, because this is js-yaml's -0 rule and
    // not anything __float does. Asserted side by side so nobody reads the
    // line above as proof the unwrap works.
    expect(formatYaml({ a: { __float: -0 } })).toBe("a: -0.0\n"); // byte-identical to PyYAML
    expect(formatYaml({ a: -0 })).toBe("a: -0.0\n");
  });

  it("emits .nan and .inf for the non-finite values a distance calculation can produce", () => {
    // Byte-identical to PyYAML 6.0.2, which writes exactly the same three
    // tokens. These are reachable, not theoretical: the distance_m on a
    // /api/2/foodbanks/search/ result comes out of a haversine, and a
    // missing or malformed latt_long turns it into NaN long before anyone
    // notices. The failure this prevents is js-yaml (or a future hand-rolled
    // number formatter) writing the JS spellings `NaN`/`Infinity`, which no
    // YAML reader resolves as numbers -- the field would arrive at the
    // consumer as the STRING "NaN".
    expect(formatYaml({ a: { __float: NaN }, b: { __float: Infinity }, c: { __float: -Infinity } })).toBe(
      "a: .nan\nb: .inf\nc: -.inf\n",
    );
    // ...and they must still be numbers when read back, which is the part
    // the byte comparison alone does not prove.
    expect(load(formatYaml({ a: { __float: NaN }, b: { __float: Infinity }, c: { __float: -Infinity } }))).toEqual({
      a: NaN,
      b: Infinity,
      c: -Infinity,
    });
  });

  it("keeps very small and very large magnitudes loadable, whatever the spelling", () => {
    // js-yaml spells these `1.e-7` / `1.e+21` where PyYAML writes
    // `1.0e-07` / `1.0e+21`. Cosmetic only -- assert the round-trip value,
    // which is what structural parity actually promises.
    expect(formatYaml({ a: { __float: 1e-7 }, b: { __float: 1e21 } })).toBe("a: 1.e-7\nb: 1.e+21\n");
    expect(load(formatYaml({ a: { __float: 1e-7 }, b: { __float: 1e21 } }))).toEqual({ a: 1e-7, b: 1e21 });
  });
});

describe("formatYaml -- the string styles that made YAML the descope", () => {
  it("writes a multiline string as a |- block, and it loads back identically", () => {
    // The blocker in PLAN.md §7.4.4. PyYAML emits a single-quoted FOLDED
    // scalar -- literally "needs: 'Beans\n\n  Pasta\n\n  Rice'\n" -- which
    // no js-yaml setting reproduces, and reproducing it means porting
    // PyYAML's scalar-style analysis. The module's header says js-yaml
    // gives a `|-` block "by default -- checked directly, not assumed", so
    // check it, and check the promise that replaced byte parity: the two
    // spellings load to the SAME string.
    const out = formatYaml({ needs: "Beans\nPasta\nRice" });
    expect(out).toBe("needs: |-\n  Beans\n  Pasta\n  Rice\n");
    expect(load(out)).toEqual({ needs: "Beans\nPasta\nRice" });
  });

  it("preserves a trailing newline and a blank line inside the block", () => {
    // The chomping indicator carries this: `|-` strips the final newline,
    // bare `|` keeps it. Get it wrong and free-text fields silently gain or
    // lose their last line break on every request.
    expect(load(formatYaml({ needs: "Beans\nPasta\n" }))).toEqual({ needs: "Beans\nPasta\n" });
    expect(formatYaml({ needs: "Beans\nPasta\n" })).toBe("needs: |\n  Beans\n  Pasta\n");
    expect(load(formatYaml({ needs: "Beans\n\nPasta" }))).toEqual({ needs: "Beans\n\nPasta" });
  });

  it("double-quotes and escapes a value containing \\r\\n -- every food bank address", () => {
    // fullAddressUnconditional() joins address and postcode with \r\n, so
    // EVERY record on the list endpoints hits this path. Byte-identical to
    // PyYAML, which also refuses to put a carriage return in a plain or
    // literal scalar. Losing the escaping here would corrupt the address of
    // every food bank in one release.
    expect(formatYaml({ address: "1 High Street\r\nSW1A 1AA" })).toBe('address: "1 High Street\\r\\nSW1A 1AA"\n');
    expect(load(formatYaml({ address: "1 High Street\r\nSW1A 1AA" }))).toEqual({ address: "1 High Street\r\nSW1A 1AA" });
  });

  it("escapes tabs and NULs rather than emitting raw control characters", () => {
    // Need text is scraped from food bank web pages, so a stray tab or a
    // NUL from a mis-decoded byte does reach here. Byte-identical to PyYAML
    // for both: a raw tab in a plain scalar would be re-read as indentation
    // and a raw NUL makes the document invalid outright, so both
    // implementations switch to a double-quoted scalar and escape.
    const out = formatYaml({ a: "x\ty", b: "x\u0000y" });
    expect(out).toBe('a: "x\\ty"\nb: "x\\0y"\n');
    expect(load(out)).toEqual({ a: "x\ty", b: "x\u0000y" });
  });

  it("escapes a lone surrogate instead of throwing, and keeps it recoverable", () => {
    // A truncated UTF-16 string -- the shape a JS `.slice()` on an emoji
    // produces, and the shape badly-decoded scraped text arrives in -- is
    // not valid Unicode, so a formatter is entitled to throw on it. This one
    // does not: byte-identical to PyYAML, which also writes "x\uD800y".
    // Pinned because "the whole endpoint 500s on one bad character" is the
    // failure this file exists to catch, and because a naive escape would
    // silently replace it with U+FFFD instead.
    const out = formatYaml({ a: "x\ud800y" });
    expect(out).toBe('a: "x\\uD800y"\n');
    expect((load(out) as { a: string }).a).toBe("x\ud800y");
  });

  it("DIVERGENCE: keeps a |- block where a line has a trailing space, and loses nothing", () => {
    // CURRENT BEHAVIOUR, pinned. PyYAML refuses a literal block when any
    // line ends in a space -- it writes "needs: \"Beans \\nPasta\"" -- on the
    // grounds that trailing whitespace inside a block is easy for a human
    // to destroy. js-yaml keeps the block. This is the one divergence in
    // this file with a plausible route to DATA LOSS rather than cosmetics,
    // so it gets the strongest assertion available: the emitted document
    // was fed to PyYAML 6.0.2 as well as to js-yaml, and both read the
    // trailing space back. Trailing spaces are ordinary in scraped need
    // lists ("Beans \nPasta"), so silently trimming one would be invisible.
    const needs = "Beans \nPasta";
    expect(formatYaml({ needs })).toBe("needs: |-\n  Beans \n  Pasta\n"); // PyYAML: needs: "Beans \nPasta"
    expect(load(formatYaml({ needs }))).toEqual({ needs }); // PyYAML reads the same value back
  });

  it("quotes a string whose leading or trailing spaces are load-bearing", () => {
    // Plain scalars are stripped on both sides when read, so " x " has to be
    // quoted or it comes back as "x". Address and need fields routinely
    // arrive with padding from the source page, and a value that changes
    // length between write and read breaks any consumer diffing yesterday's
    // response against today's.
    //
    // " x " is byte-identical to PyYAML. An ALL-whitespace string is a
    // small DIVERGENCE in quote style only -- js-yaml double-quotes it
    // where PyYAML writes '  ' -- so assert the loaded value there, which
    // PyYAML 6.0.2 also reads back as two spaces.
    expect(formatYaml({ a: " x ", b: "  " })).toBe('a: \' x \'\nb: "  "\n'); // PyYAML: b: '  '
    expect(load(formatYaml({ a: " x ", b: "  " }))).toEqual({ a: " x ", b: "  " });
  });

  it("DIVERGENCE: folds a long plain scalar as >- where PyYAML folds it in place", () => {
    // Both implementations wrap near 80 columns (PLAN.md §7.4.4's "line
    // width" row); they choose different styles for it. PyYAML continues
    // the plain scalar on an indented line, js-yaml switches to a folded
    // block. Same loaded string either way, which is the test that matters.
    const address = "The Old Fire Station, 140 Something Long Road, Somewhereville, Greater Manchester, M1 2AB";
    const out = formatYaml({ address });
    expect(out).toBe(
      "address: >-\n  The Old Fire Station, 140 Something Long Road, Somewhereville, Greater\n  Manchester, M1 2AB\n",
    );
    expect(load(out)).toEqual({ address });
  });

  it("leaves a long URL on one line, because there is nowhere to fold it", () => {
    // PLAN.md §7.4.4: "long addresses fold, long URLs (no spaces) cannot".
    // Every record carries several urls.* values, so a folding change that
    // broke them mid-path would break far more than it looked like.
    const url = "https://www.givefood.org.uk/needs/at/some-really-long-food-bank-name/1234567890/abcdefg";
    expect(formatYaml({ url })).toBe(`url: ${url}\n`);
    expect(load(formatYaml({ url }))).toEqual({ url });
  });
});

describe("formatYaml -- documents and containers", () => {
  it("renders a top-level array, which is what every list endpoint passes", () => {
    // apiResponse() hands `response_list` (a bare array) straight through
    // for /api/2/foodbanks/ and friends, exactly as the Python does.
    // Byte-identical to PyYAML, key sorting included.
    expect(formatYaml([{ b: 1, a: 2 }, "x"])).toBe("- a: 2\n  b: 1\n- x\n");
  });

  it("renders an empty result set as [] rather than an empty body", () => {
    // A search with no hits is an ordinary 200. Byte-identical to PyYAML,
    // and an empty string body would break clients that parse before
    // checking length.
    expect(formatYaml([])).toBe("[]\n");
    expect(formatYaml({})).toBe("{}\n");
    expect(formatYaml({ needs: [], meta: {} })).toBe("meta: {}\nneeds: []\n");
  });

  it("DIVERGENCE: indents nested sequences two columns deeper than PyYAML", () => {
    // PyYAML puts the dash at the parent key's indentation
    // ("locations:\n  - a: 1" becomes "locations:\n- a: 1" there). Pure
    // whitespace: the loaded document is identical, and a YAML consumer
    // cannot tell. Pinned so the difference is on the record rather than
    // discovered during a diff against production.
    const data = { foodbank: { name: "X", locations: [{ b: 2, a: 1 }] } };
    expect(formatYaml(data)).toBe("foodbank:\n  locations:\n    - a: 1\n      b: 2\n  name: X\n");
    expect(load(formatYaml(data))).toEqual({ foodbank: { name: "X", locations: [{ a: 1, b: 2 }] } });
  });

  it("DIVERGENCE: expands a repeated object instead of emitting an anchor", () => {
    // Given the same object twice, PyYAML writes "x: &id001\n  a: 1\ny:
    // *id001". toPlainJs rebuilds every object as a fresh copy, so the
    // aliasing is lost -- and, for a consumer whose YAML library does not
    // resolve aliases, gained. Assert no anchor syntax reaches the wire.
    const shared = { a: 1 };
    const out = formatYaml({ x: shared, y: shared });
    expect(out).toBe("x:\n  a: 1\n'y':\n  a: 1\n");
    expect(out).not.toContain("&");
    expect(out).not.toContain("*");

    // The assertions above are only meaningful if js-yaml WOULD have
    // aliased -- otherwise they pass against an implementation that does no
    // copying at all, and the day someone replaces toPlainJs's rebuild with
    // an in-place mutation the test would stay green while `y: *ref_0`
    // started appearing in production bodies. So prove it: the same input,
    // the same options, straight to dump().
    expect(dump({ x: shared, y: shared }, { sortKeys: true })).toContain("&");
    expect(dump({ x: shared, y: shared }, { sortKeys: true })).toContain("*");

    // Arrays alias too, and are the likelier shape here: `urls` and `needs`
    // are built once and can easily be referenced from two places in a
    // response.
    const sharedList = [1, 2];
    expect(dump({ x: sharedList, y: sharedList }, { sortKeys: true })).toContain("&");
    expect(formatYaml({ x: sharedList, y: sharedList })).toBe("x:\n  - 1\n  - 2\n'y':\n  - 1\n  - 2\n");
  });

  it("throws a RangeError on a self-referencing object instead of aliasing it", () => {
    // CURRENT BEHAVIOUR, pinned rather than fixed (reported instead).
    // js-yaml handles a cycle natively -- that is what anchors are for --
    // but toPlainJs recurses eagerly and blows the stack before dump() ever
    // sees the value. SerialisableValue is a tree, so no route can build
    // this today; it is pinned because the previous test makes de-aliasing
    // look like a free win, and this is its price.
    const cyclic: Record<string, unknown> = { name: "X" };
    cyclic.self = cyclic;
    expect(() => formatYaml(cyclic as { [key: string]: never })).toThrow(RangeError);
  });

  it("ends with exactly one newline and no document markers", () => {
    // The result is handed straight to `new Response()` by apiResponse();
    // a stray "---"/"..." or a missing trailing newline would be visible in
    // every response body diff against production.
    //
    // Pin the exact bytes FIRST. On their own the four shape assertions
    // below are nearly vacuous -- a document that had lost its indentation,
    // its nesting or its list entirely would still end in exactly one
    // newline, still not start with "---" and still contain no "..." -- so
    // they only become a regression net once the string they describe is
    // nailed down. (Not byte-identical to PyYAML here, and deliberately so:
    // the two-column list indent is the divergence pinned above, which is
    // exactly why this test cannot be left as shape assertions alone.)
    const out = formatYaml({ a: 1, b: [1, 2] });
    expect(out).toBe("a: 1\nb:\n  - 1\n  - 2\n"); // PyYAML: "a: 1\nb:\n- 1\n- 2\n"
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    expect(out.startsWith("---")).toBe(false);
    expect(out).not.toContain("...");
  });

  it("drops an undefined value rather than writing null", () => {
    // undefined is outside SerialisableValue, but it is one `?.` away in
    // any route that builds a response object, and the failure is silent:
    // the key vanishes from the document instead of arriving as null. Same
    // outcome as JSON.stringify, so at least the formats agree.
    expect(formatYaml({ a: undefined as unknown as null, b: 1 })).toBe("b: 1\n");

    // A nested mapping whose every value went undefined collapses to an
    // empty flow mapping rather than disappearing -- so `urls: {}` is what a
    // route with a broken URL builder ships, which at least looks wrong.
    expect(formatYaml({ urls: { self: undefined as unknown as null } })).toBe("urls: {}\n");
  });

  it("writes undefined INSIDE a list as null, unlike undefined in a mapping", () => {
    // The asymmetry matters more than either half: a list cannot drop an
    // element without renumbering everything after it, so js-yaml writes
    // null there while silently dropping the mapping key above. A `needs`
    // array built with a `.map()` that forgets a return therefore arrives
    // full of nulls and the RIGHT LENGTH, which is exactly the kind of
    // thing a consumer counts rather than inspects. Byte-identical to what
    // PyYAML emits for the Python equivalent, [1, None, 2].
    expect(formatYaml({ needs: [1, undefined as unknown as null, 2] })).toBe("needs:\n  - 1\n  - null\n  - 2\n");
    expect(load(formatYaml({ needs: [1, undefined as unknown as null, 2] }))).toEqual({ needs: [1, null, 2] });
  });
});

describe("formatYaml -- malformed input", () => {
  it("throws on a null __datetime instead of degrading to an empty field", () => {
    // CURRENT BEHAVIOUR, pinned rather than fixed. Every nullable datetime
    // column in D1 can produce { __datetime: null } if a route forgets the
    // guard, and parsePyDatetime calls raw.trim() unconditionally -- so the
    // request 500s. Shared with json.ts and xml.ts rather than specific to
    // YAML, but this is where it surfaces for /api/2/*?format=yaml.
    expect(() => formatYaml({ created: { __datetime: null } as unknown as { __datetime: string } })).toThrow(TypeError);

    // undefined is the likelier of the two in practice -- `{ __datetime:
    // row.created }` on a column the SELECT did not ask for -- and takes
    // the same path, as does anything non-string (a Date, an epoch number)
    // that a caller might reasonably think the wrapper accepts. Pinned as
    // three cases rather than one because a guard added for `null` alone
    // would leave the other two live.
    expect(() => formatYaml({ created: { __datetime: undefined } as unknown as { __datetime: string } })).toThrow(TypeError);
    expect(() => formatYaml({ created: { __datetime: 1579883423173 } as unknown as { __datetime: string } })).toThrow(
      TypeError,
    );
    expect(() => formatYaml({ created: { __datetime: new Date(0) } as unknown as { __datetime: string } })).toThrow(
      TypeError,
    );
  });

  it("passes a malformed __float straight through instead of throwing, unlike __datetime", () => {
    // The asymmetry with the test above is the whole point, and it is not
    // stated anywhere in the source: the two wrappers are unwrapped by
    // adjacent lines of toPlainJs, but __datetime goes through
    // parsePyDatetime (which calls .trim() and so throws on anything
    // non-string) while __float is returned RAW. So the identical route bug
    // -- `{ __x: row.col }` on a column the SELECT did not fetch, or a
    // nullable column -- 500s the request for a datetime and ships silently
    // wrong data for a float.
    //
    // A nullable float column is the realistic one: latt and long are NULL
    // for food banks that have never been geocoded.
    expect(formatYaml({ latt: { __float: null } as unknown as { __float: number } })).toBe("latt: null\n");

    // undefined is worse than null -- the key does not become null, it
    // DISAPPEARS, so a consumer doing `row["latt"]` gets a KeyError rather
    // than a None it could have handled. A record whose every field went
    // this way collapses to an empty mapping rather than erroring.
    expect(formatYaml({ latt: { __float: undefined } as unknown as { __float: number } })).toBe("{}\n");
    expect(formatYaml({ foodbank: { latt: { __float: undefined } } as unknown as { __float: number } })).toBe(
      "foodbank: {}\n",
    );

    // And the silent type change: D1 stores latt_long as TEXT, so
    // `{ __float: row.latt }` can perfectly well hand over a STRING. The
    // wrapper does no coercion, so it is emitted quoted -- a float field
    // arriving at every consumer as a string, with nothing in the output to
    // suggest anything went wrong.
    expect(formatYaml({ latt: { __float: "51.5" } as unknown as { __float: number } })).toBe("latt: '51.5'\n");

    // The sharpest version of that, because it looks like it works: the
    // STRING "NaN" is emitted bare, not as the `.nan` the real NaN produces
    // two tests up. Byte-identical to PyYAML for the string, and it loads as
    // the string in both -- which is exactly the "arrives at the consumer as
    // the STRING 'NaN'" failure the .nan test says it prevents, reached by
    // the other door.
    expect(formatYaml({ a: { __float: "NaN" } as unknown as { __float: number } })).toBe("a: NaN\n");
    expect(load(formatYaml({ a: { __float: "NaN" } as unknown as { __float: number } }))).toEqual({ a: "NaN" });
    expect(formatYaml({ a: { __float: NaN } })).toBe("a: .nan\n");
  });

  it("turns a value that is an object but not a wrapper into an empty mapping", () => {
    // The failure this catches is forgetting the wrapper, which is the most
    // likely mistake in the whole serialiser: `{ created: row.created }`
    // rather than `{ created: { __datetime: row.created } }`. toPlainJs
    // recognises a wrapper only by its `__float`/`__datetime` key, and
    // anything else that is an object gets the generic branch --
    // Object.keys() of a Date is EMPTY, so the field silently becomes `{}`.
    //
    // Silently is the operative word: no throw, no tag, no odd-looking
    // string, valid YAML, HTTP 200, and every timestamp on the endpoint
    // replaced by an empty mapping. Compare the __datetime tests above,
    // which at least fail loudly.
    expect(formatYaml({ created: new Date(0) as unknown as null })).toBe("created: {}\n");
    expect(formatYaml({ urls: { self: new Date(0) as unknown as null } })).toBe("urls:\n  self: {}\n");
    expect(load(formatYaml({ created: new Date(0) as unknown as null }))).toEqual({ created: {} });

    // Same for the other host objects a route could plausibly hand over --
    // a Map built to collect urls, a Set of item names -- because none of
    // them has own enumerable keys either.
    expect(formatYaml({ a: new Map([["k", 1]]) as unknown as null, b: new Set([1]) as unknown as null })).toBe(
      "a: {}\nb: {}\n",
    );

    // The contrast that makes the point: a value js-yaml genuinely cannot
    // represent DOES throw, so this is a gap in toPlainJs's wrapper
    // detection rather than a blanket "everything degrades quietly" policy.
    expect(() => formatYaml({ a: 1n as unknown as null })).toThrow(/unacceptable kind of an object/);
    expect(() => formatYaml({ a: (() => 1) as unknown as null })).toThrow(/unacceptable kind of an object/);
  });

  it("throws on a mapping with an own __proto__ key rather than emitting it", () => {
    // toPlainJs copies keys with `out[k] = ...`, so a literal "__proto__"
    // key sets the copy's prototype instead of becoming a member and
    // js-yaml then refuses the object. No D1 column is named __proto__
    // today; pinned because the same shape is what the sibling xml.ts
    // prototype bug looks like, and because the failure mode is a 500 on a
    // public endpoint rather than a wrong value.
    const data = JSON.parse('{"__proto__": {"a": 1}, "b": 2}') as { [key: string]: null };

    // A bare toThrow() would also pass if formatYaml threw for some
    // completely unrelated reason, so name the failure: js-yaml rejecting a
    // value whose prototype is no longer Object.prototype, which is the
    // specific consequence of the `out[k] = ...` copy. If the copy is ever
    // changed to Object.create(null) or a Map, this stops being a throw and
    // the test should be revisited rather than quietly still passing.
    expect(() => formatYaml(data)).toThrow(/unacceptable kind of an object/);
    try {
      formatYaml(data);
    } catch (e) {
      expect((e as Error).name).toBe("YAMLException");
    }

    // The bound that actually matters for a public endpoint: the assignment
    // moves ONE object's prototype, it does not pollute Object.prototype,
    // so the blast radius is a 500 on this request rather than every later
    // request on the isolate seeing a stray `a`.
    expect(Object.prototype).not.toHaveProperty("a");
    expect(({} as Record<string, unknown>).a).toBeUndefined();

    // The sibling shape, and the one more likely to reach here: a
    // "__proto__" key nested inside a record rather than at the root.
    const nested = JSON.parse('{"urls": {"__proto__": {"a": 1}, "self": "x"}}') as { [key: string]: null };
    expect(() => formatYaml(nested)).toThrow(/unacceptable kind of an object/);
  });
});

describe("formatYaml -- a whole food bank record", () => {
  const record = [
    {
      name: "Bradford Foodbank",
      alt_name: null,
      slug: "bradford",
      address: "1 High Street\r\nBD1 1AA",
      closed: false,
      created: { __datetime: "2020-01-24 16:30:23.173268" },
      latt_long: "53.79,-1.75",
      distance_m: { __float: 1234.5 },
      urls: { self: "https://www.givefood.org.uk/api/2/foodbank/bradford/", homepage: "https://example.org" },
    },
  ];

  it("renders the /api/2/foodbanks/ item shape end to end", () => {
    // One assertion that exercises the pieces together in the arrangement
    // they actually arrive in: a top-level list, sorted keys at both
    // levels, a null alt_name, a false boolean, an escaped \r\n address, a
    // nested urls mapping, an unwrapped float and an unquoted timestamp.
    // If any single behaviour above regresses, this is the test that shows
    // what the endpoint's body would look like afterwards.
    expect(formatYaml(record)).toBe(
      '- address: "1 High Street\\r\\nBD1 1AA"\n' +
        "  alt_name: null\n" +
        "  closed: false\n" +
        "  created: 2020-01-24 16:30:23.173268\n" +
        "  distance_m: 1234.5\n" +
        "  latt_long: 53.79,-1.75\n" +
        "  name: Bradford Foodbank\n" +
        "  slug: bradford\n" +
        "  urls:\n" +
        "    homepage: https://example.org\n" +
        "    self: https://www.givefood.org.uk/api/2/foodbank/bradford/\n",
    );
  });

  it("reaches a YAML 1.1 consumer with every value's TYPE intact", () => {
    // The byte assertion above is the whole of what the record test used to
    // check, and bytes are precisely NOT what this file promises: the
    // maintainer's 2026-08-30 decision gave up byte parity for STRUCTURAL
    // parity, so the flagship test has to state the structure a consumer
    // actually receives. Read it back with a YAML 1.1 loader, which is what
    // a PyYAML client is, and check the types rather than the spelling.
    //
    // Every one of these is a type a plausible refactor could flatten
    // without changing a single byte of the prose above: `created` a string
    // instead of a timestamp (drop PyTimestamp), `distance_m` a string
    // (format the float by hand), `alt_name` the string "null", `closed`
    // the string "false", `latt_long` a LIST (its comma would split it in
    // flow context, so this also pins that nothing switched to flow style).
    const parsed = load(formatYaml(record), { schema: YAML11_SCHEMA }) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      address: "1 High Street\r\nBD1 1AA",
      alt_name: null,
      closed: false,
      created: new Date(Date.UTC(2020, 0, 24, 16, 30, 23, 173)),
      distance_m: 1234.5,
      latt_long: "53.79,-1.75",
      name: "Bradford Foodbank",
      slug: "bradford",
      urls: { homepage: "https://example.org", self: "https://www.givefood.org.uk/api/2/foodbank/bradford/" },
    });

    // toEqual on a Date compares the instant, so it would still pass if
    // BOTH sides were shifted by the same amount -- and the one thing this
    // module must never do to a datetime is move it (Django ran USE_TZ=False
    // and PyYAML reads a naive timestamp as naive local-clock fields, no
    // conversion). Assert the clock fields the consumer sees, which is
    // TZ-independent rather than merely TZ-pinned by vitest.config.mts.
    const created = parsed[0]!.created as Date;
    expect([created.getUTCFullYear(), created.getUTCMonth() + 1, created.getUTCDate()]).toEqual([2020, 1, 24]);
    expect([created.getUTCHours(), created.getUTCMinutes(), created.getUTCSeconds()]).toEqual([16, 30, 23]);
    // The microseconds a JS Date cannot hold are truncated, not rounded --
    // .173268 must not come back as .174.
    expect(created.getUTCMilliseconds()).toBe(173);
  });
});
