import { getFoodbankNotifyTarget, getNeedById, type Session } from "@givefood/db";
import type { Env } from "../../worker-configuration";
import { importRs256Key, signJwtRs256 } from "./jwt";
import { buildFirebasePayload, NOTIFICATION_ICON } from "./payload";

// send_firebase_notification() (givefood/utils/notifications.py:189-272) --
// the mobile-app channel of gfadmin/views.py:2000's Notify.
//
// ONE HTTP CALL PER NEED, not per subscriber. FCM addresses a TOPIC
// (`foodbank-<uuid>`) that the apps subscribe themselves to; the server
// never holds a device list, which is why there is no mobilesubscriber
// read here even though that table exists. mobilesubscriber is the
// analytics/"who is watching what" record the /mobsub/ endpoint writes --
// it is not the send list, and treating it as one would notify nobody.
//
// FCM v1, NOT the retired legacy HTTP API. v1 authenticates with an OAuth2
// access token minted from the service account, so this file does what
// firebase-admin's credential layer does for Django: build an RS256
// assertion, exchange it at Google's token endpoint, cache the result.
//
// Failure is LOGGED, NOT RETRIED (the caller acks). Django's task does the
// same -- send_firebase_notification catches every exception and returns
// None. A notification is worth sending once, at the moment the reviewer
// pressed the button; re-sending it an hour later to a topic that may
// already have been notified is worse than not sending it.

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface NotifyNeedFirebaseMessage {
  type: "notify-need-firebase";
  needId: number;
}

// Cached for the isolate's life, keyed by nothing: one Worker has exactly
// one service account. firebase-admin caches the same way (its
// `initialize_app` is guarded by `get_app()`), and an access token is
// valid for an hour -- minting one per message would add an RSA signature
// and a round trip to every send for no benefit.
let cachedToken: { token: string; expiresAtMs: number } | null = null;

function parseServiceAccount(raw: string): ServiceAccount | null {
  let account: ServiceAccount;
  try {
    account = JSON.parse(raw) as ServiceAccount;
  } catch {
    // notifications.py:174-177's json.JSONDecodeError branch, same
    // non-fatal shape: log and send nothing.
    console.error("notify-need-firebase: FIREBASE_SERVICE_ACCOUNT is not valid JSON");
    return null;
  }
  if (!account.project_id || !account.client_email || !account.private_key) {
    console.error("notify-need-firebase: FIREBASE_SERVICE_ACCOUNT is missing project_id/client_email/private_key");
    return null;
  }
  return account;
}

async function getAccessToken(account: ServiceAccount, nowMs: number): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAtMs > nowMs) return cachedToken.token;

  const nowSec = Math.floor(nowMs / 1000);
  const tokenUri = account.token_uri ?? GOOGLE_TOKEN_URL;
  let assertion: string;
  try {
    const key = await importRs256Key(account.private_key);
    assertion = await signJwtRs256(key, {
      iss: account.client_email,
      scope: FCM_SCOPE,
      // `aud` must be the token endpoint itself, not the API being
      // called -- the assertion is addressed to whoever exchanges it.
      aud: tokenUri,
      iat: nowSec,
      exp: nowSec + 3600,
    });
  } catch (err) {
    console.error("notify-need-firebase: could not sign the service-account assertion", err);
    return null;
  }

  let payload: { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  try {
    const res = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }),
      signal: AbortSignal.timeout(15_000),
    });
    payload = (await res.json()) as typeof payload;
    if (!res.ok || !payload.access_token) {
      console.error(`notify-need-firebase: token exchange failed (HTTP ${res.status})`, payload.error, payload.error_description);
      return null;
    }
  } catch (err) {
    console.error("notify-need-firebase: token exchange could not be reached", err);
    return null;
  }

  // 60s of slack so a token that expires mid-flight is refreshed rather
  // than used and rejected.
  const ttlSec = payload.expires_in ?? 3600;
  cachedToken = { token: payload.access_token, expiresAtMs: nowMs + (ttlSec - 60) * 1000 };
  return cachedToken.token;
}

export async function handleNotifyNeedFirebase(msg: NotifyNeedFirebaseMessage, env: Env): Promise<void> {
  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    // notifications.py:170-172: a missing credential is a warning and a
    // return, not an error -- the other three channels still go out.
    console.warn("notify-need-firebase: FIREBASE_SERVICE_ACCOUNT not set, skipping");
    return;
  }

  const account = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
  if (!account) return;

  const session: Session = env.DB.withSession("first-unconstrained");
  const need = await getNeedById(session, msg.needId);
  if (!need?.foodbank_id) {
    console.error(`notify-need-firebase: need ${msg.needId} is missing or has no food bank`);
    return;
  }
  const foodbank = await getFoodbankNotifyTarget(session, need.foodbank_id);
  if (!foodbank) {
    console.error(`notify-need-firebase: food bank ${need.foodbank_id} not found`);
    return;
  }

  const accessToken = await getAccessToken(account, Date.now());
  if (!accessToken) return;

  const payload = buildFirebasePayload(foodbank, need.change_text, env.SITE_DOMAIN);
  const topic = `foodbank-${foodbank.uuid}`;

  // notifications.py:238-269's messaging.Message, field for field. The
  // notification/data/webpush split is not redundancy: `notification` is
  // what a native app renders, `webpush` overrides it for FCM's own
  // browser transport (icon, badge, click link), and `data` is what a
  // handler reads programmatically. All three are addressed to the same
  // topic in one message.
  //
  // FCM v1 requires every `data` value to be a STRING -- the legacy API
  // coerced, v1 rejects. Both maps here are string-valued already.
  const message = {
    message: {
      topic,
      notification: { title: payload.title, body: payload.body },
      data: { foodbank_slug: foodbank.slug },
      webpush: {
        notification: {
          title: payload.title,
          body: payload.body,
          icon: NOTIFICATION_ICON,
          badge: NOTIFICATION_ICON,
        },
        fcm_options: { link: payload.url },
        data: { foodbank_slug: foodbank.slug, click_action: payload.url },
      },
    },
  };

  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.error(`notify-need-firebase: FCM ${res.status} for need ${msg.needId} topic ${topic}: ${await res.text()}`);
      return;
    }
    const body = (await res.json()) as { name?: string };
    console.log(`notify-need-firebase: sent need ${msg.needId} to topic ${topic}: ${body.name ?? "(no name)"}`);
  } catch (err) {
    console.error(`notify-need-firebase: send failed for need ${msg.needId}`, err);
  }
}
