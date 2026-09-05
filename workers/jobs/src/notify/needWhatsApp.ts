import {
  getFoodbankNotifyTarget,
  getNeedById,
  getWhatsappSubscribersPage,
  setWhatsappLastNotified,
  type Session,
} from "@givefood/db";
import { changeList } from "@givefood/models";
import type { Env } from "../../worker-configuration";

// send_whatsapp_notification() / send_whatsapp_template_notification()
// (givefood/utils/notifications.py:521-660) -- the WhatsApp channel of
// gfadmin/views.py:2006's Notify.
//
// TEMPLATE MESSAGE, not free text. WhatsApp only permits a business to
// message a user outside a 24-hour customer-service window through a
// template Meta has pre-approved, so the wording is fixed at Meta's end
// and this only supplies the variables. That is why the payload below has
// no message body in it: `foodbankneed2` is the approved template, and its
// header/body/button parameters are positional.
//
// SELF-PAGING through the queue, like the other two channels. 51
// subscribers today across every food bank.

const PAGE_SIZE = 25;

// notifications.py:20-21. The phone-number id is the WhatsApp Business
// sender, not a secret -- it is public in every message this account has
// ever sent. WHATSAPP_TOKEN is the secret half.
const WHATSAPP_PHONE_NUMBER_ID = "890504590819478";
const GRAPH_API_VERSION = "v24.0";
const TEMPLATE_NAME = "foodbankneed2";

export interface NotifyNeedWhatsAppMessage {
  type: "notify-need-whatsapp";
  needId: number;
  afterId: number;
}

export async function handleNotifyNeedWhatsApp(msg: NotifyNeedWhatsAppMessage, env: Env): Promise<void> {
  if (!env.WHATSAPP_TOKEN) {
    console.warn("notify-need-whatsapp: WHATSAPP_TOKEN not set, skipping");
    return;
  }

  const session: Session = env.DB.withSession("first-unconstrained");
  const need = await getNeedById(session, msg.needId);
  if (!need?.foodbank_id) {
    console.error(`notify-need-whatsapp: need ${msg.needId} is missing or has no food bank`);
    return;
  }

  const subscribers = await getWhatsappSubscribersPage(session, need.foodbank_id, msg.afterId, PAGE_SIZE);
  if (subscribers.length === 0) {
    console.log(`notify-need-whatsapp: need ${msg.needId} done after id ${msg.afterId}`);
    return;
  }

  const foodbank = await getFoodbankNotifyTarget(session, need.foodbank_id);
  if (!foodbank) {
    console.error(`notify-need-whatsapp: food bank ${need.foodbank_id} not found`);
    return;
  }

  // notifications.py:566-570 -- the template takes exactly three items,
  // and a food bank needing fewer sends empty strings for the rest.
  // change_list() is the raw split, matching Django; the template's own
  // wording is what makes a blank line read sensibly.
  const items = changeList(need.change_text);
  const body = buildTemplatePayload(foodbank.name, foodbank.slug, [items[0] ?? "", items[1] ?? "", items[2] ?? ""]);

  const notified: number[] = [];
  let lastId = msg.afterId;
  for (const subscriber of subscribers) {
    if (await sendTemplate(env, subscriber.phone_number, body)) notified.push(subscriber.id);
    lastId = subscriber.id;
  }

  // notifications.py:652-654 stamps last_notified per successful send.
  // One statement for the page's successes rather than one per subscriber.
  if (notified.length > 0) await setWhatsappLastNotified(session, notified, new Date().toISOString());

  await env.JOBS_Q.send({ type: "notify-need-whatsapp", needId: msg.needId, afterId: lastId });
  console.log(`notify-need-whatsapp: need ${msg.needId} sent ${notified.length}/${subscribers.length}, next after id ${lastId}`);
}

// notifications.py:573-621's payload, component for component. The
// parameter ORDER is the contract with Meta's approved template and
// cannot be rearranged here: header {{1}} is the food bank name, body
// {{1}}..{{4}} are the name then three items, and the button's URL suffix
// is the food bank slug.
function buildTemplatePayload(foodbankName: string, foodbankSlug: string, items: readonly [string, string, string]) {
  const text = (t: string) => ({ type: "text", text: t });
  return {
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: "en" },
      components: [
        { type: "header", parameters: [text(foodbankName)] },
        { type: "body", parameters: [text(foodbankName), text(items[0]), text(items[1]), text(items[2])] },
        { type: "button", sub_type: "url", index: "0", parameters: [text(foodbankSlug)] },
      ],
    },
  };
}

async function sendTemplate(env: Env, toPhone: string, body: ReturnType<typeof buildTemplatePayload>): Promise<boolean> {
  // notifications.py:570 -- the Graph API wants the number without a
  // leading "+", and the stored numbers have one.
  const to = toPhone.replace(/^\+/, "");
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    // Django checks `== 200` exactly. Matched, not widened: the Graph API
    // returns 200 on an accepted message, and a 2xx that is not 200 from
    // this endpoint would be worth seeing in the log rather than counting
    // as a send.
    if (res.status !== 200) {
      console.error(`notify-need-whatsapp: Graph API ${res.status} for ${to}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`notify-need-whatsapp: send failed for ${to}`, err);
    return false;
  }
}
