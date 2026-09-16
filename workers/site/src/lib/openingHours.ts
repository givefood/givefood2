// FoodbankDonationPoint.opening_hours_days()/is_open --
// givefood/models/foodbank.py:1153-1245. Needed only by the
// donationpoint_openinghours fragment (no /md/ twin exists to reuse this
// from). `opening_hours` is stored as 7 newline-separated "Day: hours"
// lines, Monday first; day-name/"Closed" translation happens in the njk
// template via `_()` at render time instead of Django's pre-split string
// replace -- cleaner given this codebase's render()-time translate
// function, same rendered *text*.
//
// EVERY CLOCK AND CALENDAR READ HERE IS Europe/London, NOT UTC.
// `opening_hours` holds what is written on the shop door -- Google Places'
// weekdayDescriptions for a UK place, or an admin typing the same thing by
// hand -- so "7:00 AM" means 7am in Farnborough, never 7am UTC. Workers run
// in UTC, which is the same clock only between the October and March
// transitions; through British Summer Time a UTC read is an hour early. That
// is issue #60: Morrisons Southwood, open 7:00 AM - 10:00 PM, badged "Closed"
// in a screenshot taken at 07:39 BST, and shut-looking every BST morning
// until 8am local. The same offset moved the seven-row rotation onto the
// wrong day for the first hour of each BST day (00:30 BST is 23:30 UTC the
// day before), which mislabels all seven rows and shifts the bank-holiday
// banners with them. Winter answers are unchanged, because Europe/London IS
// UTC then.
//
// DELIBERATE DIVERGENCE on `is_closed`: Django computes it from the
// ALREADY-TRANSLATED text (`opening_hours.replace("Closed", _("Closed"))`
// happens before the `"Closed" in day_text` check) -- on cy/ga/gd, where
// "Closed" doesn't translate to a string containing the literal substring
// "Closed", that check is silently always False in the real app, a
// translation-ordering bug, not a deliberate one. This port computes
// is_closed from the real (English, untranslated) source text instead, so
// it stays correct on every locale -- translation is applied only for
// display (day_name/"Closed" label) in the njk template, never mixed into
// this boolean. Not byte-for-byte Django parity; a considered choice not
// to reproduce an accidental bug that would silently degrade three
// locales' opening-hours pages for no benefit.
import bankHolidaysData from "../data/bank-holidays.json";

interface BankHolidayEvent {
  title: string;
  date: string;
  notes: string;
  bunting: boolean;
}
type BankHolidaysData = Record<string, { division: string; events: BankHolidayEvent[] }>;

const BANK_HOLIDAY_DIVISION: Record<string, string> = {
  England: "england-and-wales",
  Wales: "england-and-wales",
  Scotland: "scotland",
  "Northern Ireland": "northern-ireland",
};

function bankHolidaysForCountry(country: string | null): BankHolidayEvent[] {
  const division = country ? BANK_HOLIDAY_DIVISION[country] : undefined;
  if (!division) return [];
  return (bankHolidaysData as BankHolidaysData)[division]?.events ?? [];
}

export interface OpeningHoursDay {
  day_name: string;
  hours: string;
  is_closed: boolean;
  is_today: boolean;
  holiday: BankHolidayEvent | null;
}

function splitDayLine(dayText: string): { day_name: string; hours: string } {
  const sepIdx = dayText.indexOf(": ");
  return sepIdx === -1 ? { day_name: dayText, hours: "" } : { day_name: dayText.slice(0, sepIdx), hours: dayText.slice(sepIdx + 2) };
}

// Python's date.weekday() (Monday=0..Sunday=6) from JS's getUTCDay() (Sunday=0..Saturday=6).
function pythonWeekday(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

// One formatter, built once: constructing an Intl.DateTimeFormat is the
// expensive part, and this one is stateless.
const LONDON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23", // midnight is 00:xx, not 24:xx
});

interface LondonTime {
  year: number;
  month: number; // 1-12, as Intl reports it
  day: number;
  minutes: number; // since London midnight
}

// The London wall-clock fields for an instant. Throws RangeError("Invalid
// time value") on an invalid Date -- Intl's own behaviour, and by luck
// exactly the error `openingHoursDays` already raised there, so that
// function's pinned contract is unchanged.
function londonTime(now: Date): LondonTime {
  const parts = LONDON.formatToParts(now);
  const field = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    minutes: field("hour") * 60 + field("minute"),
  };
}

// The London calendar date re-expressed as a UTC midnight. The rest of this
// module's date arithmetic -- pythonWeekday, the whole-day steps, the
// toISOString() holiday key -- is written against UTC calendar fields, so
// handing it a UTC stand-in for the London date keeps all of it correct
// without a second timezone conversion per row.
function londonMidnightUtc(t: LondonTime): number {
  return Date.UTC(t.year, t.month - 1, t.day);
}

// `opening_hours_days()`. Django's `False` no-hours sentinel is `null`
// here; the caller (wfbnFoodbankDonationpointOpeninghours) already 404s
// before this runs, so that branch is unreached in practice.
export function openingHoursDays(openingHours: string | null, country: string | null, now: Date = new Date()): OpeningHoursDay[] | null {
  if (!openingHours) return null;
  const days = openingHours.split("\n");
  const holidays = bankHolidaysForCountry(country);
  const todayUtc = londonMidnightUtc(londonTime(now));

  const result: OpeningHoursDay[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const dayDate = new Date(todayUtc + offset * 86400000);
    const dayText = days[pythonWeekday(dayDate)] ?? "";
    const dateStr = dayDate.toISOString().slice(0, 10);
    result.push({
      ...splitDayLine(dayText),
      is_closed: dayText.includes("Closed"),
      is_today: offset === 0,
      holiday: holidays.find((h) => h.date === dateStr) ?? null,
    });
  }
  return result;
}

// Python's `%I:%M %p` (e.g. "9:00 AM") -> minutes since midnight. strptime's
// %M, like %I, accepts 1 or 2 digits (confirmed: strptime("9:5 AM", "%I:%M
// %p") parses fine as 09:05) -- \d{1,2} on both groups, not just the hour.
function parseClockTime(text: string): number | null {
  const m = /^(\d{1,2}):(\d{1,2})\s*(AM|PM)$/i.exec(text.trim());
  if (!m) return null;
  const rawHour = Number(m[1]);
  const minute = Number(m[2]);
  if (rawHour < 1 || rawHour > 12 || minute > 59) return null;
  const meridiem = m[3]!.toUpperCase();
  const hour = meridiem === "AM" ? (rawHour === 12 ? 0 : rawHour) : rawHour === 12 ? 12 : rawHour + 12;
  return hour * 60 + minute;
}

// `is_open` property, answered on the London clock -- see the module header.
export function isOpen(openingHours: string | null, now: Date = new Date()): boolean | null {
  if (!openingHours) return null;
  // "Cannot tell" for an unusable clock, as for every other unusable input
  // here. Explicit because londonTime() would throw on it, where the old
  // getUTCDay()-of-NaN route degraded by accident.
  if (Number.isNaN(now.getTime())) return null;
  const days = openingHours.split("\n");
  const today = londonTime(now);
  const dayText = days[pythonWeekday(new Date(londonMidnightUtc(today)))] ?? "";
  if (dayText.includes("Closed")) return false;

  const { hours } = splitDayLine(dayText);
  if (!hours) return null;
  const parts = hours.split(/\s*[–—-]\s*/);
  if (parts.length !== 2) return null;
  const openMin = parseClockTime(parts[0]!);
  const closeMin = parseClockTime(parts[1]!);
  if (openMin === null || closeMin === null) return null;

  const currentMin = today.minutes;
  if (closeMin <= openMin) return currentMin >= openMin; // crosses midnight
  return currentMin >= openMin && currentMin < closeMin;
}
