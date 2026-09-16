import { afterEach, describe, expect, it, vi } from "vitest";
import { isOpen, openingHoursDays } from "./openingHours";

// These two functions render the "Opening hours" fragment on every donation
// point page (wfbnFoodbankDonationpointOpeninghours in
// routes/wfbn/locationDetail.ts). Almost everything they can get wrong is a
// wrong ANSWER, not an error: a food bank shown as open when it is shut sends
// somebody with a bag of shopping to a locked door, and a rotation that
// starts on the wrong weekday mislabels all seven rows at once. None of that
// reaches an error log, which is why the tests below pin the arithmetic
// rather than just the happy path.
//
// Ported from FoodbankDonationPoint.opening_hours_days()/is_open,
// givefood/models/foodbank.py:1153-1245. Where the port deliberately differs
// from Django the test says so and pins OUR behaviour, per the module header.

// The canonical stored shape: seven newline-separated "Day: hours" lines,
// Monday first, whatever the day the reader arrives on.
const WEEK = [
  "Monday: 9:00 AM - 5:00 PM",
  "Tuesday: 9:00 AM - 5:00 PM",
  "Wednesday: 10:00 AM - 4:00 PM",
  "Thursday: 9:00 AM - 5:00 PM",
  "Friday: 9:00 AM - 1:00 PM",
  "Saturday: Closed",
  "Sunday: Closed",
].join("\n");

// The same seven lines with labels that are deliberately NOT weekday names.
// WEEK cannot distinguish "reads the stored line at index weekday()" from
// "formats the row's own date as a day name and ignores the stored line" --
// on real data the two agree. This fixture makes them disagree, so it is the
// one that actually pins the array indexing.
const LABELLED = ["L0: h0", "L1: h1", "L2: h2", "L3: h3", "L4: h4", "L5: h5", "L6: h6"].join("\n");

// Fixed instants, chosen so the weekday is stated once here and not
// re-derived (wrongly) in each test. Verified against the real calendar.
// Noon deliberately: it is the same calendar day in UTC and in London
// whatever the season, so these say "a Saturday" and nothing about zones.
const SATURDAY = new Date("2026-09-05T12:00:00Z");
const SUNDAY = new Date("2026-09-06T12:00:00Z");
const MONDAY = new Date("2026-09-07T12:00:00Z");

// Seven identical lines: the shape most parser tests want, where only the
// content of "today's" line matters and every weekday gives the same answer.
const everyDay = (line: string) => Array(7).fill(line).join("\n");

// U+00A0, spelled out because it is invisible in a diff. Opening hours are
// admin free text and a lot of it is pasted out of Word, which turns the
// space before "AM" into a non-breaking one. The two halves of this module
// disagree about it -- splitDayLine wants a literal ASCII ": ", while
// parseClockTime's `\s*` is happy with any whitespace -- so both sides are
// pinned below.
const NBSP = " ";

// A Date whose LOCAL-time accessors throw. The suite runs with TZ=UTC
// (vitest.config.mts), so getHours() and getUTCHours() return the same number
// and no ordinary fixture can tell a host-local read from a UTC one. The
// module must do neither: it answers in Europe/London, via Intl, from the
// instant alone. Passing one of these proves it never reached for the host's
// clock -- a getHours() regression would be right on a UTC server, wrong on
// a developer's laptop, and silently so in both.
class UtcOnlyDate extends Date {
  override getHours(): never {
    throw new Error("read local getHours()");
  }
  override getMinutes(): never {
    throw new Error("read local getMinutes()");
  }
  override getDay(): never {
    throw new Error("read local getDay()");
  }
  override getDate(): never {
    throw new Error("read local getDate()");
  }
  override getMonth(): never {
    throw new Error("read local getMonth()");
  }
  override getFullYear(): never {
    throw new Error("read local getFullYear()");
  }
}

// Both functions default `now` to `new Date()`, and production calls them
// that way, so the default parameter is exercised against a pinned clock
// rather than asserted loosely against "one of the three allowed values".
afterEach(() => {
  vi.useRealTimers();
});

describe("openingHoursDays", () => {
  // Django returns the bare `False` sentinel here; this port returns null
  // (module comment). The caller 404s before reaching this, so the only way
  // the distinction ever matters is if somebody reuses the function -- pin
  // it so `=== false` never quietly becomes the contract again.
  it("returns null, not false and not [], when there are no stored hours", () => {
    expect(openingHoursDays(null, "England", MONDAY)).toBeNull();
    expect(openingHoursDays("", "England", MONDAY)).toBeNull();
  });

  // The fragment is a "next seven days" list, NOT a Monday-to-Sunday table:
  // Django builds `today + timedelta(days=offset)` for offset 0..6 and looks
  // up `days[day_date.weekday()]`. If the rotation were dropped, a Saturday
  // visitor would be told the food bank opens at 9am tomorrow when tomorrow
  // is Sunday and it is shut.
  it("starts at today and rotates forward seven days, not Monday-first", () => {
    const days = openingHoursDays(WEEK, "England", SATURDAY)!;
    expect(days.map((d) => d.day_name)).toEqual([
      "Saturday",
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
    ]);
    // Each row must carry ITS OWN day's hours, not the first line's.
    expect(days.map((d) => d.hours)).toEqual([
      "Closed",
      "Closed",
      "9:00 AM - 5:00 PM",
      "9:00 AM - 5:00 PM",
      "10:00 AM - 4:00 PM",
      "9:00 AM - 5:00 PM",
      "9:00 AM - 1:00 PM",
    ]);
  });

  // The rotation asserted with labels that are not weekday names, so the test
  // fails against an implementation that renders the row's date rather than
  // reading days[weekday()]. Both name and hours are checked: a row must be
  // one whole stored line, never a name from one line and hours from another.
  it("takes both name and hours from the stored line at that day's index", () => {
    const days = openingHoursDays(LABELLED, "England", SATURDAY)!;
    expect(days.map((d) => d.day_name)).toEqual(["L5", "L6", "L0", "L1", "L2", "L3", "L4"]);
    expect(days.map((d) => d.hours)).toEqual(["h5", "h6", "h0", "h1", "h2", "h3", "h4"]);
  });

  // The Sunday case is the one a Sunday=0 weekday helper gets wrong: JS's
  // getUTCDay() calls Sunday 0, Python's date.weekday() calls it 6, and the
  // stored string is Monday-first. A missing (+6)%7 would show Sunday's
  // visitor the Monday line.
  it("maps Sunday to the LAST stored line, not the first (Python weekday)", () => {
    expect(openingHoursDays(LABELLED, "England", SUNDAY)![0]!.day_name).toBe("L6");
    expect(openingHoursDays(LABELLED, "England", MONDAY)![0]!.day_name).toBe("L0");
    const days = openingHoursDays(WEEK, "England", SUNDAY)!;
    expect(days[0]!.day_name).toBe("Sunday");
    expect(days[0]!.is_closed).toBe(true);
    expect(days[1]!.day_name).toBe("Monday");
  });

  it("flags exactly one row as today, and it is the first", () => {
    const days = openingHoursDays(WEEK, "England", SATURDAY)!;
    expect(days.map((d) => d.is_today)).toEqual([true, false, false, false, false, false, false]);
  });

  // Django splits on the FIRST ": " only (`day_text.split(": ", 1)`), so a
  // second colon inside the hours -- "Tuesday: 9:00 AM - 5:00 PM: ring first"
  // -- must stay in the hours rather than truncating them.
  it("splits on the first ': ' only, keeping later colons inside the hours", () => {
    const days = openingHoursDays(everyDay("Monday: 9:00 AM - 5:00 PM: ring the bell"), "England", MONDAY)!;
    expect(days[0]!.day_name).toBe("Monday");
    expect(days[0]!.hours).toBe("9:00 AM - 5:00 PM: ring the bell");
  });

  // A bare "9:00 AM" contains a colon but no ": " -- the separator is colon
  // plus space, so a time never counts as the day-name separator.
  it("does not treat the colon inside a clock time as the separator", () => {
    const days = openingHoursDays(everyDay("9:00 AM - 5:00 PM"), "England", MONDAY)!;
    expect(days[0]!.day_name).toBe("9:00 AM - 5:00 PM");
    expect(days[0]!.hours).toBe("");
  });

  // The separator is a literal ": ", so the space must be an ASCII space --
  // unlike the clock parser, whose `\s*` is lenient. Data pasted out of Word
  // arrives with U+00A0 after the colon and silently loses its hours, and a
  // "just use \s" tidy-up of splitDayLine would change that. Pin the split
  // as it stands so the asymmetry is a decision rather than a surprise.
  it("requires an ASCII space after the colon, not any whitespace", () => {
    const nbsp = openingHoursDays(everyDay(`Monday:${NBSP}9:00 AM - 5:00 PM`), "England", MONDAY)!;
    expect(nbsp[0]!.day_name).toBe(`Monday:${NBSP}9:00 AM - 5:00 PM`);
    expect(nbsp[0]!.hours).toBe("");
    const tab = openingHoursDays(everyDay("Monday:\t9:00 AM - 5:00 PM"), "England", MONDAY)!;
    expect(tab[0]!.hours).toBe("");
    // ...and a colon with nothing after it is not a separator either.
    expect(openingHoursDays(everyDay("Monday:9:00 AM"), "England", MONDAY)![0]!.day_name).toBe("Monday:9:00 AM");
  });

  // Django: `day_name = day_parts[0] if len(day_parts) > 1 else day_text`,
  // i.e. an unsplittable line becomes the whole text as the NAME with empty
  // hours -- not empty name with the text as hours. The njk template prints
  // day_name, so getting this backwards blanks the row.
  it("puts an unsplittable line in day_name and leaves hours empty (Django's fallback)", () => {
    const days = openingHoursDays(everyDay("Closed"), "England", MONDAY)!;
    expect(days[0]).toMatchObject({ day_name: "Closed", hours: "", is_closed: true });
  });

  // The mirror image: a line that begins with the separator yields an EMPTY
  // name and real hours, because indexOf(": ") === 0 is a found separator,
  // not a missing one. The `sepIdx === -1` test must stay identity-strict; a
  // falsy `if (!sepIdx)` would send this down the fallback branch above and
  // print the times where the day name goes.
  it("keeps an empty day_name when the line starts with the separator", () => {
    const days = openingHoursDays(everyDay(": 9:00 AM - 5:00 PM"), "England", MONDAY)!;
    expect(days[0]).toMatchObject({ day_name: "", hours: "9:00 AM - 5:00 PM" });
  });

  // Rows keep their raw hours text even when closed -- "Saturday" / "Closed",
  // not "Saturday" / "". The template prints hours for every row and relies
  // on the njk `_()` call to translate the word, so blanking it here would
  // leave the closed rows with nothing beside the day name.
  it("keeps the literal hours text on a closed row", () => {
    const days = openingHoursDays(WEEK, "England", SATURDAY)!;
    expect(days[0]).toMatchObject({ day_name: "Saturday", hours: "Closed", is_closed: true });
  });

  // DELIBERATE DIVERGENCE (module header): Django tests for "Closed" in the
  // ALREADY-TRANSLATED text, so on cy/ga/gd the flag is silently always
  // false. This port reads the untranslated source. Translation is not a
  // parameter of this function, so no test here can observe the divergence
  // directly -- what it CAN pin is that the flag is a pure function of the
  // stored English line, i.e. that no locale, Accept-Language or ambient
  // translate() ever gets mixed in. Anything that reintroduced Django's
  // ordering would have to add such an input, and this test is the reason it
  // could not be done quietly.
  it("derives is_closed from the raw English source text alone", () => {
    const days = openingHoursDays(WEEK, "England", SATURDAY)!;
    expect(days.map((d) => d.is_closed)).toEqual([true, true, false, false, false, false, false]);
  });

  // Substring match, exactly as Django's `"Closed" in day_text`. A food bank
  // that types "Closed for lunch 1-2pm" is flagged closed all day; that is
  // the upstream behaviour and the template renders it, so it must not be
  // "improved" into an exact match without a deliberate decision.
  it("matches 'Closed' as a substring anywhere in the line", () => {
    const line = "Monday: 9:00 AM - 5:00 PM (Closed for lunch)";
    const days = openingHoursDays(everyDay(line), "England", MONDAY)!;
    expect(days[0]!.is_closed).toBe(true);
    // The whole line is searched, day name included -- not just the hours.
    expect(openingHoursDays(everyDay("Closed Mondays: 9:00 AM - 5:00 PM"), "England", MONDAY)![0]!.is_closed).toBe(
      true,
    );
  });

  // ...and case-sensitively, again matching Python's `in`. Lower-case
  // "closed" in the stored data does NOT set the flag, so the row renders as
  // if the food bank were open with the hours "closed".
  it("is case-sensitive about 'Closed'", () => {
    const days = openingHoursDays(everyDay("Monday: closed"), "England", MONDAY)!;
    expect(days[0]).toMatchObject({ is_closed: false, hours: "closed" });
    expect(openingHoursDays(everyDay("Monday: CLOSED"), "England", MONDAY)![0]!.is_closed).toBe(false);
  });

  describe("bank holidays", () => {
    // The country -> gov.uk division mapping is the part with no natural
    // feedback loop: a Welsh food bank whose country string stopped mapping
    // to england-and-wales would just lose its holiday banners silently.
    // 2026-01-01..2026-01-07 is the window that separates the divisions:
    // Scotland alone has "2nd January".
    const NEW_YEAR = new Date("2026-01-01T09:00:00Z");

    it("gives England and Wales the same england-and-wales division", () => {
      const england = openingHoursDays(WEEK, "England", NEW_YEAR)!;
      const wales = openingHoursDays(WEEK, "Wales", NEW_YEAR)!;
      expect(england.map((d) => d.holiday?.title ?? null)).toEqual(wales.map((d) => d.holiday?.title ?? null));
      expect(england[0]!.holiday).toEqual({
        title: "New Year’s Day",
        date: "2026-01-01",
        notes: "",
        bunting: true,
      });
      // England has no 2nd January holiday; Scotland does (asserted below).
      expect(england[1]!.holiday).toBeNull();
    });

    it("gives Scotland its own division, including 2nd January", () => {
      const days = openingHoursDays(WEEK, "Scotland", NEW_YEAR)!;
      expect(days[0]!.holiday?.title).toBe("New Year’s Day");
      expect(days[1]!.holiday?.title).toBe("2nd January");
      // ...and England, on the identical window, does not.
      expect(openingHoursDays(WEEK, "England", NEW_YEAR)![1]!.holiday).toBeNull();
    });

    it("gives Northern Ireland its own division, including St Patrick's Day", () => {
      // 2026-03-17 falls inside a window starting 2026-03-16.
      const stPatricks = new Date("2026-03-16T09:00:00Z");
      expect(openingHoursDays(WEEK, "Northern Ireland", stPatricks)![1]!.holiday?.title).toBe("St Patrick’s Day");
      // Not a bank holiday in England and Wales -- the whole reason the
      // divisions are kept apart.
      expect(openingHoursDays(WEEK, "England", stPatricks)![1]!.holiday).toBeNull();
      expect(openingHoursDays(WEEK, "Scotland", stPatricks)![1]!.holiday).toBeNull();
    });

    // Django's `elif self.country == "England"` chain is an exact string
    // comparison too. Anything not one of the four names -- a null country,
    // a lower-cased one, or somewhere outside the UK -- must yield no
    // holidays rather than throwing or defaulting to england-and-wales.
    it("returns no holidays for an unmapped, mis-cased or null country", () => {
      for (const country of [null, "england", "ENGLAND", "United Kingdom", "Isle of Man", " England", "England ", ""]) {
        const days = openingHoursDays(WEEK, country, NEW_YEAR)!;
        expect(days.every((d) => d.holiday === null)).toBe(true);
      }
      // An empty country must be indistinguishable from a null one: `country
      // ? ... : undefined` treats "" as absent, and the D1 column is
      // nullable, so both arrive in practice.
      expect(openingHoursDays(WEEK, "", NEW_YEAR)).toEqual(openingHoursDays(WEEK, null, NEW_YEAR));
    });

    // `country` is admin free text used directly as an object key, and
    // BANK_HOLIDAY_DIVISION is a plain object literal, so "constructor" and
    // "toString" resolve to inherited Function values that are TRUTHY and
    // sail straight past the `if (!division) return []` guard. Only the
    // second lookup missing in the JSON keeps the result empty. Nothing
    // throws today; this pins that, so a future refactor of the second
    // lookup (a Map, a default division, a `?? "england-and-wales"`) cannot
    // turn an inherited property into a real answer unnoticed.
    it("returns no holidays for a country name inherited from Object.prototype", () => {
      for (const country of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
        expect(openingHoursDays(WEEK, country, NEW_YEAR)!.every((d) => d.holiday === null)).toBe(true);
      }
    });

    // Only holidays inside the seven-day window attach. Christmas Day 2026
    // is a Friday: a window starting the Saturday after must not still be
    // showing it, and a window starting the Thursday before must.
    it("attaches a holiday only on its own date within the window", () => {
      const before = openingHoursDays(WEEK, "England", new Date("2026-12-24T09:00:00Z"))!;
      expect(before[0]!.holiday).toBeNull(); // Christmas Eve is not a bank holiday
      expect(before[1]!.holiday?.title).toBe("Christmas Day");
      // The 2026 Boxing Day substitute is Monday the 28th, four days on.
      expect(before[4]!.holiday).toMatchObject({ title: "Boxing Day", notes: "Substitute day" });
      // ...and nothing else in the window is decorated.
      expect(before.filter((d) => d.holiday !== null)).toHaveLength(2);

      const after = openingHoursDays(WEEK, "England", new Date("2026-12-26T09:00:00Z"))!;
      expect(after.every((d) => d.holiday?.title !== "Christmas Day")).toBe(true);
    });

    // The window is a rolling seven days, not a calendar year: the last week
    // of December reaches into next January. A lookup that filtered the
    // events to `now`'s year first -- an easy "optimisation" on a 100-entry
    // list -- would drop New Year's Day for every reader in late December,
    // which is exactly when the banner matters most.
    it("matches holidays across a year boundary", () => {
      const days = openingHoursDays(WEEK, "England", new Date("2026-12-28T09:00:00Z"))!;
      expect(days[0]!.holiday?.title).toBe("Boxing Day"); // Mon 28 Dec 2026, substitute
      expect(days[4]!.holiday?.title).toBe("New Year’s Day"); // Fri 1 Jan 2027
    });

    // bank-holidays.json covers 2019-01-01..2028-12-26. Outside that the
    // `.find()` simply misses; it must not throw and must not wrap round to
    // a same-day-different-year match.
    it("returns no holidays for dates outside the shipped data range", () => {
      for (const instant of ["2018-12-25T09:00:00Z", "2029-12-25T09:00:00Z"]) {
        const days = openingHoursDays(WEEK, "England", new Date(instant))!;
        expect(days).toHaveLength(7);
        expect(days.every((d) => d.holiday === null)).toBe(true);
      }
    });

    // The holiday object handed back is a LIVE reference into the JSON
    // imported at module scope, shared by every request in the isolate --
    // not a copy. That is fine as long as nobody mutates it, and this test
    // exists to say so out loud: if a caller ever writes to `day.holiday`,
    // the change persists for every later request on that Worker instance.
    it("hands back the shared JSON event object, not a per-call copy", () => {
      const xmas = new Date("2026-12-25T09:00:00Z");
      const first = openingHoursDays(WEEK, "England", xmas)!;
      const second = openingHoursDays(WEEK, "Wales", xmas)!;
      expect(first[0]!.holiday).toBe(second[0]!.holiday);
    });

    // DIVERGENCE, harmless but worth pinning: Django only sets the "holiday"
    // key when the country resolved to a division, so the template sees a
    // missing key for e.g. a null country. This port always emits the key
    // with null. njk renders both as falsy, so the page is identical -- but
    // any future consumer can rely on the key existing.
    it("always emits the holiday key, even with no division (Django omits it)", () => {
      const days = openingHoursDays(WEEK, null, NEW_YEAR)!;
      expect(days.every((d) => Object.hasOwn(d, "holiday"))).toBe(true);
      expect(days.every((d) => d.holiday === null)).toBe(true);
    });
  });

  // The contract is that the seven rows are a function of the LONDON DATE,
  // not of the instant: a reader at 00:00 and a reader at 23:59:59.999 get an
  // identical list, holiday banners included. (The truncation to midnight is
  // belt-and-braces rather than the thing that achieves it -- adding whole
  // days to any instant lands on the same calendar dates. The invariant is
  // still worth pinning, because it is the one a future "just use
  // now.getTime() + a rolling 24h window" rewrite breaks, and it breaks it
  // invisibly: the page would simply differ by the hour the reader happened
  // to arrive.)
  it("produces the same seven days at any time of the London day", () => {
    const early = openingHoursDays(WEEK, "England", new Date("2026-12-25T00:00:00.000+00:00"))!;
    const late = openingHoursDays(WEEK, "England", new Date("2026-12-25T23:59:59.999+00:00"))!;
    expect(late).toEqual(early);
    expect(early[0]!.holiday?.title).toBe("Christmas Day");
    expect(early[3]!.holiday?.title).toBe("Boxing Day"); // Mon 28th, three days on
  });

  // The other half of issue #60. The London day turns over an hour before the
  // UTC one for the whole of BST, so between midnight and 1am every summer
  // night a UTC rotation is still showing YESTERDAY: all seven rows shifted
  // by a day, each labelled with the wrong weekday's hours, and the bank
  // holiday banners dragged along with them. 00:30 BST on the Summer bank
  // holiday is the sharpest version -- the visitor is told the holiday is
  // tomorrow while standing in it.
  it("rolls over to the new day at London midnight, not an hour later", () => {
    const justAfterMidnight = new Date("2026-08-31T00:30:00+01:00"); // 23:30Z on the 30th
    const days = openingHoursDays(WEEK, "England", justAfterMidnight)!;
    expect(days.map((d) => d.day_name)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
    expect(days[0]).toMatchObject({ hours: "9:00 AM - 5:00 PM", is_today: true });
    expect(days[0]!.holiday?.title).toBe("Summer bank holiday");
    // Half an hour earlier is genuinely still Sunday, so the rotation must
    // NOT have simply been shifted a day forward for everyone.
    const beforeMidnight = openingHoursDays(WEEK, "England", new Date("2026-08-30T23:30:00+01:00"))!;
    expect(beforeMidnight[0]!.day_name).toBe("Sunday");
    expect(beforeMidnight[1]!.holiday?.title).toBe("Summer bank holiday");
  });

  // See UtcOnlyDate: TZ=UTC in the harness hides a host-local read, so the
  // only way to prove the rotation and the holiday dates come from the
  // London calendar rather than the machine's is to make the local-time
  // accessors fatal.
  it("builds the window from London calendar fields, never the host's", () => {
    const days = openingHoursDays(WEEK, "England", new UtcOnlyDate("2026-12-25T00:00:00Z"))!;
    expect(days.map((d) => d.day_name)).toEqual([
      "Friday",
      "Saturday",
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
    ]);
    expect(days[0]!.holiday?.title).toBe("Christmas Day");
  });

  // Called without a `now` in production (locationDetail.ts passes only two
  // arguments), so the default parameter is the real code path -- and with
  // the clock pinned the assertion is the full rotation, not just "seven
  // rows came back".
  it("defaults to the current time when no clock is supplied", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z")); // a Saturday
    expect(openingHoursDays(WEEK, "England")!.map((d) => d.day_name)).toEqual([
      "Saturday",
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
    ]);
    vi.setSystemTime(new Date("2026-09-07T12:00:00Z")); // and a Monday
    expect(openingHoursDays(WEEK, "England")![0]!.day_name).toBe("Monday");
  });

  // DIVERGENCE from Django, on malformed data: Django indexes days[weekday]
  // directly and raises IndexError on a short string, 500ing the fragment.
  // The `?? ""` here degrades to a blank row instead. Admin-entered free
  // text is exactly where a six-line value comes from, so pin the graceful
  // behaviour -- and pin that a blank row is NOT reported as closed, since
  // "we have no idea" must not render as a confident "Closed".
  it("degrades to blank rows for a short string instead of throwing (Django IndexErrors)", () => {
    const days = openingHoursDays("Monday: 9:00 AM - 5:00 PM", "England", MONDAY)!;
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ day_name: "Monday", hours: "9:00 AM - 5:00 PM" });
    for (const day of days.slice(1)) {
      expect(day).toMatchObject({ day_name: "", hours: "", is_closed: false });
    }
  });

  // The eighth line and beyond are unreachable: pythonWeekday() only ever
  // yields 0..6. A stored "Bank holidays: Closed" footer -- which real
  // admins do add -- must not leak into a row, and above all must not set
  // is_closed on a day that is open.
  it("ignores stored lines beyond the seventh", () => {
    const days = openingHoursDays(`${WEEK}\nBank holidays: Closed\nBy appointment: Tuesdays`, "England", MONDAY)!;
    expect(days.map((d) => d.day_name)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
    expect(days[0]!.is_closed).toBe(false);
  });

  // Truncation is by index, not by slicing, so a pathological value costs
  // nothing beyond the split: still exactly seven rows, still the first
  // seven lines.
  it("still returns exactly seven rows for a very large value", () => {
    const days = openingHoursDays(Array(5000).fill("Monday: Closed").join("\n"), "England", MONDAY)!;
    expect(days).toHaveLength(7);
    expect(days[0]!.day_name).toBe("Monday");
  });

  // The lines are cut with split("\n"), not /\r?\n/, so a value stored with
  // Windows line endings leaves a "\r" on the tail of every line but the
  // last -- and unlike isOpen, which trims before parsing, this function
  // hands that straight to the template as part of `hours`. The day name and
  // is_closed survive (the \r lands after them), so the bug is invisible
  // except in the page source. Pinned because the tempting fix -- splitting
  // on /\r?\n/ or trimming each line -- is a real behaviour change to a
  // rendered string, not a no-op, and should be made on purpose.
  it("leaves a stray \\r in hours when the value is stored with CRLF", () => {
    const days = openingHoursDays(
      ["Monday: 9:00 AM - 5:00 PM", "Tuesday: Closed", "L2", "L3", "L4", "L5", "L6"].join("\r\n"),
      "England",
      MONDAY,
    )!;
    expect(days[0]).toMatchObject({ day_name: "Monday", hours: "9:00 AM - 5:00 PM\r", is_closed: false });
    expect(days[1]).toMatchObject({ day_name: "Tuesday", hours: "Closed\r", is_closed: true });
    // The final line has no trailing separator, so it alone comes out clean.
    expect(days[6]).toMatchObject({ day_name: "L6", hours: "" });
  });

  it("survives a whitespace-only value without throwing", () => {
    const days = openingHoursDays("\n", "England", MONDAY)!;
    expect(days).toHaveLength(7);
    expect(days.every((d) => d.day_name === "" && d.hours === "" && !d.is_closed)).toBe(true);
    // A single space is truthy, so it is NOT the null-hours sentinel: it
    // splits into one line and lands in day_name.
    const space = openingHoursDays(" ", "England", MONDAY)!;
    expect(space).toHaveLength(7);
    expect(space[0]).toMatchObject({ day_name: " ", hours: "", is_closed: false });
  });

  // Negative epoch milliseconds: `todayUtc + offset * 86400000` has to keep
  // working below zero, and 1969-07-20 was a Sunday, so a sign error in the
  // day arithmetic or the (+6)%7 would show up immediately. JS's `%` returns
  // a negative remainder for negative operands, which is the specific way
  // this goes wrong.
  it("handles dates before the epoch without a sign error", () => {
    const days = openingHoursDays(LABELLED, "England", new Date("1969-07-20T12:00:00Z"))!;
    expect(days.map((d) => d.day_name)).toEqual(["L6", "L0", "L1", "L2", "L3", "L4", "L5"]);
    expect(openingHoursDays(LABELLED, "England", new Date(0))![0]!.day_name).toBe("L3"); // Thu 1 Jan 1970
  });

  // The one input that DOES throw. Intl's formatToParts raises
  // RangeError("Invalid time value") on an unparseable date, so this 500s the
  // fragment rather than degrading like every other malformed input above.
  // Production callers always pass a real clock, so it is a latent trap
  // rather than a live fault -- pinned here so that anyone who reuses
  // openingHoursDays with a user-supplied date knows to validate it first,
  // and so the asymmetry with isOpen (which guards explicitly and returns
  // null for the same input) is on the record. The error is unchanged from
  // the UTC implementation, which threw the same RangeError out of
  // toISOString().
  it("throws RangeError on an invalid Date, unlike every other bad input", () => {
    expect(() => openingHoursDays(WEEK, "England", new Date("not a date"))).toThrow(RangeError);
    expect(() => openingHoursDays(WEEK, "England", new Date(NaN))).toThrow(/Invalid time value/);
  });
});

describe("isOpen", () => {
  // A week where every day is open only in its own one-hour window, so a
  // wrong weekday index cannot accidentally give the right answer.
  const oneHourPerDay = [
    "Monday: 1:00 AM - 2:00 AM",
    "Tuesday: 2:00 AM - 3:00 AM",
    "Wednesday: 3:00 AM - 4:00 AM",
    "Thursday: 4:00 AM - 5:00 AM",
    "Friday: 5:00 AM - 6:00 AM",
    "Saturday: 6:00 AM - 7:00 AM",
    "Sunday: 7:00 AM - 8:00 AM",
  ].join("\n");

  // Django's `is_open` returns None (not False) when it cannot tell, and the
  // template distinguishes the two. Collapsing "unknown" into "closed" would
  // print a confident "Closed now" on a food bank whose hours simply do not
  // parse.
  it("returns null, not false, when there are no stored hours", () => {
    expect(isOpen(null, MONDAY)).toBeNull();
    expect(isOpen("", MONDAY)).toBeNull();
  });

  // Same Monday=0..Sunday=6 mapping as above, checked one day at a time.
  // 2026-09-07 is a Monday, so offset i is the i-th stored line. Each day's
  // window is unique, so reading the wrong line is always wrong -- there is
  // no index that accidentally agrees. The base is LONDON midnight (BST, so
  // 23:00Z the evening before): the windows are London wall-clock hours from
  // it, because that is the clock the stored hours are written in.
  it("reads today's line using Python's Monday=0 weekday", () => {
    for (let i = 0; i < 7; i++) {
      const midnight = new Date(`2026-09-${String(7 + i).padStart(2, "0")}T00:00:00+01:00`);
      const inWindow = new Date(midnight.getTime() + (i + 1) * 3600000 + 30 * 60000);
      const outOfWindow = new Date(midnight.getTime() + (i + 2) * 3600000 + 30 * 60000);
      expect(isOpen(oneHourPerDay, inWindow)).toBe(true);
      expect(isOpen(oneHourPerDay, outOfWindow)).toBe(false);
    }
  });

  it("is open inside the window and shut outside it", () => {
    expect(isOpen(WEEK, new Date("2026-09-07T12:00:00+01:00"))).toBe(true); // Monday lunchtime
    expect(isOpen(WEEK, new Date("2026-09-07T08:59:00+01:00"))).toBe(false); // before opening
    expect(isOpen(WEEK, new Date("2026-09-07T17:30:00+01:00"))).toBe(false); // after closing
    // Wednesday's 10-4 is narrower than Monday's 9-5: 9:30am on Wednesday is
    // shut, which only holds if the right line was read.
    expect(isOpen(WEEK, new Date("2026-09-09T09:30:00+01:00"))).toBe(false);
    expect(isOpen(WEEK, new Date("2026-09-09T10:30:00+01:00"))).toBe(true);
  });

  // Django: `open_time <= current_time < close_time` -- inclusive at the
  // open minute, EXCLUSIVE at the close minute. Getting the closing boundary
  // wrong is the one that matters: it tells someone standing outside at
  // 5:00pm that the door is still open.
  it("is open at the opening minute and shut at the closing minute", () => {
    expect(isOpen(WEEK, new Date("2026-09-07T09:00:00+01:00"))).toBe(true);
    expect(isOpen(WEEK, new Date("2026-09-07T08:59:59+01:00"))).toBe(false);
    expect(isOpen(WEEK, new Date("2026-09-07T16:59:59+01:00"))).toBe(true);
    expect(isOpen(WEEK, new Date("2026-09-07T17:00:00+01:00"))).toBe(false);
  });

  // Seconds are dropped (minute resolution), so 17:00:59 is still "17:00".
  it("compares at whole-minute resolution", () => {
    expect(isOpen(WEEK, new Date("2026-09-07T09:00:59+01:00"))).toBe(true);
    expect(isOpen(WEEK, new Date("2026-09-07T17:00:59+01:00"))).toBe(false);
    // ...and 08:59:59.999 has not yet become 09:00.
    expect(isOpen(WEEK, new Date("2026-09-07T08:59:59.999+01:00"))).toBe(false);
  });

  // A "Closed" day is definitively false, and is checked BEFORE the hours
  // are parsed -- so "Saturday: Closed" never falls through to the null
  // "cannot tell" branch.
  it("returns false for a Closed day, ahead of any parsing", () => {
    expect(isOpen(WEEK, SATURDAY)).toBe(false);
    expect(isOpen(WEEK, SUNDAY)).toBe(false);
    expect(isOpen(everyDay("Closed"), MONDAY)).toBe(false);
  });

  // The "Closed" substring BEATS a perfectly parseable window, because the
  // check happens on the whole line before the range is looked at. So a food
  // bank whose Monday reads "9:00 AM - 5:00 PM (Closed for lunch)" is
  // reported shut at noon -- and at 10am too. Django does exactly this, and
  // the fragment shows it; changing the order here (parse first, fall back
  // to the sentinel) would flip live answers on real stored data, so the
  // precedence is pinned rather than left to reading order.
  it("lets a 'Closed' substring override an otherwise valid window", () => {
    const lunch = everyDay("Monday: 9:00 AM - 5:00 PM (Closed for lunch)");
    expect(isOpen(lunch, new Date("2026-09-07T10:00:00+01:00"))).toBe(false);
    expect(isOpen(lunch, new Date("2026-09-07T12:00:00+01:00"))).toBe(false);
    // Even when the word is in the day name rather than the hours.
    expect(isOpen(everyDay("Closed Mondays: 9:00 AM - 5:00 PM"), new Date("2026-09-07T12:00:00+01:00"))).toBe(false);
  });

  it("is case-sensitive about 'Closed', matching Python's `in`", () => {
    // Lower-case "closed" is not the sentinel, so it falls through to the
    // parser, finds no two-part time range, and reports "cannot tell".
    expect(isOpen(everyDay("Monday: closed"), MONDAY)).toBeNull();
    expect(isOpen(everyDay("Monday: CLOSED"), MONDAY)).toBeNull();
  });

  it("returns null when the line has no ': ' separator at all", () => {
    // Django: `if len(day_parts) < 2: return None`.
    expect(isOpen(everyDay("9:00 AM - 5:00 PM"), MONDAY)).toBeNull();
    // Same ASCII-space strictness as openingHoursDays: a non-breaking space
    // after the colon loses the hours, so the answer is unknown.
    expect(isOpen(everyDay(`Monday:${NBSP}9:00 AM - 5:00 PM`), MONDAY)).toBeNull();
  });

  it("returns null when the hours are empty or free text", () => {
    expect(isOpen(everyDay("Monday: "), MONDAY)).toBeNull();
    expect(isOpen(everyDay("Monday: By appointment only"), MONDAY)).toBeNull();
    expect(isOpen(everyDay("Monday: 24 hours"), MONDAY)).toBeNull();
    expect(isOpen(everyDay("Monday: Open"), MONDAY)).toBeNull();
  });

  // Django splits on `\s*[–—\-]\s*` and bails unless there are exactly two
  // parts, so a split shift ("9:00 AM - 12:00 PM, 1:00 PM - 5:00 PM") is
  // reported as unknown rather than half-guessed -- three parts, not two.
  it("returns null when the range does not split into exactly two times", () => {
    const split = everyDay("Monday: 9:00 AM - 12:00 PM, 1:00 PM - 5:00 PM");
    expect(isOpen(split, new Date("2026-09-07T10:00:00+01:00"))).toBeNull();
    expect(isOpen(everyDay("Monday: 9:00 AM"), MONDAY)).toBeNull();
    // A trailing dash makes an empty third part -- still not two.
    expect(isOpen(everyDay("Monday: 9:00 AM - 5:00 PM -"), MONDAY)).toBeNull();
  });

  // Real stored data uses all three dashes, with and without spaces, because
  // it is typed by hand by hundreds of different food bank admins. Each is
  // also checked OUTSIDE the window, so a variant that silently failed to
  // split (returning null) could not pass by being loosely asserted.
  it("accepts hyphen, en dash and em dash, spaced or not", () => {
    for (const range of [
      "9:00 AM - 5:00 PM",
      "9:00 AM-5:00 PM",
      "9:00 AM – 5:00 PM",
      "9:00 AM–5:00 PM",
      "9:00 AM — 5:00 PM",
      "9:00 AM—5:00 PM",
      `9:00 AM${NBSP}-${NBSP}5:00 PM`, // pasted out of Word
      "9:00 AM\t-\t5:00 PM",
    ]) {
      const hours = everyDay(`Monday: ${range}`);
      expect(isOpen(hours, new Date("2026-09-07T12:00:00+01:00"))).toBe(true);
      expect(isOpen(hours, new Date("2026-09-07T18:00:00+01:00"))).toBe(false);
    }
  });

  // ...but the character class is exactly those three dashes. A Unicode
  // minus sign (U+2212) or a written "to" does not split, so the range comes
  // back as one part and the answer is unknown rather than a guess. Pinned
  // because "just add more separators" is a tempting change that would alter
  // live answers for stored data nobody has re-read.
  it("does not accept a minus sign or a written 'to' as the range separator", () => {
    expect(isOpen(everyDay("Monday: 9:00 AM − 5:00 PM"), new Date("2026-09-07T12:00:00+01:00"))).toBeNull();
    expect(isOpen(everyDay("Monday: 9:00 AM to 5:00 PM"), new Date("2026-09-07T12:00:00+01:00"))).toBeNull();
  });

  // %I/%p semantics: 12 AM is midnight (00:xx) and 12 PM is noon (12:xx).
  // The classic off-by-twelve turns "12:00 AM - 6:00 AM" into an evening.
  it("reads 12 AM as midnight and 12 PM as noon", () => {
    const overnight = everyDay("Monday: 12:00 AM - 6:00 AM");
    expect(isOpen(overnight, new Date("2026-09-07T00:00:00+01:00"))).toBe(true); // the opening minute itself
    expect(isOpen(overnight, new Date("2026-09-07T00:30:00+01:00"))).toBe(true);
    expect(isOpen(overnight, new Date("2026-09-07T06:30:00+01:00"))).toBe(false);
    expect(isOpen(overnight, new Date("2026-09-07T12:30:00+01:00"))).toBe(false); // not a 12:00-18:00 shift

    const afternoon = everyDay("Monday: 12:00 PM - 11:00 PM");
    expect(isOpen(afternoon, new Date("2026-09-07T12:00:00+01:00"))).toBe(true);
    expect(isOpen(afternoon, new Date("2026-09-07T12:30:00+01:00"))).toBe(true);
    expect(isOpen(afternoon, new Date("2026-09-07T11:30:00+01:00"))).toBe(false);
    expect(isOpen(afternoon, new Date("2026-09-07T00:30:00+01:00"))).toBe(false); // not a 00:00-23:00 shift
  });

  // Django's overnight rule: when close <= open the range is assumed to
  // cross midnight and the ONLY test is `current_time >= open_time`. That
  // means at 1am -- genuinely inside a 9pm-2am shift -- the answer is false,
  // because the lookup is still on the calendar day's own line. It is a
  // quirk, but it is upstream's quirk and the port reproduces it exactly.
  it("treats close <= open as crossing midnight, reporting open only from the opening time", () => {
    const overnight = everyDay("Monday: 9:00 PM - 2:00 AM");
    expect(isOpen(overnight, new Date("2026-09-07T22:00:00+01:00"))).toBe(true);
    expect(isOpen(overnight, new Date("2026-09-07T23:59:00+01:00"))).toBe(true);
    expect(isOpen(overnight, new Date("2026-09-07T21:00:00+01:00"))).toBe(true); // opening minute
    expect(isOpen(overnight, new Date("2026-09-07T20:59:00+01:00"))).toBe(false);
    // Inside the shift by the clock, but false -- Django does the same.
    expect(isOpen(overnight, new Date("2026-09-07T01:00:00+01:00"))).toBe(false);
    expect(isOpen(overnight, new Date("2026-09-07T00:00:00+01:00"))).toBe(false);
  });

  // Equal open and close hits the same `close <= open` branch, so a
  // 24-hour-style "9:00 AM - 9:00 AM" reads as open from 9am onwards rather
  // than as a zero-length window that is never open. The `<=` in the branch
  // test is load-bearing: a plain `<` would send this down the normal path
  // and report shut all day.
  it("treats an identical open and close time as the midnight-crossing case", () => {
    const allDay = everyDay("Monday: 9:00 AM - 9:00 AM");
    expect(isOpen(allDay, new Date("2026-09-07T09:00:00+01:00"))).toBe(true);
    expect(isOpen(allDay, new Date("2026-09-07T23:00:00+01:00"))).toBe(true);
    expect(isOpen(allDay, new Date("2026-09-07T08:00:00+01:00"))).toBe(false);
    // Midnight-to-midnight is the same shape and is open from 00:00 on.
    expect(isOpen(everyDay("Monday: 12:00 AM - 12:00 AM"), new Date("2026-09-07T00:00:00+01:00"))).toBe(true);
  });

  // The module comment cites a confirmed strptime detail: "%M", like "%I",
  // accepts one OR two digits, so strptime("9:5 AM", "%I:%M %p") is 09:05.
  // A \d{2} on the minute group would reject real stored values.
  it("accepts single-digit hours and minutes, like Python's strptime", () => {
    const sloppy = everyDay("Monday: 9:5 AM - 5:0 PM");
    expect(isOpen(sloppy, new Date("2026-09-07T09:04:00+01:00"))).toBe(false);
    expect(isOpen(sloppy, new Date("2026-09-07T09:05:00+01:00"))).toBe(true);
    expect(isOpen(sloppy, new Date("2026-09-07T16:59:00+01:00"))).toBe(true);
    expect(isOpen(sloppy, new Date("2026-09-07T17:00:00+01:00"))).toBe(false);
    // Two digits with a leading zero, which "%I"/"%M" also take.
    const padded = everyDay("Monday: 09:05 AM - 05:00 PM");
    expect(isOpen(padded, new Date("2026-09-07T09:05:00+01:00"))).toBe(true);
    expect(isOpen(padded, new Date("2026-09-07T09:04:00+01:00"))).toBe(false);
  });

  // Python's strptime builds its regex with re.IGNORECASE, so "%p" matches
  // "am"/"pm"/"Am". Stored data is hand-typed, so this is common. Asserted
  // in both directions so a variant that failed to parse (null) is caught.
  it("accepts lower-case and mixed-case am/pm", () => {
    for (const range of ["9:00 am - 5:00 pm", "9:00 Am - 5:00 pM", "9:00 aM - 5:00 Pm"]) {
      const hours = everyDay(`Monday: ${range}`);
      expect(isOpen(hours, new Date("2026-09-07T12:00:00+01:00"))).toBe(true);
      expect(isOpen(hours, new Date("2026-09-07T18:00:00+01:00"))).toBe(false);
    }
  });

  // Hours outside 1..12 and minutes above 59 are what strptime's "%I"/"%M"
  // reject with ValueError, which Django catches and turns into None. The
  // explicit range checks in parseClockTime exist for exactly this: a bare
  // regex would happily accept "13:00 PM" and place it at 25:00, i.e. never
  // reached, i.e. a permanently-shut food bank.
  it("returns null for hours or minutes strptime would reject", () => {
    for (const range of [
      "0:30 AM - 5:00 PM", // %I has no hour 0
      "13:00 PM - 5:00 PM", // nor 13
      "99:00 AM - 5:00 PM", // nor two-digit nonsense
      "9:60 AM - 5:00 PM", // %M stops at 59
      "9:99 AM - 5:00 PM",
      "9:00 AM - 0:00 PM", // and the close time is checked too
      "9:00 AM - 13:00 PM",
      "9:00 AM - 5:60 PM",
    ]) {
      expect(isOpen(everyDay(`Monday: ${range}`), MONDAY)).toBeNull();
    }
    // The accepted extremes on either side of those rejections.
    expect(isOpen(everyDay("Monday: 1:00 AM - 11:59 PM"), MONDAY)).toBe(true);
    expect(isOpen(everyDay("Monday: 12:59 AM - 11:00 PM"), MONDAY)).toBe(true);
  });

  // 24-hour and bare-hour notation are not "%I:%M %p" and Django's strptime
  // raises on them, so they must read as unknown, not be half-parsed. The
  // anchors matter here: an unanchored regex would find "9:00 AM" inside
  // "9:00 AM approx" and answer confidently.
  it("returns null for 24-hour, meridiem-less or trailing-junk times", () => {
    for (const range of [
      "09:00 - 17:00",
      "9am - 5pm",
      "nine - five",
      "9:00 AM - 5:00",
      "9:00 AM approx - 5:00 PM",
      "from 9:00 AM - 5:00 PM",
      "9:00 A.M. - 5:00 P.M.",
    ]) {
      expect(isOpen(everyDay(`Monday: ${range}`), MONDAY)).toBeNull();
    }
  });

  // KNOWN LENIENCY vs Django: a space in a strptime format compiles to `\s+`
  // (at least one), so Python REJECTS "9:00AM"; this port's `\s*` accepts
  // it. Pinned as current behaviour -- a food bank that typed no space is
  // shown a real answer here and "unknown" on the Django site.
  it("accepts a missing space before AM/PM, which Django's strptime rejects", () => {
    const tight = everyDay("Monday: 9:00AM - 5:00PM");
    expect(isOpen(tight, new Date("2026-09-07T12:00:00+01:00"))).toBe(true);
    expect(isOpen(tight, new Date("2026-09-07T18:00:00+01:00"))).toBe(false);
    // And a non-breaking space there, for the same Word-paste reason.
    expect(isOpen(everyDay(`Monday: 9:00${NBSP}AM - 5:00${NBSP}PM`), new Date("2026-09-07T12:00:00+01:00"))).toBe(true);
  });

  // Both ends are trimmed before parsing, which is what makes a value stored
  // with Windows line endings still work: the "\r" left behind by
  // split("\n") lands at the end of the closing time.
  it("tolerates surrounding whitespace, including a CRLF leftover \\r", () => {
    const crlf = Array(7).fill("Monday: 9:00 AM - 5:00 PM").join("\r\n");
    expect(isOpen(crlf, new Date("2026-09-07T12:00:00+01:00"))).toBe(true);
    expect(isOpen(crlf, new Date("2026-09-07T18:00:00+01:00"))).toBe(false);
    expect(isOpen(everyDay("Monday:  9:00 AM  -  5:00 PM "), new Date("2026-09-07T12:00:00+01:00"))).toBe(true);
    // A CRLF "Closed" day still reads as closed, not as unparseable.
    expect(isOpen(Array(7).fill("Monday: Closed").join("\r\n"), MONDAY)).toBe(false);
  });

  // ISSUE #60, the whole point of the Europe/London read. Stored hours are UK
  // wall-clock, so a UTC clock is an hour early for the entire of BST: this
  // is the real Morrisons Southwood line, at the real time on the screenshot,
  // which the UTC version badged "Closed" because 07:39 BST is 06:39Z.
  it("answers on the London clock, not UTC, through British Summer Time", () => {
    const supermarket = everyDay("Wednesday: 7:00 AM - 10:00 PM");
    expect(isOpen(supermarket, new Date("2026-09-16T07:39:00+01:00"))).toBe(true);
    // The hour either side of the boundary, which is where UTC and London
    // disagree: open from 7am local, still shut at 6:59am local even though
    // UTC has already ticked past 7.
    expect(isOpen(supermarket, new Date("2026-09-16T07:00:00+01:00"))).toBe(true);
    expect(isOpen(supermarket, new Date("2026-09-16T06:59:00+01:00"))).toBe(false);
    // ...and the closing end, an hour later than a UTC reader would have it.
    expect(isOpen(supermarket, new Date("2026-09-16T21:59:00+01:00"))).toBe(true);
    expect(isOpen(supermarket, new Date("2026-09-16T22:00:00+01:00"))).toBe(false);
    // In GMT the two clocks agree, so winter answers are untouched by this.
    expect(isOpen(everyDay("Monday: 9:00 AM - 5:00 PM"), new Date("2026-12-07T09:00:00Z"))).toBe(true);
    expect(isOpen(everyDay("Monday: 9:00 AM - 5:00 PM"), new Date("2026-12-07T08:59:00Z"))).toBe(false);
  });

  // The transitions come from the tz database, not from a hand-rolled "last
  // Sunday in March" rule -- which is the tempting way to avoid Intl, and
  // gets both of these wrong. A 1am-2am Sunday shop is NEVER open on the
  // spring-forward Sunday, because the wall clock goes 00:59 -> 02:00 and
  // that hour does not exist; on the autumn Sunday it is open TWICE, because
  // 01:30 happens once in BST and again in GMT. Asserted on real instants an
  // hour apart, so an implementation that added a fixed offset for "summer"
  // fails on at least one of them.
  it("follows the real BST transitions, including the hour that is skipped and the one that repeats", () => {
    const smallHours = everyDay("Sunday: 1:00 AM - 2:00 AM");
    // Spring forward, 29 March 2026: 01:00 GMT becomes 02:00 BST.
    expect(isOpen(smallHours, new Date("2026-03-29T00:59:00Z"))).toBe(false); // 00:59 GMT
    expect(isOpen(smallHours, new Date("2026-03-29T01:00:00Z"))).toBe(false); // already 02:00 BST
    expect(isOpen(smallHours, new Date("2026-03-29T01:30:00Z"))).toBe(false); // 02:30 BST
    // Fall back, 25 October 2026: 02:00 BST becomes 01:00 GMT.
    expect(isOpen(smallHours, new Date("2026-10-25T00:30:00Z"))).toBe(true); // 01:30 BST
    expect(isOpen(smallHours, new Date("2026-10-25T01:30:00Z"))).toBe(true); // 01:30 again, GMT
    expect(isOpen(smallHours, new Date("2026-10-25T02:30:00Z"))).toBe(false); // 02:30 GMT
  });

  // The offset is applied to the INSTANT, never to the literal: 18:30+02:00
  // is 17:30 in London and therefore shut, where a naive "strip the offset
  // and read the digits" would call it 18:30 and, before that, 16:30Z.
  it("normalises an instant given in another offset to London time", () => {
    expect(isOpen(WEEK, new Date("2026-09-07T17:30:00+02:00"))).toBe(true); // 16:30 London
    expect(isOpen(WEEK, new Date("2026-09-07T18:30:00+02:00"))).toBe(false); // 17:30 London
    // 23:30 London is still the same London weekday, not tomorrow's line.
    expect(isOpen(WEEK, new Date("2026-09-06T23:30:00+01:00"))).toBe(false); // Sunday: Closed
  });

  // TZ=UTC in the harness (vitest.config.mts) makes an ordinary fixture blind
  // to a getHours()/getUTCHours() mix-up, so UtcOnlyDate is what holds that
  // line: the module must read the instant through Intl, never through the
  // host's local-time accessors, or it would answer in whatever zone the
  // machine happens to sit in rather than in London.
  it("never reads the host's local-time accessors", () => {
    expect(isOpen(WEEK, new UtcOnlyDate("2026-07-06T16:30:00+01:00"))).toBe(true); // Monday, deep in BST
    expect(isOpen(WEEK, new UtcOnlyDate("2026-07-06T17:30:00+01:00"))).toBe(false);
    expect(isOpen(oneHourPerDay, new UtcOnlyDate("2026-09-07T01:30:00+01:00"))).toBe(true);
  });

  // Same graceful-degradation divergence as openingHoursDays: Django's
  // days[weekday] raises IndexError on a short string; here the missing line
  // becomes "" and the answer is "cannot tell".
  it("returns null rather than throwing when today's line is missing", () => {
    expect(isOpen("Monday: 9:00 AM - 5:00 PM", SUNDAY)).toBeNull();
    expect(isOpen("\n", MONDAY)).toBeNull();
    expect(isOpen(" ", MONDAY)).toBeNull();
  });

  // Unlike openingHoursDays, which throws RangeError on the same input:
  // pythonWeekday() yields NaN, days[NaN] is undefined, `?? ""` takes over
  // and the whole thing degrades to "cannot tell". The asymmetry is
  // deliberate to record, not to rely on.
  it("returns null for an invalid Date, where openingHoursDays throws", () => {
    expect(isOpen(WEEK, new Date("not a date"))).toBeNull();
    expect(isOpen(WEEK, new Date(NaN))).toBeNull();
  });

  // Called with a single argument in production (locationDetail.ts:223), so
  // the default `now` is the live path -- and with the clock pinned this
  // asserts the actual answer instead of "it returned one of three values".
  it("defaults to the current time when no clock is supplied", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:00:00+01:00")); // Monday lunchtime
    expect(isOpen(WEEK)).toBe(true);
    vi.setSystemTime(new Date("2026-09-07T18:00:00+01:00")); // Monday evening
    expect(isOpen(WEEK)).toBe(false);
    vi.setSystemTime(new Date("2026-09-05T12:00:00+01:00")); // Saturday: Closed
    expect(isOpen(WEEK)).toBe(false);
    expect(isOpen(everyDay("Monday: By appointment only"))).toBeNull();
  });
});
