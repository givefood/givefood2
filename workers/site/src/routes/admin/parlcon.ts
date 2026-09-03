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

  const title = existing ? `Edit ${existing.name}` : "New Parliamentary Constituency";

  // views.py:2555-2576's `if request.POST:` branch has no else, so an
  // invalid form falls through to the same render() with the BOUND form --
  // the values stay on screen with the error beside them, rather than the
  // page being replaced by a plain-text 400.
  const renderForm = async (data: Record<string, unknown>, error: string | null) => {
    const html = await render("admin/generic_form.njk", {
      ...(await adminPageContext(c, "settings")),
      title,
      fields: PARLCON_FIELDS,
      data,
      // Django's admin/form.html has no Back link either -- not an omission.
      back_url: null,
      error,
    });
    return c.html(html, error ? 400 : 200);
  };

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(PARLCON_FIELDS, body as Record<string, unknown>);
    if (!parsed.ok) return renderForm({ ...parsed.values }, parsed.error);

    const mpParlId = Number.parseInt(String(parsed.values.mp_parl_id), 10);
    if (!Number.isInteger(mpParlId)) return renderForm({ ...parsed.values }, "MP's ID must be a whole number");

    await upsertParliamentaryConstituency(
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
    // views.py:2568 `redirect("admin:politics")` -- a save, new or edit,
    // returns to the constituency list so the next one can be picked,
    // which is the batch-MP-update workflow. Re-opening the form it just
    // saved gave the admin no signal that anything had happened.
    return c.redirect("/admin/politics/", 302);
  }

  return renderForm((existing ?? {}) as unknown as Record<string, unknown>, null);
}
