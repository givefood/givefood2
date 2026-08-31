import type { Context } from "hono";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";

// gfwfbn `get_location` (GET /needs/getlocation/, i18n-patterned).
// Ported from gfwfbn/views.py:192-204 -- "Handle non-javascript location
// requests": geolocate the requester, then a 302 to the wfbn index
// carrying lat_lng as a query param for its own client-side nearest-search
// to pick up. @never_cache in Django -- no Cache-Control set here either,
// matching that.
//
// DELIBERATE ARCHITECTURE CHANGE, not a parity port: Django calls out to
// freeipapi.com (a live, third-party HTTP lookup on every request) because
// a traditional server has no geolocation data of its own for an incoming
// IP. A Cloudflare Worker does -- `request.cf.latitude`/`.longitude` are
// already computed at the edge before this handler even runs, same
// mechanism workers/site/src/routes/wfbn/hit.ts already reads `cf.country`
// from. Using it instead removes a live external dependency (and its
// failure mode) entirely, for a strictly more reliable, faster
// equivalent. `cf` is typed `any` by @cloudflare/workers-types (it varies
// by product/plan), hence the narrow local shape, same convention as
// hit.ts's own comment on this. Both fields are absent on a
// non-Cloudflare-proxied request (e.g. local `wrangler dev`, unless the
// simulated `cf` object includes them) -- that's the one case this
// diverges from Django's own always-attempts-a-lookup behaviour into a
// clean 400, matching Django's HttpResponseBadRequest() on a failed
// lookup.
export async function wfbnGetLocation(c: Context<AppEnv>): Promise<Response> {
  const cf = c.req.raw.cf as { latitude?: string; longitude?: string } | undefined;
  if (!cf?.latitude || !cf?.longitude) return c.text("", 400);

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const target = `${urlForLocale(locale, "wfbn:index")}?lat_lng=${cf.latitude},${cf.longitude}`;
  return c.redirect(target, 302);
}
