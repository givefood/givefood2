import type { Context } from "hono";
import { getDiscrepancyById, setDiscrepancyStatus, getFoodbankSlugAndUrlById } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// gfadmin/views.py:2194-2203 discrepancy() -- the reference view also
// builds a `FoodbankForm(instance=discrepancy.foodbank)` so the reviewer
// can edit the food bank directly from this page, with a successful save
// implicitly resolving the discrepancy (?discrepancy=<id> query string,
// views.py:831-836). Food bank edit forms don't exist yet (WP 6.5) --
// resolution here is explicit only (the Done/Invalid buttons below),
// matching discrepancy_action's own two real actions.
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
  // failing loudly inside an iframe.
  let foodbankSlug: string | null = null;
  let proxySrc: string | null = null;
  if (discrepancy.foodbank_id !== null && discrepancy.url) {
    const foodbank = await getFoodbankSlugAndUrlById(db, discrepancy.foodbank_id);
    if (foodbank && sameOrigin(foodbank.url, discrepancy.url)) {
      foodbankSlug = foodbank.slug;
      proxySrc = `/admin/proxy/?foodbank=${encodeURIComponent(foodbank.slug)}&field=url&target=${encodeURIComponent(discrepancy.url)}`;
    }
  }

  const html = await render("admin/discrepancy.njk", {
    ...(await adminPageContext(c, "needs")),
    discrepancy,
    foodbank_slug: foodbankSlug,
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
