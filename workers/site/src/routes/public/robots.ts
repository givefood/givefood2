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
// sitemap_places_index is still DELIBERATELY OMITTED from the Sitemap:
// list: it needs the gazetteer `Place` table (Phase 2.5, not yet copied to
// D1 -- see WP 4.2's own scoping notes). md_sitemap was omitted for the
// same "don't advertise a URL that 501s" reason, but WP 4.3 (the /md/
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
    "Crawl-delay: 2",
    "",
    ...sitemapUrls.map((s) => `Sitemap: ${c.env.SITE_DOMAIN}${s}`),
  ];

  return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/plain" } });
}
