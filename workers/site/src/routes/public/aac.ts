import type { Context } from "hono";
import { searchAddressAutocomplete } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";

// givefood/views.py:1522-1580 address_autocomplete() -- PLAN.md §4.8.6/
// §4.8.7. @cache_page(SECONDS_IN_DAY) there becomes an explicit
// Cache-Control here (no per-route cache middleware in this port -- see
// publicServices()'s comment on services.ts for why edge caching for HTML
// pages is a Cloudflare Cache Rule rather than per-route code; this route
// is JSON, uncredentialed and CORS-open, so it sets its own header
// directly instead). Response shape is frozen/contract: bare JSON array,
// terse {n,l,t,c} keys, CORS *, browser-cacheable for a day.
export async function addressAutocomplete(c: Context<AppEnv>): Promise<Response> {
  const query = c.req.query("q") ?? "";
  const session = dbSession(c);
  const results = await searchAddressAutocomplete(session, query);

  return new Response(JSON.stringify(results), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
