import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types";

// PLAN.md WP 1.6: `img/ar/**` (27 MB, incl. an 11 MB mp4) and
// `img/appscreenshots/**` (2 MB) are excluded from the Workers Static
// Assets bundle (dist/static/) and served from R2 instead, with Range
// passthrough -- the annual report video needs seeking, and neither
// family is on the hot path the ~5 MB asset budget is sized around.
//
// Keys mirror the exact static/ URL, e.g. static/img/ar/2025/androidapp.mp4,
// uploaded via `wrangler r2 object put "givefood-static/<key>" --file ...`.
// Registered under /static, so it only sees requests the Workers Assets
// binding already reported "no match" for (dist/static/ has no img/ar/ or
// img/appscreenshots/ tree) -- everything else under /static/* is served
// asset-first and never reaches this Worker code at all.
export const staticMediaApp = new Hono<AppEnv>();

staticMediaApp.get("/img/ar/*", serveStaticMedia);
staticMediaApp.get("/img/appscreenshots/*", serveStaticMedia);

async function serveStaticMedia(c: Context<AppEnv>) {
  const url = new URL(c.req.url);
  // url.pathname is already "/static/img/ar/2025/androidapp.mp4" -- the
  // mount prefix in index.ts ("/static") is the request's real path, not
  // stripped the way it is inside the sub-app's own route matching. Just
  // drop the leading slash; do NOT prepend "static" again (that duplicated
  // the segment and made every R2 key here a guaranteed miss).
  const key = url.pathname.slice(1); // -> static/img/ar/2025/androidapp.mp4

  const rangeHeader = c.req.header("Range");
  const obj = await c.env.STATIC_MEDIA.get(key, {
    range: c.req.raw.headers,
    onlyIf: c.req.raw.headers,
  });

  if (obj === null) {
    return c.body(null, 404);
  }
  if (!("body" in obj)) {
    // Matched onlyIf's condition (If-None-Match / If-Modified-Since): 304.
    return new Response(null, { status: 304, headers: { etag: obj.httpEtag } });
  }

  const h = new Headers();
  obj.writeHttpMetadata(h); // contentType + cacheControl set at PUT time
  h.set("etag", obj.httpEtag);
  h.set("accept-ranges", "bytes");

  // obj.range is only present when the request actually carried a Range
  // header AND R2 honoured it -- a plain GET (or a Range R2 can't satisfy,
  // e.g. a malformed one) returns the full object with no `range` field, in
  // which case this must stay a 200 with the full Content-Length, not a 206.
  if (rangeHeader && obj.range) {
    const total = obj.size;
    const r = obj.range;
    let start: number;
    let length: number;
    if ("suffix" in r) {
      length = r.suffix;
      start = total - length;
    } else {
      start = r.offset ?? 0;
      length = r.length ?? total - start;
    }
    const end = start + length - 1;
    h.set("content-range", `bytes ${start}-${end}/${total}`);
    h.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers: h });
  }

  h.set("content-length", String(obj.size));
  return new Response(obj.body, { headers: h }); // STREAMED -- never buffered
}
