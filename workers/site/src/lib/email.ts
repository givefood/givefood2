import type { Context } from "hono";
import type { AppEnv } from "../types";

// givefood/utils/notifications.py's send_email() -- POSTs to Postmark's
// REST API. Extracted from routes/wfbn/updates.ts (its original home, kept
// working via the re-export there) and extended with cc/bcc/replyTo --
// gfwrite's `send` route needs them, updates.ts's two callers don't.
//
// `cc_name`/`bcc_name`/`reply_to_name` exist as parameters on the real
// Django send_email() but are NEVER read anywhere in its body (verified
// directly against notifications.py:99-146) -- Postmark gets bare
// addresses for Cc/Bcc/ReplyTo, no display-name formatting. Not ported;
// there is nothing to port.
//
// Returns whether Postmark accepted the send (status 200), matching
// Django's own `if result.status_code == 200: return True else: ...
// return False` -- callers that need to know (gfwrite's `send`, PLAN.md
// §6.9 R5) can now check it; updates.ts's two callers still don't, same
// as before.
export interface SendEmailParams {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
}

// registration_email.txt/flag_email.txt, ported as one shared builder
// rather than two copies (routes/public/registerFoodbank.ts and flag.ts
// both feed a submitted form's fields into an internal notification email
// this same way): one "key: value" line per field, csrf_token and
// cf-turnstile-response always excluded (an internal email to
// mail@givefood.org.uk still shouldn't carry a live CSRF/Turnstile token --
// flag()'s real Django view already strips the equivalent two keys for the
// same reason, views.py:1112-1113; registration_email.txt's real Django
// template does NOT, a leak this port doesn't reproduce).
export function redactedKeyValueLines(fields: Record<string, string>): string {
  return Object.entries(fields)
    .filter(([key]) => key !== "csrf_token" && key !== "cf-turnstile-response")
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

export async function sendEmail(c: Context<AppEnv>, params: SendEmailParams): Promise<boolean> {
  const token = c.env.POSTMARK_TOKEN;
  if (!token) {
    console.log(`POSTMARK_TOKEN not set -- skipping email to ${params.to}: ${params.subject}`);
    return false;
  }
  // notifications.py:117-118, preserved deliberately (PLAN.md §6.11 decision
  // I -- reachable from the public /write/ form via the constituent's own
  // `reply_to`, kept on the maintainer's explicit call): a constituent
  // typing "test@example.com" as their own email diverts the send away
  // from the MP entirely, to an internal test inbox.
  const to = params.replyTo === "test@example.com" ? "mail+testemail@givefood.org.uk" : params.to;
  try {
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        From: "mail@givefood.org.uk",
        To: to,
        Cc: params.cc ?? null,
        Bcc: params.bcc ?? null,
        Subject: params.subject,
        TextBody: params.textBody,
        HtmlBody: params.htmlBody ?? null,
        ReplyTo: params.replyTo ?? null,
        // notifications.py:111-114 -- "broadcast" iff is_broadcast, else
        // "outbound". No caller of this shared sendEmail() (updates.ts's
        // two, write/index.ts's one, or the two this MessageStream fix
        // itself was found while adding) ever sends a broadcast; hardcoded
        // rather than threading an unused parameter through every call site.
        MessageStream: "outbound",
      }),
    });
    // Django's send_email() checks `result.status_code == 200` exactly,
    // not "any 2xx" (response.ok's own definition) -- narrower on purpose,
    // matched here rather than "improved".
    if (response.status !== 200) {
      console.error(`Failed to send email to ${to}: ${response.status} - ${await response.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Failed to send email to ${to}: ${String(err)}`);
    return false;
  }
}
