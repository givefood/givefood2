import type { Context } from "hono";
import { getFeaturedArticles, getMostViewed, getRecentlyUpdated, getSiteStats } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../types";
import { dbSession } from "../lib/session";
import { elapsedMs } from "../middleware/serverTiming";
import { slugify, titleCapitalised, urlWithRefFoodbank } from "../lib/fields";

// givefood/views.py:77-209 index() -- verbatim, not from any wfbn app
// (see PLAN.md §10.2.2's app boundary note: "givefood" itself, ported for
// the first time by this handler).
const LOGOS = [
  { name: "NHS", slug: "nhs", url: "https://www.nhs.uk", format: "svg" },
  { name: "BBC", slug: "bbc", url: "https://www.bbc.co.uk", format: "svg" },
  { name: "Scottish Government Riaghaltas na h-Alba", slug: "scottishgov", url: "https://www.gov.scot", format: "svg" },
  { name: "Consumer Data Research Centre", slug: "cdrc", url: "https://www.cdrc.ac.uk", format: "png" },
  { name: "Reach plc", slug: "reach", url: "https://www.reachplc.com", format: "svg" },
  { name: "Age UK", slug: "ageuk", url: "https://www.ageuk.org.uk", format: "svg" },
  { name: "Channel 4", slug: "channel4", url: "https://www.channel4.com", format: "svg" },
  { name: "Welsh Government", slug: "welshgov", url: "https://www.gov.wales", format: "svg" },
  {
    name: "Foreign, Commonwealth & Development Office",
    slug: "fcdo",
    url: "https://www.gov.uk/government/organisations/foreign-commonwealth-development-office",
    format: "svg",
  },
  { name: "Mars", slug: "mars", url: "https://www.mars.com/en-gb", format: "svg" },
  { name: "Citizens Advice", slug: "ca", url: "https://www.citizensadvice.org.uk/", format: "svg" },
  { name: "National Council for the Training of Journalists", slug: "nctj", url: "https://www.nctj.com/", format: "png" },
];

const RECENTLY_UPDATED_LIMIT = 8;
const MOST_VIEWED_LIMIT = 8;
const MOST_VIEWED_DAYS = 7;
const ARTICLES_LIMIT = 5;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// givefood/const/general.py's ENABLE_WRITE -- a hardcoded constant, not an
// env flag (grep confirms no other value is ever assigned to it), so
// there's nothing to read at request time.
const ENABLE_WRITE = true;

export async function publicIndex(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const today = new Date();
  const sinceDay = new Date(today);
  sinceDay.setUTCDate(sinceDay.getUTCDate() - MOST_VIEWED_DAYS);

  const [recentlyUpdatedRows, mostViewed, articleRows, stats] = await Promise.all([
    getRecentlyUpdated(session, RECENTLY_UPDATED_LIMIT),
    getMostViewed(session, isoDate(sinceDay), isoDate(today), MOST_VIEWED_LIMIT),
    getFeaturedArticles(session, ARTICLES_LIMIT),
    getSiteStats(session),
  ]);

  // FoodbankChange.foodbank_name_slug() -- slugify(), not a join to the
  // real foodbank.slug (see needs.py; the homepage query mirrors it
  // exactly, .only('foodbank_name')).
  const recentlyUpdated = recentlyUpdatedRows.map((r) => ({ name: r.foodbank_name, slug: slugify(r.foodbank_name) }));

  const articles = articleRows.map((a) => ({
    foodbank: { slug: a.foodbank_slug, name: a.foodbank_name },
    url_with_ref: urlWithRefFoodbank(a.url),
    title_captialised: titleCapitalised(a.title),
    published_date: a.published_date,
  }));

  const geojsonPath = "/needs/geo.json"; // wfbn:geojson, WP 3.6 not built yet
  const mapConfig = JSON.stringify({
    geojson: locale === "en" ? geojsonPath : `/${locale}${geojsonPath}`,
    lat: 55.4,
    lng: -4,
    zoom: 5,
    location_marker: false,
  });

  const context = buildPageContext({
    path: c.req.path,
    appName: "givefood",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "public/index.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      logos: LOGOS,
      stats,
      recently_updated: recentlyUpdated,
      most_viewed: mostViewed,
      articles,
      enable_write: ENABLE_WRITE,
      address: "",
      map_config: mapConfig,
    },
    locale,
  );
  return c.html(html);
}
