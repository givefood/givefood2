// Ticket #9. Timestamps written into D1 must look like the ones Django
// writes, because D1 stores them as TEXT and SQLite compares TEXT
// lexicographically.
//
//   Django / the ETL   2026-09-05 19:28:08.853000     <- str(datetime)
//   new Date().toISOString()   2026-09-05T19:28:08.639Z
//
// `'T'` is 0x54 and `' '` is 0x20, so within one day EVERY ISO value sorts
// after EVERY Django value regardless of the actual time:
//
//   SELECT '2026-09-05T08:00:00.000Z' > '2026-09-05 20:00:00.000000';  -- 1
//
// An 08:00 row beating a 20:00 row is not a rendering quirk; it is the
// wrong row coming back from `ORDER BY created DESC LIMIT 1`, and the wrong
// count from `WHERE created >= ?`. Both were live:
//
//   * recomputeFoodbankNeedFields picked the wrong "latest published need"
//     during the 2026-09-05 migration and needed a replace() workaround.
//   * getAdminDashboardStats built its 24-hour threshold with toISOString()
//     and compared it against Django-format columns, silently dropping
//     every same-day row -- measured at 31 of 46 on foodbankchange.
//
// So: one helper, used everywhere a timestamp is written to or compared
// against D1. Not in @givefood/serialise, where the other datetime code
// lives, because packages/db does not depend on serialise and does most of
// the writing; @givefood/models is the zero-dependency package all three
// consumers already import.
//
// SIX FRACTIONAL DIGITS ALWAYS. JS gives milliseconds, so the last three
// are zeros -- padded rather than left at three so that every value this
// writes has identical length and lexicographic order matches chronological
// order exactly. Python omits the fraction entirely when microsecond is 0;
// that difference is invisible to comparisons (a shorter string that is a
// prefix sorts first, which is the correct direction) and the API layer
// re-derives Python's rendering anyway via @givefood/serialise's
// formatPyStrDatetime.

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Django's `str(datetime)` for a naive UTC datetime: `YYYY-MM-DD HH:MM:SS.ffffff`. */
export function pyDatetime(d: Date): string {
  // getUTC*, never the local getters: Django runs with USE_TZ=False and TZ
  // pinned to UTC, so every stored timestamp is naive UTC. A Worker has no
  // local timezone other than UTC, but being explicit keeps this correct if
  // it is ever run somewhere that does.
  const date = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  const time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  const micro = `${String(d.getUTCMilliseconds()).padStart(3, "0")}000`;
  return `${date} ${time}.${micro}`;
}

/** `pyDatetime(new Date())` -- the common case at a write site. */
export function pyNow(): string {
  return pyDatetime(new Date());
}
