import type { Context } from "hono";
import {
  getAllConstituencySlugs,
  getAllOpenDonationPointSlugs,
  getAllOpenFoodbanksForSitemap,
  getAllOpenLocationSlugs,
} from "@givefood/db";
import type { Locale } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { changefreq } from "@givefood/models";
import { COUNTRY_MAPPING } from "../../lib/countries";

const XML_HEADERS = { "Content-Type": "text/xml" };

// givefood/views.py:644-696 sitemap() -- givefood/urls.py:53, inside
// i18n_patterns, so <loc> URLs are locale-prefixed per the requesting
// page's language (Django's {% url %} resolves in the active language;
// urlForLocale() reproduces that here explicitly since this bypasses the
// Nunjucks render() pipeline entirely -- text/xml, not an HTML page).
//
// `enable_write` is never added to this view's own template_vars in
// Django, so its `{% if enable_write %}` branch (a second <url> per
// constituency, for write:constituency) is unconditionally false here too
// -- omitted, not a gap.
//
// sitemap_external.xml (Django's sibling view, givefood/views.py:933-945,
// linking to each food bank's own external site/shopping-list/RSS feed)
// is deliberately not ported -- maintainer decision, not needed.
export async function sitemapXml(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const locale = c.get("lang") as Locale;
  const u = (name: string, ...args: string[]) => `${c.env.SITE_DOMAIN}${urlForLocale(locale, name, ...args)}`;

  // All four queries are column-projected, matching Django's four `.only()`
  // calls (givefood/views.py:660-679) one for one. Two of them used to be
  // `SELECT *`: together they pulled 14.2 MB of D1 result payload per render
  // to emit the 1,239,016-byte body, and the donation-point one alone
  // (10.6 MB, a median 320 ms against production) set the critical path
  // through this Promise.all -- which is now the ~40 ms of the two slug
  // queries instead. See getAllOpenFoodbanksForSitemap and
  // getAllOpenDonationPointSlugs for the measured figures; rows_read is
  // unchanged, so nothing about D1 billing moves.
  const [foodbanks, locationSlugs, donationpoints, constituencySlugs] = await Promise.all([
    getAllOpenFoodbanksForSitemap(session),
    getAllOpenLocationSlugs(session),
    getAllOpenDonationPointSlugs(session),
    getAllConstituencySlugs(session),
  ]);

  const urls: string[] = [];
  for (const name of ["index", "about_us", "donate", "annual_report_index", "privacy"]) urls.push(`<url><loc>${u(name)}</loc></url>`);
  for (const countrySlug of Object.keys(COUNTRY_MAPPING)) urls.push(`<url><loc>${u("country", countrySlug)}</loc></url>`);

  for (const foodbank of foodbanks) {
    urls.push(`<url><loc>${u("wfbn:foodbank", foodbank.slug)}</loc><changefreq>${changefreq(foodbank.days_between_needs)}</changefreq></url>`);
    urls.push(`<url><loc>${u("wfbn:foodbank_nearby", foodbank.slug)}</loc></url>`);
    if (foodbank.no_locations !== 0) urls.push(`<url><loc>${u("wfbn:foodbank_locations", foodbank.slug)}</loc></url>`);
    // no_donation_points is nullable in production (unlike no_locations) --
    // a truthy check treats null the same as 0 ("unknown/none"), matching
    // Django's own `if foodbank.no_donation_points:`. Same bug class
    // already found and fixed once this session in wfbn/updates.ts -- see
    // that file's identical comment.
    if (Boolean(foodbank.no_donation_points)) urls.push(`<url><loc>${u("wfbn:foodbank_donationpoints", foodbank.slug)}</loc></url>`);
    if (foodbank.rss_url || foodbank.news_url) urls.push(`<url><loc>${u("wfbn:foodbank_news", foodbank.slug)}</loc></url>`);
    if (foodbank.charity_name) urls.push(`<url><loc>${u("wfbn:foodbank_charity", foodbank.slug)}</loc></url>`);
  }
  for (const location of locationSlugs) urls.push(`<url><loc>${u("wfbn:foodbank_location", location.foodbank_slug, location.slug)}</loc></url>`);
  for (const donationpoint of donationpoints) urls.push(`<url><loc>${u("wfbn:foodbank_donationpoint", donationpoint.foodbank_slug, donationpoint.slug)}</loc></url>`);
  for (const slug of constituencySlugs) urls.push(`<url><loc>${u("wfbn:constituency", slug)}</loc></url>`);

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
  return new Response(body, { headers: XML_HEADERS });
}
