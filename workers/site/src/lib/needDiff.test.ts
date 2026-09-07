import { describe, expect, it } from "vitest";
import { diffHtml } from "./needDiff";

// What these tests protect: the WP 6.4 need-detail page shows an admin four
// diff panels ("what changed since the last published need", "...since the
// last non-pertinent need", and the excess-items equivalents). The admin
// decides whether to publish a need based entirely on what those panels say,
// so a diff that silently drops, duplicates or misclassifies a line is a
// wrong-publish waiting to happen -- and because the template renders the
// result with `{{ diff | safe }}` (admin/need.njk:199-213), an escaping
// mistake here is stored XSS in the admin from scraped third-party page text.
//
// The Django ancestor is givefood/utils/text.py diff_html(), which is
// `difflib.unified_diff(a, b, n=999)` with the three header lines popped and
// `-`/`+` prefixes rewritten to <del>/<ins>. Every expectation below that
// claims "Django does X" was checked by running that function; where this
// port deliberately differs, the test says so and pins the port's behaviour.

// Splits a rendered diff back into its lines. The join separator is part of
// the contract (see the "<br>, never \n" test), so the helper hard-codes it:
// if someone changes the separator, these helpers stop working and the
// invariant tests fail loudly rather than quietly passing on the new shape.
// Splitting is only unambiguous because every line is escaped first -- see
// "an item containing a literal <br> cannot forge a line break".
function diffLines(html: string): string[] {
  return html === "" ? [] : html.split("<br>");
}

// Exact reverse of the module's escapeHtml, so a property test can compare
// rendered lines against the raw input it started from. Order matters and is
// the mirror of a single-pass escape: the entity-named characters first, `&`
// last, otherwise an item whose own text was "&lt;" would round-trip to "<".
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// An INDEPENDENT oracle for how many lines the two lists genuinely have in
// common. Deliberately a forward DP (dp[i][j] = LCS of the first i and first
// j entries), where the module builds its table backwards from the end -- so
// this is a second opinion rather than the implementation run twice. Used to
// assert MINIMALITY, which is the property the reconstruction check below
// cannot see: an implementation that struck through all of `a` and then added
// all of `b`, matching nothing ever, would satisfy "every line is accounted
// for" perfectly while rendering a useless panel.
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

// Checks the two properties an admin's decision rests on, for one pair:
//   1. Completeness -- reading the panel while ignoring the <ins> lines
//      reproduces the previous list exactly; ignoring the <del> lines
//      reproduces the new list exactly. Nothing invented, nothing lost.
//   2. Minimality -- exactly LCS-many lines are untagged. Without this a
//      "diff" that classifies nothing as unchanged still passes (1).
// Returns the parsed lines so callers can make extra assertions.
function assertFaithfulDiff(a: readonly string[], b: readonly string[]): string[] {
  const html = diffHtml(a, b);
  expect(html).not.toContain("\n");
  const lines = diffLines(html);
  const rebuiltA: string[] = [];
  const rebuiltB: string[] = [];
  let context = 0;
  for (const line of lines) {
    const removed = /^<del>([\s\S]*)<\/del>$/.exec(line);
    const added = /^<ins>([\s\S]*)<\/ins>$/.exec(line);
    if (removed) rebuiltA.push(unescapeHtml(removed[1]!));
    else if (added) rebuiltB.push(unescapeHtml(added[1]!));
    else {
      // A context line carries no tags at all -- if the walk ever emitted a
      // third shape this branch would push garbage and the compare would fail.
      expect(line).not.toMatch(/<\/?(?:del|ins)>/);
      rebuiltA.push(unescapeHtml(line));
      rebuiltB.push(unescapeHtml(line));
      context++;
    }
  }
  expect(rebuiltA).toEqual([...a]);
  expect(rebuiltB).toEqual([...b]);
  expect(context).toBe(lcsLength(a, b));
  expect(lines).toHaveLength(a.length + b.length - lcsLength(a, b));
  return lines;
}

// Deterministic PRNG (numerical-recipes LCG). The randomised property test
// below must never be flaky: a failure has to be reproducible from the seed
// printed in the test name, not a coin flip that goes away on re-run.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("diffHtml", () => {
  it("returns the empty string for identical lists, which is what renders 'No change'", () => {
    // Django's unified_diff yields NOTHING at all for equal sequences -- not
    // even context lines -- so diff_html returns "" and the template's
    // `{% if diff_from_pub %}` falls through to the "No change" box. This
    // port short-circuits to "" for the same reason. If it ever returned the
    // full unchanged list instead, every unchanged need would render a wall
    // of text where an admin expects a two-word "No change".
    expect(diffHtml(["Beans", "Pasta", "Rice"], ["Beans", "Pasta", "Rice"])).toBe("");
  });

  it("treats two empty lists as identical rather than tripping over the empty diff", () => {
    // Reached whenever a need and its predecessor both have no excess items.
    // The equality guard must fire here, not fall into the LCS walk (which
    // would also return "", but by accident rather than by contract).
    expect(diffHtml([], [])).toBe("");
    // The caller in routes/admin/needs.ts builds these lists with
    // `change_text.split("\n")`, and "".split("\n") is [""] in JS -- so a
    // pair of empty change_texts arrives here as [""] vs [""], not [] vs [].
    expect(diffHtml([""], [""])).toBe("");
  });

  it("compares the same array against itself without reporting a change", () => {
    // The caller hands `changeList` to two different diffHtml calls; a need
    // whose predecessor has byte-identical change_text can reach the guard
    // with literally the same array object on both sides. An identity
    // short-circuit is fine, but the guard must not, say, compare by
    // reference ONLY and then mis-handle equal-but-distinct arrays -- which
    // the test above already covers.
    const list = ["Beans", "Pasta"];
    expect(diffHtml(list, list)).toBe("");
  });

  it("tags an appended item and leaves the lines that survived untagged", () => {
    // The commonest real change: a food bank adds one item to the bottom of
    // its list. Django prints " Beans\n Pasta\n Rice\n<ins>Tea</ins>".
    expect(diffHtml(["Beans", "Pasta", "Rice"], ["Beans", "Pasta", "Rice", "Tea"])).toBe(
      "Beans<br>Pasta<br>Rice<br><ins>Tea</ins>",
    );
  });

  it("tags a removed item in place, keeping it visible between its neighbours", () => {
    // A removal has to stay where it was, not be listed at the end: the whole
    // point of the panel is showing the admin WHERE in the list something
    // went. Django prints " Beans\n<del>Pasta</del>\n Rice".
    expect(diffHtml(["Beans", "Pasta", "Rice"], ["Beans", "Rice"])).toBe("Beans<br><del>Pasta</del><br>Rice");
  });

  it("puts an inserted item at its own position, not at the end of the panel", () => {
    // The mirror of the removal test, and the case that exercises the OTHER
    // side of the LCS tie-break (`table[i+1][j] < table[i][j+1]`, so advance
    // `b`). An implementation that only ever drained insertions at the end
    // would still round-trip both lists and so still pass the completeness
    // property -- it would just tell the admin the new item went on the
    // bottom when it actually went in the middle.
    expect(diffHtml(["Beans", "Pasta"], ["Beans", "Rice", "Pasta"])).toBe("Beans<br><ins>Rice</ins><br>Pasta");
  });

  it("prints the removal before the addition when a line is replaced", () => {
    // difflib emits a 'replace' opcode as every deleted line first, then
    // every inserted line -- Django's output here is
    // " Beans\n<del>Pasta</del>\n<ins>Coffee</ins>\n Rice". The port
    // reproduces that ordering through the `>=` in its LCS tie-break, which
    // prefers advancing `a` (a deletion) when both directions are equally
    // good. Flip that to `>` and the panel reads <ins> before <del>, which
    // scans as "added Coffee, then dropped Pasta" -- a different story.
    expect(diffHtml(["Beans", "Pasta", "Rice"], ["Beans", "Coffee", "Rice"])).toBe(
      "Beans<br><del>Pasta</del><br><ins>Coffee</ins><br>Rice",
    );
  });

  it("groups a multi-line replacement as all removals then all additions, like a difflib hunk", () => {
    // The single-line replacement above cannot distinguish "dels before ins
    // within a block" from "dels and ins interleaved pairwise", because with
    // one of each the two orderings differ only by which comes first. Two
    // replaced lines can: difflib's replace opcode prints
    // " Beans\n<del>Pasta</del>\n<del>Rice</del>\n<ins>Coffee</ins>\n<ins>Tea</ins>\n Sugar",
    // and an interleaving walk would print del/ins/del/ins instead. Same set
    // of lines, but the panel would read as two separate swaps rather than
    // one block of the list being rewritten.
    expect(diffHtml(["Beans", "Pasta", "Rice", "Sugar"], ["Beans", "Coffee", "Tea", "Sugar"])).toBe(
      "Beans<br><del>Pasta</del><br><del>Rice</del><br><ins>Coffee</ins><br><ins>Tea</ins><br>Sugar",
    );
  });

  it("marks every line as added when there was no previous list", () => {
    // A food bank's first-ever need, or its first-ever excess list: the
    // previous need exists (so the caller does produce a diff) but its
    // excess_change_text is NULL and becomes [].
    expect(diffHtml([], ["Tea", "Coffee"])).toBe("<ins>Tea</ins><br><ins>Coffee</ins>");
  });

  it("marks every line as removed when the new list is empty", () => {
    // A food bank clearing its list entirely -- the admin needs to see all
    // of what went, not an empty panel that looks like "No change".
    expect(diffHtml(["Tea", "Coffee"], [])).toBe("<del>Tea</del><br><del>Coffee</del>");
  });

  it("shows an empty <del> for the [''] vs [] shape the caller actually produces", () => {
    // routes/admin/needs.ts builds one side with `.split("\n")` (so "" gives
    // [""]) and the other with a NULL check (so NULL gives []). An empty
    // previous excess list compared against an empty current one therefore
    // arrives as [""] vs [] and is NOT caught by the equality guard. Django
    // does exactly the same thing -- diff_html([""], []) is "<del></del>" --
    // so the resulting empty box is inherited behaviour, not a port bug.
    expect(diffHtml([""], [])).toBe("<del></del>");
    expect(diffHtml([], [""])).toBe("<ins></ins>");
  });

  it("renders a trailing newline in change_text as an empty struck-through line", () => {
    // Scrapers routinely leave a trailing newline, and "a\nb\n".split("\n")
    // is ["a","b",""] -- a phantom third item. Diffing a trailing-newline
    // change_text against one without gives the admin a blank <del> row at
    // the bottom of an otherwise unchanged panel. Ugly but harmless, and
    // pinned here so nobody "fixes" it by trimming inside diffHtml: the
    // trimming decision belongs to the caller, and Django doesn't trim
    // either.
    expect(diffHtml("Beans\nPasta\n".split("\n"), "Beans\nPasta".split("\n"))).toBe("Beans<br>Pasta<br><del></del>");
  });

  it("treats a CRLF-scraped list as entirely different from an LF one", () => {
    // change_text is stored raw and split on "\n" only, so a page scraped
    // with CRLF line endings yields lines ending in a stray "\r". Those are
    // not equal to their LF twins, so the panel shows the whole list replaced
    // -- a real "why does every item look changed?" support question. Pinned
    // as current behaviour: the fix, if wanted, is normalising newlines in
    // the scraper or the caller, not adding a trim here.
    expect(diffHtml("Beans\r\nPasta".split("\n"), "Beans\nPasta".split("\n"))).toBe(
      "<del>Beans\r</del><br><ins>Beans</ins><br>Pasta",
    );
  });

  it("escapes the item text while leaving its own <del>/<ins> tags intact", () => {
    // Need lists are SCRAPED from food bank websites, and the template
    // renders this with `| safe`. Django's diff_html does no escaping at all
    // (its template chains `|safe|linebreaksbr`), so a page containing a
    // <script> tag put it straight into the Django admin. This port escapes
    // per line, before wrapping -- the tags it adds itself must survive.
    expect(diffHtml(["<script>alert(1)</script>"], ["Tea & biscuits"])).toBe(
      "<del>&lt;script&gt;alert(1)&lt;/script&gt;</del><br><ins>Tea &amp; biscuits</ins>",
    );
  });

  it("escapes unchanged lines too, not only the tagged ones", () => {
    // Easy regression: wrap-and-escape in the <del>/<ins> branches but push
    // the context line raw. An unchanged item is just as attacker-controlled
    // as a changed one.
    const html = diffHtml(['Beans "value" pack', "Rice"], ['Beans "value" pack', "Pasta"]);
    expect(html).toBe("Beans &quot;value&quot; pack<br><del>Rice</del><br><ins>Pasta</ins>");
    expect(html).not.toContain('"value"');
  });

  it("escapes the full set of HTML-significant characters, apostrophes included", () => {
    // Attribute-context safety: the panel is inside a <p>, but food bank
    // names and item text carry apostrophes constantly ("Children's nappies")
    // and a half-done escape table is the kind of thing that gets copied
    // into a context where it matters.
    expect(diffHtml([], [`&<>"'`])).toBe("<ins>&amp;&lt;&gt;&quot;&#39;</ins>");
  });

  it("escapes & first so nothing is double-decoded, and escapes it again if already an entity", () => {
    // The escape is one regex pass, so a `&` produced BY the escape is never
    // reconsidered -- "<b>" becomes "&lt;b&gt;", not "&amp;lt;b&amp;gt;".
    // A two-pass or naive sequential implementation (replace "<" then "&")
    // gets exactly that wrong. The flip side, pinned in the second
    // assertion: input that is already an entity is escaped again, so a page
    // that literally contains "&amp;" shows as "&amp;" to the admin rather
    // than silently decoding to "&". Not idempotent, and it must not be:
    // idempotence here is how "&lt;script&gt;" sneaks back to being a tag.
    expect(diffHtml([], ["<b>"])).toBe("<ins>&lt;b&gt;</ins>");
    expect(diffHtml([], ["&amp; Tea"])).toBe("<ins>&amp;amp; Tea</ins>");
  });

  it("leaves characters outside the escape table exactly as they were", () => {
    // The table is deliberately the five HTML-significant characters. Over-
    // escaping (e.g. a stray backslash or slash rewrite) would corrupt item
    // text like "Tinned fish (in oil/brine)" in the panel, and under-escaping
    // is covered above. Pins the boundary of the table in both directions.
    expect(diffHtml([], ["Fish (in oil/brine) 50% \\ `x` = y"])).toBe("<ins>Fish (in oil/brine) 50% \\ `x` = y</ins>");
  });

  it("passes accents and astral-plane characters through byte-for-byte", () => {
    // Item text is scraped UTF-8: "Café", "Crème fraîche", and increasingly
    // emoji. escapeHtml's character class has no `u` flag, so a surrogate
    // pair must survive as a pair -- if the replace ever moved to a
    // codepoint-wise rewrite that split surrogates, the panel would render
    // replacement characters and the admin would see mojibake where an item
    // name should be.
    expect(diffHtml([], ["Nappies \u{1F476} Café crème"])).toBe("<ins>Nappies \u{1F476} Café crème</ins>");
  });

  it("compares lines by codepoint: no normalisation, no case folding, no locale", () => {
    // "café" written NFC (é as U+00E9) and NFD (e + U+0301) look identical in
    // the panel but are different strings, exactly as Python's `str` equality
    // sees them inside difflib -- so a scraper switching normalisation form
    // makes the whole list look replaced. Pinned because the "fix" of
    // normalising or lowercasing inside diffHtml would be a silent divergence
    // from Django, and would also make two genuinely different items compare
    // equal in the other direction.
    // Derived rather than written as two literals: an editor or a git filter
    // that normalised this source file would otherwise silently turn the pair
    // into the same string and the test would pass for the wrong reason. The
    // length assertions make that vacuous case impossible -- four codepoints
    // against five.
    const nfc = "caf\u00E9".normalize("NFC");
    const nfd = nfc.normalize("NFD");
    expect(nfc).toHaveLength(4);
    expect(nfd).toHaveLength(5);
    expect(nfc).not.toBe(nfd);
    expect(diffHtml([nfc], [nfd])).toBe(`<del>${nfc}</del><br><ins>${nfd}</ins>`);

    // Case matters too, for the same reason: a case-insensitive compare would
    // hide a real edit behind a "No change" panel, and it is exactly the kind
    // of leniency someone adds to stop a re-titled list looking wholly
    // rewritten. Django compares Python strings, which are case-sensitive.
    expect(diffHtml(["Baby Milk"], ["baby milk"])).toBe("<del>Baby Milk</del><br><ins>baby milk</ins>");
    expect(diffHtml(["Beans", "TEA"], ["Beans", "tea"])).toBe("Beans<br><del>TEA</del><br><ins>tea</ins>");
  });

  it("joins on <br>, never on a newline", () => {
    // This is the port's one deliberate structural divergence and the module
    // comment explains it: Django joins on "\n" and lets the template's
    // `|safe|linebreaksbr` convert, which works only because Django's
    // linebreaksbr skips re-escaping SafeData. This port's linebreaksbr
    // (packages/templates/src/filters.ts:219) escapes unconditionally, so it
    // would turn the <del> tags built here into &lt;del&gt;. Joining here
    // and rendering with plain `| safe` is what keeps the tags real.
    // Asserted as the exact string, not just "contains <br>": a hybrid that
    // emitted "\n<br>" or wrapped each line in its own <br> would pass a
    // containment check while doubling every gap in the panel.
    const html = diffHtml(["Beans", "Pasta"], ["Beans", "Rice"]);
    expect(html).toBe("Beans<br><del>Pasta</del><br><ins>Rice</ins>");
    expect(html).not.toContain("\n");
  });

  it("makes an item containing a literal <br> unable to forge a line break", () => {
    // The <br> join and the escaping are load-bearing on each other: because
    // every line is escaped BEFORE it is joined, a scraped item that itself
    // reads "Beans <br> Pasta" renders as one panel line with visible
    // "&lt;br&gt;", not as two. Drop the escaping of `<`/`>` and a food bank
    // page could inject extra rows into the admin's diff -- and this file's
    // own diffLines() helper would start mis-parsing too.
    const html = diffHtml(["Beans <br> Pasta"], ["Rice"]);
    expect(html).toBe("<del>Beans &lt;br&gt; Pasta</del><br><ins>Rice</ins>");
    expect(diffLines(html)).toHaveLength(2);
  });

  it("drops Django's leading context space on unchanged lines", () => {
    // unified_diff prefixes unchanged lines with a single space, and Django's
    // diff_html strips that prefix only from "-"/"+" lines -- so its context
    // lines really are " Beans". The port emits the bare line. Documented
    // divergence, invisible in rendered HTML, pinned so a "restore Django
    // fidelity" change has to be a deliberate one. Asserted as the exact
    // string as well as the no-leading-space property, because the property
    // alone holds for any output that happens not to start with a space.
    const html = diffHtml(["Beans", "Pasta"], ["Beans"]);
    expect(html).toBe("Beans<br><del>Pasta</del>");
    for (const line of diffLines(html)) {
      expect(line.startsWith(" ")).toBe(false);
    }
  });

  it("keeps leading whitespace that belongs to the item itself", () => {
    // The companion to the test above: "no leading space" is a fact about the
    // diff FORMAT, not a promise to trim item text. Indented continuation
    // lines are common in scraped lists ("Baby food\n  Stage 1"), and a naive
    // implementation of the Django-parity note -- strip a leading space from
    // every line -- would quietly eat one level of that indentation and make
    // two genuinely different lists look the same.
    expect(diffHtml([], [" Beans"])).toBe("<ins> Beans</ins>");
    expect(diffHtml(["Beans"], ["Beans", " "])).toBe("Beans<br><ins> </ins>");
  });

  it("preserves trailing whitespace that Django would have stripped", () => {
    // Django rstrips the content of every <del>/<ins> line, so it renders
    // diff_html(["Soup  "], ["Soup"]) as "<del>Soup</del>\n<ins>Soup</ins>":
    // two lines that look identical. The port keeps the spaces, which is
    // arguably more honest about why the two lines differ at all. Either way
    // HTML collapses the run, so this is cosmetic -- pinned as current
    // behaviour, not asserted as the better choice.
    expect(diffHtml(["Soup  "], ["Soup"])).toBe("<del>Soup  </del><br><ins>Soup</ins>");
  });

  it("handles duplicate items without collapsing them", () => {
    // Scraped lists repeat themselves constantly ("Tinned tomatoes" under two
    // headings). A diff that deduplicated would under-report a removal: here
    // one of the two copies goes and the other stays, so the panel still has
    // three lines. This walk takes the equality branch as soon as it can and
    // so strikes through the SECOND copy; Django strikes through the first
    // ("<del>Beans</del>\n Beans\n Rice"). Identical text either way, so the
    // rendered panel is indistinguishable -- pinned as current behaviour.
    expect(diffHtml(["Beans", "Beans", "Rice"], ["Beans", "Rice"])).toBe("Beans<br><del>Beans</del><br>Rice");
  });

  it("picks a different anchor line than difflib does on a pure reordering", () => {
    // The module comment scopes its "an LCS diff and SequenceMatcher agree"
    // claim to the mostly-append/mostly-remove lists a shopping list actually
    // produces. A straight swap is outside that scope and the two disagree:
    // difflib anchors on "a" ("<ins>b</ins>\n a\n<del>b</del>"), this LCS
    // walk anchors on "b". Both are minimal -- one unchanged, one removed,
    // one added -- and both read correctly to an admin. Pinned so the
    // divergence is a known, tested fact rather than a surprise.
    expect(diffHtml(["a", "b"], ["b", "a"])).toBe("<del>a</del><br>b<br><ins>a</ins>");
  });

  it("never mutates the lists it was given", () => {
    // routes/admin/needs.ts passes the SAME `changeList` array into two
    // separate diffHtml calls (diff_from_pub and diff_from_nonpert). If this
    // function sorted or spliced its inputs, the second panel would be diffed
    // against a list the first one had already chewed up. Frozen rather than
    // merely compared afterwards: this module is ESM and therefore strict, so
    // any in-place write throws here instead of being tidied up before the
    // function returns and slipping past a toEqual.
    const previous = Object.freeze(["Beans", "Pasta", "Rice"]);
    const current = Object.freeze(["Beans", "Rice", "Tea"]);
    expect(() => {
      diffHtml(previous, current);
      diffHtml(previous, current);
    }).not.toThrow();
    expect(previous).toEqual(["Beans", "Pasta", "Rice"]);
    expect(current).toEqual(["Beans", "Rice", "Tea"]);
  });

  it("is stable: the same pair of lists always renders the same panel", () => {
    // The four panels are rendered from overlapping inputs in one request,
    // and the LCS table is rebuilt for each. Any dependence on shared state
    // between calls would show up as a second answer here that differs from
    // the first -- so the known-good value is asserted too, otherwise a
    // function that returned the same wrong string twice would pass.
    const expected = "Beans<br><del>Pasta</del><br><ins>Rice</ins>";
    const first = diffHtml(["Beans", "Pasta"], ["Beans", "Rice"]);
    const second = diffHtml(["Beans", "Pasta"], ["Beans", "Rice"]);
    expect(first).toBe(expected);
    expect(second).toBe(expected);
  });

  it("accounts for every line of both lists, in order, and matches everything it can", () => {
    // The invariant an admin's decision rests on: nothing is invented,
    // nothing is lost, and nothing that could have been shown as unchanged is
    // struck through instead. Checked across every ordered pair of these
    // fixtures -- appends, removals, replacements, reorderings, empty sides,
    // duplicates and HTML-significant text -- because a subtle off-by-one in
    // the LCS table indices can produce output that still LOOKS like a
    // plausible diff. assertFaithfulDiff() checks the count of untagged lines
    // against an independent LCS oracle, which is what stops a degenerate
    // "delete everything, then add everything" implementation from passing.
    const fixtures: string[][] = [
      [],
      [""],
      ["Beans"],
      ["Beans", "Pasta"],
      ["Beans", "Pasta", "Rice"],
      ["Beans", "Rice"],
      ["Rice", "Beans"],
      ["Coffee", "Tea"],
      ["Beans", "Beans", "Rice"],
      ["Beans", "Pasta", "Rice", "Tea", "Coffee"],
      ["<b>Beans</b>", "Tea & coffee", "Café"],
    ];
    for (const a of fixtures) {
      for (const b of fixtures) {
        if (a.length === b.length && a.every((line, i) => line === b[i])) {
          // Identical inputs render "" by design; reconstruction cannot tell
          // that apart from "both lists were empty", so the dedicated
          // equality tests above cover this case instead.
          expect(diffHtml(a, b)).toBe("");
          continue;
        }
        assertFaithfulDiff(a, b);
      }
    }
  });

  it("stays faithful and minimal on hundreds of pseudo-random list pairs", () => {
    // Hand-picked fixtures encode the author's idea of what can go wrong. The
    // LCS walk's failure mode is an index off by one in a case nobody thought
    // of -- long common runs, alternating blocks, one side empty, repeated
    // items with different neighbours. Deterministic seed, so a failure is
    // reproducible rather than a flake. The alphabet includes HTML-
    // significant text and an empty line so escaping and the <br> join are
    // exercised by the round-trip too, not just by the targeted tests.
    const alphabet = ["Beans", "Pasta", "Rice", "Tea", "Coffee & cream", "<b>Nappies</b>", 'Soup "value"', "Café", "Item <br> two", ""];
    const random = makeRandom(20240612);
    for (let trial = 0; trial < 400; trial++) {
      const build = (): string[] => {
        const length = Math.floor(random() * 9);
        return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]!);
      };
      const a = build();
      const b = build();
      if (a.length === b.length && a.every((line, i) => line === b[i])) {
        expect(diffHtml(a, b)).toBe("");
        continue;
      }
      assertFaithfulDiff(a, b);
    }
  });

  it("keeps a long unchanged list untagged instead of hunking it", () => {
    // Django passes n=999 to unified_diff precisely so that the context
    // window is larger than any real shopping list and the output is never
    // broken into @@ hunks with elided middles. This port has no hunking at
    // all, but the observable promise is the same: with one change buried in
    // a 60-item list, all 60 surrounding lines are still present.
    const previous = Array.from({ length: 60 }, (_, i) => `Item ${i}`);
    const current = previous.filter((_, i) => i !== 30);
    const lines = diffLines(diffHtml(previous, current));
    expect(lines).toHaveLength(60);
    expect(lines.filter((line) => line.startsWith("<del>"))).toEqual(["<del>Item 30</del>"]);
    expect(lines).not.toContain("@@");
    // The removal has to appear at position 30, not shunted to the end: an
    // admin scanning a 60-line panel navigates by position.
    expect(lines[30]).toBe("<del>Item 30</del>");
  });

  it("survives a pathologically long pair of lists without truncating or blowing up", () => {
    // The LCS table is O(len(a) x len(b)) numbers, allocated eagerly. A
    // 400-item list is far past any real need but well within what a broken
    // scraper can produce from a page of navigation junk, and the panel must
    // still be complete rather than truncated, recursion-blown or hung.
    const previous = Array.from({ length: 400 }, (_, i) => `Item ${i}`);
    const current = previous.map((line, i) => (i === 200 ? "Replaced" : line));
    const lines = assertFaithfulDiff(previous, current);
    expect(lines).toHaveLength(401);
    expect(lines[200]).toBe("<del>Item 200</del>");
    expect(lines[201]).toBe("<ins>Replaced</ins>");

    // Two long lists with nothing in common exercise both drain loops at
    // scale: every removal first, then every addition.
    const disjointLines = diffLines(diffHtml(previous, Array.from({ length: 300 }, (_, i) => `Other ${i}`)));
    expect(disjointLines).toHaveLength(700);
    expect(disjointLines[399]).toBe("<del>Item 399</del>");
    expect(disjointLines[400]).toBe("<ins>Other 0</ins>");
  });

  it("diffs two entirely different lists as a full removal then a full addition", () => {
    // Nothing in common means an empty LCS: the walk has to fall out of the
    // main loop and drain both tails. With the `>=` tie-break every deletion
    // is emitted first, so the panel reads as the old list struck through
    // above the new one.
    expect(diffHtml(["Beans", "Pasta"], ["Tea", "Coffee"])).toBe(
      "<del>Beans</del><br><del>Pasta</del><br><ins>Tea</ins><br><ins>Coffee</ins>",
    );
  });

  it("reports 'No change' for equal-length lists whose difference sits in an array hole", () => {
    // SUSPECTED BUG, pinned as current behaviour rather than fixed. The
    // equality guard is `a.length === b.length && a.every(...)`, and
    // Array.prototype.every SKIPS holes in a sparse array -- so a sparse `a`
    // matches any `b` at the hole's index and the function returns "", which
    // the template renders as "No change" for two lists that differ. It is
    // not reachable from routes/admin/needs.ts, whose lists always come from
    // String.prototype.split (never sparse) or a NULL check, which is why
    // this is documented rather than treated as live. Any future caller that
    // builds a list by assigning into an empty array by index would hit it.
    const sparse: string[] = [];
    sparse[1] = "Rice";
    expect(sparse).toHaveLength(2);
    expect(diffHtml(sparse, ["Beans", "Rice"])).toBe("");
    // The same pair with the hole filled in is correctly reported as changed,
    // which is what makes the line above a hole-handling defect rather than
    // an equality-semantics choice.
    expect(diffHtml(["Pasta", "Rice"], ["Beans", "Rice"])).toBe("<del>Pasta</del><br><ins>Beans</ins><br>Rice");
  });
});
