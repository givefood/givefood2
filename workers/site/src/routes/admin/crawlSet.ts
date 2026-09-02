import type { Context } from "hono";
import { getCrawlSetJson } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";

// gfadmin/views.py:3283-3323 crawl_set_json -- exact shape test-pinned
// (WP 6.7 research quoted gfadmin/tests/test_crawl_set_json.py). Built
// standalone: its own consumer page (crawl_set.html's setInterval poll
// loop) is bundled with WP 6.6's crawl-sets-list deferral, but PLAN.md
// names this JSON endpoint as its own WP 6.7 deliverable regardless.
export async function adminCrawlSetJson(c: Context<AppEnv>): Promise<Response> {
  const idJson = c.req.param("idJson")!; // "<id>.json" -- see index.ts's route registration comment
  const id = Number(idJson.slice(0, -".json".length));
  if (!Number.isInteger(id)) return c.notFound();

  const data = await getCrawlSetJson(dbSession(c), id);
  // Not c.notFound() -- that triggers index.ts's global APPEND_SLASH
  // probe (a not-found response re-dispatched with a trailing slash to
  // see if THAT resolves), which is wrong for this one URL: Django's own
  // `crawl-set/<id>.json` pattern deliberately has no trailing slash
  // (it's a file-suffixed resource, not a directory-style page like
  // every other admin URL), so a slashed retry should never be tried.
  if (!data) return c.text("Not Found", 404);
  return c.json(data);
}
