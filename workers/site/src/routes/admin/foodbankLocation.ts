import type { Context } from "hono";
import { getFoodbankBySlug, getFoodbankLocationBySlugs, upsertLocation, deleteLocation } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { FOODBANK_LOCATION_FIELDS, parseAdminFields } from "../../lib/adminFormFields";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:1614-1644 fblocation_form -- create (no :locSlug) and
// edit (with :locSlug) in one handler, matching Django's single view.
// Redirects to the food bank's own edit page rather than `admin:foodbank`
// (Django's tabbed detail page) -- that page is WP 6.7's htmx-surface
// work, not built yet; the edit form is the closest thing that exists.
export async function adminFoodbankLocationForm(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const locSlug = c.req.param("locSlug");
  const db = dbSession(c);

  const foodbank = await getFoodbankBySlug(db, slug);
  if (!foodbank) return c.notFound();

  const existing = locSlug ? await getFoodbankLocationBySlugs(db, slug, locSlug) : null;
  if (locSlug && !existing) return c.notFound();

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(FOODBANK_LOCATION_FIELDS, body as Record<string, unknown>);
    if (!parsed.ok) return c.text(parsed.error, 400);

    await upsertLocation(
      db,
      {
        foodbankId: foodbank.id,
        foodbank: {
          name: foodbank.name,
          slug: foodbank.slug,
          network: foodbank.network,
          phone_number: foodbank.phone_number,
          contact_email: foodbank.contact_email,
          country: foodbank.country,
        },
        name: String(parsed.values.name),
        address: parsed.values.address as string | null,
        postcode: parsed.values.postcode as string | null,
        isDonationPoint: Number(parsed.values.is_donation_point),
        isMobile: Number(parsed.values.is_mobile),
        latLng: String(parsed.values.lat_lng),
        boundaryGeojson: parsed.values.boundary_geojson as string | null,
        placeId: parsed.values.place_id as string | null,
        phoneNumber: parsed.values.phone_number as string | null,
        email: parsed.values.email as string | null,
      },
      existing?.id,
    );
    return c.redirect(`/admin/foodbank/${foodbank.slug}/edit/`, 302);
  }

  const nameFromQuery = c.req.query("name");
  const data = existing ?? (nameFromQuery ? { name: nameFromQuery } : {});

  const html = await render("admin/generic_form.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    title: existing ? `Edit ${foodbank.name} Food Bank Location` : `New ${foodbank.name} Food Bank Location`,
    fields: FOODBANK_LOCATION_FIELDS,
    data,
    back_url: `/admin/foodbank/${foodbank.slug}/edit/`,
    delete_url: existing ? `/admin/foodbank/${foodbank.slug}/location/${existing.slug}/delete/` : null,
  });
  return c.html(html);
}

// gfadmin/views.py:1741 fblocation_delete, @require_POST.
export async function adminFoodbankLocationDelete(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const locSlug = c.req.param("locSlug")!;
  const db = dbSession(c);

  const existing = await getFoodbankLocationBySlugs(db, slug, locSlug);
  if (!existing) return c.notFound();

  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  await deleteLocation(db, existing.id);
  return c.redirect(`/admin/foodbank/${slug}/edit/`, 302);
}
