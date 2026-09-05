import { getNeedTranslation, type FoodbankWithLatestNeed, type Session } from "@givefood/db";
import { nonEmptyLines, resolveNeedText } from "@givefood/models";

export interface NeedDisplay {
  changeText: string;
  excessChangeText: string | null;
  getChangeText: string;
  excessTextList: string[];
}

// FoodbankChangeTranslation lookup (needs.py:216-259) -- shared by every
// route that displays a food bank's "items needed" text on a locale-
// prefixed page (foodbank.ts, locationDetail.ts's two handlers). Looks up
// unconditionally whenever locale !== "en" and a latest need exists --
// PLAN.md §6.3.5's own "A real quirk to reproduce, not fix silently" note:
// Django's get_text() looks up a translation for a SENTINEL need too (the
// sentinel-check branch at needs.py:218-219 is unconditionally overwritten
// by the language check that follows it), and translate_need_async runs on
// every publish regardless of change_text content, so a translation row
// for a sentinel need is a real production state, not a hypothetical --
// gating this lookup on "is this a real (non-sentinel) need" silently
// diverges from Django for that case. The resulting oddity PLAN.md also
// documents (a translated "Unknown" failing need_text.njk's literal string
// comparison and rendering as raw text, PLAN.md §6.11 item H) is
// deliberately NOT worked around here -- it's flagged there as its own
// follow-on fix, not something to paper over by skipping the lookup.
//
// Callers should run this concurrently (Promise.all) with any sibling
// has_service_area query -- both are independent D1 round trips.
export async function resolveNeedDisplay(
  session: Session,
  foodbank: FoodbankWithLatestNeed,
  locale: "en" | "cy" | "ga" | "gd",
): Promise<NeedDisplay> {
  const changeText = foodbank.latestNeed?.change_text ?? "";
  const excessChangeText = foodbank.latestNeed?.excess_change_text ?? null;
  const translation =
    locale !== "en" && foodbank.latestNeed ? await getNeedTranslation(session, foodbank.latestNeed.id, locale) : null;
  return {
    changeText,
    excessChangeText,
    getChangeText: resolveNeedText(changeText, translation?.change_text, locale),
    excessTextList: nonEmptyLines(resolveNeedText(excessChangeText, translation?.excess_change_text, locale)),
  };
}
