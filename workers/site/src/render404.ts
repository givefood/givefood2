import type { Context } from "hono";
import type { AppEnv } from "./types";
import { renderErrorPage } from "./renderErrorPage";

// givefood/templates/404.html -- Django never registers this via a
// handler404/urls.py entry (there is none); it falls back to its own
// default view (django.views.defaults.page_not_found), which resolves
// "404.html" purely by filename convention once DEBUG=False, rendered
// with the request still attached so context_processors.py's context()
// runs same as any other page (language_code etc. included). Ported here
// as a real render() call through the same Nunjucks pipeline every other
// page uses, rather than the bare placeholder string this file used to
// return.
//
// index.ts's app.notFound handler is the sole caller (`c.html(await
// render404(c), 404)`) and runs for ANY unmatched path in ANY locale --
// resolveLanguage is global middleware (`app.use("*", resolveLanguage)`),
// so `lang`/`pathAfterPrefix` are already set on `c` regardless of
// whether a route ever matched.
export async function render404(c: Context<AppEnv>): Promise<string> {
  return renderErrorPage(c, "404.njk");
}
