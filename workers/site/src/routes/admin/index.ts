import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { getAdminSession } from "../../lib/adminAuth";
import { adminProxy } from "./proxy";

// gfadmin (WP 6.1/6.2 scaffolding only -- the real index page, need-review
// queue etc. are WP 6.4+). `adminApp` is where every actual admin feature
// mounts as its own WP lands, gated once here by requireAdminAuth -- same
// shape as api2App (routes/api2/*). The bare index route is the one
// exception: same Hono quirk already documented for api2Index/api2Docs in
// index.ts (a mounted sub-app's own "" route doesn't match the bare mount
// prefix, verified directly -- a session-bearing request to /admin/ fell
// straight through to the site-wide catch-all instead of reaching
// adminApp.get("/", ...)) -- `adminIndex` below is exported for an
// explicit top-level registration instead, checking auth inline rather
// than going through adminApp's middleware chain.
//
// WP 6.3 (PLAN.md §10.2.7): `GET /admin/credential/<name>/`
// (gfadmin/views.py:2866, returns any secret as text/plain) is not ported
// at all -- secrets live in Cloudflare Secrets Store / `wrangler secret`
// now, so there is no D1-backed credential value left for a view like that
// to leak. Nothing to delete here because nothing was ever built.
export const adminApp = new Hono<AppEnv>();

adminApp.use("*", requireAdminAuth);
adminApp.get("/proxy/", adminProxy);

// Placeholder -- WP 6.4 replaces this with the real need-review queue.
// Plain c.html() rather than the njk template system: an admin page
// layout is itself part of the not-yet-scoped WP 6.5+ forms work, not
// something to stand up early just for this stub.
export async function adminIndex(c: Context<AppEnv>): Promise<Response> {
  const session = await getAdminSession(c);
  if (!session) return c.redirect(`/auth/?next=${encodeURIComponent(c.req.path)}`, 302);

  return c.html(
    `<!doctype html><html><head><title>Admin</title></head><body>` +
      `<p>Signed in as ${escapeHtml(session.name)} (${escapeHtml(session.email)})</p>` +
      `<p><a href="/auth/sign-out/">Sign out</a></p>` +
      `</body></html>`,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
