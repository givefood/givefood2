import type { Context } from "hono";
import { getDuplicatePostcodes } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:340-358 foodbanks_dupe_postcodes, registered
// gfadmin/urls/foodbanks.py:8. GET only -- the Django view has no POST
// branch and mutates nothing.
//
// section = "settings": Django's own view passes no section at all
// (template_vars is just {"dupes": ...} at views.py:355-357), but its
// closest sibling foodbanks_without_need sets "settings" (views.py:3110),
// and settings.njk's "Geo" block holds this page's only inbound link.
//
// This route is what makes an already-shipped link work:
// packages/templates/templates/admin/settings.njk:44 already points at
// /admin/foodbanks/dupe_postcodes/ and 404s today, because no route was
// registered for it.
export async function adminFoodbanksDupePostcodes(c: Context<AppEnv>): Promise<Response> {
  const result = await getDuplicatePostcodes(dbSession(c));
  const html = await render("admin/foodbanks_dupe_postcodes.njk", {
    ...(await adminPageContext(c, "settings")),
    groups: result.groups,
    truncated: result.truncated,
    limit: result.limit,
  });
  return c.html(html);
}
