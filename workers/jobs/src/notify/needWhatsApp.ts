import {
  getFoodbankNotifyTarget,
  getNeedById,
  getWhatsappSubscribersPage,
  setWhatsappLastNotified,
  type Session,
} from "@givefood/db";
import { changeList } from "@givefood/models";
import type { Env } from "../../worker-configuration";
import { buildNeedTemplate, sendWhatsappTemplate } from "./whatsappClient";

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
const LOG = "notify-need-whatsapp";

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
  const template = buildNeedTemplate(foodbank.name, foodbank.slug, [items[0] ?? "", items[1] ?? "", items[2] ?? ""]);

  const notified: number[] = [];
  let lastId = msg.afterId;
  for (const subscriber of subscribers) {
    if (await sendWhatsappTemplate(env, subscriber.phone_number, template, LOG)) notified.push(subscriber.id);
    lastId = subscriber.id;
  }

  // notifications.py:652-654 stamps last_notified per successful send.
  // One statement for the page's successes rather than one per subscriber.
  if (notified.length > 0) await setWhatsappLastNotified(session, notified, new Date().toISOString());

  await env.JOBS_Q.send({ type: "notify-need-whatsapp", needId: msg.needId, afterId: lastId });
  console.log(`notify-need-whatsapp: need ${msg.needId} sent ${notified.length}/${subscribers.length}, next after id ${lastId}`);
}
