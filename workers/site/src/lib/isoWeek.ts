// gfdash `weekly_itemcount`/`weekly_itemcount_year` (views.py:27-80) group
// needs by `"%s-%s" % (year, week_number)` where `year` is
// `need.created.year` (the plain calendar year) and `week_number` is
// `need.created.isocalendar()[1]` (the ISO 8601 week number). Those two
// are DELIBERATELY not from the same calendar system near a year boundary
// -- isocalendar()'s own year (isocalendar()[0]) can differ from
// date.year for the last days of December/first days of January, and the
// Django code uses date.year regardless. Reproduced verbatim, quirk
// included, rather than "fixed" into a self-consistent ISO year+week pair.
export function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
}

export function weekKey(date: Date): string {
  return `${date.getUTCFullYear()}-${isoWeekNumber(date)}`;
}

// D1's stored `created` shape ("YYYY-MM-DD HH:MM:SS.ffffff", no 'T'/'Z') --
// same conversion filters.ts's formatRfc2822/newsCharity.ts already use.
export function parseD1Timestamp(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}
