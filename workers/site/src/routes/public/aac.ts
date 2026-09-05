import type { Context } from "hono";
import { searchAddressAutocomplete, searchAddressAutocompleteNext } from "@givefood/db";
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

// Ticket #8. The speculative half: results for the typed prefix plus each
// character that might come next, so the NEXT keystroke renders with no
// round trip. See packages/db/src/aac.ts for how the buckets are built.
//
// A SEPARATE ROUTE, deliberately -- the response above is the one a user is
// waiting on and keeps its ten-row limits and ~750-byte payload; this one is
// speculative, an order of magnitude larger, and nothing blocks on it. They
// also cache independently, so a large bucket payload never evicts or delays
// the small hot one.
//
// Cached harder than the results endpoint (a week, not a day). It is derived
// from the same rows, but it is only ever a hint that the real request
// immediately corrects, so serving a stale one costs nothing a fresh one
// would have saved.
export async function addressAutocompleteNext(c: Context<AppEnv>): Promise<Response> {
  const query = c.req.query("q") ?? "";
  const next = await searchAddressAutocompleteNext(dbSession(c), query);

  return new Response(JSON.stringify({ next }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=604800",
    },
  });
}
