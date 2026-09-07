import type { Context } from "hono";
import {
  getAllConstituencySlugs,
  getAllConstituencySlugsWithNames,
  getAllOpenDonationPointSlugs,
  getAllOpenDonationPointSlugsWithNames,
  getAllOpenFoodbankSlugs,
  getAllOpenFoodbankSlugsWithNames,
  getAllOpenLocationSlugs,
  getAllOpenLocationSlugsWithNames,
  getMostViewed,
  getRecentlyUpdated,
  getSiteStats,
} from "@givefood/db";
import { render } from "@givefood/templates";
import { url } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { isoDate, slugify } from "@givefood/models";
import { COUNTRY_MAPPING } from "../../lib/countries";

// givefood/views.py md_index()/md_sitemap()/md_sitemap_md() -- givefood/urls.py's
// "Markdown versions" block, outside i18n_patterns (no locale prefixing,
// see PLAN.md's note on this route group), so every render() call here
// omits the locale argument and every url() call uses the plain,
// non-locale-aware global.

const RECENTLY_UPDATED_LIMIT = 10;
const MOST_VIEWED_LIMIT = 10;
const MOST_VIEWED_DAYS = 7;

// md_sitemap()/md_sitemap_md() share this exact list, in this order.
const SITEMAP_URL_NAMES = ["index", "about_us", "donate", "annual_report_index", "privacy"];

export async function mdIndex(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);

  const today = new Date();
  const sinceDay = new Date(today);
  sinceDay.setUTCDate(sinceDay.getUTCDate() - MOST_VIEWED_DAYS);

  const [recentlyUpdatedRows, mostViewed, stats] = await Promise.all([
    getRecentlyUpdated(session, RECENTLY_UPDATED_LIMIT),
    getMostViewed(session, isoDate(sinceDay), isoDate(today), MOST_VIEWED_LIMIT),
    getSiteStats(session),
  ]);

  // FoodbankChange.foodbank_name_slug() -- slugify(), not a join to the
  // real foodbank.slug, same as publicIndex's identical mapping.
  const recentlyUpdated = recentlyUpdatedRows.map((r) => ({ name: r.foodbank_name, slug: slugify(r.foodbank_name) }));

  const html = await render("public/md/index.njk", {
    SITE_DOMAIN: c.env.SITE_DOMAIN,
    recently_updated: recentlyUpdated,
    most_viewed: mostViewed,
    stats,
  });
  return new Response(html, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

// md_sitemap() -- application/xml, hand-built by string concatenation
// (not a .njk template) since it has no filter/i18n needs, matching the
// existing precedent at ../sitemaps.ts's sitemapXml. Note the deliberate
// Content-Type divergence from the main /sitemap.xml (text/xml there):
// preserved verbatim from Django, not unified.
export async function mdSitemapXml(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const domain = c.env.SITE_DOMAIN;

  // Column-projected, like ../sitemaps.ts's sitemapXml and for the same
  // measured reason -- this handler's loops read one string off each food
  // bank and two off each donation point, and used to fetch every column of
  // both to do it (14.2 MB of D1 result payload per render). See
  // getAllOpenFoodbankSlugs / getAllOpenDonationPointSlugs.
  const [foodbankSlugs, locations, donationpoints, constituencySlugs] = await Promise.all([
    getAllOpenFoodbankSlugs(session),
    getAllOpenLocationSlugs(session),
    getAllOpenDonationPointSlugs(session),
    getAllConstituencySlugs(session),
  ]);

  const urls: string[] = [];
  for (const name of SITEMAP_URL_NAMES) urls.push(`  <url><loc>${domain}${url(name)}</loc></url>`);
  for (const countrySlug of Object.keys(COUNTRY_MAPPING)) urls.push(`  <url><loc>${domain}${url("country", countrySlug)}</loc></url>`);
  for (const slug of foodbankSlugs) urls.push(`  <url><loc>${domain}${url("wfbn-md:md_foodbank", slug)}</loc></url>`);
  for (const location of locations) {
    urls.push(`  <url><loc>${domain}${url("wfbn-md:md_foodbank_location", location.foodbank_slug, location.slug)}</loc></url>`);
  }
  for (const donationpoint of donationpoints) {
    urls.push(`  <url><loc>${domain}${url("wfbn-md:md_foodbank_donationpoint", donationpoint.foodbank_slug, donationpoint.slug)}</loc></url>`);
  }
  for (const slug of constituencySlugs) urls.push(`  <url><loc>${domain}${url("wfbn:constituency", slug)}</loc></url>`);

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml" } });
}

// md_sitemap_md() -- same query shape as mdSitemapXml above, fetched
// independently (not shared) matching how ../sitemaps.ts already handles
// the analogous text/xml + text/markdown pairing, plus .name via the
// wider ...WithNames variant of each of the four queries (public/md/
// sitemap.njk renders each entry as a Markdown link, so it needs link text
// where the XML sitemaps only need a <loc>).
export async function mdSitemapMd(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);

  const [foodbanks, locations, donationpoints, constituencies] = await Promise.all([
    getAllOpenFoodbankSlugsWithNames(session),
    getAllOpenLocationSlugsWithNames(session),
    getAllOpenDonationPointSlugsWithNames(session),
    getAllConstituencySlugsWithNames(session),
  ]);

  const html = await render("public/md/sitemap.njk", {
    domain: c.env.SITE_DOMAIN,
    url_names: SITEMAP_URL_NAMES,
    country_slugs: Object.keys(COUNTRY_MAPPING),
    foodbanks,
    locations,
    donationpoints,
    constituencies,
  });
  return new Response(html, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
