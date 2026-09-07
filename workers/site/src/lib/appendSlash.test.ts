import { Hono } from "hono";
import type { ExecutionContext } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { tryAppendSlashRedirect } from "./appendSlash";

// This helper is the whole of Django's APPEND_SLASH on the Workers side.
// `givefood/settings.py:23` sets `APPEND_SLASH = True`, so every slashless
// request to a slash URL on givefood.org.uk has 301'd for years -- search
// engines and third-party API consumers have those redirects baked in. There
// is no Cloudflare platform equivalent (PLAN.md §6.1.5: Static Assets'
// force-trailing-slash only rewrites ASSET lookups, and would silently do
// nothing for the 3,000+ food bank URLs that actually need this), so if these
// tests go red the redirects are simply gone from the live site.
//
// Every test drives a REAL Hono app through `app.notFound()`, because that is
// this helper's only caller and because the probe re-enters the same router --
// a mock router would not exercise the re-entrancy, which is where the two
// historical bugs (givefood/givefood2#3 and the crawl-set 301) both lived.

const env = { TEST_BINDING: "kv-value" } as unknown as AppEnv["Bindings"];

function makeCtx() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } satisfies ExecutionContext;
}

/**
 * Builds an app whose notFound() calls the helper exactly the way index.ts
 * does, and records what the helper actually returned -- `null` and "a 404
 * response" are different answers from this function, and only the raw return
 * value tells them apart.
 */
function buildApp(register: (app: Hono<AppEnv>) => void) {
  const app = new Hono<AppEnv>();
  register(app);
  const calls: (Response | null)[] = [];
  app.notFound(async (c) => {
    const redirect = await tryAppendSlashRedirect(c, app);
    calls.push(redirect);
    return redirect ?? c.text("the real 404 page", 404);
  });
  const ctx = makeCtx();
  return {
    app,
    ctx,
    calls,
    fetch: (url: string, method = "GET", headers?: Record<string, string>) =>
      app.fetch(new Request(url, { method, headers }), env, ctx),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tryAppendSlashRedirect", () => {
  it("301s a slashless URL whose slashed twin resolves", async () => {
    // The documented happy path, and the exact case confirmed broken live on
    // beta.givefood.org.uk in givefood/givefood2#3. 301 is not incidental:
    // Django's CommonMiddleware uses HttpResponsePermanentRedirect
    // (django/middleware/common.py: `response_redirect_class`), and a
    // "tidy-up" to 302/308 would change what every crawler has cached.
    const h = buildApp((app) => app.get("/about-us/", (c) => c.text("about us")));
    const res = await h.fetch("https://www.givefood.org.uk/about-us");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://www.givefood.org.uk/about-us/");
    // The 301 is the helper's OWN return value, not buildApp's fallback -- and
    // exactly one pass through notFound() happened, so the probe was answered
    // by the real route rather than falling through and probing again.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.status).toBe(301);
  });

  it("never runs at all for a slashless URL that resolves on its own", async () => {
    // Django parity, and the reason this lives in app.notFound() rather than
    // in middleware: CommonMiddleware.process_response() only considers
    // APPEND_SLASH `if response.status_code == 404`. So a URL that resolves
    // without a trailing slash is served, never redirected, even when a
    // slashed twin also exists. Every file-suffixed route on the site is
    // exactly that shape -- /robots.txt, /manifest.json, /llms.txt and
    // /.well-known/security.txt are all registered slashless in index.ts
    // (420, 421, 439, 440) -- so if the check ever moved into a `use("*")`
    // middleware they would all start 301'ing to a slashed URL that either
    // 404s or, worse, serves an HTML page instead of the file.
    const h = buildApp((app) => {
      app.get("/robots.txt", (c) => c.text("User-agent: *"));
      app.get("/robots.txt/", (c) => c.text("a page that must never be redirected to"));
    });
    const res = await h.fetch("https://www.givefood.org.uk/robots.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("User-agent: *");
    expect(h.calls).toEqual([]); // the helper was never consulted
  });

  it("appends the slash to the path only, keeping the query string byte-for-byte after it", async () => {
    // `slashed.pathname += "/"` rather than string-concatenating the href.
    // Concatenating would produce `/needs/at/sid-valley?utm_source=x/`, which
    // sends the tracking parameter into the slug and 404s -- and campaign
    // links to food bank pages arrive with UTM parameters constantly. Django
    // splits it the same way: get_full_path(force_append_slash=True) appends
    // to the path and re-attaches the query string untouched.
    const h = buildApp((app) => app.get("/needs/at/:slug/", (c) => c.text("needs")));
    const res = await h.fetch("https://www.givefood.org.uk/needs/at/sid-valley?utm_source=x&utm_medium=y");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://www.givefood.org.uk/needs/at/sid-valley/?utm_source=x&utm_medium=y");

    // "Untouched" means the raw string, never a re-serialisation. Rebuilding
    // the query through URLSearchParams reads as equivalent and is not: it
    // turns a valueless `flag` into `flag=`, decodes `sp%61ce` to `space` and
    // normalises `%2B`. Every component below is chosen to survive the real
    // implementation and change under that rewrite, so this assertion is what
    // stops a "tidy-up" refactor from silently rewriting the query strings of
    // /aac/ searches and UTM-tagged campaign links.
    const gnarly = "?q=a%2Bb&q=2&flag&sp%61ce=x+y";
    const res2 = await h.fetch(`https://www.givefood.org.uk/needs/at/sid-valley${gnarly}`);
    expect(res2.headers.get("location")).toBe(`https://www.givefood.org.uk/needs/at/sid-valley/${gnarly}`);
    expect(new URLSearchParams(gnarly).toString()).not.toBe(gnarly.slice(1)); // the rewrite really would differ
  });

  it("keeps the request's own scheme, host and port in the Location", async () => {
    // Location is absolute and derived from c.req.url, so beta, preview and
    // localhost deploys redirect to themselves. A hardcoded www.givefood.org.uk
    // would bounce every staging request onto production. (Django emits a
    // path-only Location here; absolute is a harmless divergence, but pin it
    // so a change to relative is a deliberate one.)
    const h = buildApp((app) => app.get("/about-us/", (c) => c.text("about us")));
    const res = await h.fetch("https://beta.givefood.org.uk:8787/about-us");
    expect(res.headers.get("location")).toBe("https://beta.givefood.org.uk:8787/about-us/");
  });

  it("cannot be turned into an open redirect by a protocol-relative path", async () => {
    // The one place the absolute Location above is not merely cosmetic.
    // `//evil.example/foo` is a legal same-origin PATH, but as a Location
    // VALUE it is a protocol-relative URL: a browser handed
    // `Location: //evil.example/foo/` leaves givefood.org.uk entirely. Django
    // guards this explicitly -- CommonMiddleware.get_full_path_with_slash()
    // runs the new path through escape_leading_slashes() precisely because
    // its Location is path-only. This port is immune for a different reason:
    // the Location is built from `new URL(c.req.url)`, so the host comes from
    // the request and an attacker-supplied path can only ever appear after
    // it. That immunity is a property of the absolute form, so it has to be
    // re-checked if anyone ever "simplifies" the Location to a path.
    const h = buildApp((app) => app.get("//evil.example/foo/", (c) => c.text("still us")));
    const res = await h.fetch("https://www.givefood.org.uk//evil.example/foo");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://www.givefood.org.uk//evil.example/foo/");
    expect(new URL(res.headers.get("location")!).host).toBe("www.givefood.org.uk");
  });

  it("passes the encoded path through untouched -- neither re-encoding nor decoding it", async () => {
    // Food bank slugs are ASCII today, but the redirect must survive any
    // percent-encoded path: re-encoding would turn %C3%A9 into %25C3%25A9 and
    // 404 the slashed URL it just redirected to.
    let seenSlug = "";
    const h = buildApp((app) =>
      app.get("/needs/at/:slug/", (c) => {
        seenSlug = c.req.param("slug");
        return c.text("needs");
      }),
    );
    const res = await h.fetch("https://www.givefood.org.uk/needs/at/caf%C3%A9-trust");
    expect(res.headers.get("location")).toBe("https://www.givefood.org.uk/needs/at/caf%C3%A9-trust/");
    expect(seenSlug).toBe("café-trust"); // the probe decoded it correctly too

    // %C3%A9 alone only proves the ROUND TRIP is clean, and a decode-then-
    // reassign implementation (`pathname = decodeURIComponent(pathname) + "/"`)
    // round-trips it perfectly -- accented characters re-encode to exactly
    // what they were. These three do not survive that, which is what makes
    // them the assertions worth having:
    //
    //   %2F  a literal `/` inside ONE segment. Decoding promotes it to a path
    //        separator, so the 301 lands on a different route entirely.
    //   %25  a literal `%`. Decoding yields a bare `%`, i.e. a Location that
    //        is no longer a valid percent-encoding at all.
    //   %zz  not a valid escape. decodeURIComponent THROWS URIError on it, and
    //        a throw inside notFound() is index.ts's 500 page -- so a crawler
    //        sending one malformed URL would take out the append-slash path.
    //        The real implementation never decodes, so it simply 301s.
    for (const [path, expected] of [
      ["/needs/at/a%2Fb", "/needs/at/a%2Fb/"],
      ["/needs/at/100%25", "/needs/at/100%25/"],
      ["/needs/at/caf%zz", "/needs/at/caf%zz/"],
    ]) {
      const hazard = await h.fetch(`https://www.givefood.org.uk${path}`);
      expect(hazard.status, `${path} should still 301`).toBe(301);
      expect(hazard.headers.get("location")).toBe(`https://www.givefood.org.uk${expected}`);
    }
  });

  it("redirects HEAD as well as GET", async () => {
    // HEAD is explicitly in the allowed set. Hono answers HEAD by dispatching
    // GET and wrapping the result in `new Response(null, res)`, so the check
    // worth making is that the Location header survives that wrapper -- a HEAD
    // that 301s with no Location is a dead end for the crawlers that use it.
    const h = buildApp((app) => app.get("/about-us/", (c) => c.text("about us")));
    const res = await h.fetch("https://www.givefood.org.uk/about-us", "HEAD");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://www.givefood.org.uk/about-us/");
  });

  it("leaves POST, PUT, PATCH, DELETE and OPTIONS alone without even probing", async () => {
    // The module comment's stated deviation. Django with DEBUG=False (which is
    // what givefood/settings.py:7 sets) redirects these too, and the request
    // body is dropped on the way -- django/middleware/common.py only refuses,
    // via RuntimeError, when DEBUG is True. Returning null here means the POST
    // gets an honest 404 instead of being silently re-issued as a bodyless GET
    // against the slashed URL.
    //
    // `handlerRuns` is the assertion that matters, and the answer alone does
    // not give it: an implementation that probed FIRST and only then filtered
    // on the method would still return null and still 404, while having
    // re-dispatched the request into the router -- exactly the "re-running a
    // mutating request" the guard exists to prevent. Zero runs proves the
    // method check happens before `app.fetch`.
    let handlerRuns = 0;
    const h = buildApp((app) =>
      app.get("/about-us/", (c) => {
        handlerRuns += 1;
        return c.text("about us");
      }),
    );
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await h.fetch("https://www.givefood.org.uk/about-us", method);
      expect(res.status, `${method} must not be redirected`).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(h.calls).toEqual([null, null, null, null, null]);
    expect(handlerRuns).toBe(0);

    // The control: same app, same URL, GET. It 301s and it does dispatch, so
    // the method is demonstrably the only reason the five above did neither.
    expect((await h.fetch("https://www.givefood.org.uk/about-us")).status).toBe(301);
    expect(handlerRuns).toBe(1);
  });

  it("never touches a URL that already ends in a slash, including the site root", async () => {
    // The guard that stops the probe recursing: a slashed URL that 404s must
    // not be probed as `//`. Without it every genuine 404 on the site becomes
    // an infinite chain of self-probes.
    //
    // The route below exists only so that a recursing implementation would be
    // caught doing it: `//` is what an unguarded probe of `/` would ask for,
    // and `/no-such-page//` what it would ask for the second URL. Neither may
    // ever be dispatched. The call-count assertion catches the sloppier
    // version of the guard too -- `url.href.endsWith("/")` is false for
    // `/no-such-page/?q=1` (the query is last), so it would probe and push a
    // third entry.
    let hazardRuns = 0;
    const h = buildApp((app) => {
      app.get("//", (c) => {
        hazardRuns += 1;
        return c.text("probed a doubled slash");
      });
      app.get("/no-such-page//", (c) => {
        hazardRuns += 1;
        return c.text("probed a doubled slash");
      });
    });
    expect((await h.fetch("https://www.givefood.org.uk/")).status).toBe(404);
    expect((await h.fetch("https://www.givefood.org.uk/no-such-page/?q=1")).status).toBe(404);
    // A bare origin: the URL parser normalises it to a pathname of "/", so it
    // takes the same exit rather than being probed as "" -> "/".
    expect((await h.fetch("https://www.givefood.org.uk")).status).toBe(404);
    expect(h.calls).toEqual([null, null, null]);
    expect(hazardRuns).toBe(0);
  });

  it("returns null, and stops, when the slashed twin is also missing", async () => {
    // A genuinely nonexistent URL must reach the real 404 page. The call count
    // is the load-bearing assertion: exactly two passes through notFound() --
    // the original request, then the slashed probe, which bails on the
    // trailing-slash guard rather than probing again.
    const h = buildApp((app) => app.get("/about-us/", (c) => c.text("about us")));
    const res = await h.fetch("https://www.givefood.org.uk/no-such-page");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("the real 404 page");
    expect(h.calls).toEqual([null, null]);
  });

  it("returns null when the slashed twin is a notPortedYet 501", async () => {
    // Why 501 sits alongside 404 in the suppression list: routes/notPortedYet.ts
    // answers 501 for a path PLAN.md specifies but this build has not shipped.
    // Redirecting into one would turn a slashless URL's honest 404 into a 301
    // that lands on "not ported yet" -- worse for crawlers than either answer
    // on its own, since 501 reads as "server broken, retry later".
    const h = buildApp((app) => app.get("/unbuilt/", (c) => c.text("givefood: x is not ported yet (see PLAN.md)", 501)));
    expect((await h.fetch("https://www.givefood.org.uk/unbuilt/")).status).toBe(501); // the twin really does resolve
    const res = await h.fetch("https://www.givefood.org.uk/unbuilt");
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(h.calls.at(-1)).toBeNull();
  });

  it("redirects when the slashed twin answers with anything other than 404 or 501", async () => {
    // Only 404 and 501 mean "there is nothing at this URL". A 403 from the
    // admin gate, or a 500 from a broken handler, still means the URL exists,
    // so the slashless form should still be corrected rather than 404'd --
    // otherwise a transient D1 outage would start emitting 404s for real pages
    // and crawlers would begin dropping them from the index.
    vi.spyOn(console, "error").mockImplementation(() => {}); // hono logs the thrown error
    const h = buildApp((app) => {
      app.get("/admin/crawl/", (c) => c.text("forbidden", 403));
      app.get("/broken/", () => {
        throw new Error("D1 unavailable");
      });
      app.get("/moved/", (c) => c.redirect("/elsewhere/", 302));
    });
    for (const path of ["/admin/crawl", "/broken", "/moved"]) {
      const res = await h.fetch(`https://www.givefood.org.uk${path}`);
      expect(res.status, `${path} should still be corrected`).toBe(301);
      expect(res.headers.get("location")).toBe(`https://www.givefood.org.uk${path}/`);
    }
  });

  it("suppresses on exactly two statuses -- 404 and 501 -- and nothing adjacent to them", async () => {
    // The test above proves three statuses redirect; this one proves the rule
    // is an equality check on two values rather than a range that happens to
    // agree on those three. Every plausible loosening is a live-site bug that
    // the three-status version would not catch:
    //
    //   `probe.status >= 400`        -> /dumps and every other 410 stops
    //                                   redirecting (routes/notPortedYet.ts
    //                                   gone(), mounted at /dumps in
    //                                   index.ts:594)
    //   `probe.status !== 404`       -> a 501 gets redirected into, the exact
    //                                   thing the 501 arm was added for
    //   `probe.status < 500`         -> a slashed twin that is briefly 502/503
    //                                   during a D1 blip starts 404'ing real
    //                                   pages to crawlers
    //   `!probe.ok`                  -> everything 4xx/5xx stops redirecting
    //
    // 500 and 502 flank 501, and 403/405 flank 404, so an off-by-one in either
    // arm shows up here.
    const redirecting = [200, 204, 301, 302, 400, 401, 403, 405, 410, 429, 500, 502, 503];
    for (const status of redirecting) {
      const h = buildApp((app) => app.get("/x/", () => new Response(status === 204 ? null : "body", { status })));
      const res = await h.fetch("https://www.givefood.org.uk/x");
      expect(res.status, `a ${status} twin means the URL exists, so /x must still 301`).toBe(301);
      expect(res.headers.get("location")).toBe("https://www.givefood.org.uk/x/");
    }
    for (const status of [404, 501]) {
      const h = buildApp((app) => app.get("/x/", () => new Response("body", { status })));
      const res = await h.fetch("https://www.givefood.org.uk/x");
      expect(res.status, `a ${status} twin means nothing is there, so /x must 404`).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(h.calls.at(-1)).toBeNull();
    }
  });

  it("does not redirect when the slashed route exists but its handler 404s", async () => {
    // A real divergence from Django, and the better behaviour. Django's
    // CommonMiddleware.should_redirect_with_slash() calls is_valid_path(), which
    // only RESOLVES the URLconf -- it never runs the view -- so Django 301s
    // /needs/at/not-a-foodbank to the slashed form and only then serves a 404.
    // This helper dispatches the probe for real, sees the handler's own 404 and
    // skips the pointless hop. If a future refactor swaps the dispatch for
    // PLAN.md §6.1.5's `app.router.match(...)` sketch, this test goes red.
    const h = buildApp((app) => {
      app.get("/needs/at/sid-valley/", (c) => c.text("Sid Valley needs"));
      app.get("/needs/at/:slug/", (c) => c.notFound()); // every other slug: no such food bank
    });
    // Same route shape, same append-slash path -- the ONLY difference is what
    // the handler answers, so this pair isolates "resolves" from "matches".
    expect((await h.fetch("https://www.givefood.org.uk/needs/at/sid-valley")).status).toBe(301);
    const res = await h.fetch("https://www.givefood.org.uk/needs/at/not-a-foodbank");
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(h.calls.at(-1)).toBeNull();
  });

  it("does not redirect to a slashed route that only accepts POST", async () => {
    // The probe is issued as HEAD, which Hono dispatches as GET, so a
    // POST-only endpoint looks like nothing at all. Django would 301 here
    // (is_valid_path is method-blind) and the follow-up GET would then 405.
    const h = buildApp((app) => app.post("/subscribe/", (c) => c.text("subscribed")));
    expect((await h.fetch("https://www.givefood.org.uk/subscribe/", "POST")).status).toBe(200); // the twin exists, for POST
    const res = await h.fetch("https://www.givefood.org.uk/subscribe");
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(h.calls.at(-1)).toBeNull();
  });

  it("really dispatches the slashed route -- middleware and all -- rather than only matching the router", async () => {
    // Pins the cost, not just the answer: the probe executes the whole stack
    // for the target route (one extra D1/KV round trip per slashless hit on a
    // real page). That is the price of the "handler 404s" accuracy above, so
    // anyone optimising the dispatch down to a router match needs to know they
    // are changing that test's behaviour at the same time.
    //
    // The middleware counter is the part worth stating out loud: the probe is
    // a full second trip through `use("*")`, so anything the site's middleware
    // does per request (server-timing, cache tags, analytics) happens twice
    // for one slashless hit -- and a THIRD time when the client follows the
    // 301. Any handler reached this way therefore has to be idempotent; that
    // is why the side-effecting endpoints are POST (/needs/at/:slug/hit/) and
    // why a GET one that ever mutates would be double-counted here.
    let handlerRuns = 0;
    let middlewareRuns = 0;
    const h = buildApp((app) => {
      app.use("*", async (_c, next) => {
        middlewareRuns += 1;
        await next();
      });
      app.get("/about-us/", (c) => {
        handlerRuns += 1;
        return c.text("about us");
      });
    });
    const res = await h.fetch("https://www.givefood.org.uk/about-us");
    expect(handlerRuns).toBe(1); // the probe ran it, before any client followed anything
    expect(middlewareRuns).toBe(2); // the slashless request, then the probe

    await h.fetch(res.headers.get("location")!);
    expect(handlerRuns).toBe(2);
    expect(middlewareRuns).toBe(3);
  });

  it("forwards env and executionCtx to the probe", async () => {
    // Not cosmetic. `c.executionCtx` THROWS when the app was fetched without
    // one, and index.ts turns any throw inside notFound() into a 500 -- which
    // is not 404 or 501, so the caller would happily 301. Dropping either
    // argument therefore fails as a *silent 301 on every slashless URL*,
    // including ones that do not exist. Bindings matter for the same reason:
    // a probe that cannot reach D1 answers 500 and redirects regardless.
    let seenBinding: unknown;
    let ctxIsSame = false;
    const h = buildApp((app) =>
      app.get("/about-us/", (c) => {
        seenBinding = (c.env as unknown as Record<string, string>).TEST_BINDING;
        ctxIsSame = c.executionCtx === h.ctx;
        c.executionCtx.waitUntil(Promise.resolve());
        return c.text("about us");
      }),
    );
    const res = await h.fetch("https://www.givefood.org.uk/about-us");
    expect(res.status).toBe(301);
    expect(seenBinding).toBe("kv-value");
    expect(ctxIsSame).toBe(true);
    expect(h.ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("probes with a bare bodyless HEAD, dropping every header the original request carried", async () => {
    // `new Request(slashed, { method: "HEAD" })` copies nothing but the URL, so
    // the probe is anonymous: no cookies, no Accept-Language, no CF headers.
    // For an auth-gated slashed route that means the probe sees the signed-out
    // response -- fine while that is a 403 (still redirects, per the test
    // above), but a gate that answers 404 to strangers would silently lose its
    // append-slash redirect for signed-in admins.
    //
    // Asserted as "no headers AT ALL" rather than "no cookie", because the
    // half-forwarding version is the one someone would actually write: passing
    // `headers: c.req.raw.headers` through, or forwarding just Accept-Language
    // or CF-Connecting-IP "so the probe looks like the real request", would
    // satisfy a cookie-only check while handing an unauthenticated probe
    // whatever those headers unlock. The method and the null body are pinned
    // here too -- together they are the module's "avoid re-running a mutating
    // request" promise, and a probe that inherited the original's method or
    // body would break it without changing any status this file asserts.
    let probeHeaders: [string, string][] | undefined;
    let probeMethod: string | undefined;
    let probeHadBody: boolean | undefined;
    const h = buildApp((app) =>
      app.get("/admin/needs/", (c) => {
        probeHeaders = [...c.req.raw.headers];
        probeMethod = c.req.method;
        probeHadBody = c.req.raw.body !== null;
        return c.text("needs admin");
      }),
    );
    const res = await h.fetch("https://www.givefood.org.uk/admin/needs", "GET", {
      cookie: "gfsession=abc123",
      "accept-language": "cy",
      "cf-connecting-ip": "203.0.113.7",
    });
    expect(res.status).toBe(301);
    expect(probeHeaders).toEqual([]);
    expect(probeMethod).toBe("HEAD");
    expect(probeHadBody).toBe(false);
  });

  it("propagates rather than swallows a context with no ExecutionContext", async () => {
    // The helper reads `c.executionCtx` unconditionally to forward it, and
    // Hono's getter THROWS ("This context has no ExecutionContext") when the
    // app was fetched without one. So in that environment a slashless URL
    // produces index.ts's 500 page, not a redirect and not the 404 page.
    //
    // Worth pinning because the alternative -- wrapping the read in a
    // try/catch or an `undefined` fallback to "make it robust" -- is strictly
    // worse: the probe would then hit a handler whose own `c.executionCtx`
    // throws, Hono would turn that into a 500, and 500 is neither 404 nor 501,
    // so EVERY slashless URL would 301, including ones that do not exist. A
    // loud failure here is the thing that keeps that from being silent.
    const app = new Hono<AppEnv>();
    app.get("/about-us/", (c) => c.text("about us"));
    let rejection: unknown;
    app.notFound(async (c) => {
      try {
        return (await tryAppendSlashRedirect(c, app)) ?? c.text("the real 404 page", 404);
      } catch (err) {
        rejection = err;
        throw err;
      }
    });
    app.onError((err, c) => c.text(`500: ${(err as Error).message}`, 500));

    const res = await app.fetch(new Request("https://www.givefood.org.uk/about-us"), env);
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull(); // never a blind 301
    expect((rejection as Error).message).toMatch(/ExecutionContext/);
  });

  it("probes the app it is handed, not the one that produced the context", async () => {
    // Why `app` is a parameter rather than read off the context: the helper was
    // extracted precisely so a second caller could pass the ROOT app while
    // handling a request inside a sub-app. index.ts is the only caller today,
    // but the parameterisation is the fix for givefood/givefood2#3 and should
    // not be quietly collapsed back into reading the router off `c`.
    const rootApp = new Hono<AppEnv>();
    rootApp.get("/about-us/", (c) => c.text("about us"));
    const subApp = new Hono<AppEnv>();
    subApp.notFound(async (c) => (await tryAppendSlashRedirect(c, rootApp)) ?? c.text("sub 404", 404));
    const res = await subApp.fetch(new Request("https://www.givefood.org.uk/about-us"), env, makeCtx());
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://www.givefood.org.uk/about-us/");
  });

  it("is shadowed by a catch-all that answers directly, but not by one that delegates", async () => {
    // givefood/givefood2#3, reproduced. A catch-all mount is a MATCHED route as
    // far as Hono's router is concerned, so `app.all("*", ...)` answering 501
    // itself means notFound() -- and therefore this helper -- never runs, and
    // every ported route requested without its trailing slash 501s instead of
    // redirecting. gone()'s `app.all("*", (c) => c.notFound())` was never
    // affected because it delegates. The catch-alls are gone from index.ts, so
    // this test exists to make the trap fail loudly if one comes back.
    const build = (catchAll: "answers" | "delegates") =>
      buildApp((app) => {
        app.get("/about-us/", (c) => c.text("about us"));
        app.all("*", (c) => (catchAll === "answers" ? c.text("not ported yet", 501) : c.notFound()));
      });

    const shadowed = build("answers");
    const shadowedRes = await shadowed.fetch("https://www.givefood.org.uk/about-us");
    expect(shadowedRes.status).toBe(501);
    expect(shadowedRes.headers.get("location")).toBeNull();
    expect(shadowed.calls).toEqual([]); // the helper was never reached at all

    const delegating = build("delegates");
    const delegatingRes = await delegating.fetch("https://www.givefood.org.uk/about-us");
    expect(delegatingRes.status).toBe(301);
    expect(delegatingRes.headers.get("location")).toBe("https://www.givefood.org.uk/about-us/");
  });

  it("has no exemption for file-suffixed URLs, which is why crawlSet.ts sidesteps it", async () => {
    // The crawl-set bug in PLAN.md §Phase 9, reproduced as a contract test.
    // The rule here is only "does the slashed URL resolve" -- there is no
    // notion that `crawl-set/<id>.json` is a file-suffixed resource that
    // deliberately has no trailing slash (Django's own pattern has none). So
    // when a looser sibling route happens to swallow the slashed form, a
    // legitimate 404 becomes a wrong 301 pointing at an HTML page.
    //
    // Route patterns copied from routes/admin/index.ts:194-282 and 282's own
    // comment: Hono needs the ".json" inside the regex block, so the id and
    // suffix are captured together.
    const hazard = buildApp((app) => {
      app.get("/admin/crawl-set/:id/", (c) => c.text(`detail page for ${c.req.param("id")}`));
      app.get("/admin/crawl-set/:idJson{[0-9]+\\.json}", (c) => c.notFound()); // the version that shipped first
    });
    expect((await hazard.fetch("https://www.givefood.org.uk/admin/crawl-set/99.json")).status).toBe(301);

    // routes/admin/crawlSet.ts's fix: return a plain 404 Response instead of
    // c.notFound(), so the request never reaches app.notFound() and this
    // helper never sees it. Nothing in appendSlash.ts enforces that -- it is a
    // caller-side discipline, and this test is where it is written down.
    const fixed = buildApp((app) => {
      app.get("/admin/crawl-set/:id/", (c) => c.text(`detail page for ${c.req.param("id")}`));
      app.get("/admin/crawl-set/:idJson{[0-9]+\\.json}", (c) => c.text("Not Found", 404));
    });
    const res = await fixed.fetch("https://www.givefood.org.uk/admin/crawl-set/99.json");
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(fixed.calls).toEqual([]); // helper never invoked
  });
});
