import type { Context } from "hono";
import { totalPages, getSlugRedirectsPage, getSlugRedirectById, slugRedirectOldSlugTaken, upsertSlugRedirect } from "@givefood/db";
import { render } from "@givefood/templates";
import { foodbankTag } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { parseAdminFields, type AdminFieldSpec } from "../../lib/adminFormFields";
import { timesince } from "../../lib/timesince";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:2276-2308 -- slug_redirects() (the list) and
// slug_redirect_form() (create+edit in ONE Django view, registered at two
// URLs: gfadmin/urls/core.py:9-10).
//
// Django's admin has no CSRF middleware (settings.py:97 comments it out),
// so its form POST is unprotected and its list page has no mutating
// buttons at all. Here every mutation is POST + verifyCsrf -> 403.

const PAGE_SIZE = 100;

function parsePage(c: Context<AppEnv>): number {
  const raw = Number.parseInt(c.req.query("page") ?? "1", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

// givefood/forms.py:219-222 SlugRedirectForm -- `fields = "__all__"` on
// SlugRedirect yields exactly these two inputs: `id` is the auto PK and
// `created`/`modified` are editable=False on TimestampedModel
// (givefood/models/base.py:12-19), so ModelForm excludes all three.
// Labels are Django's own auto verbose_names ("Old slug"/"New slug", the
// field name with only its first letter capitalised). The help text is a
// port addition -- Django shows none -- because "slug" here means the bare
// path segment, and typing a full URL in is the obvious mistake.
//
// Declared here rather than in lib/adminFormFields.ts alongside
// PARLCON_FIELDS purely because that file is shared with several other
// in-flight work packages; it belongs there, see the wiring notes.
const SLUG_REDIRECT_FIELDS: readonly AdminFieldSpec[] = [
  { name: "old_slug", label: "Old slug", kind: "text", required: true, helpText: 'The retired food bank slug, e.g. "durham" -- no leading or trailing slash.' },
  { name: "new_slug", label: "New slug", kind: "text", required: true, helpText: 'The slug it should 301 to, e.g. "county-durham".' },
] as const;

// givefood/models/operations.py:46-47 -- CharField(max_length=200) on both.
// Django's ModelForm enforces this; parseAdminFields has no length rule of
// its own, so the route does it.
const MAX_SLUG_LENGTH = 200;

// gfadmin/views.py:2276-2284 slug_redirects() + admin/slug_redirects.html.
// Django's table is 4 columns (Old Slug / New Slug / Created / Edit) with
// no empty state, no count, no sort links and no pagination; the port adds
// the count, the empty state and real pagination, matching every other
// ported admin list. `created` uses this admin's standard two-line date
// cell rather than Django's `|naturaltime` (django.contrib.humanize, which
// has no port equivalent) -- a superset of the same information.
export async function adminSlugRedirectsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const now = new Date();
  const page = await getSlugRedirectsPage(db, parsePage(c), PAGE_SIZE);

  const html = await render("admin/slug_redirects.njk", {
    ...(await adminPageContext(c, "settings")), // views.py:2282 "section":"settings"
    total: page.total,
    page: page.page,
    total_pages: totalPages(page.total, page.pageSize),
    has_next: page.hasNext,
    rows: page.rows.map((row) => ({ ...row, created_ago: timesince(row.created, now) })),
  });
  return c.html(html);
}

// gfadmin/views.py:2287-2308 slug_redirect_form(request, id=None) -- one
// handler for /new/ and /:id/edit/, exactly as Django uses one view for
// its two URL patterns. Django branches on `if request.POST:` (the
// truthiness of the POST dict, not the method); both fields are required
// so an empty POST could never validate there anyway, and branching on
// the method here is the same behaviour with one less trap.
export async function adminSlugRedirectForm(c: Context<AppEnv>): Promise<Response> {
  const idParam = c.req.param("id");
  // Django's `<int:id>` path converter -- Hono has no equivalent, so a
  // non-numeric id 404s here rather than reaching the query.
  const id = idParam !== undefined ? Number.parseInt(idParam, 10) : undefined;
  if (idParam !== undefined && (id === undefined || !Number.isInteger(id))) return c.notFound();

  const db = dbSession(c);
  const existing = id !== undefined ? await getSlugRedirectById(db, id) : null;
  if (id !== undefined && !existing) return c.notFound(); // views.py:2290 get_object_or_404

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const parsed = parseAdminFields(SLUG_REDIRECT_FIELDS, body as Record<string, unknown>);
    if (!parsed.ok) return c.text(parsed.error, 400);
    const oldSlug = String(parsed.values.old_slug);
    const newSlug = String(parsed.values.new_slug);

    // Validation errors are a plain 400 here rather than Django's
    // re-rendered form with inline `{{ form|bulma }}` errors
    // (views.py:2296-2302) -- the port's established convention, see
    // routes/admin/parlcon.ts:28,31. generic_form.njk has no error slot
    // and building one for a two-field form is out of proportion.
    if (oldSlug.length > MAX_SLUG_LENGTH || newSlug.length > MAX_SLUG_LENGTH) {
      return c.text(`Slugs are limited to ${MAX_SLUG_LENGTH} characters`, 400);
    }
    // The unique=True clash Django reports as "Slug redirect with this Old
    // slug already exists." (models/operations.py:46). The UNIQUE index in
    // 0016_slugredirect.sql is the real guard; this is what turns it into
    // a readable message instead of a D1 constraint error.
    if (await slugRedirectOldSlugTaken(db, oldSlug, existing?.id)) {
      return c.text(`A redirect from "${oldSlug}" already exists`, 400);
    }
    // PORT ADDITION, no Django equivalent: old == new is an infinite 301
    // loop the moment the blob reaches the middleware, and Django will
    // happily let an admin save it.
    if (oldSlug === newSlug) return c.text("Old slug and new slug are the same", 400);

    await upsertSlugRedirect(db, { oldSlug, newSlug }, existing?.id);

    // THE MIDDLEWARE MEMO IS NOT THE ONLY CACHE. This used to read "no
    // cache to invalidate: middleware/slugRedirect.ts reads this table
    // directly, memoised 5 minutes per isolate, so a save is live within
    // that window on its own" -- true of the memo, and wrong about the
    // edge. `north-enfield` -> `enfield` was added on 2026-09-11 and
    // /needs/at/north-enfield/ still served its own 200 page afterwards:
    // that URL was already in the Cloudflare cache under
    // `s-maxage=86400`, and as index.ts:131 says, "because wrangler.jsonc
    // enables the Workers Cache a HIT never executes the Worker" -- so
    // slugRedirect never ran. The redirect was correct all along and
    // invisible for up to 24 hours.
    //
    // The old slug's pages are what must go: middleware/cacheTag.ts tags
    // everything under /needs/at/<slug>/ with fb-<slug>, so one tag
    // covers the page, locations, donation points, charity, news, RSS and
    // GeoJSON. AGGREGATE_TAG is deliberately NOT purged -- a redirect
    // changes no list, map or API collection, and purging the aggregates
    // for it would evict the whole site's hot set to fix one URL.
    //
    // On an EDIT, the row's previous old_slug also needs purging: it is
    // no longer redirected, and its 301 may itself be cached. `existing`
    // is the pre-update row, so it still holds that value.
    //
    // waitUntil, not awaited, matching foodbank.ts:163 -- the admin gets
    // its redirect immediately, and a failed enqueue must not turn a
    // save that already committed into an error page.
    const purgeTags = [foodbankTag(oldSlug)];
    if (existing && existing.old_slug !== oldSlug) purgeTags.push(foodbankTag(existing.old_slug));
    c.executionCtx.waitUntil(
      c.env.PURGE_Q.send({ tags: purgeTags }).catch((err) =>
        console.error("slug redirect save: purge enqueue failed", err),
      ),
    );

    return c.redirect("/admin/slug-redirects/", 302); // views.py:2300
  }

  const html = await render("admin/generic_form.njk", {
    ...(await adminPageContext(c, "settings")),
    title: existing ? "Edit Slug Redirect" : "New Slug Redirect", // views.py:2291/2294 verbatim
    fields: SLUG_REDIRECT_FIELDS,
    data: existing ?? {},
    // Django has NO delete for SlugRedirect -- only the list and this
    // form exist (verified: `grep -rn SlugRedirect --include="*.py"` hits
    // nothing but these two views, the imports and the tests). None is
    // ported.
    delete_url: null,
  });
  return c.html(html);
}

