-- ==================== 0006_need_translations.sql =========================
-- FoodbankChangeTranslation (givefood/models/needs.py:345-357) --
-- FoodbankChange.get_text()'s per-locale lookup, backing every "items
-- needed"/"they don't need any more" display on a cy/ga/gd page. Follow-up
-- to WP 3's gfwfbn HTML build: nothing had ported this yet, every
-- non-English page was silently falling back to raw English text.
--
-- Only cy/ga/gd rows are loaded -- production also carries 16 other
-- languages (ur/pa/ro/pl/ar/pt/es/bn/gu/bg/lt/it/fr/ta/tr/zh-hans, ~60k more
-- rows) for Django's wider LANGUAGES list, none of which this app serves
-- (§2.7.1: 4 languages, not Django's 21; get_text()'s `current_language ==
-- "en"` branch never queries this table at all, so English needs no rows
-- here either). tools/pg-to-d1/extract_core.py's TRANSLATION_TABLES filters
-- to exactly those 3.
--
-- Indexed (language, need_id), not Postgres's own (need_id, language): every
-- real read here is scoped to the CURRENT request's one locale first (a
-- single need_id lookup for a detail page, or a need_id IN (...) batch for
-- a list page) -- language is always the more selective first predicate.

CREATE TABLE foodbankchangetranslation (
  id INTEGER PRIMARY KEY,
  need_id INTEGER NOT NULL, foodbank_id INTEGER,
  language TEXT NOT NULL,
  change_text TEXT, excess_change_text TEXT
);
CREATE INDEX fct_lang_need_idx ON foodbankchangetranslation(language, need_id);
