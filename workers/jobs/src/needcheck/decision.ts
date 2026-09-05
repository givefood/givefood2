import { keysEqual, needItemsKey } from "@givefood/models";

// crawlers.py:486-538, stages 8-9 of the pipeline (PLAN.md §8.5.3) --
// extracted as a pure function (no D1/network access) so it can be unit
// tested directly against the extraction outputs, independent of the
// scrape/OpenRouter/DB plumbing around it.

export interface PriorNeed {
  changeText: string;
  excessChangeText: string | null;
}

export type NeedDecision =
  | { kind: "empty_extraction_skip" } // S6: never wipe a real published need on an empty extraction
  | { kind: "no_change" }
  | { kind: "nonpertinent" }
  | { kind: "change"; needText: string; excessText: string };

export function decideNeedChange(params: {
  needText: string;
  excessText: string;
  lastPublished: PriorNeed | null;
  lastUnpublished: PriorNeed[];
}): NeedDecision {
  const { needText, excessText, lastPublished, lastUnpublished } = params;

  // S6.
  if (!needText && !excessText && lastPublished && (lastPublished.changeText || lastPublished.excessChangeText)) {
    return { kind: "empty_extraction_skip" };
  }

  const needKey = needItemsKey(needText);
  const excessKey = needItemsKey(excessText);

  // S7: suppress a repeat of something already sitting unreviewed.
  let isNonpertinent = false;
  for (const prev of lastUnpublished) {
    if (keysEqual(needKey, needItemsKey(prev.changeText)) && keysEqual(excessKey, needItemsKey(prev.excessChangeText))) {
      isNonpertinent = true;
    }
  }

  let isChange = false;
  if (lastPublished === null) {
    if (needText || excessText) isChange = true;
  } else {
    if (!keysEqual(needKey, needItemsKey(lastPublished.changeText))) isChange = true;
    if (!keysEqual(excessKey, needItemsKey(lastPublished.excessChangeText))) isChange = true;
  }

  if (!isChange) return { kind: "no_change" };
  if (isNonpertinent) return { kind: "nonpertinent" };
  return { kind: "change", needText, excessText };
}
