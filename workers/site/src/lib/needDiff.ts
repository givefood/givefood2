// givefood/utils/text.py:46-61 diff_html() -- WP 6.4's need-detail "diff
// from the previous published/non-pertinent need" panels. Django builds
// this on `difflib.unified_diff(a, b, n=999)`: a context window bigger
// than any real shopping list, so in practice it's "every line, in order,
// tagged unchanged/removed/added" rather than a hunked diff -- and when
// the two lists are identical, unified_diff yields nothing at all (no
// lines, not even context), which is what lets the template's `{% if
// diff_from_pub %}` fall through to "No change". This is a line-based
// LCS diff, not a port of Python's difflib.SequenceMatcher algorithm
// itself (no equivalent exists in the JS standard library) -- for the
// short, mostly-append/mostly-remove lists a shopping-list diff actually
// produces, an LCS diff and SequenceMatcher agree on the same
// unchanged/removed/added classification.
function longestCommonSubsequenceTable(a: readonly string[], b: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

// Returns "" when `a` and `b` are the same sequence (nothing to show),
// otherwise every line of `b` merged with `a`'s removed lines, in order,
// `<del>`-wrapped for a line only `a` has and `<ins>`-wrapped for a line
// only `b` has -- `<br>`-joined, not `\n`-joined: Django's own
// `{{ diff|safe|linebreaksbr }}` only gets away with joining on `\n` and
// converting at render time because Django's `linebreaksbr` filter checks
// whether its input is already-marked-safe (SafeData) and skips
// re-escaping when it is; this port's `linebreaksbr` (filters.ts) has no
// such check and would re-escape the `<del>`/`<ins>` tags built above.
// Doing the `<br>` join here, once, keeps this function the only place
// that needs to know that -- callers just do `{{ diff | safe }}`.
export function diffHtml(a: readonly string[], b: readonly string[]): string {
  if (a.length === b.length && a.every((line, i) => line === b[i])) return "";

  const table = longestCommonSubsequenceTable(a, b);
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(escapeHtml(a[i]!));
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push(`<del>${escapeHtml(a[i]!)}</del>`);
      i++;
    } else {
      lines.push(`<ins>${escapeHtml(b[j]!)}</ins>`);
      j++;
    }
  }
  while (i < a.length) {
    lines.push(`<del>${escapeHtml(a[i]!)}</del>`);
    i++;
  }
  while (j < b.length) {
    lines.push(`<ins>${escapeHtml(b[j]!)}</ins>`);
    j++;
  }
  return lines.join("<br>");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
