import {
  deleteWhatsappSubscriber,
  findWhatsappSubscriber,
  getFoodbankIdBySlug,
  getFoodbankNotifyTarget,
  insertWhatsappSubscriber,
  type Session,
} from "@givefood/db";
import type { Env } from "../../worker-configuration";
import { sendWhatsappText } from "../notify/whatsappClient";

// givefood/views.py:1366-1470 -- the command half of `whatsapp_hook`:
// parsing `subscribe <slug>` / `unsubscribe <slug>` out of an inbound
// WhatsApp message and acting on it.
//
// THE QUEUE HAD NO CONSUMER AT ALL. workers/site/src/routes/whatsappHook.ts
// has verified the signature and enqueued the raw Meta payload since WP
// 4.8, deliberately declaring no consumer itself ("that's Phase 5 work"),
// and nothing was ever wired to the other end. So every inbound message
// was accepted, acked to Meta with a 200, and dropped.
//
// That was survivable while nothing sent. It stopped being survivable the
// moment the notification channels shipped (2026-09-05): 51 people receive
// WhatsApp messages and, without this, none of them could send STOP and
// have it mean anything. An opt-out you cannot exercise is worse than a
// channel that never sends -- so this is a launch blocker, not a
// nice-to-have, and is built before the cutover rather than after.
//
// THE PAYLOAD IS META'S RAW WEBHOOK BODY. The site Worker enqueues what it
// received, unparsed, so the walk down entry[].changes[].value.messages[]
// happens here -- exactly as views.py:1366-1391 does it.
//
// REPLIES ARE FREE TEXT, not templates. That is correct and is not an
// inconsistency with notify/needWhatsApp.ts: an inbound message opens a
// 24-hour service window during which free text is permitted, which is
// precisely the situation here. See notify/whatsappClient.ts.

export interface InboundMessage {
  from?: string;
  type?: string;
  text?: { body?: string };
}

// views.py:1366-1372's nested walk, defensive at every level -- this is an
// external payload whose shape Meta can extend at will, and a missing key
// anywhere must not throw.
// Exported, with parseCommand below, for tools/whatsapp-command/verify.ts
// -- both are pure, and they are the two places a silent bug would live:
// a payload shape Meta changed, or an off-by-one in the command slice.
// Everything else in this file is a D1 write or an HTTP call.
export function extractMessages(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown[] } })?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) out.push(message as InboundMessage);
    }
  }
  return out;
}

export type Command = { action: "subscribe" | "unsubscribe"; slug: string } | null;

// views.py:1385-1391. Lowercased and trimmed BEFORE matching, so
// "SUBSCRIBE Foo" works; the slug is whatever follows the space. Anything
// that is not one of the two prefixes is ignored in silence, exactly as
// Django ignores it -- this number receives ordinary conversation too, and
// replying "unknown command" to every "thank you" would be worse than
// saying nothing.
export function parseCommand(body: string): Command {
  const text = body.trim().toLowerCase();
  if (text.startsWith("subscribe ")) return { action: "subscribe", slug: text.slice(10).trim() };
  if (text.startsWith("unsubscribe ")) return { action: "unsubscribe", slug: text.slice(12).trim() };
  return null;
}

// views.py:1376-1378 -- Meta sends the number without one, and every
// stored number has one.
function normaliseFrom(from: string): string {
  return from.startsWith("+") ? from : `+${from}`;
}

const LOG = "whatsapp-hook";

export async function handleWhatsappHookQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleOne(message.body, env);
      message.ack();
    } catch (err) {
      // Retried: unlike a send, the failure here is most likely D1 being
      // briefly unavailable, and re-running is safe -- subscribe is a
      // find-then-insert and unsubscribe is a delete, so a repeat produces
      // the same end state. The only visible cost of a retry is a repeated
      // reply message.
      console.error(`${LOG}: message failed`, err);
      message.retry();
    }
  }
}

async function handleOne(payload: unknown, env: Env): Promise<void> {
  const messages = extractMessages(payload);
  if (messages.length === 0) return;

  for (const message of messages) {
    // views.py:1382 -- only text messages carry commands. An image,
    // reaction or status update is not an error, it is just not a command.
    if (message.type !== "text") continue;
    const from = message.from;
    const body = message.text?.body;
    if (!from || !body) continue;

    const command = parseCommand(body);
    if (!command) continue;

    const phone = normaliseFrom(from);
    if (command.action === "subscribe") await subscribe(env, phone, command.slug);
    else await unsubscribe(env, phone, command.slug);
  }
}

// The reply copy is views.py:1413-1433 / 1451-1470, word for word --
// people have received these messages for months and the wording is part
// of the product, not an implementation detail to paraphrase.
async function subscribe(env: Env, phone: string, slug: string): Promise<void> {
  const session: Session = env.DB.withSession("first-unconstrained");
  const foodbankId = await getFoodbankIdBySlug(session, slug);
  if (foodbankId === null) {
    await sendWhatsappText(
      env,
      phone,
      `Sorry, we couldn't find a foodbank with the name '${slug}'. Please check the spelling and try again.`,
      LOG,
    );
    return;
  }
  const foodbank = await getFoodbankNotifyTarget(session, foodbankId);
  const name = foodbank?.name ?? slug;

  const existing = await findWhatsappSubscriber(session, phone, foodbankId);
  if (existing !== null) {
    await sendWhatsappText(env, phone, `You're already subscribed to updates from ${name} Foodbank.`, LOG);
    return;
  }

  await insertWhatsappSubscriber(session, phone, foodbankId, new Date().toISOString());
  await sendWhatsappText(
    env,
    phone,
    `You've successfully subscribed to updates from ${name} Foodbank. You'll receive a message when they update ` +
      `their shopping list. To unsubscribe, send 'unsubscribe ${slug}'.`,
    LOG,
  );
  console.log(`${LOG}: subscribed a number to ${slug}`);
}

async function unsubscribe(env: Env, phone: string, slug: string): Promise<void> {
  const session: Session = env.DB.withSession("first-unconstrained");
  const foodbankId = await getFoodbankIdBySlug(session, slug);
  if (foodbankId === null) {
    await sendWhatsappText(
      env,
      phone,
      `Sorry, we couldn't find a foodbank with the name '${slug}'. Have a look on https://www.givefood.org.uk ` +
        `to find the correct foodbank.`,
      LOG,
    );
    return;
  }
  const foodbank = await getFoodbankNotifyTarget(session, foodbankId);
  const name = foodbank?.name ?? slug;

  // A DELIBERATE DIVERGENCE FROM DJANGO, and the one place in this file
  // that is not a straight port. views.py:1457 uses
  // `WhatsappSubscriber.objects.get(phone_number=, foodbank=)`, which
  // raises MultipleObjectsReturned if the pair appears twice -- and the
  // table has no unique constraint stopping that. The exception is caught
  // nowhere: it would escape whatsapp_hook, return a 500 to Meta, and Meta
  // de-registers a webhook that stops returning 200. So in Django a single
  // duplicated row would take the whole webhook down, and the person who
  // asked to be unsubscribed would stay subscribed.
  //
  // Checked before writing this: there are no duplicate (phone, foodbank)
  // pairs in production today (a number legitimately appears against up to
  // 10 DIFFERENT food banks, which is not the same thing). So this is
  // defending a case that has not happened -- but the cost is one word of
  // SQL, and the failure mode it prevents is "the unsubscribe endpoint is
  // dead for everyone".
  const deleted = await deleteWhatsappSubscriber(session, phone, foodbankId);
  if (deleted === 0) {
    await sendWhatsappText(env, phone, `You weren't subscribed to ${name} Foodbank.`, LOG);
    return;
  }
  await sendWhatsappText(
    env,
    phone,
    `You've been unsubscribed from ${name} Foodbank. You won't receive any more updates. To subscribe again, ` +
      `send 'subscribe ${slug}'.`,
    LOG,
  );
  console.log(`${LOG}: unsubscribed a number from ${slug} (${deleted} row(s))`);
}
