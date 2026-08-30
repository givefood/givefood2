import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types";

// PLAN.md §3.7 "Media routes — PlacePhoto and the three families that were
// missing". Explicitly called out as "the safest possible first thing to
// ship": keyed by URL path (not place_id), so serving a request is a single
// env.MEDIA.get() with no D1 dependency and no lookup.
//
// NOTE: registration order matters. The two-segment location route is the
// most general and MUST come after the donationpoint route -- exactly as in
// gfwfbn/urls/generic.py:12-17 -- or /at/:slug/donationpoint/:dp/photo.jpg
// would be swallowed by /at/:slug/:loc/photo.jpg with loc="donationpoint".
export const mediaApp = new Hono<AppEnv>();

mediaApp.get("/at/:slug/photo.jpg", serveMedia);
mediaApp.get("/at/:slug/favicon.png", serveMedia);
mediaApp.get("/at/:slug/screenshots/:page{.+\\.png}", serveMedia);
mediaApp.get("/at/:slug/donationpoint/:dp/photo.jpg", serveMedia);
mediaApp.get("/at/:slug/donationpoint/:dp/favicon.png", serveMedia);
mediaApp.get("/at/:slug/:loc/photo.jpg", serveMedia);

// Map routes are inside i18n_patterns in Django (one URL, not per-language,
// but reached with a language prefix stripped by resolveLanguage upstream --
// see routes/wfbn.ts once it is built). Registered here too since they share
// serveMedia's R2-key-by-path design.
mediaApp.get("/at/:slug/map.png", serveMedia);
mediaApp.get("/at/:slug/maps/:size{[0-9]+}.png", serveMedia);
mediaApp.get("/at/:slug/:loc/map.png", serveMedia);
mediaApp.get("/at/:slug/:loc/maps/:size{[0-9]+}.png", serveMedia);

async function serveMedia(c: Context<AppEnv>) {
  const url = new URL(c.req.url);

  // NORMALISE ?size= AWAY. photo_from_place_id() (givefood/utils/geo.py:107)
  // only honours it on the very first Google fetch; for a stored photo it is
  // ignored. Keeping it in the cache key fragments the cache on a parameter
  // that changes nothing.
  const key = "media" + url.pathname;

  const inm = c.req.header("If-None-Match");
  // `onlyIf` must never be `undefined` here, even when there is no
  // If-None-Match header -- R2Bucket.get() only returns the
  // "matched-but-no-body" (304) shape under the overload where `onlyIf` is
  // structurally required. An empty R2Conditional carries no constraints, so
  // it behaves exactly like omitting onlyIf while keeping the wider return
  // type (R2ObjectBody | R2Object | null) available for the branch below.
  const onlyIf: R2Conditional = inm
    ? { etagDoesNotMatch: inm.replace(/^W\//, "").replace(/"/g, "") }
    : {};
  const obj = await c.env.MEDIA.get(key, { onlyIf, range: c.req.raw.headers });

  if (obj === null) {
    // Missing object. Enqueue a backfill and 404 now -- the Google Places /
    // Static Maps / Browser Rendering call NEVER happens in the user's request.
    c.executionCtx.waitUntil(
      c.env.JOBS_Q.send({ type: "media-backfill", key }),
    );
    return c.body(null, 404);
  }

  if (!("body" in obj)) {
    // onlyIf matched -- the caller already has the current bytes.
    return new Response(null, { status: 304, headers: { etag: obj.httpEtag } });
  }

  const h = new Headers();
  obj.writeHttpMetadata(h); // contentType + cacheControl from the object
  h.set("etag", obj.httpEtag);
  h.set("cache-tag", `media, media-${c.req.param("slug")}`);
  return new Response(obj.body, { headers: h }); // STREAMED -- never buffered
}
