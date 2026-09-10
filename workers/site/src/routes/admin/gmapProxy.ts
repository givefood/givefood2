import type { Context } from "hono";
import type { AppEnv } from "../../types";

// gfadmin/views.py:3362-3370 gmap_proxy() -- the CORS shim behind admin.js's
// "Lookup Donation Point" and "Lookup Location" buttons. Google's Places
// endpoints send no CORS headers, so the browser cannot call them directly;
// this proxies the two calls admin.js makes (API_URLS.placeSearch /
// API_URLS.placeDetail) and returns the JSON same-origin.
//
// Two defects fixed rather than ported:
//
// 1. Django forwards `request.GET.dict()` -- EVERY query parameter, verbatim,
//    including a `key` the browser supplied. So the Places API key has to be
//    published to every admin page as a JS global for the buttons to work at
//    all, and the proxy adds no protection whatsoever: it is a plain open
//    relay to two Google endpoints. Here the key is read from the Worker
//    secret server-side and any client-supplied `key` is DISCARDED, so the
//    Places key never has to reach the browser. admin.js still appends its
//    (now empty) `key=` param; it is simply ignored, so the shipped
//    otherwise-unmodified admin.js keeps working unchanged.
// 2. `params = request.GET.dict()` also lets a caller inject arbitrary Places
//    API parameters. Only the parameters admin.js actually sends are
//    forwarded here.
const ALLOWED_PARAMS: Record<GmapProxyType, readonly string[]> = {
  textsearch: ["query", "region"],
  placedetails: ["placeid", "region"],
};

const UPSTREAM: Record<GmapProxyType, string> = {
  textsearch: "https://maps.googleapis.com/maps/api/place/textsearch/json",
  placedetails: "https://maps.googleapis.com/maps/api/place/details/json",
};

type GmapProxyType = "textsearch" | "placedetails";

function isProxyType(value: string | undefined): value is GmapProxyType {
  return value === "textsearch" || value === "placedetails";
}

// GET /admin/proxy/gmaps/textsearch/?query=...
// GET /admin/proxy/gmaps/placedetails/?placeid=...
export async function adminGmapProxy(c: Context<AppEnv>): Promise<Response> {
  const type = c.req.param("type");
  if (!isProxyType(type)) return c.notFound();

  const key = c.env.GMAP_PLACES_KEY;
  if (!key) {
    // Set on the account and listed in wrangler.jsonc's `secrets.required`
    // since 2026-09-02, so this branch is now only reachable if the secret is
    // later revoked or rotated away. Kept: a clear JSON error beats a Google
    // error the caller can't act on -- admin.js logs the failure and alerts,
    // so this text reaches the admin.
    return c.json({ status: "REQUEST_DENIED", error_message: "GMAP_PLACES_KEY is not configured on this Worker" }, 503);
  }

  const upstream = new URL(UPSTREAM[type]);
  for (const name of ALLOWED_PARAMS[type]) {
    const value = c.req.query(name);
    if (value) upstream.searchParams.set(name, value);
  }
  upstream.searchParams.set("key", key);

  let res: Response;
  try {
    res = await fetch(upstream, { signal: AbortSignal.timeout(20_000) });
  } catch {
    return c.json({ status: "UNKNOWN_ERROR", error_message: "Google Places could not be reached" }, 502);
  }
  if (!res.ok) return c.json({ status: "UNKNOWN_ERROR", error_message: `Google Places returned ${res.status}` }, 502);

  // Pass the body straight through -- admin.js reads Google's own response
  // shape (results[0].geometry.location, result.formatted_address, ...), so
  // reshaping it here would break the shipped script.
  return c.json(await res.json());
}
