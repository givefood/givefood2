import type { Context } from "hono";
import type { AppEnv } from "../types";
import { hmacSha256HexBytes, timingSafeEqual } from "../lib/hmac";

// givefood `whatsapp_hook` (GET+POST /whatsapp_hook/, untranslated --
// givefood/urls.py:70, outside i18n_patterns). Ported from
// givefood/views.py:1330-1393, but NOT the command processing
// (_handle_subscribe/_handle_unsubscribe, views.py:1398+): those write to
// WhatsappSubscriber (no D1 table yet) and send an outbound confirmation
// via the Graph API (WHATSAPP_TOKEN, a jobs-Worker-only secret per PLAN.md
// §3.1's secret-blast-radius split -- this Worker holds none of the
// dangerous send credentials). That's Phase 5 (crons/need-pipeline) work,
// which PLAN.md's own "Open re-plan" note (just above §10.2.5) says needs
// re-scoping before it starts -- not something to back into via this WP.
//
// WP 4.8's actual scope, matching PLAN.md's G10 acceptance criteria
// exactly: verify, enqueue, return 200 fast. A verified message is handed
// to the "whatsapp-hook" queue (WHATSAPP_Q) for whichever Worker Phase 5
// wires up as its consumer -- this route deliberately declares no consumer
// itself. The enqueue is fired via waitUntil (not awaited in the response
// path, matching routes/media.ts's own JOBS_Q precedent): the response to
// Meta is always exactly 200 regardless of whether the send succeeds, so
// waiting for it first only adds latency, not reliability.
//
// Security work added during the port, not carried over -- Django's real
// view has NO X-Hub-Signature-256 check at all (confirmed directly against
// views.py:1330-1393): "anyone who can POST to it can subscribe or
// unsubscribe an arbitrary phone number and cause outbound WhatsApp
// messages to it" (PLAN.md §9228). Verified here as an HMAC-SHA256 of the
// RAW body bytes (c.req.arrayBuffer(), not a UTF-8-decoded string --
// c.req.text() would lose fidelity if the raw bytes ever contained an
// invalid UTF-8 sequence) using WHATSAPP_APP_SECRET, timing-safe compared
// against the X-Hub-Signature-256 header's "sha256=<hex>" value, before any
// parsing.
//
// IT REALLY IS THE APP SECRET, confirmed by the maintainer 2026-09-05.
// Worth recording because the doubt is easy to re-acquire: WHATSAPP_TOKEN
// (the access token) and this looked alike enough to be mistaken for each
// other, and getting it wrong FAILS CLOSED AND SILENTLY -- every signature
// check would mismatch, every POST would still return 200 to Meta as
// designed below, and the only evidence would be a log line. The App
// Secret is Meta App Dashboard -> Settings -> Basic; the access token is
// under WhatsApp -> API Setup. They are not interchangeable.
//
// Every POST returns exactly 200 regardless of outcome -- PLAN.md is
// explicit: "Keep the always-200 response to Meta (they de-register a
// webhook that stops returning 200), but log rejections." This is a
// deliberate departure from Django's own behaviour (which 400s on invalid
// JSON, views.py:1358-1359) in favour of PLAN.md's explicit reliability
// requirement, not an oversight -- and the whole handler body runs inside a
// single try/catch for exactly this reason: an uncaught exception here
// (e.g. a request body stream erroring mid-read) would otherwise reach
// index.ts's global app.onError and come back as an HTML 500, breaking
// that contract.
export async function whatsappHook(c: Context<AppEnv>): Promise<Response> {
  if (c.req.method === "GET") {
    return handleVerification(c);
  }
  if (c.req.method === "POST") {
    try {
      return await handleInbound(c);
    } catch (err) {
      console.error("whatsapp_hook: unexpected error handling POST", err);
      return new Response(null, { status: 200 });
    }
  }
  return new Response(null, { status: 405 });
}

// views.py:1342-1352. Meta's one-time (and periodic re-)verification
// handshake: echo hub.challenge back as text/plain iff hub.mode=subscribe
// and hub.verify_token matches. An unset WHATSAPP_WEBHOOKVERIFYTOKEN fails
// closed (never treated as a wildcard match), same convention as
// lib/turnstile.ts/lib/csrf.ts's own secret handling -- logged distinctly
// so an unprovisioned secret doesn't read as ordinary failed traffic in the
// Workers logs.
function handleVerification(c: Context<AppEnv>): Response {
  const verifyToken = c.env.WHATSAPP_WEBHOOKVERIFYTOKEN;
  if (!verifyToken) {
    console.error("whatsapp_hook: WHATSAPP_WEBHOOKVERIFYTOKEN not set -- failing verification closed");
    return new Response("Verification failed", { status: 403 });
  }

  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token") ?? "";
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && timingSafeEqual(token, verifyToken)) {
    return new Response(challenge ?? "", { headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Verification failed", { status: 403 });
}

const SIGNATURE_PREFIX = "sha256=";

async function verifySignature(appSecret: string | undefined, rawBody: ArrayBuffer, signatureHeader: string): Promise<boolean> {
  if (!appSecret) return false;
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = signatureHeader.slice(SIGNATURE_PREFIX.length);
  const expected = await hmacSha256HexBytes(appSecret, rawBody);
  return timingSafeEqual(provided, expected);
}

async function handleInbound(c: Context<AppEnv>): Promise<Response> {
  const appSecret = c.env.WHATSAPP_APP_SECRET;
  const signatureHeader = c.req.header("X-Hub-Signature-256") ?? "";

  // Cheap, synchronous checks first -- reject before ever buffering the
  // request body (this is a public, unauthenticated endpoint; no reason to
  // read a POST's full body just to then reject it for a missing header).
  if (!appSecret) {
    console.error("whatsapp_hook: WHATSAPP_APP_SECRET not set -- rejecting POST closed");
    return new Response(null, { status: 200 });
  }
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    console.error("whatsapp_hook: rejected POST -- missing or malformed X-Hub-Signature-256");
    return new Response(null, { status: 200 });
  }

  const rawBody = await c.req.arrayBuffer();
  const verified = await verifySignature(appSecret, rawBody, signatureHeader);
  if (!verified) {
    console.error("whatsapp_hook: rejected POST -- signature mismatch");
    return new Response(null, { status: 200 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    console.error("whatsapp_hook: rejected POST -- body is not valid JSON despite a valid signature");
    return new Response(null, { status: 200 });
  }

  c.executionCtx.waitUntil(
    c.env.WHATSAPP_Q.send(payload).catch((err: unknown) => {
      console.error("whatsapp_hook: failed to enqueue a verified message", err);
    }),
  );
  return new Response(null, { status: 200 });
}
