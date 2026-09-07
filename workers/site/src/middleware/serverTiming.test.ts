import { Hono } from "hono";
import type { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { elapsedMs, serverTiming } from "./serverTiming";

// The port of givefood/middleware.py's RenderTime. That Django middleware did
//
//     response.content = response.content.replace(
//         b"PUTTHERENDERTIMEHERE", bytes(str(duration), "utf-8"), 1)
//
// on the body of EVERY response, and PLAN.md §3.5 says explicitly not to port
// that. So this module has two jobs and the tests below split along them:
//
//   1. serverTiming -- a header, and ONLY a header. The reason is not tidiness:
//      touching response.content forces the whole body into memory, which is
//      incompatible with streaming an R2 object straight through (routes/
//      media.ts:164 "STREAMED -- never buffered", the photo migration). Several
//      tests here would fail loudly if a body rewrite ever came back -- one on
//      byte-identical bytes, one on bytes that are not valid UTF-8 (which a
//      decode/re-encode rewrite would silently replace with U+FFFD), and one
//      that would hang on a body that has not arrived yet.
//
//   2. elapsedMs -- the human-facing "Took Nms" in debugcomment.njk (and
//      "{{ render_time_ms }} ms" in admin/page.njk). It is a DELIBERATE
//      divergence from Django's three decimal places, and the module comment
//      explains why (Workers coarsens timers, so the fraction was always
//      exactly ".000" -- decoration that reads like precision). Both halves of
//      that divergence are pinned from a single stubbed clock, so nobody can
//      "restore parity with Django" on one side only.
//
// Worth knowing while reading these: the middleware calls c.header() AFTER the
// response exists, and Hono's Context.header() reacts to that by rebuilding the
// response (`this.#res = createResponseInstance(this.#res.body, this.#res)`,
// hono/dist/context.js). So every response on the site passes through a clone
// purely because this middleware is mounted. Tests below pin the things that
// clone must not damage: multiple Set-Cookie headers, a bodyless 304, a
// redirect's immutable headers, and an un-consumed stream.

const env = {} as unknown as AppEnv["Bindings"];

// performance.now(), not Date.now() -- see the module's own trap comment. The
// tests that care about an exact number drive it from a fixed sequence, which
// also proves the module reads the clock exactly as often as it should: each
// call consumes one entry, so a stray extra read shifts every later assertion.
// Returns the spy so a test can assert the read COUNT directly as well.
function stubClock(readings: [number, ...number[]]) {
  let i = 0;
  return vi.spyOn(performance, "now").mockImplementation(() => readings[Math.min(i++, readings.length - 1)] ?? readings[0]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// A Hono app with the middleware mounted the way index.ts:112 mounts it
// (app.use("*", serverTiming), above everything else) and one route.
function timedApp(handler: (c: Context<AppEnv>) => Response | Promise<Response>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", serverTiming);
  app.get("/", handler);
  return app;
}

describe("serverTiming", () => {
  it("reports the downstream duration as a Server-Timing metric", async () => {
    // Two clock readings: one before next(), one after. 1064.06612 - 1000 is
    // the "Took 64.066ms" from the module comment, so this also pins that the
    // measurement brackets next() rather than starting from request receipt.
    //
    // The metric NAME is load-bearing too: a RUM collector or the devtools
    // timing panel keys off "render", so renaming it to "total" or "worker"
    // would silently orphan whatever is already graphing it. Hence toBe() on
    // the whole header rather than a match on the number.
    const clock = stubClock([1000, 1064.06612]);
    const res = await timedApp((c) => c.text("ok")).request("https://x/", {}, env);
    expect(res.headers.get("Server-Timing")).toBe("render;dur=64.066");
    // Exactly two reads, no more: an implementation that recorded
    // requestStartTime from its own separate performance.now() call would
    // still produce a plausible-looking header here, but would be timing
    // something subtly different from what elapsedMs reports.
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("ignores Date.now() completely, which is the trap the module was written around", async () => {
    // PLAN.md §6.1.6, verbatim: "Date.now() does not advance during code
    // execution on Workers. A literal port reports 0 ms for everything." This
    // is the test for that sentence. Date.now is stubbed to a fixed wall-clock
    // instant -- the shape it really has inside a Worker invocation, frozen --
    // while performance.now advances. A literal port of Django's
    // `time.time()`-style timing would read the frozen clock and report 0.000
    // for every request on the site, forever, with nothing else failing.
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    stubClock([1000, 1064.06612, 1064.06612]);
    const res = await timedApp((c) => c.text(elapsedMs(c))).request("https://x/", {}, env);
    expect(await res.text()).toBe("64");
    expect(res.headers.get("Server-Timing")).toBe("render;dur=64.066");
    expect(dateNow).not.toHaveBeenCalled();
  });

  it("keeps three decimal places, which is what makes the header machine-readable", async () => {
    // The stated divergence: the human string drops its decimals, this one
    // does not, "since that is a machine-readable field where the format is
    // conventional and a consumer may reasonably parse a float". A consumer
    // is a browser devtools panel or an RUM collector, so assert the actual
    // Server-Timing grammar (name;dur=value) and that it survives parseFloat.
    stubClock([1000, 1002.5]);
    const res = await timedApp((c) => c.text("ok")).request("https://x/", {}, env);
    const value = res.headers.get("Server-Timing") ?? "";
    expect(value).toMatch(/^render;dur=\d+\.\d{3}$/);
    expect(Number.parseFloat(value.slice("render;dur=".length))).toBe(2.5);
  });

  it("rounds the third decimal rather than truncating it", async () => {
    // toFixed(3) rounds; a hand-rolled `Math.trunc(d * 1000) / 1000` or a
    // string slice of the raw float -- both plausible rewrites when someone
    // decides toFixed is "slow" or wants to strip the padding -- would report
    // 64.066 here instead of 64.067. Sub-millisecond, but this is the field
    // that is supposed to be the precise one, so it should actually be precise.
    stubClock([1000, 1064.0669]);
    const res = await timedApp((c) => c.text("ok")).request("https://x/", {}, env);
    expect(res.headers.get("Server-Timing")).toBe("render;dur=64.067");
  });

  it("still emits the metric when the whole request took no measurable time", async () => {
    // Not hypothetical: the module comment records that on Workers
    // performance.now() does not advance during synchronous execution, so a
    // cached page really does measure zero. The header must still be there
    // (a missing metric and a zero metric mean different things to a
    // collector), and toFixed(3) must still produce its padding -- a
    // `String(durationMs)` or `Number(d.toFixed(3))` would give a bare "0".
    stubClock([5000, 5000]);
    const res = await timedApp((c) => c.text("ok")).request("https://x/", {}, env);
    expect(res.headers.get("Server-Timing")).toBe("render;dur=0.000");
  });

  it("formats a long request as plain digits, with no thousands separators", async () => {
    // A twenty-minute duration is not realistic for one request, but a
    // four-figure one is (a cold food bank page doing several D1 reads plus a
    // subrequest), and this is where locale-aware formatting shows itself.
    // toLocaleString() would render "1,233,567.891" and "1,233,568" -- the
    // comma breaks the Server-Timing grammar outright, since a comma separates
    // METRICS in that header, so one slow request would look to a collector
    // like two metrics named "render;dur=1" and "233567.891". Both formatters
    // must stay locale-independent (toFixed and String both are; Intl is not).
    stubClock([1000, 1234567.891, 1234567.891]);
    const res = await timedApp((c) => c.text(elapsedMs(c))).request("https://x/", {}, env);
    expect(await res.text()).toBe("1233568");
    expect(res.headers.get("Server-Timing")).toBe("render;dur=1233567.891");
  });

  it("appends to a Server-Timing a route already set, rather than replacing it", async () => {
    // The `{ append: true }` argument. Server-Timing is a comma-separated
    // list of metrics, so a route that times its own D1 query must not lose
    // that metric just because this middleware runs afterwards -- and the
    // failure would be silent, since the header would still look valid.
    stubClock([1000, 1000.135]);
    const app = timedApp((c) => {
      c.header("Server-Timing", "db;dur=5");
      return c.text("ok");
    });
    const res = await app.request("https://x/", {}, env);
    expect(res.headers.get("Server-Timing")).toBe("db;dur=5, render;dur=0.135");
  });

  it("appends to a Server-Timing carried by a Response the handler constructed", async () => {
    // Deliberately NOT the same code path as the test above. c.header() before
    // the response exists writes into Hono's preparedHeaders; a route that
    // returns `new Response(...)` itself (media.ts's R2 passthrough, the shape
    // most likely to want to report its own R2 latency) means this middleware
    // appends to a real, already-built Headers object instead. Only the second
    // path exercises Hono's clone-the-finalized-response branch, so a
    // regression could easily hit one and not the other.
    stubClock([1000, 1002.5]);
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/", () => new Response("ok", { headers: { "Server-Timing": "r2;dur=12.5" } }));
    const res = await app.request("https://x/", {}, env);
    expect(res.headers.get("Server-Timing")).toBe("r2;dur=12.5, render;dur=2.500");
  });

  it("leaves the response body byte-identical, including Django's own placeholder", async () => {
    // The single most important assertion in this file. Django replaced the
    // FIRST PUTTHERENDERTIMEHERE in the body (the `1` count argument); this
    // middleware must not touch either occurrence. If someone ports RenderTime
    // literally after all, this is the test that says no -- and the placeholder
    // is the payload deliberately, so the failure message names the exact
    // Django behaviour being reintroduced.
    //
    // Asserted as BYTES, not as a decoded string. The site serves Welsh and
    // twenty other languages, and a rewrite implemented the obvious way
    // (decode -> String.replace -> re-encode) would pass a text comparison
    // while still having round-tripped every multi-byte character through a
    // decoder. Byte length plus byte content is what actually pins "untouched".
    const body = "<html><!--PUTTHERENDERTIMEHERE ms--><p>Banc bwyd — caffi ☺ PUTTHERENDERTIMEHERE</p></html>";
    const expected = new TextEncoder().encode(body);
    const res = await timedApp((c) => c.html(body)).request("https://x/", {}, env);
    const actual = new Uint8Array(await res.arrayBuffer());
    expect(actual.length).toBe(expected.length);
    expect(actual).toEqual(expected);
    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=/);
  });

  it("does not touch non-HTML bodies either", async () => {
    // Django's replace() ran on image/jpeg and application/json alike -- the
    // PLAN.md line this module was written against calls that out by name.
    // A JSON body that happens to contain the placeholder is the cheapest way
    // to prove the middleware is content-type-blind in the right direction.
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/j", (c) => c.json({ note: "PUTTHERENDERTIMEHERE" }));
    app.get("/i", () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "Content-Type": "image/jpeg" } }));

    const json = await app.request("https://x/j", {}, env);
    expect(await json.json()).toEqual({ note: "PUTTHERENDERTIMEHERE" });
    expect(json.headers.get("Server-Timing")).toMatch(/^render;dur=/);

    const jpeg = await app.request("https://x/i", {}, env);
    expect(new Uint8Array(await jpeg.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    expect(jpeg.headers.get("Server-Timing")).toMatch(/^render;dur=/);
  });

  it("passes through bytes that are not valid UTF-8, even under a text/html type", async () => {
    // The trap the test above cannot spring. A body rewrite that is careful --
    // gated on Content-Type: text/html, exactly as PLAN.md suggests doing it
    // with HTMLRewriter if the visible comment ever has to come back -- still
    // has to decode to search for the placeholder, and TextDecoder replaces
    // every invalid byte with U+FFFD (EF BF BD). 0xC3 0x28 is a truncated
    // two-byte sequence and 0xFF can never appear in UTF-8, so a decode
    // round-trip turns these ten bytes into twelve. Cloudflare's own image
    // resizer output and R2 objects mislabelled text/html both look like this.
    const raw = new Uint8Array([0x3c, 0x70, 0x3e, 0xc3, 0x28, 0xff, 0x3c, 0x2f, 0x70, 0x3e]);
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/", () => new Response(raw, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    const res = await app.request("https://x/", {}, env);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(raw);
  });

  it("returns before a streamed body has produced a single byte", async () => {
    // The anti-buffering test, and the one that catches a rewrite that was
    // careful enough to preserve bytes. routes/media.ts hands back an R2
    // object's ReadableStream; a middleware that read it to rewrite the body
    // could not respond until R2 finished. Here the stream is held shut until
    // after the response has been returned and asserted, so any implementation
    // that awaits the body deadlocks and this test times out.
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    let openTheTap!: () => void;
    const held = new Promise<void>((resolve) => {
      openTheTap = resolve;
    });
    app.get("/photo.jpg", () => {
      const stream = new ReadableStream({
        async pull(controller) {
          await held;
          controller.enqueue(new TextEncoder().encode("R2 OBJECT BODY"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "image/jpeg" } });
    });

    const res = await Promise.race([
      app.request("https://x/photo.jpg", {}, env),
      new Promise<"BUFFERED">((resolve) => setTimeout(() => resolve("BUFFERED"), 500)),
    ]);
    expect(res).not.toBe("BUFFERED");
    const response = res as Response;
    expect(response.headers.get("Server-Timing")).toMatch(/^render;dur=/);

    // And the stream is still the caller's to drain afterwards -- Hono rebuilds
    // the Response around the SAME body when this middleware appends a header,
    // so a change that copied the body instead (or teed it) would leave this
    // reading an already-locked or empty stream.
    openTheTap();
    expect(await response.text()).toBe("R2 OBJECT BODY");
  });

  it("adds the metric to a raw Response the handler built itself", async () => {
    // Response.redirect() produces immutable headers, and several routes
    // return responses this middleware did not construct (slugRedirect's
    // 301s, media.ts's R2 passthrough). If appending to those threw, the
    // middleware would turn a working redirect into a 500 -- so pin that the
    // header lands and the redirect is unharmed.
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/old/", () => Response.redirect("https://x/new/", 301));
    const res = await app.request("https://x/old/", {}, env);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://x/new/");
    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=/);
  });

  it("survives a bodyless 304, which may not be given a body", async () => {
    // media.ts:157 returns `new Response(null, { status: 304 })` when
    // If-None-Match matched the R2 object's etag. Appending a header to that
    // makes Hono rebuild the Response, and the Fetch spec makes constructing a
    // 304 WITH a body a TypeError -- so a rebuild that substituted any body at
    // all (even "") would throw here, and every conditional request for a food
    // bank photo would 500 instead of 304. The etag has to survive too, or the
    // browser's next request cannot be conditional either.
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/photo.jpg", () => new Response(null, { status: 304, headers: { etag: '"abc123"' } }));
    const res = await app.request("https://x/photo.jpg", {}, env);
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"abc123"');
    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=/);
  });

  it("keeps every Set-Cookie separate through the response clone it forces", async () => {
    // Non-obvious and genuinely dangerous. Because this middleware appends a
    // header after the response is finalized, Hono rebuilds EVERY response on
    // the site as `new Response(body, res)`. If that rebuild ever folded the
    // Set-Cookie list into one comma-joined header, two things break at once:
    // lib/adminAuth.ts appends two of them on the same response (clear
    // __Host-oauth at :140, set __Host-gfsession at :305, plus csrf.ts's own
    // at :76), so sign-in would land a single malformed cookie and the admin
    // would be unreachable; and pageCacheControl.ts:125 bails out on
    // `headers.has("Set-Cookie")`, so the count changing is the difference
    // between a private response and a publicly cached one.
    //
    // Both routes below exist because they take different paths through Hono:
    // c.header() writes into preparedHeaders, a hand-built Response does not.
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/via-context", (c) => {
      c.header("Set-Cookie", "__Host-oauth=; Path=/; Max-Age=0", { append: true });
      c.header("Set-Cookie", "__Host-gfsession=abc; Path=/; Secure; HttpOnly", { append: true });
      return c.text("ok");
    });
    app.get("/via-response", () => {
      const h = new Headers();
      h.append("Set-Cookie", "__Host-oauth=; Path=/; Max-Age=0");
      h.append("Set-Cookie", "__Host-gfsession=abc; Path=/; Secure; HttpOnly");
      return new Response("ok", { headers: h });
    });

    for (const path of ["/via-context", "/via-response"]) {
      const res = await app.request(`https://x${path}`, {}, env);
      expect(res.headers.getSetCookie()).toEqual([
        "__Host-oauth=; Path=/; Max-Age=0",
        "__Host-gfsession=abc; Path=/; Secure; HttpOnly",
      ]);
      expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=/);
    }
  });

  it("times 404s too, since app.use('*') covers unmatched paths", async () => {
    // index.ts registers this at app.use("*", serverTiming) above every route,
    // and app.notFound() renders a real 404 page through the same template
    // pipeline -- so a slow 404 is exactly as worth measuring as a slow page.
    const res = await timedApp((c) => c.text("ok")).request("https://x/no-such-page/", {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=/);
  });

  it("still emits the metric when the handler throws", async () => {
    // index.ts pairs this with app.onError -> render500(c), and render500's
    // own comment leans on "same `c`, just caught higher up". Hono resolves
    // next() after its error handler has produced a response rather than
    // rejecting, so the timing of a failed request is recorded like any other
    // -- which is when you most want to know how long it took.
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    app.onError((err, c) => c.text(`sorry: ${err.message}`, 500));
    const res = await app.request("https://x/boom", {}, env);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("sorry: kaboom");
    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=/);
  });

  it("publishes requestStartTime before running the rest of the chain", async () => {
    // types.ts declares requestStartTime on Vars and elapsedMs reads it, so
    // it has to be set BEFORE next() -- not alongside the header afterwards.
    // Every route in the site calls elapsedMs from inside its handler.
    stubClock([4242.5, 9999]);
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/", (c) => c.json({ start: c.get("requestStartTime") }));
    const res = await app.request("https://x/", {}, env);
    expect(await res.json()).toEqual({ start: 4242.5 });
  });

  it("brackets asynchronous downstream work, not just the synchronous part", async () => {
    // Proves the `await` on next(). Every page on the site awaits D1 before it
    // renders, so a dropped await would make the header report the time spent
    // getting as far as the first await -- near zero, on every request, which
    // looks plausible enough that nobody would question it.
    //
    // The reading ORDER is the assertion. With `await next()` the handler's
    // clock read (5000) comes first and the middleware's (9000) second, giving
    // "4000" and dur=8000. Drop the await and the middleware reads 5000 while
    // the handler is still suspended, so the pair swaps to dur=4000 and "8000".
    stubClock([1000, 5000, 9000]);
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return c.text(elapsedMs(c));
    });
    const res = await app.request("https://x/", {}, env);
    expect(await res.text()).toBe("4000");
    expect(res.headers.get("Server-Timing")).toBe("render;dur=8000.000");
  });

  it("gives each request its own start time", async () => {
    // A module-level `const t0` would pass every test above and report
    // ever-growing durations in production. Two requests through one app
    // instance must not share a clock reading. Worth pinning because the
    // Worker isolate outlives the request: a leaked start time would look
    // fine locally and drift upward for hours in production.
    stubClock([1000, 1010, 2000, 2030]);
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/", (c) => c.text("ok"));
    const first = await app.request("https://x/", {}, env);
    const second = await app.request("https://x/", {}, env);
    expect(first.headers.get("Server-Timing")).toBe("render;dur=10.000");
    expect(second.headers.get("Server-Timing")).toBe("render;dur=30.000");
  });
});

describe("elapsedMs", () => {
  it("returns whole milliseconds, the deliberate divergence from Django", async () => {
    // Django's RenderTime did round(duration * 1000, 3) and debugcomment.html
    // rendered "Took 64.066ms". This prints "Took 64ms" on purpose: on Workers
    // those three digits were always ".000", and the module comment argues
    // that fake precision is worse than none. Assert there is no "." at all,
    // so a well-meaning toFixed(3) "for parity with Django" cannot slip back.
    //
    // Safe against the parity harness, which is why the divergence was
    // allowed: PLAN.md:11039 scrubs `Took [\d.]+ms` before diffing, and that
    // pattern matches "Took 64ms" as happily as "Took 64.066ms".
    stubClock([1000, 1064.06612, 1064.06612]);
    const res = await timedApp((c) => c.text(elapsedMs(c))).request("https://x/", {}, env);
    const rendered = await res.text();
    expect(rendered).toBe("64");
    expect(rendered).not.toContain(".");
  });

  it("rounds half UP -- towards +Infinity, which is not the same as away from zero", async () => {
    // Math.round's actual rule, and the two directions differ on negatives:
    // Math.round(-1.5) is -1, not -2. Worth pinning explicitly because the
    // obvious "equivalent" rewrites are not equivalent -- Math.trunc rounds
    // 64.6 down to 64, and Math.sign(d) * Math.round(Math.abs(d)) turns -1.5
    // into -2. Django's own round() is different again (banker's rounding, so
    // Python's round(64.5) is 64), but the module has already left Django's
    // format behind here, so JS semantics are the ones to pin.
    //
    // Readings 2-5 are BEFORE the recorded start. performance.now() is
    // deliberately coarsened on Workers, so a tiny backwards step is not
    // unthinkable, and the -0 case matters: Math.round(-0.4) is -0, whose
    // String() is "0". If that ever became "-0" the debug comment would read
    // "Took -0ms", which looks like a bug in the site to anyone who saw it.
    stubClock([1000, 1064.4, 1064.5, 1064.6, 999.6, 999.5, 998.5, 998.6]);
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/", (c) => c.json([elapsedMs(c), elapsedMs(c), elapsedMs(c), elapsedMs(c), elapsedMs(c), elapsedMs(c), elapsedMs(c)]));
    const res = await app.request("https://x/", {}, env);
    //                             +64.4  +64.5  +64.6  -0.4   -0.5   -1.5   -1.4
    expect(await res.json()).toEqual(["64", "65", "65", "0", "0", "-1", "-1"]);
  });

  it("reports a backwards clock rather than clamping it to zero", async () => {
    // Current behaviour, documented not endorsed: nothing floors either output
    // at zero, so a start time later than the end time produces "Took -1ms" in
    // the debug comment and `render;dur=-1.400` in the header -- and a negative
    // dur is outside what the Server-Timing grammar leads a collector to
    // expect. It cannot happen while one middleware chain owns requestStartTime
    // on a monotonic clock; it becomes reachable the moment anything else sets
    // that variable (a sub-app mounting its own serverTiming, a test harness
    // seeding it). Pinned so that adding a clamp is a visible decision rather
    // than an incidental change.
    stubClock([1000, 998.6, 998.6]);
    const res = await timedApp((c) => c.text(elapsedMs(c))).request("https://x/", {}, env);
    expect(await res.text()).toBe("-1");
    expect(res.headers.get("Server-Timing")).toBe("render;dur=-1.400");
  });

  it("treats a requestStartTime of exactly 0 as a real start time", async () => {
    // The falsy-zero trap. performance.now() is relative to the start of the
    // isolate's time origin, so the very first request an isolate serves can
    // legitimately read a value at or near 0. Any defensive rewrite of the
    // form `c.get("requestStartTime") || performance.now()` -- an easy thing
    // to reach for after seeing the "NaN" behaviour two tests below -- would
    // turn that request's timing into a flat 0ms instead of 5ms, silently, and
    // only on the requests that pay the cold-start cost worth measuring.
    stubClock([0, 5, 9]);
    const res = await timedApp((c) => c.text(elapsedMs(c))).request("https://x/", {}, env);
    expect(await res.text()).toBe("5");
    expect(res.headers.get("Server-Timing")).toBe("render;dur=9.000");
  });

  it("always returns a string, because debugcomment.njk interpolates it raw", async () => {
    // render_time_ms goes straight into "⏱️ Took {{ render_time_ms }}ms" and
    // into admin/page.njk's "{{ render_time_ms }} ms". A number would render
    // identically today, so nothing else would catch a change of return type --
    // but the callers all spread it into a template context typed as strings
    // (routes/*.ts, renderErrorPage.ts:25).
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/", (c) => {
      const value = elapsedMs(c);
      return c.json({ type: typeof value, matchesInteger: /^\d+$/.test(value) });
    });
    const res = await app.request("https://x/", {}, env);
    expect(await res.json()).toEqual({ type: "string", matchesInteger: true });
  });

  it("measures from the middleware's start, not from the call site", async () => {
    // The whole point of reading requestStartTime instead of each route timing
    // itself: the number must mean what Django's meant -- view + DB + template
    // render -- so work done by earlier middleware (resolveLanguage, the D1
    // reads a route does before rendering) is inside it. Both readings here
    // are taken from one start, so the second must be the larger.
    stubClock([1000, 1005, 1080, 1080]);
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/", (c) => c.json({ early: elapsedMs(c), late: elapsedMs(c) }));
    const res = await app.request("https://x/", {}, env);
    expect(await res.json()).toEqual({ early: "5", late: "80" });
  });

  it("produces the string 'NaN' if serverTiming never ran", async () => {
    // NOT an endorsement -- a documentation test. render500.ts:16 reasons in
    // prose that requestStartTime "is already set on `c`" because serverTiming
    // is the first app.use("*") in index.ts, and this is what the alternative
    // looks like: "⏱️ Took NaNms" served inside every page's debug comment,
    // with no exception thrown anywhere to point at the cause. The 200 status
    // is the assertion that matters -- the page renders perfectly, so nothing
    // in monitoring would ever surface this. That makes the registration order
    // in index.ts load-bearing, which is easy to forget when adding a new Hono
    // sub-app that mounts its own middleware stack.
    const app = new Hono<AppEnv>();
    app.get("/", (c) => c.text(elapsedMs(c)));
    const res = await app.request("https://x/", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("NaN");
  });

  it("agrees with the Server-Timing header on the same request", async () => {
    // The two halves of the divergence, from one clock, in one request: the
    // machine-readable header keeps its decimals and the human string is the
    // rounded whole of the same elapsed time. A change to either format that
    // did not think about the other one breaks this. The 64.6 -> "65" pairing
    // is chosen so that a truncating rewrite of elapsedMs would show up as a
    // mismatch rather than an off-by-nothing.
    stubClock([1000, 1064.6, 1064.6]);
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.get("/", (c) => c.text(elapsedMs(c)));
    const res = await app.request("https://x/", {}, env);
    expect(await res.text()).toBe("65");
    expect(res.headers.get("Server-Timing")).toBe("render;dur=64.600");
  });
});
