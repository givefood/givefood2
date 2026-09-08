import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../index";
import { staticMediaApp } from "./staticMedia";
import type { AppEnv } from "../types";

// routes/staticMedia.ts -- the two static families that are NOT in the
// Workers Assets bundle (PLAN.md WP 1.6): `img/ar/**` (27 MB of annual-report
// media, including the 11 MB `ar/2025/androidapp.mp4` that public/ar/2025.njk
// puts in a <video>) and `img/appscreenshots/**` (2 MB, four PNGs linked from
// public/apps.njk). Everything else under /static/* is served asset-first by
// the Assets binding and never reaches this Worker at all.
//
// WHY THIS FILE EXISTS. Nothing here renders, so nothing here fails visibly.
// The three things that can go wrong all produce a plausible-looking response:
//
//   * THE R2 KEY. It is derived from the request path, and the mount prefix
//     ("/static") is part of that path rather than stripped from it -- the
//     file's own comment records that prepending "static" again "duplicated
//     the segment and made every R2 key here a guaranteed miss". A wrong key
//     is not an error; it is a 404 with an empty body on the annual report's
//     images, which no test that only seeds the key the handler asks for can
//     ever catch. So the key is asserted directly (the bucket records what it
//     was asked for), AND objects are seeded under the WRONG keys -- with the
//     "static/" segment missing, and with it doubled -- and asserted to 404.
//   * THE RANGE ARITHMETIC. `content-range` and `content-length` are computed
//     by hand from R2's R2Range. Off-by-one there is invisible on an <img>
//     (browsers do not range-request images) and fatal on the 11 MB mp4 the
//     whole R2 excursion exists for: a video element seeks by asking for a
//     byte range, and a range whose header disagrees with the bytes on the
//     wire stalls the player rather than erroring.
//   * THE 304 BRANCH. It is reached whenever R2 hands back an object with no
//     body -- which, as measured below, is EVERY failed precondition and not
//     just If-None-Match.
//
// REAL EVERYTHING that can be real: the real production app from ../index
// (so the real router, the real /static mount, the real middleware chain and
// the real app.notFound()), driven with real Requests. Only the R2 bucket is
// a double, because a node-environment vitest run has no R2 -- see the block
// above FakeStaticMedia for how its behaviour was pinned down rather than
// guessed, and for exactly what was and was not verified.
//
// MUTATION-TESTED against a copy of the whole repo in a scratchpad outside
// it (TESTING.md's convention; never by editing a file under src/).
// Twenty-nine mutants, every one of them failed this file. Widened to
// index.ts as well as staticMedia.ts, since the mount point is half of the
// key rule. The kills worth naming, because each one leaves a green-looking
// site: `url.pathname.slice(1)` changed to `"static" + url.pathname`, to
// `url.pathname`, and to include the query string; the 206's `end` computed
// as `start + length`; `content-range`'s total off by one; the 206's
// `content-length` left as the object's full size; either half of the
// `rangeHeader && obj.range` guard dropped; the suffix and offset branches
// swapped; `r.offset ?? 0` defaulted to 1; `r.length ?? total - start`
// defaulted to `total`; the 304 branch made unreachable, stripped of its
// etag, or given the 200's headers; `accept-ranges`, `etag`, `content-length`
// and `writeHttpMetadata` each dropped from the 200; `onlyIf` and `range`
// each dropped from the R2 get; the 404 turned into a 200 and given a
// Cache-Control; the appscreenshots route unregistered; the ar route widened
// to `/*`; a POST registration added; and index.ts's mount moved to
// "/statics" and to the site root.

const ORIGIN = "https://www.givefood.org.uk";

// ---------------------------------------------------------------------------
// The R2 double
// ---------------------------------------------------------------------------
//
// PROVENANCE, because a double that invents its own semantics would make
// every assertion below a statement about this file rather than about the
// handler. The behaviour encoded here was READ OFF workerd's own R2
// implementation -- miniflare 5.20260903.0-alpha driving workerd
// 1.20260903.1, i.e. the R2 that `wrangler dev` runs -- by a script in a
// scratchpad outside the repo that put a 1,000-byte object into a real
// bucket and called `get()` with the same `{ range: headers, onlyIf: headers }`
// shape this route uses. What that measured, on 2026-09-08:
//
//   Range: bytes=0-99      -> { offset: 0,   length: 100 }
//   Range: bytes=100-      -> { offset: 100, length: 900 }
//   Range: bytes=-100      -> { offset: 900, length: 100 }   <- NORMALISED
//   Range: bytes=-5000     -> { offset: 0,   length: 1000 }
//   Range: bytes=0-99999   -> { offset: 0,   length: 1000 }
//   Range: bytes=2000-3000 -> { offset: 0,   length: 1000 }
//   Range: bytes=abc       -> { offset: 0,   length: 1000 }
//   Range: bytes=0-99, 200-299 -> { offset: 0, length: 1000 }
//   (no Range header)      -> { offset: 0,   length: 1000 }
//   If-None-Match: <etag> | "*" | W/<etag>  -> object WITHOUT a body
//   If-Match: "nope"                        -> object WITHOUT a body
//   If-Unmodified-Since: <before upload>    -> object WITHOUT a body
//   httpEtag                                -> md5 of the content, quoted
//
// Two of those are load-bearing surprises, and both are why this file asserts
// what it does rather than what the module's comments predict:
//
//   1. `obj.range` is ALWAYS populated -- even on a plain GET with no Range
//      header at all. The handler's comment says it "is only present when the
//      request actually carried a Range header", which is why the guard reads
//      `rangeHeader && obj.range`; on this R2 the second half is always true
//      and the first half is the whole guard.
//   2. An unsatisfiable or malformed Range is NOT reported by omitting
//      `range`; it comes back as the full extent. The handler therefore
//      answers 206, not the 200 its comment predicts. Pinned below, flagged
//      as suspect, NOT "fixed" here.
//
// NOT VERIFIED: production R2. This machine has no network access to it and
// the local implementation is a simulator, so where the two differ these
// tests describe workerd's. Every assertion that depends on a shape workerd
// produced is marked; the ones that depend on a shape it never produced (the
// `suffix` R2Range) are marked more loudly still.

interface StoredObject {
  bytes: Uint8Array;
  httpMetadata?: R2HTTPMetadata;
  uploaded: Date;
}

interface GetCall {
  key: string;
  range: string | null;
  ifNoneMatch: string | null;
}

// R2's etag for a single-part upload is the md5 of the content, and httpEtag
// is that wrapped in double quotes. Verified against workerd: the same
// 1,000-byte object produced "cbecbdb0fdd5cec1e242493b6008cc79" there and
// from node's md5 here, and the 3-byte one "5289df737df57326fcdd22597afb1fac"
// in both. Computed rather than hardcoded so the etag assertions below are
// about the handler echoing R2's value, not about a constant agreeing with
// itself.
function md5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

// workerd's Range parsing, as measured above. Returns the object's full
// extent for anything it cannot satisfy -- which is the behaviour the 206
// tests below hinge on.
function parseRange(header: string | null, size: number): R2Range {
  const whole: R2Range = { offset: 0, length: size };
  if (header === null) return whole;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return whole;
  const [, rawStart = "", rawEnd = ""] = m;

  if (rawStart === "") {
    // "bytes=-n": the last n bytes. n >= size (and n === 0) is unsatisfiable
    // as written and comes back as the whole object.
    const suffix = Number(rawEnd);
    if (rawEnd === "" || suffix === 0 || suffix >= size) return whole;
    return { offset: size - suffix, length: suffix };
  }

  const start = Number(rawStart);
  if (start >= size) return whole; // entirely past the end
  if (rawEnd === "") return { offset: start, length: size - start };
  const end = Math.min(Number(rawEnd), size - 1);
  if (end < start) return whole;
  return { offset: start, length: end - start + 1 };
}

// The conditional evaluation R2 does when `onlyIf` is a Headers object. A
// FAILED precondition of ANY kind produces an R2Object with no body -- there
// is no separate "precondition failed" signal for the caller to distinguish,
// which is the root of the If-Match finding below.
function conditionFails(headers: Headers, etag: string, uploaded: Date): boolean {
  const strip = (v: string) => v.trim().replace(/^W\//, "").replace(/"/g, "");

  const inm = headers.get("If-None-Match");
  if (inm !== null) {
    const matches = inm.split(",").some((v) => strip(v) === "*" || strip(v) === etag);
    if (matches) return true;
  }

  const im = headers.get("If-Match");
  if (im !== null) {
    const matches = im.split(",").some((v) => strip(v) === "*" || strip(v) === etag);
    if (!matches) return true;
  }

  // Seconds resolution: HTTP dates carry no sub-second component.
  const uploadedSec = Math.floor(uploaded.getTime() / 1000) * 1000;

  const ims = headers.get("If-Modified-Since");
  if (ims !== null) {
    const since = Date.parse(ims);
    if (!Number.isNaN(since) && uploadedSec <= since) return true;
  }

  const ius = headers.get("If-Unmodified-Since");
  if (ius !== null) {
    const until = Date.parse(ius);
    if (!Number.isNaN(until) && uploadedSec > until) return true;
  }

  return false;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const UPLOADED = new Date("2026-09-05T12:00:00.000Z");

class FakeStaticMedia {
  // Every get() the handler made, in order: the key it asked for and the two
  // headers it forwarded. "Was R2 consulted at all, and with what key" is the
  // question a body-only assertion cannot answer.
  readonly gets: GetCall[] = [];
  private readonly objects = new Map<string, StoredObject>();

  // Overrides the R2Range the bucket reports, WITHOUT changing which bytes it
  // returns. Used only by the tests that exercise R2Range shapes workerd's own
  // Range parser never emits -- see "R2Range shapes this R2 never produces".
  forceRange: R2Range | null = null;

  // Omits `range` from the returned object entirely -- the shape the handler's
  // own comment describes and workerd's R2 never actually produces. Same
  // section, same caveat.
  reportNoRange = false;

  put(key: string, bytes: Uint8Array, httpMetadata?: R2HTTPMetadata): void {
    this.objects.set(key, { bytes, httpMetadata, uploaded: UPLOADED });
  }

  async get(key: string, options?: R2GetOptions): Promise<unknown> {
    const range = options?.range instanceof Headers ? options.range.get("Range") : null;
    const onlyIf = options?.onlyIf instanceof Headers ? options.onlyIf : new Headers();
    this.gets.push({ key, range, ifNoneMatch: onlyIf.get("If-None-Match") });

    const stored = this.objects.get(key);
    if (!stored) return null;

    const etag = md5(stored.bytes);
    const size = stored.bytes.byteLength;
    const meta = stored.httpMetadata;
    const reported: R2Range | null = this.reportNoRange ? null : (this.forceRange ?? parseRange(range, size));
    const base = {
      key,
      size,
      etag,
      httpEtag: `"${etag}"`,
      uploaded: stored.uploaded,
      ...(reported ? { range: reported } : {}),
      writeHttpMetadata(headers: Headers): void {
        if (meta?.contentType) headers.set("content-type", meta.contentType);
        if (meta?.contentLanguage) headers.set("content-language", meta.contentLanguage);
        if (meta?.contentDisposition) headers.set("content-disposition", meta.contentDisposition);
        if (meta?.contentEncoding) headers.set("content-encoding", meta.contentEncoding);
        if (meta?.cacheControl) headers.set("cache-control", meta.cacheControl);
      },
    };

    // The 304 shape. A separate object literal rather than `body: undefined`,
    // because the handler branches on `"body" in obj` -- an own property set
    // to undefined would still satisfy `in` and take the wrong branch.
    if (conditionFails(onlyIf, etag, stored.uploaded)) return base;

    // The bytes must agree with the range the object claims, or the tests
    // would be asserting against a self-contradictory response.
    if (reported === null) return { ...base, body: streamOf(stored.bytes) };
    const offset = "suffix" in reported ? size - reported.suffix : (reported.offset ?? 0);
    const length = "suffix" in reported ? reported.suffix : (reported.length ?? size - offset);
    const slice = stored.bytes.subarray(Math.max(0, offset), Math.max(0, offset) + length);
    return { ...base, body: streamOf(slice) };
  }
}

// ---------------------------------------------------------------------------
// Fixtures -- real URLs from the real templates
// ---------------------------------------------------------------------------
//
// public/ar/2025.njk:131 is `<video src="/static/img/ar/2025/androidapp.mp4">`
// and public/apps.njk:27-30 link the four appscreenshots PNGs. Using the URLs
// the site actually emits means a route registration that stops matching them
// fails here rather than in production.
const MP4_KEY = "static/img/ar/2025/androidapp.mp4";
const MP4_PATH = "/static/img/ar/2025/androidapp.mp4";
const PNG_KEY = "static/img/appscreenshots/2.png";
const PNG_PATH = "/static/img/appscreenshots/2.png";

// 1,000 bytes of a recognisable pattern, so a slice can be checked against the
// offset it claims to start at rather than merely counted.
const MP4_BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
const MP4_ETAG = `"${md5(MP4_BYTES)}"`;
const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

// What `wrangler r2 object put` would have stored for these two: the module's
// own comment says "contentType + cacheControl set at PUT time".
const MP4_META: R2HTTPMetadata = { contentType: "video/mp4", cacheControl: "public, max-age=31536000, immutable" };
const PNG_META: R2HTTPMetadata = { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" };

let bucket: FakeStaticMedia;

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// Only STATIC_MEDIA is populated. That is deliberate: if a change ever puts a
// D1 query, a KV read or a queue send on this path, it throws here instead of
// passing quietly -- these two families must cost exactly one R2 GET.
function env(): AppEnv["Bindings"] {
  return { STATIC_MEDIA: bucket } as unknown as AppEnv["Bindings"];
}

// `async` because Hono's fetch is typed `Response | Promise<Response>` and
// every caller here awaits it anyway.
async function fetchStatic(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
}

beforeEach(() => {
  bucket = new FakeStaticMedia();
  bucket.put(MP4_KEY, MP4_BYTES, MP4_META);
  bucket.put(PNG_KEY, PNG_BYTES, PNG_META);
});

// ---------------------------------------------------------------------------
// The R2 key
// ---------------------------------------------------------------------------

describe("staticMediaApp: the R2 key", () => {
  // THE BUG THE MODULE DOCUMENTS. Hono does not strip a `.route()` prefix from
  // the request's own URL, so `url.pathname` still carries "/static" and the
  // key is the path minus its leading slash. Prepending "static" again -- the
  // obvious-looking fix if you assume Hono strips the mount -- yields
  // "static/static/img/..." and a guaranteed miss on every object.
  it("asks R2 for the request path minus its leading slash, mount prefix included", async () => {
    const res = await fetchStatic(MP4_PATH);

    expect(res.status).toBe(200);
    expect(bucket.gets.map((g) => g.key)).toEqual([MP4_KEY]);
    expect(bucket.gets[0]?.key).toBe("static/img/ar/2025/androidapp.mp4");
  });

  it("uses the same rule for the appscreenshots family", async () => {
    const res = await fetchStatic(PNG_PATH);

    expect(res.status).toBe(200);
    expect(bucket.gets.map((g) => g.key)).toEqual(["static/img/appscreenshots/2.png"]);
  });

  // The negative half of the two tests above, and the reason they are not just
  // decoration: a handler that dropped the "static/" segment, or doubled it,
  // still asks R2 for SOMETHING, and a fixture seeded only at the correct key
  // cannot tell the difference between "asked for the right key" and "asked
  // for a key that happens to miss". These objects exist and must not be
  // served.
  it("does not serve an object stored at the path without the static/ segment", async () => {
    bucket = new FakeStaticMedia(); // ONLY the wrong key exists
    bucket.put("img/ar/2025/androidapp.mp4", MP4_BYTES, MP4_META);

    const res = await fetchStatic(MP4_PATH);

    expect(res.status).toBe(404);
    expect(bucket.gets.map((g) => g.key)).toEqual([MP4_KEY]);
  });

  it("does not serve an object stored with the static/ segment doubled", async () => {
    bucket = new FakeStaticMedia();
    bucket.put(`static/${MP4_KEY}`, MP4_BYTES, MP4_META);

    const res = await fetchStatic(MP4_PATH);

    expect(res.status).toBe(404);
    expect(bucket.gets.map((g) => g.key)).toEqual([MP4_KEY]);
  });

  // Cache-busting query strings are ordinary on static URLs (`?v=3` after a
  // redeploy). The key is built from `url.pathname` alone, so they cost
  // nothing; a key built from the full URL would 404 on every one of them.
  it("ignores the query string when building the key", async () => {
    const res = await fetchStatic(`${MP4_PATH}?v=3&cachebust=1`);

    expect(res.status).toBe(200);
    expect(bucket.gets.map((g) => g.key)).toEqual([MP4_KEY]);
  });

  // Percent-encoding is NOT decoded: `url.pathname` is the raw path, so the
  // key handed to R2 is the escaped form. That is the safe direction -- an
  // encoded "../" cannot become a real path segment on the way to R2, and R2
  // keys are opaque strings with no traversal semantics of their own -- but it
  // does mean an object whose name contains a space must be uploaded under the
  // %20 spelling to be reachable. Pinned because it is a silent 404 either way
  // round.
  it("passes the path to R2 percent-encoded, without decoding it", async () => {
    bucket.put("static/img/ar/2024/annual%20report.png", PNG_BYTES, PNG_META);

    const encoded = await fetchStatic("/static/img/ar/2024/annual%20report.png");
    expect(encoded.status).toBe(200);
    expect(bucket.gets.map((g) => g.key)).toEqual(["static/img/ar/2024/annual%20report.png"]);
  });

  // Nothing in the handler sanitises the path before it becomes an R2 key, so
  // "can this be walked out of its two prefixes?" is a fair question. It
  // cannot, for two different reasons, and both are worth holding still:
  //
  //   * The WHATWG URL parser resolves dot segments -- INCLUDING their
  //     percent-encoded spellings -- while parsing, so "/static/img/ar/%2e%2e/
  //     %2e%2e/secrets.txt" is already "/static/secrets.txt" by the time Hono
  //     routes it. It therefore matches neither pattern and R2 is never asked.
  //     (Checked directly in node: `new URL()` gives "/static/secrets.txt" for
  //     both the literal and the encoded form.)
  //   * An encoded SLASH is not decoded, so "..%2f.." survives as one opaque
  //     segment -- which is harmless, because an R2 key is a flat string with
  //     no traversal semantics: it addresses an object literally named that.
  it("cannot be walked out of its prefix: dot segments are resolved before routing", async () => {
    const res = await fetchStatic("/static/img/ar/%2e%2e/%2e%2e/secrets.txt");

    expect(res.status).toBe(404);
    expect(bucket.gets).toEqual([]);
  });

  it("turns an encoded-slash traversal into a literal key inside the prefix", async () => {
    const res = await fetchStatic("/static/img/ar/..%2f..%2fsecrets.txt");

    expect(res.status).toBe(404);
    expect(bucket.gets.map((g) => g.key)).toEqual(["static/img/ar/..%2f..%2fsecrets.txt"]);
  });

  // The exported sub-app is mounted at "/static" by index.ts, and the key rule
  // above is only correct BECAUSE of that mount. Driving the sub-app on its
  // own -- the way a future refactor might mount it somewhere else, or none --
  // shows the dependency explicitly: the key follows the URL, so a different
  // mount point silently changes every key.
  it("derives the key from the URL, so the mount point in index.ts is part of the contract", async () => {
    bucket.put("img/ar/2025/androidapp.mp4", MP4_BYTES, MP4_META);

    const res = await staticMediaApp.fetch(new Request(`${ORIGIN}/img/ar/2025/androidapp.mp4`), env(), execCtx);

    expect(res.status).toBe(200);
    expect(bucket.gets.map((g) => g.key)).toEqual(["img/ar/2025/androidapp.mp4"]);
  });
});

// ---------------------------------------------------------------------------
// Which URLs reach this code at all
// ---------------------------------------------------------------------------

describe("staticMediaApp: routing", () => {
  // The whole design rests on this Worker seeing only what the Assets binding
  // could not serve. If a pattern here widened to "/static/*", every CSS,
  // JS and font request on the site would take an R2 round trip on a key that
  // does not exist -- 404ing assets that the binding serves perfectly well
  // today. Asserting `bucket.gets` is empty is the only way to see that: the
  // status code is 404 either way.
  it("never touches R2 for a /static/ path outside the two families", async () => {
    for (const path of ["/static/css/bulma.min.css", "/static/js/echarts.js", "/static/img/map.png", "/static/img/manifestscreens/1.png"]) {
      const res = await fetchStatic(path);
      expect(res.status).toBe(404);
    }

    expect(bucket.gets).toEqual([]);
  });

  // "img/ar" is a path SEGMENT, not a string prefix. Hono's "/img/ar/*"
  // matches on the "/" that follows, so a directory that merely starts with
  // the same two letters is not swallowed.
  it("matches ar/ as a whole segment, not as a prefix", async () => {
    const res = await fetchStatic("/static/img/argentina/flag.png");

    expect(res.status).toBe(404);
    expect(bucket.gets).toEqual([]);
  });

  it("is case-sensitive, matching R2 keys and the Assets binding", async () => {
    const res = await fetchStatic("/static/img/AR/2025/androidapp.mp4");

    expect(res.status).toBe(404);
    expect(bucket.gets).toEqual([]);
  });

  // A path deeper than the two segments the fixtures use: the wildcard spans
  // every remaining segment, which is what `img/ar/2025/...` needs.
  it("serves any depth under the two prefixes", async () => {
    bucket.put("static/img/ar/2021/charts/a/b/c.png", PNG_BYTES, PNG_META);

    const res = await fetchStatic("/static/img/ar/2021/charts/a/b/c.png");

    expect(res.status).toBe(200);
    expect(bucket.gets.map((g) => g.key)).toEqual(["static/img/ar/2021/charts/a/b/c.png"]);
  });

  // GET-only. Both routes are registered with `.get()`, so anything else falls
  // through to app.notFound() -- which is what stops this route family from
  // being an unauthenticated write surface onto the bucket, and equally stops
  // a client from spending an R2 operation with a method R2 will not honour.
  it("answers only GET and HEAD; other methods never reach R2", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetchStatic(MP4_PATH, { method });
      expect(res.status).toBe(404);
    }

    expect(bucket.gets).toEqual([]);
  });

  // Hono dispatches HEAD through the GET handler and drops the body, so the
  // headers a player needs before it starts streaming -- content-length,
  // accept-ranges -- are all there. A <video> element issues exactly this
  // request before its first range request.
  it("answers HEAD with the GET headers and no body", async () => {
    const res = await fetchStatic(MP4_PATH, { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1000");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await res.text()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// A hit
// ---------------------------------------------------------------------------

describe("staticMediaApp: a stored object", () => {
  it("streams the exact bytes with the metadata stored at PUT time", async () => {
    const res = await fetchStatic(MP4_PATH);
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(body).toEqual(MP4_BYTES);
    // writeHttpMetadata is where content-type and cache-control come from --
    // the handler sets neither itself. Drop that call and the mp4 goes out as
    // an untyped octet stream with no cache directive, which a browser will
    // download instead of play.
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe(MP4_ETAG);
    // Without accept-ranges a video element will not offer seeking at all,
    // which is the one capability this whole route exists to provide.
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("1000");
    expect(res.headers.get("content-range")).toBeNull();
  });

  // Django served /static/ through WhiteNoise with WHITENOISE_MAX_AGE set to
  // a year (givefood/settings.py:270), so every one of these files carried
  // `max-age=31536000` there. Here that header exists only if it was set on
  // the object at upload time: an object put without `--cache-control` gets
  // NO Cache-Control at all -- middleware/pageCacheControl.ts fills gaps only
  // for HTML, RSS and markdown, so nothing downstream supplies one either.
  // That is a real difference from Django's behaviour and it is invisible
  // until someone reads a cf-cache-status header, so it is pinned rather than
  // assumed.
  it("emits no Cache-Control when the object was uploaded without one", async () => {
    bucket.put("static/img/appscreenshots/1.png", PNG_BYTES);

    const res = await fetchStatic("/static/img/appscreenshots/1.png");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("content-type")).toBeNull();
    expect(res.headers.get("etag")).toBe(`"${md5(PNG_BYTES)}"`);
    expect(res.headers.get("content-length")).toBe("8");
  });

  // routes/media.ts stamps `cache-tag: media, media-<slug>` on its R2
  // responses so queues/cachePurge.ts can invalidate one food bank's photo.
  // Nothing does that here, and middleware/cacheTag.ts's path rules do not
  // cover /static -- so a re-uploaded annual-report image cannot be purged by
  // tag and will sit at the edge until its TTL expires. Deliberate (these
  // files are immutable in practice) but worth failing loudly if it ever
  // changes by accident in either direction.
  it("carries no Cache-Tag, so these objects are not purgeable by tag", async () => {
    const res = await fetchStatic(MP4_PATH);

    expect(res.headers.get("cache-tag")).toBeNull();
  });

  // The response is built with `new Response(...)` rather than a Hono helper,
  // which is exactly the shape middleware that writes to `c.res` can miss.
  // securityHeaders and resolveLanguage both run after it; if either stopped
  // applying to hand-built responses, a scanner would flag the missing
  // nosniff on launch day and nothing else would.
  it("still gets the global middleware's headers despite being a hand-built Response", async () => {
    const res = await fetchStatic(MP4_PATH);

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("content-language")).toBe("en");
    expect(res.headers.get("server-timing")).toMatch(/^render;dur=\d+(\.\d+)?$/);
  });
});

// ---------------------------------------------------------------------------
// A miss
// ---------------------------------------------------------------------------

describe("staticMediaApp: a missing object", () => {
  // `c.body(null, 404)` -- an EMPTY 404, not the site's rendered 404 page.
  // Worth pinning both ways round: this route is reached only for the two
  // families, so a miss here means "that annual-report file was never
  // uploaded", and the empty body is what distinguishes it in a log from an
  // ordinary unrouted URL.
  it("returns an empty 404, not the rendered 404 page", async () => {
    const res = await fetchStatic("/static/img/ar/2025/never-uploaded.png");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(bucket.gets.map((g) => g.key)).toEqual(["static/img/ar/2025/never-uploaded.png"]);
  });

  it("answers an unrouted /static/ path with the site's rendered 404 page instead", async () => {
    const res = await fetchStatic("/static/img/nope/nope.png");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("<html");
  });

  // routes/media.ts deliberately sets `cache-control: public, max-age=10` on
  // its 404s, because a miss there means "queued for backfill, try again in a
  // few seconds" and a cached 404 defeats the backfill entirely. This route
  // has no backfill -- objects arrive by `wrangler r2 object put` -- and sets
  // nothing, so the 404 takes the zone default. Pinned so the difference
  // between the two routes stays a decision rather than an oversight.
  it("sets no Cache-Control on the 404", async () => {
    const res = await fetchStatic("/static/img/ar/2025/never-uploaded.png");

    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("404s a ranged request for a missing object rather than 206ing it", async () => {
    const res = await fetchStatic("/static/img/ar/2025/never-uploaded.mp4", { headers: { Range: "bytes=0-99" } });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-range")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Conditional requests
// ---------------------------------------------------------------------------

describe("staticMediaApp: conditional requests", () => {
  // The whole point of the 304 branch: an 11 MB mp4 that a returning visitor
  // already has must not be re-sent. The handler passes the request's own
  // headers straight to R2 as `onlyIf`, so R2 does the comparison and signals
  // the match by returning an object with no body.
  it("answers If-None-Match on the current etag with a bodiless 304", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { "If-None-Match": MP4_ETAG } });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    // The etag must be echoed: a 304 without one gives the client nothing to
    // revalidate against next time, and some caches treat it as a reason to
    // drop the stored entry.
    expect(res.headers.get("etag")).toBe(MP4_ETAG);
    // The header goes to R2 VERBATIM. routes/media.ts does the opposite --
    // it reads If-None-Match itself and hands R2 a built R2Conditional with
    // the W/ prefix and quotes stripped -- so the two routes' 304s are
    // reached by genuinely different mechanisms and a change to one says
    // nothing about the other.
    expect(bucket.gets.map((g) => g.ifNoneMatch)).toEqual([MP4_ETAG]);
  });

  // What the 304 deliberately does NOT carry. `new Response(null, {status:
  // 304, headers: { etag }})` is built from scratch rather than from `h`, so
  // none of the 200's headers survive. Pinned because a content-length on a
  // bodiless 304 is a protocol error some clients act on, and because a future
  // "tidy-up" that reuses `h` here would introduce exactly that.
  it("sends nothing but the etag on a 304", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { "If-None-Match": MP4_ETAG } });

    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-type")).toBeNull();
    expect(res.headers.get("accept-ranges")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("serves the full object when If-None-Match does not match", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { "If-None-Match": '"0123456789abcdef0123456789abcdef"' } });

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP4_BYTES);
  });

  it("treats If-None-Match: * as a match", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { "If-None-Match": "*" } });

    expect(res.status).toBe(304);
  });

  // A 304 wins over a range request, which is correct: the client is asking
  // "has this changed?" first and "send me these bytes" second.
  it("prefers the 304 over the 206 when a conditional request also carries a Range", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { "If-None-Match": MP4_ETAG, Range: "bytes=0-99" } });

    expect(res.status).toBe(304);
    expect(res.headers.get("content-range")).toBeNull();
  });

  // SUSPECT -- pinned, not fixed (TESTING.md's rule). `onlyIf` is the whole
  // request Headers object, so R2 evaluates If-Match and If-Unmodified-Since
  // too, and signals a FAILED precondition the same way it signals a matched
  // If-None-Match: an object with no body. The handler cannot tell the two
  // apart and answers 304 for both. RFC 9110 §13.1.1 says a failed If-Match
  // is a 412, and 304 is only ever correct for If-None-Match/If-Modified-Since.
  //
  // Nothing on this site sends If-Match to a static file today, which is why
  // it is harmless in practice and why it is asserted rather than repaired
  // here. Reported as a suspected bug.
  it("answers a FAILED If-Match precondition with 304 rather than 412 (suspect)", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { "If-Match": '"0123456789abcdef0123456789abcdef"' } });

    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(MP4_ETAG);
  });

  it("answers a FAILED If-Unmodified-Since the same way (suspect)", async () => {
    // The object was uploaded at 2026-09-05T12:00:00Z; this asks for it only
    // if it has not changed since an hour before that, which it has.
    const res = await fetchStatic(MP4_PATH, { headers: { "If-Unmodified-Since": "Sat, 05 Sep 2026 11:00:00 GMT" } });

    expect(res.status).toBe(304);
  });

  it("serves the object when If-Match does match", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { "If-Match": MP4_ETAG } });

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP4_BYTES);
  });

  it("answers If-Modified-Since after the upload with a 304", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { "If-Modified-Since": "Mon, 07 Sep 2026 00:00:00 GMT" } });

    expect(res.status).toBe(304);
  });
});

// ---------------------------------------------------------------------------
// Range requests -- the reason these two families are in R2 at all
// ---------------------------------------------------------------------------

describe("staticMediaApp: Range requests", () => {
  // The ordinary seek: a <video> asking for a window in the middle of the
  // file. content-range's end is inclusive, so `start + length - 1` -- the
  // classic off-by-one here (`start + length`) makes every response claim one
  // byte more than it sends, which stalls a player mid-stream rather than
  // failing outright.
  it("answers a byte range with 206, an inclusive content-range and the right bytes", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=0-99" } });
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-99/1000");
    expect(res.headers.get("content-length")).toBe("100");
    expect(body.byteLength).toBe(100);
    expect(body).toEqual(MP4_BYTES.subarray(0, 100));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("answers an open-ended range with everything from the offset to the end", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=900-" } });
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect(res.headers.get("content-length")).toBe("100");
    expect(body).toEqual(MP4_BYTES.subarray(900));
  });

  // A one-byte range: the shape a player uses to probe for range support, and
  // the case where an inclusive/exclusive mix-up shows up as length 0 or 2.
  it("answers a single-byte range", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=999-999" } });
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 999-999/1000");
    expect(res.headers.get("content-length")).toBe("1");
    expect(body).toEqual(MP4_BYTES.subarray(999));
  });

  // A suffix range ("the last 100 bytes"). Measured against workerd's R2: it
  // NORMALISES this to { offset: 900, length: 100 } before the handler sees
  // it, so this arrives through the offset/length branch, not the `suffix`
  // one. The response is what matters and is asserted here; the `suffix`
  // branch's own arithmetic is exercised separately below.
  it("answers a suffix range with the tail of the object", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=-100" } });
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect(res.headers.get("content-length")).toBe("100");
    expect(body).toEqual(MP4_BYTES.subarray(900));
  });

  // The stored metadata still applies to a partial response -- a 206 with no
  // content-type is a video a browser will not play.
  it("keeps the object's own content-type, cache-control and etag on a 206", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=10-19" } });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe(MP4_ETAG);
  });

  // SUSPECT -- pinned, not fixed. The handler's own comment says a Range that
  // R2 "can't satisfy, e.g. a malformed one" comes back "with no `range`
  // field, in which case this must stay a 200". Measured against workerd's R2
  // (see the provenance block at the top), that premise does not hold: an
  // unsatisfiable or malformed Range comes back as the FULL extent,
  // { offset: 0, length: size }, and `obj.range` is populated on every get --
  // including a plain GET with no Range header at all.
  //
  // So the response is a 206 claiming `content-range: bytes 0-999/1000` for a
  // request that asked for bytes 2000-3000. RFC 9110 §14.4 says an
  // unsatisfiable range is a 416, and §14.2 says a malformed one must be
  // IGNORED and answered 200. A client that asked to seek past the end is
  // handed the start of the file and told it is a successful partial
  // response, which for a resumed download means a corrupt file.
  //
  // Not reproduced against production R2 -- no network access from here -- so
  // it is possible production reports these differently. Reported as a
  // suspected bug with that caveat.
  it("answers an unsatisfiable range with a 206 over the whole object (suspect)", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=2000-3000" } });
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-999/1000");
    expect(res.headers.get("content-length")).toBe("1000");
    expect(body).toEqual(MP4_BYTES);
  });

  it("answers a malformed Range with a 206 rather than the 200 its comment predicts (suspect)", async () => {
    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=abc" } });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-999/1000");
  });

  it("answers a multi-range request with a 206 over the whole object (suspect)", async () => {
    // Multipart/byteranges is not implemented -- correctly, since R2 collapses
    // the request to the full extent before the handler sees it. But the
    // answer is again a 206 that misdescribes itself rather than a 200.
    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=0-99, 200-299" } });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-999/1000");
  });

  // The `rangeHeader &&` half of the 206 guard is the ONLY half doing any
  // work, precisely because `obj.range` is always populated (above). Drop it
  // and every plain GET on these two families -- every annual-report image on
  // the site -- becomes a 206 with a content-range header, which browsers
  // handle but caches and crawlers treat quite differently.
  it("answers a request with no Range header with a 200, never a 206", async () => {
    const res = await fetchStatic(MP4_PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("content-length")).toBe("1000");
  });
});

// ---------------------------------------------------------------------------
// R2Range shapes this R2 never produces
// ---------------------------------------------------------------------------
//
// The handler codes for three R2Range shapes: { suffix }, { offset, length }
// and a partial { offset } with no length. Driving it through real Range
// headers only ever exercises the middle one, because workerd's R2 normalises
// everything to { offset, length } (measured -- see the provenance block).
//
// The other two are still in the type the binding is declared with, and R2's
// documented R2Range union includes them, so the arithmetic is asserted here
// by forcing the bucket to report those shapes. THESE TESTS DESCRIBE THE
// HANDLER'S ARITHMETIC, NOT AN OBSERVED R2 RESPONSE: production R2 was not
// reachable from this machine, so whether it ever returns a bare { suffix }
// is unverified either way. Without them the `"suffix" in r` branch has no
// coverage at all, and a wrong `start` there would be silent.
describe("staticMediaApp: R2Range shapes the local R2 never returns", () => {
  it("computes start from the end for a { suffix } range", async () => {
    bucket.forceRange = { suffix: 250 };

    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=-250" } });
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 750-999/1000");
    expect(res.headers.get("content-length")).toBe("250");
    expect(body).toEqual(MP4_BYTES.subarray(750));
  });

  it("runs a { offset } range with no length to the end of the object", async () => {
    bucket.forceRange = { offset: 400 };

    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=400-" } });
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 400-999/1000");
    expect(res.headers.get("content-length")).toBe("600");
    expect(body).toEqual(MP4_BYTES.subarray(400));
  });

  it("treats a { length } with no offset as starting at zero", async () => {
    bucket.forceRange = { length: 32 };

    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=0-31" } });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-31/1000");
    expect(res.headers.get("content-length")).toBe("32");
  });

  // The second half of the `rangeHeader && obj.range` guard, isolated: a
  // reported range on a request that carried no Range header must be ignored.
  // Unreachable through real R2 (which reports a range on every get), so it is
  // the guard's intent that is pinned here rather than a live code path.
  it("ignores a reported range when the client sent no Range header", async () => {
    bucket.forceRange = { offset: 100, length: 50 };

    const res = await fetchStatic(MP4_PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("content-length")).toBe("1000");
  });

  // The other half of the same guard, and the premise the handler was written
  // against: "a Range R2 can't satisfy ... returns the full object with no
  // `range` field, in which case this must stay a 200". That shape does not
  // arise on workerd's R2 (which is why the unsatisfiable-range test above
  // gets a 206 instead), but the guard is what makes it safe, and without this
  // test `if (rangeHeader && obj.range)` can be simplified to
  // `if (rangeHeader)` with the whole suite still green -- after which this
  // shape would throw on `"suffix" in undefined` and turn into a 500.
  it("falls back to a full 200 if R2 reports no range at all", async () => {
    bucket.reportNoRange = true;

    const res = await fetchStatic(MP4_PATH, { headers: { Range: "bytes=0-99" } });
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("content-length")).toBe("1000");
    expect(body).toEqual(MP4_BYTES);
  });
});
