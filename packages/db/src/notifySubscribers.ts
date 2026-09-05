import type { Session } from "./types";

// The reads and writes behind gfadmin/views.py:1999-2006 -- the three
// notification channels the Notify button fires alongside email:
// Firebase (topic, so one row: the food bank's uuid), web push
// (webpushsubscription) and WhatsApp (whatsappsubscriber).
//
// PAGED, like getConfirmedSubscribersPage() in subscribers.ts, and for the
// same reason: each consumer handles one page and enqueues the next, so a
// food bank with many subscribers is many small messages rather than one
// that runs out of CPU. The counts are small today (49 web push, 51
// WhatsApp across ALL food banks) and the paging is nearly free -- but the
// send path is the one that must not silently truncate if that changes.

// send_firebase_notification() addresses a TOPIC named from the food
// bank's uuid, and every one of the three channels titles its notification
// `f"{need.foodbank.name} needs ..."` -- foodbank.name, NOT full_name()
// (which is what the email subject uses). Verified against
// notifications.py:206, 302 and 559 individually rather than assumed
// consistent with the email path.
export interface FoodbankNotifyTarget {
  uuid: string;
  slug: string;
  name: string;
}

export async function getFoodbankNotifyTarget(session: Session, id: number): Promise<FoodbankNotifyTarget | null> {
  const row = await session
    .prepare("SELECT uuid, slug, name FROM foodbank WHERE id = ?")
    .bind(id)
    .first<FoodbankNotifyTarget>();
  return row ?? null;
}

// notifications.py:401's `WebPushSubscription.objects.filter(foodbank=...)`.
// The three fields RFC 8291 encryption needs, plus the id for the
// 404/410 cleanup below.
export interface NotifiableWebPushSubscription {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function getWebPushSubscriptionsPage(
  session: Session,
  foodbankId: number,
  afterId: number,
  limit: number,
): Promise<NotifiableWebPushSubscription[]> {
  const { results } = await session
    .prepare(
      "SELECT id, endpoint, p256dh, auth FROM webpushsubscription " +
        "WHERE foodbank_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3",
    )
    .bind(foodbankId, afterId, limit)
    .all<NotifiableWebPushSubscription>();
  return results;
}

// notifications.py:419-421 -- a push service answering 404 or 410 is
// telling us the subscription is dead, and Django deletes it. Keeping it
// would mean re-attempting a known-gone endpoint on every future need,
// forever.
export async function deleteWebpushSubscriptionsByIds(session: Session, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  // D1 caps a statement at 100 bound parameters. A page is far smaller
  // than that, but the cap is the reason this takes the page's ids rather
  // than accumulating across the whole fan-out.
  const placeholders = ids.map(() => "?").join(", ");
  const result = await session
    .prepare(`DELETE FROM webpushsubscription WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
  return result.meta.changes;
}

// notifications.py:641's `WhatsappSubscriber.objects.filter(foodbank=...)`.
// No confirmed flag: a WhatsApp subscriber opted in through WhatsApp
// itself, so there is no double-opt-in step to gate on (unlike email).
export interface NotifiableWhatsappSubscriber {
  id: number;
  phone_number: string;
}

export async function getWhatsappSubscribersPage(
  session: Session,
  foodbankId: number,
  afterId: number,
  limit: number,
): Promise<NotifiableWhatsappSubscriber[]> {
  const { results } = await session
    .prepare(
      "SELECT id, phone_number FROM whatsappsubscriber " +
        "WHERE foodbank_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3",
    )
    .bind(foodbankId, afterId, limit)
    .all<NotifiableWhatsappSubscriber>();
  return results;
}

// ============ inbound WhatsApp subscribe / unsubscribe ============
// givefood/views.py:1399-1470's _handle_subscribe/_handle_unsubscribe --
// the commands a person texts the WhatsApp number. Django reaches these
// straight from the webhook view; here they are the queue consumer's
// (workers/jobs/src/queues/whatsappHook.ts).

// `get_or_create(phone_number=, foodbank=)` (views.py:1419-1422), read
// half. Returns the existing row's id, or null.
export async function findWhatsappSubscriber(
  session: Session,
  phoneNumber: string,
  foodbankId: number,
): Promise<number | null> {
  // LIMIT 1 where Django uses .get(). The table has no unique constraint
  // on the pair (migration 0020 explains why), so .get() would raise
  // MultipleObjectsReturned on a duplicate -- see whatsappHook.ts, which
  // documents why that Django behaviour is not reproduced.
  const row = await session
    .prepare("SELECT id FROM whatsappsubscriber WHERE phone_number = ?1 AND foodbank_id = ?2 ORDER BY id LIMIT 1")
    .bind(phoneNumber, foodbankId)
    .first<{ id: number }>();
  return row ? row.id : null;
}

// The create half of get_or_create. `created` is set; `last_notified`
// stays NULL until the first send, matching the Django model's own
// null=True default rather than back-dating it to the subscribe.
export async function insertWhatsappSubscriber(
  session: Session,
  phoneNumber: string,
  foodbankId: number,
  createdIso: string,
): Promise<void> {
  await session
    .prepare("INSERT INTO whatsappsubscriber (phone_number, foodbank_id, created) VALUES (?1, ?2, ?3)")
    .bind(phoneNumber, foodbankId, createdIso)
    .run();
}

// views.py:1460's `subscription.delete()`. Deletes EVERY row for the pair,
// not one -- see whatsappHook.ts on why that is the deliberate choice.
// Returns how many rows went, so the reply can distinguish "you were not
// subscribed" from "done".
export async function deleteWhatsappSubscriber(
  session: Session,
  phoneNumber: string,
  foodbankId: number,
): Promise<number> {
  const result = await session
    .prepare("DELETE FROM whatsappsubscriber WHERE phone_number = ?1 AND foodbank_id = ?2")
    .bind(phoneNumber, foodbankId)
    .run();
  return result.meta.changes;
}

// notifications.py:652-654 -- stamped only for the sends that SUCCEEDED,
// which is why the consumer collects ids as it goes rather than updating
// the whole page. One statement for the page instead of one per
// subscriber: same 100-parameter cap reasoning as the delete above.
export async function setWhatsappLastNotified(session: Session, ids: readonly number[], nowIso: string): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  await session
    .prepare(`UPDATE whatsappsubscriber SET last_notified = ? WHERE id IN (${placeholders})`)
    .bind(nowIso, ...ids)
    .run();
}
