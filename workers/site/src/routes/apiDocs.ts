import type { Context } from "hono";
import { getPublishedNeeds, toDashedUuid } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../types";
import { dbSession } from "../lib/session";
import { elapsedMs } from "../middleware/serverTiming";

// The three HTML doc pages PLAN.md calls out as WP 2.7 (see index.ts's old
// notPortedYet mount for this group): gfapi1's deprecated-API page, and
// gfapi2's index + docs pages. Each is a straight `render()` through the
// same page.njk every other page extends -- see packages/templates.

function pageContext(c: Context<AppEnv>, appName: string) {
  const context = buildPageContext({ path: c.req.path, appName });
  return { ...context, render_time_ms: elapsedMs(c) };
}

// gfapi1 `api` (GET /api/1/) -- static doc page, no DB reads.
export async function api1Index(c: Context<AppEnv>): Promise<Response> {
  return c.html(await render("api1.njk", pageContext(c, "gfapi1")));
}

// gfapi2 `index` (GET /api/2/). The real page's "Dumps" table (dumps were
// gfdumps' own daily CSV/JSON/XML exports) is gone -- WP 5.6, maintainer
// decision 2026-09-02: dropped entirely rather than built. See index.njk's
// own comment and PLAN.md §8.8.
export async function api2Index(c: Context<AppEnv>): Promise<Response> {
  return c.html(await render("api2/index.njk", pageContext(c, "gfapi2")));
}

// gfapi2/views.py:33-40 -- static, verbatim from the Python source.
const API_FORMATS = ["JSON", "XML", "YAML"];
const EG_FOODBANKS = ["Sid Valley", "Kingsbridge", "Meon Valley", "Black Country"];
const EG_SEARCHES = [
  { type: "address", query: "12 Millbank, Westminster, London SW1P 4QE" },
  { type: "address", query: "Mount Pleasant Rd, Porthleven, Helston TR13 9JSE" },
  { type: "address", query: "Gartocharn, Scotland" },
  { type: "address", query: "Bexhill-on-Sea" },
  { type: "address", query: "ZE2 9AU" },
  { type: "lat_lng", query: "51.178889,-1.826111" },
  { type: "lat_lng", query: "52.090833,0.131944" },
];

// gfapi2/views.py:57 was `ParliamentaryConstituency.objects.all()
// .order_by("?")[:5]` -- a full random-order scan of ~650 rows on every
// cache miss. Replaced with a fixed list of five real constituencies
// (confirmed against production, 2026-08-30) rather than porting the
// random ordering: PLAN.md §7.6 calls this out explicitly as a deliberate,
// non-regressing change ("the output is already non-deterministic... flag
// it to the maintainer rather than doing it silently") -- consider this
// that flag.
const EG_PARL_CONS = ["Broadland and Fakenham", "Great Yarmouth", "North Norfolk", "Mid Norfolk", "South West Norfolk"];

// gfapi2 `docs` (GET /api/2/docs/) -- `eg_needs` stays a live query (PLAN.md
// accepts this page's structural-parity-only status; the 5 most recent
// published needs change several times a day either way).
export async function api2Docs(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const recentNeeds = await getPublishedNeeds(session, 5);

  return c.html(
    await render("api2/docs.njk", {
      ...pageContext(c, "gfapi2"),
      api_formats: API_FORMATS,
      eg_foodbanks: EG_FOODBANKS,
      eg_searches: EG_SEARCHES,
      eg_needs: recentNeeds.map((need) => toDashedUuid(need.need_id)),
      eg_parl_cons: EG_PARL_CONS,
    }),
  );
}
