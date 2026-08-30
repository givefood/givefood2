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
