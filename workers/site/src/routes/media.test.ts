import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_TAG, mediaTag } from "@givefood/urls";
import { mediaApp } from "./media";
import type { AppEnv } from "../types";

// routes/media.ts -- every photograph and map PNG on the public site, ported
// from gfwfbn/urls/generic.py:12-17 (photos) and gfwfbn/urls/i18n.py:27-39
// (maps) over gfwfbn/views.py foodbank_photo/foodbank_map and siblings.
//
// WHY A ROUTE-LEVEL SUITE, AND WHY THIS SHAPE. Nothing this module does is
// visible from a page that looks right. Its three failure modes are all
// silent, all cost money or availability, and all have already happened once:
//
//   1. THE CACHED 404. missing() returns `cache-control: public, max-age=10`
//      because a bare 404 took the zone default and was cached at the edge --
//      the module's own comment records `404` with `cf-cache-status: HIT`
//      while the PNG was already sitting in R2. A backfill that lands and is
//      never served is indistinguishable, from the outside, from a backfill
//      that never ran. Several tests below assert that header and nothing
//      else, because the header IS the fix.
//   2. THE KEY THAT NOTHING CONSUMES. The 404 enqueues a media-backfill
//      message keyed by R2 path. workers/jobs' consumers match that key
//      against regexes (mediaBackfill/placePhoto.ts:43-45 and
//      mediaBackfill/mapImage.ts:28-29) and THROW on anything they do not
//      recognise, which is three retries and then jobs-dlq. So every key
//      asserted here is asserted as a literal string against those documented
//      shapes -- a route that enqueues `media/at/...` instead of
//      `media/needs/at/...` would look identical from the browser and fill a
//      dead-letter queue nobody is watching.
//   3. THE UNBOUNDED TRANSFORM. `?s=` is allowlisted because each distinct
//      value is a billed image transformation anyone can mint by editing a
//      URL. A guard that stops working does not fail; it spends.
//
// REAL THINGS, NOT MOCKS:
//   * THE REAL mediaApp, mounted the way index.ts:213 mounts it
//     (`app.route("/needs", mediaApp)`). The mount prefix is not cosmetic --
//     the R2 key is `"media" + url.pathname`, so it is the mount that puts
//     `/needs` in every key, and a suite that mounted the sub-app at the root
//     would assert keys that no consumer accepts.
//   * THE REAL @givefood/urls tag helpers, so "the cache-tag this route
//     stamps is the tag the purge job clears" is a fact about both modules
//     rather than two string literals that happen to agree today.
//   * A LOOPBACK fetch: the resizing subrequest is dispatched straight back
//     into the same app, so `?s=150` genuinely re-enters serveMedia and the
//     `__raw` loop guard is exercised rather than assumed. The loopback
//     counts its own depth and throws, so a removed guard fails as
//     "subrequest loop" instead of hanging the suite.
//
// MOCKED, and only these: R2 (there is no node-side double -- vitest runs in
// the node environment, see vitest.config.mts), the queue, and `fetch` where
// it stands in for Cloudflare's image-resizing service.
//
// MUTATION-TESTED, per TESTING.md's convention: the repo was copied to a
// scratchpad OUTSIDE this tree (source files here were never edited), media.ts
// broken there one change at a time, and this file re-run against each mutant.
// 39 mutants, 2 survivors, both provably equivalent and left alone:
//
//   * `!Number.isInteger(width) ||` deleted from parseVariant. It is dead
//     code: VARIANT_WIDTHS holds four integers, and Set.has uses
//     SameValueZero, so no non-integer and no NaN can be in it anyway. See
//     the note in the rejection block below.
//   * the donationpoint route registered AFTER the two-segment location one,
//     against the module's own "registration order matters" comment. In Hono
//     the two patterns differ in segment count (five against four), so the
//     order genuinely does not decide the match here -- see the resolution
//     test below, which pins the outcome rather than the mechanism.
//
// The 37 that died include: the 404's cache-control widened or dropped; the
// enqueue removed, awaited instead of waitUntil'd, or duplicated onto the
// transform-failure path; the key losing its `media` prefix or gaining the
// query string; the `__raw` guard deleted and (separately) moved after
// parseVariant; each of the three allowlist checks removed; `onlyIf` passed
// as undefined; the weak-validator strip and the quote strip each removed;
// the 304 branch disabled; writeHttpMetadata, etag and cache-tag each dropped;
// the cache-tag keyed on :loc instead of :slug on BOTH branches; `fit`
// changed to cover; the width hardcoded; the format never passed; the
// subrequest keeping its original query or losing its `__raw` marker; the
// variant etag losing its width, its format, its "0" fallback or its
// unwrapping; the variant's immutable cache-control and its `vary` override
// removed; the variant 404's cache-control removed; the `!res.ok` failure
// branch disabled entirely; and the transform-failure fallback returning the
// error instead of refetching, or failing silently.

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ORIGIN = "https://www.givefood.org.uk";

// The commonest of the shapes mediaBackfill/placePhoto.ts documents at the top
// of the file (its FOODBANK_PHOTO_RE), spelled out as both a URL and a key so
// that a change to either end of the contract breaks a test rather than a queue.
const PHOTO_PATH = "/needs/at/salisbury/photo.jpg";
const PHOTO_KEY = "media/needs/at/salisbury/photo.jpg";

interface StoredObject {
  /** the object's bytes, as text so assertions read as strings */
  body: string;
  /** the raw etag, unquoted -- httpEtag adds the quotes, as R2 does */
  etag: string;
  contentType: string;
  cacheControl?: string;
}

/** What R2.get() was asked for. The options are as much the behaviour as the key is. */
interface GetCall {
  key: string;
  onlyIf: unknown;
  /** the Range header on whatever Headers object was handed to R2, or null */
  range: string | null;
}

let media: Map<string, StoredObject>;
let getCalls: GetCall[];

/**
 * R2's read side, modelled only as far as media.ts uses it.
 *
 * The `onlyIf` semantics matter and are R2's, not HTTP's: with
 * `etagDoesNotMatch`, the get SUCCEEDS (body included) when the stored etag is
 * different, and comes back as a bodyless R2Object when it MATCHES. media.ts
 * distinguishes the two with `"body" in obj`, so the bodyless shape here must
 * genuinely lack the property rather than carry an undefined one.
 *
 * `range` accepts a Headers object and R2 parses the Range header itself.
 * Modelled because media.ts passes the request's headers straight through --
 * see the "SUSPECT" range test for what it then does with the result.
 */
function mediaBucket(): unknown {
  return {
    get: async (key: string, options?: { onlyIf?: Record<string, string>; range?: Headers }) => {
      const rangeHeader = options?.range?.get("range") ?? null;
      getCalls.push({ key, onlyIf: options?.onlyIf, range: rangeHeader });

      const stored = media.get(key);
      if (!stored) return null;

      const httpEtag = `"${stored.etag}"`;
      const base = {
        key,
        size: stored.body.length,
        httpEtag,
        writeHttpMetadata: (h: Headers) => {
          h.set("content-type", stored.contentType);
          if (stored.cacheControl) h.set("cache-control", stored.cacheControl);
        },
      };

      // The 304 shape: no `body` property at all.
      if (options?.onlyIf?.etagDoesNotMatch === stored.etag) return base;

      let bytes = stored.body;
      let range: { offset: number; length: number } | undefined;
      const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;
      if (match && match[1] !== "") {
        const offset = Number(match[1]);
        const end = match[2] === "" ? stored.body.length - 1 : Number(match[2]);
        bytes = stored.body.slice(offset, end + 1);
        range = { offset, length: bytes.length };
      }

      return { ...base, range, body: new Response(bytes).body };
    },
  };
}

function seed(key: string, object: Partial<StoredObject> = {}): void {
  media.set(key, {
    body: `bytes-of-${key}`,
    etag: "abc123",
    contentType: "image/jpeg",
    cacheControl: "public, max-age=604800",
    ...object,
  });
}

// --- the queue ------------------------------------------------------------

let sent: unknown[];
let send: (message: unknown) => Promise<void>;

// --- the execution context ------------------------------------------------

let waited: Promise<unknown>[];
const execCtx = {
  waitUntil: (p: Promise<unknown>) => void waited.push(p),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

// --- the resizing service -------------------------------------------------

interface FetchCall {
  url: string;
  /** the `cf` option, or null for a plain fetch with no transform asked for */
  cf: unknown;
}

let fetchCalls: FetchCall[];
/** Non-null makes the TRANSFORM subrequest answer with this status; the plain refetch still works. */
let transformStatus: number | null;
/** The etag the resizing service returns, exactly as it would appear on the wire. */
let transformEtag: string | null;

/**
 * `fetch` as Cloudflare's image resizing sees it, dispatched back into the
 * real app.
 *
 * This is the whole point of the variant tests: serveVariant fetches ITS OWN
 * URL with `__raw=1` and `cf.image`, and the thing that stops that being
 * error 9403 is serveMedia checking `__raw` before parseVariant. A stubbed
 * fetch that answered from a fixture would pass whether or not that check
 * existed. Dispatching into the app makes the recursion real, so the depth
 * cap below is what a removed guard actually hits.
 */
async function loopbackFetch(input: unknown, init?: { cf?: { image?: Record<string, unknown> } }): Promise<Response> {
  const url = String(input);
  fetchCalls.push({ url, cf: init?.cf ?? null });
  if (fetchCalls.length > 4) throw new Error("subrequest loop: serveVariant re-entered its own transform branch");

  const origin = await app.fetch(new Request(url), env, execCtx);

  const image = init?.cf?.image;
  // No transform asked for: this is serveVariant's fallback refetch, which
  // wants the stored bytes untouched.
  if (!image) return origin;
  // The resizing service passes an origin error straight through -- a 404
  // source is a 404 transform.
  if (!origin.ok) return origin;
  if (transformStatus !== null) return new Response("transform failed", { status: transformStatus });

  const h = new Headers({
    "content-type": `image/${image.format ?? "jpeg"}`,
    // The service's own Vary. media.ts strips it, and the comment above that
    // line records the 4.0% edge hit rate it cost when it did not.
    vary: "Accept",
    "cache-control": "public, max-age=604800",
    "x-from": "resizer",
  });
  if (transformEtag !== null) h.set("etag", transformEtag);
  return new Response(`resized(w=${image.width},f=${image.format ?? "none"}) ${await origin.text()}`, { headers: h });
}

// --- the app --------------------------------------------------------------

let app: Hono<AppEnv>;
let env: AppEnv["Bindings"];
let errorLogs: string[];

beforeEach(() => {
  media = new Map<string, StoredObject>();
  getCalls = [];
  sent = [];
  waited = [];
  fetchCalls = [];
  transformStatus = null;
  transformEtag = '"tx"';
  errorLogs = [];

  send = async (message: unknown) => void sent.push(message);

  env = {
    MEDIA: mediaBucket(),
    JOBS_Q: { send: (message: unknown) => send(message) },
  } as unknown as AppEnv["Bindings"];

  // index.ts:213 verbatim. Nothing else from index.ts is mounted: this route
  // group is registered OUTSIDE i18n_patterns (givefood/urls.py:14 ->
  // gfwfbn/urls/generic.py), so no language middleware runs ahead of it, and
  // adding some here would test index.ts rather than this module.
  app = new Hono<AppEnv>();
  app.route("/needs", mediaApp);

  vi.stubGlobal("fetch", loopbackFetch);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errorLogs.push(args.map(String).join(" ")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Result {
  res: Response;
  body: string;
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Result> {
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, execCtx);
  return { res, body: await res.text() };
}

/** Every waitUntil promise settled, so a queue send is observable before assertions. */
async function drain(): Promise<void> {
  await Promise.all(waited);
}

// ===========================================================================
// Registration: which URLs this app answers at all
// ===========================================================================
//
// The set of registered paths is the set of R2 keys the backfill consumers
// have to implement, so it is a contract in both directions. A path that
// should not be here 404s AND enqueues -- which is a dead letter, not a 404.

describe("mediaApp: the registered URL set", () => {
  // Every family that actually resolves, asserted through the R2 key it reads
  // -- the key is the only externally visible consequence of picking one route
  // registration over another, and it is what the backfill consumer's regex
  // (cited per row) has to accept.
  const SERVED: [path: string, key: string, describedBy: string][] = [
    ["/needs/at/salisbury/photo.jpg", "media/needs/at/salisbury/photo.jpg", "placePhoto.ts:43 FOODBANK_PHOTO_RE"],
    [
      "/needs/at/salisbury/donationpoint/tesco-castle-street/photo.jpg",
      "media/needs/at/salisbury/donationpoint/tesco-castle-street/photo.jpg",
      "placePhoto.ts:44 DONATIONPOINT_PHOTO_RE",
    ],
    ["/needs/at/salisbury/branch-street/photo.jpg", "media/needs/at/salisbury/branch-street/photo.jpg", "placePhoto.ts:45 LOCATION_PHOTO_RE"],
    ["/needs/at/salisbury/map.png", "media/needs/at/salisbury/map.png", "mapImage.ts:28 FOODBANK_MAP_RE"],
    ["/needs/at/salisbury/branch-street/map.png", "media/needs/at/salisbury/branch-street/map.png", "mapImage.ts:29 LOCATION_MAP_RE"],
  ];
  // The other two shapes mapImage.ts implements -- maps/<size>.png -- are
  // registered but unreachable; see the "sized map" block below.

  it.each(SERVED)("serves %s from R2 key %s (%s)", async (path, key) => {
    seed(key, { body: "the bytes" });
    const { res, body } = await get(path);

    expect(res.status).toBe(200);
    expect(body).toBe("the bytes");
    expect(getCalls.map((call) => call.key)).toEqual([key]);
  });

  // The module's registration-order comment says the two-segment location
  // route would otherwise swallow the donation point one with
  // loc="donationpoint". In Hono the two patterns differ in segment count
  // (four against five), so this test pins the RESOLUTION rather than proving
  // the ordering is what achieves it -- the ordering is still worth keeping,
  // since it is gfwfbn/urls/generic.py:12-17's own and costs nothing.
  //
  // What would genuinely break here is the slug binding: the cache-tag and
  // the key must both name the FOOD BANK, not the string "donationpoint".
  it("resolves a donation point photo to the donation point route, not the location one", async () => {
    const key = "media/needs/at/salisbury/donationpoint/tesco-castle-street/photo.jpg";
    seed(key);
    const { res } = await get("/needs/at/salisbury/donationpoint/tesco-castle-street/photo.jpg");

    expect(res.headers.get("cache-tag")).toBe("media, media-salisbury");
    expect(getCalls[0]!.key).toBe(key);
  });

  // Everything here 404s WITHOUT enqueueing. Each entry is a URL that either
  // belongs to a different route file or is simply not a media object; an
  // enqueue for any of them is a message no consumer's regex accepts, i.e.
  // three retries and a dead letter for a request anyone can send.
  const UNREGISTERED: [path: string, why: string][] = [
    ["/needs/at/salisbury/favicon.png", "routes/wfbn/favicon.ts -- live Google fetch, never R2"],
    ["/needs/at/salisbury/screenshots/homepage.png", "routes/wfbn/screenshot.ts -- Django does not persist screenshots"],
    ["/needs/at/salisbury/donationpoint/tesco/favicon.png", "the donation point favicon, same reason"],
    ["/needs/at/salisbury/maps/large.png", "a non-numeric size (though so is a numeric one -- see the sized-map block)"],
    ["/needs/at/salisbury/maps/.png", "an empty size"],
    ["/needs/at/salisbury/donationpoint/tesco/map.png", "no donation point map exists in Django or here"],
    ["/needs/at/a/b/c/photo.jpg", "one segment too deep"],
    ["/needs/at/photo.jpg", "no slug at all"],
    ["/needs/at/salisbury/photo.png", "photo.jpg is a literal"],
    ["/needs/at/salisbury/photo.jpg/", "a trailing slash -- these URLs have none, unlike Django's APPEND_SLASH pages"],
    ["/needs/at/salisbury/PHOTO.JPG", "case matters"],
    ["/at/salisbury/photo.jpg", "without the /needs mount prefix"],
  ];

  it.each(UNREGISTERED)("404s %s without touching R2 or the queue (%s)", async (path) => {
    const { res } = await get(path);
    await drain();

    expect(res.status).toBe(404);
    expect(getCalls).toEqual([]);
    expect(sent).toEqual([]);
  });

  // A GET-only app. Worth asserting rather than assuming, because the
  // enqueue is an unauthenticated side effect: a POST that reached
  // serveMedia would let anyone mint queue messages, and the 404 alone would
  // never show it.
  it.each(["POST", "PUT", "DELETE", "PATCH"])("does not answer %s at all", async (method) => {
    seed(PHOTO_KEY);
    const res = await app.fetch(new Request(`${ORIGIN}${PHOTO_PATH}`, { method }), env, execCtx);
    await drain();

    expect(res.status).toBe(404);
    expect(getCalls).toEqual([]);
    expect(sent).toEqual([]);
  });

  // HEAD is Hono's own doing, not this module's, and it is pinned only so
  // that a framework upgrade which changes it is visible here rather than in
  // a monitoring check: Hono answers HEAD from the GET handler, so a HEAD on
  // a missing object still enqueues a backfill.
  it("answers HEAD from the GET handler, enqueueing on a miss like any other request", async () => {
    const res = await app.fetch(new Request(`${ORIGIN}${PHOTO_PATH}`, { method: "HEAD" }), env, execCtx);
    await drain();

    expect(res.status).toBe(404);
    expect(sent).toEqual([{ type: "media-backfill", key: PHOTO_KEY }]);
  });
});

// ===========================================================================
// The R2 key
// ===========================================================================

describe("mediaApp: the R2 key", () => {
  // "media" + url.pathname. The mount prefix is part of the pathname, which is
  // why every key carries /needs -- and why this test mounts the sub-app the
  // way index.ts does instead of at the root.
  it("is 'media' plus the full request path, mount prefix included", async () => {
    await get(PHOTO_PATH);

    expect(getCalls[0]!.key).toBe("media/needs/at/salisbury/photo.jpg");
  });

  // photo_from_place_id (givefood/utils/geo.py:107) only honours ?size= on the
  // very first Google fetch; for a stored photo it changes nothing. Keeping it
  // in the key would fragment R2 (and the edge cache) on a parameter with no
  // effect, and -- worse -- would enqueue a backfill under a key the consumer
  // regexes reject, because they are anchored with $.
  it("drops ?size= rather than fragmenting the key on a parameter that changes nothing", async () => {
    seed(PHOTO_KEY);
    const { res } = await get(`${PHOTO_PATH}?size=400`);

    expect(res.status).toBe(200);
    expect(getCalls[0]!.key).toBe(PHOTO_KEY);
  });

  // Same for any unrelated query string -- cache busters, analytics tags, the
  // `?v=2` someone adds by hand while debugging.
  it("drops an unrelated query string from the key", async () => {
    seed(PHOTO_KEY);
    const { res } = await get(`${PHOTO_PATH}?v=2&utm_source=x`);

    expect(res.status).toBe(200);
    expect(getCalls[0]!.key).toBe(PHOTO_KEY);
  });

  // The key comes from the RAW pathname and the cache-tag from Hono's decoded
  // param. For every real slug (Django's SlugConverter is [-a-zA-Z0-9_]+,
  // read out of the installed django/urls/converters.py) the two agree; this
  // pins what happens when they cannot, so the divergence is documented
  // rather than discovered.
  it("keys on the undecoded path while tagging with the decoded slug", async () => {
    const { res } = await get("/needs/at/sid%20valley/photo.jpg");
    await drain();

    expect(getCalls[0]!.key).toBe("media/needs/at/sid%20valley/photo.jpg");
    expect(res.headers.get("cache-tag")).toBeNull(); // a 404 carries no tag; see the miss tests
    expect(sent).toEqual([{ type: "media-backfill", key: "media/needs/at/sid%20valley/photo.jpg" }]);
  });
});

// ===========================================================================
// A hit
// ===========================================================================

describe("mediaApp: serving a stored object", () => {
  it("streams the stored bytes with the object's own content-type and cache-control", async () => {
    seed(PHOTO_KEY, { body: "jpeg bytes", contentType: "image/jpeg", cacheControl: "public, max-age=604800" });
    const { res, body } = await get(PHOTO_PATH);

    expect(res.status).toBe(200);
    expect(body).toBe("jpeg bytes");
    // writeHttpMetadata is what carries these across; they are set at PUT time
    // by the backfill consumers (CACHE_CONTROL_WEEK, matching Django's
    // @cache_page(SECONDS_IN_WEEK)).
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=604800");
  });

  it("returns the object's etag, quoted as R2 quotes it", async () => {
    seed(PHOTO_KEY, { etag: "abc123" });
    const { res } = await get(PHOTO_PATH);

    expect(res.headers.get("etag")).toBe('"abc123"');
  });

  // The tag the purge consumer clears when a food bank's photo changes. Built
  // from @givefood/urls' own helpers rather than from literals, so the two
  // modules cannot drift apart silently -- a purge for `media-salisbury`
  // against a response tagged `media_salisbury` would simply never evict
  // anything, and nothing would report it.
  it("stamps the cache-tag @givefood/urls names, keyed on the food bank slug", async () => {
    seed(PHOTO_KEY);
    const { res } = await get(PHOTO_PATH);

    expect(res.headers.get("cache-tag")).toBe(`${MEDIA_TAG}, ${mediaTag("salisbury")}`);
    expect(res.headers.get("cache-tag")).toBe("media, media-salisbury");
  });

  // The location and map routes bind :slug to the FOOD BANK, so one purge of
  // media-<foodbank> takes its locations' photos and maps with it. A route
  // that tagged on :loc would leave a stale location photo behind after the
  // food bank moved, which is invisible until someone looks at the picture.
  it("tags a location map with the food bank's slug, not the location's", async () => {
    const key = "media/needs/at/salisbury/branch-street/map.png";
    seed(key, { contentType: "image/png" });
    const { res } = await get("/needs/at/salisbury/branch-street/map.png");

    expect(res.headers.get("cache-tag")).toBe("media, media-salisbury");
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("reads R2 exactly once per request", async () => {
    seed(PHOTO_KEY);
    await get(PHOTO_PATH);

    expect(getCalls).toHaveLength(1);
  });

  // A hit must not enqueue. This is the whole economics of the design: the
  // billed Google call happens once per object, ever.
  it("enqueues nothing when the object is present", async () => {
    seed(PHOTO_KEY);
    await get(PHOTO_PATH);
    await drain();

    expect(sent).toEqual([]);
  });
});

// ===========================================================================
// A miss: 404 + backfill
// ===========================================================================

describe("mediaApp: a miss", () => {
  // THE HEADER IS THE FIX. Without it the 404 takes the zone's edge TTL and
  // the first visitor's miss is served to everyone else long after the
  // backfill has landed -- observed on map.png as `404` + `cf-cache-status:
  // HIT` with the PNG already in R2. Ten seconds, not no-store, so a popular
  // missing image still collapses its herd.
  it("404s with a ten-second cache-control, not the zone default", async () => {
    const { res, body } = await get(PHOTO_PATH);

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=10");
    expect(body).toBe("");
  });

  // The exact message shape queues/jobs.ts dispatches on. `type` picks the
  // handler; `key` is matched against the consumer regexes.
  it("enqueues one media-backfill message keyed by the R2 path", async () => {
    await get(PHOTO_PATH);
    await drain();

    expect(sent).toEqual([{ type: "media-backfill", key: PHOTO_KEY }]);
  });

  it.each([
    ["/needs/at/salisbury/map.png", "media/needs/at/salisbury/map.png"],
    ["/needs/at/salisbury/branch-street/map.png", "media/needs/at/salisbury/branch-street/map.png"],
    ["/needs/at/salisbury/branch-street/photo.jpg", "media/needs/at/salisbury/branch-street/photo.jpg"],
    [
      "/needs/at/salisbury/donationpoint/tesco-castle-street/photo.jpg",
      "media/needs/at/salisbury/donationpoint/tesco-castle-street/photo.jpg",
    ],
  ])("enqueues %s as %s", async (path, key) => {
    await get(path);
    await drain();

    expect(sent).toEqual([{ type: "media-backfill", key }]);
  });

  // The enqueue is deliberately NOT deduplicated: one message per 10s per
  // colo for a permanently missing object, which is why the module's comment
  // insists the consumer be idempotent. Pinned so that adding a dedupe cache
  // here is a deliberate act, and so the consumer's idempotency requirement
  // has a test on this side of it too.
  it("enqueues again on every miss, deduplicating nothing", async () => {
    await get(PHOTO_PATH);
    await get(PHOTO_PATH);
    await drain();

    expect(sent).toHaveLength(2);
  });

  // waitUntil, not await: the visitor's 404 must not wait on a queue round
  // trip. Proved by never resolving the send -- if the handler awaited it,
  // this test would time out rather than fail.
  it("answers before the queue send settles", async () => {
    send = () => new Promise<void>(() => {});
    const { res } = await get(PHOTO_PATH);

    expect(res.status).toBe(404);
    expect(waited).toHaveLength(1);
  });

  // A miss carries no cache-tag, so the 10s 404 cannot be purged by tag. That
  // is tolerable only because of the 10s; pinned because if the TTL is ever
  // raised, this is the missing piece that makes the raise unsafe.
  it("SUSPECT: the 404 carries no cache-tag, so it cannot be purged by tag", async () => {
    const { res } = await get(PHOTO_PATH);

    expect(res.headers.get("cache-tag")).toBeNull();
  });
});

// ===========================================================================
// The sized map routes
// ===========================================================================
//
// SUSPECT, pinned not fixed, and the largest thing this suite found.
//
// media.ts:36 and :38 register `/at/:slug/maps/:size{[0-9]+}.png` and its
// location twin. Hono does not read that as "a param constrained to digits
// followed by a literal .png": the whole segment has to be the parameter for
// the `:name{regex}` form to apply, so `:size{[0-9]+}.png` is parsed as an
// ORDINARY LITERAL SEGMENT and the routes match nothing a client would ever
// send. Verified in a scratchpad probe against the same hono 4.13.7 this
// package resolves: `:size{[0-9]+\.png}` -- the extension moved inside the
// braces -- matches /at/x/maps/300.png with size="300.png", while the
// spelling as shipped does not match it at all.
//
// SO BOTH SIZED MAP FAMILIES ARE DEAD. Django serves them
// (gfwfbn/urls/i18n.py:28 foodbank_map_size and :39
// foodbank_location_map_size, and locations.html:91-93 links the location one
// at size 300), and workers/jobs' backfill consumer implements both key shapes
// (documented at mediaBackfill/mapImage.ts:25,27, matched by its regexes at
// :28-29) --
// isMapImageKey even has a test for `maps/0600.png`. Nothing on this side can
// ever ask for them.
//
// IT IS LATENT RATHER THAN LIVE: no ported template links a map at all
// (@givefood/urls has no map URL builder, and locations.njk:83 uses the
// location PHOTO with `?s=300` where Django used foodbank_location_map_size).
// That is presumably why it has gone unnoticed, and it is also why these are
// pinned as 404s rather than "fixed" -- the fix belongs with whoever brings
// the map URLs back, and they will need the unallowlisted-size question
// answered too: Django 400s a size outside MAP_SIZE_CONFIG
// (gfwfbn/views.py:440-446), whereas a working [0-9]+ route here would 404
// and enqueue `maps/999.png`, which backfillMapImage can only throw on
// (mapImage.ts:79) -- three retries and a dead letter per request, for a URL
// anyone can mint.

describe("mediaApp: the sized map routes", () => {
  it.each([
    ["/needs/at/salisbury/maps/300.png", "gfwfbn/urls/i18n.py:28, foodbank_map_size"],
    ["/needs/at/salisbury/maps/600.png", "the default size Django uses"],
    ["/needs/at/salisbury/maps/1080.png", "the retina size"],
    ["/needs/at/salisbury/branch-street/maps/300.png", "gfwfbn/urls/i18n.py:39, what locations.html:91-93 links"],
    ["/needs/at/salisbury/branch-street/maps/1080.png", "the location retina size"],
  ])("SUSPECT: 404s %s, which is a size the backfill consumer implements (%s)", async (path) => {
    seed(`media${path}`); // even with the object sitting in R2
    const { res } = await get(path);
    await drain();

    expect(res.status).toBe(404);
    expect(getCalls).toEqual([]); // no route matched, so R2 was never asked
    expect(sent).toEqual([]); // and no backfill either: this is a plain routing miss
  });

  // The unsized forms, registered on the lines either side, do work. Asserted
  // next to the failures so the diagnosis is unambiguous -- this is a pattern
  // spelling, not a broken mount or a broken sub-app.
  it.each(["/needs/at/salisbury/map.png", "/needs/at/salisbury/branch-street/map.png"])("still serves the unsized %s", async (path) => {
    seed(`media${path}`, { contentType: "image/png" });
    const { res } = await get(path);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

// ===========================================================================
// Conditional requests
// ===========================================================================

describe("mediaApp: If-None-Match", () => {
  // R2's onlyIf takes a bare etag, so the HTTP quoting and the weak-validator
  // prefix have to come off. A request whose etag never matched would revalidate
  // to a full 200 every time -- correct, but every image on every repeat view.
  it.each([
    ['"abc123"', "abc123", "a strong etag"],
    ['W/"abc123"', "abc123", "a weak etag"],
    ["abc123", "abc123", "an unquoted one, which some proxies send"],
  ])("passes %s to R2 as etagDoesNotMatch %s (%s)", async (header, expected) => {
    seed(PHOTO_KEY, { etag: "abc123" });
    await get(PHOTO_PATH, { "If-None-Match": header });

    expect(getCalls[0]!.onlyIf).toEqual({ etagDoesNotMatch: expected });
  });

  // The empty R2Conditional is deliberate and load-bearing -- the module
  // comment explains that `undefined` selects the overload whose return type
  // has no bodyless shape, so the 304 branch below would not typecheck. A
  // mutant that passed `undefined` here still serves images correctly, which
  // is why this is asserted directly rather than through a response.
  it("passes an empty R2Conditional, never undefined, when there is no If-None-Match", async () => {
    seed(PHOTO_KEY);
    await get(PHOTO_PATH);

    expect(getCalls[0]!.onlyIf).toEqual({});
    expect(getCalls[0]!.onlyIf).not.toBeUndefined();
  });

  it("304s with the etag and no body when the caller already has the bytes", async () => {
    seed(PHOTO_KEY, { etag: "abc123", body: "jpeg bytes" });
    const { res, body } = await get(PHOTO_PATH, { "If-None-Match": '"abc123"' });

    expect(res.status).toBe(304);
    expect(body).toBe("");
    expect(res.headers.get("etag")).toBe('"abc123"');
  });

  // A 304 is built by hand rather than from the object, so it carries neither
  // the content-type nor the cache-tag. Both are defensible (the client keeps
  // its cached headers, and there are no bytes to purge) but neither is
  // stated anywhere, so they are pinned here.
  it("sends a 304 with no cache-tag and no content-type", async () => {
    seed(PHOTO_KEY, { etag: "abc123" });
    const { res } = await get(PHOTO_PATH, { "If-None-Match": '"abc123"' });

    expect(res.headers.get("cache-tag")).toBeNull();
    expect(res.headers.get("content-type")).toBeNull();
  });

  it("serves the full object when the caller's etag is stale", async () => {
    seed(PHOTO_KEY, { etag: "abc123", body: "jpeg bytes" });
    const { res, body } = await get(PHOTO_PATH, { "If-None-Match": '"older"' });

    expect(res.status).toBe(200);
    expect(body).toBe("jpeg bytes");
  });

  // RFC 9110 allows a list of validators. The quote strip turns `"a", "b"`
  // into the single string `a, b`, which can never equal a stored etag, so a
  // multi-valued If-None-Match silently loses the 304 and transfers the whole
  // image. Browsers send one validator for images, so this is a latent cost
  // rather than a live one -- pinned, not fixed.
  it("SUSPECT: a multi-valued If-None-Match never matches, so the 304 is lost", async () => {
    seed(PHOTO_KEY, { etag: "abc123" });
    const { res } = await get(PHOTO_PATH, { "If-None-Match": '"abc123", "def456"' });

    expect(getCalls[0]!.onlyIf).toEqual({ etagDoesNotMatch: "abc123, def456" });
    expect(res.status).toBe(200);
  });

  // A conditional request for an object that is not there is still a miss:
  // 404 and a backfill, not a 304. Getting this backwards would tell a
  // browser its cached copy was current when there is no copy at all.
  it("still 404s and enqueues when the object is missing entirely", async () => {
    const { res } = await get(PHOTO_PATH, { "If-None-Match": '"abc123"' });
    await drain();

    expect(res.status).toBe(404);
    expect(sent).toEqual([{ type: "media-backfill", key: PHOTO_KEY }]);
  });
});

// ===========================================================================
// Range
// ===========================================================================

describe("mediaApp: Range", () => {
  it("hands the request's headers to R2 so it parses the Range itself", async () => {
    seed(PHOTO_KEY, { body: "0123456789" });
    await get(PHOTO_PATH, { Range: "bytes=2-5" });

    expect(getCalls[0]!.range).toBe("bytes=2-5");
  });

  // SUSPECT, pinned not fixed. media.ts asks R2 for the range and then
  // answers 200 with the partial bytes and no content-range, no
  // accept-ranges, no content-length. A client that asked for bytes 2-5 gets
  // four bytes labelled as the whole object -- a truncated image, cached as
  // complete. routes/staticMedia.ts, which serves the annual-report video
  // from the same kind of bucket, does the full 206 dance
  // (staticMedia.ts:54-77); this route does half of it.
  //
  // Not reachable from an <img> today -- browsers do not range-request still
  // images -- which is presumably why it has survived.
  it("SUSPECT: returns the partial bytes as a 200 with no content-range", async () => {
    seed(PHOTO_KEY, { body: "0123456789" });
    const { res, body } = await get(PHOTO_PATH, { Range: "bytes=2-5" });

    expect(res.status).toBe(200);
    expect(body).toBe("2345");
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("accept-ranges")).toBeNull();
  });

  it("serves the whole object when there is no Range header", async () => {
    seed(PHOTO_KEY, { body: "0123456789" });
    const { res, body } = await get(PHOTO_PATH);

    expect(res.status).toBe(200);
    expect(body).toBe("0123456789");
  });
});

// ===========================================================================
// ?s= / ?f= parsing
// ===========================================================================
//
// The allowlist is a spending control: every distinct accepted value is a
// billed transformation, and the URL is user-controlled. Django does the same
// thing for map sizes (gfwfbn/views.py:440-446, HttpResponseBadRequest).

const BAD_VARIANT_BODY =
  "Unsupported image variant. ?s= must be one of 150, 300, 540, 1080; ?f= is optional and must be one of avif, webp, jpeg, png.";

describe("mediaApp: rejecting an unsupported variant", () => {
  const REJECTED: [query: string, why: string][] = [
    ["?s=999", "a width outside the allowlist -- the whole point of the allowlist"],
    ["?s=1081", "one off an allowed width"],
    ["?s=0", "zero"],
    ["?s=-150", "negative"],
    ["?s=abc", "not a number at all -- Number() gives NaN"],
    ["?s=", "empty, which Number() reads as 0"],
    ["?s=150.5", "not an integer"],
    ["?s=150px", "CSS units"],
    ["?s=Infinity", "Number('Infinity') is a number but not an integer"],
    ["?s=150&f=jpg", "jpg is not jpeg"],
    ["?s=150&f=AVIF", "the format list is case-sensitive"],
    ["?s=150&f=gif", "a format the transformer does not emit here"],
    ["?s=150&f=", "an empty format"],
    ["?f=avif", "?f= without ?s= means nothing"],
    ["?f=", "an empty ?f= alone"],
  ];

  it.each(REJECTED)("400s on %s (%s)", async (query) => {
    seed(PHOTO_KEY);
    const { res, body } = await get(`${PHOTO_PATH}${query}`);

    expect(res.status).toBe(400);
    expect(body).toBe(BAD_VARIANT_BODY);
  });

  // A 400 is the cheapest possible answer and must stay that way: no R2 read,
  // no transform subrequest, and above all no queue message -- otherwise a
  // rejected URL would still cost a backfill attempt.
  it("spends nothing on a rejected variant", async () => {
    seed(PHOTO_KEY);
    await get(`${PHOTO_PATH}?s=999`);
    await drain();

    expect(getCalls).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(sent).toEqual([]);
  });

  // The message names the four widths and four formats. Asserted verbatim
  // because it is the only documentation a developer hitting it gets, and
  // because it is generated from the two Sets -- so a width quietly added to
  // VARIANT_WIDTHS shows up here.
  it("names every accepted width and format in the message", async () => {
    const { res, body } = await get(`${PHOTO_PATH}?s=999`);

    expect(body).toBe(BAD_VARIANT_BODY);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
  });

  // `?s=150.5` and `?s=abc` are both rejected above, and both would still be
  // rejected with parseVariant's `Number.isInteger` check deleted -- a Set of
  // four integers cannot contain a non-integer or NaN, so that half of the
  // condition is dead code. Recorded here because it is one of this suite's
  // two surviving mutants and the survival is a property of the code, not a
  // gap in the tests.
  it.each([150, 300, 540, 1080])("accepts the allowlisted width %i", async (width) => {
    seed(PHOTO_KEY);
    const { res } = await get(`${PHOTO_PATH}?s=${width}`);

    expect(res.status).toBe(200);
  });

  it.each(["avif", "webp", "jpeg", "png"])("accepts the allowlisted format %s", async (format) => {
    seed(PHOTO_KEY);
    const { res } = await get(`${PHOTO_PATH}?s=150&f=${format}`);

    expect(res.status).toBe(200);
  });

  // SUSPECT, pinned not fixed. The guard is `Number.isInteger(Number(s))`, so
  // every spelling of 150 that Number() accepts is allowed: "0150", " 150",
  // "1.5e2", "+150". Each is a DIFFERENT URL and therefore a different edge
  // cache entry and a different billed transformation for identical bytes --
  // which is exactly the unbounded-minting problem the allowlist exists to
  // prevent, reintroduced one spelling at a time. Not currently reachable
  // from any template, which is presumably why it has not been noticed.
  it.each([
    ["0150", "leading zero"],
    ["%20150", "a leading space"],
    ["1.5e2", "exponent notation"],
    ["%2B150", "a leading plus"],
  ])("SUSPECT: accepts %s as 150 (%s), minting a second cache entry for the same bytes", async (spelling) => {
    seed(PHOTO_KEY);
    const { res } = await get(`${PHOTO_PATH}?s=${spelling}`);

    expect(res.status).toBe(200);
    expect(fetchCalls[0]!.cf).toStrictEqual({ image: { width: 150, fit: "scale-down" } });
  });

  // URLSearchParams.get returns the first value. Pinned because "last wins"
  // is just as plausible a reading and the two differ in what gets billed.
  it("takes the first ?s= when it is repeated", async () => {
    seed(PHOTO_KEY);
    await get(`${PHOTO_PATH}?s=150&s=1080`);

    expect(fetchCalls[0]!.cf).toStrictEqual({ image: { width: 150, fit: "scale-down" } });
  });
});

// ===========================================================================
// __raw
// ===========================================================================

describe("mediaApp: the __raw marker", () => {
  // The loop guard. serveMedia checks __raw BEFORE parseVariant, so the
  // transform subrequest can never re-enter the transform branch whatever
  // Cloudflare does with Workers on a resizing subrequest (error 9403 is
  // exactly that loop).
  it("serves the stored object and ignores ?s= entirely", async () => {
    seed(PHOTO_KEY, { body: "jpeg bytes" });
    const { res, body } = await get(`${PHOTO_PATH}?__raw=1&s=150`);

    expect(res.status).toBe(200);
    expect(body).toBe("jpeg bytes");
    expect(fetchCalls).toEqual([]); // no transform was attempted
  });

  // The check is `has`, not a value comparison, so the marker works bare.
  it("recognises the marker with no value", async () => {
    seed(PHOTO_KEY);
    const { res } = await get(`${PHOTO_PATH}?__raw`);

    expect(res.status).toBe(200);
    expect(fetchCalls).toEqual([]);
  });

  // The guard runs before validation as well as before the transform, so a
  // marked subrequest carrying a malformed variant is still answered with the
  // stored object rather than a 400. That matters because the 400 would
  // propagate outwards as a transform failure.
  it("skips variant validation too, so a bad ?f= does not 400", async () => {
    seed(PHOTO_KEY);
    const { res } = await get(`${PHOTO_PATH}?__raw=1&f=avif`);

    expect(res.status).toBe(200);
  });

  it("still 404s and enqueues when a marked request finds nothing", async () => {
    const { res } = await get(`${PHOTO_PATH}?__raw=1`);
    await drain();

    expect(res.status).toBe(404);
    expect(sent).toEqual([{ type: "media-backfill", key: PHOTO_KEY }]);
  });
});

// ===========================================================================
// The transform
// ===========================================================================

describe("mediaApp: serving a resized variant", () => {
  beforeEach(() => {
    seed(PHOTO_KEY, { body: "jpeg bytes", etag: "abc123" });
  });

  // The subrequest is this same URL with the query replaced by the marker.
  // Everything else about it is load-bearing: a subrequest that kept ?s=
  // would recurse, and one that kept an unrelated query would not change the
  // key but would change the edge cache entry the transformer reads through.
  it("fetches its own URL with the query replaced by __raw=1", async () => {
    await get(`${PHOTO_PATH}?s=540&f=webp&utm_source=x`);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(`${ORIGIN}${PHOTO_PATH}?__raw=1`);
  });

  it("asks for width and scale-down, and names the format only when one was requested", async () => {
    await get(`${PHOTO_PATH}?s=540&f=webp`);
    expect(fetchCalls[0]!.cf).toStrictEqual({ image: { width: 540, fit: "scale-down", format: "webp" } });

    fetchCalls = [];
    await get(`${PHOTO_PATH}?s=1080`);
    expect(fetchCalls[0]!.cf).toStrictEqual({ image: { width: 1080, fit: "scale-down" } });
  });

  // The recursion test. The loopback dispatches back into the real app, so
  // if the __raw check were removed or moved after parseVariant this would
  // spiral; the depth cap turns that into a named failure. One R2 read, one
  // subrequest, no matter how many times the bytes pass through.
  it("re-enters the app exactly once, taking the unresized branch", async () => {
    await get(`${PHOTO_PATH}?s=150`);

    expect(fetchCalls).toHaveLength(1);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0]!.key).toBe(PHOTO_KEY);
  });

  it("returns the transformed bytes with the transformer's content-type", async () => {
    const { res, body } = await get(`${PHOTO_PATH}?s=150&f=avif`);

    expect(res.status).toBe(200);
    expect(body).toBe("resized(w=150,f=avif) jpeg bytes");
    expect(res.headers.get("content-type")).toBe("image/avif");
  });

  // Two variants of one photo must never be interchangeable to a cache. The
  // suffix is this Worker's own guarantee rather than a trusted behaviour of
  // the resizing service, which is the point of appending it at all.
  it("appends the width and format to the source etag", async () => {
    transformEtag = '"tx"';
    const { res } = await get(`${PHOTO_PATH}?s=150&f=avif`);

    expect(res.headers.get("etag")).toBe('"tx-150-avif"');
  });

  it("says 'orig' in the etag when no format was requested", async () => {
    const { res } = await get(`${PHOTO_PATH}?s=540`);

    expect(res.headers.get("etag")).toBe('"tx-540-orig"');
  });

  it.each([
    ['W/"tx"', '"tx-300-webp"', "a weak validator"],
    ['"tx"', '"tx-300-webp"', "a strong one"],
  ])("strips %s down before appending the variant (%s)", async (sourceEtag, expected) => {
    transformEtag = sourceEtag;
    const { res } = await get(`${PHOTO_PATH}?s=300&f=webp`);

    expect(res.headers.get("etag")).toBe(expected);
  });

  // "0" is the documented stand-in when the transformer sends no validator.
  // It makes every unvalidated variant of every photo share the etag
  // `"0-<width>-<format>"`, which is safe only because the URL is part of the
  // cache key; pinned so that the fallback is a decision and not an accident.
  it("falls back to etag 0 when the transformer sends none", async () => {
    transformEtag = null;
    const { res } = await get(`${PHOTO_PATH}?s=150&f=png`);

    expect(res.headers.get("etag")).toBe('"0-150-png"');
  });

  // A derived variant has no cacheControl of its own, and its etag moves when
  // the photo does, so it is immutable for a year. This overrides the week
  // the stored object carries -- assert the override, not just the presence.
  it("overrides the object's week-long cache-control with an immutable year", async () => {
    const { res } = await get(`${PHOTO_PATH}?s=150`);

    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("stamps the same cache-tag as the unresized branch", async () => {
    const { res } = await get(`${PHOTO_PATH}?s=150`);

    expect(res.headers.get("cache-tag")).toBe(`${MEDIA_TAG}, ${mediaTag("salisbury")}`);
  });

  // serveVariant reads :slug from the OUTER request, not from the subrequest,
  // and on a location URL that param sits beside a :loc it could just as
  // easily have taken. A variant tagged `media-branch-street` would survive
  // every purge the site issues, leaving a resized photo of the old premises
  // on the page indefinitely -- the failure mode is a stale picture, which
  // nothing alerts on.
  it("tags a location variant with the food bank slug, matching the unresized branch", async () => {
    seed("media/needs/at/salisbury/branch-street/photo.jpg");
    const { res } = await get("/needs/at/salisbury/branch-street/photo.jpg?s=300&f=webp");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-tag")).toBe("media, media-salisbury");
  });

  // THE VARY FIX. The resizing service sends `Vary: Accept` because it is
  // built for format=auto; this route names the format in the URL, so a given
  // URL has exactly one representation. This zone has Cloudflare's "Vary for
  // Images" on, so leaving the header through gave every distinct Accept
  // string its own cache entry -- the module's comment records a 4.0% jpeg
  // edge hit rate against an expected ~67%. accept-encoding is kept because
  // gzip/br genuinely does vary the bytes.
  it("replaces the transformer's Vary: Accept with accept-encoding alone", async () => {
    const { res } = await get(`${PHOTO_PATH}?s=150&f=avif`);

    expect(res.headers.get("vary")).toBe("accept-encoding");
  });

  // The rest of the transformer's headers ride along, which is why the three
  // overridden ones above have to be overridden explicitly.
  it("keeps the transformer's other headers", async () => {
    const { res } = await get(`${PHOTO_PATH}?s=150`);

    expect(res.headers.get("x-from")).toBe("resizer");
  });

  // A conditional request for a variant is answered with the full bytes: the
  // subrequest is built from the URL alone, so If-None-Match never reaches
  // R2 and the derived etag is never compared. Harmless in practice because
  // the year-long immutable cache-control stops browsers revalidating at all
  // -- pinned so the reasoning is on the record.
  it("ignores If-None-Match on a variant and never forwards it to R2", async () => {
    const { res } = await get(`${PHOTO_PATH}?s=150`, { "If-None-Match": '"tx-150-orig"' });

    expect(res.status).toBe(200);
    expect(getCalls[0]!.onlyIf).toEqual({});
  });

  // Likewise Range: the module's comment says a variant "cannot honour
  // Range", and this is the mechanism by which that is true.
  it("does not forward a Range header to the transform subrequest", async () => {
    const { res } = await get(`${PHOTO_PATH}?s=150`, { Range: "bytes=0-3" });

    expect(res.status).toBe(200);
    expect(getCalls[0]!.range).toBeNull();
  });
});

// ===========================================================================
// The transform's failure modes
// ===========================================================================

describe("mediaApp: a variant when things go wrong", () => {
  // A variant of an object that is not stored. The subrequest goes through
  // serveMedia's unresized branch, which enqueues the backfill and 404s; the
  // outer response repeats the short TTL so a variant 404 does not outlive
  // the object it is waiting for.
  it("404s with the same ten-second cache-control when the source is missing", async () => {
    const { res } = await get(`${PHOTO_PATH}?s=150&f=avif`);

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=10");
  });

  // ONE message, keyed WITHOUT the variant. If __raw or ?s= ever leaked into
  // the key the consumer would store bytes under a key no request reads back,
  // and the image would 404 forever while the backfill reported success.
  it("enqueues exactly one backfill, under the unsuffixed key", async () => {
    await get(`${PHOTO_PATH}?s=150&f=avif`);
    await drain();

    expect(sent).toEqual([{ type: "media-backfill", key: PHOTO_KEY }]);
  });

  it("does not enqueue a second time from the variant branch", async () => {
    await get(`${PHOTO_PATH}?s=150`);
    await get(`${PHOTO_PATH}?s=300`);
    await drain();

    expect(sent).toHaveLength(2); // one per request, not two per request
  });

  // Any failure that is not a 404 -- an undecodable source, a transform error
  // -- is answered with the ORIGINAL bytes: correct pixels at the wrong size
  // beats a broken <img>. The second fetch deliberately carries no cf.image.
  it("serves the original bytes when the transform itself fails", async () => {
    seed(PHOTO_KEY, { body: "jpeg bytes" });
    transformStatus = 500;
    const { res, body } = await get(`${PHOTO_PATH}?s=150&f=avif`);

    expect(res.status).toBe(200);
    expect(body).toBe("jpeg bytes");
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]!.url).toBe(`${ORIGIN}${PHOTO_PATH}?__raw=1`);
    expect(fetchCalls[1]!.cf).toBeNull();
  });

  // This is a queue consumer's kind of failure: nothing renders wrongly, the
  // page just quietly costs more and shows a full-size image. The log line is
  // the only signal it happened, which is why its text is asserted.
  it("logs the failure with the path and the status", async () => {
    seed(PHOTO_KEY);
    transformStatus = 500;
    await get(`${PHOTO_PATH}?s=150&f=avif`);

    expect(errorLogs).toEqual(["media: transform failed, serving original /needs/at/salisbury/photo.jpg 500"]);
  });

  // The fallback returns the subrequest's response untouched -- and because
  // that subrequest went through serveMedia's own unresized branch, it
  // arrives already carrying the stored object's week-long cache-control and
  // the cache-tag that branch stamps. So a degraded variant is still
  // purgeable, and it is NOT pinned as immutable for a year, which is the
  // right way round: a full-size image served at a variant URL must not
  // outlive the failure that caused it.
  it("hands back the stored object's own headers, tag included, not the immutable year", async () => {
    seed(PHOTO_KEY, { cacheControl: "public, max-age=604800" });
    transformStatus = 500;
    const { res } = await get(`${PHOTO_PATH}?s=150`);

    expect(res.headers.get("cache-tag")).toBe("media, media-salisbury");
    expect(res.headers.get("cache-control")).toBe("public, max-age=604800");
  });

  // A transform failure does not enqueue: the object is present, so there is
  // nothing to backfill. Spending a queue message on every failed transform
  // would turn a transformer outage into a flood of doomed backfills.
  it("enqueues nothing when the source is present but the transform fails", async () => {
    seed(PHOTO_KEY);
    transformStatus = 500;
    await get(`${PHOTO_PATH}?s=150`);
    await drain();

    expect(sent).toEqual([]);
  });

  // If the refetch fails too, its status is passed through as-is. Pinned
  // because "serve the original" quietly becomes "serve the error" here, and
  // a 500 from an image URL is at least visible in the logs.
  it("passes a failed refetch through with its own status", async () => {
    seed(PHOTO_KEY);
    transformStatus = 500;
    // Drop the object between the transform attempt and the refetch, so the
    // fallback finds nothing. This is a real interleaving: the two fetches are
    // separate requests and R2 can change under them.
    const original = loopbackFetch;
    vi.stubGlobal("fetch", async (input: unknown, init?: { cf?: { image?: Record<string, unknown> } }) => {
      if (fetchCalls.length === 1) media.delete(PHOTO_KEY);
      return original(input, init);
    });

    const { res } = await get(`${PHOTO_PATH}?s=150`);

    expect(res.status).toBe(404);
  });
});
