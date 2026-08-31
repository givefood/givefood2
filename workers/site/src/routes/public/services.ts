import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { elapsedMs } from "../../middleware/serverTiming";

// givefood/views.py:445-449 services() -- givefood/urls.py:71, "services/",
// in the "Untranslated pages" block (OUTSIDE i18n_patterns). Genuinely
// untranslated content too, not just an untranslated URL: services.html
// carries no {% trans %}/{% blocktrans %} tags at all. Static, no DB
// reads, no @cache_page -- PLAN.md §6.10's table lists this route's
// Cache-Control as "None" ("UNCACHED despite being fully static"), which
// this port leaves as-is (no Cache-Control set here), matching Django and
// every other HTML page in this pass (see publicIndex in ../public.ts --
// edge caching for the cached pages is a Cloudflare Cache Rule, not
// per-route code).
export async function publicServices(c: Context<AppEnv>): Promise<Response> {
  const context = buildPageContext({
    path: c.req.path,
    appName: "givefood",
    pageTranslatable: false,
  });

  const html = await render("public/services.njk", {
    ...context,
    render_time_ms: elapsedMs(c),
  });
  return c.html(html);
}
