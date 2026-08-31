import type { Context } from "hono";
import { getRecentPublishedChanges, type ExcessNeedRow } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { slugify } from "../../lib/fields";
import { timesince } from "../../lib/timesince";

const LIMIT = 200;

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path, appName: "gfdash" }), render_time_ms: elapsedMs(c) };
}

interface ExcessTemplateRow {
  foodbank_name: string | null;
  foodbank_slug: string;
  excess_change_text: string | null;
  created_timesince: string;
}

// FoodbankChange.foodbank_name_slug() -- slugify(), not a join to the real
// foodbank.slug (getRecentPublishedChanges only reads foodbank_name, same
// as the homepage's recentlyUpdated mapping in routes/public.ts).
function toTemplateRow(row: ExcessNeedRow, now: Date): ExcessTemplateRow {
  return {
    foodbank_name: row.foodbank_name,
    foodbank_slug: slugify(row.foodbank_name ?? ""),
    excess_change_text: row.excess_change_text,
    created_timesince: timesince(row.created, now),
  };
}

// gfdash `excess` (views.py:338-344) -- the 200 most recently created
// published FoodbankChange rows, newest first.
export async function gfdashExcess(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const now = new Date();
  const rows = await getRecentPublishedChanges(session, LIMIT);

  const excesses = rows.map((row) => toTemplateRow(row, now));

  return c.html(await render("dash/excess.njk", { ...pageContext(c), excesses }));
}
