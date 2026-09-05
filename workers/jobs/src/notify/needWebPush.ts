import {
  deleteWebpushSubscriptionsByIds,
  getFoodbankNotifyTarget,
  getNeedById,
  getWebPushSubscriptionsPage,
  type Session,
} from "@givefood/db";
import type { Env } from "../../worker-configuration";
import { importVapidKey } from "./jwt";
import { buildWebPushPayload, NOTIFICATION_ICON } from "./payload";
import { encryptPayload, vapidAuthorizationHeader } from "./webPushCrypto";

// send_webpush_notification() (givefood/utils/notifications.py:388-430) --
// the browser channel of gfadmin/views.py:2003's Notify. The encryption
// and the VAPID assertion are in webPushCrypto.ts; this is the loop, the
// payload shape and the dead-subscription cleanup.
//
// SELF-PAGING through the queue, same shape as needEmail.ts: one message
// per page of subscriptions, keyset on id, next page enqueued only after
// the current one is sent. Web push is a smaller list than email (49
// subscriptions across every food bank today, against 5,855 email
// subscribers) but each send costs an ECDH, an HKDF chain, an AES-GCM
// encryption and an HTTP round trip -- more CPU per recipient than an
// email, not less.

const PAGE_SIZE = 25;

export interface NotifyNeedWebPushMessage {
  type: "notify-need-webpush";
  needId: number;
  afterId: number;
}

// pywebpush's own default (`ttl=0`), which Django does not override. Zero
// means "deliver now or drop": a browser that is closed when the push
// arrives never sees it. That is a real limitation of what production
// sends today, carried over deliberately rather than quietly improved --
// changing it would make the port send notifications Django would not.
const TTL_SECONDS = 0;

export async function handleNotifyNeedWebPush(msg: NotifyNeedWebPushMessage, env: Env): Promise<void> {
  // notifications.py:293-298 requires all three, and returns (None, None)
  // -- i.e. skips the channel -- if any is missing.
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_ADMIN_EMAIL) {
    console.warn("notify-need-webpush: VAPID credentials not fully set, skipping web push notifications");
    return;
  }

  const session: Session = env.DB.withSession("first-unconstrained");
  const need = await getNeedById(session, msg.needId);
  if (!need?.foodbank_id) {
    console.error(`notify-need-webpush: need ${msg.needId} is missing or has no food bank`);
    return;
  }

  const subscriptions = await getWebPushSubscriptionsPage(session, need.foodbank_id, msg.afterId, PAGE_SIZE);
  if (subscriptions.length === 0) {
    console.log(`notify-need-webpush: need ${msg.needId} done after id ${msg.afterId}`);
    return;
  }

  const foodbank = await getFoodbankNotifyTarget(session, need.foodbank_id);
  if (!foodbank) {
    console.error(`notify-need-webpush: food bank ${need.foodbank_id} not found`);
    return;
  }

  let vapidKey: CryptoKey;
  try {
    vapidKey = await importVapidKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
  } catch (err) {
    // A malformed key fails identically for every subscriber and every
    // page, so this returns rather than throwing: retrying would re-read
    // the same secret and fail the same way, three times, into the DLQ.
    console.error("notify-need-webpush: VAPID key could not be imported", err);
    return;
  }

  const built = buildWebPushPayload(foodbank, need.change_text, env.SITE_DOMAIN);
  // _build_webpush_payload()'s exact keys (notifications.py:337-343).
  // `head`, not `title` -- django-webpush's own convention, and what the
  // site's service worker reads; renaming it would silently produce
  // notifications with no heading.
  const payload = JSON.stringify({
    head: built.title,
    body: built.body,
    icon: NOTIFICATION_ICON,
    url: built.url,
    // `need_id` is the dashless UUID; a tag makes a second notification
    // about the SAME need replace the first rather than stack.
    tag: `need-${need.need_id}`,
  });

  const subject = `mailto:${env.VAPID_ADMIN_EMAIL}`;
  const nowMs = Date.now();
  const gone: number[] = [];
  let sent = 0;
  let lastId = msg.afterId;

  for (const subscription of subscriptions) {
    const outcome = await sendOne(subscription, payload, vapidKey, env.VAPID_PUBLIC_KEY, subject, nowMs);
    if (outcome === "sent") sent++;
    if (outcome === "gone") gone.push(subscription.id);
    lastId = subscription.id;
  }

  // Cleaned up per page, not at the end of the fan-out: the last page is
  // the one that enqueues nothing, so an end-of-fan-out cleanup would
  // need state carried across messages to know what to delete.
  if (gone.length > 0) {
    const deleted = await deleteWebpushSubscriptionsByIds(session, gone);
    console.log(`notify-need-webpush: deleted ${deleted} dead subscription(s)`);
  }

  await env.JOBS_Q.send({ type: "notify-need-webpush", needId: msg.needId, afterId: lastId });
  console.log(`notify-need-webpush: need ${msg.needId} sent ${sent}/${subscriptions.length}, next after id ${lastId}`);
}

type SendOutcome = "sent" | "failed" | "gone";

async function sendOne(
  subscription: { id: number; endpoint: string; p256dh: string; auth: string },
  payload: string,
  vapidKey: CryptoKey,
  vapidPublicKey: string,
  subject: string,
  nowMs: number,
): Promise<SendOutcome> {
  let body: Uint8Array;
  let authorization: string;
  try {
    body = await encryptPayload(subscription, payload);
    authorization = await vapidAuthorizationHeader(vapidKey, vapidPublicKey, subscription.endpoint, subject, nowMs);
  } catch (err) {
    // A subscription whose stored p256dh/auth cannot be decoded is
    // corrupt, not merely unreachable. Logged and skipped, NOT deleted:
    // Django only ever deletes on the push service's own 404/410, and a
    // decode bug on this side must not destroy production rows.
    console.error(`notify-need-webpush: could not build message for subscription ${subscription.id}`, err);
    return "failed";
  }

  try {
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(TTL_SECONDS),
      },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(15_000),
    });
    // Push services answer 201 on success; 200 and 202 are accepted too
    // rather than treating a valid-but-unexpected 2xx as a failure.
    if (res.ok) return "sent";
    // notifications.py:419-421 -- these two mean the browser has revoked
    // or replaced the subscription, and it will never work again.
    if (res.status === 404 || res.status === 410) {
      console.log(`notify-need-webpush: subscription ${subscription.id} is gone (HTTP ${res.status})`);
      return "gone";
    }
    console.error(`notify-need-webpush: subscription ${subscription.id} failed (HTTP ${res.status}): ${await res.text()}`);
    return "failed";
  } catch (err) {
    console.error(`notify-need-webpush: subscription ${subscription.id} could not be reached`, err);
    return "failed";
  }
}
