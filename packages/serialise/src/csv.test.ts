import { describe, expect, it } from "vitest";
import { formatCsvRow } from "./csv";

// This module is one of the two that must stay BYTE-exact with the Python it
// replaces -- `/api/1/foodbanks/?format=csv` is a live, deprecated-but-still-
// consumed endpoint (gfapi1/views.py:60-63) and the dump exports
// (gfdumps/management/commands/dump.py:434) are downloaded and diffed by
// third parties. A CSV that merely "parses the same" is not good enough: a
// changed quoting rule or a bare \n silently changes every byte of a file
// someone else's pipeline is checksumming.
//
// Every expected string below was produced by running the real thing --
// Python's `csv.writer` in both dialects -- and pasted in, not reasoned out
// from the spec. Where this port deliberately or accidentally diverges from
// that output, the test says so in a comment rather than asserting the
// Python value and failing.
//
// The two dialects, both real production contracts:
//   quoteAll=false  csv.writer(response)                     gfapi1/views.py
//   quoteAll=true   csv.writer(f, quoting=csv.QUOTE_ALL)     dump.py

describe("formatCsvRow -- QUOTE_MINIMAL (the gfapi1 dialect)", () => {
  it("writes the live /api/1/foodbanks/?format=csv header unquoted", () => {
    // The 19 columns of gfapi1/views.py's writer.writerow([...]), in order.
    // Plain identifiers, so QUOTE_MINIMAL leaves every one of them bare --
    // if a future change started quoting defensively, the first line of a
    // file consumers have been fetching for years would change shape.
    const header = [
      "name",
      "slug",
      "url",
      "shopping_list_url",
      "phone",
      "email",
      "address",
      "postcode",
      "parliamentary_constituency",
      "mp",
      "mp_party",
      "ward",
      "district",
      "country",
      "charity_number",
      "charity_register_url",
      "closed",
      "latt_long",
      "network",
    ];
    expect(formatCsvRow(header)).toBe(
      "name,slug,url,shopping_list_url,phone,email,address,postcode," +
        "parliamentary_constituency,mp,mp_party,ward,district,country," +
        "charity_number,charity_register_url,closed,latt_long,network\r\n",
    );
  });

  it("writes a whole 19-column foodbank record byte-exact", () => {
    // The tests below take the quoting rules apart one character class at a
    // time, which is how you localise a failure -- but none of them proves
    // the rules COMPOSE. This is one record in the exact column order
    // api1.ts:137-157 emits, exercising four rules at once: a name with a
    // comma, a multi-line address, two NULL charity columns, a False boolean
    // and a comma-joined latt_long. A writer that leaked quoting state
    // between fields, or lost a field in the join, passes every
    // single-field test in this file and fails here.
    const row = [
      "Trussell Trust, Salisbury",
      "salisbury",
      "https://www.givefood.org.uk/needs/at/salisbury/",
      "", // shopping_list_url -- routinely blank in the real data
      "01722 341444",
      "info@salisburyfoodbank.org.uk",
      "Unit 1\nSouthampton Road\nSalisbury",
      "SP2 7TU",
      "Salisbury",
      "John Glen",
      "Conservative",
      "St Martin & Cathedral",
      "Wiltshire",
      "England",
      null, // charity_number
      null, // charity_register_url
      false, // closed -- FoodbankRow.is_closed is a real JS boolean
      "51.0688,-1.7945",
      "Trussell",
    ];
    expect(formatCsvRow(row)).toBe(
      '"Trussell Trust, Salisbury",salisbury,' +
        "https://www.givefood.org.uk/needs/at/salisbury/,,01722 341444," +
        'info@salisburyfoodbank.org.uk,"Unit 1\nSouthampton Road\nSalisbury",' +
        "SP2 7TU,Salisbury,John Glen,Conservative,St Martin & Cathedral," +
        'Wiltshire,England,,,False,"51.0688,-1.7945",Trussell\r\n',
    );
    // Column count is the contract consumers actually depend on, and it is
    // the one thing the literal above would not obviously betray if a field
    // went missing. Blank out every quoted field and every comma that
    // remains is a real delimiter: 19 columns must give exactly 18 of them,
    // however many commas the quoted name and latt_long contain.
    const line = formatCsvRow(row).slice(0, -2);
    const delimiters = line.replace(/"(?:[^"]|"")*"/g, "F").match(/,/g);
    expect(delimiters).toHaveLength(row.length - 1);
  });

  it("terminates rows with CRLF, never a bare LF", () => {
    // Python's csv dialect defaults to lineterminator="\r\n" and gfapi1
    // does not override it. Callers build the whole body by concatenating
    // these strings (api1.ts:135-158, admin/lists.ts:49-50), so the
    // terminator lives here and nowhere else -- dropping the \r would
    // rewrite every byte-offset in the file.
    const body = formatCsvRow(["a", "b"]) + formatCsvRow(["c", "d"]);
    expect(body).toBe("a,b\r\nc,d\r\n");
    expect(body.match(/\n/g)).toHaveLength(2);
    expect(body.match(/(?<!\r)\n/g)).toBeNull();
  });

  it("quotes a field containing the delimiter, and only wraps that field", () => {
    // Verified: csv.writer(QUOTE_MINIMAL).writerow(["SP2 7TU", "51.0,-1.8"])
    // -> 'SP2 7TU,"51.0,-1.8"\r\n'. `latt_long` is a comma-joined pair, so
    // this is the everyday case for the foodbanks export, not an edge case.
    expect(formatCsvRow(["SP2 7TU", "51.0,-1.8"])).toBe('SP2 7TU,"51.0,-1.8"\r\n');
    expect(formatCsvRow(["Trussell Trust, Salisbury", "trussell"])).toBe(
      '"Trussell Trust, Salisbury",trussell\r\n',
    );
  });

  it("doubles an embedded quote instead of backslash-escaping it", () => {
    // Verified against Python: ['He said "hi"'] -> '"He said ""hi"""\r\n',
    // and a lone quote character -> '""""\r\n'. A backslash escape would
    // still look plausible in a diff but is not valid RFC4180 CSV and would
    // corrupt any field a food bank name manages to put a quote into.
    expect(formatCsvRow(['He said "hi"'])).toBe('"He said ""hi"""\r\n');
    expect(formatCsvRow(['"'])).toBe('""""\r\n');
    // A field that ALREADY looks like a quoted CSV field is not passed
    // through -- it is escaped like any other text. Pinned because a
    // "don't double-quote what's already quoted" shortcut is an easy and
    // plausible-looking optimisation, and it silently eats the real quotes.
    expect(formatCsvRow(['"already quoted"'])).toBe('"""already quoted"""\r\n');
    // Every quote is doubled, not just the first: a non-global regex in the
    // replace would still pass the two-quote case above by luck.
    expect(formatCsvRow(['a"b"c"d'])).toBe('"a""b""c""d"\r\n');
  });

  it("quotes CR and LF, including a CRLF pair inside a field", () => {
    // Python quotes any character present in the dialect's lineterminator,
    // which is "\r\n" -- so a bare \r counts too, not just \n. Addresses in
    // the real data are multi-line, so an unquoted \n here would split one
    // food bank across two CSV records.
    expect(formatCsvRow(["a\nb"])).toBe('"a\nb"\r\n');
    expect(formatCsvRow(["a\rb"])).toBe('"a\rb"\r\n');
    expect(formatCsvRow(["x", "a\r\nb"])).toBe('x,"a\r\nb"\r\n');
    // The newline is NOT rewritten to the row terminator on the way through:
    // an embedded bare \n stays a bare \n inside the quotes, so the only
    // \r\n in the result is the one at the end.
    expect(formatCsvRow(["a\nb"]).match(/\r\n/g)).toHaveLength(1);
  });

  it("decides quoting per field, carrying no scan state from one field to the next", () => {
    // Verified against Python:
    //   writerow(["Trussell Trust, Salisbury", "51.0688,-1.7945"])
    //     -> '"Trussell Trust, Salisbury","51.0688,-1.7945"\r\n'
    //   writerow(["a,b", ",x"]) -> '"a,b",",x"\r\n'
    //
    // Every other test in this file happens to place at most one
    // needs-quoting field among fields that need none -- which is exactly
    // the shape a STATEFUL quoting check survives. Hoisting the character
    // test to a module-level `/[,"\r\n]/g`, the obvious way to stop
    // rebuilding a regex per field in a loop over thousands of rows, makes
    // RegExp#test resume from the previous field's lastIndex: the second
    // consecutive comma-bearing field is scanned from an offset past its own
    // comma, reports clean, and is written bare. The damage is not a mangled
    // field but an EXTRA COLUMN, which a consumer reads as a shifted row
    // rather than as an error. The name/latt_long pair below is the everyday
    // adjacency in the real foodbanks export, so this would be live on day
    // one.
    expect(formatCsvRow(["Trussell Trust, Salisbury", "51.0688,-1.7945"])).toBe(
      '"Trussell Trust, Salisbury","51.0688,-1.7945"\r\n',
    );
    expect(formatCsvRow(["a,b", ",x"])).toBe('"a,b",",x"\r\n');
    // Two fields in, exactly one real delimiter out -- the column count is
    // the contract, whatever the fields contain.
    const line = formatCsvRow(["Trussell Trust, Salisbury", "51.0688,-1.7945"]).slice(0, -2);
    expect(line.replace(/"(?:[^"]|"")*"/g, "F").match(/,/g)).toHaveLength(1);
    // A run of identical needs-quoting fields: a resuming scan fails on
    // alternate fields, so a two-field case alone could still pass by luck.
    expect(formatCsvRow([",", ",", ",", ","])).toBe('",",",",",",","\r\n');
    expect(formatCsvRow(['"', '"', '"'])).toBe('"""","""",""""\r\n');
    // The same invariant stated positively: a field renders identically
    // alone and after some other field that was itself quoted.
    const alone = formatCsvRow(["a\r\nb"]);
    expect(formatCsvRow(["x,y", "a\r\nb"])).toBe('"x,y",' + alone);
  });

  it("quotes NOTHING else -- not tabs, semicolons, apostrophes or padding", () => {
    // The exact quoting set in CPython's _csv.c is: the delimiter, the
    // quotechar, the escapechar, and the characters of the lineterminator.
    // Nothing about whitespace or "looks dangerous in a spreadsheet".
    // Verified: ["tab\tsep","semi;colon","pipe|bar","apos'trophe","  spaced  "]
    // -> "tab\tsep,semi;colon,pipe|bar,apos'trophe,  spaced  \r\n".
    expect(formatCsvRow(["tab\tsep", "semi;colon", "pipe|bar", "apos'trophe", "  spaced  "])).toBe(
      "tab\tsep,semi;colon,pipe|bar,apos'trophe,  spaced  \r\n",
    );
    // The characters most likely to be swept up by a "be safe, quote it"
    // regex if someone hardens this later, and the ones a naive line-splitter
    // might mistake for a terminator: NUL, vertical tab, form feed, and the
    // Unicode line separators U+2028/U+2029. Python's csv quotes none of
    // them -- only \r and \n, the characters of the lineterminator -- so
    // quoting any of them here would change bytes for no benefit.
    expect(formatCsvRow(["a\0b", "c\vd", "e\fd", "f\u2028g", "h\u2029i"])).toBe(
      "a\0b,c\vd,e\fd,f\u2028g,h\u2029i\r\n",
    );
    // Non-ASCII is a pass-through too -- unicodecsv's whole purpose was to
    // carry these through unmangled, and food bank names contain them.
    expect(formatCsvRow(["Café Kraków — naïve"])).toBe("Café Kraków — naïve\r\n");
    // A backslash is ordinary content: the excel dialect sets escapechar=None,
    // so Python neither quotes for it nor gives it any meaning. Verified:
    // ["a\\b","c\\d"] -> 'a\\b,c\\d\r\n'. Worth pinning separately from the
    // doubling test above, because the two halves of "RFC4180, not C escapes"
    // can break independently -- a port can double quotes correctly and still
    // treat a backslash as significant.
    expect(formatCsvRow(["a\\b", "c\\d"])).toBe("a\\b,c\\d\r\n");
    // And the composition: a backslash sitting immediately before a quote.
    // Verified: ['a\\"b'] -> '"a\\""b"\r\n' -- the quote is doubled and the
    // backslash stays exactly where it was, neither consumed as an escape
    // nor doubled itself.
    expect(formatCsvRow(['a\\"b'])).toBe('"a\\""b"\r\n');
    expect(formatCsvRow(["a\\b"], true)).toBe('"a\\b"\r\n');
  });

  it("does not Unicode-normalise, so NFD text stays NFD", () => {
    // Two spellings of "Café": precomposed U+00E9, and plain e followed by
    // combining acute U+0301. They render identically in any editor, so a
    // .normalize() added for "tidiness" would look like a no-op in review
    // while changing the byte length of every accented food bank name in a
    // file third parties checksum. Written with an explicit escape so the
    // difference survives this file being reformatted or re-encoded.
    const nfc = "Café";
    const nfd = "Cafe\u0301";
    expect(formatCsvRow([nfc])).toBe("Café\r\n");
    expect(formatCsvRow([nfd])).toBe("Cafe\u0301\r\n");
    // The load-bearing assertion: neither form was collapsed into the other.
    expect(formatCsvRow([nfc])).not.toBe(formatCsvRow([nfd]));
    expect(formatCsvRow([nfd])).toHaveLength(formatCsvRow([nfc]).length + 1);
  });

  it("handles a very wide row and a very long field without truncating", () => {
    // api1.ts concatenates one row per food bank into a single in-memory
    // string and the dump exports are larger again, so this code path meets
    // production-sized input. A rewrite reaching for recursion or `reduce`
    // with array spread passes every small case in this file and then blows
    // the stack on the real data.
    const wide = formatCsvRow(Array.from({ length: 5000 }, (_, i) => i));
    expect(wide.match(/,/g)).toHaveLength(4999);
    expect(wide.startsWith("0,1,2,")).toBe(true);
    expect(wide.endsWith(",4998,4999\r\n")).toBe(true);

    // 100k characters with a quote at the very end: the escape must still
    // happen at the far end of the string and nothing may be dropped.
    // Length = 100000 x's + 2 for the doubled quote + 2 wrapping quotes + 2
    // for the CRLF.
    const long = "x".repeat(100_000) + '"';
    const rendered = formatCsvRow([long]);
    expect(rendered).toBe('"' + "x".repeat(100_000) + '"""\r\n');
    expect(rendered).toHaveLength(100_006);
  });
});

describe("formatCsvRow -- empty, null and undefined", () => {
  it("renders null, undefined and '' identically, losing the distinction", () => {
    // The module header states this outright: neither dialect preserves the
    // null/empty-string difference, and that loss already exists in the live
    // Python API. This test exists so nobody "improves" it by emitting a
    // sentinel like \\N or NULL for null -- which would change the bytes of
    // a file consumers already parse.
    const asNull = formatCsvRow(["a", null, "b"]);
    expect(asNull).toBe("a,,b\r\n");
    expect(formatCsvRow(["a", undefined, "b"])).toBe(asNull);
    expect(formatCsvRow(["a", "", "b"])).toBe(asNull);
  });

  it("writes an all-empty multi-column row as bare delimiters", () => {
    // Verified: csv.writer(QUOTE_MINIMAL).writerow(["", "", ""]) -> ',,\r\n'.
    expect(formatCsvRow(["", "", ""])).toBe(",,\r\n");
    expect(formatCsvRow([null, null, null])).toBe(",,\r\n");
  });

  it("writes a zero-column row as just the terminator", () => {
    // Matches Python: writerow([]) -> '\r\n'.
    expect(formatCsvRow([])).toBe("\r\n");
    // Even with QUOTE_ALL there is nothing to quote, so no stray '""'.
    expect(formatCsvRow([], true)).toBe("\r\n");
  });

  it("DIVERGES from Python for a one-column row whose only field is empty", () => {
    // Python has a special case here: when a record has exactly one field
    // and the rendered record is empty, the writer emits '""' so the line
    // does not read back as a zero-field record ("single empty field record
    // must be quoted" in _csv.c). Verified: writerow([""]) and
    // writerow([None]) both -> '""\r\n'.
    //
    // This port emits a blank line instead. Pinned, NOT fixed: it is
    // unreachable in production -- every CSV written here is multi-column
    // (19 fields in api1.ts, fixed headers in admin/lists.ts) -- and the
    // divergence is reported rather than silently corrected.
    expect(formatCsvRow([""])).toBe("\r\n");
    expect(formatCsvRow([null])).toBe("\r\n");
    expect(formatCsvRow([undefined])).toBe("\r\n");
    // Python's special case is scoped to len(row) == 1, so a TWO-column
    // all-empty row is a bare delimiter in both implementations. Asserted so
    // that anyone "fixing" the divergence above by quoting empty fields in
    // general can see immediately that they have overshot.
    expect(formatCsvRow(["", ""])).toBe(",\r\n");
    // Same one-field case under QUOTE_ALL is NOT a divergence: quoting
    // everything happens to produce Python's answer anyway.
    expect(formatCsvRow([""], true)).toBe('""\r\n');
    expect(formatCsvRow([null], true)).toBe('""\r\n');
  });
});

describe("formatCsvRow -- value types", () => {
  it("renders booleans Python-style: True/False, not true/false", () => {
    // The `closed` column of /api/1/foodbanks/?format=csv. FoodbankRow's
    // is_closed is a real JS boolean (packages/db/src/foodbank.ts:71), so it
    // reaches here as `true`/`false` and must come out capitalised the way
    // Python's str(bool) does. Anything relying on the exported column --
    // including the site's own regression diffs against the old API --
    // breaks on lowercase.
    expect(formatCsvRow([true, false])).toBe("True,False\r\n");
    // `false` must take the boolean branch, not be swallowed as falsy: the
    // obvious `v ? "True" : ""` shortcut would blank the column for every
    // OPEN food bank, which is most of them.
    expect(formatCsvRow([false])).not.toBe(formatCsvRow([null]));
  });

  it("renders integers with no decimal point, floats through formatFloat", () => {
    // Verified against Python: [1,-5,0,0.5,-0.5,1e-5,0.1,1/3] ->
    // '1,-5,0,0.5,-0.5,1e-05,0.1,0.3333333333333333'. Note 1e-05, not
    // 1e-5 -- Python pads the exponent to two digits, which is exactly what
    // formatFloat is delegated to for; this test proves the delegation
    // happens rather than re-testing float.ts.
    expect(formatCsvRow([1, -5, 0, 0.5, -0.5, 1e-5, 0.1, 1 / 3])).toBe(
      "1,-5,0,0.5,-0.5,1e-05,0.1,0.3333333333333333\r\n",
    );
    // 0 must render as "0" and not be swallowed by a falsy check -- the same
    // trap as `false` above, and charity_number/latitude columns are full of
    // legitimate zeroes.
    expect(formatCsvRow([0])).toBe("0\r\n");
    expect(formatCsvRow([0])).not.toBe(formatCsvRow([null]));
  });

  it("applies no locale grouping and no locale decimal separator", () => {
    // String(x) is locale-independent; Number#toLocaleString and
    // Intl.NumberFormat are not, and reaching for one of them "so the
    // numbers read nicely" is the classic way a column starts emitting
    // 1,234,567 on one host and 1.234.567 on another -- the same build
    // producing different bytes depending on the machine's ICU default
    // locale, which is precisely what a byte-exact export cannot tolerate.
    // Verified: writerow([1234567, -1234567, 12345.5]) ->
    // '1234567,-1234567,12345.5\r\n'.
    const rendered = formatCsvRow([1234567, -1234567, 12345.5]);
    expect(rendered).toBe("1234567,-1234567,12345.5\r\n");
    // The load-bearing consequence, and the reason this is worse than a
    // cosmetic difference: an en-GB grouping separator IS the delimiter, so
    // a grouped number both gains quotes and, to a reader that mishandles
    // them, gains columns. No quote character anywhere in the line proves no
    // separator was introduced in any of the three fields.
    expect(rendered).not.toContain('"');
    expect(rendered.slice(0, -2).match(/,/g)).toHaveLength(2);
  });

  it("renders NaN and Infinity the JS way, NOT Python's nan/inf", () => {
    // formatFloat returns "NaN"/"Infinity"/"-Infinity" (float.ts:15-17),
    // matching JS and dicttoxml. Python's csv.writer calls str() on the
    // float, which gives lowercase 'nan'/'inf'/'-inf' -- so these three
    // values are a real divergence. Pinned rather than fixed because it is
    // float.ts's decision, not csv.ts's, and because no CSV column reaches
    // this today: latt_long arrives as a string and the numeric columns are
    // ids. This test is the tripwire if that ever stops being true.
    expect(formatCsvRow([NaN, Infinity, -Infinity])).toBe("NaN,Infinity,-Infinity\r\n");
    expect(formatCsvRow([NaN, Infinity, -Infinity], true)).toBe('"NaN","Infinity","-Infinity"\r\n');
  });

  it("collapses an integral-valued float to int form -- 1.0 becomes 1", () => {
    // JS has no float/int distinction (float.ts's opening line), so a Python
    // 1.0 arriving here as the number 1 renders "1" where Python wrote
    // "1.0". This is the reason the { __float } wrapper exists in types.ts
    // at all. Pinned so the loss is visible rather than assumed.
    expect(formatCsvRow([1])).toBe("1\r\n");
    // -0 takes the same integer branch, so formatFloat's "-0.0" handling
    // never runs from here: Python's str(-0.0) is '-0.0', this writes '0'.
    expect(formatCsvRow([-0])).toBe("0\r\n");
    // The integer branch is plain String(), which does NOT switch to
    // exponent notation until 1e21 -- while float.ts documents 1e16 ->
    // "1e+16" as the verified Python answer for a float. Because 1e16 is
    // integral in JS it never reaches formatFloat, so the whole 1e16..1e21
    // range is written long-hand where Python would have written an
    // exponent. This is the widest window of the float/int loss and the one
    // most likely to show up in a real diff, so it is pinned explicitly.
    expect(formatCsvRow([1e16])).toBe("10000000000000000\r\n");
    expect(formatCsvRow([1e21])).toBe("1e+21\r\n");
    expect(formatCsvRow([Number.MAX_SAFE_INTEGER])).toBe("9007199254740991\r\n");
  });

  it("does NOT unwrap a { __float } value -- it stringifies to [object Object]", () => {
    // types.ts claims "xml.ts/csv.ts render it with full float formatting",
    // and xml.ts really does (isFloatValue -> v.__float). csv.ts has no such
    // branch: the wrapper falls through to String(v). No caller passes one
    // today (api1.ts and admin/lists.ts both hand over raw values), so this
    // pins current behaviour and the gap is reported, not patched here.
    expect(formatCsvRow([{ __float: 1 }])).toBe("[object Object]\r\n");
    // Under QUOTE_ALL the same garbage is merely quoted, not detected.
    expect(formatCsvRow([{ __float: 1 }], true)).toBe('"[object Object]"\r\n');
  });

  it("does NOT format a Date -- datetimes must arrive pre-formatted", () => {
    // types.ts: a datetime is carried as the RAW D1 column string, never a
    // JS Date, because each writer formats it differently. There is no Date
    // branch here, so passing one leaks JS's toString into the export. This
    // documents the trap; the fix is at the call site, not in csv.ts.
    //
    // The GMT+0000 in the expectation holds because vitest.config.mts pins
    // env TZ to "UTC"; the trailing timezone NAME is left unasserted since
    // it varies with the Node ICU build.
    const rendered = formatCsvRow([new Date("2026-09-05T19:28:08.853Z")]);
    expect(rendered.startsWith("Sat Sep 05 2026 19:28:08 GMT+0000")).toBe(true);
    expect(rendered.endsWith("\r\n")).toBe(true);
    // Not Django's / D1's format, which is what a consumer of this column
    // is expecting to see.
    expect(rendered).not.toContain("2026-09-05 19:28:08");
    // And specifically Date#toString, not toLocaleString or toUTCString --
    // both of those contain a comma, which would have forced the field to be
    // quoted. An unquoted field is therefore proof of which one ran.
    expect(rendered).not.toContain(",");
    expect(rendered).not.toContain('"');
  });

  it("stringifies most other values, quoting the result if it needs it", () => {
    // A nested array joins itself with commas via String(), and the quoting
    // check runs AFTER stringification -- so the result is a single valid
    // quoted field rather than a row that silently gained a column. The
    // delimiter count is the assertion that actually proves that.
    expect(formatCsvRow([["a", "b"], "z"])).toBe('"a,b",z\r\n');
    expect(formatCsvRow([["a", "b"], "z"]).replace(/"[^"]*"/g, "F")).toBe("F,z\r\n");
    // BigInt happens to render like a Python int, which is what a large D1
    // integer would want. A big one too, since the number branch is bypassed
    // entirely: no precision is lost the way a Number cast would lose it.
    expect(formatCsvRow([10n])).toBe("10\r\n");
    expect(formatCsvRow([9007199254740993n])).toBe("9007199254740993\r\n");
    // The stringification primitive is String(v), not `${v}` or "" + v.
    // Worth pinning because the two documented behaviours either side of
    // this line -- the [object Object] above and the TypeError below -- are
    // identical for all three spellings, so nothing else in this file would
    // notice the swap; a symbol is the one value that separates them, since
    // the other two throw on it and String() does not. The comma inside the
    // description then proves the quoting check ran on String()'s output.
    expect(formatCsvRow([Symbol("a,b")])).toBe('"Symbol(a,b)"\r\n');
    // ...but "stringifies anything" is not actually true, and callers should
    // know it: a value with no path to a primitive throws out of the map
    // rather than producing a field. formatCsvRow is not a defensive
    // function, so rows must be built from D1 scalars, not arbitrary objects.
    expect(() => formatCsvRow([Object.create(null)])).toThrow(TypeError);
  });
});

describe("formatCsvRow -- QUOTE_ALL (the dump.py dialect)", () => {
  it("defaults to the QUOTE_MINIMAL dialect", () => {
    // gfapi1 is the caller that omits the flag, so the default must be the
    // unquoted dialect. An accidental flip to quoteAll=true would rewrite
    // every line of the live foodbanks export.
    const row = ["name", "slug", "51.0,-1.8"];
    expect(formatCsvRow(row)).toBe(formatCsvRow(row, false));
    expect(formatCsvRow(row)).toBe("name,slug,\"51.0,-1.8\"\r\n");
    expect(formatCsvRow(row, true)).toBe('"name","slug","51.0,-1.8"\r\n');
    // A caller threading an option through -- formatCsvRow(row, opts?.quoteAll)
    // -- passes undefined explicitly, and the default parameter must still
    // fire. A rewrite to `quoteAll: boolean` plus an internal truthiness
    // check keeps this working, but one to `quoteAll !== false` does not:
    // undefined would then quote everything and turn the live API's output
    // into a dump file.
    expect(formatCsvRow(row, undefined)).toBe("name,slug,\"51.0,-1.8\"\r\n");
  });

  it("quotes every field, including ones needing no quoting", () => {
    // Verified: csv.writer(f, quoting=csv.QUOTE_ALL).writerow(["name","slug","url"])
    // -> '"name","slug","url"\r\n'. This is the header of every dump file.
    expect(formatCsvRow(["name", "slug", "url"], true)).toBe('"name","slug","url"\r\n');
    expect(formatCsvRow(["tab\tsep", "  spaced  "], true)).toBe('"tab\tsep","  spaced  "\r\n');
    // A field that would have been quoted anyway is wrapped ONCE, not twice
    // -- the flag and the character check must not both apply their own
    // layer of quotes.
    expect(formatCsvRow(["a,b"], true)).toBe('"a,b"\r\n');
  });

  it("quotes empties and booleans too: None -> \"\", True -> \"True\"", () => {
    // The exact claim in the module header, verified against the real
    // library: writerow([True, False, None, ""], QUOTE_ALL) ->
    // '"True","False","",""\r\n'. dump.py writes is_school/is_mobile/is_area
    // as bools and most other columns as nullable, so this line is the shape
    // of a real foodbanks dump row.
    expect(formatCsvRow([true, false, null, ""], true)).toBe('"True","False","",""\r\n');
    expect(formatCsvRow([undefined, null], true)).toBe('"",""\r\n');
  });

  it("quotes numbers as well -- QUOTE_ALL, not QUOTE_NONNUMERIC", () => {
    // Python has a separate QUOTE_NONNUMERIC dialect that leaves numbers
    // bare; dump.py does not use it. Verified: [1, -5, 0.5] under QUOTE_ALL
    // -> '"1","-5","0.5"\r\n'.
    expect(formatCsvRow([1, -5, 0.5], true)).toBe('"1","-5","0.5"\r\n');
  });

  it("still doubles inner quotes and still terminates with CRLF", () => {
    // Quoting everything must not skip the escaping step -- an unescaped
    // inner quote inside an always-quoted field ends the field early and
    // shifts every remaining column of that dump row.
    expect(formatCsvRow(['He said "hi"', "plain"], true)).toBe('"He said ""hi""","plain"\r\n');
    expect(formatCsvRow(["a\r\nb"], true)).toBe('"a\r\nb"\r\n');
  });

  it("DIVERGES on an array HOLE: the field is emitted unquoted", () => {
    // Array#map skips holes rather than visiting them, so a hole never
    // reaches the quoting step and lands in the join as nothing at all.
    // Under QUOTE_MINIMAL that is indistinguishable from undefined and
    // harmless; under QUOTE_ALL it breaks the dialect's one invariant --
    // every field is quoted -- and produces a row a strict QUOTE_ALL reader
    // will not accept.
    const holed: unknown[] = ["a", "placeholder", "b"];
    delete holed[1]; // a real hole, not undefined
    expect(formatCsvRow(holed)).toBe("a,,b\r\n");
    expect(formatCsvRow(holed)).toBe(formatCsvRow(["a", undefined, "b"]));
    // ...but under QUOTE_ALL the hole and undefined part company:
    expect(formatCsvRow(holed, true)).toBe('"a",,"b"\r\n');
    expect(formatCsvRow(["a", undefined, "b"], true)).toBe('"a","","b"\r\n');
    expect(formatCsvRow(holed, true)).not.toBe(formatCsvRow(["a", undefined, "b"], true));
    // Reachable only if a caller ever builds a row with `new Array(n)` and
    // fills it by index, or `delete`s a column. Pinned, not fixed, and
    // reported: no caller does this today.
    expect(formatCsvRow(new Array(3), true)).toBe(",,\r\n");
  });
});

describe("formatCsvRow -- purity", () => {
  it("does not mutate the row it was given", () => {
    // Callers build one array per record in a loop over thousands of rows
    // (dump.py's port and api1.ts both do); an in-place normalisation would
    // be invisible until a caller reused a row array.
    const row: unknown[] = ["a,b", null, true, 0.5];
    const before = [...row];
    formatCsvRow(row);
    formatCsvRow(row, true);
    expect(row).toEqual(before);
  });

  it("keeps no state between calls", () => {
    // api1.ts calls this in a tight loop and appends to one string. A
    // module-level buffer or a memo keyed on anything but the full input --
    // a tempting way to speed up a hot loop -- would show up as one row's
    // content bleeding into the next, which no single-call test can catch.
    const a = formatCsvRow(["a", "b"]);
    const b = formatCsvRow(["c,d", null], true);
    expect(formatCsvRow(["a", "b"])).toBe(a);
    expect(formatCsvRow(["c,d", null], true)).toBe(b);
    // Interleaved, and with the same array object rendered in both dialects
    // back to back, since that is exactly what a dump-then-api sequence does.
    const row: unknown[] = ["x,y", true];
    const minimal = formatCsvRow(row);
    const all = formatCsvRow(row, true);
    expect(formatCsvRow(row)).toBe(minimal);
    expect(formatCsvRow(row, true)).toBe(all);
    expect(minimal).toBe('"x,y",True\r\n');
    expect(all).toBe('"x,y","True"\r\n');
  });
});
