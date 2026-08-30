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

// django.template.defaultfilters.filesizeformat. `bytes` is a whole byte
// count (the `dump.size` column) -- Django's own %d branch assumes the same.
export function filesizeformat(bytes: number): string {
  if (!Number.isFinite(bytes)) return "0 bytes";
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const TB = GB * 1024;
  const PB = TB * 1024;
  const negative = bytes < 0;
  const b = negative ? -bytes : bytes;

  let value: string;
  if (b < KB) {
    value = `${b} ${b === 1 ? "byte" : "bytes"}`;
  } else if (b < MB) {
    value = `${(b / KB).toFixed(1)} KB`;
  } else if (b < GB) {
    value = `${(b / MB).toFixed(1)} MB`;
  } else if (b < TB) {
    value = `${(b / GB).toFixed(1)} GB`;
  } else if (b < PB) {
    value = `${(b / TB).toFixed(1)} TB`;
  } else {
    value = `${(b / PB).toFixed(1)} PB`;
  }
  return negative ? `-${value}` : value;
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

const DATE_FORMAT_TOKENS: Record<string, (d: Date) => string> = {
  Y: (d) => String(d.getUTCFullYear()),
  m: (d) => String(d.getUTCMonth() + 1).padStart(2, "0"),
  d: (d) => String(d.getUTCDate()).padStart(2, "0"),
};

// django's `date` filter -- only the tokens actually used by a ported
// template (Y, m, d) are supported; extend DATE_FORMAT_TOKENS if a future
// port needs more. `value` is a D1 TEXT timestamp, "YYYY-MM-DD HH:MM:SS[.ffffff]".
export function djangoDate(value: string, format: string): string {
  const iso = `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return format.replace(/[Ymd]/g, (token) => DATE_FORMAT_TOKENS[token]!(date));
}

// django's `floatformat:N` -- fixed N decimal places for display. Only the
// explicit-positive-arg form is needed by any ported template so far (not
// floatformat's no-arg/negative-arg "trim trailing zeros" variants).
export function floatformat(value: number, decimalPlaces: number): string {
  return value.toFixed(decimalPlaces);
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

export function linebreaks(value: string): string {
  const paragraphs = escapeHtml(value).split(/\n{2,}/);
  return paragraphs.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("\n\n");
}

// django's `linebreaksbr` -- NOT the same as linebreaks above: no <p>
// wrapping/paragraph grouping at all, just a flat escape-then-replace of
// every newline with <br>.
export function linebreaksbr(value: string): string {
  return escapeHtml(value.replace(/\r\n|\r/g, "\n")).replace(/\n/g, "<br>");
}

// django's `truncatechars:N` -- Truncator(value).chars(N): if value is
// already <= N chars, returned unchanged; otherwise cut so that text plus
// a single trailing "…" together total exactly N characters.
export function truncatechars(value: string, count: number): string {
  if (value.length <= count) return value;
  return `${value.slice(0, count - 1)}…`;
}
