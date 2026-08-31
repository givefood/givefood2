import type { Context } from "hono";
import { getTrussellFoodbanksByLastNeed, type TrussellFoodbankRow } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { timesince } from "../../lib/timesince";

const LIMIT = 100;

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path, appName: "gfdash" }), render_time_ms: elapsedMs(c) };
}

interface TrussellFoodbankTemplateRow {
  name: string;
  url: string;
  last_need_timesince: string;
}

// Django's `{{ foodbank.last_need|timesince }} ago` with a None last_need
// prints "" for the filter (Django's timesince template filter returns ''
// on a falsy value) then " ago" -- reproduced here the same way rather
// than adding a null-guard the original template doesn't have.
function toTemplateRow(row: TrussellFoodbankRow, now: Date): TrussellFoodbankTemplateRow {
  return {
    name: row.name,
    url: row.url,
    last_need_timesince: row.last_need ? timesince(row.last_need, now) : "",
  };
}

// gfdash `tt_old_data` (views.py:220-230) -- two opposite-ordered 100-row
// slices of the same Trussell/open filter: `recent` is last_need DESC,
// `old` is last_need ASC.
export async function gfdashTtOldData(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const now = new Date();

  const [recentRows, oldRows] = await Promise.all([
    getTrussellFoodbanksByLastNeed(session, "DESC", LIMIT),
    getTrussellFoodbanksByLastNeed(session, "ASC", LIMIT),
  ]);

  const recent = recentRows.map((row) => toTemplateRow(row, now));
  const old = oldRows.map((row) => toTemplateRow(row, now));

  return c.html(await render("dash/tt_old_data.njk", { ...pageContext(c), recent, old }));
}
