import type { Context } from "hono";
import { getBeanPastaMonthCounts } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

// gfdash entirely outside i18n_patterns (givefood/urls.py's "Untranslated
// apps" block) -- one URL, no locale prefix, no {% trans %} in any dash/*
// template. Same pageContext shape as apiDocs.ts, hardcoded to "gfdash"
// since every dash page uses the one app name.
function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path }), render_time_ms: elapsedMs(c) };
}

// gfdash `bean_pasta_index` (views.py:382-391) -- Django's raw-SQL query is
// already fully ported into getBeanPastaMonthCounts (grouped/sorted by
// month); this handler just calls it and hands the rows to the template.
export async function gfdashBeanPastaIndex(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const months = await getBeanPastaMonthCounts(session);
  return c.html(await render("dash/bean_pasta_index.njk", { ...pageContext(c), months }));
}
