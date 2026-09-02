import type { Context } from "hono";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:2747-2764 settings() -- a link hub, plus one piece of real
// logic: the "Dated Stats" form is pre-filled with the CURRENT calendar
// quarter's start and end dates, so the common case (this quarter's numbers)
// is one click. Ported exactly, including Q4's December-31 special case.
function currentQuarterRange(today: Date): { start: string; end: string } {
  const year = today.getUTCFullYear();
  const quarter = Math.floor(today.getUTCMonth() / 3) + 1; // Django: (month - 1) // 3 + 1, on 1-indexed months
  const startMonth = (quarter - 1) * 3; // 0-indexed for Date.UTC
  const start = new Date(Date.UTC(year, startMonth, 1));
  // Django: date(year, quarter * 3 + 1, 1) - 1 day, except Q4 which is
  // hardcoded to Dec 31 because month 13 does not exist. Day 0 of the next
  // quarter's first month is the same value without the special case, but the
  // special case is kept explicit so this reads against the original.
  const end = quarter === 4 ? new Date(Date.UTC(year, 11, 31)) : new Date(Date.UTC(year, startMonth + 3, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// routes/admin/clearCache.ts redirects back here with ?cache=<outcome> so the
// result banner lands where the button is. Narrowed against the enum rather
// than passed through raw -- the querystring is attacker-controllable, and
// nothing arbitrary should reach the template context.
const CACHE_OUTCOMES = ["purged", "purged-kv-only", "cooldown", "failed"] as const;

export async function adminSettings(c: Context<AppEnv>): Promise<Response> {
  const { start, end } = currentQuarterRange(new Date());
  const rawCache = c.req.query("cache");
  const html = await render("admin/settings.njk", {
    ...(await adminPageContext(c, "settings")),
    quarter_start: start,
    quarter_end: end,
    cache_result: (CACHE_OUTCOMES as readonly string[]).includes(rawCache ?? "") ? rawCache : null,
  });
  return c.html(html);
}
