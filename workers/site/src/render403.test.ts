import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index";
import { render403 } from "./render403";
import { resolveLanguage } from "./middleware/resolveLanguage";
import { serverTiming } from "./middleware/serverTiming";
import type { AppEnv } from "./types";
import type { Env } from "../worker-configuration";

// render403.ts -- the renderer for givefood/templates/403.html.
//
// WHY A MODULE WITH NO CALL SITE IS WORTH A TEST FILE AT ALL. The module's own
// header is emphatic that nothing calls it, by design: every 403 this Worker
// actually emits is a deliberate bare `new Response("", { status: 403 })`,
// matching the Django views' own HttpResponseForbidden(), and wiring this in
// would be a behaviour change rather than a fix. That makes the file a
// standing invitation to two opposite mistakes, and both of them are silent:
//
//   * someone "finishes the job" by pointing the existing bare 403s at this
//     renderer, turning an empty 403 that an API client reads as a refusal
//     into a 2KB HTML page (see "nothing on the site serves this page" below,
//     which is the tripwire for exactly that); or
//   * someone deletes it as dead code, and the ported template loses its only
//     working renderer -- at which point nobody notices until the day a real
//     PermissionDenied equivalent needs a page.
//
// Either way the template is untested and unrendered until the moment it is
// needed, which is the worst moment to discover that `403.njk` was renamed, or
// that the .po catalogues never carried a Welsh "403 - Forbidden". So this file
// renders it, for real, in all four languages.
//
// DJANGO PROVENANCE, ACTUALLY CHECKED (paths under
// /Users/jasoncartwright/Sites/foodcharity, which pins django==6.1 in
// pyproject.toml and has 6.1 in its own .venv -- note the machine's SYSTEM
// python has Django 5.2.6, so the version depends on which interpreter you
// ask):
//   * givefood/templates/403.html -- read, and every string the tests below
//     assert is one of its `{% trans %}` literals.
//   * `grep -rn --include="*.py" -E "handler403|PermissionDenied" .` over the
//     whole checkout, minus .venv: NO MATCHES. So the module's claim holds --
//     Django never registers a 403 handler and nothing raises the exception
//     that would reach django.views.defaults.permission_denied, which is the
//     only view that ever renders 403.html (read in the venv at
//     django/views/defaults.py:126-150).
//   * givefood/views.py:1074-1095 (`def human`) returns HttpResponseForbidden()
//     at :1082 and :1086 with no content, which does NOT render 403.html --
//     confirming the port's bare 403s are parity, not an omission.
//
// REAL EVERYTHING. render403 takes a Hono Context and returns a string, so
// every test below drives it through a REAL Hono app with the REAL middleware
// index.ts mounts (serverTiming, resolveLanguage) and the REAL Nunjucks
// environment, precompiled templates and .po catalogues from
// @givefood/templates. The one line of the harness that is not real is the
// route registration, because there is no real one -- it is written as
// `c.html(await render403(c), 403)`, the exact shape index.ts:683/691 uses for
// render404/render500, so that if this ever IS wired in the harness is already
// what the wiring will look like.
//
// MUTATION-TESTED in a copy of the repo outside the tree (never in src/, and
// never restored-in-place), against eleven mutants of render403.ts and of the
// renderErrorPage.ts it delegates to: "403.njk" swapped for "404.njk" and for
// "500.njk"; pageTranslatable false; unprefixedPath fed c.req.path; the locale
// argument dropped from render(); the locale dropped from buildPageContext();
// path fed c.req.url; render_time_ms dropped; a querystring passed through to
// buildPageContext; render403 returning c.html(...) instead of a string; and
// render403 given render500's try/catch fallback. All eleven turn this file
// red, none survived. Two of them are killed by exactly ONE test each -- the
// querystring and the try/catch -- which is why those two tests are worded
// around a property rather than around a string that happens to appear.

const ORIGIN = "https://www.givefood.org.uk";

// A path that is not translatable in Django and is not a real page here
// either -- the shape of URL an admin 403 would carry. Used throughout so the
// hreflang divergence below is asserted on a URL where Django genuinely
// disagrees, rather than on one where the two happen to coincide.
const REFUSED = "/admin/foodbanks/";

type Bindable = null | number | bigint | string | Uint8Array;

// The D1 surface packages/db uses, over a real in-memory SQLite built from the
// real migrations, recording every statement prepared. It is here to be NOT
// USED: an error page that queried the database would be the single worst page
// on the site to have a query in, since it is the page served when things are
// already going wrong. Backed by a genuine database so "no queries" is a claim
// about restraint rather than about a binding that would have thrown anyway.
function countingD1(db: DatabaseSync, prepares: string[]): D1Database {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  const prepare = (sql: string) => {
    prepares.push(sql);
    return statement(sql, []);
  };
  return { prepare, withSession: () => ({ prepare, getBookmark: () => null }) } as unknown as D1Database;
}

// schemaFor(), not hand-written DDL: a fixture schema typed out by hand tests
// the author's memory of the columns rather than the columns the migrations
// actually produce, and "the fixture was wrong" is a bad way to find out that
// an error page started reading the database.
const SCHEMA = schemaFor("foodbank");

let db: DatabaseSync;
let prepares: string[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepares = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function env(): Env {
  return { DB: countingD1(db, prepares) } as unknown as Env;
}

/**
 * The app render403 would live in if anything called it: the two global
 * middlewares it silently depends on (serverTiming for `requestStartTime`,
 * resolveLanguage for `lang`/`pathAfterPrefix`), and index.ts's own
 * `c.html(await render<NNN>(c), <NNN>)` handler shape.
 */
function forbidden(): Hono<AppEnv> {
  const h = new Hono<AppEnv>();
  h.use("*", serverTiming);
  h.use("*", resolveLanguage);
  h.all("*", async (c) => c.html(await render403(c), 403));
  return h;
}

/** The rendered 403 page for a path, through the full middleware chain. */
async function page(path: string): Promise<string> {
  return (await forbidden().request(`${ORIGIN}${path}`, {}, env())).text();
}

/**
 * render403's return VALUE, captured from inside a real route rather than
 * inferred from a Response -- the difference between "returns HTML" and
 * "returns a Response" is invisible once Hono has wrapped it.
 */
async function returnValue(path: string): Promise<unknown> {
  let captured: unknown = "the handler never ran";
  const h = new Hono<AppEnv>();
  h.use("*", serverTiming);
  h.use("*", resolveLanguage);
  h.all("*", async (c) => {
    captured = await render403(c);
    return c.text("ok");
  });
  await h.request(`${ORIGIN}${path}`, {}, env());
  return captured;
}

/**
 * Settles render403's promise and hands back either its value or its
 * rejection. Hono catches a rejected handler and answers 500, so a plain
 * request cannot tell "render403 threw" from "render403 returned nonsense";
 * this can. `lang` is set directly because resolveLanguage will only ever set
 * one of the four real locales.
 */
async function settle(lang: string): Promise<{ html: string } | { err: unknown }> {
  let outcome: { html: string } | { err: unknown } = { err: "the handler never ran" };
  const h = new Hono<AppEnv>();
  h.use("*", serverTiming);
  h.use("*", async (c, next) => {
    c.set("lang", lang);
    c.set("pathAfterPrefix", REFUSED);
    await next();
  });
  h.all("*", async (c) => {
    outcome = await render403(c).then(
      (html) => ({ html }),
      (err: unknown) => ({ err }),
    );
    return c.text("ok");
  });
  await h.request(`${ORIGIN}${REFUSED}`, {}, env());
  return outcome;
}

// ---------------------------------------------------------------------------
// The page itself
// ---------------------------------------------------------------------------

describe("the page render403 produces", () => {
  it("renders every line of Django's 403.html, in English", async () => {
    // Each of these is one `{% trans %}` literal from
    // givefood/templates/403.html, asserted with its surrounding markup so the
    // test is about the PAGE and not just about the catalogue: the title, the
    // h1, the logo that links home and the three escape routes offered to
    // someone who has just been refused. (The apology paragraph is the fourth
    // literal and gets its own test below, for the reason given there.)
    //
    // Content, not shape: a 403.njk whose `{% block body %}` were renamed
    // would still render, still return a perfectly valid page, and simply have
    // nothing in it -- so "it produced HTML" is not an assertion.
    const html = await page(REFUSED);

    expect(html).toContain("<title>403 - Forbidden - Give Food</title>");
    expect(html).toContain("<h1>403 - Forbidden</h1>");
    expect(html).toContain('<a href="/" class="logo"><img src="/static/img/logo.svg" alt="Give Food"></a>');
    expect(html).toContain('<li><a href="/">Homepage</a></li>');
    expect(html).toContain('<li><a href="/needs/">Find what food banks need</a></li>');
    expect(html).toContain('<li>Email <a href="mailto:mail@givefood.org.uk">mail@givefood.org.uk</a></li>');
  });

  it("escapes the apostrophes Django left alone -- a real, if cosmetic, divergence", async () => {
    // PINNED, NOT FIXED, and checked by RUNNING Django 6.1 in foodcharity's own
    // .venv rather than by reasoning about it:
    //
    //   engine autoescape = True
    //   A:{% trans "can't" %} -> can't
    //   B:{{ v }}  (v = "can't") -> can&#x27;t
    //
    // i.e. Django's `{% trans %}` on a string literal emits a SafeString and is
    // NOT escaped, while an ordinary variable is (and as `&#x27;`, not `&#39;`).
    // The port's `_()` (packages/templates/src/i18n.ts) returns a plain string,
    // so nunjucks autoescape escapes it -- every translated string on the site
    // containing an apostrophe differs from Django by these six bytes. Harmless
    // to a browser, which renders both identically; NOT harmless to a
    // byte-diffing parity harness, which is why it is written down here with
    // the transcript rather than left to be rediscovered.
    const html = await page(REFUSED);

    expect(html).toContain("<p>Sorry, something has gone wrong there and we can&#39;t serve that page. This error has been logged and we&#39;ll look into it.</p>");
    expect(html).not.toContain("we can't serve that page");
  });

  it("is 403.njk and not 404.njk or 500.njk -- which the apology alone cannot tell you", async () => {
    // THE ONE-CHARACTER MUTANT. renderErrorPage() takes the template name as a
    // string and all three error pages are byte-identical apart from two
    // strings, so `renderErrorPage(c, "500.njk")` compiles, renders, and looks
    // completely fine.
    //
    // The apology paragraph cannot distinguish them: locale/*/django.po records
    // it as ONE msgid used by two templates (`#: givefood/templates/403.html:25
    // givefood/templates/500.html:25`), so 403 and 500 share it verbatim. Only
    // the title and the h1 differ, hence the negative assertions here.
    const html = await page(REFUSED);

    expect(html).not.toContain("404 - Not Found");
    expect(html).not.toContain("500 - Internal Server Error");
    // ...and specifically not 404.njk's own apology, which IS distinct.
    expect(html).not.toContain("Sorry, we can&#39;t find that page");
  });

  it("returns an HTML string for its caller to wrap, not a Response", async () => {
    // render404/render500 have the same signature and index.ts calls all three
    // the same way: `c.html(await renderNNN(c), NNN)`. A version that returned
    // `c.html(...)` itself would still work in a hand-written route and would
    // silently drop the 403 status the moment the real caller wrapped it (Hono
    // would take the inner Response's 200). Pinned as the type contract.
    const value = await returnValue(REFUSED);

    expect(typeof value).toBe("string");
    expect(value).not.toBeInstanceOf(Response);
    const html = value as string;
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("is a whole page with the site's footer, not a headless fragment", async () => {
    // renderErrorPage passes no `headless`, so buildPageContext defaults it to
    // false and page.njk renders the full footer -- including its two
    // `data-include` spans, which each fire a browser fetch at /frag/ when the
    // page loads. That is a deliberate difference from routes/human.ts (which
    // passes headless: true precisely to avoid those two requests), and it
    // means an error page costs two extra subrequests per view. Current
    // behaviour, and it matches Django, whose 403.html extends the same
    // public/page.html with no headless flag.
    const html = await page(REFUSED);

    expect(html).toContain('<footer class="footer">');
    expect(html).toContain('data-include="/frag/last-updated/"');
    expect(html).toContain('data-include="/frag/need-hits/"');
    // is_flag_page defaults false too, so the "report this page" link renders,
    // pointing at the refused URL.
    expect(html).toContain(`<a href="/flag/#${ORIGIN}${REFUSED}" rel="nofollow" class="flag">`);
  });
});

// ---------------------------------------------------------------------------
// Which URL the page says it is
// ---------------------------------------------------------------------------

describe("the URL the page claims to be", () => {
  it("canonicalises the refused path, not the site root", async () => {
    // renderErrorPage passes `path: c.req.path`. Feeding it c.req.url instead
    // -- an easy slip, since both exist on the same object -- produces
    // `https://www.givefood.org.ukhttps://www.givefood.org.uk/admin/foodbanks/`
    // in the canonical link and in every hreflang alternate, which no status
    // code or visible page text would reveal.
    const html = await page(REFUSED);

    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}${REFUSED}">`);
    expect(html).not.toContain(`href="${ORIGIN}${ORIGIN}`);
  });

  it("DROPS the query string, where Django kept it in flag_path and the alternates", async () => {
    // A DIVERGENCE, pinned rather than fixed. givefood/context_processors.py
    // (read at foodcharity) reads `request.META['QUERY_STRING']` at :20 and
    // appends it to every entry in `languages` (:38-39) and to flag_path
    // (:46-48), while leaving canonical_path without it. renderErrorPage never
    // passes `querystring` to
    // buildPageContext at all, so flag_path collapses to canonical_path and the
    // query string is lost from the "Something wrong in this page?" link.
    //
    // The consequence is small and arguably in the right direction: whatever
    // was in the query string of a refused request -- a token, an email
    // address, a search term -- is not echoed back into the page for the
    // visitor to copy into a flag report. Pinned so that "restore parity" here
    // is a deliberate decision about that, not an incidental tidy-up.
    const html = await page(`${REFUSED}?token=s3cret&q=beans`);

    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}${REFUSED}">`);
    expect(html).toContain(`<a href="/flag/#${ORIGIN}${REFUSED}" rel="nofollow" class="flag">`);
    expect(html).not.toContain("s3cret");
    expect(html).not.toContain("q=beans");
  });

  it("cannot be made to inject markup through the requested path", async () => {
    // An error page is, by construction, reached with a URL its VISITOR chose,
    // and this one echoes that URL into six attributes. Autoescape is the only
    // thing standing between that and reflected XSS on www.givefood.org.uk --
    // and, contrary to the obvious assumption, percent-encoding is NOT a
    // second line of defence here.
    //
    // The Request really is normalised (`new Request(...).url` reports
    // `/admin/%22%3E%3Cscript%3E...`, checked in this node, v24.15.0), but
    // Hono's getPath calls `tryDecode(path, decodeURI)` the moment it sees a
    // "%" (hono/dist/utils/url.js), and decodeURI turns %22/%3C/%3E back into
    // the literal characters -- so `c.req.path`, and therefore canonical_path
    // and the flag link, carry raw `"` `<` `>` into the template. Only
    // nunjucks autoescape (env.ts, `autoescape: true`) makes that safe. A
    // `| safe` added to canonical_path, or a template that put the path in an
    // unquoted attribute, would be an immediate XSS.
    const html = await page('/admin/"><script>alert(1)</script>/');

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/admin/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;/">`);
    expect(html).toContain(`<a href="/flag/#${ORIGIN}/admin/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;/" rel="nofollow" class="flag">`);
  });

  it("spells the same URL two different ways in one page -- decoded canonical, encoded alternates", async () => {
    // SUSPECT, pinned rather than fixed. renderErrorPage takes canonical_path
    // from `c.req.path` (decoded, per the test above) but the alternates from
    // `c.get("pathAfterPrefix")`, and resolveLanguage builds that with
    // `new URL(c.req.url).pathname` -- which is NOT decoded. So one page
    // declares its canonical URL and its own `hreflang="en"` alternate to be
    // different strings for the same request. A crawler reading both sees a
    // canonical that does not match any alternate.
    //
    // Invisible on every ordinary URL (nothing to encode), and unreachable on
    // an error page nothing serves -- but renderErrorPage is shared, and the
    // 404 page IS served, to exactly the kind of malformed URLs that contain
    // percent escapes. Pinned so the inconsistency has one place it is written
    // down.
    const html = await page('/admin/"><script>alert(1)</script>/');

    expect(html).toContain(`<link rel="alternate" hreflang="en" href="${ORIGIN}/admin/%22%3E%3Cscript%3Ealert(1)%3C/script%3E/">`);
    expect(html).toContain(`<link rel="alternate" hreflang="cy" href="${ORIGIN}/cy/admin/%22%3E%3Cscript%3Ealert(1)%3C/script%3E/">`);
  });
});

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

describe("the language it renders in", () => {
  it("renders Welsh in all four places the locale has to arrive", async () => {
    // The locale reaches the output by four separate routes and a mutant can
    // break any one of them alone:
    //   * buildPageContext's `locale` -> language_code -> <html lang>;
    //   * ...and language_name, which only the debug comment shows;
    //   * render()'s third argument -> the .po catalogue -> the title and h1;
    //   * ...and the same argument -> url()'s prefix -> the logo's href.
    // Dropping the third argument alone yields a page marked lang="cy" that is
    // written in English and links back to the ENGLISH home page, which is why
    // all four are asserted in one test rather than settling for the first.
    const html = await page(`/cy${REFUSED}`);

    expect(html).toContain('<html lang="cy" dir="ltr" class="txt-dir-ltr">');
    expect(html).toContain("🌍 Language Cymraeg");
    expect(html).toContain("<title>403 - Gwaharddedig - Give Food</title>");
    expect(html).toContain("<h1>403 - Gwaharddedig</h1>");
    expect(html).toContain('<a href="/cy/" class="logo">');
  });

  it("serves Irish and Scots Gaelic from their own catalogues, not the English fallback", async () => {
    // translate() in i18n.ts falls back to the msgid whenever a msgstr is
    // missing or empty, so a catalogue that failed to load produces a perfectly
    // valid English page under `lang="gd"` with nothing thrown and nothing
    // logged. These two locales are the ones nobody would notice.
    //
    // The gd paragraph is also a poParser regression test: locale/gd/django.po
    // writes this msgstr as `msgstr ""` followed by three continuation lines,
    // the standard gettext wrapping, and a parser that read only the first line
    // would see an empty translation and fall back to English. Note the
    // typographic apostrophe in "a’ mhearachd" survives unescaped -- nunjucks
    // escapes & < > " and ' only, so U+2019 passes through.
    const ga = await page(`/ga${REFUSED}`);
    expect(ga).toContain("<h1>403 - Toirmiscthe</h1>");
    expect(ga).toContain(
      "<p>Tá brón orainn, ach tá rud éigin imithe amú ansin agus ní féidir linn an leathanach sin a sheirbheáil. Tá an earráid seo logáilte agus féachfaimid uirthi.</p>",
    );

    const gd = await page(`/gd${REFUSED}`);
    expect(gd).toContain("<h1>403 - Toirmisgte</h1>");
    expect(gd).toContain(
      "<p>Tha sinn duilich, tha rudeigin air a dhol ceàrr an sin agus chan urrainn dhuinn an duilleag sin a fhrithealadh. Chaidh a’ mhearachd seo a chlàradh agus nì sinn sgrùdadh air.</p>",
    );
  });

  it("builds the hreflang alternates from the UNPREFIXED path", async () => {
    // THE MUTANT THAT SURVIVES AN ENGLISH-ONLY TEST. renderErrorPage passes
    // `unprefixedPath: c.get("pathAfterPrefix")`, and buildPageContext builds
    // each alternate by putting a code in front of it. Passing c.req.path
    // instead is invisible on an English URL, where the prefixed and unprefixed
    // spellings are the same string -- it only shows up here, as
    // /cy/cy/admin/foodbanks/. routes/human.test.ts records the same mutant
    // surviving its first mutation round for exactly this reason, so the
    // assertion lives in the PREFIXED test, where the two spellings differ.
    const html = await page(`/cy${REFUSED}`);

    expect(html).toContain(`<link rel="alternate" hreflang="en" href="${ORIGIN}${REFUSED}">`);
    expect(html).toContain(`<link rel="alternate" hreflang="cy" href="${ORIGIN}/cy${REFUSED}">`);
    expect(html).toContain(`<link rel="alternate" hreflang="ga" href="${ORIGIN}/ga${REFUSED}">`);
    expect(html).toContain(`<link rel="alternate" hreflang="gd" href="${ORIGIN}/gd${REFUSED}">`);
    expect(html).not.toContain("/cy/cy/");
  });

  it("declares four translations of a page nobody may see -- where Django would have declared none", async () => {
    // A DIVERGENCE, pinned and reported rather than fixed, and it belongs to
    // renderErrorPage (so 404 and 500 have it too; on 404 it is the one that is
    // actually observable in production, since that page really is served).
    //
    // renderErrorPage hardcodes `pageTranslatable: true`. Django computed it:
    // context_processors.py:33 is
    //     page_translatable = "/cy/" == translate_url(path, "cy")[:4]
    // which is False for any path outside i18n_patterns. VERIFIED BY RUNNING
    // Django 6.1 against foodcharity's real URLconf -- not by reading it:
    //     '/admin/foodbanks/'   -> '/admin/foodbanks/'      page_translatable = False
    //     '/api/2/foodbanks/'   -> '/api/2/foodbanks/'      page_translatable = False
    //     '/no-such-page/'      -> '/no-such-page/'         page_translatable = False
    //     '/needs/at/salisbury/'-> '/cy/needs/at/salisbury/' page_translatable = True
    // So Django's 403 page for an admin URL emitted NO alternates, and this one
    // emits four, telling a crawler that four translations of a forbidden URL
    // exist. Harmless while nothing serves the page; the same hardcode on
    // render404 is not hypothetical.
    const html = await page(REFUSED);

    for (const code of ["en", "cy", "ga", "gd"]) {
      expect(html).toContain(`hreflang="${code}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// The middlewares it depends on without declaring
// ---------------------------------------------------------------------------

describe("the middleware it silently depends on", () => {
  /** render403 with NO middleware at all -- the shape of a second app, a
   *  preview worker, or a route mounted before the global chain. */
  async function bare(path: string): Promise<Response> {
    const h = new Hono<AppEnv>();
    h.all("*", async (c) => c.html(await render403(c), 403));
    return h.request(`${ORIGIN}${path}`, {}, env());
  }

  it("reports the whole request's elapsed time, not a timer it started itself", async () => {
    // renderErrorPage passes elapsedMs(c), which subtracts serverTiming's
    // requestStartTime. A renderer that timed only its own render() call would
    // report a number that is plausible, small, and measures the wrong thing --
    // and on an error page the interesting duration is the whole doomed
    // request, not the 3ms spent rendering the apology. Driven from a fixed
    // clock so the number itself is the assertion: reading 1 is serverTiming's
    // t0, reading 2 is elapsedMs inside renderErrorPage.
    const readings = [1000, 1064.6, 1099];
    let i = 0;
    vi.spyOn(performance, "now").mockImplementation(() => readings[Math.min(i++, readings.length - 1)] ?? 0);

    expect(await page(REFUSED)).toContain("⏱️ Took 65ms");
  });

  it("still renders, with 'Took NaNms', when serverTiming never ran", async () => {
    // NOT an endorsement -- a documentation test, and the same one
    // serverTiming.test.ts writes from the other end. render500.ts reasons in
    // prose that requestStartTime "is already set on `c`" because serverTiming
    // is the first app.use("*") in index.ts; this is what the alternative looks
    // like. The page is perfect apart from three characters inside an HTML
    // comment, nothing throws, and nothing is logged -- so the registration
    // ORDER in index.ts is load-bearing, which is easy to forget when adding a
    // sub-app with its own middleware stack.
    const res = await bare(REFUSED);
    const html = await res.text();

    expect(res.status).toBe(403);
    expect(html).toContain("<h1>403 - Forbidden</h1>");
    expect(html).toContain("⏱️ Took NaNms");
  });

  it("falls back to English with NO alternates when resolveLanguage never ran", async () => {
    // With `lang` unset, `c.get("lang")` is undefined: buildPageContext takes
    // its `options.locale ? ... : []` branch and emits no alternates at all
    // despite pageTranslatable being true, while render()'s DEFAULT PARAMETER
    // (`locale: Locale = "en"`) quietly supplies English. The page renders
    // fine. Worth pinning because it is the near-miss of the test below: an
    // undefined locale is absorbed by a default parameter, an unrecognised one
    // is not.
    const html = await (await bare(REFUSED)).text();

    expect(html).toContain('<html lang="en" dir="ltr" class="txt-dir-ltr">');
    expect(html).toContain("<h1>403 - Forbidden</h1>");
    expect(html).not.toContain('rel="alternate"');
  });
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

describe("when the render itself fails", () => {
  it("rejects rather than falling back -- the one way it differs from render500", async () => {
    // render500.ts wraps the identical call in try/catch and returns a bare
    // "<!doctype html><title>500..." string if the shared pipeline itself is
    // broken, because "this is the page an already-broken request lands on".
    // render403 and render404 have no such guard. This test is what makes that
    // difference visible, and it pins the consequence: a 403 page that failed
    // to render would propagate out of the handler to index.ts's app.onError,
    // which renders the 500 page -- so a refusal would be reported to the
    // visitor as a server error.
    //
    // "de" is not an arbitrary bad value: it is one of the 17 languages
    // §2.7.1 dropped from Django's 21, and it is what a URL like /de/... asks
    // for. resolveLanguage maps that to "en" (its PREFIXES set is derived from
    // LOCALES), so this is NOT reachable through the real chain today -- it
    // becomes reachable the moment anything else sets `lang`.
    const outcome = await settle("de");

    expect(outcome).not.toHaveProperty("html");
    const { err } = outcome as { err: unknown };
    // loadCatalogue() indexes a Record of three dynamic importers by locale and
    // calls the result; for an unknown locale that is `undefined()`.
    expect(err).toBeInstanceOf(TypeError);
  });

  it("renders normally for every locale resolveLanguage can actually produce", async () => {
    // The negative control for the test above: the throw is a property of
    // UNKNOWN locales, not of the settle() harness, so all four real ones must
    // come back with HTML through the same helper. Without this, a settle()
    // that always failed for some unrelated reason would make the test above
    // pass forever.
    for (const locale of ["en", "cy", "ga", "gd"]) {
      const outcome = await settle(locale);
      expect(outcome, locale).toHaveProperty("html");
      expect((outcome as { html: string }).html, locale).toContain("Give Food");
    }
  });
});

// ---------------------------------------------------------------------------
// Cost and determinism
// ---------------------------------------------------------------------------

describe("what rendering it costs", () => {
  it("asks the database nothing, in any language", async () => {
    // An error page is served when something is already wrong -- during an
    // incident, or to a crawler hammering a subtree it may not have. A D1 read
    // added to this path is a read paid for by exactly the traffic nobody is
    // watching, and renderErrorPage is shared with the 404 page, which the site
    // really does serve at volume.
    await page(REFUSED);
    await page(`/cy${REFUSED}`);
    expect(prepares).toEqual([]);

    // NEGATIVE CONTROL. Without this, an inert recorder -- a countingD1 that
    // stopped pushing, or a binding never actually reaching the app -- would
    // make the assertion above pass regardless of what the renderer did.
    const control = countingD1(db, prepares);
    await control.prepare("SELECT COUNT(*) AS n FROM foodbank").first();
    expect(prepares).toEqual(["SELECT COUNT(*) AS n FROM foodbank"]);
  });

  it("gives two identical requests byte-identical pages", async () => {
    // Purity, stated as the property that matters: this page is a function of
    // the URL and nothing else. Two things legitimately vary between renders --
    // the debug comment's wall clock and its render timer -- so both are frozen
    // and then the WHOLE page is compared, rather than a chosen subset that
    // could not notice a new element appearing. A renderer that leaked
    // per-render state (a mutated context object, a memoised catalogue keyed
    // wrongly) shows up here and almost nowhere else.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
    vi.spyOn(performance, "now").mockReturnValue(1000);

    const first = await page(REFUSED);
    const second = await page(REFUSED);

    expect(second).toBe(first);
    // ...and the frozen clock really did reach the page, or the comparison
    // above would be comparing two pages that merely rendered within the same
    // second. `now()` is registered as a nunjucks global in env.ts and formats
    // through Django's "r" tokens.
    expect(first).toContain("🕰️ Generated at Tue, 08 Sep 2026 12:00:00 +0000");
    expect(first).toContain("⏱️ Took 0ms");
  });
});

// ---------------------------------------------------------------------------
// The module's central claim
// ---------------------------------------------------------------------------

describe("nothing on the site serves this page", () => {
  it("answers a real 403 with an empty body, exactly as Django's HttpResponseForbidden did", async () => {
    // THE TRIPWIRE for the module header's "Do NOT wire this into any of the
    // existing bare-403 endpoints; that would be a behaviour change from Django
    // parity, not a fix." POST /human/ with no `target` is the cheapest real
    // 403 the app can produce (givefood/views.py:1081-1082's
    // `if not target: return HttpResponseForbidden()`), and it is driven
    // through the REAL app from ./index -- the real router, the real middleware
    // chain -- because the claim is about the app, not about this module.
    //
    // Asserting the empty body rather than just the status is the whole point:
    // wiring render403 in here would keep the 403 and change the body from
    // nothing to a full HTML page, which every status-code test on the site
    // would sail straight through. An API client posting to this endpoint reads
    // an empty 403 as a refusal; an HTML page is something it has to parse to
    // find out it was refused.
    const res = await app.request(
      `${ORIGIN}/human/`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "action=subscribe" },
      env(),
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  it("does not serve the 403 page for an unknown URL either -- that is the 404 page's job", async () => {
    // The other direction. render403 and render404 differ by three characters
    // of template name and are called through the same helper, so "the wrong
    // error page" is a plausible edit with no visible symptom beyond a heading.
    // index.ts:683 must reach render404, and this asserts the heading a visitor
    // would actually read.
    const res = await app.request(`${ORIGIN}/no-such-page/`, {}, env());
    const html = await res.text();

    expect(res.status).toBe(404);
    expect(html).toContain("<h1>404 - Not Found</h1>");
    expect(html).not.toContain("403 - Forbidden");
  });
});
