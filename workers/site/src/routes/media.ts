import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types";

// PLAN.md §3.7 "Media routes — PlacePhoto and the three families that were
// missing". Explicitly called out as "the safest possible first thing to
// ship": keyed by URL path (not place_id), so serving a request is a single
// env.MEDIA.get() with no D1 dependency and no lookup.
//
// favicon.png/donationpoint favicon.png are NOT here -- they don't go
// through R2 at all. Google's favicon service (unlike Static Maps/Places/
// Browser Rendering) is free and keyless, so there's no billed-API-call
// reason to keep it out of the request path; routes/wfbn/favicon.ts fetches
// live and caches the response with the Workers Cache API instead. See
// that file's own comment for the full reasoning.
//
// NOTE: registration order matters. The two-segment location route is the
// most general and MUST come after the donationpoint route -- exactly as in
// gfwfbn/urls/generic.py:12-17 -- or /at/:slug/donationpoint/:dp/photo.jpg
// would be swallowed by /at/:slug/:loc/photo.jpg with loc="donationpoint".
export const mediaApp = new Hono<AppEnv>();

mediaApp.get("/at/:slug/photo.jpg", serveMedia);
mediaApp.get("/at/:slug/screenshots/:page{.+\\.png}", serveMedia);
mediaApp.get("/at/:slug/donationpoint/:dp/photo.jpg", serveMedia);
mediaApp.get("/at/:slug/:loc/photo.jpg", serveMedia);

// Map routes are inside i18n_patterns in Django (one URL, not per-language,
// but reached with a language prefix stripped by resolveLanguage upstream --
// see routes/wfbn.ts once it is built). Registered here too since they share
// serveMedia's R2-key-by-path design.
mediaApp.get("/at/:slug/map.png", serveMedia);
mediaApp.get("/at/:slug/maps/:size{[0-9]+}.png", serveMedia);
mediaApp.get("/at/:slug/:loc/map.png", serveMedia);
mediaApp.get("/at/:slug/:loc/maps/:size{[0-9]+}.png", serveMedia);

// RESIZING: `?s=<width>`, optionally `&f=avif|webp`.
//
// Django emitted `/cdn-cgi/image/width=540,format=avif/needs/at/x/photo.jpg`
// -- Cloudflare's URL-based resizing, sitting in front of the origin. That
// still works in front of a Worker on a Custom Domain (spike run 2026-09-05,
// see PLAN.md §5.1), but it puts a Cloudflare-internal path in front of every
// image URL on the site and it is not ours to reason about. These routes now
// do the transform themselves, so the URL is the resource plus a parameter:
//
//     /needs/at/sid-valley/photo.jpg?s=540&f=avif
//
// givefood/givefood2#2, maintainer decision 2026-09-05.
//
// WIDTHS ARE ALLOWLISTED, and an unrecognised value is a 400 rather than a
// silent full-size response. Two reasons: an arbitrary `?s=` is an unbounded
// number of billed unique transformations that anyone can mint by editing a
// URL, and Django's own foodbank_map() does exactly this
// (gfwfbn/views.py:440-446, HttpResponseBadRequest on a size outside
// MAP_SIZE_CONFIG). The four values are the ones the templates actually ask
// for.
//
// FORMAT IS EXPLICIT, not negotiated from Accept. The <picture> elements
// already name the format per <source>, which is what Django did; and an
// Accept-negotiated response would need `Vary: Accept` to be cached
// correctly, which Cloudflare's cache does not honour for images unless the
// zone-level "Vary for images" setting is on. Getting that wrong serves AVIF
// to a browser that cannot decode it, from cache, for as long as the object
// lives. Format in the URL keeps the cache key honest.
// MECHANISM: `fetch(src, { cf: { image: {...} } })`, NOT the Images binding.
// The binding is the tidier API and needs no subrequest, but this account
// gets "IMAGES_TRANSFORM_ERROR 9432: Bad request: The Images Binding is not
// available using legacy billing" from every call. `cf.image` is the same
// transformation engine reached the old way and works today -- it is what
// `/cdn-cgi/image/` was using all along. Switch to `env.IMAGES` (kept bound
// in wrangler.jsonc) if the Images plan is ever moved off legacy billing.
const VARIANT_WIDTHS = new Set([150, 300, 540, 1080]);
const VARIANT_FORMATS = new Set(["avif", "webp", "jpeg", "png"]);

interface Variant {
  width: number;
  format: string | null;
}

// Returns null for "no resize asked for", "bad" for a request to reject.
function parseVariant(url: URL): Variant | null | "bad" {
  const s = url.searchParams.get("s");
  const f = url.searchParams.get("f");
  if (s === null) return f === null ? null : "bad"; // ?f= without ?s= means nothing

  const width = Number(s);
  if (!Number.isInteger(width) || !VARIANT_WIDTHS.has(width)) return "bad";

  if (f === null) return { width, format: null };
  if (!VARIANT_FORMATS.has(f)) return "bad";
  return { width, format: f };
}

// The marker serveVariant() puts on its own subrequest. Checked before
// anything else so a subrequest is always answered with the stored object,
// never re-entered into the transform branch.
const RAW_PARAM = "__raw";

async function serveMedia(c: Context<AppEnv>) {
  const url = new URL(c.req.url);

  const variant = url.searchParams.has(RAW_PARAM) ? null : parseVariant(url);
  if (variant === "bad") {
    return c.text(`Unsupported image variant. ?s= must be one of ${[...VARIANT_WIDTHS].join(", ")}; ?f= is optional and must be one of ${[...VARIANT_FORMATS].join(", ")}.`, 400);
  }

  // NORMALISE ?size= AWAY. photo_from_place_id() (givefood/utils/geo.py:107)
  // only honours it on the very first Google fetch; for a stored photo it is
  // ignored. Keeping it in the cache key fragments the cache on a parameter
  // that changes nothing. `?s=`/`?f=` are deliberately NOT in the key either:
  // there is one stored object per path and every variant is derived from it.
  const key = "media" + url.pathname;

  if (variant) return serveVariant(c, variant);

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

// The `?s=` path. Separate from the branch above rather than folded into it
// because almost every decision differs: it does not read from R2 at all, it
// cannot honour Range, and its ETag is not the stored object's.
//
// The transform is `fetch(<this same URL, marked raw>, {cf:{image}})`. The
// subrequest goes back out to our own hostname and lands on the branch above,
// which streams the stored object -- so the source bytes reach the
// transformer without this Worker ever buffering them, and R2 is read exactly
// once per miss either way.
//
// RAW_PARAM IS WHAT STOPS THAT BEING A LOOP. serveMedia() checks it before
// parseVariant(), so the subrequest can never itself take this branch and
// recurse, whether or not Cloudflare re-runs Workers on a resizing
// subrequest. Error 9403 is precisely this loop, and a guard that does not
// depend on undocumented behaviour is worth one query parameter.
async function serveVariant(c: Context<AppEnv>, variant: Variant): Promise<Response> {
  const src = new URL(c.req.url);
  src.search = "";
  src.searchParams.set(RAW_PARAM, "1");

  const image: Record<string, string | number> = { width: variant.width, fit: "scale-down" };
  if (variant.format) image.format = variant.format;

  const res = await fetch(src.toString(), { cf: { image } } as RequestInit);

  // A 404 from the source is a real 404 -- and the branch above has already
  // enqueued the backfill on its way to producing it, so there is nothing
  // extra to do here.
  if (!res.ok) {
    if (res.status === 404) return c.body(null, 404);
    // Any other failure (an undecodable source, a transform error) is better
    // answered with the original than with a broken <img>: correct pixels,
    // wrong size. Fetch it without the cf.image option.
    console.error("media: transform failed, serving original", src.pathname, res.status);
    return fetch(src.toString());
  }

  const h = new Headers(res.headers);
  // The resizing service already returns its own ETag, and it does vary it
  // per transform (verified: ?s=150 and ?s=300 come back with different
  // ones). The variant is appended anyway so that the guarantee is ours
  // rather than an observed behaviour of someone else's service -- two
  // variants of one photo must never be interchangeable to a cache, and this
  // costs a dozen bytes.
  const sourceEtag = res.headers.get("etag")?.replace(/^W\//, "").replace(/"/g, "") ?? "0";
  h.set("etag", `"${sourceEtag}-${variant.width}-${variant.format ?? "orig"}"`);
  h.set("cache-tag", `media, media-${c.req.param("slug")}`);
  // A derived variant has no cacheControl of its own. Immutable for a given
  // ETag, and the ETag moves when the photo does.
  h.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(res.body, { status: 200, headers: h });
}
