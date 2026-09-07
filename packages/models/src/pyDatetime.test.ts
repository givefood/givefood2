import { describe, expect, it } from "vitest";
import { pyDatetime, pyNow } from "./pyDatetime";

// The invariant this module exists for: D1 stores timestamps as TEXT, and
// SQLite compares TEXT lexicographically. Two live bugs came from mixing
// Django's `str(datetime)` with JavaScript's toISOString() in one column --
// the wrong "latest need" during the 2026-09-05 migration, and a 24-hour
// dashboard threshold that silently dropped 31 of 46 same-day rows.
//
// So these tests assert the ORDERING property directly, not just the string
// shape. A future "tidy-up" that switches to toISOString() would still look
// reasonable in a diff; it cannot survive the comparison tests below.

describe("pyDatetime", () => {
  it("renders Django's str(datetime): space separator, six fractional digits", () => {
    expect(pyDatetime(new Date("2026-09-05T19:28:08.853Z"))).toBe("2026-09-05 19:28:08.853000");
  });

  it("pads every field, so all values are the same length", () => {
    expect(pyDatetime(new Date("2020-01-02T03:04:05.006Z"))).toBe("2020-01-02 03:04:05.006000");
    expect(pyDatetime(new Date("2020-11-12T13:14:15.678Z"))).toBe("2020-11-12 13:14:15.678000");
    const lengths = new Set(
      [
        new Date("2020-01-02T03:04:05.006Z"),
        new Date("2026-12-31T23:59:59.999Z"),
        new Date("2020-01-01T00:00:00.000Z"),
      ].map((d) => pyDatetime(d).length),
    );
    expect(lengths).toEqual(new Set([26]));
  });

  it("prints a zero millisecond field as .000000 rather than omitting it", () => {
    // Python omits the fraction entirely at microsecond 0; this writes zeros
    // on purpose so that every value it produces is the same length. Both
    // sort correctly, and the module comment explains why the divergence is
    // safe -- pin it so nobody "fixes" it into a variable-length string.
    expect(pyDatetime(new Date("2026-09-05T19:28:08.000Z"))).toBe("2026-09-05 19:28:08.000000");
  });

  it("reads the date in UTC, never local time", () => {
    // 23:30 UTC is the NEXT day in Sydney and the SAME day in London. If
    // these helpers ever used getFullYear()/getHours() this flips the date.
    expect(pyDatetime(new Date("2026-06-30T23:30:00.000Z"))).toBe("2026-06-30 23:30:00.000000");
    // Midway through BST, where a local-time reader would be an hour out.
    expect(pyDatetime(new Date("2026-07-15T00:30:00.000Z"))).toBe("2026-07-15 00:30:00.000000");
  });

  it("sorts lexicographically in the same order as chronologically", () => {
    const chronological = [
      new Date("2020-01-24T16:30:23.173Z"),
      new Date("2026-09-05T08:00:00.000Z"),
      new Date("2026-09-05T19:28:08.853Z"),
      new Date("2026-09-05T20:00:00.000Z"),
      new Date("2026-09-06T00:00:00.000Z"),
    ].map(pyDatetime);
    expect([...chronological].sort()).toEqual(chronological);
  });

  it("beats the toISOString() bug it was written to fix", () => {
    // The exact comparison from the module comment: an 08:00 ISO value
    // sorts AFTER a 20:00 Django value, because 'T' (0x54) > ' ' (0x20).
    const morning = new Date("2026-09-05T08:00:00.000Z");
    const evening = new Date("2026-09-05T20:00:00.000Z");
    expect(morning.toISOString() > pyDatetime(evening)).toBe(true); // the bug
    expect(pyDatetime(morning) > pyDatetime(evening)).toBe(false); // the fix
  });
});

describe("pyNow", () => {
  it("produces the same shape as pyDatetime", () => {
    expect(pyNow()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
  });

  it("agrees with pyDatetime(new Date()) to the second", () => {
    expect(pyNow().slice(0, 19)).toBe(pyDatetime(new Date()).slice(0, 19));
  });
});
