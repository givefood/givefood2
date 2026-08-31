import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "./types";
import { elapsedMs } from "./middleware/serverTiming";

// Shared by render404.ts/render403.ts/render500.ts -- all three Django
// error templates (404.html/403.html/500.html) are rendered through this
// exact same buildPageContext()+render() shape, with only the template
// name differing; see each of those files for what actually calls them
// (or, for 403, why nothing does).
export async function renderErrorPage(c: Context<AppEnv>, templateName: string): Promise<string> {
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const context = buildPageContext({
    path: c.req.path,
    appName: "givefood",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  return render(
    templateName,
    {
      ...context,
      render_time_ms: elapsedMs(c),
    },
    locale,
  );
}
