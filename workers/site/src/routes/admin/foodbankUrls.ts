import type { Context } from "hono";
import { getFoodbankBySlug, updateFoodbankFields } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { fieldsByName, parseAdminFields } from "../../lib/adminFormFields";
import { adminPageContext } from "./pageContext";

const URL_FIELD_NAMES = ["url", "shopping_list_url", "rss_url", "news_url", "donation_points_url", "locations_url", "contacts_url"] as const;

// givefood/forms.py:73-84 FoodbankUrlsForm -- kept separate from the 4
// collapsed partials (routes/admin/foodbank.ts) because Django's GET
// branch (views.py:1405-1500) isn't boilerplate: it opens a CrawlItem,
// fetches the food bank's live homepage, scrapes links (BeautifulSoup +
// a regex fallback), and calls Gemini with a JSON schema to suggest
// values for any empty URL field, tagging suggested fields `is-success`.
// WP 6.5 (maintainer decision): build the plain edit/save path now: this
// endpoint's suggest-on-GET behaviour is genuinely the same class of work
// as WP 6.8 ("foodbank_check ... Neither survives a request-scoped
// Worker") -- a live fetch plus a synchronous AI call inside a GET
// handler -- and belongs with that Queue+polling infrastructure once it
// exists, not bolted on here first.
export async function adminFoodbankUrlsEdit(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, slug);
  if (!foodbank) return c.notFound();

  const fieldSpecs = fieldsByName(URL_FIELD_NAMES);

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(fieldSpecs, body as Record<string, unknown>);
    if (!parsed.ok) return c.text(parsed.error, 400);

    await updateFoodbankFields(db, foodbank.id, parsed.values, true);
    return c.redirect(`/admin/foodbank/${foodbank.slug}/`, 302);
  }

  const html = await render("admin/foodbank_form.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    title: "URLs",
    fields: fieldSpecs,
    foodbank,
    show_proxy: true,
  });
  return c.html(html);
}
