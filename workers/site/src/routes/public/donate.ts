import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { elapsedMs } from "../../middleware/serverTiming";

// givefood/views.py:484-488 donate() -- verbatim: `return render(request,
// "public/donate.html")`, no dynamic context beyond the shared page
// context every route builds. The /donate/managed/<slug>-<key>/ family
// (managed_donation, managed_donation_geojson, managed_donation_items --
// views.py:492+) is explicitly out of scope for this pass; only the plain
// /donate/ page itself is ported here.
export async function publicDonate(c: Context<AppEnv>): Promise<Response> {
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "public/donate.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
    },
    locale,
  );
  return c.html(html);
}
