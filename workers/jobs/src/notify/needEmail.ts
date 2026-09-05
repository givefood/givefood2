import {
  buildNeedEmailContext,
  formatSubscribedDate,
  formatSubscribedTime,
  getConfirmedSubscribersPage,
  getNeedById,
  type Session,
} from "@givefood/db";
import { noItems } from "@givefood/models";
import { render } from "@givefood/templates";
import type { Env } from "../../worker-configuration";

// givefood/utils/notifications.py:24-78 post_to_subscriber, and
// gfadmin/views.py:1993-1997's loop over confirmed subscribers -- the
// notification email 5,855 people receive when a food bank's needs change.
//
// PLAN.md WP 6.4b listed this as not built, alongside Firebase, VAPID web
// push and WhatsApp. Only the email channel is built here; the other three
// remain deferred for the reasons that WP records (no whatsappsubscriber
// table exists, and web push needs RFC 8291's ECDH/HKDF/AES-GCM hand-rolled
// in WebCrypto). Email is 5,855 recipients against 49/47/49 for the rest,
// so it is the channel that matters.
//
// FANS OUT THROUGH THE QUEUE, one message per PAGE of subscribers rather
// than one per subscriber. Django loops in-request and enqueues one
// django-task per email (views.py:1996), which is what makes its runbook
// warn about ~98 outstanding tasks after a single publish. A Worker cannot
// loop in-request at all -- a few hundred Postmark round trips would blow
// the CPU budget -- so the loop lives in the consumer and each message
// re-enqueues the next page. Keyset paging on subscriber id, so a retry
// re-sends at most one page.
//
// AT-LEAST-ONCE, and that is a real consequence: a message that fails
// partway through a page and is retried re-sends to the subscribers already
// done in that page. PAGE_SIZE is small to bound it. Django has the same
// property per-task and the same non-answer; making it exactly-once needs a
// per-subscriber sent marker, which is a schema change and is not worth it
// for a duplicate notification email.

const PAGE_SIZE = 25;

// notifications.py:26-44, verbatim and in order.
const SUBJECT_EMOJI = ["🍝", "🍲", "🍛", "🥫", "🌽", "🥕", "🥔", "🍚", "🍽️", "🍴", "🥘", "🍅", "🫘", "🫛", "🥄", "🥣", "🥧"];

// django.contrib.humanize's apnumber: one to nine as words, everything else
// as digits (notifications.py:47's `apnumber(need.no_items())`).
const AP_NUMBERS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
function apnumber(n: number): string {
  return n >= 1 && n <= 9 ? AP_NUMBERS[n]! : String(n);
}

export interface NotifyNeedEmailMessage {
  type: "notify-need-email";
  needId: number;
  /** Keyset cursor. 0 for the first page; the consumer re-enqueues with the last id it sent to. */
  afterId: number;
}

export async function handleNotifyNeedEmail(msg: NotifyNeedEmailMessage, env: Env): Promise<void> {
  const session: Session = env.DB.withSession("first-unconstrained");

  const need = await getNeedById(session, msg.needId);
  if (!need) {
    console.error(`notify-need-email: need ${msg.needId} no longer exists`);
    return;
  }
  if (!need.foodbank_id) {
    console.error(`notify-need-email: need ${msg.needId} has no food bank`);
    return;
  }

  const subscribers = await getConfirmedSubscribersPage(session, need.foodbank_id, msg.afterId, PAGE_SIZE);
  if (subscribers.length === 0) {
    console.log(`notify-need-email: need ${msg.needId} done after id ${msg.afterId}`);
    return;
  }

  // The context that does NOT vary per subscriber is built once per page --
  // the food bank, the item list, the articles. Only the two subscriber
  // fields change inside the loop.
  const base = await buildNeedEmailContext(session, need, null);
  if (!base) {
    console.error(`notify-need-email: no email context for need ${msg.needId}`);
    return;
  }

  // notifications.py:45-47. The emoji is random PER EMAIL there, because
  // the subject is built inside post_to_subscriber -- so it is random per
  // email here too rather than per page, which would be tidier and wrong.
  // FoodbankChange.no_items() is the item count the subject reports.
  const items = apnumber(noItems(need.change_text));

  let lastId = msg.afterId;
  for (const subscriber of subscribers) {
    // The base context is built once per page -- food bank, item list and
    // articles do not vary by recipient. Only these three do, and they are
    // the paragraph the preview deliberately renders blank.
    const context = {
      ...base,
      subscriber_created_date: formatSubscribedDate(subscriber.created),
      subscriber_created_time: formatSubscribedTime(subscriber.created),
      unsub_key: subscriber.unsub_key,
    };
    const emoji = SUBJECT_EMOJI[Math.floor(Math.random() * SUBJECT_EMOJI.length)]!;
    const [textBody, htmlBody] = await Promise.all([
      render("emails/need_notification_txt.njk", context),
      render("emails/need_notification.njk", context),
    ]);

    await sendBroadcast(env, {
      to: subscriber.email,
      subject: `${emoji} ${base.full_name} needs ${items} items`,
      textBody,
      htmlBody,
      // RFC 8058 one-click unsubscribe (notifications.py:66-70). Gmail and
      // Yahoo require it on bulk mail; without it a broadcast stream is a
      // spam-folder risk regardless of content.
      unsubscribeUrl: `${env.SITE_DOMAIN}/needs/at/${base.foodbank_slug}/updates/unsubscribe/?key=${subscriber.unsub_key}`,
    });
    lastId = subscriber.id;
  }

  // Next page. Enqueued only after the current one is sent, so a failure
  // retries this page rather than skipping ahead.
  await env.JOBS_Q.send({ type: "notify-need-email", needId: msg.needId, afterId: lastId });
  console.log(`notify-need-email: need ${msg.needId} sent ${subscribers.length}, next after id ${lastId}`);
}

interface BroadcastParams {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  unsubscribeUrl: string;
}

// The jobs Worker's own Postmark send. workers/site/src/lib/email.ts takes a
// Hono Context and hardcodes MessageStream "outbound"; this is the
// BROADCAST stream, which is what notifications.py:111-114 selects for
// is_broadcast=True and what Postmark requires for bulk mail. Two senders
// rather than one shared one because the difference is not a parameter --
// a transactional mail must never go out on the broadcast stream, and a
// bulk mail must never go out on the transactional one.
async function sendBroadcast(env: Env, params: BroadcastParams): Promise<boolean> {
  if (!env.POSTMARK_TOKEN) {
    console.log(`notify-need-email: POSTMARK_TOKEN not set -- skipping ${params.to}`);
    return false;
  }
  try {
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": env.POSTMARK_TOKEN,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        From: "mail@givefood.org.uk",
        To: params.to,
        Subject: params.subject,
        TextBody: params.textBody,
        HtmlBody: params.htmlBody,
        MessageStream: "broadcast",
        Headers: [
          { Name: "List-Unsubscribe", Value: `<${params.unsubscribeUrl}>` },
          { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
        ],
      }),
    });
    // Django checks == 200 exactly, not any 2xx. Matched, not "improved".
    if (response.status !== 200) {
      console.error(`notify-need-email: Postmark ${response.status} for ${params.to}: ${await response.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`notify-need-email: send failed for ${params.to}`, err);
    return false;
  }
}
