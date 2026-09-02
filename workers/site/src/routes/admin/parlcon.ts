import type { Context } from "hono";
import { getConstituencyBySlug, upsertParliamentaryConstituency } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { PARLCON_FIELDS, parseAdminFields } from "../../lib/adminFormFields";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:2555-2576 parlcon_form -- create (no :slug) and edit
// (with :slug) in one handler. Django's two URL patterns share the name
// "parlcon_form" (WP 6.5 research: not a bug, `reverse()` picks the
// pattern matching the kwargs given), reproduced here as two distinct
// registrations instead -- Hono has no naming collision to work around.
export async function adminParlconForm(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug");
  const db = dbSession(c);

  const existing = slug ? await getConstituencyBySlug(db, slug) : null;
  if (slug && !existing) return c.notFound();

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(PARLCON_FIELDS, body as Record<string, unknown>);
    if (!parsed.ok) return c.text(parsed.error, 400);

    const mpParlId = Number.parseInt(String(parsed.values.mp_parl_id), 10);
    if (!Number.isInteger(mpParlId)) return c.text("MP's ID must be a whole number", 400);

    const newSlug = await upsertParliamentaryConstituency(
      db,
      {
        name: String(parsed.values.name),
        country: parsed.values.country as string | null,
        mp: parsed.values.mp as string | null,
        mpParty: parsed.values.mp_party as string | null,
        mpParlId,
        email: parsed.values.email as string | null,
        centroid: String(parsed.values.centroid),
        boundaryGeojson: parsed.values.boundary_geojson as string | null,
      },
      existing?.id,
    );
    return c.redirect(`/admin/parlcon/${newSlug}/edit/`, 302);
  }

  const html = await render("admin/generic_form.njk", {
    ...(await adminPageContext(c, "settings")),
    title: existing ? `Edit ${existing.name}` : "New Parliamentary Constituency",
    fields: PARLCON_FIELDS,
    data: existing ?? {},
    back_url: null,
  });
  return c.html(html);
}
