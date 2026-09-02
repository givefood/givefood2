import type { Context } from "hono";
import { getDiscrepancyById, setDiscrepancyStatus, getFoodbankSlugAndUrlById, getFoodbankBySlug } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { FOODBANK_FIELDS } from "../../lib/adminFormFields";
import { adminPageContext } from "./pageContext";

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// gfadmin/views.py:2194-2203 discrepancy() -- the reference view's real
// "fix it" loop: an embedded, editable FoodbankForm (all 30 fields,
// reusing foodbank_form.njk's own fieldset macro) posts back to
// foodbank_edit with ?discrepancy=<id> attached, which both saves the
// foodbank and marks this discrepancy Done (renderFoodbankForm's own
// comment). The stale "food bank edit forms don't exist yet (WP 6.5)"
// deferral this used to carry no longer applies -- that form shipped.
export async function adminDiscrepancyDetail(c: Context<AppEnv>): Promise<Response> {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.notFound();

  const db = dbSession(c);
  const discrepancy = await getDiscrepancyById(db, id);
  if (!discrepancy) return c.notFound();

  // WP 6.3's proxy only ever proxies one of a food bank's 5 known URL
  // fields, resolved fresh from D1 -- never an arbitrary stored URL. A
  // discrepancy's `url` is safe to preview through it only when it's
  // actually that food bank's current `url` field (the one WP 6.4's
  // research confirmed discrepancies are ever raised about); anything
  // else (a stale/changed URL) just doesn't get a preview rather than
  // failing loudly inside an iframe. Independent of whether the edit form
  // below is shown -- that only needs the foodbank to exist, not the URL
  // to match.
  let foodbank = null;
  let proxySrc: string | null = null;
  if (discrepancy.foodbank_id !== null) {
    const slugAndUrl = await getFoodbankSlugAndUrlById(db, discrepancy.foodbank_id);
    if (slugAndUrl) {
      foodbank = await getFoodbankBySlug(db, slugAndUrl.slug);
      if (discrepancy.url && sameOrigin(slugAndUrl.url, discrepancy.url)) {
        proxySrc = `/admin/proxy/?foodbank=${encodeURIComponent(slugAndUrl.slug)}&field=url&target=${encodeURIComponent(discrepancy.url)}`;
      }
    }
  }

  const html = await render("admin/discrepancy.njk", {
    ...(await adminPageContext(c, "needs")),
    discrepancy,
    foodbank,
    foodbank_fields: FOODBANK_FIELDS,
    show_proxy: !!proxySrc,
    proxy_src: proxySrc,
  });
  return c.html(html);
}

// gfadmin/views.py:2206-2217 discrepancy_action -- "invalid" (dismiss) or
// "done" (resolve). POST-only here (WP 6.3's carried-forward requirement
// -- Django's version has no @require_POST at all, confirmed in WP 6.3's
// research).
export async function adminDiscrepancyAction(c: Context<AppEnv>): Promise<Response> {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.notFound();

  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  const action = body.action;
  if (action !== "done" && action !== "invalid") return c.text("Bad request", 400);

  await setDiscrepancyStatus(dbSession(c), id, action === "done" ? "Done" : "Invalid");
  return c.redirect("/admin/", 302);
}
