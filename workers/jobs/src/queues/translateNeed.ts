import type { Env } from "../../worker-configuration";
import { getNeedById, replaceNeedTranslation } from "@givefood/db";

// "jobs" queue, type "translate-need" -- enqueued by workers/site's
// admin need_publish handler (routes/admin/needs.ts), one message per
// language, per publish. givefood/utils/general.py:179-221's
// get_translation()/translate_need(): a plain GET against Google Cloud
// Translation API v2 (the `google-cloud-translate` SDK Django declares as
// a dependency is imported nowhere -- PLAN.md §2.9's own note not to port
// it), then delete-then-insert the FoodbankChangeTranslation row. Only
// cy/ga/gd ever land here -- this Worker's admin only ever enqueues those
// three (§2.7.1's 4-language scope), never Django's other 16.
const GOOGLE_TRANSLATE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";

export interface TranslateNeedMessage {
  type: "translate-need";
  needId: number;
  language: "cy" | "ga" | "gd";
}

async function translateText(apiKey: string, text: string, targetLanguage: string): Promise<string | null> {
  const url = `${GOOGLE_TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: text, source: "en", target: targetLanguage, format: "text" }).toString(),
  });
  if (!res.ok) throw new Error(`Google Translate API failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data?: { translations?: { translatedText?: string }[] } };
  return json.data?.translations?.[0]?.translatedText ?? null;
}

export async function handleTranslateNeed(message: TranslateNeedMessage, env: Env): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");
  const need = await getNeedById(session, message.needId);
  if (!need) return; // deleted since enqueue -- nothing to translate

  const [changeText, excessChangeText] = await Promise.all([
    translateText(env.GCP_TRANSLATE_KEY, need.change_text, message.language),
    need.excess_change_text ? translateText(env.GCP_TRANSLATE_KEY, need.excess_change_text, message.language) : Promise.resolve(null),
  ]);

  await replaceNeedTranslation(session, {
    needId: need.id,
    foodbankId: need.foodbank_id,
    language: message.language,
    changeText,
    excessChangeText,
  });
}
