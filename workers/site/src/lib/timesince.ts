// Port of django.utils.timesince.timesince() (English locale only, the
// only locale the JSON API ever serves -- see resolveLanguage.ts). Read
// directly from the installed Django source (django/utils/timesince.py) to
// port exactly, not paraphrased: calendar-aware year/month arithmetic (a
// year is genuinely 12 months, not 365.25 days), up to 2 adjacent units,
// singular/plural per unit, spaces within each unit replaced with U+00A0
// (avoid_wrapping) before joining with ", ".
const UNITS: Array<{ key: string; seconds: number; singular: string; plural: string }> = [
  { key: "year", seconds: 0, singular: "year", plural: "years" },
  { key: "month", seconds: 0, singular: "month", plural: "months" },
  { key: "week", seconds: 604800, singular: "week", plural: "weeks" },
  { key: "day", seconds: 86400, singular: "day", plural: "days" },
  { key: "hour", seconds: 3600, singular: "hour", plural: "hours" },
  { key: "minute", seconds: 60, singular: "minute", plural: "minutes" },
];
const CHUNK_SECONDS = [604800, 86400, 3600, 60]; // week, day, hour, minute -- matches Django's TIME_CHUNKS
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function unitText(count: number, unit: (typeof UNITS)[number]): string {
  const word = count === 1 ? unit.singular : unit.plural;
  return `${count} ${word}`; // avoid_wrapping: the one space in "N word" becomes U+00A0
}

// D1 timestamps are naive UTC text ("YYYY-MM-DD HH:MM:SS.ffffff" or with a
// "T"), matching PLAN.md §4.4/§7.4.6 -- Django itself runs with TZ=UTC when
// USE_TZ=False, so parsing as UTC and comparing against a Worker's `now`
// (also UTC; Workers have no other local timezone) reproduces the same
// naive-datetime arithmetic Django's timesince does.
function parseUtc(s: string): Date {
  const [datePart, timePart] = s.split(/[ T]/);
  const [year, month, day] = (datePart as string).split("-").map(Number);
  const [hms, frac] = (timePart as string).split(".");
  const [hour, minute, second] = (hms as string).split(":").map(Number);
  const millis = frac ? Math.floor(Number(frac.padEnd(6, "0").slice(0, 6)) / 1000) : 0;
  return new Date(Date.UTC(year as number, (month as number) - 1, day, hour, minute, second, millis));
}

export function timesince(dateInput: string | Date, now: Date = new Date()): string {
  const d = typeof dateInput === "string" ? parseUtc(dateInput) : dateInput;

  const sinceSeconds = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (sinceSeconds <= 0) return unitText(0, UNITS[5] as (typeof UNITS)[number]);

  let totalMonths = (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
  const dTimeOfDay = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  const nowTimeOfDay = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  if (d.getUTCDate() > now.getUTCDate() || (d.getUTCDate() === now.getUTCDate() && dTimeOfDay > nowTimeOfDay)) {
    totalMonths -= 1;
  }
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths - years * 12;

  let pivot: Date;
  if (years || months) {
    let pivotYear = d.getUTCFullYear() + years;
    let pivotMonth = d.getUTCMonth() + 1 + months; // 1-indexed, matching Django's d.month + months
    if (pivotMonth > 12) {
      pivotMonth -= 12;
      pivotYear += 1;
    }
    const pivotDay = Math.min(MONTH_DAYS[pivotMonth - 1] as number, d.getUTCDate());
    pivot = new Date(
      Date.UTC(pivotYear, pivotMonth - 1, pivotDay, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()),
    );
  } else {
    pivot = d;
  }

  let remainingSeconds = (now.getTime() - pivot.getTime()) / 1000;
  const partials = [years, months];
  for (const chunk of CHUNK_SECONDS) {
    const count = Math.floor(remainingSeconds / chunk);
    partials.push(count);
    remainingSeconds -= chunk * count;
  }

  const firstNonZero = partials.findIndex((v) => v !== 0);
  if (firstNonZero === -1) return unitText(0, UNITS[5] as (typeof UNITS)[number]);

  const result: string[] = [];
  const depth = 2;
  let i = firstNonZero;
  while (i < UNITS.length && result.length < depth) {
    const value = partials[i] as number;
    if (value === 0) break;
    result.push(unitText(value, UNITS[i] as (typeof UNITS)[number]));
    i += 1;
  }

  return result.join(", ");
}
