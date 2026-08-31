import type { Context } from "hono";
import type { AppEnv } from "./types";
import { renderErrorPage } from "./renderErrorPage";

// givefood/templates/403.html -- Django never registers this via a
// handler403/urls.py entry (there is none); it falls back to its own
// default view (django.views.defaults.permission_denied), which resolves
// "403.html" purely by filename convention once DEBUG=False, rendered
// with the request still attached so context_processors.py's context()
// runs same as any other page. That view only ever runs off Django's
// PermissionDenied exception path, which nothing in this app's ported
// surface raises -- every existing 403 in this codebase (human.ts,
// updates.ts's unsubscribe, mobsub.ts, webpush.ts) is a deliberate bare
// `new Response("", { status: 403 })`, matching the SAME Django views'
// own HttpResponseForbidden() calls, which never render 403.html either.
//
// So: there is genuinely no call site for this function anywhere in the
// app today, by design -- it exists purely so the ported template has a
// real, working renderer, matching render404.ts/render500.ts's shape.
// Do NOT wire this into any of the existing bare-403 endpoints; that
// would be a behaviour change from Django parity, not a fix.
export async function render403(c: Context<AppEnv>): Promise<string> {
  return renderErrorPage(c, "403.njk");
}
