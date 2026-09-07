import type { Context } from "hono";
import type { Session } from "@givefood/db";
import {
  getFoodbankBySlug,
  updateFoodbankFields,
  insertFoodbank,
  deleteFoodbankCascade,
  setDiscrepancyStatus,
  foodbankNameTaken,
  foodbankSlugTaken,
  foodbankSlugForName,
} from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { AGGREGATE_TAG, constituencyTag, foodbankTag } from "@givefood/urls";
import { verifyCsrf } from "../../lib/csrf";
import type { AdminFieldSpec, AdminFieldValue } from "../../lib/adminFormFields";
import { FOODBANK_FIELDS, FOODBANK_PARTIAL_FORMS, fieldsByName, parseAdminFields } from "../../lib/adminFormFields";
import { adminPageContext } from "./pageContext";

// givefood/models/foodbank.py:148-151 Foodbank.clean() -- a model-level
// validation ModelForm._post_clean() runs on every admin save, so Django
// refuses the save with this message rather than publishing the same
// number twice. Gated on BOTH fields being on the form being submitted:
// Django compares against the instance for fields a partial form
// excludes, which would block an unrelated Address/Email edit whenever
// legacy data already holds a duplicate pair; the Phone partial form
// (adminFormFields.ts:153) and the two full forms post both, which is
// every form that can actually create the problem.
// Note the values compared here are already space-stripped by
// parseAdminFields (foodbank.py:649-652 does that in save(), i.e. after
// clean()), so "01234 567890" and "01234567890" are caught as the
// duplicate they are about to become on disk.
function phoneClashError(specs: readonly AdminFieldSpec[], values: Record<string, AdminFieldValue>): string | null {
  const hasBoth = specs.some((s) => s.name === "phone_number") && specs.some((s) => s.name === "secondary_phone_number");
  if (!hasBoth) return null;
  if (values.phone_number && values.phone_number === values.secondary_phone_number) {
    return "Phone number and secondary phone number can not be the same";
  }
  return null;
}

// The uniqueness validation Django's ModelForm did for free, and github #12
// says this port dropped: FoodbankForm(request.POST, instance=foodbank)
// .is_valid() ran _post_clean() -> instance.validate_unique(), so a
// duplicate came back as an error on the RE-RENDERED BOUND form with all 30
// typed fields (including whatever the Lookup buttons pulled out of Google
// Places) still on the page. Sending the write straight to D1 instead turns
// that into SQLITE_CONSTRAINT_UNIQUE -> app.onError -> the 500 page, and the
// admin retypes everything.
//
// Two constraints, checked in the order the admin can act on them:
//
//   foodbank_name_uniq -- Django's own `unique=True` (foodbank.py:61). The
//   wording is ModelForm's single-field branch verbatim,
//   "%(model_name)s with this %(field_label)s already exists." resolved
//   against capfirst(verbose_name)="Foodbank" and capfirst(name.verbose_name)
//   ="Name". The offending value is appended, as items.ts:133 does -- an
//   improvement on Django, kept deliberately, because the admin often gets
//   here from a Lookup that rewrote the field under them.
//
//   foodbank_slug_uniq -- no Django wording to copy: `slug` is
//   editable=False and NOT unique there, so Django wrote the duplicate and
//   broke the public page later. Say the thing the admin can act on instead,
//   because the name they typed is genuinely not a duplicate and pointing at
//   "Name already exists" would be a lie: slugify() eats case and
//   punctuation, so "St Marys Foodbank" collides with "St. Mary's Foodbank".
//
// `exceptId` is the row being edited (undefined when creating). Without it
// every ordinary save of an unrenamed food bank would fail, since the full
// form and the Politics form both post the row's own current name back.
async function nameClashError(db: Session, name: AdminFieldValue | undefined, exceptId: number | undefined): Promise<string | null> {
  // The 4 partial forms (address/phone/email/fsa-id) never post `name`, so
  // they touch neither index and skip both queries.
  if (typeof name !== "string" || !name) return null;

  if (await foodbankNameTaken(db, name, exceptId)) {
    return `Foodbank with this Name already exists: "${name}"`;
  }
  // Against the DERIVED slug, not the typed name: updateFoodbankFields and
  // insertFoodbank both re-slugify internally, so checking anything else
  // would let the write disagree with the check.
  const slug = foodbankSlugForName(name);
  if (await foodbankSlugTaken(db, slug, exceptId)) {
    return `Another food bank already uses the web address /needs/at/${slug}/ -- choose a name more distinct than "${name}"`;
  }
  return null;
}

async function renderFoodbankForm(
  c: Context<AppEnv>,
  opts: { title: string; fieldSpecs: typeof FOODBANK_FIELDS; slug: string; stampEdited: boolean },
): Promise<Response> {
  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, opts.slug);
  if (!foodbank) return c.notFound();

  // gfadmin/views.py:825-856 -- the `if request.POST:` branch has no
  // else, so an invalid form falls through to the same render() with the
  // BOUND form: every value the admin typed is still on the page, with
  // the error beside it. A bare text/plain 400 threw all 30 away.
  const renderForm = async (data: Record<string, unknown>, error: string | null) => {
    const html = await render("admin/foodbank_form.njk", {
      ...(await adminPageContext(c, "foodbanks")),
      title: opts.title,
      fields: opts.fieldSpecs,
      foodbank: data,
      show_proxy: true,
      error,
    });
    return c.html(html, error ? 400 : 200);
  };

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(opts.fieldSpecs, body as Record<string, unknown>);
    // Cheap local checks first, so a form that fails on a required field or
    // the phone clash costs no D1 round trip; the uniqueness lookups only
    // run when the rest of the form is already good.
    const error =
      (parsed.ok ? phoneClashError(opts.fieldSpecs, parsed.values) : parsed.error) ??
      (await nameClashError(db, parsed.values.name, foodbank.id));
    if (error) return renderForm({ ...foodbank, ...parsed.values }, error);

    // Backstop, not the guard -- nameClashError above is the guard, and this
    // is the same backstop adminFoodbankNew keeps around its INSERT. What is
    // left for this to catch is the race (a second admin taking the name
    // between that SELECT and this UPDATE) and anything else D1 refuses.
    // Without it those still reach app.onError and throw all 30 typed fields
    // away, which is the exact loss github #12 is about -- a check that
    // closes the common path but leaves the rare one landing on the 500 page
    // has fixed the report, not the class.
    let newSlug: string | null;
    try {
      newSlug = await updateFoodbankFields(db, foodbank.id, parsed.values, opts.stampEdited);
    } catch (err) {
      // The raw SQLite text goes to the log, not into the admin's page.
      console.error("foodbank save: update failed", err);
      return renderForm(
        { ...foodbank, ...parsed.values },
        "Could not save this food bank -- the database refused the change, so nothing was saved. Check the name is not already in use and try again.",
      );
    }

    // givefood/models/foodbank.py:717-758's do_decache, as a tag purge
    // rather than Django's hand-maintained URL list. Both slugs when the
    // name changed: the old one so its now-wrong pages stop being served
    // (they 404 or redirect afterwards, but a cached 200 would outlive
    // that), the new one because its pages may already be cached from a
    // crawler hit. Plus the constituency, whose page lists this food bank,
    // and the aggregates.
    //
    // waitUntil, not awaited: the admin gets its redirect immediately and
    // the purge happens on the way out. A failed enqueue must not turn a
    // successful save into an error page -- the data is already written.
    const purgeTags = [foodbankTag(foodbank.slug), AGGREGATE_TAG];
    if (newSlug && newSlug !== foodbank.slug) purgeTags.push(foodbankTag(newSlug));
    if (foodbank.parliamentary_constituency_slug) purgeTags.push(constituencyTag(foodbank.parliamentary_constituency_slug));
    c.executionCtx.waitUntil(
      c.env.PURGE_Q.send({ tags: purgeTags }).catch((err) => console.error("foodbank save: purge enqueue failed", err)),
    );

    // gfadmin/views.py:817-838 foodbank_form's ?discrepancy=<id> handling
    // -- the discrepancy page's embedded FoodbankForm posts back here with
    // that query string attached, so a successful save both fixes the
    // data AND resolves the discrepancy that flagged it, landing back on
    // the dashboard instead of the foodbank page (matching Django's own
    // redirect("admin:index") for this branch specifically).
    const discrepancyId = Number(c.req.query("discrepancy"));
    if (Number.isInteger(discrepancyId) && discrepancyId > 0) {
      await setDiscrepancyStatus(db, discrepancyId, "Done");
      return c.redirect("/admin/", 302);
    }

    // views.py:836 `redirect("admin:foodbank", slug = foodbank.slug)` --
    // the POST-SAVE slug. Foodbank.save() re-slugifies the name
    // (foodbank.py:634), so a rename moves the record to a new URL and
    // `foodbank.slug` read before the write is already stale.
    return c.redirect(`/admin/foodbank/${newSlug ?? foodbank.slug}/`, 302);
  }

  return renderForm(foodbank as unknown as Record<string, unknown>, null);
}

// givefood/forms.py:58-70 FoodbankForm -- the full 30-field edit form.
export async function adminFoodbankEdit(c: Context<AppEnv>): Promise<Response> {
  return renderFoodbankForm(c, { title: "Edit Foodbank", fieldSpecs: FOODBANK_FIELDS, slug: c.req.param("slug")!, stampEdited: true });
}

// gfadmin/views.py:817-858 foodbank_form's create branch (`slug=None`,
// real and reachable -- a "New Foodbank" button on the foodbanks list,
// WP 6.6 research). GET seeds `initial` from `?name/address/postcode`,
// matching Django's own prefill (e.g. from the cross-model search view,
// not itself ported this pass).
export async function adminFoodbankNew(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);

  // views.py:822 `page_title = "New Food Bank"`. The exact string is
  // load-bearing, not cosmetic: admin/form.html:14 renders
  // `class="form-{{ page_title|slugify }}"` and static/js/admin.js:105
  // selects `.form-new-food-bank #id_name` to attach the live "'X' food
  // bank already exists" duplicate check. "New Foodbank" slugified to
  // `form-new-foodbank` and the checker never ran.
  const title = "New Food Bank";
  const renderForm = async (data: Record<string, unknown>, error: string | null) => {
    const html = await render("admin/foodbank_form.njk", {
      ...(await adminPageContext(c, "foodbanks")),
      title,
      fields: FOODBANK_FIELDS,
      foodbank: data,
      show_proxy: false,
      error,
    });
    return c.html(html, error ? 400 : 200);
  };

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(FOODBANK_FIELDS, body as Record<string, unknown>);
    // No exceptId on a create -- there is no row to exclude. nameClashError
    // passes `undefined` through to `id IS NOT NULL`, which matches every
    // existing row; an `id != NULL` there would match none and wave the
    // duplicate straight through to the INSERT.
    const error =
      (parsed.ok ? phoneClashError(FOODBANK_FIELDS, parsed.values) : parsed.error) ??
      (await nameClashError(db, parsed.values.name, undefined));
    if (error) return renderForm({ ...parsed.values }, error);

    let created: { id: number; slug: string };
    try {
      created = await insertFoodbank(db, parsed.values);
    } catch (err) {
      // Backstop, not the guard -- the check above is the guard. What is
      // left for this to catch is the race (two admins creating the same
      // name between that SELECT and this INSERT) and anything else D1
      // refuses, so it no longer ASSERTS a duplicate the way it used to:
      // a NOT NULL violation or a D1 outage reported as "a food bank with
      // this name may already exist" sent the admin hunting for a duplicate
      // that was never there. The raw SQLite text goes to the log rather
      // than into the page; the admin gets their 30 fields back, which is
      // the part that matters.
      console.error("foodbank create: insert failed", err);
      return renderForm(
        { ...parsed.values },
        "Could not create food bank -- the database refused the save, so nothing was created. Check the name is not already in use and try again.",
      );
    }
    // gfadmin/views.py:817-858 foodbank_form redirects to `admin:foodbank`
    // (the detail page, WP 6.7) on success for both create and edit.
    return c.redirect(`/admin/foodbank/${created.slug}/`, 302);
  }

  const initial: Record<string, string> = {};
  for (const key of ["name", "address", "postcode"]) {
    const value = c.req.query(key);
    if (value) initial[key] = value;
  }

  return renderForm(initial, null);
}

// gfadmin/views.py:1364 foodbank_delete, @require_POST.
export async function adminFoodbankDelete(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const slug = c.req.param("slug")!;
  const foodbank = await getFoodbankBySlug(db, slug);
  if (!foodbank) return c.notFound();

  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  await deleteFoodbankCascade(db, foodbank.id);
  return c.redirect("/admin/foodbanks/", 302);
}

// givefood/forms.py:143-147 FoodbankPoliticsForm -- same 30 fields as
// FoodbankForm (confirmed, WP 6.5 research: `fields = "__all__"`, same
// `field_order`), reached from a different URL/UI entry point, with one
// real difference: no save() override, so `edited` is NOT stamped --
// preserved verbatim per the maintainer's explicit decision (WP 6.5),
// not "fixed" the way WP 6.3/6.4 fixed other Django defects this phase.
// views.py:1383 redirects to `admin:foodbank` on success exactly like the
// other six Foodbank form variants -- it does NOT re-open itself.
export async function adminFoodbankPoliticsEdit(c: Context<AppEnv>): Promise<Response> {
  return renderFoodbankForm(c, {
    title: "Edit Foodbank Politics",
    fieldSpecs: FOODBANK_FIELDS,
    slug: c.req.param("slug")!,
    stampEdited: false,
  });
}

// givefood/forms.py:73-140's 4 collapsed partial forms (WP 6.5, maintainer
// decision) -- FoodbankUrlsForm, the 5th, stays separate (routes/admin/
// foodbankUrls.ts) since its GET request isn't boilerplate.
export async function adminFoodbankPartialEdit(c: Context<AppEnv>): Promise<Response> {
  const formSlug = c.req.param("form")!;
  const config = FOODBANK_PARTIAL_FORMS.find((f) => f.slug === formSlug);
  if (!config) return c.notFound();

  return renderFoodbankForm(c, {
    title: config.title,
    fieldSpecs: fieldsByName(config.fieldNames),
    slug: c.req.param("slug")!,
    stampEdited: true,
  });
}
