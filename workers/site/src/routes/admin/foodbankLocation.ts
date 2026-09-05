import type { Context } from "hono";
import { getFoodbankBySlug, getFoodbankLocationBySlugs, upsertLocation, deleteLocation } from "@givefood/db";
import { render } from "@givefood/templates";
import { AGGREGATE_TAG, foodbankTag } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { FOODBANK_LOCATION_FIELDS, parseAdminFields } from "../../lib/adminFormFields";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:1614-1644 fblocation_form -- create (no :locSlug) and
// edit (with :locSlug) in one handler, matching Django's single view.
// Redirects to `admin:foodbank`'s equivalent, the tabbed detail page
// (WP 6.7), matching Django exactly.
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
    // A location/donation point change alters the food bank's own pages and
    // the aggregate list endpoints -- same tag purge foodbank.ts's save does.
    // waitUntil so a purge failure cannot fail a save that already happened.
    c.executionCtx.waitUntil(
      c.env.PURGE_Q.send({ tags: [foodbankTag(foodbank.slug), AGGREGATE_TAG] }).catch((err) =>
        console.error("purge enqueue failed", err),
      ),
    );
    return c.redirect(`/admin/foodbank/${foodbank.slug}/`, 302);
  }

  const nameFromQuery = c.req.query("name");
  const postcodeFromQuery = c.req.query("postcode");
  const data = existing ?? (nameFromQuery || postcodeFromQuery ? { name: nameFromQuery, postcode: postcodeFromQuery } : {});

  const html = await render("admin/generic_form.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    title: existing ? `Edit ${foodbank.name} Food Bank Location` : `New ${foodbank.name} Food Bank Location`,
    fields: FOODBANK_LOCATION_FIELDS,
    data,
    delete_url: existing ? `/admin/foodbank/${foodbank.slug}/location/${existing.slug}/delete/` : null,
    // admin/form.html:30-36 renders the food bank's own site beside the
    // fields so an admin can read from it while typing. `preview_field`
    // rather than Django's `?url=`: routes/admin/proxy.ts resolves the URL
    // from D1 by field name, which is the fix for the SSRF that parameter was.
    preview_foodbank_slug: foodbank.url ? foodbank.slug : null,
    preview_field: foodbank.url ? "url" : null,
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
  // foodbank_check.njk's Delete uses hx-target="closest li" / hx-swap="outerHTML",
  // which needs an empty body to swap in -- same branch as photoDelete.ts. Without
  // it htmx follows the 302 below and swaps the whole detail page into the <li>.
  // The plain-form caller (generic_form.njk) sends no HX-Request and keeps the 302.
  if (c.req.header("HX-Request")) return c.body(null, 200);
  return c.redirect(`/admin/foodbank/${slug}/`, 302);
}
