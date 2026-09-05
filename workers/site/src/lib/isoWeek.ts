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

// Returns null for an unparseable date instead of the string "NaN-NaN".
// This value is a CHART AXIS LABEL and a table cell, so a bad row rendered
// itself into the page: ticket #7 was a screenshot of a "NaN-NaN" bucket
// sitting at the end of "Items requested by UK food banks per week".
// Callers skip a null rather than grouping under a nonsense key -- one
// unreadable row should cost that row, not the credibility of the chart.
export function weekKey(date: Date): string | null {
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${isoWeekNumber(date)}`;
}

// D1's stored `created` shape ("YYYY-MM-DD HH:MM:SS.ffffff", no 'T'/'Z').
//
// THE TRAILING-Z STRIP IS NOT REDUNDANT, and its absence is what caused
// ticket #7. Appending "Z" blindly turns an input that already ends in one
// into "...ZZ", which `new Date()` resolves to an Invalid Date SILENTLY --
// getTime() is NaN, nothing throws -- and weekKey() then formatted that as
// "NaN-NaN" straight onto the dashboard.
//
// This is the FOURTH site of one bug. workers/site/src/lib/timesince.ts's
// parseUtc(), packages/db/src/foodbankTabs.ts's own parseD1Timestamp() and
// routes/admin/stats.ts's parseStatsTimestamp() were each fixed for exactly
// this -- "blind + Z", foodbankTabs.ts's own words, 2026-09-02 -- and this
// copy was missed. It only became reachable once rows written by the port
// itself carried ISO timestamps; ticket #9 normalised those, which removed
// the trigger without removing the bug.
export function parseD1Timestamp(value: string): Date {
  return new Date(`${value.replace(" ", "T").replace(/Z$/, "")}Z`);
}
