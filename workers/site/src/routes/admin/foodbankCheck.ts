import type { Context } from "hono";
import { getFoodbankBySlug, getAdminJob } from "@givefood/db";
import { runFoodbankCheck, type FoodbankCheckResult } from "@givefood/ai";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { timesince } from "../../lib/timesince";
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

// gfadmin/templates/admin/check.html:48-67 -- Django hardcodes a human
// label per <dt>. Kept as a parallel map so the field names above stay
// byte-identical to workers/jobs' CHECK_USE_AI_FIELDS, which are also the
// detailChanges keys and the /use-ai/<field>/ URL segment.
const CHECK_USE_AI_LABELS: Record<(typeof CHECK_USE_AI_FIELDS)[number], string> = {
  phone_number: "Phone",
  contact_email: "Email",
  charity_number: "Charity",
  facebook_page: "Facebook",
  bankuet_slug: "Bankuet",
  rss_url: "RSS URL",
  news_url: "News URL",
  donation_points_url: "Donation Points URL",
  locations_url: "Locations URL",
  contacts_url: "Contacts URL",
};

// check.html:59-67 (Ours) and :144-196 (Found) give every URL field a
// new-window icon link on both sides, so a reviewer can open a candidate
// URL before pressing Use. Same set as useAi.ts:16's URL_FIELDS, an array
// rather than a Set because nunjucks' `in` operator falls back to JS
// `key in obj` for anything that isn't an array or string.
const CHECK_URL_FIELDS: string[] = ["rss_url", "news_url", "donation_points_url", "locations_url", "contacts_url"];

// check.html:296-299 labels each preview tab with the foodbank_urls key
// ("Home", "Shopping List", ...) set in gfadmin/views.py:935-993, while
// the data-tab attribute keeps the slug. The port's page.name is the
// internal key from workers/jobs/src/adminJobs/foodbankCheck.ts:81-91, so
// map to the display name at render time -- renaming it job-side would
// orphan every already-stored admin_job result.
const CHECK_PAGE_LABELS: Record<string, string> = {
  homepage: "Home",
  shopping_list: "Shopping List",
  locations: "Locations",
  contacts: "Contacts",
  donation_points: "Donation Points",
};

// gfadmin/views.py:1138-1215 foodbank_check. INLINE AGAIN, github #38.
//
// WP 6.8 built this as "enqueue and poll": the POST inserted an admin_job
// row, sent a "foodbank-check" queue message, and the page polled every two
// seconds until the workers/jobs consumer finished. The reasoning was sound
// -- Django hangs the reviewer's tab for however long 5 fetches and a Gemini
// call take -- but the measurement was never taken, and when it was, the
// architecture was costing more than the thing it avoided. All six completed
// checks on production ran 37-40 s wall clock; the `jobs` queue is configured
// `max_batch_size: 10, max_batch_timeout: 30`, an admin presses Check once so
// the batch never fills, and the message waits out the full 30 s before the
// consumer is even invoked. The work is ~7-10 s. Four fifths of the wait was
// the machinery for not waiting.
//
// So this is Django's shape again, deliberately (maintainer's call, #38): the
// GET does the work and renders the answer. No admin_job row, no queue
// message, no polling fragment, and no stale previous result sitting on the
// page pretending to be current.
//
// AND IT RUNS ON NAVIGATION, not on a button press -- also #38, also Django's
// behaviour. "This allowed the user to quickly check the food bank
// information then move on to the next one" is the ticket's own description
// of the loop, and a button between the reviewer and the answer is the part
// that broke it. The cost is real and was accepted explicitly: every load,
// refresh and back-button is a paid Gemini call. Pressing Use or Delete is
// NOT -- those are hx-post and answer with a fragment (useAi.ts's
// `HX-Request` branch), so the common review loop still pays for exactly one
// check per food bank.
//
// A FAILED CHECK IS A NOTIFICATION, NOT A 500. Inline work means an
// exception reaches the response, and a food bank whose site is down would
// otherwise take the whole admin page with it -- including the Touch button
// and the "Last edit" line, which are the parts a reviewer can still act on.
// The error is caught and handed to the template exactly where the failed
// job's `job.error` used to render.
//
// `foodbank_check_prompt` / `foodbank_check_result` (Django's two debug-only
// views, unlinked from any template, each re-running the entire scrape from
// scratch just to dump the prompt or raw JSON) stay folded into
// `?debug=prompt` / `?debug=json` on this page -- PLAN.md's own S9
// recommendation. They now read the result this request just computed rather
// than a stored job's, which is what Django's did.
export async function adminFoodbankCheck(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const slug = c.req.param("slug")!;
  const foodbank = await getFoodbankBySlug(db, slug);
  if (!foodbank) return c.notFound();

  let result: FoodbankCheckResult | null = null;
  let error: string | null = null;
  try {
    result = await runFoodbankCheck(db, slug, c.env.GEMINI_API_KEY);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const debug = c.req.query("debug");
  if (result && debug === "prompt") return c.text(result.prompt);
  if (result && debug === "json") return c.json(result.aiResponse);

  const html = await render("admin/foodbank_check.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    foodbank,
    result,
    check_error: error,
    use_ai_fields: CHECK_USE_AI_FIELDS,
    use_ai_labels: CHECK_USE_AI_LABELS,
    url_fields: CHECK_URL_FIELDS,
    page_labels: CHECK_PAGE_LABELS,
    // check.html:19 `Last edit: {{ foodbank.edited|timesince }} ago`. There
    // is no nunjucks `timesince` filter (packages/templates/src/env.ts), so
    // it is computed here, as admin/index.ts:325-336 already does.
    foodbank_edited_timesince: foodbank.edited ? timesince(foodbank.edited, new Date()) : null,
  });
  return c.html(html);
}

// The htmx `hx-trigger="every 2s"` polling target for admin_job rows.
//
// ONE CALLER LEFT: order-lines. github #38 took the food bank check off the
// queue, so `kind === "check"` can no longer occur -- but the redirect below
// still names it, because an admin_job row of that kind can still EXIST: any
// check queued before that deploy is still in the table, and a reviewer with
// an open tab is still polling for it. Dropping the branch would send those
// to /admin/ instead of to the page they were watching. It costs one
// comparison and it stops being reachable on its own once those rows age
// out.
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
