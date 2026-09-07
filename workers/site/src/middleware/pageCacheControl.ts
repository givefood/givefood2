import type { MiddlewareHandler } from "hono";
import { LOCALES } from "@givefood/templates";
import type { AppEnv } from "../types";

// Django decorated 75 public views with @cache_page, which sets a
// Cache-Control header on the response. This port sets one in 12 of its 72
// public route files -- the API, geojson, /aac/, favicons, screenshots and
// a handful of others -- and nothing at all on HTML, RSS or Markdown.
//
// routes/public/services.ts records the reasoning: "edge caching for the
// cached pages is a Cloudflare Cache Rule, not per-route code". That is
// still true and is not being reversed here. The Cache Rule works -- a food
// bank page comes back HIT with age=3092 -- but a Cache Rule is an EDGE
// mechanism, and it cannot put a header in the response. So no browser
// anywhere caches a page of this site for a single second, where Django's
// @cache_page had them caching for an hour, a day or a week. Measured
// 2026-09-06: html 11.9% edge hit rate, rss 0.0%, md 1.3%.
//
// This middleware supplies only the half the Cache Rule cannot: the header.
//
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
// Only s-maxage, which shared caches read and browsers ignore. Whether the
// edge actually uses it depends on the Cache Rule: a rule with an explicit
// Edge TTL overrides it, one set to respect origin honours it. Both are
// fine, which is the point of writing it this way -- it either matches
// Django's number or defers to the rule already in place, and cannot
// shorten what the edge does today.
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

// Only the three types that have no header today. Everything else either
// already sets its own (JSON, geojson, images) or is served by the assets
// binding with its own immutable headers.
const CACHEABLE_TYPES = /^(?:text\/html|application\/rss\+xml|text\/markdown|text\/plain)/;

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
};
