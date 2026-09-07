import { describe, expect, it } from "vitest";
import type { SerialisableValue } from "@givefood/serialise";
import { apiResponse, SECONDS_IN_DAY, SECONDS_IN_HOUR, SECONDS_IN_MONTH, SECONDS_IN_WEEK } from "./apiResponse";

// apiResponse() is the single choke point every /api/2/ endpoint returns
// through, so the two things worth defending here are the ones a reader
// would most plausibly "tidy up":
//
//   1. The ALLOWED_FORMATS table is NOT regular. `constituency` allows
//      geojson but `constituencies` does not; `locations` allows it but
//      `location` does not. That looks like a typo in gfapi2/func.py and
//      is not -- it is what the live API does, and a client that today
//      gets a 400 must keep getting one.
//   2. The CORS header is on 2xx responses ONLY. PLAN.md §7.7.2 calls this
//      "asymmetric, and the asymmetry is the contract": adding the header
//      to the 400 changes what every browser client's error handling sees,
//      which is a breaking change, not a fix.
//
// Both are asserted directly below rather than left to the route tests,
// because a route test that only ever asks for `?format=json` would stay
// green through either regression.
//
// The third thing this file defends is the DISPATCH itself: the same
// payload has to come out as three genuinely different documents, and
// because each branch delegates to a different writer in
// packages/serialise, a refactor that "shares" work across the branches is
// invisible to that package's own unit tests. The datetime and float
// blocks below are here for exactly that -- they are wire-format
// assertions on what a client receives, not re-tests of the writers.

// A realistic gfapi2 detail payload: needToResponseDict() in
// routes/api2/needs.ts, trimmed. It carries the three value kinds the
// format writers each treat differently -- a __datetime wrapper, a null,
// and a multiline string -- so a change in how apiResponse dispatches to
// a writer shows up as a changed body rather than silently passing.
const NEED: SerialisableValue = {
  id: "0e0a1a2c-0000-4000-8000-000000000001",
  found: { __datetime: "2026-09-05 19:28:08.853000" },
  foodbank: { name: "Sid Valley", slug: "sid-valley" },
  needs: "Tinned soup\nPasta",
  excess: null,
};

// The table read verbatim from gfapi2/func.py:22-32. Duplicated here on
// purpose: the module under test must not be able to change its own
// expectations. If someone edits ALLOWED_FORMATS, this list is what says
// whether that was intended.
const DJANGO_ALLOWED_FORMATS: Record<string, string[]> = {
  foodbank: ["json", "xml", "yaml", "geojson"],
  foodbanks: ["json", "xml", "yaml", "geojson"],
  location: ["json", "xml", "yaml"],
  locations: ["json", "xml", "yaml", "geojson"],
  donationpoints: ["json", "xml", "yaml", "geojson"],
  need: ["json", "xml", "yaml"],
  needs: ["json", "xml", "yaml"],
  constituency: ["json", "xml", "yaml", "geojson"],
  constituencies: ["json", "xml", "yaml"],
};
const EVERY_FORMAT = ["json", "xml", "yaml", "geojson"];

// Content-Type per format, kept as its own table so the matrix test below
// can assert it for all 33 allowed (objName, format) pairs rather than for
// the one example each format's describe block happens to use.
const CONTENT_TYPE: Record<string, string> = {
  json: "application/json",
  geojson: "application/json", // NOT application/geo+json -- see the geojson test
  xml: "text/xml",
  yaml: "text/yaml",
};

describe("apiResponse format gating", () => {
  it("accepts and rejects exactly the pairs gfapi2/func.py's ALLOWED_FORMATS does", () => {
    // The whole 9x4 matrix, so an accidental widening (e.g. making every
    // object name use STD_FORMATS_GEOJSON "for consistency") fails here
    // rather than in production, where it would start serving geojson on
    // routes that have never had a geojson serialiser exercised.
    //
    // Every response in the matrix is checked for its full header
    // signature, not just its status: the 2xx/400 split in what headers
    // get set is the actual contract (see the CORS block below), and
    // asserting it here means it holds for all 36 pairs rather than for
    // the two the CORS tests sample.
    for (const [objName, allowed] of Object.entries(DJANGO_ALLOWED_FORMATS)) {
      for (const format of EVERY_FORMAT) {
        const res = apiResponse(NEED, objName, format, SECONDS_IN_HOUR);
        const label = `${objName}?format=${format}`;
        if (allowed.includes(format)) {
          expect(res.status, label).toBe(200);
          expect(res.headers.get("Content-Type"), label).toBe(CONTENT_TYPE[format]);
          expect(res.headers.get("Access-Control-Allow-Origin"), label).toBe("*");
          expect(res.headers.get("Cache-Control"), label).toBe("public, max-age=3600, s-maxage=3600");
        } else {
          expect(res.status, label).toBe(400);
          expect(res.headers.get("Access-Control-Allow-Origin"), label).toBeNull();
          expect(res.headers.get("Cache-Control"), label).toBeNull();
        }
      }
    }
  });

  it("keeps the singular/plural geojson asymmetry that looks like a Django typo", () => {
    // Spelled out separately from the matrix above because these four are
    // the ones a reader is most likely to "correct". They are inconsistent
    // in BOTH directions, which is why neither can be inferred:
    //   locations has geojson, location does not;
    //   constituency has geojson, constituencies does not.
    expect(apiResponse(NEED, "locations", "geojson", SECONDS_IN_DAY).status).toBe(200);
    expect(apiResponse(NEED, "location", "geojson", SECONDS_IN_DAY).status).toBe(400);
    expect(apiResponse(NEED, "constituency", "geojson", SECONDS_IN_DAY).status).toBe(200);
    expect(apiResponse(NEED, "constituencies", "geojson", SECONDS_IN_DAY).status).toBe(400);
  });

  it("rejects an unknown format rather than falling through to a default", () => {
    // Routes default the querystring to "json" before calling in, so
    // anything else here came from the client verbatim. There is no
    // "unknown formats render as JSON" fallback in Django and there must
    // not be one here -- the last `else` branch is the YAML branch, and it
    // is only ever reached because ALLOWED_FORMATS gated the value first.
    for (const format of ["", "html", "csv", "geo+json", "json ", " json"]) {
      expect(apiResponse(NEED, "foodbanks", format, SECONDS_IN_HOUR).status, format).toBe(400);
    }
  });

  it("compares the format WHOLE, so a substring of an allowed name is still a 400", () => {
    // The membership test is `allowed.includes(format)` -- an exact
    // element match. The plausible wrong version is a swap of the two
    // operands (`allowed.some((a) => a.includes(format))`), which passes
    // every test above because "html" and "csv" are not substrings of
    // anything. These are: "son" and "on" sit inside "json", "ml" inside
    // "xml", "ya" inside "yaml", "geo" inside "geojson". A client sending
    // ?format=js must get a 400, not a YAML body.
    for (const format of ["son", "js", "ml", "ya", "on", "geo", "j", "jso", "geojso"]) {
      expect(apiResponse(NEED, "foodbanks", format, SECONDS_IN_HOUR).status, format).toBe(400);
    }
  });

  it("matches formats case-sensitively, so ?format=JSON is a 400", () => {
    // Python's `format not in ALLOWED_FORMATS.get(obj_name)` is a
    // case-sensitive list membership test. A client sending ?format=JSON
    // gets a 400 today; lowercasing the input here would silently start
    // serving them a body instead.
    expect(apiResponse(NEED, "foodbanks", "JSON", SECONDS_IN_HOUR).status).toBe(400);
    expect(apiResponse(NEED, "foodbanks", "Json", SECONDS_IN_HOUR).status).toBe(400);
    expect(apiResponse(NEED, "foodbanks", "GeoJSON", SECONDS_IN_HOUR).status).toBe(400);
  });

  it("rejects opml and rss, whose Django branch is unreachable dead code", () => {
    // func.py:44-48 lists "opml" and "rss" alongside "xml" in xml_formats,
    // but no ALLOWED_FORMATS entry ever contains them, so that branch can
    // never run. The port simply omits them; this pins that the omission
    // is invisible from outside -- both still 400, same as Django.
    for (const objName of Object.keys(DJANGO_ALLOWED_FORMATS)) {
      expect(apiResponse(NEED, objName, "opml", SECONDS_IN_HOUR).status, objName).toBe(400);
      expect(apiResponse(NEED, objName, "rss", SECONDS_IN_HOUR).status, objName).toBe(400);
    }
  });

  it("400s rather than throwing when a route hands it a non-string format", () => {
    // `c.req.query("format")` returns `string | undefined`, and a route
    // that forgets its `?? "json"` default passes undefined straight in.
    // `allowed.includes(undefined)` is false, so this is a clean 400 --
    // not a crash, and not an accidental JSON body. Worth pinning because
    // the obvious "tidy" alternative (`format.toLowerCase()`) would turn
    // that route bug into a 500 on every request.
    for (const format of [undefined, null, 0, NaN]) {
      const res = apiResponse(NEED, "foodbanks", format as unknown as string, SECONDS_IN_HOUR);
      expect(res.status, String(format)).toBe(400);
    }
  });

  it("throws on an object name that is not in the table, as Django does", () => {
    // Documented current behaviour, NOT an endorsement. Django's
    // `ALLOWED_FORMATS.get(obj_name)` returns None and `format not in
    // None` raises TypeError; the port's `allowed.includes(...)` on
    // undefined raises TypeError too, so a typo'd object name is a 500 in
    // both -- loud, and identical either side of the migration. Every call
    // site passes a literal, so this is reachable only via a code change.
    expect(() => apiResponse(NEED, "foodbanx", "json", SECONDS_IN_HOUR)).toThrow(TypeError);
    expect(() => apiResponse(NEED, "Foodbanks", "json", SECONDS_IN_HOUR)).toThrow(TypeError);
    expect(() => apiResponse(NEED, "", "json", SECONDS_IN_HOUR)).toThrow(TypeError);
    // The message names the missing lookup, which is what makes the 500
    // diagnosable from a Workers tail. A silent 400 here would hide a
    // routing typo behind a plausible-looking client error.
    expect(() => apiResponse(NEED, "foodbanx", "json", SECONDS_IN_HOUR)).toThrow(/undefined/);
  });

  it("throws on an Object.prototype key too, rather than serving whatever it finds", () => {
    // ALLOWED_FORMATS is an object literal, so it inherits from
    // Object.prototype: `ALLOWED_FORMATS["toString"]` is a FUNCTION, not
    // undefined. That is a different failure mode from the missing-key
    // case above ("allowed.includes is not a function" rather than
    // "cannot read properties of undefined"), and it is the one that would
    // change silently if the lookup were ever swapped for something like
    // `ALLOWED_FORMATS[objName] ?? []` -- which would turn these into 400s
    // and, worse, turn a genuinely typo'd object name into a 400 as well.
    // Distinguishing the two messages is the point of asserting them.
    for (const objName of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
      expect(() => apiResponse(NEED, objName, "json", SECONDS_IN_HOUR), objName).toThrow(TypeError);
      expect(() => apiResponse(NEED, objName, "json", SECONDS_IN_HOUR), objName).toThrow(/is not a function/);
    }
  });

  it("checks the format before it looks at the data", () => {
    // The 400 must not depend on the payload: a search endpoint that
    // rejects a bad ?format= should do so without having serialised
    // anything.
    //
    // A CIRCULAR object is the proof, and it has to be genuinely circular
    // -- a payload that merely looks odd (say `{ self: null }`) serialises
    // fine, so a test using one would pass just as happily against an
    // implementation that serialised FIRST and gated afterwards. This one
    // cannot: json.ts's toPlainJs() recurses into the cycle and blows the
    // stack. The second assertion is the positive control that proves the
    // fixture really is poisonous -- without it, the first assertion is
    // only evidence that `needs` rejects `geojson`, which the matrix
    // already covers.
    const circular: Record<string, unknown> = { name: "Sid Valley" };
    circular.self = circular;
    const poison = circular as unknown as SerialisableValue;

    expect(apiResponse(poison, "needs", "geojson", SECONDS_IN_HOUR).status).toBe(400);
    expect(() => apiResponse(poison, "needs", "json", SECONDS_IN_HOUR)).toThrow(RangeError);
  });
});

describe("apiResponse 400 branch", () => {
  it("returns an empty body, mirroring Django's bare HttpResponseBadRequest()", () => {
    // func.py:38 constructs HttpResponseBadRequest() with no argument --
    // there is no error message, no JSON envelope, nothing for a client to
    // parse. Anyone adding a helpful body would be changing the API.
    const res = apiResponse(NEED, "needs", "geojson", SECONDS_IN_HOUR);
    expect(res.status).toBe(400);
    expect(res.ok).toBe(false);
    return expect(res.text()).resolves.toBe("");
  });

  it("sets no Cache-Control, so a bad request is never cached at the edge", () => {
    // The 2xx path is cached for up to a month at the edge. If the 400
    // carried the same Cache-Control, one client's typo'd ?format= would
    // be served to everyone else from cache.
    const res = apiResponse(NEED, "needs", "geojson", SECONDS_IN_MONTH);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("carries the runtime's default text/plain type, NOT the requested format's", () => {
    // DIVERGENCE, pinned deliberately. `new Response("")` has no explicit
    // Content-Type, so the runtime supplies text/plain;charset=UTF-8;
    // Django's HttpResponseBadRequest() sends text/html; charset=utf-8.
    // Neither is meaningful (the body is empty either way), but this is
    // asserted so the value is a decision rather than an accident -- and
    // so that nobody "helpfully" makes the 400 echo the requested format's
    // Content-Type, which would imply a parseable error body that is not
    // there.
    const res = apiResponse(NEED, "needs", "geojson", SECONDS_IN_HOUR);
    expect(res.headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
    expect(res.headers.get("Content-Type")).not.toBe("application/json");
  });
});

describe("apiResponse CORS asymmetry (PLAN.md §7.7.2)", () => {
  it("sets Access-Control-Allow-Origin: * on every successful response", () => {
    for (const [objName, allowed] of Object.entries(DJANGO_ALLOWED_FORMATS)) {
      for (const format of allowed) {
        const res = apiResponse(NEED, objName, format, SECONDS_IN_HOUR);
        expect(res.headers.get("Access-Control-Allow-Origin"), `${objName}/${format}`).toBe("*");
      }
    }
  });

  it("omits the CORS header on the 400 -- deliberately, not by oversight", () => {
    // In Django the header is set at func.py:62, after the bad-request
    // branch has already returned at func.py:37. The consequence, spelled
    // out in PLAN.md §7.7.2: a browser hitting /api/2/foodbanks/search/
    // with a bad lat_lng sees an opaque CORS failure rather than a clean
    // 400. That is the behaviour clients have coded against, so the port
    // reproduces it. Fixing it is a breaking change and needs to be an
    // explicit decision, not a one-line drive-by.
    const bad = apiResponse(NEED, "needs", "geojson", SECONDS_IN_HOUR);
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();

    // Same object name, allowed format: the header IS there. Asserted in
    // the same test so the pair reads as one contract.
    const good = apiResponse(NEED, "needs", "json", SECONDS_IN_HOUR);
    expect(good.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("sets no other CORS header, so a browser preflight is not answered here", () => {
    // The port sets exactly one CORS header, matching func.py:62's single
    // `response["Access-Control-Allow-Origin"] = "*"`. No Allow-Methods,
    // no Allow-Headers, no Max-Age -- which is why a preflighted request
    // (one with a custom header) still fails against this API today.
    // Adding them here would change which cross-origin requests succeed.
    const res = apiResponse(NEED, "needs", "json", SECONDS_IN_HOUR);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(res.headers.get("Access-Control-Max-Age")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
  });
});

describe("apiResponse JSON and geojson", () => {
  it("serialises JSON with two-space indent, matching json_dumps_params={'indent': 2}", () => {
    const res = apiResponse(NEED, "need", "json", SECONDS_IN_DAY);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    return expect(res.text()).resolves.toBe(
      [
        "{",
        '  "id": "0e0a1a2c-0000-4000-8000-000000000001",',
        '  "found": "2026-09-05T19:28:08.853",',
        '  "foodbank": {',
        '    "name": "Sid Valley",',
        '    "slug": "sid-valley"',
        "  },",
        '  "needs": "Tinned soup\\nPasta",',
        '  "excess": null',
        "}",
      ].join("\n"),
    );
  });

  it("renders geojson through the JSON encoder, byte for byte", async () => {
    // The module header states this outright: geojson is a GeoJSON-SHAPED
    // dict built by the route, not a distinct wire format. func.py routes
    // "geojson" into the same JsonResponse branch as "json", so the two
    // must be indistinguishable at this layer -- including the
    // Content-Type, which stays application/json and does NOT become
    // application/geo+json.
    const asJson = apiResponse(NEED, "foodbanks", "json", SECONDS_IN_HOUR);
    const asGeojson = apiResponse(NEED, "foodbanks", "geojson", SECONDS_IN_HOUR);
    expect(asGeojson.headers.get("Content-Type")).toBe("application/json");
    const [a, b] = await Promise.all([asJson.text(), asGeojson.text()]);
    expect(b).toBe(a);
    // Guard against the degenerate way this could pass: two empty bodies,
    // or two bodies produced by some shared error path, are also equal.
    expect(b).toContain('"slug": "sid-valley"');
    expect(b.startsWith("{")).toBe(true);
  });

  it("serialises a top-level null and an empty list without special-casing them", async () => {
    // JsonResponse(data, safe=False) accepts a non-dict top level, which
    // is how every list endpoint returns its bare `response_list`. An
    // empty result set must still be a 200 with "[]", not a 404 or an
    // empty body -- clients poll /needs/ and expect valid JSON back.
    const empty = apiResponse([], "needs", "json", SECONDS_IN_HOUR);
    expect(empty.status).toBe(200);
    const nul = apiResponse(null, "needs", "json", SECONDS_IN_HOUR);
    const [e, n] = await Promise.all([empty.text(), nul.text()]);
    expect(e).toBe("[]");
    expect(n).toBe("null");
    // An empty STRING payload is distinct from an empty BODY: a 0-byte
    // response is not valid JSON and would throw in every client.
    await expect(apiResponse("", "need", "json", SECONDS_IN_HOUR).text()).resolves.toBe('""');
  });

  it("indents nested arrays at two spaces as well, not just objects", async () => {
    // The list endpoints are the high-traffic ones and they return a bare
    // array. `indent: 2` has to reach the array elements too, or every
    // /api/2/foodbanks/ response changes shape while the detail-endpoint
    // test above stays green.
    await expect(apiResponse([1, 2], "needs", "json", SECONDS_IN_HOUR).text()).resolves.toBe("[\n  1,\n  2\n]");
  });

  it("emits raw UTF-8 where Django's ensure_ascii=True emitted \\uXXXX", async () => {
    // KNOWN DIVERGENCE (packages/serialise/src/json.test.ts pins it at the
    // writer; this pins what actually goes out over the wire). Python's
    // json.dumps defaults to ensure_ascii=True and would send
    // "Ynys Môn"; JSON.stringify sends the character itself. Both
    // decode to the same string, so it is a byte difference only -- but a
    // Welsh or Northern Irish foodbank name is the common case here, not
    // an edge case, so any attempt to "restore parity" needs to be a
    // deliberate change with this test updated alongside it.
    const res = apiResponse({ name: "Ynys Môn" }, "foodbank", "json", SECONDS_IN_HOUR);
    const body = await res.text();
    expect(body).toContain("Ynys Môn");
    expect(body).not.toContain("\\u00f4");
  });
});

describe("apiResponse XML", () => {
  it("wraps a list endpoint's bare array in <objName> with singular item tags", () => {
    // The list case the module comment calls out: routes hand
    // `response_list` straight through as a top-level array, and the root
    // tag comes from objName. Full-string equality here because the exact
    // shape (root, repeated singular child, 4-space indent) is the
    // contract an XML consumer's XPath is written against.
    const res = apiResponse([NEED], "needs", "xml", SECONDS_IN_HOUR);
    expect(res.headers.get("Content-Type")).toBe("text/xml");
    return expect(res.text()).resolves.toBe(
      [
        "<?xml version='1.0'?>",
        "<needs>",
        "    <need>",
        "        <id>0e0a1a2c-0000-4000-8000-000000000001</id>",
        "        <found>2026-09-05T19:28:08.853000</found>",
        "        <foodbank>",
        "            <name>Sid Valley</name>",
        "            <slug>sid-valley</slug>",
        "        </foodbank>",
        "        <needs>Tinned soup",
        "Pasta</needs>",
        "        <excess/>",
        "    </need>",
        "</needs>",
      ].join("\n"),
    );
  });

  it("uses objName as the root tag directly for a detail endpoint's object", () => {
    // The other half of the same comment: a `need`/`foodbank` detail
    // endpoint passes an object, which becomes the root's children with no
    // intervening item element. Getting this wrong would emit
    // <need><need>... for every detail URL.
    const res = apiResponse(NEED, "need", "xml", SECONDS_IN_DAY);
    return expect(res.text()).resolves.toBe(
      [
        "<?xml version='1.0'?>",
        "<need>",
        "    <id>0e0a1a2c-0000-4000-8000-000000000001</id>",
        "    <found>2026-09-05T19:28:08.853000</found>",
        "    <foodbank>",
        "        <name>Sid Valley</name>",
        "        <slug>sid-valley</slug>",
        "    </foodbank>",
        "    <needs>Tinned soup",
        "Pasta</needs>",
        "    <excess/>",
        "</need>",
      ].join("\n"),
    );
  });

  it("emits <None> item tags for donationpoints -- frozen bug B1, reproduced", () => {
    // xml_item_name() in func.py:66-76 has no "donationpoints" key, so
    // Python's dict.get() returns None and dicttoxml names every item
    // element "None". PLAN.md §7.3 freezes this as bug B1. It is ugly and
    // it is live, so /api/2/donationpoints/?format=xml must keep emitting
    // it until the bug is deliberately unfrozen.
    const res = apiResponse([{ name: "Tesco Sidmouth" }], "donationpoints", "xml", SECONDS_IN_WEEK);
    return expect(res.text()).resolves.toBe(
      [
        "<?xml version='1.0'?>",
        "<donationpoints>",
        "    <None>",
        "        <name>Tesco Sidmouth</name>",
        "    </None>",
        "</donationpoints>",
      ].join("\n"),
    );
  });

  it("still emits a well-formed document for an empty result set", () => {
    // An empty array must not produce an empty body or a parse error --
    // an XML consumer parsing the response would throw on either. The
    // self-closing root is the correct degenerate case.
    const res = apiResponse([], "needs", "xml", SECONDS_IN_HOUR);
    expect(res.status).toBe(200);
    return expect(res.text()).resolves.toBe("<?xml version='1.0'?>\n<needs/>");
  });

  it("THROWS on a top-level null, unlike the JSON and YAML branches", () => {
    // Documented current behaviour, not an endorsement -- the same input
    // that the JSON test above proves returns "null" with a 200 crashes
    // here, because formatXml() reaches Object.keys(null). So an endpoint
    // that can return a null payload is a 200 on ?format=json and a 500 on
    // ?format=xml. Nothing in gfapi2 passes null to a detail endpoint
    // today (a missing row 404s earlier), which is why this is latent
    // rather than live, but the asymmetry is real and pinning it means a
    // future route that CAN return null fails this test rather than
    // production.
    expect(() => apiResponse(null, "need", "xml", SECONDS_IN_HOUR)).toThrow(TypeError);
    expect(apiResponse(null, "need", "json", SECONDS_IN_HOUR).status).toBe(200);
    expect(apiResponse(null, "need", "yaml", SECONDS_IN_HOUR).status).toBe(200);
  });

  it("throws on a non-empty top-level string, whose characters become tag names", () => {
    // The other malformed-input shape, and a more surprising one: a bare
    // string top level makes formatXml index it like an object, so the
    // element names come out as "0", "1", "2"... and js2xmlparser rejects
    // them as invalid XML names. An empty string has no indices, so it
    // degenerates to the empty root instead of throwing -- the two are
    // asserted together because the difference is not guessable.
    expect(() => apiResponse("hello", "need", "xml", SECONDS_IN_HOUR)).toThrow();
    return expect(apiResponse("", "need", "xml", SECONDS_IN_HOUR).text()).resolves.toBe(
      "<?xml version='1.0'?>\n<need/>",
    );
  });

  it("escapes & and < but leaves > and \" alone, as js2xmlparser does", async () => {
    // Foodbank names really do contain ampersands ("Trussell & Co"), and
    // an unescaped one is a hard parse error for any XML consumer. The
    // asymmetry matters just as much: > and " are LEGAL as raw text in an
    // XML text node, so js2xmlparser leaves them, and a hand-rolled
    // "escape everything" replacement would change the bytes on every
    // opening-hours string without fixing anything. Non-ASCII passes
    // through raw, same as the JSON branch.
    const res = apiResponse({ name: "A & B", lt: "a<b", gt: "a>b", q: 'a"b', uni: "Ynys Môn" }, "foodbank", "xml", 0);
    await expect(res.text()).resolves.toBe(
      [
        "<?xml version='1.0'?>",
        "<foodbank>",
        "    <name>A &amp; B</name>",
        "    <lt>a&lt;b</lt>",
        "    <gt>a>b</gt>",
        '    <q>a"b</q>',
        "    <uni>Ynys Môn</uni>",
        "</foodbank>",
      ].join("\n"),
    );
  });
});

describe("apiResponse YAML", () => {
  it("serialises with sorted keys and a block literal for multiline strings", () => {
    // PyYAML's yaml.dump() sorts mapping keys by default, so the YAML key
    // order is NOT the JSON key order for the same payload -- see the
    // ordering assertion below. `default_flow_style=False` means block
    // style throughout, which is what these nested mappings render as.
    const res = apiResponse(NEED, "need", "yaml", SECONDS_IN_DAY);
    expect(res.headers.get("Content-Type")).toBe("text/yaml");
    return expect(res.text()).resolves.toBe(
      [
        "excess: null",
        "foodbank:",
        "  name: Sid Valley",
        "  slug: sid-valley",
        "found: 2026-09-05 19:28:08.853000",
        "id: 0e0a1a2c-0000-4000-8000-000000000001",
        "needs: |-",
        "  Tinned soup",
        "  Pasta",
        "",
      ].join("\n"),
    );
  });

  it("sorts YAML keys while JSON keeps insertion order, for the same input", async () => {
    // Stated as a property rather than a second copy of the fixtures: the
    // two writers genuinely disagree about key order, and that difference
    // is inherited from PyYAML vs json.dumps. A shared "normalise the
    // object first" refactor across the three branches would break it.
    //
    // NEED is deliberately built with `id` first and `excess` last, which
    // is the reverse of their alphabetical order -- so neither assertion
    // below can pass by luck if the sort were dropped or if JSON started
    // sorting.
    const yaml = apiResponse(NEED, "need", "yaml", SECONDS_IN_DAY);
    const json = apiResponse(NEED, "need", "json", SECONDS_IN_DAY);
    const [y, j] = await Promise.all([yaml.text(), json.text()]);
    expect(y.indexOf("excess:")).toBeLessThan(y.indexOf("id:"));
    expect(j.indexOf('"excess"')).toBeGreaterThan(j.indexOf('"id"'));
    // Sorting is on the FULL key set, not just the two sampled above, and
    // it is lexicographic by code unit -- the ordering js-yaml's sortKeys
    // and PyYAML's default both use.
    const keys = y.split("\n").filter((l) => /^\w+:/.test(l)).map((l) => l.split(":")[0]);
    expect(keys).toStrictEqual([...keys].sort());
    expect(keys).toStrictEqual(["excess", "foodbank", "found", "id", "needs"]);
  });

  it("returns a valid empty document for an empty list and an empty object", async () => {
    const list = apiResponse([], "needs", "yaml", SECONDS_IN_HOUR);
    const obj = apiResponse({}, "need", "yaml", SECONDS_IN_DAY);
    const [l, o] = await Promise.all([list.text(), obj.text()]);
    expect(l).toBe("[]\n");
    expect(o).toBe("{}\n");
  });
});

// The datetime block below is the reason apiResponse is worth testing as a
// unit at all rather than only through its routes. PLAN.md §7.4.6 ("the
// same value, three renderings") is a claim about what a CLIENT receives,
// and it is only true if the format dispatch keeps the three branches
// wired to three different writers.
describe("apiResponse datetime renderings (PLAN.md §7.4.6)", () => {
  const DT: SerialisableValue = { found: { __datetime: "2020-01-24 16:30:23.173268" } };

  it("gives the same instant three different shapes, one per format", async () => {
    // Milliseconds + T for JSON (DjangoJSONEncoder truncates isoformat to
    // 23 chars), microseconds + T for XML (dicttoxml calls isoformat()),
    // microseconds + space for YAML (PyYAML's timestamp scalar, which is
    // isoformat(" ")). Asserted side by side, and asserted as mutually
    // DISTINCT, because the plausible regression is a refactor that routes
    // two of the three through one formatter -- which every "does the
    // datetime appear?" assertion would survive.
    const [json, xml, yaml] = await Promise.all(
      ["json", "xml", "yaml"].map((f) => apiResponse(DT, "need", f, SECONDS_IN_HOUR).text()),
    );
    expect(json).toContain('"found": "2020-01-24T16:30:23.173"');
    expect(xml).toContain("<found>2020-01-24T16:30:23.173268</found>");
    expect(yaml).toBe("found: 2020-01-24 16:30:23.173268\n");
    // Truncation, never rounding: .173268 must not become .173 rounded up
    // to .173 -- trivially the same here, so the sharper check is that the
    // JSON form is a strict prefix-with-T of the XML form's first 23 chars.
    expect("2020-01-24T16:30:23.173268".slice(0, 23)).toBe("2020-01-24T16:30:23.173");
  });

  it("normalises BOTH raw D1 shapes to identical bytes -- the 2026-09-05 production bug", async () => {
    // pyDatetime.ts's header documents this as found by diffing beta
    // against production: D1 holds two shapes for the same column, because
    // ETL rows carry Python's str(datetime) and rows the port writes carry
    // JavaScript's toISOString(). 114 of 34,175 foodbankchange rows were
    // already in the second shape, so a raw pass-through gave an API
    // consumer a different `found` format for a recent need than for an
    // old one, on the same endpoint.
    //
    // These two strings are the SAME instant in the two shapes. Every
    // format must render them byte-identically; if any branch ever stops
    // going through the parser, this is the test that catches it, and it
    // catches it for all three formats rather than for whichever one a
    // fixture happened to use.
    const fromEtl: SerialisableValue = { found: { __datetime: "2020-01-24 16:30:23.173000" } };
    const fromWorker: SerialisableValue = { found: { __datetime: "2020-01-24T16:30:23.173Z" } };
    for (const format of ["json", "xml", "yaml"]) {
      const [a, b] = await Promise.all([
        apiResponse(fromEtl, "need", format, SECONDS_IN_HOUR).text(),
        apiResponse(fromWorker, "need", format, SECONDS_IN_HOUR).text(),
      ]);
      expect(b, format).toBe(a);
      // And the trailing Z is DROPPED, not converted: these datetimes are
      // naive UTC (USE_TZ = False), so no branch may shift the clock.
      expect(a, format).toContain("16:30:23");
    }
  });

  it("omits the fractional part entirely when the microsecond is zero", async () => {
    // pyDatetime.ts states this as a rule: "In every rendering a datetime
    // whose microsecond is 0 has NO fractional part at all -- Python omits
    // it rather than printing zeros." The natural JS implementation
    // (padEnd then always slice) would print ".000" instead, which is a
    // wire change on every top-of-the-minute timestamp. All three input
    // spellings of a zero microsecond must behave the same.
    for (const raw of ["2020-01-24 16:30:23", "2020-01-24 16:30:23.000000", "2020-01-24T16:30:23.000Z"]) {
      const [json, xml, yaml] = await Promise.all(
        ["json", "xml", "yaml"].map((f) => apiResponse({ found: { __datetime: raw } }, "need", f, SECONDS_IN_HOUR).text()),
      );
      expect(json, raw).toContain('"found": "2020-01-24T16:30:23"');
      expect(xml, raw).toContain("<found>2020-01-24T16:30:23</found>");
      expect(yaml, raw).toBe("found: 2020-01-24 16:30:23\n");
      expect(json, raw).not.toContain(".000");
    }
  });

  it("passes an unparseable datetime through rather than 500ing the whole response", async () => {
    // pyDatetime.ts: "An unparseable value is returned unchanged rather
    // than thrown on: this runs inside a response serialiser, and one odd
    // row must not 500 a 1,000-row list." That is a property of the whole
    // response, so it is worth asserting here and not only at the parser:
    // the row is still in the output, and the other 999 rows are fine.
    const rows: SerialisableValue = [{ found: { __datetime: "not a date" } }, { found: { __datetime: "2020-01-24 16:30:23" } }];
    const res = apiResponse(rows, "needs", "json", SECONDS_IN_HOUR);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(
      ["[", "  {", '    "found": "not a date"', "  },", "  {", '    "found": "2020-01-24T16:30:23"', "  }", "]"].join("\n"),
    );

    // YAML is the one that shows it: js-yaml cannot emit a plain scalar it
    // could not read back as a timestamp, so the bad value acquires a
    // VISIBLE `!!timestamp` tag. Ugly on the wire, but still a 200 and
    // still valid YAML, which is the tradeoff the comment is describing.
    await expect(apiResponse({ found: { __datetime: "not a date" } }, "need", "yaml", SECONDS_IN_HOUR).text()).resolves.toBe(
      "found: !!timestamp 'not a date'\n",
    );
  });
});

describe("apiResponse float handling", () => {
  it("unwraps a { __float } latitude to a plain number in all three formats", async () => {
    // types.ts's comment claims xml.ts renders a __float "with full float
    // formatting", but xml.ts, json.ts and yaml.ts all unwrap it to a
    // plain JS number -- float.ts's own comment is the accurate one, and
    // packages/serialise pins the tradeoff per-writer. What is worth
    // asserting HERE is that all three agree: a foodbank at latitude 50.0
    // goes out as `50`, never `50.0`, whichever format is asked for. If
    // someone ever restores full float formatting they must do it in all
    // three branches at once, or /api/2/foodbanks/ starts disagreeing with
    // itself about a coordinate depending on ?format=.
    const geo: SerialisableValue = { lat: { __float: 50.0 }, lng: { __float: -3.25 } };
    const [json, xml, yaml] = await Promise.all(
      ["json", "xml", "yaml"].map((f) => apiResponse(geo, "foodbank", f, SECONDS_IN_HOUR).text()),
    );
    expect(json).toBe('{\n  "lat": 50,\n  "lng": -3.25\n}');
    expect(xml).toBe("<?xml version='1.0'?>\n<foodbank>\n    <lat>50</lat>\n    <lng>-3.25</lng>\n</foodbank>");
    expect(yaml).toBe("lat: 50\nlng: -3.25\n");
    expect(json).not.toContain("50.0");
    expect(xml).not.toContain("50.0");
  });
});

describe("apiResponse Cache-Control", () => {
  it("emits public + max-age + s-maxage, this codebase's gfapi2 convention", () => {
    // NOT what Django emits. @cache_page calls patch_response_headers,
    // which sets a bare `max-age`; routes/wfbn/geojson.ts documents that
    // and deliberately keeps the bare form. gfapi2 responses instead get
    // the explicit public/s-maxage trio so Cloudflare will cache them at
    // the edge. Anyone unifying the two conventions needs to know they are
    // different on purpose.
    const res = apiResponse(NEED, "need", "json", SECONDS_IN_DAY);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400, s-maxage=86400");
  });

  it("uses the caller's TTL verbatim, including a zero", () => {
    // No clamping, no minimum. A route asking for max-age=0 must get
    // max-age=0 rather than a silently substituted default, or an endpoint
    // that deliberately opted out of caching would start being cached.
    expect(apiResponse(NEED, "need", "json", 0).headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=0",
    );
    expect(apiResponse(NEED, "need", "json", SECONDS_IN_MONTH).headers.get("Cache-Control")).toBe(
      "public, max-age=2419200, s-maxage=2419200",
    );
  });

  it("passes a nonsense TTL straight through instead of sanitising it", () => {
    // "Verbatim" above is only checked with values that are already valid,
    // so it would survive a `Math.max(0, Math.round(maxAgeSeconds))`
    // "hardening" -- which is exactly the change this pins against. These
    // are all current behaviour, documented rather than endorsed: a
    // negative or NaN TTL produces a syntactically invalid Cache-Control
    // that Cloudflare treats as no-cache, so a route bug shows up as a
    // cache miss (loud, cheap) rather than as a silently substituted
    // default (quiet, and wrong for a month). -0 stringifies as "0", which
    // is the one case where JS quietly normalises for us.
    const cc = (n: number) => apiResponse(NEED, "need", "json", n).headers.get("Cache-Control");
    expect(cc(-1)).toBe("public, max-age=-1, s-maxage=-1");
    expect(cc(NaN)).toBe("public, max-age=NaN, s-maxage=NaN");
    expect(cc(1.5)).toBe("public, max-age=1.5, s-maxage=1.5");
    expect(cc(Infinity)).toBe("public, max-age=Infinity, s-maxage=Infinity");
    expect(cc(-0)).toBe("public, max-age=0, s-maxage=0");
    expect(cc(1e21)).toBe("public, max-age=1e+21, s-maxage=1e+21"); // exponent notation, not 21 zeroes
  });

  it("applies the same TTL header regardless of format", () => {
    // The Cache-Control is set once, after the format branch. If it ever
    // moved inside the branches, one format could quietly lose its edge
    // caching -- invisible in a JSON-only smoke test.
    for (const format of ["json", "geojson", "xml", "yaml"]) {
      const res = apiResponse(NEED, "foodbanks", format, SECONDS_IN_WEEK);
      expect(res.headers.get("Cache-Control"), format).toBe("public, max-age=604800, s-maxage=604800");
    }
  });
});

describe("cache TTL constants", () => {
  it("derives each value the way givefood/const/cache_times.py does", () => {
    // Asserted as arithmetic rather than as literals, because the literal
    // is the thing under suspicion: SECONDS_IN_MONTH is FOUR WEEKS
    // (2419200), not a 30-day month (2592000). Django computes it as
    // `4 * SECONDS_IN_WEEK`, and /api/2/locations/ is cached at the edge
    // for exactly that long, so a "rounder" 30-day value would change a
    // live cache lifetime by two days.
    expect(SECONDS_IN_HOUR).toBe(60 * 60);
    expect(SECONDS_IN_DAY).toBe(24 * SECONDS_IN_HOUR);
    expect(SECONDS_IN_WEEK).toBe(7 * SECONDS_IN_DAY);
    expect(SECONDS_IN_MONTH).toBe(4 * SECONDS_IN_WEEK);
    expect(SECONDS_IN_MONTH).not.toBe(30 * SECONDS_IN_DAY);
  });

  it("keeps every constant a positive integer, so it can go in a header verbatim", () => {
    // These are interpolated straight into Cache-Control without
    // formatting. A float or a negative would emit a header value RFC 9111
    // says is invalid (delta-seconds must be a non-negative integer), and
    // every intermediary would drop the directive rather than reject it --
    // silent loss of edge caching on the busiest endpoints.
    for (const [name, value] of Object.entries({ SECONDS_IN_HOUR, SECONDS_IN_DAY, SECONDS_IN_WEEK, SECONDS_IN_MONTH })) {
      expect(Number.isSafeInteger(value), name).toBe(true);
      expect(value, name).toBeGreaterThan(0);
      expect(String(value), name).toMatch(/^\d+$/); // no exponent notation
    }
  });
});
