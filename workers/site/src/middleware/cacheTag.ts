import type { MiddlewareHandler } from "hono";
import { AGGREGATE_TAG, constituencyTag, foodbankTag } from "@givefood/urls";
import type { AppEnv } from "../types";

// PLAN.md §3.6 "Purge: cache tags, not URLs". Stamps every cacheable
// response with the tags that say what it depends on, so
// queues/cachePurge.ts can invalidate one food bank without purging the
// zone.
//
// DERIVED FROM THE PATH, IN MIDDLEWARE, rather than set by each handler.
// Django's equivalent is a list of URLs rebuilt by hand inside
// Foodbank.save() (models/foodbank.py:717-758), and it is already wrong: it
// never mentions /needs/at/<slug>/donationpoints/ or any donation point
// page beneath it, so editing a food bank has never purged them. Thirty-odd
// handlers each remembering to call a helper would rot the same way. A rule
// over the path cannot: a route added tomorrow under /needs/at/<slug>/ is
// tagged the moment it exists.
//
// RUNS AFTER THE HANDLER and writes to c.res, because the tag belongs on
// the way out -- including on responses a handler built itself with
// `new Response(...)` rather than through Hono's helpers.
//
// THE HEADER IS NOT VISIBLE TO CLIENTS. Cloudflare consumes Cache-Tag at
// the edge and strips it before the response reaches a browser, so
// `curl -I` will never show it -- confirmed here by mirroring the value
// into a temporary X-Probe-Tag, which came back `fb-all` on / and
// `fb-sid-valley` on /needs/at/sid-valley/. Do not "fix" its absence.
//
// NOT APPLIED TO UNCACHEABLE RESPONSES. If middleware/noStore.ts has marked
// it private/no-store there is nothing in any cache to purge, and a
// Cache-Tag on it is noise at best. Non-2xx is skipped for the same reason;
// a 404 with a tag would be purgeable but there is no reason to want that.

// The locale prefixes resolveLanguage strips. Duplicated as a plain regex
// fragment rather than imported so this stays a pure path rule with no
// ordering dependency on the language middleware -- it must work whether it
// runs before or after it, and on c.req.path, which still carries the
// prefix.
const LOCALE = "(?:cy|ga|gd)";

// /needs/at/<slug>/... and /<locale>/needs/at/<slug>/..., plus the markdown
// mirror at /md/needs/at/<slug>/. Everything under a food bank's own path:
// its page, locations, donation points, charity, news, RSS, GeoJSON.
const FOODBANK_PATH = new RegExp(`^(?:/md)?(?:/${LOCALE})?/needs/at/([^/]+)`);

// /api/1/foodbank/<slug>/, /api/2/foodbank/<slug>/ -- one food bank's API
// representation. The LIST endpoints are aggregates, handled below.
const FOODBANK_API = /^\/api\/[123]\/foodbank\/([^/]+)/;

// /constituency/<slug>/ and its geo.json, in any locale.
const CONSTITUENCY_PATH = new RegExp(`^(?:/${LOCALE})?/constituency/([^/]+)`);
const CONSTITUENCY_API = /^\/api\/[123]\/constituency\/([^/]+)/;

// Responses whose content changes when ANY food bank does: the homepage, the
// sitemaps, the site-wide feeds, and every list endpoint. Same set Django
// re-lists on every single save.
const AGGREGATE_PATHS = new RegExp(
  `^(?:` +
    `(?:/${LOCALE})?/$` +
    `|(?:/${LOCALE})?/needs/(?:rss\\.xml|geo\\.json)$` +
    `|/sitemap[^/]*\\.xml$` +
    `|(?:/${LOCALE})?/sitemap\\.xml$` +
    `|/api/[123]/(?:foodbanks|locations|donationpoints|needs|constituencies)` +
    `|/md/?$` +
    `)`,
);

function tagsFor(path: string): string[] {
  const tags: string[] = [];

  const fb = FOODBANK_PATH.exec(path) ?? FOODBANK_API.exec(path);
  if (fb?.[1]) tags.push(foodbankTag(fb[1]));

  const pc = CONSTITUENCY_PATH.exec(path) ?? CONSTITUENCY_API.exec(path);
  if (pc?.[1]) tags.push(constituencyTag(pc[1]));

  if (AGGREGATE_PATHS.test(path)) tags.push(AGGREGATE_TAG);

  return tags;
}

export const cacheTag: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();

  if (!c.res.ok) return;
  const cacheControl = c.res.headers.get("Cache-Control") ?? "";
  if (cacheControl.includes("no-store") || cacheControl.includes("private")) return;

  const tags = tagsFor(c.req.path);
  if (!tags.length) return;

  // Appended, not overwritten: routes/media.ts sets its own media tags and
  // both sets should survive on a food bank's photo.
  const existing = c.res.headers.get("Cache-Tag");
  c.res.headers.set("Cache-Tag", existing ? `${existing}, ${tags.join(", ")}` : tags.join(", "));
};
