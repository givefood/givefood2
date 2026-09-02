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

const INPUT_METHOD_EMOJI: Record<string, string> = {
  scrape: "\u{1F577}\u{FE0F}", // spider
  typed: "⌨\u{FE0F}", // keyboard
  user: "\u{1F464}", // bust in silhouette
  ai: "\u{1F916}", // robot
};

export function inputMethodEmoji(method: string): string {
  return INPUT_METHOD_EMOJI[method] ?? "";
}
