import type { Env } from "../../worker-configuration";

// The WhatsApp Business Graph API client -- givefood/utils/
// notifications.py:474-521 send_whatsapp_message (plain text) and
// :521-621 send_whatsapp_template_notification (approved template).
//
// TWO SEND SHAPES, NOT ONE, and the difference is a policy boundary rather
// than a formatting one. WhatsApp only permits a business to open a
// conversation through a template Meta has pre-approved; free text is
// allowed only INSIDE the 24-hour service window a user's own message
// opens. So the template send is what a need notification uses (the user
// is not talking to us), and the text send is what the inbound
// subscribe/unsubscribe replies use (the user just messaged us, so the
// window is open). Using the wrong one is not a cosmetic error: a free
// text reply outside the window is silently dropped by Meta.

// notifications.py:20-21. The phone-number id is the WhatsApp Business
// sender, not a secret -- it is public in every message this account has
// ever sent. WHATSAPP_TOKEN is the secret half.
const WHATSAPP_PHONE_NUMBER_ID = "890504590819478";
const GRAPH_API_VERSION = "v24.0";

function messagesUrl(): string {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

// notifications.py:499/570 -- the Graph API wants the number without a
// leading "+", and the stored numbers have one.
function normalisePhone(phone: string): string {
  return phone.replace(/^\+/, "");
}

async function post(env: Env, logPrefix: string, to: string, body: Record<string, unknown>): Promise<boolean> {
  if (!env.WHATSAPP_TOKEN) {
    console.warn(`${logPrefix}: WHATSAPP_TOKEN not set, not sending to ${to}`);
    return false;
  }
  try {
    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    // Django checks `== 200` exactly, on both send paths. Matched, not
    // widened: the Graph API returns 200 on an accepted message, and a 2xx
    // that is not 200 from this endpoint is worth seeing in the log rather
    // than counting as a send.
    if (res.status !== 200) {
      console.error(`${logPrefix}: Graph API ${res.status} for ${to}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`${logPrefix}: send failed for ${to}`, err);
    return false;
  }
}

// send_whatsapp_message (notifications.py:474). Free text, valid only
// inside the 24-hour window -- see this file's header.
export async function sendWhatsappText(env: Env, toPhone: string, message: string, logPrefix: string): Promise<boolean> {
  return post(env, logPrefix, normalisePhone(toPhone), { type: "text", text: { body: message } });
}

// send_whatsapp_template_notification's payload (notifications.py:573-621),
// component for component. The parameter ORDER is the contract with Meta's
// approved template and cannot be rearranged here: header {{1}} is the
// food bank name, body {{1}}..{{4}} are the name then three items, and the
// button's URL suffix is the food bank slug.
const TEMPLATE_NAME = "foodbankneed2";

export function buildNeedTemplate(foodbankName: string, foodbankSlug: string, items: readonly [string, string, string]) {
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

export async function sendWhatsappTemplate(
  env: Env,
  toPhone: string,
  template: ReturnType<typeof buildNeedTemplate>,
  logPrefix: string,
): Promise<boolean> {
  return post(env, logPrefix, normalisePhone(toPhone), template);
}
