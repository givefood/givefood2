import { describe, expect, it } from "vitest";
import { replaceBoundaryProperties, setBoundaryPropertyType, toDjangoJsonFormat } from "./geojsonBoundary";

// What this module is defending, and therefore what these tests are for:
// geo.json is in PLAN.md's STRICT byte-equality corpus, and a stored
// `boundary_geojson` column is the one place in the response whose numbers
// this port does NOT generate itself. Django re-encodes them through
// json.dumps (which prints a Python float 51.0 as "51.0"); JavaScript's
// JSON.stringify prints the same value as "51" -- so any parse+re-serialize
// of a stored polygon silently shortens thousands of coordinates and blows
// byte parity for every boundary feed. Every test below that quotes a
// coordinate like `51.0` or `-1.50` back verbatim exists to catch a
// "simplification" of this module into JSON.parse/JSON.stringify.
//
// For that reason these tests assert on EXACT OUTPUT STRINGS, essentially
// never on `JSON.parse(out)`. A deep-equal against a parsed result is worse
// than useless here: JSON.parse is precisely the operation that destroys
// `51.0` and `-1.50`, so an assertion phrased through it cannot fail when
// the thing this module exists to prevent actually happens.
//
// The other half is key POSITION. Django mutates a Python dict, so an
// assignment to an existing key updates it where it sits and an assignment
// to a new key appends at the end of iteration order. Both orders were
// confirmed against live responses (see the module header); a splice that
// always prepended, or always appended, would still produce valid GeoJSON
// and still fail byte parity.
//
// Every Python-side expectation below (separators, ensure_ascii escapes,
// float repr, dict-literal ordering) was checked against a real `python3 -c
// "import json; ..."` rather than recalled, because half of them are
// counter-intuitive.

// A compact stored constituency row, in the shape the module header records
// for `givefood_parliamentaryconstituency`: no spaces at all, a raw UTF-8
// "ô" in the ONS name, and coordinates carrying trailing zeros.
const STORED_CONSTITUENCY =
  '{"type":"Feature","properties":{"PCON24CD":"W07000041","PCON24NM":"Ynys Môn"},"geometry":{"type":"Polygon","coordinates":[[[-4.20000,53.30]]]}}';

// A pretty-printed stored location row with NO "properties" key at all --
// the other stored shape the header records, from an older pipeline.
const STORED_LOCATION_PRETTY =
  '{\n  "type": "Feature",\n  "geometry": {\n    "coordinates": [51.0, -1.50]\n  }\n}';

// A pretty-printed stored constituency row that DOES have a properties
// object. Used to prove the splices are byte-conservative: everything
// outside the one span being written keeps its original indentation.
const STORED_CONSTITUENCY_PRETTY =
  '{\n  "type": "Feature",\n  "properties": {\n    "PCON24CD": "W07000041"\n  },\n' +
  '  "geometry": {\n    "coordinates": [[[-4.20000, 53.30]]]\n  }\n}';

describe("replaceBoundaryProperties", () => {
  it("replaces an existing properties object wholesale, in its original position", () => {
    // Django's `boundary["properties"] = {...}` (gfwfbn/views.py:290-295) is
    // a reassignment, not a merge: whatever the stored row had under
    // "properties" is gone, and the key stays where it was in iteration
    // order -- here BEFORE "geometry", not appended after it.
    const stored = '{"type":"Feature","properties":{"stored_id":7,"note":"keep me?"},"geometry":{"type":"Polygon"}}';
    expect(replaceBoundaryProperties(stored, [["type", "lb"], ["name", "Hall"]])).toBe(
      '{"type":"Feature","properties":{"type":"lb","name":"Hall"},"geometry":{"type":"Polygon"}}',
    );
  });

  it("appends properties LAST when the stored row has no properties key", () => {
    // Confirmed against a live response in the module header: a location
    // whose stored Feature had no "properties" comes back as
    // {"type":..., "geometry":..., "properties":...} -- properties after
    // geometry, because Python appends a new dict key at the end.
    //
    // Asserted as an exact string, not as a parsed shape plus an indexOf
    // ordering check. Three separate regressions hide behind a parse-based
    // assertion of this case and are caught here: the coordinates keeping
    // their trailing zeros (`51.0`, not `51`), the stored indentation being
    // left untouched by the splice, and the insertion landing immediately
    // before the closing brace rather than after the last value.
    expect(replaceBoundaryProperties(STORED_LOCATION_PRETTY, [["type", "lb"], ["name", "Hall"]])).toBe(
      '{\n  "type": "Feature",\n  "geometry": {\n    "coordinates": [51.0, -1.50]\n  }\n' +
        ',"properties":{"type":"lb","name":"Hall"}}',
    );
  });

  it("emits the caller's entries in order, so the Python dict literal's key order survives", () => {
    // buildGeojson.ts passes type, name, foodbank, url -- exactly the order
    // of the dict literal at gfwfbn/views.py:290-295, and deliberately no
    // "address" (the "lb" branch never had one). Order is the caller's to
    // control; this asserts the module does not sort it.
    const out = replaceBoundaryProperties('{"type":"Feature"}', [
      ["type", "lb"],
      ["name", "Central Hall"],
      ["foodbank", "Testville"],
      ["url", "/needs/at/testville/central-hall/"],
    ]);
    expect(out).toBe(
      '{"type":"Feature","properties":{"type":"lb","name":"Central Hall","foodbank":"Testville",' +
        '"url":"/needs/at/testville/central-hall/"}}',
    );
    // Sorting is the specific failure to guard against: `name` sorts before
    // `type` alphabetically, so an implementation that sorted its entries
    // would emit a different -- and still perfectly valid -- feature.
    expect(out.indexOf('"type"')).toBeLessThan(out.indexOf('"name"'));
    // Integer-LIKE keys are the second way order gets lost, and the four
    // real keys above cannot catch it. Building the properties object as a
    // plain JS object (`JSON.stringify(Object.fromEntries(entries))`) is the
    // obvious "simplification" of the map+join below, and it silently
    // reorders any key that looks like an array index to the front, in
    // ascending numeric order -- "1" would jump ahead of "2". A Map, or the
    // ordered list this module actually keeps, does not. Python's dict has
    // no such rule (json.dumps({"2": ..., "1": ...}) keeps insertion order),
    // so the reordering would be a pure JS artefact and a parity failure.
    expect(replaceBoundaryProperties('{"a":1}', [["2", "two"], ["1", "one"], ["z", "zed"]])).toBe(
      '{"a":1,"properties":{"2":"two","1":"one","z":"zed"}}',
    );
  });

  it("does not dedupe repeated entry keys either", () => {
    // The order test above uses four distinct keys, so it cannot tell a
    // faithful pass-through from an implementation that built a Map or a
    // plain object out of `entries` on the way -- both would look identical
    // there. This case can: a Map/object would collapse the pair to one key.
    // Nothing in buildGeojson.ts passes duplicates, but the module promises
    // to reproduce a caller-controlled ordered list verbatim, and that is
    // what it does.
    expect(replaceBoundaryProperties('{"type":"Feature"}', [["type", "lb"], ["type", "x"]])).toBe(
      '{"type":"Feature","properties":{"type":"lb","type":"x"}}',
    );
  });

  it("copies every coordinate digit through untouched, trailing zeros included", () => {
    // The reason this module scans instead of parsing. A JSON.parse +
    // JSON.stringify round trip turns `51.0` into `51` and `-1.50` into
    // `-1.5`; both would be a byte-parity failure on every boundary feed.
    const out = replaceBoundaryProperties(STORED_LOCATION_PRETTY, [["type", "lb"]]);
    expect(out).toContain("[51.0, -1.50]");
  });

  it("strips exactly one trailing comma, matching Django's geojson_dict", () => {
    // givefood/utils/geo.py:180-189 strips a single trailing comma before
    // json.loads. Real data, not defensive Python: the stored text for
    // bethnal-green-and-stepney ends "...}}," straight out of Postgres.
    expect(replaceBoundaryProperties('{"type":"Feature"},', [["type", "lb"]])).toBe(
      '{"type":"Feature","properties":{"type":"lb"}}',
    );
    // A SECOND trailing comma is not stripped -- Django's `if geojson[-1:]
    // == ","` runs once and json.loads then raises (JSONDecodeError,
    // confirmed with python3). This throws too rather than quietly
    // repairing text Django would have rejected. Pinned to the exact
    // message, not just /geojsonBoundary/: the scanner has four distinct
    // failure modes and a loose regex cannot tell a "stopped at the stray
    // comma" from a "ran off the end of the text".
    expect(() => replaceBoundaryProperties('{"type":"Feature"},,', [["type", "lb"]])).toThrow(
      "geojsonBoundary: expected a quoted key",
    );
  });

  it("trims surrounding whitespace, like geojson_dict's .strip()", () => {
    expect(replaceBoundaryProperties('\n  {"type":"Feature"}  \n', [["type", "lb"]])).toBe(
      '{"type":"Feature","properties":{"type":"lb"}}',
    );
  });

  it("SUSPECTED BUG: whitespace between the brace and the trailing comma corrupts the output", () => {
    // stripTrailingComma trims BEFORE stripping the comma and never again
    // after, so `{...} ,` leaves a trailing space that spliceObjectKey then
    // treats as the object's closing brace: the new key is appended OUTSIDE
    // the object and the result is not JSON at all. Django survives this
    // shape -- python3 json.loads('{"a":1} ') returns {'a': 1} and the
    // assignment succeeds -- so this is a real divergence, not a shared
    // failure. Pinned, not fixed, per the rules of this port; reported
    // separately. If someone fixes it, this test SHOULD fail.
    expect(replaceBoundaryProperties('{"a":1} , ', [["type", "lb"]])).toBe('{"a":1},"properties":{"type":"lb"} ');
    // With an object as the last value the same input throws instead of
    // silently corrupting, because the scanner reaches the stray `}`.
    expect(() => replaceBoundaryProperties('{"a":{"b":1}} ,', [["type", "lb"]])).toThrow(
      "geojsonBoundary: expected a quoted key",
    );
  });

  it("is not fooled by braces, brackets or escaped quotes inside stored string values", () => {
    // A stored food bank or ONS name really can contain a brace or a quote.
    // If the scan were a naive indexOf/depth count over raw characters, the
    // "}" inside this name would close the object early and the splice
    // would land in the middle of a string. Asserted byte-for-byte: a
    // JSON.parse deep-equal would also pass for an implementation that
    // re-encoded the escapes differently.
    const stored = '{"name":"The {Old} Church \\"Annexe\\"","geometry":{"c":"]}"}}';
    expect(replaceBoundaryProperties(stored, [["type", "lb"]])).toBe(
      '{"name":"The {Old} Church \\"Annexe\\"","geometry":{"c":"]}"},"properties":{"type":"lb"}}',
    );
  });

  it("handles an escaped quote inside a KEY, not just inside a value", () => {
    // Keys go through the same skipString scan and then through
    // JSON.parse(text.slice(...)) to be compared against "properties". A
    // key-scanner that stopped at the first raw `"` would mis-read the key
    // and splice into the wrong span.
    expect(replaceBoundaryProperties('{"a\\"b":1}', [["type", "lb"]])).toBe(
      '{"a\\"b":1,"properties":{"type":"lb"}}',
    );
  });

  it("is not fooled by a stored string that ENDS in an escaped backslash", () => {
    // The classic string-scanner killer, and the one escape shape the
    // escaped-quote tests above cannot reach: in `"C:\\"` the two raw
    // backslash characters are an escaped BACKSLASH, so the quote that
    // follows really does close the literal. A scanner that skipped `\"`
    // pairs with a naive regex, or that reset its `escaped` flag one
    // character late, would read straight past that quote and swallow the
    // rest of the Feature -- appending "properties" inside a string value,
    // or throwing "unterminated string" on text Django parses fine
    // (python3 json.loads('{"n":"C:\\\\"}') -> {'n': 'C:\\'}).
    expect(replaceBoundaryProperties('{"n":"C:\\\\","geometry":{}}', [["type", "lb"]])).toBe(
      '{"n":"C:\\\\","geometry":{},"properties":{"type":"lb"}}',
    );
    // Same shape in a KEY, and immediately before the "properties" key the
    // scan has to find -- if the backslash ate the closing quote, the
    // splice would miss the existing key and append a duplicate instead of
    // replacing in place.
    expect(replaceBoundaryProperties('{"a\\\\":1}', [["type", "lb"]])).toBe('{"a\\\\":1,"properties":{"type":"lb"}}');
    expect(replaceBoundaryProperties('{"x":"\\\\","properties":{"a":1}}', [["type", "lb"]])).toBe(
      '{"x":"\\\\","properties":{"type":"lb"}}',
    );
  });

  it("matches KEYS only -- a stored string VALUE reading \"properties\" is left alone", () => {
    // The whole point of scanning key/value entries rather than reaching for
    // an indexOf('"properties"') or a /"properties"\s*:/ regex over the raw
    // text. A stored ONS or food bank field whose VALUE is the word
    // properties would send either of those shortcuts splicing into the
    // middle of somebody's data; here it is skipped as an ordinary value
    // and the real key is appended at the end.
    expect(replaceBoundaryProperties('{"a":"properties"}', [["type", "lb"]])).toBe(
      '{"a":"properties","properties":{"type":"lb"}}',
    );
    // And the inverse: a "properties" key whose stored VALUE is a string
    // that itself spells out a JSON object. skipString has to consume the
    // whole literal -- the braces and colon inside it are data -- and the
    // replacement lands over exactly that span.
    expect(replaceBoundaryProperties('{"properties":"{\\"a\\":1}"}', [["type", "lb"]])).toBe(
      '{"properties":{"type":"lb"}}',
    );
    // The sharpest of the three, and the only one a /"properties"\s*:/
    // regex would fail: a stored value that is an escaped JSON blob
    // containing the exact byte sequence `"properties":`. The word alone
    // (the first case above) does not kill such a regex, because nothing
    // follows it with a colon; this does. Escaped JSON inside a string
    // column is ordinary enough in ONS-derived payloads to be worth the
    // guard. Here the real key is absent, so the splice appends.
    expect(replaceBoundaryProperties('{"note":"{\\"properties\\":{\\"a\\":1}}"}', [["type", "lb"]])).toBe(
      '{"note":"{\\"properties\\":{\\"a\\":1}}","properties":{"type":"lb"}}',
    );
  });

  it("decodes an escaped spelling of the key, exactly as json.loads does", () => {
    // Keys are compared after `JSON.parse(text.slice(...))`, not as raw
    // source text, so `"\u0070roperties"` IS the "properties" key -- python3
    // json.loads('{"\\u0070roperties":1}') gives {'properties': 1} and
    // Django's assignment would therefore overwrite it in place. A key
    // comparison written as a raw slice equality would miss it and append a
    // second, duplicate key. No production row is spelled this way, but the
    // scan being value-equal rather than byte-equal is the behaviour that
    // keeps this module honest about what a JSON key is.
    expect(replaceBoundaryProperties('{"\\u0070roperties":{"a":1}}', [["type", "lb"]])).toBe(
      '{"\\u0070roperties":{"type":"lb"}}',
    );
    // The splice leaves the escaped key TEXT as it found it (it only ever
    // rewrites the value span) -- and byte parity is still reached, because
    // toDjangoJsonFormat decodes and re-encodes every string literal it
    // passes. python3 json.dumps(json.loads('{"\\u0070roperties":{"type":"lb"}}'))
    // is '{"properties": {"type": "lb"}}', which is exactly this.
    expect(toDjangoJsonFormat(replaceBoundaryProperties('{"\\u0070roperties":{"a":1}}', [["type", "lb"]]))).toBe(
      '{"properties": {"type": "lb"}}',
    );
  });

  it("replaces a string-, array- or bare-valued properties in place, whitespace span and all", () => {
    // The null case above takes the bare-value branch of the entry scanner;
    // these are the other two value shapes a stored row could put under
    // "properties", and each is located by a different arm of the scan
    // (skipString, scanBalanced). All three must REPLACE, not append.
    expect(replaceBoundaryProperties('{"properties":[1,2],"g":1}', [["type", "lb"]])).toBe(
      '{"properties":{"type":"lb"},"g":1}',
    );
    // A bare value's span runs to the next comma WITHOUT trimming, so the
    // space sitting between `null` and the comma is part of what gets
    // replaced and disappears from the output. Pinned because it is a real
    // (if cosmetic) consequence of the third scan branch: a refactor that
    // trimmed the value span would leave `{"properties": {...} , ...}`
    // here. Both spellings collapse to the same bytes once
    // toDjangoJsonFormat runs, so this is about the splice, not parity.
    expect(replaceBoundaryProperties('{"properties": null , "geometry":{}}', [["type", "lb"]])).toBe(
      '{"properties": {"type":"lb"}, "geometry":{}}',
    );
  });

  it("DIVERGENCE: stray, doubled and leading commas are tolerated where json.loads rejects them", () => {
    // scanTopLevelEntries advances between entries with `/[\s,]/`, which
    // cannot tell one comma from three. Every input below is a hard
    // JSONDecodeError in python3 ("Expecting property name enclosed in
    // double quotes" / "Illegal trailing comma"), so Django would 500
    // rather than emit anything; this module scans straight past and
    // returns text that is still not valid JSON, just longer. Pinned, not
    // fixed, per the rules of this port -- but it means malformed stored
    // text reaches the API as malformed response body instead of as an
    // error, which is worth knowing before someone tightens the scanner.
    expect(replaceBoundaryProperties('{"a":1,,"b":2}', [["type", "lb"]])).toBe(
      '{"a":1,,"b":2,"properties":{"type":"lb"}}',
    );
    expect(replaceBoundaryProperties('{,"a":1}', [["type", "lb"]])).toBe('{,"a":1,"properties":{"type":"lb"}}');
    expect(replaceBoundaryProperties('{"a":1,}', [["type", "lb"]])).toBe('{"a":1,,"properties":{"type":"lb"}}');
    // The stray comma survives the formatting pass too -- toDjangoJsonFormat
    // is punctuation and strings only, so it politely spaces the garbage
    // rather than noticing it.
    expect(toDjangoJsonFormat(replaceBoundaryProperties('{"a":1,,"b":2}', [["type", "lb"]]))).toBe(
      '{"a": 1, , "b": 2, "properties": {"type": "lb"}}',
    );
  });

  it("DIVERGENCE: the scanner accepts a non-breaking space as separator whitespace", () => {
    // The other half of the isJsonWs test in the toDjangoJsonFormat block
    // below, and the reason that test's comment says the module's two
    // definitions of whitespace really do disagree. scanTopLevelEntries
    // uses `/[\s,]/`, whose \s matches U+00A0 and the rest of Unicode Zs;
    // python3's json.loads accepts only space/tab/CR/LF and rejects this
    // input outright. So the splice succeeds on text Django would refuse --
    // and the NBSP is then copied through untouched by the formatter,
    // because isJsonWs does NOT consider it whitespace. One character, two
    // opposite answers, in one pipeline. If the scanner is ever tightened
    // to isJsonWs this test should fail, and that should be a decision.
    expect(replaceBoundaryProperties('{"a":1,\u00a0"b":2}', [["type", "lb"]])).toBe(
      '{"a":1,\u00a0"b":2,"properties":{"type":"lb"}}',
    );
    expect(setBoundaryPropertyType('{"properties":{"a":1,\u00a0"b":2}}', "b")).toBe(
      '{"properties":{"a":1,\u00a0"b":2,"type":"b"}}',
    );
    // Inside a string literal an NBSP is ordinary data, and the formatting
    // pass escapes it like any other non-ASCII character -- python3
    // json.dumps(json.loads('{"a":"x\u00a0y"}')) is '{"a": "x\\u00a0y"}'.
    expect(toDjangoJsonFormat('{"a":"x\u00a0y"}')).toBe('{"a": "x\\u00a0y"}');
  });

  it("only ever touches the TOP-LEVEL properties key, never a nested one", () => {
    // Nested objects are skipped with scanBalanced, never descended into,
    // so a "properties" (or "type") key inside geometry cannot be mistaken
    // for the Feature's own.
    const stored = '{"geometry":{"properties":{"inner":1},"type":"Polygon"}}';
    expect(replaceBoundaryProperties(stored, [["type", "lb"]])).toBe(
      '{"geometry":{"properties":{"inner":1},"type":"Polygon"},"properties":{"type":"lb"}}',
    );
  });

  it("writes an empty properties object when given no entries", () => {
    // Not a case buildGeojson.ts hits, but the boundary of the entries loop:
    // an empty list must still produce a valid `{}`, not `{,}` or a dangling
    // comma that would make the whole FeatureCollection unparseable.
    expect(replaceBoundaryProperties('{"type":"Feature"}', [])).toBe('{"type":"Feature","properties":{}}');
  });

  it("overwrites a null properties value in place rather than appending a second key", () => {
    // RFC 7946 allows "properties": null. Full reassignment covers it
    // without any special case -- but it must REPLACE the null, not append
    // a duplicate "properties" key that would make the output ambiguous.
    const out = replaceBoundaryProperties('{"type":"Feature","properties":null,"geometry":{}}', [["type", "lb"]]);
    expect(out).toBe('{"type":"Feature","properties":{"type":"lb"},"geometry":{}}');
    expect(out.match(/"properties"/g)).toHaveLength(1);
  });

  it("handles a top-level bare number value without losing it", () => {
    // Bare (unquoted) values take the third branch of the entry scanner --
    // scan forward to the next comma rather than to a matching bracket or
    // closing quote. A stored Feature with a numeric "id" exercises it,
    // both in the middle of the object and as its final entry (where the
    // scan has to stop at the closing brace instead).
    expect(replaceBoundaryProperties('{"type":"Feature","id":12}', [["type", "lb"]])).toBe(
      '{"type":"Feature","id":12,"properties":{"type":"lb"}}',
    );
    expect(replaceBoundaryProperties('{"id":12,"type":"Feature"}', [["type", "lb"]])).toBe(
      '{"id":12,"type":"Feature","properties":{"type":"lb"}}',
    );
  });

  it("DIVERGENCE: splices the FIRST of two duplicate stored properties keys; Python keeps the last", () => {
    // python3 json.loads('{"properties":1,"properties":2}') -> {'properties': 2}:
    // a later duplicate wins, and Django's assignment would then overwrite
    // that one. This module scans left to right and takes the first hit, so
    // the surviving stored value differs. No production row is known to
    // have duplicate top-level keys, which is why this is documented rather
    // than fixed -- but it is a real behavioural difference and it should
    // be a deliberate decision to change it, not an accident.
    expect(replaceBoundaryProperties('{"properties":{"a":1},"properties":{"b":2}}', [["type", "lb"]])).toBe(
      '{"properties":{"type":"lb"},"properties":{"b":2}}',
    );
  });

  it("throws rather than guessing when the stored text is not a JSON object", () => {
    // Django would raise here too (json.loads on a non-object still parses,
    // but `boundary["properties"] = ...` then fails on a list/str). Failing
    // loudly beats emitting a corrupt FeatureCollection to the API.
    expect(() => replaceBoundaryProperties("[1,2]", [["type", "lb"]])).toThrow("geojsonBoundary: not a JSON object");
    expect(() => replaceBoundaryProperties("", [["type", "lb"]])).toThrow("geojsonBoundary: not a JSON object");
    expect(() => replaceBoundaryProperties("   ", [["type", "lb"]])).toThrow("geojsonBoundary: not a JSON object");
    // A stored value of nothing but a comma strips down to the empty string
    // and hits the same guard -- it must not index off the front of "".
    expect(() => replaceBoundaryProperties(",", [["type", "lb"]])).toThrow("geojsonBoundary: not a JSON object");
    expect(() => replaceBoundaryProperties("null", [["type", "lb"]])).toThrow("geojsonBoundary: not a JSON object");
  });

  it("throws a bare TypeError -- not a geojsonBoundary error -- on a NULL column value", () => {
    // `boundary_geojson` is a nullable TEXT column and D1 hands back a real
    // JS null for it, so this is a shape the types forbid but the database
    // can produce. What stops it reaching here is the CALLER's truthy
    // guard: buildGeojson.ts:149 `if (location.boundary_geojson && ...)` and
    // :255 `if (constituency.boundary_geojson)` -- the constituency one
    // explicitly there because Django's own `boundary_geojson_dict()` would
    // crash on `None.strip()`. This module has no guard of its own and
    // fails the same way Django does, with a null-dereference rather than
    // one of its own messages. Pinned so that a future caller that drops
    // the guard finds a documented answer instead of a mystery 500, and so
    // that anyone catching /geojsonBoundary/ knows this one slips past.
    expect(() => replaceBoundaryProperties(null as unknown as string, [["type", "lb"]])).toThrow(TypeError);
    expect(() => setBoundaryPropertyType(undefined as unknown as string, "b")).toThrow(TypeError);
    expect(() => toDjangoJsonFormat(null as unknown as string)).toThrow(TypeError);
    expect(() => replaceBoundaryProperties(null as unknown as string, [["type", "lb"]])).not.toThrow(
      /geojsonBoundary/,
    );
  });

  it("throws on an unbalanced bracket, exercising scanBalanced's own error", () => {
    // The three malformed-input tests elsewhere in this file all trip
    // skipString or the key/colon guards. scanBalanced has its own
    // "unterminated {...}" / "unterminated [...]" failure and nothing else
    // reaches it: a stored polygon truncated mid-coordinate-array is
    // exactly how it would show up in production.
    expect(() => replaceBoundaryProperties('{"geometry":[1,2}', [["type", "lb"]])).toThrow(
      "geojsonBoundary: unterminated [...]",
    );
    expect(() => setBoundaryPropertyType('{"properties":{"a":1', "b")).toThrow("geojsonBoundary: unterminated {...}");
  });

  it("SUSPECTED BUG: a Feature missing its own closing brace is silently mis-spliced", () => {
    // `{"geometry":{"a":1}` -- the outer brace never closes. scanBalanced
    // is never asked about the OUTER object (spliceObjectKey is handed
    // 0..text.length on trust), so text.length-1 is taken as the closing
    // brace and the new key is inserted INSIDE "geometry". The result is
    // both invalid JSON and wrongly nested, returned with no error at all.
    // python3's json.loads rejects the same input outright. Truncated TEXT
    // columns are a plausible real failure, so this is worth pinning even
    // though the rules of this port say document rather than fix.
    expect(replaceBoundaryProperties('{"geometry":{"a":1}', [["type", "lb"]])).toBe(
      '{"geometry":{"a":1,"properties":{"type":"lb"}}',
    );
  });
});

describe("setBoundaryPropertyType", () => {
  it("appends type after the stored ONS fields when properties has no type key", () => {
    // The live-verified case from the module header: a constituency whose
    // stored properties had no "type" comes back with "type" LAST, after
    // the pre-existing ONS boundary fields. Everything else -- the raw "ô"
    // byte, the trailing zeros in the polygon -- is left exactly as stored.
    expect(setBoundaryPropertyType(STORED_CONSTITUENCY, "b")).toBe(
      '{"type":"Feature","properties":{"PCON24CD":"W07000041","PCON24NM":"Ynys Môn","type":"b"},' +
        '"geometry":{"type":"Polygon","coordinates":[[[-4.20000,53.30]]]}}',
    );
  });

  it("updates an existing nested type in place, without moving it", () => {
    // `boundary["properties"]["type"] = "b"` on a key that already exists
    // updates the value where it sits. If this appended instead, the ONS
    // field that followed "type" would move and the bytes would differ.
    const stored = '{"properties":{"PCON24NM":"Ynys Môn","type":"stale","PCON24CD":"W07000041"}}';
    expect(setBoundaryPropertyType(stored, "b")).toBe(
      '{"properties":{"PCON24NM":"Ynys Môn","type":"b","PCON24CD":"W07000041"}}',
    );
  });

  it("touches only the Feature's own type, never the geometry's", () => {
    // "type":"Polygon" inside geometry and "type":"Feature" at the top level
    // must both survive: the only "type" this writes is the one nested
    // inside "properties".
    const stored = '{"type":"Feature","properties":{"a":1},"geometry":{"type":"MultiPolygon"}}';
    expect(setBoundaryPropertyType(stored, "b")).toBe(
      '{"type":"Feature","properties":{"a":1,"type":"b"},"geometry":{"type":"MultiPolygon"}}',
    );
  });

  it("never mistakes a type key nested one level INSIDE properties for the one it writes", () => {
    // The scan of "properties" is itself depth-1 only. A property whose
    // value is an object carrying its own "type" (stored ONS payloads do
    // contain nested blobs) must be stepped over via scanBalanced, and the
    // real "type" appended after the last top-level property -- not written
    // into the nested object, which would leave the Feature without the
    // "b" marker the map front-end switches on.
    expect(setBoundaryPropertyType('{"properties":{"nested":{"type":"inner"},"a":1}}', "b")).toBe(
      '{"properties":{"nested":{"type":"inner"},"a":1,"type":"b"}}',
    );
  });

  it("writes a KEY named type, never a property whose VALUE happens to be \"type\"", () => {
    // The nested-scan counterpart of the key/value test on the lb path. An
    // ONS payload really can carry the string "type" as a value (a field
    // describing a boundary category, say). An indexOf('"type"') or a
    // regex over the properties span would splice over that value and
    // leave the Feature without its "b" marker AND with a corrupted
    // stored field; the key/value scan appends a new key instead.
    expect(setBoundaryPropertyType('{"properties":{"a":"type"}}', "b")).toBe(
      '{"properties":{"a":"type","type":"b"}}',
    );
    // The word on its own does not kill a /"type"\s*:/ regex, because
    // nothing follows it with a colon. This does: a stored property whose
    // value is an escaped JSON blob carrying the literal bytes `"type":`.
    // A regex locator would overwrite the "orig" INSIDE that string and
    // never append the real key; the scan steps over the whole literal.
    expect(setBoundaryPropertyType('{"properties":{"raw":"{\\"type\\":\\"orig\\"}"}}', "b")).toBe(
      '{"properties":{"raw":"{\\"type\\":\\"orig\\"}","type":"b"}}',
    );
    // An escaped spelling of the key IS the key, here as much as at the top
    // level: python3 json.loads('{"\\u0074ype":"stale"}') is {'type': 'stale'},
    // so Django would overwrite it in place, and so does this -- leaving
    // the escaped key text alone and rewriting only the value span.
    expect(setBoundaryPropertyType('{"properties":{"\\u0074ype":"stale"}}', "b")).toBe(
      '{"properties":{"\\u0074ype":"b"}}',
    );
    // Which then normalises to the bytes Django emits.
    expect(toDjangoJsonFormat(setBoundaryPropertyType('{"properties":{"\\u0074ype":"stale"}}', "b"))).toBe(
      '{"properties": {"type": "b"}}',
    );
  });

  it("DIVERGENCE: writes the FIRST duplicate type inside properties; Python keeps the last", () => {
    // The same left-to-right/first-hit rule as the top-level duplicate-key
    // divergence on the lb path, but through the second, nested scan, which
    // is a separate call into findTopLevelKey over the properties span and
    // could have diverged on its own. python3 json.loads('{"type":1,"type":2}')
    // is {'type': 2} and the assignment would leave a dict with ONE key;
    // this rewrites the first and leaves the second sitting there, so the
    // output has two "type" keys and a JSON reader would see the stale one.
    // Documented rather than fixed -- no production row has duplicate keys.
    expect(setBoundaryPropertyType('{"properties":{"type":1,"type":2}}', "b")).toBe(
      '{"properties":{"type":"b","type":2}}',
    );
  });

  it("creates a properties object, appended last, when the stored row has none", () => {
    // Django's `boundary["properties"]["type"] = "b"` would KeyError here,
    // so there is no Django output to stay byte-identical to. The module
    // documents its choice -- insert a fresh {} and splice into it -- and
    // the insertion follows the same append-at-the-end rule as any new key.
    expect(setBoundaryPropertyType('{"type":"Feature","geometry":{"type":"Polygon"}}', "b")).toBe(
      '{"type":"Feature","geometry":{"type":"Polygon"},"properties":{"type":"b"}}',
    );
  });

  it("replaces a null or non-object properties value with a fresh object, keeping its position", () => {
    // The documented divergence: null (legal GeoJSON per RFC 7946) and any
    // other non-object value are treated exactly like "missing", rather
    // than the scanner trying to reach inside "null" as if it were a dict.
    // Django TypeErrors on both, so again there is no byte parity to hold.
    // Note the position: because "properties" is a key that already exists,
    // the replacement lands in place, BEFORE "geometry".
    expect(setBoundaryPropertyType('{"type":"Feature","properties":null,"geometry":{}}', "b")).toBe(
      '{"type":"Feature","properties":{"type":"b"},"geometry":{}}',
    );
    expect(setBoundaryPropertyType('{"properties":"not an object","geometry":{}}', "b")).toBe(
      '{"properties":{"type":"b"},"geometry":{}}',
    );
    // An ARRAY is the case most likely to trip a "is it an object?" check
    // written as `typeof === object` after a parse: the guard here is a
    // raw `text[valueStart] !== "{"`, so `[` takes the replacement path and
    // scanBalanced is never invited to walk a list as if it were a dict.
    expect(setBoundaryPropertyType('{"properties":[1,2]}', "b")).toBe('{"properties":{"type":"b"}}');
  });

  it("adds no leading comma when the stored properties object is empty", () => {
    // `{}` has no entries, so the insertion must not start with a comma --
    // `{,"type":"b"}` would be unparseable JSON served to the API.
    expect(setBoundaryPropertyType('{"properties":{}}', "b")).toBe('{"properties":{"type":"b"}}');
    // Same, but with whitespace inside the braces and around the colon, so
    // the "is it empty?" decision cannot be a `=== "{}"` string compare.
    expect(setBoundaryPropertyType('{"properties" : { } }', "b")).toBe('{"properties" : { "type":"b"} }');
  });

  it("leaves the stored row's own indentation alone, splicing only the one span", () => {
    // The module header is explicit that the two splice functions "leave
    // whatever mixed formatting the input already had" and that
    // toDjangoJsonFormat is the ONE pass that normalises -- applied later,
    // by buildGeojson.ts, over the whole assembled body. An implementation
    // that tidied as it spliced would pass every compact-input test in this
    // file and quietly do the normalising work twice. Here every newline
    // and every run of two spaces survives byte-for-byte, and the only
    // change is `,"type":"b"` appearing before the properties object's
    // closing brace.
    expect(setBoundaryPropertyType(STORED_CONSTITUENCY_PRETTY, "b")).toBe(
      '{\n  "type": "Feature",\n  "properties": {\n    "PCON24CD": "W07000041"\n  ,"type":"b"},\n' +
        '  "geometry": {\n    "coordinates": [[[-4.20000, 53.30]]]\n  }\n}',
    );
  });

  it("is idempotent: a second call updates the type it wrote, it does not duplicate it", () => {
    const once = setBoundaryPropertyType(STORED_CONSTITUENCY, "b");
    expect(setBoundaryPropertyType(once, "b")).toBe(once);
    expect(once.match(/"type":"b"/g)).toHaveLength(1);
  });

  it("strips exactly one trailing comma, like the lb path", () => {
    expect(setBoundaryPropertyType('{"properties":{"a":1}},', "b")).toBe('{"properties":{"a":1,"type":"b"}}');
  });

  it("writes the type value it is given, including empty and non-ASCII ones", () => {
    // buildGeojson.ts only ever passes the literal "b", but the value goes
    // through JSON.stringify here and pyJsonString later, and neither may
    // drop or mangle it. The empty string is the degenerate boundary; the
    // non-ASCII one proves the splice emits a RAW character that the later
    // formatting pass is responsible for escaping -- not a double escape.
    expect(setBoundaryPropertyType('{"properties":{}}', "")).toBe('{"properties":{"type":""}}');
    expect(setBoundaryPropertyType('{"properties":{}}', "Môn")).toBe('{"properties":{"type":"Môn"}}');
    expect(toDjangoJsonFormat(setBoundaryPropertyType('{"properties":{}}', "Môn"))).toBe(
      '{"properties": {"type": "M\\u00f4n"}}',
    );
  });

  it("leaves every stored coordinate digit alone", () => {
    // Same invariant as the lb path, on the far bigger payload: a
    // constituency boundary is up to 1.5 MB of coordinates, none of which
    // this function is allowed to reformat.
    expect(setBoundaryPropertyType(STORED_CONSTITUENCY, "b")).toContain("[[[-4.20000,53.30]]]");
  });

  it("throws a geojsonBoundary error on malformed stored text instead of corrupting it", () => {
    // These are the ways the scanner can fail on text Django's json.loads
    // would also have rejected. Each is pinned to its exact message rather
    // than /geojsonBoundary/, so a change that made one failure mode
    // masquerade as another would be caught -- and the first two show why
    // that matters. A string left open INSIDE a nested object never reaches
    // skipString at all: scanBalanced tracks quotes itself and runs off the
    // end of the text still inside the string, so it reports the enclosing
    // brace as unterminated. Only a string left open at the TOP level of
    // the Feature is skipString's to complain about. The two inputs differ
    // by one character of nesting and produce two different messages.
    expect(() => setBoundaryPropertyType('{"properties":{"a":"unterminated}', "b")).toThrow(
      "geojsonBoundary: unterminated {...}",
    );
    expect(() => setBoundaryPropertyType('{"properties":{"a":1},"unterminated}', "b")).toThrow(
      "geojsonBoundary: unterminated string",
    );
    expect(() => setBoundaryPropertyType("{properties:1}", "b")).toThrow("geojsonBoundary: expected a quoted key");
    expect(() => setBoundaryPropertyType('{"properties" 1}', "b")).toThrow("geojsonBoundary: expected ':' after key");
    expect(() => setBoundaryPropertyType('"a string"', "b")).toThrow("geojsonBoundary: not a JSON object");
    expect(() => setBoundaryPropertyType("", "b")).toThrow("geojsonBoundary: not a JSON object");
    expect(() => setBoundaryPropertyType("   ", "b")).toThrow("geojsonBoundary: not a JSON object");
    expect(() => setBoundaryPropertyType("[1,2]", "b")).toThrow("geojsonBoundary: not a JSON object");
  });
});

describe("toDjangoJsonFormat", () => {
  it("emits Python json.dumps's default separators", () => {
    // json.dumps defaults to separators=(', ', ': ') -- a real space after
    // every comma and colon and no other whitespace. Verified with
    // python3: json.dumps({"a":1,"b":[1,2]}) -> '{"a": 1, "b": [1, 2]}'.
    expect(toDjangoJsonFormat('{"a":1,"b":[1,2]}')).toBe('{"a": 1, "b": [1, 2]}');
    // The empty object and empty array get NO inserted space, because they
    // contain no comma or colon at all -- python3 json.dumps({}) is '{}'
    // and json.dumps({"a": {}}) is '{"a": {}}'.
    expect(toDjangoJsonFormat("{}")).toBe("{}");
    expect(toDjangoJsonFormat('{ "a" : { } }')).toBe('{"a": {}}');
  });

  it("collapses a pretty-printed stored row to the same output as a compact one", () => {
    // Stored formatting is not what the endpoint emits: some rows are
    // compact, some are multi-line indented, and Django's single
    // JsonResponse -> json.dumps pass flattens both. Two inputs that differ
    // only in whitespace must therefore come out byte-identical.
    const compact = '{"a":1,"b":[1,2]}';
    const pretty = '{\n  "a" : 1,\n  "b" : [\n    1,\n    2\n  ]\n}';
    // Pinned against the literal expected text as well as against each
    // other: `toDjangoJsonFormat(x) === toDjangoJsonFormat(y)` alone would
    // hold for a function that returned "" for everything.
    expect(toDjangoJsonFormat(pretty)).toBe('{"a": 1, "b": [1, 2]}');
    expect(toDjangoJsonFormat(pretty)).toBe(toDjangoJsonFormat(compact));
    // Whitespace BEFORE a comma/colon/brace is dropped too, not only the
    // whitespace after it that the separator rule rewrites.
    expect(toDjangoJsonFormat('  {"a": 1 , "b" : 2 }  ')).toBe('{"a": 1, "b": 2}');
    // \r and \t are JSON whitespace as much as space and \n are.
    expect(toDjangoJsonFormat('{\r\n\t"a":\t1\r\n}')).toBe('{"a": 1}');
  });

  it("only treats the four real JSON whitespace characters as whitespace", () => {
    // isJsonWs is a hand-written check against 0x20/0x09/0x0a/0x0d rather
    // than a `/\s/` test, and that is load-bearing: JS's `\s` also matches
    // U+00A0, U+2028 and the rest of Unicode Zs, none of which JSON allows
    // as structural whitespace (python3's json.loads rejects a NBSP there
    // outright). A `/\s/` rewrite would silently swallow the NBSP below
    // instead of copying it through, which is a different -- and unasked
    // for -- transformation of somebody's data. Note the scanner elsewhere
    // in this same module DOES use /[\s,]/, so the two definitions really
    // do disagree and this pins which one the formatter uses.
    expect(toDjangoJsonFormat('{"a":1, "b":2}')).toBe('{"a": 1,  "b": 2}');
  });

  it("re-escapes non-ASCII as \\uXXXX, matching ensure_ascii=True", () => {
    // The stored column holds a raw UTF-8 "ô", but the live
    // /needs/in/constituency/ynys-mon/geo.json emits it as the escape
    // sequence `Môn` -- json.dumps's ensure_ascii default.
    // JSON.stringify would pass the raw character straight through and
    // lose byte parity on every Welsh, Gaelic and Polish name in the data.
    // Both expectations below were checked against python3's json.dumps.
    expect(toDjangoJsonFormat('{"n":"Ynys Môn"}')).toBe('{"n": "Ynys M\\u00f4n"}');
    expect(toDjangoJsonFormat('{"n":"St John’s Church"}')).toBe('{"n": "St John\\u2019s Church"}');
    // Keys are strings too, and get the same treatment.
    expect(toDjangoJsonFormat('{"Môn":1}')).toBe('{"M\\u00f4n": 1}');
    // A bare top-level string is not a shape buildGeojson.ts produces, but
    // it is the smallest input that isolates the string branch from the
    // punctuation branch: python3 json.dumps("Môn") -> '"Môn"'.
    expect(toDjangoJsonFormat('"Môn"')).toBe('"M\\u00f4n"');
  });

  it("re-encodes escapes that were ALREADY escapes, rather than copying them through", () => {
    // Every test above feeds this pass a RAW non-ASCII character, so all of
    // them would still pass for an implementation that only escaped raw
    // characters and copied any existing `\uXXXX` sequence through as
    // source text. It does not: each literal is JSON.parse'd and re-emitted
    // by pyJsonString, which is exactly `json.dumps(json.loads(x))`, and
    // that normalises two things a copy-through would preserve.
    //   - HEX CASE. Python emits lower-case hex; a stored row escaped by
    //     some other encoder may not. python3
    //     json.dumps(json.loads('"\\u00F4\\u0041"')) is '"\\u00f4A"'.
    //   - REDUNDANT escapes. `A` is just "A", and Python prints it as
    //     the bare character; the same goes for the `\/` that many encoders
    //     emit and Python never does.
    expect(toDjangoJsonFormat('{"n":"\\u00F4\\u0041"}')).toBe('{"n": "\\u00f4A"}');
    expect(toDjangoJsonFormat('{"a\\/b":1}')).toBe('{"a/b": 1}');
  });

  it("escapes astral characters as a surrogate pair, like CPython", () => {
    // Walking UTF-16 code units rather than code points reproduces
    // py_encode_basestring_ascii's two-escape output for free. python3:
    // json.dumps({"a": "\U0001F600"}) -> '{"a": "\\ud83d\\ude00"}'.
    expect(toDjangoJsonFormat('{"a":"\u{1F600}"}')).toBe('{"a": "\\ud83d\\ude00"}');
    // A LONE surrogate survives as itself rather than becoming U+FFFD.
    // Python holds lone surrogates in str and json.dumps({"a": "\ud83d"})
    // emits '{"a": "\\ud83d"}'. The mutation this specific case catches is
    // an escaper that round-trips through UTF-8 bytes (TextEncoder, or
    // Buffer.from(s, "utf8")) on the way -- that substitutes U+FFFD for an
    // unpaired surrogate and corrupts the row. Code-POINT iteration is a
    // different mutation and it is the astral case above that kills it.
    expect(toDjangoJsonFormat('{"a":"\\ud83d"}')).toBe('{"a": "\\ud83d"}');
  });

  it("escapes DEL but not the forward slash, exactly where Python draws the line", () => {
    // ensure_ascii escapes everything outside 0x20..0x7e, so 0x7f IS
    // escaped; "/" is NOT (Python never escapes it), which matters because
    // every feature carries a "url" property full of slashes. An input
    // that arrives with an escaped \/ is decoded and re-emitted bare, the
    // same as json.dumps would.
    // "~" (0x7e) and DEL (0x7f) sit either side of the ensure_ascii cutoff,
    // and both are legal raw inside a JSON string literal, so this is the
    // exact boundary of the escaping rule rather than a nearby example.
    const del = ""; // a real U+007F character, not the six-character escape
    expect(toDjangoJsonFormat(`{"a":"~${del}"}`)).toBe('{"a": "~\\u007f"}');
    expect(toDjangoJsonFormat('{"u":"/needs/at/foo/"}')).toBe('{"u": "/needs/at/foo/"}');
    expect(toDjangoJsonFormat('{"u":"\\/needs\\/"}')).toBe('{"u": "/needs/"}');
  });

  it("uses Python's short escapes for the control characters that have them", () => {
    // The low end of the same cutoff. python3 json.dumps of
    // "\x00\x01\x1f\b\f" is '"\\u0000\\u0001\\u001f\\b\\f"': below 0x20
    // Python emits \uXXXX, EXCEPT for the five characters with a
    // single-letter escape (\b \f \n \r \t), which it spells the short way.
    // Getting this wrong (all-\uXXXX, or all-short) is invisible until a
    // stored ONS field contains a stray control byte and byte parity dies.
    expect(toDjangoJsonFormat('{"a":"\\u0000\\u0001\\u001f\\b\\f"}')).toBe('{"a": "\\u0000\\u0001\\u001f\\b\\f"}');
  });

  it("never reformats a number, so 51.0 does not become 51", () => {
    // The single most important property of this pass: it is punctuation
    // and strings only. Python prints a round-tripped 51.0 as "51.0";
    // JavaScript's JSON.stringify prints it as "51". A parse-based
    // implementation would pass every other test in this file and still
    // corrupt thousands of coordinates.
    expect(toDjangoJsonFormat('{"c":[51.0,-1.5,0]}')).toBe('{"c": [51.0, -1.5, 0]}');
    // Negative zero is the sharpest single case: JSON.stringify(-0) is "0",
    // losing the sign entirely, while python3 json.dumps(-0.0) is "-0.0".
    // A coordinate on the prime meridian or the equator really can be -0.0.
    expect(toDjangoJsonFormat('{"c":[-0.0,0.0]}')).toBe('{"c": [-0.0, 0.0]}');
    // Digits are copied character-for-character, which also means a stored
    // number that is NOT already in Python's repr form is passed through
    // as-is: Python would print -1.50 as -1.5 and 1e10 as 10000000000.0.
    // Pinning current behaviour -- see the note in this port's report.
    expect(toDjangoJsonFormat('{"c":[-1.50,1e10,1E+10]}')).toBe('{"c": [-1.50, 1e10, 1E+10]}');
    // The three bare literals take the same copy-through path as numbers.
    expect(toDjangoJsonFormat('{"a":null,"b":true,"c":false}')).toBe('{"a": null, "b": true, "c": false}');
    // So do Python's three NON-STANDARD literals, and here the copy-through
    // is a parity requirement rather than an accident: json.dumps emits a
    // non-finite float as bare `NaN` / `Infinity` / `-Infinity` (verified
    // with python3, and json.loads reads them straight back), while JSON
    // itself has no such tokens and JSON.parse throws on all three. Any
    // rewrite of this pass that leaned on JSON.parse would turn a stored
    // row carrying one -- a degenerate coordinate is the plausible source
    // -- from a slightly odd response into a 500.
    expect(toDjangoJsonFormat('{"c":[NaN,Infinity,-Infinity]}')).toBe('{"c": [NaN, Infinity, -Infinity]}');
  });

  it("leaves commas, colons and whitespace INSIDE string values alone", () => {
    // A food bank's address is full of commas and its opening hours full of
    // colons. If the separator pass were not string-aware it would inject a
    // space after every one of them.
    expect(toDjangoJsonFormat('{"a":"1 High St, Testville","h":"9:00-17:00"}')).toBe(
      '{"a": "1 High St, Testville", "h": "9:00-17:00"}',
    );
    // Escape sequences inside a string survive the decode/re-encode round
    // trip rather than being flattened into real whitespace -- python3
    // json.dumps({"a": "line\nbreak\ttab"}) is '{"a": "line\\nbreak\\ttab"}'.
    expect(toDjangoJsonFormat('{"a":"line\\nbreak\\ttab"}')).toBe('{"a": "line\\nbreak\\ttab"}');
    // Braces and brackets inside a string are not structure either, so they
    // cannot pull the whitespace collapse out of alignment.
    expect(toDjangoJsonFormat('{"a":"{ [ , : ] }"}')).toBe('{"a": "{ [ , : ] }"}');
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    // Whitespace outside strings is dropped wholesale, so there is nothing
    // left. Worth pinning because the function must not throw on the
    // degenerate input -- buildGeojson.ts calls it unconditionally.
    expect(toDjangoJsonFormat("")).toBe("");
    expect(toDjangoJsonFormat("   \n\t ")).toBe("");
  });

  it("is idempotent, so a body that somehow passed through twice is unchanged", () => {
    // buildGeojson.ts is careful to apply this exactly once. If a refactor
    // ever applied it twice the output must still be correct -- already
    // normalised separators and already \u-escaped strings must survive.
    const once = toDjangoJsonFormat('{"a":1,"n":"Ynys Môn","c":[51.0]}');
    // Spelled out rather than left as `f(f(x)) === f(x)`, which would also
    // hold for a function that returned its input untouched.
    expect(once).toBe('{"a": 1, "n": "Ynys M\\u00f4n", "c": [51.0]}');
    expect(toDjangoJsonFormat(once)).toBe(once);
  });

  it("throws on an unterminated string rather than emitting a truncated body", () => {
    expect(() => toDjangoJsonFormat('{"a":"oops}')).toThrow("geojsonBoundary: unterminated string");
  });

  it("surfaces a raw control character inside a string as a JSON SyntaxError, not silent output", () => {
    // A literal newline between the quotes is illegal JSON. skipString
    // happily walks past it (it only tracks escapes and quotes), so the
    // failure comes out of the JSON.parse of that literal instead -- a
    // SyntaxError, NOT one of this module's own errors. Pinned because a
    // caller catching only /geojsonBoundary/ would otherwise be surprised
    // by which of the two shapes of malformed text throws which error.
    expect(() => toDjangoJsonFormat('{"a":"x\ny"}')).toThrow(SyntaxError);
    expect(() => toDjangoJsonFormat('{"a":"x\ny"}')).not.toThrow(/geojsonBoundary/);
  });

  it("handles a boundary-sized payload without recursing or dropping digits", () => {
    // A real constituency boundary is up to 1.5 MB of coordinates, and this
    // pass walks every character of it. Both halves matter: the chunked
    // out[] accumulator must not be swapped for string concatenation in a
    // recursive walk (stack overflow on the biggest 20 or so rows), and no
    // trailing zero anywhere in those 40,000 numbers may be touched.
    const coords = Array.from({ length: 20000 }, (_, i) => `[${i}.0,${i}.50]`).join(",");
    const out = toDjangoJsonFormat(setBoundaryPropertyType(`{"geometry":{"coordinates":[${coords}]}}`, "b"));
    expect(out.startsWith('{"geometry": {"coordinates": [[0.0, 0.50], [1.0, 1.50], ')).toBe(true);
    expect(out.endsWith('[19999.0, 19999.50]]}, "properties": {"type": "b"}}')).toBe(true);
    // Every one of the 20,000 ".0" first ordinates is still there.
    expect(out.match(/\.0,/g)).toHaveLength(20000);
  });
});

describe("the assembled geo.json boundary feature", () => {
  it('produces the "b" constituency feature the live endpoint returns', () => {
    // End to end, in the order buildGeojson.ts does it: splice the type in,
    // then run the ONE formatting pass over the result. This is the byte
    // sequence the parity corpus compares -- Python separators, an escaped
    // ô, the stored ONS fields in their original order with "type" appended
    // last, and every coordinate digit exactly as it came out of D1.
    expect(toDjangoJsonFormat(setBoundaryPropertyType(STORED_CONSTITUENCY, "b"))).toBe(
      '{"type": "Feature", "properties": {"PCON24CD": "W07000041", "PCON24NM": "Ynys M\\u00f4n", "type": "b"}, ' +
        '"geometry": {"type": "Polygon", "coordinates": [[[-4.20000, 53.30]]]}}',
    );
    // The same stored row pretty-printed comes out byte-identical apart
    // from the fields it genuinely lacks: the splice leaves the indentation
    // in place and the single formatting pass removes it, which is the
    // whole reason the two responsibilities are split.
    expect(toDjangoJsonFormat(setBoundaryPropertyType(STORED_CONSTITUENCY_PRETTY, "b"))).toBe(
      '{"type": "Feature", "properties": {"PCON24CD": "W07000041", "type": "b"}, ' +
        '"geometry": {"coordinates": [[[-4.20000, 53.30]]]}}',
    );
  });

  it('produces the "lb" location feature the live endpoint returns', () => {
    // The pretty-printed stored row's indentation, and the newline the
    // append leaves sitting before the inserted comma, are both cleaned up
    // by the same single pass -- which is why the splice functions are
    // allowed to leave mixed formatting behind.
    const spliced = replaceBoundaryProperties(STORED_LOCATION_PRETTY, [
      ["type", "lb"],
      ["name", "St John’s Hall"],
      ["foodbank", "Testville"],
      ["url", "/needs/at/testville/st-johns-hall/"],
    ]);
    expect(toDjangoJsonFormat(spliced)).toBe(
      '{"type": "Feature", "geometry": {"coordinates": [51.0, -1.50]}, ' +
        '"properties": {"type": "lb", "name": "St John\\u2019s Hall", "foodbank": "Testville", ' +
        '"url": "/needs/at/testville/st-johns-hall/"}}',
    );
  });

  it("escapes quotes and backslashes in a food bank name through the whole pipeline", () => {
    // Property values are caller-supplied strings that go in via
    // JSON.stringify and come out via pyJsonString. A name containing a
    // quote or a backslash must survive both encodings and still parse.
    const out = toDjangoJsonFormat(
      replaceBoundaryProperties('{"type":"Feature"}', [["name", 'The "Old" Hall \\ Annexe']]),
    );
    expect(out).toBe('{"type": "Feature", "properties": {"name": "The \\"Old\\" Hall \\\\ Annexe"}}');
    expect(JSON.parse(out).properties.name).toBe('The "Old" Hall \\ Annexe');
  });

  it("escapes non-ASCII in a caller-supplied property KEY, not just in its value", () => {
    // buildGeojson.ts only ever passes ASCII keys, but the key path through
    // this module is JSON.stringify -> pyJsonString exactly like the value
    // path, and only the value path was covered. python3 json.dumps of
    // {"nôm": "vàl"} is '{"n\\u00f4m": "v\\u00e0l"}'.
    expect(toDjangoJsonFormat(replaceBoundaryProperties('{"type":"Feature"}', [["nôm", "vàl"]]))).toBe(
      '{"type": "Feature", "properties": {"n\\u00f4m": "v\\u00e0l"}}',
    );
  });

  it("survives a stored row that arrives with a trailing comma AND needs escaping", () => {
    // The two real-data quirks the module header records for the same
    // table -- bethnal-green-and-stepney's trailing comma and Ynys Môn's
    // raw UTF-8 byte -- have only ever been tested one at a time. They
    // arrive together in production, and the comma strip happens before
    // any of the scanning, so the combination has to work in one pass.
    expect(toDjangoJsonFormat(setBoundaryPropertyType(`${STORED_CONSTITUENCY},`, "b"))).toBe(
      '{"type": "Feature", "properties": {"PCON24CD": "W07000041", "PCON24NM": "Ynys M\\u00f4n", "type": "b"}, ' +
        '"geometry": {"type": "Polygon", "coordinates": [[[-4.20000, 53.30]]]}}',
    );
  });
});
