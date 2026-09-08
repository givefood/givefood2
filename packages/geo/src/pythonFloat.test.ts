import { describe, expect, it } from "vitest";
import { parseLatLngLikePython, pythonFloat } from "./pythonFloat";

// github #15 and #16. Two public, unauthenticated search endpoints answered
// 200 with ten arbitrary food banks and `distance_m: null` for a coordinate
// Django 500s on, because JS's Number()/parseFloat() answer NaN where
// Python's float() raises. This module is the raise.
//
// EVERY EXPECTATION BELOW WAS RUN THROUGH CPython 3 AGAINST THE REAL DJANGO
// SOURCE, not reasoned about. The table in the module header is the transcript.
// That matters more than usual here: the whole defect was a plausible-looking
// assumption about what a parser does with input nobody tried.
describe("pythonFloat -- what CPython's float() accepts", () => {
  it.each([
    ["51.5", 51.5],
    ["-0.12", -0.12],
    ["+51.5", 51.5],
    // Python accepts a bare trailing point and a bare leading point.
    ["51.", 51],
    [".5", 0.5],
    ["5e1", 50],
    ["5E1", 50],
    ["1e-2", 0.01],
    // str.strip() runs first, and a newline is whitespace to it.
    [" 51.5 ", 51.5],
    ["51.5\n", 51.5],
    // PEP 515. Looks like a typo, is not: float("1_0") is 10.0 since 3.6.
    // Rejecting it would 500 an input Django answers 200 for.
    ["1_0", 10],
    ["1_000.5", 1000.5],
  ])("accepts %o as %o, like float()", (input, expected) => {
    expect(pythonFloat(input)).toBe(expected);
  });

  it.each([
    // The realistic client bugs, and the reason both tickets exist.
    [""],
    [" "],
    // A half-built `${lat},${lng}` leaves one side empty.
    ["."],
    ["-"],
    ["+"],
    // Deliberate garbage.
    ["banana"],
    ["abc"],
    // JS's Number() says 16 and 3 for these. Python says no.
    ["0x10"],
    ["0b11"],
    ["0o17"],
    // Number("") is 0 and Number(" ") is 0 -- the two that made an empty
    // coordinate half look like a real search at 0,0 in the Atlantic.
    ["1,2"],
    ["5e"],
    ["1__0"],
    ["_1"],
    ["1_"],
  ])("rejects %o, like float()", (input) => {
    expect(() => pythonFloat(input)).toThrow(/could not convert string to float/);
  });

  // DELIBERATE DIVERGENCE 1, documented in the module. float() accepts these;
  // Django then dies a few lines later at `int(foodbank.distance)`
  // (gfapi1/views.py:132, gfapi2/views.py:414) -- ValueError for nan,
  // OverflowError for inf. Same 500 for the caller either way, and rejecting
  // here keeps NaN out of the distance maths this fix is about.
  it.each([["inf"], ["-inf"], ["Infinity"], ["nan"], ["NaN"]])("rejects %o, where float() accepts it and Django 500s later", (input) => {
    expect(() => pythonFloat(input)).toThrow(/could not convert string to float/);
  });

  // DELIBERATE DIVERGENCE 2. float("１２") really is 12.0 -- float() takes any
  // Unicode Nd character, fullwidth digits included. Recorded rather than
  // silently missed; no HTTP client has ever sent this.
  it("rejects non-ASCII decimal digits, where float() accepts them", () => {
    expect(() => pythonFloat("１２")).toThrow(/could not convert string to float/);
  });

  it("names the offending value the way Python's message does", () => {
    expect(() => pythonFloat("banana")).toThrow("could not convert string to float: 'banana'");
  });
});

describe("parseLatLngLikePython -- Django INDEXES, it does not unpack", () => {
  it("reads index 0 and 1 and ignores anything after them", () => {
    // THE ASSERTION THAT DISTINGUISHES THIS FROM THE OBVIOUS IMPLEMENTATION.
    // `is_uk()` and `find_foodbanks()` are float(lat_lng.split(",")[0]) and
    // [1], so a third part is ignored. CPython answers 51.5,-0.12 for both of
    // these. A `parts.length !== 2` check -- which is what the sibling helper
    // in api2/locations.ts does -- would 500 them, trading one divergence for
    // another.
    expect(parseLatLngLikePython("51.5,-0.12,junk")).toEqual([51.5, -0.12]);
    expect(parseLatLngLikePython("51.5,-0.12,")).toEqual([51.5, -0.12]);
  });

  it("reads a well-formed pair", () => {
    expect(parseLatLngLikePython("51.5,-0.12")).toEqual([51.5, -0.12]);
    expect(parseLatLngLikePython(" 51.5 , -0.12 ")).toEqual([51.5, -0.12]);
  });

  it("throws Python's IndexError, not its ValueError, when there is no index 1", () => {
    // `"51.5".split(",")[1]` is an IndexError in Python -- a different
    // exception from the empty-string ValueError below, and the distinction is
    // worth keeping because the two arrive by different routes. Both are
    // uncaught, so both are a 500.
    expect(() => parseLatLngLikePython("51.5")).toThrow(/list index out of range/);
    expect(() => parseLatLngLikePython("")).toThrow(/list index out of range/);
  });

  it.each([
    // Every one of these returned a 200 with the wrong food banks before the
    // fix. All are ValueError in CPython.
    ["51.5074,"],
    [",-0.1278"],
    [",,12"],
    [","],
    ["abc,def"],
    ["0x10,0x10"],
    [".,1"],
    ["-,1"],
  ])("throws on %o, which used to answer 200 with ten arbitrary food banks", (input) => {
    expect(() => parseLatLngLikePython(input)).toThrow(/could not convert string to float/);
  });
});
