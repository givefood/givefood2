// Cache-Tag names, in one place because two Workers have to agree on them:
// workers/site stamps them onto responses (middleware/cacheTag.ts) and
// workers/jobs purges by them (queues/cachePurge.ts). A tag invented
// independently on either side is a purge that silently does nothing, which
// is the failure mode this file exists to prevent.
//
// PLAN.md §3.6 "Purge: cache tags, not URLs". Django instead enumerates the
// URLs a food bank owns and purges them by name -- 30 at a time, plus
// prefixes (givefood/models/foodbank.py:717-758, utils/cache.py:156-197).
// That list has to be kept in step by hand with every route that renders a
// food bank, and it is already out of step: it never mentions
// /needs/at/<slug>/donationpoints/ or the donation point pages under it.
// A tag stamped by the router cannot drift from the routes.
//
// Verified available on this zone's plan before building any of this:
// purge by tag is NOT Enterprise-only (Free/Pro/Business/Enterprise all
// support URL, hostname, tag and prefix purging; only the rate limits
// differ). givefood.org.uk is Business.

// Everything that renders one food bank: its pages in every locale, its
// RSS, its GeoJSON, its markdown mirror, its API representations, and its
// locations and donation points.
export function foodbankTag(slug: string): string {
  return `fb-${slug}`;
}

// One constituency's page and GeoJSON, which list the food banks inside it.
export function constituencyTag(slug: string): string {
  return `pc-${slug}`;
}

// The aggregates: the homepage, the sitemaps, the site-wide RSS and GeoJSON,
// and every list endpoint across all three API versions. ANY food bank
// changing invalidates all of them, so they share one tag rather than
// carrying every food bank's.
//
// This is what Django does too, without the name: its per-save URL list
// includes reverse("index"), the sitemap, api_foodbanks, api2:foodbanks and
// api2:locations -- the same set, re-listed on every save.
export const AGGREGATE_TAG = "fb-all";

// Media objects, already stamped by routes/media.ts before this module
// existed. Kept here so the naming is discoverable rather than only
// appearing at the one site that writes it.
export function mediaTag(slug: string): string {
  return `media-${slug}`;
}
export const MEDIA_TAG = "media";
