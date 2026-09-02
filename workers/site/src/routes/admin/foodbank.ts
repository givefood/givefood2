import type { Context } from "hono";
import { getFoodbankBySlug, updateFoodbankFields } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { FOODBANK_FIELDS, FOODBANK_PARTIAL_FORMS, fieldsByName, parseAdminFields } from "../../lib/adminFormFields";
import { adminPageContext } from "./pageContext";

async function renderFoodbankForm(
  c: Context<AppEnv>,
  opts: { title: string; fieldSpecs: typeof FOODBANK_FIELDS; slug: string; stampEdited: boolean; redirectSuffix?: string },
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
  });
  return c.html(html);
}

// givefood/forms.py:58-70 FoodbankForm -- the full 30-field edit form.
// (No "new" branch here -- WP 6.6 owns food bank creation, alongside the
// rest of "CRUD for remaining models"; this WP is edit-forms-first,
// matching every other model built in this pass.)
export async function adminFoodbankEdit(c: Context<AppEnv>): Promise<Response> {
  return renderFoodbankForm(c, { title: "Edit Foodbank", fieldSpecs: FOODBANK_FIELDS, slug: c.req.param("slug")!, stampEdited: true });
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
