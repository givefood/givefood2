import type { Context } from "hono";
import { getSiteStats } from "@givefood/db";
import { intcomma } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";

// givefood/views.py:920-930 securitytxt() -- givefood/urls.py:65,
// untranslated block, single URL (/.well-known/security.txt). Hand-built
// in the Django view (not a template) -- exactly these two lines, ported
// verbatim. NOT the stale, unrouted duplicate at
// givefood/static/root/security.txt (different content, never wired into
// urls.py -- confirmed dead, not ported).
export async function securityTxt(): Promise<Response> {
  // @cache_page(SECONDS_IN_WEEK) in Django, set here for the same reason as
  // llmsTxt below: pageCacheControl no longer treats text/plain as cacheable.
  return new Response("Contact: mailto:mail@givefood.org.uk\nExpires: 2030-01-01T00:00:00.000Z\n", {
    headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=604800" },
  });
}

// givefood/views.py:904-917 llmstxt() -- givefood/urls.py:64, untranslated
// block, single URL (/llms.txt), no locale variants. Static Markdown-like
// document with two dynamic values (foodbanks_count/donationpoints_count,
// from the same get_site_stats() the homepage uses) ported as a template
// literal rather than through Nunjucks -- this is text/plain, not an HTML
// page, so page.njk's machinery doesn't apply (same reasoning as
// sitemaps.ts/robots.ts/manifest.ts).
//
// Content fixes applied, not a verbatim port:
// 1. The Data Dumps bullet is gone entirely -- WP 5.6, maintainer decision
//    2026-09-02: gfdumps' daily CSV/JSON/XML exports were dropped, not
//    built (PLAN.md §8.8). Advertising a page that will never exist to
//    crawlers would be worse than the pre-existing "and YAML" inaccuracy
//    this bullet also had (no YAML dump ever existed either).
// 2. The "Multi-Language Support" section named 20 languages (not even
//    the real 21, and omitting Welsh entirely) -- rewritten for the 4
//    languages this migration actually supports (PLAN.md §2.7.1).
// 3. The Email Subscriptions bullet gave the subscribe URL as
//    /needs/at/{slug}/subscribe/ -- verified against the real route
//    (wfbn:updates, packages/templates/src/urls.ts) that's wrong, missing
//    an /updates/ segment; the real path is
//    /needs/at/{slug}/updates/subscribe/. This is a real, pre-existing
//    inaccuracy in Django's own llms.txt (not something this port
//    introduced), but this file's whole purpose is accurate crawler
//    documentation, so it's corrected rather than reproduced.
export async function llmsTxt(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const stats = await getSiteStats(session);
  const domain = c.env.SITE_DOMAIN;
  const foodbanksCount = intcomma(stats?.foodbanks ?? 0);
  const donationpointsCount = intcomma(stats?.donationpoints ?? 0);

  const body = `# Give Food

> UK charity providing the largest public database of food banks and their current needs, with data used by governments, councils, NHS, media, and apps to help alleviate food insecurity.

Give Food is a registered charity in England & Wales (1188192) that uses data to highlight local and structural food insecurity. We maintain near-realtime data on ${foodbanksCount} food bank locations and ${donationpointsCount}+ donation points across the UK, tracking what items they need donated and providing tools to help connect donors with those in need.

## Sitemap

- [Markdown Sitemap](${domain}/md/sitemap.md)

## About the Charity

- [About Give Food](${domain}/about-us/): Information about the charity, mission, and impact
- [Annual Reports](${domain}/annual-reports/): Yearly reports on activities, innovations, and impact (2019-2025)
- [2025 Annual Report](${domain}/2025/): Latest annual report
- [Donate](${domain}/donate/): Information on how to support Give Food
- [Register a Food Bank](${domain}/register-foodbank/): Form for food banks to join the database
- [Privacy Policy](${domain}/privacy/): How we handle data and user privacy
- [Bot Documentation](${domain}/bot/): Information about GiveFoodBot web crawler

## Public Tools

- [Find Food Banks Near You](${domain}/needs/): Search by postcode, town, or location to find nearby food banks and what they need
- [Write to Your MP](${domain}/write/): Contact your Member of Parliament about food insecurity issues
- [Dashboard](${domain}/dashboard/): Data visualizations and statistics about food bank usage and trends
- [Android App](https://play.google.com/store/apps/details?id=uk.org.givefood.android): Mobile app to find food banks and their needs

## Country Pages

- [England](${domain}/england/): Food banks in England with regional map
- [Scotland](${domain}/scotland/): Food banks in Scotland with regional map
- [Wales](${domain}/wales/): Food banks in Wales with regional map
- [Northern Ireland](${domain}/northern-ireland/): Food banks in Northern Ireland with regional map

## Dashboard & Analytics

- [Main Dashboard](${domain}/dashboard/): Overview of food bank statistics and trends
- [Items Requested Weekly](${domain}/dashboard/items-requested-weekly/): Chart showing weekly demand trends over time
- [Items Requested Weekly by Year](${domain}/dashboard/items-requested-weekly/by-year/): Year-over-year comparison
- [Bean & Pasta Index](${domain}/dashboard/bean-pasta-index/): Unique index tracking staple item demand as a measure of food insecurity
- [Most Requested Items](${domain}/dashboard/most-requested-items/): Analysis of commonly requested food and hygiene items
- [Most Excess Items](${domain}/dashboard/most-excess-items/): Items food banks have in surplus
- [Item Categories](${domain}/dashboard/item-categories/): Items aggregated by category
- [Charity Income & Expenditure](${domain}/dashboard/charity-income-expenditure/): Financial data for food bank charities
- [Donation Points by Supermarket](${domain}/dashboard/donationpoints/supermarkets/): Distribution of donation points by retailer
- [Food Banks Found](${domain}/dashboard/foodbanks-found/): Cumulative count of food banks discovered over time

## Multi-Language Support

The website is available in 4 languages to serve UK and Ireland communities:

- English (en), Welsh (cy), Irish (ga), Scottish Gaelic (gd)

Access any language via: ${domain}/{language-code}/

## API Documentation

- [API Overview](${domain}/api/): Introduction to the public API for accessing food bank data
- [API v2 Documentation](${domain}/api/2/docs/): Interactive documentation with all endpoints and examples
- [API v2 Source](https://github.com/givefood/givefood2/tree/main/workers/site/src/routes/api2): The handlers behind every v2 endpoint

## API Endpoints (v2)

### Food Banks
- [List All Food Banks](${domain}/api/2/foodbanks/): All active food banks with basic information
- [Get Food Bank Details](${domain}/api/2/foodbank/{slug}/): Detailed information including needs and nearby locations
- [Search Food Banks](${domain}/api/2/foodbanks/search/?address={location}): Find food banks by postcode or address

### Locations
- [List All Locations](${domain}/api/2/locations/): All food bank distribution points
- [Search Locations](${domain}/api/2/locations/search/?address={location}): Find distribution points near an address

### Donation Points
- [List All Donation Points](${domain}/api/2/donationpoints/): All donation collection points (GeoJSON)

### Needs & Requests
- [List Recent Needs](${domain}/api/2/needs/): Latest 100 food bank need updates
- [Get Specific Need](${domain}/api/2/need/{id}/): Individual need request details

### Political Data
- [List All Constituencies](${domain}/api/2/constituencies/): UK parliamentary constituencies
- [Get Constituency Details](${domain}/api/2/constituency/{slug}/): Food banks in a specific constituency

### Geographic Data (GeoJSON)
- [All Food Banks](${domain}/needs/geo.json): All food banks, locations, and donation points
- [Food Bank](${domain}/needs/at/{slug}/geo.json): Geographic data for a specific food bank
- [Constituency](${domain}/needs/in/constituency/{slug}/geo.json): Food banks in a constituency
- [Country](${domain}/{country-slug}/geo.json): Food banks in England, Scotland, Wales, or Northern Ireland

### Response Formats
API endpoints support multiple formats via \`?format=\` parameter:
- \`json\` (default), \`xml\`, \`yaml\`, \`geojson\`

## Data Resources

- [Open Data Repository](https://github.com/givefood/data): Versioned food bank data on GitHub with daily updates
- [Food Banks CSV](https://github.com/givefood/data/blob/main/foodbanks.csv): Complete list of food banks with metadata
- [API Usage Guidelines](${domain}/api/): Best practices for using Give Food data responsibly

## Notifications & Subscriptions

- **Email Subscriptions**: Subscribe to food bank updates at ${domain}/needs/at/{slug}/updates/subscribe/
- **WhatsApp Notifications**: Subscribe via WhatsApp by sending "subscribe {foodbank-slug}" to our WhatsApp number
- **RSS Feeds**: Site-wide feed at ${domain}/needs/rss.xml or per-food bank at ${domain}/needs/at/{slug}/rss.xml

## Source Code & Documentation

- [Main Repository](https://github.com/givefood/givefood2): Complete source code for the Give Food platform
- [Project README](https://github.com/givefood/givefood2/blob/main/README.md): Repository overview and architecture
- [Testing Guide](https://github.com/givefood/givefood2/blob/main/TESTING.md): How to run tests and contribute
- [Architecture & Decisions](https://github.com/givefood/givefood2/blob/main/PLAN.md): Why the platform is built the way it is
- [Templates & Translations](https://github.com/givefood/givefood2/tree/main/packages/templates): Nunjucks templates and the i18n catalogues

## Technical Components

- [Public Worker](https://github.com/givefood/givefood2/tree/main/workers/site): Every HTTP route the site serves
- [What Food Banks Need](https://github.com/givefood/givefood2/tree/main/workers/site/src/routes/wfbn): Food bank search tool
- [Dashboard](https://github.com/givefood/givefood2/tree/main/workers/site/src/routes/dashboards): Data visualization components
- [Write to MP](https://github.com/givefood/givefood2/tree/main/workers/site/src/routes/write): MP contact functionality
- [Background Jobs](https://github.com/givefood/givefood2/tree/main/workers/jobs): Crons, queue consumers and the daily dumps

## Key Features

- **AI-Enhanced Data**: Automated categorization of food bank needs using Google GenAI
- **Multi-Language Support**: Website available in 4 languages -- English, Welsh, Irish, and Scottish Gaelic
- **Comprehensive Coverage**: ${foodbanksCount} food banks and ${donationpointsCount}+ donation points including supermarkets, phone boxes, and cathedrals
- **Real-Time Updates**: Multiple updates per day from web scraping of food bank websites
- **Political Integration**: Parliamentary constituency mapping and direct MP contact tools
- **Open Data**: All data freely available via API and GitHub with no registration required
- **Notification System**: Email, WhatsApp, and RSS subscriptions for food bank updates
- **Trusted by**: Governments (UK, Scottish, Welsh), NHS, BBC, Channel 4, major supermarkets, universities, and hundreds of news organizations

## Contact

- Email: mail@givefood.org.uk
- Twitter: https://twitter.com/GiveFoodCharity
- Facebook: https://www.facebook.com/GiveFoodOrgUK
- Website: ${domain}
- Charity Registration: England & Wales 1188192
`;

    // Django gave this @cache_page(SECONDS_IN_WEEK) (givefood/views.py). Set
  // HERE rather than left to middleware/pageCacheControl.ts, which no longer
  // treats text/plain as cacheable -- see that file on why a content type is
  // not evidence that a response is shareable.
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=604800" },
  });
}
