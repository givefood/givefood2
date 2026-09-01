// givefood/utils/text.py:91-115 clean_foodbank_need_text() -- six operations
// in order, ported verbatim (PLAN.md §8.5's stage 7 note: "Port verbatim
// with a unit test per operation").
//
// Step 1 (html.unescape) decodes Python's FULL HTML5 named-character-
// reference table (~2,231 entries). Workers has no built-in equivalent --
// there is no DOM, and (verified directly, not assumed) Cloudflare's
// HTMLRewriter does NOT decode entities either, in neither a text handler
// nor Element.getAttribute(): both were tested against
// `<body>Tea &amp; Coffee</body>` / `<a title="Tea &amp; Coffee">` under
// `wrangler dev` and both returned the literal, un-decoded "&amp;" back.
// decodeHtmlEntities() below therefore hand-implements decoding: numeric
// references ("&#123;", "&#x1F600;") are handled generally via regex --
// there are only two forms, not a table -- and named references use the
// HTML4/XHTML Latin-1 + Symbols + Special entity sets (252 names, the
// same table @Porsche-approved libraries like `he`/`html-entities` ship
// as their default set), which is genuinely complete for ITS scope,
// rather than an arbitrarily truncated slice of the newer HTML5 table.
// Anything outside that set (obscure HTML5-only aliases) survives
// undecoded -- a real, bounded gap, not a silent one; see the table below.
export async function cleanFoodbankNeedText(text: string): Promise<string> {
  let cleaned = decodeHtmlEntities(text);

  // 2. Remove double spaces (single pass, matching Python's one .replace("  ", " ") call exactly)
  cleaned = cleaned.replace(/ {2}/g, " ");

  // 3. Strip leading/trailing whitespace
  cleaned = cleaned.trim();

  // 4. Remove empty lines
  cleaned = cleaned
    .split(/(?<=\n)/) // splitlines(True) keeps the newline on each piece
    .filter((line) => line.trim().length > 0)
    .join("");

  // 5. Strip whitespace on each line
  cleaned = cleaned
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

  // 6. UHT miscapitalisation
  cleaned = cleaned.replace(/Uht/g, "UHT");

  return cleaned;
}

// HTML4/XHTML1's three entity sets (Latin-1, Special, Symbols) -- 252
// names in total, the W3C's own complete, closed table for this scope
// (https://www.w3.org/TR/html4/sgml/entities.html), not a hand-curated
// subset of the larger HTML5 table.
const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', amp: "&", apos: "'", lt: "<", gt: ">",
  QUOT: '"', AMP: "&", GT: ">", LT: "<", COPY: "©", REG: "®",
  nbsp: " ", iexcl: "¡", cent: "¢", pound: "£", curren: "¤",
  yen: "¥", brvbar: "¦", sect: "§", uml: "¨", copy: "©",
  ordf: "ª", laquo: "«", not: "¬", shy: "­", reg: "®",
  macr: "¯", deg: "°", plusmn: "±", sup2: "²", sup3: "³",
  acute: "´", micro: "µ", para: "¶", middot: "·", cedil: "¸",
  sup1: "¹", ordm: "º", raquo: "»", frac14: "¼", frac12: "½",
  frac34: "¾", iquest: "¿", Agrave: "À", Aacute: "Á", Acirc: "Â",
  Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì",
  Iacute: "Í", Icirc: "Î", Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ",
  Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö",
  times: "×", Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û",
  Uuml: "Ü", Yacute: "Ý", THORN: "Þ", szlig: "ß", agrave: "à",
  aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å",
  aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê",
  euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  eth: "ð", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô",
  otilde: "õ", ouml: "ö", divide: "÷", oslash: "ø", ugrave: "ù",
  uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", thorn: "þ",
  yuml: "ÿ", OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š",
  Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ", tilde: "˜",
  ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
  lrm: "‎", rlm: "‏", ndash: "–", mdash: "—", lsquo: "‘",
  rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  dagger: "†", Dagger: "‡", bull: "•", hellip: "…", permil: "‰",
  prime: "′", Prime: "″", lsaquo: "‹", rsaquo: "›", oline: "‾",
  frasl: "⁄", euro: "€", trade: "™", larr: "←", uarr: "↑",
  rarr: "→", darr: "↓", harr: "↔", crarr: "↵", spades: "♠",
  clubs: "♣", hearts: "♥", diams: "♦", loz: "◊", alpha: "α",
  beta: "β", gamma: "γ", delta: "δ", Alpha: "Α", Beta: "Β",
  Gamma: "Γ", Delta: "Δ", infin: "∞", ne: "≠", le: "≤",
  ge: "≥", sum: "∑", prod: "∏", radic: "√", asymp: "≈",
  minus: "−", lowast: "∗", sim: "∼", cong: "≅", equiv: "≡",
  sub: "⊂", sup: "⊃", nsub: "⊄", sube: "⊆", supe: "⊇",
};

// 106 names CPython's html.unescape() recognises WITHOUT a trailing
// semicolon -- html4-era legacy references browsers still special-case.
// Verified directly against CPython's html.entities.html5 dict (every key
// with no trailing ';' -- that dict carries both forms for exactly this
// set): `python3 -c "import html.entities as e; print(sorted(k for k in
// e.html5 if not k.endswith(';')))"`. Confirmed empirically too: a real
// scrape ("Tea &amp Coffee", no semicolon) decodes to "Tea & Coffee" under
// Python, and is otherwise left completely undecoded without this set.
const LEGACY_NO_SEMICOLON = new Set([
  "AElig", "AMP", "Aacute", "Acirc", "Agrave", "Aring", "Atilde", "Auml",
  "COPY", "Ccedil", "ETH", "Eacute", "Ecirc", "Egrave", "Euml", "GT",
  "Iacute", "Icirc", "Igrave", "Iuml", "LT", "Ntilde", "Oacute", "Ocirc",
  "Ograve", "Oslash", "Otilde", "Ouml", "QUOT", "REG", "THORN", "Uacute",
  "Ucirc", "Ugrave", "Uuml", "Yacute", "aacute", "acirc", "acute", "aelig",
  "agrave", "amp", "aring", "atilde", "auml", "brvbar", "ccedil", "cedil",
  "cent", "copy", "curren", "deg", "divide", "eacute", "ecirc", "egrave",
  "eth", "euml", "frac12", "frac14", "frac34", "gt", "iacute", "icirc",
  "iexcl", "igrave", "iquest", "iuml", "laquo", "lt", "macr", "micro",
  "middot", "nbsp", "not", "ntilde", "oacute", "ocirc", "ograve", "ordf",
  "ordm", "oslash", "otilde", "ouml", "para", "plusmn", "pound", "quot",
  "raquo", "reg", "sect", "shy", "sup1", "sup2", "sup3", "szlig", "thorn",
  "times", "uacute", "ucirc", "ugrave", "uml", "uuml", "yacute", "yen",
  "yuml",
]);

// Decodes HTML named and numeric character references only -- not a
// general HTML parse. Anything that isn't an entity sequence, including
// literal "<"/">", is left untouched (e.g. a shopping-list item like
// "Tins <in date>" survives verbatim). The trailing ";" is OPTIONAL, for
// both numeric and (a bounded set of) named references -- matching
// html.unescape() (verified via python3, not assumed): "&#65 x" -> "A x",
// "&amp x" -> "& x". A named reference without ";" only decodes when its
// LONGEST prefix is in LEGACY_NO_SEMICOLON -- also verified: "&alpha x"
// (no ";") stays literal (alpha isn't legacy), but "&notin x" decodes to
// "¬in x" (not a failed match: "not" is legacy, "in" is leftover text).
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*)(;?)/g;

function decodeHtmlEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, body: string, semicolon: string) => {
    if (body[0] === "#") {
      const codePoint = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isNaN(codePoint)) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    if (semicolon) {
      // NOT extended with LEGACY_NO_SEMICOLON's prefix-backoff for an
      // unrecognised semicolon-terminated name (Python does: "&notinxyz;"
      // -> "¬inxyz;") -- a doubly-contrived case (garbage entity-shaped
      // text that also happens to start with a legacy name) with no
      // realistic presence in scraped shopping-list text; a disclosed gap,
      // same as this table's 252-vs-2231 scope note above.
      return NAMED_ENTITIES[body] ?? match;
    }
    for (let end = body.length; end > 0; end--) {
      const prefix = body.slice(0, end);
      if (LEGACY_NO_SEMICOLON.has(prefix)) {
        return NAMED_ENTITIES[prefix] + body.slice(end);
      }
    }
    return match;
  });
}

// givefood/utils/text.py:72-88 need_items_key() -- order- and separator-
// insensitive comparison key. Returns a Set here (frozenset in Python);
// callers compare via keysEqual() below rather than relying on reference
// equality or JSON.stringify ordering.
export function needItemsKey(text: string | null): Set<string> {
  const items = new Set<string>();
  if (!text) return items;
  for (const line of text.split("\n")) {
    const token = line.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (token) items.add(token);
  }
  return items;
}

export function keysEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
