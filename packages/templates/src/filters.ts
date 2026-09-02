// Ported verbatim from givefood/utils/text.py -- the entire bespoke
// template-filter surface (PLAN.md §6.2.4: "four filters and zero custom
// tags", "an afternoon, and it is the entire bespoke template-language
// surface").
const QUERYSTRING_RUBBISH = ["utm_source", "utm_medium", "utm_campaign", "y_source", "sc_cmp", "extcam", "utm_content"];

export function friendlyPhone(phone: string | null): string | null {
  if (!phone) return phone;
  return `${phone.slice(0, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}`;
}

export function fullPhone(phone: string | null): string | null {
  if (!phone) return phone;
  return phone.startsWith("0") ? `+44${phone.slice(1)}` : phone;
}

export function friendlyUrl(url: string): string {
  let stripped = url.replace(/^https:\/\//, "").replace(/^http:\/\//, "");
  const parsed = new URL(stripped.includes("://") ? stripped : `https://${stripped}`);
  for (const key of QUERYSTRING_RUBBISH) parsed.searchParams.delete(key);
  // Reconstruct without the scheme -- matches Python furl's `.url` after
  // the scheme was already stripped from the input above.
  let out = parsed.host + parsed.pathname + (parsed.search || "");
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export function commaSeparated(value: string): string {
  return value.split("\n").join(", ");
}

// Below: Django/django.contrib.humanize builtin filters, ported because the
// gfapi1/gfapi2 doc pages use them -- not part of the bespoke text.py
// surface above, but there's no nunjucks/npm equivalent to reach for either.

// django.utils.text.slugify (allow_unicode=False, the default).
export function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
  const lowered = ascii.toLowerCase().replace(/[^\w\s-]/g, "");
  return lowered.replace(/[-\s]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
}

// django.contrib.humanize's intcomma -- the same recursive regex substitution
// Django itself uses, so this matches its output (including negatives) exactly.
export function intcomma(value: number | string): string {
  let result = String(value);
  let prev: string;
  do {
    prev = result;
    result = result.replace(/^(-?\d+)(\d{3})/, "$1,$2");
  } while (result !== prev);
  return result;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Django's `P` format: 12-hour time, minutes dropped when :00, and the
// "midnight"/"noon" special cases -- ported verbatim from
// django.utils.dateformat.DateFormat.f()/P(), not approximated.
function formatP(d: Date): string {
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  if (hours === 0 && minutes === 0) return "midnight";
  if (hours === 12 && minutes === 0) return "noon";
  const ampm = hours < 12 ? "a.m." : "p.m.";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0 ? `${h12} ${ampm}` : `${h12}:${String(minutes).padStart(2, "0")} ${ampm}`;
}

// Django's `N` token: "Month abbreviation in Associated Press style" --
// ported verbatim from django.utils.dates.MONTHS_AP, not a simple
// abbreviation + period (March/April/May/June/July are spelled out in
// full, and September is "Sept." not "Sep."). Used by DATETIME_FORMAT/
// DATE_FORMAT ("N j, Y[, P]"), the format Django applies whenever a
// datetime/date is printed with no explicit `|date:"..."` filter.
const MONTHS_AP = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

// Django's `S` token: "English ordinal suffix for day of the month, 2
// characters" -- 'st'/'nd'/'rd'/'th', ported verbatim from
// django.utils.dateformat.DateFormat.S() (the 11th/12th/13th exception).
function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

const DATE_FORMAT_TOKENS: Record<string, (d: Date) => string> = {
  Y: (d) => String(d.getUTCFullYear()),
  m: (d) => String(d.getUTCMonth() + 1).padStart(2, "0"),
  d: (d) => String(d.getUTCDate()).padStart(2, "0"),
  j: (d) => String(d.getUTCDate()),
  S: (d) => ordinalSuffix(d.getUTCDate()),
  M: (d) => MONTH_ABBR[d.getUTCMonth()]!,
  N: (d) => MONTHS_AP[d.getUTCMonth()]!,
  P: formatP,
  // RFC 2822 tokens ("D, d M Y H:i:s O", Django's `|date:"r"`/`{% now "r" %}`
  // shortcut spelled out) -- Workers run in UTC and Django's timezone.now()
  // is UTC-aware too, so O is always the fixed +0000 offset, same reasoning
  // as env.ts's now() global.
  D: (d) => DAY_ABBR[d.getUTCDay()]!,
  H: (d) => String(d.getUTCHours()).padStart(2, "0"),
  i: (d) => String(d.getUTCMinutes()).padStart(2, "0"),
  s: (d) => String(d.getUTCSeconds()).padStart(2, "0"),
  O: () => "+0000",
};

// The actual token substitution, split out from djangoDate below so a
// caller already holding a real Date (env.ts's `now` global, this
// package's other Date-producing callers) can format one directly instead
// of round-tripping through a D1-timestamp-string parse it doesn't need.
export function formatDjangoDateTokens(date: Date, format: string): string {
  return format.replace(/[YmdjSMNPDHisO]/g, (token) => DATE_FORMAT_TOKENS[token]!(date));
}

// django's `date` filter -- only the tokens actually used by a ported
// template are supported; extend DATE_FORMAT_TOKENS if a future port
// needs more. `value` is a D1 TEXT timestamp, "YYYY-MM-DD[ HH:MM:SS[.ffffff]]"
// -- the time part is optional (some stored dates genuinely have none, see
// workers/site/src/lib/timesince.ts's parseUtc for the production case that
// proved it), and any existing "Z" suffix has to come off before appending
// a new one or it corrupts the string ("...:00Z" + "Z" isn't a valid ISO
// instant) -- the same defensive parsing as parseUtc, duplicated rather
// than cross-package-imported per this repo's small-shared-shape precedent
// (see BOT_USER_AGENT/slugify).
export function djangoDate(value: string | null | undefined, format: string): string {
  // Django's own `|date` on a None/empty value renders "" -- it never raises.
  // Matching that is not just defensiveness: a nullable timestamp reaching
  // this filter is NORMAL (foodbank.edited, last_need_check, an order's
  // actual delivery...), and templates guard on the ROW existing far more
  // often than on the individual column. Throwing here 500s the whole page
  // for a null column, which is exactly what happened to the admin dashboard
  // (`stats.oldest_edit.edited` is null whenever the oldest-edited food bank
  // has never been edited -- SQLite sorts NULLs first on ORDER BY edited ASC,
  // so that row is the one the query returns).
  if (!value) return "";
  const withT = value.includes(" ") ? value.replace(" ", "T") : value;
  const hasTime = withT.includes("T");
  const iso = `${hasTime ? withT.replace(/Z$/, "") : `${withT}T00:00:00`}Z`;
  const date = new Date(iso);
  // An unparseable stored value renders as "" too, rather than the literal
  // "NaN NaN, NaN" the token substitution would otherwise emit.
  return Number.isNaN(date.getTime()) ? "" : formatDjangoDateTokens(date, format);
}

// django's `floatformat:N` -- fixed N decimal places for display. Only the
// explicit-positive-arg form is needed by any ported template so far (not
// floatformat's no-arg/negative-arg "trim trailing zeros" variants).
export function floatformat(value: number, decimalPlaces: number): string {
  return value.toFixed(decimalPlaces);
}

// django's `|title` -- Python's str.title() (title-case after ANY
// non-letter boundary: hyphens, apostrophes, parens, not just spaces),
// followed by two touch-up regexes (an apostrophe-then-capital gets its
// capital lowered back, e.g. "Bill'S" -> "Bill's"; a digit-then-capital
// too, e.g. "3Rd" -> "3rd"). Registered as "django_title", not "title":
// nunjucks ships a builtin `title` filter that only splits on spaces,
// same "don't silently shadow a builtin with different semantics"
// reasoning as djangoSlice/djslice above. ASCII-letter scope only, same
// simplification PLAN.md R7 already accepts for slugify() -- this
// codebase's charity names are English/ASCII throughout.
export function djangoTitle(value: string): string {
  let titled = "";
  let prevIsAlpha = false;
  for (const ch of value) {
    const isAlpha = /[A-Za-z]/.test(ch);
    titled += isAlpha ? (prevIsAlpha ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prevIsAlpha = isAlpha;
  }
  return titled
    .replace(/([a-z])'([A-Z])/g, (_m, before: string, after: string) => `${before}'${after.toLowerCase()}`)
    .replace(/(\d)([A-Z])/g, (_m, digit: string, after: string) => `${digit}${after.toLowerCase()}`);
}

// django's `|slice:"5"` -- Python list-slice syntax (here, just the "first
// N" form actually used by any ported template so far). Registered as
// "djslice", not "slice": nunjucks already ships a builtin `slice` filter
// with completely different (Jinja2 chunking) semantics -- shadowing it
// would silently break that meaning for any future template that wants it.
export function djangoSlice(arr: readonly unknown[], count: number): unknown[] {
  return arr.slice(0, count);
}

// django's `linebreaks` filter -- HTML-escape, then blank-line-separated
// paragraphs become <p>, single newlines within a paragraph become <br>.
// Only the plain (non-`|safe`) input case is needed by any ported template
// so far, so this always escapes first, matching Django's default
// autoescape-on behaviour for this filter.
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Django's template filters treat None as "" (StringifyToText coerces it),
// not a TypeError -- WP 6.4's need.excess_change_text (nullable) was the
// first caller to actually hit this, but the guard belongs here rather
// than at each call site: every future `| linebreaks(br)` on a nullable
// column should get the same safe-empty behaviour, not a 500.
export function linebreaks(value: string | null | undefined): string {
  if (!value) return "";
  const paragraphs = escapeHtml(value).split(/\n{2,}/);
  return paragraphs.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("\n\n");
}

// django's `linebreaksbr` -- NOT the same as linebreaks above: no <p>
// wrapping/paragraph grouping at all, just a flat escape-then-replace of
// every newline with <br>.
export function linebreaksbr(value: string | null | undefined): string {
  if (!value) return "";
  return escapeHtml(value.replace(/\r\n|\r/g, "\n")).replace(/\n/g, "<br>");
}

// django's `truncatechars:N` -- Truncator(value).chars(N): if value is
// already <= N chars, returned unchanged; otherwise cut so that text plus
// a single trailing "…" together total exactly N characters.
export function truncatechars(value: string, count: number): string {
  if (value.length <= count) return value;
  return `${value.slice(0, count - 1)}…`;
}

// django's `truncatewords:N` -- Truncator(value).words(N, truncate=" …"):
// Python's str.split() (no-arg) semantics, which splits on any run of
// whitespace and drops empty leading/trailing tokens, matched here with
// trim() + split(/\s+/). If there are <= N words, the words are rejoined
// (whitespace-normalised, same as Django); otherwise the first N words are
// rejoined and " …" appended (add_truncation_text's default truncate
// string, which doesn't contain "%(truncated_text)s" so it's a plain
// suffix, not a %-substitution).
export function truncatewords(value: string, count: number): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length <= count) return words.join(" ");
  return `${words.slice(0, count).join(" ")} …`;
}
