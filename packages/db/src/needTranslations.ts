import type { Session } from "./types";

// Not imported from @givefood/templates's own Locale type -- packages/db
// stays free of a templates dependency (every other locale-typed function
// across this codebase, e.g. @givefood/models' fullNameLocaleAware, inlines
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

// WP 6.4: givefood/utils/general.py:203-221 translate_need() -- delete
// any existing (need, language) row then insert the fresh translation.
// Delete-then-insert, not upsert-on-conflict: Django has no unique
// constraint on (need_id, language) either (that module's own top
// comment already notes the dedup here is purely "the write path always
// clears first", not a DB guarantee), so this matches exactly rather
// than introducing a stricter invariant D1 alone would enforce.
export async function replaceNeedTranslation(
  session: Session,
  params: { needId: number; foodbankId: number | null; language: Locale; changeText: string | null; excessChangeText: string | null },
): Promise<void> {
  await session.prepare("DELETE FROM foodbankchangetranslation WHERE need_id = ? AND language = ?").bind(params.needId, params.language).run();
  await session
    .prepare("INSERT INTO foodbankchangetranslation (need_id, foodbank_id, language, change_text, excess_change_text) VALUES (?, ?, ?, ?, ?)")
    .bind(params.needId, params.foodbankId, params.language, params.changeText, params.excessChangeText)
    .run();
}

export interface NeedTranslationForDisplay {
  language: Locale;
  change_text: string | null;
  excess_change_text: string | null;
}

// WP 6.4: gfadmin/views.py:2011-2020 need_translations -- the admin's
// read-only "every stored translation for this need" viewer, unlike the
// two lookups above (which are always scoped to the CURRENT request's one
// locale). Only cy/ga/gd rows ever exist (this module's own top comment),
// so this never returns more than 3 rows.
export async function getAllTranslationsForNeed(session: Session, needId: number): Promise<NeedTranslationForDisplay[]> {
  const result = await session
    .prepare("SELECT language, change_text, excess_change_text FROM foodbankchangetranslation WHERE need_id = ? ORDER BY language")
    .bind(needId)
    .all<NeedTranslationForDisplay>();
  return result.results;
}
