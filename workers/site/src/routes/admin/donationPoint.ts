import type { Context } from "hono";
import { getFoodbankBySlug, getDonationPointBySlugs, upsertDonationPoint, deleteDonationPoint } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { FOODBANK_DONATION_POINT_FIELDS, parseAdminFields } from "../../lib/adminFormFields";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:1834-1862 donationpoint_form -- create (no :dpSlug) and
// edit (with :dpSlug) in one handler. POST redirect appends `#donationpoints`
// in Django (targeting a tab on the not-yet-built `admin:foodbank` page);
// this redirects to the edit form instead, same reasoning as
// foodbankLocation.ts's own comment.
export async function adminDonationPointForm(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const dpSlug = c.req.param("dpSlug");
  const db = dbSession(c);

  const foodbank = await getFoodbankBySlug(db, slug);
  if (!foodbank) return c.notFound();

  const existing = dpSlug ? await getDonationPointBySlugs(db, slug, dpSlug) : null;
  if (dpSlug && !existing) return c.notFound();

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(FOODBANK_DONATION_POINT_FIELDS, body as Record<string, unknown>);
    if (!parsed.ok) return c.text(parsed.error, 400);

    await upsertDonationPoint(
      db,
      {
        foodbankId: foodbank.id,
        foodbank: { name: foodbank.name, slug: foodbank.slug, network: foodbank.network },
        name: String(parsed.values.name),
        address: String(parsed.values.address),
        postcode: String(parsed.values.postcode),
        phoneNumber: parsed.values.phone_number as string | null,
        openingHours: parsed.values.opening_hours as string | null,
        wheelchairAccessible: parsed.values.wheelchair_accessible as number | null,
        url: parsed.values.url as string | null,
        inStoreOnly: Number(parsed.values.in_store_only),
        company: parsed.values.company as string | null,
        storeId: parsed.values.store_id as string | null,
        notes: parsed.values.notes as string | null,
        latLng: String(parsed.values.lat_lng),
        placeId: parsed.values.place_id as string | null,
      },
      existing?.id,
    );
    return c.redirect(`/admin/foodbank/${foodbank.slug}/`, 302);
  }

  const nameFromQuery = c.req.query("name");
  const postcodeFromQuery = c.req.query("postcode");
  const data = existing ?? (nameFromQuery || postcodeFromQuery ? { name: nameFromQuery, postcode: postcodeFromQuery } : {});

  const html = await render("admin/generic_form.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    title: existing ? `Edit ${foodbank.name} Donation Point` : `New ${foodbank.name} Donation Point`,
    fields: FOODBANK_DONATION_POINT_FIELDS,
    data,
    back_url: `/admin/foodbank/${foodbank.slug}/`,
    delete_url: existing ? `/admin/foodbank/${foodbank.slug}/donationpoint/${existing.slug}/delete/` : null,
    // admin/form.html:30-36 renders the food bank's own site beside the
    // fields so an admin can read from it while typing. `preview_field`
    // rather than Django's `?url=`: routes/admin/proxy.ts resolves the URL
    // from D1 by field name, which is the fix for the SSRF that parameter was.
    preview_foodbank_slug: foodbank.url ? foodbank.slug : null,
    preview_field: foodbank.url ? "url" : null,
  });
  return c.html(html);
}

// gfadmin/views.py:1865 donationpoint_delete.
export async function adminDonationPointDelete(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const dpSlug = c.req.param("dpSlug")!;
  const db = dbSession(c);

  const existing = await getDonationPointBySlugs(db, slug, dpSlug);
  if (!existing) return c.notFound();

  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  await deleteDonationPoint(db, existing.id);
  // foodbank_check.njk's Delete uses hx-target="closest li" / hx-swap="outerHTML",
  // which needs an empty body to swap in -- same branch as photoDelete.ts. Without
  // it htmx follows the 302 below and swaps the whole detail page into the <li>.
  // The plain-form caller (generic_form.njk) sends no HX-Request and keeps the 302.
  if (c.req.header("HX-Request")) return c.body(null, 200);
  return c.redirect(`/admin/foodbank/${slug}/`, 302);
}
