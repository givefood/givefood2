import { describe, expect, it } from "vitest";
import { inputMethodEmoji, inputMethodHuman } from "./needAdminDisplay";

// The whole vocabulary the input_method column is allowed to hold, copied
// from givefood/const/general.py:23-28 (NEED_INPUT_TYPES, wired into the
// model as choices= at needs.py:74). Written out here rather than imported
// from the module under test so that these tests compare the port against
// the DJANGO source, not against itself -- if someone deletes a branch from
// either lookup table, the coverage test below fails instead of quietly
// agreeing with the new, smaller table.
//
// Worth knowing while reading the rest of this file: 0001_core.sql:120
// declares `input_method TEXT NOT NULL` with no CHECK constraint, so the
// four values below are a convention enforced by the writers (needcheck.ts
// writes 'ai' as a SQL literal, needAdminExtras.ts hardcodes "typed" because
// NeedForm excludes distill_id), not by SQLite. Values outside the list are
// therefore reachable in principle, which is why the fallback behaviour of
// both functions is pinned as carefully as the happy path.
const DJANGO_INPUT_METHODS = ["scrape", "user", "typed", "ai"] as const;

// Tokens that are NOT in that vocabulary. These are the shapes a bad row
// actually takes: a half-finished feature branch's new method, a value typed
// with the wrong case, one with stray whitespace, and the empty string an
// incomplete insert leaves behind. Both functions are probed against the
// whole list in both directions, so an extra key added to ONE table is
// caught by the parity test rather than surfacing as a lopsided admin row.
//
// Deliberately contains no Object.prototype member name -- those behave
// differently and get their own describe block at the bottom of this file.
const NON_DJANGO_TOKENS = ["distill", "volunteer", "import", "csv", "Scrape", "AI", "ai ", " ai", ""];

describe("inputMethodHuman", () => {
  it("reproduces Django's four labels exactly", () => {
    // givefood/models/needs.py:113-122. These are the only words in the
    // admin that say where a need came from -- "AI" next to a need means an
    // LLM extracted it from a scraped page and nobody has checked it, which
    // is the whole reason the column is shown at need.njk:21. A label that
    // silently changed case ("Ai") or wording ("Robot") would make the
    // needs list disagree with a decade of Django screenshots and notes.
    expect(inputMethodHuman("scrape")).toBe("Scraped");
    expect(inputMethodHuman("typed")).toBe("Typed");
    expect(inputMethodHuman("user")).toBe("User");
    expect(inputMethodHuman("ai")).toBe("AI");
  });

  it("has a distinct label for every value the Django model allows", () => {
    // Guards the case where a new input method is added to the schema and
    // only half the port is updated: an unmapped value falls through to the
    // raw token, so "scrape" would render as the lowercase "scrape".
    for (const method of DJANGO_INPUT_METHODS) {
      expect(inputMethodHuman(method)).not.toBe(method);
    }
    // And no two methods may share a label. need.njk:21 prints this word as
    // the only prose describing a need's origin, so "Scraped" appearing for
    // both scrape and ai would hide exactly the distinction ("has a human
    // checked this?") the admin reads that line to answer.
    const labels = DJANGO_INPUT_METHODS.map(inputMethodHuman);
    expect(new Set(labels).size).toBe(DJANGO_INPUT_METHODS.length);
  });

  it("returns the raw token for an unknown method, where Django returned None", () => {
    // A DELIBERATE DIVERGENCE, and the reason this test exists. Django's
    // input_method_human() is a chain of `if`s with no else, so it falls off
    // the end and returns None -- which `{{ need.input_method_human }}`
    // renders as the literal word "None" (verified against Django's template
    // engine, which str()s the value). The port shows the stored token
    // instead, so an admin looking at an unexpected value can see WHAT it
    // was. Nobody should "restore Django parity" by turning this back into
    // an empty string or the word None.
    expect(inputMethodHuman("distill")).toBe("distill");
    expect(inputMethodHuman("volunteer")).toBe("volunteer");
  });

  it("matches on the exact stored token, so casing and whitespace do not", () => {
    // Django compares with `==` against lowercase literals; a row written as
    // "Scrape" or with a stray space is not the same input method and must
    // not be labelled as one. Because of the fallback above, the odd value
    // is displayed verbatim -- which is the signal that the data is wrong.
    // A lenient rewrite (.trim(), .toLowerCase(), or a substring/startsWith
    // match) would pass every other test in this file and fail here.
    expect(inputMethodHuman("Scrape")).toBe("Scrape");
    expect(inputMethodHuman("SCRAPE")).toBe("SCRAPE");
    expect(inputMethodHuman(" typed")).toBe(" typed");
    expect(inputMethodHuman("typed ")).toBe("typed ");
    expect(inputMethodHuman("typedx")).toBe("typedx");
  });

  it("hands the token back unescaped, which is why its template must NOT use | safe", () => {
    // The counterpart to inputMethodEmoji's "never echoes its input" test,
    // and the reason that one can be strict while this one cannot. This
    // function DOES echo, verbatim: no entity encoding, no stripping. That is
    // safe today only because nunjucks auto-escapes it, and need.njk:21
    // prints `{{ need.input_method_emoji | safe }} {{ need.input_method_human }}`
    // -- the emoji half filtered, the label half deliberately not. Copying
    // the `| safe` across that line (the easiest edit to make there, since
    // the two values sit inside one <dd>) turns a bad input_method row into
    // stored HTML in the admin. Pinning the RAW value here makes the label's
    // dependence on auto-escaping explicit instead of accidental.
    expect(inputMethodHuman("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
    expect(inputMethodHuman('"><img src=x onerror=alert(1)>')).toBe('"><img src=x onerror=alert(1)>');
    // Specifically not "&lt;b&gt;": a well-meaning escapeHtml() in the
    // fallback would be double-escaped by nunjucks and print the entities
    // themselves on the page.
    expect(inputMethodHuman("<b>")).toBe("<b>");
  });

  it("passes empty string straight through rather than inventing a label", () => {
    // The column is NOT NULL but not non-empty: an empty string is what a
    // half-written insert leaves behind. Rendering nothing is right here --
    // the icon column next to it is empty too, so the row reads as "unknown
    // origin" rather than mislabelling itself as typed.
    expect(inputMethodHuman("")).toBe("");
  });
});

describe("inputMethodEmoji", () => {
  it("returns Material Design Icons markup, not unicode emoji", () => {
    // givefood/models/needs.py:124-132, and the module's own warning: the
    // name says emoji but the values are MDI webfont spans, loaded by
    // admin/page.njk:7. Every consumer renders them unescaped -- through
    // `| safe` at need.njk:21, needtable.njk:13, foodbank_detail.njk:279,
    // needsorders.njk:23 and need_translations.njk:19, and straight into a
    // raw HTML cell at admin/lists.ts:692. The exact class names are
    // load-bearing: a typo in "mdi-spider" renders as a blank box, not as a
    // visible error, so these are asserted byte for byte against the Django
    // source. Swapping them back to real emoji -- the "simplification" the
    // module comment explicitly forbids -- fails here too.
    expect(inputMethodEmoji("scrape")).toBe('<span class="mdi mdi-spider"></span>');
    expect(inputMethodEmoji("typed")).toBe('<span class="mdi mdi-keyboard"></span>');
    expect(inputMethodEmoji("user")).toBe('<span class="mdi mdi-account"></span>');
    expect(inputMethodEmoji("ai")).toBe('<span class="mdi mdi-robot"></span>');
  });

  it("gives every allowed input method an icon, and each a different one", () => {
    // The icon is the ONLY origin indicator in the needs table
    // (needtable.njk:13 shows the icon with no text beside it), so two
    // methods sharing a glyph would make scraped and AI-extracted needs
    // indistinguishable at a glance -- the exact distinction an admin is
    // scanning that column for.
    const icons = DJANGO_INPUT_METHODS.map((method) => inputMethodEmoji(method));
    for (const [i, method] of DJANGO_INPUT_METHODS.entries()) {
      // Asserted per method rather than with icons.every(icon => icon !== ""):
      // an implementation that dropped its `?? ""` and returned undefined for
      // a missing key satisfies `!== ""`, and an .every() failure names
      // neither the method that lost its icon nor what came back instead.
      expect(typeof icons[i], `${method} did not produce a string`).toBe("string");
      expect(icons[i], `${method} has no icon`).not.toBe("");
    }
    expect(new Set(icons).size).toBe(DJANGO_INPUT_METHODS.length);
  });

  it("stays in step with inputMethodHuman in both directions", () => {
    // need.njk:21 and need_translations.njk:19 print the icon and the label
    // side by side. The two tables must agree on their key set, or that line
    // renders as a bare word with no icon (key missing from the icon table)
    // or an icon beside a raw lowercase token (key missing from the label
    // table). Checked BOTH ways round: every Django method is mapped by
    // both, and every non-Django token falls back in both. The second half
    // is what catches a key quietly added to only one of the two tables.
    for (const method of DJANGO_INPUT_METHODS) {
      expect(inputMethodEmoji(method)).not.toBe("");
      expect(inputMethodHuman(method)).not.toBe(method);
    }
    for (const token of NON_DJANGO_TOKENS) {
      expect(inputMethodEmoji(token)).toBe("");
      expect(inputMethodHuman(token)).toBe(token);
    }
  });

  it("returns an empty string for an unknown method", () => {
    // The port's documented divergence from Django, which returns None here
    // and therefore renders the literal word "None" into the icon cell (the
    // module comment's "renders as empty" is optimistic about Django, but
    // "" is what the port actually produces and what the templates want).
    expect(inputMethodEmoji("distill")).toBe("");
    expect(inputMethodEmoji("Scrape")).toBe("");
    expect(inputMethodEmoji(" ai")).toBe("");
    expect(inputMethodEmoji("")).toBe("");
  });

  it("never echoes its input, because its output is rendered unescaped", () => {
    // THE SECURITY-RELEVANT INVARIANT. inputMethodHuman can safely fall back
    // to the raw token because nunjucks auto-escapes it; this function
    // cannot, because every consumer marks the result `| safe` or splices it
    // into a raw HTML string. lists.ts:692 is the clearest case: the icon
    // sits in a rowCells array whose every other string cell is wrapped in
    // escapeHtml(), so this one value is trusted by construction. A future
    // "helpful" fallback of `?? method` here -- or an escapeHtml(method)
    // one, which still leaks the value onto the page -- would turn a bad
    // input_method row into stored HTML in the admin.
    const hostile = [
      "<script>alert(1)</script>",
      '"><img src=x onerror=alert(1)>',
      '<span class="mdi mdi-spider"></span>',
      "javascript:alert(1)",
      // These two contain a real key as a substring, so a startsWith- or
      // includes-style "fuzzy" lookup returns the wrong icon for them, and a
      // lenient fallback echoes the payload that follows it.
      "scrape<script>alert(1)</script>",
      'ai"><img src=x onerror=alert(1)>',
    ];
    for (const value of hostile) {
      // Asserted as "nothing at all comes back", not "contains no script
      // tag": that is the only version of this guarantee that also fails an
      // escaping-based reimplementation, which would still put the
      // attacker's text in the cell.
      expect(inputMethodEmoji(value)).toBe("");
    }
  });

  it("only ever emits a single self-closed MDI span", () => {
    // Shape check on top of the exact-string assertions: the values sit
    // inside a <td> and a <dd>, so an unbalanced tag would break the
    // surrounding table, not just the cell.
    for (const method of DJANGO_INPUT_METHODS) {
      expect(inputMethodEmoji(method)).toMatch(/^<span class="mdi mdi-[a-z]+"><\/span>$/);
    }
  });
});

describe("boundaries neither lookup table can hold", () => {
  it("keeps no state between calls, so one need's label cannot leak into the next", () => {
    // The needs list renders hundreds of rows through BOTH functions in one
    // isolate (needs.ts:121-122 maps every row), and the tables are
    // module-level constants shared by every request that isolate serves.
    // This interleaves the two functions over repeated and alternating keys:
    // a memoised "last lookup" cache -- the plausible optimisation over a
    // plain Record read -- would return the previous row's value here, and a
    // cache SHARED between the two functions would put an icon in the label
    // column. An ordinary read of a constant object cannot fail this.
    const script: Array<[(method: string) => string, string, string]> = [
      [inputMethodHuman, "ai", "AI"],
      [inputMethodEmoji, "ai", '<span class="mdi mdi-robot"></span>'],
      [inputMethodHuman, "ai", "AI"],
      [inputMethodHuman, "scrape", "Scraped"],
      [inputMethodEmoji, "scrape", '<span class="mdi mdi-spider"></span>'],
      [inputMethodHuman, "distill", "distill"],
      [inputMethodEmoji, "distill", ""],
      [inputMethodHuman, "scrape", "Scraped"],
      [inputMethodEmoji, "ai", '<span class="mdi mdi-robot"></span>'],
      [inputMethodHuman, "", ""],
      [inputMethodEmoji, "typed", '<span class="mdi mdi-keyboard"></span>'],
      [inputMethodHuman, "user", "User"],
      [inputMethodHuman, "distill", "distill"],
    ];
    for (const [fn, method, expected] of script) {
      expect(fn(method)).toBe(expected);
    }
  });

  it("compares unicode code point for code point, with no folding or normalisation", () => {
    // The ASCII casing test above is killed by a .toLowerCase() rewrite;
    // this one is aimed at the leniency that survives it. Fullwidth "ai"
    // folds to plain "ai" under NFKC, and an accented "scrape" folds to
    // "scrape" if someone strips combining marks -- both are the sort of "be
    // forgiving about messy data" change that looks harmless in a diff and
    // would start labelling junk rows as genuine AI-extracted needs. Django
    // compares with `==` and does none of this; nor does a property read.
    //
    // The inputs below are literal non-ASCII characters, which an editor or
    // a bad merge could silently normalise into plain ASCII -- at which
    // point these assertions would pass while testing nothing. Each one is
    // therefore preceded by a property check that fails loudly if the
    // character has been flattened.
    const fullwidthAi = "ａｉ";
    expect(fullwidthAi.normalize("NFKC")).toBe("ai"); // the fold this test rules out
    expect(inputMethodHuman(fullwidthAi)).toBe(fullwidthAi);
    expect(inputMethodEmoji(fullwidthAi)).toBe("");

    const precomposed = "scrapé"; // e-acute as one code point
    const decomposed = "scrapé"; // "scrape" + combining acute
    expect(precomposed).not.toBe(decomposed); // sanity: genuinely two inputs
    expect(inputMethodHuman(precomposed)).toBe(precomposed);
    expect(inputMethodEmoji(precomposed)).toBe("");
    expect(inputMethodHuman(decomposed)).toBe(decomposed);
    expect(inputMethodEmoji(decomposed)).toBe("");
    // The decomposed form literally starts with the seven characters
    // "scrape", so a startsWith() lookup would label this junk as Scraped.
    expect(decomposed.startsWith("scrape")).toBe(true);
    expect(inputMethodHuman(decomposed)).not.toBe("Scraped");

    // Turkish dotted capital I, whose lowercase is "i" plus a combining dot
    // -- two code points, not one. Asserted so a toLocaleLowerCase() rewrite
    // is caught by intent rather than by luck.
    const dottedI = "İ";
    expect(dottedI.toLowerCase()).toHaveLength(2); // fails if flattened to "I"
    expect(inputMethodHuman(dottedI)).toBe(dottedI);
    expect(inputMethodEmoji(dottedI)).toBe("");
  });

  it("returns the argument itself when it falls back, whatever its type", () => {
    // TypeScript types the parameter as string, but the rows come from D1
    // and the fallback is `?? method` -- it hands back the ARGUMENT, not a
    // stringification of it. So inputMethodHuman's declared `: string`
    // return type is not true at runtime for non-string input, and
    // enrichNeedRow (admin/index.ts:288-289) inherits that hole in its own
    // return type. Pinned as CURRENT BEHAVIOUR, not endorsed: a `??
    // String(method)` tidy-up would pass every other test in this file and
    // change all five of these assertions. Note that the two functions
    // diverge here -- inputMethodEmoji's fallback is a literal "", so it is
    // always a string no matter what it is handed.
    expect(inputMethodHuman(undefined as unknown as string)).toBeUndefined();
    expect(inputMethodHuman(null as unknown as string)).toBeNull();
    expect(inputMethodHuman(0 as unknown as string)).toBe(0);
    expect(inputMethodHuman(NaN as unknown as string)).toBeNaN();
    // Object.is, so -0 is not accepted in place of 0: proves the value comes
    // back by identity rather than round-tripped through a string.
    expect(Object.is(inputMethodHuman(-0 as unknown as string), -0)).toBe(true);

    // The icon table is asked the same questions and answers "" every time,
    // which is what keeps the unescaped-output invariant true for junk rows.
    expect(inputMethodEmoji(undefined as unknown as string)).toBe("");
    expect(inputMethodEmoji(null as unknown as string)).toBe("");
    expect(inputMethodEmoji(0 as unknown as string)).toBe("");
    expect(inputMethodEmoji(NaN as unknown as string)).toBe("");
  });

  it("looks up by property-key coercion, so a non-string CAN hit a real key", () => {
    // The other half of the test above, and the sharper half. The one above
    // only covers non-strings that MISS; these are non-strings that HIT.
    // Indexing an object converts the key with ToPropertyKey first, so any
    // value that merely stringifies to one of the four tokens is treated as a
    // genuine input method. Django cannot do this: `self.input_method == "ai"`
    // is False for a list, for a boxed string, and for an object that only
    // renders as "ai".
    //
    // This is the divergence that matters most, because inputMethodEmoji's
    // result is spliced into the page unescaped (lists.ts:692): which HTML
    // gets emitted is decided by an arbitrary caller-supplied toString rather
    // than by a string comparison. Recorded as CURRENT BEHAVIOUR, not
    // endorsed -- a `typeof method === "string"` guard, the obvious
    // hardening, flips every assertion in this test, and that is exactly why
    // they are written down rather than left to be discovered.
    const singletonArray = ["ai"]; // String(["ai"]) === "ai"
    expect(inputMethodHuman(singletonArray as unknown as string)).toBe("AI");
    expect(inputMethodEmoji(singletonArray as unknown as string)).toBe('<span class="mdi mdi-robot"></span>');

    const boxed = new String("scrape"); // typeof "object", not "string"
    expect(inputMethodHuman(boxed as unknown as string)).toBe("Scraped");
    expect(inputMethodEmoji(boxed as unknown as string)).toBe('<span class="mdi mdi-spider"></span>');

    const custom = { toString: () => "typed" };
    expect(inputMethodHuman(custom as unknown as string)).toBe("Typed");
    expect(inputMethodEmoji(custom as unknown as string)).toBe('<span class="mdi mdi-keyboard"></span>');

    // A symbol is already a valid property key, so nothing is stringified,
    // nothing throws, and the lookup simply misses. This is the input that
    // proves the label's fallback returns the ARGUMENT rather than a
    // stringification of it: `?? String(method)` would give "Symbol(ai)" and
    // a template-literal fallback would throw a TypeError outright.
    const sym = Symbol("ai");
    expect(inputMethodHuman(sym as unknown as string)).toBe(sym);
    expect(inputMethodEmoji(sym as unknown as string)).toBe("");
  });

  it("handles a pathologically long value without throwing or truncating", () => {
    // change_text is user-visible free text and input_method sits beside it
    // in the same row; a corrupt insert (or a mis-shifted column in a bulk
    // import) can put a large blob here. Both functions must survive it: the
    // label falls back to the whole value untouched -- nunjucks escapes it,
    // so a long value is ugly rather than dangerous -- and the icon stays
    // empty, which is the one that matters because it is spliced unescaped.
    const huge = "x".repeat(100_000);
    // toBe, not toHaveLength(100_000): a fallback that returned some OTHER
    // 100,000-character string -- a padded, sliced-and-rejoined or otherwise
    // rebuilt value -- has the right length and the wrong content, and the
    // point of this function's fallback is that the admin sees the stored
    // value exactly as stored.
    expect(inputMethodHuman(huge)).toBe(huge);
    expect(inputMethodEmoji(huge)).toBe("");
  });
});

describe("inherited Object.prototype keys", () => {
  // Both functions look up a plain object literal, so keys that live on
  // Object.prototype resolve to inherited members instead of missing. `??`
  // only catches null/undefined, so those inherited values are returned
  // rather than falling back. This is NOT a fix -- it is a record of what
  // the code does today, so that hardening it later (Object.create(null), or
  // an Object.hasOwn guard) shows up as an intentional change to these
  // expectations rather than an accident. input_method is written by trusted
  // code paths today (a SQL literal in needcheck.ts, a hardcoded "typed" in
  // needAdminExtras.ts), so this is currently unreachable rather than
  // exploitable.
  it("returns the inherited member for a prototype key name", () => {
    expect(typeof inputMethodHuman("toString")).toBe("function");
    expect(typeof inputMethodHuman("constructor")).toBe("function");
    expect(typeof inputMethodEmoji("toString")).toBe("function");
    expect(typeof inputMethodEmoji("valueOf")).toBe("function");
    expect(inputMethodEmoji("__proto__")).toBe(Object.prototype);
    // The label function is probed with "__proto__" too, not just the icon
    // one. It is the single input for which the invariant asserted in
    // "stays in step with inputMethodHuman in both directions" -- that a
    // token which misses comes back unchanged -- is FALSE: `__proto__` is an
    // accessor on Object.prototype, so the read yields the prototype object
    // instead of undefined and `??` never fires. Left in the icon test alone,
    // that asymmetry reads as an oversight rather than a fact about the code.
    expect(inputMethodHuman("__proto__")).toBe(Object.prototype);
    expect(inputMethodHuman("__proto__")).not.toBe("__proto__");
  });

  it("carries no own key beyond Django's four, in EITHER table", () => {
    // Turns the quirk above into a probe, because it closes a hole the parity
    // test in the inputMethodEmoji block cannot: that test can only walk a
    // fixed list of tokens and check they fall back, and falling back is
    // indistinguishable from a table entry whose value happens to EQUAL the
    // fallback. Stubbing a half-finished new method as `distill: ""` in
    // INPUT_METHOD_EMOJI, or `distill: "distill"` in INPUT_METHOD_HUMAN --
    // the natural way to add a key before its value is decided -- passes
    // every other assertion in this file while leaving the two tables out of
    // step, which is precisely the state need.njk:21 renders as an icon with
    // no label, or a label with no icon.
    //
    // A prototype value is reached ONLY when the table has no own key of that
    // name, so getting the sentinel back proves the key is absent, and
    // getting anything else back proves someone added it. The tables are not
    // exported (correctly -- rule 4), so this is the only way to assert
    // absence rather than merely assert behaviour.
    const sentinel = "__probe_sentinel__";
    // Plausible next input methods and near-misses of existing ones. None is
    // an Object.prototype member name, so the sentinel is what the lookup
    // finds if -- and only if -- the table itself does not define the key.
    const candidates = ["distill", "manual", "bot", "llm", "sms", "import", "Scraped", "scrapes"];
    const probed = [...candidates, ...DJANGO_INPUT_METHODS];
    try {
      for (const key of probed) {
        Object.defineProperty(Object.prototype, key, {
          value: sentinel,
          configurable: true,
          enumerable: false,
          writable: true,
        });
      }
      for (const key of candidates) {
        expect(inputMethodHuman(key), `INPUT_METHOD_HUMAN gained a key: ${key}`).toBe(sentinel);
        expect(inputMethodEmoji(key), `INPUT_METHOD_EMOJI gained a key: ${key}`).toBe(sentinel);
      }
      // Positive control, and not decoration: it proves the probe is actually
      // wired up. Own properties shadow the prototype, so the four real
      // methods must be blind to the sentinel -- if they were not, the
      // assertions above would be passing because the lookup always reaches
      // the prototype, which would make this whole test vacuous.
      for (const method of DJANGO_INPUT_METHODS) {
        expect(inputMethodHuman(method)).not.toBe(sentinel);
        expect(inputMethodEmoji(method)).not.toBe(sentinel);
      }
    } finally {
      for (const key of probed) {
        delete (Object.prototype as unknown as Record<string, unknown>)[key];
      }
    }
    // Cleanup asserted rather than assumed. A leaked "scrape" or "ai" on
    // Object.prototype would NOT break the happy-path tests (own keys still
    // win), so it would escape notice while quietly turning every fallback
    // assertion in this file green for the wrong reason.
    expect(inputMethodHuman("distill")).toBe("distill");
    expect(inputMethodEmoji("distill")).toBe("");
    expect(inputMethodHuman("scrape")).toBe("Scraped");
  });

  it("means the emptiness guarantee holds only for ordinary strings", () => {
    // Stated explicitly so the "never echoes its input" test above is not
    // read as a stronger promise than it is: the guarantee covers every
    // value that is not an Object.prototype key name.
    expect(inputMethodEmoji("hasOwnProperty")).not.toBe("");
  });

  it("and is defeated for ANY key once Object.prototype is polluted", () => {
    // The sharp edge of the same fact, and the reason the two tests above
    // are not just trivia. The set of keys that escape the "" fallback is
    // not fixed at four-plus-Object.prototype: it is whatever
    // Object.prototype happens to carry at call time. If anything in this
    // Worker ever pollutes it -- the classic deep-merge or query-string
    // parse bug -- an attacker-chosen string is returned from
    // inputMethodEmoji and spliced unescaped into the admin at lists.ts:692.
    //
    // Defined non-enumerable so nothing else iterating objects during this
    // test can see it, and removed in a finally so the pollution cannot leak
    // into the "distill falls back" assertions elsewhere in this file.
    const payload = "<img src=x onerror=alert(1)>";
    try {
      Object.defineProperty(Object.prototype, "distill", {
        value: payload,
        configurable: true,
        enumerable: false,
        writable: true,
      });
      expect(inputMethodEmoji("distill")).toBe(payload);
      expect(inputMethodHuman("distill")).toBe(payload);
      // The four real methods are own properties, so they still win over the
      // polluted prototype -- the happy path is not what breaks here.
      expect(inputMethodEmoji("ai")).toBe('<span class="mdi mdi-robot"></span>');
      expect(inputMethodHuman("ai")).toBe("AI");
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>).distill;
    }
    // Asserted rather than trusted: if that cleanup ever stops working, this
    // fails here instead of causing a baffling failure in inputMethodHuman's
    // fallback test further up the file.
    expect(inputMethodEmoji("distill")).toBe("");
    expect(inputMethodHuman("distill")).toBe("distill");
  });
});
