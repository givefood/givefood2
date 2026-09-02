import type { Context } from "hono";
import { getFoodbankBySlug, updateFoodbankFields, insertFoodbank, deleteFoodbankCascade } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { FOODBANK_FIELDS, FOODBANK_PARTIAL_FORMS, fieldsByName, parseAdminFields } from "../../lib/adminFormFields";
import { adminPageContext } from "./pageContext";

async function renderFoodbankForm(
  c: Context<AppEnv>,
  opts: { title: string; fieldSpecs: typeof FOODBANK_FIELDS; slug: string; stampEdited: boolean; redirectSuffix?: string; showDelete?: boolean },
): Promise<Response> {
  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, opts.slug);
  if (!foodbank) return c.notFound();

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(opts.fieldSpecs, body as Record<string, unknown>);
    if (!parsed.ok) return c.text(parsed.error, 400);

    await updateFoodbankFields(db, foodbank.id, parsed.values, opts.stampEdited);
    return c.redirect(`/admin/foodbank/${foodbank.slug}/${opts.redirectSuffix ?? ""}`, 302);
  }

  const html = await render("admin/foodbank_form.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    title: opts.title,
    fields: opts.fieldSpecs,
    foodbank,
    show_proxy: true,
    show_delete: opts.showDelete ?? false,
  });
  return c.html(html);
}

// givefood/forms.py:58-70 FoodbankForm -- the full 30-field edit form.
export async function adminFoodbankEdit(c: Context<AppEnv>): Promise<Response> {
  return renderFoodbankForm(c, { title: "Edit Foodbank", fieldSpecs: FOODBANK_FIELDS, slug: c.req.param("slug")!, stampEdited: true, showDelete: true });
}

// gfadmin/views.py:817-858 foodbank_form's create branch (`slug=None`,
// real and reachable -- a "New Foodbank" button on the foodbanks list,
// WP 6.6 research). GET seeds `initial` from `?name/address/postcode`,
// matching Django's own prefill (e.g. from the cross-model search view,
// not itself ported this pass).
export async function adminFoodbankNew(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(FOODBANK_FIELDS, body as Record<string, unknown>);
    if (!parsed.ok) return c.text(parsed.error, 400);

    let created: { id: number; slug: string };
    try {
      created = await insertFoodbank(db, parsed.values);
    } catch (err) {
      return c.text(`Could not create food bank -- a food bank with this name may already exist (${err instanceof Error ? err.message : String(err)})`, 400);
    }
    return c.redirect(`/admin/foodbank/${created.slug}/edit/`, 302);
  }

  const initial: Record<string, string> = {};
  for (const key of ["name", "address", "postcode"]) {
    const value = c.req.query(key);
    if (value) initial[key] = value;
  }

  const html = await render("admin/foodbank_form.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    title: "New Foodbank",
    fields: FOODBANK_FIELDS,
    foodbank: initial,
    show_proxy: false,
  });
  return c.html(html);
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
export async function adminFoodbankPoliticsEdit(c: Context<AppEnv>): Promise<Response> {
  return renderFoodbankForm(c, {
    title: "Edit Foodbank Politics",
    fieldSpecs: FOODBANK_FIELDS,
    slug: c.req.param("slug")!,
    stampEdited: false,
    redirectSuffix: "politics/edit/",
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
