// The inbound WhatsApp command parse, checked against a real Meta webhook
// payload and against the exact strings people actually send.
//
//   pnpm run verify:whatsapp
//
// WHY THIS EXISTS. This is the STOP path. Everything else in
// workers/jobs/src/queues/whatsappHook.ts is a D1 write or an HTTP call
// that fails loudly; these two functions fail SILENTLY -- an off-by-one in
// the command slice or a payload shape that stopped matching just means
// `parseCommand` returns null and the message is ignored, which is exactly
// what the code does for ordinary conversation. A broken unsubscribe and a
// "thanks!" look identical from the log.
//
// The payload below is the shape Meta documents and sends for an inbound
// text message, trimmed of fields this code never reads.

import {
  extractMessages,
  parseCommand,
  type InboundMessage,
} from "../../workers/jobs/src/queues/whatsappHook";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`);
    failures++;
  }
}

function metaPayload(messages: unknown[]): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "0",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "442039206758", phone_number_id: "890504590819478" },
              contacts: [{ profile: { name: "A Person" }, wa_id: "447700900123" }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

const textMessage = (body: string) => ({
  from: "447700900123",
  id: "wamid.TEST",
  timestamp: "1757088000",
  type: "text",
  text: { body },
});

console.log("extractMessages");
check(
  "pulls a text message out of a real Meta envelope",
  extractMessages(metaPayload([textMessage("subscribe sid-valley")])).map((m: InboundMessage) => m.text?.body),
  ["subscribe sid-valley"],
);
check("two messages in one webhook both come through", extractMessages(metaPayload([textMessage("a"), textMessage("b")])).length, 2);
// Meta sends a `statuses` array (delivery receipts) far more often than it
// sends `messages`, and that envelope has no `messages` key at all.
check("a statuses-only delivery receipt yields nothing", extractMessages({ entry: [{ changes: [{ value: { statuses: [{ id: "x" }] } }] }] }), []);
check("an empty object yields nothing", extractMessages({}), []);
check("null yields nothing", extractMessages(null), []);
check("entry present but not an array yields nothing", extractMessages({ entry: "nope" }), []);
check("changes missing yields nothing", extractMessages({ entry: [{}] }), []);

console.log("parseCommand");
check("subscribe", parseCommand("subscribe sid-valley"), { action: "subscribe", slug: "sid-valley" });
check("unsubscribe", parseCommand("unsubscribe sid-valley"), { action: "unsubscribe", slug: "sid-valley" });
// The slice offsets are the thing most likely to be silently wrong: the
// prefixes are 10 and 12 characters INCLUDING the trailing space, and
// "unsubscribe " also starts with... nothing that collides, but it is
// checked before nothing else would catch a swapped pair of branches.
check("unsubscribe is not mis-read as subscribe", parseCommand("unsubscribe x")?.action, "unsubscribe");
check("uppercase is accepted", parseCommand("SUBSCRIBE Sid-Valley"), { action: "subscribe", slug: "sid-valley" });
check("surrounding whitespace is stripped", parseCommand("  subscribe   sid-valley  "), { action: "subscribe", slug: "sid-valley" });
// Django matches on the prefix INCLUDING the space, so a bare word is not
// a command -- reproduced, so behaviour does not diverge on the one input
// a confused person is most likely to send.
check("bare 'subscribe' with no space is not a command", parseCommand("subscribe"), null);
// This expectation was wrong on the first run of this file, and the check
// is what caught it: "subscribe " looks like it should parse to an empty
// slug, but Django strips the whole body BEFORE testing the prefix
// (views.py:1383 `.strip().lower()`, then `.startswith('subscribe ')`), so
// a trailing space is gone by the time the prefix is tested and the input
// is indistinguishable from the bare word above. The port does the same.
// Recorded rather than quietly corrected: the natural reading of the code
// is the wrong one, so the next person to look will make the same guess.
check("'subscribe ' collapses to the bare word and is ignored", parseCommand("subscribe "), null);
check("ordinary conversation is not a command", parseCommand("thanks, this is great"), null);
check("empty string is not a command", parseCommand(""), null);
check("a word merely containing subscribe is not a command", parseCommand("resubscribe me please"), null);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nPASS: inbound WhatsApp command parsing matches givefood/views.py:1366-1391");
}
