import type { Context } from "hono";
import { buildPageContext } from "@givefood/templates";
import type { AppEnv } from "../../types";
import type { AdminSessionData } from "../../lib/adminAuth";
import { issueCsrfToken } from "../../lib/csrf";
import { elapsedMs } from "../../middleware/serverTiming";

// Shared by every admin*.njk render call -- same shape as dashboards/
// heatmap.ts's own pageContext(), plus what admin/page.njk actually needs
// beyond the public site's page.njk: the signed-in user (for the nav's
// "signed in as"/sign out) and a CSRF token (WP 6.2's double-submit
// design) for the page's mutating forms. Every admin GET handler that
// renders a page with at least one form should call this, even a page
// with no form of its own -- issuing one unconditionally is cheaper than
// threading a "does this page need one" flag through every call site, and
// an unused token costs nothing.
export async function adminPageContext(c: Context<AppEnv>, section: string): Promise<Record<string, unknown>> {
  const adminUser = c.get("adminUser") as AdminSessionData | undefined;
  const csrfToken = await issueCsrfToken(c, c.env.CSRF_SECRET);
  return {
    ...buildPageContext({ path: c.req.path, appName: "gfadmin" }),
    render_time_ms: elapsedMs(c),
    section,
    admin_user: adminUser,
    csrf_token: csrfToken,
  };
}
