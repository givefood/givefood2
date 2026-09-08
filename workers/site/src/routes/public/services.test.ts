import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { ROUTES } from "@givefood/urls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/public/services.ts -- publicServices, its only exported symbol:
// GET /services/, Django's services() at givefood/views.py:445-449
// (registered at givefood/urls.py:71, inside the "Untranslated pages" block).
//
// WHY THIS FILE EXISTS. Six lines of handler with no query, no form and no
// parameter, so nothing here can throw and nothing can return the wrong row.
// What it CAN do is stop being the page it is supposed to be, and every way
// that happens is invisible to a status check:
//
//   * IT IS THE CHARITY'S PITCH TO FOOD BANKS. The whole page is one offer --
//     a free website, an entry in the national database, the open data -- and
//     the four addresses a reader acts on (mail@givefood.org.uk, the sample
//     site, /register-foodbank/, /api/ and /dashboard/) are the only things
//     on it that DO anything. A dropped mailto or a link to a route that no
//     longer exists renders as a perfectly good-looking page that quietly
//     converts nobody, and nothing in the build would notice.
//   * IT IS ONE OF ONLY TWO CONTENT PAGES OUTSIDE i18n_patterns (the other is
//     privacy/). So it is one of two public page handlers that pass NEITHER a
//     locale to buildPageContext NOR one to render(), while every neighbour in
//     this directory -- contentPages.ts, donate.ts, news.ts -- passes both.
//     "Make services.ts look like the rest of the file" is a plausible tidy-up
//     that produces a 200 advertising four hreflang URLs, three of which 404
//     and all of which Google will follow. Both halves are pinned below.
//   * IT IS REACHED ONLY FROM THE HOME PAGE, IN EVERY LANGUAGE. Unlike
//     /privacy/ it is not in the footer and, matching Django, it is NOT in the
//     sitemap (givefood/views.py:649-654 lists index/about_us/donate/
//     annual_report_index/privacy and no more). index.njk:55 and :129 are the
//     entire discovery path, and they render on the Welsh, Irish and Gaelic
//     home pages too -- where `url('services')` must still emit the unprefixed
//     /services/, because /cy/services/ does not exist. A wrong answer there
//     is a 404 reachable from the top of the site in three languages.
//   * ITS CACHING DIVERGES FROM DJANGO, in the one direction the module's own
//     header does not mention. See the cacheability block.
//
// So the assertions are rendered VALUES -- the title, the three section
// headings in order, the four actionable addresses, the exact Cache-Control --
// plus the properties that make a shared cache safe. A status assertion would
// pass under every failure above.
//
// REAL EVERYTHING, the same harness as routes/public/privacy.test.ts (the
// nearest neighbour: the other untranslated content page) and
// routes/public/contentPages.test.ts. The real production app
// (workers/site/src/index.ts's default export), so the real router, the real
// middleware chain in its real order and the real 404 handler; the real
// Nunjucks environment and the real compiled catalogues. The D1 binding is
// real in-memory SQLite built from the real migrations -- not because this
// handler queries (it must not, and that is asserted on the statements that
// actually reached the engine) but so a query that CREEPS IN executes for real
// and fails on the recorded SQL rather than exploding against a stub and
// hiding behind a 500. Only global fetch is faked, and only to prove nothing
// here leaves the machine.
//
// PARITY CHECKED BY DIFFING, NOT BY ASSUMING. On 2026-09-08 this file's author
// ran a line diff of givefood/templates/public/services.html against
// packages/templates/templates/public/services.njk, with the two `{% load %}`
// lines dropped and `{% extends "public/page.html" %}` / `{% url 'index' %}`
// normalised to their Nunjucks spellings and trailing whitespace stripped:
// the two are identical, the Django file merely lacking a final newline. The
// module header's claim -- "services.html carries no {% trans %}/{% blocktrans %}
// tags at all" -- was checked the same way and holds (grep for `{% trans`
// and `{% blocktrans` in the Django template returns nothing, despite its
// `{% load i18n %}`).

const ORIGIN = "https://www.givefood.org.uk";

// middleware/runtimeIdentity.ts turns CF_VERSION_METADATA.id into `version`
// (first 8 characters), which page.njk cache-busts every stylesheet and script
// with. Fixed here so `?v=` is an assertable value rather than the "unknown"
// fallback. It is minted ONCE PER ISOLATE by that middleware, so a second value
// in this file would silently be ignored -- hence one constant.
const VERSION_ID = "abcd1234-0000-4000-8000-000000000000";
const VERSION = "abcd1234";

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite, with
// every prepared statement recorded. `prepared` is the point: "the page still
// renders" is equally true with and without a database read, so the only way to
// pin "this handler touches no database at all" is to look at the statements
// that reached the engine.
function d1Session(db: DatabaseSync, prepared: string[]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      prepared.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: string[];
let outbound: string[];

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
    CF_VERSION_METADATA: { id: VERSION_ID },
  } as unknown as AppEnv["Bindings"];
}

// One database for the whole file. Nothing here writes to it and the schema is
// applied once because running every migration is the expensive part; the
// per-test state is `prepared`, which is reset below.
beforeAll(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  prepared = [];
  outbound = [];
  // Records any subrequest and refuses it loudly. A page whose entire value is
  // that it renders from nothing must not grow a fetch to a CMS, a form vendor
  // or an analytics endpoint -- and if one appears, the failure should name the
  // URL rather than show up as a slow test.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    outbound.push(url);
    throw new Error(`unexpected outbound fetch to ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
// The ExecutionContext is not optional -- lib/appendSlash.ts reads
// c.executionCtx to re-enter the app for its trailing-slash probe, and a
// context built without one throws there, turning a 301 into a 500.
const get = async (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env(), execCtx);

const body = async (path: string, headers: Record<string, string> = {}): Promise<string> => (await get(path, headers)).text();

// includes/debugcomment.njk stamps a wall-clock timestamp and a render duration
// into every page. Both legitimately differ between two responses and neither
// is per-VISITOR, so they are the only things normalised before a byte
// comparison -- and this asserts it actually found both, so a template change
// that removes them cannot quietly turn the comparison into a comparison of
// nothing.
function withoutClockNoise(html: string): string {
  expect(html).toMatch(/🕰️ Generated at .+/);
  expect(html).toMatch(/⏱️ Took \d+ms/);
  return html.replace(/🕰️ Generated at .+/, "🕰️ Generated at <T>").replace(/⏱️ Took \d+ms/, "⏱️ Took <N>ms");
}

// ---------------------------------------------------------------------------
// publicServices -- the render
// ---------------------------------------------------------------------------

describe("publicServices -- GET /services/", () => {
  // WHICH TEMPLATE RENDERED. services.ts is the same six lines as privacy.ts,
  // donate.ts and every publicX in contentPages.ts with one string changed, so
  // "renders a page" is equally satisfied by it rendering privacy.njk or
  // about_us.njk. These values exist only in public/services.njk: the title
  // block (byte-identical to Django's, including the " - Give Food" suffix that
  // privacy.njk deliberately lacks), the h1, and the logo anchor the body opens
  // with -- whose href is `{{ url('index') }}`, so it also pins that the page
  // resolved the home page unprefixed rather than to some locale's.
  it("renders services.njk -- its title block, heading and body logo link", async () => {
    const res = await get("/services/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Services for food banks - Give Food</title>");
    expect(html).toContain("<h1>Services for food banks</h1>");
    expect(html).toContain('<a href="/" class="logo"><img src="/static/img/logo.svg" alt="Give Food"></a>');
    // No {% block head %} in services.njk, so only page.njk's two stylesheets,
    // both cache-busted with `version`. A third link here would mean a
    // different template rendered.
    expect(html).toContain(`<link rel="stylesheet" href="/static/css/gf.css?v=${VERSION}">`);
    expect(html.match(/<link rel="stylesheet"/g)).toHaveLength(2);
  });

  // THE THREE OFFERS, IN ORDER. The page is a three-column pitch and each
  // column is one thing the charity offers a food bank. Losing one -- to a bad
  // merge, a truncated port, a template inheritance mistake -- leaves a page
  // that renders, validates and passes every other test in this file while no
  // longer offering it. Asserted as the full ordered list so a dropped,
  // duplicated or reordered column names itself, and matching Django's
  // services.html one for one.
  it("carries all three offer columns, in the order Django published them", async () => {
    const headings = [...(await body("/services/")).matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);

    expect(headings).toEqual(["Websites", "Registration", "Data"]);
    // The first column is the wide one (`content is-half`) and the other two
    // share what is left -- Django's own class list, and the difference between
    // the intended layout and three equal columns.
    expect(await body("/services/")).toContain('<div class="column content is-half">');
  });

  // WHAT THE WEBSITE OFFER ACTUALLY PROMISES. Four bullets, quoted whole rather
  // than by keyword, because this is the list a food bank decides on and a
  // reworded or missing bullet is a changed offer rather than a layout nit.
  // The spelling is Django's ("customised", "organisation"), pinned so an
  // Americanising editor pass is a visible failure.
  it("lists the four things the free website includes", async () => {
    const html = await body("/services/");

    expect(html).toContain("<li>Custom domain name (e.g., www.yourfoodbank.org.uk)</li>");
    expect(html).toContain("<li>Mobile-friendly design</li>");
    expect(html).toContain("<li>Content management system for easy updates</li>");
    expect(html).toContain("<li>Fast and friendly email support</li>");
    expect(html).toContain("can quickly and easily be customised to fit the needs of your organisation");
  });

  // THE ONLY THINGS ON THE PAGE THAT DO ANYTHING. Everything else is prose; if
  // one of these five addresses is wrong, the page still looks finished and
  // simply stops working -- the reader emails nobody, or lands on a 404. The
  // mailto is the sole contact route for the website offer, and the sample-site
  // link and screenshot are the only evidence a reader gets that the offer is
  // real. All five are hardcoded literals in the template rather than url()
  // calls (matching Django's services.html, which hardcodes them too), so
  // nothing else in the codebase fails when a route beneath one is renamed.
  it("carries the five addresses a reader can act on, and the sample screenshot", async () => {
    const html = await body("/services/");

    expect(html).toContain('contact us at <a href="mailto:mail@givefood.org.uk">mail@givefood.org.uk</a>');
    expect(html).toContain('<a href="https://www.xyzfoodbank.org.uk">xyzfoodbank.org.uk</a>');
    expect(html).toContain('<img src="/static/img/xyzfoodbank.png" alt="Sample website">');
    expect(html).toContain('<p><a href="/register-foodbank/">Register your food bank</a></p>');
    expect(html).toContain('<li><a href="/api/">API</a></li>');
    expect(html).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
  });

  // AND THOSE THREE INTERNAL ADDRESSES ARE LIVE ROUTES. The assertion above
  // only proves the strings are in the HTML; hardcoded paths in a template are
  // exactly the links that rot silently when a route is renamed or moved to
  // another Worker, because no import and no reverse-URL table breaks. Fetched
  // through the real router so a rename fails here rather than on the page a
  // food bank was sent to. Status only, deliberately -- what each of those
  // pages contains is its own module's test.
  it("links only to routes that answer -- /register-foodbank/, /api/ and /dashboard/", async () => {
    for (const path of ["/register-foodbank/", "/api/", "/dashboard/"]) {
      expect((await get(path)).status, path).toBe(200);
    }
  });

  // buildPageContext({ path: c.req.path }) -- canonical is the request's own
  // path, matching context_processors.py:18-19 (SITE_DOMAIN + translate_url,
  // which is a no-op for a URL outside i18n_patterns).
  it("declares itself canonical at its own URL", async () => {
    expect(await body("/services/")).toContain(`<link rel="canonical" href="${ORIGIN}/services/">`);
  });
});

// ---------------------------------------------------------------------------
// The untranslated exception, and the discovery path that depends on it
// ---------------------------------------------------------------------------

describe("publicServices -- untranslated, and only at /services/", () => {
  // The three URLs that would be advertised are asserted absent BY NAME,
  // because that is the damage: a hreflang pointing at a 404 is followed and
  // indexed by search engines long before a human sees it.
  //
  // WHAT THIS DOES AND DOES NOT CATCH, measured rather than assumed. page.njk:24
  // is `{% if page_translatable %}{% for language in languages %}` -- the only
  // reader of either variable in any template -- so the two are AND-ed, and
  // services.ts withholds both: pageTranslatable: false, and no `locale`, which
  // leaves buildPageContext's `languages` empty (context.ts:95-101). Mutation
  // tested in a scratchpad copy of the repo on 2026-09-08: adding
  // `locale: "en"` alongside `pageTranslatable: true` -- the "make services.ts
  // look like contentPages.ts" tidy-up in full -- fails this test. Flipping
  // pageTranslatable ALONE survives it, and survives the whole file, because
  // with `languages` empty that flag has no rendered consequence anywhere. That
  // is a limit of the page rather than a gap in the test: there is nothing to
  // observe. It is recorded so nobody mistakes this for cover on the flag.
  it("advertises no alternate language URLs at all", async () => {
    const html = await body("/services/");

    expect(html).not.toContain('<link rel="alternate"');
    expect(html).not.toContain(`${ORIGIN}/cy/services/`);
    expect(html).not.toContain(`${ORIGIN}/ga/services/`);
    expect(html).not.toContain(`${ORIGIN}/gd/services/`);
    // services.njk does not include the switcher either -- matching Django's
    // services.html, which has no {% include "includes/langswitcher.html" %}.
    expect(html).not.toContain("langswitcher");
    expect(html).not.toContain('class="dropdown-item"');
  });

  // THE OTHER HALF OF THE SAME FACT, and the reason the assertion above is not
  // merely cosmetic: the prefixed URLs genuinely do not exist. index.ts:423
  // registers /services/ outside the LOCALES loop at index.ts:432-440 that
  // gives about-us, apps, bot, donate, news and annual-reports their three
  // prefixed forms. Add services to that loop without touching anything else
  // and the page would answer in Welsh clothing while rendering English prose,
  // because the handler passes no locale to render().
  //
  // The expected heading differs per prefix and that is the second half of the
  // check: resolveLanguage is global middleware, so /cy/services/ 404s IN WELSH
  // -- "this page does not exist in Welsh" -- while /en/ and /de/ get the
  // English page, because prefix_default_language=False makes "en" a language
  // that never gets a URL prefix and /de/ is one of the 17 §2.7.1 dropped.
  // Asserting the translated heading rather than just the status keeps the two
  // failure modes apart: a route that started matching would 200, and a
  // resolveLanguage regression would 404 in the wrong language. The first half
  // is the mutant this kills: adding `app.get(`/${locale}/services/`,
  // publicServices)` to that loop fails here and nowhere else in the file.
  it("404s under every locale prefix, in that locale's own language, including /en/", async () => {
    const expected: Record<string, string> = {
      cy: "404 - Heb ei Ganfod",
      ga: "404 - Níor aimsíodh",
      gd: "404 - Cha deach a lorg",
      en: "404 - Not Found",
      de: "404 - Not Found",
    };

    for (const [prefix, heading] of Object.entries(expected)) {
      const res = await get(`/${prefix}/services/`);

      expect(res.status, `/${prefix}/services/`).toBe(404);
      expect(await res.text(), `/${prefix}/services/`).toContain(`<h1>${heading}</h1>`);
    }
  });

  // NO LOCALE REACHES render(). The handler omits render()'s third argument, so
  // the catalogue loads whatever the request resolved to -- which is always
  // "en" here and is worth pinning at the debug comment, because that block is
  // where language_code/language_name/language_direction land and it is the
  // only place a wrong locale would be legible. resolveLanguage's rule 1 is
  // that the path prefix is the only thing that ever wins, so an
  // Accept-Language asking for Welsh must change nothing at all -- if it ever
  // did, this page would render its English prose inside Welsh chrome and be
  // cached that way for a day (see below) for everyone.
  it("renders English regardless of what the visitor's Accept-Language asks for", async () => {
    const html = await body("/services/", { "Accept-Language": "cy,gd;q=0.9,en;q=0.5" });

    expect(html).toContain('<html lang="en" dir="ltr" class="txt-dir-ltr">');
    expect(html).toContain("🌍 Language English");
    expect(html).toContain("🌍 Language code en");
    expect(html).toContain("🔣 Language direction ltr");
    // The chrome comes from the same catalogue, so it is English too -- the
    // footer's own words, not the body's.
    expect(html).toContain("<h1>Services for food banks</h1>");
    expect(html).toContain("Something wrong in this page?");
  });

  // THE DISCOVERY PATH, AND WHY IT IS THE INTERESTING ONE HERE. /services/ is
  // not in the footer and not in the sitemap, so index.njk:55 and :129 are the
  // only links to it anywhere on the site -- and they render on the Welsh,
  // Irish and Gaelic home pages too. `services` is deliberately NOT in
  // packages/urls' I18N_SCOPED set, so `url('services')` must emit the
  // unprefixed /services/ even from /cy/ -- which is the only correct answer,
  // since /cy/services/ 404s (asserted above). Scope that name by accident and
  // the top of the Welsh home page gains two links to a 404, in the two places
  // a food bank is most likely to click.
  //
  // Taken from the ROUTES table rather than written out, so a rename on either
  // side -- the table or index.ts's registration -- fails here. The mutant this
  // kills: adding "services" to packages/urls' I18N_SCOPED set, which changes
  // nothing on this page and nothing in English, and turns both links at the
  // top of the Welsh home page into /cy/services/.
  it("is linked as the unprefixed /services/ from the English AND the Welsh home page", async () => {
    expect(ROUTES.services).toBe("/services/");

    const res = await get(ROUTES.services as string);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Services for food banks</h1>");

    // English home page: both call sites, the nav list item and the promo card.
    expect(await body("/")).toContain('<a href="/services/">Services for food banks</a>');
    // Welsh home page: the label is translated, the URL is not. The heading is
    // asserted too, so a /cy/ that quietly served English chrome cannot pass
    // this by rendering the English link.
    const welsh = await body("/cy/");
    expect(welsh).toContain('<a href="/services/">Gwasanaethau ar gyfer banciau bwyd</a>');
    expect(welsh).not.toContain('href="/cy/services/"');
  });

  // NOT IN THE SITEMAP, MATCHING DJANGO. givefood/views.py:649-654 lists
  // exactly index, about_us, donate, annual_report_index and privacy; services
  // is absent there and absent here (sitemaps.ts:53 carries the same five
  // names). Pinned in both directions: adding it would be a silent divergence
  // from the Django sitemap that has been indexed for years, and the sibling
  // that IS listed proves the assertion is reading a real sitemap rather than
  // an empty one.
  it("is absent from sitemap.xml, exactly as in Django, while /privacy/ is present", async () => {
    const xml = await body("/sitemap.xml");

    expect(xml).toContain(`<url><loc>${ORIGIN}/privacy/</loc></url>`);
    expect(xml).not.toContain("/services/");
  });
});

// ---------------------------------------------------------------------------
// Caching -- where the port diverges from Django, and the properties that make
// the divergence safe
// ---------------------------------------------------------------------------

describe("publicServices -- cacheability", () => {
  // A DIVERGENCE FROM DJANGO, AND THE MODULE HEADER TELLS ONLY HALF OF IT.
  // services.ts says PLAN.md §6.10 lists this route's Cache-Control as "None"
  // ("UNCACHED despite being fully static") and that the port "leaves this
  // as-is (no Cache-Control set here)". That is true of the HANDLER and false
  // of the RESPONSE: middleware/pageCacheControl.ts is mounted on "*" as a
  // gap-filler, and /services/ matches none of its named families (it is not in
  // WEEKLY_PAGES the way privacy is), so it falls through to the SECONDS_IN_DAY
  // default. Django's services() carries no @cache_page decorator at all --
  // checked in givefood/views.py:445-449, unlike annual_report five lines above
  // it, which does.
  //
  // So the page is now held in a shared cache for a day where Django held it
  // for none. That is defensible for a page with no query and no per-visitor
  // content -- and every property that makes it defensible is asserted in this
  // block -- but it is a divergence, and the exact number is pinned because
  // 86400 and 604800 look equally plausible in a header and neither changes a
  // pixel. The wrong-by-one-rule value is named so a future edit that adds
  // "services" to WEEKLY_PAGES shows up as this test rather than as a week-old
  // page nobody can explain -- mutation tested on 2026-09-08 by doing exactly
  // that in a scratchpad copy, which fails here and nowhere else.
  it("is held at the edge for the middleware's day default, though Django cached it not at all", async () => {
    const res = await get("/services/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Control")).not.toContain("s-maxage=604800");
    // Not one of middleware/noStore.ts's mounts, so none of its headers.
    expect(res.headers.get("CDN-Cache-Control")).toBeNull();
  });

  // THE INVARIANT THAT MAKES A DAY OF SHARED CACHE SAFE: two different visitors
  // get the same bytes. Written as a property rather than a list of things that
  // must not appear, because the failure mode is open-ended -- a CSRF token, a
  // session greeting, a geo lookup, an echoed header -- and every one of them
  // would be served to everybody once the first visitor populated the edge.
  // This is the exact incident middleware/pageCacheControl.ts records against
  // /flag/ (a visitor's own CSRF token cached and served to strangers) and
  // against /frag/ip-address/ (a stranger's IPv6 address, observed on
  // production 2026-09-07 as a HIT with age 1427).
  it("serves byte-identical bodies to two different visitors", async () => {
    const anonymous = await body("/services/");
    const identified = await body("/services/", {
      Cookie: "__Host-csrf=deadbeef; sessionid=012345",
      "Accept-Language": "cy,en-GB;q=0.8",
      "User-Agent": "Mozilla/5.0 (some other browser)",
      "CF-Connecting-IP": "2a00:23c7::1",
    });

    expect(withoutClockNoise(identified)).toBe(withoutClockNoise(anonymous));
  });

  // No cookie, for the same reason: Cloudflare refuses to cache a response
  // carrying Set-Cookie, so one appearing here would silently drop the page out
  // of the edge cache entirely (a BYPASS on every request) rather than breaking
  // anything visible. And no csrfIssued flag, which is the causal signal
  // pageCacheControl.ts checks first -- a token in the HTML with no Set-Cookie
  // is what actually shipped the /flag/ bug. This page carries no form, and
  // that must stay true: the neighbouring /register-foodbank/ it links to DOES
  // have one, and is mounted under noStore for exactly this reason.
  it("sets no cookie and issues no CSRF token", async () => {
    const res = await get("/services/");

    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).not.toContain("csrfmiddlewaretoken");
  });

  // NO CACHE-TAG, AND THAT IS CORRECT. middleware/cacheTag.ts tags a response
  // with what it depends on so queues/cachePurge.ts can invalidate it; this page
  // depends on no food bank and no constituency, so it gets none and nothing
  // purges it. Pinned because the consequence is severe in one direction and
  // wasteful in the other: an edit to the offer is invisible for up to a day (a
  // deploy is what publishes it), while adding AGGREGATE_TAG here would drag an
  // unchanging marketing page into every food bank save's purge.
  it("carries no cache tag, so nothing but a deploy replaces it", async () => {
    expect((await get("/services/")).headers.get("Cache-Tag")).toBeNull();
  });

  // THE CLAIM IN THE MODULE'S OWN HEADER -- "Static, no DB reads" -- and the one
  // property of a static page that can regress without changing a pixel. A read
  // added here costs a D1 round trip and, on a D1 outage, converts the page from
  // "always available" to "500". The outbound half is asserted with it: nothing
  // on this page may depend on a third party being up, and the sample-site link
  // is the obvious future temptation to go and check one.
  it("issues no database query and makes no subrequest", async () => {
    const res = await get("/services/");

    expect(res.status).toBe(200);
    expect(prepared).toEqual([]);
    expect(outbound).toEqual([]);
  });

  // Content-Language is resolveLanguage's post-response contract. `Vary:
  // Accept-Language` must NOT come back with it -- removed 2026-09-07 (issue
  // #39) because it minted a separate edge object per Accept-Language string
  // for identical bytes, which the byte-identity test above shows they are.
  it("labels the language in a header and adds no Accept-Language Vary", async () => {
    const res = await get("/services/", { "Accept-Language": "gd" });

    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Vary")).toBeNull();
  });

  // A DIVERGENCE INSIDE THE PORT, PINNED BECAUSE IT CONTRADICTS A COMMENT.
  // pageCacheControl.ts:122-124 returns early for any non-GET, reasoning that
  // "HEAD inherits GET's headers from the same handler anyway" -- true of the
  // headers the HANDLER sets, and false of the one that middleware sets itself.
  // Hono routes HEAD to the app.get() handler, so HEAD /services/ renders the
  // page and comes back 200 with NO Cache-Control at all, while GET of the same
  // URL says a day. Harmless in practice (a HEAD is a probe, and no cache keys
  // on it) and recorded here so it stays a known difference rather than a
  // discovery -- and so that "fixing" the comment does not quietly change this.
  it("answers HEAD with no Cache-Control, where GET gets the day", async () => {
    const res = await app.fetch(new Request(`${ORIGIN}/services/`, { method: "HEAD" }), env(), execCtx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Routing and the page chrome
// ---------------------------------------------------------------------------

describe("publicServices -- routing and chrome", () => {
  // Django's APPEND_SLASH, via lib/appendSlash.ts -- a 301 to the slashed URL,
  // not a rewrite. Worth pinning here specifically because the probe re-enters
  // the app with a HEAD request and needs this route to answer something other
  // than 404/501; the page dropped from the router turns this into a 404 rather
  // than a redirect loop, which is easy to misread. It is also the form a
  // hand-typed or printed URL takes.
  it("301s a missing trailing slash to /services/", async () => {
    const res = await get("/services");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/services/`);
  });

  // A DIVERGENCE, PINNED. Django's services() carries no method decorator, so
  // any method rendered the page with a 200. index.ts:423 registers it with
  // app.get(), so Hono never matches a POST or a PUT and app.notFound() answers
  // -- 404, with the real 404 page. Nothing posts to a marketing page and the
  // port's answer is arguably the better one; recorded here so it is a known
  // difference rather than a discovery. The same note privacy.test.ts makes.
  it("404s a POST and a PUT, where Django's undecorated view rendered the page", async () => {
    for (const method of ["POST", "PUT"]) {
      const res = await app.fetch(new Request(`${ORIGIN}/services/`, { method }), env(), execCtx);

      expect(res.status, method).toBe(404);
      expect(await res.text(), method).toContain("<h1>404 - Not Found</h1>");
    }
  });

  // A DIVERGENCE, PINNED. context_processors.py:38-39 and :46-48 appended
  // QUERY_STRING to every alternate URL and to flag_path, so Django's
  // "Something wrong in this page?" link carried the query the reader was
  // actually looking at. This handler passes only `path` to buildPageContext,
  // so the query is dropped -- harmless (nothing on this page reads a
  // parameter) and recorded so it stays a known difference. The same note
  // routes/apiDocs.test.ts, contentPages.test.ts and privacy.test.ts make.
  it("drops the query string from the flag link, unlike Django", async () => {
    const html = await body("/services/?utm_source=newsletter");

    expect(html).toContain(`href="/flag/#${ORIGIN}/services/"`);
    expect(html).not.toContain("utm_source");
  });

  // headless and is_flag_page both default to false in buildPageContext, so this
  // page gets the full footer including the flag link. Asserted because the
  // footer is a food bank's second route to the charity after the body's
  // mailto, and because the footer is where the registration numbers that make
  // the offer credible to a trustee live.
  it("renders the full footer, with the charity registration numbers", async () => {
    const html = await body("/services/");

    expect(html).toContain('<a rel="self" href="https://register-of-charities.charitycommission.gov.uk/en/charity-search/-/charity-details/5147019">1188192</a>');
    expect(html).toContain('ICO Data Protection Registration <a href="https://ico.org.uk/ESDWebPages/Entry/ZB528540">ZB528540</a>');
    expect(html).toContain('<p class="flag">');
  });

  // The debug comment's "Took Nms" is elapsedMs(c) reading the timestamp
  // middleware/serverTiming.ts stored -- whole milliseconds, deliberately not
  // Django's three decimals, because performance.now() only advances at I/O
  // boundaries on Workers and the fraction was always exactly ".000". Drop
  // render_time_ms from the context (the one thing services.ts adds beyond the
  // page context) and the line reads "Took ms" -- nunjucks' throwOnUndefined is
  // off, deliberately, so nothing else in the render would notice.
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body("/services/")).toMatch(/⏱️ Took \d+ms\n/);
  });

  // The machine-readable half of the same measurement, from serverTiming's
  // response header, which KEEPS its decimals. Both are asserted in one place so
  // the deliberate asymmetry between them stays deliberate.
  it("keeps three decimals in the Server-Timing header the debug comment rounds away", async () => {
    expect((await get("/services/")).headers.get("Server-Timing")).toMatch(/^render;dur=\d+\.\d{3}$/);
  });
});
