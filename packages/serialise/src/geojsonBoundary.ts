// WP 3.6 (geo.json). Stored `boundary_geojson` TEXT columns (packages/db's
// locations.ts / constituencies.ts) hold one GeoJSON Feature as raw text,
// e.g. {"type":"Feature","geometry":{...},"properties":{...}}. gfwfbn's
// geojson view (gfwfbn/views.py:207-339) needs to overwrite or replace
// that Feature's "properties" object without disturbing the digit-exact
// text of "geometry"'s coordinate numbers -- see float.ts's header on why
// a parse+re-serialize round trip (JSON.parse/JSON.stringify) silently
// collapses e.g. `51.0` to `51` the same way it does everywhere else in
// this codebase. This module locates the parts of the raw text it needs
// to change by bracket/string-aware SCANNING, never by JSON.parse-ing
// (and thereby losing the exact source text of) anything with a number in
// it, and returns text with only those parts spliced.
//
// Two things were verified directly against production before writing any
// of this, both surprising enough to be worth recording:
//
// 1. Key ORDER and PRESENCE are not uniform. Some stored rows have no
//    "properties" key at all (e.g. a `foodbanklocation` row saved by an
//    older pipeline); some have one. Django's view does a plain Python
//    dict assignment (`boundary["properties"] = {...}` for "lb",
//    `boundary["properties"]["type"] = "b"` for "b") -- assigning an
//    EXISTING key updates its value WITHOUT moving its position; assigning
//    a key that isn't there yet APPENDS it at the end of iteration order.
//    Confirmed against two live responses: a location whose stored
//    Feature had no "properties" key at all comes back as
//    {"type":..., "geometry":..., "properties":...} (properties appended
//    LAST, after geometry); a constituency whose stored properties had no
//    "type" key comes back with "type" as the LAST property key, after
//    seven pre-existing ONS boundary fields. `spliceObjectKey` below
//    reproduces exactly this "replace in place, else append at the end"
//    rule -- do not "simplify" it into always appending or always
//    prepending.
//
// 2. STORED FORMATTING is not what the endpoint emits, in two separate
//    ways, both because Django's view does `json.loads(stored_text)` and
//    lets the WHOLE response_dict (this boundary feature included) go
//    through one `JsonResponse(...)` -> `json.dumps(...)` call, which
//    re-encodes everything with Python's defaults regardless of how the
//    source text looked:
//      a. SPACING. Some stored rows are compact (`{"type":"Feature",...`,
//         no spaces at all -- confirmed for `givefood_parliamentaryconstituency`);
//         others are pretty-printed with multi-line indentation (confirmed
//         for some `givefood_foodbanklocation` rows). Neither survives:
//         `json.dumps`'s default separators are `(', ', ': ')` (a real
//         space after every comma and colon, no other whitespace), and
//         that is what every live geo.json response actually has, in the
//         BOUNDARY POLYGON'S OWN COORDINATES too, not just the properties
//         this module touches directly.
//      b. STRING ESCAPING. `json.dumps`'s default `ensure_ascii=True`
//         re-escapes any non-ASCII character as `\uXXXX`, even though the
//         stored column holds it as a raw UTF-8 character -- confirmed
//         directly: `givefood_parliamentaryconstituency`'s stored
//         boundary_geojson for Ynys Môn has a literal "ô" byte in
//         "PCON24NM", but /needs/in/constituency/ynys-mon/geo.json emits
//         "Ynys Môn". A property VALUE straight from the stored
//         text (this module never invents property values for "b", only
//         for "lb" -- and even those go through pyJsonString the same
//         way) must be re-escaped the same way JS's JSON.stringify would
//         not do on its own.
//    `toDjangoJsonFormat` is the one pass that fixes both, applied ONCE by
//    the caller (buildGeojson.ts) over the FULLY ASSEMBLED response body
//    -- not by the two splice functions below, which leave whatever mixed
//    formatting the input already had and only touch the property span
//    they're asked to. Doing the reformat once, over everything (this
//    module's spliced boundary text AND the hand-built Point features
//    around it), is both simpler and cheaper than normalising twice.
import { pyJsonString } from "./pyJsonString";
import { formatFloat } from "./float";

// Mirrors Django's geojson_dict() (givefood/utils/geo.py): strip exactly
// one trailing comma before doing anything else. Confirmed real, not
// just defensive Python: `givefood_parliamentaryconstituency`'s stored
// text for bethnal-green-and-stepney ends "...}},direct from Postgres.
//
// THE CLOSING BRACE IS CHECKED TOO, not just the opening one -- see the two
// call sites below. Both already asserted `text[0] === "{"` and neither
// asserted the other end, which is the whole shape of #21: spliceObjectKey
// takes `objEnd - 1` as the closing brace on trust. Whitespace was one way to
// break that assumption and the trim below fixes it; a DOUBLED trailing comma
// is another, and it was silently corrupting before this change and after it
// -- `'{"a":1},,'` came back as `{"a":1},"properties":{...},`, a 200 whose
// body is not JSON. Django raises JSONDecodeError on that input (geo.py's
// json.loads sees the leftover comma), so the throw is the parity behaviour,
// not extra strictness. Found while fixing #21, in the same function, one
// character away; fixed here rather than left as a second silent-wrong-answer
// report.
//
// TRIMMED AGAIN AFTER THE COMMA COMES OFF (github #21). Django gets away
// without that second trim because `json.loads` tolerates whitespace on both
// ends, so `'{...} ,'` -> strip -> drop the comma -> `'{...} '` -> parses
// fine. This module does not parse: it SPLICES, and spliceObjectKey takes the
// last character as the object's closing brace without checking that it is
// one. A single space between the brace and the comma therefore left the
// splice pointing at whitespace -- appending the new key OUTSIDE the object
// (a 200 whose body is not JSON) when the last value was a scalar, and
// throwing "expected a quoted key" when it was an object, which is the shape
// every real Feature has. Either way the whole feed went, not just the one
// feature: /needs/at/<slug>/geo.json, the location feed and the constituency
// feed all render boundaries through here.
//
// No production row has this shape today -- the ONS-sourced ones end "}}," --
// so the way in is a hand-pasted boundary in the admin's free-text textarea,
// which parseAdminFields whole-value-trims and therefore cannot clean.
function stripTrailingComma(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.endsWith(",") ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

// Index just past the closing quote of the string literal starting at
// text[start] (which must be '"'). String-aware only as far as escapes go
// -- doesn't decode anything, just finds where the literal ends.
function skipString(text: string, start: number): number {
  let i = start + 1;
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      return i + 1;
    }
    i++;
  }
  throw new Error("geojsonBoundary: unterminated string");
}

// Index just past the closing bracket matching the opening '{' or '['
// at text[start]. Quote/escape-aware so a brace or bracket byte sitting
// inside a string value (a name, an ONS field) can never be mistaken for
// structure.
function scanBalanced(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`geojsonBoundary: unterminated ${open}...${close}`);
}

interface TopLevelEntry {
  key: string;
  valueStart: number;
  valueEnd: number;
}

// Enumerates the TOP-LEVEL (depth-1) key/value entries of the JSON object
// spanning text[objStart..objEnd) -- i.e. text[objStart] === '{' and
// text[objEnd-1] === '}'. Nested objects/arrays are skipped over via
// scanBalanced, never descended into, so a "type" key inside e.g. a
// nested geometry can never be mistaken for a top-level one.
function scanTopLevelEntries(text: string, objStart: number, objEnd: number): TopLevelEntry[] {
  const entries: TopLevelEntry[] = [];
  const closeIdx = objEnd - 1;
  let i = objStart + 1;
  while (i < closeIdx) {
    while (i < closeIdx && /[\s,]/.test(text[i] as string)) i++;
    if (i >= closeIdx) break;
    if (text[i] !== '"') throw new Error("geojsonBoundary: expected a quoted key");
    const keyEnd = skipString(text, i);
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    let j = keyEnd;
    while (j < closeIdx && /\s/.test(text[j] as string)) j++;
    if (text[j] !== ":") throw new Error("geojsonBoundary: expected ':' after key");
    j++;
    while (j < closeIdx && /\s/.test(text[j] as string)) j++;
    const valueStart = j;
    const vch = text[j];
    let valueEnd: number;
    if (vch === '"') valueEnd = skipString(text, j);
    else if (vch === "{" || vch === "[") valueEnd = scanBalanced(text, j);
    else {
      let k = j;
      while (k < closeIdx && text[k] !== ",") k++;
      valueEnd = k;
    }
    entries.push({ key, valueStart, valueEnd });
    i = valueEnd;
  }
  return entries;
}

function findTopLevelKey(text: string, objStart: number, objEnd: number, key: string): TopLevelEntry | null {
  const entries = scanTopLevelEntries(text, objStart, objEnd);
  return entries.find((e) => e.key === key) ?? null;
}

// Replace an existing top-level `key`'s value with `rawValue` IN PLACE
// (same position, matching a Python dict assignment to an existing key),
// or append `"key":rawValue` just before the object's closing brace if
// `key` isn't present yet (matching a Python dict assignment to a new
// key -- see this file's header, point 1). `rawValue` is raw JSON text,
// not a JS value -- callers build it themselves (JSON.stringify is fine
// here regardless of ensure_ascii concerns: this text gets normalised by
// toDjangoJsonFormat later, see the header).
function spliceObjectKey(text: string, objStart: number, objEnd: number, key: string, rawValue: string): string {
  const hit = findTopLevelKey(text, objStart, objEnd, key);
  if (hit) {
    return text.slice(0, hit.valueStart) + rawValue + text.slice(hit.valueEnd);
  }
  const entries = scanTopLevelEntries(text, objStart, objEnd);
  const closeIdx = objEnd - 1;
  const insertion = (entries.length > 0 ? "," : "") + JSON.stringify(key) + ":" + rawValue;
  return text.slice(0, closeIdx) + insertion + text.slice(closeIdx);
}

// "lb" feature (FoodbankLocation with a boundary): full replace, matching
// the Django view's `boundary["properties"] = {...}` -- a plain
// reassignment, not a merge, so whatever keys the stored row had (if any)
// are gone. `entries` is an ordered [key, value] list so the caller
// controls property order the same way the Python dict literal does (see
// gfwfbn/views.py:290-295: type, name, foodbank, url -- no address).
export function replaceBoundaryProperties(rawGeojson: string, entries: readonly [string, string][]): string {
  const text = stripTrailingComma(rawGeojson);
  if (text[0] !== "{" || text[text.length - 1] !== "}") throw new Error("geojsonBoundary: not a JSON object");
  const body = entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",");
  return spliceObjectKey(text, 0, text.length, "properties", `{${body}}`);
}

// "b" feature (ParliamentaryConstituency boundary): overwrite -- or
// append, if absent -- a single "type" key nested inside "properties",
// matching `boundary["properties"]["type"] = "b"`. Every other stored
// key/value at any depth, including any nested inside "properties"
// itself, is left as exactly the bytes that were already there.
export function setBoundaryPropertyType(rawGeojson: string, typeValue: string): string {
  let text = stripTrailingComma(rawGeojson);
  if (text[0] !== "{" || text[text.length - 1] !== "}") throw new Error("geojsonBoundary: not a JSON object");
  // Ensure a "properties" *object* exists before reaching inside it -- a
  // handful of stored rows have no "properties" key at all (see this
  // file's header), and GeoJSON also permits a present-but-null value
  // (RFC 7946). Django's own `boundary["properties"]["type"] = "b"`
  // would KeyError/TypeError on either shape (there is no successful
  // Django output to stay byte-parity with here), so both are treated the
  // same way as "missing": replaced with a fresh {} before splicing "type"
  // in, rather than scanning "null" (or nothing) as if it were an object.
  let props = findTopLevelKey(text, 0, text.length, "properties");
  if (!props || text[props.valueStart] !== "{") {
    text = spliceObjectKey(text, 0, text.length, "properties", "{}");
    props = findTopLevelKey(text, 0, text.length, "properties");
  }
  if (!props) throw new Error("geojsonBoundary: failed to locate \"properties\" after insertion");
  return spliceObjectKey(text, props.valueStart, props.valueEnd, "type", JSON.stringify(typeValue));
}

function isJsonWs(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

// The one formatting pass every geo.json response body goes through
// EXACTLY ONCE, applied by buildGeojson.ts over the fully assembled
// FeatureCollection string (hand-built Point features and any spliced
// boundary features alike) -- see this file's header, point 2, for why
// both halves of what it does are real, verified requirements and not
// defensive over-engineering:
//   - every comma/colon OUTSIDE a string gets normalised to Python
//     json.dumps's default separators, `, ` / `: ` -- collapsing whatever
//     whitespace (none, or a multi-line indent) was already there;
//   - every STRING literal (key or value) is decoded and re-encoded via
//     pyJsonString, matching json.dumps's ensure_ascii=True.
//   - every NUMBER literal outside a string is re-emitted the way
//     json.dumps would print it (github #22).
//
// THE NUMBER CASE USED TO BE A PASS-THROUGH, and this comment used to state
// the opposite invariant: "every number literal ... is copied through
// character-for-character, never touched". That was safe for the numbers the
// port GENERATES (formatFloat already prints them CPython's way, so copying
// them through is a no-op) and wrong for the ones it SPLICES. A stored ONS
// boundary is the raw file line -- gfadmin assigns it verbatim and the
// pg-to-d1 extract copies it unmodified -- so its coordinates carry whatever
// spelling the ONS generator used, while Django json.loads/json.dumps the
// whole thing and re-prints every float through CPython's repr.
//
// Measured over the real 650 stored constituency features: 12 of them
// differ, carrying 16 non-canonical tokens between them, in two shapes --
// `-0.00006763445938537486`, which Python prints as `-6.763445938537486e-05`,
// and `-4.658355775837418e-7`, which Python prints with a two-digit exponent
// as `-4.658355775837418e-07`. Numerically identical, so no map moves; the
// cost is that geo.json is in PLAN.md's STRICT byte-equality corpus where
// "any difference fails the build".
//
// INTEGERS ARE STILL COPIED VERBATIM, deliberately: json.loads gives a
// Python int for a token with no `.`/`e`, and Python ints are arbitrary
// precision, so routing one through a double could lose digits a
// pass-through preserves. The single exception is a bare `-0`, which
// json.loads reads as the int 0 and json.dumps prints as `0`.
//
// NaN / Infinity / -Infinity are not matched and keep their pass-through,
// which is already what json.dumps does with them.
// JSON's own number grammar, which is narrower than JS's: no leading `+`,
// no leading zeros, no hex, no bare `.5`. Anything else is not a number
// token and falls through to the passes below untouched.
const NUMBER_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

// What json.dumps prints for one JSON number token.
function pythonNumberLiteral(token: string): string {
  // No `.`, `e` or `E` means json.loads produced an INT, and Python ints are
  // arbitrary precision -- 12345678901234567890 survives a round trip there
  // and would not survive a double here. So the digits are returned as they
  // came, with the one exception json.loads collapses: `-0` is the int 0.
  if (!/[.eE]/.test(token)) return token === "-0" ? "0" : token;
  // A float: formatFloat is already CPython's repr, exponent thresholds and
  // the e+16/e-05 two-digit spelling included (it is what the port's own
  // generated coordinates go through).
  return formatFloat(Number(token));
}

export function toDjangoJsonFormat(text: string): string {
  const out: string[] = [];
  let chunkStart = 0;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === '"') {
      if (i > chunkStart) out.push(text.slice(chunkStart, i));
      const end = skipString(text, i);
      const decoded = JSON.parse(text.slice(i, end)) as string;
      out.push(pyJsonString(decoded));
      i = end;
      chunkStart = i;
      continue;
    }
    // A number literal, outside a string. Matched from the current position
    // rather than scanned by hand so the token boundary is one regex rather
    // than four conditions -- and anchored with ^ on a slice, since a bare
    // `y` flag would carry state across the loop.
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const token = NUMBER_TOKEN.exec(text.slice(i))?.[0];
      if (token !== undefined) {
        if (i > chunkStart) out.push(text.slice(chunkStart, i));
        out.push(pythonNumberLiteral(token));
        i += token.length;
        chunkStart = i;
        continue;
      }
    }
    if (ch === "," || ch === ":") {
      out.push(text.slice(chunkStart, i + 1));
      let j = i + 1;
      while (j < n && isJsonWs(text.charCodeAt(j))) j++;
      out.push(" ");
      i = j;
      chunkStart = j;
      continue;
    }
    if (isJsonWs(text.charCodeAt(i))) {
      if (i > chunkStart) out.push(text.slice(chunkStart, i));
      let j = i + 1;
      while (j < n && isJsonWs(text.charCodeAt(j))) j++;
      i = j;
      chunkStart = j;
      continue;
    }
    i++;
  }
  if (chunkStart < n) out.push(text.slice(chunkStart));
  return out.join("");
}
