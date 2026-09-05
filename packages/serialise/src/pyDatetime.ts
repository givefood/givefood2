// PLAN.md §7.4.6 -- "Datetimes: the same value, three renderings". Stated
// there as a rule because it trips people up, and it tripped this port:
// until 2026-09-05 every serialiser emitted the D1 column's raw string.
//
// WHY THAT WAS WRONG TWICE OVER. First, the raw string is never what Django
// sends in ANY format -- the table below is what it sends. Second, D1 no
// longer holds one format: rows the ETL copied from Postgres carry
// Python's str(datetime) (`2020-01-24 16:30:23.173268`), while rows the
// port itself writes carry JavaScript's toISOString()
// (`2026-09-05T15:21:42.853Z`). So a raw pass-through gave an API consumer
// a DIFFERENT shape for a need found yesterday than for one found last
// year, on the same endpoint. Found by diffing beta against production;
// 114 of 34,175 foodbankchange rows were already in the second shape.
//
// The fix is a parser that accepts both and formatters that produce what
// Python does. All Django datetimes here are NAIVE UTC (USE_TZ = False,
// TZ pinned to UTC), so a trailing Z or offset is dropped, not converted.
//
//   Python expression                          | rendering
//   -------------------------------------------|------------------------------
//   DjangoJSONEncoder (gfapi2 created/found,   | 2020-01-24T16:30:23.173
//     gfapi1 created/need_found)               |   -- isoformat() truncated
//                                              |      to milliseconds
//   isoformat()  (XML, via dicttoxml)          | 2020-01-24T16:30:23.173268
//   str(datetime) (gfapi1 updated, gfapi3      | 2020-01-24 16:30:23.173268
//     found), and PyYAML's timestamp scalar    |
//
// In every rendering a datetime whose microsecond is 0 has NO fractional
// part at all -- Python omits it rather than printing zeros. Reproduced.

interface Parts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  micro: string; // exactly six digits, "000000" when absent
}

const RAW_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:?\d{2})?$/;

export function parsePyDatetime(raw: string): Parts | null {
  const m = RAW_RE.exec(raw.trim());
  if (!m) return null;
  return { date: m[1]!, time: m[2]!, micro: (m[3] ?? "").padEnd(6, "0") };
}

function fraction(p: Parts, digits: number): string {
  // Python's rule, not "always print N digits": a zero microsecond field
  // prints nothing. DjangoJSONEncoder then slices the six-digit isoformat
  // to three -- a truncation, never a rounding -- which is why `digits`
  // slices rather than rounds here too.
  return p.micro === "000000" ? "" : `.${p.micro.slice(0, digits)}`;
}

// An unparseable value is returned unchanged rather than thrown on: this
// runs inside a response serialiser, and one odd row must not 500 a
// 1,000-row list. It also means a bug here degrades to the pre-fix output,
// which is at least the shape the site was already shipping.

// DjangoJSONEncoder.default() for a naive datetime: isoformat(), then if
// microsecond != 0, `r[:23] + r[26:]` -- keep three fractional digits.
export function formatDjangoJsonDatetime(raw: string): string {
  const p = parsePyDatetime(raw);
  return p ? `${p.date}T${p.time}${fraction(p, 3)}` : raw;
}

// datetime.isoformat() -- what dicttoxml calls on a datetime value.
export function formatIsoDatetime(raw: string): string {
  const p = parsePyDatetime(raw);
  return p ? `${p.date}T${p.time}${fraction(p, 6)}` : raw;
}

// str(datetime), which is isoformat(sep=" "). Also PyYAML's representation
// of a datetime (represent_datetime uses isoformat(" ")).
export function formatPyStrDatetime(raw: string): string {
  const p = parsePyDatetime(raw);
  return p ? `${p.date} ${p.time}${fraction(p, 6)}` : raw;
}
