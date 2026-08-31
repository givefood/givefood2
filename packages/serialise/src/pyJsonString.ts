// WP 3.6 (geo.json), PLAN.md's STRICT byte-equality parity note. Python's
// json.dumps() defaults to ensure_ascii=True: every character outside
// printable ASCII (0x20-0x7E) is escaped as `\uXXXX`, INCLUDING characters
// JS's native JSON.stringify would happily emit as raw UTF-8. Verified
// against the live site: a curly apostrophe in a food bank name like
// "St John's Church Hall" comes back from /needs/geo.json as the literal
// six bytes `’`, and "Ynys Môn" comes back as `Ynys Môn` -- not
// the raw characters JSON.stringify("Ynys Môn") would produce. Every
// string VALUE this endpoint emits (feature names/addresses/urls, and any
// string re-embedded from a stored `boundary_geojson` column -- see
// geojsonBoundary.ts) must go through this, not JSON.stringify, to match.
//
// JS strings are UTF-16 internally, so walking UTF-16 code UNITS (not
// Unicode code points) and escaping each one >= 0x7F on its own
// reproduces Python's surrogate-pair handling for free: a character
// outside the BMP is already stored as two UTF-16 code units in the JS
// string, and CPython's `py_encode_basestring_ascii` emits exactly two
// `\uXXXX` escapes for it too (a manual surrogate-pair encoding) -- no
// separate codepoint/surrogate arithmetic needed here.
const SHORT_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

export function pyJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    const short = SHORT_ESCAPES[ch];
    if (short) {
      out += short;
      continue;
    }
    const code = s.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out + '"';
}
