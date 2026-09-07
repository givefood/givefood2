import type { Context } from "hono";
import {
  getFoodbankBySlug,
  getFoodbankLocationBySlugs,
  upsertLocation,
  deleteLocation,
  locationNameTaken,
  locationSlugTaken,
  locationSlug,
} from "@givefood/db";
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

  const title = existing ? `Edit ${foodbank.name} Food Bank Location` : `New ${foodbank.name} Food Bank Location`;

  // One renderer for the GET and for every POST that fails validation, so a
  // rejected save comes back as the SAME page the admin was looking at with
  // their own values still in it. That is the whole of issue #12: what broke
  // was not that a duplicate was refused, it was that refusing it threw away
  // ten fields including a boundary GeoJSON textarea and whatever the Lookup
  // button had just fetched from Google Places.
  const renderForm = async (data: Record<string, unknown>, error: string | null) => {
    const html = await render("admin/generic_form.njk", {
      ...(await adminPageContext(c, "foodbanks")),
      title,
      fields: FOODBANK_LOCATION_FIELDS,
      data,
      delete_url: existing ? `/admin/foodbank/${foodbank.slug}/location/${existing.slug}/delete/` : null,
      error,
      // admin/form.html:30-36 renders the food bank's own site beside the
      // fields so an admin can read from it while typing. `preview_field`
      // rather than Django's `?url=`: routes/admin/proxy.ts resolves the URL
      // from D1 by field name, which is the fix for the SSRF that parameter was.
      preview_foodbank_slug: foodbank.url ? foodbank.slug : null,
      preview_field: foodbank.url ? "url" : null,
    });
    // 400 is the status this handler already used for a validation failure
    // (the bare `c.text(parsed.error, 400)` this replaces); Django itself
    // re-rendered a bound form at 200. Kept at 400 to match items.ts:149 and
    // donationPoint.ts, and because the change that matters is the body, not
    // the code.
    return c.html(html, error ? 400 : 200);
  };

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(FOODBANK_LOCATION_FIELDS, body as Record<string, unknown>);
    let error = parsed.ok ? null : parsed.error;

    const name = typeof parsed.values.name === "string" ? parsed.values.name : "";
    const slug = locationSlug(name);

    // ModelForm.validate_unique() against foodbank.py:794-795's
    // unique_together=('foodbank','name') -- the check whose absence is
    // issue #12. Wording is Django's own message for the multi-field branch,
    // verified by running Django 5.2's Model.unique_error_message() against
    // this model's Meta rather than transcribed from memory: verbose_name
    // "foodbank location" capfirst'd, then the two field labels joined with
    // "and". The offending value is appended the way items.ts:133 does --
    // an addition to Django, kept because "already exists" with no
    // indication of WHICH name is a poor error on a form with ten fields.
    //
    // `existing?.id` covers both halves in one call: undefined on create,
    // the row's own id on edit, so saving a location without renaming it is
    // not reported as a clash.
    if (!error && (await locationNameTaken(db, foodbank.id, name, existing?.id))) {
      error = `Foodbank location with this Foodbank and Name already exists: "${name}"`;
    }

    // Separate constraint, separate failure: the slug is derived from the
    // name, so it can clash when the name does not (see locationSlugTaken's
    // comment). No 500 to prevent here -- loc_foodbank_slug_idx is not
    // unique -- but the row that would be written is unreachable and its
    // edit URL overwrites its twin, which is a silent loss rather than a
    // loud one.
    //
    // Skipped when the slug is unchanged (`slug !== existing?.slug`, always
    // true on create, where existing is null). Production predates this
    // check, so a pair of already-colliding rows may exist; without this
    // guard the surviving, reachable one of that pair would become
    // permanently unsavable -- punishing an admin for a collision they did
    // not create. New collisions are still refused.
    if (!error && slug !== existing?.slug && (await locationSlugTaken(db, foodbank.id, slug, existing?.id))) {
      error = `Another location at this food bank already uses the URL "${slug}", which is derived from the name -- two names differing only in punctuation produce the same one`;
    }

    if (error) return renderForm({ ...parsed.values }, error);

    // Backstop, not the guard -- locationNameTaken above is the guard, and
    // this is the same backstop foodbank.ts keeps around its own save. What
    // is left for it to catch is the gap between that SELECT and this write:
    // a second admin taking the name in between, a browser retrying a slow
    // POST, and above all a STALE READ -- lib/session.ts opens every request
    // "first-unconstrained" and this database has read replication enabled
    // (packages/db/src/types.ts:1-7), so the pre-flight can run against a
    // replica that has not yet seen an insert the primary already holds.
    // Without this, those still reach app.onError and throw ten fields away,
    // which is the exact loss issue #12 is about: closing the common path
    // and leaving the rare one on the 500 page fixes the report, not the
    // class.
    try {
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
    } catch (err) {
      // The raw SQLite text goes to the log, not into the admin's page.
      console.error("location save: upsert failed", err);
      return renderForm(
        { ...parsed.values },
        "Could not save this location -- the database refused the change, so nothing was saved. Check the name is not already in use and try again.",
      );
    }
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

  // admin/foodbank_check.njk:167 links here with ?name=&postcode= prefilled
  // from a location the check job flagged as missing -- and it flags on
  // POSTCODE ALONE (adminJobs/foodbankCheck.ts:243), so a location we
  // already hold whose postcode moved is offered back to the admin with the
  // name that will collide. That is how the create half of issue #12 is
  // reached without the admin typing a duplicate at all.
  const nameFromQuery = c.req.query("name");
  const postcodeFromQuery = c.req.query("postcode");
  // Spread rather than assigned: an interface has no index signature, so
  // `existing` on its own is not assignable to Record<string, unknown>
  // (same reason items.ts:103 spreads its row).
  const data: Record<string, unknown> = existing
    ? { ...existing }
    : nameFromQuery || postcodeFromQuery
      ? { name: nameFromQuery, postcode: postcodeFromQuery }
      : {};

  return renderForm(data, null);
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
