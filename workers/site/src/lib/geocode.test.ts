import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isUk } from "@givefood/geo";
import { geocode } from "./geocode";
import type { AppEnv } from "../types";

// lib/geocode.ts is a four-line fetch wrapper, and every interesting thing
// about it is a FAILURE mode rather than a feature: it is the only module in
// the port that turns "the paid third-party dependency stopped working" into
// a perfectly ordinary-looking string. Nothing above it logs, retries or
// alerts -- `catch { return "0,0" }` is the whole error handling -- so the
// symptoms of a broken geocoding key are: /needs/?address=... redirects the
// visitor to the homepage, /api/2/foodbanks/search/?address=... 400s, and
// /api/1/foodbanks/search/?address=... quietly ranks UK food banks by their
// distance from the Gulf of Guinea and returns 200. That is exactly the
// shape of failure this tier exists for, and the reason the tests below are
// mostly about what a broken Google looks like from in here.
//
// THE ONE THAT MATTERS MOST is `REQUEST_DENIED`: Google answers a revoked,
// unbilled or IP-restricted key with HTTP **200** and an error envelope, so
// `response.ok` is true, the parse succeeds, and the only trace left is
// `results: []`. The test named for it is the difference between "we can
// tell a dead key from a genuinely unfindable address" and "we cannot", and
// today the answer is that we cannot -- both are "0,0".
//
// PORT SOURCE: givefood/utils/geo.py:61-82 geocode(). Read in full against
// this module; the differences are asserted individually below and each one
// was checked by RUNNING both sides (CPython 3.13.0 with the repo's own
// `requests`, and node) rather than reasoned about. They are, in full:
//   1. `response.ok` (200-299) where Python tests `status_code == 200`.
//   2. encodeURIComponent vs `requests.utils.quote(safe="/")` -- five
//      characters are encoded by one side and not the other.
//   3. Number-to-string: JS `${51.0}` is "51", Python `"%s" % 51.0` is
//      "51.0".
// None of the three changes which place Google resolves, and #3 only moves
// a string that every caller immediately parseFloat()s back to a number.
//
// MOCKED: `fetch`, and nothing else. It is the only thing here that leaves
// the machine. The Context is a REAL Hono one -- the module reads `c.env`,
// and env only exists on a Context that Hono itself built from an
// `app.fetch(request, env, ctx)` call, so a `{ env } as Context` literal
// would be testing this file's idea of Hono rather than Hono.

const KEY = "AIzaSy-geocode-key-not-a-real-one";
const ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const PAGE = "https://www.givefood.org.uk/needs/?address=Sidmouth";

// Hono's fetch() wants an ExecutionContext; nothing under test touches it.
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

// Only the one binding this module reads. Env has dozens of others (D1, KV,
// queue producers); handing over a full one would say nothing extra and
// would break the day someone adds a binding.
function envWith(key: unknown): AppEnv["Bindings"] {
  return { GMAP_GEOCODE_KEY: key } as unknown as AppEnv["Bindings"];
}

type Reply = (url: string) => Response | Promise<Response>;

/** A REAL Response, so `ok` is the runtime's opinion of the status code and
 *  `.json()` genuinely parses. A stub object with a hand-set `ok` would be
 *  asserting this file's model of HTTP against the module's use of it, which
 *  is the one comparison that cannot fail. */
function googleJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=UTF-8" } });
}

/** A geocode envelope trimmed to the two fields the module reads, plus
 *  Google's own `status` so the fixture stays recognisable in a diff. */
function geocodeBody(...locations: Array<Record<string, unknown>>) {
  return {
    results: locations.map((location) => ({
      formatted_address: "somewhere",
      geometry: { location, location_type: "ROOFTOP" },
      place_id: "ChIJnotarealplaceid",
    })),
    status: "OK",
  };
}

let calls: unknown[][] = [];

/**
 * Runs geocode() inside a real handler on a real Hono app and hands back
 * both the string and the outbound calls.
 *
 * The `status !== 200` guard enforces the module's headline promise --
 * "never throws" -- on EVERY call in this file rather than in one test of
 * its own. That promise is load-bearing three ways: api1's search endpoint
 * has no try/catch around it, api2's has none either, and wfbn's page
 * render has none, so a throw here is a 500 on three public endpoints that
 * an attacker picks by sending an address Google chokes on. Without the
 * guard a regression would surface below as a baffling `expected 'Internal
 * Server Error' to be '0,0'`.
 */
async function run(address: string, options: { reply?: Reply; key?: unknown } = {}): Promise<string> {
  const reply: Reply =
    options.reply ??
    (() => {
      throw new Error("fetch not stubbed for this test");
    });

  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: unknown[]): Promise<Response> => {
      calls.push(args);
      return reply(String(args[0]));
    }),
  );

  const app = new Hono<AppEnv>();
  // The result comes back as the response body because it is a short opaque
  // string, so the body is a safe carrier.
  app.get("*", async (c) => c.text(await geocode(c, address)));

  // `Object.hasOwn`, not `options.key ?? KEY` -- the "secret is unset" test
  // passes `key: undefined` deliberately, and a nullish default would have
  // handed it the real key and made that test assert nothing. (It did,
  // briefly, when this helper used a default parameter.)
  const env = envWith(Object.hasOwn(options, "key") ? options.key : KEY);
  const res = await app.fetch(new Request(PAGE), env as never, execCtx);
  const body = await res.text();
  if (res.status !== 200) throw new Error(`geocode() threw (status ${res.status}): ${body}`);
  return body;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The outbound request
// ---------------------------------------------------------------------------

describe("the URL it asks Google for", () => {
  // Asserted as one exact string rather than parameter by parameter. A wrong
  // key, a dropped `region=uk` or a missing ",UK" is completely invisible in
  // the response -- Google answers 200 with a different place, or with a
  // plausible place in the wrong country -- so the request is the only
  // artefact where those failures are visible at all.
  it("is the endpoint, region, key and ',UK'-suffixed address, in that order", async () => {
    const result = await run("Sidmouth, Devon", { reply: () => googleJson(geocodeBody({ lat: 50.6795, lng: -3.2405 })) });

    expect(result).toBe("50.6795,-3.2405");
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe(`${ENDPOINT}?region=uk&key=${KEY}&address=Sidmouth%2C%20Devon%2CUK`);
  });

  // `region=uk` biases Google's results towards the UK; ",UK" on the address
  // is the second, independent nudge. Both are Django's (geo.py:65-66) and
  // both are easy to lose to a "tidy the query string" refactor -- with no
  // visible consequence until an address like "Newport" or "Boston" starts
  // resolving to the American one. This pins the pair as PROPERTIES, so it
  // still fails if the exact-string test above is updated for some unrelated
  // reason.
  it("keeps both UK biases -- region=uk and the appended country", async () => {
    await run("Boston", { reply: () => googleJson(geocodeBody({ lat: 52.9787, lng: -0.0269 })) });

    const url = new URL(String(calls[0]![0]));
    expect(url.searchParams.get("region")).toBe("uk");
    expect(url.searchParams.get("address")).toBe("Boston,UK");
  });

  // Exactly one call, no init object at all -- so no headers, no method, and
  // in particular NO AbortSignal. queueBacklog.ts in this same directory
  // wraps its Cloudflare calls in a timeout for exactly this reason; this
  // module does not, and a Google that accepts the connection and then goes
  // quiet will hold the request open to the Workers subrequest limit. That
  // matches Django (`requests.get(url)` with no `timeout=`), so it is pinned
  // as current behaviour rather than filed as a port defect -- but if
  // someone adds a signal, this test is where they will be reminded that the
  // three callers all have to cope with the abort.
  it("makes exactly one bare GET, with no init and therefore no timeout", async () => {
    await run("Sidmouth", { reply: () => googleJson(geocodeBody({ lat: 50.68, lng: -3.24 })) });

    expect(calls.length).toBe(1);
    expect(calls[0]!.length).toBe(1);
    expect(typeof calls[0]![0]).toBe("string");
  });

  // DIVERGENCE 2a, measured not guessed: encodeURIComponent percent-encodes
  // "/", Python's requests.utils.quote does not (its default is safe="/").
  // Run on this machine -- CPython 3.13.0, requests.utils.quote("Flat
  // 1/2, Sauchiehall St,UK") -> 'Flat%201/2%2C%20Sauchiehall%20St%2CUK'.
  // Google decodes both identically, so this is recorded, not filed. Scottish
  // tenement addresses are the realistic source of a "/" in an address.
  it("percent-encodes '/' where Python leaves it bare", async () => {
    await run("Flat 1/2, Sauchiehall St", { reply: () => googleJson(geocodeBody({ lat: 55.8656, lng: -4.2666 })) });

    expect(calls[0]![0]).toBe(`${ENDPOINT}?region=uk&key=${KEY}&address=Flat%201%2F2%2C%20Sauchiehall%20St%2CUK`);
  });

  // DIVERGENCE 2b, the other direction: Python encodes ' ( ) * ! where
  // encodeURIComponent leaves them literal. Same machine, same run --
  // quote("St Mary's Hall (Rear Entrance),UK") ->
  // 'St%20Mary%27s%20Hall%20%28Rear%20Entrance%29%2CUK'. Apostrophes in
  // church-hall addresses are extremely common in this dataset, so this is
  // the divergence that actually fires in production, on most of the
  // requests that reach it.
  it("leaves apostrophes and brackets literal where Python encodes them", async () => {
    await run("St Mary's Hall (Rear Entrance)", { reply: () => googleJson(geocodeBody({ lat: 51.07, lng: -1.79 })) });

    expect(calls[0]![0]).toBe(`${ENDPOINT}?region=uk&key=${KEY}&address=St%20Mary's%20Hall%20(Rear%20Entrance)%2CUK`);
  });

  // The two encodings that MATCH, pinned so the divergence tests above are
  // not read as "the encoding is arbitrary". A stored foodbank address is
  // CRLF-separated (see the `address` column throughout api1.test.ts) and
  // routinely non-ASCII, and both sides produce the same bytes for both --
  // %0D%0A and UTF-8 %C3%A9. Verified by running quote() on the same two
  // strings. A raw CR/LF reaching an HTTP request line would be a header
  // injection, so this one is not merely cosmetic.
  it("encodes CRLF and non-ASCII exactly as Python does", async () => {
    const reply: Reply = () => googleJson(geocodeBody({ lat: 56.396, lng: -3.437 }));

    await run("12 Tay Street\r\nPerth", { reply });
    expect(calls[0]![0]).toBe(`${ENDPOINT}?region=uk&key=${KEY}&address=12%20Tay%20Street%0D%0APerth%2CUK`);

    await run("Café & Co", { reply });
    expect(calls[0]![0]).toBe(`${ENDPOINT}?region=uk&key=${KEY}&address=Caf%C3%A9%20%26%20Co%2CUK`);
  });

  // ",UK" is appended UNCONDITIONALLY -- an address that already ends in it
  // gets a second one, exactly as `"%s,UK" % address` does. Pinned because
  // "only append if it isn't already there" is a tempting one-line tidy-up,
  // and it would change what Google is asked for every visitor who types the
  // country themselves.
  it("appends ',UK' even to an address that already ends in it", async () => {
    await run("Sidmouth,UK", { reply: () => googleJson(geocodeBody({ lat: 50.68, lng: -3.24 })) });

    expect(calls[0]![0]).toBe(`${ENDPOINT}?region=uk&key=${KEY}&address=Sidmouth%2CUK%2CUK`);
  });

  // An empty address is still sent -- ",UK" alone. All three callers guard
  // with `if (address && ...)` so this should be unreachable, but the module
  // itself does not, and Django's did not either. Pinned so that "we never
  // spend a paid geocode on an empty string" stays a fact about the CALLERS,
  // which is where it is actually enforced.
  it("still calls Google for an empty address rather than short-circuiting", async () => {
    const result = await run("", { reply: () => googleJson({ results: [], status: "ZERO_RESULTS" }) });

    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe(`${ENDPOINT}?region=uk&key=${KEY}&address=%2CUK`);
    expect(result).toBe("0,0");
  });

  // The key is interpolated RAW while the address is encoded, so a key
  // containing "&" would silently truncate the query string and hand Google
  // a request with no address on it -- which is a 200 with ZERO_RESULTS,
  // i.e. "0,0" for every address, i.e. the silent-credential-failure story
  // again. Google's own keys are [A-Za-z0-9_-] so this cannot fire today,
  // and Django interpolates the key just as rawly (`%s`), so it is parity
  // rather than a port defect. Pinned as the reason not to accept an
  // arbitrary string here.
  it("does not encode the key, so a key with '&' in it would break the URL", async () => {
    await run("Sidmouth", {
      key: "abc&address=Paris",
      reply: () => googleJson(geocodeBody({ lat: 48.85, lng: 2.35 })),
    });

    const url = new URL(String(calls[0]![0]));
    expect(url.searchParams.get("key")).toBe("abc");
    // Two `address` parameters now; Google reads the first, which is Paris.
    expect(url.searchParams.getAll("address")).toEqual(["Paris", "Sidmouth,UK"]);
  });

  // An unset secret produces the literal string "undefined" as the key,
  // because template interpolation has no opinion about missing bindings.
  // Google answers that with a 200 REQUEST_DENIED envelope, so the deployed
  // symptom of "someone forgot `wrangler secret put GMAP_GEOCODE_KEY`" is
  // every address in the country resolving to Null Island, with a green
  // deploy and no error anywhere. Worth knowing by name.
  it("sends the literal 'undefined' when the secret is unset", async () => {
    const result = await run("Sidmouth", {
      key: undefined,
      reply: () => googleJson({ error_message: "The provided API key is invalid.", results: [], status: "REQUEST_DENIED" }),
    });

    expect(calls[0]![0]).toBe(`${ENDPOINT}?region=uk&key=undefined&address=Sidmouth%2CUK`);
    expect(result).toBe("0,0");
  });

  // No caching, no memoisation: two identical lookups are two paid calls.
  // Pinned in both directions -- an added cache would break the second
  // assertion, and it would also be a behaviour change nobody would notice
  // until a food bank's re-geocoded address kept coming back stale.
  it("calls Google again for a repeated address rather than caching", async () => {
    const reply: Reply = () => googleJson(geocodeBody({ lat: 50.68, lng: -3.24 }));

    await run("Sidmouth", { reply });
    const first = calls.length;
    // A second geocode() on a FRESH app, and then a second one within one
    // request, since a module-level cache would survive both.
    const app = new Hono<AppEnv>();
    app.get("*", async (c) => c.text(`${await geocode(c, "Sidmouth")}|${await geocode(c, "Sidmouth")}`));
    const body = await (await app.fetch(new Request(PAGE), envWith(KEY) as never, execCtx)).text();

    expect(first).toBe(1);
    expect(calls.length).toBe(3);
    expect(body).toBe("50.68,-3.24|50.68,-3.24");
  });
});

// ---------------------------------------------------------------------------
// The string it builds from a successful response
// ---------------------------------------------------------------------------

describe("the 'lat,lng' string", () => {
  it("is lat then lng, comma-separated, with no space", async () => {
    const result = await run("Brixton", { reply: () => googleJson(geocodeBody({ lat: 51.4622817, lng: -0.1145622 })) });

    // Not `toContain` or a regexp: the ORDER is the whole point. A lat/lng
    // swap is a coordinate somewhere off the coast of Somalia that still
    // parses, still ranks, and still renders.
    expect(result).toBe("51.4622817,-0.1145622");
  });

  // Google returns candidates best-first and Django takes `results[0]`. The
  // second result here is a REAL UK place with plausible coordinates, seeded
  // precisely so that "reads the first result" is measured rather than
  // assumed -- an implementation that took the last, or the closest to
  // something, would pass a test that only ever seeded one result.
  it("reads the first result and ignores every other candidate", async () => {
    const result = await run("Newport", {
      reply: () =>
        googleJson(
          geocodeBody(
            { lat: 51.5842, lng: -2.9977 }, // Newport, Gwent -- the one Google ranks first
            { lat: 52.7695, lng: -2.3782 }, // Newport, Shropshire
            { lat: 50.7014, lng: -1.2931 }, // Newport, Isle of Wight
          ),
        ),
    });

    expect(result).toBe("51.5842,-2.9977");
    expect(result).not.toContain("52.7695");
    expect(result).not.toContain("50.7014");
  });

  // DIVERGENCE 3, measured on this machine: CPython renders a JSON float
  // with a zero fraction as "51.0" (`"%s,%s" % (51.0, -3.0)` -> '51.0,-3.0'),
  // JS renders the same parsed number as "51" (`String(51.0)` -> '51').
  // Harmless -- every caller immediately parseFloat()s it back -- but it
  // WOULD show up if a lat_lng from this function were ever compared as a
  // string against a lat_lng Django wrote into the database, which is
  // exactly what the `lat_lng` TEXT column invites. Recorded so the next
  // person to try that comparison finds it here first.
  it("drops the trailing '.0' that Python's %s keeps", async () => {
    const result = await run("Greenwich", { reply: () => googleJson(geocodeBody({ lat: 51, lng: 0 })) });

    expect(result).toBe("51,0");
    expect(result).not.toBe("51.0,0.0"); // what geo.py:72-75 would have produced
  });

  // The same divergence at both ends of the float range. Python: 1e-07 and
  // -0.0; JS: 1e-7 and 0. Neither is a coordinate anything real sits at, but
  // both are one bad upstream response away, and both are silently
  // different strings for the same number.
  it("differs from Python on exponent padding and negative zero too", async () => {
    const result = await run("Null Island Adjacent", { reply: () => googleJson(geocodeBody({ lat: 1e-7, lng: -0 })) });

    expect(result).toBe("1e-7,0"); // Python would write '1e-07,-0.0'
  });

  // Google has never sent a string here, but the module does no coercion at
  // all -- whatever JSON.parse produced goes straight into the template
  // literal. Pinned because it means the return type is a promise about the
  // SHAPE ("something,something"), not about the contents, and every caller
  // parseFloat()s it precisely because of that.
  it("passes strings through uncoerced when Google sends them", async () => {
    const result = await run("Stringly Typed", { reply: () => googleJson(geocodeBody({ lat: "51.46", lng: "-0.11" })) });

    expect(result).toBe("51.46,-0.11");
  });

  // SUSPECT, and pinned rather than fixed. `location?.lat === undefined` is
  // an identity check, so an explicit JSON `null` sails straight past it and
  // becomes the four-character string "null" in the coordinate. Downstream
  // that is parseFloat("null") -> NaN, and packages/geo's isUk() answers
  // TRUE for NaN (all four of its comparisons are false), so a null latitude
  // would pass the api/2 guard that "0,0" is stopped by, and rank food banks
  // from NaN. Django's `"%s,%s" % (None, ...)` builds an equally broken
  // "None,..." but its is_uk() calls float() on it and raises, so Django
  // 500s where this returns 200. Google does not send nulls here, which is
  // why this is a note rather than a fix.
  it("emits the literal 'null' for a null coordinate instead of falling back", async () => {
    const result = await run("Nulled", { reply: () => googleJson(geocodeBody({ lat: null, lng: -0.11 })) });

    expect(result).toBe("null,-0.11");
    // The consequence, spelled out with the REAL isUk rather than described:
    expect(isUk(Number.parseFloat("null"), -0.11)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Every road to "0,0"
// ---------------------------------------------------------------------------

describe("the '0,0' fallback", () => {
  // THE CREDENTIAL FAILURE, and the single most important test in this file.
  // A revoked key, a disabled billing account, an over-quota project and an
  // IP-restricted key all come back as HTTP **200** with an error envelope
  // and an empty `results` array -- not as a 401, not as a 403. So `ok` is
  // true, `.json()` succeeds, and the only signal is the absence of results,
  // which is byte-identical to a genuinely unfindable address. Nothing here
  // reads `status` or `error_message`, so the day the key dies, this
  // function returns a plausible string and every log stays clean. That is
  // the same failure mode as the Browser Rendering credential that broke
  // silently for a day.
  it("cannot tell a dead API key from an unfindable address -- both are '0,0'", async () => {
    const deadKey = await run("Sidmouth, Devon", {
      reply: () => googleJson({ error_message: "The provided API key is expired.", results: [], status: "REQUEST_DENIED" }),
    });
    const noSuchPlace = await run("Not A Real Place At All", { reply: () => googleJson({ results: [], status: "ZERO_RESULTS" }) });

    expect(deadKey).toBe("0,0");
    expect(noSuchPlace).toBe("0,0");
    expect(deadKey).toBe(noSuchPlace);
  });

  // OVER_QUERY_LIMIT is the third member of that family and the one that
  // arrives WITHOUT anybody changing anything -- a traffic spike alone is
  // enough. Also a 200.
  it("returns '0,0' for an over-quota 200", async () => {
    expect(await run("Sidmouth", { reply: () => googleJson({ results: [], status: "OVER_QUERY_LIMIT" }) })).toBe("0,0");
  });

  // Every non-2xx, short-circuited before the body is even read. 403 and 429
  // are what a quota-blocked project returns at the edge rather than from
  // the API; 500 and 502 are Google having a bad day.
  it.each([400, 401, 403, 404, 429, 500, 502, 503])("returns '0,0' for HTTP %i without parsing the body", async (status) => {
    const result = await run("Sidmouth", { reply: () => googleJson(geocodeBody({ lat: 50.68, lng: -3.24 }), status) });

    // The body carried a PERFECTLY GOOD coordinate. If the status check were
    // dropped, this would come back as "50.68,-3.24" and look like a success
    // -- which is why the fixture is a valid envelope rather than an error
    // page.
    expect(result).toBe("0,0");
  });

  // DIVERGENCE 1: `response.ok` is 200-299, Python's `status_code == 200` is
  // one value. A 201/202/206 carrying a valid geocode is honoured here and
  // discarded by Django. Google does not send those for this endpoint, so
  // this is recorded as the port's actual behaviour rather than filed --
  // but it is the one place where the port is more permissive than the
  // original, and a proxy or a service mesh in front of the request is the
  // realistic way it would ever fire.
  it.each([201, 202, 206, 299])("accepts HTTP %i where Django would have returned '0,0'", async (status) => {
    const result = await run("Sidmouth", { reply: () => googleJson(geocodeBody({ lat: 50.68, lng: -3.24 }), status) });

    expect(result).toBe("50.68,-3.24");
  });

  // Every shape of a 200 whose JSON parses but does not contain a
  // coordinate. These are the `KeyError`/`IndexError` arm of geo.py:76's
  // bare except, one branch at a time. Each one is a place an optional chain
  // could be dropped without any other test noticing.
  it.each([
    ["no results key at all", { status: "ZERO_RESULTS" }],
    ["an empty results array", { results: [], status: "ZERO_RESULTS" }],
    ["a null first result", { results: [null] }],
    ["a first result with no geometry", { results: [{ formatted_address: "somewhere" }] }],
    ["geometry with no location", { results: [{ geometry: { location_type: "APPROXIMATE" } }] }],
    ["an empty location object", { results: [{ geometry: { location: {} } }] }],
    ["a null location", { results: [{ geometry: { location: null } }] }],
    ["a latitude but no longitude", { results: [{ geometry: { location: { lat: 51.46 } } }] }],
    ["a longitude but no latitude", { results: [{ geometry: { location: { lng: -0.11 } } }] }],
    ["a bare JSON array", []],
    ["a bare JSON number", 42],
    ["a bare JSON null", null],
  ])("returns '0,0' for a 200 with %s", async (_label, body) => {
    expect(await run("Sidmouth", { reply: () => googleJson(body) })).toBe("0,0");
  });

  // NOT a fallback, and pinned here next to the ones that are because the
  // difference is a surprise: `results?.[0]` is a bracket access, not an
  // array index, so a JSON OBJECT keyed "0" is read exactly like a
  // single-element array and the coordinate is honoured. Python's
  // `["results"][0]` uses the integer 0 against a dict whose key is the
  // string "0" and raises KeyError, so Django would return "0,0" for this
  // body. Unreachable from Google, whose `results` is always an array --
  // recorded as the port's actual behaviour, not filed.
  it("honours a results OBJECT keyed '0' where Django would have raised KeyError", async () => {
    const result = await run("Sidmouth", {
      reply: () => googleJson({ results: { 0: { geometry: { location: { lat: 51.46, lng: -0.11 } } } } }),
    });

    expect(result).toBe("51.46,-0.11");
  });

  // The half-a-coordinate cases above are worth one explicit assertion of
  // what they DO NOT return: a partial pair. `${undefined},${lng}` is a
  // perfectly valid template literal, and "undefined,-0.11" would parse,
  // rank and render. The `location?.lat === undefined` guard is the only
  // thing standing between here and that string.
  it("never emits a half-built pair when one coordinate is missing", async () => {
    const latOnly = await run("Sidmouth", { reply: () => googleJson(geocodeBody({ lat: 51.46 })) });

    expect(latOnly).toBe("0,0");
    expect(latOnly).not.toContain("undefined");
    expect(latOnly).not.toContain("51.46");
  });

  // A 200 that is not JSON at all -- Google's edge answering an HTML error
  // page, or a captive portal. This is the one failure that happens INSIDE
  // `.json()`, after the `ok` check has already passed, so it exercises the
  // try/catch rather than either explicit guard.
  it.each([
    ["an HTML error page", "<html><body>502 Bad Gateway</body></html>"],
    ["an empty body", ""],
    ["truncated JSON", '{"results": [{"geometry":'],
  ])("returns '0,0' when a 200 carries %s", async (_label, body) => {
    expect(await run("Sidmouth", { reply: () => new Response(body, { status: 200 }) })).toBe("0,0");
  });

  // fetch itself failing: DNS, TLS, connection reset, or the Workers runtime
  // refusing the subrequest. Django's `requests.get` raises here too and its
  // except clause does NOT list ConnectionError -- so geo.py propagates and
  // the Django view 500s where this returns "0,0". That divergence is
  // deliberate and documented in the module header ("never throws"); it is
  // pinned here because it is the difference between a wrong answer and a
  // dead page, and someone reading only the Python would expect the latter.
  it.each([
    ["a network error", new TypeError("fetch failed")],
    ["a runtime error", new Error("Network connection lost.")],
    ["a thrown non-Error", "boom"],
    ["a thrown null", null],
  ])("returns '0,0' when fetch rejects with %s", async (_label, thrown) => {
    const result = await run("Sidmouth", {
      reply: () => {
        throw thrown;
      },
    });

    expect(result).toBe("0,0");
  });

  // Not "0.0,0.0", not "0, 0", not "". Three characters exactly. Callers
  // parseFloat() it so the arithmetic would survive a change, but the string
  // itself is what a human greps the logs for, and api1.test.ts's B6 test
  // depends on the ranking that this exact value produces.
  it("is exactly the three-character string '0,0'", async () => {
    const result = await run("Sidmouth", { reply: () => googleJson({ results: [] }) });

    expect(result).toBe("0,0");
    expect(result.length).toBe(3);
  });

  // The module header's claim -- "every call site already runs the result
  // through isUk(), which naturally rejects 0,0" -- checked against the REAL
  // isUk() rather than restated. If the UK bounding box were ever widened
  // southwards past the equator, the "no separate geocoding-failed branch is
  // needed" argument would collapse silently and every failed geocode would
  // start returning food banks instead of a 400. This is where that would
  // be caught.
  it("is rejected by the real isUk(), which is the only thing making it safe", async () => {
    const [lat, lng] = (await run("Nowhere", { reply: () => googleJson({ results: [] }) })).split(",").map(Number);

    expect(isUk(lat as number, lng as number)).toBe(false);
  });

  // AND THE COROLLARY, which is the uncomfortable half: (0,0) is a real
  // point on the Earth, so a legitimate Google result of exactly zero is
  // indistinguishable from failure. Nothing in the UK is anywhere near it,
  // so this costs nothing in practice -- but it is the reason the fallback
  // can never be upgraded into a sentinel by widening the check.
  it("is also what a genuine (0,0) result produces -- the sentinel is ambiguous", async () => {
    const real = await run("Gulf of Guinea", { reply: () => googleJson(geocodeBody({ lat: 0, lng: 0 })) });
    const failed = await run("Gulf of Guinea", { reply: () => googleJson({ results: [] }) });

    expect(real).toBe("0,0");
    expect(real).toBe(failed);
  });

  // Statelessness across calls. The module holds nothing between
  // invocations, so a failure does not poison the next lookup and a success
  // is not sticky -- worth pinning because all three callers are hot paths
  // on a long-lived isolate that will serve thousands of requests, and a
  // module-level `let lastResult` added for "caching" would be invisible
  // until two visitors searched different towns in the same isolate.
  it("keeps no state between calls -- a failure does not poison the next lookup", async () => {
    expect(await run("Broken", { reply: () => googleJson(null, 500) })).toBe("0,0");
    expect(await run("Perth", { reply: () => googleJson(geocodeBody({ lat: 56.396, lng: -3.437 })) })).toBe("56.396,-3.437");
    expect(await run("Broken Again", { reply: () => googleJson(null, 500) })).toBe("0,0");
  });
});
