import type { Context } from "hono";
import { getFoodbankBySlug, insertAdminJob, getAdminJob, getLatestAdminJob } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:1321-1326 foodbank_use_ai_detail's ALLOWED_FIELDS, same
// list as workers/jobs' checkPrompt.ts's CHECK_USE_AI_FIELDS -- duplicated
// rather than cross-imported, since workers/site and workers/jobs are
// separate deployed Workers and shouldn't reach into each other's src/
// (matching this codebase's established small-constant-duplication
// pattern, e.g. BOT_USER_AGENT, rather than a new shared package for one
// 10-item array).
const CHECK_USE_AI_FIELDS = [
  "phone_number",
  "contact_email",
  "charity_number",
  "facebook_page",
  "bankuet_slug",
  "rss_url",
  "news_url",
  "donation_points_url",
  "locations_url",
  "contacts_url",
] as const;

// gfadmin/views.py:1138-1215 foodbank_check, redesigned per PLAN.md
// §9.4.4's "enqueue and poll, no Workflows" architecture (WP 6.8):
// Django does 5-6 fetches plus a Gemini call synchronously in the GET
// handler -- the reviewer's tab hangs for however long that takes, with
// no timeout handling if a fetch stalls. Here, GET only ever reads
// admin_job state; the actual scrape+AI work runs in workers/jobs'
// "foodbank-check" queue consumer. `foodbank_check_prompt`/
// `foodbank_check_result` (Django's two debug-only views, unlinked from
// any template, each re-running the entire scrape from scratch just to
// dump the prompt or raw JSON) are folded into `?debug=prompt`/
// `?debug=json` on this same page instead, reading the already-completed
// job's stored result -- PLAN.md's own S9 recommendation, taken here
// rather than porting three separate re-scraping views.
export async function adminFoodbankCheck(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const slug = c.req.param("slug")!;
  const foodbank = await getFoodbankBySlug(db, slug);
  if (!foodbank) return c.notFound();

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const jobId = crypto.randomUUID();
    await insertAdminJob(db, { id: jobId, kind: "check", target: slug });
    await c.env.JOBS_Q.send({ type: "foodbank-check", jobId, foodbankSlug: slug });
    return c.redirect(`/admin/foodbank/${slug}/check/?job=${jobId}`, 302);
  }

  const jobId = c.req.query("job");
  const job = jobId ? await getAdminJob(db, jobId) : await getLatestAdminJob(db, "check", slug);

  const debug = c.req.query("debug");
  if (job && job.status === "done" && debug) {
    const result = JSON.parse(job.result!) as { prompt: string; aiResponse: unknown };
    if (debug === "prompt") return c.text(result.prompt);
    if (debug === "json") return c.json(result.aiResponse);
  }

  const html = await render("admin/foodbank_check.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    foodbank,
    job,
    result: job && job.status === "done" ? JSON.parse(job.result!) : null,
    use_ai_fields: CHECK_USE_AI_FIELDS,
  });
  return c.html(html);
}

// gfadmin/views.py:3283's csi.js-style polling target, here an htmx
// `hx-trigger="every 2s"` fragment instead (PLAN.md's own citation for
// "the pattern already in the codebase" pointed at csi.js's hand-rolled
// fetch+setInterval, not htmx -- this page has no existing browser
// contract to preserve, unlike WP 6.4/6.7's tab mechanisms, so htmx's
// built-in polling is used directly rather than porting csi.js for one
// new page). Still queued/running: same fragment, poll continues. Done
// or failed: HX-Redirect back to the check page (no `?debug=`), which
// then renders the full result from admin_job in one place rather than
// duplicating that rendering here.
export async function adminJobStatus(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const job = await getAdminJob(db, c.req.param("id")!);
  if (!job) return c.notFound();

  if (job.status === "queued" || job.status === "running") {
    const html = await render("admin/includes/job_status.njk", { job });
    return c.html(html);
  }

  const redirectTo = job.kind === "check" ? `/admin/foodbank/${job.target}/check/?job=${job.id}` : "/admin/";
  c.header("HX-Redirect", redirectTo);
  return c.body(null);
}
