import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import app from "../../index";
import { serverTiming } from "../../middleware/serverTiming";
import { resolveLanguage } from "../../middleware/resolveLanguage";
import { annualReport } from "./annualReport";
import type { AppEnv } from "../../types";
import type { Env } from "../../../worker-configuration";

// routes/public/annualReport.ts -- the two handlers behind givefood's
// `annual_report_index` (GET /annual-reports/) and `annual_report`
// (GET /<year>/), ported from givefood/views.py:431-443 and registered by
// index.ts:431/471 under the same fixed year alternation Django's
// re_path uses.
//
// WHY THIS FILE EXISTS. Both handlers are three lines of "build a context,
// render a template", which is exactly the shape that looks untestable and
// then fails silently. Three things can go wrong here, and none of them
// shows up as an error:
//
//   * THE WRONG TEMPLATE. YEAR_TEMPLATES is a hand-maintained map of seven
//     keys to seven filenames. Point 2021 at 2020.njk and the site serves a
//     perfectly well-formed 200 that is simply the wrong year's report --
//     for a week, because pageCacheControl gives these pages s-maxage
//     604800 and cacheTag assigns them no tag, so nothing can purge them.
//     Every test below that names a year asserts a marker unique to THAT
//     year's template rather than "a page rendered".
//   * THE ALLOWLIST TURNING BACK INTO AN INTERPOLATION. The module's own
//     comment calls YEAR_TEMPLATES a belt-and-braces guard against
//     template-path injection, on the grounds that Django's urls.py regex
//     was "the ONLY guard" in the original app. That claim is only worth
//     anything if something exercises it, and the real router never can --
//     it only ever hands over one of the seven keys. See the "defensive
//     guard" block at the bottom for how it is exercised, and for the one
//     input that makes the difference concrete: `index`, which
//     `public/ar/${year}.njk` would happily resolve to a real template.
//   * THE PORTED COPY-PASTE BUGS BEING "FIXED". Three of the seven Django
//     templates carry wrong og: metadata (2019's is 2020's outright, 2022's
//     og:image is 2021's, 2024's og:title says 2023). Those are pinned here
//     against the Python source -- read directly from
//     /Users/jasoncartwright/Sites/foodcharity/givefood/templates/public/ar/
//     on 2026-09-08, not inferred -- so that a well-meaning correction to
//     published social metadata is a decision someone makes on purpose.
//
// REAL APP, REAL TEMPLATES, NO MOCKS. Every request goes through the default
// export of workers/site/src/index.ts, so it runs the real middleware chain
// (serverTiming, securityHeaders, cacheTag, runtimeIdentity, slugRedirect,
// resolveLanguage, geoJsonPreload, pageCacheControl) and the real route
// table, and renders the real .njk through the real nunjucks environment
// with the real .po catalogues. Neither handler touches D1, KV, R2 or a
// queue -- slugRedirect's SLUG_PATTERN only matches /needs/at/ URLs -- so
// nothing is faked, and the DB binding below is deliberately a landmine
// rather than a stub. Nothing here leaves the machine.
//
// MUTATION-TESTED (TESTING.md's convention) in an rsync copy of the whole
// tree under the scratchpad, OUTSIDE the repo -- no file in src/ was edited
// and restored at any point. Twenty-four mutants, deliberately widened past
// annualReport.ts itself because a careless edit to any of these reaches
// these eight pages just as surely as one to the handler: index.ts's route
// table, middleware/pageCacheControl.ts, and the eight .njk templates (each
// template mutant re-runs packages/templates' precompile step, without which
// a .njk edit is inert and the "mutant" proves nothing).
//
// The kills worth naming, because each is a test's reason to exist: 2021
// remapped to 2020.njk; annualReportIndex pointed at a year template; the
// allowlist replaced by `public/ar/${year}.njk`; the `if (!templateName)`
// guard deleted; 2019 dropped from the allowlist; `pageTranslatable: true`
// dropped; `locale` dropped from buildPageContext and, separately, from the
// render() call; `unprefixedPath` replaced by `c.req.path`; render_time_ms
// dropped from each handler; index.ts's :year alternation widened to
// unconstrained and, separately, narrowed to drop 2025; the Welsh
// registration of /annual-reports/ removed; "annual-reports" dropped from
// pageCacheControl's WEEKLY_PAGES and the ANNUAL_REPORT rule deleted; a year
// removed from index.njk's list and a year link repointed at the wrong year;
// 2023's <h1> changed to 2022; index.njk's `url('index')` hardcoded to "/";
// and each of the three ported og: copy-paste bugs "corrected".
//
// ONE MUTANT SURVIVED the first round and is the reason a test was added:
// render_time_ms dropped from annualReportIndex alone, which only the year
// page's copy of that assertion was watching. The two handlers build their
// contexts independently, so both are asserted now.

const ORIGIN = "https://www.givefood.org.uk";

// A binding set that FAILS LOUDLY if either handler ever grows a query.
// Both pages are pure template renders today, and that is a property worth
// defending: they are the longest-cached HTML on the site (a week of shared
// cache, no cache tag), so a D1 read added here would be paid on every edge
// miss for a page whose content changes once a year. `withSession` throwing
// turns that regression into a 500 in these tests rather than a silent cost
// in production. It is not a stub standing in for a database -- there is no
// database in this story at all.
const env = {
  DB: {
    withSession: () => {
      throw new Error("annualReport must not touch D1: both pages are static template renders");
    },
  },
} as unknown as Env;

// index.ts's app.notFound() calls lib/appendSlash.ts, which re-enters the app
// with a HEAD probe and reads `c.executionCtx` to do it -- so a request made
// without one throws "This context has no ExecutionContext" and the
// APPEND_SLASH tests below come back 500 instead of 301. Every request here
// goes through app.fetch with a real third argument for that reason; the
// Workers runtime always supplies one, so this is the harness matching
// production rather than a workaround. Same shape as routes/apiDocs.test.ts.
const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

const fetchWith = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env, execCtx);
const get = (path: string) => fetchWith(path);
const body = async (path: string): Promise<string> => (await get(path)).text();

// includes/debugcomment.njk stamps a wall-clock time and a render duration
// into every page. Both legitimately differ between two responses of the
// same URL, so they are the only things normalised before a byte-for-byte
// comparison -- and this asserts it actually found both, so a template
// change that removed them could not quietly turn the comparison below into
// a comparison of nothing.
function withoutClockNoise(html: string): string {
  expect(html).toMatch(/🕰️ Generated at .+/);
  expect(html).toMatch(/⏱️ Took \d+ms/);
  return html.replace(/🕰️ Generated at .+/, "🕰️ Generated at <T>").replace(/⏱️ Took \d+ms/, "⏱️ Took <N>ms");
}

// The year list on /annual-reports/, as "href|blurb" pairs. Parsing the
// pairs rather than asserting a slab of markup keeps the claim on the two
// things that matter -- which years are offered, in which order, described
// how -- while still pinning the exact strings and the exact sequence.
function yearLinks(html: string): string[] {
  return [...html.matchAll(/<a class="is-size-4" href="([^"]+)">[^<]*<\/a><br>\s*<p>([^<]*)<\/p>/g)].map((m) => `${m[1]}|${m[2]}`);
}

// The <link rel="alternate"> set page.njk emits when page_translatable is
// true, as "hreflang|href".
function alternates(html: string): string[] {
  return [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => `${m[1]}|${m[2]}`);
}

// ---------------------------------------------------------------------------
// annualReportIndex -- GET /annual-reports/
// ---------------------------------------------------------------------------

describe("annualReportIndex -- GET /annual-reports/", () => {
  // THE PAGE IS THE LIST. There is nothing else on it: seven links and seven
  // one-line summaries, newest first. A year silently dropped from the
  // template, or the list reordered oldest-first, renders a page that looks
  // entirely correct to anyone not holding last week's copy next to it.
  // Asserted verbatim against givefood/templates/public/ar/index.html, whose
  // `&amp;` entities are literal inside the {% blocktrans %} msgids (they are
  // the msgid text in the .po catalogue too, not an escaping artefact).
  it("lists all seven reports newest first, with each year's own summary", async () => {
    expect(yearLinks(await body("/annual-reports/"))).toEqual([
      "/2025/|Even more AI, translations and mobile apps",
      "/2024/|AI, general election, site translation",
      "/2023/|Rebrand, refresh, rewrite &amp; categorisation",
      "/2022/|Write to your MP tool, surplus monitoring, data audits",
      "/2021/|Data &amp; UX review, dashboards, charity reporting",
      "/2020/|Pandemic response, becoming a charity, publishing our data",
      "/2019/|Initial deliveries, Christmas",
    ]);
  });

  // Every year the index offers must actually be one of YEAR_TEMPLATES' keys.
  // The two lists are maintained in different files by different people --
  // a template and a TypeScript map -- and publishing next year's report
  // means editing both. Getting only the template means the index links
  // straight at a 404; this is the test that says so before a reader finds
  // out.
  it("links only at years the router and the allowlist actually serve", async () => {
    const hrefs = yearLinks(await body("/annual-reports/")).map((pair) => pair.split("|")[0]!);

    for (const href of hrefs) {
      expect((await get(href)).status).toBe(200);
    }
  });

  it("renders the index template, with its title and meta description", async () => {
    const res = await get("/annual-reports/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Annual reports - Give Food</title>");
    expect(html).toContain("<h1>Annual reports</h1>");
    expect(html).toContain(
      '<meta name="description" content="Give Food is a UK charity that uses data to highlight local and structural food insecurity then provides tools to help alleviate it.">',
    );
    // Named explicitly rather than left implied by the title: this is what
    // distinguishes "rendered public/ar/index.njk" from "rendered one of the
    // seven year templates", which is the mutant a title-only assertion in a
    // file full of year pages would be most likely to miss.
    expect(html).not.toMatch(/<h1>\d{4} annual report<\/h1>/);
  });

  // buildPageContext({ path: c.req.path }) -- canonical is the request's own
  // path, matching context_processors.py:17-19's SITE_DOMAIN + translate_url(path).
  it("declares itself canonical at its own URL", async () => {
    expect(await body("/annual-reports/")).toContain(`<link rel="canonical" href="${ORIGIN}/annual-reports/">`);
  });

  // givefood/views.py:430 -- @cache_page(SECONDS_IN_WEEK) on annual_report_index,
  // reproduced by pageCacheControl's WEEKLY_PAGES rule, which lists
  // "annual-reports" by name. The browser number is this port's deliberate
  // divergence (see that middleware: a browser cache cannot be purged), the
  // shared number is Django's.
  it("is cached for a week at the edge, as @cache_page(SECONDS_IN_WEEK) asked", async () => {
    expect((await get("/annual-reports/")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
  });

  // The page's ONE claim to being dynamic is that it is not: no D1, no KV, no
  // fetch. `env.DB.withSession` throws, so a query added to this handler
  // surfaces here as a 500 instead of as a per-request cost nobody notices
  // on a page cached for a week.
  it("reads no database at all", async () => {
    expect((await get("/annual-reports/")).status).toBe(200);
  });

  // Asserted for this handler SEPARATELY from the year page's identical test,
  // because the two build their render contexts independently: a mutant that
  // dropped render_time_ms from annualReportIndex alone survived while only
  // the year page was asked. What it renders is "⏱️ Took ms", which is inside
  // an HTML comment and which no reader would ever think to report.
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body("/annual-reports/")).toMatch(/⏱️ Took \d+ms\n/);
  });
});

describe("annualReportIndex -- translation", () => {
  // pageTranslatable: true is what makes page.njk emit the alternates, and
  // `unprefixedPath` is what makes them right. Both are single arguments in
  // the handler with no other visible effect: drop the first and the page
  // stops advertising its three translations to search engines, and get the
  // second wrong (pass c.req.path instead) and the Welsh page advertises
  // /cy/cy/annual-reports/ -- a 404 -- as its own alternate.
  it("advertises all four languages, built from the unprefixed path", async () => {
    const expected = [
      `en|${ORIGIN}/annual-reports/`,
      `cy|${ORIGIN}/cy/annual-reports/`,
      `ga|${ORIGIN}/ga/annual-reports/`,
      `gd|${ORIGIN}/gd/annual-reports/`,
    ];

    expect(alternates(await body("/annual-reports/"))).toEqual(expected);
    // Identical set from the Welsh URL, not a set relative to it.
    expect(alternates(await body("/cy/annual-reports/"))).toEqual(expected);
  });

  // The locale reaches THREE separate places from this handler: the context
  // (language_code, used for <html lang>), the render() call (which catalogue
  // {% blocktrans %} reads), and through render() into url(), which is what
  // puts the /cy prefix on the logo link. A locale threaded into only some of
  // them produces a page that is half-translated and links out of Welsh, and
  // all three are asserted here for that reason.
  it("renders in Welsh, from the real .po catalogue, with Welsh links", async () => {
    const html = await body("/cy/annual-reports/");

    expect(html).toContain('<html lang="cy" dir="ltr"');
    expect(html).toContain("<title>Adroddiadau blynyddol - Give Food</title>");
    expect(html).toContain("<h1>Adroddiadau blynyddol</h1>");
    expect(html).toContain("<p>Dosbarthiadau cychwynnol, Nadolig</p>");
    expect(html).toContain('<a href="/cy/" class="logo">');
  });

  it("sets Content-Language from the URL prefix, not from a request header", async () => {
    expect((await get("/annual-reports/")).headers.get("Content-Language")).toBe("en");
    expect((await get("/gd/annual-reports/")).headers.get("Content-Language")).toBe("gd");
    // Rule 1 of middleware/resolveLanguage.ts: the path prefix is the only
    // thing that ever wins. Asserted from a page that really is translated,
    // because "Accept-Language is ignored" is only convincing where honouring
    // it would have produced something different.
    const negotiated = await fetchWith("/annual-reports/", { headers: { "Accept-Language": "cy" } });
    expect(negotiated.headers.get("Content-Language")).toBe("en");
    expect(await negotiated.text()).toContain("<h1>Annual reports</h1>");
  });

  // PINNED, AND SUSPECT -- but ported, not introduced. index.njk hardcodes
  // `href="/2025/"` rather than calling url('annual_report', '2025'), exactly
  // as givefood/templates/public/ar/index.html does. So a Welsh reader on
  // /cy/annual-reports/ clicks a year and lands on the unprefixed URL,
  // dropping out of Welsh -- the whole page chrome reverts to English.
  // Everything else on the site that links between i18n_patterns pages goes
  // through url(), which is why this is worth a test rather than a shrug:
  // the fix is one template edit, and it must be a decision.
  it("keeps the year links unprefixed on a Welsh page, exactly as Django's template does", async () => {
    const hrefs = yearLinks(await body("/cy/annual-reports/")).map((pair) => pair.split("|")[0]!);

    expect(hrefs).toEqual(["/2025/", "/2024/", "/2023/", "/2022/", "/2021/", "/2020/", "/2019/"]);
    expect(hrefs.some((href) => href.startsWith("/cy/"))).toBe(false);
  });

  // "en" is never a URL prefix (prefix_default_language=False in Django,
  // PREFIXES in resolveLanguage.ts), so /en/... is not a language-prefixed
  // form of anything -- it is simply not a route. Asserted because a router
  // change that derived prefixes from LOCALES *including* en would silently
  // create a duplicate of every page on the site at a second URL.
  it("has no /en/ form -- that is a 404, not the English page", async () => {
    expect((await get("/en/annual-reports/")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// annualReport -- GET /<year>/
// ---------------------------------------------------------------------------

// Per-year markers, each read out of the corresponding .njk. The title and
// the h1 are what identify the template; the og: block is what a link
// preview shows. THREE OF THESE SEVEN ROWS ARE DELIBERATELY WRONG, and
// wrong in the Django source too -- see each note. Verified 2026-09-08 by
// reading givefood/templates/public/ar/{2019,2022,2024}.html in the
// read-only Django checkout, not inferred from the port's own comments.
const YEARS = [
  {
    year: "2019",
    // og:title, og:description and og:image all say 2020 on the 2019 report.
    // Django's 2019.html lines 8-11, verbatim. The port's template carries a
    // comment saying so; this is the assertion that keeps it true.
    ogTitle: "Give Food 2020 Annual Report",
    ogDescription: "Find out what we've been done in 2020",
    ogImage: `${ORIGIN}/static/img/ar/2020/sharing.jpg`,
  },
  {
    // The page 2019's metadata was copied FROM, which is why "been done"
    // (sic) and the .jpg are correct here and only here.
    year: "2020",
    ogTitle: "Give Food 2020 Annual Report",
    ogDescription: "Find out what we've been done in 2020",
    ogImage: `${ORIGIN}/static/img/ar/2020/sharing.jpg`,
  },
  {
    year: "2021",
    ogTitle: "Give Food 2021 Annual Report",
    ogDescription: "Find out what we've been doing in 2021",
    ogImage: `${ORIGIN}/static/img/ar/2021/sharing.png`,
  },
  {
    year: "2022",
    ogTitle: "Give Food 2022 Annual Report",
    ogDescription: "Find out what we've been doing in 2022",
    // og:image points at 2021's asset. Django's 2022.html line 11.
    ogImage: `${ORIGIN}/static/img/ar/2021/sharing.png`,
  },
  {
    year: "2023",
    ogTitle: "Give Food 2023 Annual Report",
    ogDescription: "Find out what we've been doing in 2023",
    ogImage: `${ORIGIN}/static/img/ar/2023/sharing.png`,
  },
  {
    year: "2024",
    // og:title says 2023 on the 2024 report. Django's 2024.html line 8.
    ogTitle: "Give Food 2023 Annual Report",
    ogDescription: "Find out what we've been doing in 2024",
    ogImage: `${ORIGIN}/static/img/ar/2024/sharing.png`,
  },
  {
    year: "2025",
    ogTitle: "Give Food 2025 Annual Report",
    ogDescription: "Find out what we've been doing in 2025",
    ogImage: `${ORIGIN}/static/img/ar/2025/sharing.png`,
  },
] as const;

describe("annualReport -- GET /<year>/", () => {
  // THE CENTRAL TEST OF THE FILE. YEAR_TEMPLATES is seven hand-written
  // key/value pairs, and every single-character mistake in it -- 2021 mapped
  // to 2020.njk, two keys pointing at one file, a year quietly missing --
  // produces a 200 carrying the wrong report. The title and the <h1> come
  // from different blocks of the template, so both must move together for a
  // mis-mapping to slip through; and each is asserted for the year requested,
  // not merely for "a year".
  it.each(YEARS.map((y) => y.year))("serves %s's own report, not a neighbouring year's", async (year) => {
    const res = await get(`/${year}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain(`<title>${year} Give Food Annual Report</title>`);
    expect(html).toContain(`<h1>${year} annual report</h1>`);
    // Every OTHER year's headline is absent, so a template that somehow
    // included two years' bodies fails here rather than passing on the strength
    // of the one string it was asked about.
    for (const other of YEARS.map((y) => y.year).filter((y) => y !== year)) {
      expect(html).not.toContain(`<h1>${other} annual report</h1>`);
    }
  });

  // PINNED, INCLUDING THREE REAL DEFECTS. These are the strings a link
  // preview shows on social media and in a chat client; three of the seven
  // are wrong, and they are wrong in Django too (see the YEARS table). The
  // reason they are asserted rather than corrected is TESTING.md's rule --
  // this is a port, and rewriting published social metadata is a content
  // decision, not a typo repair. If someone fixes them on purpose, this test
  // is where the fix gets recorded.
  it.each(YEARS)("carries $year's ported og: metadata, copy-paste bugs and all", async ({ year, ogTitle, ogDescription, ogImage }) => {
    const html = await body(`/${year}/`);

    expect(html).toContain(`<meta property="og:title" content="${ogTitle}">`);
    expect(html).toContain(`<meta property="og:description" content="${ogDescription}">`);
    expect(html).toContain(`<meta property="og:image" content="${ogImage}">`);
    // The two twitter: lines are the same on all seven and are the rest of
    // what a preview reads.
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).toContain('<meta name="twitter:site" content="@GiveFoodCharity">');
  });

  it("declares each year canonical at its own URL", async () => {
    expect(await body("/2025/")).toContain(`<link rel="canonical" href="${ORIGIN}/2025/">`);
    expect(await body("/2019/")).toContain(`<link rel="canonical" href="${ORIGIN}/2019/">`);
  });

  // givefood/views.py:438 -- @cache_page(SECONDS_IN_WEEK), reproduced by
  // pageCacheControl's ANNUAL_REPORT rule. The absent Cache-Tag is the half
  // worth knowing: cacheTag.ts assigns these paths nothing, so there is no
  // way to purge a year's report at the edge short of a URL purge. That is
  // fine for a document that changes once a year, and it is exactly why the
  // "wrong template" tests above matter -- a mis-mapped year would be stuck
  // for up to a week.
  it("is cached for a week and carries no cache tag to purge it with", async () => {
    const res = await get("/2025/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  it("reads no database at all", async () => {
    expect((await get("/2019/")).status).toBe(200);
  });

  // Nothing on these pages is per-visitor: no CSRF token, no session, no
  // Set-Cookie. That is the precondition for the week of SHARED cache the
  // test above pins -- middleware/pageCacheControl.ts records an incident
  // where a page carrying a per-visitor token was marked public and served
  // to everyone -- so it is asserted as the property rather than as the
  // absence of any one line.
  it("gives two different visitors byte-identical HTML, which is what makes a week of shared cache safe", async () => {
    const first = await get("/2023/");
    const second = await fetchWith("/2023/", { headers: { Cookie: "__Host-csrf=someone-elses-token" } });

    expect(first.headers.get("Set-Cookie")).toBeNull();
    expect(second.headers.get("Set-Cookie")).toBeNull();
    expect(withoutClockNoise(await second.text())).toBe(withoutClockNoise(await first.text()));
  });

  // The debug comment's "Took Nms" is elapsedMs(c), read off the timestamp
  // middleware/serverTiming.ts stored. WHOLE milliseconds, deliberately not
  // Django's three decimals: performance.now() is coarsened on Workers and
  // the fraction was always exactly ".000". A route that timed itself instead
  // of reading the middleware's start time would report ~0 for the render
  // rather than for the request.
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body("/2021/")).toMatch(/⏱️ Took \d+ms\n/);
  });
});

describe("annualReport -- translation", () => {
  // page_translatable is true for the year pages as well, because Django
  // computed it the same way: annual_report sits inside i18n_patterns, so
  // translate_url("/2025/", "cy") returns "/cy/2025/" and
  // context_processors.py:33's test passes. The alternates are therefore
  // advertised even though the report BODY is English-only -- see the next
  // test. Ported behaviour, pinned rather than judged.
  it("advertises all four languages for a year page too", async () => {
    expect(alternates(await body("/2025/"))).toEqual([
      `en|${ORIGIN}/2025/`,
      `cy|${ORIGIN}/cy/2025/`,
      `ga|${ORIGIN}/ga/2025/`,
      `gd|${ORIGIN}/gd/2025/`,
    ]);
  });

  // WHAT /cy/2025/ ACTUALLY IS: Welsh chrome around an English report. The
  // seven year templates contain no {% blocktrans %} and no _() at all --
  // verified by reading all seven -- so only page.njk's shared header and
  // footer translate. Worth pinning because the two halves fail in opposite
  // directions: lose the locale and the chrome silently reverts to English
  // on a URL that promises Welsh; "fix" the body by wrapping a report in
  // blocktrans and several hundred untranslated msgids enter the catalogue.
  it("renders Welsh chrome around an untranslated English report", async () => {
    const html = await body("/cy/2025/");

    expect(html).toContain('<html lang="cy" dir="ltr"');
    expect(html).toContain("<h1>2025 annual report</h1>"); // the report itself: English
    expect(html).toContain('<a href="/cy/" class="logo">'); // url() carries the prefix
    expect(html).toContain("Adroddiadau blynyddol"); // page.njk's footer nav: Welsh
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/cy/2025/">`);
  });
});

describe("annualReport -- which years exist", () => {
  // index.ts's `:year{2019|...|2025}` reproduces Django's re_path alternation
  // exactly. A year with no template must 404 at the ROUTER, before the
  // handler runs -- 2026 is the interesting one, because it is the year this
  // list will next need extending and the failure mode of forgetting is a
  // link from the index page to a 404.
  it.each(["2018", "2026", "1999", "2099", "0000"])("404s /%s/, which has no report", async (year) => {
    const res = await get(`/${year}/`);

    expect(res.status).toBe(404);
    // The real 404 page, not a rendered report and not Hono's bare default.
    expect(await res.text()).toContain("<h1>404");
  });

  // A four-digit-looking year that is not one of the seven, in the shapes a
  // loosened regex would let through. `20255` and `2025x` matter because a
  // rule written as a prefix or an unanchored match rather than an
  // alternation would accept them.
  it.each(["20255", "2025x", "202", "twenty25"])("404s /%s/, which is not a year at all", async (fake) => {
    expect((await get(`/${fake}/`)).status).toBe(404);
  });

  // Same alternation under every locale prefix -- the loop at index.ts:472
  // registers all four independently, so a year could in principle be live in
  // English and 404 in Welsh.
  it("serves and refuses the same years under every locale prefix", async () => {
    for (const locale of ["cy", "ga", "gd"]) {
      expect((await get(`/${locale}/2025/`)).status).toBe(200);
      expect((await get(`/${locale}/2026/`)).status).toBe(404);
    }
  });

  // Django's APPEND_SLASH, via lib/appendSlash.ts. /2025 is what a person
  // types and what an old link looks like; a 404 there would lose the page.
  it("301s a year requested without its trailing slash", async () => {
    const res = await get("/2025");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/2025/`);
    // ...and does not redirect for a year that has no report, because the
    // probe genuinely re-enters the app and gets a 404 back.
    expect((await get("/2026")).status).toBe(404);
  });

  it("301s /annual-reports without its trailing slash", async () => {
    const res = await get("/annual-reports");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/annual-reports/`);
  });
});

// ---------------------------------------------------------------------------
// The defensive guard -- annualReport's own allowlist
// ---------------------------------------------------------------------------

// annualReport.ts justifies YEAR_TEMPLATES as a SECOND guard against
// template-path injection, independent of index.ts's route regex: "even a
// future routing change can't turn `year` into an arbitrary template path".
// The real router can never test that claim, because it only ever supplies
// one of the seven keys -- so the claim would go unexercised forever and the
// map could be replaced by `public/ar/${year}.njk` with every test above
// still green.
//
// This mounts the REAL handler, unmodified, behind the REAL serverTiming and
// resolveLanguage middleware (annualReport reads `lang`, `pathAfterPrefix`
// and `requestStartTime`, all of which those two set), on a route whose
// :year param is deliberately UNCONSTRAINED. It is not a copy of the router
// -- every test above uses the real one -- it is the router's guard removed
// on purpose so the handler's own guard is the only thing left standing.
const unguarded = new Hono<AppEnv>();
unguarded.use("*", serverTiming);
unguarded.use("*", resolveLanguage);
unguarded.get("/:year", annualReport);

const unguardedGet = (year: string) => unguarded.fetch(new Request(`${ORIGIN}/${year}`), env, execCtx);

describe("annualReport -- the allowlist, exercised without the router's regex", () => {
  // THE INPUT THAT MAKES THE DIFFERENCE CONCRETE. `public/ar/index.njk` is a
  // real precompiled template -- it is the index page tested at the top of
  // this file -- so under a `public/ar/${year}.njk` interpolation the year
  // "index" would render a 200 carrying the wrong page. The exact-lookup map
  // returns undefined and the handler 404s. This is the single test that
  // distinguishes the two implementations, and it is why the allowlist is
  // written the way it is.
  it("refuses `index`, which string interpolation would have rendered as a real template", async () => {
    const res = await unguardedGet("index");

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Annual reports");
  });

  // Traversal and filename shapes. None of these can reach the handler
  // through the real app today; the point is that the handler is safe if one
  // ever could, which is exactly what the module comment promises. Note
  // "2025%20": written as a literal trailing space the WHATWG URL parser
  // trims it before Hono ever sees it, so the test would pass against a
  // handler that had no guard at all.
  it.each(["../page", "..%2Fpage", "2025.njk", "%2Fetc%2Fpasswd", "2025%20", "%202025"])(
    "refuses %o rather than turning it into a template path",
    async (year) => {
      expect((await unguardedGet(year)).status).toBe(404);
    },
  );

  // SUSPECT, AND PINNED AS IT BEHAVES. The allowlist is an object LITERAL, so
  // `YEAR_TEMPLATES[year]` walks the prototype chain: "constructor" returns
  // Object itself and "__proto__" returns Object.prototype. Both are truthy,
  // so both sail straight past `if (!templateName)` and reach render(), which
  // throws "template names must be a string" -- a 500, not the 404 the guard
  // was written to produce. The module's claim that "even a future routing
  // change can't turn `year` into an arbitrary template path" holds (nothing
  // is rendered, and neither value names a template), but the guard is two
  // keys short of the total lookup it is described as.
  //
  // NOT REACHABLE TODAY, and that is the reason this is asserted rather than
  // fixed: index.ts's `:year{2019|...|2025}` never delivers either string, as
  // the companion assertion below shows. It matters only if the second guard
  // ever becomes the first one -- which is the exact scenario the allowlist
  // exists for. A null-prototype map or Object.hasOwn() would close it;
  // reported, not changed, per TESTING.md.
  it.each(["constructor", "__proto__"])("500s on %o -- an inherited property passes the guard as a template name", async (year) => {
    expect((await unguardedGet(year)).status).toBe(500);
  });

  it("is protected from that today only by the router's own year alternation", async () => {
    // Through the REAL app, where the regex is in force, both are ordinary
    // 404s and never reach the handler at all.
    expect((await get("/constructor/")).status).toBe(404);
    expect((await get("/__proto__/")).status).toBe(404);
  });

  // The positive control. Without this the whole block would pass against a
  // handler that 404s unconditionally, which is the classic way a negative
  // test suite ends up proving nothing.
  it("still serves a real year through the unguarded route, so the 404s above mean something", async () => {
    const res = await unguardedGet("2025");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>2025 annual report</h1>");
  });
});
