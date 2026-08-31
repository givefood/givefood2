import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { elapsedMs } from "../../middleware/serverTiming";

// givefood/views.py:979-984 privacy() -- givefood/urls.py:67, "privacy/",
// in the "Untranslated pages" block (OUTSIDE i18n_patterns; already a
// confirmed exception in packages/templates/src/urls.ts's ROUTES table).
// Genuinely untranslated content too: privacy.html carries no
// {% trans %}/{% blocktrans %} tags at all. Static, no DB reads.
// @cache_page(SECONDS_IN_WEEK) in Django -- PLAN.md §6.10's table lists
// `privacy` under the SECONDS_IN_WEEK family, served via a Cloudflare
// Cache Rule at the edge rather than a Cache-Control header set here,
// matching every other HTML page in this pass (see publicIndex in
// ../public.ts).
export async function publicPrivacy(c: Context<AppEnv>): Promise<Response> {
  const context = buildPageContext({
    path: c.req.path,
    appName: "givefood",
    pageTranslatable: false,
  });

  const html = await render("public/privacy.njk", {
    ...context,
    render_time_ms: elapsedMs(c),
  });
  return c.html(html);
}
