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
