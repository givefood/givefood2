import type { Context } from "hono";
import { getDonationPointBySlugs, getFoodbankBySlug } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";

// gfwfbn `foodbank_favicon`/`foodbank_donationpoint_favicon`
// (gfwfbn/views.py:510-524, 1026-1041). Deliberately NOT part of the R2
// media system (routes/media.ts): that system exists to keep BILLED,
// rate-limited third-party calls (Static Maps, Places photos, Browser
// Rendering) out of the request path via an async backfill queue. Google's
// favicon service (unlike those) is free and keyless, so there's no cost
// reason to defer it -- this fetches live on a cache miss and caches the
// response with the Workers Cache API (this repo's first use of it),
// giving every request -- including the very first one for a given food
// bank -- a real favicon, not a 404 that only clears up once an async job
// eventually runs.
//
// get_favicon() (givefood/utils/general.py:167-176) -- domain-only, no
// path/query, sz=64. Falls back to a bundled default image on any failure
// (no url, non-200, network error), matching Django's own
// `if not favicon: favicon = DEFAULT_FAVICON`.
//
// Calls gstatic directly rather than google.com/s2/favicons: the latter is
// just a 301 to this same faviconV2 endpoint on t0.gstatic.com, so hitting
// it straight away saves a redirect round trip on every cache miss.
const GSTATIC_FAVICON_BASE_URL = "https://t0.gstatic.com/faviconV2";
const DEFAULT_FAVICON_URL = "https://www.givefood.org.uk/static/img/default_favicon.png";
const CACHE_CONTROL_WEEK = "public, max-age=604800"; // matches @cache_page(SECONDS_IN_WEEK)

async function fetchFaviconFor(url: string | null): Promise<Response | null> {
  if (!url) return null;
  let domain: string;
  try {
    domain = new URL(url).hostname;
  } catch {
    return null;
  }
  const params = new URLSearchParams({
    client: "SOCIAL",
    type: "FAVICON",
    fallback_opts: "TYPE,SIZE,URL",
    url: `http://${domain}`,
    size: "64",
  });
  const response = await fetch(`${GSTATIC_FAVICON_BASE_URL}?${params}`);
  return response.ok ? response : null;
}

// Cache-then-fetch-then-cache-write-back, using the Workers Cache API
// directly (c.req.raw as the cache key -- query-string-free, so no
// fragmentation risk the way media.ts's own ?size= comment warns about).
async function servedFromCacheOrFetched(c: Context<AppEnv>, url: string | null): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(c.req.raw);
  if (cached) return cached;

  const upstream = (await fetchFaviconFor(url)) ?? (await fetch(DEFAULT_FAVICON_URL));
  const response = new Response(upstream.body, {
    headers: { "Content-Type": "image/png", "Cache-Control": CACHE_CONTROL_WEEK },
  });
  c.executionCtx.waitUntil(cache.put(c.req.raw, response.clone()));
  return response;
}

export async function wfbnFoodbankFavicon(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  return servedFromCacheOrFetched(c, foodbank.url);
}

export async function wfbnFoodbankDonationpointFavicon(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const dpslug = c.req.param("dpslug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  const donationpoint = await getDonationPointBySlugs(session, foodbank.slug, dpslug);
  if (!donationpoint) return c.notFound();
  return servedFromCacheOrFetched(c, donationpoint.url);
}
