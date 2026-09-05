import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { elapsedMs } from "../../middleware/serverTiming";

// givefood/views.py:987-1008 colophon() -- givefood/urls.py:24, "colophon/",
// inside i18n_patterns (translated: colophon.html's "Colophon" title/h1
// both carry a Django {% trans %} tag, already present in the copied
// locale/*/django.po catalogues).
//
// Django's own colophon() view also does a live `requests.get` to
// raw.githubusercontent.com/.../pyproject.toml on every cache miss and
// renders a "Libraries" list parsed out of it -- deliberately NOT ported:
// maintainer decision, keep this page static instead of taking on an
// unpinned, uncached, per-request external dependency for a page that's
// otherwise pure prose.
export async function publicColophon(c: Context<AppEnv>): Promise<Response> {
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "public/colophon.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
    },
    locale,
  );
  return c.html(html);
}
