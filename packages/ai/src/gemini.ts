// WP 6.8: a Workers-native replacement for givefood/utils/ai.py's
// gemini() (google-genai Python SDK, ai.py:17-83) -- plain REST, matching
// this codebase's established "SDK doesn't port, call the REST endpoint
// directly" pattern (needTranslations' Google Translate call, WP 6.4;
// PLAN.md §2.9's own note not to port the google-cloud-translate SDK).
// thinkingConfig.thinkingBudget=0 and all four safety categories at
// BLOCK_NONE reproduce ai.py's ThinkingConfig(thinking_budget=0) and
// HarmCategory.*: BLOCK_NONE exactly. NOT verified against a live Gemini
// API call (no key available to this build) -- the request shape below
// is transcribed from Google's REST documentation for generateContent,
// not exercised end-to-end; a real first call is the actual verification,
// same disclosed-risk shape as WP 6.1's OAuth flow (verified up to
// Google's real token endpoint, not with a real client secret).
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiJsonCallParams {
  apiKey: string;
  model: string;
  prompt: string;
  temperature: number;
  responseSchema: unknown;
  // Both default to ai.py's own numbers, which assume a queue consumer.
  // A REQUEST-SCOPED CALLER MUST OVERRIDE THEM -- see the note on the retry
  // below. github #38 made runFoodbankCheck one of those.
  retryDelayMs?: number;
  timeoutMs?: number;
}

const SAFETY_SETTINGS = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map(
  (category) => ({ category, threshold: "BLOCK_NONE" }),
);

// ai.py:59-65's ServerError handling -- one retry after a 60s sleep.
//
// THE 60 SECONDS IS A QUEUE-CONSUMER NUMBER AND IT IS NOW OVERRIDABLE. This
// comment used to say a Workers invocation triggered from a Queue consumer
// "can afford to actually wait out that sleep, unlike a request-scoped
// handler -- this whole call living in a Queue consumer is the point of this
// WP". github #38 moved the food bank check into a request-scoped handler, so
// that sentence stopped being true of every caller: on a Gemini 5xx the
// admin's tab would sit for 60 s doing nothing, then take the retry, then
// most likely be cut off by Cloudflare's ~100 s edge timeout with no page at
// all. Same for the 120 s per-attempt timeout, which is longer than the edge
// will wait in the first place.
//
// So both are parameters now, defaulting to ai.py's values for the queue
// callers that can still afford them (orderLines), and overridden by
// runFoodbankCheck. Defaults rather than required arguments deliberately:
// the queue path should not have to restate a number it already had, and the
// override belongs with the caller that has the constraint.
export async function geminiJsonCall(params: GeminiJsonCallParams): Promise<unknown> {
  const retryDelayMs = params.retryDelayMs ?? 60_000;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const body = {
    contents: [{ parts: [{ text: params.prompt }] }],
    generationConfig: {
      temperature: params.temperature,
      responseMimeType: "application/json",
      responseSchema: params.responseSchema,
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: SAFETY_SETTINGS,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      const res = await fetch(`${GEMINI_ENDPOINT}/${params.model}:generateContent?key=${encodeURIComponent(params.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 500) {
        lastError = new Error(`Gemini server error: ${res.status} ${await res.text()}`);
        continue;
      }
      if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);

      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini response had no text part");
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
