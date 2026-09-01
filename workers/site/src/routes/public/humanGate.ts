import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { verifyCsrf } from "../../lib/csrf";
import { validateTurnstile } from "../../lib/turnstile";

// Shared by registerFoodbank.ts and flag.ts -- both forms post through
// POST /human/ (routes/human.ts) first, then arrive here carrying the same
// two fields to check: a csrf_token (this port's own addition -- see
// lib/csrf.ts) and cf-turnstile-response (the widget /human/ rendered).
// verifyCsrf() is local HMAC computation; validateTurnstile() is a real
// network POST to Cloudflare's siteverify endpoint -- short-circuited here
// so a request that already fails CSRF (a stale tab, a replay, a bot
// posting directly without going through /human/) never pays for that
// round-trip.
export async function verifyHumanGate(c: Context<AppEnv>, body: Record<string, string | File>): Promise<boolean> {
  const csrfOk = await verifyCsrf(c, c.env.CSRF_SECRET, typeof body.csrf_token === "string" ? body.csrf_token : undefined);
  if (!csrfOk) return false;
  const turnstileToken = typeof body["cf-turnstile-response"] === "string" ? body["cf-turnstile-response"] : "";
  return await validateTurnstile(c.env.TURNSTILE_SECRET, turnstileToken);
}
