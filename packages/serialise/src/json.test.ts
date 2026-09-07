import { describe, expect, it } from "vitest";
import { formatJson } from "./json";
import type { SerialisableValue } from "./types";

// json.ts is the body half of gfapi2/func.py:51 --
// `JsonResponse(data, safe=False, json_dumps_params={'indent': 2})`, encoder
// `DjangoJSONEncoder`. Two very different kinds of test live here, and the
// difference matters more than any individual assertion:
//
//   1. Things the port must keep matching Django, because a consumer parses
//      them: two-space indent, `": "` after a key, dict insertion order,
//      `null` vs `""`, and above all the datetime rendering.
//   2. Things json.ts KNOWINGLY does differently, because it hands the value
//      tree to the native JSON.stringify instead of hand-rolling a byte-exact
//      encoder (see its header comment): `1.0` renders as `1`, and non-ASCII
//      is emitted as raw UTF-8 rather than Python's `\uXXXX` escapes.
//
// The second group is pinned deliberately. Those outputs look like bugs in a
// diff, so without a test that says "yes, on purpose" someone eventually
// "fixes" one of them -- and if that ever IS the decision, it should be made
// by editing a test that explains the tradeoff, not silently.
//
// A third group was added when this file was reviewed adversarially: the
// places where "structural parity" is thinner than the phrase suggests, or
// where the type signature promises something the runtime does not (a JS
// `Date`, an `undefined` return, a throw on a NULL datetime column). Those
// live at the bottom, each saying what a caller would actually see.
//
// A second adversarial pass asked a different question of each test -- "which
// plausible WRONG implementation would this catch?" -- and added the ones
// nothing here could see: that toPlainJs rebuilds rather than unwrapping the
// caller's tree in place (an in-place version produces byte-identical output
// for every other assertion in this file), that it takes a wrapper's payload
// one level deep and never walks into it, and the layout of a top-level list,
// which is the body most of the API's bytes are actually in.

// The /api/2/need/ dict literal, gfapi2/views.py:814-828 -- the shape the
// port builds in workers/site/src/routes/api2/needs.ts (needToResponseDict).
const NEED: SerialisableValue = {
  id: "1cd1e2ff-2b12-4f8c-9e4d-0c9c3b7a1f11",
  found: { __datetime: "2020-01-24 16:30:23.173268" },
  foodbank: {
    name: "Ynys Môn",
    slug: "ynys-mon",
    urls: {
      self: "https://www.givefood.org.uk/api/2/foodbank/ynys-mon/",
      html: "https://www.givefood.org.uk/needs/at/ynys-mon/",
    },
  },
  needs: "Tinned meat\nRice",
  excess: "",
  self: "https://www.givefood.org.uk/api/2/need/1cd1e2ff-2b12-4f8c-9e4d-0c9c3b7a1f11/",
};

describe("formatJson -- the layout JsonResponse(indent=2) produces", () => {
  it("lays out a real /api/2/need/ payload the way Python's json.dumps does", () => {
    // Whole-document assertion on purpose: indent width, the space after
    // each colon, the absence of a trailing comma and the nesting are one
    // contract, and a caller diffing the port against production sees them
    // as one blob. Everything here except the `Ynys Môn` line is what
    // `json.dumps(..., indent=2)` prints for the same dict (checked against
    // python3); the Môn line is the ensure_ascii divergence pinned below.
    expect(formatJson(NEED)).toBe(
      `{
  "id": "1cd1e2ff-2b12-4f8c-9e4d-0c9c3b7a1f11",
  "found": "2020-01-24T16:30:23.173",
  "foodbank": {
    "name": "Ynys Môn",
    "slug": "ynys-mon",
    "urls": {
      "self": "https://www.givefood.org.uk/api/2/foodbank/ynys-mon/",
      "html": "https://www.givefood.org.uk/needs/at/ynys-mon/"
    }
  },
  "needs": "Tinned meat\\nRice",
  "excess": "",
  "self": "https://www.givefood.org.uk/api/2/need/1cd1e2ff-2b12-4f8c-9e4d-0c9c3b7a1f11/"
}`,
    );
  });

  it("defaults to indent 2, so a caller that omits the argument still matches gfapi2", () => {
    // apiResponse() passes 2 explicitly; the default exists for everything
    // else. Asserted against the literal two-space layout rather than
    // against `formatJson(x, 2)` -- comparing the function to itself would
    // still pass if BOTH paths drifted to, say, four spaces together.
    expect(formatJson({ a: 1 })).toBe(`{\n  "a": 1\n}`);
  });

  it("treats an explicit `undefined` indent as 2 but `null` as no indent -- an easy way to ship the wrong body", () => {
    // The signature is `indent: number | null = 2` and the body does
    // `indent ?? undefined`. A default parameter fires on `undefined`, so
    // `formatJson(v, opts.indent)` with an absent `opts.indent` silently
    // INDENTS, while the documented "no indent" spelling is `null`. Those
    // two produce different response bytes from what reads like the same
    // "not specified" intent, which is exactly how a caller ships a
    // pretty-printed body where it meant a compact one.
    expect(formatJson({ a: 1 }, undefined)).toBe(`{\n  "a": 1\n}`);
    expect(formatJson({ a: 1 }, null)).toBe(`{"a":1}`);
  });

  it("collapses a zero, negative or fractional indent to no indent, and clamps above ten", () => {
    // JSON.stringify's own rules leak straight through `indent ?? undefined`:
    // the number is floored, anything below 1 means no whitespace at all,
    // and 11 is capped at 10. Nothing in /api/2/ passes these today, so the
    // point is that a future caller computing an indent (from a query param,
    // say) gets silent clamping rather than an error.
    expect(formatJson({ a: 1 }, 0)).toBe(`{"a":1}`);
    expect(formatJson({ a: 1 }, -1)).toBe(`{"a":1}`);
    expect(formatJson({ a: 1 }, 2.9)).toBe(`{\n  "a": 1\n}`);
    expect(formatJson({ a: 1 }, 11)).toBe(`{\n${" ".repeat(10)}"a": 1\n}`);
  });

  it("keeps key insertion order -- the dict literals in gfapi2/views.py ARE the contract", () => {
    // PLAN.md §7.4.2 rule 3. Python dicts preserve insertion order and
    // json.dumps does not sort by default; a sorted encoder would reorder
    // every documented response body while still being valid JSON.
    const reversed: SerialisableValue = { self: "z", excess: "y", id: "x" };
    expect(formatJson(reversed, null)).toBe(`{"self":"z","excess":"y","id":"x"}`);
  });

  it("does NOT keep insertion order for integer-like keys -- JS hoists them, Python does not", () => {
    // The limit of the rule above, and the reason it is worth stating
    // separately: `Object.keys` (and so JSON.stringify) emits array-index-like
    // keys first, in ascending numeric order, whatever order they were
    // inserted in. Python would have printed 2020 then 2019. Nothing in the
    // current /api/2/ payloads is keyed by a number, so this is a constraint
    // on future ones -- a year-keyed or id-keyed stats dict cannot be handed
    // to formatJson and expected to come back in the order it was built.
    expect(formatJson({ "2020": 1, "2019": 2, total: 3 }, null)).toBe(
      `{"2019":2,"2020":1,"total":3}`,
    );
  });

  it("puts empty containers on one line, as Python's indent mode does", () => {
    // PLAN.md §7.4.2 rule 2. `/api/2/foodbank/<slug>/` carries empty
    // `locations` and `nearby_foodbanks` arrays for a lot of rows, so this
    // is the common case, not an edge case.
    expect(formatJson({ locations: [], urls: {} })).toBe(
      `{
  "locations": [],
  "urls": {}
}`,
    );
  });

  it("indents a top-level list, which is the body every /api/2/ list endpoint ships", () => {
    // The other whole-document assertion, and the higher-traffic one: the
    // detail endpoints return a dict (pinned above) but /api/2/foodbanks/,
    // /api/2/needs/ and /api/2/locations/ all return `response_list` through
    // `JsonResponse(..., safe=False, indent=2)`, so THIS is the layout most
    // bytes the API serves are in. The existing list tests all pass
    // `null`, which never exercises indent's interaction with array
    // elements -- the elements' opening brace sitting on its own line at two
    // spaces, and their contents at four.
    expect(
      formatJson([
        { name: "A", urls: {}, found: { __datetime: "2020-01-24 16:30:23.173268" } },
        { name: "B", urls: {}, found: null },
      ]),
    ).toBe(
      `[
  {
    "name": "A",
    "urls": {},
    "found": "2020-01-24T16:30:23.173"
  },
  {
    "name": "B",
    "urls": {},
    "found": null
  }
]`,
    );
    // An empty list endpoint (a constituency with no foodbanks) is still
    // two characters, not a newline-wrapped pair of brackets.
    expect(formatJson([])).toBe("[]");
  });

  it("indents cumulatively, two spaces per level", () => {
    expect(formatJson({ a: { b: [1] } })).toBe(
      `{
  "a": {
    "b": [
      1
    ]
  }
}`,
    );
  });

  it("never conflates null with the empty string", () => {
    // PLAN.md §7.4.2 rule 6. `excess` is "" for most needs and NULL for
    // some; a client rendering "no excess items" branches on which.
    expect(formatJson({ excess: null, needs: "" }, null)).toBe(`{"excess":null,"needs":""}`);
  });

  it("escapes what JSON escapes and leaves `/` alone", () => {
    // PLAN.md §7.4.2 rule 1 spells out that `/` is NOT escaped -- worth
    // pinning because every url in these payloads is full of slashes, and
    // an encoder that escaped them (some do, for HTML-embedding safety)
    // would change every single response body.
    expect(formatJson("https://www.givefood.org.uk/needs/at/ynys-mon/", null)).toBe(
      `"https://www.givefood.org.uk/needs/at/ynys-mon/"`,
    );
    expect(formatJson('quote" back\\slash\ttab\nnewline', null)).toBe(
      `"quote\\" back\\\\slash\\ttab\\nnewline"`,
    );
    // KEYS are escaped by the same rules as values. Only interesting because
    // json.ts's header names "a hand-written encoder" as the road not taken:
    // the usual way that rewrite goes wrong is to escape values properly and
    // build key strings by concatenation, which produces invalid JSON that no
    // structural test catches (both documents fail to parse, so a parse-based
    // assertion never runs). Reachable via the admin list endpoints, where a
    // scraped foodbank name can end up as a dict key.
    expect(formatJson({ 'a"b\nc': 1 }, null)).toBe(`{"a\\"b\\nc":1}`);
  });

  it("escapes C0 control characters the same way Python does, and leaves DEL raw like Python does", () => {
    // Reachable: `change_text` is scraped from foodbank web pages, and a
    // stray \r or \x0b from a CMS paste ends up in the column. This is one
    // of the few string-level places the port and Django AGREE -- both use
    // the short forms for \b \f \n \r \t and \uXXXX for the rest of
    // 0x00-0x1f -- so an "improvement" here would be a real divergence
    // rather than another accepted one. DEL (0x7f) is ASCII, so Python's
    // ensure_ascii leaves it alone too; it is here to stop someone
    // "tightening" the escaping to everything above 0x7e.
    expect(formatJson("a\u0000b\u0007c\bd\fe\rf\u001fg\u007f", null)).toBe(
      `"a\\u0000b\\u0007c\\bd\\fe\\rf\\u001fg\u007f"`,
    );
  });

  it("carries a 16-digit legacy Datastore id through as written, and cannot save one past 2^53", () => {
    // PLAN.md §7.4.2's note on integers: foodbank.id reaches
    // 6,755,286,043,852,800 -- 75% of Number.MAX_SAFE_INTEGER. The first
    // assertion is the live case: the id must survive as digits, not become
    // 6.7552860438528e+15.
    expect(formatJson({ id: 6755286043852800 }, null)).toBe(`{"id":6755286043852800}`);
    // The second is the honest limit of the first. formatJson receives a JS
    // `number`, so an id past 2^53 has ALREADY lost its last digit by the
    // time it gets here -- 9007199254740993 arrives as ...992 and is
    // re-emitted, wrong, without a throw. If ids ever cross that line the
    // fix is upstream (read the column as a string), not in this function,
    // and no assertion here can warn about it.
    expect(formatJson({ id: 9007199254740993 }, null)).toBe(`{"id":9007199254740992}`);
    // And the fix that comment recommends has exactly one spelling. A BigInt
    // is the other obvious way to carry an id past 2^53, and it does not
    // reach the response at all -- JSON.stringify throws TypeError on one, so
    // the whole endpoint 500s rather than losing a digit. Read the column as
    // a STRING, as the comment says, not as a BigInt.
    const bigintId = { id: 9007199254740993n } as unknown as SerialisableValue;
    expect(() => formatJson(bigintId, null)).toThrow(TypeError);
  });

  it("accepts a bare list at the top level, as safe=False allows", () => {
    // gfapi2 passes `response_list` (a plain Python list) to JsonResponse
    // with safe=False for every list endpoint. A serialiser that required
    // an object at the root would break /api/2/needs/ and /api/2/foodbanks/.
    expect(formatJson([], null)).toBe("[]");
    expect(formatJson([{ id: 1 }, { id: 2 }], null)).toBe(`[{"id":1},{"id":2}]`);
    expect(formatJson(null, null)).toBe("null");
    expect(formatJson(true, null)).toBe("true");
    expect(formatJson(false, null)).toBe("false");
    expect(formatJson(0, null)).toBe("0");
    expect(formatJson("needs", null)).toBe(`"needs"`);
    // The empty string is a JSON document too -- `excess` is "" on most
    // rows, and /api/2/need/<id>/excess-style scalars go out bare.
    expect(formatJson("", null)).toBe(`""`);
  });

  it("emits nothing but whitespace-free JSON when indent is null", () => {
    // NOTE a divergence, in case this path is ever wired to gfapi1/gfapi3
    // (which call JsonResponse with no indent, PLAN.md §7.4.2): Python's
    // no-indent default separators are `(', ', ': ')`, i.e.
    // `{"a": 1, "b": 2}` WITH spaces, where JSON.stringify emits none. No
    // caller passes null today -- apiResponse() always passes 2 -- so this
    // records what the argument does, not a shape any endpoint ships.
    expect(formatJson({ a: 1, b: [2, 3] }, null)).toBe(`{"a":1,"b":[2,3]}`);
  });

  it("renders a 1,000-row list whole, which is the payload json.ts's header is designed around", () => {
    // json.ts justifies leaning on the native JSON.stringify with
    // "/api/2/foodbanks/, 1000+ rows ... a real consideration for a Worker's
    // CPU-ms budget". This is the corresponding correctness check: nothing
    // is truncated, the recursive unwrap reaches every row, and every
    // datetime in the list is formatted rather than the first one only.
    const rows: SerialisableValue = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      created: { __datetime: `2020-01-24 16:30:${String(i % 60).padStart(2, "0")}.173268` },
    }));
    const out = formatJson(rows, null);
    const parsed = JSON.parse(out) as { id: number; created: string }[];
    expect(parsed).toHaveLength(1000);
    expect(parsed[0]!.created).toBe("2020-01-24T16:30:00.173");
    expect(parsed[999]!.created).toBe("2020-01-24T16:30:39.173");
    // A wrapper that leaked would still parse as JSON, so assert on the text.
    expect(out).not.toContain("__datetime");
  });
});

describe("formatJson -- datetimes (DjangoJSONEncoder)", () => {
  it("renders both raw D1 shapes identically, which is the whole point of the wrapper", () => {
    // pyDatetime.ts's header: D1 holds two formats at once -- ETL rows from
    // Postgres carry Python's str(datetime), rows the port writes carry
    // toISOString(). 114 of 34,175 foodbankchange rows were already in the
    // second shape when this was found by diffing beta against production.
    // A pass-through would hand an API consumer a different shape for a
    // need found yesterday than for one found in 2020, on one endpoint.
    const fromEtl = formatJson({ found: { __datetime: "2020-01-24 16:30:23.173268" } }, null);
    const fromPort = formatJson({ found: { __datetime: "2020-01-24T16:30:23.173268Z" } }, null);
    expect(fromEtl).toBe(`{"found":"2020-01-24T16:30:23.173"}`);
    expect(fromPort).toBe(fromEtl);
  });

  it("uses the three-digit DjangoJSONEncoder rendering, not the six-digit or str() one", () => {
    // The single assertion that says WHICH of pyDatetime.ts's three
    // formatters json.ts wired up. All three accept the same input and only
    // differ in the separator and the digit count (PLAN.md §7.4.6's table),
    // so an import swapped to formatIsoDatetime (-> .173268) or
    // formatPyStrDatetime (-> a space separator) would still produce
    // plausible-looking output on every other test in this file.
    const out = formatJson({ found: { __datetime: "2020-01-24 16:30:23.173268" } }, null);
    expect(out).toBe(`{"found":"2020-01-24T16:30:23.173"}`);
    expect(out).not.toContain("173268"); // formatIsoDatetime
    expect(out).not.toContain("2020-01-24 16:30"); // formatPyStrDatetime
  });

  it("truncates the fraction to three digits rather than rounding it", () => {
    // DjangoJSONEncoder.default() does `r = o.isoformat(); r[:23] + r[26:]`
    // -- a slice, never a rounding. .173999 must stay .173; a "tidier"
    // implementation using toFixed(3) would say .174 and every timestamp in
    // the API would move by up to a millisecond.
    expect(formatJson({ found: { __datetime: "2020-01-24 16:30:23.173999" } }, null)).toBe(
      `{"found":"2020-01-24T16:30:23.173"}`,
    );
    expect(formatJson({ found: { __datetime: "2020-01-24 16:30:23.999999" } }, null)).toBe(
      `{"found":"2020-01-24T16:30:23.999"}`,
    );
  });

  it("reads a short fraction as Python does -- .17 is 170 milliseconds, not 17", () => {
    // `.17` in an isoformat string means 170000 microseconds, so
    // pyDatetime.ts right-pads to six digits before slicing to three. Get
    // this wrong (slice the raw digits) and `.17` ships as `.17`, a tenfold
    // error in the sub-second field and a string Python would never print.
    // The port's own toISOString() rows always carry three digits, but ETL
    // rows carry whatever Postgres trimmed, so short fractions are real.
    expect(formatJson({ found: { __datetime: "2020-01-24 16:30:23.17" } }, null)).toBe(
      `{"found":"2020-01-24T16:30:23.170"}`,
    );
    expect(formatJson({ found: { __datetime: "2020-01-24 16:30:23.1" } }, null)).toBe(
      `{"found":"2020-01-24T16:30:23.100"}`,
    );
  });

  it("still prints .000 for a nonzero microsecond that rounds below a millisecond", () => {
    // The exception to "microsecond 0 prints nothing": .000100 is not zero,
    // so Python emits a fraction, and the three-digit slice of it is "000".
    // A shortcut implementation that dropped the fraction whenever the first
    // three digits were zeros would lose the distinction between a timestamp
    // Django writes as `...23` and one it writes as `...23.000`.
    expect(formatJson({ found: { __datetime: "2020-01-24 16:30:23.000100" } }, null)).toBe(
      `{"found":"2020-01-24T16:30:23.000"}`,
    );
  });

  it("drops the fractional part entirely when the microsecond field is zero", () => {
    // Python prints no fraction at microsecond 0 rather than ".000" --
    // reproduced deliberately (pyDatetime.ts). Note this is the OPPOSITE
    // choice from packages/models/pyDatetime.ts, which pads to six zeros so
    // its D1 column sorts lexicographically. Two modules, two jobs.
    expect(formatJson({ found: { __datetime: "2020-01-24 16:30:23" } }, null)).toBe(
      `{"found":"2020-01-24T16:30:23"}`,
    );
    expect(formatJson({ found: { __datetime: "2020-01-24 16:30:23.000000" } }, null)).toBe(
      `{"found":"2020-01-24T16:30:23"}`,
    );
  });

  it("drops a trailing Z or offset instead of converting the clock time", () => {
    // USE_TZ = False: every Django datetime here is naive UTC, so a stored
    // offset is noise to be stripped, not a timezone to shift by. A parser
    // that converted +05:00 would move `found` five hours and make
    // "needs found today" wrong for exactly the rows the ETL touched.
    expect(formatJson({ found: { __datetime: "2020-01-24T16:30:23.173268+05:00" } }, null)).toBe(
      `{"found":"2020-01-24T16:30:23.173"}`,
    );
    // The offset-without-colon and negative-offset spellings the regex also
    // accepts, so a row written by a different client is stripped too.
    expect(formatJson({ found: { __datetime: "2020-01-24T16:30:23.173268-0800" } }, null)).toBe(
      `{"found":"2020-01-24T16:30:23.173"}`,
    );
  });

  it("reshapes the string without ever going through a JS Date", () => {
    // The strongest guard this file has against a Date-based rewrite, and
    // the one that does not depend on the suite's TZ being pinned to UTC.
    // `new Date("2020-01-24 25:00:00")` either rolls over to the 25th or is
    // Invalid; `new Date("2020-13-45 ...")` is Invalid outright. A pure
    // string reshaper passes the nonsense through in the target shape, which
    // is what a naive-UTC port must do -- the moment a Date appears in this
    // path, every space-separated ETL row starts being read in the local
    // zone and the whole API shifts by the developer's offset.
    expect(formatJson({ found: { __datetime: "2020-01-24 25:00:00" } }, null)).toBe(
      `{"found":"2020-01-24T25:00:00"}`,
    );
    expect(formatJson({ found: { __datetime: "2020-13-45 16:30:23.173268" } }, null)).toBe(
      `{"found":"2020-13-45T16:30:23.173"}`,
    );
  });

  it("passes an unparseable datetime through unchanged instead of throwing", () => {
    // pyDatetime.ts states the invariant: "one odd row must not 500 a
    // 1,000-row list". The bad value degrades to the pre-fix output and the
    // other 999 rows still render -- so assert the whole list survives, not
    // just that the one call returns.
    const list: SerialisableValue = [
      { found: { __datetime: "not a date" } },
      { found: { __datetime: "" } },
      { found: { __datetime: "2020-01-24" } }, // a date with no time is NOT parseable here
      // Seven fractional digits fail the whole regex (it allows one to six),
      // so a row with extra precision degrades to raw rather than being
      // silently truncated to a different instant.
      { found: { __datetime: "2020-01-24 16:30:23.1234567" } },
      { found: { __datetime: "2020-01-24 16:30:23.173268" } },
    ];
    expect(() => formatJson(list, null)).not.toThrow();
    expect(formatJson(list, null)).toBe(
      `[{"found":"not a date"},{"found":""},{"found":"2020-01-24"},` +
        `{"found":"2020-01-24 16:30:23.1234567"},{"found":"2020-01-24T16:30:23.173"}]`,
    );
  });

  it("trims surrounding whitespace on the way IN but not on the way out", () => {
    // parsePyDatetime does `RAW_RE.exec(raw.trim())` but the degrade path
    // returns `raw`, not the trimmed string -- so padding is invisible on a
    // parseable value and survives into the response body on an unparseable
    // one. Reachable: the ETL copies text columns verbatim, and a padded cell
    // is the classic thing a spreadsheet-sourced import carries.
    //
    // Both halves matter and they fail in opposite directions. Drop the
    // .trim() and the first assertion breaks (a padded good row degrades to
    // raw). Add a .trim() to the degrade path and the second breaks -- which
    // would be an improvement, and should therefore be a deliberate edit here
    // rather than a silent one.
    expect(formatJson({ found: { __datetime: "  2020-01-24 16:30:23.173268  " } }, null)).toBe(
      `{"found":"2020-01-24T16:30:23.173"}`,
    );
    expect(formatJson({ found: { __datetime: "  nope  " } }, null)).toBe(`{"found":"  nope  "}`);
  });

  it("formats every datetime in the tree, however deeply nested", () => {
    // /api/2/foodbank/<slug>/ carries datetimes at three depths at once
    // (foodbank.created, needs[].created, nearby_foodbanks[].need.found).
    // A recursion bug that only handled top-level values would leak the raw
    // wrapper object into the response as {"__datetime": "..."} -- which
    // parses fine, so nothing downstream would fail loudly.
    const nested: SerialisableValue = {
      created: { __datetime: "2020-01-24 16:30:23.173268" },
      needs: [{ found: { __datetime: "2026-09-05T15:21:42.853Z" } }],
      nearby: [[{ found: { __datetime: "2021-02-03 04:05:06.700000" } }]],
    };
    const out = formatJson(nested, null);
    expect(out).toBe(
      `{"created":"2020-01-24T16:30:23.173","needs":[{"found":"2026-09-05T15:21:42.853"}],` +
        `"nearby":[[{"found":"2021-02-03T04:05:06.700"}]]}`,
    );
    expect(out).not.toContain("__datetime");
  });
});

describe("formatJson -- the structural-parity tradeoffs, pinned on purpose", () => {
  it("unwraps a __float to a plain number, so 1.0 ships as 1 (Python ships 1.0)", () => {
    // json.ts's header names this as the accepted cost of using the native
    // JSON.stringify. csv.ts still renders the same wrapper through
    // formatFloat() because CSV stayed byte-exact -- so the wrapper is not
    // dead weight, and a reader who sees `1` here should not "fix" the
    // producer into emitting a plain number instead.
    expect(formatJson({ lat: { __float: 1.0 }, lng: { __float: 1.5 } }, null)).toBe(
      `{"lat":1,"lng":1.5}`,
    );
    // Unwrapped, not stringified: formatFloat() returns a STRING ("1.5",
    // "0.0"), so a version of toPlainJs that reached for it would quote
    // every coordinate and every consumer doing arithmetic on lat/lng would
    // start concatenating instead.
    expect(formatJson({ lat: { __float: 0 } }, null)).toBe(`{"lat":0}`);
  });

  it("does not round the number it unwraps", () => {
    // A real Ordnance Survey-derived latitude, kept at full precision. The
    // rounding helpers live next door in float.ts (round2 for distance_mi,
    // pyRound for the geo.json feeds) and are applied by the CALLER; if one
    // of them were ever pulled into toPlainJs "for consistency", every
    // coordinate in /api/2/ would quietly move by up to half a metre and
    // this is the assertion that would say so.
    expect(formatJson({ lat: { __float: 51.50735012345 } }, null)).toBe(
      `{"lat":51.50735012345}`,
    );
  });

  it("prints the shortest round-tripping form, which matches Python's repr except in the exponent", () => {
    // Both languages print the shortest decimal that reads back as the same
    // double, so the ugly ones agree exactly: 0.1 + 0.2 is
    // 0.30000000000000004 in json.dumps and here, and an implementation
    // "tidied up" with toFixed/toPrecision would round it and lose the
    // round-trip property that makes the API's coordinates reproducible.
    expect(formatJson({ d: { __float: 0.1 + 0.2 } }, null)).toBe(`{"d":0.30000000000000004}`);
    // Where they part company is the exponent, and only there. json.dumps
    // uses C's two-digit exponent (`5e-07`, `1e-07`); JS emits `5e-7`. Both
    // are valid JSON and parse to the same double, so this belongs with the
    // other structural-parity divergences rather than in the bug column --
    // it is recorded because a byte-diff against production will show it and
    // it should not send anyone looking for a rounding error. Above 1e20 the
    // two agree (`1e+21`), which is why only the negative case differs.
    expect(formatJson({ d: { __float: 5e-7 } }, null)).toBe(`{"d":5e-7}`); // Python: 5e-07
    expect(formatJson({ d: { __float: 1e21 } }, null)).toBe(`{"d":1e+21}`); // Python: 1e+21
    // The boundary where JS switches to exponent notation, pinned because a
    // rounded distance_mi never reaches it but a raw metres-to-miles
    // intermediate could: 1e-6 still prints as decimal digits, 1e-7 does not.
    expect(formatJson({ d: { __float: 0.000001 } }, null)).toBe(`{"d":0.000001}`);
    expect(formatJson({ d: { __float: 0.0000001 } }, null)).toBe(`{"d":1e-7}`);
  });

  it("loses the sign of negative zero, which formatFloat() would have kept", () => {
    // formatFloat(-0) is "-0.0"; JSON.stringify(-0) is "0". Reachable from
    // a rounded distance or a coordinate of exactly -0.0 -- the Greenwich
    // meridian runs through the UK, so a rounded longitude of -0.00002 is a
    // real row, not a contrived one.
    expect(formatJson({ distance: { __float: -0 } }, null)).toBe(`{"distance":0}`);
  });

  it("emits raw UTF-8 where Django's ensure_ascii=True emitted \\uXXXX", () => {
    // PLAN.md §7.4.2 rule 1: json.dumps escapes every codepoint outside
    // 0x20..0x7e, so production returns `Ynys Môn` and `St John’s`
    // as literal backslash-u sequences. This is the one real byte-level
    // difference in /api/2/ responses; both documents parse to the same
    // values, which is what "structural parity" bought.
    //
    // packages/serialise/src/pyJsonString.ts is the byte-exact encoder,
    // used by the geo.json endpoints that PLAN.md holds to strict
    // byte-equality -- if this module ever has to match too, that is the
    // function to reach for rather than a fresh one.
    expect(formatJson("Ynys Môn", null)).toBe(`"Ynys Môn"`);
    expect(formatJson("St John’s", null)).toBe(`"St John’s"`);
    expect(formatJson({ "Pentre-dŵr": "Eilean Leòdhais" }, null)).toBe(
      `{"Pentre-dŵr":"Eilean Leòdhais"}`,
    );
    // Astral-plane characters go out as the raw surrogate pair, one
    // character not two escapes -- foodbank names scraped from Facebook do
    // carry emoji. Python would have written 🙏.
    expect(formatJson("Trussell \u{1F64F}", null)).toBe(`"Trussell \u{1F64F}"`);
    // NEITHER encoder normalises, and that is the half of this behaviour the
    // ensure_ascii difference leaves alone. A name scraped from a
    // macOS-authored page arrives DECOMPOSED (o + U+0302 combining
    // circumflex) and ships as the two codepoints it was given -- Django
    // writes `Mo\u0302n`, this writes the raw pair -- so a client matching
    // the API's `name` against a locally stored precomposed "Môn" misses
    // against either API, and the two spellings are different JSON documents
    // that look identical in every diff and terminal. Written with \u
    // escapes rather than accented literals so that an editor or git filter
    // normalising this file cannot quietly turn the test into a tautology.
    expect(formatJson("M\u00f4n", null)).toBe(`"M\u00f4n"`);
    expect(formatJson("Mo\u0302n", null)).toBe(`"Mo\u0302n"`);
    expect(formatJson("Mo\u0302n", null)).not.toBe(formatJson("M\u00f4n", null));
    // Four codepoints out, not the three a normalising encoder would emit.
    expect(JSON.parse(formatJson("Mo\u0302n", null))).toHaveLength(4);
  });

  it("escapes a LONE surrogate, which is the one place the two encoders agree on \\uXXXX", () => {
    // A truncated UTF-16 string (a name cut mid-emoji by a fixed-width
    // column) cannot be written as raw UTF-8 at all, so JSON.stringify falls
    // back to the escape -- and it is well-formed since ES2019, meaning the
    // output is always valid UTF-8 and R2/CDN caching of the body is safe.
    // Python's ensure_ascii writes exactly the same six characters, so this
    // is parity rather than another divergence.
    expect(formatJson("cut\uD83D", null)).toBe(`"cut\\ud83d"`);
  });

  it("turns NaN and both infinities into null, where Python emitted the bare words", () => {
    // json.dumps(float('nan')) writes `NaN` -- invalid JSON that many
    // clients reject. JSON.stringify writes null instead, so a NaN latitude
    // becomes a silently missing value here rather than a parse error
    // there. Neither is right; pin which one this is. -Infinity is included
    // because formatFloat() spells it "-Infinity" and a reader comparing
    // the two modules will look for it.
    expect(
      formatJson({ lat: NaN, lng: Infinity, alt: -Infinity, d: { __float: NaN } }, null),
    ).toBe(`{"lat":null,"lng":null,"alt":null,"d":null}`);
  });

  it("drops an undefined property instead of writing null", () => {
    // Not reachable through SerialisableValue's type, but very reachable in
    // practice: a D1 row that lacks a column yields undefined, and
    // JSON.stringify omits the key entirely. Django would have sent
    // `"excess": null` for the same None, so a client doing
    // `"excess" in need` sees a different answer. Cast, because the type
    // says this cannot happen and the runtime says otherwise.
    const withUndefined = { id: "x", excess: undefined } as unknown as SerialisableValue;
    expect(formatJson(withUndefined, null)).toBe(`{"id":"x"}`);
    // Inside a list the same value becomes null rather than vanishing,
    // because dropping it would change the list's length.
    expect(formatJson([undefined] as unknown as SerialisableValue, null)).toBe(`[null]`);
  });

  it("returns the value `undefined`, not a string, when the whole document is undefined", () => {
    // The return type says `string`. JSON.stringify(undefined) is undefined,
    // and nothing here guards it, so `new Response(formatJson(data))` would
    // send an empty body with a JSON content-type rather than failing.
    // Reachable from a route that forgot to await, or from a `.find()` that
    // matched nothing. Pinned so the type lie is at least written down.
    expect(formatJson(undefined as unknown as SerialisableValue, null)).toBeUndefined();
    // Same hole one level in: a wrapper whose payload is undefined unwraps
    // to undefined and takes the whole document with it.
    expect(
      formatJson({ __float: undefined } as unknown as SerialisableValue, null),
    ).toBeUndefined();
  });

  it("renders a JS Date as `{}` -- types.ts says a datetime is never carried as a Date, and this is why", () => {
    // types.ts: "a datetime is carried as the RAW D1 column string in a
    // wrapper, never a JS `Date`". A Date reaches toPlainJs's plain-object
    // branch, and `Object.keys(date)` is empty, so the value silently
    // becomes an empty object. Note that bare JSON.stringify would have
    // produced a usable ISO string here -- passing a Date is strictly worse
    // than not using this module at all, and it fails silently, which is
    // exactly the failure a producer writing `{ created: row.created }`
    // instead of `{ created: { __datetime: row.created } }` would hit if the
    // column were ever mapped to a Date.
    expect(formatJson({ created: new Date(0) } as unknown as SerialisableValue, null)).toBe(
      `{"created":{}}`,
    );
  });

  it("throws on a NULL datetime column instead of degrading it", () => {
    // The limit of pyDatetime.ts's "one odd row must not 500 a 1,000-row
    // list": that promise covers an unparseable STRING. A NULL column
    // arrives as `{ __datetime: null }` -- the key is present, so
    // isDatetimeValue() says yes, and formatDjangoJsonDatetime calls
    // .trim() on null. FoodbankChangeRow types `created` as non-null and
    // mapNeedRow does not validate it, so this is the runtime behaviour if
    // that ever stops being true, and it takes the whole response with it
    // rather than one row. Documented, not fixed -- see the report.
    expect(() =>
      formatJson({ found: { __datetime: null } } as unknown as SerialisableValue, null),
    ).toThrow(TypeError);
    expect(() =>
      formatJson({ found: { __datetime: undefined } } as unknown as SerialisableValue, null),
    ).toThrow(TypeError);
    // Any non-string payload goes the same way, because the throw is
    // `raw.trim is not a function` inside parsePyDatetime rather than
    // anything datetime-shaped -- a producer that handed over a JS Date or a
    // unix timestamp gets a 500, not a wrong date.
    expect(() =>
      formatJson({ found: { __datetime: 1579883423 } } as unknown as SerialisableValue, null),
    ).toThrow(TypeError);
    // The __float wrapper does NOT behave this way, and the asymmetry is the
    // point: `latitude` is a nullable column too, and `{ __float: null }`
    // sails through as `null` (JSON.stringify's treatment of the unwrapped
    // value). So the same NULL, in the same row, is a silent null in one
    // wrapper and a dead response in the other. Whichever of the two is
    // right, they should not differ by accident.
    expect(formatJson({ lat: { __float: null } } as unknown as SerialisableValue, null)).toBe(
      `{"lat":null}`,
    );
  });

  it("unwraps a __float without coercing it, so a pre-formatted float ships quoted", () => {
    // toPlainJs returns `v.__float` untouched. float.ts's formatFloat()
    // returns a STRING ("51.5", "0.0"), so a producer that reached for it
    // before wrapping -- the natural mistake, since csv.ts and xml.ts DO
    // render the wrapper through formatFloat -- puts a quoted number in the
    // JSON body. That parses, so every downstream consumer keeps working
    // until one of them does arithmetic on lat/lng and starts concatenating.
    // Nothing here validates the payload; the type is the only guard.
    expect(formatJson({ lat: { __float: "51.5" } } as unknown as SerialisableValue, null)).toBe(
      `{"lat":"51.5"}`,
    );
  });

  it("blows the stack on a circular tree rather than reporting the cycle", () => {
    // The cost of the toPlainJs pre-pass, and worth knowing before debugging
    // one at 3am: bare JSON.stringify detects a cycle and throws a TypeError
    // that names it ("Converting circular structure to JSON"), but toPlainJs
    // recurses first and dies with a RangeError whose message says nothing
    // about the data. Reachable from a hand-built response tree that links a
    // foodbank back to one of its own nearby_foodbanks entries.
    const cyclic: Record<string, unknown> = { name: "Ynys Mon" };
    cyclic.self = cyclic;
    expect(() => formatJson(cyclic as SerialisableValue, null)).toThrow(RangeError);
    // What the caller would have got without this module, for contrast.
    expect(() => JSON.stringify(cyclic)).toThrow(TypeError);
  });
});

describe("formatJson -- wrapper detection", () => {
  it("treats any object carrying a __float key as a float wrapper and discards its siblings", () => {
    // isFloatValue() (types.ts) tests only for the key's presence, so a
    // response dict that happened to contain a "__float" field would
    // collapse to that number and lose everything else. Nothing in the
    // gfapi2 payloads uses a double-underscore key, which is why the cheap
    // check is safe -- this test is the tripwire if that ever changes.
    expect(formatJson({ __float: 1.5, name: "Ynys Môn" }, null)).toBe("1.5");
  });

  it("does the same for __datetime, discarding siblings rather than merging them", () => {
    // The matching tripwire for isDatetimeValue(). Both guards are
    // presence-only checks, so both lose data on a collision; a reader who
    // has only seen the __float case should not assume the datetime branch
    // is more careful.
    expect(formatJson({ __datetime: "2020-01-24 16:30:23", source: "etl" }, null)).toBe(
      `"2020-01-24T16:30:23"`,
    );
  });

  it("checks __float before __datetime when a value somehow carries both", () => {
    // Documents the order of the checks in toPlainJs, so a refactor that
    // reorders them has to change a test rather than quietly changing which
    // branch wins.
    expect(formatJson({ __float: 3, __datetime: "2020-01-24 16:30:23" }, null)).toBe("3");
  });

  it("renders a bare wrapper at the top level, not only as a property value", () => {
    // apiResponse() hands formatJson whatever the view built; nothing
    // guarantees that is a dict.
    expect(formatJson({ __datetime: "2020-01-24 16:30:23.173268" }, null)).toBe(
      `"2020-01-24T16:30:23.173"`,
    );
    expect(formatJson({ __float: 2.5 }, null)).toBe("2.5");
  });

  it("checks arrays before wrappers, so a list is never mistaken for one", () => {
    // `Array.isArray` is tested first in toPlainJs and again inside both
    // type guards. Belt and braces, but the failure it prevents is ugly: an
    // array is an object, and `"__float" in []` is false only because arrays
    // do not carry that key -- the ordering is what makes the guard's own
    // check redundant rather than load-bearing.
    expect(formatJson([{ __float: 1.5 }, { __datetime: "2020-01-24 16:30:23" }], null)).toBe(
      `[1.5,"2020-01-24T16:30:23"]`,
    );
  });

  it("leaves the caller's value tree untouched -- it rebuilds, it does not unwrap in place", () => {
    // THE test this file was missing. toPlainJs allocates a new object at
    // every level (`const out = {}`) and a new array (`v.map`), so the tree
    // the caller built is still wrapped afterwards. The obvious "why allocate
    // twice?" optimisation --
    //
    //     for (const k of Object.keys(v)) v[k] = toPlainJs(v[k]); return v;
    //
    // -- produces byte-identical output for every other assertion in this
    // file, so nothing else here would go red. What it breaks is a tree that
    // is read again after being serialised: types.ts says xml.ts and csv.ts
    // render the SAME __float wrapper through full float formatting, so a
    // tree flattened by a JSON render would come out of a later XML render as
    // `1` instead of `1.0` -- a byte-parity failure in the one format PLAN.md
    // still holds to byte-exactness, caused by a function that had already
    // returned. Assert on the input, not the output; the output cannot see it.
    const tree: SerialisableValue = {
      lat: { __float: 1.0 },
      found: { __datetime: "2020-01-24 16:30:23.173268" },
      rows: [{ lng: { __float: -0.1275 } }],
    };
    formatJson(tree, null);
    formatJson(tree, 2); // twice, since an in-place unwrap is idempotent and would survive one call
    // Compared against a literal rather than a copy taken before the call: a
    // shallow copy (`{ ...tree }`) shares the nested objects and would be
    // flattened alongside the original, quietly passing. The literal also
    // states the shape a producer is expected to hand over.
    expect(tree).toEqual({
      lat: { __float: 1 },
      found: { __datetime: "2020-01-24 16:30:23.173268" },
      rows: [{ lng: { __float: -0.1275 } }],
    });
  });

  it("takes a wrapper's payload as-is and never walks INTO it", () => {
    // The honest limit of this file's `not.toContain("__datetime")` guards.
    // toPlainJs returns `v.__float` / the formatted datetime directly -- no
    // recursive call -- so anything nested inside a wrapper's payload is
    // handed to JSON.stringify unprocessed. A double-wrapped float (easy to
    // write when a helper already wraps and the caller wraps again) leaks the
    // literal `__float` key into the response, and a datetime nested under a
    // float wrapper leaks the raw D1 string in whichever of its two shapes
    // that row happened to carry -- the exact bug pyDatetime.ts exists to
    // stop. Both parse as valid JSON, so nothing downstream fails loudly.
    const doubleWrapped = { lat: { __float: { __float: 1.5 } } } as unknown as SerialisableValue;
    expect(formatJson(doubleWrapped, null)).toBe(`{"lat":{"__float":1.5}}`);

    const datetimeUnderFloat = {
      lat: { __float: { d: { __datetime: "2020-01-24 16:30:23" } } },
    } as unknown as SerialisableValue;
    expect(formatJson(datetimeUnderFloat, null)).toBe(
      `{"lat":{"d":{"__datetime":"2020-01-24 16:30:23"}}}`,
    );
  });

  it("leaves a plain object with ordinary keys alone", () => {
    // The negative case for the two guards above: an ordinary nested dict
    // must not be mistaken for a wrapper and collapsed.
    expect(formatJson({ urls: { self: "/a/", html: "/b/" } }, null)).toBe(
      `{"urls":{"self":"/a/","html":"/b/"}}`,
    );
    // An empty object has neither key and must survive as `{}`, not vanish
    // -- `/api/2/foodbank/<slug>/` ships empty `urls` sub-objects.
    expect(formatJson({ urls: {} }, null)).toBe(`{"urls":{}}`);
  });
});
