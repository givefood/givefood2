import type { Context } from "hono";
import type { AppEnv } from "./types";
import { renderErrorPage } from "./renderErrorPage";

// givefood/templates/500.html -- Django never registers this via a
// handler500/urls.py entry (there is none); it falls back to its own
// default view (django.views.defaults.server_error), which resolves
// "500.html" purely by filename convention once DEBUG=False, rendered
// with the request still attached so context_processors.py's context()
// runs same as any other page.
//
// index.ts's app.onError handler is the sole caller (`c.html(await
// render500(c), 500)`). serverTiming (`app.use("*", serverTiming)`) and
// resolveLanguage (`app.use("*", resolveLanguage)`) are both global
// middleware that run BEFORE any route handler, so
// `requestStartTime`/`lang`/`pathAfterPrefix` are already set on `c` by
// the time an error thrown further down the chain reaches app.onError --
// same `c`, just caught higher up.
//
// This is the page an already-broken request lands on, so it falls back
// to a bare string (never throws itself) if rendering the real 500.njk
// through the shared Nunjucks/catalogue pipeline ALSO fails -- e.g. a
// fault in that shared pipeline itself, not just in whatever route
// originally errored. Without this, a double failure would propagate an
// unhandled rejection out of app.fetch() entirely, past even app.onError,
// producing the platform's raw error response instead of any page at all.
export async function render500(c: Context<AppEnv>): Promise<string> {
  try {
    return await renderErrorPage(c, "500.njk");
  } catch (err) {
    console.error("render500: rendering the real 500 page itself failed", err);
    return "<!doctype html><title>500 - Internal Server Error</title><h1>500 - Internal Server Error</h1>";
  }
}
