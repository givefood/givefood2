import type { Context } from "hono";
import { loadCatalogue, translate, type Locale } from "@givefood/templates";
import type { AppEnv } from "../../types";

// givefood/views.py:849-900 manifest() -- givefood/urls.py:52, inside
// i18n_patterns. Only two of the dict's fields actually vary by language
// (lang, description); everything else (icons/screenshots/related_applications/
// etc.) is a static literal in the Django source too, ported verbatim.
export async function manifestJson(c: Context<AppEnv>): Promise<Response> {
  const locale = c.get("lang") as Locale;
  const catalogue = await loadCatalogue(locale);
  const description = translate(catalogue, "Use Give Food's tool to find what food banks near you are requesting to have donated");

  const manifest = {
    name: "Give Food",
    short_name: "Give Food",
    description,
    start_url: c.env.SITE_DOMAIN,
    display: "minimal-ui",
    lang: locale,
    icons: [{ src: "/static/img/favicon.svg", sizes: "48x48 72x72 96x96 128x128 256x256 512x512", type: "image/svg+xml", purpose: "any" }],
    screenshots: [
      { src: "/static/img/manifestscreens/index.png", type: "image/png", sizes: "1402x2356" },
      { src: "/static/img/manifestscreens/search.png", type: "image/png", sizes: "1402x2356" },
      { src: "/static/img/manifestscreens/foodbank.png", type: "image/png", sizes: "1402x2356" },
    ],
    prefer_related_applications: true,
    related_applications: [{ platform: "play", url: "https://play.google.com/store/apps/details?id=uk.org.givefood.android", id: "uk.org.givefood.android" }],
  };

  return new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } });
}
