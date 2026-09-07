import { Absent, parse as buildXml } from "js2xmlparser";
import { describe, expect, it } from "vitest";
import { formatFloat } from "./float"; // not under test -- imported to check xml.ts's divergence FROM it
import { formatXml, xmlItemName } from "./xml";

// What this module can and cannot break, and therefore what is worth testing.
//
// js2xmlparser owns the XML string; xml.ts owns two things only, and both are
// invisible in a diff if they regress:
//
//   1. WHICH SINGULAR TAG wraps each list's items -- domain knowledge ported
//      from `xml_item_name()` in gfapi2/func.py:66-75, including the missing
//      `donationpoints` entry that PLAN.md §7.3 freezes as bug B1. A helpful
//      "let's complete the map" edit silently changes a public API response.
//   2. FOUR RESHAPES that work around js2xmlparser quirks (null, empty array,
//      per-item tag names, datetimes). Most look like pointless ceremony
//      until you see the output without them, so the quirks are asserted
//      against the real library below -- if a js2xmlparser upgrade ever
//      stops needing a workaround, those tests fail and say so, rather than
//      the workaround quietly becoming a lie in a comment. (The empty-array
//      one is the exception: it is redundant while the item-name pre-wrap
//      exists. Explained where it is asserted, so nobody re-derives it.)
//   3. TWO HOLES in those reshapes, pinned as current behaviour rather than
//      fixed: a null that comes OUT of a __float wrapper never reaches the
//      Absent swap, and a null __datetime throws instead of degrading. Both
//      are latent -- every wrapped column is NOT NULL today -- and both are
//      one nullable column away from being live, so they are asserted here
//      to be a known quantity rather than an outage.
//
// Parity here is STRUCTURAL, not byte-exact (PLAN.md §7.4.3): the declaration
// quoting and the indent character differ from dicttoxml + minidom on purpose.
// Where the plan's property table states a behaviour that IS reproduced --
// `<None>`, self-closing null, six-digit datetimes, raw newlines, insertion
// key order -- the tests below cite it and assert that behaviour.

describe("xmlItemName", () => {
  it("maps every plural that gfapi2/func.py's `singular` dict maps", () => {
    // Read straight off gfapi2/func.py:68-74. These five strings are the
    // API contract for element names inside every list-bearing response;
    // getting one wrong (e.g. "constituencies" -> "constituencie") breaks
    // consumers' XPath without breaking any request.
    expect(xmlItemName("foodbanks")).toBe("foodbank");
    expect(xmlItemName("nearby_foodbanks")).toBe("foodbank");
    expect(xmlItemName("locations")).toBe("location");
    expect(xmlItemName("needs")).toBe("need");
    expect(xmlItemName("constituencies")).toBe("constituency");
  });

  it("returns 'None' for donationpoints -- frozen bug B1, do not fix", () => {
    // Django's `singular.get(plural)` returns Python's None for an unmapped
    // key and dicttoxml stringifies it into the tag, so the live API really
    // does emit <None>. PLAN.md §7.3 B1 pins it on two endpoints:
    // /api/2/donationpoints/search/?format=xml and the nested donationpoints
    // key of /api/2/foodbank/<slug>/?format=xml. If someone "completes" the
    // SINGULAR map, this test is the thing that stops it shipping.
    expect(xmlItemName("donationpoints")).toBe("None");
  });

  it("falls back to 'None' for anything else, including the empty string", () => {
    // The fallback is not donationpoints-specific: any future response key
    // holding a list inherits <None> until someone adds it to SINGULAR.
    expect(xmlItemName("foodbank")).toBe("None"); // singular, never a list key
    expect(xmlItemName("prices")).toBe("None");
    expect(xmlItemName("")).toBe("None");
    // Looked up by EXACT key, the way Python's `singular.get(plural)` is.
    // Case-folding or trimming would be a plausible "make it robust" edit
    // that quietly resolves a near-miss key into a real singular name -- and
    // since the whole point of this map is to preserve B1, a near miss must
    // land on <None> rather than being helpfully repaired.
    expect(xmlItemName("Foodbanks")).toBe("None");
    expect(xmlItemName("FOODBANKS")).toBe("None");
    expect(xmlItemName(" foodbanks")).toBe("None");
    expect(xmlItemName("foodbanks ")).toBe("None");
  });

  it("leaks Object.prototype members instead of falling back to 'None'", () => {
    // NOT a desirable behaviour -- pinned because it is the CURRENT one and
    // fixing it is a source change. SINGULAR is a plain object literal, so
    // `SINGULAR[key]` finds inherited members for a handful of key names and
    // `?? "None"` never fires. Django's dict.get() returns None for these.
    // Reported as a suspected bug rather than fixed here; see the throw it
    // causes in the formatXml suite below.
    expect(typeof xmlItemName("toString")).toBe("function");
    expect(typeof xmlItemName("constructor")).toBe("function");
    expect(typeof xmlItemName("valueOf")).toBe("function");
    expect(typeof xmlItemName("hasOwnProperty")).toBe("function");
    expect(xmlItemName("__proto__")).toBe(Object.prototype);
  });
});

describe("formatXml -- list endpoints (a top-level array)", () => {
  it("wraps each item of a top-level array in the root tag's singular name", () => {
    // gfapi2's list views pass `response_list` (a bare Python list) into
    // ApiResponse with custom_root=obj_name; dicttoxml then names each item
    // with item_func(obj_name). This is the whole-response shape for
    // /api/2/foodbanks/search/?format=xml, so assert it end to end.
    expect(
      formatXml("foodbanks", [
        { name: "One", slug: "one" },
        { name: "Two", slug: "two" },
      ]),
    ).toBe(
      "<?xml version='1.0'?>\n" +
        "<foodbanks>\n" +
        "    <foodbank>\n" +
        "        <name>One</name>\n" +
        "        <slug>one</slug>\n" +
        "    </foodbank>\n" +
        "    <foodbank>\n" +
        "        <name>Two</name>\n" +
        "        <slug>two</slug>\n" +
        "    </foodbank>\n" +
        "</foodbanks>",
    );
  });

  it("names top-level donationpoints items <None> too, not just nested ones", () => {
    // B1's first endpoint: /api/2/donationpoints/search/?format=xml passes a
    // top-level list whose root tag is the unmapped plural, so the bug has to
    // survive the array branch of formatXml as well as the object branch.
    expect(formatXml("donationpoints", [{ name: "Tesco Metro" }])).toBe(
      "<?xml version='1.0'?>\n" +
        "<donationpoints>\n" +
        "    <None>\n" +
        "        <name>Tesco Metro</name>\n" +
        "    </None>\n" +
        "</donationpoints>",
    );
  });

  it("wraps bare scalars in the item tag, not just objects", () => {
    expect(formatXml("needs", ["Beans", "Pasta"])).toBe(
      "<?xml version='1.0'?>\n<needs>\n    <need>Beans</need>\n    <need>Pasta</need>\n</needs>",
    );
  });

  it("renders an empty result list as a self-closing root, never a crash", () => {
    // A search with no hits is an ordinary response, not an error. The empty
    // array collapses through the item-wrap into an empty payload, which
    // js2xmlparser self-closes.
    expect(formatXml("foodbanks", [])).toBe("<?xml version='1.0'?>\n<foodbanks/>");
  });

  it("renders every objName apiResponse.ts can pass, with the right item tag", () => {
    // The nine keys of ALLOWED_FORMATS in workers/site/src/lib/apiResponse.ts
    // are the complete set of root tags that can ever reach here, and the
    // rootTag is the ONE argument that can make formatXml throw (see the
    // malformed-input suite). Walking the real table catches both halves in
    // one go: every live objName is a legal XML name, and the four singular
    // roots -- which no other test exercises, because they carry an object
    // rather than a list -- come out named after themselves.
    // The four singular roots are asserted as WHOLE documents rather than
    // with toContain("<foodbank>"): an implementation that also item-wrapped
    // a keyed object would emit <foodbank><None><name>x</name></None></...>
    // and still contain the root tag, so a containment check would pass a
    // response no consumer could read.
    const bare = (root: string) => `<?xml version='1.0'?>\n<${root}>\n    <name>x</name>\n</${root}>`;
    expect(formatXml("foodbank", { name: "x" })).toBe(bare("foodbank"));
    expect(formatXml("location", { name: "x" })).toBe(bare("location"));
    expect(formatXml("need", { name: "x" })).toBe(bare("need"));
    expect(formatXml("constituency", { name: "x" })).toBe(bare("constituency"));
    expect(formatXml("foodbanks", [{ name: "x" }])).toContain("<foodbanks>\n    <foodbank>");
    expect(formatXml("locations", [{ name: "x" }])).toContain("<locations>\n    <location>");
    expect(formatXml("needs", [{ name: "x" }])).toContain("<needs>\n    <need>");
    expect(formatXml("constituencies", [{ name: "x" }])).toContain("<constituencies>\n    <constituency>");
    expect(formatXml("donationpoints", [{ name: "x" }])).toContain("<donationpoints>\n    <None>");
  });

  it("produces exactly the shape the same array nested under a key produces", () => {
    // formatXml's header states this as fact -- a top-level list "wraps each
    // item in item_func(objName) directly under the root, THE SAME SHAPE a
    // nested array under a key produces". It is the justification for one
    // function serving both the list and detail endpoints, and it is only
    // true while formatXml's array branch and transformObject's array branch
    // agree. Nothing else in this file compares them, so a change to one
    // alone (say, dropping the empty-array recode) would leave every other
    // test green while the two endpoint families diverged.
    const rows = [
      { name: "One", needs: ["Beans"] },
      { name: "Two", needs: [] },
    ];
    const topLevel = formatXml("foodbanks", rows).split("\n").slice(1).join("\n");
    const nested = formatXml("root", { foodbanks: rows })
      .split("\n")
      .slice(2, -1) // drop the declaration, <root> and </root>
      .map((line) => line.slice(4)) // and one level of indent
      .join("\n");
    expect(nested).toBe(topLevel);
    // Anchored to the literal expected shape as well, so the comparison
    // cannot pass by both branches being broken in the same direction.
    expect(topLevel).toBe(
      "<foodbanks>\n" +
        "    <foodbank>\n" +
        "        <name>One</name>\n" +
        "        <needs>\n" +
        "            <need>Beans</need>\n" +
        "        </needs>\n" +
        "    </foodbank>\n" +
        "    <foodbank>\n" +
        "        <name>Two</name>\n" +
        "        <needs/>\n" +
        "    </foodbank>\n" +
        "</foodbanks>",
    );
    // The empty list agrees too, which is NOT obvious: the top-level branch
    // has no `val.length === 0 ? {}` recode at all, so its empty array is
    // dropped by js2xmlparser and the ROOT self-closes, while the keyed
    // branch keeps the key and self-closes the CHILD. Two code paths, same
    // rendering of "a search with no hits".
    expect(formatXml("foodbanks", [])).toBe("<?xml version='1.0'?>\n<foodbanks/>");
    expect(formatXml("root", { foodbanks: [] })).toBe("<?xml version='1.0'?>\n<root>\n    <foodbanks/>\n</root>");
  });

  it("formats a full-size list without dropping, truncating or merging rows", () => {
    // 1,000 rows is the size this module's comments and pyDatetime.ts's keep
    // citing (/api/2/needs/ genuinely returns thousands), and every other
    // fixture here is two or three items. transformValue recurses once per
    // node and the document is built entirely in memory, so pin the real
    // list size: a change that truncated, de-duplicated by key, or blew the
    // stack would be invisible in every small-fixture test above.
    const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `fb-${i}` }));
    const xml = formatXml("foodbanks", rows);
    expect(xml.split("<foodbank>").length - 1).toBe(1000);
    expect(xml).toContain("<name>fb-0</name>");
    expect(xml).toContain("<name>fb-999</name>");
  });
});

describe("formatXml -- detail endpoints (a keyed object)", () => {
  it("names nested list items from their OWN key, not the root tag", () => {
    // /api/2/foodbank/<slug>/?format=xml: the root is `foodbank` but the
    // nested `locations` list must still be named `location`. Passing the
    // root tag down instead of each parent key would produce
    // <locations><foodbank>..., which is the failure this pins.
    expect(formatXml("foodbank", { name: "Trussell", locations: [{ name: "Main hall" }] })).toBe(
      "<?xml version='1.0'?>\n" +
        "<foodbank>\n" +
        "    <name>Trussell</name>\n" +
        "    <locations>\n" +
        "        <location>\n" +
        "            <name>Main hall</name>\n" +
        "        </location>\n" +
        "    </locations>\n" +
        "</foodbank>",
    );
  });

  it("keeps naming items by key at any depth, so deep lists are not <None>", () => {
    // Three levels of the real /api/2/foodbank/<slug>/ tree: a `needs` list
    // nested inside a `nearby_foodbanks` list inside `locations`. Two things
    // at once -- transformValue must recurse (a shallow implementation would
    // only look up top-level keys and emit <None> deeper down), and
    // `nearby_foodbanks` must map to `foodbank`, the one entry in SINGULAR
    // whose plural and singular do not share a stem.
    expect(formatXml("foodbank", { locations: [{ nearby_foodbanks: [{ needs: ["Beans"] }] }] })).toBe(
      "<?xml version='1.0'?>\n" +
        "<foodbank>\n" +
        "    <locations>\n" +
        "        <location>\n" +
        "            <nearby_foodbanks>\n" +
        "                <foodbank>\n" +
        "                    <needs>\n" +
        "                        <need>Beans</need>\n" +
        "                    </needs>\n" +
        "                </foodbank>\n" +
        "            </nearby_foodbanks>\n" +
        "        </location>\n" +
        "    </locations>\n" +
        "</foodbank>",
    );
  });

  it("emits <None> for the nested donationpoints key -- B1's second endpoint", () => {
    // PLAN.md §7.3 names both call sites; the nested one is easy to miss
    // because the root tag here is `foodbank`, which IS in the map.
    expect(formatXml("foodbank", { donationpoints: [{ name: "Tesco Metro" }] })).toBe(
      "<?xml version='1.0'?>\n" +
        "<foodbank>\n" +
        "    <donationpoints>\n" +
        "        <None>\n" +
        "            <name>Tesco Metro</name>\n" +
        "        </None>\n" +
        "    </donationpoints>\n" +
        "</foodbank>",
    );
  });

  it("preserves dict insertion order at every level rather than sorting keys", () => {
    // PLAN.md §7.4.3: "Key order | dict insertion order". YAML is the one
    // format that sorts (§7.4.4) -- if that ever leaks into XML, every field
    // in every response moves. Both levels here are in an order no sort
    // (ascending or descending) would produce, and the whole document is
    // asserted so a sort applied only to the nested object is caught too.
    expect(
      formatXml("foodbank", { name: "Z", address: "Y", country: "X", place: { town: "T", county: "C" } }),
    ).toBe(
      "<?xml version='1.0'?>\n" +
        "<foodbank>\n" +
        "    <name>Z</name>\n" +
        "    <address>Y</address>\n" +
        "    <country>X</country>\n" +
        "    <place>\n" +
        "        <town>T</town>\n" +
        "        <county>C</county>\n" +
        "    </place>\n" +
        "</foodbank>",
    );
  });

  it("cannot leak JS's integer-key reordering, because such keys throw first", () => {
    // The one case where Object.keys() does NOT give insertion order: an
    // integer-like key is hoisted to the front in ascending numeric order,
    // where Python's dict would have kept it where it was put. That
    // divergence is unreachable in practice -- an XML name may not start
    // with a digit, so js2xmlparser rejects the key outright rather than
    // emitting it in the wrong place. Asserted so the insertion-order claim
    // above can be read as unconditional.
    expect(() => formatXml("foodbank", { "10": "a", name: "x", "2": "b" })).toThrow(/element name "2"/);
  });

  it("renders an object with no keys as a self-closing root", () => {
    expect(formatXml("foodbank", {})).toBe("<?xml version='1.0'?>\n<foodbank/>");
  });
});

describe("formatXml -- null, empty and the js2xmlparser quirks it works around", () => {
  it("self-closes null AND empty string identically", () => {
    // PLAN.md §7.4.3: "Null and empty string | self-closing, no space ... both
    // None and "" render identically, so the null/empty distinction is
    // already lost in XML". Reproduced, not repaired -- consumers of the live
    // API cannot tell the two apart today either.
    expect(formatXml("foodbank", { html_attributions: null, phone: "" })).toBe(
      "<?xml version='1.0'?>\n<foodbank>\n    <html_attributions/>\n    <phone/>\n</foodbank>",
    );
  });

  it("would print the literal text 'null' without the Absent.instance swap", () => {
    // The workaround is invisible in the output, so assert the raw library
    // behaviour it exists for. If a js2xmlparser upgrade starts self-closing
    // null on its own, this fails and the swap can be reconsidered
    // deliberately -- rather than the comment above it going stale unnoticed.
    expect(buildXml("foodbank", { html_attributions: null })).toContain("<html_attributions>null</html_attributions>");
    expect(buildXml("foodbank", { html_attributions: Absent.instance })).toContain("<html_attributions/>");
  });

  it("self-closes a null INSIDE a list, not just a null field", () => {
    // The Absent swap lives in transformValue, which array items go through
    // too -- a version that swapped only in transformObject's non-array
    // branch would put the literal text "null" inside <need>/<location>
    // elements and pass every other test in this file.
    expect(formatXml("needs", [null, "Beans"])).toBe(
      "<?xml version='1.0'?>\n<needs>\n    <need/>\n    <need>Beans</need>\n</needs>",
    );
    expect(formatXml("foodbank", { locations: [null] })).toContain("<location/>");
  });

  it("keeps an empty list's key in the output as a self-closing element", () => {
    // An "open food bank with no locations yet" must still carry a
    // <locations/> element: a consumer reading data["locations"] should get an
    // empty collection, not a missing field.
    expect(formatXml("foodbank", { name: "New", locations: [] })).toBe(
      "<?xml version='1.0'?>\n<foodbank>\n    <name>New</name>\n    <locations/>\n</foodbank>",
    );
    // The recode must reach objects INSIDE a list too, not only the top-level
    // dict -- a location with no needs of its own still carries <needs/>.
    // transformObject is the only place the recode lives, so this is what
    // proves list items are routed back through it rather than emitted raw.
    expect(formatXml("foodbank", { locations: [{ needs: [] }] })).toContain(
      "<location>\n            <needs/>\n        </location>",
    );
  });

  it("would DROP an empty list's key if it ever reached the library BARE", () => {
    // The quirk the header comment describes, asserted against the real
    // library: a bare empty array vanishes (not even a self-closing tag)
    // while an empty object self-closes.
    const raw = buildXml("foodbank", { locations: [], name: "New" });
    expect(raw).not.toContain("locations");
    expect(buildXml("foodbank", { locations: {} })).toContain("<locations/>");
    // BUT the module never hands the library a bare array: the item-name
    // pre-wrap runs first, and `{ locations: { location: [] } }` ALSO
    // self-closes, because the inner empty array renders nothing and leaves
    // <locations> childless. So `val.length === 0 ? {}` in transformObject is
    // belt-and-braces, not the thing keeping the key -- deleting it leaves
    // every output in this file byte-identical (verified by mutation). Worth
    // knowing before "restoring" it in a refactor that drops the pre-wrap:
    // it is the pre-wrap OR the recode that is load-bearing, never neither.
    expect(buildXml("foodbank", { locations: { location: [] } })).toContain("<locations/>");
  });

  it("would use the PARENT key as every item's tag without the pre-wrap", () => {
    // The third quirk from the header comment: js2xmlparser has no per-array
    // item-name option, so a bare array repeats the parent key. The
    // `{ [itemName(key)]: [...] }` pre-wrap is what turns that into the
    // container + singular-item shape dicttoxml's item_func produces.
    expect(buildXml("foodbank", { locations: [{ n: 1 }] })).toContain("<locations>\n        <n>1</n>\n    </locations>");
    expect(buildXml("foodbank", { locations: { location: [{ n: 1 }] } })).toContain("<location>");
  });
});

describe("formatXml -- value formatting", () => {
  it("renders a datetime as isoformat() with six microsecond digits", () => {
    // PLAN.md §7.4.3: "Datetimes | isoformat() with six microsecond digits".
    // dicttoxml calls isoformat() on the datetime, so the separator is 'T'
    // and the fraction is not truncated to three the way DjangoJSONEncoder
    // truncates it for JSON -- the same instant, a different rendering.
    expect(formatXml("need", { created: { __datetime: "2020-11-27 09:55:57.877123" } })).toBe(
      "<?xml version='1.0'?>\n<need>\n    <created>2020-11-27T09:55:57.877123</created>\n</need>",
    );
  });

  it("normalises a JS-written D1 row to the same six-digit shape", () => {
    // D1 holds two shapes in one column: ETL rows in Python's str(datetime)
    // and port-written rows in toISOString(). Both must leave here looking
    // like Python's isoformat(), or an API consumer sees a different format
    // for a recent need than for an old one on the same endpoint.
    expect(formatXml("need", { created: { __datetime: "2026-09-05T15:21:42.853Z" } })).toBe(
      "<?xml version='1.0'?>\n<need>\n    <created>2026-09-05T15:21:42.853000</created>\n</need>",
    );
    // Django ran USE_TZ=False with TZ pinned to UTC, so pyDatetime.ts DROPS a
    // trailing offset rather than converting the wall time. A version that
    // shifted by the offset would move 16:30 to 15:30 on the wire for any row
    // an offset-aware exporter ever writes.
    expect(formatXml("need", { created: { __datetime: "2020-01-24 16:30:23.173268+01:00" } })).toContain(
      "<created>2020-01-24T16:30:23.173268</created>",
    );
  });

  it("omits the fraction entirely when the microsecond field is zero", () => {
    // Python prints no fractional part at all at microsecond 0. Padding to
    // .000000 here would be a visible wire change on every whole-second row.
    expect(formatXml("need", { created: { __datetime: "2020-01-24 16:30:23" } })).toContain(
      "<created>2020-01-24T16:30:23</created>",
    );
  });

  it("passes an unparseable datetime through rather than throwing", () => {
    // formatIsoDatetime returns the raw string when it cannot parse, on
    // purpose: one odd row out of a 1,000-row list must not 500 the response.
    expect(formatXml("need", { created: { __datetime: "sometime last tuesday" } })).toContain(
      "<created>sometime last tuesday</created>",
    );
    // An empty datetime column takes the same path and then self-closes --
    // indistinguishable on the wire from a NULL created column, which is the
    // same conflation PLAN.md §7.4.3 documents for null vs "".
    expect(formatXml("need", { created: { __datetime: "" } })).toContain("<created/>");
  });

  it("unwraps wrappers inside a list, not only wrappers held under a key", () => {
    // Array items go through transformValue too. A version whose array branch
    // mapped items straight into the payload would hand js2xmlparser the raw
    // { __datetime } / { __float } objects, and every item in a `needs` list
    // would come out as a <__datetime> sub-element -- a shape change no
    // object-level datetime test above would notice.
    expect(formatXml("foodbank", { needs: [{ __datetime: "2020-01-24 16:30:23.173268" }, { __float: 1 }] })).toBe(
      "<?xml version='1.0'?>\n" +
        "<foodbank>\n" +
        "    <needs>\n" +
        "        <need>2020-01-24T16:30:23.173268</need>\n" +
        "        <need>1</need>\n" +
        "    </needs>\n" +
        "</foodbank>",
    );
  });

  it("lets __float win over __datetime, and drops any sibling key on a wrapper", () => {
    // types.ts detects both wrappers by KEY PRESENCE (`"__float" in v`), not
    // by shape, and transformValue checks __float first. Two consequences
    // that only bite an object carrying more than the wrapper key: an object
    // with both renders as the float, and a real field sitting alongside a
    // wrapper VANISHES instead of becoming a sub-element -- silently, with no
    // error to notice. yaml.ts checks in the same order and yaml.test.ts pins
    // the same pair; asserted here so the two writers cannot drift apart, and
    // so a row-mapper that tacks metadata onto a wrapper fails loudly here.
    expect(
      formatXml("need", { a: { __float: 1.5, __datetime: "2020-01-24 16:30:23" } as unknown as { __float: number } }),
    ).toBe("<?xml version='1.0'?>\n<need>\n    <a>1.5</a>\n</need>");
    expect(
      formatXml("need", { a: { __datetime: "2020-01-24 16:30:23", note: "x" } as unknown as { __datetime: string } }),
    ).toBe("<?xml version='1.0'?>\n<need>\n    <a>2020-01-24T16:30:23</a>\n</need>");
    expect(formatXml("need", { a: { __float: 2.5, note: "x" } as unknown as { __float: number } })).toBe(
      "<?xml version='1.0'?>\n<need>\n    <a>2.5</a>\n</need>",
    );
  });

  it("does NOT apply the Absent swap to a null that comes out of a wrapper", () => {
    // A hole in the null workaround, pinned rather than fixed. transformValue
    // swaps a BARE null for Absent.instance on its first line, but a wrapper
    // is unwrapped afterwards and whatever comes out is returned as-is -- so
    // `{ __float: null }` puts the literal text "null" on the wire where a
    // bare null self-closes. Latent, not live: every column wrapped this way
    // is `created TEXT NOT NULL` in packages/db/migrations/0001_core.sql, so
    // no response builds one today. Reported as a suspected bug.
    expect(formatXml("foodbank", { lat: { __float: null } as unknown as { __float: number } })).toBe(
      "<?xml version='1.0'?>\n<foodbank>\n    <lat>null</lat>\n</foodbank>",
    );
    expect(formatXml("foodbank", { lat: null })).toContain("<lat/>"); // the bare null, for contrast
  });

  it("throws on a NULL datetime column -- the limit of the never-500 promise", () => {
    // The test above pins pyDatetime's "an unparseable value is returned
    // unchanged rather than thrown on ... one odd row must not 500 a
    // 1,000-row list" for the string "sometime last tuesday". That promise
    // covers STRINGS only: formatIsoDatetime opens with raw.trim(), so a
    // { __datetime: null } out of a NULL column takes down the ENTIRE
    // response, which is precisely the failure mode the promise exists to
    // prevent. Latent today -- every wrapped column (needs.ts:38,
    // foodbanks.ts:73, locations.ts:340, donationpoints.ts:297) is NOT NULL
    // and each nullable one is guarded by a caller-side `if` -- so this is
    // pinned as a known hole, not fixed. Reported as a suspected bug.
    expect(() => formatXml("need", { created: { __datetime: null } as unknown as { __datetime: string } })).toThrow(
      TypeError,
    );
    expect(() => formatXml("need", { created: { __datetime: null } as unknown as { __datetime: string } })).toThrow(
      /trim/,
    );
  });

  it("unwraps a __float to a plain number, losing the .0 (accepted tradeoff)", () => {
    // float.ts's header: json/xml/yaml unwrap the wrapper to a plain JS
    // number, and only csv.ts renders it through formatFloat. So Python's
    // `1.0` reaches the wire as `1` here. Pinned because it is a knowing
    // structural-parity divergence, not an oversight -- note that types.ts
    // still claims XML is byte-exact, which this contradicts.
    expect(formatXml("foodbank", { lat: { __float: 51.5 }, whole: { __float: 1 } })).toBe(
      "<?xml version='1.0'?>\n<foodbank>\n    <lat>51.5</lat>\n    <whole>1</whole>\n</foodbank>",
    );
  });

  it("diverges from formatFloat at the three edges float.ts verified", () => {
    // The `1` above hides how far the unwrap goes, so pin the edges float.ts
    // says it checked against dicttoxml 1.7.16's real output: Python writes
    // "-0.0", "1e-07" (two-digit exponent) and "NaN"; String(number) here
    // writes "0" (sign gone), "1e-7" (one digit) and "NaN". Two of the three
    // differ. Reachable from a rounded distance_mi of -0.0 and from any tiny
    // computed float. Pinned as the current, deliberate behaviour -- routing
    // __float through formatFloat would be a wire change on every latitude,
    // so it must be a decision, not a drive-by tidy-up.
    const xml = formatXml("foodbank", { d: { __float: -0 }, tiny: { __float: 1e-7 }, n: { __float: NaN } });
    expect(xml).toBe(
      "<?xml version='1.0'?>\n<foodbank>\n    <d>0</d>\n    <tiny>1e-7</tiny>\n    <n>NaN</n>\n</foodbank>",
    );
    expect(xml).not.toContain("-0.0");
    expect(xml).not.toContain("1e-07");
  });

  it("agrees with formatFloat on the infinities and NaN, and only on those", () => {
    // The test above says xml.ts's unwrap "diverges from formatFloat", quoting
    // three literals. Asserted against the REAL formatFloat here, because a
    // hard-coded literal cannot notice float.ts moving underneath it, and
    // because the divergence is not uniform: -0 and 1e-7 differ, NaN and the
    // infinities happen to coincide. The coincidence is what makes an
    // infinity dangerous to reason about -- it looks like proof that the two
    // paths agree. (float.ts's header lists the edges it verified against
    // dicttoxml 1.7.16; the infinities are NOT on that list, so neither
    // spelling here is evidence of what Django actually sent.)
    expect(formatXml("foodbank", { d: { __float: Infinity }, e: { __float: -Infinity } })).toBe(
      "<?xml version='1.0'?>\n<foodbank>\n    <d>Infinity</d>\n    <e>-Infinity</e>\n</foodbank>",
    );
    // Agreeing: the two infinities, NaN, and any value String() already
    // renders with a decimal point.
    for (const agreeing of [Infinity, -Infinity, NaN, 51.5, -0.25]) {
      expect(formatXml("foodbank", { v: { __float: agreeing } })).toContain(`<v>${formatFloat(agreeing)}</v>`);
    }
    // Differing: -0, the exponent edges, and -- the one that hits real data
    // on every response -- every WHOLE number, where formatFloat appends the
    // ".0" that Python prints and the unwrap does not.
    for (const differing of [-0, 1e-7, 1e16, 1, 52]) {
      expect(formatXml("foodbank", { v: { __float: differing } })).not.toContain(`<v>${formatFloat(differing)}</v>`);
    }
    // The plain-number branch of transformValue is a DIFFERENT line of code
    // from the __float branch, and the two must agree -- neither is allowed
    // to start routing through float.ts's formatFloat on its own, which would
    // give one of them "inf" / "-0.0" and leave the other as it is.
    expect(formatXml("foodbank", { d: Infinity, e: -Infinity, n: NaN, z: -0 })).toBe(
      "<?xml version='1.0'?>\n" +
        "<foodbank>\n" +
        "    <d>Infinity</d>\n" +
        "    <e>-Infinity</e>\n" +
        "    <n>NaN</n>\n" +
        "    <z>0</z>\n" +
        "</foodbank>",
    );
  });

  it("renders booleans lowercase, and 0/false distinctly from null", () => {
    // PLAN.md §7.4.3: "Booleans | lowercase true / false" -- Python's
    // str(True) would give "True", so this is dicttoxml's own lowercasing.
    // The falsy-but-present values must NOT collapse into self-closing tags.
    expect(formatXml("foodbank", { is_closed: false, delivery: true, count: 0 })).toBe(
      "<?xml version='1.0'?>\n" +
        "<foodbank>\n" +
        "    <is_closed>false</is_closed>\n" +
        "    <delivery>true</delivery>\n" +
        "    <count>0</count>\n" +
        "</foodbank>",
    );
  });

  it("emits newlines inside text raw and un-indented", () => {
    // PLAN.md §7.4.3: "Newlines inside text | emitted raw and un-indented ...
    // Every needs/excess field is multi-line, so this affects essentially
    // every XML response". A pretty-printer that indented the continuation
    // would change the VALUE consumers parse, not just the whitespace.
    expect(formatXml("foodbank", { needs: "Beans\nPasta\nRice" })).toBe(
      "<?xml version='1.0'?>\n<foodbank>\n    <needs>Beans\nPasta\nRice</needs>\n</foodbank>",
    );
  });

  it("escapes the characters that would otherwise break the document", () => {
    // Food bank names really do contain "&" ("Trussell & District"), and
    // needs text is user-entered. An unescaped & or < produces XML that no
    // parser will accept -- a whole-response failure, not a cosmetic one.
    expect(formatXml("foodbank", { name: 'A & B <c> "d"' })).toContain("<name>A &amp; B &lt;c> \"d\"</name>");
    // An & that was ALREADY an entity is escaped again, so scraped need text
    // holding "&amp;" survives a round trip as the four characters it is.
    // Python's dicttoxml escape() does exactly the same.
    expect(formatXml("foodbank", { name: "Fish &amp; Chips" })).toContain("<name>Fish &amp;amp; Chips</name>");
    // A bare ">" and a bare apostrophe stay raw (both are legal in character
    // data), but ">" IS escaped when it would close a CDATA section -- worth
    // knowing before writing a byte-comparison against Django's output.
    expect(formatXml("foodbank", { name: "O'Brien > all" })).toContain("<name>O'Brien > all</name>");
    expect(formatXml("foodbank", { name: "]]> hmm" })).toContain("<name>]]&gt; hmm</name>");
  });

  it("passes non-ASCII through as raw UTF-8, astral characters included", () => {
    // Welsh and Polish food bank names, and the 19 translation languages.
    // Numeric character references would still parse but would not match the
    // bytes Django sends. The emoji is a surrogate pair in JS, so it also
    // proves nothing here walks the string by UTF-16 code unit and splits it.
    expect(formatXml("foodbank", { name: "Caffi Cymraeg 日本語 Żółć 🍞" })).toContain(
      "<name>Caffi Cymraeg 日本語 Żółć 🍞</name>",
    );
  });

  it("writes a legacy Datastore id exactly, with no exponent or rounding", () => {
    // PLAN.md §7.4.2's note on integers: foodbank.id reaches
    // 6,755,286,043,852,800 -- 75% of Number.MAX_SAFE_INTEGER. Ids are opaque
    // keys; a lossy rendering here makes them un-lookupable.
    const xml = formatXml("foodbank", { id: 6755286043852800 });
    expect(xml).toContain("<id>6755286043852800</id>");
    expect(xml).not.toMatch(/e[+-]/); // no exponent form anywhere in the document
    // Where the cliff actually is, for the record: String(number) switches to
    // exponent notation at 1e21, far above any id the Datastore ever minted.
    expect(formatXml("foodbank", { id: 1e21 })).toContain("<id>1e+21</id>");
  });
});

describe("formatXml -- the itemName parameter", () => {
  it("defaults to xmlItemName, so callers get the B1 map for free", () => {
    // apiResponse.ts calls formatXml(objName, data) with two arguments only.
    // A default of `() => "None"`, or one that named items after the root tag,
    // would still produce valid XML -- so assert the mapped tag itself, and
    // that the two-argument call really is the three-argument one.
    const twoArg = formatXml("foodbanks", [{ n: 1 }]);
    expect(twoArg).toBe(
      "<?xml version='1.0'?>\n<foodbanks>\n    <foodbank>\n        <n>1</n>\n    </foodbank>\n</foodbanks>",
    );
    expect(twoArg).not.toContain("<None>");
    expect(twoArg).toBe(formatXml("foodbanks", [{ n: 1 }], xmlItemName));
    // And on the NESTED keys, which is where the default earns its keep:
    // apiResponse.ts passes objName and nothing else, so every inner list
    // name in a detail response -- including B1's <None> -- comes from this
    // default rather than from anything the route knows about.
    expect(formatXml("foodbank", { locations: [{ n: 1 }], donationpoints: [{ n: 2 }] })).toBe(
      "<?xml version='1.0'?>\n" +
        "<foodbank>\n" +
        "    <locations>\n" +
        "        <location>\n" +
        "            <n>1</n>\n" +
        "        </location>\n" +
        "    </locations>\n" +
        "    <donationpoints>\n" +
        "        <None>\n" +
        "            <n>2</n>\n" +
        "        </None>\n" +
        "    </donationpoints>\n" +
        "</foodbank>",
    );
  });

  it("has no fallback of its own when a custom itemName returns an illegal name", () => {
    // The callback's implicit contract, and the reason xmlItemName's fallback
    // is the literal string "None" rather than "": an empty item name throws
    // out of js2xmlparser instead of degrading to something renderable. A
    // future caller writing `SINGULAR[key] ?? ""` gets a 500, not a quiet
    // change of element name.
    expect(() => formatXml("foodbanks", [{ n: 1 }], () => "")).toThrow(/element name should not be empty/);
  });

  it("threads a custom itemName through the root and every nested level", () => {
    // The parameter exists for tests and for any future endpoint with its own
    // naming; it must not be consulted only at the top level.
    expect(formatXml("foodbanks", [{ needs: ["Beans"] }], (key) => `x_${key}`)).toBe(
      "<?xml version='1.0'?>\n" +
        "<foodbanks>\n" +
        "    <x_foodbanks>\n" +
        "        <needs>\n" +
        "            <x_needs>Beans</x_needs>\n" +
        "        </needs>\n" +
        "    </x_foodbanks>\n" +
        "</foodbanks>",
    );
  });
});

describe("formatXml -- malformed and out-of-contract input", () => {
  it("throws when the root tag is not a legal XML name", () => {
    // Not a claimed invariant ("never throws" is pyDatetime's promise, not
    // this module's) but worth pinning: rootTag comes from the caller's
    // obj_name, so a bad route table entry surfaces as a 500 here rather than
    // as a malformed document a consumer has to diagnose.
    expect(() => formatXml("", {})).toThrow();
    expect(() => formatXml("foo bar", {})).toThrow();
    expect(() => formatXml("1foo", {})).toThrow(); // XML names cannot start with a digit
  });

  it("throws a TypeError when `data` itself is null or undefined", () => {
    // Outside the argument's contract (formatXml takes an array or a keyed
    // object, never a bare null) but it is exactly what a route handler
    // produces after a lookup miss it forgot to 404 on. It lands on
    // Object.keys(null) inside transformObject, so the symptom is a bare
    // TypeError with no mention of XML -- worth knowing before spending time
    // in js2xmlparser looking for it.
    expect(() => formatXml("foodbanks", null as unknown as { [key: string]: never })).toThrow(TypeError);
    expect(() => formatXml("foodbanks", undefined as unknown as { [key: string]: never })).toThrow(
      /Cannot convert undefined or null to object/,
    );
  });

  it("throws on a control character in text, where Django emitted the row", () => {
    // The other way a whole response can 500: js2xmlparser validates
    // character data, and a NUL, vertical tab or lone surrogate in a scraped
    // needs/excess string aborts the ENTIRE document -- one bad row out of a
    // 1,000-row list, exactly the failure pyDatetime.ts refuses to cause.
    // Python's dicttoxml + minidom would have written the byte out instead.
    // Pinned as current behaviour; making it lenient is a source change.
    expect(() => formatXml("foodbank", { needs: "Beans\u0000Pasta" })).toThrow(
      /should not contain characters not allowed in XML/,
    );
    expect(() => formatXml("foodbank", { needs: "Beans\u000BPasta" })).toThrow();
    expect(() => formatXml("foodbank", { needs: "Beans\uD800Pasta" })).toThrow();
  });

  it("renders `undefined` as the literal text 'undefined', not a self-closed tag", () => {
    // undefined is outside SerialisableValue, so this is what a missing D1
    // column would produce if one ever slipped into a response dict: the
    // string "undefined" on the wire, where null would have self-closed.
    // Documented so the difference is a known quantity, not a surprise.
    const withUndefined = { a: undefined } as unknown as { [key: string]: never };
    expect(formatXml("foodbank", withUndefined)).toContain("<a>undefined</a>");
    // Same inside a list, where the surrounding items look perfectly normal.
    const inList = { needs: [undefined] } as unknown as { [key: string]: never };
    expect(formatXml("foodbank", inList)).toContain("<need>undefined</need>");
  });

  it("drops a key literally named __proto__ instead of emitting it", () => {
    // Current behaviour, pinned rather than fixed: transformObject builds its
    // output with `out[key] = ...`, and assigning "__proto__" sets the
    // prototype instead of creating an own property, so the key disappears.
    // Django's dicttoxml would have emitted a <__proto__> element. Reported
    // as a suspected bug; latent today because no response dict has that key.
    const data = JSON.parse('{"__proto__": {"a": 1}, "name": "Trussell"}') as {
      [key: string]: never;
    };
    const xml = formatXml("foodbank", data);
    expect(xml).not.toContain("__proto__");
    expect(xml).toContain("<name>Trussell</name>");
  });

  it("throws on a list under a key that shadows an Object.prototype member", () => {
    // The consequence of the xmlItemName leak above: itemName("toString")
    // returns a FUNCTION, which is coerced into the element name and rejected
    // by js2xmlparser -- a 500 where Django would have emitted <None>. The
    // error message carries the stringified function, which is how you
    // recognise this failure in a log. Pinned as-is; the fix belongs in a
    // source change, not in this test.
    const data = { toString: ["Beans"] } as unknown as { [key: string]: never };
    expect(() => formatXml("foodbank", data)).toThrow(/should not contain characters not allowed in XML names/);
    expect(() => formatXml("foodbank", data)).toThrow(/native code/);
    const ctor = { constructor: ["Beans"] } as unknown as { [key: string]: never };
    expect(() => formatXml("foodbank", ctor)).toThrow(/function Object/);
  });

  it("silently restructures the document for js2xmlparser's reserved keys", () => {
    // A quirk the module header does not list, and the only one that changes
    // the SHAPE of a response without erroring: js2xmlparser reads "@" as an
    // attribute map, "#" as the element's text content and "=" as an alias
    // that RENAMES the element. dicttoxml has no such reserved keys, so any
    // future endpoint that echoes a caller-supplied key into a response dict
    // would produce XML no consumer expects. No live response dict contains
    // one today -- pinned so that stays a known constraint on new keys.
    expect(formatXml("foodbank", { "@": { id: "1" }, name: "x" })).toBe(
      "<?xml version='1.0'?>\n<foodbank id='1'>\n    <name>x</name>\n</foodbank>",
    );
    expect(formatXml("foodbank", { "#": "text" })).toBe("<?xml version='1.0'?>\n<foodbank>text</foodbank>");
    expect(formatXml("foodbank", { "=": "alias", n: 1 })).toBe(
      "<?xml version='1.0'?>\n<alias>\n    <n>1</n>\n</alias>",
    );
  });

  it("flattens a nested array into one flat run of sibling item elements", () => {
    // js2xmlparser flattens arrays of arrays, so [[1,2],[3]] does not nest.
    // No current endpoint sends one; pinned so that if one ever does, the
    // silently-flattened shape is a known behaviour rather than a discovery
    // made from a consumer's bug report.
    expect(formatXml("foodbank", { needs: [["Beans", "Pasta"], ["Rice"]] })).toBe(
      "<?xml version='1.0'?>\n" +
        "<foodbank>\n" +
        "    <needs>\n" +
        "        <need>Beans</need>\n" +
        "        <need>Pasta</need>\n" +
        "        <need>Rice</need>\n" +
        "    </needs>\n" +
        "</foodbank>",
    );
    // The empty-array recode is in transformObject only, so an empty array
    // nested INSIDE an array is not recoded -- it stays empty and js2xmlparser
    // drops it. A list of nothing but empty lists therefore self-closes.
    expect(formatXml("foodbank", { needs: [[]] })).toBe("<?xml version='1.0'?>\n<foodbank>\n    <needs/>\n</foodbank>");
    expect(formatXml("foodbank", { needs: [[], "Beans"] })).toContain("<needs>\n        <need>Beans</need>\n    </needs>");
    // Both behaviours again on the TOP-LEVEL branch, which does its own
    // `data.map(transformValue)` rather than going through transformObject --
    // a fix applied to one branch and not the other would split the list
    // endpoints from the detail endpoints without failing anything else.
    expect(formatXml("needs", [["Beans", "Pasta"], ["Rice"]])).toBe(
      "<?xml version='1.0'?>\n<needs>\n    <need>Beans</need>\n    <need>Pasta</need>\n    <need>Rice</need>\n</needs>",
    );
    expect(formatXml("needs", [[]])).toBe("<?xml version='1.0'?>\n<needs/>");
  });
});

describe("formatXml -- documented divergence from dicttoxml + minidom", () => {
  it("uses js2xmlparser's declaration and 4-space indent, not minidom's", () => {
    // PLAN.md §7.4.3's table describes the Django pipeline's bytes:
    // `<?xml version="1.0" ?>` and a literal TAB per level. Parity here is
    // structural, resolved 2026-08-30, so the port emits single quotes, no
    // space before `?>`, and four spaces. Asserted explicitly so that a
    // future byte-parity push starts from a failing test rather than from an
    // argument about whether the divergence was ever intended.
    const xml = formatXml("foodbank", { locations: [{ name: "Main hall" }] });
    expect(xml.startsWith("<?xml version='1.0'?>\n")).toBe(true);
    expect(xml).not.toContain('<?xml version="1.0" ?>');
    expect(xml).toContain("\n    <locations>");
    expect(xml).not.toContain("\t");
    // The one minidom special case that IS reproduced (§7.4.3, "Element with
    // a single text child | written on one line"): no newline between the
    // open tag, the text and the close tag.
    expect(xml).toContain("<name>Main hall</name>");
  });
});
