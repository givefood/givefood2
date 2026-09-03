// givefood/models/needs.py:108-132 -- input_method_human()/input_method_emoji(),
// the admin-only labels shown next to a need's origin. Public-facing need
// display (lib/needDisplay.ts) never surfaces input_method at all, so
// these live here rather than there.
const INPUT_METHOD_HUMAN: Record<string, string> = {
  scrape: "Scraped",
  typed: "Typed",
  user: "User",
  ai: "AI",
};

export function inputMethodHuman(method: string): string {
  return INPUT_METHOD_HUMAN[method] ?? method;
}

// givefood/models/needs.py:124-132 -- despite the name, input_method_emoji()
// returns Material Design Icons markup, not a unicode emoji: MDI webfont
// glyphs from the stylesheet admin/page.njk:7 already loads, so they match
// the rest of the admin's iconography and inherit the cell's colour/size.
// These values are therefore HTML, and every template consumer must render
// them through `| safe` (Django does exactly that at need.html:24,
// need_translations.html:28, needs.html:36, foodbank.html:398 and :491, and
// includes/needtable.html:12). Do not "simplify" them back to emoji.
const INPUT_METHOD_EMOJI: Record<string, string> = {
  scrape: '<span class="mdi mdi-spider"></span>',
  typed: '<span class="mdi mdi-keyboard"></span>',
  user: '<span class="mdi mdi-account"></span>',
  ai: '<span class="mdi mdi-robot"></span>',
};

export function inputMethodEmoji(method: string): string {
  // Django's method falls off the end and returns None for an unrecognised
  // value, which `{{ ...|safe }}` renders as empty.
  return INPUT_METHOD_EMOJI[method] ?? "";
}
