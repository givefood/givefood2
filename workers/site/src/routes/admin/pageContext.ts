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
    // Django's `version` is os.environ['SOURCE_COMMIT'][:7] (givefood/
    // context_processors.py:22-29), feeding BOTH the footer's "Version" and
    // every `?v=` static cache-buster in page.njk. Nothing was passing one, so
    // context.ts's "dev" fallback applied on every deploy -- meaning a shipped
    // CSS/JS change kept being served under the same ?v=dev key.
    ...buildPageContext({ path: c.req.path, appName: "gfadmin", version: c.env.CF_VERSION_METADATA?.id?.slice(0, 7) }),
    render_time_ms: elapsedMs(c),
    section,
    admin_user: adminUser,
    csrf_token: csrfToken,
    // The four Google-key globals admin.js reads --
    // gfadmin/context_processors.py's gmap_keys() supplies exactly these to
    // every admin page in Django via page.html's inline <script>. Ported here
    // rather than per-route because admin.js loads on every admin page and
    // initialises unconditionally; all four names must EXIST or the script
    // throws ReferenceError on the first button click and every lookup button
    // in the admin dies with it (which is what was happening before this).
    //
    // Only two are actually published:
    //   - geocode: admin.js fetches maps.googleapis.com/maps/api/geocode
    //     straight from the browser (that endpoint does send CORS headers),
    //     so the value has to be in the page. Browser-restricted key, same
    //     exposure Django already has.
    //   - static:  used as an <img src> for the staticmap preview, so it is
    //     in the page by construction.
    // `places` is deliberately left EMPTY: routes/admin/gmapProxy.ts now
    // supplies it server-side and discards any client-sent key, so unlike
    // Django this one never reaches the browser at all. `gmap_key` (the Maps
    // JS API key) has no consumer in any ported admin template yet.
    //
    // `?? ""` rather than a hard read: GMAP_PLACES_KEY is not set on the
    // account (`wrangler secret list`, 2026-09-02) and this repo's rule is
    // that a name only enters wrangler.jsonc's `secrets.required` in the same
    // change that actually sets it. Missing keys degrade one button; a hard
    // read would 500 every admin page.
    gmap_key: "",
    gmap_places_key: "",
    gmap_static_key: c.env.GMAP_STATIC_KEY ?? "",
    gmap_geocode_key: c.env.GMAP_GEOCODE_KEY ?? "",
    // Django's footer answers "which database am I looking at" with DB_HOST.
    // D1 exposes no name through the binding at runtime, so it comes from a
    // plain var instead -- see workers/site/wrangler.jsonc.
    d1_database: c.env.D1_DATABASE_NAME ?? "d1",
  };
}
