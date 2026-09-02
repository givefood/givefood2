import type { Context } from "hono";
import { toggleArticleFeatured } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";

// gfadmin/views.py:3399-3417 article_toggle_featured, @require_POST.
// Lives on the admin dashboard (admin/index.njk), not the foodbank
// detail page (WP 6.7 research corrected this from the WP's own
// grouping). The response fragment's button hardcodes its own hx-post
// path the same way Django's does, rather than reversing a route name.
export async function adminArticleToggleFeatured(c: Context<AppEnv>): Promise<Response> {
  const articleId = Number(c.req.param("id"));
  if (!Number.isInteger(articleId)) return c.notFound();

  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  const featured = await toggleArticleFeatured(dbSession(c), articleId);
  if (featured === null) return c.notFound();

  if (c.req.header("HX-Request")) {
    const buttonClass = featured ? "is-warning is-light" : "is-light";
    const buttonText = featured ? "★" : "☆";
    return c.html(
      `<button type="submit" class="button is-small ${buttonClass}" hx-post="/admin/article/${articleId}/toggle-featured/" hx-vals='{"csrf_token": "${csrfToken}"}' hx-swap="outerHTML">${buttonText}</button>`,
    );
  }
  return c.redirect("/admin/", 302);
}
