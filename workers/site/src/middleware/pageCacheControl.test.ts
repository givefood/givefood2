import { Hono } from "hono";
import type { Context } from "hono";
import { LOCALES } from "@givefood/templates";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { noStore } from "./noStore";
import { pageCacheControl } from "./pageCacheControl";

// What this middleware is for: Django decorated 75 public views with
// @cache_page, and the port replaced that with a Cloudflare Cache Rule --
// which caches at the EDGE but cannot put a header in the response, so no
// browser cached a page of this site for a single second. This file's job is
// to make sure the header comes back, in the right amount, and -- much more
// important -- that a gap-filler mounted on "*" never overwrites a header
// somebody else set on purpose. The noStore interaction below is the one that
// matters most: Cloudflare was caching authenticated admin pages and serving
// them anonymously (beta, 2026-09-02), and a Worker cache HIT never runs the
// Worker at all, so no amount of auth-middleware correctness can catch it.

const env = {} as unknown as AppEnv["Bindings"];

const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;

// Mount exactly as index.ts does -- `app.use("*", ...)` -- because "runs on
// every response, including ones it must not touch" is the whole contract.
function appWith(handler: (c: Context<AppEnv>) => Response | Promise<Response>) {
  const app = new Hono<AppEnv>();
  app.use("*", pageCacheControl);
  // .all, not .get, so the method-guard tests can reach the same handler.
  app.all("*", handler);
  return app;
}

const html = (c: Context<AppEnv>) => c.html("<p>ok</p>");

// A handler returning a raw Response, so a test can control the exact header
// NAME CASING and value the middleware's guards will see. Hono's c.header()
// would normalise some of that away, and the guards use Headers.has(), whose
// case-insensitivity is load-bearing -- a route writing "cache-control" in
// lower case must still be left alone.
const raw =
  (body: string | null, init: ResponseInit) =>
  (): Response =>
    new Response(body, init);

async function cacheControl(
  path: string,
  handler: (c: Context<AppEnv>) => Response | Promise<Response> = html,
  init: RequestInit = {},
): Promise<string | null> {
  const res = await appWith(handler).request(`https://www.givefood.org.uk${path}`, init, env);
  return res.headers.get("Cache-Control");
}

// Read the shared TTL back out, so the family tests read as "this page family
// gets the number its Django view asked for" rather than as string matching.
// Returns null both when no header was set and when one was set without an
// s-maxage, which is why the family tests below always assert a NUMBER -- a
// middleware that stopped emitting the header entirely would fail every one
// of them rather than quietly comparing null to null.
async function sharedTtl(path: string): Promise<number | null> {
  const match = (await cacheControl(path))?.match(/s-maxage=(\d+)/);
  return match ? Number(match[1]) : null;
}

describe("pageCacheControl: the header itself", () => {
  it("sets the Cache-Control that Django's @cache_page used to set", async () => {
    // The literal header, asserted once. Everything below reads only the
    // s-maxage half, so this is the test that pins the actual format --
    // "public" (a shared cache may store it) plus both TTLs.
    expect(await cacheControl("/")).toBe("public, max-age=300, s-maxage=3600");
  });

  it("gives the browser five minutes on every family, not Django's TTL", async () => {
    // DELIBERATE DIVERGENCE, in the safer direction. Django sent
    // max-age=86400 on a food bank's needs page, so a visitor who looked
    // twice in a day saw the same shopping list even after the food bank
    // changed it -- and a browser cache cannot be purged. The long TTL
    // belongs on the edge, which the cache-tag purge can revoke.
    //
    // If anyone ever "restores parity with Django" by passing the family TTL
    // through to max-age, this fails: the browser number must stay 300 while
    // the shared number varies. The exact-match assertions are what make that
    // bite -- a /^public, max-age=300, / prefix check would also pass against
    // an implementation that appended the family TTL a second time.
    expect(await cacheControl("/")).toBe(`public, max-age=300, s-maxage=${HOUR}`);
    expect(await cacheControl("/needs/at/sid-valley/")).toBe(`public, max-age=300, s-maxage=${DAY}`);
    expect(await cacheControl("/privacy/")).toBe(`public, max-age=300, s-maxage=${WEEK}`);
  });

  it("adds a header to the handler's response instead of building a new one", async () => {
    // THE HOLE EVERY OTHER TEST IN THIS FILE LEAVES OPEN. Every assertion
    // elsewhere reads Cache-Control and nothing else, so an implementation
    // that did `c.res = new Response(body, { headers: { "Cache-Control": ... } })`
    // -- a plausible way to write this, and how you would have to write it if
    // the response headers were immutable -- would pass all of them while
    // throwing away the page's status, its Content-Type, its Content-Language
    // and anything a security or i18n middleware had already put on it.
    //
    // So this is the one test that looks at the whole response.
    const page = () =>
      new Response("<p>privacy policy</p>", {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Language": "cy",
          "X-Robots-Tag": "index, follow",
          "X-Content-Type-Options": "nosniff",
          Vary: "Accept-Language",
        },
      });
    const res = await appWith(page).request("https://www.givefood.org.uk/privacy/", {}, env);

    expect(res.headers.get("Cache-Control")).toBe(`public, max-age=300, s-maxage=${WEEK}`);
    // The body is the page, not an empty response with a good header on it.
    expect(await res.text()).toBe("<p>privacy policy</p>");
    expect(res.status).toBe(200);
    // securityHeaders.ts and resolveLanguage.ts both put headers on public
    // pages; losing X-Content-Type-Options to a cache tweak would be a
    // security regression with no symptom short of a header diff.
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Language")).toBe("cy");
    expect(res.headers.get("X-Robots-Tag")).toBe("index, follow");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Vary")).toBe("Accept-Language");
  });

  it("runs after the handler has finished, not alongside it", async () => {
    // The middleware is `await next()` and then the guards, and the await is
    // load-bearing: every guard reads c.res, which does not exist until the
    // handler has returned. A missing await would leave the middleware
    // inspecting Hono's placeholder instead of the page.
    //
    // Every other handler in this file resolves in the same microtask, so a
    // real suspension point is needed to make the ordering observable at all.
    const slow = async (c: Context<AppEnv>) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return c.html("<p>slow page</p>");
    };
    expect(await cacheControl("/news/", slow)).toBe(`public, max-age=300, s-maxage=${HOUR}`);
    // And an async route that sets its own header still wins the race -- the
    // never-override guard has to see a header the handler set after an await.
    const slowOwn = async (c: Context<AppEnv>) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      c.header("Cache-Control", "max-age=604800");
      return c.html("<p>slow page</p>");
    };
    expect(await cacheControl("/news/", slowOwn)).toBe("max-age=604800");
  });

  it("emits each directive exactly once", async () => {
    // A duplicated directive is not a cosmetic problem: RFC 9111 lets a cache
    // treat a repeated max-age as unparseable, or take the first occurrence --
    // so "max-age=300, max-age=604800" from an append-instead-of-set could
    // hand browsers the week-long TTL this module exists to refuse them.
    // Parsed as a directive list rather than substring-matched, so the test
    // fails on an extra copy instead of shrugging at it the way a
    // .toContain("max-age=300") would.
    const directives = ((await cacheControl("/privacy/")) ?? "").split(", ");
    expect(directives).toEqual(["public", "max-age=300", `s-maxage=${WEEK}`]);
    expect(new Set(directives).size).toBe(directives.length);
  });
});

describe("pageCacheControl: TTL families copied from Django", () => {
  it("caches the hourly pages for an hour (givefood/views.py index/news/country)", async () => {
    // @cache_page(SECONDS_IN_HOUR) on index, news and country in
    // givefood/views.py. The home page carries "recently updated" and "most
    // viewed" panels, so an hour is the point rather than an accident -- a
    // day here would show a week-old "recently updated" list.
    expect(await sharedTtl("/")).toBe(HOUR);
    expect(await sharedTtl("/news/")).toBe(HOUR);
    for (const country of ["scotland", "england", "wales", "northern-ireland"]) {
      expect(await sharedTtl(`/${country}/`)).toBe(HOUR);
    }
  });

  it("enumerates the four countries rather than accepting any word", async () => {
    // COUNTRY is an explicit alternation, and these are the pages that would
    // quietly join the hourly family if it were ever loosened to a character
    // class. "ireland" is the one that matters: it is a suffix of the real
    // "northern-ireland" route, so an unanchored alternation would match it.
    expect(await sharedTtl("/ireland/")).toBe(DAY);
    expect(await sharedTtl("/france/")).toBe(DAY);
    expect(await sharedTtl("/scotland/foodbanks/")).toBe(DAY);
  });

  it("caches the near-static pages for a week (@cache_page(SECONDS_IN_WEEK))", async () => {
    // about_us, privacy, donate, colophon, bot, api and annual_report_index
    // in givefood/views.py; constituencies in gfwfbn/views.py -- every one
    // of them @cache_page(SECONDS_IN_WEEK).
    for (const page of [
      "/about-us/",
      "/privacy/",
      "/donate/",
      "/colophon/",
      "/bot/",
      "/api/",
      "/annual-reports/",
      "/constituencies/",
    ]) {
      expect(await sharedTtl(page)).toBe(WEEK);
    }
  });

  it("caches a nearby page for a week, in every shape the route table produces", async () => {
    // gfwfbn foodbank_nearby AND md_foodbank_nearby, both
    // @cache_page(SECONDS_IN_WEEK). The rule is a plain endsWith, so the
    // Markdown mirror at /md/needs/at/<slug>/nearby/ (routes.ts's
    // "wfbn-md:md_foodbank_nearby") is covered by the same line.
    expect(await sharedTtl("/needs/at/sid-valley/nearby/")).toBe(WEEK);
    expect(await sharedTtl("/md/needs/at/sid-valley/nearby/")).toBe(WEEK);
    expect(await sharedTtl("/cy/needs/at/sid-valley/nearby/")).toBe(WEEK);
    expect(await sharedTtl("/gd/needs/at/sid-valley/nearby/")).toBe(WEEK);
    // The suffix is matched on the pathname, so tracking parameters on a
    // shared "food banks near you" link do not drop it to the day default.
    expect(await sharedTtl("/needs/at/sid-valley/nearby/?utm_source=x")).toBe(WEEK);
  });

  it("matches nearby as a whole final segment, not anywhere in the path", async () => {
    // The rule is endsWith("/nearby/"), and both halves of that carry weight.
    // ENDS: an implementation using includes() would give a week to anything
    // hanging off a nearby page. SLASH: dropping it to endsWith("nearby/")
    // would give a week to every food bank whose slug happens to end in
    // "nearby" -- and slugs are generated from names the public supplies.
    expect(await sharedTtl("/needs/at/sid-valley/nearby/more/")).toBe(DAY);
    expect(await sharedTtl("/needs/at/sid-valley-nearby/")).toBe(DAY);
    // Pinned as current behaviour: unlike every other rule this one is a bare
    // suffix test with no ^ anchor and no locale prefix, so a top-level
    // /nearby/ -- not a route today -- would also get the week.
    expect(await sharedTtl("/nearby/")).toBe(WEEK);
  });

  it("keeps the anchored families and the nearby suffix rule from claiming the same path", async () => {
    // SHARED_TTL is documented as "Order matters -- first match wins", but as
    // written the six rules are mutually exclusive: five are anchored
    // ^/<prefix>?<exact segments>/$ over disjoint segment sets and the sixth is
    // a bare /nearby/ suffix, so no path reaches two of them and reversing the
    // whole array changes no answer. That makes the ordering claim vacuous
    // today -- reported, not changed.
    //
    // This is where it would stop being vacuous. Each path below looks like an
    // anchored family with "nearby/" appended: the $ anchor is what stops the
    // family from claiming it, and the suffix rule takes it instead. Loosen an
    // anchor and first-match-wins starts biting -- /news/nearby/ would be
    // caught by NEWS at index 1 and get an hour instead of the week its
    // gfwfbn foodbank_nearby view asked for.
    for (const path of ["/news/nearby/", "/privacy/nearby/", "/scotland/nearby/", "/2024/nearby/"]) {
      expect(await sharedTtl(path)).toBe(WEEK);
    }
    // ...while the families themselves keep their own numbers, so the test
    // fails for a loosened anchor rather than for a broken suffix rule.
    expect(await sharedTtl("/news/")).toBe(HOUR);
    expect(await sharedTtl("/privacy/")).toBe(WEEK);
    expect(await sharedTtl("/scotland/")).toBe(HOUR);
  });

  it("caches an annual report year for a week", async () => {
    // givefood/urls.py:44 reverses /<year>/ to annual_report, which is
    // @cache_page(SECONDS_IN_WEEK). Django's regex enumerates the years it
    // has published (2019-2025); this port matches any 19xx/20xx, which is
    // broader but harmless -- see the 404 test below, since a year with no
    // report never returns 200 in the first place.
    for (const year of ["2019", "2021", "2025"]) {
      expect(await sharedTtl(`/${year}/`)).toBe(WEEK);
    }
    // The exact edges of "broader than Django", pinned so the width of the
    // divergence is a decision rather than a surprise: (?:19|20)\d{2} is
    // 1900-2099 and nothing else.
    expect(await sharedTtl("/1900/")).toBe(WEEK);
    expect(await sharedTtl("/2099/")).toBe(WEEK);
    expect(await sharedTtl("/1899/")).toBe(DAY);
    expect(await sharedTtl("/2100/")).toBe(DAY);
    expect(await sharedTtl("/0000/")).toBe(DAY);
  });

  it("falls through to a day, which is what @cache_page said for a food bank page", async () => {
    // gfwfbn/views.py foodbank and its tabs are @cache_page(SECONDS_IN_DAY),
    // and they are nearly all of this site's HTML -- so the default is the
    // common case rather than a shrug.
    expect(await sharedTtl("/needs/at/sid-valley/")).toBe(DAY);
    expect(await sharedTtl("/needs/at/sid-valley/locations/")).toBe(DAY);
    expect(await sharedTtl("/needs/at/sid-valley/news/")).toBe(DAY);
    expect(await sharedTtl("/needs/in/constituency/exeter/")).toBe(DAY);
    // /needs/ USED TO BE HERE, pinned at DAY as "reported, not changed" --
    // github #19 changed it; see the hour test below.
    //
    // gfwfbn/views.py rss is @cache_page(SECONDS_IN_DAY) too, so the feed
    // lands on the right number by falling through rather than by a rule.
    // Checked against the Django source while fixing #19 rather than
    // assumed, because /needs/rss.xml sits one path segment from a page
    // whose TTL just moved: gfwfbn/views.py:131 really is SECONDS_IN_DAY.
    expect(await sharedTtl("/needs/rss.xml")).toBe(DAY);
    expect(await sharedTtl("/some/route/nobody/has/written/yet/")).toBe(DAY);
  });

  // github #19. The site's primary search page was getting a 24-hour edge
  // TTL where Django's @cache_page(SECONDS_IN_HOUR) allowed one, so a
  // visitor searching a postcode could be served a food bank list a day out
  // of date.
  //
  // THE TTL IS THE ONLY BOUND ON STALENESS HERE, which is what made the
  // multiplier matter: tagsFor() returns [] for /needs/, so the fb-all purge
  // fired on every publish cannot reach it. That missing tag is PARITY, not
  // a second bug -- Django's decache list omits reverse("wfbn:index") too --
  // and it is the reason the number is the whole defence.
  it("caches the needs index and the markdown homepage for an hour, like Django", async () => {
    expect(await sharedTtl("/needs/")).toBe(HOUR);
    // Inside i18n_patterns, so every locale prefix gets the same rule.
    for (const locale of ["cy", "ga", "gd"]) {
      expect(await sharedTtl(`/${locale}/needs/`), locale).toBe(HOUR);
    }
    // givefood/views.py:699 md_index, also SECONDS_IN_HOUR.
    expect(await sharedTtl("/md/")).toBe(HOUR);
  });

  it("does not let the new hour rules swallow the pages beneath them", async () => {
    // `at()` anchors both ends, so "needs/" cannot match /needs/at/... --
    // asserted rather than trusted, because a rule that lost its `$` would
    // hand an hour to nearly every page on the site and the only symptom
    // would be more origin traffic.
    expect(await sharedTtl("/needs/at/sid-valley/")).toBe(DAY);
    expect(await sharedTtl("/needs/in/constituency/exeter/")).toBe(DAY);
    expect(await sharedTtl("/needs/at/sid-valley/nearby/")).toBe(WEEK);
    // MD_INDEX is deliberately NOT built with at(): the markdown block sits
    // outside i18n_patterns, so /cy/md/ is not a route and must not be
    // matched. It falls through to the default like any unknown path.
    expect(await sharedTtl("/cy/md/")).toBe(DAY);
    expect(await sharedTtl("/md/needs/at/sid-valley/")).toBe(DAY);
  });
});

describe("pageCacheControl: the locale prefix is built from LOCALES", () => {
  it("does not read /privacy/ as a locale home page", async () => {
    // THE BUG THIS FILE'S EXISTENCE IS CREDITED WITH. The prefix was
    // "(?:[a-z-]{2,7}/)?" first, a character class that happily matches
    // "privacy", "donate", "bot" and "api" -- so those pages matched HOME
    // and got the home page's hour instead of Django's week, a 168x
    // under-cache of four completely static pages.
    for (const page of ["/privacy/", "/donate/", "/bot/", "/api/"]) {
      expect(await sharedTtl(page)).toBe(WEEK);
    }
    // The same character class also swallowed the two-to-seven-letter country
    // names, which would have made /wales/ a locale home page. Distinct from
    // the WEEK cases above because HOUR is the right answer here for a
    // different reason, so only a correct prefix gets both right.
    expect(await sharedTtl("/wales/")).toBe(HOUR);
    expect(await sharedTtl("/news/")).toBe(HOUR);
  });

  it("honours every non-English locale the router actually registers", async () => {
    // Derived from LOCALES, so it cannot drift from index.ts, which loops
    // the same list. Hardcoding "cy|ga" back into the regex would pass this
    // today and fail the moment a fifth locale is added -- which is the
    // point of deriving it.
    const prefixes = LOCALES.filter((l) => l !== "en");
    // Guard against a vacuous pass: if LOCALES were ever emptied or reduced to
    // ["en"], every loop below would run zero times and this test would go
    // green while asserting nothing at all.
    expect(prefixes.length).toBeGreaterThanOrEqual(3);
    expect(LOCALES).toContain("en");
    for (const locale of prefixes) {
      expect(await sharedTtl(`/${locale}/`)).toBe(HOUR);
      expect(await sharedTtl(`/${locale}/news/`)).toBe(HOUR);
      expect(await sharedTtl(`/${locale}/scotland/`)).toBe(HOUR);
      expect(await sharedTtl(`/${locale}/privacy/`)).toBe(WEEK);
      expect(await sharedTtl(`/${locale}/2024/`)).toBe(WEEK);
      // The prefix is optional but SINGLE -- a stacked prefix is not a route,
      // and "(?:...)/*" or a repeated group would make it look like one.
      expect(await sharedTtl(`/${locale}/${locale}/`)).toBe(DAY);
      // And it is a prefix, not a suffix or a free-floating match.
      expect(await sharedTtl(`/news/${locale}/`)).toBe(DAY);
    }
  });

  it("treats /en/ as an ordinary path, because English is never a prefix", async () => {
    // index.ts's locale loop does `if (locale === "en") continue`, so /en/
    // is not a route -- the regex excludes it for the same reason. Pinned
    // because re-adding "en" to the prefix would make /en/ look like a home
    // page that does not exist.
    expect(await sharedTtl("/en/")).toBe(DAY);
    expect(await sharedTtl("/en/privacy/")).toBe(DAY);
  });

  it("does not invent locales the site does not serve", async () => {
    // Django ran 21 languages; this port serves 4 (i18n.ts). /fr/ is not a
    // route here, so it must not be read as the French home page.
    expect(await sharedTtl("/fr/")).toBe(DAY);
    expect(await sharedTtl("/de/news/")).toBe(DAY);
    // Nor a truncation or extension of one that is: the alternation has to be
    // bounded by the slashes on either side.
    expect(await sharedTtl("/c/")).toBe(DAY);
    expect(await sharedTtl("/cym/")).toBe(DAY);
    expect(await sharedTtl("/gd-GB/news/")).toBe(DAY);
  });
});

describe("pageCacheControl: path matching boundaries", () => {
  it("requires the trailing slash Django's URLs always have", async () => {
    // Every one of these is a real 301 target in Django (APPEND_SLASH), so
    // the slashless form is a redirect, not a page. The regexes are anchored
    // with $ for that reason.
    expect(await sharedTtl("/news")).toBe(DAY);
    expect(await sharedTtl("/privacy")).toBe(DAY);
    expect(await sharedTtl("/2024")).toBe(DAY);
    expect(await sharedTtl("/needs/at/sid-valley/nearby")).toBe(DAY);
    expect(await sharedTtl("/cy")).toBe(DAY);
  });

  it("anchors every family at the start of the path", async () => {
    // The ^ in at(). Without it the family regexes would match a suffix of
    // any deeper path, and this site has plenty of deep paths that end in a
    // family-looking segment.
    expect(await sharedTtl("/blog/news/")).toBe(DAY);
    expect(await sharedTtl("/needs/at/sid-valley/privacy/")).toBe(DAY);
    expect(await sharedTtl("/foo/scotland/")).toBe(DAY);
    expect(await sharedTtl("/blog/2024/")).toBe(DAY);
  });

  it("does not match a year that is only part of a longer segment", async () => {
    // "(?:19|20)\\d{2}" is exactly four digits between the slashes, so a
    // five-digit segment or a suffixed one is not an annual report.
    expect(await sharedTtl("/20241/")).toBe(DAY);
    expect(await sharedTtl("/2024-review/")).toBe(DAY);
    expect(await sharedTtl("/2024x/")).toBe(DAY);
    expect(await sharedTtl("/x2024/")).toBe(DAY);
  });

  it("matches families on the path only, ignoring the query string", async () => {
    // The regexes end in $, so anything that read the raw URL instead of
    // URL.pathname would drop /news/?page=2 to the day default. Real links
    // into this site carry utm_* parameters constantly.
    expect(await sharedTtl("/news/?page=2")).toBe(HOUR);
    expect(await sharedTtl("/?utm_source=twitter")).toBe(HOUR);
    expect(await sharedTtl("/privacy/?utm_campaign=x")).toBe(WEEK);
    // An empty query string still leaves a "?" on the raw URL.
    expect(await sharedTtl("/privacy/?")).toBe(WEEK);
    // The other direction, which is the one the nearby rule needs: that rule
    // is a bare endsWith with no $ anchor of its own, so an implementation
    // reading the raw URL would let a QUERY STRING ending in "/nearby/"
    // promote an ordinary food bank page from a day to a week at the edge.
    // "?next=" round-trip parameters like this are exactly what the site's
    // own links carry.
    expect(await sharedTtl("/needs/at/sid-valley/?next=/nearby/")).toBe(DAY);
    expect(await sharedTtl("/needs/at/sid-valley/?from=/needs/at/other/nearby/")).toBe(DAY);
  });

  it("treats a request for the bare origin as the home page", async () => {
    // The empty-path boundary. A request for "https://www.givefood.org.uk"
    // with nothing after the host has pathname "/", so HOME matches and the
    // site's most-requested URL gets its hour -- but only because the module
    // reads URL.pathname. Anything slicing the URL string would see "" here,
    // fail to match HOME and hand the home page the day default, which is 24x
    // Django's @cache_page(SECONDS_IN_HOUR) on a page whose whole point is
    // its "recently updated" panel.
    const res = await appWith(html).request("https://www.givefood.org.uk", {}, env);
    expect(res.headers.get("Cache-Control")).toBe(`public, max-age=300, s-maxage=${HOUR}`);
    // The same request with only a query string attached, no path at all.
    const q = await appWith(html).request("https://www.givefood.org.uk?utm_source=x", {}, env);
    expect(q.headers.get("Cache-Control")).toBe(`public, max-age=300, s-maxage=${HOUR}`);
  });

  it("matches the family regexes case-sensitively", async () => {
    // Documenting current behaviour, not endorsing it: Django's URLconf is
    // case-sensitive too, so /News/ is a 404 rather than the news page and
    // never reaches the 200-only guard with a body worth caching.
    expect(await sharedTtl("/News/")).toBe(DAY);
    expect(await sharedTtl("/PRIVACY/")).toBe(DAY);
    expect(await sharedTtl("/CY/")).toBe(DAY);
  });

  it("matches the raw pathname without percent-decoding it", async () => {
    // CURRENT BEHAVIOUR, and the safe one. URL.pathname does not decode, so
    // /pri%76acy/ ("privacy" once decoded) is not the privacy page. An
    // implementation that ran decodeURIComponent first -- an easy-looking
    // "fix" for accented slugs -- would hand a week-long shared TTL to any
    // path an attacker could spell in escapes, and would also throw on a
    // malformed escape, on a middleware mounted on "*".
    expect(await sharedTtl("/pri%76acy/")).toBe(DAY);
    expect(await sharedTtl("/news%2F")).toBe(DAY);
    expect(await sharedTtl("/%2Fnews/")).toBe(DAY);
  });

  it("survives the paths a crawler actually sends without throwing", async () => {
    // A middleware on "*" that threw would take down every response it could
    // not classify, so the hostile cases have to end in a header rather than
    // an exception. Accented slugs are real -- Django's slugify kept them --
    // and arrive percent-encoded, hence the day default rather than a match.
    expect(await sharedTtl("/needs/at/café/")).toBe(DAY);
    expect(await sharedTtl("/needs/at/über-tafel/")).toBe(DAY);
    expect(await sharedTtl("/%zz/")).toBe(DAY);
    expect(await sharedTtl(`/${"a".repeat(5000)}/`)).toBe(DAY);
    expect(await sharedTtl("//privacy/")).toBe(DAY);
    // Dot segments are normalised away by URL parsing before the middleware
    // ever sees them, so /a/../news/ IS the news page. Pinned because a
    // string-slicing implementation would disagree.
    expect(await sharedTtl("/a/../news/")).toBe(HOUR);
  });
});

describe("pageCacheControl: the guards that make it safe on '*'", () => {
  it("never overrides a header a route set on purpose", async () => {
    // routes/wfbn/constituencies.ts sets max-age=604800 itself, and
    // routes/public/country.ts and frag.ts set their own too. A gap-filler
    // that overwrote those would silently rewrite twelve considered
    // decisions into one default.
    const own = (c: Context<AppEnv>) => {
      c.header("Cache-Control", "max-age=604800");
      return c.html("<p>constituencies</p>");
    };
    expect(await cacheControl("/needs/in/constituencies/", own)).toBe("max-age=604800");
    // Including when the route deliberately asked for something SHORTER than
    // the family default -- routes/media.ts uses max-age=10 on a 404.
    const short = (c: Context<AppEnv>) => {
      c.header("Cache-Control", "max-age=10");
      return c.html("<p>short</p>");
    };
    expect(await cacheControl("/", short)).toBe("max-age=10");
  });

  it("respects an existing header whatever case the route spelled it in", async () => {
    // The guard is Headers.has("Cache-Control"), which is case-insensitive by
    // spec -- but a rewrite to a plain object lookup or a `=== "Cache-Control"`
    // comparison would not be, and routes that build a raw Response are free
    // to write the name in lower case.
    const lower = raw("<p>x</p>", {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=42" },
    });
    expect(await cacheControl("/", lower)).toBe("max-age=42");
  });

  it("reads the RESPONSE's headers, not the request's", async () => {
    // Both guards are about what the handler put on the way OUT, and both
    // header names have a plausible look-alike on the way in. Reading
    // c.req.header() instead of c.res.headers would be a one-word slip that
    // no other test in this file can see, because every request elsewhere is
    // header-free.
    //
    // It would also be a slip with an unusually bad blast radius: every
    // browser hard-refresh sends "Cache-Control: no-cache" on the REQUEST, and
    // every visitor who has ever hit /flag/ carries a Cookie, so the
    // middleware would switch itself off for a large slice of real traffic --
    // silently, and only for the people whose caches most needed the header.
    expect(
      await cacheControl("/privacy/", html, {
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          Cookie: "csrftoken=abc123; sessionid=x",
        },
      }),
    ).toBe(`public, max-age=300, s-maxage=${WEEK}`);
    // The same for the conditional-request headers a returning visitor sends.
    expect(
      await cacheControl("/", html, {
        headers: { "If-None-Match": '"abc"', "If-Modified-Since": "Wed, 02 Sep 2026 00:00:00 GMT" },
      }),
    ).toBe(`public, max-age=300, s-maxage=${HOUR}`);
  });

  it("treats an empty Cache-Control as a header that exists, and leaves it", async () => {
    // The guard tests PRESENCE, not truthiness. An implementation written as
    // `if (c.res.headers.get("Cache-Control")) return` would read "" as absent
    // and overwrite it -- which is the wrong call: a route that deliberately
    // emptied the header has said something, and this middleware only fills
    // gaps. Pinned as current behaviour.
    const blank = raw("<p>x</p>", {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "" },
    });
    expect(await cacheControl("/privacy/", blank)).toBe("");
  });

  it("keeps admin pages uncacheable whichever way the two middlewares are mounted", async () => {
    // SECURITY REGRESSION TEST. Cloudflare cached authenticated admin pages
    // at the edge and served them to anonymous visitors on beta (2026-09-02);
    // the subscribers tab leaks subscriber identifiers, and a cache HIT never
    // runs the Worker, so requireAdminAuth cannot be the thing that stops it.
    // The ONLY defence is that these responses never carry a cacheable header.
    //
    // index.ts:125 registers pageCacheControl above the noStore mounts so that
    // Hono unwinds it LAST and its never-override guard sees noStore's header
    // already in place. Both orders are asserted here deliberately: the
    // protection turns out to be doubly held, because noStore sets its header
    // unconditionally after next() and so wins the other way round too. That
    // is worth pinning rather than assuming -- if noStore ever grows a guard
    // of its own, this test fails and says which order became load-bearing.
    const build = (cacheFirst: boolean) => {
      const app = new Hono<AppEnv>();
      if (cacheFirst) {
        app.use("*", pageCacheControl);
        app.use("/admin/*", noStore);
      } else {
        app.use("/admin/*", noStore);
        app.use("*", pageCacheControl);
      }
      app.get("/admin/foodbank/sid-valley/", (c) => c.html("<p>admin</p>"));
      return app;
    };
    for (const cacheFirst of [true, false]) {
      const res = await build(cacheFirst).request(
        "https://www.givefood.org.uk/admin/foodbank/sid-valley/",
        {},
        env,
      );
      expect(res.headers.get("Cache-Control")).toBe(
        "private, no-store, max-age=0, must-revalidate",
      );
      // The assertions that would catch a merge rather than a replace: a
      // header reading "private, no-store, ..., public, max-age=300" would
      // still satisfy a .toContain("no-store") check and still be cacheable.
      expect(res.headers.get("Cache-Control")).not.toContain("public");
      expect(res.headers.get("Cache-Control")).not.toContain("s-maxage");
    }
  });

  it("REGRESSION: leaves a token-bearing response alone even with NO Set-Cookie", async () => {
    // The live bug this guard was added for. issueCsrfToken() REUSES a valid
    // cookie and returns early WITHOUT re-emitting Set-Cookie, so a returning
    // visitor's /flag/ carried a CSRF token and no cookie header at all. The
    // first version of this middleware keyed only on Set-Cookie, stamped
    // `public, s-maxage=86400` on that page, and put one visitor's token in
    // the shared cache for a day; everyone served it had their submission
    // rejected and their typed contents discarded. Reproduced on production
    // 2026-09-07.
    //
    // csrfIssued is set by issueCsrfToken on EVERY path, so it is the causal
    // signal: "this response contains a token", not "this response happens
    // to set a cookie".
    const reusedToken = (c: Context<AppEnv>) => {
      c.set("csrfIssued", true); // no Set-Cookie -- the reuse path
      return c.html('<input name="csrf_token" value="2222a5e7">');
    };
    expect(await cacheControl("/flag/", reusedToken)).toBeNull();
    expect(await cacheControl("/register-foodbank/", reusedToken)).toBeNull();
    expect(await cacheControl("/write/to/cities-of-london-and-westminster/", reusedToken)).toBeNull();
    // Including on the paths that would otherwise get the longest TTL, since
    // the flag must beat the TTL table rather than being consulted after it.
    expect(await cacheControl("/privacy/", reusedToken)).toBeNull();
    // And a page that issued no token is unaffected -- the guard must not
    // quietly disable caching for the whole site.
    expect(await cacheControl("/privacy/")).toBe("public, max-age=300, s-maxage=604800");
  });

  it("leaves a response carrying Set-Cookie exactly as it found it", async () => {
    // Kept as belt-and-braces alongside the csrfIssued flag above, for any
    // future per-visitor response that sets a cookie without going through
    // issueCsrfToken (a session, a stored preference).
    //
    // /flag/ and /register-foodbank/ embed a per-visitor CSRF token in the
    // form. Cloudflare declines to cache a response with Set-Cookie, which
    // is one reason one visitor's token is not served to everybody;
    // adding "public" could plausibly talk it out of that bypass.
    const withCookie = (c: Context<AppEnv>) => {
      c.header("Set-Cookie", "csrftoken=abc123; Path=/");
      return c.html("<p>flag form</p>");
    };
    expect(await cacheControl("/flag/", withCookie)).toBeNull();
    // Even on a path that would otherwise get the longest TTL of all.
    expect(await cacheControl("/privacy/", withCookie)).toBeNull();
    // And whatever case the route spelled the header in -- same reasoning as
    // the Cache-Control guard, but this one is the CSRF token.
    const lowerCookie = raw("<p>x</p>", {
      headers: { "Content-Type": "text/html; charset=utf-8", "set-cookie": "csrftoken=abc123" },
    });
    expect(await cacheControl("/privacy/", lowerCookie)).toBeNull();
    // A session cookie with no CSRF in sight is still per-visitor.
    const session = raw("<p>x</p>", {
      headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "sessionid=x; HttpOnly" },
    });
    expect(await cacheControl("/", session)).toBeNull();
    // PRESENCE, not truthiness -- the same distinction the empty
    // Cache-Control test makes, but with the CSRF token on the other end of
    // it. A cookie header set to the empty string is still a response
    // Cloudflare will refuse to cache, and `if (c.res.headers.get("Set-Cookie"))`
    // would read it as absent and stamp "public" on a per-visitor page.
    const blankCookie = raw("<p>x</p>", {
      headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "" },
    });
    expect(await cacheControl("/privacy/", blankCookie)).toBeNull();
    // And when a route sets more than one cookie, which Headers keeps as
    // separate values rather than collapsing.
    const twoCookies = () => {
      const res = new Response("<p>x</p>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
      res.headers.append("Set-Cookie", "csrftoken=abc123; Path=/");
      res.headers.append("Set-Cookie", "sessionid=x; HttpOnly");
      return res;
    };
    expect(await cacheControl("/privacy/", twoCookies)).toBeNull();
  });

  it("only touches a 200", async () => {
    // A 404's TTL is its own decision (routes/media.ts uses max-age=10 on
    // one) and a redirect's belongs to the router -- a cached 302 from the
    // slug-redirect middleware would outlive the rename that caused it.
    //
    // Every status here carries an explicit text/html Content-Type so that
    // the STATUS guard is what rejects it. Without that, a 204 (which Hono
    // sends with no Content-Type at all) passes this test even against an
    // implementation whose status check was `if (!c.res.ok) return` -- the
    // type gate rejects it first and the assertion proves nothing.
    const status = (code: number, body: string | null = "<p>x</p>") =>
      raw(body, { status: code, headers: { "Content-Type": "text/html; charset=utf-8" } });
    expect(await cacheControl("/needs/at/gone-away/", status(404))).toBeNull();
    expect(await cacheControl("/", status(500))).toBeNull();
    expect(await cacheControl("/old-slug/", (c) => c.redirect("/new-slug/", 301))).toBeNull();
    // That c.redirect() line is weaker than it looks and is kept only for
    // realism: Hono's redirect sends no Content-Type, so the TYPE gate
    // rejects it and the assertion holds even against an implementation whose
    // status check was `if (c.res.status >= 400) return`. These carry an
    // explicit text/html so that only the STATUS guard can reject them --
    // slugRedirect.ts 301s a renamed food bank, and a redirect cached for a
    // day at the edge outlives the rename that caused it and pins a visitor
    // to the old URL long after it stops resolving.
    const redirect = (code: number) =>
      raw("<p>moved</p>", {
        status: code,
        headers: { "Content-Type": "text/html; charset=utf-8", Location: "/new-slug/" },
      });
    for (const code of [301, 302, 307, 308]) {
      expect(await cacheControl("/old-slug/", redirect(code))).toBeNull();
      // Including on a path whose family rule would otherwise fire, so the
      // test cannot pass by accident through the day default being null.
      expect(await cacheControl("/privacy/", redirect(code))).toBeNull();
    }
    // The 2xx neighbours, which an `ok`/`>= 400` style check would let past.
    expect(await cacheControl("/news/", status(201))).toBeNull();
    expect(await cacheControl("/news/", status(202))).toBeNull();
    expect(await cacheControl("/news/", status(204, null))).toBeNull();
    expect(await cacheControl("/news/", status(206))).toBeNull();
    // A 304 is a conditional-GET answer whose freshness the origin already
    // settled; re-stating it here would be the middleware overruling that.
    expect(await cacheControl("/news/", status(304, null))).toBeNull();
  });

  it("only touches a GET", async () => {
    // POST /needs/at/<slug>/updates/subscribe/ mutates and mails; caching
    // its response is never right. The other verbs are asserted too because
    // `if (method === "POST") return` would pass a POST-only test while
    // leaving every mutating verb the admin forms use wide open.
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(
        await cacheControl("/needs/at/sid-valley/updates/subscribe/", html, { method }),
      ).toBeNull();
      // And on a path whose family rule would otherwise fire.
      expect(await cacheControl("/privacy/", html, { method })).toBeNull();
    }
  });

  it("does not put a header on a HEAD response", async () => {
    // CURRENT BEHAVIOUR, pinned as-is. Hono routes HEAD to the GET handler
    // and returns 200, but the method guard skips it -- so a HEAD of a page
    // answers without the Cache-Control its GET carries. The module comment
    // reasons that "HEAD inherits GET's headers from the same handler",
    // which holds for headers the handler sets and not for this one, since
    // the middleware is what sets it. Reported rather than fixed.
    //
    // Asserted against an app registered with .get, which is how index.ts
    // actually registers pages -- the .all("*") helper used elsewhere in this
    // file could otherwise be doing the routing work.
    const app = new Hono<AppEnv>();
    app.use("*", pageCacheControl);
    app.get("/", html);
    const head = await app.request("https://www.givefood.org.uk/", { method: "HEAD" }, env);
    expect(head.status).toBe(200);
    expect(head.headers.get("Cache-Control")).toBeNull();
    const get = await app.request("https://www.givefood.org.uk/", {}, env);
    expect(get.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=3600");
  });
});

describe("pageCacheControl: which content types it fills in for", () => {
  it("covers the types that had no header at all", async () => {
    // The measured gap this exists to close (2026-09-06): html 11.9% edge
    // hit rate, rss 0.0%, md 1.3%.
    const rss = () =>
      new Response("<rss/>", { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
    const md = () =>
      new Response("# Needs", { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    expect(await cacheControl("/needs/rss.xml", rss)).toBe(`public, max-age=300, s-maxage=${DAY}`);
    expect(await cacheControl("/md/needs/at/sid-valley/", md)).toBe(`public, max-age=300, s-maxage=${DAY}`);
    // text/plain is DELIBERATELY NOT on the list, and this asserts the
    // absence. It was on it until 2026-09-07, when /frag/ip-address/ -- a
    // text/plain response carrying the caller's own IP -- was found on
    // production as a shared-cache HIT, age 1427, serving a stranger's IPv6
    // address. The WhatsApp webhook's GET verification echo is text/plain
    // too. robots.txt, security.txt and llms.txt now set their own week-long
    // TTL rather than relying on this middleware.
    const txt = () => new Response("User-agent: *", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    expect(await cacheControl("/robots.txt", txt)).toBeNull();
    const ip = () => new Response("2a02:6b67::1", { headers: { "Content-Type": "text/plain" } });
    expect(await cacheControl("/frag/ip-address/", ip)).toBeNull();
    // A markdown nearby page still gets the week its Django view asked for:
    // the family rules run on the path, independently of the type gate.
    expect(await cacheControl("/md/needs/at/sid-valley/nearby/", md)).toBe(
      `public, max-age=300, s-maxage=${WEEK}`,
    );
    // The "+" in application/rss+xml is escaped in CACHEABLE_TYPES. Left
    // unescaped it reads as "one or more s", which matches nothing a real RSS
    // response sends -- the feed would silently go back to a 0.0% hit rate.
    // A charset-free type proves the match is a prefix, not an equality.
    const bareRss = () => new Response("<rss/>", { headers: { "Content-Type": "application/rss+xml" } });
    expect(await cacheControl("/needs/rss.xml", bareRss)).toBe(`public, max-age=300, s-maxage=${DAY}`);
  });

  it("keeps out of everything that already sets its own header", async () => {
    // JSON, geojson and images come from routes that set a considered
    // Cache-Control (or deliberately set none, like api1/api3 -- ported
    // straight from Django, which sent none either). This middleware is not
    // allowed to have an opinion about them.
    const typed = (type: string) => () => new Response("body", { headers: { "Content-Type": type } });
    for (const type of [
      "application/json",
      "application/geo+json",
      "image/png",
      "image/svg+xml",
      "text/xml",
      "application/xml",
      "application/rss",
      "text/css",
      "application/javascript",
      "font/woff2",
      "application/octet-stream",
    ]) {
      expect(await cacheControl("/", typed(type))).toBeNull();
    }
  });

  it("does nothing when there is no Content-Type at all", async () => {
    // `?? ""` then a failed regex test, rather than a throw on null. A
    // middleware mounted on "*" that threw would take down every response
    // it could not classify.
    const bare = () => {
      const res = new Response("body");
      res.headers.delete("Content-Type");
      return res;
    };
    expect(await cacheControl("/", bare)).toBeNull();
    const empty = () => new Response("body", { headers: { "Content-Type": "" } });
    expect(await cacheControl("/", empty)).toBeNull();
  });

  it("anchors the type match at the start, so a type is never matched mid-string", async () => {
    // "^" in CACHEABLE_TYPES. Without it, a multipart or vendor type that
    // merely mentions text/html would be treated as a cacheable page.
    const typed = (type: string) => () => new Response("body", { headers: { "Content-Type": type } });
    expect(await cacheControl("/", typed('multipart/mixed; boundary="text/html"'))).toBeNull();
    expect(await cacheControl("/", typed("application/vnd.x+text/plain"))).toBeNull();
  });

  it("matches the Content-Type case-sensitively, which RFC 9110 says it should not", async () => {
    // SUSPECTED BUG, pinned as current behaviour rather than fixed. Media
    // types are case-insensitive by spec, so a route or an upstream that sent
    // "TEXT/HTML" would be a correct HTML response -- and would silently get
    // no Cache-Control, i.e. exactly the 0%-browser-cache state this module
    // was written to end, with nothing to show it had happened. Nothing in
    // this Worker emits an upper-case type today, which is why it is only a
    // latent bug; c.html() and c.text() both lower-case it.
    const typed = (type: string) => () => new Response("body", { headers: { "Content-Type": type } });
    expect(await cacheControl("/", typed("TEXT/HTML; charset=utf-8"))).toBeNull();
    expect(await cacheControl("/", typed("Text/Html"))).toBeNull();
    expect(await cacheControl("/needs/rss.xml", typed("APPLICATION/RSS+XML"))).toBeNull();
  });

  it("prefix-matches the type, so a longer type starting the same way is treated as a page", async () => {
    // CURRENT BEHAVIOUR, pinned because it is the flip side of the prefix
    // match that makes "; charset=utf-8" work. There is no delimiter after
    // the type name, so an invented "text/htmlish" is read as HTML. Harmless
    // today -- no route sends one -- but a test that only ever fed it real
    // types would let a tightening of this regex (adding [;\s] or an end
    // anchor) look like a no-op when it would in fact drop every charset-less
    // response on the floor.
    const typed = (type: string) => () => new Response("body", { headers: { "Content-Type": type } });
    expect(await cacheControl("/", typed("text/htmlish"))).toBe("public, max-age=300, s-maxage=3600");
    // text/plaintext no longer matches anything, since text/plain left the
    // list -- the prefix-matching point is now carried by text/htmlish above.
    expect(await cacheControl("/", typed("text/plaintext"))).toBeNull();
  });

  it("fills in for the helpers real routes use, and only those", async () => {
    // End-to-end through Hono's own body helpers rather than hand-built
    // Responses, because that is what the 60 page handlers actually call and
    // the Content-Type they produce is Hono's to choose, not this repo's.
    const via = async (path: string, handler: (c: Context<AppEnv>) => Response) => {
      const app = new Hono<AppEnv>();
      app.use("*", pageCacheControl);
      app.get("*", handler);
      const res = await app.request(`https://www.givefood.org.uk${path}`, {}, env);
      return res.headers.get("Cache-Control");
    };
    expect(await via("/", (c) => c.html("<p>x</p>"))).toBe(`public, max-age=300, s-maxage=${HOUR}`);
    // c.text() is text/plain and is NOT filled in, deliberately -- see the
    // content-type test above. This is the helper /frag/ip-address/ and the
    // WhatsApp webhook echo both use, and neither may be shared. The routes
    // that genuinely want a plain-text page (robots.txt, security.txt,
    // llms.txt) now say so themselves with Django's own week.
    expect(await via("/robots.txt", (c) => c.text("User-agent: *"))).toBeNull();
    // c.json() is the API, which Django left uncached and this port leaves
    // to the route -- so the gap-filler must not reach it.
    expect(await via("/api/2/foodbanks/", (c) => c.json({ ok: true }))).toBeNull();
  });
});
