import type { Env } from "../../worker-configuration";

// givefood/utils/ai.py:86-151 openrouter(), scoped to exactly the call
// needcheck makes (crawlers.py:439-449's need_check_kwargs) -- not a
// general-purpose port of every parameter that function accepts.
const NEED_SCHEMA = {
  type: "object",
  properties: {
    needed: {
      type: "array",
      description: "A list of food items the food bank is requesting or has low stock of. Items should be in Title Case and not repeated.",
      items: { type: "string" },
    },
    excess: {
      type: "array",
      description: "A list of food items the food bank has an excess of. Items should be in Title Case and not repeated.",
      items: { type: "string" },
    },
  },
  required: ["needed", "excess"],
} as const;

export interface NeedExtraction {
  needed: string[];
  excess: string[];
}

export type OpenRouterOutcome =
  | { kind: "ok"; need: NeedExtraction }
  | { kind: "retryable" } // caller should msg.retry()
  | { kind: "permanent"; reason: string }; // caller should not retry (e.g. 402 -- WP 5.4)

// crawlers.py:451-474's two-attempt loop, folded together with ai.py's
// payload construction. temperature/seed/model/require_parameters are all
// load-bearing (PLAN.md §8.5.3 stage 5 table) -- do not change any of them
// without re-benchmarking against the same prompt/schema.
export async function extractNeed(env: Env, prompt: string): Promise<OpenRouterOutcome> {
  const body = {
    model: "openai/gpt-oss-120b",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    seed: 1,
    response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: NEED_SCHEMA } },
    // NON-NEGOTIABLE (ai.py:129-139). Without it OpenRouter can route to a
    // provider that ignores response_format and answers in prose -- a 200
    // with unparseable content, measured at roughly 1 call in 10.
    provider: { require_parameters: true },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENROUTER_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(65_000),
      });
    } catch {
      if (attempt + 1 < 2) continue;
      return { kind: "retryable" };
    }

    if (!res.ok) {
      // WP 5.4: 402 (insufficient OpenRouter balance) is classified
      // non-retryable -- every one of ~1,024 daily messages would
      // otherwise hit the same 402 and each burn its own retry budget
      // before dead-lettering, which is what cost production two full
      // days in Aug 2026. 401/403 (a rotated/invalid key, a permissions
      // change) fail exactly as uniformly account-wide as a 402 does, so
      // they get the same treatment -- PLAN.md §8.4.4's own classify()
      // design lists both alongside 402, and retrying either just repeats
      // the identical failure at full concurrency for no benefit.
      if (res.status === 402 || res.status === 401 || res.status === 403) {
        return { kind: "permanent", reason: `OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}` };
      }
      if (attempt + 1 < 2) continue; // was sleep(60) in Django -- a Worker must not block wall clock; the caller retries with a delay instead
      return { kind: "retryable" };
    }

    const json: { choices?: { message?: { content?: string } }[] } = await res.json();
    const content = json.choices?.[0]?.message?.content;
    let parsed: unknown;
    try {
      parsed = content ? JSON.parse(content) : null;
    } catch {
      parsed = null;
    }
    if (isNeedExtraction(parsed)) return { kind: "ok", need: parsed };
    // Unparseable content re-routes on retry -- no sleep, matching
    // crawlers.py:462-464's immediate `continue`.
  }

  // An unparseable reply is a FAILURE, not an empty shopping list (S5) --
  // never returned as { needed: [], excess: [] }.
  return { kind: "retryable" };
}

function isNeedExtraction(value: unknown): value is NeedExtraction {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as NeedExtraction).needed) &&
    Array.isArray((value as NeedExtraction).excess)
  );
}
