import type { Context } from "hono";
import { getNeedByUuid } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { buildNeedEmailContext } from "../../lib/needNotificationEmail";

// gfadmin/views.py:2023-2038 need_email -- GET /admin/need/<id>/email/.
//
// Renders the SUBSCRIBER notification email body raw, with no admin page
// chrome, so the maintainer can eyeball what will land in inboxes before
// pressing Send. Linked from admin/need.html:136-140's "Notification
// Preview" block as two <li> links.
//
// The templates are NOT under gfadmin/templates/admin/emails/ (that
// directory holds only order.{html,txt}, rfi.{html,txt} and the shared
// shell page.html) -- they are gfwfbn/templates/wfbn/emails/
// notification.{txt,html}, ported to packages/templates/templates/emails/.
//
// Django does not restrict the method and the view is a pure read, so this
// is registered GET-only here; there is nothing to CSRF-protect.
//
// Two things this port does NOT change:
//
//  * Only the exact string "html" selects HTML (views.py:2028).
//    ?format=HTML, ?format=htm, garbage, and no param at all all fall
//    through to text/plain. Kept exactly, because need.njk's own preview
//    links are the only callers and they pass the two exact values.
//
//  * Django passes ONLY {need}, never {subscriber} (views.py:2035), so the
//    preview's last paragraph renders "...you subscribed to them at
//    www.givefood.org.uk on  at ." and the unsubscribe link as "?key=".
//    Reproduced deliberately -- see the D9 note in
//    lib/needNotificationEmail.ts. A fake subscriber would make the preview
//    lie about the one paragraph that is per-recipient in the real mail.
//
// One thing it does change: Django's view would raise (500) on a need with
// no food bank, since every line of both templates dereferences
// need.foodbank. Refused with a 400 and an explanation instead.
export async function adminNeedEmail(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const need = await getNeedByUuid(db, c.req.param("id")!);
  if (!need) return c.notFound();

  const context = await buildNeedEmailContext(db, need, null);
  if (!context) return c.text("This need has no food bank set, so it has no notification email", 400);

  const html = c.req.query("format") === "html";
  const body = await render(html ? "emails/need_notification.njk" : "emails/need_notification_txt.njk", { ...context });

  // A raw Response with an explicit Content-Type rather than c.html()/
  // c.text() -- the same pattern routes/admin/lists.ts uses for its CSV
  // exports, and the only way to serve one route as two content types.
  return new Response(body, {
    headers: { "Content-Type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" },
  });
}
