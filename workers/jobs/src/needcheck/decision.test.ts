import { describe, expect, it } from "vitest";
import { decideNeedChange, type NeedDecision, type PriorNeed } from "./decision";

// This function is the sharp end of the whole needcheck pipeline: its return
// value decides whether ~1,024 food banks' live shopping lists are left
// alone, or replaced by whatever a language model returned this afternoon.
// PLAN.md §8.5.6 calls the June 2026 incident "a silent-corruption failure a
// naive port would not have caught either" -- nothing here fails loudly, so
// the tests have to be the thing that notices.
//
// Every case below is written against the Django ancestor the module cites,
// givefood/utils/crawlers.py:486-538 (do_foodbank_need_check), and the two
// safeguards PLAN.md §8.5.4 names:
//   S6 -- empty extraction + existing published need -> skip. "The
//         catastrophic case: wiping a live shopping list."
//   S7 -- nonpertinent suppression against the last 10 unpublished needs.
//         "Queue flooding from re-extraction of the same content."
//
// The comparison itself is delegated to needItemsKey()/keysEqual() (tested in
// packages/models/src/textClean.test.ts). What is tested HERE is the wiring:
// which comparison is made against which record, and which of the four
// outcomes wins when more than one condition holds.

// Defaults chosen so each test states only the fields it is actually about:
// nothing extracted, nothing published, nothing awaiting review.
function decide(params: {
  needText?: string;
  excessText?: string;
  lastPublished?: PriorNeed | null;
  lastUnpublished?: PriorNeed[];
}): NeedDecision {
  return decideNeedChange({
    needText: params.needText ?? "",
    excessText: params.excessText ?? "",
    lastPublished: params.lastPublished ?? null,
    lastUnpublished: params.lastUnpublished ?? [],
  });
}

describe("decideNeedChange -- S6, the empty-extraction guard", () => {
  it("refuses to act on an all-empty extraction when a real need is published", () => {
    // crawlers.py:486-514. A blocked render, an anti-bot interstitial that
    // slipped past the challenge-marker check, or a provider blip that still
    // returned valid JSON all look identical here: {needed: [], excess: []}.
    // Reading that as "this food bank needs nothing" is the failure mode the
    // whole safeguard exists for -- the caller turns this kind into a
    // discrepancy for a human, and leaves the published need untouched.
    expect(decide({ lastPublished: { changeText: "Beans\nRice\nNappies", excessChangeText: null } })).toEqual({
      kind: "empty_extraction_skip",
    });
  });

  it("fires on a published excess list alone, not just a published need list", () => {
    // Django's guard is `(last_published_need.change_text or
    // last_published_need.excess_change_text)` -- a food bank that publishes
    // only an excess ("we have too much pasta") is just as wipeable.
    expect(decide({ lastPublished: { changeText: "", excessChangeText: "Pasta" } })).toEqual({
      kind: "empty_extraction_skip",
    });
  });

  it("needs BOTH halves of the extraction to be empty before it protects anything", () => {
    // Deliberately faithful to `if not need_text and not excess_text`: a
    // half-empty extraction is NOT protected. An extraction that lost the
    // needs list but found an excess line still overwrites the published
    // shopping list with nothing. If someone ever tightens the guard to
    // per-field, this test is the record that today it is all-or-nothing.
    const decision = decide({
      excessText: "Pasta",
      lastPublished: { changeText: "Beans\nRice", excessChangeText: null },
    });
    expect(decision).toEqual({ kind: "change", needText: "", excessText: "Pasta" });
  });

  it("has nothing to protect when no need has ever been published", () => {
    // First-ever crawl of a food bank whose page genuinely lists nothing.
    // Skipping here would be wrong -- there is no live list at risk, and the
    // caller must still close the crawl item and stamp last_need_check.
    expect(decide({ lastPublished: null })).toEqual({ kind: "no_change" });
  });

  it("does not fire when the published record is itself blank on both fields", () => {
    // Production has placeholder rows. An empty extraction matching an empty
    // published record is a genuine no-op, and must fall through to the key
    // comparison rather than raising a discrepancy every single day for a
    // food bank that has published nothing.
    expect(decide({ lastPublished: { changeText: "", excessChangeText: "" } })).toEqual({ kind: "no_change" });
    expect(decide({ lastPublished: { changeText: "", excessChangeText: null } })).toEqual({ kind: "no_change" });
  });

  it("answers before the review queue is even consulted, so S6 outranks S7", () => {
    // Ordering that matters, and that no single-condition test can see: S6
    // wins over a queued row that also matches. Two consecutive failed
    // renders are the realistic setup -- yesterday's empty extraction is
    // sitting unreviewed, today's matches it exactly, so S7 alone would
    // answer "nonpertinent": a silent no-op that writes no discrepancy and
    // tells nobody the renders are broken. S6 answering first is what makes
    // the caller raise the discrepancy on the repeat too, not just on the
    // first day.
    //
    // Precisely: what is pinned is the DISPATCH order, not the source
    // order. Moving the S6 block down past the nonpertinent loop is
    // unobservable (the loop only sets a flag); moving it past the
    // `if (isNonpertinent) return` below it flips this case to
    // "nonpertinent" -- verified by mutation, and this test plus the
    // punctuation-only one are the only two that notice.
    const decision = decide({
      lastPublished: { changeText: "Beans\nRice", excessChangeText: null },
      lastUnpublished: [{ changeText: "", excessChangeText: null }],
    });
    expect(decision).toEqual({ kind: "empty_extraction_skip" });
  });

  it("protects a published record whose text has no alphanumerics in it at all", () => {
    // S6 tests the published side for raw truthiness (Django's
    // `last_published_need.change_text or ...`), NOT for a non-empty
    // need_items_key -- and the two disagree, because needItemsKey("-") is
    // the EMPTY set. A hand-entered placeholder row therefore still counts
    // as "something is published", and an empty extraction raises a
    // discrepancy rather than passing silently as a no-op. Rewriting the
    // guard as `needItemsKey(lastPublished.changeText).size > 0` reads like
    // a tidy-up and would quietly turn this into "no_change".
    expect(decide({ lastPublished: { changeText: "-", excessChangeText: null } })).toEqual({
      kind: "empty_extraction_skip",
    });
  });

  it("is bypassed by an extraction that is punctuation only, because that is not falsy", () => {
    // Documented, not endorsed (see the suspected-bug note in this module's
    // test report). "-" is a truthy string, so S6 stands down; but
    // needItemsKey("-") strips every non-alphanumeric character and yields
    // the EMPTY set, so the comparison below sees "the list is now empty"
    // and reports a change -- exactly the wipe S6 exists to prevent, via a
    // model that answered {needed: ["-"]} instead of {needed: []}.
    // Django behaves identically at crawlers.py:486; this pins the port to
    // it rather than silently diverging.
    const decision = decide({
      needText: "-",
      lastPublished: { changeText: "Beans\nRice", excessChangeText: null },
    });
    expect(decision).toEqual({ kind: "change", needText: "-", excessText: "" });
  });
});

describe("decideNeedChange -- the first published need", () => {
  it("treats any scraped content as a change when nothing is published yet", () => {
    // crawlers.py:526-529, change_state "First need". Note there is no key
    // comparison on this branch: with no published record there is nothing
    // to compare against, so raw truthiness of the text decides.
    expect(decide({ needText: "Beans\nRice" })).toEqual({ kind: "change", needText: "Beans\nRice", excessText: "" });
  });

  it("counts an excess-only extraction as that first change", () => {
    // `if need_text or excess_text` -- a food bank whose first ever
    // extraction is "we have too much pasta" must still reach the review
    // queue, not be dropped for having an empty needs list.
    expect(decide({ excessText: "Pasta" })).toEqual({ kind: "change", needText: "", excessText: "Pasta" });
  });

  it("counts punctuation-only text as a first need, because this branch tests truthiness not the key", () => {
    // crawlers.py:526's `if need_text or excess_text` is the ONLY branch in
    // the function that does not go through need_items_key, and the two
    // measures disagree on "-": truthy string, empty key. So a model that
    // answered {needed: ["-"]} for a food bank with no history writes a real
    // foodbankchange row whose comparison key is empty -- and once a human
    // publishes it, the next crawl of the same "-" reads as no_change
    // against it (both keys empty), so it lands once and then sits there.
    // Anyone rewriting this branch as `needKey.size || excessKey.size` for
    // symmetry with the branch below would change that first row into a
    // no_change; this pins which of the two Django does.
    expect(decide({ needText: "-", lastPublished: null })).toEqual({ kind: "change", needText: "-", excessText: "" });
  });

  it("reports no change when there is nothing published and nothing extracted", () => {
    // The common steady state for a food bank that never lists anything:
    // no row is written, the crawl item is just closed.
    expect(decide({})).toEqual({ kind: "no_change" });
  });
});

describe("decideNeedChange -- comparison against the last published need", () => {
  const published: PriorNeed = { changeText: "Beans\nRice\nNappies", excessChangeText: "Pasta" };

  it("reports no change for a byte-identical re-extraction", () => {
    // The overwhelmingly common daily outcome -- ~1,024 food banks crawled,
    // a handful of real changes. If this ever returned "change" the review
    // queue floods with a thousand identical needs overnight.
    expect(decide({ needText: published.changeText, excessText: "Pasta", lastPublished: published })).toEqual({
      kind: "no_change",
    });
  });

  it("ignores pure reordering of the items", () => {
    // crawlers.py:531-532's stated reason for need_items_key: model output
    // order drifts between providers even at temperature 0 with a fixed
    // seed (the seed pins sampling, not routing -- PLAN.md §8.5.2). Order
    // drift is not news to a human reviewer.
    expect(decide({ needText: "Nappies\nBeans\nRice", excessText: "Pasta", lastPublished: published })).toEqual({
      kind: "no_change",
    });
  });

  it("ignores separator and capitalisation drift inside a single item", () => {
    // "Beans / Rice" vs "Beans - Rice" reduce to the same key. Same for
    // "Tinned Tomatoes (400g)" vs "tinned tomatoes 400g" -- punctuation,
    // case and spacing are all stripped.
    const before: PriorNeed = { changeText: "Beans / Rice\nTinned Tomatoes (400g)", excessChangeText: null };
    expect(decide({ needText: "Beans - Rice\ntinned tomatoes 400g", lastPublished: before })).toEqual({
      kind: "no_change",
    });
  });

  it("reports a change when an item is added", () => {
    const decision = decide({
      needText: "Beans\nRice\nNappies\nUHT Milk",
      excessText: "Pasta",
      lastPublished: published,
    });
    expect(decision).toEqual({ kind: "change", needText: "Beans\nRice\nNappies\nUHT Milk", excessText: "Pasta" });
  });

  it("reports a change when an item is removed", () => {
    // needItemsKey compares sets, and keysEqual short-circuits on size --
    // a strict subset must not read as equal.
    expect(decide({ needText: "Beans\nRice", excessText: "Pasta", lastPublished: published })).toEqual({
      kind: "change",
      needText: "Beans\nRice",
      excessText: "Pasta",
    });
  });

  it("reports a change when only the EXCESS list moved", () => {
    // Two independent `if`s in Django, not an else-if: the needs list being
    // unchanged must not mask a changed excess list. A regression that
    // collapsed these into one condition would silently stop tracking
    // excess entirely, and nothing else in the pipeline would notice.
    const decision = decide({ needText: published.changeText, excessText: "Coffee", lastPublished: published });
    expect(decision).toEqual({ kind: "change", needText: published.changeText, excessText: "Coffee" });
  });

  it("treats a NULL published excess and an empty extracted excess as equal", () => {
    // Real production shape: most foodbankchange rows carry NULL excess.
    // needItemsKey(null) is the empty set, same as needItemsKey("") -- if
    // NULL ever compared as "different from empty", every food bank without
    // an excess list would report a change on every single crawl.
    expect(decide({ needText: "Beans", excessText: "", lastPublished: { changeText: "Beans", excessChangeText: null } })).toEqual({
      kind: "no_change",
    });
  });

  it("compares placeholder published records literally, because filtering them is the PROMPT's job", () => {
    // needcheckRender.ts:152 drops "Facebook"/"Unknown"/"Nothing" records
    // before priming the prompt (crawlers.py:409-411) -- but that filter is
    // NOT applied to the comparison here, in either codebase. So a legacy
    // "Facebook" placeholder is compared verbatim, and the first real
    // extraction for that food bank correctly reads as a change rather than
    // being suppressed against a record that was never a shopping list.
    const decision = decide({ needText: "Beans", lastPublished: { changeText: "Facebook", excessChangeText: null } });
    expect(decision).toEqual({ kind: "change", needText: "Beans", excessText: "" });
  });

  it("passes the extracted text through verbatim rather than the normalised key", () => {
    // The comparison key is lowercased and stripped of punctuation; the
    // text handed to insertFoodbankChange() is what a human reviews and
    // what the public page eventually shows, so it must be the original
    // wording, capitalisation and line breaks -- not the key.
    const needText = "Tinned Tomatoes (400g)\nUHT Milk";
    const decision = decide({ needText, excessText: "Baked Beans", lastPublished: null });
    expect(decision).toEqual({ kind: "change", needText, excessText: "Baked Beans" });
  });
});

describe("decideNeedChange -- S7, nonpertinent suppression", () => {
  const published: PriorNeed = { changeText: "Beans", excessChangeText: null };

  it("suppresses a repeat of something already sitting unreviewed", () => {
    // crawlers.py:521-524, and PLAN.md §8.5.5: "The nonpertinent check IS
    // the dedup" for a Cloudflare Queues redelivery -- there is no unique
    // constraint on (foodbank, created). A redelivered message re-extracts
    // the same deterministic text, finds the row the first delivery already
    // wrote, and must not write a second one.
    const alreadyQueued: PriorNeed = { changeText: "Beans\nRice", excessChangeText: "Pasta" };
    expect(
      decide({
        needText: "Beans\nRice",
        excessText: "Pasta",
        lastPublished: published,
        lastUnpublished: [alreadyQueued],
      }),
    ).toEqual({ kind: "nonpertinent" });
  });

  it("requires BOTH the need and the excess to match the queued row", () => {
    // The `&&` in the loop. A repeat need paired with a genuinely new
    // excess list is new information for the reviewer, and suppressing it
    // would lose the excess change permanently -- nothing re-queues it.
    const decision = decide({
      needText: "Beans\nRice",
      excessText: "Coffee",
      lastPublished: published,
      lastUnpublished: [{ changeText: "Beans\nRice", excessChangeText: "Pasta" }],
    });
    expect(decision).toEqual({ kind: "change", needText: "Beans\nRice", excessText: "Coffee" });
  });

  it("finds the queued match at EVERY position in the window, not just the last", () => {
    // The caller passes the last 10 unpublished needs (crawlers.py:484's
    // [:10], NONPERTINENT_WINDOW in needcheckRender.ts). The loop ORs into
    // the flag -- `if (...) isNonpertinent = true` -- rather than assigning
    // it. Written as the one-character-shorter `isNonpertinent = keysEqual(
    // ...) && keysEqual(...)`, only the LAST row in the window would decide,
    // and a redelivery sitting behind nine newer needs in a review backlog
    // would sail past S7 and duplicate itself in the queue. That mutant
    // survives a single fixture with the match at the end, so this walks the
    // match through all ten slots. (It also stands in for "the loop has no
    // early break": position 0 is only reached correctly if the scan does
    // not stop at the first non-match either.)
    const filler: PriorNeed[] = Array.from({ length: 9 }, (_, i) => ({
      changeText: `Unrelated ${i}`,
      excessChangeText: null,
    }));
    const queued: PriorNeed = { changeText: "Beans\nRice", excessChangeText: null };
    for (let position = 0; position < 10; position++) {
      const window = [...filler.slice(0, position), queued, ...filler.slice(position)];
      expect(window).toHaveLength(10);
      expect(decide({ needText: "Beans\nRice", lastPublished: published, lastUnpublished: window })).toEqual({
        kind: "nonpertinent",
      });
    }
  });

  it("scans every row it is handed, because the window size belongs to the CALLER", () => {
    // The 10 is needcheckRender.ts's NONPERTINENT_WINDOW (crawlers.py:484's
    // [:10]) and it is applied in the SQL that fetches the rows, not here.
    // Verified by mutation: a `lastUnpublished.slice(0, 10)` added inside
    // this function -- the kind of thing someone adds to "enforce the
    // documented window" -- passes every other test in this file, because
    // none of them hands it more than ten rows. It would then silently cap
    // the dedup: widening NONPERTINENT_WINDOW to survive a longer review
    // backlog would appear to work, change nothing, and let redeliveries
    // duplicate themselves in the queue exactly as before.
    const window: PriorNeed[] = [
      ...Array.from({ length: 24 }, (_, i) => ({ changeText: `Unrelated ${i}`, excessChangeText: null })),
      { changeText: "Beans", excessChangeText: null },
    ];
    expect(decide({ needText: "Beans", lastPublished: { changeText: "Rice", excessChangeText: null }, lastUnpublished: window })).toEqual({
      kind: "nonpertinent",
    });
  });

  it("does not report a match when the window is full of near-misses", () => {
    // The negative half of the test above: ten rows that all share a token
    // with the extraction but none of which IS the extraction. keysEqual
    // compares sizes first and then membership, so a subset ("Beans") and a
    // superset ("Beans\nRice\nPasta") both have to miss. Without this, a
    // loop that had been "fixed" into always setting the flag would still
    // look green.
    const window: PriorNeed[] = [
      { changeText: "Beans", excessChangeText: null },
      { changeText: "Rice", excessChangeText: null },
      { changeText: "Beans\nRice\nPasta", excessChangeText: null },
      ...Array.from({ length: 7 }, (_, i) => ({ changeText: `Beans\nRice ${i}`, excessChangeText: null })),
    ];
    expect(decide({ needText: "Beans\nRice", lastPublished: published, lastUnpublished: window })).toEqual({
      kind: "change",
      needText: "Beans\nRice",
      excessText: "",
    });
  });

  it("matches queued rows order- and separator-insensitively too", () => {
    // Same need_items_key comparison as the published check, so provider
    // drift between two runs of the SAME content still dedups. This is the
    // drift PLAN.md §8.5.2 says the fixed seed cannot pin, because it does
    // not pin which provider serves the request.
    expect(
      decide({
        needText: "Rice\nbeans / peas",
        lastPublished: published,
        lastUnpublished: [{ changeText: "Beans - Peas\nRice", excessChangeText: null }],
      }),
    ).toEqual({ kind: "nonpertinent" });
  });

  it("treats a queued row's NULL excess as equal to an empty extracted excess", () => {
    // Rows written by insertFoodbankChange can carry NULL excess, so the
    // dedup has to survive that or a redelivery slips straight past S7.
    expect(
      decide({
        needText: "Beans\nRice",
        excessText: "",
        lastPublished: published,
        lastUnpublished: [{ changeText: "Beans\nRice", excessChangeText: null }],
      }),
    ).toEqual({ kind: "nonpertinent" });
  });

  it("does not let a queued row's NULL excess stand in for an excess it never had", () => {
    // The negative half of the test above, and the one S7 mutant the
    // positive half cannot see. needItemsKey(null) is the empty set, so a
    // NULL excess is equal to "" -- and to NOTHING else. A "be forgiving
    // about the NULL excess" tidy-up in the loop (an added
    // `|| prev.excessChangeText === null`) reads as harmless and survives
    // every other S7 case in this file, because all of them pair a matching
    // need with a queued row that HAS an excess. Here the queued row's is
    // NULL and today's extraction found a real one: the food bank has begun
    // declaring a surplus, which is new information for the reviewer.
    // Suppressing it loses that permanently -- nothing re-queues an
    // extraction once it has been judged nonpertinent.
    const decision = decide({
      needText: "Beans\nRice",
      excessText: "Pasta",
      lastPublished: published,
      lastUnpublished: [{ changeText: "Beans\nRice", excessChangeText: null }],
    });
    expect(decision).toEqual({ kind: "change", needText: "Beans\nRice", excessText: "Pasta" });
  });

  it("dedups on the KEY, so an empty-keyed extraction matches a genuinely blank queued row", () => {
    // S7 compares need_items_key values, not text, and every extraction
    // whose key is empty is therefore interchangeable with every other one.
    // Concretely: a model that answered {needed: ["-"]} walks past S6 (see
    // the S6 block above -- "-" is truthy) and reads as a wipe of the
    // published list, but if ANY blank row is sitting unreviewed -- and
    // blank rows are exactly what a previous bad day leaves behind -- the
    // wipe is suppressed as a repeat rather than queued. Worth pinning in
    // both directions: it is the reason a "skip rows with an empty key"
    // guard in the loop, which looks like an obvious optimisation, is a
    // behaviour change and not a speed-up.
    const wipeable: PriorNeed = { changeText: "Beans\nRice", excessChangeText: null };
    const blankQueued: PriorNeed[] = [{ changeText: "", excessChangeText: null }];
    expect(decide({ needText: "-", lastPublished: wipeable, lastUnpublished: blankQueued })).toEqual({
      kind: "nonpertinent",
    });
    // And the half that keeps that from becoming a blanket suppression: a
    // blank queued row must not swallow a real extraction. If it did, one
    // stale empty row would silence a food bank's shopping list updates for
    // as long as it stayed unreviewed.
    expect(decide({ needText: "Coffee", lastPublished: published, lastUnpublished: blankQueued })).toEqual({
      kind: "change",
      needText: "Coffee",
      excessText: "",
    });
  });

  it("reports a plain change when the review queue is empty", () => {
    const decision = decide({ needText: "Beans\nRice", lastPublished: published, lastUnpublished: [] });
    expect(decision).toEqual({ kind: "change", needText: "Beans\nRice", excessText: "" });
  });

  it("lets no_change win over nonpertinent when the extraction matches both", () => {
    // Ordering matters for the returned kind: `if (!isChange)` is checked
    // before `if (isNonpertinent)`. Django sets both flags and writes a row
    // only when `is_change and not is_nonpertinent`, so the effect is
    // identical -- no row either way -- but the kind reported to the caller
    // is "no_change", and the caller's logging/branching keys off it.
    expect(
      decide({
        needText: "Beans",
        lastPublished: { changeText: "Beans", excessChangeText: null },
        lastUnpublished: [{ changeText: "Beans", excessChangeText: null }],
      }),
    ).toEqual({ kind: "no_change" });
  });

  it("never suppresses a first-ever need against an unrelated queued row", () => {
    // With nothing published, is_change comes from truthiness alone; S7
    // still applies, so a genuinely different extraction reaches the queue.
    const decision = decide({
      needText: "Beans",
      lastPublished: null,
      lastUnpublished: [{ changeText: "Coffee", excessChangeText: null }],
    });
    expect(decision).toEqual({ kind: "change", needText: "Beans", excessText: "" });
  });

  it("does suppress a first-ever need that is already awaiting review", () => {
    // The redelivery case for a food bank with no published need at all --
    // the first delivery queued it, the second must not queue it twice.
    expect(
      decide({
        needText: "Beans",
        lastPublished: null,
        lastUnpublished: [{ changeText: "Beans", excessChangeText: null }],
      }),
    ).toEqual({ kind: "nonpertinent" });
  });
});

describe("decideNeedChange -- text the ASCII comparison key was not designed for", () => {
  // needItemsKey lowercases and then deletes everything outside [a-z0-9]
  // (text.py:72-88). That is fine for "Tinned Tomatoes (400g)" and strange
  // for anything else; the cases below are the strange ones, pinned because
  // they are exactly what someone would change while "improving" the key,
  // and because each one has a visible consequence for a real food bank.

  it("treats an accented spelling and its plain spelling as DIFFERENT items", () => {
    // Accents are STRIPPED, not folded: "purée" keys as "pure", "puree" as
    // "puree". A model that alternates between the two spellings on
    // successive days therefore produces a change every single day for that
    // food bank -- small, real review-queue churn. Adding an NFD
    // normalisation to the key would be a defensible fix and would flip
    // this test, which is the point: it is a decision, not an accident.
    expect(decide({ needText: "Purée", lastPublished: { changeText: "Puree", excessChangeText: null } })).toEqual({
      kind: "change",
      needText: "Purée",
      excessText: "",
    });
  });

  it("cannot tell two wholly non-Latin lists apart, because both keys are empty", () => {
    // The sharp end of an ASCII-only key. Every character of a Chinese,
    // Arabic or Cyrillic item is stripped, the line yields an empty token,
    // and the token is dropped -- so a list of rice keys identically to a
    // list of soy sauce: the empty set. For a food bank publishing its
    // shopping list in a non-Latin script, changes are invisible to this
    // function and never reach the review queue at all. Django has the
    // same hole (`re.sub(r"[^a-z0-9]", "", ...)` on an un-normalised
    // string); documented here rather than fixed, because fixing it in the
    // port alone would make the two codebases disagree.
    expect(decide({ needText: "醬油", lastPublished: { changeText: "白米", excessChangeText: null } })).toEqual({
      kind: "no_change",
    });
  });

  it("collapses repeated items, because the key is a set and not a list", () => {
    // frozenset in Django, Set here. A page that lists "Beans" in both its
    // "urgent" and "always needed" sections extracts it twice; that must
    // not register as a change against a single published "Beans". A
    // comparison built on sorted arrays would pass every other test in this
    // file and fail only this one.
    expect(
      decide({ needText: "Beans\nBeans\nRice", lastPublished: { changeText: "Rice\nBeans", excessChangeText: null } }),
    ).toEqual({ kind: "no_change" });
  });

  it("survives line-ending and blank-line drift", () => {
    // Scraped pages and model replies both turn up with \r\n, and with
    // blank lines between sections. The key splits on "\n" only, so the
    // stray \r has to be removed by the non-alphanumeric strip, and empty
    // tokens have to be dropped rather than added as "". If either failed,
    // a food bank whose page moved web host would report one whole-list
    // change and then never again -- the kind of one-off noise nobody
    // traces back to a line ending.
    expect(decide({ needText: "Beans\r\nRice", lastPublished: { changeText: "Beans\nRice", excessChangeText: null } })).toEqual({
      kind: "no_change",
    });
    expect(
      decide({ needText: "\nBeans\n\n\nRice\n", lastPublished: { changeText: "Beans\nRice", excessChangeText: null } }),
    ).toEqual({ kind: "no_change" });
  });

  it("compares the whole list, however long, rather than a prefix of it", () => {
    // 500 lines is above anything a real shopping list runs to, which is
    // the point: nothing in this function may short-circuit, sample or
    // truncate. Only the LAST line differs, so any comparison that stopped
    // early -- a slice added "for performance", or a size-only keysEqual --
    // would call this no_change and drop a genuine change on the floor.
    const lines = Array.from({ length: 500 }, (_, i) => `Item ${i}`);
    const published: PriorNeed = { changeText: lines.join("\n"), excessChangeText: null };
    const changed = [...lines.slice(0, 499), "Item 499 large size"].join("\n");
    expect(decide({ needText: lines.join("\n"), lastPublished: published })).toEqual({ kind: "no_change" });
    expect(decide({ needText: changed, lastPublished: published })).toEqual({
      kind: "change",
      needText: changed,
      excessText: "",
    });
  });
});

describe("decideNeedChange -- inputs it must survive", () => {
  it("does not mutate the records it was handed", () => {
    // The caller reuses lastPublished after this call (needcheckRender.ts
    // holds the row for the prompt priming decision), and passes DB rows
    // straight in. A decision function that edited them in place would be
    // a very hard bug to see.
    const lastPublished: PriorNeed = { changeText: "Beans", excessChangeText: "Pasta" };
    const lastUnpublished: PriorNeed[] = [{ changeText: "Rice", excessChangeText: null }];
    decide({ needText: "Coffee", excessText: "Tea", lastPublished, lastUnpublished });
    expect(lastPublished).toEqual({ changeText: "Beans", excessChangeText: "Pasta" });
    expect(lastUnpublished).toEqual([{ changeText: "Rice", excessChangeText: null }]);
  });

  // A full truth table over the four axes that actually branch: the
  // extracted need (empty / real / punctuation-only, the three classes S6
  // and the first-need branch disagree about), the extracted excess,
  // whether anything is published, and whether a matching row is already
  // queued. Every expected value below was derived BY HAND from
  // crawlers.py:486-538 and the PLAN.md §8.5.3 stage-9 listing -- not
  // recorded from a run of this implementation, which would agree with the
  // code however wrong the code became. Twenty-four rows is enough to
  // catch the operator slips (&& for ||, a swapped comparison operand, the
  // two `if`s collapsed into one) that any single hand-written case can
  // miss, and cheap enough to read.
  const PUBLISHED: PriorNeed = { changeText: "Beans", excessChangeText: null };
  const QUEUED: PriorNeed = { changeText: "Beans", excessChangeText: "Pasta" };
  const TABLE: {
    needText: string;
    excessText: string;
    published: PriorNeed | null;
    queued: PriorNeed[];
    expected: NeedDecision["kind"];
    why: string;
  }[] = [
    // Nothing extracted. Only the published record decides, and only S6.
    { needText: "", excessText: "", published: null, queued: [], expected: "no_change", why: "nothing anywhere" },
    { needText: "", excessText: "", published: null, queued: [QUEUED], expected: "no_change", why: "queued row differs; nothing published to change from" },
    { needText: "", excessText: "", published: PUBLISHED, queued: [], expected: "empty_extraction_skip", why: "S6, the catastrophic case" },
    { needText: "", excessText: "", published: PUBLISHED, queued: [QUEUED], expected: "empty_extraction_skip", why: "S6 returns before S7 is consulted" },
    // Excess only. The need half being empty must not mask it.
    { needText: "", excessText: "Pasta", published: null, queued: [], expected: "change", why: "first need, excess half" },
    { needText: "", excessText: "Pasta", published: null, queued: [QUEUED], expected: "change", why: "queued need key {beans} != {}" },
    { needText: "", excessText: "Pasta", published: PUBLISHED, queued: [], expected: "change", why: "need {} vs published {beans}" },
    { needText: "", excessText: "Pasta", published: PUBLISHED, queued: [QUEUED], expected: "change", why: "queued need key does not match" },
    // A real need.
    { needText: "Beans", excessText: "", published: null, queued: [], expected: "change", why: "first need" },
    { needText: "Beans", excessText: "", published: null, queued: [QUEUED], expected: "change", why: "need matches queued row but its excess does not" },
    { needText: "Beans", excessText: "", published: PUBLISHED, queued: [], expected: "no_change", why: "identical to published, NULL excess == empty" },
    { needText: "Beans", excessText: "", published: PUBLISHED, queued: [QUEUED], expected: "no_change", why: "no_change outranks nonpertinent" },
    { needText: "Beans", excessText: "Pasta", published: null, queued: [], expected: "change", why: "first need, both halves" },
    { needText: "Beans", excessText: "Pasta", published: null, queued: [QUEUED], expected: "nonpertinent", why: "S7 on a first-ever need" },
    { needText: "Beans", excessText: "Pasta", published: PUBLISHED, queued: [], expected: "change", why: "only the excess moved" },
    { needText: "Beans", excessText: "Pasta", published: PUBLISHED, queued: [QUEUED], expected: "nonpertinent", why: "S7 suppresses the repeat" },
    // Punctuation only: truthy text, empty key -- the two measures disagree.
    { needText: "-", excessText: "", published: null, queued: [], expected: "change", why: "truthiness, not key, on the first-need branch" },
    { needText: "-", excessText: "", published: null, queued: [QUEUED], expected: "change", why: "key {} does not match queued {beans}" },
    { needText: "-", excessText: "", published: PUBLISHED, queued: [], expected: "change", why: "S6 bypassed; key {} reads as a wipe" },
    { needText: "-", excessText: "", published: PUBLISHED, queued: [QUEUED], expected: "change", why: "same, and no queued match" },
    { needText: "-", excessText: "Pasta", published: null, queued: [], expected: "change", why: "first need" },
    { needText: "-", excessText: "Pasta", published: null, queued: [QUEUED], expected: "change", why: "need key {} != {beans}" },
    { needText: "-", excessText: "Pasta", published: PUBLISHED, queued: [], expected: "change", why: "need key {} vs {beans}" },
    { needText: "-", excessText: "Pasta", published: PUBLISHED, queued: [QUEUED], expected: "change", why: "need key {} != {beans}, so no suppression" },
  ];

  it.each(TABLE)("$expected when need=$needText excess=$excessText -- $why", ({ needText, excessText, published, queued, expected }) => {
    const decision = decideNeedChange({ needText, excessText, lastPublished: published, lastUnpublished: queued });
    // Asserted as the whole object, not just the kind: a "change" must
    // carry the extraction verbatim, and the other three kinds must carry
    // no payload at all (the caller reads decision.needText only after
    // narrowing on kind, so a stray field would type-check and mislead).
    // toStrictEqual rather than toEqual because toEqual ignores keys whose
    // value is undefined -- `{kind: "no_change", needText: undefined}` would
    // satisfy toEqual and make the sentence above false.
    expect(decision).toStrictEqual(expected === "change" ? { kind: "change", needText, excessText } : { kind: expected });
  });

  it("keeps the union of outcomes closed at the four the caller handles", () => {
    // The caller switches on `kind`: it inserts a foodbankchange row only
    // for "change", writes a discrepancy only for "empty_extraction_skip",
    // and does nothing for the other two. A fifth kind would silently do
    // nothing at all -- no discrepancy, no queue entry, no error -- so the
    // table above has to keep exercising all four and produce no others.
    const produced = new Set(
      TABLE.map((row) => decideNeedChange({ needText: row.needText, excessText: row.excessText, lastPublished: row.published, lastUnpublished: row.queued }).kind),
    );
    expect(produced).toEqual(new Set(["empty_extraction_skip", "no_change", "nonpertinent", "change"]));
  });

  it("carries no state between calls -- the table gives the same answers backwards", () => {
    // PLAN.md §8.5.5: "the redelivery path is genuinely safe ONLY because
    // the extraction is deterministic and the nonpertinent check exists".
    // That argument collapses if the decision depends on what was decided
    // before it. Running the same table forwards and backwards is a real
    // test of that; calling one fixture twice in a row (which is what this
    // replaced) would pass against a function that cached its last answer.
    const run = (rows: typeof TABLE) =>
      rows.map((row) => decideNeedChange({ needText: row.needText, excessText: row.excessText, lastPublished: row.published, lastUnpublished: row.queued }));
    const forwards = run(TABLE);
    const backwards = run([...TABLE].reverse()).reverse();
    expect(backwards).toEqual(forwards);
  });

  it("does not quietly read a MISSING published record as 'nothing published'", () => {
    // The null test is `lastPublished === null`, not `!lastPublished`, and
    // the distinction is a safety property rather than a style choice: the
    // null branch skips S6 and the key comparison entirely and calls any
    // non-empty extraction a first need. A caller that fetched the row with
    // `rows[0]` -- undefined, not null, when there is no row -- would under
    // a `!lastPublished` check publish straight over a live shopping list,
    // silently, which is the exact failure S6 exists to prevent. Today that
    // input throws instead: loud, and the queue message retries. Pinned so
    // that a "defensive" `lastPublished ?? null` cannot be added without
    // someone reading this first. (Deliberately not asserting the error
    // type or message -- only that it does not return a decision.)
    expect(() =>
      decideNeedChange({
        needText: "Beans",
        excessText: "",
        lastPublished: undefined as unknown as null,
        lastUnpublished: [],
      }),
    ).toThrow();
  });
});
