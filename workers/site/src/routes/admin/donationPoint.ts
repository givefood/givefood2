import type { Context } from "hono";
import { getFoodbankBySlug, getDonationPointBySlugs, upsertDonationPoint, deleteDonationPoint, getLocationLatLngsByFoodbankId } from "@givefood/db";
import { render } from "@givefood/templates";
import { AGGREGATE_TAG, foodbankTag } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { FOODBANK_DONATION_POINT_FIELDS, parseAdminFields } from "../../lib/adminFormFields";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:1834-1862 donationpoint_form -- create (no :dpSlug) and
// edit (with :dpSlug) in one handler. views.py:1850 redirects to
// `admin:foodbank` with a `#donationpoints` fragment (the only fragment
// redirect in the whole Django admin); the detail page is tabbed
// (foodbank_detail.njk:23/:307) and tabber.js:43-52 opens the tab named by
// the hash, so that fragment is what lands the admin back on the Donation
// Points tab with the row they just saved on screen.
export async function adminDonationPointForm(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const dpSlug = c.req.param("dpSlug");
  const db = dbSession(c);

  const foodbank = await getFoodbankBySlug(db, slug);
  if (!foodbank) return c.notFound();

  const existing = dpSlug ? await getDonationPointBySlugs(db, slug, dpSlug) : null;
  if (dpSlug && !existing) return c.notFound();

  // views.py:1841/1844 `page_title = "Edit Donation Point"` / "New
  // Donation Point" -- bare, with no food bank name in it. That is
  // load-bearing rather than cosmetic: generic_form.njk renders
  // `class="form-{{ title|slugify }}"` and static/js/admin.js:106 selects
  // `.form-new-donation-point #id_name, .form-edit-donation-point #id_name`
  // by exact class. Interpolating the food bank name produced
  // `form-new-brixton-food-bank-donation-point`, which matches neither, so
  // the "Lookup Donation Point" button (one click fills lat_lng, place_id,
  // address, postcode, phone_number, url, opening_hours and
  // wheelchair_accessible from Google Places) was never injected and
  // initCompanyAutoSelect() never attached. The name moves to a subtitle.
  const title = existing ? "Edit Donation Point" : "New Donation Point";

  const renderForm = async (data: Record<string, unknown>, error: string | null) => {
    const html = await render("admin/generic_form.njk", {
      ...(await adminPageContext(c, "foodbanks")),
      title,
      subtitle: foodbank.name,
      fields: FOODBANK_DONATION_POINT_FIELDS,
      data,
      delete_url: existing ? `/admin/foodbank/${foodbank.slug}/donationpoint/${existing.slug}/delete/` : null,
      error,
      // admin/form.html:30-36 renders the food bank's own site beside the
      // fields so an admin can read from it while typing. `preview_field`
      // rather than Django's `?url=`: routes/admin/proxy.ts resolves the URL
      // from D1 by field name, which is the fix for the SSRF that parameter was.
      // Django's donationpoint_form passes no `foodbank` into template_vars
      // (views.py:1858-1861), so form.html:31's `{% if foodbank %}` is false
      // and this page has NO preview there -- the port adds one deliberately.
      preview_foodbank_slug: foodbank.url ? foodbank.slug : null,
      preview_field: foodbank.url ? "url" : null,
    });
    return c.html(html, error ? 400 : 200);
  };

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(FOODBANK_DONATION_POINT_FIELDS, body as Record<string, unknown>);
    let error = parsed.ok ? null : parsed.error;

    // givefood/models/foodbank.py:1247-1256 FoodbankDonationPoint.clean()
    // -- run by ModelForm._post_clean() on every admin save, and gated on
    // `if self.postcode:` exactly as here. A donation point sharing the
    // food bank's own lat_lng (or one of its locations') stacks two
    // markers on the same point on the public map, which nothing
    // downstream can detect. Django compares against locations() (all of
    // them, closed included), foodbank.lat_lng and delivery_lat_lng; it
    // does NOT compare against other donation points, so neither do we.
    if (!error && parsed.values.postcode && typeof parsed.values.lat_lng === "string") {
      const latLngs = new Set<string>(await getLocationLatLngsByFoodbankId(db, foodbank.id));
      latLngs.add(foodbank.lat_lng);
      if (foodbank.delivery_lat_lng) latLngs.add(foodbank.delivery_lat_lng);
      if (latLngs.has(parsed.values.lat_lng)) error = "Location can't be the same as the food bank or one of it's locations";
    }

    if (error) return renderForm({ ...parsed.values }, error);

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
    // views.py:1850-1851 `"%s#donationpoints" % reverse("admin:foodbank")`.
    // A location/donation point change alters the food bank's own pages and
    // the aggregate list endpoints -- same tag purge foodbank.ts's save does.
    // waitUntil so a purge failure cannot fail a save that already happened.
    c.executionCtx.waitUntil(
      c.env.PURGE_Q.send({ tags: [foodbankTag(foodbank.slug), AGGREGATE_TAG] }).catch((err) =>
        console.error("purge enqueue failed", err),
      ),
    );
    return c.redirect(`/admin/foodbank/${foodbank.slug}/#donationpoints`, 302);
  }

  const nameFromQuery = c.req.query("name");
  const postcodeFromQuery = c.req.query("postcode");
  const data = existing ?? (nameFromQuery || postcodeFromQuery ? { name: nameFromQuery, postcode: postcodeFromQuery } : {});

  return renderForm(data as unknown as Record<string, unknown>, null);
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
