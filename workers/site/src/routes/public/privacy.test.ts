import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { ROUTES } from "@givefood/urls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/public/privacy.ts -- publicPrivacy, the site's only exported symbol
// here: GET /privacy/, Django's privacy() at givefood/views.py:980-984.
//
// WHY THIS FILE EXISTS. /privacy/ is six lines of handler and the most boring
// page on the site, which is exactly why every one of its distinguishing
// properties can regress without anybody noticing:
//
//   * IT IS A CONTENT PAGE OUTSIDE i18n_patterns. givefood/urls.py:67 puts it
//     in the "Untranslated pages" block, so it has no /cy/, /ga/ or /gd/ form,
//     and the handler passes NEITHER a locale to buildPageContext NOR one to
//     render() -- as services.ts and apiDocs.ts also do, and as every other
//     file in this directory (contentPages.ts, donate.ts, news.ts, country.ts)
//     does not. So "make privacy.ts look like its neighbours" is a plausible
//     tidy-up, and it produces a 200 advertising four hreflang URLs, three of
//     which 404. Google follows and indexes those. Both halves are pinned
//     below.
//   * IT IS LINKED FROM EVERY PAGE'S FOOTER. page.njk:79 emits
//     `{{ url('privacy') }}` on every render of every page in every language,
//     so the agreement between packages/urls' ROUTES table and index.ts:424's
//     registration is a site-wide contract, not a local one. Asserted by
//     fetching the URL the table hands the footer.
//   * IT IS HELD AT THE EDGE FOR A WEEK, and getting that number wrong here
//     has already happened once: pageCacheControl.ts:58-64 records that its
//     locale-prefix fragment was `(?:[a-z-]{2,7}/)?`, which matches the
//     literal string "privacy", so /privacy/ was read as a locale home page
//     and given the home page's one hour instead of Django's
//     @cache_page(SECONDS_IN_WEEK). That regression is one character of regex
//     away at all times and shows up in nothing a human looks at.
//   * IT IS A LEGAL DOCUMENT. The body is the text the ICO registration at
//     the foot of the page points at. A dropped section renders as a
//     perfectly valid page that is missing a commitment.
//
// So the assertions are rendered VALUES -- the thirteen section headings in
// order, the retention and response-time promises, the canonical, the absent
// alternates, the cache header's exact seconds -- plus the properties that
// make a week of shared cache safe. A status-code assertion would pass under
// every failure above.
//
// REAL EVERYTHING, the same harness as routes/public/contentPages.test.ts and
// routes/apiDocs.test.ts: the real production app (workers/site/src/index.ts's
// default export), so the real router, the real middleware chain in its real
// order and the real 404 handler; the real Nunjucks environment and the real
// compiled catalogues. The D1 binding is real in-memory SQLite built from the
// real migrations -- not because this handler queries (it must not, and that
// is asserted on the statements that actually reached the engine) but so a
// query that CREEPS IN executes for real and fails on the recorded SQL rather
// than exploding against a stub and hiding behind a 500. Only global fetch is
// faked, and only to prove nothing here leaves the machine.
//
// MUTATION-TESTED. 25 deliberate breakages were applied to a copy of the repo
// in a scratch directory outside it (never to a file in the checkout) and this
// suite re-run against each. 21 turn it red: a policy section renamed, the
// retention promise changed from 90 days to 900, the contact address changed,
// the em dash turned into an entity, the title block reworded, the wrong
// template rendered, render_time_ms dropped from the context, the canonical
// hardcoded, headless: true, c.text() in place of c.html(), a D1 read added to
// the handler, the route also registered under the three locale prefixes,
// app.all for app.get, the route renamed out from under the ROUTES table,
// pageCacheControl's old locale regex restored, "privacy" removed from its
// WEEKLY_PAGES list, an AGGREGATE_TAG added for this path, Vary:
// Accept-Language put back, elapsedMs returned to three decimals,
// canonical_path stripped of its domain, and the full "make privacy.ts look
// like contentPages.ts" edit (locale AND pageTranslatable together).
//
// 4 SURVIVE, and they are recorded at the tests they belong to rather than
// buried here, because each is a real limit on what this page can observe:
// pageTranslatable alone, a locale alone, buildPageContext's default flipped,
// and a locale threaded into render(). See "WHAT THIS TEST CAN AND CANNOT
// CATCH" and the note above the Accept-Language test for why, in both cases,
// the protection comes from a different test in this file.
//
// PARITY CHECKED BY DIFFING, NOT BY ASSUMING. On 2026-09-08 this file's author
// ran a line diff of givefood/templates/public/privacy.html against
// packages/templates/templates/public/privacy.njk with `{% extends %}` and the
// `{% url 'index' %}` tag normalised to their Nunjucks spellings: the two are
// identical apart from trailing whitespace on three lines and one trailing
// blank line. The module's own header claim -- "privacy.html carries no
// {% trans %}/{% blocktrans %} tags at all" -- was checked the same way and
// holds (grep for `{% trans`/`{% blocktrans` in the Django template returns
// nothing; the five "trans" hits are the words transfer/transmission).

const ORIGIN = "https://www.givefood.org.uk";

// middleware/runtimeIdentity.ts turns CF_VERSION_METADATA.id into `version`
// (first 8 characters), which page.njk cache-busts every stylesheet with.
// Fixed here so `?v=` is an assertable value rather than the "unknown"
// fallback. It is minted ONCE PER ISOLATE by that middleware, so a second
// value in this file would silently be ignored -- hence one constant.
const VERSION_ID = "abcd1234-0000-4000-8000-000000000000";
const VERSION = "abcd1234";

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite, with
// every prepared statement recorded. `prepared` is the point: "the page still
// renders" is equally true with and without a database read, so the only way
// to pin "this handler touches no database at all" is to look at the
// statements that reached the engine.
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
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
    CF_VERSION_METADATA: { id: VERSION_ID },
  } as unknown as AppEnv["Bindings"];
}

// One database for the whole file: nothing here writes to it, and applying
// every migration is the expensive part. `prepared` is what has to be
// per-test, and that is reset below.
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
  // that it renders from nothing must not grow a fetch to a consent vendor, a
  // policy generator or an analytics endpoint -- and if one appears the
  // failure should name the URL rather than show up as a slow test.
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

// includes/debugcomment.njk stamps a wall-clock timestamp and a render
// duration into every page. Both legitimately differ between two responses and
// neither is per-VISITOR, so they are the only things normalised before a byte
// comparison -- and this asserts it actually found both, so a template change
// that removes them cannot quietly turn the comparison into a comparison of
// nothing.
function withoutClockNoise(html: string): string {
  expect(html).toMatch(/🕰️ Generated at .+/);
  expect(html).toMatch(/⏱️ Took \d+ms/);
  return html.replace(/🕰️ Generated at .+/, "🕰️ Generated at <T>").replace(/⏱️ Took \d+ms/, "⏱️ Took <N>ms");
}

// ---------------------------------------------------------------------------
// publicPrivacy -- the render
// ---------------------------------------------------------------------------

describe("publicPrivacy -- GET /privacy/", () => {
  // WHICH TEMPLATE RENDERED. privacy.ts is the same dozen lines as every other
  // static handler in this directory with one string changed, so "renders a
  // page" is satisfied by it rendering about_us.njk or donate.njk instead.
  // These three values are public/privacy.njk's own: its title block
  // (deliberately "Give Food Privacy Policy" with no " - Give Food" suffix,
  // unlike about_us.njk -- byte-identical to Django's {% block title %}), its
  // h1, and the logo anchor its body opens with.
  it("renders privacy.njk -- its title block, heading and body logo link", async () => {
    const res = await get("/privacy/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Give Food Privacy Policy</title>");
    expect(html).toContain("<h1>Privacy policy</h1>");
    expect(html).toContain('<a href="/" class="logo"><img src="/static/img/logo.svg" alt="Give Food"></a>');
    // No {% block head %} in privacy.njk, so only page.njk's two stylesheets,
    // both cache-busted with `version`. A third link here would mean a
    // different template rendered.
    expect(html).toContain(`<link rel="stylesheet" href="/static/css/gf.css?v=${VERSION}">`);
    expect(html.match(/<link rel="stylesheet"/g)).toHaveLength(2);
  });

  // THE DOCUMENT ITSELF, IN ORDER. This is a published legal notice, not
  // decoration: the thirteen <h3> sections are its clauses, and losing one --
  // to a bad merge, a truncated port, a template inheritance mistake -- leaves
  // a page that renders, validates and passes every other test in this file
  // while no longer saying what the charity's ICO registration says it says.
  // Asserted as the full ordered list so a dropped, duplicated or reordered
  // section names itself.
  it("carries all thirteen policy sections, in the order Django published them", async () => {
    const headings = [...(await body("/privacy/")).matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);

    expect(headings).toEqual([
      "What information do we collect?",
      "How do we use your information?",
      "Will your information be shared with anyone?",
      "Do we use cookies and other tracking technologies?",
      "Do we use Google Maps?",
      "Is your information transferred internationally?",
      "How long do we keep your information?",
      "How do we keep your information safe?",
      // The typo is Django's, character for character (privacy.html:115), and
      // is pinned rather than corrected. Fixing it here would put the port's
      // published wording out of step with the document of record for no
      // reviewable reason; if it is to be fixed, it is fixed in both.
      "What are you privacy rights?",
      "Controls for do-not-track features",
      "Do we make updates to this notice?",
      "How can you contact us about this notice?",
      "How can you review, update, or delete the data we collect from you?",
    ]);
    // The one <h4>, nested under "What information do we collect?" -- a
    // separate level in the source, and a flattening of the hierarchy would
    // pass the list above.
    expect(headings).not.toContain("Information collected through our App");
    expect(await body("/privacy/")).toContain("<h4>Information collected through our App</h4>");
  });

  // THE PROMISES WITH NUMBERS IN THEM, AND THE ADDRESS FOR ACTING ON THEM.
  // Everything else on the page is prose; these two are commitments a regulator
  // or a subject-access request would hold the charity to, and the mailbox is
  // the only route a reader has to exercise either. Quoted whole rather than by
  // keyword so a reworded sentence is a visible failure rather than a silent
  // change of meaning.
  it("states the 90-day retention, the 30-day response and the contact address", async () => {
    const html = await body("/privacy/");

    expect(html).toContain("No purpose in this notice will require us keeping your personal information for longer than 90 days.");
    expect(html).toContain("We will respond to your request within 30 days.");
    expect(html).toContain("<p>If you have questions or comments about this notice, you may email us at mail@givefood.org.uk.</p>");
    // The two supervisory-authority URLs a reader in the EEA or Switzerland is
    // pointed at. Plain text in the source, not anchors -- pinned as such,
    // because "helpfully" linkifying them is a template edit to a legal
    // document.
    expect(html).toContain("http://ec.europa.eu/justice/data-protection/bodies/authorities/index_en.htm");
    expect(html).toContain("https://www.edoeb.admin.ch/edoeb/en/home.html");
  });

  // NON-ASCII SURVIVES THE PIPELINE. The body carries an em dash and a curly
  // apostrophe (privacy.njk:27 and :91), and the response declares UTF-8. A
  // charset or double-decode regression anywhere between the precompiled
  // template and c.html() turns those into mojibake -- which is invisible to
  // every status, header and length check, and legible only to a reader.
  it("serves the em dash and curly apostrophe as UTF-8, not as entities or mojibake", async () => {
    const html = await body("/privacy/");

    expect(html).toContain("Some information — such as your Internet Protocol (IP) address");
    expect(html).toContain("subject to Google’s Terms of Service");
    expect(html).not.toContain("â€”");
    expect(html).not.toContain("&mdash;");
  });

  // buildPageContext({ path: c.req.path }) -- canonical is the request's own
  // path, matching context_processors.py:17-19 (SITE_DOMAIN + translate_url,
  // which is a no-op for a URL outside i18n_patterns).
  it("declares itself canonical at its own URL", async () => {
    expect(await body("/privacy/")).toContain(`<link rel="canonical" href="${ORIGIN}/privacy/">`);
  });
});

// ---------------------------------------------------------------------------
// The untranslated exception -- the property that makes this handler different
// from every other content page in the directory
// ---------------------------------------------------------------------------

describe("publicPrivacy -- untranslated, and only at /privacy/", () => {
  // pageTranslatable: false is what stops page.njk:24-25 emitting the
  // alternates, and passing no `locale` to buildPageContext is what leaves
  // `languages` empty. The three URLs that would be advertised are asserted
  // absent by name, because that is the damage: a hreflang pointing at a 404
  // is followed and indexed by search engines long before a human sees it.
  //
  // WHAT THIS TEST CAN AND CANNOT CATCH, measured rather than assumed. The two
  // omissions are belt and braces and NEITHER IS OBSERVABLE ALONE: page.njk
  // gates the loop on page_translatable and then iterates `languages`, so
  // flipping pageTranslatable to true with no locale iterates an empty list,
  // and passing a locale while leaving pageTranslatable false never reaches
  // the loop. Both were applied to a copy of this repo outside it and this
  // suite stayed green for each; applying BOTH -- which is what "make
  // privacy.ts look like contentPages.ts" actually does -- turns this test
  // red. That combination is the realistic edit, so it is the one worth
  // pinning; the halves are recorded here so nobody reads a green run as
  // evidence that either flag alone is protected.
  it("advertises no alternate language URLs at all", async () => {
    const html = await body("/privacy/");

    expect(html).not.toContain('<link rel="alternate"');
    expect(html).not.toContain(`${ORIGIN}/cy/privacy/`);
    expect(html).not.toContain(`${ORIGIN}/ga/privacy/`);
    expect(html).not.toContain(`${ORIGIN}/gd/privacy/`);
    // privacy.njk does not include the switcher either -- matching Django's
    // privacy.html, which has no {% include "includes/langswitcher.html" %}.
    expect(html).not.toContain("langswitcher");
    expect(html).not.toContain('class="dropdown-item"');
  });

  // THE OTHER HALF OF THE SAME FACT, and the reason the assertion above is not
  // merely cosmetic: the prefixed URLs genuinely do not exist. index.ts:424
  // registers /privacy/ outside the LOCALES loop that gives about-us, apps,
  // bot, donate and news their three prefixed forms. Add privacy to that loop
  // without touching anything else and the page would answer in Welsh
  // clothing, but url('privacy') in every footer would still point at
  // /privacy/, and the ROUTES table would still have one entry.
  //
  // The expected heading differs per prefix and that is the second half of the
  // check: resolveLanguage is global middleware, so /cy/privacy/ 404s IN WELSH
  // -- "this page does not exist in Welsh" -- while /en/ and /de/ get the
  // English page, because prefix_default_language=False makes "en" a language
  // that never gets a URL prefix and /de/ is one of the 17 §2.7.1 dropped.
  // Asserting the translated heading rather than just the status keeps the two
  // failure modes apart: a route that started matching would 200, and a
  // resolveLanguage regression would 404 in the wrong language.
  it("404s under every locale prefix, in that locale's own language, including /en/", async () => {
    const expected: Record<string, string> = {
      cy: "404 - Heb ei Ganfod",
      ga: "404 - Níor aimsíodh",
      gd: "404 - Cha deach a lorg",
      en: "404 - Not Found",
      de: "404 - Not Found",
    };

    for (const [prefix, heading] of Object.entries(expected)) {
      const res = await get(`/${prefix}/privacy/`);

      expect(res.status, `/${prefix}/privacy/`).toBe(404);
      expect(await res.text(), `/${prefix}/privacy/`).toContain(`<h1>${heading}</h1>`);
    }
  });

  // NO LOCALE REACHES render(). The handler omits render()'s third argument, so
  // the "en" catalogue loads whatever the request says. Pinned at the debug
  // comment and the <html> element because privacy.njk has no translated
  // strings of its own (Django's privacy.html has no {% trans %} either) --
  // those two are the only places on this page where a wrong locale would be
  // legible at all. resolveLanguage still resolves "en" for an unprefixed path
  // (its rule 1: the path prefix is the only thing that ever wins), so
  // Accept-Language must change nothing.
  //
  // Adding `c.get("lang")` as render()'s third argument does not fail this
  // suite -- checked on a copy of the repo -- and cannot, because the only URL
  // that reaches this handler is unprefixed and therefore always resolves to
  // "en". What makes that safe is the 404 test above rather than this one: the
  // locale argument only starts to matter the moment a prefixed URL routes
  // here, and none does.
  it("renders English regardless of what the visitor's Accept-Language asks for", async () => {
    const html = await body("/privacy/", { "Accept-Language": "cy,gd;q=0.9,en;q=0.5" });

    expect(html).toContain('<html lang="en" dir="ltr" class="txt-dir-ltr">');
    expect(html).toContain("🌍 Language English");
    expect(html).toContain("🌍 Language code en");
    expect(html).toContain("🔣 Language direction ltr");
    // The body is untranslatable source text and the chrome resolves through
    // the same "en" catalogue, so both stay English. The flag link is the
    // chrome half: it is a `{{ _(...) }}` in page.njk and would come back as
    // "Rhywbeth o'i le ar y dudalen hon?" the moment a Welsh catalogue loaded.
    expect(html).toContain("<h1>Privacy policy</h1>");
    expect(html).toContain("Something wrong in this page?");
  });

  // THE SITE-WIDE CONTRACT. page.njk:79 renders `{{ url('privacy') }}` into the
  // footer of every page in every language, and `privacy` is deliberately NOT
  // in packages/urls' I18N_SCOPED set, so that link is /privacy/ even on a
  // Welsh page. Taken from the ROUTES table rather than written out, so a
  // rename on either side -- the table or index.ts's registration -- fails
  // here instead of leaving a dead link in the footer of every page on the
  // site.
  it("answers at the URL the ROUTES table gives every page's footer", async () => {
    expect(ROUTES.privacy).toBe("/privacy/");

    const res = await get(ROUTES.privacy as string);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Privacy policy</h1>");

    // And the link this page's own footer emits is that same unprefixed URL,
    // proving url('privacy') was not silently locale-scoped.
    expect(await body("/privacy/")).toContain('<li><a href="/privacy/">Privacy policy</a></li>');
  });
});

// ---------------------------------------------------------------------------
// Caching -- the half of Django's @cache_page(SECONDS_IN_WEEK) that lives
// outside this handler, and the properties that make a week safe
// ---------------------------------------------------------------------------

describe("publicPrivacy -- cacheability", () => {
  // THE REGRESSION THIS PAGE HAS ALREADY HAD. privacy.ts's header says the
  // week comes from a Cloudflare Cache Rule rather than a header set here, and
  // middleware/pageCacheControl.ts supplies the header half from its
  // WEEKLY_PAGES list. That middleware's own comment (lines 58-64) records the
  // failure: the locale-prefix fragment was `(?:[a-z-]{2,7}/)?`, which matches
  // the literal "privacy", so /privacy/ matched the HOME rule first and was
  // served with the home page's one hour. Both numbers are asserted, and the
  // wrong one by name, because 3600 and 604800 look equally plausible in a
  // header and neither changes a pixel.
  it("is held at the edge for Django's full week, not the home page's hour", async () => {
    const res = await get("/privacy/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
    expect(res.headers.get("Cache-Control")).not.toContain("s-maxage=3600");
    // Not one of middleware/noStore.ts's mounts, so none of its headers.
    expect(res.headers.get("CDN-Cache-Control")).toBeNull();
  });

  // THE INVARIANT THAT MAKES A WEEK OF SHARED CACHE SAFE: two different
  // visitors get the same bytes. Written as a property rather than a list of
  // things that must not appear, because the failure mode is open-ended -- a
  // CSRF token, a session greeting, a geo lookup, an echoed header -- and
  // every one of them would be served to everybody once the first visitor
  // populated the edge. This is the exact incident middleware/pageCacheControl.ts
  // reproduced on production with /flag/ in September 2026, on a page cached
  // for a day; this one is cached for seven.
  it("serves byte-identical bodies to two different visitors", async () => {
    const anonymous = await body("/privacy/");
    const identified = await (
      await get("/privacy/", {
        Cookie: "__Host-csrf=deadbeef; sessionid=012345",
        "Accept-Language": "cy,en-GB;q=0.8",
        "User-Agent": "Mozilla/5.0 (some other browser)",
        "CF-Connecting-IP": "2a00:23c7::1",
      })
    ).text();

    expect(withoutClockNoise(identified)).toBe(withoutClockNoise(anonymous));
  });

  // No cookie, for the same reason: Cloudflare refuses to cache a response
  // carrying Set-Cookie, so one appearing here would silently drop the page
  // out of the edge cache entirely (a BYPASS on every request) rather than
  // breaking anything visible. And no csrfIssued flag, which is the causal
  // signal pageCacheControl.ts checks first -- a token in the HTML with no
  // Set-Cookie is what actually shipped the /flag/ bug.
  it("sets no cookie and issues no CSRF token", async () => {
    const res = await get("/privacy/");

    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).not.toContain("csrfmiddlewaretoken");
  });

  // NO CACHE-TAG, AND THAT IS CORRECT. middleware/cacheTag.ts tags a response
  // with what it depends on so queues/cachePurge.ts can invalidate it; this
  // page depends on no food bank and no constituency, so it gets none and
  // nothing purges it. Pinned because the consequence is severe in one
  // direction and wasteful in the other: an edit to the policy is invisible
  // for up to a week (a deploy is what publishes it), while adding
  // AGGREGATE_TAG here would drag an unchanging legal page into every food
  // bank save's purge.
  it("carries no cache tag, so nothing but a deploy replaces it", async () => {
    expect((await get("/privacy/")).headers.get("Cache-Tag")).toBeNull();
  });

  // THE CLAIM IN THE MODULE'S OWN HEADER -- "Static, no DB reads" -- and the
  // one property of a static page that can regress without changing a pixel.
  // A read added here costs a D1 round trip on the page every footer links to
  // and, on a D1 outage, converts it from "always available" to "500". The
  // outbound half is asserted with it: nothing on this page may depend on a
  // third party being up.
  it("issues no database query and makes no subrequest", async () => {
    const res = await get("/privacy/");

    expect(res.status).toBe(200);
    expect(prepared).toEqual([]);
    expect(outbound).toEqual([]);
  });

  // Content-Language is resolveLanguage's post-response contract. `Vary:
  // Accept-Language` must NOT come back with it -- removed 2026-09-07
  // (issue #39) because it minted a separate edge object per Accept-Language
  // string for identical bytes. This page is the longest-cached HTML on the
  // site and is reachable from every other page, so it is among the worst
  // places to fragment the edge cache.
  it("labels the language in a header and adds no Accept-Language Vary", async () => {
    const res = await get("/privacy/", { "Accept-Language": "gd" });

    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Vary")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Routing and the page chrome
// ---------------------------------------------------------------------------

describe("publicPrivacy -- routing and chrome", () => {
  // Django's APPEND_SLASH, via lib/appendSlash.ts -- a 301 to the slashed URL,
  // not a rewrite. Worth pinning here specifically because the probe re-enters
  // the app with a HEAD request and needs this route to answer something other
  // than 404/501; the page dropped from the router turns this into a 404
  // rather than into a redirect loop, which is easy to misread.
  it("301s a missing trailing slash to /privacy/", async () => {
    const res = await get("/privacy");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/privacy/`);
  });

  // A DIVERGENCE, PINNED. Django's privacy() carries no method decorator, so a
  // POST to it rendered the page with a 200. index.ts:424 registers it with
  // app.get(), so Hono never matches and app.notFound() answers -- 404, with
  // the real 404 page. Nothing POSTs to a privacy policy and the port's answer
  // is arguably the better one; recorded here so it is a known difference
  // rather than a discovery.
  it("404s a POST, where Django's undecorated view rendered the page", async () => {
    const res = await app.fetch(new Request(`${ORIGIN}/privacy/`, { method: "POST" }), env(), execCtx);

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<h1>404 - Not Found</h1>");
  });

  // A DIVERGENCE, PINNED. context_processors.py:38-40 and :46-48 appended
  // QUERY_STRING to flag_path and to every alternate URL, so Django's
  // "Something wrong in this page?" link carried the query the reader was
  // actually looking at. This handler passes only `path` to buildPageContext,
  // so the query is dropped -- harmless (nothing on this page reads a
  // parameter) and recorded so it stays a known difference. The same note
  // routes/apiDocs.test.ts and routes/public/contentPages.test.ts make.
  it("drops the query string from the flag link, unlike Django", async () => {
    const html = await body("/privacy/?utm_source=newsletter");

    expect(html).toContain(`href="/flag/#${ORIGIN}/privacy/"`);
    expect(html).not.toContain("utm_source");
  });

  // headless and is_flag_page both default to false in buildPageContext, so
  // this page gets the full footer including the flag link. Asserted because
  // the footer is where the ICO registration number and the charity number
  // live, and a privacy policy that has lost them is a compliance problem
  // rather than a layout one.
  it("renders the full footer, with the registration numbers a privacy notice needs", async () => {
    const html = await body("/privacy/");

    expect(html).toContain('<a rel="self" href="https://register-of-charities.charitycommission.gov.uk/en/charity-search/-/charity-details/5147019">1188192</a>');
    expect(html).toContain('ICO Data Protection Registration <a href="https://ico.org.uk/ESDWebPages/Entry/ZB528540">ZB528540</a>');
    expect(html).toContain('<p class="flag">');
  });

  // The debug comment's "Took Nms" is elapsedMs(c) reading the timestamp
  // middleware/serverTiming.ts stored -- whole milliseconds, deliberately not
  // Django's three decimals, because performance.now() only advances at I/O
  // boundaries on Workers and the fraction was always exactly ".000". Drop
  // render_time_ms from the context (the one thing privacy.ts adds beyond the
  // page context) and the line reads "Took ms" -- nunjucks' throwOnUndefined
  // is off, deliberately, so nothing else would notice.
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body("/privacy/")).toMatch(/⏱️ Took \d+ms\n/);
  });

  // The machine-readable half of the same measurement, from serverTiming's
  // response header, which KEEPS its decimals. Both are asserted in one place
  // so the deliberate asymmetry between them stays deliberate.
  it("keeps three decimals in the Server-Timing header the debug comment rounds away", async () => {
    expect((await get("/privacy/")).headers.get("Server-Timing")).toMatch(/^render;dur=\d+\.\d{3}$/);
  });
});
