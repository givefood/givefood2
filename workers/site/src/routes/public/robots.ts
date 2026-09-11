import type { Context } from "hono";
import { LOCALES } from "@givefood/templates";
import { url, urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";

// givefood/views.py:819-846 robotstxt() -- givefood/urls.py:51, inside
// i18n_patterns with prefix_default_language=False, so it's reachable at
// /robots.txt, /cy/robots.txt, /ga/robots.txt, /gd/robots.txt -- but the
// view never branches on request.LANGUAGE_CODE, so all four variants
// render byte-identical content (the same handler is registered under all
// four paths, matching Django's own language-independent output).
//
// Django loops `for language in LANGUAGES` (21 entries) to build the
// Disallow:/Sitemap: lists; this port loops LOCALES (4: en/cy/ga/gd, per
// PLAN.md §2.7.1), so Disallow: is 10 lines here, not Django's 44.
//
// CRAWL-DELAY REMOVED, a deliberate divergence from Django's template
// (maintainer decision 2026-09-11). Django emitted "Crawl-delay: 2" in the
// second record. Google and Bing both ignore the directive outright --
// Google documents it as unsupported and Bing takes its rate from
// Webmaster Tools -- so the only crawlers it ever bound were the polite
// minority that honour it, which are not the ones generating load. The
// 404 flood that dominates this zone's traffic is Bing on stale URLs,
// which Crawl-delay was never able to slow. The rest of the file stays
// byte-for-byte Django's, including the two User-agent groups.
//
// sitemap_places_index is PERMANENTLY OMITTED from the Sitemap: list, not
// just deferred: maintainer decision 2026-08-31 -- the `/needs/at/place/`
// gazetteer pages (Django's `Place` model, 253,584 rows sourced from
// gazetteer.org.uk) are out of scope for this port entirely, so there is
// no sitemap to advertise for them. md_sitemap was omitted for the
// different "don't advertise a URL that 501s" reason, but WP 4.3 (the /md/
// markdown mirror) now exists, so it's added back below -- appended once,
// like Django's own `sitemap_urls.append(md_sitemap_url)`, not per-locale
// (the /md/ tree is entirely outside i18n_patterns).
export async function robotsTxt(c: Context<AppEnv>): Promise<Response> {
  const disallowed: string[] = ["/aac/", "/at/*/hit/"];
  const sitemapUrls: string[] = [];

  for (const locale of LOCALES) {
    disallowed.push(urlForLocale(locale, "wfbn:get_location"));
    disallowed.push(urlForLocale(locale, "flag"));
    sitemapUrls.push(urlForLocale(locale, "sitemap"));
  }
  sitemapUrls.push(url("md_sitemap"));

  const lines = [
    "User-agent: *",
    ...disallowed.map((d) => `Disallow: ${d}`),
    "",
    "User-agent: *",
    "Allow: /",
    "",
    ...sitemapUrls.map((s) => `Sitemap: ${c.env.SITE_DOMAIN}${s}`),
  ];

    // Django gave this @cache_page(SECONDS_IN_WEEK) (givefood/views.py). Set
  // HERE rather than left to middleware/pageCacheControl.ts, which no longer
  // treats text/plain as cacheable -- see that file on why a content type is
  // not evidence that a response is shareable.
  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=604800" },
  });
}
