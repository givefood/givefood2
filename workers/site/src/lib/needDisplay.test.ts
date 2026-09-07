import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FoodbankChangeRow, FoodbankWithLatestNeed, NeedTranslationRow, Session } from "@givefood/db";

// resolveNeedDisplay() is the one place three locale-prefixed pages --
// /needs/at/<slug>/, /needs/at/<slug>/<locslug>/ and
// /needs/at/<slug>/<dpslug>/ -- turn a FoodbankChange row into the four
// values their templates read. It is the read half of
// FoodbankChange.get_text() (givefood/models/needs.py:216-259), and the
// thing worth testing about it is not the string munging (that is
// @givefood/models' resolveNeedText/nonEmptyLines, tested there) but the
// SPLIT it maintains:
//
//   * changeText / excessChangeText are the RAW English columns. Django's
//     templates gate on the model field -- `{% if
//     foodbank.latest_need.change_text != "Unknown" and ... != "Nothing" %}`
//     (gfwfbn/templates/wfbn/foodbank/index.html:68) -- so those gates
//     must behave identically on /cy/ as on /. locationDetail.ts:126's
//     three-sentinel `hasNeed` reads changeText for the same reason.
//   * getChangeText / excessTextList are the DISPLAY values: translated
//     where a translation exists, blank lines stripped, English otherwise.
//
// Collapsing those two into one value is the mistake this file exists to
// catch: it is invisible in English, and silently changes what every
// Welsh, Irish and Scots Gaelic page shows.
//
// @givefood/db is mocked -- what is under test is the wiring (WHEN a
// lookup is issued, keyed on what, and which value wins), not the SQL,
// which is packages/db's contract. @givefood/models is deliberately NOT
// mocked: resolveNeedText's Django fallback chain and nonEmptyLines'
// blank-line strip are exactly what this function promises its callers, so
// they run for real.

const db = vi.hoisted(() => ({ getNeedTranslation: vi.fn() }));
vi.mock("@givefood/db", () => db);

import { resolveNeedDisplay, type NeedDisplay } from "./needDisplay";

// A sentinel rather than a real D1DatabaseSession. PLAN.md §3.3: this
// database has read replication on, and a translation lookup that escaped
// the caller's session could land on a replica that has not caught up with
// the publish that queued the translation in the first place.
const SESSION = { sessionMarker: "the caller's D1 session" } as unknown as Session;

const NON_ENGLISH = ["cy", "ga", "gd"] as const;

// Only the three columns this function reads. FoodbankChangeRow has 20+
// columns and none of the others can change the outcome.
function need(row: Partial<FoodbankChangeRow> & { id: number }): FoodbankChangeRow {
  return { change_text: "Beans", excess_change_text: null, ...row } as unknown as FoodbankChangeRow;
}

function foodbank(latestNeed: FoodbankChangeRow | null): FoodbankWithLatestNeed {
  return { id: 42, name: "Croydon", slug: "croydon", latestNeed } as unknown as FoodbankWithLatestNeed;
}

function translation(row: Partial<NeedTranslationRow>): NeedTranslationRow {
  return { change_text: null, excess_change_text: null, ...row };
}

// A realistic shopping list, with the blank line a scraper leaves behind.
const NEED = need({
  id: 9101,
  change_text: "Tinned soup\n\nLong life milk\nNappies (size 5)",
  excess_change_text: "Baked beans\nPasta",
});

beforeEach(() => {
  vi.clearAllMocks();
  // No translation row is the default, and it is the common case: D1 holds
  // cy/ga/gd rows only (migrations/0006_need_translations.sql), and any
  // given (need, language) pair is absent until the publish-time queue job
  // in workers/jobs has run for it.
  db.getNeedTranslation.mockResolvedValue(null);
});

describe("resolveNeedDisplay in English", () => {
  it("never queries the translation table", async () => {
    // Django's get_text() takes the `current_language == "en"` branch
    // (needs.py:221-225) and reads change_text/excess_change_text directly
    // -- it never touches FoodbankChangeTranslation. packages/db's
    // needTranslations.ts says the same in its own header: "English never
    // queries this table at all ... callers gate on that themselves". So a
    // lookup here would be both a divergence and a wasted D1 round trip on
    // the large majority of requests to the busiest pages on the site.
    await resolveNeedDisplay(SESSION, foodbank(NEED), "en");
    expect(db.getNeedTranslation).not.toHaveBeenCalled();
  });

  it("publishes the raw column and the blank-line-stripped display text side by side", async () => {
    // The documented happy path. changeText is the stored value, byte for
    // byte, because index.njk:66 compares it to "Unknown"/"Nothing";
    // getChangeText is Django's get_change_text(), which drops blank lines
    // and rejoins with "\n" so that `|linebreaksbr` does not emit a run of
    // empty <br>s for a scraped list with gaps in it.
    const display = await resolveNeedDisplay(SESSION, foodbank(NEED), "en");
    expect(display.changeText).toBe("Tinned soup\n\nLong life milk\nNappies (size 5)");
    expect(display.getChangeText).toBe("Tinned soup\nLong life milk\nNappies (size 5)");
  });

  it("drops whitespace-only lines, not just empty ones", async () => {
    // Django filters on `line.strip()`, not on `line`. A line of spaces or
    // a tab is what a scrape of a <ul> with indented markup produces, and
    // it must not become a blank bullet on the page.
    const display = await resolveNeedDisplay(
      SESSION,
      foodbank(need({ id: 1, change_text: "Beans\n   \nRice\n\t\nPasta" })),
      "en",
    );
    expect(display.getChangeText).toBe("Beans\nRice\nPasta");
  });

  it("filters lines without trimming the ones it keeps", async () => {
    // The half of Django's comprehension that is easy to get wrong in a
    // rewrite: `[line for line in text.split("\n") if line.strip()]` tests
    // `line.strip()` but appends `line`. A port that wrote
    // `.map(l => l.trim()).filter(Boolean)` -- the obvious tidier spelling --
    // passes every other test in this file and silently reflows the page,
    // because the scraped lists really do carry leading indentation
    // ("  Tinned soup") that Django preserves and `|linebreaksbr` renders.
    // Verified against CPython: "Beans  \n \n  Rice" -> ['Beans  ', '  Rice'].
    const display = await resolveNeedDisplay(
      SESSION,
      foodbank(need({ id: 1, change_text: "  Tinned soup  \n   \nRice\t", excess_change_text: "  Baked beans  \nPasta" })),
      "en",
    );
    expect(display.getChangeText).toBe("  Tinned soup  \nRice\t");
    expect(display.excessTextList).toEqual(["  Baked beans  ", "Pasta"]);
  });

  it("splits on \\n alone, so a CRLF scrape keeps its carriage returns", async () => {
    // Django splits on the literal "\n", never on a universal-newlines
    // regex, so a Windows-line-ending scrape leaves a trailing "\r" on every
    // line -- kept, because the filter is on the STRIPPED line and the line
    // itself is appended verbatim. The blank "\r\n\r\n" line does vanish
    // ("\r".strip() == "" in Python, "\r".trim() === "" in JS). A port that
    // "helpfully" split on /\r?\n/ would produce different bytes from Django
    // for the ~few food banks whose need text is pasted out of Word.
    const display = await resolveNeedDisplay(
      SESSION,
      foodbank(need({ id: 1, change_text: "Beans\r\n\r\nRice\r\n" })),
      "en",
    );
    expect(display.getChangeText).toBe("Beans\r\nRice\r");
  });

  it("drops a byte-order-mark-only line -- a real, if tiny, divergence from Django", async () => {
    // Documented, not endorsed. JS `String.prototype.trim` strips U+FEFF
    // (it is in the spec's WhiteSpace production); Python's `str.strip()`
    // does not, because "\uFEFF".isspace() is False. So a stray BOM left
    // mid-text by a mis-decoded scrape becomes a surviving, invisible bullet
    // in Django and disappears here. Both were checked directly rather than
    // assumed. The behaviours agree on every other space character that
    // matters -- U+00A0, U+2028, U+3000 and the tab/VT family are stripped
    // by both -- so this one codepoint is the whole of the difference.
    const display = await resolveNeedDisplay(
      SESSION,
      foodbank(need({ id: 1, change_text: "Beans\n\uFEFF\nRice", excess_change_text: "\u00A0\nPasta" })),
      "en",
    );
    expect(display.getChangeText).toBe("Beans\nRice");
    // U+00A0 agrees with Django: dropped on both sides.
    expect(display.excessTextList).toEqual(["Pasta"]);
  });

  it("keeps excessChangeText raw and excessTextList as the split display items", async () => {
    // Two different jobs. index.njk:75 opens the "They don't need any more"
    // section on the RAW value (Django index.html:78 gates on the model's
    // `foodbank.latest_need.excess_change_text`); the loop underneath it
    // renders excess_text_list. Feeding the section the display value
    // instead would change which food banks show that paragraph at all.
    const display = await resolveNeedDisplay(SESSION, foodbank(NEED), "en");
    expect(display.excessChangeText).toBe("Baked beans\nPasta");
    expect(display.excessTextList).toEqual(["Baked beans", "Pasta"]);
  });

  it("returns an empty list, not a one-element list of empty string, for a null excess", async () => {
    // A DIVERGENCE FROM DJANGO, benign and worth stating. Django's
    // get_excess_text_list() (needs.py:267-268) is
    // `get_excess_text().split("\n")`, and
    // Python's "".split("\n") is [''] -- a one-item list. This returns [].
    // Nothing renders differently (the section is gated on the raw value,
    // and a single empty item prints nothing and no comma either), but a
    // future caller doing `if (excessTextList.length)` gets the sane answer
    // here and would have got the wrong one from a literal port.
    const display = await resolveNeedDisplay(SESSION, foodbank(need({ id: 1, excess_change_text: null })), "en");
    expect(display.excessChangeText).toBeNull();
    expect(display.excessTextList).toEqual([]);
  });

  it("keeps an empty-string excess distinct from a NULL one", async () => {
    // The guard is `?? null`, not `|| null`, and the difference is
    // observable: excessChangeText is handed to the template as
    // `foodbank.latest_need_excess_text` (foodbank.ts:86) and reaches the
    // page context, and the same object shape is what a future /api/ caller
    // would serialise. Both values are falsy so index.njk:75's gate agrees
    // either way -- which is exactly why a `||` would slip through review.
    // Django keeps them distinct too ("" is the column's stored value; None
    // is a null FK), so collapsing them here would invent a value.
    const display = await resolveNeedDisplay(SESSION, foodbank(need({ id: 1, excess_change_text: "" })), "en");
    expect(display.excessChangeText).toBe("");
    expect(display.excessChangeText).not.toBeNull();
    expect(display.excessTextList).toEqual([]);
  });

  it("keeps a blank-only excess truthy for the template's gate while listing nothing", async () => {
    // The boundary between the two fields, in the one case where they
    // disagree about emptiness: "\n \n" is truthy, so the paragraph opens,
    // but there are no items to name. Django behaves the same way (its gate
    // is on the raw field too), which is why this is pinned rather than
    // tidied into "no excess at all".
    const display = await resolveNeedDisplay(SESSION, foodbank(need({ id: 1, excess_change_text: "\n \n" })), "en");
    expect(display.excessChangeText).toBe("\n \n");
    expect(display.excessTextList).toEqual([]);
  });

  it("passes the three sentinels through untouched", async () => {
    // "Nothing", "Unknown" and "Facebook" are compared as exact strings in
    // at least six places and appear in API responses -- PLAN.md §6.3.5:
    // "part of the public data contract, not internal markers". Both the
    // raw and the display value must be the bare word, with no whitespace
    // added, or index.njk's gate and its Facebook-embed branch both miss.
    for (const sentinel of ["Nothing", "Unknown", "Facebook"]) {
      const display = await resolveNeedDisplay(SESSION, foodbank(need({ id: 1, change_text: sentinel })), "en");
      expect(display.changeText).toBe(sentinel);
      expect(display.getChangeText).toBe(sentinel);
    }
  });

  it("survives a change_text that is only whitespace", async () => {
    // change_text is NOT NULL but not non-empty, and a failed scrape can
    // leave a row like this. The gate sees a truthy, non-sentinel value and
    // opens the "is currently requesting" paragraph; the display value is
    // empty, so the paragraph renders bare rather than 500ing.
    const display = await resolveNeedDisplay(SESSION, foodbank(need({ id: 1, change_text: "   \n  " })), "en");
    expect(display.changeText).toBe("   \n  ");
    expect(display.getChangeText).toBe("");
  });
});

describe("resolveNeedDisplay with no latest need", () => {
  it('falls back to "" -- deliberately NOT the "Nothing" sentinel', async () => {
    // Called out at all three call sites (foodbank.ts:34-38,
    // locationDetail.ts:36, and md/foodbank.ts:20-24, which has the fullest
    // version): "Nothing" is a real, distinct value meaning the
    // food bank told us it needs nothing, and "" is Django's silent-variable
    // failure for `{{ foodbank.latest_need.change_text }}` against a null FK.
    // Substituting the sentinel would tell every visitor to a
    // newly-added food bank that it has told us it needs nothing.
    const display = await resolveNeedDisplay(SESSION, foodbank(null), "en");
    expect(display.changeText).toBe("");
    expect(display.getChangeText).toBe("");
    expect(display.excessChangeText).toBeNull();
    expect(display.excessTextList).toEqual([]);
  });

  it('leaves "" on the requesting-items side of both template gates, as Django does', async () => {
    // The CONSEQUENCE of "" rather than a sentinel, stated rather than
    // assumed -- and it is not the intuitive one, so it is pinned. Both
    // real gates are exclusion tests against the sentinels, so "" passes
    // them: index.njk:66 opens the "is currently requesting the following
    // items" paragraph with an empty need_text underneath it, and
    // locationDetail.ts:126's hasNeed is true.
    //
    // That is Django's behaviour too (its gate is the same exclusion test
    // against the same silently-empty variable), which is the only reason
    // it is reproduced rather than fixed. Anyone tempted to make the
    // no-need case return "Unknown" so the page reads better is changing
    // parity, and this test is where they find that out.
    const display = await resolveNeedDisplay(SESSION, foodbank(null), "en");
    const indexGate = (t: string) => t !== "Unknown" && t !== "Nothing"; // index.njk:66
    const hasNeed = (t: string) => t !== "Unknown" && t !== "Nothing" && t !== "Facebook"; // locationDetail.ts:126
    expect(indexGate(display.changeText)).toBe(true);
    expect(hasNeed(display.changeText)).toBe(true);
  });

  it("skips the lookup on a non-English page too, rather than reading id off null", async () => {
    // The `&& foodbank.latestNeed` half of the guard. Without it this would
    // be `null.id` -- a TypeError, so a 500 on every /cy/ page for any food
    // bank with no need yet. New food banks are added regularly and have no
    // need for as long as it takes the first scrape to land.
    //
    // All four fields are asserted per locale, not just getChangeText: a
    // guard that skipped the lookup but then took a different no-need path
    // for cy/ga/gd -- returning null for changeText, say -- would break the
    // string comparisons above on exactly those pages and nowhere else.
    for (const locale of NON_ENGLISH) {
      const display = await resolveNeedDisplay(SESSION, foodbank(null), locale);
      expect(display).toEqual({ changeText: "", excessChangeText: null, getChangeText: "", excessTextList: [] });
    }
    expect(db.getNeedTranslation).not.toHaveBeenCalled();
  });
});

describe("resolveNeedDisplay in Welsh, Irish and Scots Gaelic", () => {
  it("looks the translation up once, keyed on the need id and the request's locale", async () => {
    // Keyed on latestNeed.id (the integer PK), not the food bank id and not
    // need_id (the 32-char dashless UUID string, a different column on the
    // same row -- see packages/db/src/needs.ts:8). Getting that wrong finds
    // no row and silently serves English on every translated page.
    for (const locale of NON_ENGLISH) {
      db.getNeedTranslation.mockClear();
      await resolveNeedDisplay(SESSION, foodbank(NEED), locale);
      expect(db.getNeedTranslation).toHaveBeenCalledTimes(1);
      expect(db.getNeedTranslation).toHaveBeenCalledWith(SESSION, 9101, locale);
    }
  });

  it("keys the lookup on the row existing, not on its id being truthy", async () => {
    // The guard is `foodbank.latestNeed`, the ROW -- not `latestNeed?.id`,
    // which is the shorter spelling a reviewer would wave through and which
    // is identical for every id except 0. Rows with id 0 are not what
    // AUTOINCREMENT produces, but they are what a hand-written fixture, a
    // seeded test database and a re-imported dump produce, and the failure
    // would be a silently untranslated page rather than an error.
    await resolveNeedDisplay(SESSION, foodbank(need({ id: 0, change_text: "Beans" })), "cy");
    expect(db.getNeedTranslation).toHaveBeenCalledWith(SESSION, 0, "cy");
  });

  it("threads the caller's own session into the lookup", async () => {
    // PLAN.md §3.3 again: translations are written by a queue consumer
    // moments after a publish, so this read is exactly the kind that can
    // observe a lagging replica if it escapes the request's session.
    await resolveNeedDisplay(SESSION, foodbank(NEED), "cy");
    expect(db.getNeedTranslation.mock.calls[0]![0]).toBe(SESSION);
  });

  it("serves the translated text as the display value", async () => {
    // The reason the whole module exists. One row carries both columns, so
    // one lookup answers both the needed and the not-needed lists.
    db.getNeedTranslation.mockResolvedValue(
      translation({ change_text: "Cawl tun\nLlaeth hir oes", excess_change_text: "Ffa pob\nPasta" }),
    );
    const display = await resolveNeedDisplay(SESSION, foodbank(NEED), "cy");
    expect(display.getChangeText).toBe("Cawl tun\nLlaeth hir oes");
    expect(display.excessTextList).toEqual(["Ffa pob", "Pasta"]);
    expect(db.getNeedTranslation).toHaveBeenCalledTimes(1);
  });

  it("leaves changeText and excessChangeText in ENGLISH even on a translated page", async () => {
    // THE SPLIT, stated as an assertion. Django's outer gates read the model
    // field, which is never translated, so /cy/needs/at/<slug>/ and
    // /needs/at/<slug>/ take the same branch of index.njk. If these carried
    // the Welsh text, a Welsh page would show the shopping-list paragraph
    // for a food bank whose English page correctly shows contact details.
    db.getNeedTranslation.mockResolvedValue(
      translation({ change_text: "Cawl tun\nLlaeth hir oes", excess_change_text: "Ffa pob\nPasta" }),
    );
    const display = await resolveNeedDisplay(SESSION, foodbank(NEED), "cy");
    expect(display.changeText).toBe("Tinned soup\n\nLong life milk\nNappies (size 5)");
    expect(display.excessChangeText).toBe("Baked beans\nPasta");
  });

  it("strips blank lines from the translated text as well as the English", async () => {
    // Google Translate is given the text one blob at a time (translateNeed.ts
    // posts the whole change_text as one `q`), so it echoes the source's
    // line structure -- blank lines included. The strip has to apply after
    // the translation wins, not only on the English path.
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: "Cawl tun\n\n\nPasta\n" }));
    const display = await resolveNeedDisplay(SESSION, foodbank(NEED), "cy");
    expect(display.getChangeText).toBe("Cawl tun\nPasta");
  });

  it("falls back to English when the need has no translation row", async () => {
    // The `except FoodbankChangeTranslation.DoesNotExist: pass` arm of
    // needs.py:238-239. Real on every page for the window between a publish
    // and the queue consumer writing the row -- and permanently for any
    // publish whose Google Translate call failed.
    db.getNeedTranslation.mockResolvedValue(null);
    const display = await resolveNeedDisplay(SESSION, foodbank(NEED), "ga");
    expect(display.getChangeText).toBe("Tinned soup\nLong life milk\nNappies (size 5)");
    expect(display.excessTextList).toEqual(["Baked beans", "Pasta"]);
  });

  it("falls back to English when the row exists but the column is null", async () => {
    // Django's `if not translated_text or not the_text` (needs.py:247-251):
    // a row is not enough, the COLUMN has to be non-empty. This is a live
    // state, not a hypothetical -- translateNeed.ts:30 writes null whenever
    // Google's response has no translations array, and its excess column is
    // hardcoded null whenever the English excess was empty (line 40).
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: null, excess_change_text: null }));
    const display = await resolveNeedDisplay(SESSION, foodbank(NEED), "cy");
    expect(display.getChangeText).toBe("Tinned soup\nLong life milk\nNappies (size 5)");
    expect(display.excessTextList).toEqual(["Baked beans", "Pasta"]);
  });

  it("falls back to English when the row exists but the column is an empty string", async () => {
    // Same Django branch reached the other way. `not ""` is True in Python
    // and "" is falsy in JS, so both sides fall back -- but a `?? ` or a
    // `!== null` check in the port would publish a blank "items needed"
    // list to every Welsh visitor instead.
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: "", excess_change_text: "" }));
    const display = await resolveNeedDisplay(SESSION, foodbank(NEED), "gd");
    expect(display.getChangeText).toBe("Tinned soup\nLong life milk\nNappies (size 5)");
    expect(display.excessTextList).toEqual(["Baked beans", "Pasta"]);
  });

  it("falls back per column, not all or nothing", async () => {
    // The realistic partial row: the needed list translated, the not-needed
    // list null because the English excess was empty when the job ran and
    // the need has since been edited. Django decides each text_type
    // separately, and so must this -- a port that used "is there a row?" to
    // choose for both columns would show Welsh items alongside an English
    // heading, or drop the excess list entirely.
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: "Cawl tun", excess_change_text: null }));
    const display = await resolveNeedDisplay(SESSION, foodbank(NEED), "cy");
    expect(display.getChangeText).toBe("Cawl tun");
    expect(display.excessTextList).toEqual(["Baked beans", "Pasta"]);
  });

  it("lets a whitespace-only translation win, and so shows nothing at all", async () => {
    // The exact truthiness boundary of the fallback, and the one place a
    // defensive tidy-up changes what Welsh readers see. Django's test is
    // `not translated_text` and `not "   "` is False, so the blank
    // translation wins there and the blank-line strip then leaves nothing --
    // the page renders the "is currently requesting" heading over an empty
    // list. A port that tested `translatedText?.trim()` instead would
    // "helpfully" fall back to English and show a Welsh reader an English
    // shopping list, passing every other test in this file while doing it.
    //
    // Google Translate returning whitespace for a short input is the real
    // source of rows like this.
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: "   ", excess_change_text: "  \n  " }));
    const display = await resolveNeedDisplay(SESSION, foodbank(NEED), "cy");
    expect(display.getChangeText).toBe("");
    expect(display.excessTextList).toEqual([]);
    // Stated as the negative too, because "" is also what a broken lookup
    // would produce: the point is that English did NOT come back.
    expect(display.getChangeText).not.toContain("Tinned soup");
  });

  it("lets the translation win even when the English column it replaces is null", async () => {
    // PLAN.md §2.7.6 step 4: English is the fallback for "a missing row or
    // an empty string", and nothing in that chain re-checks the English
    // value first. So a translated excess survives a null English excess,
    // and the result is deliberately inconsistent: excessChangeText is null,
    // closing index.njk:75's gate, while excessTextList has two items in it
    // that the page will therefore never print.
    //
    // Reachable in production -- translateNeed.ts hardcodes a null excess
    // translation only for the state at publish time, and the need's English
    // excess can be edited to empty afterwards without re-running the job.
    // Pinned because the tempting "fix" (gate the translation on the raw
    // column being non-empty) would diverge from Django on the change_text
    // column too, where it is not cosmetic.
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: "Cawl tun", excess_change_text: "Ffa pob\n\nPasta" }));
    const display = await resolveNeedDisplay(SESSION, foodbank(need({ id: 1, excess_change_text: null })), "cy");
    expect(display.excessChangeText).toBeNull();
    expect(display.excessTextList).toEqual(["Ffa pob", "Pasta"]);
  });

  it("passes accented text through without normalising it", async () => {
    // Irish and Scots Gaelic need text is full of accented vowels, and
    // Google Translate's response is not guaranteed to be NFC -- the same
    // word can come back decomposed (u + U+0301) from one call and
    // precomposed from the next. Nothing in this path may normalise either
    // way: D1 comparisons, the ETag over the rendered page and Django's own
    // byte-for-byte output all key on the stored form. A `.normalize()`
    // added anywhere in the chain -- most plausibly inside a "clean up the
    // scraped text" helper -- fails here and nowhere else.
    const decomposed = "Su\u0301tha talu\u0301n\n\nBainne";
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: decomposed }));
    const display = await resolveNeedDisplay(SESSION, foodbank(NEED), "ga");
    expect(display.getChangeText).toBe("Su\u0301tha talu\u0301n\nBainne");
    // The decomposed form differs from its own NFC composition, so this
    // assertion is only satisfiable by text that was never normalised.
    expect(display.getChangeText).not.toBe(display.getChangeText.normalize("NFC"));
  });

  it("uses an English excess fallback of null without throwing", async () => {
    // Both halves empty at once: no excess in English, no row in Welsh.
    // resolveNeedText is handed (null, undefined) here, and its `if (!text)
    // return ""` guard is the only thing between that and a crash on the
    // ~half of food banks that publish no excess list.
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: "Cawl tun" }));
    const display = await resolveNeedDisplay(SESSION, foodbank(need({ id: 1, excess_change_text: null })), "cy");
    expect(display.excessChangeText).toBeNull();
    expect(display.excessTextList).toEqual([]);
  });
});

describe("resolveNeedDisplay and the sentinel translation quirk", () => {
  it("looks up a translation for a SENTINEL need, exactly as Django does", async () => {
    // PLAN.md §6.3.5's "A real quirk to reproduce, not fix silently": the
    // sentinel branch at needs.py:219-220 assigns the_text and is then
    // unconditionally overwritten by the `current_language == "en"` / else
    // block that follows, so a sentinel need DOES hit the translation table
    // on a non-English page. The module's own header forbids gating this
    // lookup on "is this a real need" for that reason. Asserting the CALL,
    // not just the output, is what stops a well-meant early return.
    await resolveNeedDisplay(SESSION, foodbank(need({ id: 5150, change_text: "Unknown" })), "cy");
    expect(db.getNeedTranslation).toHaveBeenCalledWith(SESSION, 5150, "cy");
  });

  it("serves the TRANSLATED sentinel, which need_text.njk then fails to match", async () => {
    // PLAN.md §6.11 item H, reproduced deliberately. A row like this is a
    // real production state: translateNeed.ts runs on every publish with no
    // regard for change_text's content, so "Unknown" gets sent to Google
    // Translate like any other string. The consequence downstream is that
    // need_text.njk:1 compares `need_text == "Unknown"` LITERALLY, so the
    // Welsh word falls through to the `{{ need_text|linebreaksbr }}` arm and
    // the page tells a Welsh reader the food bank needs "Anhysbys".
    //
    // This is documented, NOT endorsed -- §6.11 H files it as its own
    // follow-on fix. Whoever fixes it should be changing this expectation on
    // purpose, not discovering it by accident.
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: "Anhysbys" }));
    const display = await resolveNeedDisplay(SESSION, foodbank(need({ id: 1, change_text: "Unknown" })), "cy");
    expect(display.getChangeText).toBe("Anhysbys");
    expect(display.getChangeText).not.toBe("Unknown");
  });

  it("still hands the caller the untranslated sentinel for its own gates", async () => {
    // The mitigation that keeps the quirk cosmetic rather than structural:
    // index.njk:66 and locationDetail.ts:126 both test changeText, which is
    // the English "Unknown", so the page still takes the no-need branch. The
    // translated word only escapes through getChangeText. If changeText ever
    // became locale-aware, the quirk would stop being a display bug and
    // start showing shopping-list markup for every "Unknown" food bank.
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: "Dim byd" }));
    const display = await resolveNeedDisplay(SESSION, foodbank(need({ id: 1, change_text: "Nothing" })), "cy");
    expect(display.changeText).toBe("Nothing");

    // locationDetail.ts:126's gate, reproduced here rather than described,
    // so this test states the CONSEQUENCE: fed the raw value it correctly
    // says "no need to show"; fed the display value it would say the
    // opposite, and the Welsh page would print "Dim byd" as a shopping list.
    const hasNeed = (text: string) => text !== "Unknown" && text !== "Nothing" && text !== "Facebook";
    expect(hasNeed(display.changeText)).toBe(false);
    expect(hasNeed(display.getChangeText)).toBe(true);
  });

  it("leaves the Facebook embed branch working while a row is untranslated", async () => {
    // index.njk:67 compares the DISPLAY value to "Facebook" (Django does the
    // same, through `{% with ... get_change_text as change_text %}`), so the
    // embed survives only because Google returns the proper noun unchanged.
    // Pinned as the currently-working case that the quirk above threatens:
    // the day a translation renders it as anything else, the Facebook embed
    // silently becomes a shopping list containing one word.
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: "Facebook" }));
    const display = await resolveNeedDisplay(SESSION, foodbank(need({ id: 1, change_text: "Facebook" })), "cy");
    expect(display.getChangeText).toBe("Facebook");
  });

  it("would lose the Facebook embed the moment a translation renamed the sentinel", async () => {
    // The teeth behind the test above, which on its own cannot tell whether
    // "Facebook" survived because the translation won or because the lookup
    // was never wired up -- both paths produce the same string. Feeding it a
    // DIFFERENT translated value proves the display value really is
    // translation-driven, and shows the failure that fact implies.
    //
    // index.njk:66's outer gate reads changeText and excludes only
    // "Unknown"/"Nothing", so it still opens; index.njk:67 then compares the
    // DISPLAY value to "Facebook", misses, and the page prints the translated
    // word as a one-item shopping list instead of embedding the page feed.
    // Same shape as PLAN.md §6.11 item H, one branch along.
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: "Llyfr wyneb" }));
    const display = await resolveNeedDisplay(SESSION, foodbank(need({ id: 1, change_text: "Facebook" })), "cy");
    expect(display.changeText).toBe("Facebook");
    expect(display.getChangeText).toBe("Llyfr wyneb");

    const outerGate = (t: string) => t !== "Unknown" && t !== "Nothing"; // index.njk:66
    const isEmbed = (t: string) => t === "Facebook"; // index.njk:67, on the display value
    expect(outerGate(display.changeText)).toBe(true);
    expect(isEmbed(display.getChangeText)).toBe(false);
  });
});

describe("resolveNeedDisplay round trips and failure", () => {
  it("issues at most one D1 query, for the whole result", async () => {
    // Both display fields come off one row. The module's header tells
    // callers to Promise.all this against hasServiceArea() precisely because
    // it is ONE round trip they can overlap; a second query hidden in here
    // would add uncached latency to all three pages and be invisible in a
    // diff.
    await resolveNeedDisplay(SESSION, foodbank(NEED), "cy");
    expect(db.getNeedTranslation).toHaveBeenCalledTimes(1);
  });

  it("rejects rather than silently serving English when the lookup fails", async () => {
    // Current behaviour, pinned on purpose. A failed translation read means
    // the page 500s -- loud, and caught by monitoring. A catch-and-fall-back-
    // to-English here would look like kindness and would instead hide a
    // broken foodbankchangetranslation table behind three pages that quietly
    // stopped being Welsh.
    db.getNeedTranslation.mockRejectedValue(new Error("D1_ERROR: no such table: foodbankchangetranslation"));
    await expect(resolveNeedDisplay(SESSION, foodbank(NEED), "cy")).rejects.toThrow("D1_ERROR");
  });

  it("does not read the need row's other columns into the result", async () => {
    // NeedDisplay is these four keys and nothing else. The result is spread
    // straight into a template context by all three callers, so a spread of
    // the row here would put change_text_original and the rest into the
    // rendered page context -- and would give templates a second, unfiltered
    // spelling of the same text to render by accident.
    const display: NeedDisplay = await resolveNeedDisplay(SESSION, foodbank(NEED), "en");
    expect(Object.keys(display).sort()).toEqual(["changeText", "excessChangeText", "excessTextList", "getChangeText"]);
  });

  it("survives a change_text that arrived as null despite the NOT NULL column", async () => {
    // 0001_core.sql declares change_text NOT NULL, but the `?? ""` guard is
    // load-bearing anyway: this row can also come from a hand-written
    // fixture or a partially-migrated table, and the failure mode without it
    // is a TypeError deep inside resolveNeedText rather than a page that
    // renders with no items.
    const broken = need({ id: 1, change_text: null as unknown as string });
    const display = await resolveNeedDisplay(SESSION, foodbank(broken), "en");
    expect(display.changeText).toBe("");
    expect(display.getChangeText).toBe("");

    // `?? ""` catches undefined as well as null, and undefined is the shape a
    // SELECT that forgot the column produces (a row object with the key
    // absent) rather than one that selected a NULL. Both must land on "" --
    // an `=== null` check would let undefined through into the template,
    // where nunjucks would print it as the literal word.
    const absent = need({ id: 1, change_text: undefined as unknown as string, excess_change_text: undefined });
    const display2 = await resolveNeedDisplay(SESSION, foodbank(absent), "en");
    expect(display2.changeText).toBe("");
    expect(display2.getChangeText).toBe("");
    expect(display2.excessChangeText).toBeNull();
    expect(display2.excessTextList).toEqual([]);
  });

  it("returns the same four keys for every locale, translated or not", async () => {
    // The shape test above runs only in English, where the translation
    // branch is skipped entirely -- so it cannot see an extra key added on
    // the cy/ga/gd path (a `translation` or `language` field spread in for
    // debugging, say). All three callers spread this straight into a
    // template context, so a key that appears only on the translated pages
    // is a difference that would show up in prod and in no test.
    db.getNeedTranslation.mockResolvedValue(translation({ change_text: "Cawl tun", excess_change_text: "Ffa pob" }));
    for (const locale of NON_ENGLISH) {
      const display = await resolveNeedDisplay(SESSION, foodbank(NEED), locale);
      expect(Object.keys(display).sort()).toEqual(["changeText", "excessChangeText", "excessTextList", "getChangeText"]);
    }
  });
});
