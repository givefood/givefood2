// Minimal gettext .po parser -- just enough for this repo's 3 catalogues
// (locale/{cy,ga,gd}/django.po, copied verbatim from the Django app's own
// locale/ directory): msgid/msgstr pairs, multi-line strings, C-style
// escapes. No msgid_plural/msgstr[n] (none of the 3 catalogues use plural
// forms -- verified by grep before writing this) and no per-entry #, fuzzy
// handling beyond "empty msgstr falls through to msgid", which is already
// gettext's own behaviour for an untranslated entry.
function unescapePoString(quoted: string): string {
  const inner = quoted.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      i++;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else out += next;
    } else {
      out += ch;
    }
  }
  return out;
}

// Consumes one or more consecutive `"..."` lines starting at `lines[i]`
// (i already pointing at the opening `keyword "..."` line) and returns the
// concatenated, unescaped string plus the index of the first line after it.
function readPoString(lines: string[], startIndex: number, firstLineValue: string): [string, number] {
  let value = unescapePoString(firstLineValue);
  let i = startIndex;
  while (i < lines.length && /^\s*"/.test(lines[i] ?? "")) {
    value += unescapePoString(lines[i]!.trim());
    i++;
  }
  return [value, i];
}

export function parsePoFile(contents: string): Record<string, string> {
  const lines = contents.split("\n");
  const catalogue: Record<string, string> = {};

  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] ?? "").trim();

    if (line.startsWith("msgid ")) {
      const [msgid, afterMsgid] = readPoString(lines, i + 1, line.slice("msgid ".length));
      i = afterMsgid;

      const msgstrLine = (lines[i] ?? "").trim();
      if (!msgstrLine.startsWith("msgstr ")) {
        // Shouldn't happen in a well-formed .po file; skip defensively
        // rather than throwing on a file this build doesn't control byte-
        // for-byte (it's copied from the Django app's own locale/, not
        // hand-authored here).
        continue;
      }
      const [msgstr, afterMsgstr] = readPoString(lines, i + 1, msgstrLine.slice("msgstr ".length));
      i = afterMsgstr;

      // msgid "" is the PO header (metadata in its msgstr), not a real
      // translatable entry -- and an empty msgstr means "untranslated",
      // which should fall through to the msgid at render time rather than
      // being stored as an empty-string translation.
      if (msgid.length > 0 && msgstr.length > 0) {
        catalogue[msgid] = msgstr;
      }
      continue;
    }

    i++;
  }

  return catalogue;
}
