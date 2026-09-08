import { describe, expect, it } from "vitest";
import app from "../../index";
import type { Env } from "../../../worker-configuration";

// routes/public/donate.ts -- the single handler behind givefood's `donate`
// view (GET /donate/), ported from givefood/views.py:483-488 and registered
// by index.ts:421 plus the LOCALES loop at :437.
//
// WHY THIS FILE EXISTS. The handler is six lines of "build a context, render
// a template", which is exactly the shape that looks untestable and then
// fails silently. This particular page is also the one page on the site
// whose failure costs money rather than credibility:
//
//   * THE CAF DONATE LINK. `https://cafdonate.cafonline.org/24602` is the
//     charity's own CAF campaign id, and it is the only thing on this page
//     a visitor is asked to click. A wrong digit there does not 404 in any
//     way this suite could see -- it sends a stranger's donation to a
//     different registered charity, and it does so for a WEEK, because
//     pageCacheControl gives /donate/ s-maxage=604800 and cacheTag assigns
//     it no tag at all (asserted below), so nothing short of a manual URL
//     purge takes it back. The whole-body assertion is the guard.
//   * THE WRONG TEMPLATE. `render("public/donate.njk", ...)` is a string
//     literal; point it at about_us.njk or apps.njk and the site serves a
//     well-formed 200 that is simply not the donate page. Every assertion
//     here names something unique to THIS template rather than "a page
//     rendered".
//   * THE FOUR CATALOGUES. locale reaches three separate places from this
//     handler (buildPageContext, render()'s third argument, and through
//     render() into url()), and a locale threaded into only some of them
//     produces a half-Welsh page that links out of Welsh. All three are
//     asserted per locale.
//
// REAL APP, REAL TEMPLATES, NO MOCKS. Every request goes through the default
// export of workers/site/src/index.ts, so it runs the real middleware chain
// (serverTiming, securityHeaders, cacheTag, runtimeIdentity, slugRedirect,
// resolveLanguage, geoJsonPreload, pageCacheControl) and the real route
// table, and renders the real public/donate.njk through the real nunjucks
// environment against the real .po catalogues. The handler touches no D1,
// KV, R2 or queue -- slugRedirect's pattern only matches /needs/at/ URLs --
// so nothing is faked and nothing leaves the machine. Same harness as
// routes/public/annualReport.test.ts and routes/public/md.test.ts.
//
// MUTATION-TESTED in a copy of the whole tree under the scratchpad, outside
// the repo; no file under this repo's src/ was edited at any point. Sixteen
// mutants were applied one at a time and every one was killed:
//
//   donate.ts -- template name swapped for public/about_us.njk, and for
//   public/apps.njk; `pageTranslatable: true` -> false (the four hreflang
//   alternates vanish); `locale` dropped from buildPageContext (a /cy/ URL
//   renders <html lang="en"> and loses its alternates entirely, because
//   buildPageContext only builds `languages` when a locale is passed);
//   `locale` dropped from render()'s third argument (Welsh chrome, English
//   body, unprefixed url()); `unprefixedPath` -> `c.req.path` (every
//   alternate on the Welsh page gains a second /cy); `path: c.req.path` ->
//   the unprefixed path (canonical on /cy/donate/ loses its prefix);
//   `render_time_ms` dropped ("Took ms"); `c.html(html)` -> `c.text(html)`
//   (Content-Type stops matching pageCacheControl's CACHEABLE_TYPES, so the
//   week of edge cache silently disappears).
//
//   index.ts -- the `/donate/` registration deleted, and separately the
//   locale-loop `/${locale}/donate/` registration deleted.
//
//   the template and the catalogues -- the CAF campaign id changed to 24603;
//   the managed-donations mailto changed; the cy msgstr for "To", for the
//   CAF button label and for the meta description each changed; the ga
//   msgstr for "Donate" changed. (Catalogues are compiled to
//   src/generated/locales/*.json at build time, so a .po edit alone does
//   nothing at runtime -- these were applied to the compiled JSON.)
//
//   pageCacheControl.ts -- "donate" removed from WEEKLY_PAGES (the page
//   silently drops from a week of shared cache to a day).
//
//   resolveLanguage.ts -- `Vary: Accept-Language` reinstated, and separately
//   Accept-Language negotiation added; both are the failure issue #39
//   removed and the file's closing paragraph warns against.

const ORIGIN = "https://www.givefood.org.uk";

// A binding set that FAILS LOUDLY if this handler ever grows a query. The
// page is a pure template render today and that is worth defending: it is
// among the longest-cached HTML on the site (a week of shared cache, no
// cache tag), so a D1 read added here is paid on every edge miss for a page
// whose content changes once a year. `withSession` throwing turns that
// regression into a 500 in these tests rather than a silent cost in
// production. This is not a stub standing in for a database -- there is no
// database in this story at all.
const env = {
  DB: {
    withSession: () => {
      throw new Error("publicDonate must not touch D1: /donate/ is a static template render");
    },
  },
} as unknown as Env;

// index.ts's app.notFound() calls lib/appendSlash.ts, which re-enters the app
// with a HEAD probe and reads `c.executionCtx` to do it -- so a request made
// without one throws "This context has no ExecutionContext" and the
// APPEND_SLASH tests below come back 500 instead of 301. The Workers runtime
// always supplies one, so this is the harness matching production rather
// than a workaround.
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

// The <link rel="alternate"> set page.njk:25 emits when page_translatable is
// true, as "hreflang|href".
function alternates(html: string): string[] {
  return [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => `${m[1]}|${m[2]}`);
}

// ---------------------------------------------------------------------------
// The page itself
// ---------------------------------------------------------------------------

// THE ENTIRE `{% block body %}` OUTPUT, verbatim. Rendered once and pasted
// here rather than reconstructed from the template, so it pins the copy, the
// two outbound destinations and the markup together.
//
// Checked line for line against the Django original,
// /Users/jasoncartwright/Sites/foodcharity/givefood/templates/public/donate.html,
// read on 2026-09-08: same four `columns is-centered` blocks in the same
// order (logo, h1, the two donation routes side by side, managed
// donations), same headings, same paragraphs, same CAF campaign id 24602,
// same mailto. The only differences are whitespace (the .njk is indented two
// spaces where the .html is four) and `{% url 'wfbn:index' %}` becoming
// `{{ url('wfbn:index') }}`, which resolves to the same /needs/.
//
// The £ is a literal pound sign, not `&pound;`: nunjucks autoescaping only
// touches the five XML metacharacters, and a regression that started
// entity-encoding it would show up here rather than as a mystery on the
// rendered page.
const ENGLISH_BODY = `  <div class="columns is-centered">
    <div class="column is-half">
      <a href="/" class="logo"><img src="/static/img/logo.svg" alt="Give Food"></a>
    </div>
  </div>

  <div class="columns is-centered">
    <div class="column is-half content">
      <h1>Donate</h1>
    </div>
  </div>

  <div class="columns is-centered">
    <div class="column is-one-quarter content">
      <h2>To Give Food</h2>
      <p>All donations from the public to Give Food are used directly to efficiently and quickly deliver requested food and supplies to UK food banks.</p>
      <p><a href="https://cafdonate.cafonline.org/24602" class="button is-link">Donate using CAF Donate</a></p>
    </div>
    <div class="column is-one-quarter content">
      <h2>To a food bank</h2>
      <p>Use our tool to find a local food bank and see what they need. Then donate food, household supplies, toiletries, money or your time.</p>
      <p><a href="/needs/" class="button is-link">Find a food bank</a></p>
    </div>
  </div>

  <div class="columns is-centered">
    <div class="column is-half">
      <h2>Managed donations</h2>
      <p>For donations or grants of £500 or more we can provide a managed service. Leveraging our data and logistical expertise we can ensure your donation is used to effectively deliver the required items to food banks that match your charitable aims. Realtime reports and tracking of how your donation is used are provided.</p>
      <p><a href="mailto:mail@givefood.org.uk">mail@givefood.org.uk</a></p>
    </div>
  </div>
`;

describe("publicDonate -- GET /donate/", () => {
  // THE CENTRAL TEST OF THE FILE. One contiguous run of ~30 lines, so a
  // changed word, a changed href or a section inserted between two blocks
  // all break contiguity and fail here. The counted assertions after it
  // close the two gaps a substring match leaves open -- a fourth section
  // appended after the last block, or a second page's worth of markup
  // wrapped around the whole thing.
  it("renders the whole donate page body, copy and destinations included", async () => {
    const res = await get("/donate/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain(ENGLISH_BODY);
    expect(html.match(/class="columns is-centered"/g)).toHaveLength(4);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html.match(/<h2>/g)).toHaveLength(3);
  });

  // THE ONE STRING ON THIS PAGE THAT MOVES MONEY, called out on its own so a
  // failure names the consequence rather than pointing at a 30-line diff.
  // 24602 is Give Food's CAF campaign id; another charity's number renders a
  // page that is correct in every other respect and takes donations away for
  // a week (see this file's header for why a week).
  it("points the donate button at CAF campaign 24602 and nowhere else", async () => {
    const html = await body("/donate/");

    expect(html).toContain('<a href="https://cafdonate.cafonline.org/24602" class="button is-link">Donate using CAF Donate</a>');
    expect(html.match(/cafdonate\.cafonline\.org\/\d+/g)).toEqual(["cafdonate.cafonline.org/24602"]);
  });

  // The second outbound destination: the managed-donations contact address,
  // which is where a £500+ grant enquiry goes. Same reasoning as the CAF id
  // -- a typo here is invisible until someone reports that nobody replied.
  it("gives mail@givefood.org.uk as the managed-donations contact", async () => {
    expect(await body("/donate/")).toContain('<a href="mailto:mail@givefood.org.uk">mail@givefood.org.uk</a>');
  });

  // The head block, which is donate.njk's own (not page.njk's): the <title>
  // identifies which of the ~70 templates rendered, and the meta description
  // is what a search result shows. Both are in `{% block %}`s that a wrong
  // template name would fill with something else entirely.
  it("renders donate.njk's own title and meta description, not another page's", async () => {
    const html = await body("/donate/");

    expect(html).toContain("<title>Donate - Give Food</title>");
    expect(html).toContain(
      '<meta name="description" content="Give Food is a UK charity that uses data to highlight local and structural food insecurity then provides tools to help alleviate it.">',
    );
    // Named explicitly rather than left implied by the title: these are the
    // headings of the two nearest neighbours in index.ts's registration
    // block, and they are what a mis-pointed render() call would produce.
    expect(html).not.toContain("<h1>About us</h1>");
    expect(html).not.toContain("<h1>Apps</h1>");
  });

  // buildPageContext({ path: c.req.path }) -- canonical is the request's own
  // path, matching context_processors.py:17-19's SITE_DOMAIN + translate_url(path).
  it("declares itself canonical at its own URL", async () => {
    expect(await body("/donate/")).toContain(`<link rel="canonical" href="${ORIGIN}/donate/">`);
  });

  // givefood/views.py:483 -- @cache_page(SECONDS_IN_WEEK) on donate(),
  // reproduced by pageCacheControl's WEEKLY_PAGES rule, which lists "donate"
  // by name. The shared number is Django's; the browser number is this
  // port's deliberate divergence (a browser cache cannot be purged -- see
  // that middleware).
  //
  // The absent Cache-Tag is the half worth knowing: cacheTag.ts matches
  // neither a food bank nor a constituency nor an aggregate path here, so
  // there is no way to purge this page at the edge short of a URL purge.
  // That is fine for copy that changes once a year, and it is exactly why
  // the CAF-id test above matters.
  it("is cached for a week at the edge, as @cache_page(SECONDS_IN_WEEK) asked, with no tag to purge it", async () => {
    const res = await get("/donate/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  // The page's ONE claim to being dynamic is that it is not. `env.DB` throws
  // on use, so a query added to this handler surfaces here as a 500 instead
  // of as a per-request cost nobody notices on a page cached for a week.
  it("reads no database at all", async () => {
    expect((await get("/donate/")).status).toBe(200);
  });

  // Nothing here is per-visitor: no CSRF token, no session, no Set-Cookie.
  // That is the PRECONDITION for the week of SHARED cache pinned above --
  // middleware/pageCacheControl.ts records an incident where a page carrying
  // a per-visitor CSRF token was marked public and served to everyone, with
  // every subsequent visitor's form submission rejected -- so it is asserted
  // as the property (two visitors, identical bytes) rather than as the
  // absence of any one line.
  it("gives two different visitors byte-identical HTML, which is what makes a week of shared cache safe", async () => {
    const first = await get("/donate/");
    const second = await fetchWith("/donate/", { headers: { Cookie: "__Host-csrf=someone-elses-token" } });

    expect(first.headers.get("Set-Cookie")).toBeNull();
    expect(second.headers.get("Set-Cookie")).toBeNull();
    expect(withoutClockNoise(await second.text())).toBe(withoutClockNoise(await first.text()));
  });

  // The debug comment's "Took Nms" is elapsedMs(c), read off the timestamp
  // middleware/serverTiming.ts stored at the top of the request. WHOLE
  // milliseconds, deliberately not Django's three decimals: performance.now()
  // is coarsened on Workers and the fraction was always exactly ".000". Drop
  // render_time_ms from the render call and this line reads "Took ms".
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body("/donate/")).toMatch(/⏱️ Took \d+ms\n/);
  });

  // Set by middleware/securityHeaders.ts on every response. Asserted from a
  // real page rather than only in that middleware's own unit test, because
  // the thing that breaks is the wiring, not the header list.
  it("carries the site's security headers", async () => {
    const res = await get("/donate/");

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });
});

// ---------------------------------------------------------------------------
// Translation -- the three arguments that carry the locale
// ---------------------------------------------------------------------------

// Per-locale markers, each read out of the rendered page and each traceable
// to a msgstr in packages/templates/locale/<code>/django.po. Those three .po
// files were diffed against the Django originals under
// /Users/jasoncartwright/Sites/foodcharity/locale/<code>/LC_MESSAGES/ on
// 2026-09-08 for the donate.html msgids specifically; the entries are
// byte-identical, so what these assert is the port's, and Django's, real
// published copy.
//
// `to` is the standalone `{{ _("To") }}` at donate.njk:25, the only bare
// one-word msgid on the page -- it is followed by the untranslated brand
// name, so "At Give Food" / "Ar Give Food" / "Gu Give Food" is the whole
// heading. A catalogue that lost this one entry would fall back to the
// English "To" and read as a typo rather than as a missing translation.
//
// `findLink` is `{{ url('wfbn:index') }}`, and it is the reason "wfbn:index"
// is in packages/urls' I18N_SCOPED set: on a Welsh page it must carry the
// /cy prefix, or the one call to action on the page drops the visitor out of
// their own language. That is a single Set membership away from breaking and
// nothing else on this page would notice.
const LOCALES = [
  {
    code: "en",
    prefix: "",
    title: "Donate - Give Food",
    h1: "Donate",
    to: "To Give Food",
    toFoodbank: "To a food bank",
    caf: "Donate using CAF Donate",
    findLink: "/needs/",
    findLabel: "Find a food bank",
    managed: "Managed donations",
    description: "Give Food is a UK charity that uses data to highlight local and structural food insecurity then provides tools to help alleviate it.",
  },
  {
    code: "cy",
    prefix: "/cy",
    title: "Cefnogi - Give Food",
    h1: "Cefnogi",
    to: "At Give Food",
    toFoodbank: "I fanc bwyd",
    caf: "Cyfrannwch gan ddefnyddio CAF Donate",
    findLink: "/cy/needs/",
    findLabel: "Dod o hyd i fanc bwyd",
    managed: "Rhoddion a reolir",
    description:
      "Elusen yn y DU yw Give Food sy’n defnyddio data i amlygu ansicrwydd bwyd lleol a strwythurol ac yna’n darparu offer i helpu i’w liniaru.",
  },
  {
    code: "ga",
    prefix: "/ga",
    title: "Tabhair Síntiús - Give Food",
    h1: "Tabhair Síntiús",
    to: "Ar Give Food",
    toFoodbank: "Chuig banc bia",
    // PINNED, AND SUSPECT -- but ported, not introduced. The Irish msgstr
    // translates the PRODUCT NAME: CAF's service is called "CAF Donate" in
    // every language, and "CAF Deonaigh" is not a thing a visitor can go and
    // find. Byte-identical to Django's own ga catalogue (verified 2026-09-08
    // against locale/ga/LC_MESSAGES/django.po:1254), so correcting it is a
    // content decision about published copy, not a typo repair -- and this
    // is where that decision gets recorded when someone makes it.
    caf: "Déan deontas ag baint úsáide as CAF Deonaigh",
    findLink: "/ga/needs/",
    findLabel: "Aimsigh banc bia",
    managed: "Síntiúis bhainistithe",
    description:
      "Is carthanas sa Ríocht Aontaithe é Give Food a úsáideann sonraí chun aird a tharraingt ar éiginnteacht bia áitiúil agus struchtúrtha agus a sholáthraíonn uirlisí chun cabhrú le maolú a dhéanamh air.",
  },
  {
    code: "gd",
    prefix: "/gd",
    title: "Thoir seachad - Give Food",
    h1: "Thoir seachad",
    to: "Gu Give Food",
    toFoodbank: "Gu banca bìdh",
    caf: "Thoir seachad a’ cleachdadh CAF Donate",
    findLink: "/gd/needs/",
    findLabel: "Lorg banca bìdh",
    managed: "Tabhartasan air an riaghladh",
    description:
      "Is e carthannas RA a th’ ann an Give Food a bhios a’ cleachdadh dàta gus mì-thèarainteachd bìdh ionadail agus structarail a shoilleireachadh, agus an uairsin a’ toirt seachad innealan gus a lughdachadh.",
  },
] as const;

describe("publicDonate -- translation", () => {
  // THE WHOLE PAGE IN EVERY LANGUAGE. The locale reaches three separate
  // places from this six-line handler and each failure looks different:
  //   * dropped from buildPageContext -> <html lang="en"> on a /cy/ URL and
  //     the alternates vanish (buildPageContext only builds `languages` when
  //     `options.locale` is set);
  //   * dropped from render()'s third argument -> Welsh chrome around an
  //     English body;
  //   * either one dropped -> url('wfbn:index') loses its prefix and the
  //     page's one call to action leaves the language.
  // All three are covered by the assertions below, per locale.
  it.each(LOCALES)("renders /$prefix/donate/ entirely in $code", async (loc) => {
    const res = await get(`${loc.prefix}/donate/`);

    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain(`<html lang="${loc.code}" dir="ltr"`);
    expect(html).toContain(`<title>${loc.title}</title>`);
    expect(html).toContain(`<h1>${loc.h1}</h1>`);
    expect(html).toContain(`<h2>${loc.to}</h2>`);
    expect(html).toContain(`<h2>${loc.toFoodbank}</h2>`);
    expect(html).toContain(`<h2>${loc.managed}</h2>`);
    expect(html).toContain(`<meta name="description" content="${loc.description}">`);
    // url() twice: the logo, and the call to action. Both must carry this
    // page's prefix, and neither is a literal in the template.
    expect(html).toContain(`<a href="${loc.prefix}/" class="logo">`);
    expect(html).toContain(`<a href="${loc.findLink}" class="button is-link">${loc.findLabel}</a>`);
    // The CAF destination is the same absolute URL in all four languages --
    // only the button's label translates.
    expect(html).toContain(`<a href="https://cafdonate.cafonline.org/24602" class="button is-link">${loc.caf}</a>`);
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}${loc.prefix}/donate/">`);
  });

  // pageTranslatable: true is what makes page.njk:24-25 emit the alternates,
  // and `unprefixedPath` is what makes them right. Both are single arguments
  // in the handler with no other visible effect: drop the first and the page
  // stops advertising its three translations to search engines, and get the
  // second wrong (pass c.req.path instead) and the Welsh page advertises
  // /cy/cy/donate/ -- a 404 -- as its own alternate.
  it("advertises all four languages, built from the unprefixed path", async () => {
    const expected = [`en|${ORIGIN}/donate/`, `cy|${ORIGIN}/cy/donate/`, `ga|${ORIGIN}/ga/donate/`, `gd|${ORIGIN}/gd/donate/`];

    for (const loc of LOCALES) {
      // The IDENTICAL set from every one of the four URLs, not a set
      // relative to whichever page is being viewed.
      expect(alternates(await body(`${loc.prefix}/donate/`))).toEqual(expected);
    }
  });

  // Rule 1 of middleware/resolveLanguage.ts: the URL path prefix wins and is
  // the only thing that ever wins. Asserted from a page that really is
  // translated, because "Accept-Language is ignored" is only convincing
  // where honouring it would have produced something visibly different --
  // and this is the header whose Vary was deliberately dropped (issue #39),
  // so a middleware that started reading it would have one visitor's
  // language served to everyone out of the week-long shared cache.
  it("sets Content-Language from the URL prefix, never from a request header", async () => {
    expect((await get("/donate/")).headers.get("Content-Language")).toBe("en");
    expect((await get("/gd/donate/")).headers.get("Content-Language")).toBe("gd");

    const negotiated = await fetchWith("/donate/", { headers: { "Accept-Language": "cy" } });
    expect(negotiated.headers.get("Content-Language")).toBe("en");
    expect(await negotiated.text()).toContain("<h1>Donate</h1>");
    expect(await (await get("/donate/")).text()).not.toContain("<h1>Cefnogi</h1>");
  });

  // No Vary at all on this page -- the counterpart to the test above, and
  // the thing that lets one edge object serve every visitor. resolveLanguage
  // used to append `Vary: Accept-Language` here; removing it was measured
  // and deliberate (issue #39), and re-adding it silently multiplies this
  // page's edge objects by the number of distinct Accept-Language strings
  // on the internet.
  it("sends no Vary header, so one cache entry serves everyone", async () => {
    expect((await get("/donate/")).headers.get("Vary")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Which URLs exist
// ---------------------------------------------------------------------------

describe("publicDonate -- the URL surface", () => {
  // "en" is never a URL prefix (prefix_default_language=False in Django,
  // PREFIXES in resolveLanguage.ts), so /en/donate/ is not the English page
  // -- it is simply not a route. Asserted because a router change that
  // derived prefixes from LOCALES *including* en would silently create a
  // duplicate of every page on the site at a second URL, and duplicate
  // content is the one SEO failure that is invisible from the site itself.
  it("has no /en/ form -- that is a 404, not the English page", async () => {
    const res = await get("/en/donate/");

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<h1>404 - Not Found</h1>");
  });

  // One of Django's other 17 configured languages. resolveLanguage's own
  // comment says these fall through the "no prefix => en" path rather than
  // taking a new one, which means the URL matches no route: the 404 is
  // rendered in English even though the URL asked for German.
  it("404s a language prefix this port does not serve", async () => {
    const res = await get("/de/donate/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // A doubled prefix is what a broken `unprefixedPath` would put in the
  // alternates, so it is worth knowing it is a 404 rather than a second copy
  // of the page: the alternates test above only means something if the URLs
  // it rejects are genuinely dead.
  it("404s a doubled locale prefix", async () => {
    expect((await get("/cy/cy/donate/")).status).toBe(404);
  });

  // Django's APPEND_SLASH, via lib/appendSlash.ts. /donate is what a person
  // types and what a printed link looks like; a 404 there loses the
  // donation. Both the unprefixed and the prefixed form, because the
  // append-slash probe re-enters the app and has to find the prefixed route
  // for the second one to work.
  it("301s /donate and /cy/donate to their slashed forms", async () => {
    const plain = await get("/donate");
    expect(plain.status).toBe(301);
    expect(plain.headers.get("Location")).toBe(`${ORIGIN}/donate/`);

    const welsh = await get("/cy/donate");
    expect(welsh.status).toBe(301);
    expect(welsh.headers.get("Location")).toBe(`${ORIGIN}/cy/donate/`);
  });

  // Paths are case-sensitive and there is no redirect for a shouted URL.
  // Pinned because it is the kind of thing someone "fixes" with a
  // lowercasing middleware, which would then fold every food bank slug too.
  it("404s /DONATE/", async () => {
    expect((await get("/DONATE/")).status).toBe(404);
  });

  // THE MODULE'S OWN SCOPE NOTE, made observable. donate.ts says the
  // /donate/managed/<slug>-<key>/ family (givefood/views.py:492+, three
  // views) is "explicitly out of scope for this pass". What that means on
  // the wire is a 404 -- not the 501 routes/notPortedYet.ts exists to send,
  // because index.ts registers nothing at all under this prefix. Worth
  // pinning both ways: admin/orderGroup.ts builds these URLs today and shows
  // them to staff (see managedDonationUrl), so every one of them currently
  // leads somewhere dead, and whoever ports the family should see this test
  // fail rather than discover the scope note by reading it.
  it.each(["/donate/managed/ocado-bulk-k7mfp2xq/", "/donate/managed/ocado-bulk-k7mfp2xq/items/", "/donate/managed/ocado-bulk-k7mfp2xq/geo.json"])(
    "404s %s -- the managed-donation family is not ported",
    async (path) => {
      const res = await get(path);

      expect(res.status).toBe(404);
      // Not the 501 "not built yet" signal, and not the donate page either.
      expect(await res.text()).not.toContain("not ported yet");
      expect(await (await get(path)).text()).not.toContain("<h1>Donate</h1>");
    },
  );

  // A DELIBERATE DIVERGENCE FROM DJANGO, pinned because it is not obvious.
  // givefood/views.py:484's donate() carries no @require_GET and no method
  // check of any kind, so Django answers POST /donate/ with the rendered
  // page and a 200. This port registers app.get() only, so anything that is
  // not GET or HEAD falls through to the 404 handler. Nothing depends on the
  // Django behaviour -- the page has no form -- and 404 is the safer answer,
  // but it IS a difference, and this is the record of it.
  it.each(["POST", "PUT", "DELETE", "PATCH"])("404s a %s, where Django's donate() would have rendered the page", async (method) => {
    expect((await fetchWith("/donate/", { method })).status).toBe(404);
  });

  // HEAD reaches the GET handler and returns the real headers with no body,
  // which is what a link checker asks for.
  //
  // SUSPECT, AND PINNED AS IT BEHAVES: the Cache-Control is MISSING on the
  // HEAD response. middleware/pageCacheControl.ts returns early for any
  // method that is not GET, on the stated grounds that "HEAD inherits GET's
  // headers from the same handler anyway" -- true of headers the HANDLER
  // sets, but this one is set by the middleware itself, so it never appears.
  // Harmless in practice (nothing caches a HEAD), but the comment describes
  // a behaviour the code does not have, and a HEAD is the cheapest way a
  // person checks what a URL's caching looks like.
  it("answers HEAD with headers and no body, but without the Cache-Control a GET gets", async () => {
    const res = await fetchWith("/donate/", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toBe("");
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect((await get("/donate/")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
  });
});

// ---------------------------------------------------------------------------
// The query string
// ---------------------------------------------------------------------------

describe("publicDonate -- query strings", () => {
  // A DIVERGENCE FROM DJANGO, pinned rather than fixed.
  //
  // givefood/context_processors.py (read on 2026-09-08 in the read-only
  // checkout) appends `request.META['QUERY_STRING']` to BOTH flag_path and
  // every entry in `languages`. buildPageContext supports that -- it takes a
  // `querystring` option -- but publicDonate does not pass one, so on
  // /donate/?utm_source=x the footer's "Something wrong in this page?" link
  // reports the bare /donate/ and the hreflang alternates omit the query
  // too. Only routes/wfbn/index.ts passes `querystring` in this whole port.
  //
  // The consequence is small and one-directional: a flag report loses the
  // campaign parameters the visitor arrived with. It is pinned because the
  // fix is one argument, and because someone comparing the two codebases
  // should find this recorded rather than rediscover it.
  it("drops the query string from the flag link and the alternates, where Django kept it", async () => {
    const html = await body("/donate/?utm_source=newsletter&utm_medium=email");

    expect(html).toContain(`<a href="/flag/#${ORIGIN}/donate/" rel="nofollow" class="flag">`);
    expect(html).not.toContain("utm_source");
    expect(alternates(html)).toEqual([`en|${ORIGIN}/donate/`, `cy|${ORIGIN}/cy/donate/`, `ga|${ORIGIN}/ga/donate/`, `gd|${ORIGIN}/gd/donate/`]);
  });

  // The flip side, and the reason the divergence above is tolerable: because
  // nothing on the page varies with the query string, every ?utm=... variant
  // renders the same bytes. Asserted so that a future change which DID start
  // reading the query string (the querystring option above being the obvious
  // one) has to come past this test and think about the week-long shared
  // cache it is about to fragment.
  it("renders identically whatever the query string, which keeps the cached page shareable", async () => {
    const plain = withoutClockNoise(await body("/donate/"));
    const tagged = withoutClockNoise(await body("/donate/?utm_source=newsletter"));

    expect(tagged).toBe(plain);
    expect((await get("/donate/?utm_source=newsletter")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
  });
});
