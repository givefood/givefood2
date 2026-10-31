import type { MiddlewareHandler } from "hono";
import { LOCALES } from "@givefood/templates";
import type { AppEnv } from "../types";
import { isPurgedByEntity } from "./cacheTag";

// Django decorated 75 public views with @cache_page, which sets a
// Cache-Control header on the response. This port sets one in 12 of its 72
// public route files -- the API, geojson, /aac/, favicons, screenshots and
// a handful of others -- and nothing at all on HTML, RSS or Markdown.
//
// The port's original reasoning was that "edge caching for the cached pages
// is a Cloudflare Cache Rule, not per-route code". That stopped being true
// when wrangler.jsonc turned on Workers Caching: zone Cache Rules have no
// effect on it, and the response headers are its entire configuration. So
// this middleware now sets both halves -- Cache-Control for browsers and any
// other shared cache, and CDN-Cache-Control for Cloudflare's edge (see
// edgeTtl below). Measured 2026-09-06, before either: html 11.9% edge hit
// rate, rss 0.0%, md 1.3%.

// WHY A MIDDLEWARE AND NOT 60 EDITS. The alternative is a Cache-Control line
// in every page handler, which is how the 12 explicit ones work and is the
// better pattern when a route has something particular to say. For "every
// HTML page should tell browsers something", 60 copies of the same line is
// 60 chances to forget one -- and the ones already carrying their own header
// keep it, because this only ever fills a gap (see the guards below).

const SECONDS_IN_HOUR = 3600;
const SECONDS_IN_DAY = 86400;
const SECONDS_IN_WEEK = 604800;

// What the BROWSER is told, and deliberately not what Django told it.
//
// Django sent max-age=86400 on a food bank's needs page, so a visitor who
// looked twice in a day saw the same shopping list even after the food bank
// changed it -- a browser cache cannot be purged, and this site's entire
// purpose is the currency of that list. The edge can be purged (the
// cache-tag design in PLAN.md §3.6, and routes/media.ts's cache-tag), so
// the long TTLs below stay on the edge where they can be revoked, and the
// browser gets five minutes: enough to make a back button, a second tab and
// a re-navigation free, far too short to show a stale need list to anyone.
//
// This is a DELIBERATE DIVERGENCE from Django, in the safer direction.
const BROWSER_MAX_AGE = 300;

// s-maxage per family, matching the @cache_page value on the corresponding
// Django view (extracted from gfwfbn/views.py and givefood/views.py rather
// than guessed). Order matters -- first match wins -- and anything not
// listed falls through to DAY, which is what @cache_page said for the food
// bank pages that make up nearly all of this site's HTML.
//
// s-maxage, which shared caches read and browsers ignore. Cloudflare's own
// edge does not use it: Workers Caching reads CDN-Cache-Control first (see
// edgeTtl below). Zone Cache Rules have no effect on Workers Caching at all.
// Built from LOCALES, not a character class. It was "(?:[a-z-]{2,7}/)?"
// first, which matches a locale prefix and ALSO matches "privacy", "rss"
// and "md" -- so /privacy/ was being read as a locale home page and given
// the home page's one hour instead of Django's week. Caught by the tests
// below this file's own reasoning, which is why they exist. The router
// registers prefixes from this same list ("en" is never a prefix), so
// deriving it here cannot drift from what actually routes.
const LOCALE_PREFIX = `(?:(?:${LOCALES.filter((l) => l !== "en").join("|")})/)?`;
const at = (rest: string) => new RegExp(`^/${LOCALE_PREFIX}${rest}$`);

const HOME = at("");
const NEWS = at("news/");

// gfwfbn `index` -- @cache_page(SECONDS_IN_HOUR) at gfwfbn/views.py:50,
// mounted at "needs/" by givefood/urls.py:47 INSIDE i18n_patterns, so the
// locale prefix applies exactly as it does to HOME. github #19: this had no
// rule at all and fell through to the day default, so the site's primary
// search page could serve a food bank list 24 hours stale where Django
// capped it at one.
const WFBN_INDEX = at("needs/");

// givefood `md_index` -- @cache_page(SECONDS_IN_HOUR) at
// givefood/views.py:699. NOT built with at(): the markdown block is OUTSIDE
// i18n_patterns, so /cy/md/ is not a route and inventing a locale prefix
// here would match a URL that does not exist.
const MD_INDEX = /^\/md\/$/;
const COUNTRY = at("(?:scotland|england|wales|northern-ireland)/");
const WEEKLY_PAGES = at("(?:about-us|privacy|donate|colophon|bot|api|annual-reports|constituencies)/");
const ANNUAL_REPORT = at("(?:19|20)\\d{2}/");

const SHARED_TTL: { test: (path: string) => boolean; ttl: number }[] = [
  // givefood/views.py index/news/country -- @cache_page(SECONDS_IN_HOUR).
  // The home page carries "recently updated" and "most viewed" panels, so
  // an hour is the point rather than an accident.
  { test: (p) => HOME.test(p), ttl: SECONDS_IN_HOUR },
  { test: (p) => NEWS.test(p), ttl: SECONDS_IN_HOUR },
  { test: (p) => COUNTRY.test(p), ttl: SECONDS_IN_HOUR },
  // gfwfbn index (the postcode-search results) and givefood md_index --
  // both @cache_page(SECONDS_IN_HOUR). github #19.
  //
  // THE TTL IS THE ONLY BOUND ON STALENESS FOR /needs/, which is why the
  // number matters more here than on the pages around it. tagsFor() returns
  // [] for this path, so the fb-all purge that fires on every publish cannot
  // reach it -- and that is PARITY, not a second bug: Django's decache list
  // (givefood/models/foodbank.py:717-758) omits reverse("wfbn:index") too.
  // Django simply had an hour to fall back on, and this port had a day.
  { test: (p) => WFBN_INDEX.test(p), ttl: SECONDS_IN_HOUR },
  { test: (p) => MD_INDEX.test(p), ttl: SECONDS_IN_HOUR },
  // gfwfbn foodbank_nearby / md_foodbank_nearby -- @cache_page(SECONDS_IN_WEEK).
  { test: (p) => p.endsWith("/nearby/"), ttl: SECONDS_IN_WEEK },
  // givefood about_us/privacy/donate/colophon/bot/annual reports and
  // gfwfbn constituencies -- all @cache_page(SECONDS_IN_WEEK).
  { test: (p) => WEEKLY_PAGES.test(p), ttl: SECONDS_IN_WEEK },
  { test: (p) => ANNUAL_REPORT.test(p), ttl: SECONDS_IN_WEEK },
];

function sharedTtl(path: string): number {
  for (const rule of SHARED_TTL) if (rule.test(path)) return rule.ttl;
  return SECONDS_IN_DAY;
}

// WHAT THE EDGE IS TOLD, separately from what Cache-Control says.
//
// Workers Caching reads CDN-Cache-Control ahead of Cache-Control, and nothing
// downstream does (browsers ignore it). That matters for two reasons:
//
// 1. s-maxage turns stale-while-revalidate OFF. RFC 9111 gives s-maxage
//    proxy-revalidate semantics, and Cloudflare honours that: with s-maxage
//    present, every expired entry is a blocking re-render (cf-cache-status
//    EXPIRED) and stale-if-error is disabled too. The edge directive below
//    uses max-age instead, so an expired page is served at once (UPDATING)
//    while the Worker refreshes it in the background, and a Worker error
//    while refreshing serves the last good copy rather than a 500.
//
// 2. A longer TTL for pages that are purged by name. This site's traffic is
//    a very long tail -- 1,375 distinct paths in 3,308 pageviews in a week of
//    late October 2026 -- so most food bank pages are not viewed twice in a
//    day, and a one-day TTL expired before the next visitor arrived. A food
//    bank's pages (fb-<slug>) and a constituency's (pc-<slug>) are purged
//    by tag on every admin save that changes them (queues/cachePurge.ts), so
//    at the edge they get a week, where Cache-Control keeps Django's day for
//    any other shared cache. Pages without such a tag keep their family's
//    TTL, because nothing purges them early.
//
// The stale window equals the TTL: at most one request after expiry sees the
// old copy, and only if it arrives within that window.
function edgeTtl(path: string): number {
  const ttl = sharedTtl(path);
  return ttl === SECONDS_IN_DAY && isPurgedByEntity(path) ? SECONDS_IN_WEEK : ttl;
}

// Only the three types that have no header today. Everything else either
// already sets its own (JSON, geojson, images) or is served by the assets
// binding with its own immutable headers.
//
// text/plain WAS ON THIS LIST AND HAD TO COME OFF. A content type is not
// evidence that a response is shareable, and text/plain is the type most
// likely to be a per-visitor fragment: /frag/ip-address/ returns the
// caller's own IP, and with no Cache-Control of its own it was stamped
// `public, s-maxage=86400` here and served to whoever asked next -- observed
// on production 2026-09-07 as a HIT, age 1427, carrying a stranger's IPv6
// address. The WhatsApp webhook's GET verification echo (whatsappHook.ts:89)
// is text/plain too, and equally must not be cached.
//
// The three that remain are HTML page renders and their markdown/RSS
// equivalents -- all whole-page responses from routes that take no
// per-visitor input. robots.txt, security.txt and llms.txt now set their own
// week-long TTL (matching Django's @cache_page) rather than relying on this.
//
// THIS IS THE SECOND TIME this middleware defaulted a per-visitor response
// to public; the first was CSRF-bearing forms, fixed by the csrfIssued flag
// above. The lesson both times: default to NOT caching and let a route opt
// in, rather than inferring shareability from a header the route did not
// choose.
const CACHEABLE_TYPES = /^(?:text\/html|application\/rss\+xml|text\/markdown)/;

export const pageCacheControl: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();

  // GET only. A POST response is never cacheable and HEAD inherits GET's
  // headers from the same handler anyway.
  if (c.req.method !== "GET") return;
  // 200 only. A 404's TTL is its own decision (routes/media.ts deliberately
  // uses max-age=10 on one), and a redirect's is the router's.
  if (c.res.status !== 200) return;

  // NEVER OVERRIDE. This is the guard that makes the middleware safe to
  // mount on "*": middleware/noStore.ts has already set
  // "private, no-store" on /admin, /auth, the subscriber confirm/unsubscribe
  // routes and the email-done page by the time this runs, and every route
  // with its own considered TTL has set that. A gap-filler must only fill
  // gaps.
  if (c.res.headers.has("Cache-Control")) return;

  // A RESPONSE CARRYING A CSRF TOKEN IS PER-VISITOR. lib/csrf.ts's
  // issueCsrfToken() sets this on every path, so the test is "did this
  // response get a token" rather than "did it happen to set a cookie".
  //
  // THE COOKIE TEST BELOW WAS NOT ENOUGH, and shipping it alone was a live
  // bug. This middleware's first version relied on Set-Cookie only, citing
  // a verification that /flag/ returns BYPASS with a distinct token per
  // request -- true, but only for a visitor with NO cookie. issueCsrfToken
  // REUSES a valid cookie and returns early without re-emitting it, so a
  // returning visitor's /flag/ came back with no Set-Cookie, was stamped
  // `public, max-age=300, s-maxage=86400`, and went into the shared cache
  // with that visitor's token in the HTML. Everyone subsequently served
  // that entry had their form submission rejected by verifyCsrf and their
  // typed contents discarded by the ?turnstilefail=true redirect -- on
  // /write/to/<slug>/ that is a name, postal address and email. Up to 24
  // hours per URL, unpurgeable (cacheTag.ts assigns these paths no tag).
  // Reproduced against production 2026-09-07 before the fix.
  //
  // Both checks are kept. The flag is the correct, causal one; Set-Cookie
  // stays as belt-and-braces for any future per-visitor response that sets
  // a cookie without going through issueCsrfToken (a session, a preference).
  if (c.get("csrfIssued")) return;
  if (c.res.headers.has("Set-Cookie")) return;

  const type = c.res.headers.get("Content-Type") ?? "";
  if (!CACHEABLE_TYPES.test(type)) return;

  const path = new URL(c.req.url).pathname;
  c.header("Cache-Control", `public, max-age=${BROWSER_MAX_AGE}, s-maxage=${sharedTtl(path)}`);
  const edge = edgeTtl(path);
  c.header("CDN-Cache-Control", `public, max-age=${edge}, stale-while-revalidate=${edge}`);
};
