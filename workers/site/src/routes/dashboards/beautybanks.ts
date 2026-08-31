import type { Context } from "hono";
import { BEAUTYBANKS_PRODUCTS, getBeautyBankProductNeeds, type BeautyBankNeedRow } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { parseD1Timestamp } from "../../lib/isoWeek";
import { timesince } from "../../lib/timesince";
import LONDON_POSTCODES from "../../data/london-postcodes.json";

const ALL_NEEDS_LIMIT = 50;
const LONDON_NEEDS_LIMIT = 50;
const TIME_SINCE_DAYS = 28;
const MS_PER_DAY = 86_400_000;

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path, appName: "gfdash" }), render_time_ms: elapsedMs(c) };
}

// filter_change_text() (givefood/utils/text.py:138-148) -- lines of
// change_text that mention any product keyword, deduped. Django dedupes
// via a plain `set()` (arbitrary hash iteration order); this uses a JS Set
// instead (insertion order) -- an internal dashboard highlight, not a
// byte-exact contract worth chasing Python's set ordering for. Returned as
// an array (not Django's rejoined string) so the template can loop lines
// directly without an in-template split() call; callers that need the
// joined string (the map's JSON payload) join it themselves.
function filteredChangeLines(changeText: string): string[] {
  const kept = new Set<string>();
  for (const line of changeText.split("\n")) {
    if (BEAUTYBANKS_PRODUCTS.some((product) => line.includes(product))) kept.add(line);
  }
  return Array.from(kept);
}

function isLondonPostcode(postcode: string): boolean {
  return (LONDON_POSTCODES as readonly string[]).some((prefix) => postcode.startsWith(prefix));
}

interface BeautyBankNeedTemplateRow {
  foodbank_name: string | null;
  foodbank_slug: string;
  foodbank_postcode: string;
  filtered_change_lines: string[];
  created_timesince: string;
}

// Links to the REAL joined foodbank.slug (getBeautyBankProductNeeds already
// carries it) rather than Django's own `need.foodbank_name_slug` guess --
// same "use the real slug, not a slugify() of the denormalised name"
// upgrade already made for the RSS feed and the articles dashboard, and
// for the same reason: a guessed slug can 404.
function mapNeedRow(n: BeautyBankNeedRow, now: Date): BeautyBankNeedTemplateRow {
  return {
    foodbank_name: n.foodbank_name,
    foodbank_slug: n.foodbank_slug,
    foodbank_postcode: n.postcode,
    filtered_change_lines: filteredChangeLines(n.change_text),
    created_timesince: timesince(parseD1Timestamp(n.created), now),
  };
}

// gfdash `beautybanks` (views.py:245-335). The three OR-chains Django
// builds in SQL (254 London postcode prefixes, 39 product keywords, and a
// dynamic per-need foodbank-id chain) are reduced to ONE D1 query carrying
// only the safely-small 39-term product chain
// (getBeautyBankProductNeeds) -- see packages/db/src/dashboards.ts's
// header comment for the full reasoning. The London postcode-prefix match
// and the three needs slices (all/London/recent-28-days) below are all
// plain JS over that one already-fetched, already-published-only,
// already-created-DESC-ordered result set.
export async function gfdashBeautybanks(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const needs = await getBeautyBankProductNeeds(session);
  const now = new Date();
  const timeSinceThreshold = new Date(now.getTime() - TIME_SINCE_DAYS * MS_PER_DAY);

  const londonRows = needs.filter((n) => isLondonPostcode(n.postcode));
  const timeSinceRows = needs.filter((n) => parseD1Timestamp(n.created) > timeSinceThreshold);

  const timeSinceJson = JSON.stringify(
    timeSinceRows.map((n) => {
      const [lat, lng] = n.lat_lng.split(",").map(Number);
      return { foodbank: n.foodbank_name, slug: n.foodbank_slug, lat, lng, change_text: filteredChangeLines(n.change_text).join("\n") };
    }),
  );

  return c.html(
    await render("dash/beautybanks.njk", {
      ...pageContext(c),
      all_needs: needs.slice(0, ALL_NEEDS_LIMIT).map((n) => mapNeedRow(n, now)),
      london_needs: londonRows.slice(0, LONDON_NEEDS_LIMIT).map((n) => mapNeedRow(n, now)),
      products: BEAUTYBANKS_PRODUCTS,
      london_postcodes: LONDON_POSTCODES,
      time_since_json: timeSinceJson,
    }),
  );
}
