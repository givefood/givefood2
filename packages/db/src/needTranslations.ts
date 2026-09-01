import type { Session } from "./types";

// Not imported from @givefood/templates's own Locale type -- packages/db
// stays free of a templates dependency (every other locale-typed function
// across this codebase, e.g. lib/fields.ts's fullNameLocaleAware, inlines
// this same 4-value union rather than importing it).
type Locale = "en" | "cy" | "ga" | "gd";

// FoodbankChangeTranslation (migrations/0006_need_translations.sql) --
// backs FoodbankChange.get_text()'s per-locale lookup (needs.py:216-259).
// Only cy/ga/gd rows exist in D1 (see that migration's comment); English
// never queries this table at all (get_text()'s `current_language == "en"`
// branch reads change_text/excess_change_text directly), so these
// functions are never called for locale === "en" -- callers gate on that
// themselves rather than this module re-checking it per row.
export interface NeedTranslationRow {
  change_text: string | null;
  excess_change_text: string | null;
}

// Single-need lookup -- the food bank/location/donation point detail pages
// (one need_id per request).
export async function getNeedTranslation(session: Session, needId: number, language: Locale): Promise<NeedTranslationRow | null> {
  const row = await session
    .prepare("SELECT change_text, excess_change_text FROM foodbankchangetranslation WHERE language = ? AND need_id = ?")
    .bind(language, needId)
    .first<NeedTranslationRow>();
  return row ?? null;
}

// Batch lookup -- list pages (the /needs/ index, a constituency's food bank
// list, the general RSS feed) that would otherwise N+1 one lookup per row.
// Mirrors foodbankDetail.ts's session.batch()/getFoodbanksByIds's
// WHERE-IN-then-remap precedent: one D1 round trip regardless of how many
// need_ids are asked for, keyed for O(1) per-row lookup by the caller.
export async function getNeedTranslationsByIds(session: Session, needIds: readonly number[], language: Locale): Promise<Map<number, NeedTranslationRow>> {
  if (needIds.length === 0) return new Map();
  const placeholders = needIds.map(() => "?").join(", ");
  const result = await session
    .prepare(`SELECT need_id, change_text, excess_change_text FROM foodbankchangetranslation WHERE language = ? AND need_id IN (${placeholders})`)
    .bind(language, ...needIds)
    .all<{ need_id: number; change_text: string | null; excess_change_text: string | null }>();
  return new Map(result.results.map((row) => [row.need_id, { change_text: row.change_text, excess_change_text: row.excess_change_text }]));
}
