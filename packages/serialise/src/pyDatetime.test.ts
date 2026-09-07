import { describe, expect, it } from "vitest";
import {
  formatDjangoJsonDatetime,
  formatIsoDatetime,
  formatPyStrDatetime,
  parsePyDatetime,
} from "./pyDatetime";

// Every expectation below was checked against the Django app this port
// replaces (/Users/jasoncartwright/Sites/foodcharity), running its own venv:
//
//   d = datetime(2020, 1, 24, 16, 30, 23, 173268)
//   json.dumps(d, cls=DjangoJSONEncoder) -> "2020-01-24T16:30:23.173"
//   d.isoformat()                        -> '2020-01-24T16:30:23.173268'
//   str(d)                               -> '2020-01-24 16:30:23.173268'
//   yaml.safe_dump(d)                    -> '2020-01-24 16:30:23.173268\n...'
//
// so these are not a restatement of the module's own comment block -- they
// are the third-party behaviour that block promises to reproduce. If Django
// is ever the thing that changed, these tests are the place it shows up.
//
// The two input shapes used throughout are the two shapes D1 actually holds,
// per the module header: rows the ETL copied out of Postgres carry Python's
// str(datetime), and rows this port has written since carry JavaScript's
// toISOString(). 114 of 34,175 foodbankchange rows were in the second shape
// when the mismatch was found by diffing beta against production.
//
// TWO NOTES ON HOW THESE ARE WRITTEN.
//
// Several assertions spell out a whole expected object or string rather
// than comparing two calls to the function under test. `expect(f(a))
// .toEqual(f(b))` is satisfied when BOTH sides are null, so a regex broken
// badly enough to reject every input would sail straight through it --
// exactly the mutation these tests exist to catch.
//
// Invisible characters (byte-order mark, non-breaking space) are always
// written as \u escapes, never pasted in as themselves: a literal one is
// invisible in every editor and would be "tidied" into a plain space by the
// first person to reformat the line, silently collapsing the test into a
// duplicate of the one above it.

const ETL_SHAPE = "2020-01-24 16:30:23.173268"; // Python str(datetime), from the Postgres ETL
const PORT_SHAPE = "2026-09-05T15:21:42.853Z"; // JavaScript toISOString(), written by this port

// The parse of ETL_SHAPE, written out once so tests can assert against a
// literal instead of against another call to the parser.
const ETL_PARTS = { date: "2020-01-24", time: "16:30:23", micro: "173268" };

// A non-breaking space where the separator should be: the one
// paste-from-a-spreadsheet corruption that looks completely correct in
// every log line and diff a person would go looking at.
const NBSP_SEPARATOR = "2020-01-24\u00A016:30:23";

describe("parsePyDatetime", () => {
  it("accepts both shapes D1 holds, because a serialiser sees both on one endpoint", () => {
    // The bug this module was written for: an API consumer got a different
    // datetime shape for a need found yesterday than for one found in 2020,
    // from the same endpoint. Both must reach the same Parts structure.
    expect(parsePyDatetime(ETL_SHAPE)).toEqual(ETL_PARTS);
    expect(parsePyDatetime(PORT_SHAPE)).toEqual({
      date: "2026-09-05",
      time: "15:21:42",
      micro: "853000",
    });
  });

  it("always returns exactly six digits of micro, even with no fractional part", () => {
    // The Parts interface documents `micro` as "exactly six digits, '000000'
    // when absent". fraction() then compares it against the literal "000000"
    // to decide whether to print anything at all, so a shorter or longer
    // string here would silently turn a zero-microsecond value into a
    // printed fraction -- a divergence from Python in every one of the three
    // renderings at once.
    //
    // The exact value is asserted for every case, not just the length: a
    // padEnd(6, "9") -- or any pad character other than "0" -- keeps the
    // length invariant while corrupting the microsecond by up to a second.
    const micros: Array<[string, string]> = [
      ["2020-01-24 16:30:23", "000000"],
      ["2020-01-24T16:30:23Z", "000000"],
      ["2020-01-24 16:30:23.0", "000000"],
      ["2020-01-24 16:30:23.173268", "173268"],
      ["2026-09-05T15:21:42.853Z", "853000"],
    ];
    for (const [raw, expected] of micros) {
      expect(parsePyDatetime(raw)!.micro).toBe(expected);
      expect(parsePyDatetime(raw)!.micro).toHaveLength(6);
    }
  });

  it("pads a short fraction on the RIGHT: .5 is half a second, not five microseconds", () => {
    // padEnd, not padStart. A fraction is left-aligned by definition, so
    // ".5" means 500000us. Swapping to padStart would read it as 000005us
    // and quietly move the timestamp back by half a second -- small enough
    // to never be noticed, big enough to reorder two needs found in the
    // same second.
    expect(parsePyDatetime("2020-01-24 16:30:23.5")!.micro).toBe("500000");
    expect(parsePyDatetime("2020-01-24 16:30:23.17")!.micro).toBe("170000");
    expect(parsePyDatetime("2020-01-24 16:30:23.173")!.micro).toBe("173000");
    // Five digits is the width the two pad directions differ least on, and
    // so the one a hand-check is likeliest to wave through: 17326 tenths of
    // a microsecond is 173260us, not 017326us.
    expect(parsePyDatetime("2020-01-24 16:30:23.17326")!.micro).toBe("173260");
  });

  it("treats a fraction that is present but all zeros as no fraction at all", () => {
    // ".0" is what a hand-written row or another language's formatter emits
    // for a whole second, and it has to land on the same "000000" the
    // absent-fraction case produces -- fraction() tests that exact literal,
    // so a value of "0" or "00" here would start printing ".0"/".00" in
    // JSON and XML where Python prints nothing at all.
    for (const f of [".0", ".00", ".000", ".0000", ".00000", ".000000"]) {
      expect(parsePyDatetime(`2020-01-24 16:30:23${f}`)!.micro).toBe("000000");
    }
    // ...and the consequence, at the level the API actually renders: all
    // three formatters drop it, exactly as they do for a bare "16:30:23".
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.0")).toBe("2020-01-24T16:30:23");
    expect(formatIsoDatetime("2020-01-24 16:30:23.0")).toBe("2020-01-24T16:30:23");
    expect(formatPyStrDatetime("2020-01-24 16:30:23.0")).toBe("2020-01-24 16:30:23");
  });

  it("drops a trailing Z or offset rather than converting it", () => {
    // Stated explicitly in the module header: all Django datetimes here are
    // NAIVE UTC (USE_TZ = False, TZ pinned to UTC), so the wall-clock fields
    // are taken as-is. The Z on a toISOString() row is therefore noise to be
    // stripped, not an instruction to shift anything.
    expect(parsePyDatetime("2020-01-24T16:30:23.173268Z")).toEqual(ETL_PARTS);
    // An offset is likewise dropped and NOT applied -- the hour stays 16,
    // it does not become 11. Nothing in this system should ever produce an
    // offset row; this pins what happens if one appears.
    expect(parsePyDatetime("2020-01-24T16:30:23.173268+05:00")).toEqual(ETL_PARTS);
    expect(parsePyDatetime("2020-01-24T16:30:23.173268-0500")).toEqual(ETL_PARTS);
    // Accepted with no fraction at all too -- the shape toISOString() never
    // emits but a hand-written UTC value often does.
    expect(parsePyDatetime("2020-01-24 16:30:23+05:00")).toEqual({
      date: "2020-01-24",
      time: "16:30:23",
      micro: "000000",
    });
    // The point of dropping rather than converting, asserted on the
    // RENDERED value: a parser that "helpfully" normalised +05:00 would
    // move a published need's timestamp five hours, with nothing in the
    // response to show that it had.
    expect(formatPyStrDatetime("2020-01-24T16:30:23.173268+05:00")).toBe(ETL_SHAPE);
  });

  it("accepts either separator, since the two D1 shapes disagree about it", () => {
    // Asserted against a literal rather than against each other: two nulls
    // are equal too, and a regex that had lost its `[ T]` class entirely
    // would pass a parse-equals-parse check while breaking every row.
    expect(parsePyDatetime("2020-01-24 16:30:23.173268")).toEqual(ETL_PARTS);
    expect(parsePyDatetime("2020-01-24T16:30:23.173268")).toEqual(ETL_PARTS);
  });

  it("tolerates surrounding whitespace, including a BOM from a CSV import", () => {
    // raw.trim() before matching. Column values arriving from a hand-edited
    // dump or a CSV import have been known to carry a trailing space; one
    // of those should not fall out of the parser and back to raw output.
    // JS trim() strips the whole Unicode whitespace set, so a byte-order
    // mark or a non-breaking space pasted in from a spreadsheet goes too --
    // worth pinning, because a file import is precisely the route by which
    // a stray invisible character arrives.
    expect(parsePyDatetime("  2020-01-24 16:30:23.173268  ")).toEqual(ETL_PARTS);
    expect(parsePyDatetime("\t2020-01-24 16:30:23.173268\n")).toEqual(ETL_PARTS);
    expect(parsePyDatetime("\uFEFF2020-01-24 16:30:23.173268")).toEqual(ETL_PARTS);
    expect(parsePyDatetime("\u00A02020-01-24 16:30:23.173268\u00A0")).toEqual(ETL_PARTS);
  });

  it("returns null rather than throwing for anything it cannot read", () => {
    // null is the signal the formatters use to fall back to pass-through.
    // The empty string matters most: a nullable D1 column read as "" must
    // not become a parse crash inside a 1,000-row list response.
    expect(parsePyDatetime("")).toBeNull();
    expect(parsePyDatetime("   ")).toBeNull();
    expect(parsePyDatetime("not a date")).toBeNull();
    expect(parsePyDatetime("2020-01-24")).toBeNull(); // date only, no time
    expect(parsePyDatetime("16:30:23")).toBeNull(); // time only, no date
    expect(parsePyDatetime("1579883423")).toBeNull(); // a unix timestamp
    expect(parsePyDatetime("2020-01-24 16:30:23.")).toBeNull(); // fraction marker, no digits
    // Trailing junk after a value that starts out valid. The regex is
    // anchored at both ends; if the `$` were ever lost, these would parse
    // and the trailing text would vanish from the response silently.
    expect(parsePyDatetime("2020-01-24 16:30:23 (approx)")).toBeNull();
    expect(parsePyDatetime("2020-01-24 16:30:23\nsecond line")).toBeNull();
    // ...and junk in FRONT, which only the `^` anchor rejects. The
    // five-digit-year case below proves a DIGIT prefix is rejected; these
    // prove a non-digit one is too, and they are not the same mutation.
    // Loosening `^` to `(?:^|\s)` -- the shape a "tolerate a label in front
    // of the value" change naturally takes -- passes every other assertion
    // in this file, while rewriting "need found <ts>" to the bare timestamp
    // and deleting the words from the response.
    expect(parsePyDatetime("need found 2020-01-24 16:30:23")).toBeNull();
    expect(parsePyDatetime("created=2020-01-24 16:30:23")).toBeNull();
    expect(parsePyDatetime("[2020-01-24 16:30:23]")).toBeNull();
  });

  it("requires zero-padded fields and a single ASCII separator", () => {
    // The regex is deliberately strict about widths: it is the thing that
    // decides whether a value is one of our two known shapes or something
    // unknown that should be passed through untouched. A loose match here
    // would reformat -- and so change -- values it does not understand.
    expect(parsePyDatetime("2020-1-24 16:30:23")).toBeNull();
    expect(parsePyDatetime("2020-01-24 6:30:23")).toBeNull();
    expect(parsePyDatetime("2020-01-24  16:30:23")).toBeNull(); // two spaces
    expect(parsePyDatetime("2020-01-24t16:30:23")).toBeNull(); // lowercase t
    expect(parsePyDatetime("2020-01-24 16:30")).toBeNull(); // no seconds
    expect(parsePyDatetime("2020-01-24 16:30:23.1732689")).toBeNull(); // 7 digits
    expect(parsePyDatetime("2020-01-24T16:30:23.173268z")).toBeNull(); // lowercase z
    // A comma is the decimal separator ISO 8601 itself prefers, and what a
    // European-locale export writes. Python never emits one, so a value
    // carrying it is not one of our two shapes. Widening the fraction to
    // `[.,]` is the tempting one-character "be liberal" edit, and it is
    // worse than useless here: the comma sits outside the capture group, so
    // the value would be reprinted with a DOT -- a character the consumer
    // sent us, silently changed, in a value we did not understand.
    expect(parsePyDatetime("2020-01-24 16:30:23,173268")).toBeNull();
    // A non-breaking space is trimmed at the ENDS (test above) but is not
    // the `[ T]` the regex wants in the middle.
    expect(parsePyDatetime(NBSP_SEPARATOR)).toBeNull();
    // Postgres renders a timestamptz offset with TWO digits and no colon
    // (`2020-01-24 16:30:23.173268+00`), which `[+-]\d{2}:?\d{2}` does not
    // match. Pinned because it is a plausible future ETL output and the
    // failure is quiet: the value passes straight through, which is the
    // mixed-shape bug this module exists to fix, coming back.
    expect(parsePyDatetime("2020-01-24 16:30:23.173268+00")).toBeNull();
  });

  it("matches ASCII digits only -- \\d has no /u flag here", () => {
    // Arabic-Indic and fullwidth digits are what a value pasted out of a
    // localised spreadsheet, or typed through an IME into the admin, looks
    // like. JavaScript's \d is ASCII 0-9 even under the /u flag, so these
    // are rejected and pass through rather than being misread as a date --
    // only an explicit \p{Nd} would widen the class, and this test is what
    // makes that a deliberate act rather than a plausible-looking tidy-up.
    // (Checked by mutation: swapping every \d for \p{Nd} fails this test;
    // adding /u alone changes nothing, which is why it is not asserted.)
    expect(parsePyDatetime("٢٠٢٠-01-24 16:30:23")).toBeNull();
    expect(parsePyDatetime("２０２０-01-24 16:30:23")).toBeNull();
    expect(parsePyDatetime("2020-01-24 １６:30:23")).toBeNull();
  });

  it("spans Python's whole datetime range and nothing wider", () => {
    // str(datetime.min) == '0001-01-01 00:00:00' and str(datetime.max) ==
    // '9999-12-31 23:59:59.999999', so a four-digit zero-padded year covers
    // every value Django can possibly hand the ETL -- and a five-digit year
    // is not a datetime at all, so it must pass through untouched rather
    // than be cut down to its first four digits.
    expect(parsePyDatetime("0001-01-01 00:00:00")).toEqual({
      date: "0001-01-01",
      time: "00:00:00",
      micro: "000000",
    });
    expect(parsePyDatetime("9999-12-31 23:59:59.999999")).toEqual({
      date: "9999-12-31",
      time: "23:59:59",
      micro: "999999",
    });
    expect(parsePyDatetime("12020-01-24 16:30:23")).toBeNull();
    expect(formatPyStrDatetime("12020-01-24 16:30:23")).toBe("12020-01-24 16:30:23");
  });

  it("does no calendar validation -- it matches a shape, not a real date", () => {
    // Current behaviour, pinned deliberately rather than endorsed: month 13
    // and hour 99 satisfy \d{2} and sail through. That is consistent with
    // the module's stated job (reshape a string that is already a datetime
    // in D1, never validate one), and with the pass-through policy: a row
    // this absurd is a data problem, and turning it into a 500 in the
    // middle of a list response would be strictly worse. See notes if this
    // is ever tightened.
    expect(parsePyDatetime("2020-13-45 99:99:99")).toEqual({
      date: "2020-13-45",
      time: "99:99:99",
      micro: "000000",
    });
    // Year zero and 30 February likewise: shapes Python cannot construct,
    // reshaped rather than rejected.
    expect(parsePyDatetime("0000-02-30 24:00:00")).toEqual({
      date: "0000-02-30",
      time: "24:00:00",
      micro: "000000",
    });
    // Which means an impossible value is REWRITTEN rather than passed
    // through: the one class of bad row the pass-through policy does not
    // hand back verbatim.
    expect(formatDjangoJsonDatetime("2020-13-45 99:99:99")).toBe("2020-13-45T99:99:99");
  });

  it("throws on null or undefined, which the pass-through policy does NOT cover", () => {
    // CURRENT BEHAVIOUR, pinned rather than fixed, and reported alongside
    // this file. The module says an unparseable value "is returned
    // unchanged rather than thrown on" so that one odd row cannot 500 a
    // 1,000-row list -- but raw.trim() is unguarded, and SQL NULL is the
    // commonest odd value these columns hold: foodbank.last_need,
    // last_need_check and edited are all nullable TEXT, typed
    // `string | null` in packages/db/src/foodbank.ts. api1.ts:293 guards
    // `last_need` explicitly; nothing makes the next caller do the same.
    //
    // The same throw is pinned from the other end in yaml.test.ts, where it
    // surfaces as a 500 on /api/2/*?format=yaml.
    expect(() => parsePyDatetime(null as unknown as string)).toThrow(TypeError);
    expect(() => parsePyDatetime(undefined as unknown as string)).toThrow(TypeError);
    expect(() => formatPyStrDatetime(null as unknown as string)).toThrow(TypeError);
    expect(() => formatDjangoJsonDatetime(null as unknown as string)).toThrow(TypeError);
    expect(() => formatIsoDatetime(null as unknown as string)).toThrow(TypeError);
    // A number is the other non-string a D1 read can produce (an INTEGER
    // column pulled through an untyped query); it throws too, rather than
    // being coerced and reshaped.
    expect(() => parsePyDatetime(20200124 as unknown as string)).toThrow(TypeError);
    // An array and an object throw for the same reason -- `.trim` is not a
    // function on either. The ARRAY is the one worth spelling out, because
    // it is what makes "just coerce the input" the wrong fix: a row read
    // through .raw() hands back a column as a one-element array, and
    // String(["2020-01-24 16:30:23"]) is the datetime string itself. A
    // String(raw ?? "") guard would therefore not merely stop throwing, it
    // would start silently ACCEPTING a value that is not a timestamp at
    // all, and the null case it was added for would quietly become "".
    expect(() => parsePyDatetime([] as unknown as string)).toThrow(TypeError);
    expect(() => parsePyDatetime([ETL_SHAPE] as unknown as string)).toThrow(TypeError);
    expect(() => parsePyDatetime({} as unknown as string)).toThrow(TypeError);
  });

  it("is the predicate yaml.ts resolves timestamps with, so it must be stateless", () => {
    // yaml.ts wires parsePyDatetime into a js-yaml scalar tag's resolve(),
    // which js-yaml calls once per candidate scalar while dumping. The
    // module-level RAW_RE has no /g flag; if one were ever added, .exec()
    // would carry lastIndex between calls and return null for every other
    // row -- half a 1,000-row list silently reverting to raw output, with
    // nothing in the diff to suggest it.
    //
    // It is also what pins that every call returns its OWN Parts object.
    // Filling one module-level object and returning it each time is a
    // plausible allocation "saving" for a function called once per scalar
    // per row; under it, this array would hold six references to the LAST
    // row's fields and every earlier row would read as the final one.
    //
    // Values of different lengths, interleaved, because a stateful regex
    // fails as a function of where the previous match ended: a run of one
    // identical string can hide that, a mixed run cannot.
    const mixed = [ETL_SHAPE, "2020-01-24 16:30:23", PORT_SHAPE, ETL_SHAPE, "not a date", ETL_SHAPE];
    expect(mixed.map(parsePyDatetime)).toEqual([
      ETL_PARTS,
      { date: "2020-01-24", time: "16:30:23", micro: "000000" },
      { date: "2026-09-05", time: "15:21:42", micro: "853000" },
      ETL_PARTS,
      null,
      ETL_PARTS,
    ]);
  });
});

describe("formatDjangoJsonDatetime", () => {
  // DjangoJSONEncoder.default(), django/core/serializers/json.py:
  //   r = o.isoformat()
  //   if o.microsecond:
  //       r = r[:23] + r[26:]
  // Reached via JsonResponse at gfapi1/views.py:231 and :250 ("created":
  // need.created), and for gfapi2's created/found values.

  it("truncates to three fractional digits, matching DjangoJSONEncoder", () => {
    // Verified: json.dumps(datetime(2020,1,24,16,30,23,173268),
    //   cls=DjangoJSONEncoder) == '"2020-01-24T16:30:23.173"'
    expect(formatDjangoJsonDatetime(ETL_SHAPE)).toBe("2020-01-24T16:30:23.173");
    expect(formatDjangoJsonDatetime(PORT_SHAPE)).toBe("2026-09-05T15:21:42.853");
  });

  it("truncates rather than rounds -- .999999 becomes .999, never .1000 or the next second", () => {
    // r[:23] is a SLICE. This is the case that separates a correct port
    // from a plausible-looking toFixed(3) one: Python renders 999999us as
    // ".999", losing 999us, and does not carry into the seconds field.
    // Verified against DjangoJSONEncoder.
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.999999")).toBe(
      "2020-01-24T16:30:23.999",
    );
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.999500")).toBe(
      "2020-01-24T16:30:23.999",
    );
    // The instant where rounding would carry all the way into the DATE: new
    // year's eve stays on 31 December, and stays in 2020.
    expect(formatDjangoJsonDatetime("2020-12-31 23:59:59.999999")).toBe(
      "2020-12-31T23:59:59.999",
    );
  });

  it("widens a short fraction to three digits: .9 is .900, not .9", () => {
    // Python has no short fractions -- microsecond is an integer and
    // isoformat() prints six digits whenever it prints any -- so the slice
    // to r[:23] necessarily yields exactly three. Verified:
    //   json.dumps(datetime(2020,1,24,16,30,23,900000), cls=DjangoJSONEncoder)
    //     == '"2020-01-24T16:30:23.900"'
    // An implementation that echoed the input's own fraction width, or that
    // trimmed trailing zeros, would emit ".9" here -- wrong only for
    // hand-written rows, the ones nobody has a golden file for.
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.9")).toBe("2020-01-24T16:30:23.900");
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.85")).toBe("2020-01-24T16:30:23.850");
  });

  it("prints .000 for a sub-millisecond microsecond, because Python tests microsecond not the digits", () => {
    // The subtlest line in DjangoJSONEncoder. `if o.microsecond:` is true
    // for 1us, so the slice runs and yields ".000" -- a fraction made
    // entirely of zeros, which Python still prints. Verified:
    //   json.dumps(datetime(2020,1,24,16,30,23,1), cls=DjangoJSONEncoder)
    //     == '"2020-01-24T16:30:23.000"'
    // An implementation that stripped trailing zeros, or that decided
    // "all-zero fraction means omit", would drop this to "...23" and stop
    // matching Django exactly here and nowhere else.
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.000001")).toBe(
      "2020-01-24T16:30:23.000",
    );
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.000999")).toBe(
      "2020-01-24T16:30:23.000",
    );
  });

  it("omits the fraction entirely when the microsecond field is zero", () => {
    // `if o.microsecond:` is false, so isoformat()'s own output stands --
    // and isoformat() prints no fraction at microsecond 0. Verified:
    //   json.dumps(datetime(2020,1,24,16,30,23,0), cls=DjangoJSONEncoder)
    //     == '"2020-01-24T16:30:23"'
    // Note this makes the field VARIABLE length, unlike the writer helper
    // in @givefood/models, which always pads to six digits for sort order.
    // Both are correct for their own job; this one is on the wire.
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23")).toBe("2020-01-24T16:30:23");
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.000000")).toBe(
      "2020-01-24T16:30:23",
    );
    // The shape @givefood/models writes at a whole second, which the API
    // layer re-derives Python's rendering from.
    expect(formatDjangoJsonDatetime("2026-09-05T19:28:08.000Z")).toBe(
      "2026-09-05T19:28:08",
    );
    // The boundary against the test above, side by side: one microsecond
    // apart, and the presence of a fraction flips.
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.000000")).toBe("2020-01-24T16:30:23");
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.000001")).toBe("2020-01-24T16:30:23.000");
  });

  it("uses the T separator whatever the input separator was", () => {
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.173268")).toBe(
      "2020-01-24T16:30:23.173",
    );
    expect(formatDjangoJsonDatetime("2020-01-24T16:30:23.173268")).toBe(
      "2020-01-24T16:30:23.173",
    );
  });

  it("emits no trailing Z, because a naive datetime never gets one from Django", () => {
    // The encoder appends Z only after `if r.endswith("+00:00")`, which an
    // AWARE datetime produces. This app runs USE_TZ = False, so isoformat()
    // ends at the seconds/fraction and no Z is ever added. Feeding in a
    // toISOString() row must not smuggle its Z through to the response.
    expect(formatDjangoJsonDatetime(PORT_SHAPE)).not.toContain("Z");
    expect(formatDjangoJsonDatetime("2020-01-24T16:30:23Z")).toBe("2020-01-24T16:30:23");
    // +00:00 is the offset that has to be named explicitly, because it is
    // the exact string Django's Z branch keys on:
    //   if r.endswith("+00:00"): r = r[:-6] + "Z"
    // Only an AWARE UTC datetime makes isoformat() end that way, and this
    // app has none (USE_TZ = False), so the branch must never fire. A port
    // that reproduced it by pattern-matching the INPUT -- which is how
    // someone reading the Django source and not the module header above
    // would port it -- appends a Z here and nowhere else. Every other
    // assertion in this describe uses Z or +05:00 and would still pass.
    expect(formatDjangoJsonDatetime("2020-01-24T16:30:23.173268+00:00")).toBe(
      "2020-01-24T16:30:23.173",
    );
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23+00:00")).toBe("2020-01-24T16:30:23");
    // Exactly 19 or 23 characters, never 20 or 24: the only two lengths
    // DjangoJSONEncoder can produce for a naive datetime, and the cheapest
    // way to say that no suffix of any kind survives.
    expect([19, 23]).toContain(formatDjangoJsonDatetime(PORT_SHAPE).length);
    expect([19, 23]).toContain(formatDjangoJsonDatetime("2020-01-24T16:30:23+05:00").length);
  });
});

describe("formatIsoDatetime", () => {
  // datetime.isoformat(), which dicttoxml calls on a datetime value (xml.ts
  // uses this one). Six fractional digits, T separator.

  it("keeps all six fractional digits, matching datetime.isoformat()", () => {
    // Verified: datetime(2020,1,24,16,30,23,173268).isoformat()
    //   == '2020-01-24T16:30:23.173268'
    expect(formatIsoDatetime(ETL_SHAPE)).toBe("2020-01-24T16:30:23.173268");
  });

  it("zero-fills a millisecond-precision row to six digits", () => {
    // JavaScript only has milliseconds, so a row this port wrote carries
    // three digits. Python would have stored six; isoformat() on 853000us
    // is '...42.853000', not '...42.853'. Verified.
    expect(formatIsoDatetime(PORT_SHAPE)).toBe("2026-09-05T15:21:42.853000");
    // The same rule for a one-digit fraction: 900000us, printed in full.
    expect(formatIsoDatetime("2020-01-24 16:30:23.9")).toBe("2020-01-24T16:30:23.900000");
  });

  it("omits the fraction at microsecond zero", () => {
    // datetime(2020,1,24,16,30,23,0).isoformat() == '2020-01-24T16:30:23'.
    // Python omits, it does not print '.000000'.
    expect(formatIsoDatetime("2020-01-24 16:30:23")).toBe("2020-01-24T16:30:23");
    expect(formatIsoDatetime("2020-01-24 16:30:23.000000")).toBe("2020-01-24T16:30:23");
  });

  it("emits no Z, so the XML body never claims a timezone Django did not send", () => {
    // isoformat() on a NAIVE datetime has no suffix at all; only an aware
    // one appends +00:00. xml.ts puts this straight into an element body,
    // so a leaked Z would tell every XML consumer the value is UTC-aware
    // when nothing else in the API says so.
    expect(formatIsoDatetime(PORT_SHAPE)).toBe("2026-09-05T15:21:42.853000");
    expect(formatIsoDatetime("2020-01-24T16:30:23Z")).toBe("2020-01-24T16:30:23");
    expect(formatIsoDatetime("2020-01-24T16:30:23.173268+05:00")).toBe(
      "2020-01-24T16:30:23.173268",
    );
    // +00:00 specifically: isoformat() on an AWARE UTC datetime ends with
    // it, and that is the only way a Django datetime string ever carries a
    // UTC marker. Dropping it here is what keeps the XML body honest about
    // the value being naive -- a "+00:00" or a "Z" left on the end would
    // tell an XML consumer this API declares timezones, which it does not.
    expect(formatIsoDatetime("2020-01-24T16:30:23.173268+00:00")).toBe(
      "2020-01-24T16:30:23.173268",
    );
  });

  it("keeps a sub-millisecond value that the JSON rendering would flatten to .000", () => {
    // The same instant renders differently in two formats on purpose --
    // PLAN.md 7.4.6's "the same value, three renderings". XML keeps the
    // 1us; JSON truncates it away. A future refactor that shared one
    // formatter between the two would break exactly one of these.
    expect(formatIsoDatetime("2020-01-24 16:30:23.000001")).toBe(
      "2020-01-24T16:30:23.000001",
    );
    expect(formatDjangoJsonDatetime("2020-01-24 16:30:23.000001")).toBe(
      "2020-01-24T16:30:23.000",
    );
  });
});

describe("formatPyStrDatetime", () => {
  // str(datetime), i.e. isoformat(sep=" "). Used for gfapi1's `updated`
  // (views.py wraps latest_need_date() in str()) and gfapi3's `found`
  // (gfapi3/views.py:75, `str(dp.foodbank.latest_need.created)`), and it is
  // also PyYAML's timestamp scalar, which yaml.ts emits.

  it("uses a space separator and six fractional digits, matching str(datetime)", () => {
    // Verified: str(datetime(2020,1,24,16,30,23,173268))
    //   == '2020-01-24 16:30:23.173268'
    expect(formatPyStrDatetime(ETL_SHAPE)).toBe("2020-01-24 16:30:23.173268");
    expect(formatPyStrDatetime(PORT_SHAPE)).toBe("2026-09-05 15:21:42.853000");
  });

  it("matches PyYAML's timestamp scalar, which yaml.ts depends on staying plain", () => {
    // yaml.ts hands this string to js-yaml wrapped in PyTimestamp so it is
    // emitted as a BARE timestamp scalar rather than a quoted string. That
    // only works while the text still resolves as a YAML 1.1 timestamp --
    // which requires the space separator and the digits below. Verified
    // against PyYAML: yaml.safe_dump(datetime(2020,1,24,16,30,23,173268))
    //   == '2020-01-24 16:30:23.173268\n...\n'
    //
    // Checked across every shape this function can emit -- with a fraction
    // and without, from each of the two D1 input shapes -- because
    // resolve() runs on this function's OUTPUT, not on the column value.
    //
    // The expected rendering AND the expected re-parse are both written out
    // as literals. `expect(parsePyDatetime(rendered)).not.toBeNull()` was
    // the obvious way to write this and is nearly worthless: if the parser
    // rejected everything, `rendered` would be `raw` passed through -- which
    // for ETL_SHAPE still satisfies the regex above -- and both sides of a
    // parse-against-parse comparison would be null.
    const cases = [
      { raw: ETL_SHAPE, rendered: ETL_SHAPE, parts: ETL_PARTS },
      {
        raw: PORT_SHAPE,
        rendered: "2026-09-05 15:21:42.853000",
        parts: { date: "2026-09-05", time: "15:21:42", micro: "853000" },
      },
      {
        raw: "2020-01-24 16:30:23",
        rendered: "2020-01-24 16:30:23",
        parts: { date: "2020-01-24", time: "16:30:23", micro: "000000" },
      },
      {
        raw: "2020-01-24T16:30:23Z",
        rendered: "2020-01-24 16:30:23",
        parts: { date: "2020-01-24", time: "16:30:23", micro: "000000" },
      },
    ];
    for (const { raw, rendered, parts } of cases) {
      expect(formatPyStrDatetime(raw)).toBe(rendered);
      // A space separator and no suffix: the subset of YAML 1.1's timestamp
      // grammar js-yaml's built-in resolver accepts, which is what lets the
      // scalar stay unquoted.
      expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/);
      // The round trip resolve() relies on: whatever this prints must parse
      // back to the same instant, or js-yaml quotes the scalar and changes
      // the value's TYPE on the wire.
      expect(parsePyDatetime(rendered)).toEqual(parts);
    }
  });

  it("omits the fraction at microsecond zero", () => {
    // str(datetime(2020,1,24,16,30,23,0)) == '2020-01-24 16:30:23'.
    expect(formatPyStrDatetime("2020-01-24 16:30:23.000000")).toBe("2020-01-24 16:30:23");
    // Which means it does NOT round-trip the writer helper in
    // @givefood/models byte for byte: that helper always writes .000000 so
    // stored values sort correctly, and this strips it back to what Python
    // would have put on the wire. That asymmetry is intentional and is what
    // the models module's closing comment refers to.
    expect(formatPyStrDatetime("2026-09-05 19:28:08.000000")).toBe(
      "2026-09-05 19:28:08",
    );
  });

  it("never emits a T, which is what made the two D1 shapes visible to consumers", () => {
    expect(formatPyStrDatetime(PORT_SHAPE)).not.toContain("T");
    expect(formatPyStrDatetime(PORT_SHAPE)).not.toContain("Z");
    // Stated positively as well, so that a formatter which stopped
    // reformatting altogether could not pass by accident on a value that
    // happens to contain neither character.
    expect(formatPyStrDatetime(PORT_SHAPE)).toBe("2026-09-05 15:21:42.853000");
    // And no offset survives either, +00:00 included -- yaml.ts feeds this
    // output back through parsePyDatetime as its resolve() predicate, and a
    // trailing "+00:00" would still satisfy that predicate while emitting a
    // scalar PyYAML never writes for a naive datetime.
    expect(formatPyStrDatetime("2020-01-24T16:30:23.173268+00:00")).toBe(ETL_SHAPE);
    expect(formatPyStrDatetime("2020-01-24T16:30:23.173268+05:00")).toBe(ETL_SHAPE);
  });
});

describe("all three formatters", () => {
  const formatters = [formatDjangoJsonDatetime, formatIsoDatetime, formatPyStrDatetime];

  it("render the two D1 shapes of one instant identically", () => {
    // The actual defect this module fixed. The ETL wrote 2020 rows as
    // str(datetime) and the port writes new rows as toISOString(); before
    // the fix each was passed through raw, so /api/1/needs/ handed a
    // consumer two different datetime formats in one JSON array depending
    // on how old the row was. Same instant in, same string out, per format.
    //
    // The expected strings are spelled out as well as compared, so this
    // cannot be satisfied by three formatters that agree on something wrong
    // -- both inputs passed through unchanged, say.
    const fromEtl = "2026-09-05 15:21:42.853000";
    const fromPort = "2026-09-05T15:21:42.853Z";
    const expected = [
      "2026-09-05T15:21:42.853",
      "2026-09-05T15:21:42.853000",
      "2026-09-05 15:21:42.853000",
    ];
    formatters.forEach((format, i) => {
      expect(format(fromEtl)).toBe(expected[i]);
      expect(format(fromPort)).toBe(expected[i]);
    });
  });

  it("return an unparseable value completely unchanged", () => {
    // The pass-through policy, stated in the module: a single odd row must
    // not 500 a 1,000-row list, and the degraded output is the raw string
    // the site was already shipping before the fix. Whitespace is NOT
    // trimmed on this path -- trim() is used for matching only, so the
    // fallback really is the original value byte for byte.
    for (const format of formatters) {
      expect(format("")).toBe("");
      expect(format("not a date")).toBe("not a date");
      expect(format("2020-01-24")).toBe("2020-01-24");
      expect(format("  2020-01-24  ")).toBe("  2020-01-24  ");
      expect(format("0000-00-00 00:00:0")).toBe("0000-00-00 00:00:0");
    }
  });

  it("pass a NEAR-miss through byte for byte rather than half-reformatting it", () => {
    // The sharper half of the pass-through policy, and the one a loosened
    // regex breaks first. Each value below differs from a valid one in
    // exactly one respect, so a regex that started tolerating that respect
    // would start silently REWRITING real production values -- the class of
    // change that is invisible in a diff of this module and visible only in
    // an API consumer's parser.
    const nearMisses = [
      "2020-01-24 16:30:23.1732689", // seven fractional digits
      "2020-01-24 16:30:23.173268+00", // Postgres two-digit offset
      "2020-01-24t16:30:23.173268", // lowercase separator
      "2020-1-24 16:30:23.173268", // unpadded month
      "2020-01-24 16:30:23.", // fraction marker, no digits
      NBSP_SEPARATOR, // non-breaking space as the separator
      "２０２０-01-24 16:30:23", // fullwidth digits
      "2020-01-24 16:30:23,173268", // comma decimal separator
      "need found 2020-01-24 16:30:23", // a label in front of the value
    ];
    for (const format of formatters) {
      for (const raw of nearMisses) {
        expect(format(raw)).toBe(raw);
      }
    }
  });

  it("never throw on a string, however malformed or large", () => {
    // "never throws" is the invariant the pass-through exists to provide.
    // Anything reaching a formatter has come out of a TEXT column, so it
    // could be any string at all. The 100k values are here for a second
    // reason: RAW_RE has no nested quantifier, so a huge near-match must
    // fail in linear time rather than hanging the isolate -- if that ever
    // changed, this test would time out rather than fail.
    //
    // Every value is asserted to come back RIGHT, not merely quietly. A
    // loop of bare not.toThrow() calls is satisfied by a formatter that
    // returns undefined for every one of them -- which is not "not
    // throwing", it is the 1,000-row list arriving full of nulls, i.e. the
    // outcome the pass-through policy exists to avoid.
    const nasty = [
      "",
      " ",
      "\n\t",
      "null",
      "undefined",
      "NaN",
      "0",
      "-0",
      "\\d{4}-\\d{2}-\\d{2}",
      "9".repeat(500),
      "2020-01-24 16:30:23" + "0".repeat(1000),
      "2020-01-24 16:30:23." + "1".repeat(100_000),
      "\u{1F96B}",
      NBSP_SEPARATOR,
    ];
    for (const format of formatters) {
      for (const raw of nasty) {
        expect(() => format(raw)).not.toThrow();
        // None of these is a datetime, so each comes back byte for byte --
        // including "0" and "-0", which a formatter reaching for Number()
        // or Date() somewhere in its fallback would not survive.
        expect(format(raw)).toBe(raw);
      }
    }
    // Whitespace is the one kind of junk that does NOT force a
    // pass-through, because trim() runs before matching: these three are
    // real datetimes wearing it, and must be reformatted rather than
    // handed back. The 100k-space value is also where the linear-time
    // claim above is actually exercised.
    const wearingJunk = [
      "2020-01-24 16:30:23.173268 ",
      `${ETL_SHAPE}\u00A0`,
      " ".repeat(100_000) + ETL_SHAPE + " ".repeat(100_000),
    ];
    for (const raw of wearingJunk) {
      expect(formatPyStrDatetime(raw)).toBe(ETL_SHAPE);
      expect(formatIsoDatetime(raw)).toBe("2020-01-24T16:30:23.173268");
      expect(formatDjangoJsonDatetime(raw)).toBe("2020-01-24T16:30:23.173");
    }
  });

  it("agree on the date, time and ordering of the values they render", () => {
    // Three renderings, one instant: the date and time fields must be
    // identical across formats, and each format must sort chronologically
    // among values of its own kind. A list endpoint sorted by the rendered
    // string (or a consumer doing so) depends on the second half.
    //
    // Array.prototype.sort with no comparator is UTF-16 code-unit order,
    // deliberately: it is locale-independent, and it is also what SQLite's
    // TEXT comparison does. localeCompare here would pass or fail with the
    // runtime's ICU data rather than with the code.
    const chronological = [
      "2020-01-24 16:30:23.173268",
      "2026-09-05 08:00:00.000000", // whole second: rendered with NO fraction
      "2026-09-05 08:00:00.000001", // 1us later: rendered WITH one
      "2026-09-05T15:21:42.853Z",
      "2026-09-05 20:00:00.000000",
      "2026-09-06 00:00:00.000000",
    ];
    for (const format of formatters) {
      const rendered = chronological.map(format);
      expect([...rendered].sort()).toEqual(rendered);
      // Every rendering distinct, so the sort above cannot be passing by
      // collapsing values onto each other.
      expect(new Set(rendered).size).toBe(chronological.length);
    }
    // The specific hazard that same-second pair exists for, stated
    // directly: omitting the fraction makes the field VARIABLE length, and
    // a shorter string that is a prefix of a longer one sorts first --
    // which happens to be the correct chronological direction. It would
    // stop being so if a rendering ever gained a trailing character (a
    // "Z", a space) after the seconds field.
    expect(formatDjangoJsonDatetime("2026-09-05 08:00:00.000000")).toBe("2026-09-05T08:00:00");
    expect(formatDjangoJsonDatetime("2026-09-05 08:00:00.000001")).toBe(
      "2026-09-05T08:00:00.000",
    );
    expect("2026-09-05T08:00:00" < "2026-09-05T08:00:00.000").toBe(true);
    // Same wall-clock fields everywhere; only the separator and the
    // fraction width differ.
    expect(formatDjangoJsonDatetime(ETL_SHAPE).slice(0, 19)).toBe("2020-01-24T16:30:23");
    expect(formatIsoDatetime(ETL_SHAPE).slice(0, 19)).toBe("2020-01-24T16:30:23");
    expect(formatPyStrDatetime(ETL_SHAPE).slice(0, 19)).toBe("2020-01-24 16:30:23");
  });

  it("are pure -- the same input gives the same output every time", () => {
    // Guards the same /g-flag hazard as the parser test above, at the level
    // the API routes actually call. Under a stateful regex the first row of
    // a response would format and the second would fall through to raw.
    //
    // PORT_SHAPE, not ETL_SHAPE, is the probe here: all three formatters
    // visibly change it, so "unchanged" cannot be confused with "correctly
    // formatted". Under a stateful regex the second call would return the
    // input verbatim and the !== check below would catch it.
    for (const format of formatters) {
      const runs = new Set([format(PORT_SHAPE), format(PORT_SHAPE), format(PORT_SHAPE)]);
      expect(runs.size).toBe(1);
      expect([...runs][0]).not.toBe(PORT_SHAPE); // it really did reformat
    }
    // And with an unparseable value interleaved, which is the shape of a
    // real list response: one bad row must not change what the next good
    // row renders as -- a stateful RAW_RE fails exactly here. Note what
    // this does NOT catch, so nobody reads more into it than it says: a
    // correct memoiser keyed on the input passes this happily, and should.
    // The state that would actually be a bug -- one Parts object refilled
    // and returned per call -- is pinned by the mixed-value test in the
    // parsePyDatetime block, which compares six results at once.
    for (const format of formatters) {
      const first = format(PORT_SHAPE);
      expect(format("not a date")).toBe("not a date");
      expect(format(PORT_SHAPE)).toBe(first);
    }
  });

  it("leaves an already-correct ETL row untouched, so re-serialising is safe", () => {
    // formatPyStrDatetime is IDEMPOTENT on the shape most D1 rows are
    // already in -- str(datetime) in, the identical string out -- because
    // the ETL copied Python's own rendering across. Worth pinning: it means
    // the fix is a no-op for 34,061 of the 34,175 foodbankchange rows and
    // only the 114 toISOString() rows changed shape on the wire, which is
    // what made the beta/production diff readable in the first place.
    expect(formatPyStrDatetime(ETL_SHAPE)).toBe(ETL_SHAPE);
    // Double application is safe for all three. The expected value is
    // written out rather than compared to another call, because
    // f(f(x)) === f(x) is also satisfied by a formatter that returns its
    // input untouched -- the pre-fix behaviour this module replaced.
    expect(formatPyStrDatetime(formatPyStrDatetime(PORT_SHAPE))).toBe(
      "2026-09-05 15:21:42.853000",
    );
    expect(formatIsoDatetime(formatIsoDatetime(PORT_SHAPE))).toBe(
      "2026-09-05T15:21:42.853000",
    );
    // ...with the one documented exception: JSON's three-digit output fed
    // back in is re-read as milliseconds, so .173 stays .173 rather than
    // decaying further. Truncation is not lossy a second time.
    expect(formatDjangoJsonDatetime(formatDjangoJsonDatetime(ETL_SHAPE))).toBe(
      "2020-01-24T16:30:23.173",
    );
    // Idempotence as a fixed point: each formatter's own output, fed back
    // in, is that same string.
    for (const format of formatters) {
      const once = format(ETL_SHAPE);
      expect(format(once)).toBe(once);
    }
  });
});
