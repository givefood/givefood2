// gfoffline/templates/foodbank_need_prompt.txt (4,663 bytes), rendered via
// Django's render_to_string() at crawlers.py:414-423. PLAN.md §8.5.7 flags
// this as the strictest-fidelity template in the whole port -- "a
// whitespace change in the prompt changes what the model extracts, and
// the June 2026 incident is what that looks like" -- so this isn't
// hand-transcribed from a read of the .txt file: every branch below was
// verified byte-for-byte against Django's own template engine (rendered
// standalone via django.template.backends.django.DjangoTemplates,
// bypassing the app's settings.py) for all 4 (last_need present/absent) x
// (excess present/absent) combinations, and for all three scrape_type
// values. Do not hand-edit the constants below without re-verifying the
// same way.
//
// WITH ONE DELIBERATE EXCEPTION, DECIDED AND NOT INHERITED: THIS DOES NOT
// HTML-ESCAPE (github #17). "Byte-for-byte" above is true of the template's
// STRUCTURE and false at its three interpolation sites. Django's
// settings.py:118-135 passes no "autoescape" key, so autoescape defaults to
// True and render_to_string applies it -- the .txt extension is irrelevant
// for the Django backend, unlike Jinja2 -- and Django's live prompt
// therefore contains "Tea &amp; Coffee", "We&#x27;re short of" and
// "&quot;UHT&quot;" wherever a page or a previous need carries & < > " or '.
// Confirmed by rendering the real gfoffline template standalone, not
// inferred: escape() maps, in order, & -> &amp;, < -> &lt;, > -> &gt;,
// " -> &quot;, ' -> &#x27; (note &#x27;, not &apos;). That is essentially
// every food bank -- apostrophes are ordinary English prose and "Tea &
// Coffee" is one of the commonest lines in the corpus.
//
// The port sends the raw characters, on purpose. The escaped form fights
// the prompt's own instructions, which are three lines of this same file:
// "copy out, verbatim", "keeping each item's own words intact", and
// line 40's 'Do not replace "&" with "and" ... Keep ampersands as written'.
// Handing the model &amp; and then telling it to copy verbatim invites it to
// echo the entity back -- and the "Use Title Case" rule turns that into
// "&Amp;", which Python's html.unescape does NOT decode (only &amp; and
// &AMP; do), so stage 7's cleanFoodbankNeedText cannot undo it and the
// entity reaches published need text. Verified in python3.
//
// THE COST OF THE CHOICE, so it is not rediscovered as a bug: the Phase 5
// hard gate at PLAN.md §8.5.7 asked for byte-identical prompts across the
// two engines. It cannot hold, and §8.5.7 now says so -- the needparity
// harness normalises those five entities before comparing rather than
// asserting raw identity that would fail on ~100% of the 200 samples for a
// known and chosen reason. prompt.test.ts pins the unescaped behaviour with
// the entity list, so re-adding escaping is a test failure rather than a
// silent reversal.
//
// Not run through @givefood/templates' Nunjucks pipeline: that package
// exists for HTML page rendering (with i18n, page context, precompilation
// for the site Worker) and pulling it into this Worker for one plain-text,
// non-i18n prompt would be a bigger dependency than the problem needs --
// same reasoning WP 4.6 applied to gfwrite's email bodies (hand-written JS
// template strings, not run through Nunjucks).

// Static portion, identical regardless of scrape_type/last_need -- verified
// byte-identical against Django's rendered output up to and including the
// trailing "\n\n\n" after "...any other fields.".
const PROMPT_PREFIX = `You are a careful data-entry clerk for a food bank charity. You are given the text of one page from a food bank's website. Your only job is to copy out, verbatim, the food and household items the food bank says it currently NEEDS (is requesting, is short of, or has on its shopping list) and, separately, any items it says it has in EXCESS (too much of, or asks people to stop donating).

This is a transcription task, not a writing task. Your output must be reproducible: the same page must always produce exactly the same lists. Do not paraphrase, summarise, improve, or normalise the wording. Follow these rules exactly.

WHAT TO INCLUDE
- Include every distinct item the page lists as needed, in the order it appears on the page.
- The list may be called a "shopping list", "most needed", "we need", "urgently needed", "wanted" or similar. If there are several such lists, include them all, in the order they appear, without reordering.
- Food banks also handle non-food items (toiletries, nappies, pet food, cleaning products). Include those too.
- It is fine to have no items. If you genuinely cannot find any needed items, return an empty needed list. If you cannot find any excess items, return an empty excess list. Empty is a valid, correct answer.

PRESERVE THE EXACT WORDING
- Copy each item's words exactly as written on the page. Do NOT abbreviate and do NOT expand: if the page says "Veg" keep "Veg" (not "Vegetables"); if it says "Tinned" keep "Tinned" (not "Tin"); if it says "Tin" keep "Tin".
- Do NOT correct spelling, pluralisation, or word choice in a way that changes the words. Capitalisation (see below) is the ONLY change you may make to the words themselves.
- A previous version of this food bank's list may be shown below under "PREVIOUS LIST". If an item on the current page is the same product as one in that previous list, reuse the previous list's exact wording (and splitting) for it, so an unchanged need stays worded identically over time. Only do this for items that genuinely still appear on the current page — never copy an item from the previous list that is not on the page now.
- Keep text inside brackets/parentheses exactly, attached to the item it belongs to. Never move a parenthetical onto a different item and never drop it.
- Keep any quantities, sizes or units written next to an item (e.g. "Milk (1 litre)", "UHT Milk x2").
- Do not replace "&" with "and", or "and" with "&". Keep ampersands as written.
- Do NOT add urgency or promotional labels of your own. Keep an annotation such as "high demand", "urgent" or an asterisk ONLY if it is actually written on the page next to that item; never invent one and never drop one that is present.
- Remove emoji.

ONE ITEM PER LIST ELEMENT
- Put exactly one item in each element of the needed/excess lists.
- If the page separates items with commas, tildes (~), bullets, or line breaks, split them into separate items — one per element — keeping each item's own words intact. For example "Tea, Coffee, Cordial" becomes three items: "Tea", "Coffee", "Cordial"; and "Pasta ~ Rice ~ Beans" becomes three items: "Pasta", "Rice", "Beans".
- Do NOT split on the word "or" or on a slash ("/"): keep a phrase like "Coffee Or Cordial" or "Jam / Marmalade" as a single item, because it describes one choice.
- Never merge two separately listed items into one element.
- Do not duplicate an item. If the same item appears more than once, include it only once, at its first position.

CAPITALISATION
- Use Title Case: capitalise the first letter of each significant word (e.g. "Tinned Tomatoes", "UHT Milk", "Washing Up Liquid"). This is the only transformation you may apply to the words themselves.

OUTPUT
- Return the needed items and the excess items as the two requested lists. Do not add commentary, headings, or any other fields.


`;

const PREVIOUS_LIST_HEADER = `PREVIOUS LIST (reference for wording only)
This is the list last recorded for this food bank. Use it ONLY to keep wording stable: if an item still appears on the current page, copy its wording from here instead of rephrasing it. Do NOT include an item from this list if it is no longer on the current page, and DO add any new items the current page now lists.

Previously needed:
`;

// The "From this web page..." tail differs by scrape_type only in the
// number of blank lines around {{ foodbank_page }} -- an artefact of the
// source template's three separate, non-elif {% if scrape_type == "..." %}
// blocks (only one of which is ever true), not a meaningful content
// difference. Verified against Django's real rendered output for each of
// the three values rather than derived by hand.
const FROM_PAGE_LABEL = "From this web page describing the food bank's needed and excess items below:";
type ScrapeType = "web" | "facebook" | "bankthefood";
const FROM_PAGE_TAIL: Record<ScrapeType, { before: string; after: string }> = {
  web: { before: "\n\n\n    ", after: "\n\n\n\n\n\n" },
  facebook: { before: "\n\n\n\n\n    ", after: "\n\n\n\n" },
  bankthefood: { before: "\n\n\n\n\n\n\n    ", after: "\n\n" },
};

export interface NeedPromptLastNeed {
  changeText: string;
  excessChangeText: string | null;
}

export function buildNeedPrompt(params: { scrapeType: ScrapeType; foodbankPage: string; lastNeed: NeedPromptLastNeed | null }): string {
  let priming = "";
  if (params.lastNeed) {
    priming = PREVIOUS_LIST_HEADER + params.lastNeed.changeText + "\n\n";
    if (params.lastNeed.excessChangeText) {
      priming += "Previously in excess:\n" + params.lastNeed.excessChangeText + "\n\n";
    }
    priming += "\n";
  }
  const tail = FROM_PAGE_TAIL[params.scrapeType];
  return PROMPT_PREFIX + priming + FROM_PAGE_LABEL + tail.before + params.foodbankPage + tail.after;
}
