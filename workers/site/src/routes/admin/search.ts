import type { Context } from "hono";
import { searchAdmin, ADMIN_SEARCH_MIN_QUERY_LENGTH } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:111-231 search_results(), gfadmin/urls/core.py:15 -- the
// navbar search box that appears on every admin page (admin/page.njk:54-56).
// GET only: no mutation, so no POST branch and no CSRF check. Auth is
// inherited from adminApp's requireAdminAuth middleware, exactly as Django
// inherits it from givefood.middleware.LoginRequiredAccess rather than a
// per-view decorator, so there is no inline session check here.
//
// `section: "search"` matches no navbar item, so nothing highlights -- same
// as Django, whose page.html has no search nav item either.
export async function adminSearch(c: Context<AppEnv>): Promise<Response> {
  const query = (c.req.query("q") ?? "").trim();

  // F1/F2, two defects fixed rather than ported. Django 500s when `q` is
  // absent entirely: `query` is None and .filter(slug__icontains=None) at
  // views.py:117 raises ValueError("Cannot use None as a query value")
  // before anything renders -- and the navbar makes reaching /admin/search/
  // with no query a one-click path. An empty `?q=` is worse rather than
  // better: `icontains=""` compiles to LIKE '%%', which matches every
  // non-NULL value, so the page returns 100 arbitrary rows from each of the
  // six groups plus up to 300 subscriptions. The navbar input has no
  // `required` attribute, so a bare Enter is all it takes. Both become the
  // same quiet prompt state here, with zero D1 queries.
  const results = query.length > 0 ? await searchAdmin(dbSession(c), query) : null;

  const html = await render("admin/search.njk", {
    ...(await adminPageContext(c, "search")),
    // `q` also feeds page.njk:55's navbar echo, which every other admin page
    // leaves undefined so the box renders empty.
    q: query,
    searched: query.length > 0,
    // searchAdmin() returns null for either query it declines to run --
    // under two characters, or longer than adminSearch.ts's 500-character
    // sanity cap. An over-50-byte LIKE pattern is NOT refused any more -- it
    // runs in instr() mode, so URL and push-endpoint searches work here too.
    // The two get different messages, so the short case is recognised here
    // and anything else null must be the over-length one; the byte
    // measurement itself stays in packages/db next to the patterns it
    // measures.
    too_short: query.length > 0 && query.length < ADMIN_SEARCH_MIN_QUERY_LENGTH,
    too_long: query.length >= ADMIN_SEARCH_MIN_QUERY_LENGTH && results === null,
    min_query_length: ADMIN_SEARCH_MIN_QUERY_LENGTH,
    results,
  });
  return c.html(html);
}
