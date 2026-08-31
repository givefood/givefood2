import type { Context } from "hono";
import { getFoodbankIdBySlug, upsertWebpushSubscription, deleteWebpushSubscription } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";

// gfwfbn `webpush_config`/`webpush_subscribe`/`webpush_unsubscribe`
// (gfwfbn/views.py:1230-1351). Standard Web Push (VAPID), not the earlier
// Firebase-based web notifications -- see that file's own module comment.

// WebPushSubscription.browser's declared max_length (givefood/models/
// subscribers.py:100) -- Django reads this off the model field at
// runtime; there's no model here to introspect, so the number is just
// carried over directly.
const BROWSER_MAX_LENGTH = 100;

// webpush_subscribe's fix_base64_padding() (gfwfbn/views.py:35-47),
// ported verbatim -- browsers may send p256dh/auth as unpadded base64url.
function fixBase64Padding(s: string): string {
  if (!s) return s;
  const padding = 4 - (s.length % 4);
  return padding !== 4 ? s + "=".repeat(padding) : s;
}

// Shared by webpush_subscribe/webpush_unsubscribe: neither has Django's
// usual @require_POST (see wfbnWebpushSubscribe's own comment below), so
// the method check happens here, in the handler, not the router. Returns
// the resolved foodbank id, or the Response the caller should return
// as-is (400 for a non-POST method, 404 for an unknown slug).
async function requirePostAndFoodbank(c: Context<AppEnv>, session: ReturnType<typeof dbSession>): Promise<number | Response> {
  if (c.req.method !== "POST") return new Response("", { status: 400 });
  const slug = c.req.param("slug")!;
  const foodbankId = await getFoodbankIdBySlug(session, slug);
  return foodbankId === null ? c.notFound() : foodbankId;
}

// Shared JSON-body parse: a malformed body is a 400 in both subscribe and
// unsubscribe, not an uncaught exception.
async function parseJsonBody<T>(c: Context<AppEnv>): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

// `webpush_config` (GET /needs/webpush/config/, no i18n prefix --
// wfbn-generic namespace). Django caches this for an hour
// (@cache_page(SECONDS_IN_HOUR)); the Workers port needs no explicit
// caching layer here (Workers Cache already sits in front of every
// request, PLAN.md §3.6), so this just implements the response.
export async function wfbnWebpushConfig(c: Context<AppEnv>): Promise<Response> {
  const vapidPublicKey = c.env.VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) {
    // Matches Django's own fallback branch exactly (`if not
    // vapid_public_key: return JsonResponse({'error': ...}, status=500)`).
    return c.json({ error: "VAPID not configured" }, 500);
  }
  return c.json({ vapidPublicKey });
}

// `webpush_subscribe` (POST /needs/webpush/subscribe/<slug>/, no i18n
// prefix -- note this is NOT nested under /at/<slug>/, confirmed against
// gfwfbn/urls/generic.py and the real fetch() call in static/js/webpush.js).
// Django's URL pattern for this view has NO method restriction (no
// @require_POST, unlike mobsub.ts's wfbnMobsub) -- the view checks the
// method itself and 400s, so it must be registered with app.all() (or
// equivalent), not app.post() only, or a non-POST request would hit
// Hono's own 404 instead of reaching this check.
export async function wfbnWebpushSubscribe(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const foodbankId = await requirePostAndFoodbank(c, session);
  if (foodbankId instanceof Response) return foodbankId;

  const data = await parseJsonBody<{ endpoint?: unknown; p256dh?: unknown; auth?: unknown; browser?: unknown }>(c);
  if (data === null) return new Response("", { status: 400 });

  const endpoint = typeof data.endpoint === "string" ? data.endpoint : "";
  let p256dh = typeof data.p256dh === "string" ? data.p256dh : "";
  let auth = typeof data.auth === "string" ? data.auth : "";
  const browser = typeof data.browser === "string" ? data.browser : "";

  if (!endpoint || !p256dh || !auth) return new Response("", { status: 400 });

  p256dh = fixBase64Padding(p256dh);
  auth = fixBase64Padding(auth);

  if (!endpoint.startsWith("https://")) return new Response("", { status: 400 });
  try {
    new URL(endpoint);
  } catch {
    return new Response("", { status: 400 });
  }

  const { id, created } = await upsertWebpushSubscription(session, {
    foodbankId,
    endpoint,
    p256dh,
    auth,
    browser: browser ? browser.slice(0, BROWSER_MAX_LENGTH) : null,
  });

  return c.json({ success: true, created, subscription_id: id });
}

// `webpush_unsubscribe` (POST /needs/webpush/unsubscribe/<slug>/, no
// i18n prefix -- same generic namespace as webpush_subscribe above).
export async function wfbnWebpushUnsubscribe(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const foodbankId = await requirePostAndFoodbank(c, session);
  if (foodbankId instanceof Response) return foodbankId;

  const data = await parseJsonBody<{ endpoint?: unknown }>(c);
  if (data === null) return new Response("", { status: 400 });

  const endpoint = typeof data.endpoint === "string" ? data.endpoint : "";
  if (!endpoint) return new Response("", { status: 400 });

  const deleted = await deleteWebpushSubscription(session, { foodbankId, endpoint });
  return c.json({ success: true, deleted });
}
